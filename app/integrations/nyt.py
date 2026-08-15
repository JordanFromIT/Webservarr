"""
New York Times Books API - bestseller lists as a trending source.

Sits alongside Open Library in the trending shelves. The two disagree usefully:
Open Library ranks by what people are looking up, which skews to perennials
(Atomic Habits, Rich Dad Poor Dad), while the NYT lists are what is selling
right now. Merging them gives a shelf that has both staples and new releases.

This is also the only source that knows about audiobooks. Audible publishes no
API and no feed, and its charts are HTML only; the NYT Audio Fiction and Audio
Nonfiction lists are the sanctioned equivalent, confirmed live against the API
rather than assumed from documentation - their own list-names endpoint 404s.

Needs a free key from https://developer.nytimes.com (1,000 requests/day),
stored as integration.nyt.api_key. Absent a key every call returns [], which
simply means the NYT half of a shelf is missing.
"""

import asyncio
import logging
import time
from typing import Dict, List, Optional

import httpx

from app.database import SessionLocal
from app.models import Setting

logger = logging.getLogger(__name__)

BASE_URL = "https://api.nytimes.com/svc/books/v3/lists/current/{list_name}.json"
TIMEOUT = 10.0

# Which lists feed which shelf. Two per shelf so fiction and nonfiction are both
# represented rather than one crowding the other out.
LISTS: Dict[str, List[str]] = {
    "books": ["combined-print-and-e-book-fiction", "combined-print-and-e-book-nonfiction"],
    "audiobooks": ["audio-fiction", "audio-nonfiction"],
}

# The print lists refresh weekly and the audio lists monthly, so an hourly
# fetch would be pure waste against a 1,000/day budget.
_TTL = 6 * 3600.0
_cache: Dict[str, tuple] = {}

# The daily quota is generous but the per-minute rate is not. Spacing calls
# within a single shelf is not enough: the warmer builds both shelves one after
# the other, which put four calls inside a second and had NYT refuse the
# audiobook half outright. The gap is enforced across every call in the process
# instead, whichever shelf asked for it.
_INTER_REQUEST_DELAY = 3.0
_last_request_at = 0.0
_rate_lock = asyncio.Lock()


async def _throttle() -> None:
    global _last_request_at
    async with _rate_lock:
        wait = _INTER_REQUEST_DELAY - (time.monotonic() - _last_request_at)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request_at = time.monotonic()


def _api_key() -> Optional[str]:
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == "integration.nyt.api_key").first()
        return row.value if row and row.value else None
    finally:
        db.close()


async def _fetch_list(client: httpx.AsyncClient, list_name: str, key: str) -> List[Dict[str, str]]:
    await _throttle()
    try:
        resp = await client.get(BASE_URL.format(list_name=list_name), params={"api-key": key})
    except httpx.RequestError as exc:
        logger.warning("NYT list %s failed: %s", list_name, exc)
        return []

    if resp.status_code != 200:
        logger.warning("NYT list %s returned HTTP %d", list_name, resp.status_code)
        return []

    try:
        books = (resp.json().get("results") or {}).get("books") or []
    except ValueError:
        return []

    out = []
    for book in books:
        title = (book.get("title") or "").strip()
        if not title:
            continue
        # NYT sets titles in caps ("THE CALAMITY CLUB"), which would carry
        # through to the card. Title-case reads properly and matches the other
        # source; the Chaptarr lookup is case-insensitive either way.
        if title.isupper():
            title = title.title()
        out.append({
            "title": title,
            "author": (book.get("author") or "").strip(),
            "cover_id": None,
        })
    return out


async def bestsellers(kind: str = "books") -> List[Dict[str, str]]:
    """
    Current NYT bestsellers for a shelf: [{title, author, cover_id}].

    `kind` is "books" or "audiobooks". Returns [] when unconfigured or failing -
    the shelf then falls back to whatever other sources provided.
    """
    if kind not in LISTS:
        return []

    hit = _cache.get(kind)
    if hit and (time.monotonic() - hit[0]) < _TTL:
        return hit[1]

    key = _api_key()
    if not key:
        return []

    items: List[Dict[str, str]] = []
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for list_name in LISTS[kind]:
            items.extend(await _fetch_list(client, list_name, key))

    if items:
        _cache[kind] = (time.monotonic(), items)
    return items


async def test_connection() -> tuple:
    """Return (ok, message) for the admin test-connection UI."""
    key = _api_key()
    if not key:
        return False, "NYT API key is not configured"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(
                BASE_URL.format(list_name="combined-print-and-e-book-fiction"),
                params={"api-key": key},
            )
    except httpx.RequestError as exc:
        return False, f"Could not reach the NYT API: {exc}"

    if resp.status_code == 401:
        return False, "NYT rejected the API key"
    if resp.status_code == 429:
        return False, "NYT rate limit reached - try again shortly"
    if resp.status_code != 200:
        return False, f"NYT returned HTTP {resp.status_code}"

    count = len(((resp.json().get("results") or {}).get("books")) or [])
    return True, f"Connected. Bestseller list returned {count} titles."
