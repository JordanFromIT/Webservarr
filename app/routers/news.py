"""
News API routes - CRUD operations for news posts
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime, timedelta
from sqlalchemy import or_

from app.content import sanitize_html
from app.database import get_db
from app.dependencies import get_current_user, get_current_user_optional, require_admin
from app.limiter import limiter
from app.models import NewsPost

router = APIRouter()


# Pydantic schemas
class NewsPostCreate(BaseModel):
    """Schema for creating a news post."""
    title: str
    content: str  # Raw HTML from rich text editor
    published: bool = False
    pinned: bool = False


class NewsPostUpdate(BaseModel):
    """Schema for updating a news post."""
    title: Optional[str] = None
    content: Optional[str] = None
    published: Optional[bool] = None
    pinned: Optional[bool] = None


class NewsPostResponse(BaseModel):
    """Schema for news post response.

    ``content`` is the editor's own copy of the post markup and is returned to
    admins only (see ``_serialize_news_post``); public/anonymous callers get
    the sanitized ``content_html`` and never the ``content`` field.
    """
    id: int
    title: str
    content: Optional[str] = None  # Sanitized editor HTML; returned to admins only
    content_html: str  # Sanitized HTML
    author_name: str
    created_at: datetime
    updated_at: Optional[datetime]
    published: bool
    published_at: Optional[datetime]
    pinned: bool

    class Config:
        from_attributes = True


def _serialize_news_post(post: NewsPost, include_content: bool) -> dict:
    """Build the response body for a news post.

    ``content`` (the editor's copy of the post markup) is included only when
    ``include_content`` is set -- i.e. for an admin who may reopen the post in
    the editor. Public/anonymous callers get ``content_html`` only, so a post
    can never serve editor-supplied markup to a non-admin viewer. Paired with
    ``response_model_exclude_unset=True`` on the read routes, omitting the key
    here drops it from the JSON entirely rather than emitting ``null``.
    """
    data = {
        "id": post.id,
        "title": post.title,
        "content_html": post.content_html,
        "author_name": post.author_name,
        "created_at": post.created_at,
        "updated_at": post.updated_at,
        "published": post.published,
        "published_at": post.published_at,
        "pinned": post.pinned,
    }
    if include_content:
        data["content"] = post.content
    return data


@router.get("/", response_model=List[NewsPostResponse], response_model_exclude_unset=True)
async def get_news_posts(
    published_only: bool = True,
    limit: int = Query(10, ge=1, le=100),
    offset: int = Query(0, ge=0),
    max_age_days: Optional[int] = Query(None, ge=1),
    db: Session = Depends(get_db),
    current_user: Optional[dict] = Depends(get_current_user_optional),
):
    """
    Get news posts.
    Public endpoint - returns published posts by default. Only an authenticated
    admin may request unpublished/draft posts (published_only=false); for anyone
    else the published-only filter is forced on.

    ``max_age_days`` retires stale news from the homepage without deleting it:
    posts older than the window drop out of the response, but the archive page
    (which omits the param) still lists everything. Pinned posts are exempt --
    a pin is the admin saying "this stays up", and an age cutoff must not
    silently override that.
    """
    is_admin = bool(current_user) and str(current_user.get("is_admin", "false")).lower() == "true"

    # Drafts are admin-only; force the published filter for everyone else.
    if not published_only and not is_admin:
        published_only = True

    query = db.query(NewsPost)

    if published_only:
        query = query.filter(NewsPost.published == True)

    if max_age_days:
        cutoff = datetime.utcnow() - timedelta(days=max_age_days)
        query = query.filter(
            or_(NewsPost.pinned == True, NewsPost.created_at >= cutoff)
        )

    # Order by pinned first, then by created_at descending
    query = query.order_by(
        NewsPost.pinned.desc(),
        NewsPost.created_at.desc()
    )

    posts = query.offset(offset).limit(limit).all()
    return [_serialize_news_post(post, include_content=is_admin) for post in posts]


@router.get("/{post_id}", response_model=NewsPostResponse, response_model_exclude_unset=True)
async def get_news_post(
    post_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[dict] = Depends(get_current_user_optional),
):
    """
    Get a single news post by ID.

    Drafts are readable by an authenticated admin only -- without this the
    editor could not reopen its own unpublished work, which reads to the
    author as the draft having been thrown away.
    """
    is_admin = bool(current_user) and str(current_user.get("is_admin", "false")).lower() == "true"

    post = db.query(NewsPost).filter(NewsPost.id == post_id).first()

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="News post not found"
        )

    if not post.published and not is_admin:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="News post not found"
        )

    return _serialize_news_post(post, include_content=is_admin)


@router.post("/", response_model=NewsPostResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("30/minute")
async def create_news_post(
    request: Request,
    post_data: NewsPostCreate,
    current_user: dict = Depends(require_admin),    db: Session = Depends(get_db)
):
    """
    Create a new news post.
    Requires admin authentication.
    """
    # Sanitize the editor HTML once and store it for BOTH fields: content_html
    # is what gets rendered, and content (the copy the editor reopens) must not
    # be allowed to carry active markup either, so it can never become a stored
    # XSS sink if it is ever served or loaded raw.
    content_html = sanitize_html(post_data.content)

    # Create post
    new_post = NewsPost(
        title=post_data.title,
        content=content_html,
        content_html=content_html,
        author_id=current_user.get("user_id", ""),
        author_name=current_user.get("name", "Unknown"),
        published=post_data.published,
        published_at=datetime.utcnow() if post_data.published else None,
        pinned=post_data.pinned
    )

    db.add(new_post)
    db.commit()
    db.refresh(new_post)

    return new_post


@router.put("/{post_id}", response_model=NewsPostResponse)
@limiter.limit("30/minute")
async def update_news_post(
    request: Request,
    post_id: int,
    post_data: NewsPostUpdate,
    current_user: dict = Depends(require_admin),    db: Session = Depends(get_db)
):
    """
    Update a news post.
    Requires admin authentication.
    """
    post = db.query(NewsPost).filter(NewsPost.id == post_id).first()

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="News post not found"
        )

    # Update fields if provided
    if post_data.title is not None:
        post.title = post_data.title

    if post_data.content is not None:
        # Store the sanitized markup for both fields (see create_news_post).
        sanitized = sanitize_html(post_data.content)
        post.content = sanitized
        post.content_html = sanitized

    if post_data.published is not None:
        # If publishing for first time, set published_at
        if post_data.published and not post.published:
            post.published_at = datetime.utcnow()
        post.published = post_data.published

    if post_data.pinned is not None:
        post.pinned = post_data.pinned

    db.commit()
    db.refresh(post)

    return post


@router.delete("/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("30/minute")
async def delete_news_post(
    request: Request,
    post_id: int,
    current_user: dict = Depends(require_admin),    db: Session = Depends(get_db)
):
    """
    Delete a news post.
    Requires admin authentication.
    """
    post = db.query(NewsPost).filter(NewsPost.id == post_id).first()

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="News post not found"
        )

    db.delete(post)
    db.commit()

    return None
