"""
Request status API - why requested media has not arrived yet.

Read-only. The work happens in app/services/request_status.py and is kept warm
by a background task; these endpoints serve the cached snapshot.
"""

import logging

from fastapi import APIRouter, Depends, Request

from app.dependencies import get_current_user, require_admin
from app.limiter import limiter
from app.services import request_status

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/")
@limiter.limit("60/minute")
async def get_request_status(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """
    The current snapshot, for any signed-in viewer.

    Deliberately not admin-only: the whole point is that somebody can find out
    what happened to their own request without having to ask the admin. Every
    viewer sees every row -- this is a household server and requests are not
    private -- but the page identifies whose each one is so it can lead with
    the viewer's own.

    If the cache is cold (a restart, before the warmer's first pass) this builds
    the snapshot inline. That is the slow path and only the unlucky first
    visitor after a restart pays it.
    """
    snapshot = await request_status.get_cached_snapshot()

    if snapshot is None:
        logger.info("Request-status cache cold; building inline")
        try:
            snapshot = await request_status.refresh()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Inline request-status build failed: %s", exc)
            # 4xx rather than 5xx on purpose: Cloudflare replaces the body of a
            # 5xx with its own error page, so the frontend would receive HTML
            # where it expects JSON and could not explain what went wrong.
            return {
                "error": "unavailable",
                "message": "Request status is still being worked out. Try again shortly.",
                "generated_at": None,
                "counts": {},
                "total": 0,
                "items": [],
            }

    return snapshot


@router.post("/refresh")
@limiter.limit("5/minute")
async def force_refresh(
    request: Request,
    current_user: dict = Depends(require_admin),
):
    """
    Rebuild the snapshot now instead of waiting for the timer.

    Admin-only and tightly rate limited: each call is tens of round trips
    against Radarr, Sonarr, Seerr and Plex, so it is a deliberate action rather
    than something a page refresh should trigger.
    """
    try:
        snapshot = await request_status.refresh()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Manual request-status refresh failed: %s", exc)
        return {"error": "refresh_failed", "message": str(exc)}
    return {
        "ok": True,
        "generated_at": snapshot["generated_at"],
        "total": snapshot["total"],
    }
