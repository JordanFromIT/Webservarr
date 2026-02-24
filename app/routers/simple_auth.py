"""
Simple authentication routes - Session-based login with database-backed users.
Will be replaced with Authentik/OIDC in a future phase.
"""

from datetime import datetime
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from passlib.hash import bcrypt

from app.auth import session_manager
from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user_optional
from app.models import User

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
async def simple_login(
    login_data: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
):
    """Authenticate with username and password against the users table."""
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

    # If OIDC session and Authentik is configured, redirect through Authentik's
    # end-session endpoint to clear their session too
    if is_oidc_session and settings.authentik_url:
        params = {"post_logout_redirect_uri": f"{settings.app_url}/login"}
        if id_token:
            params["id_token_hint"] = id_token
        redirect_url = f"{settings.oidc_logout_url}?{urlencode(params)}"
    else:
        redirect_url = "/login"

    response = RedirectResponse(url=redirect_url, status_code=302)
    response.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite="lax",
    )
    # Clear Overseerr SSO cookie
    parent_domain = "." + settings.app_domain.split(".", 1)[1]
    response.delete_cookie("connect.sid", domain=parent_domain, path="/")
    return response


@router.post("/simple-logout")
async def simple_logout(
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
    # Clear Overseerr SSO cookie
    parent_domain = "." + settings.app_domain.split(".", 1)[1]
    response.delete_cookie("connect.sid", domain=parent_domain, path="/")

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
        },
    }
