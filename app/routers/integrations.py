"""
Integration API routes - Plex, Uptime Kuma, Seerr, Netdata endpoints.
"""

import asyncio
import json
import logging
import time
from urllib.parse import urlparse

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user, require_admin
from app.integrations import plex, uptime_kuma, seerr, netdata, sonarr, radarr, chaptarr, openlibrary, nyt
from app.limiter import limiter

logger = logging.getLogger(__name__)

router = APIRouter()

# Trending books: {period: (fetched_at, cards)}. Matches the upstream trending
# TTL, since resolving the shelf is far more expensive than fetching it.
_TRENDING_BOOKS_TTL = 3600.0
_trending_books_cache: dict = {}


async def _cache_get(key: str):
    """
    Shared second tier for anything expensive enough to cache.

    An in-process cache only helps the worker that filled it, and uvicorn runs
    several. That has two costs: work is repeated once per worker, and - worse
    for anything a person actually looks at - each worker expires on its own
    clock, so consecutive page loads land on different workers and show
    different snapshots of the same figures. Redis is already here for
    sessions, so these go through it and every worker sees one answer.
    """
    try:
        from app.auth import session_manager

        redis = await session_manager.get_redis()
        raw = await redis.get(f"webservarr:cache:{key}")
        return json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001 - a cold cache is not an error
        return None


async def _cache_set(key: str, value, ttl: float) -> None:
    try:
        from app.auth import session_manager

        redis = await session_manager.get_redis()
        await redis.set(f"webservarr:cache:{key}", json.dumps(value), ex=int(ttl))
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not cache %s in Redis: %s", key, exc)


# --- Plex Endpoints ---

@router.get("/active-streams")
async def get_active_streams(
    current_user: dict = Depends(get_current_user),
):
    """Get active Plex streams. Requires authentication."""
    streams = await plex.get_active_streams()
    return streams


@router.get("/plex/thumb")
async def plex_thumbnail(
    path: str,
    current_user: dict = Depends(get_current_user),
):
    """Proxy a Plex thumbnail image to avoid mixed-content issues."""
    # Anti-SSRF: 'path' is forwarded verbatim as Plex's transcode 'url' param, so
    # it must be a Plex-internal RELATIVE path (e.g. /library/metadata/123/thumb/..)
    # and never a full/protocol-relative URL — otherwise any authenticated user
    # could make Plex fetch arbitrary LAN/metadata URLs and return the body.
    _parsed = urlparse(path)
    if not path.startswith("/") or path.startswith("//") or _parsed.scheme or _parsed.netloc:
        raise HTTPException(status_code=400, detail="Invalid thumbnail path")
    content, content_type = await plex.get_thumbnail(path)
    if content is None:
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return Response(content=content, media_type=content_type, headers={"Cache-Control": "public, max-age=3600"})


@router.get("/backgrounds")
@limiter.limit("60/minute")
async def get_backgrounds(request: Request, db: Session = Depends(get_db)):
    """
    Get TMDB trending backdrop URLs for login page.
    No auth required — login page is pre-authentication.
    Returns empty list if Seerr is not configured or feature is disabled.

    Rate limited because it is unauthenticated and every call reaches Seerr:
    without a limit an anonymous caller can use the login page to amplify
    traffic against it. Same reasoning as /status-summary.
    """
    from app.models import Setting
    flag = db.query(Setting).filter(Setting.key == "features.login_backgrounds").first()
    if flag and flag.value == "false":
        return []
    return await seerr.get_backdrops()


# --- Uptime Kuma Endpoints ---

def _get_monitor_preferences(db: Session, monitor_id: int) -> dict:
    """Read monitor preferences from settings table. Defaults: enabled=true, icon=''."""
    from app.models import Setting
    enabled_row = db.query(Setting).filter(Setting.key == f"monitor.{monitor_id}.enabled").first()
    icon_row = db.query(Setting).filter(Setting.key == f"monitor.{monitor_id}.icon").first()
    return {
        "enabled": enabled_row.value.lower() != "false" if enabled_row else True,
        "icon": icon_row.value if icon_row else "",
    }


@router.get("/monitors")
async def get_monitors(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get all Uptime Kuma monitors with stored preferences (enabled, icon)."""
    monitors = await uptime_kuma.get_monitors()
    for m in monitors:
        prefs = _get_monitor_preferences(db, m["id"])
        m["enabled"] = prefs["enabled"]
        m["icon"] = prefs["icon"]
    return monitors


@router.get("/service-status")
async def get_service_status(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get enabled service status from Uptime Kuma for homepage display."""
    monitors = await uptime_kuma.get_monitors()
    result = []
    for m in monitors:
        prefs = _get_monitor_preferences(db, m["id"])
        if prefs["enabled"]:
            m["icon"] = prefs["icon"]
            result.append(m)
    return result


@router.get("/status-summary")
@limiter.limit("60/minute")
async def get_status_summary(request: Request, db: Session = Depends(get_db)):
    """Public aggregate service health for the login page badge.

    Returns ONLY an overall indicator ("online"/"degraded"/"issues"/"unknown")
    with no per-service names or topology, so it is safe for unauthenticated
    callers on the login page. Authenticated pages use the detailed
    /service-status endpoint (which requires a session) instead.
    """
    monitors = await uptime_kuma.get_monitors()
    statuses = [
        m.get("status")
        for m in monitors
        if _get_monitor_preferences(db, m["id"])["enabled"]
    ]
    if any(s == "down" for s in statuses):
        overall = "issues"
    elif any(s == "degraded" for s in statuses):
        overall = "degraded"
    elif statuses:
        overall = "online"
    else:
        overall = "unknown"
    return {"status": overall}


# --- Seerr Endpoints ---

@router.get("/recent-requests")
async def get_recent_requests(
    limit: int = 10,
    current_user: dict = Depends(get_current_user),
):
    """
    Recent requests across every backend.

    Books live in Chaptarr rather than Seerr, so a Seerr-only panel silently
    dropped every ebook and audiobook request that was ever made. Both sources
    are merged and re-sorted by date so the panel shows what was actually
    requested most recently, whatever kind of thing it was.
    """
    screen, books = await asyncio.gather(
        seerr.get_recent_requests(limit=limit),
        chaptarr.recent_requests(limit=limit),
        return_exceptions=True,
    )
    merged = (screen if isinstance(screen, list) else []) + (books if isinstance(books, list) else [])
    merged.sort(key=lambda r: r.get("requested_date") or "", reverse=True)
    return merged[:limit]


@router.get("/request-counts")
async def get_request_counts(
    current_user: dict = Depends(get_current_user),
):
    """Get Seerr request count statistics. Requires authentication."""
    counts = await seerr.get_request_counts()
    return counts


@router.get("/seerr-url")
async def get_seerr_url(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get the configured Seerr URL for iframe embedding."""
    from app.models import Setting
    row = db.query(Setting).filter(Setting.key == "integration.seerr.url").first()
    return {"url": row.value if row else ""}


@router.post("/seerr-auth")
async def seerr_auth(
    response: Response,
    current_user: dict = Depends(get_current_user),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Re-authenticate with Seerr using stored Plex token. Sets connect.sid cookie."""
    if not session_id:
        return {"success": False, "reason": "no_session"}

    session_data = await session_manager.get_session(session_id)
    if not session_data:
        return {"success": False, "reason": "invalid_session"}

    plex_token = session_data.get("plex_token", "")
    if not plex_token:
        return {"success": False, "reason": "no_plex_token"}

    seerr_sid = await seerr.authenticate_with_plex_token(plex_token)
    if not seerr_sid:
        return {"success": False, "reason": "auth_failed"}

    parent_domain = "." + settings.app_domain.split(".", 1)[1]
    response.set_cookie(
        key="connect.sid",
        value=seerr_sid,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
        domain=parent_domain,
    )
    return {"success": True}


@router.get("/seerr-search")
async def seerr_search(
    query: str,
    page: int = 1,
    current_user: dict = Depends(get_current_user),
):
    """Search TMDB via Seerr. Returns movies and TV shows."""
    if not query.strip():
        return {"page": 1, "totalPages": 0, "totalResults": 0, "results": []}
    results = await seerr.search_media(query=query.strip(), page=page)
    return results


@router.get("/chaptarr-search")
@limiter.limit("30/minute")
async def chaptarr_search(
    request: Request,
    query: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Search books via Chaptarr.

    Deliberately never raises: book search sits alongside movie and TV search on
    the same page, and a Chaptarr outage must not break those. Failures come
    back as an empty list.
    """
    if not query.strip():
        return {"results": []}
    return {"results": await chaptarr.search(query.strip())}


# Open Library's trending windows. Anything else is not a period, and more to
# the point must never reach a cache key - the value is caller-supplied and is
# interpolated into a Redis key, so an unvalidated one lets a client mint
# unbounded distinct keys, each holding a full shelf for an hour.
_TRENDING_PERIODS = ("daily", "weekly", "monthly", "yearly")


async def build_books_shelf(period: str = "weekly") -> list:
    """
    Build the trending books shelf, from cache when it is fresh.

    Kept separate from the route so the background warmer can call it without
    faking a request or an authenticated user.
    """
    if period not in _TRENDING_PERIODS:
        period = "weekly"

    cached = _trending_books_cache.get(period)
    if cached and (time.monotonic() - cached[0]) < _TRENDING_BOOKS_TTL:
        return cached[1]

    shared = await _cache_get(f"shelf:books:{period}")
    if shared:
        _trending_books_cache[period] = (time.monotonic(), shared)
        return shared

    try:
        # Two sources that disagree usefully: Open Library ranks what people
        # look up, which skews to perennials, while the NYT lists are what is
        # selling now. Either failing just thins the shelf.
        looked_up, selling = await asyncio.gather(
            openlibrary.trending(period=period),
            nyt.bestsellers("books"),
            return_exceptions=True,
        )
        ranked = openlibrary.merge_trending(
            looked_up if isinstance(looked_up, list) else [],
            selling if isinstance(selling, list) else [],
        )
        cards = await chaptarr.resolve_trending(ranked)
    except Exception as exc:  # noqa: BLE001 - a shelf must never break the page
        logger.warning("Trending books failed: %s", exc)
        return []

    if cards:
        _trending_books_cache[period] = (time.monotonic(), cards)
        await _cache_set(f"shelf:books:{period}", cards, _TRENDING_BOOKS_TTL)
    return cards


async def build_audiobooks_shelf() -> list:
    """Build the trending audiobooks shelf, from cache when it is fresh."""
    cached = _trending_books_cache.get("audiobooks")
    if cached and (time.monotonic() - cached[0]) < _TRENDING_BOOKS_TTL:
        return cached[1]

    shared = await _cache_get("shelf:audiobooks")
    if shared:
        _trending_books_cache["audiobooks"] = (time.monotonic(), shared)
        return shared

    try:
        ranked = await nyt.bestsellers("audiobooks")
        cards = await chaptarr.resolve_trending(ranked)
    except Exception as exc:  # noqa: BLE001 - a shelf must never break the page
        logger.warning("Trending audiobooks failed: %s", exc)
        return []

    for card in cards:
        card["media_type"] = "audiobook"

    if cards:
        _trending_books_cache["audiobooks"] = (time.monotonic(), cards)
        await _cache_set("shelf:audiobooks", cards, _TRENDING_BOOKS_TTL)
    return cards


@router.get("/books-trending")
@limiter.limit("30/minute")
async def books_trending(
    request: Request,
    period: str = "weekly",
    current_user: dict = Depends(get_current_user),
):
    """
    Trending books, as requestable cards.

    Merged from Open Library and the NYT bestseller lists, resolved through
    Chaptarr so every card can actually be requested. Normally served from a
    cache the background warmer keeps filled - see services/shelf_warmer.py for
    why this row cannot be built on demand as cheaply as the Seerr ones.
    """
    return await build_books_shelf(period)


@router.get("/audiobooks-trending")
@limiter.limit("30/minute")
async def audiobooks_trending(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """
    Trending audiobooks, as requestable cards.

    NYT's Audio Fiction and Audio Nonfiction lists are the only sanctioned
    source - Audible publishes no API and no feed. Requests from this shelf
    carry an audiobook format so Chaptarr files them under its audiobook root
    folder rather than the ebook one.
    """
    return await build_audiobooks_shelf()


_LIBRARY_SUMMARY_TTL = 300.0
_library_summary_cache: dict = {}


@router.get("/library-summary")
@limiter.limit("30/minute")
async def library_summary(request: Request, current_user: dict = Depends(get_current_user)):
    """
    What the library actually holds, for the stats rail.

    Replaces the request-lifecycle counts that used to sit there. Those said
    almost nothing: with automatic approval, Pending is permanently zero and
    Approved is within a rounding error of Total, so three of the four numbers
    were the same fact. These describe the library instead.

    Cached briefly - it walks every series and film in Sonarr and Radarr, and
    the answer moves slowly.
    """
    cached = _library_summary_cache.get("all")
    if cached and (time.monotonic() - cached[0]) < _LIBRARY_SUMMARY_TTL:
        return cached[1]

    # Shared before rebuilt, so every worker reports the same snapshot. Without
    # this each worker expires on its own clock and consecutive reloads flick
    # between two sets of figures that are both correct and visibly different.
    shared = await _cache_get("library-summary")
    if shared:
        _library_summary_cache["all"] = (time.monotonic(), shared)
        return shared

    tv, film, books, waits = await asyncio.gather(
        sonarr.library_summary(),
        radarr.library_summary(),
        chaptarr.library_summary(),
        seerr.request_insights(),
        return_exceptions=True,
    )
    tv = tv if isinstance(tv, dict) else {}
    film = film if isinstance(film, dict) else {}
    books = books if isinstance(books, dict) else {}
    waits = waits if isinstance(waits, dict) else {}
    requested = waits.get("requested") or {}
    fulfilled = waits.get("fulfilled") or {}

    summary = {
        "movies": film.get("movies", 0),
        "shows": tv.get("shows", 0),
        "episodes": tv.get("episodes", 0),
        "complete_shows": tv.get("complete_shows", 0),
        "missing_episodes": tv.get("missing_episodes", 0),
        "percent": tv.get("percent", 0),
        "seasons": tv.get("seasons", 0),
        "complete_seasons": tv.get("complete_seasons", 0),
        "books": books.get("books", 0),
        "ebooks": books.get("ebooks", 0),
        "audiobooks": books.get("audiobooks", 0),
        # Titles actively being chased, and titles simply not out yet. Kept
        # apart because a film awaiting its cinema release is not a problem,
        # and counting it as one makes the queue look stuck.
        "in_progress": film.get("in_progress", 0) + tv.get("in_progress", 0),
        "unreleased": film.get("unreleased", 0),
        # Median rather than mean; see seerr.request_insights.
        "wait_minutes": waits.get("wait") or {},
        # What was asked for against what actually arrived.
        "requested": requested,
        "fulfilled": fulfilled,
        "partial": waits.get("partial") or {},
        "removed": waits.get("removed") or {},
        "fulfilled_percent": (
            round(100 * fulfilled.get("total", 0) / requested["total"])
            if requested.get("total") else 0
        ),
        # Every service reports bytes per title, so the total is free once the
        # lists have been walked. Books are a rounding error against video but
        # are included so "on disk" means the whole library, not most of it.
        "bytes": tv.get("bytes", 0) + film.get("bytes", 0) + books.get("bytes", 0),
        "added_recently": tv.get("added_recently", 0) + film.get("added_recently", 0),
        "recent_days": 30,
    }
    if any(summary.values()):
        _library_summary_cache["all"] = (time.monotonic(), summary)
        await _cache_set("library-summary", summary, _LIBRARY_SUMMARY_TTL)
    return summary


@router.get("/book-rating")
@limiter.limit("60/minute")
async def book_rating(
    request: Request,
    title: str,
    author: str = "",
    current_user: dict = Depends(get_current_user),
):
    """
    Goodreads rating for a book, for the eBooks detail sheet.

    Kavita holds no rating of its own worth showing - its endpoints for that
    are 404 on this build - so the number comes from Chaptarr's metadata
    provider. Returns {} rather than an error when there is no confident
    match: the sheet simply omits the line.
    """
    if not title.strip():
        return {}
    return await chaptarr.book_rating(title.strip(), author.strip())


@router.get("/book-cover")
@limiter.limit("120/minute")
async def book_cover(
    request: Request,
    coverId: int,
    current_user: dict = Depends(get_current_user),
):
    """
    Proxy an Open Library book cover.

    Served through here rather than linked directly so readers' browsers never
    contact Open Library — only the VPS does. Takes an integer id, so it cannot
    be pointed at an arbitrary URL.
    """
    result = await openlibrary.fetch_cover(coverId)
    if result is None:
        raise HTTPException(status_code=404, detail="Cover not found")
    content, content_type = result
    return Response(
        content=content,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=604800"},
    )


class BookRequestCreate(BaseModel):
    # A Chaptarr foreign id such as "gr:3634639" - a string, not an int.
    bookId: str
    # "ebook" or "audiobook"; picks which Chaptarr root folder and profiles the
    # request lands in. Anything else is treated as an ebook rather than
    # rejected, so an older client keeps working.
    format: str = "ebook"


@router.post("/chaptarr-request")
@limiter.limit("10/minute")
async def create_chaptarr_request(
    request: Request,
    body: BookRequestCreate,
    current_user: dict = Depends(get_current_user),
):
    """Add a book to Chaptarr and kick off a search for it."""
    if not body.bookId.strip():
        raise HTTPException(status_code=400, detail="bookId is required")
    fmt = "audiobook" if body.format == "audiobook" else "ebook"
    result = await chaptarr.request_book(body.bookId.strip(), fmt=fmt)
    if not result["ok"]:
        raise HTTPException(status_code=502, detail=result["message"])
    return result


async def _get_plex_token(session_id: str) -> str | None:
    """Extract plex_token from user's Redis session."""
    if not session_id:
        return None
    session_data = await session_manager.get_session(session_id)
    if not session_data:
        return None
    return session_data.get("plex_token") or None


class RequestCreate(BaseModel):
    mediaType: str
    mediaId: int
    is4k: bool = False


@router.post("/seerr-request")
async def create_seerr_request(
    body: RequestCreate,
    current_user: dict = Depends(get_current_user),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Create a media request in Seerr, attributed to the current Plex user when possible."""
    if body.mediaType not in ("movie", "tv"):
        raise HTTPException(status_code=400, detail="mediaType must be 'movie' or 'tv'")

    plex_token = await _get_plex_token(session_id)
    if plex_token:
        result = await seerr.create_request_as_user(
            plex_token=plex_token,
            media_type=body.mediaType, media_id=body.mediaId, is4k=body.is4k,
        )
    else:
        result = await seerr.create_request(
            media_type=body.mediaType, media_id=body.mediaId, is4k=body.is4k,
        )

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Request failed"))
    return result


# --- Seerr Issues ---

class IssueCreate(BaseModel):
    issueType: int  # 1=Video, 2=Audio, 3=Subtitles, 4=Other
    message: str
    mediaId: int


class IssueCommentCreate(BaseModel):
    message: str


@router.get("/issues")
async def get_issues(
    take: int = 20,
    skip: int = 0,
    sort: str = "added",
    current_user: dict = Depends(get_current_user),
):
    """Get Seerr issues with media details. Requires authentication."""
    return await seerr.get_issues(take=take, skip=skip, sort=sort)


@router.get("/issue-counts")
async def get_issue_counts(
    current_user: dict = Depends(get_current_user),
):
    """Get Seerr issue count statistics."""
    return await seerr.get_issue_counts()


@router.get("/issues/{issue_id}")
async def get_issue_detail(
    issue_id: int,
    current_user: dict = Depends(get_current_user),
):
    """Get single issue with comments."""
    issue = await seerr.get_issue_detail(issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")
    return issue


@router.post("/issues")
async def create_issue(
    body: IssueCreate,
    current_user: dict = Depends(get_current_user),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Create an issue in Seerr, attributed to the current Plex user."""
    if body.issueType not in (1, 2, 3, 4):
        raise HTTPException(status_code=400, detail="issueType must be 1 (Video), 2 (Audio), 3 (Subtitles), or 4 (Other)")
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    plex_token = await _get_plex_token(session_id)
    if not plex_token:
        raise HTTPException(status_code=400, detail="No Plex token in session. Please sign in with Plex.")

    result = await seerr.create_issue(
        plex_token=plex_token,
        issue_type=body.issueType, message=body.message.strip(), media_id=body.mediaId,
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Failed to create issue"))
    return result


@router.post("/issues/{issue_id}/comment")
async def create_issue_comment(
    issue_id: int,
    body: IssueCommentCreate,
    current_user: dict = Depends(get_current_user),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Add a comment to an issue, attributed to the current Plex user."""
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    plex_token = await _get_plex_token(session_id)
    if not plex_token:
        raise HTTPException(status_code=400, detail="No Plex token in session. Please sign in with Plex.")

    result = await seerr.create_issue_comment(
        plex_token=plex_token, issue_id=issue_id, message=body.message.strip(),
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Failed to add comment"))
    return result


# --- Seerr Discover Endpoints ---

@router.get("/seerr-discover/trending")
async def seerr_discover_trending(
    current_user: dict = Depends(get_current_user),
):
    """Get Seerr trending items (mixed movies + TV). Requires authentication."""
    return await seerr.get_discover_list("trending")


@router.get("/seerr-discover/popular-movies")
async def seerr_discover_popular_movies(
    current_user: dict = Depends(get_current_user),
):
    """Get popular movies from Seerr. Requires authentication."""
    return await seerr.get_discover_list("popular-movies")


@router.get("/seerr-discover/upcoming-movies")
async def seerr_discover_upcoming_movies(
    current_user: dict = Depends(get_current_user),
):
    """Get upcoming movies from Seerr. Requires authentication."""
    return await seerr.get_discover_list("upcoming-movies")


@router.get("/seerr-discover/popular-series")
async def seerr_discover_popular_series(
    current_user: dict = Depends(get_current_user),
):
    """Get popular TV series from Seerr. Requires authentication."""
    return await seerr.get_discover_list("popular-series")


@router.get("/seerr-discover/upcoming-series")
async def seerr_discover_upcoming_series(
    current_user: dict = Depends(get_current_user),
):
    """Get upcoming TV series from Seerr. Requires authentication."""
    return await seerr.get_discover_list("upcoming-series")


# --- Sonarr/Radarr Endpoints ---

@router.get("/upcoming-releases")
async def get_upcoming_releases(
    days: int = 14,
    start: str = "",
    current_user: dict = Depends(get_current_user),
):
    """Get upcoming TV episodes and movies from Sonarr/Radarr. Requires authentication."""
    sonarr_items = await sonarr.get_calendar(days=days, start=start)
    radarr_items = await radarr.get_calendar(days=days, start=start)

    # Merge and sort by air_date
    combined = sonarr_items + radarr_items
    combined.sort(key=lambda x: x.get("air_date", ""))

    return combined


# --- Netdata Endpoints ---

@router.get("/system-stats")
async def get_system_stats(
    current_user: dict = Depends(get_current_user),
):
    """Get system stats from Netdata. Requires authentication."""
    stats = await netdata.get_system_stats()
    return stats
