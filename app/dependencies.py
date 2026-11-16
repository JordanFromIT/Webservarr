"""
FastAPI dependencies for authentication and authorization.
"""

import logging
import time

from fastapi import Cookie, HTTPException, Request, status, Depends
from typing import Optional, Dict
from urllib.parse import urlsplit
from app.auth import session_digest, session_manager
from app.config import settings

logger = logging.getLogger(__name__)

# How often a signed-in Plex session's server membership is asked again.
ACCESS_RECHECK_S = 24 * 60 * 60


async def still_has_access(session_id: str, user_data: Dict[str, str]) -> bool:
    """False when a session's Plex account has lost access to the server
    (taken off the share), after deleting the session and the person's kept
    Kavita key. Sign-in checks membership once; sessions persist up to the
    absolute lifetime, so it is asked again here at most once a day per
    session. Recent sign-ins count as checked, so ordinary requests make no
    Plex call. A Redis claim (SET NX for the whole interval) keeps concurrent
    requests from asking twice. Plex being unreachable ("unknown") keeps the
    session: nobody is signed out because Plex is down. A session without a
    plex_token (a local password) is never asked."""
    plex_token = user_data.get("plex_token")
    if not plex_token:
        return True
    checked = user_data.get("access_checked_at") or user_data.get("created_at") or "0"
    try:
        checked_at = int(checked)
    except ValueError:
        checked_at = 0
    now = int(time.time())
    if now - checked_at < ACCESS_RECHECK_S:
        return True
    redis = await session_manager.get_redis()
    claim = f"session_access_check:{session_digest(session_id)}"
    if not await redis.set(claim, "1", nx=True, ex=ACCESS_RECHECK_S):
        return True

    from app.database import SessionLocal
    from app.routers.auth import _server_membership
    db = SessionLocal()
    try:
        membership = await _server_membership(plex_token, db)
    finally:
        db.close()

    if membership == "member":
        await session_manager.update_session(session_id, {"access_checked_at": str(now)})
        return True
    if membership in ("not_member", "token_rejected"):
        from app.routers.tickets import account_identity
        from app.services import kavita_keys
        await session_manager.delete_session(session_id)
        identity = account_identity(user_data)
        if identity:
            kavita_keys.forget(identity)
        logger.warning("Session ended: its Plex account no longer has access (%s)", membership)
        return False
    return True


async def get_current_user(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name)
) -> Dict[str, str]:
    """
    Dependency to get the current authenticated user.
    Raises 401 if not authenticated.
    """
    if not session_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"}
        )

    user_data = await session_manager.get_session(session_id)

    if not user_data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
            headers={"WWW-Authenticate": "Bearer"}
        )

    if not await still_has_access(session_id, user_data):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
            headers={"WWW-Authenticate": "Bearer"}
        )

    return user_data


async def get_current_user_optional(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name)
) -> Optional[Dict[str, str]]:
    """
    Dependency to get the current user if authenticated, None otherwise.
    """
    if not session_id:
        return None

    user_data = await session_manager.get_session(session_id)
    if user_data and not await still_has_access(session_id, user_data):
        return None
    return user_data


async def require_admin(
    current_user: Dict[str, str] = Depends(get_current_user)
) -> Dict[str, str]:
    """
    Dependency to require admin role.
    Checks the is_admin flag stored in the Redis session.
    """
    if current_user.get("is_admin") != "true":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )

    return current_user


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
    request's own host, under the configured scheme or the one the browser is
    really on (a TLS proxy's X-Forwarded-Proto, else the connection's own, so
    the quick start on http://localhost:7979 works with APP_SCHEME=https).
    Browsers send Origin on every POST and PUT, including sendBeacon; an
    opaque origin ("null") is refused.

    The app has no CSRF token (the session cookie is SameSite=Lax, which still
    rides along from another subdomain of the same site), so every
    state-changing route a signed-in browser calls carries this check."""
    sent = request.headers.get("origin")
    if sent is None:
        sent = request.headers.get("referer")
    got = _origin(sent)
    allowed = {_origin(settings.app_url)}
    host = request.headers.get("host")
    if host:
        forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        for scheme in (settings.app_scheme, forwarded or request.url.scheme):
            allowed.add(_origin(f"{scheme}://{host}"))
    allowed.discard("")
    if not got or got not in allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-origin request refused")
