"""
Direct Plex OAuth routes — PIN-based authentication without Authentik.
Same flow used by Overseerr, Tautulli, and other *arr apps.
"""

import logging
import uuid
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.integrations import overseerr
from app.models import Setting
from app.routers.auth import _is_plex_server_owner

logger = logging.getLogger(__name__)
router = APIRouter()

PLEX_TIMEOUT = 5.0


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
async def plex_start(db: Session = Depends(get_db)):
    """
    Initiate Plex PIN-based auth flow.
    Creates a PIN on plex.tv and returns the auth URL for the client to open.
    """
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

    # Store PIN in Redis with 5-minute TTL
    redis = await session_manager.get_redis()
    await redis.setex(f"plex_pin:{pin_id}", 300, "1")

    # Build the auth URL
    if settings.app_domain == "localhost":
        app_url = "http://localhost:8000"
    else:
        app_url = f"{settings.app_scheme}://{settings.app_domain}"

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
async def plex_callback(
    body: PlexCallbackRequest,
    response: Response,
    db: Session = Depends(get_db),
):
    """
    Complete Plex PIN-based auth flow.
    Polls plex.tv for the PIN result, creates a session on success.
    """
    pin_id = body.pin_id

    # Verify the PIN was issued by us (anti-replay)
    redis = await session_manager.get_redis()
    pin_key = f"plex_pin:{pin_id}"
    if not await redis.exists(pin_key):
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

    plex_user_id = str(user_info.get("id", ""))
    username = user_info.get("username", "")
    display_name = user_info.get("title", username)
    email = user_info.get("email", "")
    avatar_url = user_info.get("thumb", "")

    # Determine admin status
    is_admin = await _is_plex_server_owner(email, db)

    # Create session
    session_data = {
        "user_id": plex_user_id,
        "username": username,
        "display_name": display_name,
        "email": email,
        "is_admin": "true" if is_admin else "false",
        "auth_method": "plex",
        "plex_token": auth_token,
        "avatar_url": avatar_url,
        "id_token": "",
    }

    session_id = session_manager.generate_session_id()
    await session_manager.create_session(session_id, session_data)

    logger.info("Plex PIN login successful: %s (admin=%s)", email, is_admin)

    # Set session cookie
    _cookie_secure = settings.app_env == "production"
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_id,
        max_age=settings.session_max_age,
        httponly=True,
        secure=_cookie_secure,
        samesite="lax",
    )

    # Try Overseerr SSO (non-blocking — failure doesn't affect login)
    try:
        overseerr_sid = await overseerr.authenticate_with_plex_token(db, auth_token)
        if overseerr_sid:
            logger.info("Overseerr SSO successful for %s (plex auth)", email)
            parent_domain = "." + settings.app_domain.split(".", 1)[1]
            response.set_cookie(
                key="connect.sid",
                value=overseerr_sid,
                httponly=True,
                secure=True,
                samesite="none",
                path="/",
                domain=parent_domain,
            )
    except Exception as e:
        logger.warning("Overseerr SSO failed (non-fatal, plex auth): %s", str(e))

    return {"success": True, "email": email, "is_admin": is_admin}


@router.get("/plex-callback-page")
async def plex_callback_page():
    """
    Landing page after Plex auth redirect.
    If opened in a popup: sends postMessage to opener and closes.
    If opened as redirect (no opener): redirects to login page.
    """
    html = """<!DOCTYPE html>
<html>
<head><title>Plex Auth</title></head>
<body>
<p>Completing authentication...</p>
<script>
if (window.opener) {
    window.opener.postMessage({type: 'plex-auth-complete'}, '*');
    window.close();
} else {
    window.location.href = '/login?plex_auth=complete';
}
</script>
</body>
</html>"""
    return HTMLResponse(content=html)
