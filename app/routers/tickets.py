"""
Ticket system API routes — user support tickets with admin management.
"""

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import bleach
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_admin
from app.limiter import limiter
from app.models import Setting, Ticket, TicketComment
from app.utils import validate_image_magic

logger = logging.getLogger(__name__)

router = APIRouter()

# --- Constants ---

VALID_CATEGORIES = {"media_request", "playback_issue", "account_issue", "feature_suggestion", "other"}
VALID_STATUSES = {"open", "in_progress", "resolved", "closed"}
VALID_PRIORITIES = {"low", "medium", "high", "urgent"}

TICKET_UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "uploads", "tickets")
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_IMAGE_SIZE = 2 * 1024 * 1024  # 2MB


# --- Pydantic schemas ---

class AdminTicketUpdate(BaseModel):
    """Schema for admin ticket update."""
    status: Optional[str] = None
    priority: Optional[str] = None
    is_public: Optional[bool] = None


# --- Helpers ---

def _check_feature_enabled(db: Session) -> None:
    """Raise 403 if features.show_tickets is 'false'."""
    setting = db.query(Setting).filter(Setting.key == "features.show_tickets").first()
    if setting and setting.value.lower() == "false":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Ticket system is disabled",
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

    return f"/static/uploads/tickets/{filename}"


def _ticket_to_dict(ticket: Ticket, is_admin: bool, current_username: str, comments: list = None) -> dict:
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
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
        "updated_at": ticket.updated_at.isoformat() if ticket.updated_at else None,
    }

    # Privacy: non-admin users never see other users' creator info
    if is_admin or ticket.creator_username == current_username:
        data["creator_username"] = ticket.creator_username
        data["creator_name"] = ticket.creator_name
    else:
        data["creator_username"] = None
        data["creator_name"] = None

    if comments is not None:
        data["comments"] = [
            _comment_to_dict(c, is_admin, current_username) for c in comments
        ]

    return data


def _comment_to_dict(comment: TicketComment, is_admin: bool, current_username: str) -> dict:
    """Convert a TicketComment ORM object to a response dict with privacy rules applied."""
    data = {
        "id": comment.id,
        "ticket_id": comment.ticket_id,
        "is_admin": comment.is_admin,
        "message": comment.message,
        "image_path": comment.image_path,
        "created_at": comment.created_at.isoformat() if comment.created_at else None,
    }

    # Privacy: non-admin sees "Admin" label on admin comments, no author info on others' comments
    if is_admin or comment.author_username == current_username:
        data["author_username"] = comment.author_username
        data["author_name"] = comment.author_name
    else:
        data["author_username"] = None
        data["author_name"] = None

    return data


# ============================================================
# User endpoints (Session auth)
# ============================================================

@router.get("/tickets")
async def list_tickets(
    status_filter: Optional[str] = Query(None, alias="status"),
    category: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    List tickets visible to the current user.
    Non-admin: own tickets + public tickets.
    """
    _check_feature_enabled(db)

    username = current_user.get("username", "")
    is_admin = current_user.get("is_admin") == "true"

    query = db.query(Ticket)

    # Non-admin: own tickets + public tickets only
    if not is_admin:
        query = query.filter(
            or_(
                Ticket.creator_username == username,
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
        "tickets": [_ticket_to_dict(t, is_admin, username) for t in tickets],
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
    _check_feature_enabled(db)

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
        image_path=image_path,
    )

    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    is_admin = current_user.get("is_admin") == "true"
    return _ticket_to_dict(ticket, is_admin, ticket.creator_username)


@router.get("/tickets/counts")
async def ticket_counts(
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get ticket counts by status for the current user's visible tickets."""
    _check_feature_enabled(db)

    username = current_user.get("username", "")
    is_admin = current_user.get("is_admin") == "true"

    query = db.query(Ticket)
    if not is_admin:
        query = query.filter(
            or_(
                Ticket.creator_username == username,
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
    _check_feature_enabled(db)

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Ticket not found",
        )

    username = current_user.get("username", "")
    is_admin = current_user.get("is_admin") == "true"

    # Access check: own ticket, public, or admin
    if not is_admin and ticket.creator_username != username and not ticket.is_public:
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

    return _ticket_to_dict(ticket, is_admin, username, comments=comments)


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
    _check_feature_enabled(db)

    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Ticket not found",
        )

    username = current_user.get("username", "")
    is_admin = current_user.get("is_admin") == "true"

    # Only ticket creator or admin can comment
    if not is_admin and ticket.creator_username != username:
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
        is_admin=is_admin,
        message=clean_message,
        image_path=image_path,
    )

    db.add(comment)

    # Explicitly update ticket.updated_at (onupdate only fires on row UPDATE, not related inserts)
    ticket.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(comment)

    return _comment_to_dict(comment, is_admin, username)


# ============================================================
# Admin endpoints
# ============================================================

@router.get("/admin/tickets")
async def admin_list_tickets(
    status_filter: Optional[str] = Query(None, alias="status"),
    category: Optional[str] = None,
    priority: Optional[str] = None,
    creator: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """List ALL tickets with filters. Admin only."""
    _check_feature_enabled(db)

    query = db.query(Ticket)

    if status_filter and status_filter in VALID_STATUSES:
        query = query.filter(Ticket.status == status_filter)
    if category and category in VALID_CATEGORIES:
        query = query.filter(Ticket.category == category)
    if priority and priority in VALID_PRIORITIES:
        query = query.filter(Ticket.priority == priority)
    if creator:
        query = query.filter(Ticket.creator_username == creator)

    total = query.count()
    tickets = query.order_by(Ticket.updated_at.desc()).offset(offset).limit(limit).all()

    username = current_user.get("username", "")
    return {
        "tickets": [_ticket_to_dict(t, True, username) for t in tickets],
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
    _check_feature_enabled(db)

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

    username = current_user.get("username", "")
    return _ticket_to_dict(ticket, True, username)


@router.delete("/admin/tickets/{ticket_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("30/minute")
async def admin_delete_ticket(
    request: Request,
    ticket_id: int,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Delete a ticket and all its comments. Admin only."""
    _check_feature_enabled(db)

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
        # URL path like /static/uploads/tickets/ticket-abc123.png
        # Filesystem: /app/app/static/uploads/tickets/ticket-abc123.png
        if url_path.startswith("/static/"):
            rel = url_path[len("/static/"):]
            filepath = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", rel)
            if os.path.isfile(filepath):
                os.remove(filepath)
    except Exception as e:
        logger.warning("Failed to delete file %s: %s", url_path, e)
