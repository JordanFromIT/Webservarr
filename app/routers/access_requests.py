"""
Request access from the sign-in page (docs/superpowers/specs/2026-10-10-request-access-design.md,
section 6).

Public, no session: POST /api/access-requests/pin, POST /api/access-requests/identify and
POST /api/access-requests. Each refuses with 403 unless the switch is on and Plex is set up, before
it does anything else. The flow proves a Plex account with the Plex PIN window, as the Plex sign-in
does, in a namespace of its own (access_pin:* and its own cookies), so a sign-in PIN can't complete
a request and a request PIN can't sign anyone in. It never makes a session. The requester's Plex
token lives only in identify's local variables: never in Redis, the database, a log or a response.
Admin, under /api/admin and require_admin: the list, the count, the libraries, approve, deny and
unblock. They work with the switch off, so requests already waiting can still be answered.
"""
import asyncio
import hmac
import json
import logging
import secrets
from typing import Dict, List, Tuple
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, StrictBool
from sqlalchemy.orm import Session

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.dependencies import require_admin
from app.integrations import plex_share
from app.limiter import limiter
from app.models import AccessRequest
from app.routers import auth, plex_auth
from app.routers.player import Text, require_encodable_body, require_same_origin
from app.routers.tickets import account_identity
from app.services import access_requests as svc
from app.settings_registry import _LIBRARY_KEY

logger = logging.getLogger(__name__)
router = APIRouter()

PLEX_TIMEOUT = 5.0
COOKIE_PATH = "/api/access-requests"
PIN_COOKIE = "webservarr_access_pin"
TICKET_COOKIE = "webservarr_access_ticket"
PIN_TTL = 300            # the PIN and its cookie, as the Plex sign-in
PIN_CLAIM_TTL = 60       # one identify at a time per PIN
TICKET_TTL = 900         # from identify to submit
SUBMIT_LOCK = "access_requests:submit"
SUBMIT_LOCK_TTL = 10
SUBMIT_LOCK_TRIES = 50
SUBMIT_LOCK_WAIT = 0.1

# The card shows these as they are, except NOT_YET, which it matches.
CLOSED = "Access requests are closed."
EXPIRED = "That Plex sign-in expired. Start again."
NOT_YET = "PIN not yet authorized. Try again."
BUSY = "This Plex sign-in is already being checked."
PLEX_DOWN = "Plex isn't answering right now. Try again in a minute."
TIMED_OUT = "Your Plex check timed out. Start again."
FULL = "We're not taking new requests right now. Try again later."
SUBMIT_BUSY = "Lots of requests are arriving at once. Try again in a moment."


class IdentifyBody(BaseModel):
    pin_id: int = Field(ge=1, le=2 ** 53 - 1)


class SubmitBody(BaseModel):
    # Generous raw caps; clean_form applies the real ones (80 and 1000, trimmed).
    name: Text = Field(max_length=200)
    note: Text = Field(max_length=4000)


def _hash(value: str) -> str:
    return plex_auth._hash_pin_nonce(value)


def _text(raw) -> str:
    return raw.decode() if isinstance(raw, (bytes, bytearray)) else (raw or "")


def _require_open(db: Session) -> None:
    if not svc.is_open(db):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=CLOSED)


async def _create_pin(client_id: str) -> Tuple[int, str]:
    """A strong PIN on plex.tv: (id, code)."""
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.post("https://plex.tv/api/v2/pins", headers=plex_auth._plex_headers(client_id),
                                     data={"strong": "true"})
        data = resp.json() if resp.status_code == 201 else None
    except (httpx.HTTPError, ValueError):
        data = None
    pin_id = data.get("id") if isinstance(data, dict) else None
    code = data.get("code") if isinstance(data, dict) else None
    if not isinstance(pin_id, int) or not isinstance(code, str) or not code:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=PLEX_DOWN)
    return pin_id, code


async def _pin_token(pin_id: int, client_id: str) -> str:
    """The PIN's Plex token once the person has signed in to Plex, else ""."""
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.get(f"https://plex.tv/api/v2/pins/{pin_id}", headers=plex_auth._plex_headers(client_id))
        data = resp.json() if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        data = None
    if not isinstance(data, dict):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=PLEX_DOWN)
    token = data.get("authToken")
    return token if isinstance(token, str) else ""


async def _account_state(db: Session, account_id: str) -> Dict[str, str]:
    """invited when Plex lists a pending invite for this account on our
    server, else the row's state. A failed invite lookup skips that step."""
    try:
        if await plex_share.find_share(account_id) == "pending":
            return {"state": "invited"}
    except plex_share.PlexShareUnavailable:
        pass
    return svc.state_for(db, account_id, svc.now_utc())


async def _take_submit_lock(r) -> str:
    """The submit lock's owner token, or "" when it stayed busy."""
    owner = secrets.token_hex(8)
    for _ in range(SUBMIT_LOCK_TRIES):
        if await r.set(SUBMIT_LOCK, owner, nx=True, ex=SUBMIT_LOCK_TTL):
            return owner
        await asyncio.sleep(SUBMIT_LOCK_WAIT)
    return ""


async def _drop_submit_lock(r, owner: str) -> None:
    if _text(await r.get(SUBMIT_LOCK)) == owner:
        await r.delete(SUBMIT_LOCK)


@router.post("/pin", dependencies=[Depends(require_same_origin)])
@limiter.limit("5/minute;20/hour")
async def start_pin(request: Request, response: Response, db: Session = Depends(get_db)):
    """A Plex PIN bound to this browser: the nonce in an HttpOnly cookie,
    only its hash in Redis, as the Plex sign-in does."""
    _require_open(db)
    client_id = plex_auth._get_plex_client_id(db)
    pin_id, code = await _create_pin(client_id)
    nonce = secrets.token_urlsafe(32)
    r = await session_manager.get_redis()
    await r.setex(f"access_pin:{pin_id}", PIN_TTL, _hash(nonce))
    response.set_cookie(key=PIN_COOKIE, value=nonce, max_age=PIN_TTL, httponly=True,
                        secure=settings.cookie_secure, samesite="lax", path=COOKIE_PATH)
    # As plex_start: the address the browser is really on, behind a TLS proxy too.
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    forward = f"{scheme}://{request.url.netloc}/auth/plex-callback-page?for=access"
    auth_url = "https://app.plex.tv/auth#?" + urlencode({
        "clientID": client_id, "code": code, "forwardUrl": forward, "context[device][product]": "WebServarr",
    })
    logger.info("Access request PIN started: pin_id=%s", pin_id)
    return {"pin_id": pin_id, "auth_url": auth_url}


@router.post("/identify", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@limiter.limit("60/minute")
async def identify(request: Request, body: IdentifyBody, response: Response, db: Session = Depends(get_db)):
    """Who the PIN proved, and where their request stands (spec section 6)."""
    _require_open(db)
    pin_id = body.pin_id
    r = await session_manager.get_redis()
    pin_key = f"access_pin:{pin_id}"
    stored = _text(await r.get(pin_key))
    nonce = request.cookies.get(PIN_COOKIE) or ""
    # One error whether the PIN is unknown, expired or another browser's, so
    # this is no oracle for issued PIN ids (as plex_callback).
    if not (stored and nonce and hmac.compare_digest(_hash(nonce), stored)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EXPIRED)
    claim = f"access_pin_claim:{pin_id}"
    if not await r.set(claim, "1", nx=True, ex=PIN_CLAIM_TTL):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=BUSY)
    # Until membership is known the PIN stays, so "not yet" and Plex being
    # down can be asked again; only the claim is released.
    try:
        client_id = plex_auth._get_plex_client_id(db)
        token = await _pin_token(pin_id, client_id)
        if not token:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=NOT_YET)
        # The token is used for these two calls only and goes with this function.
        account = await auth._fetch_plex_account(token, plex_auth._plex_headers(client_id))
        membership = await auth._server_membership(token, db)
        account_id = str(account.get("id") or "")
        if membership == "token_rejected":
            # plex.tv refused the token this PIN gave, so the same PIN can't
            # do better: it is used up and the person starts again.
            await r.delete(pin_key)
            logger.warning("Access request identify: plex.tv refused the PIN's token")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EXPIRED)
        if membership == "unknown" or not account_id:
            logger.warning("Access request identify: Plex couldn't answer (account=%s)", account_id or "unknown")
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=PLEX_DOWN)
    except BaseException:
        await r.delete(claim)
        raise
    # Member or not, the answer is known: the PIN is used up and can't be
    # identified twice.
    await r.delete(pin_key)
    response.delete_cookie(key=PIN_COOKIE, path=COOKIE_PATH)

    # Shown and stored either way, but only a real username is ever sent to
    # Plex as the invite's address: a display name could be someone else's.
    plex_username = str(account.get("username") or "")[:100]
    username = plex_username or str(account.get("title") or "")[:100]
    avatar = svc.safe_avatar_url(account.get("thumb"))
    state = {"state": "member"} if membership == "member" else await _account_state(db, account_id)
    if state["state"] == "new":
        ticket = secrets.token_urlsafe(32)
        await r.setex(f"access_ticket:{_hash(ticket)}", TICKET_TTL, json.dumps({
            "plex_account_id": account_id, "plex_username": username, "has_plex_username": bool(plex_username),
            "plex_email": str(account.get("email") or "")[:254], "plex_avatar_url": avatar,
        }))
        response.set_cookie(key=TICKET_COOKIE, value=ticket, max_age=TICKET_TTL, httponly=True,
                            secure=settings.cookie_secure, samesite="strict", path=COOKIE_PATH)
    logger.info("Access request identify: account=%s state=%s", account_id, state["state"])
    return {**state, "username": username, "avatar_url": avatar}


@router.post("", dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
@limiter.limit("5/hour")
async def submit(request: Request, body: SubmitBody, response: Response, db: Session = Depends(get_db)):
    """Make the request with the ticket identify gave (spec section 6). The
    form is checked before the ticket is used, so a typo costs no Plex
    sign-in; the checks and the insert run under one lock across workers."""
    _require_open(db)
    try:
        name, note = svc.clean_form(body.name, body.note)
    except svc.FormProblem as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from None
    ticket = request.cookies.get(TICKET_COOKIE) or ""
    if not ticket:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=TIMED_OUT)
    r = await session_manager.get_redis()
    owner = await _take_submit_lock(r)
    if not owner:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SUBMIT_BUSY)
    try:
        raw = await r.getdel(f"access_ticket:{_hash(ticket)}")
        if not raw:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=TIMED_OUT)
        account = json.loads(_text(raw))
        try:
            result, row = svc.place(db, account, name, note, svc.now_utc())
        except svc.CapReached:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=FULL) from None
    finally:
        await _drop_submit_lock(r, owner)
    response.delete_cookie(key=TICKET_COOKIE, path=COOKIE_PATH)
    if row is not None:
        logger.info("Access request %s made: account=%s", row.id, row.plex_account_id)
        await svc.notify_admins(r, db, row)
    else:
        logger.info("Access request not made: account=%s state=%s", account.get("plex_account_id"), result["state"])
    return result


admin_router = APIRouter()

APPROVE_CLAIM_TTL = 60
GONE = "That request is gone."
ANSWERED = "That request was already answered."
PICK_LIBRARIES = "Pick libraries from the list."


class ApproveBody(BaseModel):
    library_keys: List[Text] = Field(min_length=1, max_length=50)


class DenyBody(BaseModel):
    block: StrictBool = False


def _row_in(db: Session, request_id: int, wanted: str) -> AccessRequest:
    row = db.get(AccessRequest, request_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=GONE)
    if row.status != wanted:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ANSWERED)
    return row


@admin_router.get("/access-requests")
async def list_access_requests(current_user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    return svc.listing(db, svc.now_utc())


@admin_router.get("/access-requests/count")
async def count_access_requests(current_user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    return {"pending": svc.pending_count(db)}


@admin_router.get("/access-requests/libraries")
async def access_libraries(current_user: dict = Depends(require_admin)):
    try:
        return {"libraries": await plex_share.list_libraries()}
    except plex_share.PlexShareUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from None


@admin_router.post("/access-requests/{request_id}/approve",
                   dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
async def approve_access_request(request_id: int, body: ApproveBody, current_user: dict = Depends(require_admin),
                                 db: Session = Depends(get_db)):
    """Approve and share the server with that account and the ticked
    libraries. Approval is final even when Plex refuses the share; the row
    then says why, and the admin can share by hand."""
    row = _row_in(db, request_id, "pending")
    keys = list(dict.fromkeys(body.library_keys))
    if not all(_LIBRARY_KEY.fullmatch(k) for k in keys):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=PICK_LIBRARIES)
    try:
        on_server = {lib["key"] for lib in await plex_share.list_libraries()}
    except plex_share.PlexShareUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from None
    if not set(keys) <= on_server:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=PICK_LIBRARIES)
    r = await session_manager.get_redis()
    claim = f"access_approve:{request_id}"
    if not await r.set(claim, "1", nx=True, ex=APPROVE_CLAIM_TTL):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ANSWERED)
    try:
        db.refresh(row)
        if row.status != "pending":
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ANSWERED)
        svc.mark_approved(db, row, keys, account_identity(current_user), svc.now_utc())
        state, error = await plex_share.share_server({"plex_account_id": row.plex_account_id}, keys)
        svc.record_share(db, row, state, error)
    finally:
        await r.delete(claim)
    if error == plex_share.WRONG_ACCOUNT:
        await svc.notify_wrong_account(r, db, row)
    logger.info("Access request %s approved: account=%s share=%s", row.id, row.plex_account_id, state)
    return svc.admin_view(row)


@admin_router.post("/access-requests/{request_id}/deny",
                   dependencies=[Depends(require_same_origin), Depends(require_encodable_body)])
async def deny_access_request(request_id: int, body: DenyBody, current_user: dict = Depends(require_admin),
                              db: Session = Depends(get_db)):
    row = _row_in(db, request_id, "pending")
    svc.deny(db, row, body.block, account_identity(current_user), svc.now_utc())
    logger.info("Access request %s %s: account=%s", row.id, row.status, row.plex_account_id)
    return svc.admin_view(row)


@admin_router.post("/access-requests/{request_id}/unblock", dependencies=[Depends(require_same_origin)])
async def unblock_access_request(request_id: int, current_user: dict = Depends(require_admin),
                                 db: Session = Depends(get_db)):
    row = _row_in(db, request_id, "blocked")
    logger.info("Access request %s unblocked: account=%s", row.id, row.plex_account_id)
    db.delete(row)
    db.commit()
    return {"ok": True}
