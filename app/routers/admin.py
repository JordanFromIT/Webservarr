"""
Admin API routes - Service management, settings, etc.
"""

import logging
import os
import re
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Literal, Optional, List
import httpx

from datetime import datetime, timedelta

from passlib.hash import bcrypt

from app.database import get_db
from app.limiter import limiter
from app.models import Setting, Notification, PushSubscription, User
from app.dependencies import require_admin
from app.services.push import send_push_to_users
from app.utils import validate_image_magic

logger = logging.getLogger(__name__)

CONTAINER_NAME = os.environ.get("CONTAINER_NAME", "webservarr")

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
    service: Literal["plex", "uptime_kuma", "seerr", "netdata", "sonarr", "radarr"]
    url: str
    credentials: Optional[str] = None


class AdminNotificationRequest(BaseModel):
    """Schema for admin broadcast notification."""
    title: str
    body: str


class AccountUpdateRequest(BaseModel):
    """Schema for updating admin account credentials."""
    current_password: str
    new_username: str = ""
    new_password: str = ""
    new_password_confirm: str = ""


# --- Account Management ---

@router.put("/account")
@limiter.limit("5/minute")
async def update_account(
    request: Request,
    data: AccountUpdateRequest,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """
    Update admin username and/or password.
    Only available for simple-auth users. Requires current password verification.
    """
    if current_user.get("auth_method") != "simple":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Account changes are only available for simple-auth users",
        )

    user = db.query(User).filter(User.username == current_user["username"]).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if not bcrypt.verify(data.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")

    changes = []

    # Update username
    if data.new_username:
        existing = db.query(User).filter(User.username == data.new_username).first()
        if existing and existing.id != user.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username already taken")
        user.username = data.new_username
        user.display_name = data.new_username
        changes.append("username")

    # Update password
    if data.new_password:
        if len(data.new_password) < 8:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New password must be at least 8 characters")
        if data.new_password != data.new_password_confirm:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New passwords do not match")
        user.password_hash = bcrypt.hash(data.new_password)
        changes.append("password")

    if not changes:
        return {"success": True, "message": "No changes requested", "updated": []}

    db.commit()
    return {"success": True, "message": "Account updated successfully", "updated": changes}


# --- Monitor Preferences ---

@router.put("/monitors/{monitor_id}")
@limiter.limit("30/minute")
async def update_monitor_preferences(
    request: Request,
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
        if prefs.icon and (len(prefs.icon) > 200 or not re.match(r'^[a-zA-Z0-9\-_/.:]+$', prefs.icon)):
            raise HTTPException(status_code=400, detail="Invalid icon value")
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
@limiter.limit("30/minute")
async def update_setting(
    request: Request,
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
        if ("api_key" in s.key or "token" in s.key) and value:
            value = "***masked***"
        result.append({
            "key": s.key,
            "value": value,
            "description": s.description
        })
    return result


@router.put("/settings/bulk")
@limiter.limit("30/minute")
async def bulk_update_settings(
    request: Request,
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
@limiter.limit("30/minute")
async def test_connection(
    request: Request,
    payload: TestConnectionRequest,
    current_user: dict = Depends(require_admin)
):
    """
    Test an external API connection.
    Supports: plex, uptime_kuma, seerr.
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
            elif service == "seerr":
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
@limiter.limit("10/minute")
async def upload_logo(
    request: Request,
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

    if not validate_image_magic(content, file.content_type):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File content does not match declared image type",
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


# --- Admin Broadcast Notification ---

@router.post("/notifications/send")
@limiter.limit("30/minute")
async def send_notification(
    request: Request,
    payload: AdminNotificationRequest,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """
    Broadcast a notification to all known users.
    Collects distinct emails from PushSubscription + Notification tables,
    creates a Notification row per user, and dispatches push notifications.
    Requires admin.
    """
    # Collect all known user emails
    cutoff = datetime.utcnow() - timedelta(days=30)
    push_emails = {
        row[0].lower()
        for row in db.query(PushSubscription.user_email).distinct().all()
        if row[0]
    }
    notif_emails = {
        row[0].lower()
        for row in db.query(Notification.user_email)
        .filter(Notification.created_at >= cutoff)
        .distinct()
        .all()
        if row[0]
    }
    all_emails = push_emails | notif_emails

    if not all_emails:
        return {"success": True, "sent_to": 0, "message": "No users to notify"}

    # Create a Notification row per user
    for email in all_emails:
        db.add(Notification(
            user_email=email,
            category="news",
            title=payload.title,
            body=payload.body,
        ))
    db.commit()

    # Dispatch push notifications
    await send_push_to_users(list(all_emails), payload.title, payload.body, "news", "/")

    return {"success": True, "sent_to": len(all_emails)}


# --- Container Management ---

@router.post("/restart-container")
@limiter.limit("30/minute")
async def restart_container(
    request: Request,
    current_user: dict = Depends(require_admin),
):
    """
    Restart the application container via Docker API.
    Requires admin. The response may not arrive since the container restarts.
    """
    import threading

    def _do_restart():
        import time
        time.sleep(1)  # Brief delay so the HTTP response can be sent
        try:
            import docker
            client = docker.from_env()
            container = client.containers.get(CONTAINER_NAME)
            container.restart(timeout=10)
        except Exception as e:
            logger.error("Container restart failed: %s", str(e))

    threading.Thread(target=_do_restart, daemon=True).start()
    return {"success": True, "message": "Container restart initiated. Page will reload shortly."}


@router.post("/shutdown-container")
@limiter.limit("30/minute")
async def shutdown_container(
    request: Request,
    current_user: dict = Depends(require_admin),
):
    """
    Stop the application container via Docker API.
    Requires admin. The dashboard will go offline.
    """
    import threading

    def _do_stop():
        import time
        time.sleep(1)  # Brief delay so the HTTP response can be sent
        try:
            import docker
            client = docker.from_env()
            container = client.containers.get(CONTAINER_NAME)
            container.stop(timeout=10)
        except Exception as e:
            logger.error("Container shutdown failed: %s", str(e))

    threading.Thread(target=_do_stop, daemon=True).start()
    return {"success": True, "message": "Container shutdown initiated. The dashboard will go offline."}
