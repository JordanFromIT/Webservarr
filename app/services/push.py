"""
Push notification dispatch service.

Sends Web Push notifications to subscribed browsers via the pywebpush library.
VAPID keys are read from the Settings table (auto-generated on startup by seed.py).
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional
from urllib.parse import urlsplit

from app.database import SessionLocal
from app.models import PushSubscription, Setting
from app.utils import identity_email, is_safe_push_endpoint, same_origin_path

logger = logging.getLogger(__name__)

# A single hung endpoint must never freeze a worker (H6) or let a broadcast run
# unbounded, so every send is capped and the whole dispatch is capped:
#   * PUSH_SEND_TIMEOUT  - handed to pywebpush -> requests, per endpoint.
#   * PUSH_TOTAL_BUDGET  - wall-clock ceiling for the entire fan-out.
#   * PUSH_CONCURRENCY   - how many sends are in flight at once.
PUSH_SEND_TIMEOUT = 10
PUSH_TOTAL_BUDGET = 30.0
PUSH_CONCURRENCY = 10

# Shown on the notification when the operator's logo is not a same-origin path
# (a service worker can only reliably load icons from its own origin). A PNG,
# because Chromium does not rasterise SVG notification icons. Keep in step with
# DEFAULT_ICON in app/static/sw.js.
DEFAULT_PUSH_ICON = "/static/webservarr-192.png"

# The most recent push that actually tried a device, for Settings >
# Notifications. In Redis, because the two uvicorn workers share no memory and
# must report the same answer.
LAST_PUSH_KEY = "webservarr:push:last"


async def _record_last_push(category: str, result: Dict[str, int]) -> None:
    """Remember a push that tried at least one device; anything else is ignored."""
    if not result.get("attempted"):
        return
    try:
        from app.auth import session_manager
        redis = await session_manager.get_redis()
        await redis.set(LAST_PUSH_KEY, json.dumps({
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "category": category,
            "attempted": int(result["attempted"]),
            "succeeded": int(result["succeeded"]),
        }))
    except Exception as exc:  # noqa: BLE001 - reporting must never break sending
        logger.debug("Could not record the last push: %s", exc)


async def read_last_push() -> Optional[dict]:
    """The last recorded push, or None when there is none or Redis can't say."""
    try:
        from app.auth import session_manager
        redis = await session_manager.get_redis()
        raw = await redis.get(LAST_PUSH_KEY)
        return json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001
        return None


def load_vapid_key(private_key: str):
    """Turn the stored VAPID private key into a py_vapid ``Vapid`` object.

    seed.py stores the key as a PKCS8 PEM block. pywebpush only accepts a
    ``Vapid`` instance, a path to a PEM *file*, or a bare base64 DER/raw string:
    handed the PEM text itself it strips the newlines, base64-decodes the
    header line along with the body and fails ASN.1 parsing, so every push was
    rejected before it left the server. The PEM is therefore parsed here, once
    per dispatch, and the object is what reaches ``webpush()``. A bare
    base64 key (another tool's format an operator may have pasted in) still
    goes through ``from_string``.
    """
    from py_vapid import Vapid

    key = (private_key or "").strip()
    if key.startswith("-----BEGIN"):
        return Vapid.from_pem(key.encode())
    return Vapid.from_string(private_key=key)


def _push_icon(logo_url: str) -> str:
    """The operator's logo when it is a same-origin raster image, else the bundled PNG.

    The shipped default logo_url is an SVG, and Chromium does not rasterise
    SVG notification icons, so any .svg path falls back to the PNG too.
    """
    path = same_origin_path(logo_url)
    if not path or urlsplit(path).path.lower().endswith(".svg"):
        return DEFAULT_PUSH_ICON
    return path


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
    result = await dispatch_push(emails, title, body, category, url)
    return result["succeeded"]


async def dispatch_push(
    emails: List[str],
    title: str,
    body: str,
    category: str,
    url: str = "/",
) -> Dict[str, int]:
    """Like send_push_to_users, but report how many devices were tried.

    Returns ``{"attempted": n, "succeeded": m}``, where attempted counts the
    stored subscriptions matched for ``emails``. Every dispatch that tried a
    device becomes the recorded last push; recording wraps the whole send, so
    no return path inside it can skip it.
    """
    result = await _dispatch_push(emails, title, body, category, url)
    await _record_last_push(category, result)
    return result


async def _dispatch_push(
    emails: List[str],
    title: str,
    body: str,
    category: str,
    url: str = "/",
) -> Dict[str, int]:
    """The send itself; dispatch_push records the outcome."""
    result = {"attempted": 0, "succeeded": 0}
    # Read VAPID keys and subscriptions with a short-lived session
    db = SessionLocal()
    try:
        pub_row = db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").first()
        priv_row = db.query(Setting).filter(Setting.key == "notifications.vapid_private_key").first()

        if not pub_row or not priv_row:
            logger.debug("VAPID keys not configured — skipping push dispatch")
            return result

        try:
            vapid_key = load_vapid_key(priv_row.value)
        except Exception as exc:
            # One clear error instead of a warning per device: with an
            # unreadable key no push can be signed at all.
            logger.error("VAPID private key could not be loaded; push disabled: %s", exc)
            return result

        logo_row = db.query(Setting).filter(Setting.key == "branding.logo_url").first()
        icon = _push_icon(logo_row.value if logo_row else "")

        # Build VAPID claims from admin email in Settings (no hardcoded domain)
        admin_email_setting = db.query(Setting).filter(Setting.key == "system.admin_email").first()
        admin_email = admin_email_setting.value if admin_email_setting else "admin@localhost"
        vapid_claims = {"sub": f"mailto:{admin_email}"}

        # Normalise emails for matching
        normalised = [e for e in (identity_email(x) for x in emails) if e]
        if not normalised:
            return result

        subscriptions = (
            db.query(PushSubscription)
            .filter(PushSubscription.user_email.in_(normalised))
            .all()
        )

        if not subscriptions:
            logger.debug("No push subscriptions found for %d email(s)", len(normalised))
            return result

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
        return result

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
        "icon": icon,
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
            #
            # webpush() writes the endpoint's origin into the claims as "aud"
            # and keeps it if already set, so each send gets its own copy: a
            # shared dict would sign every device with the first one's push
            # service as audience, and the others would reject it.
            await asyncio.to_thread(
                webpush,
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=vapid_key,
                vapid_claims=dict(vapid_claims),
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
    result["attempted"] = len(sub_data)
    result["succeeded"] = success_count
    return result
