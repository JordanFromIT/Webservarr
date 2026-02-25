"""
Background notification poller.

Runs three independent polling loops that detect events from
Overseerr (requests/issues), Uptime Kuma (monitor status), and
the local NewsPost table. When an event is detected it creates a
Notification row (with dedup) and dispatches a Web Push via
send_push_to_users().

Architecture:
    start_poller()  -- launched as asyncio.create_task in main.py lifespan
    stop_poller()   -- sets a flag; the loop exits on the next tick
"""

import asyncio
import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional, Set

import httpx
import redis.asyncio as aioredis
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import Notification, NewsPost, PushSubscription, Setting
from app.services.push import send_push_to_users

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

_stop_event: Optional[asyncio.Event] = None
_redis: Optional[aioredis.Redis] = None

# Overseerr media-status codes (used on media objects)
MEDIA_STATUS_MAP = {
    1: "unknown",
    2: "pending",
    3: "processing",
    4: "partially_available",
    5: "available",
}

# Overseerr issue-status codes
ISSUE_STATUS_MAP = {
    1: "open",
    2: "resolved",
}

# Minimum configurable poll interval (seconds)
MIN_INTERVAL = 30

# Default poll intervals (seconds)
DEFAULT_OVERSEERR_INTERVAL = 60
DEFAULT_MONITORS_INTERVAL = 60
DEFAULT_NEWS_INTERVAL = 60

# Internal tick — how often we check whether a poll is due
TICK_SECONDS = 5


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _email_hash(email: str) -> str:
    """SHA-256-based hash matching the notifications router."""
    return hashlib.sha256(email.lower().encode()).hexdigest()[:16]


def _get_setting_int(db: Session, key: str, default: int) -> int:
    """Read an integer setting from the DB, floored at MIN_INTERVAL."""
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        try:
            val = int(row.value)
            return max(val, MIN_INTERVAL)
        except (ValueError, TypeError):
            pass
    return max(default, MIN_INTERVAL)


def _user_wants_category(db: Session, email: str, category: str) -> bool:
    """Check the notify.<hash>.<category> preference.  True if unset."""
    eh = _email_hash(email)
    row = db.query(Setting).filter(Setting.key == f"notify.{eh}.{category}").first()
    if row:
        return row.value.lower() != "false"
    return True


def _dedup_exists(db: Session, user_email: str, category: str, reference_id: str) -> bool:
    """Return True if a Notification with matching dedup triple already exists."""
    return (
        db.query(Notification)
        .filter(
            Notification.user_email == user_email,
            Notification.category == category,
            Notification.reference_id == reference_id,
        )
        .first()
    ) is not None


def _create_notification(
    db: Session,
    user_email: str,
    category: str,
    title: str,
    body: str,
    reference_id: str,
) -> Optional[Notification]:
    """Create a Notification row after dedup + preference checks.  Returns the row or None."""
    email = user_email.lower()
    if _dedup_exists(db, email, category, reference_id):
        return None
    if not _user_wants_category(db, email, category):
        return None
    notif = Notification(
        user_email=email,
        category=category,
        title=title,
        body=body,
        reference_id=reference_id,
    )
    db.add(notif)
    return notif


async def _get_redis() -> aioredis.Redis:
    """Lazy-init a module-level Redis connection."""
    global _redis
    if _redis is None:
        _redis = await aioredis.from_url(settings.redis_url)
    return _redis


async def _collect_session_emails(r: aioredis.Redis) -> Set[str]:
    """Scan Redis for session:* keys, return set of unique lowercased emails."""
    emails: Set[str] = set()
    cursor = 0
    while True:
        cursor, keys = await r.scan(cursor, match="session:*", count=100)
        for key in keys:
            data = await r.hgetall(key)
            email_bytes = data.get(b"email", b"")
            email_str = email_bytes.decode() if isinstance(email_bytes, bytes) else email_bytes
            if email_str:
                emails.add(email_str.lower())
        if cursor == 0:
            break
    return emails


# ---------------------------------------------------------------------------
# Overseerr config helper
# ---------------------------------------------------------------------------

def _get_overseerr_config(db: Session) -> dict:
    url_row = db.query(Setting).filter(Setting.key == "integration.overseerr.url").first()
    key_row = db.query(Setting).filter(Setting.key == "integration.overseerr.api_key").first()
    return {
        "url": url_row.value.rstrip("/") if url_row else None,
        "api_key": key_row.value if key_row else None,
    }


# ---------------------------------------------------------------------------
# Poll: Overseerr requests
# ---------------------------------------------------------------------------

async def _poll_overseerr_requests(db: Session, r: aioredis.Redis, first_run: bool) -> None:
    config = _get_overseerr_config(db)
    if not config["url"] or not config["api_key"]:
        return

    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            resp = await client.get(
                f"{config['url']}/api/v1/request",
                params={"take": 50, "sort": "added", "skip": 0},
                headers={"X-Api-Key": config["api_key"]},
            )
            if resp.status_code != 200:
                logger.warning("Poller: Overseerr requests HTTP %d", resp.status_code)
                return

            results = resp.json().get("results", [])

            for req in results:
                request_id = req.get("id", 0)
                if not request_id:
                    continue

                media = req.get("media", {})
                status_code = media.get("status", 0)
                status_label = MEDIA_STATUS_MAP.get(status_code, "unknown")

                redis_key = f"poller:request:{request_id}"
                prev = await r.get(redis_key)
                prev_status = prev.decode() if prev else None

                # Always update snapshot
                await r.set(redis_key, status_label)

                if first_run or prev_status is None:
                    continue  # seed silently

                if status_label == "available" and prev_status != "available":
                    # Fetch media title
                    tmdb_id = media.get("tmdbId", 0)
                    media_type = req.get("type", "movie")
                    title = "Unknown"
                    if tmdb_id:
                        endpoint = "movie" if media_type == "movie" else "tv"
                        try:
                            detail_resp = await client.get(
                                f"{config['url']}/api/v1/{endpoint}/{tmdb_id}",
                                headers={"X-Api-Key": config["api_key"]},
                            )
                            if detail_resp.status_code == 200:
                                d = detail_resp.json()
                                title = d.get("title") or d.get("name", "Unknown")
                        except Exception:
                            pass

                    # Who requested it?
                    requester = req.get("requestedBy", {})
                    requester_email = (requester.get("email") or "").lower()
                    if not requester_email:
                        continue

                    ref_id = f"request:{request_id}:available"
                    notif = _create_notification(
                        db,
                        requester_email,
                        "request",
                        "Your request is available",
                        f"{title} is now available on Plex",
                        ref_id,
                    )
                    if notif:
                        db.commit()
                        await send_push_to_users(
                            db,
                            [requester_email],
                            notif.title,
                            notif.body or "",
                            "request",
                            url="/",
                        )

    except Exception as exc:
        logger.warning("Poller: Overseerr requests error: %s", exc)


# ---------------------------------------------------------------------------
# Poll: Overseerr issues
# ---------------------------------------------------------------------------

async def _poll_overseerr_issues(db: Session, r: aioredis.Redis, first_run: bool) -> None:
    config = _get_overseerr_config(db)
    if not config["url"] or not config["api_key"]:
        return

    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            list_resp = await client.get(
                f"{config['url']}/api/v1/issue",
                params={"take": 50, "sort": "added", "skip": 0},
                headers={"X-Api-Key": config["api_key"]},
            )
            if list_resp.status_code != 200:
                logger.warning("Poller: Overseerr issues HTTP %d", list_resp.status_code)
                return

            results = list_resp.json().get("results", [])

            for issue_summary in results:
                issue_id = issue_summary.get("id", 0)
                if not issue_id:
                    continue

                # Fetch detail for comments + status
                try:
                    detail_resp = await client.get(
                        f"{config['url']}/api/v1/issue/{issue_id}",
                        headers={"X-Api-Key": config["api_key"]},
                    )
                    if detail_resp.status_code != 200:
                        continue
                    detail = detail_resp.json()
                except Exception:
                    continue

                comments = detail.get("comments", [])
                comment_count = len(comments)
                status_code = detail.get("status", 1)
                status_label = ISSUE_STATUS_MAP.get(status_code, "open")

                redis_key = f"poller:issue:{issue_id}"
                prev = await r.get(redis_key)
                snapshot_val = f"{comment_count}:{status_label}"
                await r.set(redis_key, snapshot_val)

                if first_run or prev is None:
                    continue

                prev_str = prev.decode()
                try:
                    prev_count_str, prev_status = prev_str.split(":", 1)
                    prev_count = int(prev_count_str)
                except (ValueError, IndexError):
                    prev_count = 0
                    prev_status = "open"

                # Who created this issue?
                creator = detail.get("createdBy", {})
                creator_email = (creator.get("email") or "").lower()
                if not creator_email:
                    continue

                # Fetch media title for context
                media = detail.get("media", {})
                tmdb_id = media.get("tmdbId", 0)
                media_type = media.get("mediaType", "movie")
                media_title = "your issue"
                if tmdb_id:
                    ep = "movie" if media_type == "movie" else "tv"
                    try:
                        mr = await client.get(
                            f"{config['url']}/api/v1/{ep}/{tmdb_id}",
                            headers={"X-Api-Key": config["api_key"]},
                        )
                        if mr.status_code == 200:
                            md = mr.json()
                            media_title = md.get("title") or md.get("name", "your issue")
                    except Exception:
                        pass

                # Status change to resolved
                if status_label == "resolved" and prev_status != "resolved":
                    ref_id = f"issue:{issue_id}:resolved"
                    notif = _create_notification(
                        db,
                        creator_email,
                        "issue",
                        "Your issue has been resolved",
                        f"The issue for {media_title} has been resolved",
                        ref_id,
                    )
                    if notif:
                        db.commit()
                        await send_push_to_users(
                            db,
                            [creator_email],
                            notif.title,
                            notif.body or "",
                            "issue",
                            url="/issues",
                        )

                # New comments
                if comment_count > prev_count:
                    ref_id = f"issue:{issue_id}:comment:{comment_count}"
                    notif = _create_notification(
                        db,
                        creator_email,
                        "issue",
                        "New response on your issue",
                        f"New comment on your issue for {media_title}",
                        ref_id,
                    )
                    if notif:
                        db.commit()
                        await send_push_to_users(
                            db,
                            [creator_email],
                            notif.title,
                            notif.body or "",
                            "issue",
                            url="/issues",
                        )

    except Exception as exc:
        logger.warning("Poller: Overseerr issues error: %s", exc)


# ---------------------------------------------------------------------------
# Poll: Uptime Kuma monitors
# ---------------------------------------------------------------------------

async def _poll_monitors(db: Session, r: aioredis.Redis, first_run: bool) -> None:
    try:
        from app.integrations.uptime_kuma import get_monitors
    except ImportError:
        logger.debug("Poller: uptime_kuma module not available")
        return

    try:
        monitors = await get_monitors(db)
    except Exception as exc:
        logger.warning("Poller: monitor fetch error: %s", exc)
        return

    if not monitors:
        return

    for mon in monitors:
        monitor_id = mon.get("id", 0)
        name = mon.get("name", f"Monitor {monitor_id}")
        status_label = mon.get("status", "unknown")

        redis_key = f"poller:monitor:{monitor_id}"
        prev = await r.get(redis_key)
        prev_status = prev.decode() if prev else None

        await r.set(redis_key, status_label)

        if first_run or prev_status is None:
            continue

        if status_label == prev_status:
            continue

        # Notify all active session users
        emails = await _collect_session_emails(r)
        if not emails:
            continue

        ref_id = f"monitor:{monitor_id}:{status_label}"
        title = f"{name} is {status_label}"
        body = f"Service status changed from {prev_status} to {status_label}"

        notified_emails = []
        for email in emails:
            notif = _create_notification(db, email, "service", title, body, ref_id)
            if notif:
                notified_emails.append(email)

        if notified_emails:
            db.commit()
            await send_push_to_users(
                db,
                notified_emails,
                title,
                body,
                "service",
                url="/",
            )


# ---------------------------------------------------------------------------
# Poll: News posts
# ---------------------------------------------------------------------------

async def _poll_news(db: Session, r: aioredis.Redis, first_run: bool) -> None:
    LAST_CHECK_KEY = "poller:news:last_check"

    prev_check_raw = await r.get(LAST_CHECK_KEY)
    if prev_check_raw:
        try:
            last_check = datetime.fromisoformat(prev_check_raw.decode())
        except (ValueError, AttributeError):
            last_check = None
    else:
        last_check = None

    now = datetime.now(timezone.utc)
    await r.set(LAST_CHECK_KEY, now.isoformat())

    if first_run or last_check is None:
        return  # seed silently — don't flood on first run

    # Query for published posts since last check
    new_posts = (
        db.query(NewsPost)
        .filter(
            NewsPost.published == True,  # noqa: E712
            NewsPost.published_at >= last_check,
        )
        .all()
    )

    if not new_posts:
        return

    # Collect all known emails (sessions + push subscriptions)
    r_conn = await _get_redis()
    session_emails = await _collect_session_emails(r_conn)
    sub_emails = set(
        row.user_email.lower()
        for row in db.query(PushSubscription.user_email).distinct().all()
        if row.user_email
    )
    all_emails = session_emails | sub_emails

    if not all_emails:
        return

    for post in new_posts:
        ref_id = f"news:{post.id}"
        notified_emails = []
        for email in all_emails:
            notif = _create_notification(
                db, email, "news", "New announcement", post.title, ref_id
            )
            if notif:
                notified_emails.append(email)

        if notified_emails:
            db.commit()
            await send_push_to_users(
                db,
                notified_emails,
                "New announcement",
                post.title,
                "news",
                url="/",
            )


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

async def start_poller() -> None:
    """Main poller loop — runs until stop_poller() is called."""
    global _stop_event
    _stop_event = asyncio.Event()

    logger.info("Notification poller starting...")

    r = await _get_redis()

    # Track first-run per poller type
    first_run_overseerr = True
    first_run_monitors = True
    first_run_news = True

    # Track when each poller last ran (epoch seconds)
    last_overseerr = 0.0
    last_monitors = 0.0
    last_news = 0.0

    while not _stop_event.is_set():
        try:
            await asyncio.wait_for(_stop_event.wait(), timeout=TICK_SECONDS)
            break  # stop_event was set
        except asyncio.TimeoutError:
            pass  # tick expired, check if any poll is due

        now = asyncio.get_event_loop().time()

        # Read intervals from DB each tick (cheap queries)
        db = SessionLocal()
        try:
            interval_overseerr = _get_setting_int(
                db, "notifications.poll_interval_overseerr", DEFAULT_OVERSEERR_INTERVAL
            )
            interval_monitors = _get_setting_int(
                db, "notifications.poll_interval_monitors", DEFAULT_MONITORS_INTERVAL
            )
            interval_news = _get_setting_int(
                db, "notifications.poll_interval_news", DEFAULT_NEWS_INTERVAL
            )

            # --- Overseerr ---
            if now - last_overseerr >= interval_overseerr:
                last_overseerr = now
                try:
                    await _poll_overseerr_requests(db, r, first_run_overseerr)
                    await _poll_overseerr_issues(db, r, first_run_overseerr)
                except Exception as exc:
                    logger.warning("Poller: overseerr cycle error: %s", exc)
                first_run_overseerr = False

            # --- Monitors ---
            if now - last_monitors >= interval_monitors:
                last_monitors = now
                try:
                    await _poll_monitors(db, r, first_run_monitors)
                except Exception as exc:
                    logger.warning("Poller: monitors cycle error: %s", exc)
                first_run_monitors = False

            # --- News ---
            if now - last_news >= interval_news:
                last_news = now
                try:
                    await _poll_news(db, r, first_run_news)
                except Exception as exc:
                    logger.warning("Poller: news cycle error: %s", exc)
                first_run_news = False

        except Exception as exc:
            logger.error("Poller: unexpected error in main loop: %s", exc)
        finally:
            db.close()

    logger.info("Notification poller stopped.")


async def stop_poller() -> None:
    """Signal the poller loop to stop."""
    global _stop_event, _redis
    if _stop_event:
        _stop_event.set()
    if _redis:
        await _redis.close()
        _redis = None
