# Phase 6: Notifications — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add in-app notifications + browser push for non-admin users, with a background poller that detects events from Overseerr, Uptime Kuma, and the news system.

**Architecture:** New `Notification` and `PushSubscription` SQLAlchemy models in SQLite. Background asyncio polling loops (launched on FastAPI startup) check Overseerr, Uptime Kuma, and NewsPost table at configurable intervals, creating notification rows and dispatching web push via `pywebpush`. A new `/api/notifications` router serves the frontend. A shared `notifications.js` script adds bell icon, dropdown panel, preferences modal, and service worker registration to every page.

**Tech Stack:** FastAPI, SQLAlchemy, Redis (state snapshots), pywebpush (VAPID/Web Push), vanilla JS (Service Worker API, Push API, Notifications API)

**Design doc:** `docs/plans/2026-02-24-phase6-notifications-design.md`

**Testing approach:** No test framework exists in this project. Each task is verified by rebuilding the container (`ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"`) and testing via curl or Chrome DevTools MCP tools against dev.hmserver.tv.

---

## Task 1: Add pywebpush dependency

**Files:**
- Modify: `requirements.txt`

**Step 1: Add the dependency**

Add to `requirements.txt` after the `docker==7.0.0` line:

```
# Web Push notifications
pywebpush>=2.0.0
```

**Step 2: Commit**

```bash
git add requirements.txt
git commit -m "deps: add pywebpush for web push notifications"
```

---

## Task 2: Add Notification and PushSubscription models

**Files:**
- Modify: `app/models.py` (add 2 new classes after `Setting`)

**Step 1: Add the models**

Add after the `Setting` class (after line 128 of `app/models.py`):

```python
class Notification(Base):
    """User notifications."""
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, index=True)
    user_email = Column(String(200), nullable=False, index=True)
    category = Column(String(20), nullable=False)  # request, issue, service, news
    title = Column(String(200), nullable=False)
    body = Column(Text, nullable=True)
    reference_id = Column(String(100), nullable=True)  # External ID for dedup
    read = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    def __repr__(self):
        return f"<Notification(id={self.id}, category='{self.category}', user='{self.user_email}')>"


class PushSubscription(Base):
    """Browser push notification subscriptions."""
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    user_email = Column(String(200), nullable=False, index=True)
    endpoint = Column(Text, nullable=False)
    p256dh = Column(String(200), nullable=False)
    auth = Column(String(200), nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    def __repr__(self):
        return f"<PushSubscription(id={self.id}, user='{self.user_email}')>"
```

**Step 2: Commit**

```bash
git add app/models.py
git commit -m "feat: add Notification and PushSubscription models"
```

---

## Task 3: Seed notification settings and generate VAPID keys

**Files:**
- Modify: `app/seed.py` (add notification settings to DEFAULT_SETTINGS dict, add VAPID key generation function)

**Step 1: Add notification settings to DEFAULT_SETTINGS**

Add these entries to the `DEFAULT_SETTINGS` dict in `app/seed.py`:

```python
    # Notification polling intervals (seconds)
    "notifications.poll_interval_overseerr": ("60", "Seconds between Overseerr notification checks"),
    "notifications.poll_interval_monitors": ("60", "Seconds between Uptime Kuma notification checks"),
    "notifications.poll_interval_news": ("60", "Seconds between news post notification checks"),
```

**Step 2: Add VAPID key generation function**

Add a new function after `seed_default_settings`:

```python
def seed_vapid_keys(db: Session) -> None:
    """Generate VAPID keys for web push if they don't exist."""
    from sqlalchemy.exc import IntegrityError

    existing = db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").first()
    if existing:
        return

    try:
        from py_vapid import Vapid
        vapid = Vapid()
        vapid.generate_keys()
        # Export keys as URL-safe base64
        raw_priv = vapid.private_pem()
        raw_pub = vapid.public_key

        # Store as application server key (raw bytes -> base64url)
        import base64
        pub_bytes = vapid.public_key.public_bytes(
            encoding=__import__('cryptography.hazmat.primitives.serialization', fromlist=['Encoding']).Encoding.X962,
            format=__import__('cryptography.hazmat.primitives.serialization', fromlist=['PublicFormat']).PublicFormat.UncompressedPoint,
        )
        pub_b64 = base64.urlsafe_b64encode(pub_bytes).rstrip(b'=').decode('ascii')
        priv_pem = raw_priv.decode('utf-8') if isinstance(raw_priv, bytes) else raw_priv

        db.add(Setting(
            key="notifications.vapid_public_key",
            value=pub_b64,
            description="VAPID public key for web push (auto-generated)",
        ))
        db.add(Setting(
            key="notifications.vapid_private_key",
            value=priv_pem,
            description="VAPID private key for web push (auto-generated)",
        ))
        db.commit()
        logger.info("Generated VAPID keys for web push notifications")
    except IntegrityError:
        db.rollback()
    except ImportError:
        logger.warning("pywebpush not installed — VAPID keys not generated")
    except Exception as e:
        db.rollback()
        logger.warning("VAPID key generation failed: %s", str(e))
```

**Step 3: Call from database.py init_db**

In `app/database.py`, add the `seed_vapid_keys` call after `seed_default_settings` in `init_db()`:

```python
    from app.seed import seed_default_admin, seed_default_settings, seed_vapid_keys
    # ...
        seed_default_admin(db)
        seed_default_settings(db)
        seed_vapid_keys(db)
```

**Step 4: Rebuild and verify**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
ssh webserver "cd /root/hms-dashboard && docker compose logs --tail=20 hms-dashboard" | grep -i vapid
```

Expected: log line "Generated VAPID keys for web push notifications" on first boot.

**Step 5: Commit**

```bash
git add app/seed.py app/database.py
git commit -m "feat: seed notification settings and auto-generate VAPID keys"
```

---

## Task 4: Build notifications API router

**Files:**
- Create: `app/routers/notifications.py`
- Modify: `app/main.py` (register the router)

**Step 1: Create the notifications router**

Create `app/routers/notifications.py`:

```python
"""
Notification API routes — user-facing notifications and push subscriptions.
"""

import hashlib
import logging
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models import Notification, PushSubscription, Setting
from app.dependencies import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

CATEGORIES = ("request", "issue", "service", "news")


def _email_hash(email: str) -> str:
    """First 16 chars of SHA-256 hex digest of lowercased email."""
    return hashlib.sha256(email.lower().encode()).hexdigest()[:16]


# --- Notification CRUD ---

@router.get("/notifications")
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Fetch current user's notifications, newest first."""
    email = current_user.get("email", "")
    if not email:
        return {"notifications": [], "total": 0}

    query = db.query(Notification).filter(Notification.user_email == email.lower())
    if unread_only:
        query = query.filter(Notification.read == False)

    total = query.count()
    rows = query.order_by(desc(Notification.created_at)).offset(offset).limit(limit).all()

    return {
        "notifications": [
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
        ],
        "total": total,
    }


@router.get("/notifications/unread-count")
async def unread_count(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return unread notification count for current user."""
    email = current_user.get("email", "")
    if not email:
        return {"count": 0}
    count = (
        db.query(Notification)
        .filter(Notification.user_email == email.lower(), Notification.read == False)
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
    email = current_user.get("email", "")
    notif = db.query(Notification).filter(
        Notification.id == notification_id,
        Notification.user_email == email.lower(),
    ).first()
    if not notif:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    notif.read = True
    db.commit()
    return {"success": True}


@router.put("/notifications/read-all")
async def mark_all_read(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark all of current user's notifications as read."""
    email = current_user.get("email", "")
    if not email:
        return {"success": True, "updated": 0}
    updated = (
        db.query(Notification)
        .filter(Notification.user_email == email.lower(), Notification.read == False)
        .update({"read": True})
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
    email = current_user.get("email", "")
    notif = db.query(Notification).filter(
        Notification.id == notification_id,
        Notification.user_email == email.lower(),
    ).first()
    if not notif:
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
    """Get per-category notification toggles for current user."""
    email = current_user.get("email", "")
    if not email:
        return {cat: True for cat in CATEGORIES}

    ehash = _email_hash(email)
    prefs = {}
    for cat in CATEGORIES:
        key = f"notify.{ehash}.{cat}"
        row = db.query(Setting).filter(Setting.key == key).first()
        prefs[cat] = row.value != "false" if row else True
    return prefs


class PreferencesUpdate(BaseModel):
    request: Optional[bool] = None
    issue: Optional[bool] = None
    service: Optional[bool] = None
    news: Optional[bool] = None


@router.put("/notifications/preferences")
async def update_preferences(
    payload: PreferencesUpdate,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update per-category notification toggles."""
    email = current_user.get("email", "")
    if not email:
        raise HTTPException(status_code=400, detail="No email in session")

    ehash = _email_hash(email)
    updates = payload.model_dump(exclude_none=True)
    for cat, enabled in updates.items():
        key = f"notify.{ehash}.{cat}"
        row = db.query(Setting).filter(Setting.key == key).first()
        val = str(enabled).lower()
        if row:
            row.value = val
        else:
            db.add(Setting(key=key, value=val, description=f"Notification pref for {email}"))
    db.commit()
    return {"success": True}


# --- Push Subscriptions ---

class PushSubscribeRequest(BaseModel):
    endpoint: str
    keys: dict  # {"p256dh": "...", "auth": "..."}


@router.post("/notifications/push-subscribe")
async def push_subscribe(
    payload: PushSubscribeRequest,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Register a browser push subscription."""
    email = current_user.get("email", "")
    if not email:
        raise HTTPException(status_code=400, detail="No email in session")

    p256dh = payload.keys.get("p256dh", "")
    auth_key = payload.keys.get("auth", "")
    if not payload.endpoint or not p256dh or not auth_key:
        raise HTTPException(status_code=400, detail="Missing push subscription fields")

    # Upsert: delete existing sub for this user+endpoint, then insert
    db.query(PushSubscription).filter(
        PushSubscription.user_email == email.lower(),
        PushSubscription.endpoint == payload.endpoint,
    ).delete()
    db.add(PushSubscription(
        user_email=email.lower(),
        endpoint=payload.endpoint,
        p256dh=p256dh,
        auth=auth_key,
    ))
    db.commit()
    return {"success": True}


@router.delete("/notifications/push-subscribe")
async def push_unsubscribe(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove all push subscriptions for current user."""
    email = current_user.get("email", "")
    if not email:
        return {"success": True}
    db.query(PushSubscription).filter(
        PushSubscription.user_email == email.lower(),
    ).delete()
    db.commit()
    return {"success": True}
```

**Step 2: Register the router in main.py**

In `app/main.py`, add the import and include:

After the existing import line:
```python
from app.routers import news, status, admin, simple_auth, integrations, auth as oidc_auth, branding
```
Change to:
```python
from app.routers import news, status, admin, simple_auth, integrations, auth as oidc_auth, branding, notifications
```

After the existing branding router include (line 125):
```python
app.include_router(notifications.router, prefix="/api", tags=["Notifications"])
```

**Step 3: Rebuild and verify**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
# Test unread count (should return 0)
ssh webserver 'curl -s -b "hms_session=<session_id>" http://localhost:8000/api/notifications/unread-count'
```

Expected: `{"count":0}`

**Step 4: Commit**

```bash
git add app/routers/notifications.py app/main.py
git commit -m "feat: add notifications API router (CRUD, preferences, push subscriptions)"
```

---

## Task 5: Add admin send-notification endpoint

**Files:**
- Modify: `app/routers/admin.py` (add POST /api/admin/notifications/send)

**Step 1: Add the endpoint**

Add at the end of `app/routers/admin.py`, before the container management section (before line 316):

```python
# --- Admin Notifications ---

class AdminNotificationRequest(BaseModel):
    title: str
    body: str


@router.post("/notifications/send")
async def send_admin_notification(
    payload: AdminNotificationRequest,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """
    Send a custom notification to all users with active push subscriptions
    or recent notifications. Admin only.
    """
    from app.models import Notification, PushSubscription

    # Collect all known user emails from push subscriptions
    subs = db.query(PushSubscription.user_email).distinct().all()
    emails = {row[0] for row in subs}

    # Also collect emails from recent notifications (last 30 days)
    from datetime import datetime, timedelta
    cutoff = datetime.utcnow() - timedelta(days=30)
    recent = (
        db.query(Notification.user_email)
        .filter(Notification.created_at >= cutoff)
        .distinct()
        .all()
    )
    emails.update(row[0] for row in recent)

    if not emails:
        return {"success": True, "sent_to": 0, "message": "No users to notify"}

    created = 0
    for email in emails:
        db.add(Notification(
            user_email=email,
            category="news",
            title=payload.title,
            body=payload.body,
        ))
        created += 1
    db.commit()

    # Send push notifications
    from app.services.push import send_push_to_users
    await send_push_to_users(db, list(emails), payload.title, payload.body, "news", "/")

    return {"success": True, "sent_to": created}
```

Note: `send_push_to_users` won't exist yet — it gets created in Task 6. This endpoint will fail if called before Task 6, which is fine.

**Step 2: Commit**

```bash
git add app/routers/admin.py
git commit -m "feat: add admin send-notification endpoint"
```

---

## Task 6: Build push notification dispatch service

**Files:**
- Create: `app/services/__init__.py`
- Create: `app/services/push.py`

**Step 1: Create package init**

Create `app/services/__init__.py` as an empty file.

**Step 2: Create push dispatch module**

Create `app/services/push.py`:

```python
"""
Web Push notification dispatch.
Sends push notifications via pywebpush using VAPID keys from settings.
"""

import json
import logging
from sqlalchemy.orm import Session
from app.models import PushSubscription, Setting

logger = logging.getLogger(__name__)


def _get_vapid_keys(db: Session) -> tuple[str | None, str | None]:
    """Read VAPID keys from settings."""
    pub = db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").first()
    priv = db.query(Setting).filter(Setting.key == "notifications.vapid_private_key").first()
    return (pub.value if pub else None, priv.value if priv else None)


async def send_push_to_users(
    db: Session,
    emails: list[str],
    title: str,
    body: str,
    category: str,
    url: str = "/",
) -> int:
    """
    Send a web push notification to all push subscriptions for the given emails.
    Returns number of successful pushes sent.
    """
    from pywebpush import webpush, WebPushException

    vapid_pub, vapid_priv = _get_vapid_keys(db)
    if not vapid_pub or not vapid_priv:
        logger.debug("VAPID keys not configured — skipping push")
        return 0

    subs = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_email.in_([e.lower() for e in emails]))
        .all()
    )

    if not subs:
        return 0

    payload = json.dumps({
        "title": title,
        "body": body,
        "category": category,
        "url": url,
    })

    sent = 0
    stale_ids = []

    for sub in subs:
        subscription_info = {
            "endpoint": sub.endpoint,
            "keys": {
                "p256dh": sub.p256dh,
                "auth": sub.auth,
            },
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=vapid_priv,
                vapid_claims={"sub": "mailto:admin@hmserver.tv"},
            )
            sent += 1
        except WebPushException as e:
            if "410" in str(e) or "404" in str(e):
                # Subscription expired or gone — mark for cleanup
                stale_ids.append(sub.id)
                logger.info("Push subscription %d expired (user %s), removing", sub.id, sub.user_email)
            else:
                logger.warning("Push failed for subscription %d: %s", sub.id, str(e))
        except Exception as e:
            logger.warning("Push error for subscription %d: %s", sub.id, str(e))

    # Clean up stale subscriptions
    if stale_ids:
        db.query(PushSubscription).filter(PushSubscription.id.in_(stale_ids)).delete(synchronize_session=False)
        db.commit()

    logger.info("Sent %d push notifications (%d stale cleaned)", sent, len(stale_ids))
    return sent
```

**Step 3: Commit**

```bash
git add app/services/__init__.py app/services/push.py
git commit -m "feat: add web push dispatch service with VAPID and stale sub cleanup"
```

---

## Task 7: Build notification poller background service

**Files:**
- Create: `app/services/notification_poller.py`
- Modify: `app/main.py` (start/stop poller in lifespan)

**Step 1: Create the poller**

Create `app/services/notification_poller.py`:

```python
"""
Background notification poller.
Periodically checks Overseerr, Uptime Kuma, and NewsPost table for changes,
creates Notification rows, and dispatches push notifications.
"""

import asyncio
import hashlib
import logging
from datetime import datetime, timezone

import httpx
import redis.asyncio as aioredis
from sqlalchemy.orm import Session as SASession

from app.config import settings as app_settings
from app.database import SessionLocal
from app.models import Notification, PushSubscription, Setting, NewsPost
from app.services.push import send_push_to_users

logger = logging.getLogger(__name__)

# Category → URL mapping for push payloads
CATEGORY_URLS = {
    "request": "/requests2",
    "issue": "/issues",
    "service": "/",
    "news": "/",
}


def _email_hash(email: str) -> str:
    return hashlib.sha256(email.lower().encode()).hexdigest()[:16]


def _user_wants_category(db: SASession, email: str, category: str) -> bool:
    """Check if user has this notification category enabled (default: True)."""
    ehash = _email_hash(email)
    row = db.query(Setting).filter(Setting.key == f"notify.{ehash}.{category}").first()
    return row.value != "false" if row else True


def _get_setting_int(db: SASession, key: str, default: int) -> int:
    """Read an integer setting, returning default if missing or invalid."""
    row = db.query(Setting).filter(Setting.key == key).first()
    if not row:
        return default
    try:
        val = int(row.value)
        return max(val, 30)  # Floor at 30 seconds
    except (ValueError, TypeError):
        return default


def _create_notification(
    db: SASession, email: str, category: str, title: str, body: str, reference_id: str = None
) -> Notification | None:
    """Create a notification if no duplicate exists. Returns the row or None."""
    email = email.lower()

    # Dedup check: same user + category + reference_id
    if reference_id:
        existing = db.query(Notification).filter(
            Notification.user_email == email,
            Notification.category == category,
            Notification.reference_id == reference_id,
        ).first()
        if existing:
            return None

    notif = Notification(
        user_email=email,
        category=category,
        title=title,
        body=body,
        reference_id=reference_id,
    )
    db.add(notif)
    return notif


async def _get_active_session_emails(redis: aioredis.Redis) -> set[str]:
    """Scan Redis for all active session emails."""
    emails = set()
    async for key in redis.scan_iter(match="session:*"):
        data = await redis.hgetall(key)
        email = data.get(b"email", b"").decode()
        if email:
            emails.add(email.lower())
    return emails


async def _get_all_known_emails(db: SASession, redis: aioredis.Redis) -> set[str]:
    """Union of active session emails and push subscription emails."""
    session_emails = await _get_active_session_emails(redis)
    sub_emails = {row[0] for row in db.query(PushSubscription.user_email).distinct().all()}
    return session_emails | sub_emails


def _get_overseerr_config(db: SASession) -> dict:
    url = db.query(Setting).filter(Setting.key == "integration.overseerr.url").first()
    key = db.query(Setting).filter(Setting.key == "integration.overseerr.api_key").first()
    return {
        "url": url.value.rstrip("/") if url and url.value else None,
        "api_key": key.value if key and key.value else None,
    }


def _get_uptime_kuma_config(db: SASession) -> dict:
    url = db.query(Setting).filter(Setting.key == "integration.uptime_kuma.url").first()
    slug = db.query(Setting).filter(Setting.key == "integration.uptime_kuma.slug").first()
    return {
        "url": url.value.rstrip("/") if url and url.value else None,
        "slug": slug.value if slug and slug.value else "default",
    }


# ---- Overseerr Polling ----

async def _poll_overseerr(redis: aioredis.Redis, first_run: bool):
    """Check Overseerr for request status changes and new issue comments."""
    db = SessionLocal()
    try:
        config = _get_overseerr_config(db)
        if not config["url"] or not config["api_key"]:
            return

        headers = {"X-Api-Key": config["api_key"]}

        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            # --- Requests ---
            try:
                resp = await client.get(
                    f"{config['url']}/api/v1/request",
                    params={"take": 50, "sort": "added", "skip": 0},
                    headers=headers,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    users_to_push = []

                    for req in data.get("results", []):
                        req_id = str(req.get("id", 0))
                        media = req.get("media", {})
                        media_status = media.get("status", 0)

                        # Map media status to label
                        status_map = {1: "unknown", 2: "pending", 3: "processing", 4: "partially_available", 5: "available"}
                        status_label = status_map.get(media_status, "unknown")

                        # Get previous status from Redis
                        redis_key = f"poller:request:{req_id}"
                        prev = await redis.get(redis_key)
                        prev_status = prev.decode() if prev else None

                        # Store current status
                        await redis.set(redis_key, status_label)

                        if first_run or prev_status is None:
                            continue  # Seed run — don't notify

                        if status_label == "available" and prev_status != "available":
                            # Request became available — notify the requester
                            requester = req.get("requestedBy", {})
                            email = requester.get("email", "")
                            if not email:
                                continue

                            # Get media title
                            tmdb_id = media.get("tmdbId", 0)
                            media_type = req.get("type", "movie")
                            title_text = "Unknown"
                            if tmdb_id:
                                try:
                                    endpoint = "movie" if media_type == "movie" else "tv"
                                    detail_resp = await client.get(
                                        f"{config['url']}/api/v1/{endpoint}/{tmdb_id}",
                                        headers=headers,
                                    )
                                    if detail_resp.status_code == 200:
                                        d = detail_resp.json()
                                        title_text = d.get("title") or d.get("name", "Unknown")
                                except Exception:
                                    pass

                            email = email.lower()
                            if _user_wants_category(db, email, "request"):
                                notif = _create_notification(
                                    db, email, "request",
                                    "Your request is available",
                                    f"{title_text} is now available on Plex",
                                    reference_id=f"request:{req_id}:available",
                                )
                                if notif:
                                    users_to_push.append(email)

                    if users_to_push:
                        db.commit()
                        await send_push_to_users(
                            db, users_to_push,
                            "Your request is available",
                            "A media request you made is now available on Plex",
                            "request", "/requests2",
                        )

            except Exception as e:
                logger.warning("Overseerr request poll error: %s", str(e))

            # --- Issues ---
            try:
                resp = await client.get(
                    f"{config['url']}/api/v1/issue",
                    params={"take": 50, "sort": "added", "skip": 0},
                    headers=headers,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    users_to_push = []

                    for issue in data.get("results", []):
                        issue_id = str(issue.get("id", 0))

                        # Fetch detail to get comment count
                        try:
                            detail_resp = await client.get(
                                f"{config['url']}/api/v1/issue/{issue_id}",
                                headers=headers,
                            )
                            if detail_resp.status_code != 200:
                                continue
                            detail = detail_resp.json()
                        except Exception:
                            continue

                        comment_count = len(detail.get("comments", []))
                        issue_status_code = detail.get("status", 1)
                        status_map = {1: "open", 2: "resolved"}
                        issue_status = status_map.get(issue_status_code, "open")

                        snapshot = f"{comment_count}:{issue_status}"
                        redis_key = f"poller:issue:{issue_id}"
                        prev = await redis.get(redis_key)
                        prev_snapshot = prev.decode() if prev else None

                        await redis.set(redis_key, snapshot)

                        if first_run or prev_snapshot is None:
                            continue

                        prev_count, prev_status = prev_snapshot.split(":", 1) if ":" in prev_snapshot else ("0", "open")

                        # Get issue creator email
                        created_by = detail.get("createdBy", {})
                        email = created_by.get("email", "")
                        if not email:
                            continue
                        email = email.lower()

                        # Get media title for context
                        media = detail.get("media", {})
                        tmdb_id = media.get("tmdbId", 0)
                        media_type = media.get("mediaType", "movie")
                        title_text = "Unknown"
                        if tmdb_id:
                            try:
                                ep = "movie" if media_type == "movie" else "tv"
                                tr = await client.get(f"{config['url']}/api/v1/{ep}/{tmdb_id}", headers=headers)
                                if tr.status_code == 200:
                                    title_text = tr.json().get("title") or tr.json().get("name", "Unknown")
                            except Exception:
                                pass

                        issue_type_map = {1: "video", 2: "audio", 3: "subtitles", 4: "other"}
                        issue_type = issue_type_map.get(detail.get("issueType", 0), "other")

                        if issue_status == "resolved" and prev_status != "resolved":
                            if _user_wants_category(db, email, "issue"):
                                notif = _create_notification(
                                    db, email, "issue",
                                    "Your issue has been resolved",
                                    f"{title_text} — {issue_type} issue resolved",
                                    reference_id=f"issue:{issue_id}:resolved",
                                )
                                if notif:
                                    users_to_push.append(email)

                        elif int(prev_count) < comment_count:
                            if _user_wants_category(db, email, "issue"):
                                notif = _create_notification(
                                    db, email, "issue",
                                    "New response on your issue",
                                    f"{title_text} — {issue_type} issue has a new comment",
                                    reference_id=f"issue:{issue_id}:comment:{comment_count}",
                                )
                                if notif:
                                    users_to_push.append(email)

                    if users_to_push:
                        db.commit()
                        await send_push_to_users(
                            db, users_to_push,
                            "Issue update",
                            "An issue you reported has been updated",
                            "issue", "/issues",
                        )

            except Exception as e:
                logger.warning("Overseerr issue poll error: %s", str(e))

    finally:
        db.close()


# ---- Uptime Kuma Polling ----

async def _poll_monitors(redis: aioredis.Redis, first_run: bool):
    """Check Uptime Kuma for monitor status changes."""
    db = SessionLocal()
    try:
        from app.integrations.uptime_kuma import get_monitors
        monitors = await get_monitors(db)
        if not monitors:
            return

        users_to_push = []

        for mon in monitors:
            mon_id = str(mon["id"])
            current_status = mon["status"]

            redis_key = f"poller:monitor:{mon_id}"
            prev = await redis.get(redis_key)
            prev_status = prev.decode() if prev else None

            await redis.set(redis_key, current_status)

            if first_run or prev_status is None:
                continue

            if current_status != prev_status:
                # Status changed — notify all logged-in users
                emails = await _get_active_session_emails(redis)
                name = mon.get("name", f"Monitor {mon_id}")
                title = f"{name} is {current_status}"
                body = mon.get("status_message", "") or f"Status changed from {prev_status} to {current_status}"

                for email in emails:
                    if _user_wants_category(db, email, "service"):
                        _create_notification(
                            db, email, "service",
                            title, body,
                            reference_id=f"monitor:{mon_id}:{current_status}",
                        )
                        users_to_push.append(email)

        if users_to_push:
            db.commit()
            await send_push_to_users(
                db, list(set(users_to_push)),
                "Service status change",
                "A monitored service has changed status",
                "service", "/",
            )

    except Exception as e:
        logger.warning("Monitor poll error: %s", str(e))
    finally:
        db.close()


# ---- News Polling ----

async def _poll_news(redis: aioredis.Redis, first_run: bool):
    """Check for newly published news posts."""
    db = SessionLocal()
    try:
        redis_key = "poller:news:last_check"
        prev = await redis.get(redis_key)

        now = datetime.now(timezone.utc)
        await redis.set(redis_key, now.isoformat())

        if first_run or prev is None:
            return  # Seed run

        last_check = datetime.fromisoformat(prev.decode())

        # Query for news published since last check
        new_posts = (
            db.query(NewsPost)
            .filter(
                NewsPost.published == True,
                NewsPost.published_at != None,
                NewsPost.published_at >= last_check,
            )
            .all()
        )

        if not new_posts:
            return

        emails = await _get_all_known_emails(db, redis)
        if not emails:
            return

        users_to_push = []
        for post in new_posts:
            for email in emails:
                if _user_wants_category(db, email, "news"):
                    _create_notification(
                        db, email, "news",
                        "New announcement",
                        post.title,
                        reference_id=f"news:{post.id}",
                    )
                    users_to_push.append(email)

        if users_to_push:
            db.commit()
            for post in new_posts:
                await send_push_to_users(
                    db, list(set(users_to_push)),
                    "New announcement",
                    post.title,
                    "news", "/",
                )

    except Exception as e:
        logger.warning("News poll error: %s", str(e))
    finally:
        db.close()


# ---- Main Polling Loop ----

_running = False


async def start_poller():
    """Start the background polling loops."""
    global _running
    _running = True

    redis = await aioredis.from_url(app_settings.redis_url)
    logger.info("Notification poller started")

    first_run_overseerr = True
    first_run_monitors = True
    first_run_news = True

    # Track independent timers
    last_overseerr = 0.0
    last_monitors = 0.0
    last_news = 0.0

    while _running:
        try:
            now = asyncio.get_event_loop().time()

            # Read intervals from DB
            db = SessionLocal()
            try:
                interval_overseerr = _get_setting_int(db, "notifications.poll_interval_overseerr", 60)
                interval_monitors = _get_setting_int(db, "notifications.poll_interval_monitors", 60)
                interval_news = _get_setting_int(db, "notifications.poll_interval_news", 60)
            finally:
                db.close()

            # Overseerr poll
            if now - last_overseerr >= interval_overseerr:
                await _poll_overseerr(redis, first_run_overseerr)
                first_run_overseerr = False
                last_overseerr = now

            # Monitor poll
            if now - last_monitors >= interval_monitors:
                await _poll_monitors(redis, first_run_monitors)
                first_run_monitors = False
                last_monitors = now

            # News poll
            if now - last_news >= interval_news:
                await _poll_news(redis, first_run_news)
                first_run_news = False
                last_news = now

            await asyncio.sleep(5)  # Check every 5s if any poll is due

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Poller loop error: %s", str(e))
            await asyncio.sleep(10)

    await redis.close()
    logger.info("Notification poller stopped")


async def stop_poller():
    """Signal the poller to stop."""
    global _running
    _running = False
```

**Step 2: Wire poller into FastAPI lifespan in main.py**

Modify the `lifespan` function in `app/main.py`:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events."""
    # Startup
    logger.info("Starting HMS Dashboard...")
    logger.info(f"Environment: {settings.app_env}")

    # Initialize database
    logger.info("Initializing database...")
    init_db()

    # Initialize Redis connection
    await session_manager.get_redis()
    logger.info("Redis connection established")

    # Start notification poller
    from app.services.notification_poller import start_poller, stop_poller
    poller_task = asyncio.create_task(start_poller())

    logger.info("HMS Dashboard started successfully!")

    yield

    # Shutdown
    logger.info("Shutting down HMS Dashboard...")
    await stop_poller()
    poller_task.cancel()
    try:
        await poller_task
    except asyncio.CancelledError:
        pass
    await session_manager.close()
    logger.info("HMS Dashboard shut down")
```

Also add `import asyncio` at the top of `app/main.py` if not already present.

**Step 3: Rebuild and verify**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
ssh webserver "cd /root/hms-dashboard && docker compose logs --tail=30 hms-dashboard" | grep -i poller
```

Expected: "Notification poller started" in logs.

**Step 4: Commit**

```bash
git add app/services/notification_poller.py app/main.py
git commit -m "feat: add background notification poller with Overseerr/Kuma/news detection"
```

---

## Task 8: Add vapid_public_key to branding API

**Files:**
- Modify: `app/routers/branding.py`

**Step 1: Add VAPID key to branding response**

In `app/routers/branding.py`, inside the `get_branding` function, after fetching the existing settings rows, also fetch the VAPID public key and include it in the response.

After the existing `keys = list(DEFAULTS.keys())` / `rows = ...` query block, add:

```python
    # Fetch VAPID public key separately (not in DEFAULTS — auto-generated)
    vapid_row = db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").first()
    vapid_public_key = vapid_row.value if vapid_row else None
```

Then add to the return dict (after `"icons": {...}`):

```python
        "vapid_public_key": vapid_public_key,
```

**Step 2: Commit**

```bash
git add app/routers/branding.py
git commit -m "feat: expose vapid_public_key in branding API for push subscription"
```

---

## Task 9: Create the service worker

**Files:**
- Create: `app/static/sw.js`

**Step 1: Create the service worker file**

Create `app/static/sw.js`:

```javascript
/*
 * HMS Dashboard — Service Worker for Push Notifications
 */

self.addEventListener('push', function(event) {
  if (!event.data) return;

  var payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: 'HMS Dashboard', body: event.data.text() };
  }

  var title = payload.title || 'HMS Dashboard';
  var options = {
    body: payload.body || '',
    icon: '/static/uploads/logo.png',
    badge: '/static/uploads/logo.png',
    tag: payload.category || 'notification',
    data: {
      url: payload.url || '/',
      category: payload.category || 'news',
    },
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  var url = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // Focus existing tab if found
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.indexOf(self.location.origin) !== -1 && 'focus' in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      // Open new tab
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
```

**Step 2: Commit**

```bash
git add app/static/sw.js
git commit -m "feat: add service worker for push notification display and click handling"
```

---

## Task 10: Create shared notifications.js

**Files:**
- Create: `app/static/js/notifications.js`

**Step 1: Create the shared notification script**

Create `app/static/js/notifications.js`:

```javascript
/*
 * HMS Dashboard — Shared Notification UI
 * Bell icon, dropdown panel, preferences modal, push subscription.
 * Call initNotifications() from DOMContentLoaded on every page.
 */

(function() {
  'use strict';

  var _pollInterval = null;
  var _panelOpen = false;
  var _prefsOpen = false;
  var _lastCount = 0;

  // Category icon mapping (Material Symbols)
  var CATEGORY_ICONS = {
    request: 'movie',
    issue: 'report_problem',
    service: 'health_metrics',
    news: 'newspaper',
  };

  var CATEGORY_URLS = {
    request: '/requests2',
    issue: '/issues',
    service: '/',
    news: '/',
  };

  // ---- Helpers ----

  function timeAgo(isoString) {
    if (!isoString) return '';
    var diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function createEl(tag, classes, text) {
    var el = document.createElement(tag);
    if (classes) el.className = classes;
    if (text) el.textContent = text;
    return el;
  }

  // ---- Badge ----

  function updateBadge(count) {
    var badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.remove('hidden');
      // Pulse animation on increase
      if (count > _lastCount) {
        badge.classList.remove('animate-pulse-once');
        void badge.offsetWidth; // reflow
        badge.classList.add('animate-pulse-once');
      }
    } else {
      badge.classList.add('hidden');
    }
    _lastCount = count;
  }

  async function fetchUnreadCount() {
    try {
      var resp = await fetch('/api/notifications/unread-count');
      if (resp.ok) {
        var data = await resp.json();
        updateBadge(data.count || 0);
      }
    } catch (e) { /* silent */ }
  }

  // ---- Dropdown Panel ----

  function buildNotificationItem(notif) {
    var item = createEl('button', 'w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ' +
      (notif.read ? 'hover:bg-white/5' : 'bg-primary/5 hover:bg-primary/10'));

    // Category icon
    var iconName = CATEGORY_ICONS[notif.category] || 'notifications';
    var icon = createEl('span', 'material-symbols-outlined text-lg text-steel-blue mt-0.5');
    icon.textContent = iconName;
    item.appendChild(icon);

    // Text content
    var content = createEl('div', 'flex-1 min-w-0');

    var titleRow = createEl('div', 'flex items-center gap-2');
    var titleEl = createEl('p', 'text-sm font-semibold text-white truncate');
    titleEl.textContent = notif.title;
    titleRow.appendChild(titleEl);
    if (!notif.read) {
      var dot = createEl('span', 'size-2 rounded-full bg-primary shrink-0');
      titleRow.appendChild(dot);
    }
    content.appendChild(titleRow);

    if (notif.body) {
      var bodyEl = createEl('p', 'text-xs text-steel-blue truncate mt-0.5');
      bodyEl.textContent = notif.body;
      content.appendChild(bodyEl);
    }

    var timeEl = createEl('p', 'text-[10px] text-steel-blue/60 mt-1');
    timeEl.textContent = timeAgo(notif.created_at);
    content.appendChild(timeEl);

    item.appendChild(content);

    // Click handler
    item.addEventListener('click', function() {
      markRead(notif.id);
      var url = CATEGORY_URLS[notif.category] || '/';
      window.location.href = url;
    });

    return item;
  }

  async function loadNotifications() {
    var list = document.getElementById('notifList');
    if (!list) return;

    list.textContent = '';
    var loading = createEl('p', 'px-4 py-6 text-center text-sm text-steel-blue', 'Loading...');
    list.appendChild(loading);

    try {
      var resp = await fetch('/api/notifications?limit=10');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();

      list.textContent = '';

      if (!data.notifications || data.notifications.length === 0) {
        var empty = createEl('p', 'px-4 py-8 text-center text-sm text-steel-blue/60', 'No notifications');
        list.appendChild(empty);
        return;
      }

      data.notifications.forEach(function(notif) {
        list.appendChild(buildNotificationItem(notif));
      });
    } catch (e) {
      list.textContent = '';
      var err = createEl('p', 'px-4 py-6 text-center text-sm text-red-400', 'Failed to load notifications');
      list.appendChild(err);
    }
  }

  async function markRead(id) {
    try {
      await fetch('/api/notifications/' + id + '/read', { method: 'PUT' });
      fetchUnreadCount();
    } catch (e) { /* silent */ }
  }

  async function markAllRead() {
    try {
      await fetch('/api/notifications/read-all', { method: 'PUT' });
      fetchUnreadCount();
      loadNotifications();
    } catch (e) { /* silent */ }
  }

  function togglePanel() {
    var panel = document.getElementById('notifPanel');
    if (!panel) return;
    _panelOpen = !_panelOpen;
    if (_panelOpen) {
      panel.classList.remove('hidden');
      loadNotifications();
    } else {
      panel.classList.add('hidden');
    }
  }

  // ---- Preferences Modal ----

  async function openPreferences() {
    _prefsOpen = true;
    var overlay = document.getElementById('notifPrefsOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      await loadPreferences();
      return;
    }

    // Build modal
    overlay = createEl('div', 'fixed inset-0 bg-black/60 flex items-center justify-center z-[60]');
    overlay.id = 'notifPrefsOverlay';
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closePreferences();
    });

    var modal = createEl('div', 'bg-black/95 border border-steel-blue/30 rounded-xl shadow-xl w-80 max-w-[90vw]');

    // Header
    var header = createEl('div', 'flex items-center justify-between px-5 py-4 border-b border-steel-blue/20');
    header.appendChild(createEl('h3', 'text-sm font-bold text-frosted-blue', 'Notification Settings'));
    var closeBtn = createEl('button', 'text-steel-blue hover:text-frosted-blue');
    closeBtn.appendChild(createEl('span', 'material-symbols-outlined text-lg', 'close'));
    closeBtn.addEventListener('click', closePreferences);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Toggles
    var body = createEl('div', 'px-5 py-4 space-y-4');
    body.id = 'notifPrefsBody';

    var categories = [
      { key: 'request', label: 'Media Requests', desc: 'When your requests become available' },
      { key: 'issue', label: 'Issue Updates', desc: 'Responses and resolutions on your issues' },
      { key: 'service', label: 'Service Status', desc: 'When services go up or down' },
      { key: 'news', label: 'Announcements', desc: 'New news posts from admins' },
    ];

    categories.forEach(function(cat) {
      var row = createEl('div', 'flex items-center justify-between gap-3');
      var info = createEl('div', '');
      info.appendChild(createEl('p', 'text-sm font-semibold text-white', cat.label));
      info.appendChild(createEl('p', 'text-[11px] text-steel-blue', cat.desc));
      row.appendChild(info);

      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.id = 'notifPref_' + cat.key;
      toggle.className = 'w-9 h-5 rounded-full appearance-none bg-steel-blue/30 checked:bg-primary relative cursor-pointer transition-colors ' +
        'after:content-[\'\'] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:rounded-full after:bg-white after:transition-transform ' +
        'checked:after:translate-x-4';
      toggle.addEventListener('change', savePreferences);
      row.appendChild(toggle);
      body.appendChild(row);
    });

    // Push toggle
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      var divider = createEl('div', 'border-t border-steel-blue/20 pt-4');
      var pushRow = createEl('div', 'flex items-center justify-between gap-3');
      var pushInfo = createEl('div', '');
      pushInfo.appendChild(createEl('p', 'text-sm font-semibold text-white', 'Push Notifications'));
      pushInfo.appendChild(createEl('p', 'text-[11px] text-steel-blue', 'Receive alerts even when the tab is closed'));
      pushRow.appendChild(pushInfo);

      var pushToggle = document.createElement('input');
      pushToggle.type = 'checkbox';
      pushToggle.id = 'notifPref_push';
      pushToggle.className = 'w-9 h-5 rounded-full appearance-none bg-steel-blue/30 checked:bg-primary relative cursor-pointer transition-colors ' +
        'after:content-[\'\'] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:rounded-full after:bg-white after:transition-transform ' +
        'checked:after:translate-x-4';
      pushToggle.addEventListener('change', togglePush);
      pushRow.appendChild(pushToggle);
      divider.appendChild(pushRow);
      body.appendChild(divider);
    }

    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    await loadPreferences();
  }

  function closePreferences() {
    _prefsOpen = false;
    var overlay = document.getElementById('notifPrefsOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  async function loadPreferences() {
    try {
      var resp = await fetch('/api/notifications/preferences');
      if (!resp.ok) return;
      var prefs = await resp.json();

      ['request', 'issue', 'service', 'news'].forEach(function(cat) {
        var toggle = document.getElementById('notifPref_' + cat);
        if (toggle) toggle.checked = prefs[cat] !== false;
      });

      // Check push subscription state
      var pushToggle = document.getElementById('notifPref_push');
      if (pushToggle && 'serviceWorker' in navigator) {
        var reg = await navigator.serviceWorker.getRegistration('/static/sw.js');
        if (reg) {
          var sub = await reg.pushManager.getSubscription();
          pushToggle.checked = !!sub;
        }
      }
    } catch (e) { /* silent */ }
  }

  async function savePreferences() {
    var payload = {};
    ['request', 'issue', 'service', 'news'].forEach(function(cat) {
      var toggle = document.getElementById('notifPref_' + cat);
      if (toggle) payload[cat] = toggle.checked;
    });

    try {
      await fetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) { /* silent */ }
  }

  // ---- Push Subscription ----

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function togglePush() {
    var pushToggle = document.getElementById('notifPref_push');
    if (!pushToggle) return;

    if (pushToggle.checked) {
      // Subscribe
      try {
        var permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          pushToggle.checked = false;
          return;
        }

        var reg = await navigator.serviceWorker.register('/static/sw.js');
        await navigator.serviceWorker.ready;

        var vapidKey = window.HMS_THEME && window.HMS_THEME.vapid_public_key;
        if (!vapidKey) {
          pushToggle.checked = false;
          return;
        }

        var sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });

        var subJson = sub.toJSON();
        await fetch('/api/notifications/push-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: subJson.endpoint,
            keys: subJson.keys,
          }),
        });
      } catch (e) {
        pushToggle.checked = false;
        console.warn('Push subscribe failed:', e);
      }
    } else {
      // Unsubscribe
      try {
        var reg = await navigator.serviceWorker.getRegistration('/static/sw.js');
        if (reg) {
          var sub = await reg.pushManager.getSubscription();
          if (sub) await sub.unsubscribe();
        }
        await fetch('/api/notifications/push-subscribe', { method: 'DELETE' });
      } catch (e) {
        console.warn('Push unsubscribe failed:', e);
      }
    }
  }

  // ---- Init ----

  function injectBellUI() {
    // Find the existing bell button
    var existingBell = document.querySelector('button[title*="Notification"]');
    if (!existingBell) {
      // No bell button found — try to inject one near the user menu
      var userMenu = document.getElementById('userMenuBtn');
      if (!userMenu) return;
      var container = userMenu.parentElement && userMenu.parentElement.parentElement;
      if (!container) return;

      existingBell = createEl('button', 'relative p-2 text-steel-blue hover:text-frosted-blue transition-colors');
      existingBell.title = 'Notifications';
      var icon = createEl('span', 'material-symbols-outlined');
      icon.textContent = 'notifications';
      existingBell.appendChild(icon);
      container.insertBefore(existingBell, userMenu.parentElement);
    }

    existingBell.id = 'notifBellBtn';
    existingBell.title = 'Notifications';
    existingBell.style.cursor = 'pointer';

    // Add badge
    var badge = createEl('span',
      'hidden absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-red-500 ' +
      'text-white text-[10px] font-bold flex items-center justify-center px-1 pointer-events-none');
    badge.id = 'notifBadge';
    existingBell.style.position = 'relative';
    existingBell.appendChild(badge);

    // Click handler
    existingBell.addEventListener('click', function(e) {
      e.stopPropagation();
      // Close user menu if open
      var userDropdown = document.getElementById('userMenuDropdown');
      if (userDropdown) userDropdown.classList.add('hidden');
      togglePanel();
    });

    // Build dropdown panel
    var panelContainer = existingBell.parentElement || document.body;

    var panel = createEl('div',
      'hidden absolute right-0 top-full mt-2 w-80 max-w-[90vw] bg-black/95 border border-steel-blue/30 ' +
      'rounded-xl shadow-xl z-50 overflow-hidden');
    panel.id = 'notifPanel';

    // Panel header
    var panelHeader = createEl('div', 'flex items-center justify-between px-4 py-3 border-b border-steel-blue/20');
    panelHeader.appendChild(createEl('span', 'text-sm font-bold text-frosted-blue', 'Notifications'));
    var markAllBtn = createEl('button', 'text-[11px] text-primary hover:text-primary/80 font-semibold', 'Mark all read');
    markAllBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      markAllRead();
    });
    panelHeader.appendChild(markAllBtn);
    panel.appendChild(panelHeader);

    // Panel list
    var list = createEl('div', 'max-h-80 overflow-y-auto custom-scrollbar divide-y divide-steel-blue/10');
    list.id = 'notifList';
    panel.appendChild(list);

    // Panel footer
    var panelFooter = createEl('div', 'border-t border-steel-blue/20 px-4 py-2.5');
    var prefsLink = createEl('button', 'text-[11px] text-steel-blue hover:text-frosted-blue font-semibold w-full text-center', 'Notification settings');
    prefsLink.addEventListener('click', function(e) {
      e.stopPropagation();
      togglePanel();
      openPreferences();
    });
    panelFooter.appendChild(prefsLink);
    panel.appendChild(panelFooter);

    // Position relative to bell
    existingBell.style.position = 'relative';
    existingBell.appendChild(panel);

    // Close panel on outside click
    document.addEventListener('click', function(e) {
      if (_panelOpen && !existingBell.contains(e.target)) {
        _panelOpen = false;
        panel.classList.add('hidden');
      }
    });
  }

  window.initNotifications = function() {
    injectBellUI();
    fetchUnreadCount();
    _pollInterval = setInterval(fetchUnreadCount, 30000);
  };

})();
```

**Step 2: Commit**

```bash
git add app/static/js/notifications.js
git commit -m "feat: add shared notifications.js — bell icon, dropdown, preferences, push"
```

---

## Task 11: Add notification CSS to theme.css

**Files:**
- Modify: `app/static/css/theme.css`

**Step 1: Add notification styles**

Append to `app/static/css/theme.css`:

```css
/* ---- Notification Badge Pulse ---- */
@keyframes pulse-once {
  0% { transform: scale(1); }
  50% { transform: scale(1.3); }
  100% { transform: scale(1); }
}
.animate-pulse-once {
  animation: pulse-once 0.3s ease-out;
}
```

**Step 2: Commit**

```bash
git add app/static/css/theme.css
git commit -m "style: add notification badge pulse animation"
```

---

## Task 12: Wire notifications.js into all pages

**Files:**
- Modify: `app/static/index.html`
- Modify: `app/static/requests2.html`
- Modify: `app/static/issues.html`
- Modify: `app/static/calendar.html`
- Modify: `app/static/settings.html`

**Step 1: Add script tag and init call to each page**

For each page, add this `<script>` tag in the `<head>` section, after the existing `sidebar.js` script tag:

```html
<script src="/static/js/notifications.js"></script>
```

And inside the existing `DOMContentLoaded` event listener, add after the `initSidebar(...)` call:

```javascript
initNotifications();
```

Do this for all 5 pages listed above. The exact location of the `initSidebar` call varies per page — find it and add `initNotifications()` on the next line.

**Step 2: Rebuild and verify**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
```

Use Chrome DevTools to verify:
- Navigate to dev.hmserver.tv
- Take a snapshot — bell icon should be visible in top bar
- Click bell — dropdown should open showing "No notifications"
- Check console for errors

**Step 3: Commit**

```bash
git add app/static/index.html app/static/requests2.html app/static/issues.html app/static/calendar.html app/static/settings.html
git commit -m "feat: wire notifications.js into all pages with bell icon and dropdown"
```

---

## Task 13: Add Notifications accordion to settings page

**Files:**
- Modify: `app/static/settings.html`

**Step 1: Add the Notifications accordion panel**

In `app/static/settings.html`, inside the `<div id="integrationsAccordion">`, after the Radarr accordion item (after line 459, before the closing `</div>` of the accordion container), add:

```html
                <!-- Notifications -->
                <div class="accordion-item" data-accordion="notifications">
                    <button type="button" class="accordion-trigger w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-cornflower-ocean/10 transition-colors" onclick="toggleAccordion('notifications')">
                        <span class="material-symbols-outlined text-xl text-frosted-blue">notifications</span>
                        <span class="flex-1 font-bold text-frosted-blue">Notifications</span>
                        <span class="material-symbols-outlined text-steel-blue accordion-chevron transition-transform duration-200">expand_more</span>
                    </button>
                    <div class="accordion-body hidden px-5 pb-5" id="accordionBodyNotifications">
                        <div class="space-y-4 pt-1">
                            <p class="text-xs text-steel-blue/70">Configure how frequently the notification system checks for updates. Minimum 30 seconds.</p>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label class="block text-xs font-semibold text-steel-blue mb-1.5">Overseerr Poll Interval</label>
                                    <div class="flex items-center gap-2">
                                        <input type="number" id="notifPollOverseerr" min="30" step="10"
                                            class="w-full bg-black/50 border border-steel-blue/30 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-steel-blue/50 focus:outline-none focus:ring-2 focus:ring-primary"
                                            placeholder="60">
                                        <span class="text-xs text-steel-blue shrink-0">sec</span>
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-xs font-semibold text-steel-blue mb-1.5">Monitor Poll Interval</label>
                                    <div class="flex items-center gap-2">
                                        <input type="number" id="notifPollMonitors" min="30" step="10"
                                            class="w-full bg-black/50 border border-steel-blue/30 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-steel-blue/50 focus:outline-none focus:ring-2 focus:ring-primary"
                                            placeholder="60">
                                        <span class="text-xs text-steel-blue shrink-0">sec</span>
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-xs font-semibold text-steel-blue mb-1.5">News Poll Interval</label>
                                    <div class="flex items-center gap-2">
                                        <input type="number" id="notifPollNews" min="30" step="10"
                                            class="w-full bg-black/50 border border-steel-blue/30 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-steel-blue/50 focus:outline-none focus:ring-2 focus:ring-primary"
                                            placeholder="60">
                                        <span class="text-xs text-steel-blue shrink-0">sec</span>
                                    </div>
                                </div>
                            </div>
                            <div class="flex items-center gap-3 pt-1">
                                <button onclick="saveNotificationSettings()" class="bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-all">
                                    Save
                                </button>
                                <button onclick="sendTestNotification()" class="bg-steel-blue/20 hover:bg-steel-blue/30 text-frosted-blue px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-1.5">
                                    <span class="material-symbols-outlined text-sm">notifications_active</span>
                                    Send Test
                                </button>
                                <div id="statusNotifications" class="flex items-center gap-2 text-sm"></div>
                            </div>
                        </div>
                    </div>
                </div>
```

**Step 2: Add JS functions for notification settings**

In the `<script>` section of `settings.html`, add these functions (alongside the existing `saveIntegration`, `testConnection`, etc.):

```javascript
        // --- Notification Settings ---
        async function saveNotificationSettings() {
            var statusEl = document.getElementById('statusNotifications');
            var settings = [
                { key: 'notifications.poll_interval_overseerr', value: String(Math.max(30, parseInt(document.getElementById('notifPollOverseerr').value) || 60)) },
                { key: 'notifications.poll_interval_monitors', value: String(Math.max(30, parseInt(document.getElementById('notifPollMonitors').value) || 60)) },
                { key: 'notifications.poll_interval_news', value: String(Math.max(30, parseInt(document.getElementById('notifPollNews').value) || 60)) },
            ];
            try {
                var resp = await fetch('/api/admin/settings/bulk', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ settings: settings }),
                });
                if (resp.ok) {
                    statusEl.textContent = 'Saved';
                    statusEl.className = 'flex items-center gap-2 text-sm text-green-400';
                } else {
                    statusEl.textContent = 'Error saving';
                    statusEl.className = 'flex items-center gap-2 text-sm text-red-400';
                }
            } catch (e) {
                statusEl.textContent = 'Network error';
                statusEl.className = 'flex items-center gap-2 text-sm text-red-400';
            }
            setTimeout(function() { statusEl.textContent = ''; }, 3000);
        }

        async function sendTestNotification() {
            var statusEl = document.getElementById('statusNotifications');
            try {
                var resp = await fetch('/api/admin/notifications/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Test notification', body: 'This is a test notification from HMS Dashboard.' }),
                });
                if (resp.ok) {
                    var data = await resp.json();
                    statusEl.textContent = 'Sent to ' + data.sent_to + ' user(s)';
                    statusEl.className = 'flex items-center gap-2 text-sm text-green-400';
                } else {
                    statusEl.textContent = 'Error sending';
                    statusEl.className = 'flex items-center gap-2 text-sm text-red-400';
                }
            } catch (e) {
                statusEl.textContent = 'Network error';
                statusEl.className = 'flex items-center gap-2 text-sm text-red-400';
            }
            setTimeout(function() { statusEl.textContent = ''; }, 3000);
        }
```

**Step 3: Load notification poll values on settings page load**

In the existing `loadAllSettings()` function (or wherever settings are loaded into the form), add logic to populate the notification interval inputs:

```javascript
            // Load notification poll intervals
            var pollOverseerr = allSettings.find(function(s) { return s.key === 'notifications.poll_interval_overseerr'; });
            var pollMonitors = allSettings.find(function(s) { return s.key === 'notifications.poll_interval_monitors'; });
            var pollNews = allSettings.find(function(s) { return s.key === 'notifications.poll_interval_news'; });
            if (pollOverseerr) document.getElementById('notifPollOverseerr').value = pollOverseerr.value;
            if (pollMonitors) document.getElementById('notifPollMonitors').value = pollMonitors.value;
            if (pollNews) document.getElementById('notifPollNews').value = pollNews.value;
```

**Step 4: Rebuild and verify**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
```

Navigate to Settings > Integrations, verify Notifications accordion appears with the 3 inputs and Save/Test buttons.

**Step 5: Commit**

```bash
git add app/static/settings.html
git commit -m "feat: add Notifications accordion in settings with poll intervals and test button"
```

---

## Task 14: Update app-contract.md

**Files:**
- Modify: `docs/app-contract.md`

**Step 1: Add notification endpoints, models, and settings to the contract**

Add the following sections to `docs/app-contract.md`:

**In the Endpoints section**, add a new "Notifications" group:

```markdown
### Notifications

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/notifications | Session | List user's notifications (paginated) |
| GET | /api/notifications/unread-count | Session | Unread notification count |
| PUT | /api/notifications/{id}/read | Session | Mark notification as read |
| PUT | /api/notifications/read-all | Session | Mark all notifications as read |
| DELETE | /api/notifications/{id} | Session | Delete a notification |
| GET | /api/notifications/preferences | Session | Get per-category toggles |
| PUT | /api/notifications/preferences | Session | Update per-category toggles |
| POST | /api/notifications/push-subscribe | Session | Register push subscription |
| DELETE | /api/notifications/push-subscribe | Session | Remove push subscriptions |
| POST | /api/admin/notifications/send | Admin | Send notification to all users |
```

**In the Models section**, add:

```markdown
### Notification
| Field | Type | Notes |
|-------|------|-------|
| id | Integer | PK, auto-increment |
| user_email | String(200) | Indexed |
| category | String(20) | request, issue, service, news |
| title | String(200) | |
| body | Text | Nullable |
| reference_id | String(100) | Nullable, for dedup |
| read | Boolean | Default false |
| created_at | DateTime | Auto-set |

### PushSubscription
| Field | Type | Notes |
|-------|------|-------|
| id | Integer | PK, auto-increment |
| user_email | String(200) | Indexed |
| endpoint | Text | Push service URL |
| p256dh | String(200) | Client key |
| auth | String(200) | Auth secret |
| created_at | DateTime | Auto-set |
```

**In the Settings section**, add:

```markdown
### Notification Settings
| Key | Default | Description |
|-----|---------|-------------|
| notifications.poll_interval_overseerr | 60 | Seconds between Overseerr checks |
| notifications.poll_interval_monitors | 60 | Seconds between Uptime Kuma checks |
| notifications.poll_interval_news | 60 | Seconds between news checks |
| notifications.vapid_public_key | (auto) | Web Push VAPID public key |
| notifications.vapid_private_key | (auto) | Web Push VAPID private key |
| notify.{hash}.{category} | true | Per-user notification preference |
```

**Step 2: Commit**

```bash
git add docs/app-contract.md
git commit -m "docs: add notification endpoints, models, and settings to app-contract"
```

---

## Task 15: Update CSP for service worker and push

**Files:**
- Modify: `app/main.py`

**Step 1: Ensure CSP allows service worker registration**

Service workers require `worker-src` CSP directive. In the `add_security_headers` middleware in `app/main.py`, add a `worker-src` directive to the CSP:

In the `csp_directives` list, add:

```python
        "worker-src 'self'",
```

This allows the service worker at `/static/sw.js` to register.

**Step 2: Commit**

```bash
git add app/main.py
git commit -m "fix: add worker-src CSP directive for service worker registration"
```

---

## Task 16: End-to-end verification

**No files modified — testing only.**

**Step 1: Rebuild**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"
```

**Step 2: Verify backend**

```bash
# Check logs for successful startup
ssh webserver "cd /root/hms-dashboard && docker compose logs --tail=30 hms-dashboard"
# Expected: "VAPID keys" and "Notification poller started" in logs

# Check unread count endpoint
ssh webserver 'curl -s -b "hms_session=<session_id>" http://localhost:8000/api/notifications/unread-count'
# Expected: {"count":0}

# Check preferences endpoint
ssh webserver 'curl -s -b "hms_session=<session_id>" http://localhost:8000/api/notifications/preferences'
# Expected: {"request":true,"issue":true,"service":true,"news":true}

# Check branding has VAPID key
ssh webserver 'curl -s http://localhost:8000/api/branding | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"vapid_public_key\",\"MISSING\")[:20])"'
# Expected: first 20 chars of a base64url string
```

**Step 3: Verify frontend via Chrome DevTools**

- Navigate to dev.hmserver.tv
- Take snapshot — verify bell icon in top bar
- Click bell — verify dropdown opens with "No notifications"
- Click "Notification settings" — verify modal with 4 toggles + push toggle
- Navigate to Settings > Integrations — verify Notifications accordion with 3 interval inputs
- Click "Send Test" — verify notification appears in bell dropdown
- Check console for any JS errors

**Step 4: Commit summary**

```bash
git add -A
git commit -m "feat: Phase 6 complete — in-app notifications + browser push"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add pywebpush dependency | requirements.txt |
| 2 | Notification + PushSubscription models | app/models.py |
| 3 | Seed settings + VAPID keys | app/seed.py, app/database.py |
| 4 | Notifications API router | app/routers/notifications.py, app/main.py |
| 5 | Admin send-notification endpoint | app/routers/admin.py |
| 6 | Push dispatch service | app/services/__init__.py, app/services/push.py |
| 7 | Background notification poller | app/services/notification_poller.py, app/main.py |
| 8 | VAPID key in branding API | app/routers/branding.py |
| 9 | Service worker | app/static/sw.js |
| 10 | Shared notifications.js | app/static/js/notifications.js |
| 11 | Notification CSS | app/static/css/theme.css |
| 12 | Wire notifications into all pages | 5 HTML files |
| 13 | Settings page Notifications accordion | app/static/settings.html |
| 14 | Update app-contract docs | docs/app-contract.md |
| 15 | CSP for service worker | app/main.py |
| 16 | End-to-end verification | (testing only) |
