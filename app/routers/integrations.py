"""
Integration API routes - Plex, Uptime Kuma, Overseerr, Netdata endpoints.
"""

from fastapi import APIRouter, Cookie, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user, require_admin
from app.integrations import plex, uptime_kuma, overseerr, netdata, sonarr, radarr

router = APIRouter()


# --- Plex Endpoints ---

@router.get("/active-streams")
async def get_active_streams(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get active Plex streams. Requires authentication."""
    streams = await plex.get_active_streams(db)
    return streams


@router.get("/plex/thumb")
async def plex_thumbnail(
    path: str,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Proxy a Plex thumbnail image to avoid mixed-content issues."""
    content, content_type = await plex.get_thumbnail(db, path)
    if content is None:
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return Response(content=content, media_type=content_type, headers={"Cache-Control": "public, max-age=3600"})


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
    monitors = await uptime_kuma.get_monitors(db)
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
    monitors = await uptime_kuma.get_monitors(db)
    result = []
    for m in monitors:
        prefs = _get_monitor_preferences(db, m["id"])
        if prefs["enabled"]:
            m["icon"] = prefs["icon"]
            result.append(m)
    return result


# --- Overseerr Endpoints ---

@router.get("/recent-requests")
async def get_recent_requests(
    limit: int = 10,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get recent Overseerr requests. Requires authentication."""
    requests = await overseerr.get_recent_requests(db, limit=limit)
    return requests


@router.get("/request-counts")
async def get_request_counts(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get Overseerr request count statistics. Requires authentication."""
    counts = await overseerr.get_request_counts(db)
    return counts


@router.get("/overseerr-url")
async def get_overseerr_url(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get the configured Overseerr URL for iframe embedding."""
    from app.models import Setting
    row = db.query(Setting).filter(Setting.key == "integration.overseerr.url").first()
    return {"url": row.value if row else ""}


@router.post("/overseerr-auth")
async def overseerr_auth(
    response: Response,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Re-authenticate with Overseerr using stored Plex token. Sets connect.sid cookie."""
    if not session_id:
        return {"success": False, "reason": "no_session"}

    session_data = await session_manager.get_session(session_id)
    if not session_data:
        return {"success": False, "reason": "invalid_session"}

    plex_token = session_data.get("plex_token", "")
    if not plex_token:
        return {"success": False, "reason": "no_plex_token"}

    overseerr_sid = await overseerr.authenticate_with_plex_token(db, plex_token)
    if not overseerr_sid:
        return {"success": False, "reason": "auth_failed"}

    parent_domain = "." + settings.app_domain.split(".", 1)[1]
    response.set_cookie(
        key="connect.sid",
        value=overseerr_sid,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
        domain=parent_domain,
    )
    return {"success": True}


@router.get("/overseerr-search")
async def overseerr_search(
    query: str,
    page: int = 1,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Search TMDB via Overseerr. Returns movies and TV shows."""
    if not query.strip():
        return {"page": 1, "totalPages": 0, "totalResults": 0, "results": []}
    results = await overseerr.search_media(db, query=query.strip(), page=page)
    return results


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


@router.post("/overseerr-request")
async def create_overseerr_request(
    body: RequestCreate,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Create a media request in Overseerr, attributed to the current Plex user when possible."""
    if body.mediaType not in ("movie", "tv"):
        raise HTTPException(status_code=400, detail="mediaType must be 'movie' or 'tv'")

    plex_token = await _get_plex_token(session_id)
    if plex_token:
        result = await overseerr.create_request_as_user(
            db, plex_token=plex_token,
            media_type=body.mediaType, media_id=body.mediaId, is4k=body.is4k,
        )
    else:
        result = await overseerr.create_request(
            db, media_type=body.mediaType, media_id=body.mediaId, is4k=body.is4k,
        )

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Request failed"))
    return result


# --- Overseerr Issues ---

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
    db: Session = Depends(get_db),
):
    """Get Overseerr issues with media details. Requires authentication."""
    return await overseerr.get_issues(db, take=take, skip=skip, sort=sort)


@router.get("/issue-counts")
async def get_issue_counts(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get Overseerr issue count statistics."""
    return await overseerr.get_issue_counts(db)


@router.get("/issues/{issue_id}")
async def get_issue_detail(
    issue_id: int,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get single issue with comments."""
    issue = await overseerr.get_issue_detail(db, issue_id)
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")
    return issue


@router.post("/issues")
async def create_issue(
    body: IssueCreate,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Create an issue in Overseerr, attributed to the current Plex user."""
    if body.issueType not in (1, 2, 3, 4):
        raise HTTPException(status_code=400, detail="issueType must be 1 (Video), 2 (Audio), 3 (Subtitles), or 4 (Other)")
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    plex_token = await _get_plex_token(session_id)
    if not plex_token:
        raise HTTPException(status_code=400, detail="No Plex token in session. Please sign in with Plex.")

    result = await overseerr.create_issue(
        db, plex_token=plex_token,
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
    db: Session = Depends(get_db),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Add a comment to an issue, attributed to the current Plex user."""
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    plex_token = await _get_plex_token(session_id)
    if not plex_token:
        raise HTTPException(status_code=400, detail="No Plex token in session. Please sign in with Plex.")

    result = await overseerr.create_issue_comment(
        db, plex_token=plex_token, issue_id=issue_id, message=body.message.strip(),
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Failed to add comment"))
    return result


# --- Sonarr/Radarr Endpoints ---

@router.get("/upcoming-releases")
async def get_upcoming_releases(
    days: int = 14,
    start: str = "",
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get upcoming TV episodes and movies from Sonarr/Radarr. Requires authentication."""
    sonarr_items = await sonarr.get_calendar(db, days=days, start=start)
    radarr_items = await radarr.get_calendar(db, days=days, start=start)

    # Merge and sort by air_date
    combined = sonarr_items + radarr_items
    combined.sort(key=lambda x: x.get("air_date", ""))

    return combined


# --- Netdata Endpoints ---

@router.get("/system-stats")
async def get_system_stats(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get system stats from Netdata. Requires authentication."""
    stats = await netdata.get_system_stats(db)
    return stats
