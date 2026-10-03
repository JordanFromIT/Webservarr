"""
The audiobook player's API (/api/player).

Every route needs a session with a Plex identity (tickets.account_identity
"plex:<id>"): 401 without a session, 403 for a local or Authentik-only
account, and 404 on every route while the player is off (no audiobook
library configured). Book and track keys are checked as belonging to the
audiobook library before anything is read or stored (404 otherwise); Plex
being unreachable is 503. Positions, the log and preferences are read and
written by the session's identity only, never by anything in the request.

Rate limits are per session (a hash of the session cookie; the client IP
when there is none), not per IP: a family listens from one home address
behind Cloudflare, and a 429 on a check-in would show the listener "not
saved".

Check-ins also come from navigator.sendBeacon on a hard exit, which cannot
set headers. The app has no CSRF token or custom-header rule (the session
cookie is SameSite=Lax), so the state-changing routes check that the request
comes from this site's own origin (Origin, or Referer when a browser sends
no Origin) instead: a Lax cookie still rides along from another subdomain of
the same site.
"""

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Literal, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, BackgroundTasks, Body, Cookie, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, Response
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictInt, model_validator
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.integrations import plex_player as pp
from app.limiter import _get_client_ip, limiter
from app.routers.tickets import account_identity
from app.services import listening
from app.utils import utc_iso

logger = logging.getLogger(__name__)

router = APIRouter()

PLAYER_LIMIT = "60/minute"
CHECKIN_LIMIT = "60/minute"
COVER_LIMIT = "240/minute"


def _limit(rate: str, route: str):
    """One budget per session for the route, whatever book key the URL
    carries. The app limiter keys by URL path, so a plain limit would give
    every /position/<key> a fresh budget of its own."""
    return limiter.shared_limit(rate, scope=f"player:{route}", key_func=session_rate_key)

# Cover URLs carry the thumbnail's version stamp, so a changed cover gets a
# new URL and the old one can be kept a long time.
COVER_MAX_AGE = 30 * 24 * 60 * 60

# Check-in events as Plex timeline states. A leave is paused, not stopped:
# the page is going away or hidden, the listener has not finished, and Plex
# ends a paused session by itself. Only the end of the book stops it.
EVENT_STATES = {
    "play": "playing", "checkin": "playing", "seek": "playing", "jump": "playing",
    "pause": "paused", "leave": "paused",
    "end": "stopped",
}

# --- Text the database can store --------------------------------------------------

# How deep a request body may nest. The player's bodies are flat; this only
# bounds the walk below, which a crafted body could otherwise drive into
# Python's recursion limit.
MAX_DEPTH = 32


def _text_ok(value: str) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _body_problem(value) -> Optional[str]:
    """Why a parsed JSON body cannot be taken, or None: "text" for a string
    (key or value) holding a lone surrogate ("\\ud800" in JSON), which UTF-8
    and so the database cannot store; "depth" for lists and objects nested
    deeper than MAX_DEPTH. Walked with an explicit stack, not recursion."""
    stack = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, str):
            if not _text_ok(item):
                return "text"
        elif isinstance(item, (dict, list)):
            if depth >= MAX_DEPTH:
                return "depth"
            if isinstance(item, dict):
                for k, v in item.items():
                    if not _text_ok(k):
                        return "text"
                    stack.append((v, depth + 1))
            else:
                stack.extend((v, depth + 1) for v in item)
    return None


def _utf8(value: str) -> str:
    if not _text_ok(value):
        raise ValueError("must be valid Unicode text")
    return value


Text = Annotated[str, AfterValidator(_utf8)]

_BODY_ERRORS = {
    "text": "The request holds text that is not valid Unicode",
    "depth": "The request is nested too deeply",
}


async def require_encodable_body(request: Request) -> None:
    """422 when the JSON body holds text that is not valid Unicode or nests
    deeper than MAX_DEPTH, before the body is validated. FastAPI's own 422
    echoes the offending input, and a lone surrogate cannot be encoded into
    that response (a 500); nothing here echoes it."""
    try:
        data = await request.json()
    except ValueError:
        return          # not JSON: body validation answers 422 itself
    except RecursionError:
        raise HTTPException(status_code=422, detail=_BODY_ERRORS["depth"]) from None
    try:
        problem = _body_problem(data)
    except RecursionError:  # the walk has no recursion; a backstop all the same
        problem = "depth"
    if problem:
        raise HTTPException(status_code=422, detail=_BODY_ERRORS[problem])


# Upper bounds that only refuse nonsense (a week of audio; JavaScript's
# largest exact integer for seq).
MAX_MS = 7 * 24 * 60 * 60 * 1000
MAX_SEQ = 2 ** 53 - 1

NO_ACCESS = "Your account doesn't have access to the audiobook library"
NEEDS_PLEX = "The audiobook player needs a Plex account"


# --- Rate-limit key and same-origin check ------------------------------------------

def session_rate_key(request: Request) -> str:
    """The rate-limit key: this session (a hash of its cookie, so the cookie
    itself never reaches Redis as a key), else the client IP."""
    sid = request.cookies.get(settings.session_cookie_name)
    if sid:
        return "player-session:" + hashlib.sha256(sid.encode("utf-8", "replace")).hexdigest()[:32]
    return _get_client_ip(request)


_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(value: Optional[str]) -> str:
    """scheme://host[:port] of a URL or origin, lower-cased with the default
    port dropped, or "" when it is not an http(s) URL."""
    try:
        parts = urlsplit((value or "").strip())
        port = parts.port
    except ValueError:
        return ""
    scheme, host = parts.scheme.lower(), (parts.hostname or "").lower()
    if scheme not in _DEFAULT_PORTS or not host:
        return ""
    if ":" in host:
        host = f"[{host}]"
    return f"{scheme}://{host}" if port in (None, _DEFAULT_PORTS[scheme]) else f"{scheme}://{host}:{port}"


def require_same_origin(request: Request) -> None:
    """403 unless the request comes from this site: its Origin (or, when the
    browser sends none, its Referer) is the configured app URL or this
    request's own host. Browsers send Origin on every POST and PUT, including
    sendBeacon; an opaque origin ("null") is refused."""
    sent = request.headers.get("origin")
    if sent is None:
        sent = request.headers.get("referer")
    got = _origin(sent)
    allowed = {_origin(settings.app_url)}
    host = request.headers.get("host")
    if host:
        allowed.add(_origin(f"{settings.app_scheme}://{host}"))
    allowed.discard("")
    if not got or got not in allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-origin request refused")


# --- The listener -------------------------------------------------------------------

@dataclass
class Listener:
    user: dict
    identity: str
    session_id: Optional[str]

    def session(self) -> dict:
        """A copy of the session for the bridge, which may cache into it."""
        return dict(self.user)


async def listener(
    user: dict = Depends(get_current_user),
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name),
) -> Listener:
    """The signed-in listener: 404 while the player is off, 403 without a Plex identity."""
    if not pp.player_on():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="The audiobook player is off")
    identity = account_identity(user)
    if not identity.startswith("plex:"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NEEDS_PLEX)
    return Listener(user=user, identity=identity, session_id=session_id)


def _http_error(exc: Exception, forbid: bool = False) -> HTTPException:
    """The HTTP error for a bridge exception. `forbid`: the listener's own
    lack of access to the server or library is theirs (403), not an outage."""
    if isinstance(exc, pp.PlayerOff):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="The audiobook player is off")
    if isinstance(exc, pp.NotInLibrary):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not in the audiobook library")
    if forbid and isinstance(exc, pp.NoServerAccess):
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NO_ACCESS)
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                         detail="Plex is unavailable right now. Try again in a moment.")


def _cover_url(key: str, thumb) -> str:
    version = pp.cover_version(thumb)
    return f"/api/player/cover/{key}?v={version}" if version else ""


# --- Library ------------------------------------------------------------------------
#
# Every route that reads the library needs the listener's own access to it
# (library_access), as /books does: a share that leaves the audiobook library
# out gets 403 everywhere, not only on the list. A book key is checked before
# any access or refresh work, so a bad key costs no plex.tv call.

async def _checked_book(who: "Listener", key: str, force: bool = False) -> tuple:
    """The key checked as a book in the library, then the listener's access to
    the library: (the album's metadata that check read, their stream access).
    Raises the HTTP error."""
    try:
        album = await pp.assert_in_library(key)
        return album, await pp.library_access(who.session(), session_id=who.session_id, force=force)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc, forbid=True) from None


async def _book_access(who: "Listener", key: str, force: bool = False) -> dict:
    """_checked_book's stream access alone."""
    return (await _checked_book(who, key, force=force))[1]


@router.get("/books")
@_limit(PLAYER_LIMIT, "books")
async def books(request: Request, who: Listener = Depends(listener)):
    """The audiobook library's books, for a listener who may read it."""
    try:
        await pp.library_access(who.session(), session_id=who.session_id)
        found = await pp.list_books()
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc, forbid=True) from None
    return {"books": [{**b, "cover": _cover_url(b["key"], b.get("cover"))} for b in found]}


@router.get("/book/{key}")
@_limit(PLAYER_LIMIT, "book")
async def book(request: Request, key: str, refresh: bool = False, who: Listener = Depends(listener)):
    """One book's tracks and chapters, plus this listener's stream access:
    their own server token and the server's connection URIs. `refresh`
    asks plex.tv again (after the stream refused the cached token)."""
    access = await _book_access(who, key, force=refresh)
    try:
        detail = await pp.book_detail(key)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc) from None
    body = {**detail, "cover": _cover_url(key, detail.get("cover")),
            "stream": {"token": access["token"], "uris": access["uris"]}}
    # It carries the listener's server token: never stored by a cache.
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/cover/{key}")
@_limit(COVER_LIMIT, "cover")
async def cover(request: Request, key: str, who: Listener = Depends(listener)):
    """The book's cover, fitted to a square, served from this origin (img-src
    stays as it is)."""
    await _book_access(who, key)
    try:
        content, content_type = await pp.cover_image(key)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc) from None
    return Response(content=content, media_type=content_type, headers={
        "Cache-Control": f"private, max-age={COVER_MAX_AGE}",
        # Loaded as a document rather than an <img>, it can run nothing.
        "Content-Security-Policy": "sandbox",
    })


# --- Positions and history ----------------------------------------------------------
#
# A book re-added as a new Plex album (spec 2.5 s4) has a new key, so the
# listener has no row for it. Their place in the earlier copy is found by
# work key and handed back instead, marked linked_from, but only when that
# copy's album is gone from the library: two editions side by side (two
# narrators of one title) share a work key and must never share a place.
# For the same reason a place already carried into a copy still in the
# library (A became B, B is there) is never offered to a third (C, beside B),
# nor one B has claimed while Plex couldn't yet confirm it (a pending claim,
# spec 2.6 s4). The claims table lets only one book hold an earlier copy.
#
# The lookup either completes or answers 503 (the player's Retry, which never
# falls back to 0:00): a lookup that gave up on a Plex error would open the
# book at the start, the first save would create a row for it, and the link
# would be lost for good.

PLEX_DOWN = "Plex is unavailable right now. Try again in a moment."


async def _album_gone(key: str) -> Optional[bool]:
    """True when assert_in_library no longer finds the book's album
    (NotInLibrary), False while it is there, None when Plex can't say (or
    the player went off meanwhile)."""
    try:
        await pp.assert_in_library(key)
    except pp.PlayerOff:
        return None
    except pp.NotInLibrary:
        return True
    except pp.PlayerUnavailable as exc:
        logger.info("Earlier-copy check unavailable: %s", type(exc).__name__)
        return None
    return False


def _lookup_failed() -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=PLEX_DOWN)


async def _carried_forward(db: Session, who: "Listener", key: str, requesting: str,
                           known: dict) -> Optional[bool]:
    """True when the listener's place in the earlier copy `key` already
    lives on in a copy still in the library: a row of theirs whose
    linked_from is `key` or that holds a pending claim on it (or, link by
    link, up to listening.LINK_HOPS deep, one of that row's own successors)
    under a book whose album is still there, other than `requesting`. A
    pending claim blocks as a verified one does (spec 2.6 s4). That place
    is that copy's: offering it to `requesting` as well would merge two
    editions side by side (spec 2.5 s2). A copy that carried it forward
    and is gone itself doesn't count (A became B, B went too: a new C may
    inherit, through B).

    False when no such copy is there, None when Plex can't say. The
    database is asked first (listening.successors), so a copy nothing
    carried forward costs no Plex read; at most LINK_HOPS album checks in
    all, and a chain going on past them counts as carried forward (the
    place is withheld rather than merged unchecked). `known` holds the
    album checks this request already made (key -> _album_gone's answer)."""
    seen = {key, requesting}
    frontier, checks = [key], 0
    for _hop in range(listening.LINK_HOPS):
        gone_too = []
        for earlier in frontier:
            for later in listening.successors(db, who.identity, earlier, exclude=seen):
                seen.add(later)
                if later not in known:
                    if checks >= listening.LINK_HOPS:
                        return True
                    checks += 1
                    known[later] = await _album_gone(later)
                if known[later] is None:
                    return None
                if not known[later]:
                    return True             # still in the library: the place is its
                gone_too.append(later)
        if not gone_too:
            return False
        frontier = gone_too
    return any(listening.successors(db, who.identity, k, exclude=seen) for k in frontier)


async def _earlier_copy(db: Session, who: "Listener", key: str, album: Optional[dict] = None):
    """This listener's position row in an earlier copy of the book, or None.

    Only for a listener with no row of their own for `key` (the caller
    checks), and only a copy whose album assert_in_library no longer finds
    (NotInLibrary) and whose place no copy still in the library carried
    forward (_carried_forward). A copy still in the library, or carried
    into one that is, is passed over for the next newest, at most
    listening.LINK_TRIES of them.

    The database is asked first, so a listener with no candidate costs no
    Plex read. For disc 1 the book's exact key is known from `album` alone
    when the album holds one book (plex_player.album_work_key): only a row
    with that key is a candidate. The tracks are read (for the key an album
    of several books gives each disc) only when there is a candidate, or,
    for a later disc, when the listener has any work-keyed row under another
    key. `album` is the album's metadata the request already read.

    Raises 503 when Plex fails before the lookup can finish, and the HTTP
    error for the book itself being gone."""
    _album_key, disc = pp.parse_key(key)
    album_key = pp.album_work_key(album) if (album and disc == 1) else None
    if album_key is not None:
        if listening.find_linked(db, who.identity, album_key, key) is None:
            return None
    elif not listening.has_work_keys(db, who.identity, key):
        return None
    try:
        about = await pp.book_identity(key, album=album)
    except pp.PlayerUnavailable as exc:
        logger.info("No work key for the earlier-copy lookup: %s", type(exc).__name__)
        raise _lookup_failed() from None
    except pp.NotInLibrary as exc:
        raise _http_error(exc) from None
    skip, known = [], {}
    for _attempt in range(listening.LINK_TRIES):
        row = listening.find_linked(db, who.identity, about.get("work_key"), key, skip=skip)
        if row is None:
            return None
        gone = known[row.book_key] if row.book_key in known else await _album_gone(row.book_key)
        known[row.book_key] = gone
        if gone is None:
            raise _lookup_failed()
        if gone:
            carried = await _carried_forward(db, who, row.book_key, key, known)
            if carried is None:
                raise _lookup_failed()
            if not carried:
                return row      # that copy's album is gone and its place lives nowhere else: this is the book it became
        skip.append(row.book_key)   # still in the library, or carried into a copy that is: an edition side by side
    return None


@router.get("/position/{key}")
@_limit(PLAYER_LIMIT, "position")
async def position(request: Request, key: str, who: Listener = Depends(listener),
                   db: Session = Depends(get_db)):
    """This listener's place in the book: WebServarr's, and Plex's own as a
    book position, each with its timestamp (null when there is none).

    Plex's is best effort: once the listener's access is confirmed, a failure
    reading their Plex state (a refused token, plex.tv down) makes it null,
    and WebServarr's still resumes the book. Such a failure (including a
    404 or an unreadable shape for the listener's own state) also adds
    `plex_error: true`, so a null that means "Plex could not be read" is
    never taken for "Plex holds no place" (the player's re-read before a
    late answer to a Plex app's question).

    Plex's copy is null too when it is an echo: a place this listener's own
    log has, logged within 30 s of Plex's timestamp for it
    (listening.is_logged_place). Plex stamps a part again when it
    ends a session our save started, so such a copy looks newer than our
    later saves while holding an older place; only a place we never logged
    (listening in Plexamp or a Plex app) competes on its time.

    `now` is the server's clock (ISO UTC) as it answers: the player measures
    its own clock against it before it compares these copies with its local
    one, which it stamps in the server's time. WebServarr's copy carries the
    psid of the page session that saved it, so a page re-checking before a
    late Play can tell its own saves from another tab's or device's.

    With no row of the listener's own for `key`, `web` may be their place in
    an earlier copy of the book, with `linked_from` its book key (see
    _earlier_copy); the player then helps them find the spot in this copy,
    and sends linked_from with its saves until a check-in answers
    "linked" true or false. Its `book_title` and `narrator` name that copy
    as the library showed it when it was saved (null when not known), so
    the helper can say which copy the place came from. 503 when Plex fails
    before that lookup can finish (never a null that would open the book
    at 0:00)."""
    album, _access = await _checked_book(who, key)
    plex_error = False
    try:
        plex_pos = await pp.plex_position(who.session(), key, session_id=who.session_id, strict=True)
    except pp.NotInLibrary as exc:
        raise _http_error(exc) from None
    except pp.PlayerUnavailable as exc:
        logger.info("Plex position unavailable: %s", type(exc).__name__)
        plex_pos = None
        plex_error = True
    if plex_pos and listening.is_logged_place(db, who.identity, key, plex_pos.get("track"),
                                              plex_pos.get("offset_ms"), plex_pos.get("updated_at")):
        plex_pos = None
    # Read after the echo check, so a save landing meanwhile is in `web` (the
    # newer copy) rather than only in the log the check just read.
    web = listening.get_position(db, who.identity, key)
    if web is None:
        row = await _earlier_copy(db, who, key, album=album)
        if row is not None:
            web = {**listening.position_dict(row), "linked_from": row.book_key}
    body = {"web": web, "plex": plex_pos, "now": utc_iso(datetime.now(timezone.utc))}
    if plex_error:
        body["plex_error"] = True
    return body


@router.get("/history/{key}")
@_limit(PLAYER_LIMIT, "history")
async def history(request: Request, key: str,
                  before: Optional[str] = Query(None, max_length=64),
                  limit: int = Query(listening.HISTORY_PAGE, ge=1, le=listening.HISTORY_MAX),
                  who: Listener = Depends(listener), db: Session = Depends(get_db)):
    """This listener's check-in log for the book, newest first, a page at a
    time: {"entries", "next_before"}. Pass next_before back as `before` for
    the next page; null means there are no more.

    Earlier copies' entries are included, each marked "earlier_copy": true:
    under the same rule as /position while the listener has no row of their
    own for `key`, and after that for as long as their row keeps its link
    (Checkin.linked_from). A link is followed on through the earlier copy's
    own link, up to listening.LINK_HOPS copies (A became B became C). 503
    when Plex fails before the lookup can finish."""
    if before is not None:
        try:
            listening.parse_cursor(before)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
    album, _access = await _checked_book(who, key)
    own = listening.get_position_row(db, who.identity, key)
    if own is not None:
        first = own.linked_from
    else:
        row = await _earlier_copy(db, who, key, album=album)
        first = row.book_key if row is not None else None
    linked = listening.link_chain(db, who.identity, key, first)
    try:
        return listening.get_history_page(db, who.identity, key, limit=limit, before=before, linked=linked)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.get("/next/{key}")
@_limit(PLAYER_LIMIT, "next")
async def next_book(request: Request, key: str, who: Listener = Depends(listener)):
    """The next book in this book's series, {"next": book or null}: the book
    fields /books gives. The same narrator's edition when the library has it,
    else another edition; null for a standalone book, the last one, or one
    whose place in its series the library doesn't say (see
    plex_player.next_in_series). The player offers it at the end of a book
    and never starts it on its own."""
    await _book_access(who, key)
    try:
        found = await pp.next_in_series(key)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc) from None
    if found is None:
        return {"next": None}
    return {"next": {**found, "cover": _cover_url(found["key"], found.get("cover"))}}


class Checkin(BaseModel):
    model_config = ConfigDict(extra="ignore")

    book: Text = Field(min_length=1, max_length=listening.KEY_MAX)
    track: Text = Field(min_length=1, max_length=listening.KEY_MAX)
    offset_ms: StrictInt = Field(ge=0, le=MAX_MS)
    duration_ms: StrictInt = Field(ge=0, le=MAX_MS)
    event: Literal[listening.EVENTS]
    device: Text = Field(default="", max_length=listening.DEVICE_MAX)
    # The browser's own random id for itself; optional (older players send none).
    device_id: Optional[str] = Field(default=None, pattern=r"^[a-z0-9]{16,40}$")
    # The stored timestamp this page last saw for the book (spec 11b); null
    # when it saw no position. Checked as ISO 8601 by the store.
    base: Optional[Text] = Field(default=None, max_length=listening.BASE_MAX)
    psid: Text = Field(min_length=1, max_length=listening.PSID_MAX)
    seq: StrictInt = Field(ge=0, le=MAX_SEQ)
    # Spec 2.5: the place in book time and that copy's chapter name, which
    # survive the book's files being replaced. Optional (older players send
    # neither); the server clamps book_ms to the book's length.
    book_ms: Optional[StrictInt] = Field(default=None, ge=0, le=listening.BOOK_MS_MAX)
    chapter_label: Optional[Text] = Field(default=None, max_length=listening.LABEL_MAX)
    # The earlier copy's book key when this place came from one (/position
    # gave linked_from). The player sends it with its saves until a response
    # says "linked" true or false; the server keeps it only when it would
    # make the same link itself.
    linked_from: Optional[str] = Field(default=None, pattern=r"^[0-9]{1,20}:[0-9]{1,6}$")

    @model_validator(mode="after")
    def _offset_within_track(self):
        if self.offset_ms > self.duration_ms:
            raise ValueError("offset_ms must not be past duration_ms")
        return self


async def _claimed_link(db: Session, who: "Listener", key: str, claim: Optional[str]):
    """The listener's own row under a check-in's claimed earlier copy when
    the claim can be checked at all (another key, a row of theirs there that
    has a work key), else None. Database only."""
    if not claim or claim == key:
        return None
    row = listening.get_position_row(db, who.identity, claim)
    return row if row is not None and row.work_key else None


async def _link_verdict(db: Session, who: "Listener", key: str, earlier: str, claimed, about: dict,
                        gone, known: dict) -> Optional[bool]:
    """Whether `key` is the book the earlier copy `earlier` became: True,
    False, or None when it can't be told now (Plex failed, or the book's own
    work key is unknown). `claimed` is _claimed_link's row, `gone` the
    _album_gone answer for `earlier` (or the exception it raised)."""
    if claimed is None:
        return False
    if not about.get("work_key"):
        return None                         # the book's own key is unknown: check again later
    if claimed.work_key != about["work_key"]:
        return False
    # _album_gone: True, False, or None when Plex can't say.
    linked = gone if not isinstance(gone, Exception) else None
    if linked:
        # Its place already lives on in a copy still in the library: not
        # this book's to take (_carried_forward).
        known[earlier] = True
        carried = await _carried_forward(db, who, earlier, key, known)
        linked = None if carried is None else not carried
    return linked


async def _settle_pending(db: Session, who: "Listener", key: str, earlier: str, claimed, about: dict,
                          gone, known: dict) -> None:
    """Re-verify the book's own pending claim on `earlier` (any check-in, see
    checkin): verified it becomes a verified claim with the row's link, the old
    album back drops it, Plex unavailable leaves it pending. Nothing is
    answered: the response's "linked" is only for the link the request carried."""
    verdict = await _link_verdict(db, who, key, earlier, claimed, about, gone, known)
    if verdict is None:
        return
    outcome = listening.claim_link(db, who.identity, key, earlier, verdict)
    await _settle_claim(db, who, key, (earlier, verdict), outcome, known)


async def _settle_claim(db: Session, who: "Listener", key: str, link: tuple, outcome, known: dict):
    """The check-in's "linked" from the claim its save wrote
    (listening.claim_link's answer). When another book holds the claim (two
    confirms at once on the two workers, or a copy that claimed it before),
    that book's album decides: still in the library, it keeps the claim and
    this book is refused (false); gone, its claim is released and taken
    over (a copy that went too blocks nothing, so A to B to C works), but
    only when the holder's own successors don't carry the place on
    (_carried_forward from the holder), else null and the claim stays; Plex
    can't say, null (sent again with the next save). `known` holds the
    album checks this request already made."""
    if not isinstance(outcome, str):
        return outcome
    gone = known[outcome] if outcome in known else await _album_gone(outcome)
    if not gone:
        return None if gone is None else False
    earlier, verdict = link
    # A pending holder has no link on its row: its claim is the only record
    # that `earlier` was carried forward. Releasing it is safe only when that
    # place lives on in none of the holder's own successors either, and
    # unknown (Plex can't say) is not safe: answer null and let it be asked again.
    if await _carried_forward(db, who, outcome, key, known) is not False:
        return None
    outcome = listening.claim_link(db, who.identity, key, earlier, verdict, release=outcome)
    return None if isinstance(outcome, str) else outcome   # yet another copy took it meanwhile: ask again


@router.post("/checkin", dependencies=[Depends(require_same_origin)])
@_limit(CHECKIN_LIMIT, "checkin")
async def checkin(request: Request, body: Checkin, background: BackgroundTasks,
                  who: Listener = Depends(listener), _text: None = Depends(require_encodable_body),
                  db: Session = Depends(get_db)):
    """Store this listener's place in the book and log it, then report it to
    Plex's timeline after the response (a slow Plex never delays the save).

    Not gated on library_access: it writes only the listener's own rows, and
    a save should have as few ways to fail as possible. The book and track
    are still checked as belonging to the library.

    {"stored": false} when an older seq from the page session that wrote the
    stored position arrived late: nothing is stored, logged or forwarded.

    409 {"conflict": {track, offset_ms, device, updated_at}, "now"} when the
    stored position is another page session's (another device, or another
    tab or a reload of this browser) and `base` is not its timestamp (spec
    11b): nothing is stored or forwarded; the attempt is logged. The body is
    only ever this listener's own row.

    The book's length, work key, narrator and title are stored with the place
    (spec 2.5), from the reads that check the book (plex_player.checkin_book:
    the album, the track and the album's tracks, all at once). The tracks
    read is best effort: when it fails the place is stored and the row keeps
    the values it had.

    `linked_from` (spec 2.5 s4): the earlier copy /position linked this book
    to. The check-in claims that copy for the book, in the save's own
    transaction (spec 2.6 s4: one successor per earlier copy, enforced by
    the database). Every response to a check-in that carries one says
    "linked":
    - true: the claim is verified and the link is kept on the listener's row
      for the book (set once, whatever the save's own outcome, a refused seq
      or a 409 included), so the earlier copy's history stays with it;
    - false: it is not a link the server would make (not the listener's own
      copy, another work, its album still in the library, or its place
      already carried into another copy still in the library, pending
      claims included), or the row already has another link, or another
      book won the claim at the same moment; stop sending it. The place is
      saved all the same;
    - null: it could not be checked now (Plex failed), and a pending claim
      is stored: it blocks other copies until a later check-in verifies it
      (true) or finds the old album back (false, and the claim is dropped).
      Send it again with the next save.
    Its album check runs at the same time as the book's reads.

    A pending claim of the book's own is re-verified on any check-in for the
    book, with or without linked_from (one more album check, at the same
    time), so a browser that lost the link, or another device, still settles
    it. Its outcome is not answered: "linked" is only for the link the
    request carried."""
    claimed = await _claimed_link(db, who, body.book, body.linked_from)
    reads = [pp.checkin_book(body.book, body.track)]
    if claimed is not None:
        reads.append(_album_gone(body.linked_from))
    # The book's own pending claim (spec 2.6 s4) is re-verified on any check-in,
    # whether or not it carries the link: the browser that confirmed it may have
    # lost it, or the listener moved to another device. One extra album check.
    pending = listening.pending_claim(db, who.identity, body.book)
    if pending == body.linked_from:
        pending = None                      # this request verifies it already
    pending_row = await _claimed_link(db, who, body.book, pending)
    pending_read = len(reads)
    if pending_row is not None:
        reads.append(_album_gone(pending))
    results = await asyncio.gather(*reads, return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException) and not isinstance(result, Exception):
            raise result
    if isinstance(results[0], (pp.PlayerUnavailable, pp.NotInLibrary)):
        raise _http_error(results[0]) from None
    if isinstance(results[0], Exception):
        raise results[0]
    _album, about = results[0]
    about = about or {}

    known = {}
    linked = None
    if body.linked_from is not None:
        linked = await _link_verdict(db, who, body.book, body.linked_from, claimed, about,
                                     results[1] if claimed is not None else None, known)
    # The claim's verdict; nothing to claim for a key that is not another book's.
    link = (body.linked_from, linked) if body.linked_from not in (None, body.book) else None

    try:
        result = listening.save_checkin(db, who.identity, body.book, body.track, body.offset_ms,
                                        body.duration_ms, body.event, body.device, body.psid, body.seq,
                                        device_id=body.device_id, base=body.base, book_ms=body.book_ms,
                                        chapter_label=body.chapter_label,
                                        book_duration_ms=about.get("duration_ms"),
                                        work_key=about.get("work_key"), narrator=about.get("narrator"),
                                        book_title=about.get("title"), link=link)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    if link is not None:
        linked = await _settle_claim(db, who, body.book, link, result.pop("link", None), known)
    if pending is not None:
        gone = results[pending_read] if pending_row is not None else None
        await _settle_pending(db, who, body.book, pending, pending_row, about, gone, known)
    extra = {} if body.linked_from is None else {"linked": linked}
    if result.get("conflict"):
        return JSONResponse({"conflict": result["conflict"], "now": utc_iso(datetime.now(timezone.utc)), **extra},
                            status_code=status.HTTP_409_CONFLICT)
    if result["stored"]:
        background.add_task(pp.timeline, who.session(), body.track, EVENT_STATES[body.event],
                            body.offset_ms, body.duration_ms, session_id=who.session_id)
    return {**result, **extra}


# --- Preferences --------------------------------------------------------------------

@router.get("/prefs")
@_limit(PLAYER_LIMIT, "prefs-get")
async def get_prefs(request: Request, who: Listener = Depends(listener), db: Session = Depends(get_db)):
    """This listener's skip, speed and smart rewind settings."""
    return listening.get_prefs(db, who.identity)


@router.put("/prefs", dependencies=[Depends(require_same_origin)])
@_limit(PLAYER_LIMIT, "prefs-put")
async def put_prefs(request: Request, payload: dict = Body(...), who: Listener = Depends(listener),
                    _text: None = Depends(require_encodable_body), db: Session = Depends(get_db)):
    """Change some of this listener's settings; returns all of them."""
    unknown = sorted(k for k in payload if k not in listening.PREF_DEFAULTS)
    if unknown:
        raise HTTPException(status_code=422, detail="Unknown preference: " + ", ".join(unknown))
    try:
        return listening.put_prefs(db, who.identity, **payload)
    except (ValueError, OverflowError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
