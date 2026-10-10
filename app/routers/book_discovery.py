"""
Books discovery (/api/books/recent, /popular, /me/stats, /series/follow):
the shelves that help people notice what is new and what others enjoy, a
person's own listening stats, and series follows. The data is
app/services/book_discovery.py's; this module decides what the caller may see.

Every route needs a session (401). Shelves show only the books the caller can
see now (books.caller). Stats and follows are the caller's own and need an
account identity (403 without one). Every write checks same-origin. Nothing
here returns another person's identity, email or anything per person, and
popularity is only ever a rounded label at or above the floor. Errors are 4xx
or 503, never 500.
"""

import logging
import re
from datetime import timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.integrations import kavita
from app.routers import books
from app.routers.books import Scope, caller
from app.routers.player import Text, require_encodable_body, require_same_origin
from app.services import book_catalog
from app.services import book_discovery as discovery
from app.services import insights_store
from app.utils import identity_email

logger = logging.getLogger(__name__)

router = APIRouter()

READ_LIMIT = books.LIST_LIMIT
WRITE_LIMIT = "60/minute"

NO_IDENTITY = "This account cannot keep books of its own"
READING_NOT_CONNECTED = "Connect your ebook library to include reading"
_ZONE = re.compile(r"[A-Za-z0-9_+\-/]{1,64}", re.ASCII)


def _identity(who: Scope) -> str:
    if not who.identity:
        raise HTTPException(status_code=403, detail=NO_IDENTITY)
    return who.identity


def _visible(db: Session, who: Scope) -> list:
    return book_catalog.visible_rows(db, who.series, who.audio)


@router.get("/recent")
@books._limit(READ_LIMIT, "recent")
@books._db_503
async def recent(request: Request, who: Scope = Depends(caller), db: Session = Depends(get_db),
                 user: dict = Depends(get_current_user)):
    """Recently added: the newest books the caller can see added in the last
    30 days, at most 12, newest first: {"items": [BookCard + is_new]}.
    `is_new` is true for a book added since the caller's previous visit,
    never on a first one. This records the visit (a load of Books)."""
    prev = None
    if who.identity:
        prev = discovery.record_visit(db, who.identity, identity_email(user.get("email")))
    shelf = discovery.recent(_visible(db, who), discovery.format_dates(db), prev)
    return {"items": [{**books._book_card(row), "is_new": is_new} for row, is_new in shelf]}


@router.get("/popular")
@books._limit(READ_LIMIT, "popular")
@books._db_503
async def popular(request: Request, who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """Popular on the server: the books the caller can see that most
    different people listened to lately, at most 12: {"items": [BookCard +
    listeners_label]}. Never who, never an exact count, nothing under the
    floor; empty while nothing qualifies."""
    visible = {r.id: r for r in _visible(db, who)}
    items = [{**books._book_card(visible[book_id]), "listeners_label": discovery.listeners_label(count)}
             for book_id, count in discovery.popular(db)
             if book_id in visible and count >= discovery.POPULAR_MIN]
    return {"items": items[:discovery.POPULAR_MAX]}


def _zone(tz: Optional[str]):
    """The caller's time zone (an IANA name from the browser), or UTC for
    none or one that is not known."""
    if not tz or not _ZONE.fullmatch(tz):
        return timezone.utc
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


@router.get("/me/stats")
@books._limit(READ_LIMIT, "me-stats")
@books._db_503
async def my_stats(request: Request, tz: Optional[str] = Query(None, max_length=64),
                   who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """The caller's own listening and reading: {listened_ms_6mo,
    listened_ms_all, finished, streak_days, weekly: [{week, ms}] (12 weeks,
    oldest first, each its Monday), top_authors: [{name, ms}], reading:
    {pages, words, hours} or null, notes}. `tz` (an IANA zone) sets the days
    and weeks; UTC otherwise. Reading comes from Kavita through the caller's
    own link and is null without one (a note says how to add it)."""
    identity = _identity(who)
    body = discovery.stats(db, identity, _zone(tz))
    notes = []
    reading = None
    if who.kavita:
        try:
            reading = await kavita.reading_stats(*who.kavita)
            insights_store.best_effort(db, "reading totals", insights_store.record_reading_totals, identity, reading)
        except kavita.KavitaTokenRefused:
            notes.append(books._note("kavita", "not_connected", READING_NOT_CONNECTED))
        except kavita.KavitaUnavailable:
            notes.append(books._note("kavita", "unavailable", books.EBOOKS_DOWN))
    for note in who.notes:
        if note["source"] == "kavita":
            notes.append(books._note("kavita", note["reason"], READING_NOT_CONNECTED
                                     if note["reason"] == "not_connected" else note["text"]))
    return {**body, "reading": reading, "notes": notes}


class FollowIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    series: Text = Field(min_length=1, max_length=books.NAME_MAX)


def _series_key(body: FollowIn) -> str:
    key = discovery.series_key(body.series)
    if not key:
        raise HTTPException(status_code=422, detail="Give a series name")
    return key


@router.put("/series/follow", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@books._limit(WRITE_LIMIT, "follow")
@books._db_503
async def follow(request: Request, body: FollowIn, who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """Follow a series the caller can see: {"following": true}. 404 when they
    can see none of its books."""
    identity = _identity(who)
    key = _series_key(body)
    if not any(discovery.series_key(r.series) == key for r in _visible(db, who)):
        raise HTTPException(status_code=404, detail="No series by that name in the library")
    discovery.set_follow(db, identity, key, discovery.MANUAL)
    return {"following": True}


@router.delete("/series/follow", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@books._limit(WRITE_LIMIT, "follow")
@books._db_503
async def unfollow(request: Request, body: FollowIn, who: Scope = Depends(caller), db: Session = Depends(get_db)):
    """Stop following a series, whatever made the caller follow it (their
    list and their listening no longer do): {"following": false}."""
    identity = _identity(who)
    discovery.set_follow(db, identity, _series_key(body), discovery.OFF)
    return {"following": False}
