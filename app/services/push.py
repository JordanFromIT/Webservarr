"""
Push notification dispatch service.

Sends Web Push notifications to subscribed browsers via the pywebpush library.
VAPID keys are read from the Settings table (auto-generated on startup by seed.py).
"""

import asyncio
import json
import logging
import time
from typing import List

from app.database import SessionLocal
from app.models import PushSubscription, Setting
from app.utils import is_safe_push_endpoint

logger = logging.getLogger(__name__)

# A single hung endpoint must never freeze a worker (H6) or let a broadcast run
# unbounded, so every send is capped and the whole dispatch is capped:
#   * PUSH_SEND_TIMEOUT  - handed to pywebpush -> requests, per endpoint.
#   * PUSH_TOTAL_BUDGET  - wall-clock ceiling for the entire fan-out.
#   * PUSH_CONCURRENCY   - how many sends are in flight at once.
PUSH_SEND_TIMEOUT = 10
PUSH_TOTAL_BUDGET = 30.0
PUSH_CONCURRENCY = 10


async def send_push_to_users(
    emails: List[str],
    title: str,
    body: str,
    category: str,
    url: str = "/",
) -> int:
    """Send a Web Push notification to all subscriptions belonging to the given emails.

    Args:
        emails: List of user emails (will be lowercased for matching).
        title: Notification title.
        body: Notification body text.
        category: Notification category (request, issue, service, news).
        url: URL to open when the notification is clicked.

    Returns:
        Number of successfully delivered pushes.
    """
    # Read VAPID keys and subscriptions with a short-lived session
    db = SessionLocal()
    try:
        pub_row = db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").first()
        priv_row = db.query(Setting).filter(Setting.key == "notifications.vapid_private_key").first()

        if not pub_row or not priv_row:
            logger.debug("VAPID keys not configured — skipping push dispatch")
            return 0

        vapid_private_key = priv_row.value

        # Build VAPID claims from admin email in Settings (no hardcoded domain)
        admin_email_setting = db.query(Setting).filter(Setting.key == "system.admin_email").first()
        admin_email = admin_email_setting.value if admin_email_setting else "admin@localhost"
        vapid_claims = {"sub": f"mailto:{admin_email}"}

        # Normalise emails for matching
        normalised = [e.lower() for e in emails if e]
        if not normalised:
            return 0

        subscriptions = (
            db.query(PushSubscription)
            .filter(PushSubscription.user_email.in_(normalised))
            .all()
        )

        if not subscriptions:
            logger.debug("No push subscriptions found for %d email(s)", len(normalised))
            return 0

        # Snapshot subscription data so we can close the session before sending
        sub_data = [
            {
                "id": sub.id,
                "endpoint": sub.endpoint,
                "p256dh": sub.p256dh,
                "auth": sub.auth,
                "user_email": sub.user_email,
            }
            for sub in subscriptions
        ]
    finally:
        db.close()

    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        logger.warning("pywebpush not installed — cannot send push notifications")
        return 0

    try:
        import requests
    except ImportError:
        requests = None

    def _no_redirect_session():
        """A requests session that refuses to follow redirects (anti-SSRF, M12).

        pywebpush re-resolves the endpoint at send time and, by default, follows
        redirects — a 307/308 to an internal address would re-POST the payload
        there. Handing it a session that never follows a redirect closes that
        hop; a redirecting endpoint is simply treated as a failed delivery."""
        if requests is None:
            return None
        session = requests.Session()

        def _no_redirect(*args, **kwargs):
            kwargs["allow_redirects"] = False
            return requests.Session.send(session, *args, **kwargs)

        session.send = _no_redirect  # type: ignore[method-assign]
        return session

    payload = json.dumps({
        "title": title,
        "body": body,
        "category": category,
        "url": url,
    })

    success_count = 0
    stale_ids: List[int] = []

    async def _send_one(sub: dict) -> None:
        nonlocal success_count
        # Re-validate at send time (M12): the endpoint passed the SSRF check when
        # it was subscribed, but DNS can rebind a once-public host to a
        # loopback/LAN/metadata address in the meantime. Re-resolve and refuse.
        if not is_safe_push_endpoint(sub["endpoint"]):
            logger.warning(
                "Skipping push to %s: endpoint no longer resolves to a public host",
                sub["user_email"],
            )
            return

        subscription_info = {
            "endpoint": sub["endpoint"],
            "keys": {
                "p256dh": sub["p256dh"],
                "auth": sub["auth"],
            },
        }

        try:
            # The webpush call is synchronous (requests under the hood); running
            # it in a worker thread with a hard timeout keeps one dead endpoint
            # from blocking the event loop (H6).
            await asyncio.to_thread(
                webpush,
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=vapid_private_key,
                vapid_claims=vapid_claims,
                timeout=PUSH_SEND_TIMEOUT,
                requests_session=_no_redirect_session(),
            )
            success_count += 1
        except WebPushException as exc:
            resp = getattr(exc, "response", None)
            resp_status = getattr(resp, "status_code", None)
            if resp_status in (404, 410):
                logger.info(
                    "Push subscription stale (HTTP %s) for %s — will delete",
                    resp_status,
                    sub["user_email"],
                )
                stale_ids.append(sub["id"])
            else:
                logger.warning(
                    "WebPushException for %s: %s",
                    sub["user_email"],
                    str(exc),
                )
        except Exception as exc:
            logger.warning(
                "Unexpected push error for %s: %s",
                sub["user_email"],
                str(exc),
            )

    # Fan the sends out concurrently but bounded, then cap the whole broadcast
    # at PUSH_TOTAL_BUDGET so a batch of slow endpoints cannot stall dispatch.
    semaphore = asyncio.Semaphore(PUSH_CONCURRENCY)

    async def _guarded(sub: dict) -> None:
        async with semaphore:
            await _send_one(sub)

    tasks = [asyncio.ensure_future(_guarded(sub)) for sub in sub_data]
    if tasks:
        done, pending = await asyncio.wait(tasks, timeout=PUSH_TOTAL_BUDGET)
        for task in pending:
            task.cancel()
        if pending:
            logger.warning(
                "Push dispatch budget (%.0fs) hit; %d of %d sends abandoned",
                PUSH_TOTAL_BUDGET,
                len(pending),
                len(tasks),
            )

    # Clean up stale subscriptions with a short-lived session
    if stale_ids:
        db = SessionLocal()
        try:
            db.query(PushSubscription).filter(PushSubscription.id.in_(stale_ids)).delete(
                synchronize_session=False
            )
            db.commit()
            logger.info("Deleted %d stale push subscription(s)", len(stale_ids))
        finally:
            db.close()

    logger.info(
        "Push dispatch complete: %d/%d successful for category=%s",
        success_count,
        len(sub_data),
        category,
    )
    return success_count
