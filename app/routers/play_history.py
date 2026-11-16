"""
Play history (/api/me/history): the caller's own listening and reading
sessions, newest first, for the Play history window in the shell.

Needs a session (401 without one). Everything is the caller's own: the
listening log by their account identity (tickets.account_identity, never the
username), reading sessions from Kavita with their own token. Only books the
caller may see are listed (books.scope_of, the Books pages' rule: an
audiobook through the player's own access check, an ebook in a Kavita
library their account reaches). A source that cannot be read leaves its
sessions out and adds a note, as the Continue row does; 503 only when
nothing asked for could be read. Errors are 4xx or 503, never 500.

Rate limited per session, as the player's routes are, and per address.
Nothing is cached in the module (two uvicorn workers); the books' contents,
for the chapter numbers, are cached in Redis (kavita.chapter_numbers_at).
"""

import asyncio
import calendar
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.integrations import kavita
from app.limiter import limiter
from app.routers.books import Scope, scope_of
from app.routers.player import session_rate_key
from app.services import book_catalog
from app.services import play_history as ph
from app.utils import utc_iso

logger = logging.getLogger(__name__)

router = APIRouter()

HISTORY_LIMIT = "60/minute"
# Per address as well: a member with several sign-ins has a budget per
# session, and each call can ask Kavita for every shown book's contents.
HISTORY_ADDRESS_LIMIT = "60/minute"
UNREADABLE = "Your history couldn't be read right now. Try again in a moment."


def _cover_url(row) -> str:
    stamp = calendar.timegm(row.updated_at.utctimetuple()) if row.updated_at else 0
    return f"/api/books/{row.id}/cover?v={stamp}"


def _book_fields(row) -> dict:
    return {"book_id": row.id, "title": row.title, "author": row.author, "cover_url": _cover_url(row),
            "book_url": f"/books/{row.id}"}


def _audio_item(s: ph.AudioSession, row) -> dict:
    return {"kind": "audio", "id": f"a{s.end_id}", **_book_fields(row), "plex_book_key": s.book_key,
            "start": utc_iso(s.start_at), "end": utc_iso(s.end_at), "listened_ms": s.listened_ms,
            "device": s.device, "chapter_label": s.chapter_label, "from_ms": s.start_book_ms,
            "to_ms": s.end_book_ms, "duration_ms": s.duration_ms,
            "place": {"track": s.end_track, "offset_ms": s.end_offset_ms}}


def _ebook_item(s: ph.EbookSession, row, chapter: Optional[int]) -> dict:
    # Kavita counts an EPUB's pages from 0, and the reader shows page + 1, as
    # this does; a PDF's it counts from 1 (its own PDF reader saves the page it
    # shows), so those are the reader's numbers already.
    pages = s.pages if s.pages > 0 else None
    end = max(s.end_page, 1) if s.pdf else s.end_page + 1
    start = max(s.start_page, 1) if s.pdf else s.start_page + 1
    last = min(end, pages) if pages else end
    first = min(start, last)
    return {"kind": "ebook", "id": f"e{s.session_id}.{s.chapter_id}", **_book_fields(row),
            "start": utc_iso(s.start), "end": utc_iso(s.end), "read_ms": s.seconds * 1000,
            "chapter": chapter, "start_page": first, "end_page": last, "pages": pages,
            "read_url": f"/reader?seriesId={row.kavita_series_id}&chapterId={row.kavita_chapter_id}&page={last}"}


async def _caller(user: dict = Depends(get_current_user),
                  session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name)) -> Scope:
    try:
        return await scope_of(user, session_id)
    except SQLAlchemyError as exc:
        logger.warning("Play history: settings could not be read: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail=UNREADABLE) from None


@router.get("/history")
@limiter.shared_limit(HISTORY_LIMIT, scope="me:history", key_func=session_rate_key)
@limiter.limit(HISTORY_ADDRESS_LIMIT)
async def history(request: Request,
                  kind: str = Query("all", pattern="^(all|audio|ebook)$"),
                  before: Optional[str] = Query(None, max_length=64),
                  limit: int = Query(ph.PAGE_DEFAULT, ge=1, le=ph.PAGE_MAX),
                  who: Scope = Depends(_caller), db: Session = Depends(get_db)):
    """One page of the caller's sessions, newest end first:
    {"items": [...], "next_before": cursor or null, "notes": [...]}.

    An audiobook item: {kind "audio", id, book_id, title, author, cover_url,
    book_url, plex_book_key, start, end (ISO UTC), listened_ms, device,
    chapter_label (where it ended), from_ms, to_ms (book time at its start
    and end, null when not saved), duration_ms, place {track, offset_ms}
    (where it ended, for the player)}. An ebook item: {kind "ebook", id,
    book_id, title, author, cover_url, book_url, start, end, read_ms,
    chapter (the book's own chapter number where it ended, or null),
    start_page, end_page (as the reader numbers them, from 1), pages (or
    null), read_url (the reader at end_page)}.

    Pass next_before back as `before` for the next page; null means there
    is nothing more in the last 180 days."""
    try:
        cursor = ph.parse_cursor(before) if before is not None else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    try:
        rows = {r.id: r for r in book_catalog.visible_rows(db, who.series, who.audio)}
    except SQLAlchemyError as exc:
        logger.warning("Play history: the catalog could not be read: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail=UNREADABLE) from None
    notes = [n for n in who.notes if (kind != "ebook" or n["source"] == "kavita")
             and (kind != "audio" or n["source"] == "plex")]
    failed = {n["source"] for n in notes if n["reason"] == "unavailable"}

    by_key = {}
    if kind in ("all", "audio") and who.audio and who.identity:
        try:
            by_key = {key: rows[book_id] for key, (book_id, _n) in book_catalog.live_editions(db).items()
                      if book_id in rows and rows[book_id].audio}
        except SQLAlchemyError as exc:
            logger.warning("Play history: the catalog could not be read: %s", type(exc).__name__)
            raise HTTPException(status_code=503, detail=UNREADABLE) from None
    chapters = {}
    if kind in ("all", "ebook") and who.kavita:
        chapters = {r.kavita_chapter_id: r for r in rows.values() if r.ebook and r.kavita_chapter_id is not None}
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=ph.DAYS)
    kavita_note = None

    async def one_page(at):
        """(the merged page after cursor `at`, Kavita's note or None)."""
        audio, audio_more = [], False
        if by_key:
            try:
                audio, audio_more = ph.audio_sessions(db, who.identity, set(by_key), at, limit)
            except SQLAlchemyError as exc:
                logger.warning("Play history: the listening log could not be read: %s", type(exc).__name__)
                raise HTTPException(status_code=503, detail=UNREADABLE) from None
        ebooks, ebook_more, resume, note = [], False, None, None
        if kind in ("all", "ebook") and who.kavita:
            base, token = who.kavita
            try:
                found, complete = await kavita.reading_sessions(base, token, since, at[0] if at else None,
                                                                enough=limit + 1)
                ebooks, ebook_more, resume = ph.ebook_page(found, chapters, at, limit, complete)
            except kavita.KavitaTokenRefused:
                note = {"source": "kavita", "reason": "not_connected",
                        "text": "Connect to your ebook library to see your reading"}
            except kavita.KavitaUnavailable:
                note = {"source": "kavita", "reason": "unavailable", "text": "Ebooks are unavailable right now"}
        return ph.merge(audio, audio_more, ebooks, ebook_more, limit, resume), note

    # A page can come back empty with more to read: Kavita's newest sessions
    # all in chapters the caller can't see (another chapter of a numbered
    # volume, a book not in the catalog). The next stretch is read here, a few
    # times at most, rather than handing the window an empty page.
    at = cursor
    for _hop in range(ph.EMPTY_HOPS):
        page, kavita_note = await one_page(at)
        if page.items or not page.next_key or kavita_note:
            break
        at = page.next_key
    if kavita_note:
        notes.append(kavita_note)
        if kavita_note["reason"] == "unavailable":
            failed.add("kavita")

    numbers = {}
    shown = [s for s in page.items if isinstance(s, ph.EbookSession)]
    if shown and who.kavita:
        base, token = who.kavita
        # The book's own chapter number, from its contents: only for what is
        # shown, and each chapter's contents read once however many of its
        # sessions are on the page.
        by_chapter: dict = {}
        for s in shown:
            by_chapter.setdefault(s.chapter_id, []).append(s)
        found = await asyncio.gather(*(kavita.chapter_numbers_at(base, token, chapter_id,
                                                                 [s.end_page for s in sessions])
                                       for chapter_id, sessions in by_chapter.items()))
        numbers = {(s.session_id, s.chapter_id): n
                   for sessions, ns in zip(by_chapter.values(), found) for s, n in zip(sessions, ns)}

    wanted = {"all": {"plex", "kavita"}, "audio": {"plex"}, "ebook": {"kavita"}}[kind]
    if not page.items and failed and wanted <= failed | _absent(who):
        raise HTTPException(status_code=503, detail=UNREADABLE)

    items = []
    for s in page.items:
        if isinstance(s, ph.AudioSession):
            items.append(_audio_item(s, by_key[s.book_key]))
        else:
            items.append(_ebook_item(s, chapters[s.chapter_id], numbers.get((s.session_id, s.chapter_id))))
    return {"items": items, "next_before": ph.make_cursor(page.next_key) if page.next_key else None,
            "notes": notes}


def _absent(who: Scope) -> set:
    """The sources this caller has no way into at all (not a failure): no
    audiobooks for them, or no Kavita link."""
    out = set()
    if not who.audio and not any(n["source"] == "plex" for n in who.notes):
        out.add("plex")
    if not who.kavita and not any(n["source"] == "kavita" for n in who.notes):
        out.add("kavita")
    return out
