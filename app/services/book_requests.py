"""
Book requests that have not arrived yet, for "where requests stand".

The Requests page asks for a book by adding it to Chaptarr monitored and
searching for it (chaptarr.request_book). So a book request is a book
Chaptarr monitors and holds no file for: the same rule Radarr's wanted list
uses for a film. Books Chaptarr merely tracks (adding an author imports their
whole back catalogue unmonitored) were never asked for and are left out, as
are books that already have a file.

The one thing WebServarr keeps of its own is when each Chaptarr book row was
asked for (book_request_times). A row the author import brought in is asked
for by monitoring it, which leaves Chaptarr's `added` at the import, months
before the request; the page would say the request has waited all that time.

Rows use the film reason codes (app/services/request_status.py), so the page
words a book exactly as it words a film: Searching, Downloading, Retrying,
Stuck, Not out yet. Like the film rows they carry nothing about who asked,
and nothing about the download client, indexer or file paths either.

Kept apart from the film and show snapshot on purpose: Chaptarr being down
must not take the film rows with it, so this has its own cache, its own
endpoint (503 while Chaptarr cannot be read) and its own turn in the warmer.
"""

import json
import logging
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import BookRequestTime
from app.services.request_status import REASON_TO_STATE, STATE_TO_GROUP, _parse_dt
from app.utils import utc_iso

logger = logging.getLogger(__name__)

CACHE_KEY = "webservarr:book_requests:v1"
CACHE_TTL = 20 * 60

# While Chaptarr cannot be read, every page view would otherwise wait out the
# client timeout again. The failure is remembered briefly instead.
DOWN_KEY = "webservarr:book_requests:down"
DOWN_TTL = 60

# Matches the films: a release date a couple of days out is noise.
_RELEASE_GRACE_DAYS = 2

# "Added this month", as for films and shows.
RECENT_DAYS = 30

FORMATS = ("ebook", "audiobook")


class Unavailable(Exception):
    """Chaptarr is configured but cannot be read right now."""


def _has_file(book: dict) -> bool:
    return bool(book.get("hasFiles")) or bool((book.get("statistics") or {}).get("bookFileCount"))


def is_request(book: dict) -> bool:
    """Asked for and not here: monitored, with no file."""
    return bool(book.get("monitored")) and not _has_file(book)


def _released(book: dict, now: datetime) -> bool:
    """No date counts as out: an unknown date is no reason to say "not yet"."""
    dt = _parse_dt(book.get("releaseDate"))
    return dt is None or (now - dt).days >= -_RELEASE_GRACE_DAYS


def classify_book(book: dict, queue_entry, now: datetime) -> str:
    """Reason code for one book request (the film table's words)."""
    if queue_entry:
        state = str(queue_entry.get("trackedDownloadState") or "").lower()
        status = str(queue_entry.get("status") or "").lower()
        tracked = str(queue_entry.get("trackedDownloadStatus") or "").lower()
        troubled = bool(queue_entry.get("statusMessages") or queue_entry.get("errorMessage"))
        if "import" in state:
            return "IMPORT_BLOCKED" if tracked in ("warning", "error") or troubled else "DOWNLOADING"
        if status in ("warning", "failed") or tracked in ("warning", "error"):
            return "DOWNLOAD_STALLED"
        return "DOWNLOADING"
    if not _released(book, now):
        return "NOT_RELEASED_YET"
    return "NO_RELEASE_FOUND"


def _percent(entry) -> float:
    if not entry:
        return 0
    try:
        size = float(entry.get("size") or 0)
        left = float(entry.get("sizeleft") or 0)
    except (TypeError, ValueError):
        return 0
    if size <= 0:
        return 0
    return max(0.0, min(100.0, round(100 * (size - left) / size, 1)))


def _author(book: dict, authors: dict) -> str:
    """The author's name. Not authorTitle: that is a sort key with the title
    run on ("twain, mark The Adventures of Tom Sawyer")."""
    name = (authors or {}).get(book.get("authorId"))
    if not name and isinstance(book.get("author"), dict):
        name = book["author"].get("authorName")
    return name if isinstance(name, str) else ""


def record_requested(db: Session, book_ids, now: datetime) -> None:
    """Remember that these Chaptarr book rows were asked for at `now` (naive
    UTC); a row asked for again takes the newer time. Database errors
    propagate (the caller decides)."""
    for book_id in dict.fromkeys(book_ids):
        stmt = sqlite_insert(BookRequestTime).values(book_id=book_id, requested_at=now)
        db.execute(stmt.on_conflict_do_update(index_elements=[BookRequestTime.book_id],
                                              set_={"requested_at": now}))
    db.commit()


def _requested_times() -> dict:
    """{Chaptarr book row id: naive UTC} for every recorded request; {} when
    the database cannot be read, so the rows fall back to Chaptarr's `added`."""
    db = SessionLocal()
    try:
        return dict(db.query(BookRequestTime.book_id, BookRequestTime.requested_at).all())
    except SQLAlchemyError as exc:
        logger.warning("Could not read book request times: %s", type(exc).__name__)
        return {}
    finally:
        db.close()


def _asked_at(book: dict, requested: dict):
    """When the book was asked for, aware UTC: the later of Chaptarr's
    `added` and a request recorded here (a row can be asked for again after
    a file was removed), or None."""
    added, asked = _parse_dt(book.get("added")), requested.get(book.get("id"))
    times = [t if t.tzinfo else t.replace(tzinfo=timezone.utc) for t in (added, asked) if t]
    return max(times, default=None)


def build_rows(books, queue, now: datetime = None, authors: dict = None, requested: dict = None):
    """
    Turn Chaptarr's book list and queue into page rows and summary counts.

    Pure, so the mapping is tested without a network. `authors` maps an
    author id to a name (the book list carries only the id); `requested`
    maps a book row id to when it was asked for here (naive UTC), which
    wins over an older `added`. Returns (rows, summary) where summary is
    {in_progress, unreleased, added_recently} counted the way the film
    figures are (Radarr's wanted list): a book still being chased, a book
    not out yet, a request made in the last month.
    """
    now = now or datetime.now(timezone.utc)
    by_book = {}
    for entry in queue or []:
        book_id = entry.get("bookId")
        # One book can have several downloads; the first one stands for it.
        if book_id is not None and book_id not in by_book:
            by_book[book_id] = entry

    cutoff = now - timedelta(days=RECENT_DAYS)
    rows = []
    summary = {"in_progress": 0, "unreleased": 0, "added_recently": 0}
    for book in books or []:
        if not book.get("monitored"):
            continue
        asked_at = _asked_at(book, requested or {})
        if asked_at and asked_at > cutoff:
            summary["added_recently"] += 1
        if _has_file(book):
            continue

        entry = by_book.get(book.get("id"))
        reason = classify_book(book, entry, now)
        if reason == "NOT_RELEASED_YET":
            summary["unreleased"] += 1
        else:
            summary["in_progress"] += 1

        fmt = book.get("mediaType") if book.get("mediaType") in FORMATS else "ebook"
        state = REASON_TO_STATE.get(reason, "NEEDS_ADMIN")
        row = {
            "request_id": f"book-{book.get('id')}",
            "media_type": fmt,
            "title": book.get("title") or "",
            "author": _author(book, authors),
            "requested_at": utc_iso(asked_at),
            "reason_code": reason,
            "state_code": state,
            "group": STATE_TO_GROUP.get(state, "needs_look"),
        }
        if entry:
            row["percent"] = _percent(entry)
        rows.append(row)

    rows.sort(key=lambda r: r.get("requested_at") or "")
    return rows, summary


async def build_snapshot() -> dict:
    """Read Chaptarr (GET only) and build the payload. Raises Unavailable."""
    from app.integrations import chaptarr

    try:
        data = await chaptarr.wanted_books()
    except chaptarr.ChaptarrUnavailable as exc:
        raise Unavailable(str(exc)) from exc

    if data is None:
        rows, summary, configured = [], {"in_progress": 0, "unreleased": 0, "added_recently": 0}, False
    else:
        rows, summary = build_rows(data["books"], data["queue"], authors=data.get("authors"),
                                   requested=_requested_times())
        configured = True
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "configured": configured,
        "total": len(rows),
        "summary": summary,
        "items": rows,
    }


# --- Cache ------------------------------------------------------------------
# Redis, as for the film snapshot: two uvicorn workers must serve one answer.

_redis = None


def _get_redis():
    global _redis
    if _redis is None:
        import redis.asyncio as aioredis
        _redis = aioredis.from_url(settings.redis_url)
    return _redis


async def get_cached_snapshot():
    """The last built snapshot, or None."""
    try:
        raw = await _get_redis().get(CACHE_KEY)
        return json.loads(raw) if raw else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read book-request cache: %s", exc)
        return None


async def _store(snapshot: dict) -> None:
    try:
        await _get_redis().set(CACHE_KEY, json.dumps(snapshot), ex=CACHE_TTL)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not write book-request cache: %s", exc)


async def _recently_down() -> bool:
    try:
        return bool(await _get_redis().get(DOWN_KEY))
    except Exception:  # noqa: BLE001
        return False


async def _mark_down() -> None:
    try:
        await _get_redis().set(DOWN_KEY, "1", ex=DOWN_TTL)
    except Exception:  # noqa: BLE001
        pass


async def refresh() -> dict:
    """Build and cache. Raises Unavailable, leaving the last good copy cached."""
    started = time.monotonic()
    try:
        snapshot = await build_snapshot()
    except Unavailable:
        await _mark_down()
        raise
    await _store(snapshot)
    logger.info("Book requests rebuilt: %d outstanding, %.1fs",
                snapshot["total"], time.monotonic() - started)
    return snapshot


async def get_snapshot() -> dict:
    """Cached, else built now. Raises Unavailable while Chaptarr cannot be read."""
    snapshot = await get_cached_snapshot()
    if snapshot is not None:
        return snapshot
    if await _recently_down():
        raise Unavailable("Chaptarr was unreachable moments ago")
    return await refresh()
