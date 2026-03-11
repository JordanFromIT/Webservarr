"""
News API routes - CRUD operations for news posts
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
import markdown
import bleach

from app.database import get_db
from app.dependencies import get_current_user, require_admin
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
    """Schema for news post response."""
    id: int
    title: str
    content: str  # Raw HTML from editor
    content_html: str  # Sanitized HTML
    author_name: str
    created_at: datetime
    updated_at: Optional[datetime]
    published: bool
    published_at: Optional[datetime]
    pinned: bool

    class Config:
        from_attributes = True


def sanitize_html(html: str) -> str:
    """
    Sanitize HTML to prevent XSS attacks.
    Allows safe tags only.
    """
    allowed_tags = [
        'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'hr',
        'img', 's', 'del', 'div', 'span', 'sub', 'sup'
    ]
    allowed_attributes = {
        'a': ['href', 'title', 'target', 'rel'],
        'img': ['src', 'alt', 'width', 'height']
    }

    return bleach.clean(
        html,
        tags=allowed_tags,
        attributes=allowed_attributes,
        strip=True
    )


def render_markdown(content: str) -> str:
    """Render markdown to sanitized HTML."""
    html = markdown.markdown(content, extensions=['extra', 'codehilite'])
    return sanitize_html(html)


@router.get("/", response_model=List[NewsPostResponse])
async def get_news_posts(
    published_only: bool = True,
    limit: int = 10,
    db: Session = Depends(get_db)
):
    """
    Get news posts.
    Public endpoint - returns published posts by default.
    """
    query = db.query(NewsPost)

    if published_only:
        query = query.filter(NewsPost.published == True)

    # Order by pinned first, then by created_at descending
    query = query.order_by(
        NewsPost.pinned.desc(),
        NewsPost.created_at.desc()
    )

    posts = query.limit(limit).all()
    return posts


@router.get("/{post_id}", response_model=NewsPostResponse)
async def get_news_post(
    post_id: int,
    db: Session = Depends(get_db)
):
    """Get a single news post by ID."""
    post = db.query(NewsPost).filter(NewsPost.id == post_id).first()

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="News post not found"
        )

    # Only show published posts to non-admins
    # TODO: Add user check for unpublished posts
    if not post.published:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="News post not found"
        )

    return post


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
    # Sanitize HTML from rich text editor
    content_html = sanitize_html(post_data.content)

    # Create post
    new_post = NewsPost(
        title=post_data.title,
        content=post_data.content,
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
        post.content = post_data.content
        post.content_html = sanitize_html(post_data.content)

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
