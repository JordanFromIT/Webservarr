"""
Kavita, read by the server for the Books catalog.

app/routers/kavita_proxy.py is the browser's way into Kavita and acts as the
signed-in person. This is the server's own read of the whole library, made
with one API key (setting integration.kavita.api_key): it exchanges the key
for a short-lived token, lists every series and reads each one's volumes and
chapters. A series can hold many books, so the unit it gives is the book: a
volume, or a chapter where Kavita keeps a standalone book as one. Author,
title and summary come from the book's own chapter metadata.

The key travels in the query string of the one exchange call (Kavita's
Plugin/authenticate takes it nowhere else), so no error raised here carries a
URL or an httpx message: every failure is a KavitaUnavailable with a fixed
sentence, safe to store and to show on the Settings page.
"""

import asyncio
import html
import json
import logging
import re
from datetime import datetime
from typing import Optional

import httpx

from app.integrations import config as integration_config

logger = logging.getLogger(__name__)

URL_KEY = "integration.kavita.url"
API_KEY = "integration.kavita.api_key"

TIMEOUT = 20.0
PAGE_SIZE = 200
MAX_PAGES = 500              # a runaway Pagination header can't keep the loop going
METADATA_CONCURRENCY = 5     # Kavita is one small server across the tunnel
LOOSE_NUMBER = 100000        # Kavita numbers loose chapters -100000 and specials 100000
PLACEHOLDER_WRITERS = {"authors_sort", "author_sort"}   # calibre artefacts, not people
PLUGIN_NAME = "WebServarr"

_TAGS = re.compile(r"<[^>]*>")
_BREAKS = re.compile(r"<\s*(?:br\s*/?|/p)\s*>", re.IGNORECASE)
_BLANK_RUNS = re.compile(r"[ \t\r\f\v]*\n[ \t\r\f\v\n]*")


class KavitaUnavailable(Exception):
    """Kavita is not set up, did not answer, or refused the key. The message
    is fixed text: it names no address and no key."""


def _config() -> tuple:
    values = integration_config.read((URL_KEY, API_KEY))
    base = integration_config.base_url("kavita", values)
    key = values.get(API_KEY) or ""
    if not base:
        raise KavitaUnavailable("Kavita is not set up")
    if not key:
        raise KavitaUnavailable("Add the Kavita API key")
    if integration_config.padded(base) or integration_config.padded(key):
        raise KavitaUnavailable("The Kavita address or API key starts or ends with a space")
    return base, key


def plain_text(value) -> str:
    """Kavita's summary is HTML; the catalog keeps it as plain text."""
    text = _BREAKS.sub("\n", str(value or ""))
    text = html.unescape(_TAGS.sub("", text))
    return _BLANK_RUNS.sub("\n", text).strip()


def _when(value) -> Optional[datetime]:
    """A Kavita timestamp as a naive datetime. The createdUtc fields are UTC;
    the plain ones are the server's own clock, which is as good for ordering."""
    try:
        return datetime.fromisoformat(str(value)).replace(tzinfo=None)
    except ValueError:
        return None


async def _get_json(client: httpx.AsyncClient, method: str, url: str, headers: dict, **kwargs):
    try:
        response = await client.request(method, url, headers=headers, **kwargs)
    except httpx.HTTPError as exc:
        raise KavitaUnavailable("Kavita did not answer") from exc
    if response.status_code in (401, 403):
        raise KavitaUnavailable("Kavita refused the API key")
    if response.status_code != 200:
        raise KavitaUnavailable(f"Kavita answered HTTP {response.status_code}")
    try:
        return response.json(), response.headers
    except ValueError as exc:
        raise KavitaUnavailable("Kavita's answer could not be read") from exc


async def _token(client: httpx.AsyncClient, base: str, key: str) -> str:
    try:
        response = await client.post(f"{base}/api/Plugin/authenticate",
                                     params={"apiKey": key, "pluginName": PLUGIN_NAME})
    except httpx.HTTPError as exc:
        raise KavitaUnavailable("Kavita did not answer") from exc
    if response.status_code != 200:
        raise KavitaUnavailable("Kavita refused the API key")
    try:
        token = (response.json() or {}).get("token")
    except (ValueError, AttributeError) as exc:
        raise KavitaUnavailable("Kavita's answer could not be read") from exc
    if not token:
        raise KavitaUnavailable("Kavita refused the API key")
    return token


async def _all_series(client: httpx.AsyncClient, base: str, headers: dict) -> list:
    body = {"statements": [], "combination": 1, "limitTo": 0,
            "sortOptions": {"sortField": 1, "isAscending": True}}
    series = []
    for page in range(1, MAX_PAGES + 1):
        items, answer = await _get_json(client, "POST", f"{base}/api/Series/all-v2", headers,
                                        params={"PageNumber": page, "PageSize": PAGE_SIZE}, json=body)
        if not isinstance(items, list):
            raise KavitaUnavailable("Kavita's answer could not be read")
        series.extend(s for s in items if isinstance(s, dict) and isinstance(s.get("id"), int))
        try:
            pages = int(json.loads(answer.get("pagination") or "{}").get("totalPages") or 1)
        except (ValueError, TypeError, AttributeError):
            pages = 1
        if page >= pages or not items:
            break
    return series


def _plain_name(name: str) -> str:
    return re.sub(r"[^\w]+", " ", name.casefold()).strip()


def _authors(writers, folder: str = "") -> str:
    """The author from a list of Kavita writers (people with the Writer role):
    the first one, or "" when there is none worth naming. Two things in what
    Kavita holds are not names. One is the calibre placeholder "authors_sort".
    The other is a "Last, First" author that Kavita has split at the comma into
    two writers ("King", "Stephen"), which is put back together as "Stephen
    King". Two writers are one split name when the first is a single word and
    the second looks like a given name (a single word, or one with an initial:
    "Sarah J."), or the author's folder in the library is named for the joined
    name; they are two people (writer and translator, co-authors) when the
    folder is named for either of them, or the first has a space, or the second
    is a full name ("Homer", "Emily Wilson") and the folder doesn't say
    otherwise. `folder` is the name of the folder the series is kept in."""
    names = []
    for w in writers or []:
        name = str(w.get("name") or "").strip() if isinstance(w, dict) else ""
        if name and name.casefold() not in PLACEHOLDER_WRITERS:
            names.append(name)
    if len(names) == 2 and " " not in names[0]:
        last, first = names
        joined = _plain_name(f"{first} {last}")
        named_for = _plain_name(folder)
        given = " " not in first or any(len(t.strip(".")) == 1 or t.endswith(".") for t in first.split())
        if named_for == joined or (given and named_for not in (_plain_name(last), _plain_name(first))):
            return f"{first} {last}"
    return names[0] if names else ""


def _numbered(volume: dict) -> bool:
    """A real volume (1, 2, ...), as opposed to Kavita's holders for loose
    chapters (-100000) and specials (100000)."""
    number = volume.get("minNumber")
    return isinstance(number, (int, float)) and not isinstance(number, bool) and abs(number) < LOOSE_NUMBER


def _book_units(detail: dict) -> list:
    """[(volume or None, chapter)] for one series, one per book. A numbered
    volume is one book (its first chapter is the one that is read); a book
    Kavita keeps as a chapter outside a numbered volume (a loose chapter or a
    special, which is how a standalone book is usually held) is one book
    each."""
    units, seen = [], set()

    def add(volume, chapter):
        if isinstance(chapter, dict) and isinstance(chapter.get("id"), int) and chapter["id"] not in seen:
            seen.add(chapter["id"])
            units.append((volume, chapter))

    for volume in detail.get("volumes") or []:
        if not isinstance(volume, dict):
            continue
        chapters = [c for c in volume.get("chapters") or [] if isinstance(c, dict) and isinstance(c.get("id"), int)]
        if _numbered(volume) and chapters:
            add(volume, chapters[0])
            seen.update(c["id"] for c in chapters)
        else:
            for chapter in chapters:
                add(None, chapter)
    for part in ("specials", "chapters", "storylineChapters"):
        for chapter in detail.get(part) or []:
            add(None, chapter)
    return units


def _inherit_authors(books: list, folders: dict) -> None:
    """A book that names no writer takes the author its neighbours agree on:
    the other books of its series, or failing that the other books kept in
    the same folder (a library laid out by author keeps one author's books,
    series or not, in one folder, and a standalone book is its own series).
    They must name exactly one author between them; two, or none, change
    nothing. Only the authors Kavita gave are used, so it never chains."""
    named = [(b, b["author"]) for b in books if b["author"]]

    def agreed(others) -> str:
        names: dict = {}
        for _, name in others:
            names.setdefault(name.casefold(), name)
        return next(iter(names.values())) if len(names) == 1 else ""

    for book in books:
        if book["author"]:
            continue
        same_series = [(b, a) for b, a in named if b["series_id"] == book["series_id"]]
        folder = folders.get(book["series_id"], "")
        same_folder = [(b, a) for b, a in named if folder and folders.get(b["series_id"]) == folder]
        book["author"] = agreed(same_series) or agreed(same_folder)


async def list_books() -> list:
    """Every book in every Kavita library, one per volume (or per chapter
    where Kavita holds a standalone book as a chapter):
    [{id, series_id, volume_id, library_id, title, sort_title, author, series,
    series_number, description, added_at}].

    `id` is the chapter that is read (a volume's first), the id the catalog
    follows and the reader opens; `volume_id` is None for a book that is not
    a numbered volume. `series` is the Kavita series name ("" for a series
    that is just this book), `series_number` the volume number (None when it
    has none), `author` the first writer of the book, else of its series
    ("" when none, see _authors; a book with none takes the author its
    series or folder agree on, see _inherit_authors), `description` the summary as plain text and
    `added_at` a naive UTC datetime (None when Kavita gives none). Raises
    KavitaUnavailable."""
    base, key = _config()
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
        headers = {"Authorization": f"Bearer {await _token(client, base, key)}"}
        gate = asyncio.Semaphore(METADATA_CONCURRENCY)

        async def get(path: str, **params):
            async with gate:
                data, _ = await _get_json(client, "GET", f"{base}{path}", headers, params=params)
            return data if isinstance(data, dict) else {}

        async def books_of(series: dict) -> list:
            detail = await get("/api/Series/series-detail", seriesId=series["id"])
            units = _book_units(detail)
            chapters = await asyncio.gather(*(get("/api/Series/chapter", chapterId=c["id"]) for _, c in units))
            folder = str(series.get("folderPath") or "").replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
            authors = [_authors(c.get("writers"), folder) for c in chapters]
            if units and not all(authors):
                # A book that names no writer takes its series'.
                fallback = _authors((await get("/api/Series/metadata", seriesId=series["id"])).get("writers"), folder)
                authors = [a or fallback for a in authors]
            name = str(series.get("name") or "").strip()
            library = series.get("libraryId") if isinstance(series.get("libraryId"), int) else None
            out = []
            for (volume, unit), chapter, author in zip(units, chapters, authors):
                volume_name = str((volume or {}).get("name") or "").strip()
                title = (str(chapter.get("titleName") or "").strip()
                         or (volume_name if not volume_name.isdigit() else "") or name)
                number = volume.get("minNumber") if volume else None
                out.append({
                    "id": unit["id"],
                    "series_id": series["id"],
                    "volume_id": volume["id"] if volume and isinstance(volume.get("id"), int) else None,
                    "library_id": library,
                    "title": title,
                    "sort_title": title,
                    "author": author,
                    "series": "" if name.casefold() == title.casefold() else name,
                    "series_number": number if _numbered(volume or {}) else None,
                    "description": plain_text(chapter.get("summary")),
                    "added_at": _when(chapter.get("createdUtc")) or _when(chapter.get("created")),
                })
            return out

        series = await _all_series(client, base, headers)
        results = await asyncio.gather(*(books_of(s) for s in series), return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            raise result
    books = [book for books in results for book in books]
    folders = {s["id"]: str(s.get("folderPath") or "").strip() for s in series}
    _inherit_authors(books, folders)
    return books


# --- Reading as the signed-in person -------------------------------------------------
#
# Everything above reads the whole library with the server's key. What a
# person may see, and where they are in a book, is theirs: it is read with
# their own Kavita token (the JWT the OIDC hand-off keeps in their session,
# see kavita_proxy.py), never the server's key. These calls take the address
# and token the caller already holds. Like the rest of this module, every
# failure is a KavitaUnavailable with fixed text: nothing carries an address or
# a token.

USER_TIMEOUT = 8.0           # a page waits on these, unlike the rebuild
USER_CONCURRENCY = 6
MAX_IN_PROGRESS_SERIES = 100
FINISHED_FROM = 100          # the ReadProgress filter's percent that is "read"
COVER_MAX_BYTES = 5 * 1024 * 1024
COVER_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif")
# Kavita's filter ids: the field (ReadProgress) and the comparisons (GreaterThan, LessThan).
FILTER_READ_PROGRESS = 20
COMPARE_GREATER_THAN = 1
COMPARE_LESS_THAN = 3
_CHAPTER_TITLE = re.compile(r"^\s*(?:chapter|ch\.?)\s*(\d{1,4})\b", re.IGNORECASE)


class KavitaTokenRefused(KavitaUnavailable):
    """Kavita refused the person's own token (expired or revoked): they have
    to connect to Kavita again."""


class KavitaNoCover(Exception):
    """Kavita has no cover for the book, or what it sent is not an image."""


def _user_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=USER_TIMEOUT, follow_redirects=False)


async def _as_user(client: httpx.AsyncClient, base: str, token: str, method: str, path: str, **kwargs):
    """The JSON answer to a call made with the person's token; None for a 404
    (what they asked about is not there), KavitaTokenRefused for a 401."""
    try:
        response = await client.request(method, f"{base}{path}", headers={"Authorization": f"Bearer {token}"},
                                        **kwargs)
    except httpx.HTTPError as exc:
        raise KavitaUnavailable("Kavita did not answer") from exc
    if response.status_code == 401:
        raise KavitaTokenRefused("Kavita no longer accepts this sign-in")
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise KavitaUnavailable(f"Kavita answered HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise KavitaUnavailable("Kavita's answer could not be read") from exc


def _whole(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


async def user_library_ids(base: str, token: str) -> set:
    """The ids of the libraries this person's own Kavita account can reach."""
    async with _user_client() as client:
        data = await _as_user(client, base, token, "GET", "/api/Library/libraries")
    if not isinstance(data, list):
        raise KavitaUnavailable("Kavita's answer could not be read")
    return {lib["id"] for lib in data if isinstance(lib, dict) and isinstance(lib.get("id"), int)
            and not isinstance(lib["id"], bool)}


async def in_progress_series_ids(base: str, token: str) -> list:
    """The ids of the series this person has started and not finished (at
    most MAX_IN_PROGRESS_SERIES), as Kavita counts it for them."""
    body = {"statements": [
        {"comparison": COMPARE_GREATER_THAN, "field": FILTER_READ_PROGRESS, "value": "0"},
        {"comparison": COMPARE_LESS_THAN, "field": FILTER_READ_PROGRESS, "value": str(FINISHED_FROM)}],
        "combination": 1, "limitTo": 0, "sortOptions": {"sortField": 1, "isAscending": True}}
    async with _user_client() as client:
        data = await _as_user(client, base, token, "POST", "/api/Series/all-v2", json=body,
                              params={"PageNumber": 1, "PageSize": MAX_IN_PROGRESS_SERIES})
    if not isinstance(data, list):
        raise KavitaUnavailable("Kavita's answer could not be read")
    return [s["id"] for s in data if isinstance(s, dict) and isinstance(s.get("id"), int)]


async def chapter_places(base: str, token: str, chapter_ids) -> dict:
    """This person's place in each chapter (a book) that they have started:
    {chapter id: {"page": the page they are on, "pages": the book's pages,
    "at": when they last read it (naive UTC, or None)}}. A chapter with no
    place, or that Kavita no longer has, is left out."""
    ids = list(dict.fromkeys(chapter_ids))
    gate = asyncio.Semaphore(USER_CONCURRENCY)
    places: dict = {}
    async with _user_client() as client:
        async def read(chapter_id: int) -> None:
            async with gate:
                progress = await _as_user(client, base, token, "GET", "/api/Reader/get-progress",
                                          params={"chapterId": chapter_id})
                page = _whole(progress.get("pageNum")) if isinstance(progress, dict) else 0
                if page <= 0:
                    return
                chapter = await _as_user(client, base, token, "GET", "/api/Series/chapter",
                                         params={"chapterId": chapter_id})
            pages = _whole(chapter.get("pages")) if isinstance(chapter, dict) else 0
            places[chapter_id] = {"page": page, "pages": pages, "at": _when(progress.get("lastModifiedUtc"))}

        results = await asyncio.gather(*(read(i) for i in ids), return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException):
            raise result
    return places


def _toc_entries(items, out: list) -> None:
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict):
            out.append((_whole(item.get("page")), str(item.get("title") or "")))
            _toc_entries(item.get("children"), out)


async def chapter_number_at(base: str, token: str, chapter_id: int, page: int) -> Optional[int]:
    """The number of the book's own chapter the reader is in at `page` ("Chapter
    12 - ..." in its table of contents), or None when the contents don't number
    it. Never raises for a book whose contents can't be read: the label is a
    nicety."""
    try:
        async with _user_client() as client:
            data = await _as_user(client, base, token, "GET", f"/api/Book/{int(chapter_id)}/chapters")
    except KavitaUnavailable:
        return None
    entries: list = []
    _toc_entries(data, entries)
    current = [e for e in entries if e[0] <= page]
    if not current:
        return None
    found = _CHAPTER_TITLE.match(max(current, key=lambda e: e[0])[1])
    return int(found.group(1)) if found else None


async def chapter_cover(chapter_id: int) -> tuple:
    """(image bytes, content type) of a book's cover, read with the server's
    key (Kavita's image routes take a key in the query string, never a token).
    The caller has already checked that the person may see the book. Only a
    raster image of at most COVER_MAX_BYTES is passed on; anything else is
    KavitaNoCover. Raises KavitaUnavailable."""
    base, key = _config()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
            async with client.stream("GET", f"{base}/api/image/chapter-cover",
                                     params={"chapterId": int(chapter_id), "apiKey": key}) as response:
                if response.status_code == 404:
                    raise KavitaNoCover()
                if response.status_code != 200:
                    raise KavitaUnavailable(f"Kavita answered HTTP {response.status_code}")
                content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
                if content_type not in COVER_TYPES:
                    raise KavitaNoCover()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body += chunk
                    if len(body) > COVER_MAX_BYTES:
                        raise KavitaNoCover()
    except httpx.HTTPError:             # its message would carry the key in the URL
        raise KavitaUnavailable("Kavita did not answer") from None
    return bytes(body), content_type
