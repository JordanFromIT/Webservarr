"""
The audiobook player's store: listening positions, the check-in log and
player preferences.

Every function takes the listener's account identity (tickets.account_identity,
"plex:<id>") and every query filters by it, so a listener can only read and
write their own rows. Never the username.

Positions. Each page session sends a random id (psid) and numbers its
check-ins (seq). An older seq from the page session that wrote the stored row
never overwrites it: check-ins can land out of order (a retry, two workers).
Across page sessions a write is a compare-and-swap (spec 11b): a check-in
carries `base`, the stored timestamp its page last saw, and is stored only
when there is no row yet, when the row came from the same page session (its
psid), or when the row's timestamp is still `base`. Otherwise it is a
conflict: nothing is stored, the attempt is logged, and the caller gets the
stored place back, so a stale page (a phone asleep, a retry after an outage,
a question left open, another tab of the same browser left paused) can never
post an old place over a newer one. A reload or another tab of the same
browser is a new page session: it saw the row at open (its base), so it
stores unless something newer has been saved since. The rule is one conditional UPDATE, so
two workers racing on the same book can't both read the old row and let the
older write land last.

Every row also records the place in terms that survive the book's files
being replaced (spec 2.5): book time (ms from the start of the book), the
book's length then, that copy's chapter name and narrator, and a work key
(plex_player.work_key) that names the book apart from its files. A book
re-added as a new Plex album finds its earlier copy's row by that key
(find_linked).

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

from sqlalchemy import and_, case, or_
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
# The book-time fields (spec 2.5). A chapter name or narrator longer than
# its column is refused (the player's) or cut (the server's own).
BOOK_MS_MAX = 10 ** 9
LABEL_MAX = 200
NARRATOR_MAX = 200
WORK_KEY = re.compile(r"[0-9a-f]{32}", re.ASCII)
# A book key, "<album>:<disc>", as plex_player.parse_key takes it.
BOOK_KEY = re.compile(r"[0-9]{1,20}:[0-9]{1,6}", re.ASCII)
# The book-time fields the server reads from Plex, not the player.
SERVER_FIELDS = ("book_duration_ms", "work_key", "narrator")
# How many earlier copies a history follows through their own links.
LINK_HOPS = 5

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


def _book_fields(book_ms, chapter_label, book_duration_ms, work_key, narrator) -> dict:
    """The book-time columns of a check-in, checked, with book_ms clamped to
    [0, book_duration_ms] when both are known. Each is None when unknown."""
    if book_ms is not None:
        book_ms = _count("book_ms", book_ms)
        if book_ms > BOOK_MS_MAX:
            raise ValueError(f"book_ms must be at most {BOOK_MS_MAX}")
    if book_duration_ms is not None:
        book_duration_ms = _count("book_duration_ms", book_duration_ms)
        if book_ms is not None:
            book_ms = min(book_ms, book_duration_ms)
    if chapter_label is not None and (not isinstance(chapter_label, str) or len(chapter_label) > LABEL_MAX):
        raise ValueError(f"chapter_label must be text of at most {LABEL_MAX} characters")
    chapter_label = chapter_label or None
    if work_key is not None and not (isinstance(work_key, str) and WORK_KEY.fullmatch(work_key)):
        raise ValueError("work_key must be 32 lower-case hex digits")
    if narrator is not None:
        if not isinstance(narrator, str):
            raise ValueError("narrator must be text")
        narrator = narrator[:NARRATOR_MAX] or None
    return {"book_ms": book_ms, "book_duration_ms": book_duration_ms, "chapter_label": chapter_label,
            "work_key": work_key, "narrator": narrator}


BASE_MAX = 40


def parse_base(base) -> Optional[datetime]:
    """A check-in's `base` (ISO 8601, as utc_iso gives it) as naive UTC, or
    None for none. Raises ValueError for anything else."""
    if base is None:
        return None
    if not isinstance(base, str) or not base or len(base) > BASE_MAX:
        raise ValueError("base must be an ISO 8601 time")
    try:
        at = _naive_utc(datetime.fromisoformat(base.replace("Z", "+00:00")))
        at + timedelta(milliseconds=1)      # the store compares to the millisecond
        return at
    except (ValueError, OverflowError):
        # The ends of the calendar ("9999-12-31T23:59:59.999Z",
        # "0001-01-01T00:00:00+01:00") overflow in the zone or millisecond sums.
        raise ValueError("base must be an ISO 8601 time") from None


def save_checkin(db: Session, identity: str, book: str, track: str, offset_ms: int, duration_ms: int,
                 event: str, device: str, psid: str, seq: int, source: str = "web",
                 device_id: Optional[str] = None, base: Optional[str] = None,
                 book_ms: Optional[int] = None, chapter_label: Optional[str] = None,
                 book_duration_ms: Optional[int] = None, work_key: Optional[str] = None,
                 narrator: Optional[str] = None) -> dict:
    """Store a check-in as this listener's position in the book and log it.

    `device_id` is the sending browser's own random id (DEVICE_ID), or None
    from a player that sends none; the row keeps what the check-in carried.
    `base` is the stored timestamp the sending page last saw (ISO 8601, or
    None when it saw no position).

    `book_ms` (the player's book time) and `chapter_label` (that copy's
    chapter name) come from the player; `book_duration_ms`, `work_key` and
    `narrator` from the server's read of the album (plex_player.book_identity).
    Each may be None. The log row keeps what this check-in carried. The
    position row takes the player's two as they are (they describe this
    place), but a server field that is None (the album read failed) leaves
    the row's value as it was rather than blanking it. `book_ms` is clamped
    to `book_duration_ms` when both are known. An empty chapter name is
    stored as null. When this check-in's length is unknown, `book_ms` is
    clamped to the length the row keeps, on the position row (in the
    UPDATE) and on the log row alike. The link to an earlier copy is set
    apart (set_link).

    Returns {"stored": bool, "updated_at": iso8601}. `stored` is False when
    the stored row was written by the same psid with a higher seq; nothing is
    written or logged then, and `updated_at` is the stored row's. A conflict
    (another page session's row, and `base` is not its timestamp) is
    {"stored": False, "updated_at", "conflict": {track, offset_ms, device,
    updated_at}}: the position is left alone, the attempt is logged. Raises
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
    base_at = parse_base(base)
    about = _book_fields(book_ms, chapter_label, book_duration_ms, work_key, narrator)

    now = _utcnow()
    values = {"track_key": track, "offset_ms": offset_ms, "duration_ms": duration_ms, "updated_at": now,
              "device": device, "device_id": device_id, "source": source, "psid": psid, "seq": seq, **about}
    for name in SERVER_FIELDS:
        if values[name] is None:
            del values[name]        # unknown this time: the row keeps what it had
    P = ListeningPosition

    def logged(kept_ms: Optional[int]) -> dict:
        """The book fields for a log row: as carried, with book_ms clamped to
        the length the position row keeps when this check-in has none (the
        same clamp the UPDATE makes)."""
        fields = dict(about)
        if fields["book_ms"] is not None and fields["book_duration_ms"] is None and kept_ms is not None:
            fields["book_ms"] = min(fields["book_ms"], kept_ms)
        return fields

    update = dict(values)
    if about["book_ms"] is not None and about["book_duration_ms"] is None:
        # The book's length is unknown this time, so the row keeps the one it
        # had: clamp to that, in the UPDATE itself, so the stored place is
        # never past the end of the book it describes.
        update["book_ms"] = case((and_(P.book_duration_ms.isnot(None), P.book_duration_ms < about["book_ms"]),
                                  P.book_duration_ms), else_=about["book_ms"])
    mine = (P.identity == identity, P.book_key == book)
    # Overwrite unless the row is this psid's own and newer. A row written
    # without a psid (a Plex import, say) is always overwritten.
    not_newer_self = or_(P.psid.is_(None), P.seq.is_(None), P.psid != psid, P.seq <= seq)
    # And, across page sessions, only over the row the page last saw: its
    # own (the same psid), or a row still at `base` (to the millisecond
    # utc_iso gives it). The device id alone is not enough: another tab of
    # the same browser, left paused, must not post its old place over the
    # newer one a second tab saved.
    allowed = [P.psid.is_(None), P.psid == psid]
    if base_at is not None:
        allowed.append(and_(P.updated_at >= base_at, P.updated_at < base_at + timedelta(milliseconds=1)))
    swap = or_(*allowed)
    for _attempt in range(3):
        if db.query(P).filter(*mine, not_newer_self, swap).update(update, synchronize_session=False):
            break
        row = db.query(P).filter(*mine).first()
        if row is not None:
            stored_at = row.updated_at
            if row.psid == psid and row.seq is not None and row.seq > seq:
                db.rollback()
                return {"stored": False, "updated_at": utc_iso(stored_at)}
            conflict = {"track": row.track_key, "offset_ms": row.offset_ms, "device": row.device,
                        "updated_at": utc_iso(stored_at)}
            kept_ms = row.book_duration_ms
            db.rollback()
            db.add(ListeningLog(identity=identity, book_key=book, track_key=track, offset_ms=offset_ms,
                                device=device, device_id=device_id, event=event, at=now, **logged(kept_ms)))
            db.commit()
            return {"stored": False, "updated_at": utc_iso(stored_at), "conflict": conflict}
        db.add(P(identity=identity, book_key=book, **values))
        try:
            db.flush()
            break
        except IntegrityError:
            # Another worker inserted the row first: go round and apply the rule to it.
            db.rollback()
    else:  # pragma: no cover - needs a row inserted and deleted between every attempt
        raise RuntimeError("could not store the listening position")

    kept_ms = None
    if about["book_ms"] is not None and about["book_duration_ms"] is None:
        kept_ms = db.query(P.book_duration_ms).filter(*mine).scalar()
    db.add(ListeningLog(identity=identity, book_key=book, track_key=track, offset_ms=offset_ms,
                        device=device, device_id=device_id, event=event, at=now, **logged(kept_ms)))
    db.commit()

    try:
        prune_if_due(db)
    except Exception:
        # Housekeeping never fails a check-in that has already been stored.
        db.rollback()
        logger.exception("Listening log pruning failed")
    return {"stored": True, "updated_at": utc_iso(now)}


def position_dict(row: ListeningPosition) -> dict:
    """A stored position as get_position gives it."""
    return {"track": row.track_key, "offset_ms": row.offset_ms, "duration_ms": row.duration_ms,
            "updated_at": utc_iso(row.updated_at), "device": row.device, "device_id": row.device_id,
            "source": row.source, "psid": row.psid, "book_ms": row.book_ms,
            "book_duration_ms": row.book_duration_ms, "chapter_label": row.chapter_label,
            "narrator": row.narrator}


def get_position_row(db: Session, identity: str, book: str) -> Optional[ListeningPosition]:
    """This listener's stored position row for the book, or None."""
    return (db.query(ListeningPosition)
            .filter(ListeningPosition.identity == identity, ListeningPosition.book_key == book).first())


def get_position(db: Session, identity: str, book: str) -> Optional[dict]:
    """This listener's stored position in the book, or None. `psid` is the
    page session that saved it, so a page can tell its own saves from
    another tab's or device's (the player's re-check before a late Play).
    The book-time fields are null for a row saved before they existed. The
    row's own link to an earlier copy is not part of it (the player reads a
    linked_from on the web copy as "the files changed")."""
    row = get_position_row(db, identity, book)
    if row is None:
        return None
    return position_dict(row)


def has_work_keys(db: Session, identity: str, exclude_key: str) -> bool:
    """True when this listener has any stored position with a work key under
    a book key other than `exclude_key`: only then can an earlier copy be
    found, so only then is the book's own work key worth reading from Plex.
    One query on ix_listening_positions_identity_work_key."""
    P = ListeningPosition
    return (db.query(P.book_key)
            .filter(P.identity == identity, P.work_key.isnot(None), P.book_key != exclude_key)
            .first()) is not None


# How many earlier copies a lookup may pass over (each still in the library).
LINK_TRIES = 3


def set_link(db: Session, identity: str, book: str, linked_from: str) -> Optional[bool]:
    """Keep `linked_from`, an earlier copy the caller has verified (the
    router's rule: the listener's own row under that key, the same work key,
    and its album gone), on this listener's row for `book`, so the earlier
    copy's history stays with the book. Set once: a row that already has a
    link keeps it. Independent of the check-in's own outcome (a refused
    older seq or a conflict still leaves a row, so the link is still set).

    True when the row now holds `linked_from`, False when it holds another
    link, None when there is no row (a check-in always leaves one; nothing
    is created without a place). Raises ValueError for a key that is not
    another book's."""
    if not (isinstance(linked_from, str) and BOOK_KEY.fullmatch(linked_from) and linked_from != book):
        raise ValueError("linked_from must be another book's key")
    P = ListeningPosition
    (db.query(P).filter(P.identity == identity, P.book_key == book, P.linked_from.is_(None))
     .update({"linked_from": linked_from}, synchronize_session=False))
    db.commit()
    row = get_position_row(db, identity, book)
    if row is None:
        return None
    db.refresh(row)
    return row.linked_from == linked_from


def link_chain(db: Session, identity: str, book: str, first: Optional[str]) -> list:
    """The earlier copies behind `book`: `first`, then the copy that one's
    own row links to, and so on, at most LINK_HOPS keys, never `book` and
    never a key twice (a loop ends the walk). This listener's rows only."""
    chain, key = [], first
    while key and len(chain) < LINK_HOPS and key != book and key not in chain:
        chain.append(key)
        row = get_position_row(db, identity, key)
        key = row.linked_from if row is not None else None
    return chain


def find_linked(db: Session, identity: str, work_key: Optional[str], exclude_key: str,
                skip=()) -> Optional[ListeningPosition]:
    """The newest of this listener's stored positions with `work_key` under a
    book key other than `exclude_key` (and none of `skip`), or None: the
    place in an earlier copy of a book re-added as a new Plex album.

    The caller links it only when that copy's album is gone from the
    library, so editions side by side never share a place; `skip` names
    copies it found still there. One query on
    ix_listening_positions_identity_work_key, scoped by identity."""
    if not isinstance(work_key, str) or not WORK_KEY.fullmatch(work_key):
        return None
    P = ListeningPosition
    q = db.query(P).filter(P.identity == identity, P.work_key == work_key, P.book_key != exclude_key)
    skip = [k for k in skip if isinstance(k, str)]
    if skip:
        q = q.filter(P.book_key.notin_(skip))
    return q.order_by(P.updated_at.desc(), P.book_key).first()


def _entry(r: ListeningLog) -> dict:
    return {"track": r.track_key, "offset_ms": r.offset_ms, "device": r.device, "device_id": r.device_id,
            "event": r.event, "at": utc_iso(r.at), "book_key": r.book_key, "book_ms": r.book_ms,
            "book_duration_ms": r.book_duration_ms, "chapter_label": r.chapter_label}


def get_history(db: Session, identity: str, book: str, limit: int = 200) -> list:
    """This listener's log for the book, newest first."""
    limit = max(1, min(int(limit), HISTORY_MAX))
    rows = (db.query(ListeningLog)
            .filter(ListeningLog.identity == identity, ListeningLog.book_key == book)
            .order_by(ListeningLog.at.desc(), ListeningLog.id.desc())
            .limit(limit).all())
    return [_entry(r) for r in rows]


# Defence in depth: Plex's copy of a place WebServarr itself saved and
# forwarded to Plex (logged within ECHO_AT of Plex's stamp for it) is that
# save, not listening done in a Plex app. On the dev instance Plex was never
# seen stamping a place of its own accord: every lastViewedAt matched one of
# our timeline writes. The rule only keeps such an echo from competing with
# WebServarr's own copy in the resume merge.
ECHO_MS = 5000
ECHO_WINDOW = timedelta(hours=24)


ECHO_AT = timedelta(seconds=30)


def is_logged_place(db: Session, identity: str, book: str, track: str, offset_ms: int,
                    stamped_at, now: Optional[datetime] = None) -> bool:
    """True when this listener's own log for the book has a place on `track`
    within ECHO_MS of `offset_ms`, logged in the last ECHO_WINDOW and within
    ECHO_AT of `stamped_at` (Plex's timestamp for that place, ISO 8601 or a
    datetime): Plex's copy of that place is an echo of a save of ours, not
    listening done in Plex. A place logged at another time (a listener who
    went back in Plexamp to somewhere we logged earlier) is not. One bounded
    query on ix_listening_log_identity_book_at (identity, book, at)."""
    if not isinstance(track, str) or isinstance(offset_ms, bool) or not isinstance(offset_ms, int):
        return False
    stamp = _parse_stamp(stamped_at) if isinstance(stamped_at, str) else (
        _naive_utc(stamped_at) if isinstance(stamped_at, datetime) else None)
    if stamp is None:
        return False
    since = max(_naive_utc(now) - ECHO_WINDOW, stamp - ECHO_AT)
    L = ListeningLog
    row = (db.query(L.id)
           .filter(L.identity == identity, L.book_key == book, L.at >= since, L.at <= stamp + ECHO_AT,
                   L.track_key == track, L.offset_ms >= offset_ms - ECHO_MS, L.offset_ms <= offset_ms + ECHO_MS)
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
                     before: Optional[str] = None, linked=None) -> dict:
    """One page of this listener's log for the book, newest first:
    {"entries": [...], "next_before": cursor or None}.

    Pass next_before back as `before` for the next page; None means there
    are no more. Rows are ordered by (at, id), and the cursor carries both,
    so rows logged at the same instant are never skipped or repeated across
    pages. `linked` is the book key of an earlier copy, or a list of them
    (link_chain): their rows are merged in, each marked "earlier_copy":
    true. Raises ValueError for a bad limit or cursor."""
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= HISTORY_MAX:
        raise ValueError(f"limit must be from 1 to {HISTORY_MAX}")
    L = ListeningLog
    others = [linked] if isinstance(linked, str) else list(linked or ())
    others = [k for k in dict.fromkeys(others) if isinstance(k, str) and k != book]
    same_book = L.book_key == book if not others else L.book_key.in_([book, *others])
    q = db.query(L).filter(L.identity == identity, same_book)
    if before is not None:
        at, row_id = parse_cursor(before)
        q = q.filter(L.at < at if row_id is None else or_(L.at < at, and_(L.at == at, L.id < row_id)))
    rows = q.order_by(L.at.desc(), L.id.desc()).limit(limit + 1).all()
    more = len(rows) > limit
    rows = rows[:limit]
    entries = []
    for r in rows:
        entry = _entry(r)
        if r.book_key != book:
            entry["earlier_copy"] = True
        entries.append(entry)
    return {"entries": entries, "next_before": _cursor(rows[-1]) if more else None}


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
