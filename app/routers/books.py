"""
The Books APIs (/api/books, and the admin's /api/admin/books).

The catalog (app/services/book_catalog.py) is shared; what a person may see
of it, and where they are in a book, is theirs. Every route needs a session
(401 without one). Errors are 4xx or 503, never 500.

What a caller may see (spec section 8):
- An ebook only in a Kavita library their own account reaches, read with their
  own Kavita token (the one the OIDC hand-off keeps in their session). When
  that cannot be read (no token, an expired one, Kavita down, eBooks switched
  off) they see no ebooks, never all of them. A note says why when it is worth
  telling them.
- An audiobook only when the player lets them in: a Plex identity and a Plex
  share that includes the audiobook library (plex_player.library_access, the
  check the player routes make). Not being able to confirm it hides audio too.
A book with neither format is not theirs to see: 404 for the book, absent from
every list, search, person and series page, and Continue.

Per-person data is never stored in the catalog. An audiobook place is read
from the player's own position store (app/services/listening.py) by the
caller's identity; an ebook place from Kavita with their token.

Rate limits are per session, as the player's are.
"""

import asyncio
import base64
import binascii
import calendar
import functools
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Dict, List, Literal, Optional, Tuple
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, HTTPException, Path, Query, Request, status
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user, require_admin
from app.integrations import kavita
from app.integrations import plex_player as pp
from app.integrations.config import same_address
from app.limiter import limiter
from app.routers import kavita_proxy
from app.routers.player import Text, require_encodable_body, require_same_origin, session_rate_key
from app.routers.tickets import account_identity
from app.services import book_catalog, book_discovery, book_personal, listening
from app.services.book_catalog import CatalogRow
from app.utils import utc_iso

logger = logging.getLogger(__name__)

router = APIRouter()
admin_router = APIRouter()

LIST_LIMIT = "120/minute"
COVER_LIMIT = "240/minute"
ADMIN_LIMIT = "60/minute"
REBUILD_LIMIT = "6/minute"

MAX_ID = 2 ** 31 - 1            # a database id; anything larger cannot be one
PAGE_DEFAULT = 30
PAGE_MAX = 60
SEARCH_DEFAULT = 30
CONTINUE_MAX = 12
PERSON_MAX = 500                # books on one person's or series' page
SERIES_MIN_BOOKS = 2            # a series of one book is shown as that book
COVER_MAX_AGE = 24 * 60 * 60
CURSOR_MAX = 4096                # a key holds a title, an author and a series name
NAME_MAX = 200

EBOOKS_DOWN = "Ebooks are unavailable right now"
EBOOKS_NOT_CONNECTED = "Connect to your ebook library to see ebooks"
AUDIO_DOWN = "Audiobooks are unavailable right now"
DB_DOWN = "The library is unavailable right now. Try again in a moment."

BookId = Annotated[int, Path(ge=1, le=MAX_ID)]


def _limit(rate: str, route: str):
    """One budget per session for the route, whatever the path carries."""
    return limiter.shared_limit(rate, scope=f"books:{route}", key_func=session_rate_key)


def _db_503(route):
    """A route that answers 503, not 500, when the database cannot be read (a
    locked or unreachable file): the Books pages show "try again", they never
    crash. Innermost decorator, so the limiter and FastAPI still see the route's
    own signature."""
    @functools.wraps(route)
    async def guarded(*args, **kwargs):
        try:
            return await route(*args, **kwargs)
        except SQLAlchemyError as exc:
            logger.warning("The Books catalog could not be read: %s", type(exc).__name__)
            raise HTTPException(status_code=503, detail=DB_DOWN) from None
    return guarded


# --- What the caller may see ------------------------------------------------------------

@dataclass
class Scope:
    """What one caller can reach right now. `series`: the Kavita series their
    own account may see, libraries and age restriction both applied by Kavita
    (empty: no ebooks); `kavita`: the address and
    token to read their progress with, when they are readable; `audio`:
    whether the player lets them in; `identity`: theirs, for the position
    store; `notes`: what to tell them about a source that is not working."""
    identity: str
    series: set = field(default_factory=set)
    kavita: Optional[Tuple[str, str]] = None
    audio: bool = False
    notes: List[dict] = field(default_factory=list)


def _note(source: str, reason: str, text: str) -> dict:
    return {"source": source, "reason": reason, "text": text}


def _blocked_answer(who: "Scope", rows) -> Optional[JSONResponse]:
    """The 404 for a lookup that found nothing the caller can see, when the
    reason is a source they cannot reach rather than something they may not
    see: {"detail", "reason": "not_connected" | "unavailable", "notes": [note]}.

    `rows` are the catalog rows the lookup matched, whoever may see them. It is
    only given when one of them has a format whose source is the problem (an
    ebook and Kavita not connected or not answering, an audiobook and Plex not
    answering), so a lookup that matches nothing, or whose cause is the
    caller's own lack of access, stays a plain 404. Nothing about the rows is
    in the answer (it fails closed): the page says what to do, not what is there."""
    wants_ebook = any(r.kavita_chapter_id is not None for r in rows)
    wants_audio = any(r.audio for r in rows)
    for note in who.notes:
        if (note["source"] == "kavita" and wants_ebook) or (note["source"] == "plex" and wants_audio):
            return JSONResponse(status_code=404, content={"detail": note["text"], "reason": note["reason"],
                                                          "notes": [note]})
    return None


async def _kavita_reach(user: dict) -> Tuple[set, Optional[Tuple[str, str]], Optional[dict]]:
    """(series ids, (address, token), note) for this person's own Kavita account.
    Nothing readable is no series, never all of them."""
    try:
        base = kavita_proxy.kavita_url_for(user)
    except HTTPException:
        base = None                  # eBooks is switched off for members
    if not base:
        return set(), None, None
    token = user.get("kavita_token") or ""
    if not token or not same_address(user.get("kavita_base"), base):
        return set(), None, _note("kavita", "not_connected", EBOOKS_NOT_CONNECTED)
    try:
        series_ids = await kavita.user_series_ids(base, token)
    except kavita.KavitaTokenRefused:
        return set(), None, _note("kavita", "not_connected", EBOOKS_NOT_CONNECTED)
    except kavita.KavitaUnavailable:
        return set(), None, _note("kavita", "unavailable", EBOOKS_DOWN)
    return series_ids, (base, token), None


async def _audio_reach(user: dict, identity: str, session_id: Optional[str]) -> Tuple[bool, Optional[dict]]:
    """(whether the player lets this person in, a note). The player's own rule:
    a Plex identity whose share includes the audiobook library."""
    if not pp.player_on() or not identity.startswith("plex:"):
        return False, None
    try:
        await pp.library_access(dict(user), session_id=session_id)
    except pp.NoServerAccess:
        return False, None           # theirs to lack: nothing to tell them
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        logger.info("Audiobook access could not be confirmed: %s", type(exc).__name__)
        return False, _note("plex", "unavailable", AUDIO_DOWN)
    return True, None


async def scope_of(user: dict, session_id: Optional[str]) -> Scope:
    identity = account_identity(user)
    (series_ids, reach, kavita_note), (audio, plex_note) = await asyncio.gather(
        _kavita_reach(user), _audio_reach(user, identity, session_id))
    notes = [n for n in (kavita_note, plex_note) if n]
    return Scope(identity=identity, series=series_ids, kavita=reach, audio=audio, notes=notes)


async def caller(user: dict = Depends(get_current_user),
                 session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name)) -> Scope:
    try:
        return await scope_of(user, session_id)
    except SQLAlchemyError as exc:           # the settings read that finds Kavita's address and the player's library
        logger.warning("The Books settings could not be read: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail=DB_DOWN) from None


# --- Cards ------------------------------------------------------------------------------

def _timestamp(value: Optional[datetime]) -> int:
    """Epoch seconds of a naive UTC time (0 for none). Not datetime.timestamp(),
    which reads a naive time as local and fails for a year-1 date Kavita can
    hold."""
    return calendar.timegm(value.utctimetuple()) if value else 0


def _cover_url(row_id: int, updated_at: Optional[datetime]) -> str:
    return f"/api/books/{row_id}/cover?v={_timestamp(updated_at)}"


def _book_card(row: CatalogRow, in_series: bool = False) -> dict:
    """A book's card. `in_series` adds its series and number in it (a list
    that shows every book on its own, so the card can say "Dune #2")."""
    card = {"kind": "book", "id": row.id, "title": row.title, "author": row.author,
            "cover_url": _cover_url(row.id, row.updated_at), "formats": row.formats}
    if in_series:
        card["series"] = row.series or ""
        card["series_number"] = row.series_number
    return card


def _formats_of(rows: List[CatalogRow]) -> List[str]:
    return [f for f in ("ebook", "audio") if any(f in r.formats for r in rows)]


def _reading_order(row: CatalogRow) -> tuple:
    """A series' reading order: by number, books without one last."""
    return (row.series_number is None, row.series_number or 0, book_catalog.fold(row.sort_title), row.id)


def _series_card(members: List[CatalogRow]) -> dict:
    ordered = sorted(members, key=_reading_order)
    authors = {book_catalog.name_key(m.author) for m in ordered if m.author}
    return {"kind": "series", "series": ordered[0].series, "count": len(ordered), "cover_book_id": ordered[0].id,
            "cover_url": _cover_url(ordered[0].id, ordered[0].updated_at),
            "author": ordered[0].author if len(authors) == 1 else "", "formats": _formats_of(ordered)}


# The order a grid is paged in. A cursor is the sort key of the last card sent,
# so a page is "the cards after this one" and stays right when a rebuild adds
# or removes books between two requests (an offset would not).
SORTS = ("added", "title", "author")


def _author_sort(author: str) -> str:
    """What the Author sort orders by: the surname, as a shelf does. "Last,
    First" gives what is before the comma; otherwise the last word ("Frank
    Herbert" is "herbert"); the whole name breaks a tie."""
    name = book_catalog.fold(author)
    surname = name.split(",")[0].strip() if "," in name else (name.split()[-1] if name else "")
    return f"{surname}\t{name}"


def _sort_key(sort: str, kind: str, ident: str, lead: CatalogRow, newest: int, name: str) -> list:
    """The card's key: [primary, secondary, tie]. `lead` is the book (or a
    series' first book) it stands for, `name` its title or series name. The
    text in it has no NUL, which is what a cursor joins the parts with."""
    tie = f"{kind}:{ident}".replace("\x00", "")
    if sort == "added":
        return [-newest, "", tie]
    if sort == "title":
        return [book_catalog.fold(name).replace("\x00", ""), "", tie]
    return [_author_sort(lead.author).replace("\x00", ""), book_catalog.fold(name).replace("\x00", ""), tie]


def _cards(rows: List[CatalogRow], sort: str, collapse: bool = True) -> List[Tuple[list, dict]]:
    """(sort key, card) for every card of the library, in order. Each series
    with SERIES_MIN_BOOKS or more books is one card; the rest are books.
    Without `collapse` (the person's "Group series" off, or a library
    filtered by series) every book is its own card, with its series and
    number on it."""
    by_series: Dict[str, List[CatalogRow]] = {}
    singles: List[CatalogRow] = []
    for row in rows:
        key = book_catalog.name_key(row.series) if collapse else ""
        (by_series.setdefault(key, []) if key else singles).append(row)
    cards = []
    for key, members in by_series.items():
        if len(members) < SERIES_MIN_BOOKS:
            singles.extend(members)
            continue
        card = _series_card(members)
        lead = sorted(members, key=_reading_order)[0]
        cards.append((_sort_key(sort, "s", key, lead, max(_timestamp(m.added_at) for m in members), card["series"]),
                      card))
    for row in singles:
        cards.append((_sort_key(sort, "b", f"{row.id:012d}", row, _timestamp(row.added_at), row.sort_title),
                      _book_card(row, in_series=not collapse)))
    cards.sort(key=lambda pair: pair[0])
    return cards


_NUMBER_TEXT = re.compile(r"-?[0-9]{1,15}", re.ASCII)


def _encode_cursor(sort: str, key: list) -> str:
    """A cursor is the sort and the key's three parts joined by NUL, in base64:
    flat, so reading one never recurses."""
    raw = "\x00".join([sort, *(str(part) for part in key)]).encode("utf-8", "replace")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str, sort: str) -> list:
    """The sort key a cursor holds; 422 for anything else, including a cursor
    made for another sort."""
    bad = HTTPException(status_code=422, detail="That page cursor is not valid")
    try:
        parts = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode("utf-8").split("\x00")
    except (ValueError, binascii.Error):        # UnicodeDecodeError is a ValueError
        raise bad from None
    if len(parts) != 4 or parts[0] != sort:
        raise bad
    primary: object = parts[1]
    if sort == "added":
        if not _NUMBER_TEXT.fullmatch(parts[1]):
            raise bad
        primary = int(parts[1])
    return [primary, parts[2], parts[3]]


def _kept_by_format(rows: List[CatalogRow], fmt: str) -> List[CatalogRow]:
    if fmt == "ebook":
        return [r for r in rows if r.ebook]
    if fmt == "audio":
        return [r for r in rows if r.audio]
    return rows


# --- Filters (the Books filters panel: Format, Author, Series, Narrator) ---------------
#
# A filter is a set of names, matched as the person and series pages match
# theirs (name_key: case and spacing ignored, accents kept). Names of one
# kind are alternatives (any of them); kinds are all applied together, and
# with the format. Every filter works on the rows the caller may see, so a
# name only ever lists or matches books that are theirs to see, whatever
# name is asked for.

FACET_MAX = 5000                 # values one facet lists
NAMES_MAX = 50                   # names one filter takes at once

Names = Optional[List[str]]


@dataclass(frozen=True)
class Filters:
    """The name keys asked for, per kind (empty: no filter)."""
    author: frozenset = frozenset()
    series: frozenset = frozenset()
    narrator: frozenset = frozenset()

    def any(self) -> bool:
        return bool(self.author or self.series or self.narrator)


def _keys(kind: str, names: Names) -> frozenset:
    """The name keys of one filter's values; blank ones are no value. 422 for
    a name longer than NAME_MAX or more than NAMES_MAX of them."""
    names = names or []
    if len(names) > NAMES_MAX:
        raise HTTPException(status_code=422, detail=f"At most {NAMES_MAX} names for {kind}")
    if any(len(n) > NAME_MAX for n in names):
        raise HTTPException(status_code=422, detail=f"A name for {kind} is too long")
    return frozenset(k for k in (book_catalog.name_key(n) for n in names) if k)


def _filters(author: Names, series: Names, narrator: Names) -> Filters:
    return Filters(_keys("author", author), _keys("series", series), _keys("narrator", narrator))


def _narrators_for(db: Session, who: Scope, needed: bool) -> Dict[int, List[str]]:
    """The editions' narrators, read only when a narrator is asked about and
    the caller may hear audiobooks at all (otherwise no book has one)."""
    return book_catalog.narrators_by_book(db) if (needed and who.audio) else {}


def _filtered(rows: List[CatalogRow], f: Filters, narrators: Dict[int, List[str]],
              skip: str = "") -> List[CatalogRow]:
    """The rows every filter but `skip` keeps: a row matches a filter when it
    has any of its names. A narrator belongs to a book's audio editions, so
    only a book the caller can hear has one."""
    out = []
    for r in rows:
        if f.author and skip != "author" and book_catalog.name_key(r.author) not in f.author:
            continue
        if f.series and skip != "series" and book_catalog.name_key(r.series) not in f.series:
            continue
        if f.narrator and skip != "narrator" and not (
                r.audio and any(book_catalog.name_key(n) in f.narrator for n in narrators.get(r.id, []))):
            continue
        out.append(r)
    return out


@router.get("")
@_limit(LIST_LIMIT, "list")
@_db_503
async def library(request: Request,
                  format: Literal["all", "ebook", "audio"] = "all",
                  sort: Literal["added", "title", "author"] = "added",
                  cursor: Optional[str] = Query(None, min_length=1, max_length=CURSOR_MAX),
                  limit: int = Query(PAGE_DEFAULT, ge=1, le=PAGE_MAX),
                  author: Names = Query(None),
                  series: Names = Query(None),
                  narrator: Names = Query(None),
                  group: bool = True,
                  who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """One page of the library the caller may see: {"items": [BookCard],
    "next_cursor", "notes", "building"}. A series of SERIES_MIN_BOOKS or more
    books is one card {kind "series", series, count, cover_book_id, cover_url,
    author, formats}; the rest are {kind "book", id, title, author, cover_url,
    formats}. `format` keeps the books that have it (a book in both still
    lists both badges).

    `author`, `series` and `narrator` may each be given more than once: a
    book is kept when it has any of a filter's names, and every filter given
    (and the format) applies. `group` false lists every book as a card of its
    own, with its `series` and `series_number`; so does a series filter.

    `building` is true only for an empty first page (whatever the format) while
    the catalog itself is empty and has never been built or is being built
    now: the page says it is being put together instead of "no books"."""
    after = _decode_cursor(cursor, sort) if cursor else None
    f = _filters(author, series, narrator)
    rows = _kept_by_format(book_catalog.visible_rows(db, who.series, who.audio), format)
    if f.any():
        rows = _filtered(rows, f, _narrators_for(db, who, bool(f.narrator)))
    cards = _cards(rows, sort, collapse=group and not f.series)
    if after is not None:
        cards = [c for c in cards if c[0] > after]
    page = cards[:limit]
    more = len(cards) > limit
    building = False
    if not page and after is None:
        status_ = await book_catalog.catalog_status()
        building = status_["counts"]["books"] == 0 and (status_["running"] or status_["last_ok_at"] is None)
    return {"items": [card for _key, card in page],
            "next_cursor": _encode_cursor(sort, page[-1][0]) if more and page else None,
            "notes": who.notes, "building": building}


# --- Search, people and series ----------------------------------------------------------

def _request_url(text: str) -> str:
    return "/requests?q=" + quote(text, safe="")


@router.get("/search")
@_limit(LIST_LIMIT, "search")
@_db_503
async def search(request: Request,
                 q: str = Query(..., min_length=1, max_length=100),
                 limit: int = Query(SEARCH_DEFAULT, ge=1, le=PAGE_MAX),
                 format: Literal["all", "ebook", "audio"] = "all",
                 author: Names = Query(None),
                 series: Names = Query(None),
                 narrator: Names = Query(None),
                 who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """Books matching `q` in their title, series, author or narrator, ignoring
    case and accents: {"items": [BookCard], "request_url" (null while a source is
    not reachable), "notes"}. Title
    matches come first, then series, then people; within a group a match at the
    start of the field first, then by title. `format`, `author`, `series` and
    `narrator` narrow the search as they narrow the library."""
    needle = book_catalog.fold(q)
    if not needle:
        raise HTTPException(status_code=422, detail="Search for at least one character")
    f = _filters(author, series, narrator)
    rows = _kept_by_format(book_catalog.visible_rows(db, who.series, who.audio), format)
    narrators = book_catalog.narrators_by_book(db) if who.audio else {}
    if f.any():
        rows = _filtered(rows, f, narrators)
    ranked = []
    for row in rows:
        fields = [(0, book_catalog.fold(row.title)), (1, book_catalog.fold(row.series)),
                  (2, book_catalog.fold(row.author))]
        if row.audio:
            fields += [(2, book_catalog.fold(n)) for n in narrators.get(row.id, [])]
        hits = [(group, 0 if text.startswith(needle) else 1) for group, text in fields if needle in text]
        if hits:
            ranked.append((min(hits), book_catalog.fold(row.sort_title), row.id, row))
    ranked.sort(key=lambda r: r[:3])
    # A source that cannot be reached may be hiding books the library already has:
    # no "request it" then (null), and the page says why instead.
    return {"items": [_book_card(r[3]) for r in ranked[:limit]],
            "request_url": None if who.notes else _request_url(q.strip()), "notes": who.notes}


@router.get("/person")
@_limit(LIST_LIMIT, "person")
@_db_503
async def person(request: Request,
                 role: Literal["author", "narrator"],
                 name: str = Query(..., min_length=1, max_length=NAME_MAX),
                 who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """One author's or narrator's books: {"name", "role", "items": [BookCard],
    "notes"}, at most PERSON_MAX, series together in reading order. The name is
    matched ignoring case and spacing (not accents), and travels in the query
    string so it can hold a "/", a comma or any Unicode. 404 when the caller
    can see none of their books."""
    wanted = book_catalog.name_key(name)
    if not wanted:
        raise HTTPException(status_code=422, detail="Give a name")
    rows = book_catalog.visible_rows(db, who.series, who.audio)
    shown = ""
    if role == "author":
        found = [r for r in rows if book_catalog.name_key(r.author) == wanted]
        shown = found[0].author if found else ""
    else:
        narrators = book_catalog.narrators_by_book(db) if who.audio else {}
        found = []
        for r in rows:
            match = next((n for n in narrators.get(r.id, []) if book_catalog.name_key(n) == wanted), None)
            if r.audio and match:
                found.append(r)
                shown = shown or match
    if not found:
        if who.notes:
            everyone = book_catalog.all_rows(db)
            if role == "author":
                matched = [r for r in everyone if book_catalog.name_key(r.author) == wanted]
            else:
                heard = book_catalog.narrators_by_book(db)
                matched = [r for r in everyone if r.audio and any(book_catalog.name_key(n) == wanted
                                                                   for n in heard.get(r.id, []))]
            blocked = _blocked_answer(who, matched)
            if blocked:
                return blocked
        raise HTTPException(status_code=404, detail="Nobody by that name in the library")
    found.sort(key=lambda r: (book_catalog.fold(r.series or r.sort_title), *_reading_order(r)))
    return {"name": shown, "role": role, "items": [_book_card(r) for r in found[:PERSON_MAX]], "notes": who.notes}


@router.get("/series")
@_limit(LIST_LIMIT, "series")
@_db_503
async def series(request: Request,
                 name: str = Query(..., min_length=1, max_length=NAME_MAX),
                 who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """One series in reading order, books without a number last: {"name",
    "items": [BookCard + series_number + progress {"ebook", "audio"}],
    "following", "notes"}. Progress is the caller's own, null for a format
    they have not started or cannot reach; `following` is whether the caller
    follows the series (book_discovery.followers). 404 when the caller can
    see none of its books."""
    wanted = book_catalog.name_key(name)
    if not wanted:
        raise HTTPException(status_code=422, detail="Give a name")
    found = sorted((r for r in book_catalog.visible_rows(db, who.series, who.audio)
                    if book_catalog.name_key(r.series) == wanted), key=_reading_order)
    if not found:
        if who.notes:
            blocked = _blocked_answer(who, [r for r in book_catalog.all_rows(db) if book_catalog.name_key(r.series) == wanted])
            if blocked:
                return blocked
        raise HTTPException(status_code=404, detail="No series by that name in the library")
    found = found[:PERSON_MAX]
    audio = _audio_progress_by_book(db, who, [r.id for r in found if r.audio])
    ebook, note = await _ebook_progress_by_chapter(
        who, [(r.kavita_chapter_id, r.kavita_volume_id) for r in found if r.ebook])
    items = [{**_book_card(r), "series_number": r.series_number,
              "progress": {"ebook": ebook.get(r.kavita_chapter_id) if r.ebook else None,
                           "audio": audio.get(r.id)}} for r in found]
    following = book_discovery.is_following(db, who.identity, found[0].series)
    return {"name": found[0].series, "items": items, "following": following,
            "notes": who.notes + ([note] if note else [])}


@router.get("/facets")
@_limit(LIST_LIMIT, "facets")
@_db_503
async def facets(request: Request,
                 facet: List[Literal["format", "author", "series", "narrator"]] = Query(..., min_length=1, max_length=4),
                 format: Literal["all", "ebook", "audio"] = "all",
                 author: Names = Query(None),
                 series: Names = Query(None),
                 narrator: Names = Query(None),
                 who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """What the filters can be set to: {"facets": {facet: [{"name",
    "count"}]}, "facet", "values", "notes"} ("facet" and "values" repeat the
    first facet asked for). Each facet counts the books the caller may see
    among those every other filter keeps (its own is left out, so the panel
    can change it).

    "format" is [all, ebook, audio], each the number of books (a book in both
    formats counts for each). The others list the names on those books:
    `count` is books, a book with two narrators counting for each; a name
    spelled more than one way is shown the way most of its books spell it;
    ordered by name, ignoring case and accents; at most FACET_MAX."""
    f = _filters(author, series, narrator)
    asked = list(dict.fromkeys(facet))
    narrators = _narrators_for(db, who, "narrator" in asked or bool(f.narrator))
    seen = book_catalog.visible_rows(db, who.series, who.audio)
    out: Dict[str, list] = {}
    for kind in asked:
        if kind == "format":
            rows = _filtered(seen, f, narrators)
            out[kind] = [{"name": "all", "count": len(rows)},
                         {"name": "ebook", "count": sum(1 for r in rows if r.ebook)},
                         {"name": "audio", "count": sum(1 for r in rows if r.audio)}]
            continue
        out[kind] = _name_values(kind, _filtered(_kept_by_format(seen, format), f, narrators, skip=kind), narrators)
    return {"facets": out, "facet": asked[0], "values": out[asked[0]], "notes": who.notes}


def _name_values(kind: str, rows: List[CatalogRow], narrators: Dict[int, List[str]]) -> List[dict]:
    found: Dict[str, list] = {}           # name key: [books, {spelling: books}]
    for r in rows:
        if kind == "author":
            names = [r.author]
        elif kind == "series":
            names = [r.series]
        else:
            names = narrators.get(r.id, []) if r.audio else []
        seen = set()
        for raw in names:
            name = " ".join(str(raw or "").split())
            key = book_catalog.name_key(name)
            if not key or key in seen:
                continue
            seen.add(key)
            held = found.setdefault(key, [0, {}])
            held[0] += 1
            held[1][name] = held[1].get(name, 0) + 1
    values = [{"name": max(spellings, key=spellings.get), "count": count} for count, spellings in found.values()]
    values.sort(key=lambda v: (book_catalog.fold(v["name"]), v["name"]))
    return values[:FACET_MAX]


# --- Progress ---------------------------------------------------------------------------

def _left_label(ms: int) -> str:
    minutes = max(1, round(ms / 60000))
    hours, minutes = divmod(minutes, 60)
    if hours and minutes:
        return f"{hours}h {minutes}m left"
    return f"{hours}h left" if hours else f"{minutes}m left"


def _audio_progress(place: dict) -> dict:
    """{"percent", "label", "updated_at", "finished"} for one place in the
    player's store. The label is the time left ("2h 10m left"); a place with no
    book position or length (saved before those were kept) is just "In
    progress"."""
    ms, total = place["book_ms"], place["book_duration_ms"]
    known = ms is not None and total is not None and total > 0
    if place["finished"]:
        percent, label = 100, "Finished"
    elif known:
        percent, label = min(99, math.floor(100 * ms / total)), _left_label(total - ms)
    else:
        percent, label = None, "In progress"
    return {"percent": percent, "label": label, "updated_at": utc_iso(place["updated_at"]),
            "finished": place["finished"]}


def _ebook_progress(place: dict, chapter: Optional[int] = None) -> dict:
    """{"percent", "label", "updated_at", "finished"} for one Kavita place
    ({"page", "pages", "at"}): "Ch. 12 · 43%" when the book's contents number
    its chapters (`chapter`), else "43%"."""
    page, pages = place["page"], place["pages"]
    finished = pages > 0 and page + 1 >= pages
    if finished:
        percent, label = 100, "Finished"
    elif pages > 1:
        percent = min(99, round(100 * page / (pages - 1)))
        label = f"Ch. {chapter} · {percent}%" if chapter else f"{percent}%"
    else:
        percent, label = None, "In progress"
    return {"percent": percent, "label": label, "updated_at": utc_iso(place["at"]), "finished": finished}


def _newest_edition_place(db: Session, who: Scope, book_ids: List[int]) -> Dict[int, Tuple[str, dict]]:
    """{book id: (the edition with the caller's newest place, that place)} for
    the books they have started in any edition. Scoped by the caller's
    identity."""
    wanted = set(book_ids)
    if not (who.audio and wanted):
        return {}
    keys = {key: book_id for key, (book_id, _n) in book_catalog.live_editions(db).items()
            if book_id in wanted}
    places = listening.get_places(db, who.identity, keys=list(keys))
    newest: Dict[int, Tuple[str, dict]] = {}
    for key, place in places.items():
        book_id = keys[key]
        if book_id not in newest or place["updated_at"] > newest[book_id][1]["updated_at"]:
            newest[book_id] = (key, place)
    return newest


def _audio_progress_by_book(db: Session, who: Scope, book_ids: List[int]) -> Dict[int, dict]:
    return {book_id: _audio_progress(place) for book_id, (_key, place) in
            _newest_edition_place(db, who, book_ids).items()}


async def _ebook_places(who: Scope, books: List[Tuple[int, Optional[int]]]) -> Tuple[Dict[int, dict], Optional[dict]]:
    """(the caller's Kavita place in each of these books, by chapter id; a note
    when Kavita could not be read). `books` are (chapter id, volume id): a
    volume is read whole. Books they have not started are absent."""
    if not (who.kavita and books):
        return {}, None
    base, token = who.kavita
    try:
        return await kavita.book_places(base, token, books), None
    except kavita.KavitaTokenRefused:
        return {}, _note("kavita", "not_connected", EBOOKS_NOT_CONNECTED)
    except kavita.KavitaUnavailable:
        return {}, _note("kavita", "unavailable", EBOOKS_DOWN)


async def _ebook_progress_by_chapter(who: Scope, books: List[Tuple[int, Optional[int]]]
                                     ) -> Tuple[Dict[int, dict], Optional[dict]]:
    places, note = await _ebook_places(who, books)
    return {chapter: _ebook_progress(place) for chapter, place in places.items()}, note


# --- The book ---------------------------------------------------------------------------

def _is_visible_ebook(book, who: Scope) -> bool:
    return book.kavita_chapter_id is not None and book.kavita_series_id in who.series


@router.get("/continue")
@_limit(LIST_LIMIT, "continue")
@_db_503
async def continue_row(request: Request, who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """What the caller is partway through, newest activity first, at most
    CONTINUE_MAX: {"items": [{book_id, format, title, author, cover_url,
    progress_label, percent, updated_at, resume}], "notes"}.

    A book started in several editions or in both formats appears once, under
    its newest activity (an audiobook under the edition touched last).
    `resume` is {"read_url"} for an ebook and {"plex_book_key"} for an
    audiobook. A book the caller took out of the row (PUT
    /api/books/<id>/continue-hidden) is left out until its activity is newer
    than it was then. A source that cannot be read drops its items and adds a note;
    the answer is still 200."""
    rows = {r.id: r for r in book_catalog.visible_rows(db, who.series, who.audio)}
    candidates: Dict[int, dict] = {}

    def offer(book_id: int, item: dict) -> None:
        held = candidates.get(book_id)
        if held is None or item["at"] > held["at"]:
            candidates[book_id] = item

    # Audiobooks: the caller's own places, the unfinished ones.
    if who.audio:
        places = listening.get_places(db, who.identity)
        editions = book_catalog.live_editions(db, places)
        for key, place in places.items():
            if key in editions and not place["finished"] and editions[key][0] in rows:
                book_id = editions[key][0]
                offer(book_id, {"book_id": book_id, "format": "audio", "at": place["updated_at"],
                                "progress": _audio_progress(place), "resume": {"plex_book_key": key}})

    # Ebooks: the series Kavita says they are in, then their place in each book.
    note = None
    ebook_places: Dict[int, dict] = {}
    chapters: Dict[int, int] = {}
    if who.kavita:
        base, token = who.kavita
        try:
            series_ids = await kavita.in_progress_series_ids(base, token)
            wanted = [b for b in book_catalog.ebooks_in_series(db, series_ids, who.series) if b.id in rows]
            chapters = {b.kavita_chapter_id: b.id for b in wanted}
            ebook_places = await kavita.book_places(base, token,
                                                    [(b.kavita_chapter_id, b.kavita_volume_id) for b in wanted])
        except kavita.KavitaTokenRefused:
            note = _note("kavita", "not_connected", EBOOKS_NOT_CONNECTED)
        except kavita.KavitaUnavailable:
            note = _note("kavita", "unavailable", EBOOKS_DOWN)
    reading = []
    for chapter_id, place in ebook_places.items():
        progress = _ebook_progress(place)
        if progress["finished"] or chapter_id not in chapters:
            continue
        book_id = chapters[chapter_id]
        reading.append(rows[book_id].series)
        offer(book_id, {"book_id": book_id, "format": "ebook", "at": place["at"] or datetime.min,
                        "progress": progress, "chapter_id": chapter_id, "place": place,
                        "resume": {"read_url": _read_url(rows[book_id])}})
    if who.identity and any(reading):
        # Reading a series in Kavita follows it (spec 3c 2.5): seen only here,
        # through the person's own link, so it is noted while it can be.
        try:
            book_discovery.note_reading(db, who.identity, reading)
        except SQLAlchemyError as exc:
            db.rollback()
            logger.warning("A series follow from reading could not be saved: %s", type(exc).__name__)

    # Books the caller took out of the row stay out until there is newer
    # activity than the row showed then; their places are untouched.
    if who.identity:
        hidden = book_personal.continue_hidden(db, who.identity)
        for book_id in [b for b, i in candidates.items()
                        if b in hidden and book_personal.to_ms(i["at"]) <= hidden[b]]:
            del candidates[book_id]

    newest = sorted(candidates.values(), key=lambda i: (i["at"], i["book_id"]), reverse=True)[:CONTINUE_MAX]
    # The chapter number is read from the book's contents: only for what is shown.
    numbers = await _chapter_numbers(who, [i for i in newest if i["format"] == "ebook"])
    items = []
    for item in newest:
        row = rows[item["book_id"]]
        progress = item["progress"]
        if item["format"] == "ebook":
            progress = _ebook_progress(ebook_places[item["chapter_id"]], numbers.get(item["chapter_id"]))
        items.append({"book_id": row.id, "format": item["format"], "title": row.title, "author": row.author,
                      "cover_url": _cover_url(row.id, row.updated_at), "progress_label": progress["label"],
                      "percent": progress["percent"], "updated_at": progress["updated_at"],
                      "resume": item["resume"]})
    return {"items": items, "notes": who.notes + ([note] if note else [])}


async def _chapter_numbers(who: Scope, ebook_items: List[dict]) -> Dict[int, int]:
    if not (who.kavita and ebook_items):
        return {}
    base, token = who.kavita
    found = await asyncio.gather(*(kavita.chapter_number_at(base, token, i["place"]["toc_chapter"],
                                                             i["place"]["toc_page"]) for i in ebook_items))
    return {i["chapter_id"]: n for i, n in zip(ebook_items, found) if n}


def _read_url(book) -> str:
    return f"/reader?seriesId={book.kavita_series_id}&chapterId={book.kavita_chapter_id}"


def preferred_edition(editions: list, places: dict):
    """The edition to open (`editions` primary first, `places` the caller's
    places by key): the newest place still being listened to, else the newest
    place (all finished), else the primary edition."""
    def newest(started: list):
        return max(started, key=lambda e: places[e.plex_book_key]["updated_at"], default=None)

    started = [e for e in editions if e.plex_book_key in places]
    return (newest([e for e in started if not places[e.plex_book_key]["finished"]])
            or newest(started) or editions[0])


def _redirect_to_book(book_id: int, suffix: str = "") -> RedirectResponse:
    """To the book an old id was merged into. Temporary and never stored: a
    later split gives the old id its own book back, and a browser that kept a
    permanent redirect would send it to the wrong work for good."""
    return RedirectResponse(f"/api/books/{book_id}{suffix}", status_code=status.HTTP_307_TEMPORARY_REDIRECT,
                            headers={"Cache-Control": "no-store"})


@router.get("/{book_id}")
@_limit(LIST_LIMIT, "book")
@_db_503
async def book_detail(request: Request, book_id: BookId, background: BackgroundTasks,
                      who: Scope = Depends(caller), db: Session = Depends(get_db),
                      user: dict = Depends(get_current_user),
                      session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name)):
    """One book: {"book", "formats": {"ebook": {available, progress, read_url}
    or null, "audio": {available, editions: [{plex_book_key, narrator,
    progress, in_progress}], preferred} or null}, "request_links", "notes",
    "my_list", "queue_position", "my_rating"}. The last three are the
    caller's own (app/services/book_personal.py): whether it is on their list,
    its place among the queued books they can see (null when not queued) and
    their stars (null when not rated).

    A null format is one the caller cannot reach (or the book lacks).
    `preferred` is the edition with the caller's newest unfinished place, else
    their newest place, else the primary edition. `request_links` holds the Requests page link for a format
    the catalog lacks, null otherwise. A book that was merged into another
    answers 307 (never cached) to the surviving id; an unknown one, or one the caller can see
    no format of, is 404."""
    book, survivor = book_catalog.resolve_book(db, book_id)
    if book is None:
        if survivor is not None:
            return _redirect_to_book(survivor)
        raise HTTPException(status_code=404, detail="No such book")
    editions = book_catalog.editions_of(db, book)
    ebook_visible = _is_visible_ebook(book, who)
    audio_visible = who.audio and bool(editions)
    if not (ebook_visible or audio_visible):
        # Hidden only because a source cannot be reached (Kavita not connected or
        # not answering for an ebook, Plex not answering for an audiobook): say so
        # (the page runs the hand-off, or says "unavailable right now"), rather than
        # "no such book". Nothing about the book itself is in the answer.
        if who.notes:
            blocked = _blocked_answer(who, [book_catalog.CatalogRow(
                book.id, "", "", "", "", None, None, book.updated_at, book.kavita_chapter_id, book.kavita_series_id,
                book.plex_book_key, "", book.kavita_volume_id, book.kavita_chapter_id is not None, bool(editions))])
            if blocked:
                return blocked
        raise HTTPException(status_code=404, detail="No such book")

    notes = list(who.notes)
    formats: dict = {"ebook": None, "audio": None}
    if ebook_visible:
        progress = None
        places, note = await _ebook_places(who, [(book.kavita_chapter_id, book.kavita_volume_id)])
        place = places.get(book.kavita_chapter_id)
        if place:
            number = None
            if not _ebook_progress(place)["finished"]:
                number = await kavita.chapter_number_at(*who.kavita, place["toc_chapter"], place["toc_page"])
            progress = _ebook_progress(place, number)
        if note:
            notes.append(note)
        formats["ebook"] = {"available": True, "progress": progress, "read_url": _read_url(book)}
    if audio_visible:
        places = listening.get_places(db, who.identity, keys=[e.plex_book_key for e in editions])
        listed = []
        for edition in editions:
            place = places.get(edition.plex_book_key)
            listed.append({"plex_book_key": edition.plex_book_key, "narrator": edition.narrator or "",
                           "progress": _audio_progress(place) if place else None,
                           "in_progress": bool(place) and not place["finished"]})
        formats["audio"] = {"available": True, "editions": listed,
                            "preferred": preferred_edition(editions, places).plex_book_key}

    ask = f"{book.title} {book.author}".strip()
    narrators = [e["narrator"] for e in (formats["audio"] or {}).get("editions", []) if e["narrator"]]
    mine = {"my_list": False, "queue_position": None, "my_rating": None}
    if who.identity:
        visible = {r.id for r in book_catalog.visible_rows(db, who.series, who.audio)}
        queued = [b for b in book_personal.queue_ids(db, who.identity) if b in visible]
        rating = book_personal.get_rating(db, who.identity, book.id)
        mine = {"my_list": book_personal.on_list(db, who.identity, book.id),
                "queue_position": queued.index(book.id) if book.id in queued else None,
                "my_rating": book_personal.shown_rating(rating)}
        if book_personal.due_on_visit(rating):
            # A rating still to be written to Kavita or Plex is tried again
            # now, as this person, after the answer is sent.
            background.add_task(book_personal.push_rating, who.identity, book.id, dict(user), session_id)
    return {
        **mine,
        "book": {"id": book.id, "title": book.title, "author": book.author, "series": book.series,
                 "series_number": book.series_number, "description": book.description,
                 "narrators": list(dict.fromkeys(narrators)), "cover_url": _cover_url(book.id, book.updated_at),
                 "added_at": utc_iso(book.added_at)},
        "formats": formats,
        "request_links": {"ebook": _request_url(ask) if book.kavita_chapter_id is None else None,
                          "audio": _request_url(ask) if not editions else None},
        "notes": notes,
    }


# --- Covers -----------------------------------------------------------------------------

@router.get("/{book_id}/cover")
@_limit(COVER_LIMIT, "cover")
@_db_503
async def cover(request: Request, book_id: BookId, who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """The book's cover, served from this origin (never hotlinked), from a
    format the caller can see: the book's own cover source first, then the
    other. Only a raster image of bounded size is passed on. 404 when the book
    is not theirs to see or has no cover; 503 when its source is down."""
    book, survivor = book_catalog.resolve_book(db, book_id)
    if book is None:
        if survivor is not None:
            return _redirect_to_book(survivor, "/cover")
        raise HTTPException(status_code=404, detail="No such book")
    sources = []
    if _is_visible_ebook(book, who):
        sources.append("kavita")
    editions = book_catalog.editions_of(db, book) if who.audio else []
    if editions:
        sources.append("plex")
    if not sources:
        raise HTTPException(status_code=404, detail="No such book")
    sources.sort(key=lambda s: s != book.cover_source)

    unavailable = False
    for source in sources:
        try:
            if source == "kavita":
                content, content_type = await kavita.chapter_cover(book.kavita_chapter_id)
            else:
                content, content_type = await pp.cover_image(book.plex_book_key or editions[0].plex_book_key)
        except (kavita.KavitaNoCover, pp.NotInLibrary):
            continue
        except (kavita.KavitaUnavailable, pp.PlayerUnavailable):
            unavailable = True
            continue
        return Response(content=content, media_type=content_type, headers={
            "Cache-Control": f"private, max-age={COVER_MAX_AGE}",
            "X-Content-Type-Options": "nosniff",
            # Loaded as a document rather than an <img>, it can run nothing.
            "Content-Security-Policy": "sandbox",
        })
    if unavailable:
        raise HTTPException(status_code=503, detail="The cover is unavailable right now")
    raise HTTPException(status_code=404, detail="This book has no cover")


# --- Admin ------------------------------------------------------------------------------

def _status_body(status_: dict) -> dict:
    return {"last_rebuild_at": utc_iso(status_["last_rebuild_at"]), "last_ok_at": utc_iso(status_["last_ok_at"]),
            "counts": status_["counts"], "errors": status_["errors"], "running": status_["running"]}


@admin_router.get("/status")
@limiter.limit(ADMIN_LIMIT)
@_db_503
async def admin_status(request: Request, _admin: dict = Depends(require_admin)):
    """How the last catalog rebuild went: {"last_rebuild_at", "last_ok_at",
    "counts": {ebooks, audiobooks, books}, "errors": {kavita, plex},
    "running"}."""
    return _status_body(await book_catalog.catalog_status())


@admin_router.post("/rebuild", dependencies=[Depends(require_same_origin)])
@limiter.limit(REBUILD_LIMIT)
@_db_503
async def admin_rebuild(request: Request, _admin: dict = Depends(require_admin)):
    """Rebuild the catalog now: the rebuild's result {ok, ebooks, audiobooks,
    books, errors, skipped} (skipped: another rebuild was already running)."""
    try:
        return await book_catalog.rebuild("manual")
    except (SQLAlchemyError, RedisError) as exc:
        logger.warning("A manual Books rebuild could not run: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="The catalog could not be written right now") from None


@admin_router.get("/unpaired")
@limiter.limit(ADMIN_LIMIT)
@_db_503
async def admin_unpaired(request: Request, _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """The ebooks with no audiobook and the audiobook editions in books with no
    ebook, for pairing by hand: {"ebooks": [...], "audiobooks": [...]}."""
    return book_catalog.unpaired(db)


@admin_router.get("/paired")
@limiter.limit(ADMIN_LIMIT)
@_db_503
async def admin_paired(request: Request, _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """The books that are an ebook with audiobook editions, for keeping one
    edition apart by hand: {"books": [{book_id, kavita_chapter_id, title,
    author, series, editions: [{plex_book_key, narrator}]}]}."""
    return book_catalog.paired(db)


def _override_body(row: dict) -> dict:
    return {**row, "created_at": utc_iso(row["created_at"])}


@admin_router.get("/overrides")
@limiter.limit(ADMIN_LIMIT)
@_db_503
async def admin_overrides(request: Request, _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """Every pairing override: {"overrides": [{kavita_chapter_id,
    plex_book_key, action, created_by, created_at, ebook_title,
    audio_title}]}."""
    return {"overrides": [_override_body(r) for r in book_catalog.overrides(db)]}


class OverrideIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kavita_chapter_id: StrictInt = Field(ge=1, le=MAX_ID)
    plex_book_key: Text = Field(pattern=r"^[0-9]{1,20}:[0-9]{1,6}$", max_length=listening.KEY_MAX)
    action: Literal["pair", "apart"]


@admin_router.post("/overrides", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@limiter.limit(ADMIN_LIMIT)
@_db_503
async def admin_set_override(request: Request, body: OverrideIn, admin: dict = Depends(require_admin),
                             db: Session = Depends(get_db)):
    """Pair an ebook (its Kavita chapter id) with one audiobook edition, or
    keep them apart. Both must be in the catalog (404 otherwise). It shows at
    the next rebuild. Returns the override."""
    if not (book_catalog.knows_ebook(db, body.kavita_chapter_id) and book_catalog.knows_edition(db, body.plex_book_key)):
        raise HTTPException(status_code=404, detail="That ebook or audiobook is not in the catalog")
    try:
        row = book_catalog.set_override(db, body.kavita_chapter_id, body.plex_book_key, body.action,
                                        account_identity(admin) or admin.get("username", "")[:200])
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("A Books pairing override could not be saved: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="The override could not be saved right now") from None
    return _override_body({"kavita_chapter_id": row.kavita_chapter_id, "plex_book_key": row.plex_book_key,
                           "action": row.action, "created_by": row.created_by, "created_at": row.created_at})


@admin_router.delete("/overrides", dependencies=[Depends(require_same_origin)])
@limiter.limit(ADMIN_LIMIT)
@_db_503
async def admin_remove_override(request: Request,
                                kavita_chapter_id: int = Query(..., ge=1, le=MAX_ID),
                                plex_book_key: str = Query(..., pattern=r"^[0-9]{1,20}:[0-9]{1,6}$",
                                                           max_length=listening.KEY_MAX),
                                _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """Remove the override for the pair; 404 when there is none."""
    try:
        removed = book_catalog.remove_override(db, kavita_chapter_id, plex_book_key)
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("A Books pairing override could not be removed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="The override could not be removed right now") from None
    if not removed:
        raise HTTPException(status_code=404, detail="No such override")
    return {"removed": True}
