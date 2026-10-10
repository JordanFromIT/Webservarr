"""
Insights (/api/admin/insights): reading and listening across everyone, for
the admin only (docs/superpowers/specs/2026-10-10-insights-design.md,
section 6). Every route depends on require_admin: 401 signed out, 403 for a
member, like the rest of /api/admin (app/tests/test_settings_gate.py sweeps
them). Every route only reads.

Plex being down never fails a route: the answer lists it under
"unavailable" and carries what WebServarr's own records say, and such an
answer is never cached. No route calls Kavita: after a failed nightly sweep
(services/insights_kavita) answers list "kavita" until one works. A database that cannot be read is 503. People are
keyed by utils.identity_key; an identity never leaves the server.
"""
import functools
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import session_manager
from app.database import get_db
from app.dependencies import require_admin
from app.limiter import limiter
from app.routers.book_discovery import _zone
from app.services import insights, insights_kavita

logger = logging.getLogger(__name__)

router = APIRouter()

LIMIT = "60/minute"
DB_DOWN = "Insights can't be read right now. Try again in a moment."
NOT_HERE = "That person or book isn't here any more."
KEY_PATTERN = r"^[0-9a-f]{24}$"
Period = Literal["30d", "90d", "1y", "all"]


def _db_503(route):
    """503, not 500, when the database cannot be read. Innermost decorator,
    so the limiter and FastAPI still see the route's own signature."""
    @functools.wraps(route)
    async def guarded(*args, **kwargs):
        try:
            return await route(*args, **kwargs)
        except SQLAlchemyError as exc:
            logger.warning("Insights could not read the database: %s", type(exc).__name__)
            raise HTTPException(status_code=503, detail=DB_DOWN) from None
    return guarded


async def _redis():
    """The shared Redis, or None while it can't be reached (the caches are then skipped)."""
    try:
        return await session_manager.get_redis()
    except (RedisError, OSError) as exc:
        logger.info("Insights cache unavailable: %s", type(exc).__name__)
        return None


async def _sources(db: Session, r, since=None) -> insights.Sources:
    """What an answer is worked out from. Web listening is read from a day
    before `since`, so the echo rule sees the hours just before the period."""
    owner, names = await insights.plex_people(r)
    plays = await insights.plex_plays(r, owner)
    web = insights.listens(db, None if since is None else since - insights.ECHO_DAY)
    unavailable = ([] if plays is not None else ["plex"]) + (["kavita"] if insights_kavita.last_error(db) else [])
    return insights.Sources(listens=web, plays=None if plays is None else insights.app_plays(plays, web),
                            names=names, now=insights.now_utc(), unavailable=unavailable)


async def _answer(r, key: str, build) -> dict:
    """The kept answer for `key` (ANSWER_TTL), else build() it. An answer
    with a source unavailable is never kept, so the next load asks again."""
    hit = await insights.cache_get(r, "answer:" + key)
    if hit is not None:
        return hit
    body = await build()
    if not body.get("unavailable"):
        await insights.cache_set(r, "answer:" + key, body, insights.ANSWER_TTL)
    return body


@router.get("/now")
@limiter.limit(LIMIT)
@_db_503
async def now(request: Request, _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """Who is listening or reading right now (spec section 7): {"listening",
    "reading", "unavailable", "checked_at"}. Not kept: the page asks every 30 s."""
    r = await _redis()
    _owner, names = await insights.plex_people(r)
    return insights.now_view(db, names, insights.now_utc())


@router.get("/people")
@limiter.limit(LIMIT)
@_db_503
async def people(request: Request, _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """Everyone, most recently active first (spec section 7, People)."""
    r = await _redis()

    async def build():
        return insights.people_view(db, await _sources(db, r))
    return await _answer(r, "people", build)


@router.get("/person")
@limiter.limit(LIMIT)
@_db_503
async def person(request: Request, key: str = Query(..., pattern=KEY_PATTERN),
                 tz: Optional[str] = Query(None, max_length=64),
                 _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """One person's history (spec section 7, People); 404 for a key that is no one's."""
    zone = _zone(tz)
    r = await _redis()

    async def build():
        src = await _sources(db, r)
        identity = insights.identity_for(db, src, key)
        if identity is None:
            raise HTTPException(status_code=404, detail=NOT_HERE)
        return insights.person_view(db, src, identity, zone)
    return await _answer(r, f"person:{key}:{zone}", build)


TZ_MAX = 64


@router.get("/trends")
@limiter.limit(LIMIT)
@_db_503
async def trends(request: Request, period: Period = "90d", tz: Optional[str] = Query(None, max_length=TZ_MAX),
                 _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """Listening and reading over the period, active people per week, the top books, authors and series."""
    zone = _zone(tz)
    r = await _redis()

    async def build():
        src = await _sources(db, r, insights.since_of(period, insights.now_utc()))
        return insights.trends_view(db, src, period, zone)
    return await _answer(r, f"trends:{period}:{zone}", build)


@router.get("/books")
@limiter.limit(LIMIT)
@_db_503
async def books(request: Request, period: Period = "90d",
                _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """Abandoned, never opened, and finish rate with the drop-off chapter."""
    r = await _redis()

    async def build():
        return insights.books_view(db, await _sources(db, r), period)
    return await _answer(r, f"books:{period}", build)


@router.get("/book/{book_id}")
@limiter.limit(LIMIT)
@_db_503
async def book(request: Request, book_id: int = Path(..., ge=1, le=2_147_483_647),
               _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """One book, everyone in it; 404 for an id that is no book's."""
    r = await _redis()

    async def build():
        body = insights.book_view(db, await _sources(db, r), book_id)
        if body is None:
            raise HTTPException(status_code=404, detail=NOT_HERE)
        return body
    return await _answer(r, f"book:{book_id}", build)


@router.get("/habits")
@limiter.limit(LIMIT)
@_db_503
async def habits(request: Request, period: Period = "90d", tz: Optional[str] = Query(None, max_length=TZ_MAX),
                 _admin: dict = Depends(require_admin), db: Session = Depends(get_db)):
    """The web and Plex split, the time-of-day heatmap and requested then read."""
    zone = _zone(tz)
    r = await _redis()

    async def build():
        src = await _sources(db, r, insights.since_of(period, insights.now_utc()))
        return insights.habits_view(db, src, period, zone)
    return await _answer(r, f"habits:{period}:{zone}", build)
