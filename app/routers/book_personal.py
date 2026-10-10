"""
A person's own Books data (/api/books/me/... and /api/books/<id>/list,
/queue, /rating, /continue-hidden): My list, the Up next queue, star ratings,
the books they took out of their Continue row, and their answer to the
audiobook notice (/api/books/me/notice). The rows are
app/services/book_personal.py's; this module decides what the caller may see
and change.

Every route needs a session (401) and an account identity (403 without one:
such a session owns nothing). Lists show only the books the caller can see
now, by the same rule as every other Books route (books.caller); a book they
cannot see cannot be added, rated or queued (404), while removing or clearing
works on whatever they hold. Every write checks same-origin. A merged id is
followed to the surviving book. Errors are 4xx or 503, never 500.
"""

import logging
import re
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Cookie, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models import Book
from app.routers import books
from app.routers.books import BookId, MAX_ID, Scope, caller
from app.routers.player import require_encodable_body, require_same_origin
from app.routers.tickets import account_identity
from app.services import book_catalog, book_personal, listening

logger = logging.getLogger(__name__)

router = APIRouter()

READ_LIMIT = books.LIST_LIMIT
WRITE_LIMIT = "60/minute"

NO_IDENTITY = "This account cannot keep books of its own"
NOT_VISIBLE = "No such book"

_EDITION_KEY = re.compile(r"[0-9]{1,20}:[0-9]{1,6}", re.ASCII)
_BOOK_ID = re.compile(r"[0-9]{1,10}", re.ASCII)


def _identity(who: Scope) -> str:
    if not who.identity:
        raise HTTPException(status_code=403, detail=NO_IDENTITY)
    return who.identity


async def _owner(user: dict = Depends(get_current_user)) -> str:
    """The caller's identity, for a removal (it needs no visibility check)."""
    identity = account_identity(user)
    if not identity:
        raise HTTPException(status_code=403, detail=NO_IDENTITY)
    return identity


def _visible(db: Session, who: Scope) -> dict:
    """{book id: CatalogRow} for every live book the caller can see."""
    return {r.id: r for r in book_catalog.visible_rows(db, who.series, who.audio)}


def _live_id(db: Session, book_id: int) -> Optional[int]:
    """The live book an id stands for (a merged id: the survivor), or None."""
    book, survivor = book_catalog.resolve_book(db, book_id)
    return book.id if book is not None else survivor


def _visible_book(db: Session, who: Scope, book_id: int):
    """The CatalogRow the caller can see for this id; 404 otherwise."""
    live = _live_id(db, book_id)
    row = _visible(db, who).get(live) if live is not None else None
    if row is None:
        raise HTTPException(status_code=404, detail=NOT_VISIBLE)
    return row


def _ids_to_clear(db: Session, book_id: int) -> list:
    """The id asked about and the book it now stands for, if it was merged."""
    live = _live_id(db, book_id)
    return list({book_id, live} - {None})


def _queue_items(db: Session, who: Scope) -> list:
    visible = _visible(db, who)
    shown = [b for b in book_personal.queue_ids(db, who.identity) if b in visible]
    return [{**books._book_card(visible[b]), "position": i} for i, b in enumerate(shown)]


# --- My list ------------------------------------------------------------------------

@router.get("/me/list")
@books._limit(READ_LIMIT, "me-list")
@books._db_503
async def my_list(request: Request, who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """The caller's list, newest first, only the books they can see now:
    {"items": [BookCard]}."""
    identity = _identity(who)
    visible = _visible(db, who)
    return {"items": [books._book_card(visible[b]) for b, _at in book_personal.list_entries(db, identity)
                      if b in visible]}


@router.put("/{book_id}/list", dependencies=[Depends(require_same_origin)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def add_to_list(request: Request, book_id: BookId, who: Scope = Depends(caller),
                      db: Session = Depends(get_db)):
    """Put a book the caller can see on their list: {"my_list": true}."""
    identity = _identity(who)
    row = _visible_book(db, who, book_id)
    try:
        book_personal.add_to_list(db, identity, row.id)
    except book_personal.Full as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return {"my_list": True}


@router.delete("/{book_id}/list", dependencies=[Depends(require_same_origin)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def remove_from_list(request: Request, book_id: BookId, identity: str = Depends(_owner),
                           db: Session = Depends(get_db)):
    """Take a book off the caller's list (not on it: nothing changes):
    {"my_list": false}."""
    book_personal.remove_from_list(db, identity, _ids_to_clear(db, book_id))
    return {"my_list": False}


# --- Up next ------------------------------------------------------------------------

@router.get("/me/queue")
@books._limit(READ_LIMIT, "me-queue")
@books._db_503
async def my_queue(request: Request, who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """The caller's queue in order, only the books they can see now:
    {"items": [BookCard + position]}, positions 0, 1, 2..."""
    _identity(who)
    return {"items": _queue_items(db, who)}


@router.put("/{book_id}/queue", dependencies=[Depends(require_same_origin)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def add_to_queue(request: Request, book_id: BookId, who: Scope = Depends(caller),
                       db: Session = Depends(get_db)):
    """Add a book the caller can see at the end of their queue (already
    queued: it stays where it is): {"queue_position"}."""
    identity = _identity(who)
    row = _visible_book(db, who, book_id)
    try:
        book_personal.enqueue(db, identity, row.id)
    except book_personal.Full as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    items = _queue_items(db, who)
    return {"queue_position": next((i["position"] for i in items if i["id"] == row.id), None)}


@router.delete("/{book_id}/queue", dependencies=[Depends(require_same_origin)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def remove_from_queue(request: Request, book_id: BookId, identity: str = Depends(_owner),
                            db: Session = Depends(get_db)):
    """Take a book out of the caller's queue: {"queue_position": null}."""
    book_personal.dequeue(db, identity, _ids_to_clear(db, book_id))
    return {"queue_position": None}


class MoveIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    book_id: StrictInt = Field(ge=1, le=MAX_ID)
    to: StrictInt = Field(ge=0, le=book_personal.QUEUE_MAX)


@router.post("/me/queue/move", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def move_in_queue(request: Request, body: MoveIn, who: Scope = Depends(caller),
                        db: Session = Depends(get_db)):
    """Move a queued book to place `to` among the books the caller can see
    (past the end: the end): the queue after the move, as GET /me/queue. 404
    when the book is not in their queue."""
    identity = _identity(who)
    live = _live_id(db, body.book_id)
    visible = _visible(db, who)
    if live not in visible or not book_personal.move(db, identity, live, body.to, visible):
        raise HTTPException(status_code=404, detail="That book is not in your Up next queue")
    return {"items": _queue_items(db, who)}


@router.get("/me/queue/next-audio")
@books._limit(READ_LIMIT, "me-next-audio")
@books._db_503
async def next_audio(request: Request,
                     after: Optional[str] = Query(None, min_length=1, max_length=listening.KEY_MAX),
                     who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """The first queued audiobook the caller can hear, other than the book
    `after` names (a catalog book id, or a Plex edition key as the player
    holds it): {"book": BookCard + position, "edition_key"} or {"book": null,
    "edition_key": null}. The edition is the one the book page would open.
    Nothing changes: the player takes the book out of the queue when it
    plays it."""
    identity = _identity(who)
    skip = None
    if after is not None:
        if _EDITION_KEY.fullmatch(after):
            found = book_catalog.live_editions(db, [after]).get(after)
            skip = found[0] if found else None
        elif _BOOK_ID.fullmatch(after) and 1 <= int(after) <= MAX_ID:
            skip = _live_id(db, int(after))
        else:
            raise HTTPException(status_code=422, detail="after is a book id or an edition key")
    nothing = {"book": None, "edition_key": None}
    if not who.audio:
        return nothing
    visible = _visible(db, who)
    shown = [b for b in book_personal.queue_ids(db, identity) if b in visible]
    for position, book_id in enumerate(shown):
        row = visible[book_id]
        if not row.audio or book_id == skip:
            continue
        book = db.get(Book, book_id)
        editions = book_catalog.editions_of(db, book)
        if not editions:
            continue
        places = listening.get_places(db, identity, keys=[e.plex_book_key for e in editions])
        return {"book": {**books._book_card(row), "position": position},
                "edition_key": books.preferred_edition(editions, places).plex_book_key}
    return nothing


# --- Ratings ------------------------------------------------------------------------

class RatingIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    stars: StrictInt = Field(ge=1, le=5)


@router.put("/{book_id}/rating", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def rate(request: Request, book_id: BookId, body: RatingIn, background: BackgroundTasks,
               who: Scope = Depends(caller), db: Session = Depends(get_db),
               user: dict = Depends(get_current_user),
               session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name)):
    """Rate a book the caller can see, 1 to 5 stars: {"my_rating"}. Saved at
    once; Kavita and Plex are written after the answer, as the caller, and a
    write that fails is tried again later (it never undoes the rating)."""
    identity = _identity(who)
    row = _visible_book(db, who, book_id)
    book_personal.set_rating(db, identity, row.id, body.stars)
    background.add_task(book_personal.push_rating, identity, row.id, dict(user), session_id)
    return {"my_rating": body.stars}


@router.delete("/{book_id}/rating", dependencies=[Depends(require_same_origin)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def clear_rating(request: Request, book_id: BookId, background: BackgroundTasks,
                       identity: str = Depends(_owner), db: Session = Depends(get_db),
                       user: dict = Depends(get_current_user),
                       session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name)):
    """Clear the caller's rating of a book, here at once and in Kavita and
    Plex after the answer: {"my_rating": null}."""
    for target in _ids_to_clear(db, book_id):
        if book_personal.set_rating(db, identity, target, None):
            background.add_task(book_personal.push_rating, identity, target, dict(user), session_id)
    return {"my_rating": None}


# --- Taken out of Continue ----------------------------------------------------------

class HideIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    # The card's updated_at as the Continue row sent it (ISO 8601); null for
    # a place with no time.
    updated_at: Optional[str] = Field(None, max_length=40)


def _activity_at(value: Optional[str]) -> Optional[datetime]:
    """updated_at as naive UTC, or None; 422 for anything else."""
    if value is None:
        return None
    try:
        at = datetime.fromisoformat(value.strip())
        if at.tzinfo is not None:
            # Year 1 or 9999 with an offset lands outside datetime's range.
            at = at.astimezone(timezone.utc).replace(tzinfo=None)
    except (ValueError, OverflowError):
        raise HTTPException(status_code=422, detail="updated_at is an ISO 8601 time") from None
    return at


@router.put("/{book_id}/continue-hidden", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def hide_from_continue(request: Request, book_id: BookId, body: HideIn, who: Scope = Depends(caller),
                             db: Session = Depends(get_db)):
    """Take a book the caller can see out of their Continue row, until they
    listen or read past `updated_at` (the activity the row showed):
    {"hidden": true}. Their place in the book is not touched."""
    identity = _identity(who)
    at = _activity_at(body.updated_at)
    row = _visible_book(db, who, book_id)
    book_personal.hide_from_continue(db, identity, row.id, at)
    return {"hidden": True}


@router.delete("/{book_id}/continue-hidden", dependencies=[Depends(require_same_origin)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def show_in_continue(request: Request, book_id: BookId, identity: str = Depends(_owner),
                           db: Session = Depends(get_db)):
    """Undo: the book is back in the caller's Continue row: {"hidden": false}."""
    book_personal.show_in_continue(db, identity, _ids_to_clear(db, book_id))
    return {"hidden": False}


# --- The audiobook notice -------------------------------------------------------------

class NoticeIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    # off: Don't show again. seen: an older copy of the page's Okay (changes nothing).
    state: Literal["seen", "off"]


@router.post("/me/notice", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@books._limit(WRITE_LIMIT, "me-write")
@books._db_503
async def answer_notice(request: Request, body: NoticeIn, identity: str = Depends(_owner),
                        db: Session = Depends(get_db)):
    """The caller's answer to the audiobook notice, kept for their account on
    every device: {"notice": "off"} after Don't show again (which no later
    answer undoes), {"notice": "window"} otherwise.
    The Books page reads it back from its own render (main.books_notice)."""
    return {"notice": book_personal.set_notice(db, identity, body.state)}
