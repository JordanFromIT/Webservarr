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

import hashlib
import logging
from dataclasses import dataclass
from typing import Literal, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, BackgroundTasks, Body, Cookie, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.integrations import plex_player as pp
from app.limiter import _get_client_ip, limiter
from app.routers.tickets import account_identity
from app.services import listening

logger = logging.getLogger(__name__)

router = APIRouter()

PLAYER_LIMIT = "60/minute"
CHECKIN_LIMIT = "60/minute"
COVER_LIMIT = "240/minute"
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

@router.get("/books")
@limiter.limit(PLAYER_LIMIT, key_func=session_rate_key)
async def books(request: Request, who: Listener = Depends(listener)):
    """The audiobook library's books, for a listener who may read it."""
    try:
        await pp.library_access(who.session(), session_id=who.session_id)
        found = await pp.list_books()
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc, forbid=True) from None
    return {"books": [{**b, "cover": _cover_url(b["key"], b.get("cover"))} for b in found]}


@router.get("/book/{key}")
@limiter.limit(PLAYER_LIMIT, key_func=session_rate_key)
async def book(request: Request, key: str, refresh: bool = False, who: Listener = Depends(listener)):
    """One book's tracks and chapters, plus this listener's stream access:
    their own server token and the server's connection URIs. `refresh`
    asks plex.tv again (after the stream refused the cached token)."""
    try:
        pp.parse_key(key)
        access = await pp.library_access(who.session(), session_id=who.session_id, force=refresh)
        detail = await pp.book_detail(key)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc, forbid=True) from None
    body = {**detail, "cover": _cover_url(key, detail.get("cover")),
            "stream": {"token": access["token"], "uris": access["uris"]}}
    # It carries the listener's server token: never stored by a cache.
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/cover/{key}")
@limiter.limit(COVER_LIMIT, key_func=session_rate_key)
async def cover(request: Request, key: str, who: Listener = Depends(listener)):
    """The book's cover as a square image, served from this origin (img-src
    stays as it is)."""
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

@router.get("/position/{key}")
@limiter.limit(PLAYER_LIMIT, key_func=session_rate_key)
async def position(request: Request, key: str, who: Listener = Depends(listener),
                   db: Session = Depends(get_db)):
    """This listener's place in the book: WebServarr's, and Plex's own as a
    book position, each with its timestamp (null when there is none).

    Plex's is best effort: when the listener's own Plex access fails (no
    share, a refused token, plex.tv down) it is null and WebServarr's still
    resumes the book."""
    try:
        await pp.assert_in_library(key)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc) from None
    web = listening.get_position(db, who.identity, key)
    try:
        plex_pos = await pp.plex_position(who.session(), key, session_id=who.session_id)
    except pp.NotInLibrary as exc:
        raise _http_error(exc) from None
    except pp.PlayerUnavailable as exc:
        logger.info("Plex position unavailable: %s", type(exc).__name__)
        plex_pos = None
    return {"web": web, "plex": plex_pos}


@router.get("/history/{key}")
@limiter.limit(PLAYER_LIMIT, key_func=session_rate_key)
async def history(request: Request, key: str, who: Listener = Depends(listener),
                  db: Session = Depends(get_db)):
    """This listener's check-in log for the book, newest first."""
    try:
        await pp.assert_in_library(key)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc) from None
    return {"entries": listening.get_history(db, who.identity, key)}


class Checkin(BaseModel):
    model_config = ConfigDict(extra="ignore")

    book: str = Field(min_length=1, max_length=listening.KEY_MAX)
    track: str = Field(min_length=1, max_length=listening.KEY_MAX)
    offset_ms: StrictInt = Field(ge=0, le=MAX_MS)
    duration_ms: StrictInt = Field(ge=0, le=MAX_MS)
    event: Literal[listening.EVENTS]
    device: str = Field(default="", max_length=listening.DEVICE_MAX)
    psid: str = Field(min_length=1, max_length=listening.PSID_MAX)
    seq: StrictInt = Field(ge=0, le=MAX_SEQ)

    @model_validator(mode="after")
    def _offset_within_track(self):
        if self.offset_ms > self.duration_ms:
            raise ValueError("offset_ms must not be past duration_ms")
        return self


@router.post("/checkin", dependencies=[Depends(require_same_origin)])
@limiter.limit(CHECKIN_LIMIT, key_func=session_rate_key)
async def checkin(request: Request, body: Checkin, background: BackgroundTasks,
                  who: Listener = Depends(listener), db: Session = Depends(get_db)):
    """Store this listener's place in the book and log it, then report it to
    Plex's timeline after the response (a slow Plex never delays the save).

    {"stored": false} when an older seq from the page session that wrote the
    stored position arrived late: nothing is stored, logged or forwarded."""
    try:
        await pp.assert_in_library(body.book, body.track)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        raise _http_error(exc) from None
    try:
        result = listening.save_checkin(db, who.identity, body.book, body.track, body.offset_ms,
                                        body.duration_ms, body.event, body.device, body.psid, body.seq)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    if result["stored"]:
        background.add_task(pp.timeline, who.session(), body.track, EVENT_STATES[body.event],
                            body.offset_ms, body.duration_ms, session_id=who.session_id)
    return result


# --- Preferences --------------------------------------------------------------------

@router.get("/prefs")
@limiter.limit(PLAYER_LIMIT, key_func=session_rate_key)
async def get_prefs(request: Request, who: Listener = Depends(listener), db: Session = Depends(get_db)):
    """This listener's skip, speed and smart rewind settings."""
    return listening.get_prefs(db, who.identity)


@router.put("/prefs", dependencies=[Depends(require_same_origin)])
@limiter.limit(PLAYER_LIMIT, key_func=session_rate_key)
async def put_prefs(request: Request, payload: dict = Body(...), who: Listener = Depends(listener),
                    db: Session = Depends(get_db)):
    """Change some of this listener's settings; returns all of them."""
    unknown = sorted(k for k in payload if k not in listening.PREF_DEFAULTS)
    if unknown:
        raise HTTPException(status_code=422,
                            detail="Unknown preference: " + ", ".join(unknown))
    try:
        return listening.put_prefs(db, who.identity, **payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
