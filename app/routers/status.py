"""
Status feed routes (app/services/status_feed.py).

The feed is for signed-in people; signed-out callers get only the one-line
GET /api/integrations/status-summary. Admins keep short notes in it. Every
write is admin only and same-origin, and a database that can't be reached
answers 503, never 500.
"""

import functools
import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_admin
from app.limiter import limiter
from app.models import StatusUpdate
from app.routers.player import Text, require_encodable_body, require_same_origin
from app.services import status_feed

logger = logging.getLogger(__name__)

router = APIRouter()

WRITE_LIMIT = "30/minute"
# SQLite's largest integer: a bigger id is a 422, not an overflow (a 500).
NoteId = Annotated[int, Path(ge=1, le=2 ** 63 - 1)]
DB_DOWN = "The status feed can't be reached right now"


def _db_503(route):
    """503, not 500, when the database can't be read or written. Innermost
    decorator, so the limiter and FastAPI still see the route's signature."""
    @functools.wraps(route)
    async def guarded(*args, **kwargs):
        try:
            return await route(*args, **kwargs)
        except SQLAlchemyError as exc:
            logger.warning("The status feed could not be reached: %s", type(exc).__name__)
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=DB_DOWN) from None
    return guarded


@router.get("/feed")
@limiter.limit("60/minute")
@_db_503
async def get_feed(
    request: Request,
    days: int = Query(status_feed.FEED_DAYS_DEFAULT, ge=1, le=status_feed.FEED_DAYS_MAX),
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """{"state", "open": [...], "items": [...]}: open outages and important
    notes pinned, then the last `days` days, newest first (status_feed.feed).
    `state` is "ok", "down", "unavailable" (Uptime Kuma hasn't answered
    lately: never read as "all running") or "off" (no Uptime Kuma)."""
    body = status_feed.feed(db, days, status_feed.now_utc())
    answering = await status_feed.kuma_answering()
    return {"state": status_feed.state(status_feed.kuma_configured(db), answering, body["open"]), **body}


class NoteIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: Text = Field(max_length=status_feed.NOTE_MAX)
    important: StrictBool = False
    service: Optional[Text] = Field(default=None, max_length=status_feed.SERVICE_MAX)

    def cleaned(self) -> tuple:
        """(text, service) trimmed; 422 when the text is blank."""
        text = self.text.strip()
        if not text:
            raise HTTPException(status_code=422, detail="Write the note first")
        return text, (self.service or "").strip() or None


def _note(db: Session, note_id: int) -> StatusUpdate:
    """The admin note, or 404 (outages aren't notes)."""
    row = db.get(StatusUpdate, note_id)
    if row is None or row.source != status_feed.ADMIN:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return row


def _fill(row: StatusUpdate, body: NoteIn) -> None:
    text, service = body.cleaned()
    row.message, row.title, row.service_name = text, text[:200], service
    row.important = body.important
    row.severity = "critical" if body.important else "info"


@router.post("/notes", status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@limiter.limit(WRITE_LIMIT)
@_db_503
async def create_note(request: Request, body: NoteIn, admin: dict = Depends(require_admin),
                      db: Session = Depends(get_db)):
    """Post a note (up to 280 characters), optionally important (pushed
    within seconds) and about one service. Returns the feed item."""
    row = StatusUpdate(source=status_feed.ADMIN, update_type="note", active=True,
                       author_id=str(admin.get("user_id") or "")[:100],
                       author_name=str(admin.get("display_name") or admin.get("username") or "")[:100],
                       created_at=status_feed.now_utc())
    _fill(row, body)
    db.add(row)
    db.commit()
    return status_feed.item(row)


@router.put("/notes/{note_id}", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@limiter.limit(WRITE_LIMIT)
@_db_503
async def update_note(request: Request, note_id: NoteId, body: NoteIn, _admin: dict = Depends(require_admin),
                      db: Session = Depends(get_db)):
    """Change a note's text, importance or service. A note already pushed is
    not pushed again; one made important now is. Returns the feed item."""
    row = _note(db, note_id)
    _fill(row, body)
    db.commit()
    return status_feed.item(row)


@router.delete("/notes/{note_id}", dependencies=[Depends(require_same_origin)])
@limiter.limit(WRITE_LIMIT)
@_db_503
async def delete_note(request: Request, note_id: NoteId, _admin: dict = Depends(require_admin),
                      db: Session = Depends(get_db)):
    db.delete(_note(db, note_id))
    db.commit()
    return {"success": True}


@router.post("/notes/{note_id}/resolve", dependencies=[Depends(require_same_origin)])
@limiter.limit(WRITE_LIMIT)
@_db_503
async def resolve_note(request: Request, note_id: NoteId, _admin: dict = Depends(require_admin),
                       db: Session = Depends(get_db)):
    """Mark a note resolved: it leaves the pinned list. Resolving it again
    changes nothing. Returns the feed item."""
    row = _note(db, note_id)
    if row.active:
        row.active = False
        row.resolved_at = status_feed.now_utc()
        db.commit()
    return status_feed.item(row)
