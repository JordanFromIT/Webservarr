"""
Push notification dispatch service.

Sends Web Push notifications to subscribed browsers via the pywebpush library.
VAPID keys are read from the Settings table (auto-generated on startup by seed.py).
"""

import json
import logging
from typing import List

from app.database import SessionLocal
from app.models import PushSubscription, Setting

logger = logging.getLogger(__name__)


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

    payload = json.dumps({
        "title": title,
        "body": body,
        "category": category,
        "url": url,
    })

    success_count = 0
    stale_ids: List[int] = []

    for sub in sub_data:
        subscription_info = {
            "endpoint": sub["endpoint"],
            "keys": {
                "p256dh": sub["p256dh"],
                "auth": sub["auth"],
            },
        }

        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=vapid_private_key,
                vapid_claims=vapid_claims,
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
