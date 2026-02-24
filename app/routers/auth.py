"""
OIDC Authentication routes - Plex login via Authentik.
Handles OIDC login redirect, callback with admin determination, and user info.
Logout is handled by simple_auth.py (shared session clearing).
"""

from fastapi import APIRouter, Cookie, Depends, HTTPException, status, Response
from fastapi.responses import RedirectResponse, HTMLResponse
from pydantic import BaseModel
from urllib.parse import quote, urlencode
import secrets
import logging
import httpx

from app.auth import oidc_client, session_manager
from app.config import settings
from app.dependencies import get_current_user
from app.database import get_db
from app.models import Setting
from app.integrations import overseerr
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)
router = APIRouter()

PLEX_TIMEOUT = 5.0

# Native Plex PIN auth constants
PLEX_CLIENT_ID = "hms-dashboard"
PLEX_PRODUCT = "HMS Dashboard"


async def _is_plex_server_owner(email: str, db: Session) -> bool:
    """
    Check if the authenticated user is the Plex server owner.
    Uses the admin's Plex token from settings to query the server identity,
    then compares the server owner's email to the authenticated user's email.
    """
    token_setting = db.query(Setting).filter(Setting.key == "integration.plex.token").first()
    url_setting = db.query(Setting).filter(Setting.key == "integration.plex.url").first()

    if not token_setting or not url_setting:
        logger.warning("Plex integration not configured, cannot determine server owner")
        return False

    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT, verify=False) as client:
            # Get the Plex account info for the token owner (server admin)
            resp = await client.get(
                "https://plex.tv/api/v2/user",
                headers={
                    "X-Plex-Token": token_setting.value,
                    "Accept": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.warning("Failed to fetch Plex account info: HTTP %d", resp.status_code)
                return False

            owner_info = resp.json()
            owner_email = owner_info.get("email", "").lower()
            return email.lower() == owner_email

    except Exception as e:
        logger.error("Error checking Plex server ownership: %s", str(e))
        return False


@router.get("/login")
async def oidc_login():
    """
    Initiate OIDC login flow.
    Redirects user to Authentik, which shows the Plex login option.
    """
    if not oidc_client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC authentication is not configured. Set AUTHENTIK_URL in environment.",
        )

    # Generate CSRF state token
    state = secrets.token_urlsafe(32)
    await session_manager.store_state(state)

    # Get authorization URL from OIDC client
    auth_url = await oidc_client.get_authorization_url(state)

    logger.info("OIDC login initiated, redirecting to Authentik")
    return RedirectResponse(url=auth_url)


@router.get("/callback")
async def oidc_callback(code: str, state: str, db: Session = Depends(get_db)):
    """
    OIDC callback endpoint.
    Handles the redirect from Authentik after Plex authentication.
    Determines admin status by checking if the user is the Plex server owner.
    """
    # Verify CSRF state
    state_valid = await session_manager.verify_state(state)
    if not state_valid:
        logger.error("Invalid or expired state token")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired state token",
        )

    try:
        # Exchange code for tokens
        token_response = await oidc_client.exchange_code_for_token(code)
        access_token = token_response.get("access_token")

        if not access_token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="No access token received",
            )

        # Get user information from Authentik
        userinfo = await oidc_client.get_userinfo(access_token)

        # Determine admin status: server owner = admin
        user_email = userinfo.get("email", "")
        is_admin = await _is_plex_server_owner(user_email, db)

        # Build session data
        id_token = token_response.get("id_token", "")
        plex_token = userinfo.get("plex_token", "")
        session_data = {
            "user_id": userinfo.get("sub", ""),
            "username": userinfo.get("preferred_username", userinfo.get("name", "")),
            "display_name": userinfo.get("name", ""),
            "email": user_email,
            "is_admin": str(is_admin).lower(),
            "auth_method": "oidc",
            "id_token": id_token,
            "plex_token": plex_token,
        }

        session_id = session_manager.generate_session_id()
        await session_manager.create_session(session_id, session_data)

        logger.info(
            "OIDC login successful: %s (admin=%s)",
            user_email,
            is_admin,
        )

        # Authenticate with Overseerr SSO (non-blocking — failure doesn't affect login)
        overseerr_sid = None
        if plex_token:
            try:
                overseerr_sid = await overseerr.authenticate_with_plex_token(db, plex_token)
                if overseerr_sid:
                    logger.info("Overseerr SSO successful for %s", user_email)
                else:
                    logger.debug("Overseerr SSO returned no session for %s", user_email)
            except Exception as e:
                logger.warning("Overseerr SSO failed (non-fatal): %s", str(e))

        # Set session cookie and notify the opener window to redirect
        # The callback runs inside a popup — send postMessage to close it
        close_html = """<!DOCTYPE html>
<html><body><script>
if (window.opener) {
    window.opener.postMessage('auth-success', window.location.origin);
    window.close();
} else {
    window.location.href = '/';
}
</script></body></html>"""
        response = HTMLResponse(content=close_html)
        response.set_cookie(
            key=settings.session_cookie_name,
            value=session_id,
            max_age=settings.session_max_age,
            httponly=True,
            secure=True,
            samesite="lax",
        )

        # Set Overseerr session cookie on parent domain for iframe SSO
        if overseerr_sid:
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

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error("OIDC authentication error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Authentication failed: {str(e)}",
        )


class PlexStartRequest(BaseModel):
    pin_id: int


@router.post("/plex-start")
async def plex_start(body: PlexStartRequest):
    """
    Store a client-created Plex PIN and return callback URL.
    The browser creates the PIN directly with plex.tv (so Plex sees the
    user's IP, not the server's), then calls this to register it.
    """
    state = secrets.token_urlsafe(32)
    await session_manager.store_plex_pin(state, body.pin_id, PLEX_CLIENT_ID)
    callback_url = f"{settings.app_url}/auth/plex-callback?state={state}"
    logger.info("Plex PIN stored (pin_id=%s)", body.pin_id)
    return {"callback_url": callback_url}


@router.get("/plex-callback")
async def plex_callback(state: str, db: Session = Depends(get_db)):
    """
    Plex PIN auth callback.
    Checks the PIN for an auth token, gets user info, creates session.
    """
    # Retrieve and consume PIN data from Redis
    pin_data = await session_manager.get_plex_pin(state)
    if not pin_data:
        logger.error("Invalid or expired Plex auth state")
        return RedirectResponse(url="/login", status_code=302)

    pin_id = pin_data["pin_id"]
    client_id = pin_data["client_id"]

    # Check the PIN for auth token
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.get(
                f"https://plex.tv/api/v2/pins/{pin_id}",
                headers={
                    "X-Plex-Client-Identifier": client_id,
                    "Accept": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.error("Failed to check Plex PIN: HTTP %d", resp.status_code)
                return RedirectResponse(url="/login", status_code=302)
            pin_result = resp.json()
    except httpx.TimeoutException:
        logger.error("Plex API timed out checking PIN")
        return RedirectResponse(url="/login", status_code=302)

    auth_token = pin_result.get("authToken")
    if not auth_token:
        logger.warning("Plex auth not completed (no token on PIN)")
        return RedirectResponse(url="/login", status_code=302)

    # Get user info from Plex
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.get(
                "https://plex.tv/api/v2/user",
                headers={
                    "X-Plex-Token": auth_token,
                    "Accept": "application/json",
                },
            )
            if resp.status_code != 200:
                logger.error("Failed to fetch Plex user info: HTTP %d", resp.status_code)
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Failed to fetch Plex user info",
                )
            user_info = resp.json()
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Plex API timed out",
        )

    user_email = user_info.get("email", "")
    username = user_info.get("username", "")
    display_name = user_info.get("title", username)

    # Determine admin status: Plex server owner = admin
    is_admin = await _is_plex_server_owner(user_email, db)

    # Build session data
    session_data = {
        "user_id": str(user_info.get("id", "")),
        "username": username,
        "display_name": display_name,
        "email": user_email,
        "is_admin": str(is_admin).lower(),
        "auth_method": "plex",
        "id_token": "",
        "plex_token": auth_token,
    }

    session_id = session_manager.generate_session_id()
    await session_manager.create_session(session_id, session_data)

    logger.info("Plex login successful: %s (admin=%s)", user_email, is_admin)

    # Authenticate with Overseerr SSO (non-blocking)
    overseerr_sid = None
    try:
        overseerr_sid = await overseerr.authenticate_with_plex_token(db, auth_token)
        if overseerr_sid:
            logger.info("Overseerr SSO successful for %s", user_email)
    except Exception as e:
        logger.warning("Overseerr SSO failed (non-fatal): %s", str(e))

    # Redirect to dashboard with session cookie
    response = RedirectResponse(url="/", status_code=302)
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_id,
        max_age=settings.session_max_age,
        httponly=True,
        secure=True,
        samesite="lax",
    )

    # Set Overseerr session cookie on parent domain for iframe SSO
    if overseerr_sid:
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

    return response


@router.get("/me")
async def get_current_user_info(current_user: dict = Depends(get_current_user)):
    """
    Get current user information from session.
    Works for both simple auth and OIDC sessions.
    """
    return {
        "user_id": current_user.get("user_id", ""),
        "username": current_user.get("username", ""),
        "display_name": current_user.get("name", current_user.get("display_name", "")),
        "email": current_user.get("email", ""),
        "is_admin": current_user.get("is_admin") == "true",
    }
