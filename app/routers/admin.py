"""
Admin API routes - Service management, settings, etc.
"""

import logging
import os
import uuid
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, UploadFile, File, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Literal, Optional, Set

from datetime import datetime, timedelta

from passlib.hash import bcrypt

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.limiter import limiter
from app.models import Setting, Notification, PushSubscription, User
from app.dependencies import require_admin
from app.integrations.config import same_address
from app.routers.admin_settings import effective_values
from app.services.integration_health import credential_key, probe_one
from app.services.push import dispatch_push, send_push_to_users
from app.settings_registry import MASK as MASK_SENTINEL, validate_value
from app.utils import identity_email, validate_image_magic

logger = logging.getLogger(__name__)

router = APIRouter()


# Pydantic schemas
class TestConnectionRequest(BaseModel):
    """Test an integration with the values on screen (saved or not)."""
    service: Literal["plex", "uptime_kuma", "seerr", "netdata", "sonarr", "radarr", "kavita", "chaptarr", "nyt"]
    url: str = ""
    credentials: Optional[str] = None
    slug: Optional[str] = None


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
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
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

    # Revoke this user's OTHER sessions after a password change so a changed
    # password invalidates any session that predates it (L10). The current
    # session is spared so the admin isn't logged out of the tab they're using.
    if "password" in changes:
        try:
            revoked = await session_manager.delete_user_sessions(
                current_user.get("auth_method", "simple"),
                str(user.id),
                exclude_session_id=session_id,
            )
            if revoked:
                logger.info(
                    "Revoked %d other session(s) after password change for user id=%s",
                    revoked,
                    user.id,
                )
        except Exception as e:
            logger.error("Failed to revoke sessions after password change: %s", str(e))

    return {"success": True, "message": "Account updated successfully", "updated": changes}


@router.post("/test-connection")
@limiter.limit("20/minute")
async def test_connection(
    request: Request,
    payload: TestConnectionRequest,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """
    Test an integration with the values currently on screen.

    Uses exactly the probe behind the Settings status lights
    (app/services/integration_health.py), so Test and the light always agree:
    same path, credential in a header, no redirects followed, address checked
    off the event loop, one 5 s deadline. A masked credential means "the one
    already saved"; the browser never holds the real value. The NYT API has a
    fixed address, so only its key is tested.

    The saved credential only ever goes to the saved address. Masking is what
    keeps stored secrets from an admin session, so a masked (or absent)
    credential with any other address on screen is not tested: pointing a
    card at another host would otherwise hand that host the saved token.
    """
    service = payload.service
    values = effective_values(db)
    cred_key = credential_key(service)
    saved_credential = payload.credentials is None or payload.credentials == MASK_SENTINEL
    if service != "nyt":
        url_key = f"integration.{service}.url"
        if cred_key and saved_credential and values.get(cred_key) \
                and not same_address(payload.url, values.get(url_key)):
            word = "token" if service == "plex" else "key"
            return {"success": False, "message": f"Enter the {word} again to test a new address", "state": "warn"}
        # As typed, like the credential: the probe tests what Save would store.
        values[url_key] = payload.url or ""
    if cred_key and not saved_credential:
        values[cred_key] = payload.credentials
    if service == "uptime_kuma" and payload.slug is not None:
        if validate_value("integration.uptime_kuma.slug", payload.slug):
            return {"success": False, "message": "That status page slug isn't valid", "state": "warn"}
        values["integration.uptime_kuma.slug"] = payload.slug
    result = await probe_one(service, values)
    return {"success": result["state"] == "ok", "message": result["reason"], "state": result["state"]}


# --- Logo Upload ---

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "uploads")
# SVG is intentionally excluded: it is served inline from the public /static tree
# and an SVG can carry inline <script>/onload, giving stored XSS in the app origin.
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
MAX_LOGO_SIZE = 2 * 1024 * 1024  # 2MB


@router.post("/upload-logo")
@limiter.limit("10/minute")
async def upload_logo(
    request: Request,
    file: UploadFile = File(...),
    current_user: dict = Depends(require_admin),
):
    """
    Upload a logo image file to /static/uploads/ and return its URL.
    The setting is written by Settings' Save (BulkSave), not here.
    Accepts PNG, JPEG, GIF, WebP up to 2MB. (SVG is rejected — XSS risk.)
    """
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type: {file.content_type}. Allowed: PNG, JPEG, GIF, WebP",
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
    if ext not in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        ext = ".png"
    filename = f"logo-{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(content)

    return {"url": f"/static/uploads/{filename}"}


# --- Admin Broadcast Notification ---

def _broadcast_recipients(db: Session) -> Set[str]:
    """Everyone an announcement reaches: push subscribers plus anyone notified
    in the last 30 days, by identity email (lower-cased, once each).

    identity_email drops rows filed under no identity ("" or the old shared
    "none"), so a broadcast never creates rows for one.
    """
    cutoff = datetime.utcnow() - timedelta(days=30)
    push_emails = {
        identity_email(row[0])
        for row in db.query(PushSubscription.user_email).distinct().all()
    }
    notif_emails = {
        identity_email(row[0])
        for row in db.query(Notification.user_email)
        .filter(Notification.created_at >= cutoff)
        .distinct()
        .all()
    }
    return (push_emails | notif_emails) - {""}


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
    all_emails = _broadcast_recipients(db)

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


@router.post("/notifications/test-push")
@limiter.limit("5/minute")
async def send_test_push(
    request: Request,
    current_user: dict = Depends(require_admin),
):
    """
    Send one test push to the calling admin's own devices, and nobody else's.
    Reports how many of the admin's stored subscriptions were tried and how
    many the push services accepted. Creates no notification rows.
    """
    email = identity_email(current_user.get("email"))
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Push notifications need an account email.",
        )

    result = await dispatch_push(
        [email],
        "Test notification",
        "Push notifications are working on this device.",
        "test",
        "/",
    )
    return {"success": result["succeeded"] > 0, **result}


@router.get("/notifications/status")
@limiter.limit("60/minute")
async def notifications_status(
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """PushStatus for Settings > Notifications: is push set up, how many
    devices and people have it, how many people an announcement reaches, and
    the last push. Counts only; no emails or endpoints leave the server.
    """
    from app.services import push

    reason = push.status_reason(db)

    # A device counts only when it belongs to an identity, the same rule
    # dispatch_push uses to choose who gets a push; people are counted
    # case-blind, as the broadcast list is.
    owners = [identity_email(row[0]) for row in db.query(PushSubscription.user_email).all()]
    owners = [e for e in owners if e]
    return {
        "push_ready": reason is None,
        "reason": reason,
        "devices": len(owners),
        "users": len(set(owners)),
        "recipients": len(_broadcast_recipients(db)),
        "last_push": await push.read_last_push(),
    }

