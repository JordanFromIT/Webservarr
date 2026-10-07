"""
Background notification poller.

Runs three independent polling loops that detect events from
Seerr (requests/issues), Uptime Kuma (monitor status, which keeps the status
feed's outages: app/services/status_feed.py), and the local NewsPost table.
When an event is detected it creates a Notification row (with dedup) and
dispatches a Web Push via send_push_to_users().

Architecture:
    start_poller()  -- launched as asyncio.create_task in main.py lifespan
    stop_poller()   -- sets a flag; the loop exits on the next tick

Every uvicorn worker runs the lifespan, so every worker starts a poller. Only
the one holding the Redis leader lease (LeaderLease) actually polls; the
others wait and take over when the lease lapses. Without it each worker
detected the same change and every user got duplicate notifications.
"""

import asyncio
import hashlib
import logging
import os
import socket
import uuid
from datetime import datetime, timezone
from typing import Optional, Set

import httpx
import redis.asyncio as aioredis
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import Notification, NewsPost, PushSubscription, Setting, Ticket, TicketComment
from app.services.push import send_push_to_users
from app.services import status_feed
from app.utils import identity_email

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

_stop_event: Optional[asyncio.Event] = None
_redis: Optional[aioredis.Redis] = None
_lease: Optional["LeaderLease"] = None

# Seerr media-status codes (used on media objects)
MEDIA_STATUS_MAP = {
    1: "unknown",
    2: "pending",
    3: "processing",
    4: "partially_available",
    5: "available",
}

# Seerr issue-status codes
ISSUE_STATUS_MAP = {
    1: "open",
    2: "resolved",
}

# Minimum configurable poll interval (seconds)
MIN_INTERVAL = 30

# Default poll intervals (seconds)
DEFAULT_SEERR_INTERVAL = 60
DEFAULT_MONITORS_INTERVAL = 60
DEFAULT_NEWS_INTERVAL = 60

# Internal tick — how often we check whether a poll is due
TICK_SECONDS = 5
# How often held Sonarr files are checked (they wait status_feed.LIBRARY_HOLD).
LIBRARY_TIDY_INTERVAL = 60

# Leader lease: the holder renews it every tick. The TTL covers a couple of
# missed renewals, and bounds how long polling stops if the leader dies.
LEADER_KEY = "poller:leader"
LEASE_TTL = TICK_SECONDS * 3

# Renew / release only while the lease is still ours, atomically, so a worker
# whose lease already lapsed can never extend or delete the new holder's.
_RENEW_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
"""
_RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


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


class LeaderLease:
    """A Redis lease that lets exactly one worker run the poller.

    ``refresh()`` takes the lease if it is free (SET NX EX) or renews it if
    this worker already holds it, and records the outcome in ``held``.
    """

    def __init__(self, r, key: str = LEADER_KEY, ttl: int = LEASE_TTL, owner: Optional[str] = None):
        self._r = r
        self.key = key
        self.ttl = ttl
        self.owner = owner or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self.held = False

    async def refresh(self) -> bool:
        was_held = self.held
        try:
            if await self._r.set(self.key, self.owner, nx=True, ex=self.ttl):
                self.held = True
            else:
                renewed = await self._r.eval(_RENEW_SCRIPT, 1, self.key, self.owner, self.ttl)
                self.held = bool(renewed)
        except Exception as exc:
            # Unknown state: stand down. If we were leader the lease will
            # lapse and whoever can reach Redis takes over.
            logger.warning("Lease %s: check failed: %s", self.key, exc)
            self.held = False
        if self.held != was_held:
            # Name the key: the class also guards other one-at-a-time jobs
            # (the books catalog rebuild), whose lease is not the poller's.
            logger.info(
                "Lease %s: %s by %s",
                self.key,
                "acquired" if self.held else "lost",
                self.owner,
            )
        return self.held

    async def release(self) -> None:
        """Give the lease up now so another worker need not wait out the TTL."""
        if not self.held:
            return
        self.held = False
        try:
            await self._r.eval(_RELEASE_SCRIPT, 1, self.key, self.owner)
        except Exception as exc:
            logger.debug("Poller: lease release failed: %s", exc)


# The Redis claim only has to cover the window in which two pollers could be
# on the same item at once (a lease handover mid-pass); the committed
# Notification row is the long-term dedup record.
DEDUP_CLAIM_TTL = 10 * 60


async def _create_notification_once(
    r: aioredis.Redis,
    db: Session,
    user_email: str,
    category: str,
    title: str,
    body: str,
    reference_id: str,
) -> Optional[Notification]:
    """Create and commit one notification, at most once across workers.

    The table check is an unlocked SELECT and Notification has no unique
    constraint, so two pollers processing the same item at once would both
    insert and push. A short Redis SET NX claim on the dedup triple lets one
    proceed. The row is committed here, per recipient: if that fails the
    claim is released, so a later poll can retry, and the caller moves on to
    the next recipient with nothing of theirs lost.
    """
    email = identity_email(user_email)
    if not email:
        return None  # no identity to address it to
    if _dedup_exists(db, email, category, reference_id):
        return None
    if not _user_wants_category(db, email, category):
        return None
    digest = hashlib.sha256(f"{email}|{category}|{reference_id}".encode()).hexdigest()[:32]
    claim = f"poller:notified:{digest}"
    if not await r.set(claim, "1", nx=True, ex=DEDUP_CLAIM_TTL):
        return None
    try:
        notif = _create_notification(db, email, category, title, body, reference_id)
        if notif is None:
            await r.delete(claim)
            return None
        db.commit()
        return notif
    except Exception as exc:
        db.rollback()
        try:
            await r.delete(claim)
        except Exception:
            pass  # it lapses on its own within DEDUP_CLAIM_TTL
        logger.warning("Poller: could not save %s notification for %s: %s", category, email, exc)
        return None


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
            email = identity_email(email_str)
            if email:  # accounts without an email are never targeted
                emails.add(email)
        if cursor == 0:
            break
    return emails


def _collect_push_emails(db: Session) -> Set[str]:
    """Emails of every user with at least one stored push subscription."""
    return {
        email
        for email in (identity_email(row.user_email)
                      for row in db.query(PushSubscription.user_email).distinct().all())
        if email
    }


async def _collect_recipient_emails(r: aioredis.Redis, db: Session) -> Set[str]:
    """Everyone a broadcast should reach: live sessions plus push subscribers.

    Sessions alone are not enough: Redis is emptied on every restart, so right
    after a deploy nobody has a session and a user who is not on the site
    (the whole point of push) would never be targeted.
    """
    return await _collect_session_emails(r) | _collect_push_emails(db)


def _parse_monitor_snapshot(raw) -> tuple:
    """Split a ``poller:monitor:<id>`` value into (status, since).

    Stored as ``<status>|<since>``; a plain ``<status>`` written by an older
    version reads as (status, None). No value reads as (None, None).
    """
    if raw is None:
        return None, None
    text = raw.decode() if isinstance(raw, bytes) else str(raw)
    status, sep, since = text.partition("|")
    return status, (since if sep else None)


async def _ticket_creator_email(r: aioredis.Redis, db: Session, ticket) -> Optional[str]:
    """Where a ticket alert goes, or None if the creator can't be reached.

    Tickets record the creator's email (creator_email): it is the target, as
    long as _collect_recipient_emails would reach it (live session or push
    subscription). A ticket without one is matched to a live session by its
    owner's account identity (creator_identity, see tickets.account_identity),
    never by username: usernames from different sign-in methods (local, Plex,
    OIDC) can collide. A ticket with neither reaches nobody.
    """
    if ticket.creator_email:
        email = identity_email(ticket.creator_email)
        if not email:
            return None
        return email if email in await _collect_recipient_emails(r, db) else None

    identity = ticket.creator_identity
    if not identity:
        return None
    from app.routers.tickets import account_identity

    cursor = 0
    while True:
        cursor, keys = await r.scan(cursor, match="session:*", count=100)
        for key in keys:
            raw = await r.hgetall(key)
            data = {
                (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v)
                for k, v in raw.items()
            }
            if account_identity(data) == identity:
                found = identity_email(data.get("email"))
                if found:
                    return found
        if cursor == 0:
            return None


# ---------------------------------------------------------------------------
# Seerr config helper
# ---------------------------------------------------------------------------

def _get_seerr_config() -> dict:
    """Read Seerr config using a short-lived session."""
    db = SessionLocal()
    try:
        url_row = db.query(Setting).filter(Setting.key == "integration.seerr.url").first()
        key_row = db.query(Setting).filter(Setting.key == "integration.seerr.api_key").first()
        return {
            "url": url_row.value.rstrip("/") if url_row else None,
            "api_key": key_row.value if key_row else None,
        }
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Poll: Seerr requests
# ---------------------------------------------------------------------------

async def _poll_seerr_requests(r: aioredis.Redis) -> None:
    config = _get_seerr_config()
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
                logger.warning("Poller: Seerr requests HTTP %d", resp.status_code)
                return

            results = resp.json().get("results", [])
            try:
                await record_new_requests(results)
            except Exception as exc:  # noqa: BLE001 - the notifications below still go out
                logger.warning("Poller: new requests could not be written to the event log: %s",
                               type(exc).__name__)

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

                if prev_status is None:
                    continue  # no baseline yet: seed silently

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
                    # Use short-lived session for DB write
                    db = SessionLocal()
                    try:
                        notif = await _create_notification_once(
                            r,
                            db,
                            requester_email,
                            "request",
                            "Your request is available",
                            f"{title} is now available on Plex",
                            ref_id,
                        )
                        if notif:
                            await send_push_to_users(
                                [requester_email],
                                notif.title,
                                notif.body or "",
                                "request",
                                url="/",
                            )
                    finally:
                        db.close()

    except Exception as exc:
        logger.warning("Poller: Seerr requests error: %s", exc)


# The highest Seerr request id the event log has dealt with (spec section
# 11.1). Seerr's ids only grow, so a request above it is new; kept in the
# database, so a restart (which empties Redis) announces nothing again.
SEERR_REQUESTS_SEEN_KEY = "status_feed.seerr_requests_seen"
SEERR_DECLINED = 3


def _request_id(req) -> int:
    rid = req.get("id") if isinstance(req, dict) else None
    return rid if isinstance(rid, int) and not isinstance(rid, bool) and rid > 0 else 0


async def record_new_requests(results: list) -> int:
    """Write "Requested: <title>" for each request in Seerr's newest
    `results` that the event log hasn't seen, oldest first; how many were
    written. The first read ever only stores the highest id: the requests
    already there are never announced. A declined request, or one whose
    title Seerr can't name, makes no line; when Seerr names none of them,
    nothing moves on and the next cycle tries again. Never names who asked."""
    from app.integrations import seerr
    from app.services import activity_lines

    requests = sorted((r for r in results if _request_id(r)), key=_request_id)
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == SEERR_REQUESTS_SEEN_KEY).first()
        try:
            seen = int(row.value) if row is not None else None
        except (TypeError, ValueError):
            seen = None
        highest = max((_request_id(r) for r in requests), default=0)
        if seen is None:
            if row is None:
                db.add(Setting(key=SEERR_REQUESTS_SEEN_KEY, value=str(highest),
                               description="Seerr requests the event log has dealt with (internal)"))
            else:
                row.value = str(highest)
            db.commit()
            logger.info("Event log: %d existing Seerr request(s) counted as seen", len(requests))
            return 0
        new = [r for r in requests if _request_id(r) > seen
               and r.get("status") != SEERR_DECLINED and (r.get("media") or {}).get("tmdbId")]
        written = 0
        if new:
            titles = await seerr.lookup_titles([{"tmdb_id": r["media"]["tmdbId"], "media_type": r.get("type")}
                                                for r in new])
            if not titles:
                return 0                # Seerr named none of them: try again next cycle
            for r in new:
                found = titles.get(r["media"]["tmdbId"]) or {}
                text = activity_lines.request_line(found.get("title"),
                                                   found.get("year") if r.get("type") == "movie" else None)
                if text is None:
                    logger.info("Event log: Seerr request %d has no title to show", _request_id(r))
                    continue
                if status_feed.record_request(db, f"seerr-request:{_request_id(r)}", text, status_feed.now_utc()):
                    written += 1
        if highest > seen:
            (db.query(Setting).filter(Setting.key == SEERR_REQUESTS_SEEN_KEY, Setting.value == str(seen))
             .update({Setting.value: str(highest)}, synchronize_session=False))
            db.commit()
        return written
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Poll: Seerr issues
# ---------------------------------------------------------------------------

async def _poll_seerr_issues(r: aioredis.Redis) -> None:
    config = _get_seerr_config()
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
                logger.warning("Poller: Seerr issues HTTP %d", list_resp.status_code)
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

                if prev is None:
                    continue  # no baseline yet: seed silently

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
                    db = SessionLocal()
                    try:
                        notif = await _create_notification_once(
                            r,
                            db,
                            creator_email,
                            "issue",
                            "Your issue has been resolved",
                            f"The issue for {media_title} has been resolved",
                            ref_id,
                        )
                        if notif:
                            await send_push_to_users(
                                [creator_email],
                                notif.title,
                                notif.body or "",
                                "issue",
                                url="/issues",
                            )
                    finally:
                        db.close()

                # New comments
                if comment_count > prev_count:
                    ref_id = f"issue:{issue_id}:comment:{comment_count}"
                    db = SessionLocal()
                    try:
                        notif = await _create_notification_once(
                            r,
                            db,
                            creator_email,
                            "issue",
                            "New response on your issue",
                            f"New comment on your issue for {media_title}",
                            ref_id,
                        )
                        if notif:
                            await send_push_to_users(
                                [creator_email],
                                notif.title,
                                notif.body or "",
                                "issue",
                                url="/issues",
                            )
                    finally:
                        db.close()

    except Exception as exc:
        logger.warning("Poller: Seerr issues error: %s", exc)


# ---------------------------------------------------------------------------
# Poll: Uptime Kuma monitors
# ---------------------------------------------------------------------------

async def _poll_monitors(r: aioredis.Redis,
                         kuma_ok_ttl: int = status_feed.KUMA_OK_POLLS * DEFAULT_MONITORS_INTERVAL) -> None:
    """Read Uptime Kuma and keep the status feed's outages in step with it.

    An outage opens on the second poll in a row that finds a monitor down, so
    one that flaps (down, up, down) opens nothing, and closes on the first
    poll that finds it up, or on the second in a row that doesn't find it at
    all (removed, or taken off the status page). A monitor switched off in
    Settings opens nothing. When Uptime Kuma doesn't answer nothing opens or
    closes, and the feed is told so (status_feed.KUMA_OK_KEY, kept for
    `kuma_ok_ttl` seconds after each answer). The "down" notifications and
    pushes are push_status_updates' job; the "back" ones go out as an
    outage closes, to whoever got its "down" (_notify_back).
    """
    from app.integrations.uptime_kuma import read_monitors

    try:
        monitors = await read_monitors()
    except Exception as exc:
        logger.warning("Poller: monitor fetch error: %s", exc)
        monitors = None

    if monitors is None:
        await r.delete(status_feed.KUMA_OK_KEY)
        return
    await r.set(status_feed.KUMA_OK_KEY, "1", ex=kuma_ok_ttl)

    now = status_feed.now_utc()
    db = SessionLocal()
    try:
        for mon in monitors:
            await _track_monitor(r, db, mon, now)
        listed = {mon.get("id", 0) for mon in monitors}
        for monitor_id in status_feed.open_outage_monitors(db):
            if monitor_id not in listed:
                await _track_missing_monitor(r, db, monitor_id, now)
    finally:
        db.close()


async def _track_monitor(r: aioredis.Redis, db: Session, mon: dict, now: datetime) -> None:
    """One monitor's poll: record what it is now and open or close its outage."""
    monitor_id = mon.get("id", 0)
    name = mon.get("name") or f"Monitor {monitor_id}"
    status_label = mon.get("status", "unknown")

    # The last status seen and when it began, kept in Redis between polls.
    redis_key = f"poller:monitor:{monitor_id}"
    seen, since = _parse_monitor_snapshot(await r.get(redis_key))
    if status_label != seen:
        # A new status. Its marker is fixed once, here: the start of the run
        # when the status page still shows it, else the time we noticed. The
        # page only returns the last few dozen beats, so recomputing it on
        # later polls would slide with every poll during a long outage.
        since = mon.get("status_since") or now.isoformat(timespec="seconds")
        await r.set(redis_key, f"{status_label}|{since}")

    if status_label == "down" and seen == "down":
        if status_feed.monitor_enabled(db, monitor_id):
            status_feed.open_outage(db, monitor_id, name, status_feed.parse_time(since, now), now)
    elif status_label == "up":
        closed = status_feed.close_outage(db, monitor_id, now)
        if closed is not None:
            await _notify_back(r, db, closed)


# A monitor's snapshot while it has an open outage but the status page
# doesn't list it.
MONITOR_MISSING = "missing"


async def _track_missing_monitor(r: aioredis.Redis, db: Session, monitor_id: int, now: datetime) -> None:
    """One poll of a monitor with an open outage that Uptime Kuma's answer
    left out: the outage closes as "no longer monitored" on the second answer
    in a row without it, the same debounce as going down."""
    redis_key = f"poller:monitor:{monitor_id}"
    seen, _ = _parse_monitor_snapshot(await r.get(redis_key))
    if seen != MONITOR_MISSING:
        await r.set(redis_key, f"{MONITOR_MISSING}|{now.isoformat(timespec='seconds')}")
        return
    status_feed.close_unmonitored(db, monitor_id, now)


def _status_ref(row_id: int) -> str:
    """The reference_id of an update's in-app notification."""
    return f"status:{row_id}"


async def _notify_status(r: aioredis.Redis, db: Session, emails: Set[str],
                         title: str, body: str, ref_id: str) -> None:
    """File a "status" notification for each of `emails` who wants them
    (once per ref_id) and push it to their devices."""
    notified = []
    for email in emails:
        if await _create_notification_once(r, db, email, "status", title, body, ref_id):
            notified.append(email)
    if notified:
        try:
            await send_push_to_users(notified, title, body, "status", url="/status")
        except Exception as exc:  # noqa: BLE001 - the notifications are saved; a push is best effort
            logger.warning("Poller: a status push could not be sent: %s", type(exc).__name__)


async def _notify_back(r: aioredis.Redis, db: Session, row) -> None:
    """Tell the people who were told an outage was down that it is back.

    Only a confirmed outage (status_feed.CONFIRMED_AFTER) reached anyone's
    bell, so a short one sends nothing here either. Called by whichever
    poll closed it (status_feed.close_outage closes it once across workers).
    """
    down_ref = _status_ref(row.id)
    told = {email for (email,) in db.query(Notification.user_email)
            .filter(Notification.category == "status", Notification.reference_id == down_ref)
            .distinct().all()}
    if not told:
        return
    title, body = status_feed.back_text(row)
    await _notify_status(r, db, told, title, body, f"{down_ref}:back")


async def push_status_updates(r: aioredis.Redis) -> int:
    """Push every status update that is due (status_feed.due_pushes): a
    confirmed outage (down CONFIRMED_AFTER or longer), while Uptime Kuma is
    still answering (never on a reading that may be stale), and an important
    note. A shorter outage never reaches the bell or a device.

    Each update is pushed at most once across workers: its push is claimed
    in the database before anything is sent, so a failed send is not
    retried. Everyone a broadcast reaches gets an in-app notification in the
    "status" category, unless they turned it off, and a push to their
    devices. Returns how many updates were pushed.
    """
    include_outages = await r.get(status_feed.KUMA_OK_KEY) is not None
    now = status_feed.now_utc()
    pushed = 0
    db = SessionLocal()
    try:
        for row in status_feed.due_pushes(db, now, include_outages):
            if not status_feed.claim_push(db, row.id, now):
                continue  # another worker has it, or it closed
            pushed += 1
            title, body = status_feed.push_text(row, now)
            await _notify_status(r, db, await _collect_recipient_emails(r, db), title, body,
                                 _status_ref(row.id))
    finally:
        db.close()
    return pushed


def tidy_library_lines() -> None:
    """Publish the Sonarr files no Import Complete took in time, and delete
    library lines past the feed's window (status_feed)."""
    now = status_feed.now_utc()
    db = SessionLocal()
    try:
        status_feed.publish_held_library_lines(db, now)
        status_feed.prune_library_lines(db, now)
        status_feed.prune_event_refs(db, now)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Poll: News posts
# ---------------------------------------------------------------------------

async def _poll_news(r: aioredis.Redis) -> None:
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

    if last_check is None:
        return  # no baseline yet: seed silently — don't flood

    db = SessionLocal()
    try:
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
        all_emails = await _collect_recipient_emails(r, db)

        if not all_emails:
            return

        for post in new_posts:
            ref_id = f"news:{post.id}"
            notified_emails = []
            for email in all_emails:
                notif = await _create_notification_once(
                    r,
                    db, email, "news", "New announcement", post.title, ref_id
                )
                if notif:
                    notified_emails.append(email)

            if notified_emails:
                await send_push_to_users(
                    notified_emails,
                    "New announcement",
                    post.title,
                    "news",
                    url="/",
                )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Poll: Support tickets
# ---------------------------------------------------------------------------

async def _poll_tickets(r: aioredis.Redis) -> None:
    """Detect admin comments and status changes on support tickets."""
    db = SessionLocal()
    try:
        try:
            tickets = db.query(Ticket).all()
        except Exception as exc:
            logger.warning("Poller: ticket query error: %s", exc)
            return

        if not tickets:
            return

        for ticket in tickets:
            ticket_id = ticket.id
            current_status = ticket.status or "open"

            # Count comments and find the newest admin comment
            comments = (
                db.query(TicketComment)
                .filter(TicketComment.ticket_id == ticket_id)
                .order_by(TicketComment.created_at.asc())
                .all()
            )
            comment_count = len(comments)

            redis_key = f"poller:ticket:{ticket_id}"
            prev = await r.get(redis_key)
            snapshot_val = f"{comment_count}:{current_status}"
            await r.set(redis_key, snapshot_val)

            if prev is None:
                continue  # no baseline yet: seed silently

            prev_str = prev.decode()
            try:
                prev_count_str, prev_status = prev_str.split(":", 1)
                prev_count = int(prev_count_str)
            except (ValueError, IndexError):
                prev_count = 0
                prev_status = "open"

            creator_email = await _ticket_creator_email(r, db, ticket)
            if not creator_email:
                continue

            ticket_title = ticket.title or f"Ticket #{ticket_id}"

            # Check for new admin comments
            if comment_count > prev_count:
                # Check if the newest comment is from an admin
                newest_comment = comments[-1] if comments else None
                if newest_comment and newest_comment.is_admin:
                    ref_id = f"ticket:{ticket_id}:comment:{comment_count}"
                    notif = await _create_notification_once(
                        r,
                        db,
                        creator_email,
                        "ticket",
                        "New response on your ticket",
                        f"Admin replied to: {ticket_title}",
                        ref_id,
                    )
                    if notif:
                        await send_push_to_users(
                            [creator_email],
                            notif.title,
                            notif.body or "",
                            "ticket",
                            url="/tickets",
                        )

            # Check for status change
            if current_status != prev_status:
                ref_id = f"ticket:{ticket_id}:status:{current_status}"
                notif = await _create_notification_once(
                    r,
                    db,
                    creator_email,
                    "ticket",
                    f"Ticket status updated to {current_status}",
                    f"Your ticket \"{ticket_title}\" is now {current_status}",
                    ref_id,
                )
                if notif:
                    await send_push_to_users(
                        [creator_email],
                        notif.title,
                        notif.body or "",
                        "ticket",
                        url="/tickets",
                    )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

async def start_poller() -> None:
    """Main poller loop — runs until stop_poller() is called."""
    global _stop_event, _lease
    _stop_event = asyncio.Event()

    logger.info("Notification poller starting...")

    r = await _get_redis()

    # The lease is renewed by its own task, not between polls: one Seerr pass
    # can take longer than the TTL, and the lease must not lapse mid-cycle.
    lease = LeaderLease(r)
    _lease = lease
    await lease.refresh()

    async def _keep_lease() -> None:
        while not _stop_event.is_set():
            try:
                await asyncio.wait_for(_stop_event.wait(), timeout=TICK_SECONDS)
                break
            except asyncio.TimeoutError:
                pass
            await lease.refresh()

    lease_task = asyncio.create_task(_keep_lease())
    try:
        await _poll_forever(r, lease)
    finally:
        lease_task.cancel()
        await lease.release()


async def _poll_forever(r: aioredis.Redis, lease: "LeaderLease") -> None:
    """The polling loop proper; polls only while this worker holds the lease."""

    # Whether to stay silent is decided per item by whether Redis already
    # holds a baseline for it, never by a flag in this process: Redis outlives
    # a uvicorn restart (supervisord restarts it alone) and a lease handover,
    # and a fresh leader must alert on the first change it sees against the
    # baseline its predecessor left. A full restart empties Redis, so that
    # still seeds silently.

    # Track when each poller last ran (epoch seconds)
    last_seerr = 0.0
    last_monitors = 0.0
    last_news = 0.0
    last_tickets = 0.0
    last_library = 0.0
    # The Books catalog is rebuilt in a task of its own: a rebuild reads Kavita
    # and Plex over the network and must not hold up the notification polls.
    # Its own Redis lock keeps two rebuilds (this one, a webhook's, an admin's)
    # from running at once. The first rebuild is due as soon as this worker
    # leads, so a fresh install has a catalog without waiting out the interval.
    from app.services import book_catalog
    last_books = -book_catalog.REBUILD_INTERVAL
    books_task: Optional[asyncio.Task] = None

    async def _rebuild_books() -> None:
        try:
            await book_catalog.rebuild("schedule")
        except Exception as exc:
            logger.warning("Poller: books catalog rebuild failed: %s", type(exc).__name__)

    # Book ratings still to be written to Kavita or Plex are tried again in a
    # task of their own too (each try is a call to Kavita or Plex as that
    # person).
    from app.services import book_personal
    last_ratings = -book_personal.RETRY_INTERVAL
    ratings_task: Optional[asyncio.Task] = None

    async def _retry_ratings() -> None:
        try:
            await book_personal.retry_due(r)
        except Exception as exc:
            logger.warning("Poller: book rating retries failed: %s", type(exc).__name__)

    # Books discovery: popularity (Plex's play history and the player's own
    # data) and the listening rollup, at most hourly, in a task of its own.
    from app.services import book_discovery
    last_discovery = -book_discovery.POPULARITY_INTERVAL
    discovery_task: Optional[asyncio.Task] = None

    async def _refresh_discovery() -> None:
        try:
            await book_discovery.refresh()
        except Exception as exc:
            logger.warning("Poller: books discovery refresh failed: %s", type(exc).__name__)

    while not _stop_event.is_set():
        try:
            await asyncio.wait_for(_stop_event.wait(), timeout=TICK_SECONDS)
            break  # stop_event was set
        except asyncio.TimeoutError:
            pass  # tick expired, check if any poll is due

        if not lease.held:
            continue  # another worker is polling

        now = asyncio.get_event_loop().time()

        # Read intervals from DB with short-lived session
        db = SessionLocal()
        try:
            interval_seerr = _get_setting_int(
                db, "notifications.poll_interval_seerr", DEFAULT_SEERR_INTERVAL
            )
            interval_monitors = _get_setting_int(
                db, "notifications.poll_interval_monitors", DEFAULT_MONITORS_INTERVAL
            )
            interval_news = _get_setting_int(
                db, "notifications.poll_interval_news", DEFAULT_NEWS_INTERVAL
            )
            interval_tickets = _get_setting_int(
                db, "notifications.poll_interval_tickets", DEFAULT_SEERR_INTERVAL
            )
        finally:
            db.close()

        try:
            # --- Seerr ---
            if lease.held and now - last_seerr >= interval_seerr:
                last_seerr = now
                try:
                    await _poll_seerr_requests(r)
                    await _poll_seerr_issues(r)
                except Exception as exc:
                    logger.warning("Poller: seerr cycle error: %s", exc)

            # --- Monitors ---
            if lease.held and now - last_monitors >= interval_monitors:
                last_monitors = now
                try:
                    await _poll_monitors(r, status_feed.KUMA_OK_POLLS * interval_monitors)
                except Exception as exc:
                    logger.warning("Poller: monitors cycle error: %s", exc)

            # --- Status feed pushes: every tick, so an important note goes
            # out within seconds whatever the monitor interval ---
            if lease.held:
                try:
                    await push_status_updates(r)
                except Exception as exc:
                    logger.warning("Poller: status push error: %s", exc)

            # --- Library lines: held Sonarr files, and the 30-day window ---
            if lease.held and now - last_library >= LIBRARY_TIDY_INTERVAL:
                last_library = now
                try:
                    tidy_library_lines()
                except Exception as exc:
                    logger.warning("Poller: library lines error: %s", type(exc).__name__)

            # --- News ---
            if lease.held and now - last_news >= interval_news:
                last_news = now
                try:
                    await _poll_news(r)
                except Exception as exc:
                    logger.warning("Poller: news cycle error: %s", exc)

            # --- Tickets ---
            if lease.held and now - last_tickets >= interval_tickets:
                last_tickets = now
                try:
                    await _poll_tickets(r)
                except Exception as exc:
                    logger.warning("Poller: tickets cycle error: %s", exc)

            # --- Books catalog ---
            if (lease.held and now - last_books >= book_catalog.REBUILD_INTERVAL
                    and (books_task is None or books_task.done())):
                last_books = now
                books_task = asyncio.create_task(_rebuild_books())

            # --- Book rating write-through retries ---
            if (lease.held and now - last_ratings >= book_personal.RETRY_INTERVAL
                    and (ratings_task is None or ratings_task.done())):
                last_ratings = now
                ratings_task = asyncio.create_task(_retry_ratings())

            # --- Books discovery: popularity and the listening rollup ---
            if (lease.held and now - last_discovery >= book_discovery.POPULARITY_INTERVAL
                    and (discovery_task is None or discovery_task.done())):
                last_discovery = now
                discovery_task = asyncio.create_task(_refresh_discovery())

        except Exception as exc:
            logger.error("Poller: unexpected error in main loop: %s", exc)

    if books_task is not None and not books_task.done():
        books_task.cancel()
    if ratings_task is not None and not ratings_task.done():
        ratings_task.cancel()
    if discovery_task is not None and not discovery_task.done():
        discovery_task.cancel()
    logger.info("Notification poller stopped.")


async def stop_poller() -> None:
    """Signal the poller loop to stop."""
    global _stop_event, _redis, _lease
    if _stop_event:
        _stop_event.set()
    if _lease:
        await _lease.release()
        _lease = None
    if _redis:
        await _redis.close()
        _redis = None
