"""
OIDC Authentication with Authentik.
Handles login, callback, logout, and session management.
"""

from authlib.integrations.httpx_client import AsyncOAuth2Client
from fastapi import HTTPException, status
from typing import Optional, Dict, Any
import httpx
import secrets
from app.config import settings
import redis.asyncio as aioredis


class OIDCClient:
    """OIDC client for Authentik authentication."""

    def __init__(self):
        self.client_id = settings.authentik_client_id
        self.client_secret = settings.authentik_client_secret
        self.redirect_uri = settings.effective_redirect_uri
        self.authorize_url = settings.oidc_authorize_url
        self.token_url = settings.oidc_token_url
        self.userinfo_url = settings.oidc_userinfo_url

    async def get_authorization_url(self, state: str) -> str:
        """
        Generate authorization URL for OIDC login flow.

        Args:
            state: CSRF protection state parameter

        Returns:
            Authorization URL to redirect user to
        """
        client = AsyncOAuth2Client(
            client_id=self.client_id,
            redirect_uri=self.redirect_uri,
            scope="openid profile email plex"
        )

        uri, _ = client.create_authorization_url(
            self.authorize_url,
            state=state
        )

        return uri

    async def exchange_code_for_token(self, code: str) -> Dict[str, Any]:
        """
        Exchange authorization code for access token.

        Args:
            code: Authorization code from callback

        Returns:
            Token response with access_token, id_token, etc.
        """
        client = AsyncOAuth2Client(
            client_id=self.client_id,
            client_secret=self.client_secret,
            redirect_uri=self.redirect_uri
        )

        try:
            token = await client.fetch_token(
                self.token_url,
                code=code,
                grant_type="authorization_code"
            )
            return token
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Failed to exchange code for token: {str(e)}"
            )

    async def get_userinfo(self, access_token: str) -> Dict[str, Any]:
        """
        Fetch user information from OIDC userinfo endpoint.

        Args:
            access_token: Access token from token exchange

        Returns:
            User information (sub, email, name, etc.)
        """
        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(
                    self.userinfo_url,
                    headers={"Authorization": f"Bearer {access_token}"}
                )
                response.raise_for_status()
                return response.json()
            except Exception as e:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail=f"Failed to fetch user info: {str(e)}"
                )


class SessionManager:
    """Manage user sessions in Redis."""

    def __init__(self):
        self.redis_url = settings.redis_url
        self.max_age = settings.session_max_age
        self._redis: Optional[aioredis.Redis] = None

    async def get_redis(self) -> aioredis.Redis:
        """Get or create Redis connection."""
        if self._redis is None:
            self._redis = await aioredis.from_url(self.redis_url)
        return self._redis

    async def close(self):
        """Close Redis connection."""
        if self._redis:
            await self._redis.close()

    def generate_session_id(self) -> str:
        """Generate a secure random session ID."""
        return secrets.token_urlsafe(32)

    async def create_session(self, session_id: str, user_data: Dict[str, Any]) -> None:
        """
        Create a new session in Redis.

        Args:
            session_id: Unique session identifier
            user_data: User information to store.
                       Accepts both OIDC fields (sub, preferred_username) and
                       simple auth fields (user_id, username) transparently.
        """
        redis = await self.get_redis()
        session_key = f"session:{session_id}"

        # Normalize field names: support both OIDC and simple auth formats
        mapping = {
            "user_id": str(user_data.get("user_id", user_data.get("sub", ""))),
            "email": str(user_data.get("email", "")),
            "name": str(user_data.get("name", user_data.get("display_name", ""))),
            "username": str(user_data.get("username", user_data.get("preferred_username", ""))),
            "is_admin": str(user_data.get("is_admin", "false")),
            "auth_method": str(user_data.get("auth_method", "simple")),
            "id_token": str(user_data.get("id_token", "")),
            "plex_token": str(user_data.get("plex_token", "")),
        }

        await redis.hset(session_key, mapping=mapping)
        await redis.expire(session_key, self.max_age)

    async def get_session(self, session_id: str) -> Optional[Dict[str, str]]:
        """
        Retrieve session data from Redis.

        Args:
            session_id: Session identifier

        Returns:
            Session data or None if not found/expired
        """
        redis = await self.get_redis()
        session_key = f"session:{session_id}"

        session_data = await redis.hgetall(session_key)

        if not session_data:
            return None

        # Refresh expiration on access
        await redis.expire(session_key, self.max_age)

        # Convert bytes to strings
        return {k.decode(): v.decode() for k, v in session_data.items()}

    async def delete_session(self, session_id: str) -> None:
        """
        Delete a session (logout).

        Args:
            session_id: Session identifier
        """
        redis = await self.get_redis()
        session_key = f"session:{session_id}"
        await redis.delete(session_key)

    async def store_state(self, state: str) -> None:
        """
        Store CSRF state temporarily (5 minutes).

        Args:
            state: CSRF state token
        """
        redis = await self.get_redis()
        state_key = f"state:{state}"
        await redis.setex(state_key, 300, "1")  # 5 minute expiration

    async def verify_state(self, state: str) -> bool:
        """
        Verify and consume CSRF state token.

        Args:
            state: CSRF state token to verify

        Returns:
            True if valid, False otherwise
        """
        redis = await self.get_redis()
        state_key = f"state:{state}"

        # Check if state exists
        exists = await redis.exists(state_key)

        if exists:
            # Delete to prevent reuse
            await redis.delete(state_key)
            return True

        return False

    async def store_plex_pin(self, state: str, pin_id: int, client_id: str) -> None:
        """Store Plex PIN data temporarily (5 minutes) for native Plex auth flow."""
        redis = await self.get_redis()
        key = f"plex_pin:{state}"
        await redis.hset(key, mapping={"pin_id": str(pin_id), "client_id": client_id})
        await redis.expire(key, 300)

    async def get_plex_pin(self, state: str) -> Optional[Dict[str, str]]:
        """Retrieve and consume Plex PIN data."""
        redis = await self.get_redis()
        key = f"plex_pin:{state}"
        data = await redis.hgetall(key)
        if data:
            await redis.delete(key)
            return {k.decode(): v.decode() for k, v in data.items()}
        return None


# Global instances
# OIDCClient is only instantiated when Authentik is configured
oidc_client = OIDCClient() if settings.authentik_url else None
session_manager = SessionManager()
