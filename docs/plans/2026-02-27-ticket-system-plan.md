# Ticket System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a native support ticket system where Plex users submit categorized requests to the server admin, with threaded comments, image attachments, privacy controls, and full notification integration.

**Architecture:** Two new SQLAlchemy models (Ticket, TicketComment) in SQLite. One new FastAPI router (`app/routers/tickets.py`) for user + admin endpoints. One new frontend page (`app/static/tickets.html`) with two-column layout. Notification poller extended with a ticket polling loop. Sidebar + seed.py updated for nav and feature toggle.

**Tech Stack:** FastAPI, SQLAlchemy, SQLite, bleach (sanitization), vanilla JS + Tailwind CSS, Web Push (existing pywebpush), Redis (existing notification poller state)

**Design doc:** `docs/plans/2026-02-27-ticket-system-design.md`

---

### Task 1: Database Models (Ticket + TicketComment)

**Files:**
- Modify: `app/models.py`

**Context:** The existing models file has User, NewsPost, Service, Setting, StatusUpdate, Notification, PushSubscription. We add Ticket and TicketComment following the same patterns (Integer PK, DateTime with server_default=func.now(), String columns).

**Step 1: Add the Ticket model to `app/models.py`**

Add after the `PushSubscription` class at the end of the file:

```python
class Ticket(Base):
    """Support tickets submitted by users."""
    __tablename__ = "tickets"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=False)
    category = Column(String(50), nullable=False)  # media_request, playback_issue, account_issue, feature_suggestion, other
    status = Column(String(20), nullable=False, default="open")  # open, in_progress, resolved, closed
    priority = Column(String(20), nullable=True)  # low, medium, high, urgent (admin-only)
    is_public = Column(Boolean, default=False, nullable=False)  # admin toggle for visibility
    creator_username = Column(String(100), nullable=False, index=True)
    creator_name = Column(String(100), nullable=False)
    image_path = Column(String(300), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def __repr__(self):
        return f"<Ticket(id={self.id}, title='{self.title}', status='{self.status}')>"
```

**Step 2: Add the TicketComment model**

Add immediately after the Ticket class:

```python
class TicketComment(Base):
    """Comments on support tickets."""
    __tablename__ = "ticket_comments"

    id = Column(Integer, primary_key=True, index=True)
    ticket_id = Column(Integer, nullable=False, index=True)
    author_username = Column(String(100), nullable=False)
    author_name = Column(String(100), nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)
    message = Column(Text, nullable=False)
    image_path = Column(String(300), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)

    def __repr__(self):
        return f"<TicketComment(id={self.id}, ticket_id={self.ticket_id})>"
```

**Step 3: Verify the models are picked up by SQLAlchemy**

The existing `init_db()` in `app/database.py` calls `Base.metadata.create_all(bind=engine)` which auto-creates tables for any model that inherits from `Base`. No change needed — the new tables will be created on next container restart.

**Step 4: Commit**

```bash
git add app/models.py
git commit -m "feat: add Ticket and TicketComment database models"
```

---

### Task 2: Seed Default Settings

**Files:**
- Modify: `app/seed.py`

**Context:** `seed.py` has a `DEFAULT_SETTINGS` dict that seeds Settings rows on first startup. We add the ticket feature toggle, sidebar label, nav icon, and notification poll interval.

**Step 1: Add ticket settings to DEFAULT_SETTINGS**

In `app/seed.py`, add these entries to the `DEFAULT_SETTINGS` dict (after the Authentik entries, before the closing `}`):

```python
    # Ticket system
    "features.show_tickets": ("true", "Show Tickets page in sidebar"),
    "sidebar.label_tickets": ("Tickets", "Sidebar label for Tickets page"),
    "icon.nav_tickets": ("confirmation_number", "Sidebar icon for Tickets page"),
    "notifications.poll_interval_tickets": ("60", "Seconds between ticket notification checks"),
```

**Step 2: Commit**

```bash
git add app/seed.py
git commit -m "feat: seed ticket system default settings"
```

---

### Task 3: Backend API Router (`app/routers/tickets.py`)

**Files:**
- Create: `app/routers/tickets.py`

**Context:** This router handles all ticket CRUD. User endpoints require session auth (`get_current_user`). Admin endpoints require admin auth (`require_admin`). Image uploads follow the same pattern as `admin.py:upload_logo` (UploadFile, content-type validation, size limit, save to uploads/ dir). Text is sanitized with bleach (same as news.py). The feature toggle `features.show_tickets` is checked — when "false", all endpoints return 403.

**Key patterns from existing code:**
- `get_current_user` returns a dict with keys: `user_id`, `email`, `name`, `username`, `is_admin`, `auth_method`, `plex_token`, `avatar_url`
- `require_admin` wraps `get_current_user` and checks `is_admin == "true"`
- `get_db` yields a SQLAlchemy Session
- Admin flag is the string `"true"`, not a boolean
- Settings are checked via `db.query(Setting).filter(Setting.key == key).first()`

**Step 1: Create the tickets router file**

Create `app/routers/tickets.py`:

```python
"""
Ticket system API routes.
User-facing: create tickets, add comments, list own tickets + public tickets.
Admin-facing: manage all tickets, update status/priority/visibility.
"""

import logging
import os
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, status
from sqlalchemy.orm import Session
from sqlalchemy import or_
from pydantic import BaseModel
from typing import Optional

import bleach

from app.database import get_db
from app.models import Ticket, TicketComment, Setting
from app.dependencies import get_current_user, require_admin

logger = logging.getLogger(__name__)

router = APIRouter()

# --- Constants ---

VALID_CATEGORIES = {"media_request", "playback_issue", "account_issue", "feature_suggestion", "other"}
VALID_STATUSES = {"open", "in_progress", "resolved", "closed"}
VALID_PRIORITIES = {"low", "medium", "high", "urgent"}

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "uploads", "tickets")
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_IMAGE_SIZE = 2 * 1024 * 1024  # 2MB

# Bleach config — strip all HTML, allow no tags
BLEACH_TAGS = []
BLEACH_ATTRS = {}


# --- Helpers ---

def _check_feature_enabled(db: Session) -> None:
    """Raise 403 if tickets feature is disabled."""
    row = db.query(Setting).filter(Setting.key == "features.show_tickets").first()
    if row and row.value.lower() == "false":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Tickets feature is disabled")


def _sanitize(text: str) -> str:
    """Strip all HTML tags from user input."""
    return bleach.clean(text, tags=BLEACH_TAGS, attributes=BLEACH_ATTRS, strip=True).strip()


def _save_image(content: bytes, prefix: str) -> str:
    """Save image bytes to uploads/tickets/ and return the relative URL path."""
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = f"{prefix}-{uuid.uuid4().hex[:8]}.png"
    filepath = os.path.join(UPLOAD_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(content)
    return f"/static/uploads/tickets/{filename}"


async def _validate_image(file: UploadFile) -> bytes:
    """Validate an uploaded image file. Returns content bytes."""
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported image type: {file.content_type}. Allowed: PNG, JPEG, WebP",
        )
    content = await file.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image too large. Maximum size is 2MB.",
        )
    return content


def _ticket_to_dict(ticket: Ticket, is_admin: bool, current_username: str) -> dict:
    """Serialize a Ticket to a response dict with privacy rules applied."""
    data = {
        "id": ticket.id,
        "title": ticket.title,
        "description": ticket.description,
        "category": ticket.category,
        "status": ticket.status,
        "priority": ticket.priority,
        "is_public": ticket.is_public,
        "image_path": ticket.image_path,
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
        "updated_at": ticket.updated_at.isoformat() if ticket.updated_at else None,
        "is_own": ticket.creator_username == current_username,
    }
    # Admin sees creator info; non-admin only sees it on their own tickets
    if is_admin or ticket.creator_username == current_username:
        data["creator_username"] = ticket.creator_username
        data["creator_name"] = ticket.creator_name
    else:
        data["creator_username"] = None
        data["creator_name"] = None
    return data


def _comment_to_dict(comment: TicketComment, is_admin: bool, current_username: str) -> dict:
    """Serialize a TicketComment with privacy rules applied."""
    data = {
        "id": comment.id,
        "ticket_id": comment.ticket_id,
        "is_admin": comment.is_admin,
        "message": comment.message,
        "image_path": comment.image_path,
        "created_at": comment.created_at.isoformat() if comment.created_at else None,
    }
    # Admin sees all author info; non-admin sees "Admin" or their own name
    if is_admin or comment.author_username == current_username:
        data["author_username"] = comment.author_username
        data["author_name"] = comment.author_name
    else:
        data["author_username"] = None
        data["author_name"] = "Admin" if comment.is_admin else None
    return data


# --- Pydantic schemas ---

class AdminTicketUpdate(BaseModel):
    """Schema for admin ticket updates."""
    status: Optional[str] = None
    priority: Optional[str] = None
    is_public: Optional[bool] = None


# --- User endpoints ---

@router.get("/tickets")
async def list_tickets(
    ticket_status: Optional[str] = Query(None, alias="status"),
    category: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List the current user's tickets + public tickets."""
    _check_feature_enabled(db)
    username = current_user.get("username", "")

    # User sees: own tickets OR public tickets
    query = db.query(Ticket).filter(
        or_(
            Ticket.creator_username == username,
            Ticket.is_public == True,  # noqa: E712
        )
    )

    if ticket_status and ticket_status in VALID_STATUSES:
        query = query.filter(Ticket.status == ticket_status)
    if category and category in VALID_CATEGORIES:
        query = query.filter(Ticket.category == category)

    total = query.count()
    rows = query.order_by(Ticket.created_at.desc()).offset(offset).limit(limit).all()

    is_admin = current_user.get("is_admin") == "true"
    tickets = [_ticket_to_dict(t, is_admin, username) for t in rows]

    return {"tickets": tickets, "total": total}


@router.post("/tickets")
async def create_ticket(
    title: str = Form(...),
    description: str = Form(...),
    category: str = Form(...),
    image: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new support ticket."""
    _check_feature_enabled(db)

    title = _sanitize(title)
    description = _sanitize(description)

    if not title or len(title) > 200:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Title is required (max 200 chars)")
    if not description:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Description is required")
    if category not in VALID_CATEGORIES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid category. Must be one of: {', '.join(VALID_CATEGORIES)}")

    image_path = None
    if image and image.filename:
        content = await _validate_image(image)
        image_path = _save_image(content, "ticket")

    ticket = Ticket(
        title=title,
        description=description,
        category=category,
        status="open",
        creator_username=current_user.get("username", "unknown"),
        creator_name=current_user.get("name", "") or current_user.get("username", "unknown"),
        image_path=image_path,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    is_admin = current_user.get("is_admin") == "true"
    return _ticket_to_dict(ticket, is_admin, current_user.get("username", ""))


@router.get("/tickets/counts")
async def ticket_counts(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get ticket counts by status for the current user."""
    _check_feature_enabled(db)
    username = current_user.get("username", "")
    is_admin = current_user.get("is_admin") == "true"

    if is_admin:
        base = db.query(Ticket)
    else:
        base = db.query(Ticket).filter(
            or_(
                Ticket.creator_username == username,
                Ticket.is_public == True,  # noqa: E712
            )
        )

    counts = {}
    for s in VALID_STATUSES:
        counts[s] = base.filter(Ticket.status == s).count()
    counts["total"] = sum(counts.values())

    return counts


@router.get("/tickets/{ticket_id}")
async def get_ticket(
    ticket_id: int,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get ticket detail with comments."""
    _check_feature_enabled(db)
    username = current_user.get("username", "")
    is_admin = current_user.get("is_admin") == "true"

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")

    # Access check: own ticket, public, or admin
    if ticket.creator_username != username and not ticket.is_public and not is_admin:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")

    comments = (
        db.query(TicketComment)
        .filter(TicketComment.ticket_id == ticket_id)
        .order_by(TicketComment.created_at.asc())
        .all()
    )

    return {
        "ticket": _ticket_to_dict(ticket, is_admin, username),
        "comments": [_comment_to_dict(c, is_admin, username) for c in comments],
    }


@router.post("/tickets/{ticket_id}/comments")
async def add_comment(
    ticket_id: int,
    message: str = Form(...),
    image: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a comment to a ticket. Only ticket creator or admin can comment."""
    _check_feature_enabled(db)
    username = current_user.get("username", "")
    is_admin = current_user.get("is_admin") == "true"

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")

    # Only creator or admin can comment
    if ticket.creator_username != username and not is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only comment on your own tickets")

    message = _sanitize(message)
    if not message:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message is required")

    image_path = None
    if image and image.filename:
        content = await _validate_image(image)
        image_path = _save_image(content, f"comment-{ticket_id}")

    comment = TicketComment(
        ticket_id=ticket_id,
        author_username=username,
        author_name=current_user.get("name", "") or username,
        is_admin=is_admin,
        message=message,
        image_path=image_path,
    )
    db.add(comment)

    # Touch ticket updated_at
    ticket.updated_at = None  # triggers onupdate=func.now()
    db.commit()
    db.refresh(comment)

    return _comment_to_dict(comment, is_admin, username)


# --- Admin endpoints ---

@router.get("/admin/tickets")
async def admin_list_tickets(
    ticket_status: Optional[str] = Query(None, alias="status"),
    category: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    creator: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin: list all tickets with filters."""
    _check_feature_enabled(db)

    query = db.query(Ticket)
    if ticket_status and ticket_status in VALID_STATUSES:
        query = query.filter(Ticket.status == ticket_status)
    if category and category in VALID_CATEGORIES:
        query = query.filter(Ticket.category == category)
    if priority and priority in VALID_PRIORITIES:
        query = query.filter(Ticket.priority == priority)
    if creator:
        query = query.filter(Ticket.creator_username == creator)

    total = query.count()
    rows = query.order_by(Ticket.created_at.desc()).offset(offset).limit(limit).all()

    username = current_user.get("username", "")
    tickets = [_ticket_to_dict(t, True, username) for t in rows]

    return {"tickets": tickets, "total": total}


@router.put("/admin/tickets/{ticket_id}")
async def admin_update_ticket(
    ticket_id: int,
    body: AdminTicketUpdate,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin: update ticket status, priority, or public visibility."""
    _check_feature_enabled(db)

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")

    if body.status is not None:
        if body.status not in VALID_STATUSES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid status. Must be one of: {', '.join(VALID_STATUSES)}")
        ticket.status = body.status

    if body.priority is not None:
        if body.priority and body.priority not in VALID_PRIORITIES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid priority. Must be one of: {', '.join(VALID_PRIORITIES)}")
        ticket.priority = body.priority or None

    if body.is_public is not None:
        ticket.is_public = body.is_public

    db.commit()
    db.refresh(ticket)

    username = current_user.get("username", "")
    return _ticket_to_dict(ticket, True, username)


@router.delete("/admin/tickets/{ticket_id}")
async def admin_delete_ticket(
    ticket_id: int,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin: delete a ticket and all its comments."""
    _check_feature_enabled(db)

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")

    # Delete comments first
    db.query(TicketComment).filter(TicketComment.ticket_id == ticket_id).delete()
    db.delete(ticket)
    db.commit()

    return {"success": True}
```

**Step 2: Register the router in `app/main.py`**

In `app/main.py`, add the import at line 18 (with the other router imports):

```python
from app.routers import news, status, admin, simple_auth, integrations, auth as oidc_auth, plex_auth, branding, notifications, tickets
```

Then add the router include after the notifications router include (around line 151):

```python
app.include_router(tickets.router, prefix="/api", tags=["Tickets"])
```

**Step 3: Add the /tickets page route in `app/main.py`**

Add after the `/calendar` route (around line 241):

```python
# Tickets page
@app.get("/tickets", response_class=HTMLResponse, tags=["Pages"])
async def tickets_page(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
):
    """Serve the support tickets page."""
    if not await _require_session(session_id):
        return RedirectResponse(url="/login", status_code=302)
    return _serve_page("/app/app/static/tickets.html", "Tickets page")
```

**Step 4: Commit**

```bash
git add app/routers/tickets.py app/main.py
git commit -m "feat: add ticket system API router with user + admin endpoints"
```

---

### Task 4: Notification Poller Extension

**Files:**
- Modify: `app/services/notification_poller.py`
- Modify: `app/routers/notifications.py`

**Context:** The notification poller runs three independent loops (Overseerr requests, Overseerr issues, Uptime Kuma monitors, news). We add a fourth loop that polls the Ticket and TicketComment tables for new comments and status changes. The preferences system needs a `ticket` category added.

**Step 1: Add ticket polling to `notification_poller.py`**

Add the `_poll_tickets` function after `_poll_news` (before the `start_poller` function):

```python
# ---------------------------------------------------------------------------
# Poll: Tickets
# ---------------------------------------------------------------------------

async def _poll_tickets(db: Session, r: aioredis.Redis, first_run: bool) -> None:
    """Check for new comments and status changes on tickets."""
    tickets = db.query(Ticket).all()

    for ticket in tickets:
        ticket_id = ticket.id
        comment_count = (
            db.query(TicketComment)
            .filter(TicketComment.ticket_id == ticket_id)
            .count()
        )

        redis_key = f"poller:ticket:{ticket_id}"
        prev = await r.get(redis_key)
        snapshot_val = f"{comment_count}:{ticket.status}"
        await r.set(redis_key, snapshot_val)

        if first_run or prev is None:
            continue

        prev_str = prev.decode()
        try:
            prev_count_str, prev_status = prev_str.split(":", 1)
            prev_count = int(prev_count_str)
        except (ValueError, IndexError):
            prev_count = 0
            prev_status = "open"

        creator_email = ""
        # Look up creator email from sessions (username -> email mapping)
        session_emails = await _collect_session_emails(r)
        # We need the creator's email for notifications — scan sessions for matching username
        cursor_scan = 0
        while True:
            cursor_scan, keys = await r.scan(cursor_scan, match="session:*", count=100)
            for key in keys:
                data = await r.hgetall(key)
                uname = (data.get(b"username", b"")).decode() if data.get(b"username") else ""
                if uname == ticket.creator_username:
                    email_bytes = data.get(b"email", b"")
                    creator_email = email_bytes.decode().lower() if email_bytes else ""
                    break
            if creator_email or cursor_scan == 0:
                break

        if not creator_email:
            continue

        # New admin comment on user's ticket
        if comment_count > prev_count:
            # Check if the newest comment is from admin (notify user)
            latest_comment = (
                db.query(TicketComment)
                .filter(TicketComment.ticket_id == ticket_id)
                .order_by(TicketComment.created_at.desc())
                .first()
            )
            if latest_comment and latest_comment.is_admin:
                ref_id = f"ticket:{ticket_id}:comment:{comment_count}"
                notif = _create_notification(
                    db,
                    creator_email,
                    "ticket",
                    "New response on your ticket",
                    f"New response on: {ticket.title}",
                    ref_id,
                )
                if notif:
                    db.commit()
                    await send_push_to_users(
                        db,
                        [creator_email],
                        notif.title,
                        notif.body or "",
                        "ticket",
                        url="/tickets",
                    )

        # Status change
        if ticket.status != prev_status:
            ref_id = f"ticket:{ticket_id}:status:{ticket.status}"
            notif = _create_notification(
                db,
                creator_email,
                "ticket",
                f"Ticket update: {ticket.status.replace('_', ' ').title()}",
                f"Your ticket \"{ticket.title}\" was marked as {ticket.status.replace('_', ' ')}",
                ref_id,
            )
            if notif:
                db.commit()
                await send_push_to_users(
                    db,
                    [creator_email],
                    notif.title,
                    notif.body or "",
                    "ticket",
                    url="/tickets",
                )
```

**Step 2: Add the Ticket import at the top of `notification_poller.py`**

Change the models import line:

```python
from app.models import Notification, NewsPost, PushSubscription, Setting, Ticket, TicketComment
```

**Step 3: Wire ticket polling into the main loop**

In the `start_poller` function, add ticket tracking variables after `first_run_news`:

```python
    first_run_tickets = True
```

And after `last_news = 0.0`:

```python
    last_tickets = 0.0
```

Add a new interval read inside the `try` block (after `interval_news`):

```python
            interval_tickets = _get_setting_int(
                db, "notifications.poll_interval_tickets", DEFAULT_OVERSEERR_INTERVAL
            )
```

Add the ticket polling block after the news polling block (before the `except` at the end of the main loop):

```python
            # --- Tickets ---
            if now - last_tickets >= interval_tickets:
                last_tickets = now
                try:
                    await _poll_tickets(db, r, first_run_tickets)
                except Exception as exc:
                    logger.warning("Poller: tickets cycle error: %s", exc)
                first_run_tickets = False
```

**Step 4: Add `ticket` to notification preferences**

In `app/routers/notifications.py`:

Update `NOTIFICATION_CATEGORIES`:

```python
NOTIFICATION_CATEGORIES = ("request", "issue", "service", "news", "ticket")
```

Update `PreferencesUpdate` to add the ticket field:

```python
class PreferencesUpdate(BaseModel):
    """Schema for updating notification preferences per category."""
    request: Optional[bool] = None
    issue: Optional[bool] = None
    service: Optional[bool] = None
    news: Optional[bool] = None
    ticket: Optional[bool] = None
```

**Step 5: Commit**

```bash
git add app/services/notification_poller.py app/routers/notifications.py
git commit -m "feat: add ticket notification polling and preferences"
```

---

### Task 5: Sidebar Navigation

**Files:**
- Modify: `app/static/js/sidebar.js`

**Context:** The sidebar has a `NAV_ITEMS` array that defines navigation links. Each item has an id, label, icon, href, and optional feature flag. The tickets item needs a `feature: 'show_tickets'` flag so it's hidden when the feature is disabled.

**Step 1: Add tickets nav item**

In `app/static/js/sidebar.js`, add the tickets entry to the `NAV_ITEMS` array after the `calendar` entry and before the `settings` entry:

```javascript
  { id: 'tickets',  label: 'Tickets',    icon: 'confirmation_number', href: '/tickets', feature: 'show_tickets' },
```

The full array should look like:

```javascript
var NAV_ITEMS = [
  { id: 'home',     label: 'Home',        icon: 'home',                   href: '/' },
  { id: 'requests', label: 'Requests',    icon: 'download',              href: '/requests', badgeId: 'requestsBadge', feature: 'show_requests' },
  { id: 'requests2', label: 'Requests2',  icon: 'movie',                 href: '/requests2' },
  { id: 'issues',    label: 'Issues',     icon: 'report_problem',        href: '/issues' },
  { id: 'calendar',  label: 'Calendar',    icon: 'calendar_month',        href: '/calendar' },
  { id: 'tickets',  label: 'Tickets',    icon: 'confirmation_number', href: '/tickets', feature: 'show_tickets' },
  { id: 'settings', label: 'Settings',    icon: 'settings',              href: '/settings', adminOnly: true },
];
```

The sidebar system already handles feature flags, custom labels (`sidebar.label_tickets`), and custom icons (`icon.nav_tickets`) via the branding API — no additional code needed.

**Step 2: Commit**

```bash
git add app/static/js/sidebar.js
git commit -m "feat: add tickets nav item to sidebar"
```

---

### Task 6: Notification Frontend — Ticket Category

**Files:**
- Modify: `app/static/js/notifications.js`

**Context:** The notifications JS has category maps for icons, URLs, and labels. We need to add `ticket` entries so ticket notifications render with the correct icon and link to the right page. The preferences modal also needs a "Tickets" toggle.

**Step 1: Add ticket to category maps**

In `app/static/js/notifications.js`, update the three category config objects (near the top of the IIFE, around lines 20-37):

Add to `CATEGORY_ICONS`:
```javascript
    ticket: 'confirmation_number'
```

Add to `CATEGORY_URLS`:
```javascript
    ticket: '/tickets'
```

Add to `CATEGORY_LABELS`:
```javascript
    ticket: 'Tickets'
```

These maps are used throughout the notification dropdown and preferences modal — no other changes needed.

**Step 2: Commit**

```bash
git add app/static/js/notifications.js
git commit -m "feat: add ticket category to notification system frontend"
```

---

### Task 7: Frontend Page (`app/static/tickets.html`)

**Files:**
- Create: `app/static/tickets.html`

**Context:** This is the main tickets page. It follows the exact same structure as `issues.html`: HTML head with theme-loader + Tailwind + Material Icons, sidebar root, toast container, modal, header, two-column layout. Key differences: left column is the ticket list (not a search/report form), right column is ticket detail with comments, and there's a "New Ticket" modal instead of an issue form.

**CRITICAL:** Zero innerHTML for user-generated content. All DOM building via createElement/textContent. The sidebar HTML is built with innerHTML (existing pattern in sidebar.js) but all ticket data must use createElement.

**Step 1: Create `app/static/tickets.html`**

This is a large file. Create it with the following structure:

```html
<!DOCTYPE html>
<html class="dark" lang="en">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>WebServarr - Tickets</title>
<script src="/static/js/theme-loader.js"></script>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<link href="/static/css/theme.css" rel="stylesheet"/>
<script>tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "primary": "rgb(var(--color-primary) / <alpha-value>)",
        "baltic-blue": "rgb(var(--color-primary) / <alpha-value>)",
        "cornflower-ocean": "rgb(var(--color-secondary) / <alpha-value>)",
        "steel-blue": "rgb(var(--color-accent) / <alpha-value>)",
        "frosted-blue": "rgb(var(--color-text) / <alpha-value>)",
        "background-dark": "rgb(var(--color-background) / <alpha-value>)",
      },
      fontFamily: {
        "display": ["var(--font-display)", "sans-serif"]
      },
    },
  },
}</script>
</head>
<body class="bg-background-dark text-frosted-blue min-h-screen flex flex-col lg:flex-row overflow-hidden">
<div id="sidebar-root"></div>

<!-- Toast notification container -->
<div id="toastContainer" class="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"></div>

<!-- Create Ticket Modal -->
<div id="createModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4" onclick="if(event.target===this)closeCreateModal()">
<div class="absolute inset-0 bg-black/70 backdrop-blur-sm"></div>
<div class="relative w-full max-w-md rounded-xl glass-card p-5">
<button onclick="closeCreateModal()" class="absolute top-3 right-3 text-steel-blue hover:text-white transition-colors">
<span class="material-symbols-outlined">close</span>
</button>
<h3 class="text-lg font-bold text-white mb-4">New Ticket</h3>

<label class="text-[10px] text-steel-blue font-bold uppercase tracking-wider block mb-1">Title</label>
<input id="createTitle" type="text" maxlength="200" placeholder="Brief summary of your issue..."
  class="w-full px-3 py-2.5 bg-black/40 border border-steel-blue/20 rounded-lg text-white placeholder-steel-blue/60 text-sm focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-all mb-3"/>

<label class="text-[10px] text-steel-blue font-bold uppercase tracking-wider block mb-1">Category</label>
<select id="createCategory"
  class="w-full px-3 py-2.5 bg-black/40 border border-steel-blue/20 rounded-lg text-white text-sm focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-all mb-3">
<option value="media_request">Media Request</option>
<option value="playback_issue">Playback Issue</option>
<option value="account_issue">Account Issue</option>
<option value="feature_suggestion">Feature Suggestion</option>
<option value="other">Other</option>
</select>

<label class="text-[10px] text-steel-blue font-bold uppercase tracking-wider block mb-1">Description</label>
<textarea id="createDescription" rows="4" placeholder="Describe your request or issue in detail..."
  class="w-full px-3 py-2.5 bg-black/40 border border-steel-blue/20 rounded-lg text-white placeholder-steel-blue/60 text-sm resize-none focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-all mb-3"></textarea>

<label class="text-[10px] text-steel-blue font-bold uppercase tracking-wider block mb-1">Screenshot (optional)</label>
<input id="createImage" type="file" accept="image/png,image/jpeg,image/webp"
  class="w-full text-sm text-steel-blue file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-bold file:bg-primary/20 file:text-primary hover:file:bg-primary/30 transition-all mb-4"/>

<button onclick="submitNewTicket()" id="createSubmitBtn" class="w-full py-2.5 rounded-lg bg-primary hover:bg-primary/80 text-white text-sm font-bold transition-all">
Submit Ticket
</button>
</div>
</div>

<!-- Ticket Detail Modal -->
<div id="detailModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4" onclick="if(event.target===this)closeDetailModal()">
<div class="absolute inset-0 bg-black/70 backdrop-blur-sm"></div>
<div class="relative w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl glass-card p-5 custom-scrollbar">
<button onclick="closeDetailModal()" class="absolute top-3 right-3 text-steel-blue hover:text-white transition-colors z-10">
<span class="material-symbols-outlined">close</span>
</button>
<div id="detailContent">
<div class="text-center text-steel-blue py-8">
<span class="material-symbols-outlined text-4xl mb-2 block opacity-50 animate-spin">progress_activity</span>
<p>Loading...</p>
</div>
</div>
</div>
</div>

<!-- Image Lightbox -->
<div id="lightbox" class="fixed inset-0 z-[60] hidden items-center justify-center bg-black/90 cursor-pointer" onclick="closeLightbox()">
<img id="lightboxImg" src="" class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"/>
</div>

<!-- Main Content Area -->
<main class="flex-1 flex flex-col min-h-0 lg:h-screen overflow-hidden">
<!-- Header (desktop only) -->
<header class="h-16 border-b border-steel-blue/20 hidden lg:flex items-center justify-between px-8 bg-black/40 backdrop-blur-md z-10">
<div class="flex items-center gap-6">
<div id="systemStatus" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-steel-blue/10 border border-steel-blue/30">
<span class="flex size-2 rounded-full bg-steel-blue"></span>
<span class="text-steel-blue text-xs font-bold uppercase tracking-widest">Loading...</span>
</div>
</div>
<div class="flex items-center gap-4">
<button class="relative p-2 text-steel-blue hover:text-frosted-blue transition-colors group" title="Notifications">
<span class="material-symbols-outlined">notifications</span>
</button>
<div class="relative">
<button id="userMenuBtn" class="flex items-center gap-3 pl-4 cursor-pointer hover:opacity-80 transition-opacity">
<div class="text-right">
<p id="headerUsername" class="text-sm font-bold text-white leading-none"></p>
<p id="headerRole" class="text-[10px] text-steel-blue mt-1"></p>
</div>
<div id="headerAvatar" class="size-9 rounded-full bg-gradient-to-br from-baltic-blue to-cornflower-ocean border border-steel-blue/40"></div>
</button>
<div id="userMenuDropdown" class="hidden absolute right-0 top-full mt-2 w-48 bg-black/95 border border-steel-blue/30 rounded-xl shadow-xl py-2 z-50">
<a href="/settings" class="flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors" data-admin-only="true" style="display:none">
<span class="material-symbols-outlined text-steel-blue text-sm">manage_accounts</span>
Account Settings
</a>
<button data-logout class="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors text-left">
<span class="material-symbols-outlined text-steel-blue text-sm">logout</span>
Sign Out
</button>
</div>
</div>
</div>
</header>

<!-- Scrollable Content -->
<div class="flex-1 overflow-y-auto p-4 lg:p-8 custom-scrollbar">

<!-- Stat Cards -->
<div class="grid grid-cols-4 gap-3 mb-6">
<div class="glass-card rounded-xl p-4 text-center">
<p class="text-2xl font-bold text-white" id="statTotal">--</p>
<p class="text-[10px] text-steel-blue font-bold uppercase tracking-wider mt-1">Total</p>
</div>
<div class="glass-card rounded-xl p-4 text-center">
<p class="text-2xl font-bold text-amber-400" id="statOpen">--</p>
<p class="text-[10px] text-steel-blue font-bold uppercase tracking-wider mt-1">Open</p>
</div>
<div class="glass-card rounded-xl p-4 text-center">
<p class="text-2xl font-bold text-blue-400" id="statInProgress">--</p>
<p class="text-[10px] text-steel-blue font-bold uppercase tracking-wider mt-1">In Progress</p>
</div>
<div class="glass-card rounded-xl p-4 text-center">
<p class="text-2xl font-bold text-green-500" id="statResolved">--</p>
<p class="text-[10px] text-steel-blue font-bold uppercase tracking-wider mt-1">Resolved</p>
</div>
</div>

<!-- New Ticket Button + Filter Tabs -->
<div class="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
<button onclick="openCreateModal()" class="px-4 py-2.5 rounded-lg bg-primary hover:bg-primary/80 text-white text-sm font-bold transition-all flex items-center gap-2 shrink-0">
<span class="material-symbols-outlined text-sm">add</span> New Ticket
</button>
<div class="flex flex-wrap gap-2">
<button onclick="setFilter('all')" data-filter="all" class="filter-tab active px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">All</button>
<button onclick="setFilter('open')" data-filter="open" class="filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">Open</button>
<button onclick="setFilter('in_progress')" data-filter="in_progress" class="filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">In Progress</button>
<button onclick="setFilter('resolved')" data-filter="resolved" class="filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">Resolved</button>
<button onclick="setFilter('closed')" data-filter="closed" class="filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">Closed</button>
</div>
</div>

<!-- Category Filter -->
<div class="flex flex-wrap gap-2 mb-4">
<button onclick="setCategoryFilter('all')" data-catfilter="all" class="cat-filter-tab active px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">All Types</button>
<button onclick="setCategoryFilter('media_request')" data-catfilter="media_request" class="cat-filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">Media Request</button>
<button onclick="setCategoryFilter('playback_issue')" data-catfilter="playback_issue" class="cat-filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">Playback Issue</button>
<button onclick="setCategoryFilter('account_issue')" data-catfilter="account_issue" class="cat-filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">Account Issue</button>
<button onclick="setCategoryFilter('feature_suggestion')" data-catfilter="feature_suggestion" class="cat-filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">Feature</button>
<button onclick="setCategoryFilter('other')" data-catfilter="other" class="cat-filter-tab px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all">Other</button>
</div>

<!-- Ticket List -->
<div id="ticketList" class="space-y-2">
<div class="text-center text-steel-blue py-12">
<span class="material-symbols-outlined text-4xl mb-2 block opacity-50 animate-spin">progress_activity</span>
<p>Loading tickets...</p>
</div>
</div>

<!-- Pagination -->
<div id="pagination" class="hidden flex items-center justify-center gap-4 mt-6">
<button onclick="prevPage()" id="prevBtn" class="px-4 py-2 rounded-lg bg-white/5 border border-steel-blue/20 text-steel-blue hover:text-white hover:border-primary/40 transition-all text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed">
<span class="material-symbols-outlined text-sm align-middle">chevron_left</span> Prev
</button>
<span id="pageInfo" class="text-sm text-steel-blue font-bold"></span>
<button onclick="nextPage()" id="nextBtn" class="px-4 py-2 rounded-lg bg-white/5 border border-steel-blue/20 text-steel-blue hover:text-white hover:border-primary/40 transition-all text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed">
Next <span class="material-symbols-outlined text-sm align-middle">chevron_right</span>
</button>
</div>

<!-- Empty State -->
<div id="emptyState" class="hidden text-center text-steel-blue py-12">
<span class="material-symbols-outlined text-5xl mb-3 block opacity-30">confirmation_number</span>
<p class="text-sm mb-1">No tickets yet</p>
<p class="text-xs opacity-60">Click "New Ticket" to submit a support request</p>
</div>

</div>
</main>

<!-- Scripts -->
<script src="/static/js/auth.js"></script>
<script src="/static/js/sidebar.js?v=6"></script>
<script src="/static/js/notifications.js"></script>
<script>
// WebServarr — Tickets Page
(function() {
  'use strict';

  // ---- State ----
  var _tickets = [];
  var _currentFilter = 'all';
  var _currentCatFilter = 'all';
  var _currentPage = 0;
  var _pageSize = 12;
  var _total = 0;
  var _isAdmin = false;
  var _username = '';
  var _refreshTimer = null;

  // ---- Category display config ----
  var CATEGORY_LABELS = {
    media_request: 'Media Request',
    playback_issue: 'Playback Issue',
    account_issue: 'Account Issue',
    feature_suggestion: 'Feature',
    other: 'Other'
  };
  var CATEGORY_COLORS = {
    media_request: 'bg-purple-500/20 text-purple-400',
    playback_issue: 'bg-red-500/20 text-red-400',
    account_issue: 'bg-blue-500/20 text-blue-400',
    feature_suggestion: 'bg-green-500/20 text-green-400',
    other: 'bg-steel-blue/20 text-steel-blue'
  };
  var STATUS_COLORS = {
    open: 'bg-amber-500/20 text-amber-400',
    in_progress: 'bg-blue-500/20 text-blue-400',
    resolved: 'bg-green-500/20 text-green-400',
    closed: 'bg-steel-blue/20 text-steel-blue'
  };
  var PRIORITY_COLORS = {
    low: 'bg-green-500/20 text-green-400',
    medium: 'bg-amber-500/20 text-amber-400',
    high: 'bg-orange-500/20 text-orange-400',
    urgent: 'bg-red-500/20 text-red-400'
  };

  // ---- Helpers ----

  function createEl(tag, classes, text) {
    var el = document.createElement(tag);
    if (classes) el.className = classes;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function timeAgo(isoString) {
    if (!isoString) return '';
    var seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 0) seconds = 0;
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
    return new Date(isoString).toLocaleDateString();
  }

  function showToast(message, type) {
    var container = document.getElementById('toastContainer');
    var toast = createEl('div', 'pointer-events-auto px-4 py-3 rounded-xl text-sm font-bold shadow-xl backdrop-blur-md border transition-all transform translate-x-full');
    if (type === 'error') {
      toast.className += ' bg-red-500/20 border-red-500/30 text-red-400';
    } else {
      toast.className += ' bg-green-500/20 border-green-500/30 text-green-400';
    }
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(function() { toast.classList.remove('translate-x-full'); });
    setTimeout(function() {
      toast.classList.add('translate-x-full');
      setTimeout(function() { toast.remove(); }, 300);
    }, 3000);
  }

  // ---- Filter tabs ----

  window.setFilter = function(status) {
    _currentFilter = status;
    _currentPage = 0;
    document.querySelectorAll('.filter-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-filter') === status);
    });
    loadTickets();
  };

  window.setCategoryFilter = function(cat) {
    _currentCatFilter = cat;
    _currentPage = 0;
    document.querySelectorAll('.cat-filter-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-catfilter') === cat);
    });
    loadTickets();
  };

  // ---- Pagination ----

  window.prevPage = function() { if (_currentPage > 0) { _currentPage--; loadTickets(); } };
  window.nextPage = function() {
    if ((_currentPage + 1) * _pageSize < _total) { _currentPage++; loadTickets(); }
  };

  function updatePagination() {
    var pag = document.getElementById('pagination');
    var totalPages = Math.max(1, Math.ceil(_total / _pageSize));
    if (_total <= _pageSize) { pag.classList.add('hidden'); return; }
    pag.classList.remove('hidden');
    document.getElementById('pageInfo').textContent = 'Page ' + (_currentPage + 1) + ' of ' + totalPages;
    document.getElementById('prevBtn').disabled = _currentPage === 0;
    document.getElementById('nextBtn').disabled = (_currentPage + 1) >= totalPages;
  }

  // ---- Load tickets ----

  function loadTickets() {
    var params = new URLSearchParams();
    if (_currentFilter !== 'all') params.set('status', _currentFilter);
    if (_currentCatFilter !== 'all') params.set('category', _currentCatFilter);
    params.set('limit', _pageSize);
    params.set('offset', _currentPage * _pageSize);

    var url = _isAdmin ? '/api/admin/tickets' : '/api/tickets';

    fetch(url + '?' + params.toString())
      .then(function(r) { return r.json(); })
      .then(function(data) {
        _tickets = data.tickets || [];
        _total = data.total || 0;
        renderTicketList();
        updatePagination();
      })
      .catch(function() { showToast('Failed to load tickets', 'error'); });
  }

  function loadCounts() {
    fetch('/api/tickets/counts')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('statTotal').textContent = data.total || 0;
        document.getElementById('statOpen').textContent = data.open || 0;
        document.getElementById('statInProgress').textContent = data.in_progress || 0;
        document.getElementById('statResolved').textContent = data.resolved || 0;
      })
      .catch(function() {});
  }

  // ---- Render ticket list ----

  function renderTicketList() {
    var container = document.getElementById('ticketList');
    var empty = document.getElementById('emptyState');

    // Clear
    while (container.firstChild) container.removeChild(container.firstChild);

    if (_tickets.length === 0) {
      container.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    container.classList.remove('hidden');
    empty.classList.add('hidden');

    _tickets.forEach(function(ticket) {
      var card = createEl('div', 'glass-card rounded-xl p-4 cursor-pointer hover:border-primary/40 transition-all border border-transparent');
      card.addEventListener('click', function() { openDetailModal(ticket.id); });

      // Top row: title + badges
      var topRow = createEl('div', 'flex items-start justify-between gap-3 mb-2');

      var titleDiv = createEl('div', 'flex-1 min-w-0');
      var titleEl = createEl('p', 'text-white font-bold text-sm truncate', ticket.title);
      titleDiv.appendChild(titleEl);

      // Creator (admin only)
      if (_isAdmin && ticket.creator_username) {
        var creatorEl = createEl('p', 'text-[10px] text-steel-blue mt-0.5', '@' + ticket.creator_username);
        titleDiv.appendChild(creatorEl);
      }

      var badgeDiv = createEl('div', 'flex items-center gap-1.5 shrink-0 flex-wrap justify-end');

      // Category badge
      var catBadge = createEl('span', 'px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ' + (CATEGORY_COLORS[ticket.category] || CATEGORY_COLORS.other), CATEGORY_LABELS[ticket.category] || ticket.category);
      badgeDiv.appendChild(catBadge);

      // Status badge
      var statusLabel = (ticket.status || 'open').replace('_', ' ');
      var statusBadge = createEl('span', 'px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ' + (STATUS_COLORS[ticket.status] || STATUS_COLORS.open), statusLabel);
      badgeDiv.appendChild(statusBadge);

      // Priority badge (if set)
      if (ticket.priority) {
        var priBadge = createEl('span', 'px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ' + (PRIORITY_COLORS[ticket.priority] || ''), ticket.priority);
        badgeDiv.appendChild(priBadge);
      }

      topRow.appendChild(titleDiv);
      topRow.appendChild(badgeDiv);
      card.appendChild(topRow);

      // Bottom row: description snippet + time
      var bottomRow = createEl('div', 'flex items-center justify-between gap-3');
      var descSnippet = createEl('p', 'text-xs text-steel-blue truncate flex-1', ticket.description);
      var timeEl = createEl('span', 'text-[10px] text-steel-blue/60 shrink-0', timeAgo(ticket.created_at));
      bottomRow.appendChild(descSnippet);
      bottomRow.appendChild(timeEl);
      card.appendChild(bottomRow);

      container.appendChild(card);
    });
  }

  // ---- Create ticket ----

  window.openCreateModal = function() {
    document.getElementById('createModal').classList.remove('hidden');
    document.getElementById('createTitle').value = '';
    document.getElementById('createDescription').value = '';
    document.getElementById('createCategory').value = 'media_request';
    document.getElementById('createImage').value = '';
  };

  window.closeCreateModal = function() {
    document.getElementById('createModal').classList.add('hidden');
  };

  window.submitNewTicket = function() {
    var title = document.getElementById('createTitle').value.trim();
    var description = document.getElementById('createDescription').value.trim();
    var category = document.getElementById('createCategory').value;
    var imageInput = document.getElementById('createImage');

    if (!title) { showToast('Title is required', 'error'); return; }
    if (!description) { showToast('Description is required', 'error'); return; }

    var formData = new FormData();
    formData.append('title', title);
    formData.append('description', description);
    formData.append('category', category);
    if (imageInput.files.length > 0) {
      formData.append('image', imageInput.files[0]);
    }

    var btn = document.getElementById('createSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    fetch('/api/tickets', { method: 'POST', body: formData })
      .then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw new Error(d.detail || 'Failed'); });
        return r.json();
      })
      .then(function() {
        closeCreateModal();
        showToast('Ticket submitted!', 'success');
        loadTickets();
        loadCounts();
      })
      .catch(function(e) { showToast(e.message, 'error'); })
      .finally(function() { btn.disabled = false; btn.textContent = 'Submit Ticket'; });
  };

  // ---- Ticket detail modal ----

  window.openDetailModal = function(ticketId) {
    document.getElementById('detailModal').classList.remove('hidden');
    var content = document.getElementById('detailContent');
    // Show loading
    while (content.firstChild) content.removeChild(content.firstChild);
    var loadingDiv = createEl('div', 'text-center text-steel-blue py-8');
    var spinner = createEl('span', 'material-symbols-outlined text-4xl mb-2 block opacity-50 animate-spin', 'progress_activity');
    loadingDiv.appendChild(spinner);
    loadingDiv.appendChild(createEl('p', '', 'Loading...'));
    content.appendChild(loadingDiv);

    fetch('/api/tickets/' + ticketId)
      .then(function(r) { return r.json(); })
      .then(function(data) { renderDetailContent(data.ticket, data.comments); })
      .catch(function() { showToast('Failed to load ticket', 'error'); closeDetailModal(); });
  };

  window.closeDetailModal = function() {
    document.getElementById('detailModal').classList.add('hidden');
  };

  function renderDetailContent(ticket, comments) {
    var content = document.getElementById('detailContent');
    while (content.firstChild) content.removeChild(content.firstChild);

    // Title
    content.appendChild(createEl('h3', 'text-lg font-bold text-white mb-1 pr-8', ticket.title));

    // Creator (admin or own)
    if (ticket.creator_username) {
      content.appendChild(createEl('p', 'text-xs text-steel-blue mb-3', 'by @' + ticket.creator_username + ' \u00B7 ' + timeAgo(ticket.created_at)));
    } else {
      content.appendChild(createEl('p', 'text-xs text-steel-blue mb-3', timeAgo(ticket.created_at)));
    }

    // Badges row
    var badgeRow = createEl('div', 'flex flex-wrap gap-2 mb-4');
    var catBadge = createEl('span', 'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ' + (CATEGORY_COLORS[ticket.category] || ''), CATEGORY_LABELS[ticket.category] || ticket.category);
    badgeRow.appendChild(catBadge);
    var statusLabel = (ticket.status || 'open').replace('_', ' ');
    var statusBadge = createEl('span', 'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ' + (STATUS_COLORS[ticket.status] || ''), statusLabel);
    badgeRow.appendChild(statusBadge);
    if (ticket.priority) {
      var priBadge = createEl('span', 'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ' + (PRIORITY_COLORS[ticket.priority] || ''), ticket.priority);
      badgeRow.appendChild(priBadge);
    }
    if (ticket.is_public) {
      badgeRow.appendChild(createEl('span', 'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase bg-primary/20 text-primary', 'Public'));
    }
    content.appendChild(badgeRow);

    // Description
    content.appendChild(createEl('p', 'text-sm text-frosted-blue mb-4 whitespace-pre-wrap', ticket.description));

    // Image
    if (ticket.image_path) {
      var img = document.createElement('img');
      img.src = ticket.image_path;
      img.className = 'w-full max-h-48 object-contain rounded-lg mb-4 cursor-pointer hover:opacity-80 transition-opacity';
      img.alt = 'Ticket attachment';
      img.addEventListener('click', function() { openLightbox(ticket.image_path); });
      content.appendChild(img);
    }

    // Admin controls
    if (_isAdmin) {
      var controlsDiv = createEl('div', 'flex flex-wrap gap-2 mb-4 p-3 rounded-lg bg-white/5 border border-steel-blue/20');

      // Status dropdown
      var statusSelect = document.createElement('select');
      statusSelect.className = 'px-2 py-1.5 bg-black/40 border border-steel-blue/20 rounded-lg text-white text-xs focus:outline-none focus:ring-1 focus:ring-primary/30';
      ['open', 'in_progress', 'resolved', 'closed'].forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s.replace('_', ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
        if (s === ticket.status) opt.selected = true;
        statusSelect.appendChild(opt);
      });

      // Priority dropdown
      var prioritySelect = document.createElement('select');
      prioritySelect.className = 'px-2 py-1.5 bg-black/40 border border-steel-blue/20 rounded-lg text-white text-xs focus:outline-none focus:ring-1 focus:ring-primary/30';
      var noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'No Priority';
      if (!ticket.priority) noneOpt.selected = true;
      prioritySelect.appendChild(noneOpt);
      ['low', 'medium', 'high', 'urgent'].forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p.charAt(0).toUpperCase() + p.slice(1);
        if (p === ticket.priority) opt.selected = true;
        prioritySelect.appendChild(opt);
      });

      // Public toggle
      var pubLabel = createEl('label', 'flex items-center gap-2 text-xs text-steel-blue cursor-pointer');
      var pubCheck = document.createElement('input');
      pubCheck.type = 'checkbox';
      pubCheck.checked = ticket.is_public;
      pubCheck.className = 'rounded border-steel-blue/30 bg-black/40 text-primary focus:ring-primary/30';
      pubLabel.appendChild(pubCheck);
      pubLabel.appendChild(document.createTextNode('Public'));

      // Save button
      var saveBtn = createEl('button', 'px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/80 text-white text-xs font-bold transition-all ml-auto', 'Save');
      saveBtn.addEventListener('click', function() {
        fetch('/api/admin/tickets/' + ticket.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: statusSelect.value,
            priority: prioritySelect.value || null,
            is_public: pubCheck.checked,
          }),
        })
          .then(function(r) { return r.json(); })
          .then(function() {
            showToast('Ticket updated', 'success');
            loadTickets();
            loadCounts();
          })
          .catch(function() { showToast('Failed to update', 'error'); });
      });

      // Delete button
      var delBtn = createEl('button', 'px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 text-xs font-bold transition-all', 'Delete');
      delBtn.addEventListener('click', function() {
        if (!confirm('Delete this ticket permanently?')) return;
        fetch('/api/admin/tickets/' + ticket.id, { method: 'DELETE' })
          .then(function(r) { return r.json(); })
          .then(function() {
            closeDetailModal();
            showToast('Ticket deleted', 'success');
            loadTickets();
            loadCounts();
          })
          .catch(function() { showToast('Failed to delete', 'error'); });
      });

      controlsDiv.appendChild(statusSelect);
      controlsDiv.appendChild(prioritySelect);
      controlsDiv.appendChild(pubLabel);
      controlsDiv.appendChild(saveBtn);
      controlsDiv.appendChild(delBtn);
      content.appendChild(controlsDiv);
    }

    // Separator
    content.appendChild(createEl('div', 'border-t border-steel-blue/20 my-4'));

    // Comments header
    content.appendChild(createEl('p', 'text-[10px] text-steel-blue font-bold uppercase tracking-wider mb-3', 'Comments (' + comments.length + ')'));

    // Comments list
    if (comments.length === 0) {
      content.appendChild(createEl('p', 'text-sm text-steel-blue/60 italic mb-4', 'No comments yet'));
    } else {
      var commentsList = createEl('div', 'space-y-3 mb-4');
      comments.forEach(function(comment) {
        var cDiv = createEl('div', 'p-3 rounded-lg ' + (comment.is_admin ? 'bg-primary/10 border border-primary/20' : 'bg-white/5 border border-steel-blue/10'));

        // Author + time
        var cHeader = createEl('div', 'flex items-center justify-between mb-1.5');
        var authorText = comment.is_admin ? 'Admin' : (comment.author_name || 'You');
        var cAuthor = createEl('span', 'text-xs font-bold ' + (comment.is_admin ? 'text-primary' : 'text-white'), authorText);
        if (comment.is_admin) {
          var adminBadge = createEl('span', 'ml-1.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-primary/20 text-primary uppercase', 'Staff');
          var authorWrap = createEl('div', 'flex items-center');
          authorWrap.appendChild(cAuthor);
          authorWrap.appendChild(adminBadge);
          cHeader.appendChild(authorWrap);
        } else {
          cHeader.appendChild(cAuthor);
        }
        cHeader.appendChild(createEl('span', 'text-[10px] text-steel-blue/60', timeAgo(comment.created_at)));
        cDiv.appendChild(cHeader);

        // Message
        cDiv.appendChild(createEl('p', 'text-sm text-frosted-blue whitespace-pre-wrap', comment.message));

        // Image
        if (comment.image_path) {
          var cImg = document.createElement('img');
          cImg.src = comment.image_path;
          cImg.className = 'mt-2 max-h-32 rounded-lg cursor-pointer hover:opacity-80 transition-opacity';
          cImg.alt = 'Comment attachment';
          cImg.addEventListener('click', function() { openLightbox(comment.image_path); });
          cDiv.appendChild(cImg);
        }

        commentsList.appendChild(cDiv);
      });
      content.appendChild(commentsList);
    }

    // Add comment form (only if own ticket or admin)
    if (ticket.is_own || _isAdmin) {
      var formDiv = createEl('div', 'border-t border-steel-blue/20 pt-4');
      var textarea = document.createElement('textarea');
      textarea.placeholder = 'Write a comment...';
      textarea.rows = 3;
      textarea.className = 'w-full px-3 py-2.5 bg-black/40 border border-steel-blue/20 rounded-lg text-white placeholder-steel-blue/60 text-sm resize-none focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-all mb-2';

      var fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/webp';
      fileInput.className = 'w-full text-sm text-steel-blue file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-primary/20 file:text-primary hover:file:bg-primary/30 transition-all mb-2';

      var sendBtn = createEl('button', 'w-full py-2.5 rounded-lg bg-primary hover:bg-primary/80 text-white text-sm font-bold transition-all', 'Add Comment');
      sendBtn.addEventListener('click', function() {
        var msg = textarea.value.trim();
        if (!msg) { showToast('Comment cannot be empty', 'error'); return; }

        var formData = new FormData();
        formData.append('message', msg);
        if (fileInput.files.length > 0) {
          formData.append('image', fileInput.files[0]);
        }

        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';

        fetch('/api/tickets/' + ticket.id + '/comments', { method: 'POST', body: formData })
          .then(function(r) {
            if (!r.ok) return r.json().then(function(d) { throw new Error(d.detail || 'Failed'); });
            return r.json();
          })
          .then(function() {
            showToast('Comment added', 'success');
            openDetailModal(ticket.id); // Refresh detail
          })
          .catch(function(e) { showToast(e.message, 'error'); })
          .finally(function() { sendBtn.disabled = false; sendBtn.textContent = 'Add Comment'; });
      });

      formDiv.appendChild(textarea);
      formDiv.appendChild(fileInput);
      formDiv.appendChild(sendBtn);
      content.appendChild(formDiv);
    }
  }

  // ---- Lightbox ----

  window.openLightbox = function(src) {
    document.getElementById('lightboxImg').src = src;
    document.getElementById('lightbox').classList.remove('hidden');
    document.getElementById('lightbox').classList.add('flex');
  };

  window.closeLightbox = function() {
    document.getElementById('lightbox').classList.add('hidden');
    document.getElementById('lightbox').classList.remove('flex');
  };

  // ---- Filter tab styles ----

  var styleEl = document.createElement('style');
  styleEl.textContent = '.filter-tab, .cat-filter-tab { background: rgba(255,255,255,0.05); color: rgb(var(--color-accent)); border: 1px solid transparent; }' +
    '.filter-tab.active, .cat-filter-tab.active { background: rgb(var(--color-primary) / 0.2); color: rgb(var(--color-primary)); border-color: rgb(var(--color-primary) / 0.3); }' +
    '.filter-tab:hover, .cat-filter-tab:hover { background: rgba(255,255,255,0.08); }';
  document.head.appendChild(styleEl);

  // ---- Init ----

  initSidebar('tickets');

  checkAuth().then(function(user) {
    _isAdmin = user.is_admin;
    _username = user.username || '';

    // Header
    var uEl = document.getElementById('headerUsername');
    var rEl = document.getElementById('headerRole');
    if (uEl) uEl.textContent = user.display_name || user.username;
    if (rEl) rEl.textContent = user.is_admin ? 'Admin' : 'Member';
    showAdminNav(user.is_admin);

    // User menu
    var menuBtn = document.getElementById('userMenuBtn');
    var menuDrop = document.getElementById('userMenuDropdown');
    if (menuBtn && menuDrop) {
      menuBtn.addEventListener('click', function() { menuDrop.classList.toggle('hidden'); });
      document.addEventListener('click', function(e) {
        if (!menuBtn.contains(e.target) && !menuDrop.contains(e.target)) menuDrop.classList.add('hidden');
      });
    }

    // Load data
    loadTickets();
    loadCounts();

    // Auto-refresh every 30s
    _refreshTimer = setInterval(function() { loadTickets(); loadCounts(); }, 30000);

    // Init notifications
    if (window.initNotifications) window.initNotifications();
  });

})();
</script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add app/static/tickets.html
git commit -m "feat: add tickets frontend page with list, create, detail, and admin controls"
```

---

### Task 8: Settings UI — Tickets Feature Toggle + Nav Config

**Files:**
- Modify: `app/static/settings.html`

**Context:** The settings page has feature toggles in the System tab (like `features.show_requests` and `features.show_simple_auth`). We need to add `features.show_tickets`. The sidebar labels and icons sections already iterate over configurable items — we just need to add the tickets entries.

**Step 1: Add tickets feature toggle**

In `app/static/settings.html`, find the feature toggles section in the System tab. Look for the `features.show_simple_auth` toggle. After it, add:

```html
<label class="flex items-center justify-between py-2">
<div>
<span class="text-sm text-white font-medium">Tickets</span>
<p class="text-[10px] text-steel-blue mt-0.5">Show Tickets page in sidebar for support requests</p>
</div>
<input type="checkbox" id="featureShowTickets" class="rounded border-steel-blue/30 bg-black/40 text-primary focus:ring-primary/30"
  onchange="saveFeatureToggle('features.show_tickets', this.checked)"/>
</label>
```

**Step 2: Wire the toggle to load its current value**

In the settings page's JavaScript, find where other feature toggles are loaded (look for `featureShowRequests` or `featureShowSimpleAuth`). Add alongside them:

```javascript
var showTicketsRow = settings.find(function(s) { return s.key === 'features.show_tickets'; });
if (showTicketsRow) {
  document.getElementById('featureShowTickets').checked = showTicketsRow.value === 'true';
}
```

**Step 3: Add tickets to sidebar label + icon config**

In the settings page's sidebar label configuration section (look for `sidebar.label_calendar`), add:

```javascript
{ key: 'sidebar.label_tickets', label: 'Tickets', path: '/tickets' },
```

In the icon configuration section (look for `icon.nav_calendar`), add:

```javascript
{ key: 'icon.nav_tickets', label: 'Tickets' },
```

**Step 4: Add notification poll interval for tickets**

In the Notifications accordion of the Integrations tab, find where the three existing interval inputs are (overseerr, monitors, news). Add after them:

```html
<div>
<label class="text-xs text-steel-blue font-semibold block mb-1">Ticket Check Interval (seconds)</label>
<input type="number" id="notifIntervalTickets" min="30" value="60"
  class="w-full px-3 py-2.5 bg-black/40 border border-steel-blue/20 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-all"/>
</div>
```

Wire it to load/save with the key `notifications.poll_interval_tickets` alongside the other intervals.

**Step 5: Commit**

```bash
git add app/static/settings.html
git commit -m "feat: add tickets feature toggle and config to settings page"
```

---

### Task 9: Branding API — Tickets Feature Flag

**Files:**
- Modify: `app/routers/branding.py`

**Context:** The branding API (`GET /api/branding`) returns feature flags, sidebar labels, and icons to the frontend. The sidebar already reads `features.show_tickets` from the response. We need to ensure the branding endpoint includes it.

**Step 1: Verify the branding endpoint includes features.show_tickets**

Read `app/routers/branding.py` and check how it constructs the `features` dict. It likely reads all `features.*` settings from the DB. If it's a general pattern (reads all Settings with `features.` prefix), no code change is needed — the seeded `features.show_tickets` setting will be automatically included.

If the features are hardcoded, add `show_tickets` to the features dict construction.

Similarly verify that `sidebar.label_tickets` and `icon.nav_tickets` are picked up by the sidebar_labels and icons sections of the branding response.

**Step 2: Commit (if changes needed)**

```bash
git add app/routers/branding.py
git commit -m "feat: include ticket feature flag in branding API"
```

---

### Task 10: Documentation Updates

**Files:**
- Modify: `docs/app-contract.md`
- Modify: `CLAUDE.md` (Phase 8 entry)
- Modify: `VISION.md` (Phase 8 description)

**Step 1: Add ticket endpoints to `docs/app-contract.md`**

In the API endpoints table, add:

```markdown
### Tickets

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/tickets` | Session | List user's tickets + public tickets |
| POST | `/api/tickets` | Session | Create a new ticket (multipart) |
| GET | `/api/tickets/counts` | Session | Ticket counts by status |
| GET | `/api/tickets/{id}` | Session | Ticket detail + comments |
| POST | `/api/tickets/{id}/comments` | Session | Add comment to ticket (multipart) |
| GET | `/api/admin/tickets` | Admin | List all tickets with filters |
| PUT | `/api/admin/tickets/{id}` | Admin | Update status/priority/visibility |
| DELETE | `/api/admin/tickets/{id}` | Admin | Delete ticket + comments |
```

Add Ticket and TicketComment to the models table.

Add `/tickets` to the pages table.

**Step 2: Update `VISION.md` Phase 8**

Add Phase 8 description for the ticket system.

**Step 3: Update `CLAUDE.md`**

Add `app/routers/tickets.py` to the Key Paths section. Update the project phases table to show Phase 8.

**Step 4: Commit**

```bash
git add docs/app-contract.md CLAUDE.md VISION.md
git commit -m "docs: add ticket system to app contract, vision, and operator manual"
```

---

## Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | `app/models.py` | Ticket + TicketComment models |
| 2 | `app/seed.py` | Default settings (feature toggle, sidebar, icon, poll interval) |
| 3 | `app/routers/tickets.py`, `app/main.py` | Full API router + page route registration |
| 4 | `app/services/notification_poller.py`, `app/routers/notifications.py` | Ticket polling loop + preferences |
| 5 | `app/static/js/sidebar.js` | Nav item with feature flag |
| 6 | `app/static/js/notifications.js` | Ticket category maps |
| 7 | `app/static/tickets.html` | Full frontend page |
| 8 | `app/static/settings.html` | Feature toggle + config UI |
| 9 | `app/routers/branding.py` | Verify feature flag in branding API |
| 10 | `docs/app-contract.md`, `CLAUDE.md`, `VISION.md` | Documentation |
