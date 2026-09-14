"""
OIDC Authentication with Authentik.
Handles login, callback, logout, and session management.
"""

from authlib.integrations.httpx_client import AsyncOAuth2Client
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any
import httpx
import logging
import secrets
import time
from app.config import settings
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)


class OIDCClient:
    """OIDC client for Authentik authentication."""

    def __init__(
        self,
        authentik_url: Optional[str] = None,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        redirect_uri: Optional[str] = None,
    ):
        base_url = (authentik_url or settings.authentik_url or "").rstrip("/")
        if not base_url:
            raise ValueError("authentik_url must be provided or set via AUTHENTIK_URL env var")
        self.client_id = client_id or settings.authentik_client_id
        self.client_secret = client_secret or settings.authentik_client_secret
        self.redirect_uri = redirect_uri or settings.effective_redirect_uri
        self.authorize_url = f"{base_url}/application/o/authorize/"
        self.token_url = f"{base_url}/application/o/token/"
        self.userinfo_url = f"{base_url}/application/o/userinfo/"

    async def get_authorization_url(
        self, state: str, code_challenge: str = "", nonce: str = ""
    ) -> str:
        """
        Generate authorization URL for OIDC login flow.

        Args:
            state: CSRF protection state parameter
            code_challenge: PKCE S256 code challenge (base64url, no padding)
            nonce: OIDC nonce to bind the id_token to this browser's flow

        Returns:
            Authorization URL to redirect user to
        """
        client = AsyncOAuth2Client(
            client_id=self.client_id,
            redirect_uri=self.redirect_uri,
            scope="openid profile email plex"
        )

        extra: Dict[str, Any] = {}
        if code_challenge:
            # PKCE (S256): the matching code_verifier is sent at token exchange.
            extra["code_challenge"] = code_challenge
            extra["code_challenge_method"] = "S256"
        if nonce:
            extra["nonce"] = nonce

        uri, _ = client.create_authorization_url(
            self.authorize_url,
            state=state,
            **extra,
        )

        return uri

    async def exchange_code_for_token(self, code: str, code_verifier: str = "") -> Dict[str, Any]:
        """
        Exchange authorization code for access token.

        Args:
            code: Authorization code from callback
            code_verifier: PKCE code_verifier matching the challenge sent at /login

        Returns:
            Token response with access_token, id_token, etc.
        """
        client = AsyncOAuth2Client(
            client_id=self.client_id,
            client_secret=self.client_secret,
            redirect_uri=self.redirect_uri
        )

        kwargs: Dict[str, Any] = {}
        if code_verifier:
            kwargs["code_verifier"] = code_verifier

        try:
            token = await client.fetch_token(
                self.token_url,
                code=code,
                grant_type="authorization_code",
                **kwargs,
            )
            return token
        except Exception as e:
            # Log the detail server-side; return a generic message to the client
            # so upstream error text is never disclosed (L15).
            logger.error("OIDC token exchange failed: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication failed"
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
                # Log server-side; return a generic message to the client (L15).
                logger.error("OIDC userinfo fetch failed: %s", str(e))
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Authentication failed"
                )


class SessionManager:
    """Manage user sessions in Redis."""

    def __init__(self):
        self.redis_url = settings.redis_url
        self.max_age = settings.session_max_age
        # Hard ceiling on session age, independent of the rolling `max_age` TTL
        # that get_session refreshes on every access. A session older than this
        # is rejected even if it has been used continuously (L10).
        self.absolute_max_age = 30 * 24 * 60 * 60  # 30 days
        self._redis: Optional[aioredis.Redis] = None

    @staticmethod
    def _user_sessions_key(auth_method: str, user_id: str) -> str:
        """Redis set key indexing all live session ids for a given identity.

        Keyed on (auth_method, user_id) so identities in different auth realms
        that share a numeric/string id never collide.
        """
        return f"user_sessions:{auth_method}:{user_id}"

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
            "avatar_url": str(user_data.get("avatar_url", "")),
            # Creation time for the absolute-lifetime ceiling enforced in
            # get_session. Extra field only — older sessions without it are
            # grandfathered (see get_session).
            "created_at": str(int(time.time())),
        }

        await redis.hset(session_key, mapping=mapping)
        await redis.expire(session_key, self.max_age)

        # Index the session under its identity so credential changes can revoke
        # a user's other sessions (L10). The set self-expires at the absolute
        # ceiling; stale ids left behind are harmless (deleting a missing key is
        # a no-op).
        user_id = mapping["user_id"]
        auth_method = mapping["auth_method"]
        if user_id:
            index_key = self._user_sessions_key(auth_method, user_id)
            await redis.sadd(index_key, session_id)
            await redis.expire(index_key, self.absolute_max_age)

    async def update_session(self, session_id: str, fields: Dict[str, Any]) -> None:
        """
        Merge fields into an existing session hash.

        Used to attach the user's Kavita JWT after the OIDC handoff, so the
        ebook proxy can act on their behalf. No-ops when the session has already
        expired, so a late callback cannot resurrect one.

        Args:
            session_id: Session identifier
            fields: Field names and values to merge in
        """
        redis = await self.get_redis()
        session_key = f"session:{session_id}"

        if not await redis.exists(session_key):
            return

        await redis.hset(session_key, mapping={k: str(v) for k, v in fields.items()})
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

        # Convert bytes to strings
        decoded = {k.decode(): v.decode() for k, v in session_data.items()}

        # Enforce the absolute lifetime ceiling (L10). Sessions created before
        # this field existed lack created_at and are grandfathered (no ceiling);
        # they drain out via the rolling TTL / restart-driven Redis flush.
        created_at = decoded.get("created_at")
        if created_at:
            try:
                if int(time.time()) - int(created_at) > self.absolute_max_age:
                    await redis.delete(session_key)
                    return None
            except ValueError:
                pass  # malformed created_at — treat as grandfathered

        # Refresh the rolling expiration on access
        await redis.expire(session_key, self.max_age)

        return decoded

    async def delete_session(self, session_id: str) -> None:
        """
        Delete a session (logout).

        Args:
            session_id: Session identifier
        """
        redis = await self.get_redis()
        session_key = f"session:{session_id}"
        await redis.delete(session_key)

    async def delete_user_sessions(
        self,
        auth_method: str,
        user_id: str,
        exclude_session_id: Optional[str] = None,
    ) -> int:
        """Revoke every session for an identity, optionally sparing one.

        Used after a credential change so old sessions can't outlive the
        password that authorised them (L10). Returns the number deleted.
        """
        if not user_id:
            return 0
        redis = await self.get_redis()
        index_key = self._user_sessions_key(auth_method, str(user_id))
        members = await redis.smembers(index_key)
        deleted = 0
        for member in members:
            sid = member.decode() if isinstance(member, (bytes, bytearray)) else str(member)
            if exclude_session_id and sid == exclude_session_id:
                continue
            await redis.delete(f"session:{sid}")
            await redis.srem(index_key, sid)
            deleted += 1
        return deleted

    async def store_oidc_flow(self, flow_id: str, data: Dict[str, str], ttl: int = 300) -> None:
        """Persist per-login OIDC flow data (state, PKCE verifier, nonce).

        Keyed by a random flow id that is handed to the browser in a
        short-lived cookie, so the callback can prove the flow was started by
        *this* browser (M4).
        """
        redis = await self.get_redis()
        flow_key = f"oidc_flow:{flow_id}"
        await redis.hset(flow_key, mapping={k: str(v) for k, v in data.items()})
        await redis.expire(flow_key, ttl)

    async def consume_oidc_flow(self, flow_id: str) -> Optional[Dict[str, str]]:
        """Fetch and delete a stored OIDC flow (single use). None if absent."""
        redis = await self.get_redis()
        flow_key = f"oidc_flow:{flow_id}"
        data = await redis.hgetall(flow_key)
        if not data:
            return None
        await redis.delete(flow_key)
        return {k.decode(): v.decode() for k, v in data.items()}

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


def get_oidc_client(db: Session) -> Optional[OIDCClient]:
    """Build an OIDCClient from Settings DB, falling back to env vars.

    Args:
        db: SQLAlchemy Session

    Returns:
        OIDCClient if Authentik is configured, None otherwise
    """
    from app.models import Setting

    def get_setting(key: str) -> str:
        s = db.query(Setting).filter(Setting.key == key).first()
        return s.value if s else ""

    url = get_setting("integration.authentik.url")
    client_id = get_setting("integration.authentik.client_id")
    client_secret = get_setting("integration.authentik.client_secret")

    if url and client_id and client_secret:
        logger.debug("Using Authentik config from Settings DB")
        return OIDCClient(
            authentik_url=url,
            client_id=client_id,
            client_secret=client_secret,
        )

    # Fall back to env vars for backwards compatibility
    if settings.authentik_url and settings.authentik_client_id:
        logger.debug("Using Authentik config from env vars (fallback)")
        return OIDCClient()

    return None


# Global instances
# OIDCClient is only instantiated when Authentik is configured (env vars).
# For DB-based config, use get_oidc_client(db) per-request instead.
oidc_client = OIDCClient() if settings.authentik_url else None
session_manager = SessionManager()
