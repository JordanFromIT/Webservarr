"""
Notification API routes - User notifications, preferences, and push subscriptions.
"""

import hashlib
import logging
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.dependencies import get_current_user
from app.limiter import limiter
from app.models import Notification, PushSubscription, Setting
from app.services.notification_poller import push_username_key
from app.utils import is_safe_push_endpoint

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
@limiter.limit("30/minute")
async def mark_read(
    request: Request,
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
@limiter.limit("30/minute")
async def mark_all_read(
    request: Request,
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


# ":int" so this never swallows DELETE /notifications/push-subscribe below
# (declared later, it used to 422 as a non-integer notification id).
@router.delete("/notifications/{notification_id:int}")
@limiter.limit("30/minute")
async def delete_notification(
    request: Request,
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


@router.delete("/notifications")
@limiter.limit("30/minute")
async def delete_all_notifications(
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete all notifications for the current user."""
    email = _get_user_email(current_user)
    deleted = db.query(Notification).filter(Notification.user_email == email).delete()
    db.commit()
    return {"success": True, "deleted": deleted}


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
@limiter.limit("30/minute")
async def update_preferences(
    request: Request,
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
@limiter.limit("30/minute")
async def push_subscribe(
    request: Request,
    body: PushSubscribeRequest,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Register or update a browser push subscription for the current user."""
    email = _get_user_email(current_user)
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No email in session")

    # Anti-SSRF: the server POSTs to this endpoint on every notification dispatch.
    # Only allow public HTTPS browser-push services — never LAN/loopback/metadata.
    if not is_safe_push_endpoint(body.endpoint):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid push subscription endpoint",
        )

    # A push endpoint is one browser profile. If another account subscribed it
    # earlier (a shared computer), that account's notifications must stop
    # arriving here now that someone else is signed in on it.
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == body.endpoint,
        PushSubscription.user_email != email,
    ).delete(synchronize_session=False)

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

    # Remember which email this username subscribed with: tickets store only
    # the creator's username, and ticket alerts must reach a subscriber who
    # is signed out (see notification_poller.push_username_key).
    username = current_user.get("username") or ""
    if username:
        key = push_username_key(username)
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = email
        else:
            db.add(Setting(key=key, value=email, description="Push: email for a username (ticket alerts)"))

    db.commit()
    return {"success": True}


@router.get("/notifications/push-subscribe/status")
@limiter.limit("60/minute")
async def push_subscription_status(
    request: Request,
    endpoint: str = Query(..., max_length=2048),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Whether the server holds this browser's subscription for the current user.

    The browser keeping a subscription is not enough for pushes to arrive: the
    server must have stored it too. The settings toggle shows "on" only when
    both are true.
    """
    email = _get_user_email(current_user)
    if not email:
        return {"subscribed": False}

    found = (
        db.query(PushSubscription.id)
        .filter(PushSubscription.user_email == email, PushSubscription.endpoint == endpoint)
        .first()
    )
    return {"subscribed": found is not None}


@router.delete("/notifications/push-subscribe")
@limiter.limit("30/minute")
async def push_unsubscribe(
    request: Request,
    endpoint: Optional[str] = Query(None, max_length=2048),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove the current user's push subscription for one browser (``endpoint``),
    or all of them when no endpoint is given."""
    email = _get_user_email(current_user)
    if not email:
        return {"success": True, "removed": 0}

    query = db.query(PushSubscription).filter(PushSubscription.user_email == email)
    if endpoint:
        query = query.filter(PushSubscription.endpoint == endpoint)
    removed = query.delete(synchronize_session=False)
    db.commit()
    return {"success": True, "removed": removed}
