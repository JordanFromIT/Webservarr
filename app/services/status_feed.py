"""
The status feed: outages Uptime Kuma reports, admins' notes and library
events from Sonarr, Radarr and Chaptarr, newest first (spec
docs/superpowers/specs/2026-10-04-home-redesign-and-status-feed-design.md,
section 3, and 2026-10-05-event-log-library-events-design.md).

The rows are StatusUpdate. The notification poller opens and closes outages
(notification_poller._poll_monitors) and sends the pushes
(notification_poller.push_status_updates); app/routers/status.py serves the
feed and keeps the notes.

uvicorn runs two workers, and anything here that must happen once is decided
by the database in one statement, never by a check in one process: an outage
opens only while the partial unique index ux_status_updates_open_monitor
allows it, closes in an UPDATE that matches only while it is open, and its
push is claimed in an UPDATE that matches only while pushed_at is empty.
A library event is written once by the unique index on its event_key.

Library lines are never pinned, never pushed and never an outage: they only
show in the history, and are kept LIBRARY_DAYS.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from sqlalchemy import and_, func, not_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.integrations import config as integration_config
from app.models import Setting, StatusUpdate
from app.services.library_lines import GRAB_NOTE, LibraryEvent
from app.utils import utc_iso

logger = logging.getLogger(__name__)

AUTO = "auto"
ADMIN = "admin"
LIBRARY = "library"

# An outage is pushed once it has lasted this long; an important note at once.
PUSH_AFTER = timedelta(minutes=10)

NOTE_MAX = 280
SERVICE_MAX = 100
FEED_DAYS_DEFAULT = 30
FEED_DAYS_MAX = 90
# History is short lines; this only bounds a pathological month.
FEED_ITEMS_MAX = 200

# A Sonarr per-file import waits this long for its Import Complete before it
# is published on its own; library lines are deleted after LIBRARY_DAYS.
LIBRARY_HOLD = timedelta(minutes=10)
LIBRARY_DAYS = 30

# The poller sets this each time Uptime Kuma answers, to expire after a few
# poll intervals, and deletes it when Kuma doesn't answer. No key means the
# feed can't vouch for anything (Kuma silent, or no poller running), so it
# says "unavailable" rather than "everything is running".
KUMA_OK_KEY = "status:kuma_ok"
KUMA_OK_POLLS = 3
REDIS_TIMEOUT = 1.0


def now_utc() -> datetime:
    """Now, as the database stores time: naive UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def parse_time(value, fallback: datetime) -> datetime:
    """A heartbeat time or the poller's own marker as naive UTC, or
    `fallback` when there is none or it can't be read. Uptime Kuma sends UTC
    as "YYYY-MM-DD HH:MM:SS(.fff)"; the poller's markers carry an offset."""
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return fallback
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def duration_text(seconds: float) -> str:
    """How long something lasted, the way the feed says it: "12 min",
    "1 h 5 min", "2 days 3 h"."""
    minutes = int(max(seconds, 0) // 60)
    if minutes < 1:
        return "under a minute"
    if minutes < 60:
        return f"{minutes} min"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours} h" + (f" {minutes} min" if minutes else "")
    days, hours = divmod(hours, 24)
    return f"{days} day{'' if days == 1 else 's'}" + (f" {hours} h" if hours else "")


def monitor_enabled(db: Session, monitor_id) -> bool:
    """False when the monitor is switched off in Settings (monitor.<id>.enabled)."""
    row = db.query(Setting).filter(Setting.key == f"monitor.{monitor_id}.enabled").first()
    return not (row and (row.value or "").lower() == "false")


def kuma_configured(db: Session) -> bool:
    row = db.query(Setting).filter(Setting.key == integration_config.url_key("uptime_kuma")).first()
    return bool(row and (row.value or "").strip())


async def kuma_answering() -> bool:
    """Whether the poller heard from Uptime Kuma lately (KUMA_OK_KEY). False
    when Redis can't say, which the feed reports as "unavailable"."""
    async def _read():
        from app.auth import session_manager
        redis = await session_manager.get_redis()
        return await redis.get(KUMA_OK_KEY)

    try:
        return await asyncio.wait_for(_read(), timeout=REDIS_TIMEOUT) is not None
    except Exception as exc:  # noqa: BLE001 - not knowing is an answer: "unavailable"
        logger.debug("Could not read whether Uptime Kuma answered: %s", type(exc).__name__)
        return False


# --- Outages ------------------------------------------------------------------------

def _open_outage(db: Session, monitor_id) -> Optional[StatusUpdate]:
    return (db.query(StatusUpdate)
            .filter(StatusUpdate.source == AUTO, StatusUpdate.monitor_id == monitor_id,
                    StatusUpdate.active.is_(True))
            .first())


def open_outage(db: Session, monitor_id: int, name: str, started_at: datetime,
                now: datetime) -> Optional[StatusUpdate]:
    """Open "<name> is down" for the monitor. None when one is already open,
    including one the other worker opened a moment ago (the unique index)."""
    if _open_outage(db, monitor_id) is not None:
        return None
    line = f"{name} is down"
    row = StatusUpdate(source=AUTO, monitor_id=monitor_id, service_name=name[:SERVICE_MAX],
                       title=line[:200], message=line, update_type="incident", severity="critical",
                       author_id="", author_name="", active=True, important=False,
                       started_at=min(started_at, now), created_at=now)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return None
    return row


def close_outage(db: Session, monitor_id: int, now: datetime) -> Optional[StatusUpdate]:
    """Close the monitor's open outage as "<name> is back, down <duration>".
    None when there is none, or the other worker closed it first."""
    row = _open_outage(db, monitor_id)
    if row is None:
        return None
    began = row.started_at or row.created_at or now
    line = f"{row.service_name or f'Monitor {monitor_id}'} is back, down {duration_text((now - began).total_seconds())}"
    closed = (db.query(StatusUpdate)
              .filter(StatusUpdate.id == row.id, StatusUpdate.active.is_(True))
              .update({StatusUpdate.active: False, StatusUpdate.ended_at: now, StatusUpdate.resolved_at: now,
                       StatusUpdate.update_type: "resolved", StatusUpdate.title: line[:200],
                       StatusUpdate.message: line}, synchronize_session=False))
    db.commit()
    return row if closed else None


# --- Pushes -------------------------------------------------------------------------

def due_pushes(db: Session, now: datetime, include_outages: bool = True) -> List[StatusUpdate]:
    """The updates whose push is due and not yet claimed: an open outage that
    began PUSH_AFTER ago or more (only when `include_outages`), and an open
    important note."""
    due = [and_(StatusUpdate.source == ADMIN, StatusUpdate.important.is_(True))]
    if include_outages:
        due.append(and_(StatusUpdate.source == AUTO, StatusUpdate.started_at <= now - PUSH_AFTER))
    return (db.query(StatusUpdate)
            .filter(StatusUpdate.active.is_(True), StatusUpdate.pushed_at.is_(None), or_(*due))
            .order_by(StatusUpdate.id)
            .all())


def claim_push(db: Session, row_id: int, now: datetime) -> bool:
    """Take the one push this update gets. False when it was already taken."""
    taken = (db.query(StatusUpdate)
             .filter(StatusUpdate.id == row_id, StatusUpdate.pushed_at.is_(None))
             .update({StatusUpdate.pushed_at: now}, synchronize_session=False))
    db.commit()
    return taken == 1


def push_text(row: StatusUpdate, now: datetime) -> Tuple[str, str]:
    """(title, body) of the update's push."""
    if row.source == AUTO:
        began = row.started_at or row.created_at or now
        return row.title, f"Down for {duration_text((now - began).total_seconds())}"
    return "Status update", row.message


# --- The feed -----------------------------------------------------------------------

def _pinned():
    """Open outages and open important notes: pinned above the history."""
    return and_(StatusUpdate.active.is_(True),
                or_(StatusUpdate.source == AUTO, StatusUpdate.important.is_(True)))


def item(row: StatusUpdate) -> dict:
    """One feed item as the API sends it. `at`: when it last changed. A
    library item also carries `note`: "not guaranteed" on a grab, else ""."""
    body = {
        "id": row.id,
        "source": row.source,
        "text": row.message,
        "service": row.service_name,
        "important": bool(row.important),
        "resolved": not row.active,
        "started_at": utc_iso(row.started_at),
        "ended_at": utc_iso(row.ended_at),
        "created_at": utc_iso(row.created_at),
        "at": utc_iso(row.resolved_at or row.created_at),
    }
    if row.source == LIBRARY:
        body["note"] = GRAB_NOTE if row.update_type == "grab" else ""
    return body


def feed(db: Session, days: int, now: datetime) -> dict:
    """{"open": [...], "items": [...]}: the pinned updates, newest first, then
    everything else that changed in the last `days` days, newest first."""
    began = func.coalesce(StatusUpdate.started_at, StatusUpdate.created_at)
    pinned = db.query(StatusUpdate).filter(_pinned()).order_by(began.desc(), StatusUpdate.id.desc()).all()
    changed = func.coalesce(StatusUpdate.resolved_at, StatusUpdate.created_at)
    history = (db.query(StatusUpdate)
               .filter(not_(_pinned()), StatusUpdate.pending.is_(False), changed >= now - timedelta(days=days))
               .order_by(changed.desc(), StatusUpdate.id.desc())
               .limit(FEED_ITEMS_MAX)
               .all())
    return {"open": [item(r) for r in pinned], "items": [item(r) for r in history]}


def home_off(db: Session, now: datetime) -> bool:
    """Whether Home's event log is hidden: the feed would answer "off" with
    nothing but library lines in it (no Uptime Kuma, and no note or outage in
    the last FEED_DAYS_DEFAULT days). The page renders the section hidden
    then, so a person who never sees it never has its room; home.js hides it
    on the same rule."""
    if kuma_configured(db):
        return False
    body = feed(db, FEED_DAYS_DEFAULT, now)
    return not body["open"] and all(i["source"] == LIBRARY for i in body["items"])


def state(configured: bool, answering: bool, open_items: List[dict]) -> str:
    """The one-word state the feed leads with: "off" (no Uptime Kuma set
    up), "unavailable" (it hasn't answered lately: never claim all is well),
    "down" (an outage is open) or "ok"."""
    if not configured:
        return "off"
    if not answering:
        return "unavailable"
    if any(i["source"] == AUTO for i in open_items):
        return "down"
    return "ok"


# --- Library events -----------------------------------------------------------------

def _library_row(app: str, event: LibraryEvent, text: str, kind_word: str, now: datetime,
                 pending: bool = False) -> StatusUpdate:
    return StatusUpdate(source=LIBRARY, app=app, event_key=event.key,
                        title=text[:200], message=text, update_type=kind_word, severity="info",
                        author_id="", author_name="", active=False, important=False, pending=pending,
                        created_at=now)


def _commit_once(db: Session) -> bool:
    """Commit; False when the event's key was already written (by a retry, or
    the other worker a moment ago)."""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False
    return True


def record_library_event(db: Session, app: str, event: LibraryEvent, now: datetime) -> bool:
    """Write a translated webhook (library_lines.translate) to the feed. A
    "line" shows at once. A Sonarr per-file import ("file") is held back,
    keyed by its file, recording whether it was an upgrade. An Import
    Complete ("complete") takes the held files it names and writes one line:
    "Upgraded" when any of them was an upgrade, else "Added". False when the
    event was already written."""
    if event.kind == "complete":
        held = []
        if event.file_keys:
            held = (db.query(StatusUpdate)
                    .filter(StatusUpdate.source == LIBRARY, StatusUpdate.pending.is_(True),
                            StatusUpdate.event_key.in_(event.file_keys))
                    .all())
        upgraded = any(r.update_type == "upgrade" for r in held)
        # Taken and written in one commit: a line already written (the
        # other worker's) rolls the taking back too.
        if held:
            (db.query(StatusUpdate)
             .filter(StatusUpdate.id.in_([r.id for r in held]), StatusUpdate.pending.is_(True))
             .delete(synchronize_session=False))
        db.add(_library_row(app, event, event.upgrade_text if upgraded else event.text,
                            "upgrade" if upgraded else "import", now))
        return _commit_once(db)
    db.add(_library_row(app, event, event.text, event.kind_word, now, pending=event.kind == "file"))
    return _commit_once(db)


def publish_held_library_lines(db: Session, now: datetime) -> int:
    """Show every held Sonarr file no Import Complete took within
    LIBRARY_HOLD (Import Complete unticked, or its post lost), each as its own
    line, at the time it arrived. One UPDATE, so a file is published once."""
    published = (db.query(StatusUpdate)
                 .filter(StatusUpdate.source == LIBRARY, StatusUpdate.pending.is_(True),
                         StatusUpdate.created_at <= now - LIBRARY_HOLD)
                 .update({StatusUpdate.pending: False}, synchronize_session=False))
    db.commit()
    return published


def prune_library_lines(db: Session, now: datetime) -> int:
    """Delete library lines older than LIBRARY_DAYS."""
    gone = (db.query(StatusUpdate)
            .filter(StatusUpdate.source == LIBRARY, StatusUpdate.created_at < now - timedelta(days=LIBRARY_DAYS))
            .delete(synchronize_session=False))
    db.commit()
    return gone
