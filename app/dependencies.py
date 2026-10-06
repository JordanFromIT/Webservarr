"""
FastAPI dependencies for authentication and authorization.
"""

from fastapi import Cookie, HTTPException, Request, status, Depends
from typing import Optional, Dict
from urllib.parse import urlsplit
from app.auth import session_manager
from app.config import settings


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

    return user_data


async def get_current_user_optional(
    session_id: Optional[str] = Cookie(None, alias=settings.session_cookie_name)
) -> Optional[Dict[str, str]]:
    """
    Dependency to get the current user if authenticated, None otherwise.
    """
    if not session_id:
        return None

    return await session_manager.get_session(session_id)


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
