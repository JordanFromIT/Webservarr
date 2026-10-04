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
USER_PAGE_SIZE = 200
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


async def _answer_as_user(client: httpx.AsyncClient, base: str, token: str, method: str, path: str, **kwargs):
    """(the JSON answer, its headers) to a call made with the person's token;
    (None, headers) for a 404 (what they asked about is not there),
    KavitaTokenRefused for a 401."""
    try:
        response = await client.request(method, f"{base}{path}", headers={"Authorization": f"Bearer {token}"},
                                        **kwargs)
    except httpx.HTTPError as exc:
        raise KavitaUnavailable("Kavita did not answer") from exc
    if response.status_code == 401:
        raise KavitaTokenRefused("Kavita no longer accepts this sign-in")
    if response.status_code == 404:
        return None, response.headers
    if response.status_code != 200:
        raise KavitaUnavailable(f"Kavita answered HTTP {response.status_code}")
    try:
        return response.json(), response.headers
    except ValueError as exc:
        raise KavitaUnavailable("Kavita's answer could not be read") from exc


async def _as_user(client: httpx.AsyncClient, base: str, token: str, method: str, path: str, **kwargs):
    return (await _answer_as_user(client, base, token, method, path, **kwargs))[0]


def _whole(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


async def _series_ids_as_user(client: httpx.AsyncClient, base: str, token: str, statements: list) -> list:
    """The ids of every series Kavita lists for this person under the filter,
    all pages. Kavita applies the person's own library access and age
    restriction to the list, so it holds nothing they may not see."""
    body = {"statements": statements, "combination": 1, "limitTo": 0,
            "sortOptions": {"sortField": 1, "isAscending": True}}
    found: list = []
    for page in range(1, MAX_PAGES + 1):
        items, headers = await _answer_as_user(client, base, token, "POST", "/api/Series/all-v2", json=body,
                                               params={"PageNumber": page, "PageSize": USER_PAGE_SIZE})
        if not isinstance(items, list):
            raise KavitaUnavailable("Kavita's answer could not be read")
        found.extend(s["id"] for s in items if isinstance(s, dict) and isinstance(s.get("id"), int))
        try:
            pages = int(json.loads(headers.get("pagination") or "{}").get("totalPages") or 1)
        except (ValueError, TypeError, AttributeError):
            pages = 1
        if page >= pages or not items:
            return found
    raise KavitaUnavailable("Kavita's list is too long to read")


async def user_series_ids(base: str, token: str) -> set:
    """The ids of the Kavita series this person's own account may see: the
    libraries it reaches, less what its age restriction hides."""
    async with _user_client() as client:
        return set(await _series_ids_as_user(client, base, token, []))


MAX_SCANS = 20                 # libraries asked to scan in one go


async def scan_libraries() -> int:
    """Ask Kavita to scan its libraries for new and changed files (not a forced
    rescan), as the account the API key belongs to, which must be an admin.
    Returns how many libraries were asked. Kavita does the scanning in its own
    time: this only queues it. Every failure is a KavitaUnavailable with a
    fixed sentence."""
    base, key = _config()
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
        headers = {"Authorization": f"Bearer {await _token(client, base, key)}"}
        libraries, _ = await _get_json(client, "GET", f"{base}/api/Library/libraries", headers)
        ids = [lib["id"] for lib in libraries if isinstance(lib, dict) and isinstance(lib.get("id"), int)] \
            if isinstance(libraries, list) else []
        asked = 0
        for library_id in ids[:MAX_SCANS]:
            try:
                response = await client.post(f"{base}/api/Library/scan", headers=headers,
                                             params={"libraryId": library_id, "force": "false"})
            except httpx.HTTPError as exc:
                raise KavitaUnavailable("Kavita did not answer") from exc
            if response.status_code in (401, 403):
                raise KavitaUnavailable("Kavita refused the scan: the key's account is not an admin")
            if response.status_code not in (200, 204):
                raise KavitaUnavailable(f"Kavita answered HTTP {response.status_code}")
            asked += 1
        return asked


async def _series_of(client: httpx.AsyncClient, base: str, token: str, kind: str, item_id: int) -> Optional[int]:
    """The series a chapter or a volume is in, as Kavita names it (a number is
    all that is taken from the answer); a series is its own. None when Kavita
    does not know it. KavitaTokenRefused for a 401, KavitaUnavailable for a
    server error or no answer."""
    if kind == "series":
        return item_id
    if kind == "chapter":
        path, params = f"/api/Book/{int(item_id)}/book-info", None
    elif kind == "volume":
        path, params = "/api/Series/volume", {"volumeId": int(item_id)}
    else:
        return None
    try:
        response = await client.get(f"{base}{path}", params=params, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as exc:
        raise KavitaUnavailable("Kavita did not answer") from exc
    if response.status_code == 401:
        raise KavitaTokenRefused("Kavita no longer accepts this sign-in")
    if response.status_code >= 500:
        raise KavitaUnavailable(f"Kavita answered HTTP {response.status_code}")
    if response.status_code != 200:
        return None
    try:
        series_id = (response.json() or {}).get("seriesId")
    except (ValueError, AttributeError):
        return None
    return series_id if isinstance(series_id, int) and not isinstance(series_id, bool) else None


async def items_are_visible(base: str, token: str, items) -> bool:
    """True when the person's own account may see the series of every item.

    items: [(kind, id, known_series_id)], kind "series", "chapter" or "volume".
    Kavita does not check library access on its book, chapter, volume, image and
    download endpoints, so the proxy asks here first. A series comes from the
    catalog when it knows the item (known_series_id), else from Kavita (see
    _series_of); each is then looked for in the list Kavita gives this person,
    which holds only what their library access and age restriction allow (read
    once for all the items). An item Kavita does not know is not visible.
    KavitaTokenRefused for a 401, KavitaUnavailable when Kavita is not answering."""
    async with _user_client() as client:
        wanted = set()
        for kind, item_id, known in items:
            series_id = known if known is not None else await _series_of(client, base, token, kind, item_id)
            if series_id is None:
                return False
            wanted.add(series_id)
        if not wanted:
            return True
        return wanted <= set(await _series_ids_as_user(client, base, token, []))


async def chapter_is_visible(base: str, token: str, chapter_id: int, known_series_id: Optional[int] = None) -> bool:
    """items_are_visible for one chapter."""
    return await items_are_visible(base, token, [("chapter", chapter_id, known_series_id)])


async def in_progress_series_ids(base: str, token: str) -> list:
    """The ids of the series this person has started and not finished, as
    Kavita counts it for them, all of them."""
    async with _user_client() as client:
        return await _series_ids_as_user(client, base, token, [
            {"comparison": COMPARE_GREATER_THAN, "field": FILTER_READ_PROGRESS, "value": "0"},
            {"comparison": COMPARE_LESS_THAN, "field": FILTER_READ_PROGRESS, "value": str(FINISHED_FROM)}])


async def reading_stats(base: str, token: str) -> dict:
    """This person's own reading totals, as Kavita counts them for them:
    {"pages", "words", "hours"}. Their account id comes from their own
    account (/api/Account, of which only the id is read), and Kavita answers
    only for that id with their token."""
    async with _user_client() as client:
        account = await _as_user(client, base, token, "GET", "/api/Account")
        user_id = account.get("id") if isinstance(account, dict) else None
        if not isinstance(user_id, int) or isinstance(user_id, bool):
            raise KavitaUnavailable("Kavita's answer could not be read")
        stats = await _as_user(client, base, token, "GET", "/api/Stats/user-read", params={"userId": user_id})
    if not isinstance(stats, dict):
        raise KavitaUnavailable("Kavita's answer could not be read")
    return {"pages": _whole(stats.get("totalPagesRead")), "words": _whole(stats.get("totalWordsRead")),
            "hours": _whole(stats.get("timeSpentReading"))}


def _volume_place(chapters: list, progress: list) -> Optional[dict]:
    """One place for a whole volume: the pages read and the pages in all its
    chapters (a finished chapter counts whole), when they last read it, and the
    chapter they were last in (`toc_chapter`) at its page (`toc_page`). None
    when they have not started any of it."""
    read = total = 0
    last = None
    for chapter, (page, at) in zip(chapters, progress):
        pages = chapter["pages"]
        total += pages
        if page <= 0:
            continue
        read += pages if pages > 0 and page + 1 >= pages else page
        if last is None or (at or datetime.min) >= (last[1] or datetime.min):
            last = (chapter["id"], at, page)
    if last is None:
        return None
    return {"page": read, "pages": total, "at": last[1], "toc_chapter": last[0], "toc_page": last[2]}


async def book_places(base: str, token: str, books) -> dict:
    """This person's place in each book they have started: {the book's chapter
    id: {"page", "pages", "at" (naive UTC or None), "toc_chapter", "toc_page"}}.
    `books` are (chapter id, volume id or None). A numbered volume is read
    whole: its pages read and its pages in all its chapters, a volume being one
    book whatever files it comes in. A book not in a numbered volume is its one
    chapter. A book with no place, or that Kavita no longer has, is left
    out."""
    wanted = list(dict.fromkeys(books))
    gate = asyncio.Semaphore(USER_CONCURRENCY)
    places: dict = {}
    async with _user_client() as client:
        async def ask(path: str, **params):
            async with gate:
                return await _as_user(client, base, token, "GET", path, params=params)

        async def progress_of(chapter_id: int) -> tuple:
            progress = await ask("/api/Reader/get-progress", chapterId=chapter_id)
            if not isinstance(progress, dict):
                return 0, None
            return _whole(progress.get("pageNum")), _when(progress.get("lastModifiedUtc"))

        async def read(chapter_id: int, volume_id: Optional[int]) -> None:
            volume = await ask("/api/Series/volume", volumeId=volume_id) if volume_id else None
            chapters = [{"id": c["id"], "pages": _whole(c.get("pages"))} for c in
                        (volume.get("chapters") if isinstance(volume, dict) else None) or []
                        if isinstance(c, dict) and isinstance(c.get("id"), int)]
            if volume_id and chapters:
                found = _volume_place(chapters, await asyncio.gather(*(progress_of(c["id"]) for c in chapters)))
                if found:
                    places[chapter_id] = found
                return
            page, at = await progress_of(chapter_id)
            if page <= 0:
                return
            chapter = await ask("/api/Series/chapter", chapterId=chapter_id)
            places[chapter_id] = {"page": page, "pages": _whole(chapter.get("pages")) if isinstance(chapter, dict) else 0,
                                  "at": at, "toc_chapter": chapter_id, "toc_page": page}

        results = await asyncio.gather(*(read(c, v) for c, v in wanted), return_exceptions=True)
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


class KavitaRefused(KavitaUnavailable):
    """Kavita answered, and said no (a 400, 403 or 404): the same write will
    not do better by being sent again soon."""


async def rate_chapter(base: str, token: str, series_id: int, chapter_id: int, stars: int) -> None:
    """Set this person's rating of a book (its chapter, the one the catalog
    keeps; Kavita's own volume page rates the same one) to `stars`, 1 to 5,
    or clear it with 0, Kavita's "not rated". Made with their own token, so
    it is their rating. KavitaTokenRefused for a 401, KavitaRefused when
    Kavita says no, KavitaUnavailable when it does not answer."""
    body = {"seriesId": int(series_id), "chapterId": int(chapter_id), "userRating": int(stars)}
    try:
        async with _user_client() as client:
            response = await client.post(f"{base}/api/rating/chapter", json=body,
                                         headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as exc:
        raise KavitaUnavailable("Kavita did not answer") from exc
    if response.status_code == 401:
        raise KavitaTokenRefused("Kavita no longer accepts this sign-in")
    if response.status_code in (400, 403, 404):
        raise KavitaRefused(f"Kavita refused the rating (HTTP {response.status_code})")
    if response.status_code not in (200, 204):
        raise KavitaUnavailable(f"Kavita answered HTTP {response.status_code}")


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
