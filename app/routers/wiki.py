"""
Wiki API - operator-authored guides, readable by any signed-in user.

Every route here requires a session. Writes require admin. There is no public
surface: the wiki is deliberately not readable logged-out, so no public rate
tier and no crawler handling appear in this file.
"""

import logging
import mimetypes
import os
import re
import unicodedata
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.content import render_markdown
from app.database import get_db
from app.dependencies import get_current_user, require_admin
from app.limiter import limiter
from app.models import WikiCategory, WikiPage
from app.utils import validate_image_magic

logger = logging.getLogger(__name__)
router = APIRouter()

SNIPPET_RADIUS = 80  # characters either side of a search hit

# Outside the public /static tree, on the persisted data volume, so images are
# reachable only through the auth-checked endpoint below.
WIKI_UPLOAD_DIR = os.environ.get("WIKI_UPLOAD_DIR", "/app/data/wiki_uploads")
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_IMAGE_SIZE = 4 * 1024 * 1024  # 4MB - screenshots of a large desktop are big
ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


# ============================================================
# Helpers
# ============================================================

def slugify(text: str, max_len: int = 220) -> str:
    """Title -> URL slug. ASCII-folded, lowercased, runs of anything else
    collapsed to single hyphens. Never returns an empty string, because an empty
    slug would collide with the wiki index route."""
    folded = unicodedata.normalize("NFKD", text or "")
    folded = folded.encode("ascii", "ignore").decode("ascii").lower()
    cleaned = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")
    return cleaned[:max_len].rstrip("-") or "page"


def unique_slug(db: Session, model, base: str, exclude_id: Optional[int] = None) -> str:
    """First free slug of the form base, base-2, base-3 ... Used to suggest an
    alternative in the 409 body, never to silently rename what the author typed."""
    candidate, n = base, 1
    while True:
        q = db.query(model).filter(model.slug == candidate)
        if exclude_id is not None:
            q = q.filter(model.id != exclude_id)
        if not q.first():
            return candidate
        n += 1
        candidate = f"{base}-{n}"


def is_admin(user: dict) -> bool:
    return user.get("is_admin") == "true"


# ============================================================
# Schemas
# ============================================================

class CategoryWrite(BaseModel):
    name: str
    slug: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    sort_order: int = 0


class PageWrite(BaseModel):
    title: str
    slug: Optional[str] = None
    summary: Optional[str] = None
    content: str
    category_slug: Optional[str] = None
    sort_order: int = 0
    published: bool = False


# ============================================================
# Serializers
# ============================================================

def _category_dict(cat: WikiCategory, page_count: int, draft_count: int) -> dict:
    return {
        "id": cat.id,
        "name": cat.name,
        "slug": cat.slug,
        "description": cat.description,
        "icon": cat.icon,
        "sort_order": cat.sort_order,
        "page_count": page_count,
        "draft_count": draft_count,
    }


def _page_brief(page: WikiPage, cat: Optional[WikiCategory]) -> dict:
    stamp = page.updated_at or page.created_at
    return {
        "id": page.id,
        "title": page.title,
        "slug": page.slug,
        "summary": page.summary,
        "category_slug": cat.slug if cat else None,
        "category_name": cat.name if cat else None,
        "sort_order": page.sort_order,
        "published": page.published,
        "is_example": page.is_example,
        "updated_at": stamp.isoformat() if stamp else None,
    }


def _snippet(content: str, term: str) -> dict:
    """A plain-text window around the first case-insensitive hit, plus the offset
    and length of the match within that window.

    Offsets rather than inserted markup: the server must never emit HTML into a
    JSON field that the client will render, and the client can highlight a range
    without parsing anything.
    """
    body = content or ""
    idx = body.lower().find((term or "").lower())
    if idx < 0:
        return {
            "snippet": body[: SNIPPET_RADIUS * 2].strip(),
            "match_offset": 0,
            "match_length": 0,
        }

    start = max(0, idx - SNIPPET_RADIUS)
    end = min(len(body), idx + len(term) + SNIPPET_RADIUS)
    window = body[start:end]
    lead = len(window) - len(window.lstrip())
    prefix = "… " if start > 0 else ""
    return {
        "snippet": prefix + window.strip() + ("" if end >= len(body) else " …"),
        "match_offset": (idx - start) - lead + len(prefix),
        "match_length": len(term),
    }


# ============================================================
# Read endpoints (any signed-in user)
# ============================================================

@router.get("/categories")
@limiter.limit("120/minute")
async def list_categories(
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Categories in display order, each with its page counts."""
    admin = is_admin(current_user)
    out = []
    for cat in db.query(WikiCategory).order_by(
        WikiCategory.sort_order, WikiCategory.name
    ).all():
        published = db.query(WikiPage).filter(
            WikiPage.category_id == cat.id, WikiPage.published.is_(True)
        ).count()
        drafts = db.query(WikiPage).filter(
            WikiPage.category_id == cat.id, WikiPage.published.is_(False)
        ).count() if admin else 0
        out.append(_category_dict(cat, published, drafts))
    return out


@router.get("/pages")
@limiter.limit("120/minute")
async def list_pages(
    request: Request,
    category: Optional[str] = None,
    q: Optional[str] = None,
    include_drafts: bool = False,
    limit: int = 50,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Page metadata only - never content_html, which would make the list huge."""
    admin = is_admin(current_user)
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    query = db.query(WikiPage)
    if not (admin and include_drafts):
        query = query.filter(WikiPage.published.is_(True))

    if category == "uncategorised":
        query = query.filter(WikiPage.category_id.is_(None))
    elif category:
        cat = db.query(WikiCategory).filter(WikiCategory.slug == category).first()
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")
        query = query.filter(WikiPage.category_id == cat.id)

    term = (q or "").strip()
    if term:
        # Searching the markdown source rather than content_html so a query never
        # matches on tag names or attribute values the author never typed.
        like = f"%{term}%"
        query = query.filter(
            WikiPage.title.ilike(like)
            | WikiPage.summary.ilike(like)
            | WikiPage.content.ilike(like)
        )

    pages = query.order_by(WikiPage.sort_order, WikiPage.title).all()
    cats = {c.id: c for c in db.query(WikiCategory).all()}

    results = []
    for page in pages:
        item = _page_brief(page, cats.get(page.category_id))
        if term:
            low = term.lower()
            if low in (page.title or "").lower():
                item["matched_in"] = "title"
            elif low in (page.summary or "").lower():
                item["matched_in"] = "summary"
            else:
                item["matched_in"] = "body"
            item.update(_snippet(page.content, term))
        results.append(item)

    if term:
        # Title hits first, then summary, then body; alphabetical within each.
        rank = {"title": 0, "summary": 1, "body": 2}
        results.sort(key=lambda r: (rank.get(r.get("matched_in"), 3), (r["title"] or "").lower()))

    return results[offset:offset + limit]


@router.get("/pages/{slug}")
@limiter.limit("120/minute")
async def get_page(
    slug: str,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """One page with its rendered body and its siblings.

    An unpublished page returns 404 rather than 403 for non-admins: a draft
    should be indistinguishable from a page that does not exist.
    """
    page = db.query(WikiPage).filter(WikiPage.slug == slug).first()
    if not page or (not page.published and not is_admin(current_user)):
        raise HTTPException(status_code=404, detail="Page not found")

    cat = None
    if page.category_id:
        cat = db.query(WikiCategory).filter(WikiCategory.id == page.category_id).first()

    siblings = []
    if cat:
        rows = db.query(WikiPage).filter(
            WikiPage.category_id == cat.id,
            WikiPage.id != page.id,
            WikiPage.published.is_(True),
        ).order_by(WikiPage.sort_order, WikiPage.title).all()
        siblings = [{"title": r.title, "slug": r.slug} for r in rows]

    data = _page_brief(page, cat)
    data.update({
        "content": page.content,
        "content_html": page.content_html,
        "author_name": page.author_name,
        "created_at": page.created_at.isoformat() if page.created_at else None,
        "siblings": siblings,
    })
    return data


# ============================================================
# Page writes (admin)
# ============================================================

@router.post("/pages", status_code=status.HTTP_201_CREATED)
@limiter.limit("30/minute")
async def create_page(
    payload: PageWrite,
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    slug = slugify(payload.slug or payload.title)
    clash = db.query(WikiPage).filter(WikiPage.slug == slug).first()
    if clash:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": f'The slug "{slug}" is already used by "{clash.title}".',
                "suggested_slug": unique_slug(db, WikiPage, slug),
            },
        )

    category_id = None
    if payload.category_slug:
        cat = db.query(WikiCategory).filter(
            WikiCategory.slug == payload.category_slug
        ).first()
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")
        category_id = cat.id

    page = WikiPage(
        title=payload.title,
        slug=slug,
        summary=payload.summary,
        content=payload.content,
        content_html=render_markdown(payload.content),
        category_id=category_id,
        sort_order=payload.sort_order,
        published=payload.published,
        author_name=current_user.get("username", "admin"),
    )
    db.add(page)
    db.commit()
    db.refresh(page)
    cat = db.query(WikiCategory).filter(WikiCategory.id == page.category_id).first() if page.category_id else None
    return _page_brief(page, cat)


@router.put("/pages/{slug}")
@limiter.limit("30/minute")
async def update_page(
    slug: str,
    payload: PageWrite,
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    page = db.query(WikiPage).filter(WikiPage.slug == slug).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    new_slug = slugify(payload.slug or payload.title)
    if new_slug != page.slug:
        clash = db.query(WikiPage).filter(
            WikiPage.slug == new_slug, WikiPage.id != page.id
        ).first()
        if clash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "message": f'The slug "{new_slug}" is already used by "{clash.title}".',
                    "suggested_slug": unique_slug(db, WikiPage, new_slug, exclude_id=page.id),
                },
            )
        page.slug = new_slug

    if payload.category_slug:
        cat = db.query(WikiCategory).filter(
            WikiCategory.slug == payload.category_slug
        ).first()
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")
        page.category_id = cat.id
    else:
        page.category_id = None

    page.title = payload.title
    page.summary = payload.summary
    page.sort_order = payload.sort_order
    page.published = payload.published
    if payload.content != page.content:
        page.content = payload.content
        page.content_html = render_markdown(payload.content)

    db.commit()
    db.refresh(page)
    cat = db.query(WikiCategory).filter(WikiCategory.id == page.category_id).first() if page.category_id else None
    return _page_brief(page, cat)


@router.delete("/pages/{slug}", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("30/minute")
async def delete_page(
    slug: str,
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    page = db.query(WikiPage).filter(WikiPage.slug == slug).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    db.delete(page)
    db.commit()
    return None


# ============================================================
# Category writes (admin)
# ============================================================

@router.post("/categories", status_code=status.HTTP_201_CREATED)
@limiter.limit("30/minute")
async def create_category(
    payload: CategoryWrite,
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    slug = slugify(payload.slug or payload.name, max_len=120)
    if db.query(WikiCategory).filter(WikiCategory.slug == slug).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": f'A category with the slug "{slug}" already exists.',
                "suggested_slug": unique_slug(db, WikiCategory, slug),
            },
        )
    cat = WikiCategory(
        name=payload.name,
        slug=slug,
        description=payload.description,
        icon=payload.icon,
        sort_order=payload.sort_order,
    )
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return _category_dict(cat, 0, 0)


@router.put("/categories/{slug}")
@limiter.limit("30/minute")
async def update_category(
    slug: str,
    payload: CategoryWrite,
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    cat = db.query(WikiCategory).filter(WikiCategory.slug == slug).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")

    new_slug = slugify(payload.slug or payload.name, max_len=120)
    if new_slug != cat.slug:
        if db.query(WikiCategory).filter(
            WikiCategory.slug == new_slug, WikiCategory.id != cat.id
        ).first():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "message": f'A category with the slug "{new_slug}" already exists.',
                    "suggested_slug": unique_slug(db, WikiCategory, new_slug, exclude_id=cat.id),
                },
            )
        cat.slug = new_slug

    cat.name = payload.name
    cat.description = payload.description
    cat.icon = payload.icon
    cat.sort_order = payload.sort_order
    db.commit()
    db.refresh(cat)

    published = db.query(WikiPage).filter(
        WikiPage.category_id == cat.id, WikiPage.published.is_(True)
    ).count()
    drafts = db.query(WikiPage).filter(
        WikiPage.category_id == cat.id, WikiPage.published.is_(False)
    ).count()
    return _category_dict(cat, published, drafts)


@router.delete("/categories/{slug}")
@limiter.limit("30/minute")
async def delete_category(
    slug: str,
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Delete a category, keeping its pages.

    The pages are nulled explicitly rather than leaning on ON DELETE SET NULL:
    SQLite ignores foreign-key actions unless PRAGMA foreign_keys=ON, which this
    app does not set, so relying on the declaration would leave rows pointing at
    a category id that no longer exists.
    """
    cat = db.query(WikiCategory).filter(WikiCategory.slug == slug).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")

    orphaned = db.query(WikiPage).filter(WikiPage.category_id == cat.id).count()
    db.query(WikiPage).filter(WikiPage.category_id == cat.id).update(
        {WikiPage.category_id: None}, synchronize_session=False
    )
    db.delete(cat)
    db.commit()
    return {"deleted": slug, "pages_uncategorised": orphaned}


# ============================================================
# Images
# ============================================================

@router.post("/images", status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
async def upload_image(
    request: Request,
    file: UploadFile = File(...),
    current_user: dict = Depends(require_admin),
):
    """Validate and store a wiki image.

    Content-Type is attacker-controlled, so the magic-number check is the one
    that actually matters; the allowlist above only gives a clearer error first.
    """
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type: {file.content_type}. Allowed: PNG, JPEG, WebP",
        )

    content = await file.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File too large. Maximum size is 4MB.",
        )

    if not validate_image_magic(content, file.content_type):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File content does not match declared image type",
        )

    os.makedirs(WIKI_UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(file.filename or "image.png")[1].lower()
    if ext not in ALLOWED_EXTS:
        ext = ".png"
    filename = f"wiki-{uuid.uuid4().hex[:12]}{ext}"

    with open(os.path.join(WIKI_UPLOAD_DIR, filename), "wb") as fh:
        fh.write(content)

    return {"url": f"/api/wiki/images/{filename}", "filename": filename}


@router.get("/images/{filename}")
@limiter.limit("120/minute")
async def get_image(
    filename: str,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """Serve a wiki image to any signed-in user.

    Unlike ticket images there is no per-page ownership to check: the whole wiki
    is visible to everyone who can sign in, so a session is the whole rule.
    """
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    filepath = os.path.join(WIKI_UPLOAD_DIR, filename)
    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Image not found")

    content_type, _ = mimetypes.guess_type(filepath)
    return FileResponse(filepath, media_type=content_type or "application/octet-stream")
