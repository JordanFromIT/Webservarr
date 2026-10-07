"""
Chaptarr book acquisition integration.

Chaptarr is the *arr for books - it searches indexers and downloads, the way
Radarr does for films. WebServarr uses it for the request flow only; the
reading side goes through Kavita.

Two things worth knowing, both established by testing against the live instance:

1. Chaptarr's default metadata provider is broken. `/api/v1/search?term=x`
   returns 503 "Hardcover search failed". Passing `provider=goodreads` works.
   googlebooks, google, openlibrary, bookinfo and isbndb all return 200 with an
   empty array, so goodreads must be passed explicitly.

2. Search results do not report format availability. `mediaType` comes back as
   "audiobook" for every result, `availableNarrators` is always empty, and the
   top-level ownership fields (`localBookId`, `hasFiles`, `monitored`) stay
   empty even for books already in the library. So results are surfaced simply
   as "eBook" rather than claiming to know which editions exist.

   Where a book stands in the library is carried instead by `localEbookBooks`
   and `localAudiobookBooks`: the library's own rows for that work, one list
   per format, each with `monitored` and `hasFiles`. See _format_status.
"""

import asyncio
import json
import logging
import re
from html import unescape
from typing import Any, Dict, List, Optional

import bleach
import httpx
import redis.asyncio as aioredis

from app.config import settings
from app.database import SessionLocal
from app.integrations import config as integration_config
from app.integrations import openlibrary
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 15.0

# The only provider that returns results; see module docstring.
SEARCH_PROVIDER = "goodreads"

# How many trending titles to resolve at once. Each is a Goodreads round trip
# made on Chaptarr's behalf, and it degrades badly under a full shelf at once.
_RESOLVE_CONCURRENCY = 5


def _get_config() -> dict:
    """Read Chaptarr config from the settings table (short-lived session)."""
    db = SessionLocal()
    try:
        def _val(key: str) -> Optional[str]:
            row = db.query(Setting).filter(Setting.key == key).first()
            return row.value if row and row.value else None

        # Address and key through the reader the Settings status light uses.
        conn = {k: _val(k) for k in (integration_config.url_key("chaptarr"),
                                     integration_config.CREDENTIAL_KEYS["chaptarr"])}
        return {
            "url": integration_config.base_url("chaptarr", conn),
            "api_key": integration_config.credential("chaptarr", conn),
            "root_folder": _val("integration.chaptarr.root_folder") or "",
            "quality_profile_id": _val("integration.chaptarr.quality_profile_id") or "1",
            "metadata_profile_id": _val("integration.chaptarr.metadata_profile_id") or "2",
            # Chaptarr keeps audiobooks in their own root folder with their own
            # profiles, so an audiobook request is the same call with a
            # different trio. Defaults match a stock Chaptarr install.
            "audiobook_root_folder": _val("integration.chaptarr.audiobook_root_folder") or "",
            "audiobook_quality_profile_id": _val("integration.chaptarr.audiobook_quality_profile_id") or "2",
            "audiobook_metadata_profile_id": _val("integration.chaptarr.audiobook_metadata_profile_id") or "1",
        }
    finally:
        db.close()


def _headers(cfg: dict) -> dict:
    return {"X-Api-Key": cfg["api_key"], "Content-Type": "application/json"}


def _plain_text(value: Any) -> str:
    """
    Flatten a Goodreads description to plain text.

    The overviews come back as HTML - "<b>A riveting account...</b><br/><br/>" -
    and the pages set descriptions with textContent, so the markup was being
    displayed literally, tags and all. Stripping here rather than in the browser
    keeps the API returning what it claims to return: text.

    Block breaks become spaces rather than vanishing, so sentences either side
    of a paragraph break do not run together.
    """
    if not value or not isinstance(value, str):
        return ""
    spaced = re.sub(r"(?i)<\s*(br|/p|/div|/li)\s*/?\s*>", " ", value)
    stripped = bleach.clean(spaced, tags=[], attributes={}, strip=True)
    # bleach escapes what it leaves behind, so &amp; and friends come back out.
    return re.sub(r"\s+", " ", unescape(stripped)).strip()


def _poster_from(images: Any) -> Optional[str]:
    """
    Return a cover URL the browser can actually load, or None.

    Chaptarr's search results only carry relative /MediaCoverProxy/<hash>.jpg
    paths, and that endpoint sits behind Chaptarr's *Forms UI login* rather than
    its API key — it answers 401 with the key and 302s to /login without it. So
    those covers cannot be fetched server-side without adding Chaptarr UI
    credentials, which is not worth a thumbnail.

    Book cards fall back to a placeholder glyph. If a build ever supplies a real
    remoteUrl, it is used.
    """
    if not isinstance(images, list):
        return None
    for img in images:
        if isinstance(img, dict):
            remote = img.get("remoteUrl")
            if remote and remote.startswith(("http://", "https://")):
                return remote
    return None


# Re-searching Chaptarr by foreignId at request time (see _lookup_book) only
# round-trips to the same book about half the time - Chaptarr's search is a
# fuzzy text match, not an id lookup, so the raw id string doesn't reliably
# find its own book again. Instead, every book object Chaptarr hands back is
# kept here, keyed by foreignId, so a request can reuse the exact object the
# user already saw instead of gambling on a second search.
#
# Redis rather than an in-process dict: uvicorn runs multiple workers (see
# supervisord.conf), and a plain module-level cache is only visible to
# whichever worker happens to populate it - the request commonly lands on a
# different worker than the search that primed it.
_BOOK_CACHE_TTL = 3600
_book_cache_redis: Optional[aioredis.Redis] = None


def _redis() -> aioredis.Redis:
    global _book_cache_redis
    if _book_cache_redis is None:
        _book_cache_redis = aioredis.from_url(settings.redis_url)
    return _book_cache_redis


async def _cache_book(book_id: Optional[str], book: Dict[str, Any]) -> None:
    if not book_id:
        return
    await _redis().set(f"chaptarr:book:{book_id}", json.dumps(book), ex=_BOOK_CACHE_TTL)


async def _get_cached_book(book_id: str) -> Optional[Dict[str, Any]]:
    raw = await _redis().get(f"chaptarr:book:{book_id}")
    return json.loads(raw) if raw else None


def _format_status(local: Any) -> Optional[str]:
    """
    Where one format of a book stands in the library, in the words Seerr uses
    for the same states, so a book card is labelled like a film card.

    `local` is the search result's localEbookBooks or localAudiobookBooks: the
    library rows for this work in that format. A row with files means it is
    here ("available"); a monitored row without files means someone asked for
    it and Chaptarr is looking ("processing", which the page calls Requested).
    A row that is neither is not a request: adding an author imports every one
    of their books unmonitored, and most of those were never wanted, so they
    get no status rather than a claim that they are on the server.
    """
    rows = [r for r in local if isinstance(r, dict)] if isinstance(local, list) else []
    if any(r.get("hasFiles") for r in rows):
        return "available"
    if any(r.get("monitored") for r in rows):
        return "processing"
    return None


async def _normalise(result: Dict[str, Any], fmt: str = "ebook") -> Optional[Dict[str, Any]]:
    """
    Convert a Chaptarr search result into the shape the requests page already
    uses for Seerr items, so book cards render through the same code path.

    `fmt` ("ebook" or "audiobook") picks whose library status the card
    carries: a book can be on the server as an audiobook and still be
    requestable as an ebook.

    Author-type results are dropped: they are not directly requestable.
    """
    book = result.get("book")
    if not isinstance(book, dict):
        return None

    title = book.get("title")
    if not title:
        return None

    author = book.get("author") or {}
    author_name = author.get("authorName") or book.get("authorTitle") or ""

    year = None
    release = book.get("releaseDate") or ""
    if isinstance(release, str) and len(release) >= 4 and release[:4].isdigit():
        year = int(release[:4])

    # Not existingLocalId / localBookId: those say only that Chaptarr tracks
    # the work, and it tracks every book of an author it has added, wanted or
    # not, so "tracked" read as "available" labelled unrequested books as on
    # the server. The per-format rows say whether it is wanted and whether it
    # arrived.
    local_key = "localAudiobookBooks" if fmt == "audiobook" else "localEbookBooks"

    book_id = result.get("foreignId") or book.get("foreignBookId")
    await _cache_book(book_id, book)

    return {
        "id": book_id,
        "media_type": "book",
        "title": title,
        "author": author_name,
        "year": year,
        "poster_url": _poster_from(book.get("images")),
        "overview": _plain_text(book.get("overview")),
        "media_status": _format_status(book.get(local_key)),
        "rating": (book.get("ratings") or {}).get("value"),
        "votes": (book.get("ratings") or {}).get("votes") or 0,
    }


async def search(term: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Search Chaptarr for books. Returns [] when unconfigured or failing."""
    cfg = _get_config()
    if not cfg["url"] or not cfg["api_key"] or not term:
        return []

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{cfg['url']}/api/v1/search",
                params={"term": term, "provider": SEARCH_PROVIDER},
                headers={"X-Api-Key": cfg["api_key"]},
            )
    except httpx.RequestError as exc:
        logger.warning("Chaptarr search failed for %r: %s", term, exc)
        return []

    if resp.status_code != 200:
        logger.warning("Chaptarr search returned HTTP %d for %r", resp.status_code, term)
        return []

    try:
        raw = resp.json()
    except ValueError:
        return []

    items = []
    for result in raw if isinstance(raw, list) else []:
        norm = await _normalise(result)
        if norm and norm["id"]:
            items.append(norm)
        if len(items) >= limit:
            break

    # Most-rated first: with no relevance score, popularity is the best proxy
    # for "the edition the person actually meant".
    items.sort(key=lambda b: b.get("votes") or 0, reverse=True)

    await _attach_covers(items)
    return items


async def _attach_covers(items: List[Dict[str, Any]], budget: float = None) -> None:
    """
    Fill in cover art from Open Library for books that have none.

    Chaptarr's own covers are unreachable (see _poster_from). Failure here is
    silent by design: a book card without art is still perfectly usable.
    """
    needed = [(b["title"], b.get("author") or "") for b in items if not b.get("poster_url")]
    if not needed:
        return

    found = await openlibrary.cover_ids(
        needed, budget=budget or openlibrary.COVER_PHASE_BUDGET
    )
    for book in items:
        if book.get("poster_url"):
            continue
        cover_id = found.get((book["title"], book.get("author") or ""))
        if cover_id:
            book["poster_url"] = f"/api/integrations/book-cover?coverId={cover_id}"


def _main_title(title: str) -> str:
    """
    The part of a title before its subtitle.

    Real books carry long explanatory subtitles - "Atomic Habits: An Easy &
    Proven Way to Build Good Habits" - and judging the whole string against a
    bare trending title would punish the genuine edition for being descriptive.
    Everything from the first colon is dropped so only the name is compared.
    """
    return openlibrary.clean_title((title or "").split(":")[0])


def _title_score(wanted: str, candidate: str) -> float:
    """
    How well a Chaptarr result matches the title that was asked for, 0..1.

    Multiplies recall by precision deliberately. Recall alone would accept
    "Summary of Atomic Habits by James Clear" for "Atomic Habits", since it
    contains every wanted word; dividing by the candidate's own length as well
    penalises the padding. Against "Atomic Habits" the real edition scores 1.0,
    the workbook 0.67 and the summary 0.4.
    """
    want = openlibrary._tokens(_main_title(wanted))
    got = openlibrary._tokens(_main_title(candidate))
    if not want or not got:
        return 0.0
    shared = len(want & got)
    return (shared / len(want)) * (shared / len(got))


# A candidate by a different author than the one trending is almost always an
# unauthorised summary or companion rather than the book itself. Scaled down
# rather than excluded, since author metadata is often missing entirely.
_WRONG_AUTHOR_PENALTY = 0.2


def _match_score(entry: Dict[str, Any], candidate: Dict[str, Any]) -> float:
    score = _title_score(entry.get("title") or "", candidate.get("title") or "")
    want_author = openlibrary._tokens(entry.get("author") or "")
    got_author = openlibrary._tokens(candidate.get("author") or "")
    if want_author and got_author and not (want_author & got_author):
        score *= _WRONG_AUTHOR_PENALTY
    return score


async def resolve_trending(
    books: List[Dict[str, Any]], limit: int = 20, fmt: str = "ebook"
) -> List[Dict[str, Any]]:
    """
    Turn a list of {title, author, cover_id} into requestable book cards.

    `fmt` is the shelf's format, so each card's status is that format's (see
    _normalise).

    A trending shelf is only worth showing if its cards can be acted on, and a
    title from an outside source means nothing to Chaptarr on its own. Each one
    is looked up through Chaptarr so the card carries a real foreignId, and
    anything Chaptarr cannot find is dropped rather than shown as a dead tile.

    Covers come from the trending source, which already supplies them, so this
    avoids a second round of Open Library matching per book.
    """
    cfg = _get_config()
    if not cfg["url"] or not cfg["api_key"] or not books:
        return []

    async def _one(entry):
        # Title only. Adding the author makes Goodreads answer with author
        # records instead of books - searching "Atomic Habits James Clear"
        # returns five authors and no Atomic Habits, while "Atomic Habits"
        # returns the book. The author is used for ranking instead.
        term = entry.get("title") or ""
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
                resp = await client.get(
                    f"{cfg['url']}/api/v1/search",
                    params={"term": term, "provider": SEARCH_PROVIDER},
                    headers={"X-Api-Key": cfg["api_key"]},
                )
            if resp.status_code != 200:
                return None
            raw = resp.json()
        except (httpx.RequestError, ValueError):
            return None

        candidates = []
        for result in raw if isinstance(raw, list) else []:
            norm = await _normalise(result, fmt)
            if norm and norm["id"]:
                candidates.append(norm)
        if not candidates:
            return None

        # Best match, not first match. Goodreads ranks the unauthorised
        # "Summary of Atomic Habits by James Clear" cash-ins above Atomic
        # Habits itself, so taking the top hit fills the shelf with summaries
        # of the books people actually wanted.
        best = max(candidates, key=lambda b: (_match_score(entry, b), b.get("votes") or 0))
        if _match_score(entry, best) < 0.3:
            return None

        # Prefer the trending source's cover; it is already known good and
        # skips a per-book Open Library match.
        if entry.get("cover_id"):
            best["poster_url"] = f"/api/integrations/book-cover?coverId={entry['cover_id']}"
        return best

    # Chaptarr proxies each of these to Goodreads, and firing the whole shelf at
    # it at once makes it start failing: 24 simultaneous lookups returned 4
    # usable results in 15s, where the same shelf a few at a time returns nearly
    # all of them in a fraction of that. Concurrency is capped rather than
    # removed - serial would be far too slow.
    gate = asyncio.Semaphore(_RESOLVE_CONCURRENCY)

    async def _guarded(entry):
        async with gate:
            return await _one(entry)

    results = await asyncio.gather(
        *[_guarded(b) for b in books[:limit]], return_exceptions=True
    )
    cards = [r for r in results if isinstance(r, dict)]

    # Only some sources carry cover ids - Open Library does, the NYT lists do
    # not - so anything still without art gets looked up by title and author,
    # the same way search results do. Without this the audiobook shelf, which
    # is entirely NYT, renders as a row of placeholder glyphs.
    await _attach_covers(cards, budget=openlibrary.TRENDING_COVER_BUDGET)
    return cards


async def _lookup_book(cfg: dict, foreign_id: str) -> Optional[Dict[str, Any]]:
    """
    Re-fetch a book from Chaptarr by its foreign id.

    The add payload is the lookup result posted back augmented, which is how
    Chaptarr's own UI does it. Re-fetching server-side means the browser never
    supplies the object we send to Chaptarr.
    """
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{cfg['url']}/api/v1/search",
                params={"term": foreign_id, "provider": SEARCH_PROVIDER},
                headers={"X-Api-Key": cfg["api_key"]},
            )
    except httpx.RequestError as exc:
        logger.warning("Chaptarr lookup failed for %s: %s", foreign_id, exc)
        return None

    if resp.status_code != 200:
        return None

    try:
        raw = resp.json()
    except ValueError:
        return None

    for result in raw if isinstance(raw, list) else []:
        if result.get("foreignId") == foreign_id:
            return result.get("book")
    return None


async def request_book(foreign_id: str, fmt: str = "ebook") -> Dict[str, Any]:
    """
    Add a book to Chaptarr and start searching for it.

    `fmt` is "ebook" or "audiobook" and selects which root folder and profile
    pair the request lands in - Chaptarr keeps the two apart, so requesting an
    audiobook into the ebook folder would download the wrong edition.

    Returns {"ok": bool, "message": str}.
    """
    cfg = _get_config()
    if not cfg["url"] or not cfg["api_key"]:
        return {"ok": False, "message": "Chaptarr is not configured"}

    audiobook = fmt == "audiobook"
    prefix = "audiobook_" if audiobook else ""
    root_folder = cfg[f"{prefix}root_folder"]
    if not root_folder:
        label = "audiobook" if audiobook else "book"
        return {"ok": False, "message": f"No Chaptarr {label} root folder configured"}

    book = await _get_cached_book(foreign_id)
    if not book:
        book = await _lookup_book(cfg, foreign_id)
    if not book:
        return {"ok": False, "message": "Could not find that book in Chaptarr"}

    # A book from a brand-new author arrives with an author record that has
    # no profiles or root folders of its own (it isn't tracked yet), and
    # Chaptarr validates the author, not just the book, when adding one.
    # Real author records (confirmed against /api/v1/author) carry the
    # ebook/audiobook pair of quality+metadata profiles and root folders
    # side by side - not the generic "qualityProfileId"/"rootFolderPath"
    # a book itself uses - and Chaptarr rejects the add if either half of
    # the pair is missing, even when only one format is being requested.
    # "none"/False in addOptions so the add pulls in just this book, not
    # the author's whole back catalogue.
    author = dict(book.get("author") or {})
    author.update({
        "monitored": True,
        "ebookQualityProfileId": int(cfg["quality_profile_id"]),
        "ebookMetadataProfileId": int(cfg["metadata_profile_id"]),
        "ebookRootFolderPath": cfg["root_folder"],
        "audiobookQualityProfileId": int(cfg["audiobook_quality_profile_id"]),
        "audiobookMetadataProfileId": int(cfg["audiobook_metadata_profile_id"]),
        "audiobookRootFolderPath": cfg["audiobook_root_folder"],
        "addOptions": {"monitor": "none", "searchForMissingBooks": False},
    })

    # The requested format has to be stated outright. Chaptarr decides which
    # edition to monitor and grab from `mediaType` in the payload, not from
    # the root folder, and every search result arrives carrying
    # "audiobook" (see the module docstring) - so copying the book through
    # unchanged silently turned every ebook request into an audiobook one.
    payload = dict(book)
    payload.update({
        "monitored": True,
        "mediaType": fmt,
        "rootFolderPath": root_folder,
        "author": author,
        "addOptions": {"searchForNewBook": True},
    })

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.post(
                f"{cfg['url']}/api/v1/book",
                headers=_headers(cfg),
                json=payload,
            )
    except httpx.RequestError as exc:
        logger.warning("Chaptarr add failed for %s: %s", foreign_id, exc)
        return {"ok": False, "message": "Could not reach Chaptarr"}

    if resp.status_code in (200, 201):
        return {"ok": True, "message": "Book requested"}

    # Chaptarr returns a list of validation errors on rejection.
    detail = ""
    try:
        body = resp.json()
        if isinstance(body, list) and body:
            detail = body[0].get("errorMessage") or body[0].get("message") or ""
        elif isinstance(body, dict):
            detail = body.get("message") or body.get("errorMessage") or ""
    except ValueError:
        detail = resp.text[:160]

    logger.warning("Chaptarr add returned HTTP %d: %s", resp.status_code, detail)
    if resp.status_code == 400 and "already" in detail.lower():
        return {"ok": True, "message": "Already in your library"}
    return {"ok": False, "message": detail or f"Chaptarr rejected the request ({resp.status_code})"}


async def library_summary() -> dict:
    """
    Shape of the book library: {books, ebooks, audiobooks, bytes}.

    Totals come from the author records, because Chaptarr leaves the per-book
    statistics at zero - summing books reports an empty library.

    The count is `availableBookCount`, NOT `bookFileCount`. The latter counts
    files: 1,608 of them against 127 actual books, because an audiobook is
    stored as one file per chapter and an ebook often exists in several
    formats. Reporting files as books overstated the library twelvefold.

    Ebooks and audiobooks are told apart by which root folder their files sit
    in, the author records carrying no rootFolderPath.
    """
    cfg = _get_config()
    empty = {"books": 0, "ebooks": 0, "audiobooks": 0, "bytes": 0}
    if not cfg["url"] or not cfg["api_key"]:
        return empty

    try:
        async with httpx.AsyncClient(timeout=30.0, verify=False) as client:
            resp = await client.get(
                f"{cfg['url']}/api/v1/author", headers={"X-Api-Key": cfg["api_key"]}
            )
        if resp.status_code != 200:
            return empty
        authors = resp.json()
    except (httpx.RequestError, ValueError) as exc:
        logger.warning("Chaptarr library summary failed: %s", exc)
        return empty

    ebooks, audiobooks = set(), set()
    for entry in await _book_files():
        book_id, path = entry.get("bookId"), entry.get("path") or ""
        if not book_id:
            continue
        if "/audiobooks" in path:
            audiobooks.add(book_id)
        elif "/ebooks" in path:
            ebooks.add(book_id)

    return {
        "books": sum((a.get("statistics") or {}).get("availableBookCount", 0) for a in authors),
        "ebooks": len(ebooks),
        "audiobooks": len(audiobooks),
        "bytes": sum((a.get("statistics") or {}).get("sizeOnDisk", 0) for a in authors),
    }


class ChaptarrUnavailable(Exception):
    """Chaptarr is configured but could not be read."""


async def wanted_books() -> Optional[Dict[str, Any]]:
    """
    The book list and the download queue, for "where requests stand".

    GET only. A request made here adds the book to Chaptarr monitored and
    searches for it (request_book); nothing else records it, so Chaptarr's
    own book list is where a book request lives. Returns None when Chaptarr
    is not configured, {"books": [...], "queue": [...]} otherwise, and raises
    ChaptarrUnavailable when the book list cannot be read. The queue only
    sharpens the status words and the authors only name the rows, so either
    one failing comes back empty. Also returns "authors": {author id: name}.
    """
    cfg = _get_config()
    if not cfg["url"] or not cfg["api_key"]:
        return None

    headers = {"X-Api-Key": cfg["api_key"]}
    try:
        async with httpx.AsyncClient(timeout=30.0, verify=False) as client:
            resp = await client.get(f"{cfg['url']}/api/v1/book", headers=headers)
            if resp.status_code != 200:
                raise ChaptarrUnavailable(f"book list returned HTTP {resp.status_code}")
            books = resp.json()
            if not isinstance(books, list):
                raise ChaptarrUnavailable("book list was not a list")
            queue: List[Dict[str, Any]] = []
            try:
                q = await client.get(
                    f"{cfg['url']}/api/v1/queue",
                    params={"page": 1, "pageSize": 500, "includeBook": "false"},
                    headers=headers,
                )
                if q.status_code == 200:
                    body = q.json()
                    records = body.get("records") if isinstance(body, dict) else body
                    queue = [r for r in records or [] if isinstance(r, dict)]
            except (httpx.RequestError, ValueError) as exc:
                logger.info("Chaptarr queue unavailable, statuses from the book list only: %s", exc)
            # The book list carries only authorId (and a sort key such as
            # "twain, mark The Adventures..."), so names come from the
            # authors. Missing names just leave the line under the title out.
            authors: Dict[Any, str] = {}
            try:
                a = await client.get(f"{cfg['url']}/api/v1/author", headers=headers)
                if a.status_code == 200:
                    authors = {
                        x.get("id"): x.get("authorName") or ""
                        for x in a.json() if isinstance(x, dict)
                    }
            except (httpx.RequestError, ValueError, TypeError) as exc:
                logger.info("Chaptarr authors unavailable, book rows without names: %s", exc)
    except httpx.RequestError as exc:
        raise ChaptarrUnavailable(f"could not reach Chaptarr: {type(exc).__name__}") from exc
    except ValueError as exc:
        raise ChaptarrUnavailable("book list was not JSON") from exc

    return {"books": [b for b in books if isinstance(b, dict)], "queue": queue, "authors": authors}


async def _book_files() -> List[Dict[str, Any]]:
    """
    Every book file Chaptarr holds, with its book id, path and date.

    The bookfile endpoint refuses an unfiltered listing ("authorId, bookId,
    bookFileIds or unmapped must be provided"), so files are gathered per
    author and stitched back together. One call per author, twelve authors.
    """
    cfg = _get_config()
    if not cfg["url"] or not cfg["api_key"]:
        return []

    headers = {"X-Api-Key": cfg["api_key"]}
    files: List[Dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=60.0, verify=False) as client:
            authors = await client.get(f"{cfg['url']}/api/v1/author", headers=headers)
            if authors.status_code != 200:
                return []
            for author in authors.json():
                resp = await client.get(
                    f"{cfg['url']}/api/v1/bookfile",
                    params={"authorId": author.get("id")},
                    headers=headers,
                )
                if resp.status_code == 200:
                    files.extend(resp.json())
    except (httpx.RequestError, ValueError) as exc:
        logger.warning("Chaptarr book files failed: %s", exc)
        return []
    return files


# Ratings barely move and a detail sheet is opened repeatedly, so they are held
# for a day. Keyed by the title+author that was asked for.
_RATING_TTL = 86400.0
_rating_cache: Dict[str, Any] = {}


async def book_rating(title: str, author: str = "") -> Dict[str, Any]:
    """
    Goodreads rating for a book, via Chaptarr's metadata provider.

    Deliberately NOT chaptarr.search(): that also resolves cover art through
    Open Library, which costs seconds and is pointless here - the detail sheet
    already has Kavita's own cover.

    Returns {rating, votes} or {} when there is no confident match. A wrong
    rating is worse than none, so the same title scoring used elsewhere applies
    and a weak best match is discarded.
    """
    import time as _time

    key = (title or "").strip().lower() + "|" + (author or "").strip().lower()
    hit = _rating_cache.get(key)
    if hit and (_time.monotonic() - hit[0]) < _RATING_TTL:
        return hit[1]

    cfg = _get_config()
    if not cfg["url"] or not cfg["api_key"] or not title:
        return {}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{cfg['url']}/api/v1/search",
                params={"term": title, "provider": SEARCH_PROVIDER},
                headers={"X-Api-Key": cfg["api_key"]},
            )
        if resp.status_code != 200:
            return {}
        raw = resp.json()
    except (httpx.RequestError, ValueError) as exc:
        logger.warning("Chaptarr rating lookup failed for %r: %s", title, exc)
        return {}

    entry = {"title": title, "author": author}
    best, best_score = None, 0.0
    for result in raw if isinstance(raw, list) else []:
        norm = await _normalise(result)
        if not norm:
            continue
        score = _match_score(entry, norm)
        if score > best_score:
            best, best_score = norm, score

    out: Dict[str, Any] = {}
    if best and best_score >= 0.3 and best.get("rating"):
        out = {
            "rating": round(float(best["rating"]), 2),
            "votes": best.get("votes") or 0,
            "source": "Goodreads",
        }

    _rating_cache[key] = (_time.monotonic(), out)
    return out


async def recent_requests(limit: int = 10) -> List[Dict[str, Any]]:
    """
    Recently acquired books, shaped like Seerr's recent requests.

    Without this the home page's Recent Requests panel reads Seerr only, so
    someone who requests an ebook sees no trace of it anywhere - the request
    succeeds and the site never mentions it again.

    Dated from the file rather than the book: Chaptarr book records carry only
    a releaseDate, which is when the book was published, not when anyone here
    asked for it. The file's dateAdded is when it actually arrived.
    """
    files = await _book_files()
    if not files:
        return []

    cfg = _get_config()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{cfg['url']}/api/v1/book", headers={"X-Api-Key": cfg["api_key"]}
            )
        titles = {
            b.get("id"): b
            for b in (resp.json() if resp.status_code == 200 else [])
            if isinstance(b, dict)
        }
    except (httpx.RequestError, ValueError):
        titles = {}

    # One entry per book, dated by its earliest file - an audiobook arrives as
    # hundreds of chapter files and would otherwise flood the panel.
    first_seen: Dict[Any, Dict[str, Any]] = {}
    for entry in files:
        book_id, added = entry.get("bookId"), entry.get("dateAdded")
        if not book_id or not added:
            continue
        current = first_seen.get(book_id)
        if not current or added < current["added"]:
            first_seen[book_id] = {"added": added, "path": entry.get("path") or ""}

    ordered = sorted(first_seen.items(), key=lambda kv: kv[1]["added"], reverse=True)

    out = []
    for book_id, info in ordered[:limit]:
        book = titles.get(book_id) or {}
        author = book.get("author") or {}
        out.append({
            "id": book_id,
            "media_title": book.get("title") or "Unknown",
            "media_type": "audiobook" if "/audiobooks" in info["path"] else "book",
            "poster_url": "",
            "author": author.get("authorName") or book.get("authorTitle") or "",
            "status": "available",
            "requested_date": info["added"],
            "updated_date": info["added"],
        })
    return out


async def test_connection() -> tuple:
    """Return (ok, message) for the admin test-connection UI."""
    cfg = _get_config()
    if not cfg["url"]:
        return False, "Chaptarr URL is not configured"
    if not cfg["api_key"]:
        return False, "Chaptarr API key is not configured"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            resp = await client.get(
                f"{cfg['url']}/api/v1/rootfolder", headers={"X-Api-Key": cfg["api_key"]}
            )
    except httpx.RequestError as exc:
        return False, f"Could not reach Chaptarr: {exc}"

    if resp.status_code != 200:
        return False, f"Chaptarr returned HTTP {resp.status_code}"
    folders = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else []
    names = ", ".join(f.get("path", "?") for f in folders) if isinstance(folders, list) else ""
    return True, f"Connected. Root folders: {names or 'none configured'}"
