"""
Ticket system API routes — user support tickets with admin management.
"""

import json
import logging
import mimetypes
import os
import shutil
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import bleach
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import false, func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_admin
from app.limiter import limiter
from app.models import Setting, Ticket, TicketComment, User
from app.seed import LOCAL_USERNAMES_SNAPSHOT_KEY
from app.settings_registry import switch_is_off
from app.utils import identity_email, utc_iso, validate_image_magic

logger = logging.getLogger(__name__)

router = APIRouter()

# --- Constants ---

VALID_CATEGORIES = {"media_request", "playback_issue", "account_issue", "feature_suggestion", "other"}
VALID_STATUSES = {"open", "in_progress", "resolved", "closed"}
VALID_PRIORITIES = {"low", "medium", "high", "urgent"}

# Ticket images are private: store them OUTSIDE the public /static tree (under the
# persisted data volume) so they are reachable only through the auth-checked
# /api/uploads/tickets/{filename} endpoint, never via /static/uploads/tickets/.
TICKET_UPLOAD_DIR = os.environ.get("TICKET_UPLOAD_DIR", "/app/data/ticket_uploads")
# Former location inside the public static tree — files here are migrated out on startup.
LEGACY_TICKET_UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "uploads", "tickets")
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_IMAGE_SIZE = 2 * 1024 * 1024  # 2MB


def migrate_ticket_uploads() -> None:
    """One-time move of ticket images out of the public /static tree into the
    auth-only data dir. Closes the unauthenticated /static/uploads/tickets/ leak
    for images uploaded before this fix. Safe to run on every startup."""
    try:
        if not os.path.isdir(LEGACY_TICKET_UPLOAD_DIR):
            return
        os.makedirs(TICKET_UPLOAD_DIR, exist_ok=True)
        moved = 0
        for name in os.listdir(LEGACY_TICKET_UPLOAD_DIR):
            src = os.path.join(LEGACY_TICKET_UPLOAD_DIR, name)
            dst = os.path.join(TICKET_UPLOAD_DIR, name)
            if os.path.isfile(src) and not os.path.exists(dst):
                shutil.move(src, dst)  # handles cross-volume (uploads -> data) moves
                moved += 1
        if moved:
            logger.info("Migrated %d ticket image(s) out of the public static tree", moved)
    except Exception as e:
        logger.warning("Ticket upload migration failed: %s", e)


# --- Pydantic schemas ---

class AdminTicketUpdate(BaseModel):
    """Schema for admin ticket update."""
    status: Optional[str] = None
    priority: Optional[str] = None
    is_public: Optional[bool] = None


# --- Helpers ---

def _check_feature_enabled(db: Session, current_user: dict) -> None:
    """403 for non-admins while the Tickets page is switched off (Settings > Pages).

    Admins keep access so they can still read and close tickets while the page
    is hidden from everyone else. The retired features.show_tickets flag is
    deliberately not read: the page switch is the only gate."""
    if current_user.get("is_admin") == "true":
        return
    setting = db.query(Setting).filter(Setting.key == "sidebar.enabled_tickets").first()
    if setting and switch_is_off(setting.value):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The ticket system is turned off",
        )


def _strip_html(text: str) -> str:
    """Strip ALL HTML tags from text using bleach."""
    return bleach.clean(text, tags=[], strip=True).strip()


async def _save_upload(file: UploadFile) -> str:
    """Validate and save an uploaded image. Returns the URL path."""
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type: {file.content_type}. Allowed: PNG, JPEG, WebP",
        )

    content = await file.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File too large. Maximum size is 2MB.",
        )

    if not validate_image_magic(content, file.content_type):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File content does not match declared image type",
        )

    os.makedirs(TICKET_UPLOAD_DIR, exist_ok=True)

    ext = os.path.splitext(file.filename or "image.png")[1].lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
        ext = ".png"
    filename = f"ticket-{uuid.uuid4().hex[:12]}{ext}"
    filepath = os.path.join(TICKET_UPLOAD_DIR, filename)

    with open(filepath, "wb") as f:
        f.write(content)

    return f"/api/uploads/tickets/{filename}"


def account_identity(user: dict) -> str:
    """The stable account identity that owns tickets and comments, or "".

    Never the username: usernames come from separate namespaces (local
    accounts, Plex, Authentik) and can collide. A Plex account is its plex.tv
    account id however it signed in: a Plex-direct session's user_id is that
    id, and both Plex paths store it as plex_account_id (sign-in is refused
    when plex.tv cannot give it). A local account is its permanent users.uid
    (account_uid; users.id can be reused after a delete), and an Authentik
    identity without a Plex account its OIDC subject; each is namespaced so
    it can never equal a Plex id. A session missing its id has no identity
    and owns nothing. Always from the session, never from the request.
    """
    method = user.get("auth_method") or "simple"
    user_id = str(user.get("user_id") or "")
    plex_id = str(user.get("plex_account_id") or "")
    if method == "simple":
        uid = str(user.get("account_uid") or "")
        return f"local:{uid}" if uid else ""
    if method == "plex":
        plex_id = plex_id or user_id
    if plex_id:
        return f"plex:{plex_id}"
    if method == "oidc" and user_id and not user.get("plex_token"):
        return f"oidc:{user_id}"
    return ""


def claim_legacy_tickets(db: Session, user: dict) -> int:
    """Give this signer's tickets from before identities existed their
    identity. Called at sign-in by the Plex and Authentik paths, never by a
    local login, and a local identity is refused here too.

    A ticket with no identity is claimed by its creator_email, and only when
    the sign-in verified the session's email (email_verified): anyone can
    assert an address to Authentik. Both sides are trimmed and casefolded
    (in Python: SQLite's lower() is ASCII-only). The username is used only
    when the signer is a Plex account, the ticket has no email, and no local
    account has that username now or had it at the upgrade (the ticket may
    be theirs). The creator's own comments on a claimed ticket come with it,
    and a Plex account also claims comments by username under the same
    rule. Only rows with no identity are touched, so a row is claimed once
    and keeps that identity. Returns the number of tickets claimed.
    """
    identity = account_identity(user)
    if not identity or identity.startswith("local:"):
        return 0
    is_plex = identity.startswith("plex:")
    email = _email_key(user.get("email")) if _email_verified(user) else ""
    username = user.get("username") or ""
    by_username = is_plex and bool(username) and not _is_local_username(db, username)
    unclaimed = Ticket.creator_identity.is_(None)
    no_email = or_(Ticket.creator_email.is_(None), func.trim(Ticket.creator_email) == "")

    claimed = 0
    if email:
        ids = [
            ticket_id
            for ticket_id, creator_email in db.query(Ticket.id, Ticket.creator_email).filter(
                unclaimed, Ticket.creator_email.isnot(None)
            )
            if _email_key(creator_email) == email
        ]
        if ids:
            claimed += (
                db.query(Ticket)
                .filter(unclaimed, Ticket.id.in_(ids))
                .update({Ticket.creator_identity: identity}, synchronize_session=False)
            )
    if by_username:
        claimed += (
            db.query(Ticket)
            .filter(unclaimed, no_email, Ticket.creator_username == username)
            .update({Ticket.creator_identity: identity}, synchronize_session=False)
        )

    # Only a ticket's creator or an admin can comment, so a non-admin comment
    # under the creator's name on a ticket this identity owns is theirs.
    owned = defaultdict(list)
    for ticket_id, creator in db.query(Ticket.id, Ticket.creator_username).filter(
        Ticket.creator_identity == identity
    ):
        if creator:
            owned[creator].append(ticket_id)
    for creator, ticket_ids in owned.items():
        db.query(TicketComment).filter(
            TicketComment.author_identity.is_(None),
            TicketComment.is_admin == False,  # noqa: E712
            TicketComment.author_username == creator,
            TicketComment.ticket_id.in_(ticket_ids),
        ).update({TicketComment.author_identity: identity}, synchronize_session=False)
    if by_username:
        db.query(TicketComment).filter(
            TicketComment.author_identity.is_(None),
            TicketComment.author_username == username,
        ).update({TicketComment.author_identity: identity}, synchronize_session=False)

    db.commit()
    if claimed:
        logger.info("Claimed %d ticket(s) from before account identities", claimed)
    return claimed


def _email_verified(user: dict) -> bool:
    """Whether the sign-in verified this session's email. The sign-in routes
    hold it as a bool; the session stored in Redis holds "true"/"false"
    (bytes before decoding). True and "true" in any case count; anything
    else does not."""
    value = user.get("email_verified")
    if value is True:
        return True
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    return isinstance(value, str) and value.strip().lower() == "true"


def _email_key(value) -> str:
    """An email for comparison: trimmed and casefolded; "" and "none" are
    no email (see utils.identity_email)."""
    if not isinstance(value, str):
        return ""
    v = value.strip().casefold()
    return "" if v in ("", "none") else v


def _is_local_username(db: Session, username: str) -> bool:
    """Whether a local account has this username (case-insensitively), or
    had it when ticket identities arrived (seed.migrate_local_usernames_snapshot)."""
    key = username.casefold()
    if any((name or "").casefold() == key for (name,) in db.query(User.username)):
        return True
    row = db.query(Setting).filter(Setting.key == LOCAL_USERNAMES_SNAPSHOT_KEY).first()
    try:
        names = json.loads(row.value) if row and row.value else []
    except ValueError:
        return True  # unreadable snapshot: do not risk a local namesake's tickets
    return any(isinstance(n, str) and n.casefold() == key for n in names)


def _is_owner(ticket: Ticket, identity: str) -> bool:
    """Whether this session's account identity created the ticket (see
    account_identity). An empty identity owns nothing, so two sessions
    without one never share tickets."""
    return bool(identity) and ticket.creator_identity == identity


def _is_author(comment: TicketComment, identity: str) -> bool:
    """Whether this session's account identity wrote the comment (the same rule)."""
    return bool(identity) and comment.author_identity == identity


def _owned_by(identity: str):
    """_is_owner as a query filter: the caller's tickets, none for an empty
    identity."""
    return Ticket.creator_identity == identity if identity else false()


def _ticket_to_dict(ticket: Ticket, is_admin: bool, current_identity: str, comments: list = None) -> dict:
    """Convert a Ticket ORM object to a response dict with privacy rules applied."""
    data = {
        "id": ticket.id,
        "title": ticket.title,
        "description": ticket.description,
        "category": ticket.category,
        "status": ticket.status,
        "priority": ticket.priority,
        "is_public": ticket.is_public,
        "image_path": ticket.image_path,
        "created_at": utc_iso(ticket.created_at),
        "updated_at": utc_iso(ticket.updated_at),
        # The page offers the comment box to the owner (and to admins).
        "is_own": _is_owner(ticket, current_identity),
    }

    # Privacy: non-admin users never see other users' creator info
    if is_admin or _is_owner(ticket, current_identity):
        data["creator_username"] = ticket.creator_username
        data["creator_name"] = ticket.creator_name
    else:
        data["creator_username"] = None
        data["creator_name"] = None

    if comments is not None:
        data["comments"] = [
            _comment_to_dict(c, is_admin, current_identity) for c in comments
        ]

    return data


def _comment_to_dict(comment: TicketComment, is_admin: bool, current_identity: str) -> dict:
    """Convert a TicketComment ORM object to a response dict with privacy rules applied."""
    data = {
        "id": comment.id,
        "ticket_id": comment.ticket_id,
        "is_admin": comment.is_admin,
        "message": comment.message,
        "image_path": comment.image_path,
        "created_at": utc_iso(comment.created_at),
    }

    # Privacy: non-admin sees "Admin" label on admin comments, no author info on others' comments
    if is_admin or _is_author(comment, current_identity):
        data["author_username"] = comment.author_username
        data["author_name"] = comment.author_name
    else:
        data["author_username"] = None
        data["author_name"] = None

    return data


# ============================================================
# Authenticated file serving
# ============================================================

@router.get("/uploads/tickets/{filename}")
async def get_ticket_image(
    filename: str,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Serve a ticket image with authentication."""
    _check_feature_enabled(db, current_user)
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    filepath = os.path.join(TICKET_UPLOAD_DIR, filename)
    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Image not found")

    # Find the ticket this image belongs to
    url_path = f"/api/uploads/tickets/{filename}"
    ticket = db.query(Ticket).filter(
        (Ticket.image_path == url_path) |
        (Ticket.id.in_(
            db.query(TicketComment.ticket_id).filter(TicketComment.image_path == url_path)
        ))
    ).first()

    if not ticket:
        raise HTTPException(status_code=404, detail="Image not found")

    identity = account_identity(current_user)
    is_admin = current_user.get("is_admin") == "true"

    # Someone else's private image answers as if it were not there, as the
    # ticket itself does.
    if not is_admin and not _is_owner(ticket, identity) and not ticket.is_public:
        raise HTTPException(status_code=404, detail="Image not found")

    content_type, _ = mimetypes.guess_type(filepath)
    return FileResponse(filepath, media_type=content_type or "application/octet-stream")


# ============================================================
# User endpoints (Session auth)
# ============================================================

@router.get("/tickets")
async def list_tickets(
    status_filter: Optional[str] = Query(None, alias="status"),
    category: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    List tickets visible to the current user.
    Non-admin: own tickets + public tickets.
    """
    _check_feature_enabled(db, current_user)

    identity = account_identity(current_user)
    is_admin = current_user.get("is_admin") == "true"

    query = db.query(Ticket)

    # Non-admin: own tickets + public tickets only
    if not is_admin:
        query = query.filter(
            or_(
                _owned_by(identity),
                Ticket.is_public == True,
            )
        )

    if status_filter and status_filter in VALID_STATUSES:
        query = query.filter(Ticket.status == status_filter)
    if category and category in VALID_CATEGORIES:
        query = query.filter(Ticket.category == category)

    total = query.count()
    tickets = query.order_by(Ticket.updated_at.desc()).offset(offset).limit(limit).all()

    return {
        "tickets": [_ticket_to_dict(t, is_admin, identity) for t in tickets],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.post("/tickets", status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
async def create_ticket(
    request: Request,
    title: str = Form(...),
    description: str = Form(...),
    category: str = Form(...),
    image: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new ticket. Accepts multipart form data with optional image."""
    _check_feature_enabled(db, current_user)

    # Validate category
    if category not in VALID_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid category: {category}. Valid: {', '.join(sorted(VALID_CATEGORIES))}",
        )

    # Sanitize text
    clean_title = _strip_html(title)
    clean_description = _strip_html(description)

    if not clean_title:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Title cannot be empty",
        )
    if not clean_description:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Description cannot be empty",
        )

    # Handle image upload
    image_path = None
    if image and image.filename:
        image_path = await _save_upload(image)

    ticket = Ticket(
        title=clean_title,
        description=clean_description,
        category=category,
        status="open",
        is_public=False,
        creator_username=current_user.get("username", ""),
        creator_name=current_user.get("name", current_user.get("username", "Unknown")),
        creator_email=identity_email(current_user.get("email")) or None,
        creator_identity=account_identity(current_user) or None,
        image_path=image_path,
    )

    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    is_admin = current_user.get("is_admin") == "true"
    return _ticket_to_dict(ticket, is_admin, account_identity(current_user))


@router.get("/tickets/counts")
async def ticket_counts(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get ticket counts by status for the current user's visible tickets."""
    _check_feature_enabled(db, current_user)

    identity = account_identity(current_user)
    is_admin = current_user.get("is_admin") == "true"

    query = db.query(Ticket)
    if not is_admin:
        query = query.filter(
            or_(
                _owned_by(identity),
                Ticket.is_public == True,
            )
        )

    all_tickets = query.all()

    counts = {"open": 0, "in_progress": 0, "resolved": 0, "closed": 0, "total": 0}
    for t in all_tickets:
        counts["total"] += 1
        if t.status in counts:
            counts[t.status] += 1

    return counts


@router.get("/tickets/{ticket_id}")
async def get_ticket(
    ticket_id: int,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get ticket detail with comments. Accessible if own ticket, public, or admin."""
    _check_feature_enabled(db, current_user)

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Ticket not found",
        )

    identity = account_identity(current_user)
    is_admin = current_user.get("is_admin") == "true"

    # Access check: own ticket, public, or admin
    if not is_admin and not _is_owner(ticket, identity) and not ticket.is_public:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Ticket not found",
        )

    comments = (
        db.query(TicketComment)
        .filter(TicketComment.ticket_id == ticket_id)
        .order_by(TicketComment.created_at.asc())
        .all()
    )

    return _ticket_to_dict(ticket, is_admin, identity, comments=comments)


@router.post("/tickets/{ticket_id}/comments", status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
async def add_comment(
    request: Request,
    ticket_id: int,
    message: str = Form(...),
    image: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add a comment to a ticket. Only ticket creator or admin can comment."""
    _check_feature_enabled(db, current_user)

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Ticket not found",
        )

    username = current_user.get("username", "")
    identity = account_identity(current_user)
    is_admin = current_user.get("is_admin") == "true"

    # Only ticket creator or admin can comment
    if not is_admin and not _is_owner(ticket, identity):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the ticket creator or an admin can comment",
        )

    # Sanitize message
    clean_message = _strip_html(message)
    if not clean_message:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Comment message cannot be empty",
        )

    # Handle image upload
    image_path = None
    if image and image.filename:
        image_path = await _save_upload(image)

    comment = TicketComment(
        ticket_id=ticket_id,
        author_username=username,
        author_name=current_user.get("name", username),
        author_identity=identity or None,
        is_admin=is_admin,
        message=clean_message,
        image_path=image_path,
    )

    db.add(comment)

    # Explicitly update ticket.updated_at (onupdate only fires on row UPDATE, not related inserts)
    ticket.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(comment)

    return _comment_to_dict(comment, is_admin, identity)


# ============================================================
# Admin endpoints
# ============================================================

@router.get("/admin/tickets")
async def admin_list_tickets(
    status_filter: Optional[str] = Query(None, alias="status"),
    category: Optional[str] = None,
    priority: Optional[str] = None,
    creator: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """List ALL tickets with filters. Admin only."""
    _check_feature_enabled(db, current_user)

    query = db.query(Ticket)

    if status_filter and status_filter in VALID_STATUSES:
        query = query.filter(Ticket.status == status_filter)
    if category and category in VALID_CATEGORIES:
        query = query.filter(Ticket.category == category)
    if priority and priority in VALID_PRIORITIES:
        query = query.filter(Ticket.priority == priority)
    if creator is not None:
        creator = creator.strip()
        if not creator or len(creator) > 200:
            raise HTTPException(status_code=400, detail="Invalid creator filter")
        query = query.filter(Ticket.creator_username == creator)

    total = query.count()
    tickets = query.order_by(Ticket.updated_at.desc()).offset(offset).limit(limit).all()

    identity = account_identity(current_user)
    return {
        "tickets": [_ticket_to_dict(t, True, identity) for t in tickets],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.put("/admin/tickets/{ticket_id}")
@limiter.limit("30/minute")
async def admin_update_ticket(
    request: Request,
    ticket_id: int,
    payload: AdminTicketUpdate,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Update ticket status, priority, or visibility. Admin only."""
    _check_feature_enabled(db, current_user)

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Ticket not found",
        )

    if payload.status is not None:
        if payload.status not in VALID_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid status: {payload.status}. Valid: {', '.join(sorted(VALID_STATUSES))}",
            )
        ticket.status = payload.status

    if payload.priority is not None:
        if payload.priority not in VALID_PRIORITIES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid priority: {payload.priority}. Valid: {', '.join(sorted(VALID_PRIORITIES))}",
            )
        ticket.priority = payload.priority

    if payload.is_public is not None:
        ticket.is_public = payload.is_public

    ticket.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(ticket)

    return _ticket_to_dict(ticket, True, account_identity(current_user))


@router.delete("/admin/tickets/{ticket_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("30/minute")
async def admin_delete_ticket(
    request: Request,
    ticket_id: int,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Delete a ticket and all its comments. Admin only."""
    _check_feature_enabled(db, current_user)

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Ticket not found",
        )

    # Collect image paths before deleting
    comment_images = [
        c.image_path
        for c in db.query(TicketComment).filter(TicketComment.ticket_id == ticket_id).all()
        if c.image_path
    ]

    # Delete comments first (cascade)
    db.query(TicketComment).filter(TicketComment.ticket_id == ticket_id).delete()

    # Delete associated images from disk
    if ticket.image_path:
        _try_delete_file(ticket.image_path)
    for path in comment_images:
        _try_delete_file(path)

    db.delete(ticket)
    db.commit()

    return None


def _try_delete_file(url_path: str) -> None:
    """Try to delete a file given its URL path. Fails silently."""
    try:
        if url_path.startswith("/api/uploads/tickets/"):
            filename = url_path.split("/")[-1]
            filepath = os.path.join(TICKET_UPLOAD_DIR, filename)
            if os.path.isfile(filepath):
                os.remove(filepath)
        elif url_path.startswith("/static/"):
            rel = url_path[len("/static/"):]
            filepath = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", rel)
            if os.path.isfile(filepath):
                os.remove(filepath)
    except Exception as e:
        logger.warning("Failed to delete file %s: %s", url_path, e)
