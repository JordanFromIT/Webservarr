"""
Admin integration endpoints for the Settings page: status lights and the
Chaptarr choices. Both reach out to the operator's LAN services, so both are
admin-only, rate-limited, time-capped, and answer 4xx/503 (never 502/504,
whose bodies Cloudflare replaces).
"""

from typing import Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import require_admin
from app.limiter import limiter
from app.routers.admin_settings import effective_values
from app.services.integration_health import IDS, get_health

router = APIRouter()


@router.get("/integrations/health")
@limiter.limit("20/minute")
async def integrations_health(
    request: Request,
    refresh: bool = False,
    service: Optional[str] = None,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """IntegrationHealth: cached 30 s; refresh=1 re-probes (one service if given)."""
    if service is not None and service not in IDS:
        return JSONResponse(status_code=400, content={"detail": "Unknown integration"})
    return await get_health(effective_values(db), refresh=refresh, only=service)
