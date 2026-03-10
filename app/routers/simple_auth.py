"""
Simple authentication routes - Session-based login with database-backed users.
Will be replaced with Authentik/OIDC in a future phase.
"""

from datetime import datetime
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from passlib.hash import bcrypt

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user_optional
from app.limiter import limiter
from app.models import User, Setting

# Use secure cookies only in production (behind HTTPS)
_COOKIE_SECURE = settings.app_env == "production"

router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    success: bool
    message: str
    redirect: str


@router.post("/simple-login", response_model=LoginResponse)
@limiter.limit("5/minute")
async def simple_login(
    request: Request,
    login_data: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
):
    """Authenticate with username and password against the users table."""
    # Check if simple auth is enabled
    simple_auth_setting = db.query(Setting).filter(Setting.key == "features.show_simple_auth").first()
    if simple_auth_setting and simple_auth_setting.value == "false":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Local authentication is disabled",
        )

    user = db.query(User).filter(
        User.username == login_data.username,
        User.is_active == True,
    ).first()

    if not user or not bcrypt.verify(login_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    # Update last login timestamp
    user.last_login = datetime.utcnow()
    db.commit()

    # Build session data
    user_data = {
        "user_id": str(user.id),
        "username": user.username,
        "display_name": user.display_name,
        "email": user.email or "",
        "is_admin": str(user.is_admin).lower(),
    }

    session_id = session_manager.generate_session_id()
    await session_manager.create_session(session_id, user_data)

    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_id,
        max_age=settings.session_max_age,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="lax",
    )

    return LoginResponse(success=True, message="Login successful", redirect="/")


@router.get("/logout")
async def logout_redirect(
    request: Request,
    db: Session = Depends(get_db),
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Logout via GET - clears session and redirects to login page.
    If user logged in via OIDC, also clears the Authentik session."""
    from fastapi.responses import RedirectResponse
    from urllib.parse import urlencode

    is_oidc_session = False
    id_token = ""
    if session_id:
        session_data = await session_manager.get_session(session_id)
        if session_data and session_data.get("auth_method") == "oidc":
            is_oidc_session = True
            id_token = session_data.get("id_token", "")
        await session_manager.delete_session(session_id)

    # If OIDC session, build Authentik end-session URL from DB with env var fallback
    if is_oidc_session:
        authentik_url_setting = db.query(Setting).filter(
            Setting.key == "integration.authentik.url"
        ).first()
        slug_setting = db.query(Setting).filter(
            Setting.key == "integration.authentik.app_slug"
        ).first()
        authentik_url = (
            authentik_url_setting.value
            if authentik_url_setting and authentik_url_setting.value
            else settings.authentik_url
        )
        slug = (
            slug_setting.value
            if slug_setting and slug_setting.value
            else "webservarr"
        )

        if authentik_url:
            logout_url = f"{authentik_url}/application/o/{slug}/end-session/"
            app_origin = f"{request.url.scheme}://{request.url.netloc}"
            params = {"post_logout_redirect_uri": f"{app_origin}/login"}
            if id_token:
                params["id_token_hint"] = id_token
            redirect_url = f"{logout_url}?{urlencode(params)}"
        else:
            redirect_url = "/login"
    else:
        redirect_url = "/login"

    response = RedirectResponse(url=redirect_url, status_code=302)
    response.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="lax",
    )
    # Clear Overseerr SSO cookie (domain scoping only applies on multi-part hostnames)
    host = request.url.hostname or ""
    if "." in host:
        parent_domain = "." + host.split(".", 1)[1]
        response.delete_cookie("connect.sid", domain=parent_domain, path="/")
    else:
        response.delete_cookie("connect.sid", path="/")
    return response


@router.post("/simple-logout")
async def simple_logout(
    request: Request,
    response: Response,
    session_id: str = Cookie(None, alias=settings.session_cookie_name),
):
    """Logout via POST - clears session and returns JSON."""
    if session_id:
        await session_manager.delete_session(session_id)

    response.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="lax",
    )
    # Clear Overseerr SSO cookie (domain scoping only applies on multi-part hostnames)
    host = request.url.hostname or ""
    if "." in host:
        parent_domain = "." + host.split(".", 1)[1]
        response.delete_cookie("connect.sid", domain=parent_domain, path="/")
    else:
        response.delete_cookie("connect.sid", path="/")

    return {"success": True, "message": "Logged out", "redirect": "/login"}


@router.get("/check-session")
async def check_session(
    current_user=Depends(get_current_user_optional),
):
    """Check if user has an active session. Used by frontend for auth gating."""
    if not current_user:
        return {"authenticated": False}

    return {
        "authenticated": True,
        "user": {
            "username": current_user.get("username", ""),
            "display_name": current_user.get("display_name", ""),
            "is_admin": current_user.get("is_admin", "false") == "true",
            "avatar_url": current_user.get("avatar_url", ""),
            "auth_method": current_user.get("auth_method", ""),
        },
    }
