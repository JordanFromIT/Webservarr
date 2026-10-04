"""
The Books catalog: one stored list of works, ebooks from Kavita and
audiobooks from Plex, rebuilt every 15 minutes, after a Chaptarr import and on
demand (spec 2026-10-03-books-page-core-design.md, section 3).

A work is one book: at most one ebook and any number of audiobook editions
(the same book narrated more than once). The ebook is one book in Kavita: a
numbered volume, or a chapter where Kavita keeps a standalone book as one
(never a whole series, which can hold a dozen books); its id is the chapter
that is read. An edition is one Plex book (album or album:disc).

Pairing is automatic and exact: an ebook takes every edition whose work key
(plex_player.work_key, the key the player stores) equals its own, if no other
ebook has that key; editions of one key with no ebook are one book of several
editions. Anything uncertain stays apart. An admin's override
(BookPairOverride) always wins: `pair` joins one edition to an ebook whatever
their keys say, `apart` keeps one edition out of that ebook's book.

A rebuild reads both sources first and writes once, in one transaction. A
source that fails to read keeps its side of the catalog exactly as it was (its
rows, their ids and counts); only a successful read removes what has gone.

Ids. A book is found again by its Kavita chapter id or its editions' Plex
keys, never by title, so a book keeps its `books.id`. When items that were in
different rows become one book, the row that held an edition (the lowest id) is
kept and the others stay behind as ghosts (merged_into set to the survivor,
what they held remembered), so an old link still finds the book. When a book
splits, the side that leaves gets its ghost back, or a new row if it has none.
Ghosts never show as books: only rows with merged_into null do.

Nothing is held in this module between calls (two uvicorn workers): one
rebuild at a time is a Redis lock with an expiry, the same lease the
notification poller uses, and where the last rebuild stands is the
BookCatalogMeta row.
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

import redis.asyncio as aioredis

from app.config import settings
from app.database import SessionLocal
from app.integrations import kavita, plex_player
from app.models import Book, BookAudioEdition, BookCatalogMeta, BookPairOverride
from app.services.notification_poller import LeaderLease

logger = logging.getLogger(__name__)

LOCK_KEY = "books:catalog:rebuild"
# Far longer than a rebuild takes (one read of each source and one short
# write); it only bounds how long the catalog stays unbuilt if a worker dies
# mid-rebuild.
LOCK_TTL = 10 * 60

REBUILD_INTERVAL = 900

ACTIONS = ("pair", "apart")

_FIELD_LIMITS = (("title", 300), ("sort_title", 300), ("author", 200), ("series", 200), ("description", None))
_COLUMNS = ("work_key", "title", "sort_title", "author", "series", "series_number", "description",
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


_NUMBER = r"(?:(?:book|vol(?:ume)?\.?|#)\s*)?#?\d+"


def _pairing_title(title: str, series: str) -> str:
    """The title the ebook's work key is made from. Kavita's titles carry the
    series in ways an audiobook's title does not: a leading "<series> 02 - " or
    "<series> Book 2: ", and a trailing ": <series>" or "(<series> #2)". They
    come off here (never from the title shown), so "Harry Potter 02 - Harry
    Potter and the Chamber of Secrets" and "A Storm of Swords: A Song of Ice
    and Fire" are the titles the audiobooks have. Nothing is taken off a book
    that is not in a series, or if nothing would be left."""
    if not series:
        return title
    name = re.escape(series.strip())
    patterns = (
        rf"^\s*{name}\s*,?\s*{_NUMBER}\s*[-:–—]\s*",
        rf"\s*[:\-–—]\s*{name}\s*$",
        rf"\s*[\(\[]\s*(?:the\s+)?{name}(?:\s+series)?\s*,?\s*(?:{_NUMBER})?\s*[\)\]]\s*$",
    )
    for pattern in patterns:
        stripped = re.sub(pattern, "", title, count=1, flags=re.IGNORECASE)
        if stripped.strip():
            title = stripped
    return title


def _ebook_item(book: dict, known_series: tuple = ()) -> _Item:
    """`known_series`: the series names Kavita has for other books. A book Kavita
    keeps as a series of its own ("Harry Potter 03 - Harry Potter and ...")
    names no series, but the title may start with one that its neighbours have."""
    key = None
    if book["author"] and book["title"]:
        try:
            title = book["title"]
            for series in ([book["series"]] if book["series"] else known_series):
                title = _pairing_title(title, series)
            key = plex_player.work_key(book["author"], title)
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

def _effective_pairs(overrides: list) -> Dict[str, int]:
    """{plex_book_key: kavita_chapter_id} for the `pair` overrides. An edition
    is in at most one: where two overrides name the same edition, the newer
    wins. (An ebook may be named by several: it takes each edition named.)"""
    pairs: Dict[str, int] = {}
    for o in sorted((o for o in overrides if o.action == "pair"), key=lambda o: (o.created_at, o.id)):
        pairs[o.plex_book_key] = o.kavita_chapter_id
    return pairs


def _groups(ebooks: Dict[int, _Item], editions: Dict[str, _Item], overrides: list) -> List[tuple]:
    """Every book as (ebook or None, [audiobook editions]).

    An ebook takes every edition an override pairs with it, and every edition
    with its work key when it is the only ebook with that key (two ebooks of
    one key are too uncertain: their editions stay apart from both). An edition
    an override names never joins by key, and an `apart` override keeps one
    edition out of one ebook's book. Editions left over that share a work key
    are one book of several editions; the rest are a book each."""
    pairs = _effective_pairs(overrides)
    apart = {(o.kavita_chapter_id, o.plex_book_key) for o in overrides if o.action == "apart"}
    members: Dict[int, List[str]] = {cid: [] for cid in ebooks}
    placed = set()
    for plex_key, chapter_id in pairs.items():
        if chapter_id in ebooks and plex_key in editions:
            members[chapter_id].append(plex_key)
            placed.add(plex_key)
    ebooks_by_key: Dict[str, List[int]] = {}
    for item in ebooks.values():
        if item.key:
            ebooks_by_key.setdefault(item.key, []).append(item.id)
    for item in editions.values():
        owners = ebooks_by_key.get(item.key, []) if item.key and item.id not in pairs else []
        if len(owners) == 1 and (owners[0], item.id) not in apart:
            members[owners[0]].append(item.id)
            placed.add(item.id)
    groups: List[tuple] = [(ebooks[cid], [editions[k] for k in sorted(set(members[cid]))]) for cid in sorted(ebooks)]
    alone: Dict[str, List[_Item]] = {}
    for item in editions.values():
        if item.id in placed:
            continue
        if item.key:
            alone.setdefault(item.key, []).append(item)
        else:
            groups.append((None, [item]))
    groups += [(None, sorted(items, key=lambda i: i.id)) for items in alone.values()]
    return groups


# --- Writing the catalog ------------------------------------------------------------

def _new_book(db, now: datetime) -> Book:
    book = Book(title="", sort_title="", author="", series="", description="",
                cover_source="plex", updated_at=now)
    db.add(book)
    db.flush()      # the id is needed to point ghosts at it
    return book


def _edition_date(item: _Item, stored: Dict[str, BookAudioEdition]) -> Optional[datetime]:
    if item.fields is not None:
        return item.fields.get("added_at")
    held = stored.get(item.id)
    return held.added_at if held else None


def _fill(book: Book, ebook: Optional[_Item], editions: List[_Item], stored: Dict[str, BookAudioEdition],
          now: datetime, fresh_row: bool) -> None:
    """Set the book's columns from its items. The primary edition's text wins,
    then the other editions', then the ebook's. A stale item (its source
    failed) stands as the row has it."""
    before = {c: getattr(book, c) for c in _COLUMNS}
    ordered = sorted(editions, key=lambda i: (_edition_date(i, stored) is None, _edition_date(i, stored), str(i.id)))
    primary = ordered[0] if ordered else None
    items = ordered + ([ebook] if ebook else [])

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

    book.work_key = (primary or ebook).key
    book.kavita_chapter_id = ebook.id if ebook else None
    book.plex_book_key = primary.id if primary else None
    if ebook and ebook.fields is not None:
        book.kavita_library_id = ebook.fields.get("library_id")
        book.kavita_series_id = ebook.fields.get("series_id")
        book.kavita_volume_id = ebook.fields.get("volume_id")
    elif not ebook:
        book.kavita_library_id = book.kavita_series_id = book.kavita_volume_id = None
    if not ebook:
        book.ebook_added_at = None
    elif ebook.fields is not None:
        book.ebook_added_at = ebook.fields.get("added_at")
    audio_dates = [d for d in (_edition_date(i, stored) for i in ordered) if d is not None]
    book.audio_added_at = min(audio_dates) if audio_dates else None
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
        live_by_id = {r.id: r for r in live}
        ghosts = [r for r in rows if r.merged_into is not None]
        stored = {e.plex_book_key: e for e in db.query(BookAudioEdition).order_by(BookAudioEdition.id)}
        live_by_k: Dict[int, Book] = {}
        for r in live:
            if r.kavita_chapter_id is not None:
                live_by_k.setdefault(r.kavita_chapter_id, r)
        held_by: Dict[str, Book] = {k: live_by_id[e.book_id] for k, e in stored.items() if e.book_id in live_by_id}

        # A source that failed stands as its live rows have it.
        if ebooks is not None:
            names = tuple(sorted({b["series"] for b in ebooks if b["series"]}, key=lambda n: (-len(n), n)))
            e_items = {i.id: i for i in (_ebook_item(b, names) for b in ebooks)}
        else:
            e_items = {k: _Item("k", k, r.work_key, None) for k, r in live_by_k.items()}
        if audiobooks is not None:
            a_items = {i.id: i for i in map(_audiobook_item, audiobooks)}
        else:
            a_items = {k: _Item("p", k, r.work_key, None) for k, r in held_by.items()}

        groups = _groups(e_items, a_items, db.query(BookPairOverride).order_by(BookPairOverride.id).all())
        # Books with the most editions pick their row first, then those with an
        # ebook: a split leaves the row with the larger side.
        groups.sort(key=lambda g: (-len(g[1]), g[0] is None, str(g[1][0].id) if g[1] else "",
                                   str(g[0].id) if g[0] else ""))

        used: set = set()
        assigned: List[tuple] = []
        fresh: set = set()
        home: Dict[tuple, Book] = {}          # ("k", chapter id) or ("p", plex key) -> the book it is in now

        def revive(match) -> Optional[Book]:
            ghost = next((g for g in ghosts if match(g)), None)
            if ghost is not None:
                ghosts.remove(ghost)
                ghost.merged_into = None
            return ghost

        for ebook, editions in groups:
            keys = {i.id for i in editions}
            row = None
            if editions:
                held = sorted({held_by[k] for k in keys if k in held_by}, key=lambda r: r.id)
                row = next((r for r in held if r.id not in used), None)
                if row is None and ebook is not None:
                    # An ebook's row that already had audio is the book's row even
                    # if its editions changed; one that was only an ebook is not.
                    own = live_by_k.get(ebook.id)
                    if own is not None and own.id not in used and own.plex_book_key is not None:
                        row = own
                if row is None:
                    row = revive(lambda g: g.plex_book_key in keys)
            else:
                own = live_by_k.get(ebook.id)
                if own is not None and own.id not in used:
                    row = own
                else:
                    # The ebook has left an audiobook's book (a split) or has none:
                    # its earlier row comes back, else it is a new book.
                    row = (revive(lambda g: g.kavita_chapter_id == ebook.id and own is not None
                                  and g.merged_into == own.id)
                           or revive(lambda g: g.kavita_chapter_id == ebook.id))
            if row is None:
                row = _new_book(db, now)
                fresh.add(row.id)
            used.add(row.id)
            assigned.append((ebook, editions, row))
            if ebook is not None:
                home[("k", ebook.id)] = row
            for i in editions:
                home[("p", i.id)] = row

        # A live row no book took is gone, or its items moved to another book
        # and it stays behind as a ghost of it.
        for r in live:
            if r.id in used:
                continue
            items = [("k", r.kavita_chapter_id)] + [("p", k) for k, e in stored.items() if e.book_id == r.id]
            target = next((home[i] for i in items if i in home), None)
            if target is not None:
                r.merged_into = target.id
                ghosts.append(r)
            else:
                db.delete(r)
        for g in ghosts:
            # A ghost follows its items to where they are now.
            target = home.get(("k", g.kavita_chapter_id)) or home.get(("p", g.plex_book_key))
            if target is not None and target.id != g.id:
                g.merged_into = target.id

        # Editions: each key is in exactly one book, the one it is paired into.
        wanted = {i.id: (row, i) for _, editions, row in assigned for i in editions}
        for key, edition in stored.items():
            if key not in wanted:
                db.delete(edition)
        for key, (row, item) in wanted.items():
            edition = stored.get(key)
            if edition is None:
                edition = BookAudioEdition(plex_book_key=key, narrator="")
                db.add(edition)
                stored[key] = edition
            edition.book_id = row.id
            if item.fields is not None:
                edition.narrator = str(item.fields.get("narrator") or "")[:200]
                edition.added_at = item.fields.get("added_at")

        for ebook, editions, row in assigned:
            _fill(row, ebook, editions, stored, now, row.id in fresh)
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
    """Record the admin's decision about one Kavita book (its chapter id) and
    one audiobook edition. A new `pair` for an edition replaces that edition's
    earlier pair (an ebook may take several editions). The change shows at the
    next rebuild."""
    if action not in ACTIONS:
        raise ValueError("action must be 'pair' or 'apart'")
    if action == "pair":
        for old in db.query(BookPairOverride).filter(BookPairOverride.action == "pair",
                                                     BookPairOverride.plex_book_key == plex_book_key).all():
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
