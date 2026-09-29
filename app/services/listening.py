"""
The audiobook player's store: listening positions, the check-in log and
player preferences.

Every function takes the listener's account identity (tickets.account_identity,
"plex:<id>") and every query filters by it, so a listener can only read and
write their own rows. Never the username.

Positions. Each page session sends a random id (psid) and numbers its
check-ins (seq). An older seq from the page session that wrote the stored row
never overwrites it: check-ins can land out of order (a retry, two workers).
Across page sessions or devices the most recently received check-in wins, and
the player's handoff prompt makes that choice visible to the listener. The
rule is one conditional UPDATE, so two workers racing on the same book can't
both read the old row and let the older write land last.

The log keeps every stored check-in for the history view and is pruned after
LOG_DAYS. Pruning runs at startup and then at most once a day, piggybacked on
check-ins; the last run is a settings row (PRUNED_AT_KEY) rather than a module
variable, because uvicorn runs two workers that share nothing but the database
and Redis.
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import ListeningLog, ListeningPosition, PlayerPrefs, Setting
from app.utils import utc_iso

logger = logging.getLogger(__name__)

EVENTS = ("play", "pause", "checkin", "seek", "jump", "leave", "end")
SOURCES = ("web", "plex", "local")
LOG_DAYS = 180
PRUNE_EVERY = timedelta(days=1)
# Internal row, not an operator setting: absent from the settings registry, so
# the settings API never lists, exports or writes it.
PRUNED_AT_KEY = "listening.log_pruned_at"

IDENTITY_MAX = 255
KEY_MAX = 64
PSID_MAX = 64
DEVICE_MAX = 80
# A browser's own random id for itself (saves.js), lower-case letters and digits.
DEVICE_ID = re.compile(r"[a-z0-9]{16,40}", re.ASCII)
HISTORY_MAX = 1000
HISTORY_PAGE = 500

PREF_DEFAULTS = {"skip_s": 10, "speed": 1.0, "smart_rewind": True}
SKIP_MIN, SKIP_MAX = 5, 60
SPEED_MIN, SPEED_MAX = 0.75, 2.0
SPEED_STEPS = 20          # 0.05 steps


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(now: Optional[datetime]) -> datetime:
    """`now` as naive UTC, as the database stores it (the current time if None)."""
    if now is None:
        return _utcnow()
    if now.tzinfo is not None:
        return now.astimezone(timezone.utc).replace(tzinfo=None)
    return now


def _text(name: str, value, max_len: int) -> str:
    if not isinstance(value, str) or not value or len(value) > max_len:
        raise ValueError(f"{name} must be text of 1 to {max_len} characters")
    return value


def _count(name: str, value) -> int:
    # bool is an int in Python; True is not an offset.
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a whole number of 0 or more")
    return value


def save_checkin(db: Session, identity: str, book: str, track: str, offset_ms: int, duration_ms: int,
                 event: str, device: str, psid: str, seq: int, source: str = "web",
                 device_id: Optional[str] = None) -> dict:
    """Store a check-in as this listener's position in the book and log it.

    `device_id` is the sending browser's own random id (DEVICE_ID), or None
    from a player that sends none; the row keeps what the check-in carried.

    Returns {"stored": bool, "updated_at": iso8601}. `stored` is False when
    the stored row was written by the same psid with a higher seq; nothing is
    written or logged then, and `updated_at` is the stored row's. Raises
    ValueError for input the caller should have refused."""
    identity = _text("identity", identity, IDENTITY_MAX)
    book = _text("book", book, KEY_MAX)
    track = _text("track", track, KEY_MAX)
    psid = _text("psid", psid, PSID_MAX)
    offset_ms = _count("offset_ms", offset_ms)
    duration_ms = _count("duration_ms", duration_ms)
    seq = _count("seq", seq)
    if event not in EVENTS:
        raise ValueError("event must be one of: " + ", ".join(EVENTS))
    if source not in SOURCES:
        raise ValueError("source must be one of: " + ", ".join(SOURCES))
    device = (device if isinstance(device, str) else "")[:DEVICE_MAX]
    if device_id is not None and not (isinstance(device_id, str) and DEVICE_ID.fullmatch(device_id)):
        raise ValueError("device_id must be 16 to 40 lower-case letters and digits")

    now = _utcnow()
    values = {"track_key": track, "offset_ms": offset_ms, "duration_ms": duration_ms, "updated_at": now,
              "device": device, "device_id": device_id, "source": source, "psid": psid, "seq": seq}
    P = ListeningPosition
    mine = (P.identity == identity, P.book_key == book)
    # Overwrite unless the row is this psid's own and newer. A row written
    # without a psid (a Plex import, say) is always overwritten.
    not_newer_self = or_(P.psid.is_(None), P.seq.is_(None), P.psid != psid, P.seq <= seq)
    for _attempt in range(3):
        if db.query(P).filter(*mine, not_newer_self).update(values, synchronize_session=False):
            break
        row = db.query(P).filter(*mine).first()
        if row is not None:
            stored_at = row.updated_at
            db.rollback()
            return {"stored": False, "updated_at": utc_iso(stored_at)}
        db.add(P(identity=identity, book_key=book, **values))
        try:
            db.flush()
            break
        except IntegrityError:
            # Another worker inserted the row first: go round and apply the rule to it.
            db.rollback()
    else:  # pragma: no cover - needs a row inserted and deleted between every attempt
        raise RuntimeError("could not store the listening position")

    db.add(ListeningLog(identity=identity, book_key=book, track_key=track, offset_ms=offset_ms,
                        device=device, device_id=device_id, event=event, at=now))
    db.commit()

    try:
        prune_if_due(db)
    except Exception:
        # Housekeeping never fails a check-in that has already been stored.
        db.rollback()
        logger.exception("Listening log pruning failed")
    return {"stored": True, "updated_at": utc_iso(now)}


def get_position(db: Session, identity: str, book: str) -> Optional[dict]:
    """This listener's stored position in the book, or None."""
    row = (db.query(ListeningPosition)
           .filter(ListeningPosition.identity == identity, ListeningPosition.book_key == book).first())
    if row is None:
        return None
    return {"track": row.track_key, "offset_ms": row.offset_ms, "duration_ms": row.duration_ms,
            "updated_at": utc_iso(row.updated_at), "device": row.device, "device_id": row.device_id,
            "source": row.source}


def _entry(r: ListeningLog) -> dict:
    return {"track": r.track_key, "offset_ms": r.offset_ms, "device": r.device, "device_id": r.device_id,
            "event": r.event, "at": utc_iso(r.at)}


def get_history(db: Session, identity: str, book: str, limit: int = 200) -> list:
    """This listener's log for the book, newest first."""
    limit = max(1, min(int(limit), HISTORY_MAX))
    rows = (db.query(ListeningLog)
            .filter(ListeningLog.identity == identity, ListeningLog.book_key == book)
            .order_by(ListeningLog.at.desc(), ListeningLog.id.desc())
            .limit(limit).all())
    return [_entry(r) for r in rows]


# Plex stamps a part again when it ends the session a save of ours started
# (about 75 s after a pause, about 10 s after a move to another part), so its
# copy of a place WebServarr already logged can look newer than a later save.
ECHO_MS = 5000
ECHO_WINDOW = timedelta(hours=24)


def is_logged_place(db: Session, identity: str, book: str, track: str, offset_ms: int,
                    now: Optional[datetime] = None) -> bool:
    """True when this listener's own log for the book has a place on `track`
    within ECHO_MS of `offset_ms` in the last ECHO_WINDOW: Plex's copy of that
    place is an echo of a save of ours, not listening done in Plex. One
    bounded query on ix_listening_log_identity_book_at (identity, book, at)."""
    if not isinstance(track, str) or isinstance(offset_ms, bool) or not isinstance(offset_ms, int):
        return False
    since = _naive_utc(now) - ECHO_WINDOW
    L = ListeningLog
    row = (db.query(L.id)
           .filter(L.identity == identity, L.book_key == book, L.at >= since, L.track_key == track,
                   L.offset_ms >= offset_ms - ECHO_MS, L.offset_ms <= offset_ms + ECHO_MS)
           .first())
    return row is not None


# A history cursor: an ISO 8601 instant, optionally followed by "~" and a log
# row id that breaks ties between rows logged at the same instant.
_CURSOR = re.compile(r"(?P<at>[0-9T:.+\-]{10,40}Z?)(?:~(?P<id>[0-9]{1,18}))?", re.ASCII)


def _cursor(r: ListeningLog) -> str:
    return r.at.isoformat(timespec="microseconds") + "Z~" + str(r.id)


def parse_cursor(value: str) -> tuple:
    """(naive UTC instant, row id or None) from a history cursor. A bare
    instant means every row logged strictly before it. Raises ValueError."""
    m = _CURSOR.fullmatch(value) if isinstance(value, str) else None
    if not m:
        raise ValueError("before must be an ISO 8601 time")
    try:
        at = datetime.fromisoformat(m.group("at").replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("before must be an ISO 8601 time") from None
    return _naive_utc(at), (int(m.group("id")) if m.group("id") else None)


def get_history_page(db: Session, identity: str, book: str, limit: int = HISTORY_PAGE,
                     before: Optional[str] = None) -> dict:
    """One page of this listener's log for the book, newest first:
    {"entries": [...], "next_before": cursor or None}.

    Pass next_before back as `before` for the next page; None means there
    are no more. Rows are ordered by (at, id), and the cursor carries both,
    so rows logged at the same instant are never skipped or repeated across
    pages. Raises ValueError for a bad limit or cursor."""
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= HISTORY_MAX:
        raise ValueError(f"limit must be from 1 to {HISTORY_MAX}")
    L = ListeningLog
    q = db.query(L).filter(L.identity == identity, L.book_key == book)
    if before is not None:
        at, row_id = parse_cursor(before)
        q = q.filter(L.at < at if row_id is None else or_(L.at < at, and_(L.at == at, L.id < row_id)))
    rows = q.order_by(L.at.desc(), L.id.desc()).limit(limit + 1).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"entries": [_entry(r) for r in rows], "next_before": _cursor(rows[-1]) if more else None}


def _prefs_dict(row: Optional[PlayerPrefs]) -> dict:
    if row is None:
        return dict(PREF_DEFAULTS)
    return {"skip_s": row.skip_s, "speed": round(row.speed, 2), "smart_rewind": bool(row.smart_rewind)}


def get_prefs(db: Session, identity: str) -> dict:
    """This listener's player preferences, the defaults for anything never saved."""
    return _prefs_dict(db.query(PlayerPrefs).filter(PlayerPrefs.identity == identity).first())


def _check_prefs(fields: dict) -> dict:
    unknown = sorted(set(fields) - set(PREF_DEFAULTS))
    if unknown:
        raise ValueError("Unknown preference: " + ", ".join(unknown))
    out = {}
    if "skip_s" in fields:
        v = fields["skip_s"]
        if isinstance(v, bool) or not isinstance(v, int) or not SKIP_MIN <= v <= SKIP_MAX:
            raise ValueError(f"Skip must be a whole number of seconds from {SKIP_MIN} to {SKIP_MAX}")
        out["skip_s"] = v
    if "speed" in fields:
        v = fields["speed"]
        # The range is checked first, by comparison alone: an int or float
        # comparison never overflows, where math.isfinite(10**400) and
        # round(1e308 * 20) raise OverflowError. NaN and infinities fail it.
        ok = not isinstance(v, bool) and isinstance(v, (int, float)) and SPEED_MIN <= v <= SPEED_MAX
        steps = round(v * SPEED_STEPS) if ok else 0
        if not ok or abs(v * SPEED_STEPS - steps) > 1e-6:
            raise ValueError(f"Speed must be from {SPEED_MIN} to {SPEED_MAX} in steps of 0.05")
        out["speed"] = steps / SPEED_STEPS
    if "smart_rewind" in fields:
        if not isinstance(fields["smart_rewind"], bool):
            raise ValueError("Smart rewind must be on or off")
        out["smart_rewind"] = fields["smart_rewind"]
    return out


def put_prefs(db: Session, identity: str, **fields) -> dict:
    """Change some of this listener's preferences; returns all of them.

    Raises ValueError (nothing stored) if any field is unknown or out of range."""
    identity = _text("identity", identity, IDENTITY_MAX)
    changes = _check_prefs(fields)
    for _attempt in range(2):
        row = db.query(PlayerPrefs).filter(PlayerPrefs.identity == identity).first()
        if row is None:
            row = PlayerPrefs(identity=identity, **PREF_DEFAULTS)
            db.add(row)
        for k, v in changes.items():
            setattr(row, k, v)
        try:
            db.commit()
            break
        except IntegrityError:
            db.rollback()   # another worker created the row first: update it instead
    return get_prefs(db, identity)


def prune_log(db: Session, now: Optional[datetime] = None) -> int:
    """Delete log rows older than LOG_DAYS; returns how many. Positions stay."""
    cutoff = _naive_utc(now) - timedelta(days=LOG_DAYS)
    n = db.query(ListeningLog).filter(ListeningLog.at < cutoff).delete(synchronize_session=False)
    db.commit()
    return n


def _parse_stamp(value: Optional[str]) -> Optional[datetime]:
    try:
        return _naive_utc(datetime.fromisoformat((value or "").strip().replace("Z", "+00:00")))
    except ValueError:
        return None


def prune_if_due(db: Session, now: Optional[datetime] = None) -> Optional[int]:
    """prune_log() unless it ran in the last day: the number deleted, or None
    when it wasn't due. Whichever worker claims the marker row first prunes;
    the claim is a compare-and-set on the row's value, so two workers seeing
    it due at once prune once."""
    now = _naive_utc(now)
    row = db.query(Setting).filter(Setting.key == PRUNED_AT_KEY).first()
    last = _parse_stamp(row.value) if row is not None else None
    # A marker more than a day ahead is not a real run (a clock that jumped back).
    if last is not None and now - last < PRUNE_EVERY and last - now < PRUNE_EVERY:
        db.rollback()
        return None
    stamp = utc_iso(now)
    if row is None:
        db.add(Setting(key=PRUNED_AT_KEY, value=stamp, description="Listening log last pruned (internal)"))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return None
    else:
        claimed = (db.query(Setting).filter(Setting.key == PRUNED_AT_KEY, Setting.value == row.value)
                   .update({"value": stamp}, synchronize_session=False))
        db.commit()
        if not claimed:
            return None
    return prune_log(db, now)
