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
   local-ownership fields stay empty even for books already in the library.
   So results are surfaced simply as "eBook" rather than claiming to know which
   editions exist.
"""

import logging
from typing import Any, Dict, List, Optional

import httpx

from app.database import SessionLocal
from app.integrations import openlibrary
from app.models import Setting

logger = logging.getLogger(__name__)

TIMEOUT = 15.0

# The only provider that returns results; see module docstring.
SEARCH_PROVIDER = "goodreads"


def _get_config() -> dict:
    """Read Chaptarr config from the settings table (short-lived session)."""
    db = SessionLocal()
    try:
        def _val(key: str) -> Optional[str]:
            row = db.query(Setting).filter(Setting.key == key).first()
            return row.value if row and row.value else None

        url = _val("integration.chaptarr.url")
        return {
            "url": url.rstrip("/") if url else None,
            "api_key": _val("integration.chaptarr.api_key"),
            "root_folder": _val("integration.chaptarr.root_folder") or "",
            "quality_profile_id": _val("integration.chaptarr.quality_profile_id") or "1",
            "metadata_profile_id": _val("integration.chaptarr.metadata_profile_id") or "2",
        }
    finally:
        db.close()


def _headers(cfg: dict) -> dict:
    return {"X-Api-Key": cfg["api_key"], "Content-Type": "application/json"}


def _is_set_id(value: Any) -> bool:
    """
    True when an id field actually identifies something.

    Chaptarr returns numeric ids as strings, so an absent id arrives as the
    string "0" — and bool("0") is True in Python. Comparing numerically avoids
    marking every search result as already owned.
    """
    if value in (None, "", 0):
        return False
    try:
        return int(value) > 0
    except (TypeError, ValueError):
        return True


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


def _normalise(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Convert a Chaptarr search result into the shape the requests page already
    uses for Seerr items, so book cards render through the same code path.

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

    # Chaptarr does report whether it already tracks the book, even though the
    # per-edition fields stay empty.
    owned = _is_set_id(result.get("existingLocalId")) or _is_set_id(book.get("localBookId"))

    return {
        "id": result.get("foreignId") or book.get("foreignBookId"),
        "media_type": "book",
        "title": title,
        "author": author_name,
        "year": year,
        "poster_url": _poster_from(book.get("images")),
        "overview": book.get("overview") or "",
        "media_status": "available" if owned else None,
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
        norm = _normalise(result)
        if norm and norm["id"]:
            items.append(norm)
        if len(items) >= limit:
            break

    # Most-rated first: with no relevance score, popularity is the best proxy
    # for "the edition the person actually meant".
    items.sort(key=lambda b: b.get("votes") or 0, reverse=True)

    await _attach_covers(items)
    return items


async def _attach_covers(items: List[Dict[str, Any]]) -> None:
    """
    Fill in cover art from Open Library for books that have none.

    Chaptarr's own covers are unreachable (see _poster_from). Failure here is
    silent by design: a book card without art is still perfectly usable.
    """
    needed = [(b["title"], b.get("author") or "") for b in items if not b.get("poster_url")]
    if not needed:
        return

    found = await openlibrary.cover_ids(needed)
    for book in items:
        if book.get("poster_url"):
            continue
        cover_id = found.get((book["title"], book.get("author") or ""))
        if cover_id:
            book["poster_url"] = f"/api/integrations/book-cover?coverId={cover_id}"


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


async def request_book(foreign_id: str) -> Dict[str, Any]:
    """
    Add a book to Chaptarr and start searching for it.

    Returns {"ok": bool, "message": str}.
    """
    cfg = _get_config()
    if not cfg["url"] or not cfg["api_key"]:
        return {"ok": False, "message": "Chaptarr is not configured"}
    if not cfg["root_folder"]:
        return {"ok": False, "message": "No Chaptarr root folder configured"}

    book = await _lookup_book(cfg, foreign_id)
    if not book:
        return {"ok": False, "message": "Could not find that book in Chaptarr"}

    payload = dict(book)
    payload.update({
        "monitored": True,
        "rootFolderPath": cfg["root_folder"],
        "qualityProfileId": int(cfg["quality_profile_id"]),
        "metadataProfileId": int(cfg["metadata_profile_id"]),
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
