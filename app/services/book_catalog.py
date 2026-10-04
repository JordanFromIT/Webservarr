"""
The Books catalog: one stored list of works, ebooks from Kavita and
audiobooks from Plex, rebuilt every 15 minutes, after a Chaptarr import and on
demand (spec 2026-10-03-books-page-core-design.md, section 3).

Pairing is automatic and exact: an ebook and an audiobook are one entry only
when their work keys (plex_player.work_key, the key the player stores) are
equal and no other item has that key on either side. Anything uncertain stays
two entries. An admin's override (BookPairOverride) always wins: `pair` joins
two items whatever their keys say, `apart` keeps them separate.

A rebuild reads both sources first and writes once, in one transaction. A
source that fails to read keeps its side of the catalog exactly as it was (its
rows, their ids and counts); only a successful read removes what has gone.

The ebook side is one book in Kavita: a numbered volume, or a chapter where
Kavita keeps a standalone book as one (never a whole series, which can hold a
dozen books). Its id is the chapter that is read.

Ids. A book is found again by its Kavita chapter id or its Plex key, never by title,
so a book keeps its `books.id`. The audiobook's row is the one that is kept
when a pair forms; the ebook's row stays behind as a ghost (merged_into set to
the survivor, its Kavita chapter id kept), so an old link still finds the book. When
the pair splits, the ebook gets its ghost back (or a new row if it has none)
and the audiobook keeps the row. Ghosts never show as books: only rows with
merged_into null do.

Nothing is held in this module between calls (two uvicorn workers): one
rebuild at a time is a Redis lock with an expiry, the same lease the
notification poller uses, and where the last rebuild stands is the
BookCatalogMeta row.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

import redis.asyncio as aioredis

from app.config import settings
from app.database import SessionLocal
from app.integrations import kavita, plex_player
from app.models import Book, BookCatalogMeta, BookPairOverride
from app.services.notification_poller import LeaderLease

logger = logging.getLogger(__name__)

LOCK_KEY = "books:catalog:rebuild"
# Far longer than a rebuild takes (one read of each source and one short
# write); it only bounds how long the catalog stays unbuilt if a worker dies
# mid-rebuild.
LOCK_TTL = 10 * 60

REBUILD_INTERVAL = 900

ACTIONS = ("pair", "apart")

_FIELD_LIMITS = (("title", 300), ("sort_title", 300), ("author", 200), ("narrator", 200),
                 ("series", 200), ("description", None))
_COLUMNS = ("work_key", "title", "sort_title", "author", "narrator", "series", "series_number", "description",
            "kavita_chapter_id", "kavita_volume_id", "kavita_series_id", "kavita_library_id", "plex_book_key",
            "added_at", "ebook_added_at", "audio_added_at", "cover_source", "merged_into")


@dataclass
class _Item:
    """One thing in a source: an ebook (side "k", id a Kavita chapter id) or an
    audiobook (side "p", id a Plex book key). `fields` is None when the source
    could not be read: the item stands as its row has it."""
    side: str
    id: object
    key: Optional[str]
    fields: Optional[dict]


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _epoch(value) -> Optional[datetime]:
    return datetime.fromtimestamp(value, timezone.utc).replace(tzinfo=None) if value else None


# --- Reading the sources --------------------------------------------------------------

async def _read(fetch, name: str) -> tuple:
    """(items, None) from a source, or (None, a sentence for the admin) when it
    cannot be read. Only text the integrations wrote themselves is kept."""
    try:
        return await fetch(), None
    except (kavita.KavitaUnavailable, plex_player.PlayerUnavailable, plex_player.PlayerOff) as exc:
        return None, str(exc)[:200]
    except Exception as exc:  # noqa: BLE001 - a source that breaks is a source that failed, never a crash
        logger.warning("The %s read for the Books catalog failed: %s", name, type(exc).__name__)
        return None, f"{name} could not be read"


def _ebook_item(book: dict) -> _Item:
    key = None
    if book["author"] and book["title"]:
        try:
            key = plex_player.work_key(book["author"], book["title"])
        except Exception as exc:  # noqa: BLE001 - no key means no automatic pair, as for the player
            logger.warning("No work key could be made of an ebook's title: %s", type(exc).__name__)
    return _Item("k", book["id"], key, {
        "title": book["title"], "sort_title": book["sort_title"], "author": book["author"],
        "narrator": "", "series": book["series"], "series_number": book["series_number"],
        "description": book["description"], "added_at": book["added_at"],
        "library_id": book["library_id"], "series_id": book["series_id"], "volume_id": book["volume_id"],
    })


def _audiobook_item(book: dict) -> _Item:
    return _Item("p", book["key"], book.get("work_key"), {
        "title": book["title"], "sort_title": book.get("sort_title") or book["title"],
        "author": book["author"], "narrator": book["narrator"], "series": book["series"],
        "series_number": book.get("series_number"), "description": book.get("description") or "",
        "added_at": _epoch(book.get("added_at")), "library_id": None,
    })


# --- Pairing ------------------------------------------------------------------------

def _effective_pairs(overrides: list) -> Dict[int, str]:
    """{kavita_chapter_id: plex_book_key} for the `pair` overrides. An item is in
    at most one: where two overrides name the same item, the newer wins."""
    pairs: Dict[int, str] = {}
    taken: Dict[str, int] = {}
    for o in sorted((o for o in overrides if o.action == "pair"), key=lambda o: (o.created_at, o.id)):
        old_key = pairs.pop(o.kavita_chapter_id, None)
        if old_key is not None:
            taken.pop(old_key, None)
        old_series = taken.pop(o.plex_book_key, None)
        if old_series is not None:
            pairs.pop(old_series, None)
        pairs[o.kavita_chapter_id] = o.plex_book_key
        taken[o.plex_book_key] = o.kavita_chapter_id
    return pairs


def _groups(ebooks: Dict[int, _Item], audiobooks: Dict[str, _Item], overrides: list) -> List[tuple]:
    """Every book as (ebook or None, audiobook or None), paired as the
    overrides and then the work keys say."""
    pairs = _effective_pairs(overrides)
    apart = {(o.kavita_chapter_id, o.plex_book_key) for o in overrides if o.action == "apart"}
    groups: List[tuple] = []
    joined_e, joined_a = set(), set()
    for kavita_id, plex_key in sorted(pairs.items()):
        if kavita_id in ebooks and plex_key in audiobooks:
            groups.append((ebooks[kavita_id], audiobooks[plex_key]))
            joined_e.add(kavita_id)
            joined_a.add(plex_key)
    # An item an override names does not pair by key as well, even when its
    # partner is gone: the admin has said who it goes with.
    named_e, named_a = set(pairs), set(pairs.values())
    by_key_e: Dict[str, list] = {}
    by_key_a: Dict[str, list] = {}
    for item in ebooks.values():
        if item.key and item.id not in named_e:
            by_key_e.setdefault(item.key, []).append(item)
    for item in audiobooks.values():
        if item.key and item.id not in named_a:
            by_key_a.setdefault(item.key, []).append(item)
    for key, es in by_key_e.items():
        as_ = by_key_a.get(key, [])
        if len(es) == 1 and len(as_) == 1 and (es[0].id, as_[0].id) not in apart:
            groups.append((es[0], as_[0]))
            joined_e.add(es[0].id)
            joined_a.add(as_[0].id)
    groups += [(i, None) for i in ebooks.values() if i.id not in joined_e]
    groups += [(None, i) for i in audiobooks.values() if i.id not in joined_a]
    return groups


# --- Writing the catalog ------------------------------------------------------------

def _new_book(db, now: datetime) -> Book:
    book = Book(title="", sort_title="", author="", narrator="", series="", description="",
                cover_source="plex", updated_at=now)
    db.add(book)
    db.flush()      # the id is needed to point ghosts at it
    return book


def _fill(book: Book, ebook: Optional[_Item], audiobook: Optional[_Item], now: datetime, fresh_row: bool) -> None:
    """Set the book's columns from its items. The audiobook's text wins where
    both have it. A stale item (its source failed) stands as the row has it."""
    before = {c: getattr(book, c) for c in _COLUMNS}
    items = [i for i in (audiobook, ebook) if i is not None]

    def text(name: str) -> str:
        for item in items:
            value = getattr(book, name) if item.fields is None else item.fields.get(name)
            if value:
                return str(value)
        return ""

    for name, limit in _FIELD_LIMITS:
        value = text(name).strip()
        setattr(book, name, value[:limit] if limit else value)
    book.title = book.title or "Untitled"
    book.sort_title = book.sort_title or book.title
    number = None
    for item in items:
        number = book.series_number if item.fields is None else item.fields.get("series_number")
        if number is not None:
            break
    book.series_number = number

    def stamp(item: Optional[_Item], current):
        if item is None:
            return None
        return current if item.fields is None else item.fields.get("added_at")

    book.work_key = (audiobook or ebook).key
    book.kavita_chapter_id = ebook.id if ebook else None
    book.plex_book_key = audiobook.id if audiobook else None
    if ebook and ebook.fields is not None:
        book.kavita_library_id = ebook.fields.get("library_id")
        book.kavita_series_id = ebook.fields.get("series_id")
        book.kavita_volume_id = ebook.fields.get("volume_id")
    elif not ebook:
        book.kavita_library_id = book.kavita_series_id = book.kavita_volume_id = None
    book.ebook_added_at = stamp(ebook, book.ebook_added_at)
    book.audio_added_at = stamp(audiobook, book.audio_added_at)
    dates = [d for d in (book.ebook_added_at, book.audio_added_at) if d is not None]
    book.added_at = min(dates) if dates else (book.added_at or now)
    book.cover_source = "kavita" if ebook else "plex"
    book.merged_into = None
    if fresh_row or any(getattr(book, c) != before[c] for c in _COLUMNS):
        book.updated_at = now


def _apply(reason: str, ebooks: Optional[list], audiobooks: Optional[list], errors: dict) -> dict:
    """Write one rebuild. `ebooks` and `audiobooks` are what each source gave,
    None for a source that could not be read."""
    db = SessionLocal()
    try:
        now = _now()
        meta = db.get(BookCatalogMeta, 1)
        if meta is None:
            meta = BookCatalogMeta(id=1, ebook_count=0, audiobook_count=0, book_count=0)
            db.add(meta)
        meta.last_rebuild_at = now
        meta.last_reason = (reason or "")[:40]
        meta.kavita_error = errors["kavita"]
        meta.plex_error = errors["plex"]
        db.flush()   # takes SQLite's write lock before anything is read or decided
        if ebooks is None and audiobooks is None:
            db.commit()
            return _result(meta, ok=False)
        meta.last_ok_at = now

        rows = db.query(Book).order_by(Book.id).all()
        live = [r for r in rows if r.merged_into is None]
        ghosts = [r for r in rows if r.merged_into is not None]
        live_by_k: Dict[int, Book] = {}
        live_by_p: Dict[str, Book] = {}
        for r in live:
            if r.kavita_chapter_id is not None:
                live_by_k.setdefault(r.kavita_chapter_id, r)
            if r.plex_book_key is not None:
                live_by_p.setdefault(r.plex_book_key, r)
        ghosts_by_k: Dict[int, List[Book]] = {}
        for g in ghosts:
            if g.kavita_chapter_id is not None:
                ghosts_by_k.setdefault(g.kavita_chapter_id, []).append(g)

        # A source that failed stands as its live rows have it.
        if ebooks is not None:
            e_items = {i.id: i for i in map(_ebook_item, ebooks)}
        else:
            e_items = {k: _Item("k", k, r.work_key, None) for k, r in live_by_k.items()}
        if audiobooks is not None:
            a_items = {i.id: i for i in map(_audiobook_item, audiobooks)}
        else:
            a_items = {k: _Item("p", k, r.work_key, None) for k, r in live_by_p.items()}

        groups = _groups(e_items, a_items, db.query(BookPairOverride).order_by(BookPairOverride.id).all())
        # Audiobooks claim their rows first: an audiobook's row is the book's.
        groups.sort(key=lambda g: (g[1] is None, str(g[1].id) if g[1] else "", str(g[0].id) if g[0] else ""))

        used: set = set()
        retired: set = set()
        assigned: List[tuple] = []
        fresh: set = set()
        for ebook, audiobook in groups:
            if audiobook is not None:
                row = live_by_p.get(audiobook.id)
                if row is None or row.id in used:
                    row = _new_book(db, now)
                    fresh.add(row.id)
            else:
                row = live_by_k.get(ebook.id)
                if row is None or row.id in used:
                    # The ebook has left an audiobook's row (a split) or has
                    # none: its ghost comes back, else it is a new book.
                    pool = ghosts_by_k.get(ebook.id, [])
                    ghost = next((g for g in pool if row is not None and g.merged_into == row.id), None) \
                        or (pool[0] if pool else None)
                    if ghost is not None:
                        pool.remove(ghost)
                        ghost.merged_into = None
                        row = ghost
                    else:
                        row = _new_book(db, now)
                        fresh.add(row.id)
            used.add(row.id)
            assigned.append((ebook, audiobook, row))

        for ebook, audiobook, row in assigned:
            if ebook is None or audiobook is None:
                continue
            # The ebook joined an audiobook: its own earlier row becomes a
            # ghost of this one, unless that row is another book's.
            earlier = live_by_k.get(ebook.id)
            if earlier is not None and earlier.id not in used and earlier.id not in retired:
                earlier.merged_into = row.id
                earlier.plex_book_key = None
                retired.add(earlier.id)
            for g in ghosts_by_k.get(ebook.id, []):
                g.merged_into = row.id

        for row in live:
            if row.id not in used and row.id not in retired:
                db.delete(row)

        for ebook, audiobook, row in assigned:
            _fill(row, ebook, audiobook, now, row.id in fresh)
        db.flush()

        # Every ghost points at a live book, not at another ghost; one whose
        # book is gone goes with it.
        ghost_rows = {g.id: g for g in db.query(Book).filter(Book.merged_into.isnot(None)).all()}
        for g in ghost_rows.values():
            target, hops = g.merged_into, 0
            while target in ghost_rows and hops < 50:
                target, hops = ghost_rows[target].merged_into, hops + 1
            if target not in used:
                db.delete(g)
            else:
                g.merged_into = target

        meta.ebook_count = len(e_items)
        meta.audiobook_count = len(a_items)
        meta.book_count = len(assigned)
        db.commit()
        return _result(meta, ok=True)
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def _result(meta: BookCatalogMeta, ok: bool, skipped: bool = False) -> dict:
    return {"ok": ok, "ebooks": meta.ebook_count or 0, "audiobooks": meta.audiobook_count or 0,
            "books": meta.book_count or 0,
            "errors": {"kavita": meta.kavita_error, "plex": meta.plex_error}, "skipped": skipped}


async def _run(reason: str) -> dict:
    (ebooks, kavita_error), (audiobooks, plex_error) = await asyncio.gather(
        _read(kavita.list_books, "Kavita"), _read(plex_player.catalog_books, "Plex"))
    errors = {"kavita": kavita_error, "plex": plex_error}
    result = await asyncio.to_thread(_apply, reason, ebooks, audiobooks, errors)
    logger.info("Books catalog rebuilt (%s): %d ebooks, %d audiobooks, %d books%s", reason,
                result["ebooks"], result["audiobooks"], result["books"],
                "" if result["ok"] else " (no source could be read)")
    return result


async def rebuild(reason: str) -> dict:
    """Rebuild the catalog from Kavita and Plex.

    {"ok", "ebooks", "audiobooks", "books", "errors": {"kavita", "plex"},
    "skipped"}. `ok` is true when at least one source was read; a source that
    could not be read is named in `errors` and its side of the catalog is
    left as it was. `skipped` is true (and nothing ran) when another rebuild
    holds the lock; the counts are then the last rebuild's. A failure of the
    database itself is raised."""
    redis = aioredis.from_url(settings.redis_url)
    lease = LeaderLease(redis, key=LOCK_KEY, ttl=LOCK_TTL)
    try:
        if not await lease.refresh():
            return await asyncio.to_thread(_stored_result, True)
        try:
            return await _run(reason)
        finally:
            await lease.release()
    finally:
        await redis.aclose()


def _stored_result(skipped: bool) -> dict:
    db = SessionLocal()
    try:
        meta = db.get(BookCatalogMeta, 1) or BookCatalogMeta()
        return _result(meta, ok=False, skipped=skipped)
    finally:
        db.close()


async def catalog_status() -> dict:
    """{"last_rebuild_at", "last_ok_at", "counts": {"ebooks", "audiobooks",
    "books"}, "errors": {"kavita", "plex"}, "running"}. The times are naive
    UTC datetimes (None before the first rebuild); `running` is whether a
    rebuild holds the lock now."""
    def stored() -> dict:
        db = SessionLocal()
        try:
            meta = db.get(BookCatalogMeta, 1) or BookCatalogMeta()
            return {"last_rebuild_at": meta.last_rebuild_at, "last_ok_at": meta.last_ok_at,
                    "counts": {"ebooks": meta.ebook_count or 0, "audiobooks": meta.audiobook_count or 0,
                               "books": meta.book_count or 0},
                    "errors": {"kavita": meta.kavita_error, "plex": meta.plex_error}}
        finally:
            db.close()

    status = await asyncio.to_thread(stored)
    redis = aioredis.from_url(settings.redis_url)
    try:
        status["running"] = bool(await redis.exists(LOCK_KEY))
    except Exception as exc:  # noqa: BLE001 - an unreadable lock is not a reason to hide the rest
        logger.warning("Books catalog lock could not be read: %s", type(exc).__name__)
        status["running"] = False
    finally:
        await redis.aclose()
    return status


# --- Pairing overrides --------------------------------------------------------------

def set_override(db, kavita_chapter_id: int, plex_book_key: str, action: str, created_by: str) -> BookPairOverride:
    """Record the admin's decision about one Kavita book (its chapter id) and one Plex book.
    A new `pair` for either item replaces that item's earlier pair. The change
    shows at the next rebuild."""
    if action not in ACTIONS:
        raise ValueError("action must be 'pair' or 'apart'")
    if action == "pair":
        for old in db.query(BookPairOverride).filter(
                BookPairOverride.action == "pair",
                (BookPairOverride.kavita_chapter_id == kavita_chapter_id)
                | (BookPairOverride.plex_book_key == plex_book_key)).all():
            db.delete(old)
        db.flush()
    row = db.query(BookPairOverride).filter(
        BookPairOverride.kavita_chapter_id == kavita_chapter_id,
        BookPairOverride.plex_book_key == plex_book_key).first()
    if row is None:
        row = BookPairOverride(kavita_chapter_id=kavita_chapter_id, plex_book_key=plex_book_key)
        db.add(row)
    row.action = action
    row.created_by = created_by
    row.created_at = _now()
    db.commit()
    return row


def remove_override(db, kavita_chapter_id: int, plex_book_key: str) -> bool:
    """Drop the decision about the pair; True when there was one."""
    removed = db.query(BookPairOverride).filter(
        BookPairOverride.kavita_chapter_id == kavita_chapter_id,
        BookPairOverride.plex_book_key == plex_book_key).delete()
    db.commit()
    return bool(removed)
