"""
OIDC Authentication routes - Plex login via Authentik.
Handles OIDC login redirect, callback with admin determination, and user info.
Logout is handled by simple_auth.py (shared session clearing).
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
import base64
import hashlib
import json
import secrets
import logging
import httpx

from app.auth import oidc_client, session_manager, get_oidc_client
from app.config import settings
from app.dependencies import get_current_user
from app.database import get_db
from app.limiter import limiter
from app.models import Setting
from app.integrations import seerr
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)
router = APIRouter()

PLEX_TIMEOUT = 5.0

# Short-lived cookie carrying the random id of a per-login OIDC flow (state +
# PKCE verifier + nonce live in Redis under that id). Binds the callback to the
# browser that started the flow (M4).
OIDC_FLOW_COOKIE = "webservarr_oidc_flow"


# ---------------------------------------------------------------------------
# Feature-toggle enforcement (H1a)
#
# The login page reads the same settings via /api/branding to decide which auth
# buttons to render (see branding.py build_branding). These mirror that logic
# exactly so a disabled method is refused server-side, not merely hidden.
# ---------------------------------------------------------------------------

def _get_feature_value(db: Session, key: str, default: str) -> str:
    """Read a features.* toggle from the settings table, falling back to the
    same default build_branding uses when the row is absent."""
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is not None and row.value is not None:
        return row.value
    return default


def _plex_auth_enabled(db: Session) -> bool:
    """Direct-Plex login enabled? (default off; on unless explicitly 'false')."""
    return _get_feature_value(db, "features.show_plex_auth", "false") != "false"


def _authentik_auth_enabled(db: Session) -> bool:
    """Authentik/OIDC login enabled? (default off; on only when 'true')."""
    return _get_feature_value(db, "features.show_authentik_auth", "false") == "true"


# ---------------------------------------------------------------------------
# PKCE / id_token helpers (M4)
# ---------------------------------------------------------------------------

def _pkce_challenge(verifier: str) -> str:
    """Compute the S256 PKCE code_challenge for a verifier (base64url, no pad)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _decode_jwt_payload(token: str) -> dict:
    """Best-effort decode of a JWT's payload segment (no signature check).

    Only used to read the `nonce` claim of the id_token, which arrives over the
    authenticated back-channel token exchange (TLS + client_secret), so the
    browser never supplies it. Returns {} on any malformed input.
    """
    if not token or token.count(".") < 2:
        return {}
    payload_b64 = token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)  # restore base64 padding
    try:
        return json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")))
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Plex server membership + ownership (H1b, H2, M1)
#
# All plex.tv calls verify TLS (valid public cert); the only relaxed-TLS hop is
# the LAN {plex_url}/identity lookup, consistent with the rest of the codebase's
# self-signed-LAN Plex calls. New membership/id logic is kept self-contained in
# this router (httpx directly) — it does not import app/integrations/plex.py.
# ---------------------------------------------------------------------------

def _plex_client_headers(db: Session) -> dict:
    """Client-identity headers required by plex.tv API endpoints.

    plex.tv's /api/v2/resources (and some other endpoints) return HTTP 400
    without an X-Plex-Client-Identifier header, so every plex.tv call here must
    carry it — mirroring plex_auth._plex_headers. Reuses the app's persistent
    client id (system.plex_client_id, set on first PIN login); falls back to a
    constant so the header is never empty even before that setting exists. The
    caller merges in its own X-Plex-Token.
    """
    row = db.query(Setting).filter(Setting.key == "system.plex_client_id").first()
    client_id = (row.value if row and row.value else "") or "WebServarr"
    return {
        "Accept": "application/json",
        "X-Plex-Product": "WebServarr",
        "X-Plex-Version": "1.0",
        "X-Plex-Platform": "Web",
        "X-Plex-Client-Identifier": client_id,
    }


async def _fetch_owner_account(db: Session) -> dict | None:
    """Fetch the plex.tv account (id, email, ...) that owns the configured
    server, using the stored owner token. TLS verified. None if unavailable."""
    token_setting = db.query(Setting).filter(Setting.key == "integration.plex.token").first()
    if not token_setting or not token_setting.value:
        logger.warning("Plex integration not configured, cannot determine server owner")
        return None
    try:
        async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
            resp = await client.get(
                "https://plex.tv/api/v2/user",
                headers={**_plex_client_headers(db), "X-Plex-Token": token_setting.value},
            )
            if resp.status_code != 200:
                logger.warning("Failed to fetch Plex owner account: HTTP %d", resp.status_code)
                return None
            return resp.json()
    except Exception as e:
        logger.error("Error fetching Plex owner account: %s", str(e))
        return None


async def _fetch_server_identifiers_for_token(
    plex_token: str, base_headers: dict, owned_only: bool = False
) -> set:
    """Return the set of Plex server machineIdentifiers (clientIdentifier) that a
    given token can see on plex.tv. `base_headers` must carry the Plex client
    identity (see _plex_client_headers) or plex.tv answers 400. TLS verified.
    Raises on transport error so callers can fail closed."""
    ids: set = set()
    if not plex_token:
        return ids
    async with httpx.AsyncClient(timeout=PLEX_TIMEOUT) as client:
        # Token in a header (never the query string) so it can't leak via URL logging.
        resp = await client.get(
            "https://plex.tv/api/v2/resources",
            params={"includeHttps": 1},
            headers={**base_headers, "X-Plex-Token": plex_token},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"plex.tv resources returned HTTP {resp.status_code}")
        for res in (resp.json() or []):
            provides = (res.get("provides") or "").split(",")
            if "server" not in provides:
                continue
            if owned_only and not res.get("owned"):
                continue
            cid = res.get("clientIdentifier")
            if cid:
                ids.add(str(cid))
    return ids


async def _fetch_configured_server_identifiers(db: Session) -> set:
    """Machine identifiers that count as 'the configured server'.

    Normally just the one server at integration.plex.url (asked directly via
    /identity). Falls back to every server the owner token owns on plex.tv when
    the LAN server is unreachable — which still covers the owner and survives a
    Plex outage. Empty set => cannot determine => caller must fail closed.
    """
    url_setting = db.query(Setting).filter(Setting.key == "integration.plex.url").first()
    token_setting = db.query(Setting).filter(Setting.key == "integration.plex.token").first()
    plex_url = (url_setting.value if url_setting and url_setting.value else "").rstrip("/")
    owner_token = token_setting.value if token_setting and token_setting.value else ""

    ids: set = set()

    if plex_url:
        try:
            # LAN Plex commonly uses a self-signed cert (same as the rest of the
            # codebase's LAN Plex calls) — verify is relaxed on THIS LAN hop only,
            # never on the plex.tv calls above/below.
            async with httpx.AsyncClient(timeout=PLEX_TIMEOUT, verify=False) as client:
                resp = await client.get(
                    f"{plex_url}/identity",
                    headers={"X-Plex-Token": owner_token, "Accept": "application/json"},
                )
                if resp.status_code == 200:
                    container = (resp.json() or {}).get("MediaContainer") or {}
                    mid = container.get("machineIdentifier")
                    if mid:
                        ids.add(str(mid))
        except Exception as e:
            logger.warning(
                "Plex /identity lookup failed; falling back to plex.tv owner resources: %s",
                str(e),
            )

    if not ids and owner_token:
        try:
            ids |= await _fetch_server_identifiers_for_token(
                owner_token, _plex_client_headers(db), owned_only=True
            )
        except Exception as e:
            logger.error("Plex owner resources lookup failed: %s", str(e))

    return ids


async def _user_has_server_access(plex_token: str, db: Session) -> bool:
    """True if the Plex user behind `plex_token` can access the configured
    server (server owner OR a shared/home user). Fails CLOSED: any error, or an
    inability to positively confirm membership, returns False.
    """
    if not plex_token:
        return False

    authorized_ids = await _fetch_configured_server_identifiers(db)
    if not authorized_ids:
        logger.error(
            "Plex membership check: could not determine the configured server's "
            "identifier — denying access (fail closed)"
        )
        return False

    try:
        user_ids = await _fetch_server_identifiers_for_token(plex_token, _plex_client_headers(db))
    except Exception as e:
        logger.error("Plex membership check: failed to fetch user's servers — denying: %s", str(e))
        return False

    if authorized_ids & user_ids:
        return True

    logger.warning("Plex membership check: account has no access to the configured server — denying")
    return False


async def _is_plex_server_owner(
    db: Session,
    user_plex_id: str = "",
    email: str = "",
    email_verified: bool = False,
) -> bool:
    """Decide admin (Plex server owner) status.

    Primary, preferred signal: the logging-in user's IMMUTABLE plex.tv account
    id equals the owner token's account id. This is not user-editable, so it
    cannot be spoofed the way the old email comparison could (H2).

    The explicit `system.admin_email` setting is kept only as an optional
    secondary allowlist, and is honoured ONLY for a verified email — an
    unverified or user-editable email is never sufficient on its own. The server
    owner always passes via the id match regardless, so this fallback only ever
    grants admin to a *non-owner* whose verified email the operator allowlisted.
    """
    owner = await _fetch_owner_account(db)

    # Primary: immutable plex.tv account id match.
    if user_plex_id and owner:
        owner_id = str(owner.get("id") or owner.get("uuid") or "")
        if owner_id and str(user_plex_id) == owner_id:
            return True

    # Secondary: explicit admin-email allowlist — verified emails only.
    if email and email_verified:
        admin_email_setting = db.query(Setting).filter(Setting.key == "system.admin_email").first()
        if admin_email_setting and admin_email_setting.value:
            if email.lower() == admin_email_setting.value.lower():
                logger.info("Admin granted via verified system.admin_email allowlist match")
                return True

    return False


@router.get("/login")
@limiter.limit("5/minute")
async def oidc_login(request: Request, db: Session = Depends(get_db)):
    """
    Initiate OIDC login flow.
    Redirects user to Authentik, which shows the Plex login option.
    """
    # Prefer DB-based config, fall back to global (env var) client
    client = get_oidc_client(db) or oidc_client
    if not client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC authentication is not configured. Set Authentik settings in the UI or AUTHENTIK_URL in environment.",
        )

    # Enforce the auth toggle server-side (H1a): a hidden button must also be a
    # closed door.
    if not _authentik_auth_enabled(db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authentik authentication is disabled",
        )

    # Derive redirect URI from the incoming request (not from config).
    # Behind a reverse proxy / Cloudflare Tunnel, base_url reports http://
    # so honour X-Forwarded-Proto to get the real scheme.
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    redirect_uri = f"{scheme}://{request.url.netloc}/auth/callback"
    client.redirect_uri = redirect_uri

    # Per-login flow secrets (M4): CSRF state, a PKCE verifier, and a nonce.
    # All three live in Redis under a random flow id; the browser gets only the
    # flow id, in a short-lived HttpOnly cookie. The callback proves the flow was
    # started by *this* browser (state bound to the cookie, not just "exists").
    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)  # 43-128 unreserved chars (RFC 7636)
    nonce = secrets.token_urlsafe(32)
    flow_id = secrets.token_urlsafe(32)
    await session_manager.store_oidc_flow(
        flow_id,
        {"state": state, "code_verifier": code_verifier, "nonce": nonce},
    )

    # Send code_challenge (S256) + nonce in the authorization request.
    auth_url = await client.get_authorization_url(
        state,
        code_challenge=_pkce_challenge(code_verifier),
        nonce=nonce,
    )

    logger.info("OIDC login initiated, redirecting to Authentik")
    response = RedirectResponse(url=auth_url)
    response.set_cookie(
        key=OIDC_FLOW_COOKIE,
        value=flow_id,
        max_age=300,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return response


@router.get("/callback")
async def oidc_callback(request: Request, code: str, state: str, db: Session = Depends(get_db)):
    """
    OIDC callback endpoint.
    Handles the redirect from Authentik after Plex authentication.
    Determines admin status by checking if the user is the Plex server owner.
    """
    # Prefer DB-based config, fall back to global (env var) client
    client = get_oidc_client(db) or oidc_client
    if not client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC authentication is not configured",
        )

    # Enforce the auth toggle server-side (H1a).
    if not _authentik_auth_enabled(db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authentik authentication is disabled",
        )

    # Derive redirect URI from the incoming request (must match what /login sent)
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    client.redirect_uri = f"{scheme}://{request.url.netloc}/auth/callback"

    # Browser-bind the flow (M4): the state must match the one stored under the
    # flow id in *this browser's* cookie — proving existence in Redis is not
    # enough (that only proves the app issued it, enabling login-CSRF).
    flow_id = request.cookies.get(OIDC_FLOW_COOKIE)
    flow = await session_manager.consume_oidc_flow(flow_id) if flow_id else None
    if not flow or not secrets.compare_digest(flow.get("state", ""), state):
        logger.error("OIDC callback: missing/mismatched flow cookie or state")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired login session. Please start again.",
        )
    code_verifier = flow.get("code_verifier", "")
    expected_nonce = flow.get("nonce", "")

    try:
        # Exchange code for tokens, sending the PKCE code_verifier.
        token_response = await client.exchange_code_for_token(code, code_verifier=code_verifier)
        access_token = token_response.get("access_token")

        if not access_token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="No access token received",
            )

        # Validate the id_token nonce against the one we generated for this flow
        # (M4). The id_token arrives over the authenticated back-channel, so the
        # browser never supplies it; a mismatch means replay/injection.
        id_token = token_response.get("id_token", "")
        if id_token:
            id_claims = _decode_jwt_payload(id_token)
            if expected_nonce and id_claims.get("nonce") != expected_nonce:
                logger.error("OIDC callback: id_token nonce mismatch")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid authentication response. Please start again.",
                )
        else:
            logger.warning("OIDC callback: no id_token returned; nonce not validated")

        # Get user information from Authentik
        userinfo = await client.get_userinfo(access_token)

        user_email = userinfo.get("email", "")
        # OIDC email_verified claim (bool or "true"), used only to gate the
        # secondary admin-email allowlist in _is_plex_server_owner.
        _ev = userinfo.get("email_verified")
        email_verified = _ev is True or str(_ev).lower() == "true"

        plex_token = userinfo.get("plex_token", "")

        # Fetch the Plex account once for BOTH the avatar and the immutable
        # account id (used for the id-based admin decision, H2).
        avatar_url = ""
        plex_user_id = ""
        if plex_token:
            try:
                async with httpx.AsyncClient(timeout=10.0) as http_client:
                    plex_resp = await http_client.get(
                        "https://plex.tv/api/v2/user",
                        headers={
                            "Accept": "application/json",
                            "X-Plex-Token": plex_token,
                        },
                    )
                    if plex_resp.status_code == 200:
                        _pj = plex_resp.json()
                        avatar_url = _pj.get("thumb", "")
                        plex_user_id = str(_pj.get("id", "") or "")
            except Exception as e:
                logger.warning("Failed to fetch Plex account during OIDC login: %s", str(e))

        # Require Plex server membership when the OIDC identity carries a Plex
        # token (H1b). Sources without a plex_token are gated by Authentik itself.
        if plex_token and not await _user_has_server_access(plex_token, db):
            logger.warning("OIDC login denied: %s has no access to the configured Plex server", user_email)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your account does not have access to this Plex server.",
            )

        # Determine admin status by immutable Plex account id (H2).
        is_admin = await _is_plex_server_owner(
            db,
            user_plex_id=plex_user_id,
            email=user_email,
            email_verified=email_verified,
        )

        # Build session data
        session_data = {
            "user_id": userinfo.get("sub", ""),
            "username": userinfo.get("preferred_username", userinfo.get("name", "")),
            "display_name": userinfo.get("name", ""),
            "email": user_email,
            "is_admin": str(is_admin).lower(),
            "auth_method": "oidc",
            "id_token": id_token,
            "plex_token": plex_token,
            "avatar_url": avatar_url,
        }

        session_id = session_manager.generate_session_id()
        await session_manager.create_session(session_id, session_data)

        logger.info(
            "OIDC login successful: %s (admin=%s)",
            user_email,
            is_admin,
        )

        # Authenticate with Seerr SSO (non-blocking — failure doesn't affect login)
        seerr_sid = None
        if plex_token:
            try:
                seerr_sid = await seerr.authenticate_with_plex_token(plex_token)
                if seerr_sid:
                    logger.info("Seerr SSO successful for %s", user_email)
                else:
                    logger.debug("Seerr SSO returned no session for %s", user_email)
            except Exception as e:
                logger.warning("Seerr SSO failed (non-fatal): %s", str(e))

        # Redirect to dashboard after successful OIDC authentication
        response = RedirectResponse(url="/", status_code=302)
        response.set_cookie(
            key=settings.session_cookie_name,
            value=session_id,
            max_age=settings.session_max_age,
            httponly=True,
            secure=True,
            samesite="lax",
        )

        # Set Seerr session cookie on parent domain for iframe SSO
        if seerr_sid:
            host = request.url.hostname or ""
            cookie_kwargs: dict = {
                "key": "connect.sid",
                "value": seerr_sid,
                "httponly": True,
                "secure": True,
                "samesite": "none",
                "path": "/",
            }
            if "." in host:
                cookie_kwargs["domain"] = "." + host.split(".", 1)[1]
            response.set_cookie(**cookie_kwargs)

        # Flow is consumed — clear its cookie.
        response.delete_cookie(key=OIDC_FLOW_COOKIE, path="/")

        return response

    except HTTPException:
        raise
    except Exception as e:
        # Log the detail server-side; return a generic message to the client (L15).
        logger.exception("OIDC authentication error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Authentication failed",
        )


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
        "avatar_url": current_user.get("avatar_url", ""),
    }
