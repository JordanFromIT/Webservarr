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

import asyncio
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

        url = _val("integration.chaptarr.url")
        return {
            "url": url.rstrip("/") if url else None,
            "api_key": _val("integration.chaptarr.api_key"),
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


async def resolve_trending(books: List[Dict[str, Any]], limit: int = 20) -> List[Dict[str, Any]]:
    """
    Turn a list of {title, author, cover_id} into requestable book cards.

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
            norm = _normalise(result)
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

    book = await _lookup_book(cfg, foreign_id)
    if not book:
        return {"ok": False, "message": "Could not find that book in Chaptarr"}

    payload = dict(book)
    payload.update({
        "monitored": True,
        "rootFolderPath": root_folder,
        "qualityProfileId": int(cfg[f"{prefix}quality_profile_id"]),
        "metadataProfileId": int(cfg[f"{prefix}metadata_profile_id"]),
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
