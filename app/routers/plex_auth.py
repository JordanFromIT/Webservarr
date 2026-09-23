"""
Direct Plex OAuth routes — PIN-based authentication without Authentik.
Same flow used by Seerr, Tautulli, and other *arr apps.
"""

import hashlib
import hmac
import json
import logging
import secrets
import uuid
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.integrations import seerr
from app.limiter import limiter
from app.models import Setting
from app.routers.auth import (
    _is_plex_server_owner,
    _plex_auth_enabled,
    _user_has_server_access,
)

logger = logging.getLogger(__name__)
router = APIRouter()

PLEX_TIMEOUT = 5.0

# Cookie that binds a Plex PIN to the browser that started the login (M3). Its
# value is a random nonce; Redis stores only sha256(nonce) alongside the PIN, so
# a stolen Redis value can't forge the cookie and a stolen cookie without the
# PIN id is useless.
PLEX_PIN_COOKIE = "webservarr_plex_pin"


def _hash_pin_nonce(nonce: str) -> str:
    """SHA-256 hex of a PIN-binding nonce (what we store in Redis)."""
    return hashlib.sha256(nonce.encode("utf-8")).hexdigest()


# --- Helpers ---


def _get_plex_client_id(db: Session) -> str:
    """
    Get or auto-generate a persistent Plex client identifier.
    Stored as system.plex_client_id in Settings (same pattern as VAPID keys).
    """
    existing = db.query(Setting).filter(Setting.key == "system.plex_client_id").first()
    if existing and existing.value:
        return existing.value

    client_id = str(uuid.uuid4())
    new_setting = Setting(
        key="system.plex_client_id",
        value=client_id,
        description="Auto-generated Plex client identifier for PIN-based auth",
    )
    try:
        db.add(new_setting)
        db.commit()
    except IntegrityError:
        db.rollback()
        # Race condition: another worker created it first
        existing = db.query(Setting).filter(Setting.key == "system.plex_client_id").first()
        if existing:
            return existing.value
    return client_id


def _plex_headers(client_id: str) -> dict:
    """Common Plex API headers for PIN-based auth."""
    return {
        "Accept": "application/json",
        "X-Plex-Product": "WebServarr",
        "X-Plex-Version": "1.0",
        "X-Plex-Platform": "Web",
        "X-Plex-Client-Identifier": client_id,
    }


# --- Request / Response models ---


class PlexCallbackRequest(BaseModel):
    pin_id: int


# --- Endpoints ---


@router.post("/plex-start")
@limiter.limit("5/minute")
async def plex_start(request: Request, response: Response, db: Session = Depends(get_db)):
    """
    Initiate Plex PIN-based auth flow.
    Creates a PIN on plex.tv and returns the auth URL for the client to open.
    """
    # Enforce the auth toggle server-side (H1a): don't even issue a PIN when
    # direct-Plex login is disabled.
    if not _plex_auth_enabled(db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Plex authentication is disabled",
        )

    # Verify Plex integration is configured
    plex_url = db.query(Setting).filter(Setting.key == "integration.plex.url").first()
    plex_token = db.query(Setting).filter(Setting.key == "integration.plex.token").first()
    if not plex_url or not plex_url.value or not plex_token or not plex_token.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Plex integration is not configured. Set Plex URL and token in Settings.",
        )

    client_id = _get_plex_client_id(db)

    # Request a PIN from plex.tv
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.post(
                "https://plex.tv/api/v2/pins",
                headers=_plex_headers(client_id),
                data={"strong": "true"},
            )
            if resp.status_code != 201:
                logger.error("Plex PIN creation failed: HTTP %d — %s", resp.status_code, resp.text)
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Plex PIN creation failed (HTTP {resp.status_code})",
                )

            pin_data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Plex API timed out",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Plex PIN request error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to contact Plex API",
        )

    pin_id = pin_data.get("id")
    pin_code = pin_data.get("code")
    if not pin_id or not pin_code:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Invalid PIN response from Plex",
        )

    # Bind the PIN to this browser (M3): generate a nonce, store only its hash in
    # Redis alongside the PIN, and hand the browser the nonce in an HttpOnly
    # cookie. The callback requires the matching cookie before proceeding, so a
    # third party who guesses/brackets the pin_id can't complete someone else's
    # login.
    pin_nonce = secrets.token_urlsafe(32)
    redis = await session_manager.get_redis()
    await redis.setex(f"plex_pin:{pin_id}", 300, _hash_pin_nonce(pin_nonce))

    response.set_cookie(
        key=PLEX_PIN_COOKIE,
        value=pin_nonce,
        max_age=300,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )

    # Build callback URL from the incoming request so no APP_DOMAIN config is needed.
    # Honour X-Forwarded-Proto behind reverse proxy / Cloudflare Tunnel.
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    app_url = f"{scheme}://{request.url.netloc}"
    callback_url = f"{app_url}/auth/plex-callback-page"
    auth_params = urlencode({
        "clientID": client_id,
        "code": pin_code,
        "forwardUrl": callback_url,
        "context[device][product]": "WebServarr",
    })
    auth_url = f"https://app.plex.tv/auth#?{auth_params}"

    logger.info("Plex PIN auth started: pin_id=%s", pin_id)
    return {"pin_id": pin_id, "auth_url": auth_url}


@router.post("/plex-callback")
@limiter.limit("60/minute")
async def plex_callback(
    request: Request,
    body: PlexCallbackRequest,
    response: Response,
    db: Session = Depends(get_db),
):
    """
    Complete Plex PIN-based auth flow.
    Polls plex.tv for the PIN result, creates a session on success.
    """
    pin_id = body.pin_id

    # Enforce the auth toggle server-side (H1a).
    if not _plex_auth_enabled(db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Plex authentication is disabled",
        )

    redis = await session_manager.get_redis()
    pin_key = f"plex_pin:{pin_id}"
    stored_hash = await redis.get(pin_key)
    stored_hash_str = (
        stored_hash.decode() if isinstance(stored_hash, (bytes, bytearray)) else (stored_hash or "")
    )

    # Browser-binding + anti-replay (M3): require the cookie set at /plex-start
    # and verify it hashes to the value stored with THIS pin. A request without
    # the matching cookie — an attacker polling another browser's pin_id, or a
    # probe for issued ids — gets ONE identical generic error regardless of
    # whether the pin is unknown, expired, or simply not theirs, so the endpoint
    # is not an oracle for issued pin ids. The legitimate browser (which holds
    # the cookie) is the only caller that can reach the states below, including
    # the "not yet authorized" polling response the login page relies on.
    cookie_nonce = request.cookies.get(PLEX_PIN_COOKIE) or ""
    binding_ok = bool(
        stored_hash_str
        and cookie_nonce
        and hmac.compare_digest(_hash_pin_nonce(cookie_nonce), stored_hash_str)
    )
    if not binding_ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown or expired PIN. Please start a new login.",
        )

    client_id = _get_plex_client_id(db)

    # Check PIN status on plex.tv
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.get(
                f"https://plex.tv/api/v2/pins/{pin_id}",
                headers=_plex_headers(client_id),
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Plex PIN check failed (HTTP {resp.status_code})",
                )

            pin_data = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Plex API timed out",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Plex PIN check error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to contact Plex API",
        )

    auth_token = pin_data.get("authToken")
    if not auth_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="PIN not yet authorized. Try again.",
        )

    # PIN used successfully — clean up
    await redis.delete(pin_key)

    # Get user info from Plex
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.get(
                "https://plex.tv/api/v2/user",
                headers={
                    **_plex_headers(client_id),
                    "X-Plex-Token": auth_token,
                },
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Failed to fetch Plex user info",
                )

            user_info = resp.json()
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Plex user info error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to fetch Plex user info",
        )

    plex_user_id = str(user_info.get("id") or "")
    username = user_info.get("username", "")
    display_name = user_info.get("title", username)
    email = user_info.get("email", "")
    avatar_url = user_info.get("thumb", "")

    # Require Plex server MEMBERSHIP before creating a session (H1b). This allows
    # the owner AND all shared/home users, and rejects only accounts with no
    # access to the configured server. Fails closed on error.
    if not await _user_has_server_access(auth_token, db):
        logger.warning("Plex login denied: %s has no access to the configured Plex server", email)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account does not have access to this Plex server.",
        )

    # Determine admin status by immutable Plex account id (H2). The owner passes
    # purely on the id match. The secondary system.admin_email allowlist only
    # ever fires here if plex.tv explicitly reports the account's email as
    # confirmed; if it does not, email_verified stays False and a non-owner can
    # never become admin via the Plex-direct path (closes H2(b) for template
    # installs whose admin_email may be registerable at plex.tv).
    email_verified = bool(
        user_info.get("confirmed")
        or user_info.get("confirmedAt")
        or user_info.get("emailVerified")
    )
    is_admin = await _is_plex_server_owner(
        db,
        user_plex_id=plex_user_id,
        email=email,
        email_verified=email_verified,
    )

    # Create session
    session_data = {
        "user_id": plex_user_id,
        "username": username,
        "display_name": display_name,
        "email": email,
        "is_admin": str(is_admin).lower(),
        "auth_method": "plex",
        "plex_token": auth_token,
        "avatar_url": avatar_url,
        "id_token": "",
    }

    session_id = session_manager.generate_session_id()
    await session_manager.create_session(session_id, session_data)

    logger.info("Plex PIN login successful: %s (admin=%s)", email, is_admin)

    # Set session cookie
    _cookie_secure = settings.cookie_secure
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_id,
        max_age=settings.session_max_age,
        httponly=True,
        secure=_cookie_secure,
        samesite="lax",
    )
    # PIN binding is consumed — clear its cookie.
    response.delete_cookie(key=PLEX_PIN_COOKIE, path="/")

    # Try Seerr SSO (non-blocking — failure doesn't affect login)
    try:
        seerr_sid = await seerr.authenticate_with_plex_token(auth_token)
        if seerr_sid:
            logger.info("Seerr SSO successful for %s (plex auth)", email)
            cookie_kwargs = {
                "key": "connect.sid",
                "value": seerr_sid,
                "httponly": True,
                "secure": True,
                "samesite": "none",
                "path": "/",
            }
            if "." in settings.app_domain:
                cookie_kwargs["domain"] = "." + settings.app_domain.split(".", 1)[1]
            response.set_cookie(**cookie_kwargs)
    except Exception as e:
        logger.warning("Seerr SSO failed (non-fatal, plex auth): %s", str(e))

    return {"success": True, "email": email, "is_admin": is_admin}


@router.get("/plex-callback-page")
async def plex_callback_page(request: Request):
    """
    Landing page after Plex auth redirect.
    If opened in a popup: sends postMessage to opener and closes.
    If opened as redirect (no opener): redirects to login page.
    """
    app_origin = f"{request.url.scheme}://{request.url.netloc}"
    # The origin comes from the (attacker-controllable) Host header and is
    # interpolated into inline JS. JSON-encode it for the JS string context, then
    # neutralise the sequences that could otherwise break out of the <script>
    # element (e.g. a Host containing "</script>"). L13.
    app_origin_js = (
        json.dumps(app_origin)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Plex Auth</title></head>
<body>
<p>Completing authentication...</p>
<script>
if (window.opener) {{
    window.opener.postMessage({{type: 'plex-auth-complete'}}, {app_origin_js});
    window.close();
}} else {{
    window.location.href = '/login?plex_auth=complete';
}}
</script>
</body>
</html>"""
    return HTMLResponse(content=html)
