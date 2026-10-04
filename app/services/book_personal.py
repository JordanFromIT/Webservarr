"""
What each person keeps about the Books catalog: My list, the Up next queue
and their 1 to 5 star ratings (spec 2026-10-04-books-page-personal-design.md).

Every row is keyed by account identity (tickets.account_identity), never by
username, and by the catalog's book id. The catalog is shared and rebuilt
from Kavita and Plex; these rows are the person's own:
- A row is kept when its book leaves the catalog or the person cannot see it
  for a while (a source down, a share changed), and shows again when the book
  is back. Reads only ever show books the caller can see (the router filters).
- When a rebuild merges a book into another (merged_into), its rows move to
  the surviving id in the rebuild's own transaction (follow_merges).
- An id that a row still names is never handed to a new book (next_book_id),
  so a kept row can never turn up on a different book.

Ratings are stored here first and are what the site shows; each is then
written through to Kavita (the book's chapter rating) and Plex (every
audiobook edition, stars x 2), as the person, with their own Kavita link and
Plex token (push_rating). A target that cannot be written yet is `pending`
and is tried again on the person's next change, on a visit to the book page
and by the leader worker's loop (retry_due), with backoff and a limit;
past the limit it is `failed:<reason>` until the person changes the rating.
A failure never blocks or reverts the rating itself.

Each write starts with a write, so SQLite's write lock is held before
anything is read and decided: two tabs (or two workers) changing one queue
take turns, and positions stay dense from 0 and unique. Nothing is held in
this module between calls (two uvicorn workers).
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import func, or_

from app.auth import session_manager
from app.database import SessionLocal
from app.integrations import kavita
from app.integrations import plex_player as pp
from app.integrations.config import same_address
from app.models import BookListEntry, BookQueueEntry, BookRating

logger = logging.getLogger(__name__)

LIST_MAX = 500               # books on one person's list
QUEUE_MAX = 500              # books in one person's queue

OK = "ok"
PENDING = "pending"
FAILED = "failed:"           # + the reason: "refused" or "unavailable"

MAX_ATTEMPTS = 8             # failed writes before a target is given up on
BACKOFF_FIRST = 60           # seconds before the first retry; doubles each time
BACKOFF_MAX = 6 * 60 * 60
WAIT_RECHECK = 15 * 60       # a target waiting for a Kavita link or a Plex token: how often the loop looks
RETRY_INTERVAL = 120         # how often the leader's loop runs
RETRY_BATCH = 100            # ratings one pass of the loop tries
SESSION_SCAN_MAX = 5000      # session keys one pass reads, at most


class Full(Exception):
    """The person's list or queue holds as many books as it may."""


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _take_write_lock(db, identity: str) -> None:
    """The transaction's first statement: a write (it deletes nothing), so
    SQLite's write lock is taken here and everything after it is decided
    while another worker's write waits."""
    db.query(BookQueueEntry).filter(BookQueueEntry.identity == identity,
                                    BookQueueEntry.id < 0).delete(synchronize_session=False)


# --- My list ------------------------------------------------------------------------

def list_entries(db, identity: str) -> List[Tuple[int, datetime]]:
    """[(book id, added_at)] on the person's list, newest first (hidden ones
    too: the caller keeps the ones it may show)."""
    return [(b, at) for b, at in db.query(BookListEntry.book_id, BookListEntry.added_at)
            .filter(BookListEntry.identity == identity)
            .order_by(BookListEntry.added_at.desc(), BookListEntry.id.desc())]


def on_list(db, identity: str, book_id: int) -> bool:
    return db.query(BookListEntry.id).filter(BookListEntry.identity == identity,
                                             BookListEntry.book_id == book_id).first() is not None


def add_to_list(db, identity: str, book_id: int) -> None:
    """Put the book on the list (already there: nothing changes). Full when
    the list holds LIST_MAX books."""
    _take_write_lock(db, identity)
    if not on_list(db, identity, book_id):
        count = db.query(func.count(BookListEntry.id)).filter(BookListEntry.identity == identity).scalar()
        if count >= LIST_MAX:
            db.rollback()
            raise Full("Your list is full")
        db.add(BookListEntry(identity=identity, book_id=book_id, added_at=_now()))
    db.commit()


def remove_from_list(db, identity: str, book_ids: Iterable[int]) -> None:
    db.query(BookListEntry).filter(BookListEntry.identity == identity,
                                   BookListEntry.book_id.in_(list(book_ids))).delete(synchronize_session=False)
    db.commit()


# --- Up next ------------------------------------------------------------------------

def queue_ids(db, identity: str) -> List[int]:
    """The person's queue in order (hidden books too)."""
    return [b for (b,) in db.query(BookQueueEntry.book_id).filter(BookQueueEntry.identity == identity)
            .order_by(BookQueueEntry.position, BookQueueEntry.id)]


def _queue_rows(db, identity: str) -> List[BookQueueEntry]:
    return (db.query(BookQueueEntry).filter(BookQueueEntry.identity == identity)
            .order_by(BookQueueEntry.position, BookQueueEntry.id).all())


def _renumber(db, rows: List[BookQueueEntry]) -> None:
    """Positions 0, 1, 2... in the order given. Two passes, so the unique
    (identity, position) never sees two rows at one position mid-way."""
    for i, row in enumerate(rows):
        row.position = -1 - i
    db.flush()
    for i, row in enumerate(rows):
        row.position = i
    db.flush()


def enqueue(db, identity: str, book_id: int) -> None:
    """Add the book at the end of the queue (already queued: it stays where
    it is). Full when the queue holds QUEUE_MAX books."""
    _take_write_lock(db, identity)
    rows = _queue_rows(db, identity)
    if not any(r.book_id == book_id for r in rows):
        if len(rows) >= QUEUE_MAX:
            db.rollback()
            raise Full("Your Up next queue is full")
        row = BookQueueEntry(identity=identity, book_id=book_id, position=len(rows), added_at=_now())
        db.add(row)
        db.flush()
        _renumber(db, rows + [row])
    db.commit()


def dequeue(db, identity: str, book_ids: Iterable[int]) -> None:
    wanted = set(book_ids)
    _take_write_lock(db, identity)
    rows = _queue_rows(db, identity)
    for row in rows:
        if row.book_id in wanted:
            db.delete(row)
    db.flush()
    _renumber(db, [r for r in rows if r.book_id not in wanted])
    db.commit()


def move(db, identity: str, book_id: int, to: int, shown: Iterable[int]) -> bool:
    """Move a queued book to place `to` among the books the caller is shown
    (`shown`, in any order: the books they can see). Books they cannot see
    now keep their place relative to the others. `to` past the end is the
    end. False when the book is not in their queue (nothing changes)."""
    shown = set(shown)
    _take_write_lock(db, identity)
    rows = _queue_rows(db, identity)
    moving = next((r for r in rows if r.book_id == book_id), None)
    if moving is None:
        db.rollback()
        return False
    rest = [r for r in rows if r is not moving]
    visible = [i for i, r in enumerate(rest) if r.book_id in shown]
    if to < len(visible):
        at = visible[max(0, to)]
    else:
        at = visible[-1] + 1 if visible else len(rest)
    _renumber(db, rest[:at] + [moving] + rest[at:])
    db.commit()
    return True


# --- Ratings ------------------------------------------------------------------------

def get_rating(db, identity: str, book_id: int) -> Optional[BookRating]:
    return db.query(BookRating).filter(BookRating.identity == identity, BookRating.book_id == book_id).first()


def _mark_for_writing(row: BookRating, now: datetime) -> None:
    """A change: both targets are to be written again, from a clean slate."""
    row.kavita_state = PENDING
    row.plex_state = PENDING
    row.version = (row.version or 0) + 1
    row.attempts = 0
    row.retry_at = now


def set_rating(db, identity: str, book_id: int, stars: Optional[int]) -> bool:
    """Rate the book 1 to 5, or clear the rating (None). Saved at once; the
    write-through is push_rating's. True when there is something to write
    through (clearing a book never rated is not)."""
    if stars is not None and not 1 <= stars <= 5:
        raise ValueError("stars must be 1 to 5")
    now = _now()
    _take_write_lock(db, identity)
    row = get_rating(db, identity, book_id)
    if row is None:
        if stars is None:
            db.commit()
            return False
        row = BookRating(identity=identity, book_id=book_id, version=0)
        db.add(row)
    row.stars = stars
    row.updated_at = now
    _mark_for_writing(row, now)
    db.commit()
    return True


def shown_rating(row: Optional[BookRating]) -> Optional[int]:
    return row.stars if row is not None else None


def due_on_visit(row: Optional[BookRating], now: Optional[datetime] = None) -> bool:
    """Whether a visit to the book page should try the write-through again:
    a target is pending, and either its backoff has run out or it is only
    waiting for a Kavita link or a Plex token (no failed attempt yet)."""
    if row is None or PENDING not in (row.kavita_state, row.plex_state):
        return False
    now = now or _now()
    return row.attempts == 0 or row.retry_at is None or row.retry_at <= now


def _backoff(attempts: int) -> int:
    return min(BACKOFF_MAX, BACKOFF_FIRST * 2 ** max(0, attempts - 1))


# What a write-through to one target came to: "ok" (written, or nothing of
# the person's is there to write), "wait" (no Kavita link or Plex token to
# write with yet: not a failure), or "fail:<reason>".
WAIT = "wait"


async def _write_kavita(book, session: dict, stars: Optional[int]) -> str:
    from app.routers import kavita_proxy      # the router module imports the services
    if book.kavita_chapter_id is None:
        return OK
    try:
        base = kavita_proxy.kavita_url_for(session)
    except HTTPException:
        return WAIT                            # eBooks switched off for members
    token = session.get("kavita_token") or ""
    if not base or not token or not same_address(session.get("kavita_base"), base):
        return WAIT
    try:
        await kavita.rate_chapter(base, token, book.kavita_series_id, book.kavita_chapter_id, stars or 0)
    except kavita.KavitaTokenRefused:
        return WAIT                            # the link has lapsed: the next one writes it
    except kavita.KavitaRefused:
        return "fail:refused"
    except kavita.KavitaUnavailable:
        return "fail:unavailable"
    return OK


async def _write_plex(keys: List[str], identity: str, session: dict, session_id: Optional[str],
                      stars: Optional[int]) -> str:
    if not keys or not identity.startswith("plex:"):
        return OK                              # no audiobook, or no Plex account: nothing of theirs in Plex
    if not session.get("plex_token"):
        return WAIT
    try:
        if not pp.player_on():
            return OK
        await pp.library_access(session, session_id=session_id)
    except pp.NoServerAccess:
        return OK                              # their share has no audiobooks: nothing of theirs to rate
    except pp.NotInLibrary:
        return OK
    except pp.PlayerUnavailable:
        return "fail:unavailable"
    try:
        await pp.rate(session, keys, stars * 2 if stars else pp.CLEAR_RATING, session_id=session_id)
    except pp.RatingRefused:
        return "fail:refused"
    except pp.NotInLibrary:
        return "fail:refused"
    except pp.PlayerUnavailable:
        return "fail:unavailable"
    return OK


def _targets(db, book_id: int):
    """(the live book, its editions' keys), or (None, []) when the book is not
    in the catalog now: nothing can be written until it is back."""
    from app.services import book_catalog
    book, _survivor = book_catalog.resolve_book(db, book_id)
    if book is None:
        return None, []
    return book, [e.plex_book_key for e in book_catalog.editions_of(db, book)]


async def push_rating(identity: str, book_id: int, session: dict, session_id: Optional[str] = None) -> None:
    """Write the person's rating (or its clearing) through to each target that
    is pending, as them (`session` is theirs: their Kavita link and Plex
    token), and record how it went. Best effort: nothing is raised."""
    try:
        await _push(identity, book_id, session, session_id)
    except Exception as exc:  # noqa: BLE001 - a background write must never take a worker down
        logger.warning("A book rating could not be written through: %s", type(exc).__name__)


async def _push(identity: str, book_id: int, session: dict, session_id: Optional[str]) -> None:
    db = SessionLocal()
    try:
        row = get_rating(db, identity, book_id)
        if row is None or PENDING not in (row.kavita_state, row.plex_state):
            return
        stars, version = row.stars, row.version
        wanted = [t for t in ("kavita", "plex") if getattr(row, f"{t}_state") == PENDING]
        book, keys = _targets(db, book_id)
    finally:
        db.close()

    outcomes: Dict[str, str] = {}
    for target in wanted:
        if book is None:
            outcomes[target] = WAIT
        elif target == "kavita":
            outcomes[target] = await _write_kavita(book, session, stars)
        else:
            outcomes[target] = await _write_plex(keys, identity, session, session_id, stars)
    _record(identity, book_id, version, outcomes)


def _record(identity: str, book_id: int, version: int, outcomes: Dict[str, str]) -> None:
    db = SessionLocal()
    try:
        now = _now()
        _take_write_lock(db, identity)
        row = get_rating(db, identity, book_id)
        if row is None:
            db.commit()
            return
        if row.version != version:
            # Changed while this was being written. The change writes itself,
            # but this write may land after it at the target, so the target is
            # written once more with what is stored now.
            for target in outcomes:
                setattr(row, f"{target}_state", PENDING)
            row.retry_at = now
            db.commit()
            return
        failures = {t: o[len("fail:"):] for t, o in outcomes.items() if o.startswith("fail:")}
        for target, outcome in outcomes.items():
            if outcome == OK:
                setattr(row, f"{target}_state", OK)
        if failures:
            row.attempts += 1
            if row.attempts >= MAX_ATTEMPTS:
                for target, reason in failures.items():
                    setattr(row, f"{target}_state", FAILED + reason)
                row.retry_at = None
            else:
                row.retry_at = now + timedelta(seconds=_backoff(row.attempts))
        elif WAIT in outcomes.values():
            row.retry_at = now + timedelta(seconds=WAIT_RECHECK)
        else:
            row.retry_at = None
        if row.stars is None and row.kavita_state == OK and row.plex_state == OK:
            db.delete(row)           # cleared everywhere: nothing left to keep
        db.commit()
    finally:
        db.close()


def _decoded(data: dict) -> dict:
    return {(k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v)
            for k, v in data.items()}


async def _sessions_of(redis, identities: set) -> Dict[str, dict]:
    """{identity: one of their live sessions} for these people, the one best
    able to write (a Kavita link, then a Plex token). Read without touching
    the session's expiry (a background write must not keep a session alive),
    and past the absolute lifetime a session is not used."""
    from app.routers.tickets import account_identity
    found: Dict[str, Tuple[int, dict]] = {}
    seen = 0
    now = int(time.time())
    async for key in redis.scan_iter(match="session:*", count=500):
        seen += 1
        if seen > SESSION_SCAN_MAX:
            break
        data = _decoded(await redis.hgetall(key))
        if not data:
            continue
        try:
            if now - int(data.get("created_at") or now) > session_manager.absolute_max_age:
                continue
        except ValueError:
            pass
        identity = account_identity(data)
        if identity not in identities:
            continue
        score = (2 if data.get("kavita_token") else 0) + (1 if data.get("plex_token") else 0)
        if identity not in found or score > found[identity][0]:
            found[identity] = (score, data)
    return {identity: data for identity, (_score, data) in found.items()}


def _due(now: datetime) -> List[Tuple[str, int]]:
    db = SessionLocal()
    try:
        return [(i, b) for i, b in db.query(BookRating.identity, BookRating.book_id).filter(
            or_(BookRating.kavita_state == PENDING, BookRating.plex_state == PENDING),
            or_(BookRating.retry_at.is_(None), BookRating.retry_at <= now))
            .order_by(BookRating.retry_at, BookRating.id).limit(RETRY_BATCH)]
    finally:
        db.close()


async def retry_due(redis) -> int:
    """One pass of the leader's loop: try again every pending rating whose
    backoff has run out, as its person, through one of their live sessions.
    A person with no live session waits for their next visit. Returns how
    many were tried."""
    due = _due(_now())
    if not due:
        return 0
    sessions = await _sessions_of(redis, {identity for identity, _ in due})
    tried = 0
    for identity, book_id in due:
        session = sessions.get(identity)
        if session is not None:
            # No session id: whatever the write learns (Plex access) is not
            # written back to the session, so its expiry is not touched.
            await push_rating(identity, book_id, session, None)
            tried += 1
    return tried


# --- The catalog's side -----------------------------------------------------------------

def next_book_id(db) -> Optional[int]:
    """The id a new catalog book must take so that it is not one a person's
    row still names (a book that left the catalog and may come back), or None
    when the database's own next id is already past every such id."""
    from app.models import Book
    named = max((db.query(func.max(m.book_id)).scalar() or 0) for m in (BookListEntry, BookQueueEntry, BookRating))
    top = db.query(func.max(Book.id)).scalar() or 0
    return named + 1 if named >= top else None


def follow_merges(db, moves: Dict[int, int]) -> None:
    """Move every row of a merged book (a ghost) to the book it was merged
    into, in the rebuild's transaction (no commit). `moves` is {ghost id:
    surviving id}. Where the person already has a row for the survivor:
    the list keeps one entry (the earlier date), the queue keeps the earlier
    place, and the newer rating wins. A rating that moves is written through
    again, because the survivor's items now include the ghost's."""
    moves = {g: t for g, t in moves.items() if g != t}
    if not moves:
        return
    ghosts = list(moves)
    now = _now()

    for entry in db.query(BookListEntry).filter(BookListEntry.book_id.in_(ghosts)).order_by(BookListEntry.id).all():
        target = moves[entry.book_id]
        held = db.query(BookListEntry).filter(BookListEntry.identity == entry.identity,
                                              BookListEntry.book_id == target).first()
        if held is not None:
            held.added_at = min(held.added_at, entry.added_at)
            db.delete(entry)
        else:
            entry.book_id = target
        db.flush()

    people = {i for (i,) in db.query(BookQueueEntry.identity).filter(BookQueueEntry.book_id.in_(ghosts)).distinct()}
    for identity in sorted(people):
        kept, seen = [], set()
        for row in _queue_rows(db, identity):
            book_id = moves.get(row.book_id, row.book_id)
            if book_id in seen:
                db.delete(row)           # the earlier place wins
                continue
            seen.add(book_id)
            kept.append(row)
        db.flush()
        _renumber(db, kept)               # the gaps close first, then the ids move (unique pairs hold)
        for row in kept:
            row.book_id = moves.get(row.book_id, row.book_id)
        db.flush()

    for rating in db.query(BookRating).filter(BookRating.book_id.in_(ghosts)).order_by(BookRating.id).all():
        target = moves[rating.book_id]
        held = get_rating(db, rating.identity, target)
        if held is None:
            rating.book_id = target
            winner = rating
        else:
            winner = held
            if rating.updated_at > held.updated_at:
                held.stars, held.updated_at = rating.stars, rating.updated_at
            db.delete(rating)
        _mark_for_writing(winner, now)
        db.flush()
