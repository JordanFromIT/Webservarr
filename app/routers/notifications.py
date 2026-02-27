"""
Notification API routes - User notifications, preferences, and push subscriptions.
"""

import hashlib
import logging
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models import Notification, PushSubscription, Setting
from app.dependencies import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


# --- Pydantic schemas ---

class PreferencesUpdate(BaseModel):
    """Schema for updating notification preferences per category."""
    request: Optional[bool] = None
    issue: Optional[bool] = None
    service: Optional[bool] = None
    news: Optional[bool] = None
    ticket: Optional[bool] = None


class PushSubscribeKeys(BaseModel):
    """Push subscription key pair."""
    p256dh: str
    auth: str


class PushSubscribeRequest(BaseModel):
    """Schema for registering a browser push subscription."""
    endpoint: str
    keys: PushSubscribeKeys


# --- Helpers ---

NOTIFICATION_CATEGORIES = ("request", "issue", "service", "news", "ticket")


def _email_hash(email: str) -> str:
    """Return the first 16 hex chars of the SHA-256 digest of the lowercased email."""
    return hashlib.sha256(email.lower().encode()).hexdigest()[:16]


def _get_user_email(current_user: dict) -> str:
    """Extract and lowercase the user email from the session dict."""
    return (current_user.get("email") or "").lower()


# --- Notification list & management ---

@router.get("/notifications")
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List the current user's notifications, newest first."""
    email = _get_user_email(current_user)
    if not email:
        return {"notifications": [], "total": 0}

    query = db.query(Notification).filter(Notification.user_email == email)
    if unread_only:
        query = query.filter(Notification.read == False)  # noqa: E712

    total = query.count()

    rows = (
        query
        .order_by(Notification.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    notifications = [
        {
            "id": n.id,
            "category": n.category,
            "title": n.title,
            "body": n.body,
            "reference_id": n.reference_id,
            "read": n.read,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        }
        for n in rows
    ]

    return {"notifications": notifications, "total": total}


@router.get("/notifications/unread-count")
async def unread_count(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return the number of unread notifications for the current user."""
    email = _get_user_email(current_user)
    if not email:
        return {"count": 0}

    count = (
        db.query(Notification)
        .filter(Notification.user_email == email, Notification.read == False)  # noqa: E712
        .count()
    )
    return {"count": count}


@router.put("/notifications/{notification_id}/read")
async def mark_read(
    notification_id: int,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark a single notification as read. Verifies ownership."""
    email = _get_user_email(current_user)
    notif = db.query(Notification).filter(Notification.id == notification_id).first()

    if not notif or notif.user_email != email:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")

    notif.read = True
    db.commit()
    return {"success": True}


@router.put("/notifications/read-all")
async def mark_all_read(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark all of the current user's notifications as read."""
    email = _get_user_email(current_user)
    if not email:
        return {"success": True, "updated": 0}

    updated = (
        db.query(Notification)
        .filter(Notification.user_email == email, Notification.read == False)  # noqa: E712
        .update({Notification.read: True})
    )
    db.commit()
    return {"success": True, "updated": updated}


@router.delete("/notifications/{notification_id}")
async def delete_notification(
    notification_id: int,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a single notification. Verifies ownership."""
    email = _get_user_email(current_user)
    notif = db.query(Notification).filter(Notification.id == notification_id).first()

    if not notif or notif.user_email != email:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")

    db.delete(notif)
    db.commit()
    return {"success": True}


# --- Preferences ---

@router.get("/notifications/preferences")
async def get_preferences(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get the current user's per-category notification preferences. Defaults all to true."""
    email = _get_user_email(current_user)
    if not email:
        return {cat: True for cat in NOTIFICATION_CATEGORIES}

    eh = _email_hash(email)
    prefs = {}
    for cat in NOTIFICATION_CATEGORIES:
        key = f"notify.{eh}.{cat}"
        row = db.query(Setting).filter(Setting.key == key).first()
        prefs[cat] = row.value.lower() != "false" if row else True

    return prefs


@router.put("/notifications/preferences")
async def update_preferences(
    body: PreferencesUpdate,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update the current user's per-category notification preferences."""
    email = _get_user_email(current_user)
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No email in session")

    eh = _email_hash(email)
    updates = body.model_dump(exclude_none=True)

    for cat, enabled in updates.items():
        key = f"notify.{eh}.{cat}"
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = str(enabled).lower()
        else:
            db.add(Setting(key=key, value=str(enabled).lower(), description=f"Notification preference: {cat}"))

    db.commit()
    return {"success": True}


# --- Push subscription ---

@router.post("/notifications/push-subscribe")
async def push_subscribe(
    body: PushSubscribeRequest,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Register or update a browser push subscription for the current user."""
    email = _get_user_email(current_user)
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No email in session")

    # Upsert by user_email + endpoint
    existing = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_email == email, PushSubscription.endpoint == body.endpoint)
        .first()
    )

    if existing:
        existing.p256dh = body.keys.p256dh
        existing.auth = body.keys.auth
    else:
        db.add(PushSubscription(
            user_email=email,
            endpoint=body.endpoint,
            p256dh=body.keys.p256dh,
            auth=body.keys.auth,
        ))

    db.commit()
    return {"success": True}


@router.delete("/notifications/push-subscribe")
async def push_unsubscribe(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove all push subscriptions for the current user."""
    email = _get_user_email(current_user)
    if not email:
        return {"success": True, "removed": 0}

    removed = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_email == email)
        .delete()
    )
    db.commit()
    return {"success": True, "removed": removed}
