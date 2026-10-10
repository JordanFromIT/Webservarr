"""
The audiobook player's store: listening positions, the check-in log and
player preferences.

Every function takes the listener's account identity (tickets.account_identity,
"plex:<id>") and every query filters by it, so a listener can only read and
write their own rows. Never the username. The admin's Insights page reads
everyone's, through app/services/insights.py.

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
(find_linked). Only one book may carry an earlier copy forward (spec 2.6
s4): the check-in that confirms the link claims that copy for its book, in
the save's own transaction, and the claims table's key lets SQLite itself
refuse a second claim (claim_link).

The log keeps every stored check-in for the history view and is pruned after
LOG_DAYS. Before rows go, the log is rolled up by day (listening_daily) and by
hour, book and source (listening_hourly, for the admin's Insights page).
Pruning runs at startup and then at most once a day, piggybacked on
check-ins; the last run is a settings row (PRUNED_AT_KEY) rather than a module
variable, because uvicorn runs two workers that share nothing but the database
and Redis.
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import and_, case, exists, func, or_
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import ListeningClaim, ListeningDismissal, ListeningLog, ListeningPosition, PlayerPrefs, Setting
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
AUTHOR_MAX = 200
BOOK_TITLE_MAX = 300
WORK_KEY = re.compile(r"[0-9a-f]{32}", re.ASCII)
# A book key, "<album>:<disc>", as plex_player.parse_key takes it.
BOOK_KEY = re.compile(r"[0-9]{1,20}:[0-9]{1,6}", re.ASCII)
# The book-time fields the server reads from Plex, not the player.
SERVER_FIELDS = ("book_duration_ms", "work_key", "narrator")
# "Were you listening to one of these?" (spec 2.6 s3): how many places are
# offered, how many of the listener's newest unfinished rows are looked at
# (a bound on the query; the library listing the router reads settles which
# are gone), and the share of a book from which it counts as finished.
ORPHAN_ROWS = 10
ORPHAN_CANDIDATES = 200
FINISHED_PERCENT = 97
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
                 narrator: Optional[str] = None, book_title: Optional[str] = None,
                 link: Optional[tuple] = None, link_manual: bool = False,
                 author: Optional[str] = None) -> dict:
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
    UPDATE) and on the log row alike.

    `link` is (earlier copy's key, verdict) when the check-in carries
    linked_from: the claim on that copy (claim_link, with the verdict the
    router reached) is written in this check-in's own transaction, whatever
    the save's outcome (a refused older seq or a conflict still leaves a
    row), and the result carries claim_link's answer as "link".

    `link_manual`: the link was chosen by the listener, not found by work key
    (spec 2.6 s3); the claim and the row's link keep the flag.

    `author` is the book's author as the library names them (the server's
    read, cut to AUTHOR_MAX), kept on the position row for the orphan lookup;
    like the other server fields, None leaves the row's value as it was.

    `book_title` is the title the library shows for the book (the server's
    read, cut to BOOK_TITLE_MAX), kept on the position row only so a place
    offered from this copy can say which copy it was; like the other
    server fields, None leaves the row's value as it was.

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
    if link is not None:
        _earlier_key(link[0], book)

    now = _utcnow()
    values = {"track_key": track, "offset_ms": offset_ms, "duration_ms": duration_ms, "updated_at": now,
              "device": device, "device_id": device_id, "source": source, "psid": psid, "seq": seq, **about}
    if book_title is not None:
        if not isinstance(book_title, str):
            raise ValueError("book_title must be text")
        values["book_title"] = book_title[:BOOK_TITLE_MAX] or None
    if author is not None:
        if not isinstance(author, str):
            raise ValueError("author must be text")
        values["author"] = author[:AUTHOR_MAX] or None
    for name in (*SERVER_FIELDS, "book_title", "author"):
        if values.get(name, "") is None:
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
    claimed = {}

    def claim() -> None:
        """The claim on the earlier copy, in the transaction open now."""
        if link is not None:
            claimed["link"] = _apply_link(db, identity, book, link[0], link[1], now, manual=link_manual)

    for _attempt in range(3):
        if db.query(P).filter(*mine, not_newer_self, swap).update(update, synchronize_session=False):
            break
        row = db.query(P).filter(*mine).first()
        if row is not None:
            stored_at = row.updated_at
            if row.psid == psid and row.seq is not None and row.seq > seq:
                db.rollback()
                if link is not None:
                    claim()
                    db.commit()
                return {"stored": False, "updated_at": utc_iso(stored_at), **claimed}
            conflict = {"track": row.track_key, "offset_ms": row.offset_ms, "device": row.device,
                        "updated_at": utc_iso(stored_at)}
            kept_ms = row.book_duration_ms
            db.rollback()
            db.add(ListeningLog(identity=identity, book_key=book, track_key=track, offset_ms=offset_ms,
                                device=device, device_id=device_id, event=event, at=now, source=source,
                                **logged(kept_ms)))
            claim()
            db.commit()
            return {"stored": False, "updated_at": utc_iso(stored_at), "conflict": conflict, **claimed}
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
                        device=device, device_id=device_id, event=event, at=now, source=source,
                        **logged(kept_ms)))
    claim()
    db.commit()

    try:
        prune_if_due(db)
    except Exception:
        # Housekeeping never fails a check-in that has already been stored.
        db.rollback()
        logger.exception("Listening log pruning failed")
    return {"stored": True, "updated_at": utc_iso(now), **claimed}


def position_dict(row: ListeningPosition) -> dict:
    """A stored position as get_position gives it."""
    return {"track": row.track_key, "offset_ms": row.offset_ms, "duration_ms": row.duration_ms,
            "updated_at": utc_iso(row.updated_at), "device": row.device, "device_id": row.device_id,
            "source": row.source, "psid": row.psid, "book_ms": row.book_ms,
            "book_duration_ms": row.book_duration_ms, "chapter_label": row.chapter_label,
            "narrator": row.narrator, "book_title": row.book_title}


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
    its album gone, and no copy that carried it forward still in the
    library), on this listener's row for `book`, so the earlier
    copy's history stays with the book. Set once: a row that already has a
    link keeps it. Independent of the check-in's own outcome (a refused
    older seq or a conflict still leaves a row, so the link is still set).

    True when the row now holds `linked_from`, False when it holds another
    link, None when there is no row (a check-in always leaves one; nothing
    is created without a place). Raises ValueError for a key that is not
    another book's.

    The row's link alone: a check-in keeps a link through claim_link, which
    also claims the earlier copy (spec 2.6 s4)."""
    _earlier_key(linked_from, book)
    P = ListeningPosition
    (db.query(P).filter(P.identity == identity, P.book_key == book, P.linked_from.is_(None))
     .update({"linked_from": linked_from}, synchronize_session=False))
    db.commit()
    row = get_position_row(db, identity, book)
    if row is None:
        return None
    db.refresh(row)
    return row.linked_from == linked_from


def _earlier_key(earlier, book: str) -> str:
    if not (isinstance(earlier, str) and BOOK_KEY.fullmatch(earlier) and earlier != book):
        raise ValueError("linked_from must be another book's key")
    return earlier


def _still_held():
    """A claim still held by its holder: the holder's row is there and keeps
    the link, or (pending) has none yet. A claim whose holder's row was
    deleted, or reset to no link or another one, holds nothing."""
    P, C = ListeningPosition, ListeningClaim
    return exists().where(P.identity == C.identity, P.book_key == C.holder_key,
                          or_(P.linked_from == C.earlier_key,
                              and_(P.linked_from.is_(None), C.state == "pending")))


def _apply_link(db: Session, identity: str, book: str, earlier: str, verdict: Optional[bool],
                now: datetime, release: Optional[str] = None, manual: bool = False):
    """claim_link's work in the transaction open now (no commit). Every path
    starts with a write, so SQLite's write lock is held before anything is
    read and decided."""
    P, C = ListeningPosition, ListeningClaim
    claim = (C.identity == identity, C.earlier_key == earlier)
    if verdict is False:
        # Refused (its album is there again, say): a pending claim of this
        # book's goes, so it blocks nothing; a verified one stays with the link.
        db.query(C).filter(*claim, C.holder_key == book, C.state == "pending").delete(synchronize_session=False)
        return False
    if release is not None:
        db.query(C).filter(*claim, C.holder_key == release).delete(synchronize_session=False)
    db.query(C).filter(*claim, C.holder_key != book, ~_still_held()).delete(synchronize_session=False)
    row = db.query(P.linked_from).filter(P.identity == identity, P.book_key == book).first()
    if row is None:
        return None             # no place, so no claim (a check-in always leaves a row)
    if row.linked_from is not None and row.linked_from != earlier:
        # Set once: this book carries another copy forward, never this one.
        db.query(C).filter(*claim, C.holder_key == book).delete(synchronize_session=False)
        return False
    held = verdict or row.linked_from == earlier
    db.execute(sqlite_insert(C).values(identity=identity, earlier_key=earlier, holder_key=book,
                                       state="verified" if held else "pending", claimed_at=now,
                                       manual=bool(manual))
               .on_conflict_do_nothing())
    holder, state, was_manual = db.query(C.holder_key, C.state, C.manual).filter(*claim).one()
    if holder != book:
        return holder
    if not held:
        return None
    if state != "verified":
        db.query(C).filter(*claim, C.holder_key == book).update({"state": "verified"}, synchronize_session=False)
    db.query(P).filter(P.identity == identity, P.book_key == book, P.linked_from.is_(None)).update(
        {"linked_from": earlier, "link_manual": bool(was_manual)}, synchronize_session=False)
    return True


def claim_link(db: Session, identity: str, book: str, earlier: str, verdict: Optional[bool],
               release: Optional[str] = None, manual: bool = False):
    """Claim the earlier copy `earlier` for this listener's book `book`
    (spec 2.6 s4), with the verdict the router reached on the link: True
    (verified), None (Plex couldn't say: a pending claim) or False (refused).

    The claims table's key (identity, earlier copy) lets SQLite itself keep
    one holder per earlier copy. A pending claim blocks other copies as a
    verified one does (successors). Returns:
    - True: `book` holds a verified claim, and its row the link (set once,
      as set_link);
    - None: `book` holds a pending claim, or has no row (nothing is claimed
      without a place);
    - False: refused. A refusal drops a pending claim of `book`'s (never a
      verified one); a row already linked to another copy claims nothing;
    - the holder's book key, when another book holds the claim. The caller
      decides: if that book's album is gone, it calls again with `release`
      naming it, which drops that claim first.

    `manual`: the listener chose this link (spec 2.6 s3) instead of the work
    key finding it. The claim keeps the flag when it is written (a pending
    claim that verifies later still has it) and hands it to the row's link.

    A claim whose holder's row was deleted, or no longer holds the link
    (reset), is released here too. Commits. Raises ValueError for a key
    that is not another book's."""
    _earlier_key(earlier, book)
    outcome = _apply_link(db, identity, book, earlier, verdict, _utcnow(), release=release, manual=manual)
    db.commit()
    return outcome


def pending_claim(db: Session, identity: str, book: str) -> Optional[str]:
    """The earlier copy this listener's book `book` holds a pending claim on
    (spec 2.6 s4), or None. The newest one when it holds several. A claim
    whose row is gone or linked elsewhere holds nothing (_still_held)."""
    C = ListeningClaim
    row = (db.query(C.earlier_key)
           .filter(C.identity == identity, C.holder_key == book, C.state == "pending", _still_held())
           .order_by(C.claimed_at.desc(), C.earlier_key).first())
    return row[0] if row is not None else None


def claim_is_manual(db: Session, identity: str, book: str, earlier: str) -> bool:
    """True when `book`'s claim on the earlier copy `earlier` was a manual
    link (claim_link's `manual`)."""
    C = ListeningClaim
    row = (db.query(C.manual).filter(C.identity == identity, C.holder_key == book, C.earlier_key == earlier)
           .first())
    return bool(row is not None and row[0])


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


def successors(db: Session, identity: str, key: str, exclude=()) -> list:
    """The book keys of this listener's rows that carried `key` forward (a
    row whose linked_from is `key`, or that holds a pending claim on it:
    spec 2.6 s4), none of `exclude`, newest first, at most LINK_TRIES. The
    router asks whether one of them (or one of theirs) is still in the
    library before it offers `key` as an earlier copy: a place already
    carried into an edition that is still there is that edition's, never
    another side-by-side edition's (spec 2.5 s2). A pending claim's holder
    has no link on its row yet; a verified claim's holder has. Scoped by
    identity, so the primary key's (identity, book_key) index bounds the
    read to this listener's own rows."""
    if not isinstance(key, str):
        return []
    P, C = ListeningPosition, ListeningClaim
    pending = exists().where(C.identity == P.identity, C.earlier_key == key, C.holder_key == P.book_key,
                             C.state == "pending")
    q = db.query(P.book_key).filter(P.identity == identity,
                                    or_(P.linked_from == key, and_(P.linked_from.is_(None), pending)))
    exclude = [k for k in exclude if isinstance(k, str)]
    if exclude:
        q = q.filter(P.book_key.notin_(exclude))
    return [r[0] for r in q.order_by(P.updated_at.desc(), P.book_key).limit(LINK_TRIES).all()]


def find_linked(db: Session, identity: str, work_key: Optional[str], exclude_key: str,
                skip=()) -> Optional[ListeningPosition]:
    """The newest of this listener's stored positions with `work_key` under a
    book key other than `exclude_key` (and none of `skip`), or None: the
    place in an earlier copy of a book re-added as a new Plex album.

    The caller links it only when that copy's album is gone from the
    library and no copy that carried it forward (successors) is still
    there, so editions side by side never share a place; `skip` names
    copies it passed over. One query on
    ix_listening_positions_identity_work_key, scoped by identity."""
    if not isinstance(work_key, str) or not WORK_KEY.fullmatch(work_key):
        return None
    P = ListeningPosition
    q = db.query(P).filter(P.identity == identity, P.work_key == work_key, P.book_key != exclude_key)
    skip = [k for k in skip if isinstance(k, str)]
    if skip:
        q = q.filter(P.book_key.notin_(skip))
    return q.order_by(P.updated_at.desc(), P.book_key).first()


def orphan_candidates(db: Session, identity: str, exclude_key: str) -> list:
    """This listener's position rows that might be places in books that left
    the library (spec 2.6 s3): the newest ORPHAN_CANDIDATES by updated_at, none
    of them `exclude_key`, all unfinished. A row is finished when the latest
    event of its log is an `end` mark that saved the row, or its book_ms is FINISHED_PERCENT or more of its
    book_duration_ms (both known: an unknown book_ms, or an unknown length,
    still counts as unfinished).

    The router tells which of them are gone (one library listing) and which a
    copy still in the library carried forward (a successor, pending claims
    included). Scoped by identity; the log is read on
    ix_listening_log_identity_book_at."""
    P, L = ListeningPosition, ListeningLog
    # Finished only while the end is what the row was last saved by (a
    # stored end shares its row's time): a book listened to again after the
    # end is a place again, and an end that was refused (409) or came late
    # finishes nothing.
    ended = exists().where(L.identity == P.identity, L.book_key == P.book_key, L.event == "end",
                           L.at == P.updated_at)
    unfinished = or_(P.book_ms.is_(None), P.book_duration_ms.is_(None), P.book_duration_ms <= 0,
                     P.book_ms * 100 < P.book_duration_ms * FINISHED_PERCENT)
    return (db.query(P).filter(P.identity == identity, P.book_key != exclude_key, ~ended, unfinished)
            .order_by(P.updated_at.desc(), P.book_key).limit(ORPHAN_CANDIDATES).all())


# The most places of one listener get_places reads when no keys are given.
PLACES_MAX = 1000
# Keys per query, under SQLite's bound-variable limit.
_PLACES_CHUNK = 400


def get_places(db: Session, identity: str, keys=None, limit: int = PLACES_MAX) -> dict:
    """This listener's places, for a view of several books at once (the Books
    pages): {book key: {"updated_at" (naive UTC), "book_ms", "book_duration_ms",
    "finished"}}. `keys` limits it to those books; with none it is their
    `limit` newest places. A place is finished by the same rule as an orphan
    candidate: the latest event of its log is an `end` that saved the row, or its
    book_ms is FINISHED_PERCENT or more of a known book_duration_ms. Scoped by
    identity."""
    P, L = ListeningPosition, ListeningLog
    ended = exists().where(L.identity == P.identity, L.book_key == P.book_key, L.event == "end",
                           L.at == P.updated_at)
    places: dict = {}

    def read(extra) -> None:
        q = db.query(P.book_key, P.updated_at, P.book_ms, P.book_duration_ms, ended.label("ended")).filter(
            P.identity == identity, *extra)
        for key, at, ms, total, was_ended in q.order_by(P.updated_at.desc(), P.book_key).limit(limit):
            known = ms is not None and total is not None and total > 0
            places[key] = {"updated_at": at, "book_ms": ms, "book_duration_ms": total,
                           "finished": bool(was_ended) or (known and ms * 100 >= total * FINISHED_PERCENT)}

    if keys is None:
        read(())
    else:
        keys = [k for k in dict.fromkeys(keys) if isinstance(k, str)]
        for start in range(0, len(keys), _PLACES_CHUNK):
            read((P.book_key.in_(keys[start:start + _PLACES_CHUNK]),))
    return places


# The most position rows of one listener the successor graph reads.
GRAPH_ROWS = 5000


def successor_graph(db: Session, identity: str) -> dict:
    """{earlier copy: [books that carried its place forward]} for this
    listener, whole: every row of theirs whose linked_from is set, and every
    pending claim whose holder's row has no link yet (successors, for all
    copies at once, so a chain of any length can be walked in memory). At
    most GRAPH_ROWS rows, newest first; scoped by identity, on the primary
    key's (identity, book_key) index and the claims' (identity, earlier_key)."""
    P, C = ListeningPosition, ListeningClaim
    graph: dict = {}
    linked = (db.query(P.book_key, P.linked_from)
              .filter(P.identity == identity, P.linked_from.isnot(None))
              .order_by(P.updated_at.desc(), P.book_key).limit(GRAPH_ROWS).all())
    for book, earlier in linked:
        graph.setdefault(earlier, []).append(book)
    pending = (db.query(C.earlier_key, C.holder_key)
               .join(P, and_(P.identity == C.identity, P.book_key == C.holder_key))
               .filter(C.identity == identity, C.state == "pending", P.linked_from.is_(None))
               .order_by(C.claimed_at.desc()).limit(GRAPH_ROWS).all())
    for earlier, book in pending:
        graph.setdefault(earlier, []).append(book)
    return graph


def orphans_dismissed(db: Session, identity: str, book: str) -> bool:
    """True when this listener answered "None of these" for `book`."""
    D = ListeningDismissal
    return db.query(D.book_key).filter(D.identity == identity, D.book_key == book).first() is not None


def dismiss_orphans(db: Session, identity: str, book: str) -> None:
    """Remember that this listener answered "None of these" for `book`, on
    every device. Idempotent and safe when two workers get it at once (an
    INSERT that ignores the key already there). Raises ValueError for a key
    that is not a book's."""
    identity = _text("identity", identity, IDENTITY_MAX)
    if not (isinstance(book, str) and BOOK_KEY.fullmatch(book)):
        raise ValueError("book must be a book key")
    db.execute(sqlite_insert(ListeningDismissal).values(identity=identity, book_key=book, dismissed_at=_utcnow())
               .on_conflict_do_nothing())
    db.commit()


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


# --- Time listened, and the daily rollup that outlives the log ------------------------
#
# Check-ins land every 10 s while audio plays. Time listened is wall time: a
# row of a playing event counts the gap to the listener's next row (whatever
# its book or device) when that gap is at most LISTEN_GAP. Ordering by the
# listener alone, not by book, means two devices playing at once are not
# counted twice, and a rejected check-in (logged too) only splits a gap.

PLAYING_EVENTS = ("play", "checkin", "seek", "jump")
LISTEN_GAP = timedelta(seconds=30)
# Internal row, as PRUNED_AT_KEY: the last UTC day listening_daily holds.
ROLLED_THROUGH_KEY = "listening.rolled_through"
# Internal row too: the highest log id the last rollup saw. A row above it on
# a day already rolled up came in late (listening synced after the fact), and
# the next rollup adds what it changes (late_changes).
ROLLED_LOG_ID_KEY = "listening.rolled_log_id"
# A day is rolled up only once its last row's gap can no longer be followed by a new row.
ROLL_MARGIN = timedelta(minutes=1)
# Internal row, as ROLLED_THROUGH_KEY: where listening_hourly ends (the end,
# exclusive, of the last hour rolled up), ISO 8601 UTC.
HOURS_THROUGH_KEY = "listening.hours_through"
# Hours this close before the marker are worked out again on every pass, so
# check-ins that arrive late (a phone that synced afterwards) still count.
HOURS_REDO = timedelta(hours=48)
HOURLY_KEEP_DAYS = 730


def listened_spans(rows) -> list:
    """[(at, book_key, ms)] for one listener's log rows, given as (at,
    event, book_key) in time order: each playing row with the time it
    counts (0 for none)."""
    rows = list(rows)
    spans = []
    for i, (at, event, book) in enumerate(rows):
        ms = 0
        if event in PLAYING_EVENTS and i + 1 < len(rows):
            gap = rows[i + 1][0] - at
            if timedelta(0) <= gap <= LISTEN_GAP:
                ms = int(gap.total_seconds() * 1000)
        spans.append((at, book, ms))
    return spans


def log_rows(db: Session, identity: str, since: Optional[datetime] = None) -> list:
    """This listener's log as (at, event, book_key) in time order, from
    `since` on (all of it for None). Scoped by identity."""
    L = ListeningLog
    q = db.query(L.at, L.event, L.book_key).filter(L.identity == identity)
    if since is not None:
        q = q.filter(L.at >= since)
    return q.order_by(L.at, L.id).all()


def rolled_through(db: Session):
    """The last UTC day (a date) listening_daily holds, or None before the first rollup."""
    row = db.query(Setting.value).filter(Setting.key == ROLLED_THROUGH_KEY).first()
    try:
        return datetime.strptime(row[0], "%Y-%m-%d").date() if row else None
    except ValueError:
        return None


def rolled_log_id(db: Session) -> Optional[int]:
    """The highest log id the last rollup saw, or None before a rollup has kept one."""
    row = db.query(Setting.value).filter(Setting.key == ROLLED_LOG_ID_KEY).first()
    try:
        return int(row[0]) if row else None
    except ValueError:
        return None


def _put_marker(db: Session, key: str, value: str, description: str) -> None:
    marker = db.query(Setting).filter(Setting.key == key).first()
    if marker is None:
        db.add(Setting(key=key, value=value, description=description))
    else:
        marker.value = value


def _daily_totals(rows) -> dict:
    """{day: [ms, books]} for one listener's log rows, given as (at, event,
    book_key) in time order; days with no time listened are left out."""
    days: dict = {}
    for at, book, ms in listened_spans(rows):
        if ms:
            day = days.setdefault(at.date(), [0, set()])
            day[0] += ms
            day[1].add(book)
    return days


def late_changes(db: Session, done, seen: Optional[int], identity: Optional[str] = None) -> dict:
    """{(identity, day): (ms, books)}: what the log rows above `seen` (a
    rolled_log_id) change on the days rolled up through `done`, for one
    listener or (identity None) all of them. `ms` is the change to the
    day's total: the time the day's log shows now less the time from the
    rows the rollup saw. Adding the difference, rather than recounting the
    day, keeps what was rolled up from rows pruned since. `books` is how
    many books the day's log shows now. A late row also changes the day
    before it when it closes the gap after that day's last row. Empty
    without both markers."""
    if done is None or seen is None:
        return {}
    L = ListeningLog
    end = datetime.combine(done + timedelta(days=1), datetime.min.time())
    late = db.query(L.identity, L.at).filter(L.id > seen, L.at < end + LISTEN_GAP)
    if identity is not None:
        late = late.filter(L.identity == identity)
    touched: dict = {}
    for who, at in late:
        for day in {at.date(), (at - LISTEN_GAP).date()}:
            if day <= done:
                touched.setdefault(who, set()).add(day)
    changes = {}
    for who, days in touched.items():
        start = datetime.combine(min(days), datetime.min.time())
        stop = datetime.combine(max(days) + timedelta(days=1), datetime.min.time()) + LISTEN_GAP
        rows = (db.query(L.id, L.at, L.event, L.book_key)
                .filter(L.identity == who, L.at >= start, L.at < stop).order_by(L.at, L.id).all())
        now_totals = _daily_totals((at, event, book) for _id, at, event, book in rows)
        seen_totals = _daily_totals((at, event, book) for row_id, at, event, book in rows if row_id <= seen)
        for day in days:
            if day in now_totals or day in seen_totals:
                ms, books = now_totals.get(day, (0, ()))
                changes[(who, day)] = (ms - seen_totals.get(day, (0, ()))[0], len(books))
    return changes


def roll_up(db: Session, now: Optional[datetime] = None) -> int:
    """Add every complete UTC day not yet rolled up to listening_daily: per
    listener and day, the time listened and the books it was in. A day
    already rolled up changes only by what log rows that came in after it
    change (late_changes), so what was rolled up from rows pruned since is
    kept. Returns how many day rows were added or changed. Safe with two
    workers: the first statement is a write, so SQLite's write lock is held
    before the markers are read, new days go in with INSERT OR IGNORE, and
    the late rows are added in the same transaction that moves the log id
    marker past them, so they are added once."""
    from app.models import ListeningDaily

    now = _naive_utc(now)
    last_day = (now - ROLL_MARGIN).date() - timedelta(days=1)
    db.query(ListeningDaily).filter(ListeningDaily.id < 0).delete(synchronize_session=False)
    done = rolled_through(db)
    late = late_changes(db, done, rolled_log_id(db))
    for (identity, day), (ms, books) in late.items():
        db.execute(sqlite_insert(ListeningDaily).values(identity=identity, day=day, ms=ms, books_touched=books)
                   .on_conflict_do_update(index_elements=[ListeningDaily.identity, ListeningDaily.day],
                                          set_={"ms": ListeningDaily.ms + ms,
                                                "books_touched": func.max(ListeningDaily.books_touched, books)}))
    top = db.query(func.max(ListeningLog.id)).scalar() or 0
    _put_marker(db, ROLLED_LOG_ID_KEY, str(top), "Listening log rolled up through id (internal)")
    if done is not None and done >= last_day:
        db.commit()
        return len(late)
    if done is None:
        oldest = db.query(ListeningLog.at).order_by(ListeningLog.at).first()
        first_day = oldest[0].date() if oldest else last_day + timedelta(days=1)
    else:
        first_day = done + timedelta(days=1)
    start = datetime.combine(first_day, datetime.min.time())
    end = datetime.combine(last_day + timedelta(days=1), datetime.min.time())
    L = ListeningLog
    rows = (db.query(L.identity, L.at, L.event, L.book_key)
            .filter(L.at >= start, L.at < end + LISTEN_GAP)
            .order_by(L.identity, L.at, L.id).all())
    totals: dict = {}
    by_identity: dict = {}
    for identity, at, event, book in rows:
        by_identity.setdefault(identity, []).append((at, event, book))
    for identity, mine in by_identity.items():
        for at, book, ms in listened_spans(mine):
            if ms and at < end:
                day = totals.setdefault((identity, at.date()), [0, set()])
                day[0] += ms
                day[1].add(book)
    for (identity, day), (ms, books) in totals.items():
        db.execute(sqlite_insert(ListeningDaily).values(identity=identity, day=day, ms=ms,
                                                       books_touched=len(books))
                   .on_conflict_do_nothing())
    _put_marker(db, ROLLED_THROUGH_KEY, last_day.isoformat(), "Listening rolled up through (internal)")
    db.commit()
    return len(totals) + len(late)


def _hour(at: datetime) -> datetime:
    return at.replace(minute=0, second=0, microsecond=0)


def hours_through(db: Session) -> Optional[datetime]:
    """Where listening_hourly ends (the end of its last hour, naive UTC), or None before the first rollup."""
    row = db.query(Setting.value).filter(Setting.key == HOURS_THROUGH_KEY).first()
    return _parse_stamp(row[0]) if row else None


def roll_up_hours(db: Session, now: Optional[datetime] = None) -> int:
    """Roll the log up into listening_hourly: per listener, UTC hour, book
    and source, the time listened (listened_spans, the wall time Your stats
    counts). Every complete hour from HOURS_REDO before the marker on is
    worked out again from the log and replaces what was there; an hour older
    than that is final. The first pass starts at the oldest log row, so the
    whole log is rolled up at once. Returns how many hour rows were written.
    Safe with two workers: the first statement is a write, so SQLite's write
    lock is held before the marker is read."""
    from app.models import ListeningHourly

    now = _naive_utc(now)
    end = _hour(now - ROLL_MARGIN)
    H, L = ListeningHourly, ListeningLog
    db.query(H).filter(H.id < 0).delete(synchronize_session=False)
    done = hours_through(db)
    if done is None:
        oldest = db.query(func.min(L.at)).scalar()
        start = _hour(oldest) if oldest is not None else end
    else:
        start = min(done, end) - HOURS_REDO
    if start >= end:
        db.commit()
        return 0
    rows = (db.query(L.identity, L.at, L.event, L.book_key, L.source)
            .filter(L.at >= start, L.at < end + LISTEN_GAP)
            .order_by(L.identity, L.at, L.id).all())
    by_identity: dict = {}
    for identity, at, event, book, source in rows:
        by_identity.setdefault(identity, []).append((at, event, book, source))
    totals: dict = {}
    for identity, mine in by_identity.items():
        spans = listened_spans((at, event, book) for at, event, book, _source in mine)
        for (at, book, ms), (_at, _event, _book, source) in zip(spans, mine):
            if ms and at < end:
                key = (identity, _hour(at), book, source or "web")
                totals[key] = totals.get(key, 0) + ms
    db.query(H).filter(H.hour >= start, H.hour < end).delete(synchronize_session=False)
    for (identity, hour, book, source), ms in totals.items():
        db.add(H(identity=identity, hour=hour, book_key=book, source=source, ms=ms))
    _put_marker(db, HOURS_THROUGH_KEY, utc_iso(end), "Listening rolled up by hour through (internal)")
    db.commit()
    return len(totals)


def prune_log(db: Session, now: Optional[datetime] = None) -> int:
    """Delete log rows older than LOG_DAYS; returns how many. Positions stay.
    The days and hours about to go are rolled up first (roll_up,
    roll_up_hours), and nothing after the last rolled-up day, or within
    HOURS_REDO before the hourly marker, is ever deleted, so all-time totals
    and the hours survive. Hour rows older than HOURLY_KEEP_DAYS go too."""
    from app.models import ListeningHourly

    now = _naive_utc(now)
    roll_up(db, now)
    roll_up_hours(db, now)
    done = rolled_through(db)
    kept_from = datetime.combine(done + timedelta(days=1), datetime.min.time()) if done else datetime.min
    hours = hours_through(db)
    hours_kept_from = hours - HOURS_REDO if hours is not None else datetime.min
    cutoff = min(now - timedelta(days=LOG_DAYS), kept_from, hours_kept_from)
    n = db.query(ListeningLog).filter(ListeningLog.at < cutoff).delete(synchronize_session=False)
    db.query(ListeningHourly).filter(ListeningHourly.hour < now - timedelta(days=HOURLY_KEEP_DAYS)).delete(
        synchronize_session=False)
    # SQLite numbers a new row one above the highest id left, so once the
    # newest rows are gone, ids at or below the log id marker come round
    # again: lower it, or roll_up would take those rows for ones it had seen.
    top = db.query(func.max(ListeningLog.id)).scalar() or 0
    seen = rolled_log_id(db)
    if seen is not None and seen > top:
        _put_marker(db, ROLLED_LOG_ID_KEY, str(top), "Listening log rolled up through id (internal)")
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
