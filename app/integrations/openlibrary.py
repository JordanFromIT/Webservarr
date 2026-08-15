"""
Open Library cover lookup.

Chaptarr cannot supply cover art for search results: it only returns relative
/MediaCoverProxy/ paths, and that endpoint sits behind its Forms UI login
(401 with the API key, 302 to /login without it). Open Library fills the gap.

Chosen over Google Books, which returns HTTP 429 "Quota exceeded" on the shared
unauthenticated tier and would need an API key to be usable at all.

This is the one external dependency in the ebook stack, and it is deliberately
kept shallow:

- Only cover art. No metadata, no titles, nothing the reader depends on.
- Covers are fetched by the server and proxied, so users' browsers never
  contact Open Library.
- Every failure path returns "no cover" rather than an error. If Open Library
  is slow or down, book cards simply show a glyph.
"""

import asyncio
import re
import logging
from typing import Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

SEARCH_URL = "https://openlibrary.org/search.json"
COVER_URL = "https://covers.openlibrary.org/b/id/{cover_id}-M.jpg"

# Short: covers are a nicety and must never hold up a search.
LOOKUP_TIMEOUT = 6.0
IMAGE_TIMEOUT = 10.0

# Bounded in-process caches. Covers effectively never change, and a search
# repeats the same titles constantly.
_MAX_CACHE = 500
_id_cache: Dict[Tuple[str, str], Optional[int]] = {}
_image_cache: Dict[int, Tuple[bytes, str]] = {}


def _trim(cache: dict) -> None:
    """Keep a cache bounded without pulling in an LRU dependency."""
    while len(cache) > _MAX_CACHE:
        cache.pop(next(iter(cache)))


def clean_title(title: str) -> str:
    """
    Strip series and edition decoration from a book title.

    Chaptarr titles carry a trailing series marker - "The Midnight Library (The
    Midnight Library, #1)", "Horus Rising (The Horus Heresy, #1)" - which Open
    Library will not match. Removing it is the difference between a cover and a
    placeholder for most results.
    """
    cleaned = re.sub(r"\s*[\(\[][^()\[\]]*[\)\]]\s*$", "", title).strip()
    # Also drop a trailing ", #3" style volume marker.
    cleaned = re.sub(r",\s*#\d+\s*$", "", cleaned).strip()
    return cleaned or title.strip()


def _tokens(text: str) -> set:
    return {t for t in re.split(r"[^a-z0-9]+", (text or "").lower()) if len(t) > 2}


def _best_match(docs: list, title: str, author: str) -> Optional[int]:
    """
    Pick the best candidate, or none.

    The loose query is what makes obscure editions findable, but it also returns
    near-misses: searching "Three Past Midnight: The Library Policeman" ranks
    "Four Past Midnight" first, which is a different book. Taking the top hit
    would put the wrong cover on the card, so candidates are scored and a weak
    best match is rejected outright.
    """
    want_title = _tokens(clean_title(title))
    want_author = _tokens(author)
    if not want_title:
        return None

    best_id, best_score = None, 0.0
    for doc in docs:
        cover_id = doc.get("cover_i")
        if not isinstance(cover_id, int):
            continue

        got_title = _tokens(doc.get("title") or "")
        if not got_title:
            continue

        # Overlap relative to the shorter title, so an edition subtitle on
        # either side does not sink an otherwise exact match.
        overlap = len(want_title & got_title) / min(len(want_title), len(got_title))

        if want_author:
            got_author = _tokens(" ".join(doc.get("author_name") or []))
            # A named author that does not match at all is disqualifying - this
            # is what stops a same-titled book by someone else being used.
            if got_author and not (want_author & got_author):
                continue

        if overlap > best_score:
            best_id, best_score = cover_id, overlap

    # Below this the match is a guess rather than a find.
    return best_id if best_score >= 0.6 else None


async def _lookup_one(client: httpx.AsyncClient, title: str, author: str) -> Optional[int]:
    search_title = clean_title(title)
    key = (search_title.lower(), (author or "").lower().strip())
    if key in _id_cache:
        return _id_cache[key]

    cover_id = None
    fields = "title,author_name,cover_i"

    # Exact-ish first: title and author as separate fields.
    attempts = [{"title": search_title, "limit": 3, "fields": fields}]
    if author:
        attempts[0]["author"] = author
        # Then a loose full-text query, which finds editions the field search
        # misses. Scoring in _best_match keeps it from guessing.
        attempts.append({"q": f"{search_title} {author}", "limit": 5, "fields": fields})

    for params in attempts:
        try:
            resp = await client.get(SEARCH_URL, params=params)
            if resp.status_code != 200:
                continue
            docs = (resp.json() or {}).get("docs") or []
        except (httpx.RequestError, ValueError):
            continue
        cover_id = _best_match(docs, title, author)
        if cover_id:
            break

    _id_cache[key] = cover_id
    _trim(_id_cache)
    return cover_id


async def cover_ids(books: List[Tuple[str, str]]) -> Dict[Tuple[str, str], int]:
    """
    Look up Open Library cover ids for (title, author) pairs.

    Runs concurrently — serially this would add seconds to every search. Books
    with no match are simply absent from the result.
    """
    if not books:
        return {}

    try:
        async with httpx.AsyncClient(timeout=LOOKUP_TIMEOUT) as client:
            results = await asyncio.gather(
                *[_lookup_one(client, t, a) for t, a in books],
                return_exceptions=True,
            )
    except Exception as exc:  # noqa: BLE001 - covers must never break search
        logger.warning("Open Library lookup failed: %s", exc)
        return {}

    found = {}
    for (title, author), cover_id in zip(books, results):
        if isinstance(cover_id, int):
            found[(title, author)] = cover_id
    return found


async def fetch_cover(cover_id: int) -> Optional[Tuple[bytes, str]]:
    """Fetch a cover image by id. Returns (bytes, content_type) or None."""
    if cover_id in _image_cache:
        return _image_cache[cover_id]

    try:
        async with httpx.AsyncClient(timeout=IMAGE_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(COVER_URL.format(cover_id=cover_id))
    except httpx.RequestError as exc:
        logger.warning("Open Library cover fetch failed for %s: %s", cover_id, exc)
        return None

    # Open Library answers with a tiny 1x1 placeholder for unknown ids rather
    # than a 404, so treat a suspiciously small body as "no cover".
    if resp.status_code != 200 or len(resp.content) < 1000:
        return None

    result = (resp.content, resp.headers.get("content-type", "image/jpeg"))
    _image_cache[cover_id] = result
    _trim(_image_cache)
    return result
