"""
Admin API routes - Service management, settings, etc.
"""

import logging
import os
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
import httpx

from app.database import get_db
from app.models import Setting
from app.dependencies import require_admin

logger = logging.getLogger(__name__)

router = APIRouter()


# Pydantic schemas
class SettingCreate(BaseModel):
    """Schema for creating/updating a setting."""
    key: str
    value: str
    description: Optional[str] = None


class SettingItem(BaseModel):
    """Schema for a single setting in a bulk update."""
    key: str
    value: str
    description: Optional[str] = None


class BulkSettingsUpdate(BaseModel):
    """Schema for bulk updating settings."""
    settings: List[SettingItem]


class MonitorPreferences(BaseModel):
    """Schema for updating monitor display preferences."""
    enabled: Optional[bool] = None
    icon: Optional[str] = None


class TestConnectionRequest(BaseModel):
    """Schema for testing an external API connection."""
    service: str  # "plex", "uptime_kuma", "overseerr", or "netdata"
    url: str
    credentials: Optional[str] = None


# --- Monitor Preferences ---

@router.put("/monitors/{monitor_id}")
async def update_monitor_preferences(
    monitor_id: int,
    prefs: MonitorPreferences,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Update display preferences for an Uptime Kuma monitor. Requires admin."""
    updated = {}
    if prefs.enabled is not None:
        key = f"monitor.{monitor_id}.enabled"
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = str(prefs.enabled).lower()
        else:
            db.add(Setting(key=key, value=str(prefs.enabled).lower()))
        updated["enabled"] = prefs.enabled

    if prefs.icon is not None:
        key = f"monitor.{monitor_id}.icon"
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = prefs.icon
        else:
            db.add(Setting(key=key, value=prefs.icon))
        updated["icon"] = prefs.icon

    db.commit()
    return {"monitor_id": monitor_id, **updated}


@router.get("/settings/{key}")
async def get_setting(
    key: str,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """
    Get a setting by key.
    Requires admin authentication.
    """
    setting = db.query(Setting).filter(Setting.key == key).first()

    if not setting:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Setting not found"
        )

    return setting


@router.put("/settings")
async def update_setting(
    setting_data: SettingCreate,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """
    Create or update a setting.
    Requires admin authentication.
    """
    setting = db.query(Setting).filter(Setting.key == setting_data.key).first()

    if setting:
        # Update existing
        setting.value = setting_data.value
        if setting_data.description:
            setting.description = setting_data.description
    else:
        # Create new
        setting = Setting(
            key=setting_data.key,
            value=setting_data.value,
            description=setting_data.description
        )
        db.add(setting)

    db.commit()
    db.refresh(setting)

    return setting


@router.get("/settings")
async def list_settings(
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """
    List all settings.
    Masks values for keys containing 'api_key' or 'token'.
    Requires admin authentication.
    """
    settings = db.query(Setting).all()
    result = []
    for s in settings:
        value = s.value
        if "api_key" in s.key or "token" in s.key:
            value = "***masked***"
        result.append({
            "key": s.key,
            "value": value,
            "description": s.description
        })
    return result


@router.put("/settings/bulk")
async def bulk_update_settings(
    payload: BulkSettingsUpdate,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """
    Create or update multiple settings at once.
    Requires admin authentication.
    """
    updated = []
    for item in payload.settings:
        setting = db.query(Setting).filter(Setting.key == item.key).first()
        if setting:
            setting.value = item.value
            if item.description is not None:
                setting.description = item.description
        else:
            setting = Setting(
                key=item.key,
                value=item.value,
                description=item.description
            )
            db.add(setting)
        db.commit()
        db.refresh(setting)
        updated.append({"key": setting.key, "value": setting.value, "description": setting.description})
    return updated


@router.post("/test-connection")
async def test_connection(
    payload: TestConnectionRequest,
    current_user: dict = Depends(require_admin)
):
    """
    Test an external API connection.
    Supports: plex, uptime_kuma, overseerr.
    Requires admin authentication.
    """
    service = payload.service
    url = payload.url.rstrip("/")
    credentials = payload.credentials or ""

    try:
        async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
            if service == "plex":
                resp = await client.get(
                    f"{url}/status/sessions",
                    params={"X-Plex-Token": credentials}
                )
            elif service == "uptime_kuma":
                resp = await client.get(f"{url}/api/status-page/heartbeat")
            elif service == "overseerr":
                resp = await client.get(
                    f"{url}/api/v1/status",
                    headers={"X-Api-Key": credentials}
                )
            elif service == "netdata":
                headers = {"Accept": "application/json"}
                if credentials:
                    headers["Authorization"] = f"Bearer {credentials}"
                resp = await client.get(
                    f"{url}/api/v1/info",
                    headers=headers
                )
            elif service == "sonarr":
                resp = await client.get(
                    f"{url}/api/v3/system/status",
                    headers={"X-Api-Key": credentials}
                )
            elif service == "radarr":
                resp = await client.get(
                    f"{url}/api/v3/system/status",
                    headers={"X-Api-Key": credentials}
                )
            else:
                return {"success": False, "message": f"Unknown service: {service}"}

            if resp.status_code == 200:
                return {"success": True, "message": "Connected successfully"}
            else:
                return {
                    "success": False,
                    "message": f"Service responded with HTTP {resp.status_code}"
                }
    except httpx.TimeoutException:
        return {"success": False, "message": "Connection timed out (5s)"}
    except httpx.ConnectError:
        return {"success": False, "message": f"Could not connect to {url}"}
    except Exception as e:
        return {"success": False, "message": f"Connection error: {str(e)}"}


# --- Logo Upload ---

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "uploads")
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"}
MAX_LOGO_SIZE = 2 * 1024 * 1024  # 2MB


@router.post("/upload-logo")
async def upload_logo(
    file: UploadFile = File(...),
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """
    Upload a logo image file. Saves to /static/uploads/ and updates branding.logo_url.
    Accepts PNG, JPEG, GIF, SVG, WebP up to 2MB.
    """
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type: {file.content_type}. Allowed: PNG, JPEG, GIF, SVG, WebP",
        )

    content = await file.read()
    if len(content) > MAX_LOGO_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File too large. Maximum size is 2MB.",
        )

    os.makedirs(UPLOAD_DIR, exist_ok=True)

    # Generate unique filename preserving extension
    ext = os.path.splitext(file.filename or "logo.png")[1].lower()
    if ext not in {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}:
        ext = ".png"
    filename = f"logo-{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(content)

    logo_url = f"/static/uploads/{filename}"

    # Update branding.logo_url setting
    setting = db.query(Setting).filter(Setting.key == "branding.logo_url").first()
    if setting:
        setting.value = logo_url
    else:
        db.add(Setting(key="branding.logo_url", value=logo_url, description="URL to custom logo image"))
    db.commit()

    return {"url": logo_url}


# --- Container Management ---

@router.post("/restart-container")
async def restart_container(
    current_user: dict = Depends(require_admin),
):
    """
    Restart the hms-dashboard container via Docker API.
    Requires admin. The response may not arrive since the container restarts.
    """
    import threading

    def _do_restart():
        import time
        time.sleep(1)  # Brief delay so the HTTP response can be sent
        try:
            import docker
            client = docker.from_env()
            container = client.containers.get("hms-dashboard")
            container.restart(timeout=10)
        except Exception as e:
            logger.error("Container restart failed: %s", str(e))

    threading.Thread(target=_do_restart, daemon=True).start()
    return {"success": True, "message": "Container restart initiated. Page will reload shortly."}


@router.post("/shutdown-container")
async def shutdown_container(
    current_user: dict = Depends(require_admin),
):
    """
    Stop the hms-dashboard container via Docker API.
    Requires admin. The dashboard will go offline.
    """
    import threading

    def _do_stop():
        import time
        time.sleep(1)  # Brief delay so the HTTP response can be sent
        try:
            import docker
            client = docker.from_env()
            container = client.containers.get("hms-dashboard")
            container.stop(timeout=10)
        except Exception as e:
            logger.error("Container shutdown failed: %s", str(e))

    threading.Thread(target=_do_stop, daemon=True).start()
    return {"success": True, "message": "Container shutdown initiated. The dashboard will go offline."}
