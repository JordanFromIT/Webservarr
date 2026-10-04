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
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

from sqlalchemy import exists

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
_COLUMNS = ("work_key", "ebook_work_key", "title", "sort_title", "author", "series", "series_number", "description",
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


def _groups_in_outage(ebooks: Dict[int, _Item], editions: Dict[str, _Item], overrides: list, live: list,
                      stored: Dict[str, BookAudioEdition], ebooks_stale: bool) -> List[tuple]:
    """The books while one source could not be read. What that source gave is
    held as stored, so nothing it holds may move: every book that holds an item
    of the failed side stays exactly as it is (with the items of the other
    side that are still there), whatever the keys or the overrides now say.
    That is also why a rebuild repeated through the outage changes nothing for
    the failed side. Only items outside those books are paired afresh; the new
    pairings reach the held items when the source is back."""
    keys_of: Dict[int, List[str]] = {}
    for key, edition in stored.items():
        keys_of.setdefault(edition.book_id, []).append(key)
    groups: List[tuple] = []
    taken_e, taken_a = set(), set()
    for row in live:
        held_editions = [k for k in sorted(keys_of.get(row.id, [])) if k in editions]
        has_stale = row.kavita_chapter_id is not None if ebooks_stale else bool(keys_of.get(row.id))
        if not has_stale:
            continue
        ebook = ebooks.get(row.kavita_chapter_id) if row.kavita_chapter_id is not None else None
        groups.append((ebook, [editions[k] for k in held_editions]))
        if ebook is not None:
            taken_e.add(ebook.id)
        taken_a.update(held_editions)
    rest = _groups({k: v for k, v in ebooks.items() if k not in taken_e},
                   {k: v for k, v in editions.items() if k not in taken_a}, overrides)
    return groups + rest


# --- Writing the catalog ------------------------------------------------------------

def _new_book(db, now: datetime) -> Book:
    from app.services import book_personal
    # Never an id a person's list, queue or rating still names (a book that
    # left the catalog): their row would turn up on a different book.
    book = Book(id=book_personal.next_book_id(db), title="", sort_title="", author="", series="",
                description="", cover_source="plex", updated_at=now)
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
    # The primary edition is the row's identity, so it stays while it is there;
    # otherwise the earliest added.
    primary = next((i for i in ordered if i.id == book.plex_book_key), ordered[0] if ordered else None)
    ordered = ([primary] + [i for i in ordered if i is not primary]) if primary else []
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
    book.ebook_work_key = ebook.key if ebook else None
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

        # A source that failed stands as its live rows have it, each item with
        # its own work key.
        if ebooks is not None:
            names = tuple(sorted({b["series"] for b in ebooks if b["series"]}, key=lambda n: (-len(n), n)))
            e_items = {i.id: i for i in (_ebook_item(b, names) for b in ebooks)}
        else:
            e_items = {k: _Item("k", k, r.ebook_work_key, None) for k, r in live_by_k.items()}
        if audiobooks is not None:
            a_items = {i.id: i for i in map(_audiobook_item, audiobooks)}
        else:
            a_items = {k: _Item("p", k, stored[k].work_key, None) for k in held_by}

        overrides = db.query(BookPairOverride).order_by(BookPairOverride.id).all()
        if (ebooks is None) != (audiobooks is None):
            groups = _groups_in_outage(e_items, a_items, overrides, live, stored, ebooks is None)
        else:
            groups = _groups(e_items, a_items, overrides)

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

        # A row goes first to the book that holds what the row is: its primary
        # edition, else its ebook. So when a book splits, each side keeps the
        # row of the work it is, and an old id never opens a different work.
        owner: Dict[tuple, int] = {}
        for n, (ebook, editions) in enumerate(groups):
            if ebook is not None:
                owner[("k", ebook.id)] = n
            for i in editions:
                owner[("p", i.id)] = n
        row_of: Dict[int, Book] = {}
        # A row that was only an ebook does not become a book with audio: when an
        # edition joins its ebook, the edition's row (or a new one) is the book's
        # and this one stays behind as a ghost of it, so an id never changes
        # from the ebook it was made for to an audiobook, or back.
        for which in (0, 1):                  # every row's edition first, then the ebook of those left
            for r in live:
                item = (("p", r.plex_book_key), ("k", r.kavita_chapter_id))[which]
                n = owner.get(item) if item[1] is not None and r.id not in used else None
                if n is not None and which == 1 and r.plex_book_key is None and groups[n][1]:
                    n = None
                if n is not None and n not in row_of:
                    row_of[n] = r
                    used.add(r.id)

        # Then, books with the most editions first, then those with an ebook.
        order = sorted(range(len(groups)), key=lambda n: (
            -len(groups[n][1]), groups[n][0] is None, str(groups[n][1][0].id) if groups[n][1] else "",
            str(groups[n][0].id) if groups[n][0] else ""))
        for n in order:
            ebook, editions = groups[n]
            keys = {i.id for i in editions}
            row = row_of.get(n)
            if row is None and editions:
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
            elif row is None:
                own = live_by_k.get(ebook.id)
                if own is not None and own.id not in used:
                    row = own
                else:
                    # The ebook has left an audiobook's book (a split) or has none:
                    # its earlier row comes back, else it is a new book.
                    # (A ghost that was an audiobook's row is its edition's, not the ebook's,
                    # while that edition is still there.)
                    def was_ebook(g):
                        return g.kavita_chapter_id == ebook.id and g.plex_book_key not in a_items
                    row = (revive(lambda g: was_ebook(g) and own is not None and g.merged_into == own.id)
                           or revive(was_ebook))
            if row is None:
                row = _new_book(db, now)
                fresh.add(row.id)
            row_of[n] = row
            used.add(row.id)
        for n, (ebook, editions) in enumerate(groups):
            row = row_of[n]
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
            items = ([("p", r.plex_book_key)] + [("p", k) for k, e in stored.items() if e.book_id == r.id]
                     + [("k", r.kavita_chapter_id)])
            target = next((home[i] for i in items if i in home), None)
            if target is not None:
                r.merged_into = target.id
                ghosts.append(r)
            else:
                db.delete(r)
        for g in ghosts:
            # A ghost follows its items to where they are now.
            target = home.get(("p", g.plex_book_key)) or home.get(("k", g.kavita_chapter_id))
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
                edition.work_key = item.key
                edition.added_at = item.fields.get("added_at")

        for ebook, editions, row in assigned:
            _fill(row, ebook, editions, stored, now, row.id in fresh)
        db.flush()

        # Every ghost points at a live book, not at another ghost; one whose
        # book is gone goes with it.
        ghost_rows = {g.id: g for g in db.query(Book).filter(Book.merged_into.isnot(None)).all()}
        merged: Dict[int, int] = {}
        for g in ghost_rows.values():
            target, hops = g.merged_into, 0
            while target in ghost_rows and hops < 50:
                target, hops = ghost_rows[target].merged_into, hops + 1
            if target not in used:
                db.delete(g)
            else:
                g.merged_into = target
                merged[g.id] = target
        db.flush()

        # What people keep about a merged book moves with it, in this
        # transaction (a deleted ghost's rows stay, hidden, with its id).
        from app.services import book_personal
        book_personal.follow_merges(db, merged)

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
            result = await _run(reason)
            # New books in followed series are announced under the same lock,
            # so two rebuilds never announce at once. It never fails the rebuild.
            from app.services import book_discovery
            try:
                await book_discovery.announce(SessionLocal, rebuild_ok=result["ok"])
            except Exception as exc:  # noqa: BLE001 - a notification problem is not a catalog problem
                logger.warning("New books could not be announced: %s", type(exc).__name__)
            return result
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


# --- Reading the catalog (the Books APIs) ------------------------------------------------
#
# These take the database session and what the caller may see, and touch
# nothing per person: progress is the router's. A caller sees a book's ebook
# only in a Kavita series their own account may see (`series_ids`), and its
# audiobook editions only when the player lets them (`audio`). A book that
# shows neither is not theirs to see.

_QUOTES = str.maketrans({"\u2019": "'", "\u2018": "'", "\u201c": '"', "\u201d": '"'})
MAX_GHOST_HOPS = 5


# Letters that are not an accented form of another (NFKD leaves them whole),
# folded to what a reader types.
_LETTERS = str.maketrans({"\u00f8": "o", "\u0142": "l", "\u00e6": "ae", "\u0153": "oe", "\u00df": "ss",
                          "\u0111": "d", "\u00fe": "th", "\u00f0": "d", "\u0131": "i"})


def fold(text) -> str:
    """Text for matching: no accents, no case, typographic quotes made plain,
    spaces collapsed, and letters like \u00f8, \u0142, \u00e6 and \u00df written as plain ones. "Bront\u00eb"
    and "bronte" fold alike, as do "Str\u00f8m" and "strom"."""
    plain = unicodedata.normalize("NFKD", str(text or "").translate(_QUOTES))
    plain = "".join(ch for ch in plain if not unicodedata.combining(ch))
    return " ".join(plain.casefold().translate(_LETTERS).split())


def name_key(text) -> str:
    """A person's or series' name for finding its page: case and spacing
    ignored, accents kept ("Jose" and "Jos\u00e9" are different people)."""
    return " ".join(unicodedata.normalize("NFC", str(text or "")).casefold().split())


@dataclass(frozen=True)
class CatalogRow:
    """One live book as the caller may see it: `ebook` and `audio` are the
    formats they can reach (a book is only a row here when one is)."""
    id: int
    title: str
    sort_title: str
    author: str
    series: str
    series_number: Optional[float]
    added_at: Optional[datetime]
    updated_at: datetime
    kavita_chapter_id: Optional[int]
    kavita_series_id: Optional[int]
    plex_book_key: Optional[str]
    cover_source: str
    kavita_volume_id: Optional[int]
    ebook: bool
    audio: bool

    @property
    def formats(self) -> List[str]:
        return (["ebook"] if self.ebook else []) + (["audio"] if self.audio else [])


def visible_rows(db, series_ids: Iterable[int], audio: bool) -> List[CatalogRow]:
    """Every live book the caller can see, with the formats they can reach.
    `series_ids` are the Kavita series their own account may see (none: no
    ebooks), `audio` whether the player lets them in."""
    reach = set(series_ids)
    has_editions = exists().where(BookAudioEdition.book_id == Book.id)
    rows = (db.query(Book.id, Book.title, Book.sort_title, Book.author, Book.series, Book.series_number,
                     Book.added_at, Book.updated_at, Book.kavita_chapter_id, Book.kavita_series_id,
                     Book.kavita_volume_id, Book.plex_book_key, Book.cover_source, has_editions.label("editions"))
            .filter(Book.merged_into.is_(None)).all())
    out = []
    for (book_id, title, sort_title, author, series, number, added, updated, chapter, series_id, volume,
         plex_key, cover, editions) in rows:
        ebook = chapter is not None and series_id in reach
        heard = bool(editions) and audio
        if ebook or heard:
            out.append(CatalogRow(book_id, title, sort_title or title, author or "", series or "", number, added,
                                  updated, chapter, series_id, plex_key, cover, volume, ebook, heard))
    return out


def all_rows(db) -> List[CatalogRow]:
    """Every live book with every format it has, whoever is asking. Only for
    deciding why a lookup found nothing (a source that cannot be reached, or
    that the person is not connected to); never shown to anyone."""
    series_ids = {sid for (sid,) in db.query(Book.kavita_series_id).filter(Book.kavita_series_id.isnot(None))}
    return visible_rows(db, series_ids, True)


def narrators_by_book(db) -> Dict[int, List[str]]:
    """{book id: its editions' narrators, the primary edition's first}."""
    found: Dict[int, List[str]] = {}
    for book_id, narrator in (db.query(BookAudioEdition.book_id, BookAudioEdition.narrator)
                              .order_by(BookAudioEdition.added_at.is_(None), BookAudioEdition.added_at,
                                        BookAudioEdition.plex_book_key)):
        names = found.setdefault(book_id, [])
        if narrator and narrator not in names:
            names.append(narrator)
    return found


def resolve_book(db, book_id: int) -> Tuple[Optional[Book], Optional[int]]:
    """(the live book, None) for a live id; (None, the surviving id) for an id
    that was merged into another book; (None, None) for an unknown id, or a
    chain of ghosts that never reaches a live book."""
    row = db.get(Book, book_id)
    if row is None:
        return None, None
    if row.merged_into is None:
        return row, None
    for _hop in range(MAX_GHOST_HOPS):
        row = db.get(Book, row.merged_into)
        if row is None:
            return None, None
        if row.merged_into is None:
            return None, row.id
    return None, None


def editions_of(db, book: Book) -> List[BookAudioEdition]:
    """The book's audiobook editions, its primary edition first, then by when
    they were added."""
    rows = (db.query(BookAudioEdition).filter(BookAudioEdition.book_id == book.id)
            .order_by(BookAudioEdition.added_at.is_(None), BookAudioEdition.added_at,
                      BookAudioEdition.plex_book_key).all())
    return sorted(rows, key=lambda e: e.plex_book_key != book.plex_book_key)


def live_editions(db, keys: Optional[Iterable[str]] = None) -> Dict[str, Tuple[int, str]]:
    """{Plex book key: (the live book it is in, its narrator)}; limited to
    `keys` when given."""
    q = (db.query(BookAudioEdition.plex_book_key, BookAudioEdition.book_id, BookAudioEdition.narrator)
         .join(Book, Book.id == BookAudioEdition.book_id).filter(Book.merged_into.is_(None)))
    if keys is not None:
        wanted = list(keys)
        found: Dict[str, Tuple[int, str]] = {}
        for start in range(0, len(wanted), 400):
            for key, book_id, narrator in q.filter(BookAudioEdition.plex_book_key.in_(wanted[start:start + 400])):
                found[key] = (book_id, narrator or "")
        return found
    return {key: (book_id, narrator or "") for key, book_id, narrator in q}


def ebooks_in_series(db, series_ids: Iterable[int], visible: Iterable[int]) -> List[Book]:
    """The live books with an ebook in these Kavita series, among the series
    the caller may see (`visible`)."""
    seen = set(visible)
    wanted = [s for s in dict.fromkeys(series_ids) if s in seen]
    books: List[Book] = []
    for start in range(0, len(wanted), 400):
        books += (db.query(Book).filter(Book.merged_into.is_(None), Book.kavita_chapter_id.isnot(None),
                                        Book.kavita_series_id.in_(wanted[start:start + 400])).all())
    return sorted(books, key=lambda b: b.id)


def unpaired(db, limit: int = 1000) -> dict:
    """For the admin's Books panel, whole (no caller is filtering): the ebooks
    that have no audiobook and the audiobook editions in books that have no
    ebook. {"ebooks": [{book_id, kavita_chapter_id, title, author, series}],
    "audiobooks": [{book_id, plex_book_key, narrator, title, author, series}]},
    each at most `limit`, by title."""
    ebooks = [{"book_id": b.id, "kavita_chapter_id": b.kavita_chapter_id, "title": b.title,
               "author": b.author, "series": b.series}
              for b in (db.query(Book).filter(Book.merged_into.is_(None), Book.kavita_chapter_id.isnot(None),
                                              ~exists().where(BookAudioEdition.book_id == Book.id))
                        .order_by(Book.sort_title, Book.id).limit(limit))]
    audiobooks = [{"book_id": b.id, "plex_book_key": e.plex_book_key, "narrator": e.narrator or "",
                   "title": b.title, "author": b.author, "series": b.series}
                  for e, b in (db.query(BookAudioEdition, Book).join(Book, Book.id == BookAudioEdition.book_id)
                               .filter(Book.merged_into.is_(None), Book.kavita_chapter_id.is_(None))
                               .order_by(Book.sort_title, BookAudioEdition.plex_book_key).limit(limit))]
    return {"ebooks": ebooks, "audiobooks": audiobooks}


def paired(db, limit: int = 1000) -> dict:
    """For the admin's Books panel: the books that are an ebook and one or more
    audiobook editions together, so one edition can be kept apart from the
    ebook. {"books": [{book_id, kavita_chapter_id, title, author, series,
    editions: [{plex_book_key, narrator}]}]}, at most `limit`, by title; the
    editions are in key order."""
    rows = (db.query(Book).filter(Book.merged_into.is_(None), Book.kavita_chapter_id.isnot(None),
                                  exists().where(BookAudioEdition.book_id == Book.id))
            .order_by(Book.sort_title, Book.id).limit(limit).all())
    ids = [b.id for b in rows]
    editions: Dict[int, List[dict]] = {}
    if ids:
        for e in (db.query(BookAudioEdition).filter(BookAudioEdition.book_id.in_(ids))
                  .order_by(BookAudioEdition.plex_book_key)):
            editions.setdefault(e.book_id, []).append({"plex_book_key": e.plex_book_key, "narrator": e.narrator or ""})
    return {"books": [{"book_id": b.id, "kavita_chapter_id": b.kavita_chapter_id, "title": b.title,
                       "author": b.author, "series": b.series, "editions": editions.get(b.id, [])}
                      for b in rows]}


def overrides(db) -> List[dict]:
    """Every pairing override, newest first, with the titles of the ebook and
    the edition's book when the catalog still knows them (null when not)."""
    rows = db.query(BookPairOverride).order_by(BookPairOverride.created_at.desc(), BookPairOverride.id.desc()).all()
    ebook_titles = {}
    for chapter, title in (db.query(Book.kavita_chapter_id, Book.title).filter(
            Book.merged_into.is_(None), Book.kavita_chapter_id.isnot(None))):
        ebook_titles[chapter] = title
    audio_titles = {key: title for key, title in (
        db.query(BookAudioEdition.plex_book_key, Book.title).join(Book, Book.id == BookAudioEdition.book_id)
        .filter(Book.merged_into.is_(None)))}
    return [{"kavita_chapter_id": r.kavita_chapter_id, "plex_book_key": r.plex_book_key, "action": r.action,
             "created_by": r.created_by, "created_at": r.created_at,
             "ebook_title": ebook_titles.get(r.kavita_chapter_id), "audio_title": audio_titles.get(r.plex_book_key)}
            for r in rows]


def knows_ebook(db, kavita_chapter_id: int) -> bool:
    return db.query(Book.id).filter(Book.kavita_chapter_id == kavita_chapter_id).first() is not None


def knows_edition(db, plex_book_key: str) -> bool:
    return db.query(BookAudioEdition.id).filter(BookAudioEdition.plex_book_key == plex_book_key).first() is not None
