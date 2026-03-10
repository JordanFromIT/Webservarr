"""
FastAPI dependencies for authentication and authorization.
"""

from fastapi import Cookie, HTTPException, status, Depends
from typing import Optional, Dict
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
