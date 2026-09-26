"""
Admin integration endpoints for the Settings page: status lights and the
Chaptarr choices. Both reach out to the operator's LAN services, so both are
admin-only, rate-limited, time-capped, and answer 4xx/503 (never 502/504,
whose bodies Cloudflare replaces).
"""

import asyncio
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import require_admin
from app.limiter import limiter
from app.routers.admin_settings import effective_values
from app.integrations import config as integration_config
from app.services import integration_health
from app.services.integration_health import IDS, get_health, make_client
from app.utils import is_safe_integration_url

logger = logging.getLogger(__name__)

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
    """IntegrationHealth, cached 30 s. refresh=1 re-probes: just `service` when
    one is given and the cache is warm, everything when the cache is cold, so
    the map always covers every integration."""
    if service is not None and service not in IDS:
        return JSONResponse(status_code=400, content={"detail": "Unknown integration"})
    return await get_health(effective_values(db), refresh=refresh, only=service)


def _profiles(rows) -> list:
    out = []
    for p in rows if isinstance(rows, list) else []:
        if isinstance(p, dict) and isinstance(p.get("id"), int) and not isinstance(p.get("id"), bool):
            out.append({"id": p["id"], "name": str(p.get("name") or f"Profile {p['id']}")})
    return out


async def _fetch_chaptarr_options(base: str, key: str):
    # The address check can resolve a hostname with a blocking getaddrinfo,
    # so it runs in a worker thread; the caller's one deadline covers it and
    # the three requests. make_client never follows redirects, so a 3xx
    # can't walk the fetch past the address check.
    if not await asyncio.to_thread(is_safe_integration_url, base):
        return JSONResponse(status_code=400, content={"detail": "That address isn't allowed"})
    headers = {"X-Api-Key": key}
    async with make_client() as client:
        responses = await asyncio.gather(
            client.get(f"{base}/api/v1/rootfolder", headers=headers),
            client.get(f"{base}/api/v1/qualityprofile", headers=headers),
            client.get(f"{base}/api/v1/metadataprofile", headers=headers),
        )
    for r in responses:
        if r.status_code in (401, 403):
            return JSONResponse(status_code=400, content={"detail": "Chaptarr rejected the API key"})
        if r.status_code != 200:
            return JSONResponse(status_code=503, content={"detail": "Chaptarr answered with an error. Try again."})
    try:
        folders, quality, metadata = (r.json() for r in responses)
    except ValueError:
        return JSONResponse(status_code=503, content={"detail": "Chaptarr answered with something unexpected. Try again."})
    return {
        "root_folders": [{"path": str(f["path"])} for f in (folders if isinstance(folders, list) else [])
                         if isinstance(f, dict) and f.get("path")],
        "quality_profiles": _profiles(quality),
        "metadata_profiles": _profiles(metadata),
    }


@router.get("/chaptarr/options")
@limiter.limit("20/minute")
async def chaptarr_options(
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """ChaptarrOptions: root folders and profiles for the Settings dropdowns,
    fetched under one PROBE_TIMEOUT deadline (address check included)."""
    values = effective_values(db)
    # Read as the Chaptarr client and the status light read them.
    base = integration_config.base_url("chaptarr", values) or ""
    key = integration_config.credential("chaptarr", values) or ""
    if not base or not key:
        return JSONResponse(status_code=400, content={"detail": "Chaptarr isn't set up yet"})
    return await chaptarr_options_response(base, key)


UNREACHABLE = "Couldn't reach Chaptarr. Check the address and try again."


async def chaptarr_options_response(base: str, key: str):
    """The fetch under its one deadline, every failure mapped to 4xx/503.
    Cancellation is a BaseException, so it still propagates."""
    try:
        return await asyncio.wait_for(_fetch_chaptarr_options(base, key),
                                      timeout=integration_health.PROBE_TIMEOUT)
    except httpx.InvalidURL:
        return JSONResponse(status_code=400, content={"detail": "That address isn't valid. Check it and try again."})
    except (httpx.RequestError, asyncio.TimeoutError):
        return JSONResponse(status_code=503, content={"detail": UNREACHABLE})
    except Exception as exc:  # noqa: BLE001 - never a 500; the type only, the message can hold the URL
        logger.warning("Chaptarr options failed: %s", type(exc).__name__)
        return JSONResponse(status_code=503, content={"detail": UNREACHABLE})
