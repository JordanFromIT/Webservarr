"""
Setup wizard router — first-run configuration.

Guides the admin through initial account creation and optional
integration setup. Once completed, the wizard is permanently locked
out via the `setup.completed` setting.
"""

import hmac
import logging
import secrets
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from passlib.hash import bcrypt
from pydantic import BaseModel, field_validator
from sqlalchemy.exc import IntegrityError

from app.database import SessionLocal
from app.limiter import limiter
from app.models import Setting, User
from app.utils import is_safe_integration_url

# Settings key under which the shared first-run setup token is persisted so all
# worker processes validate against ONE value (L11).
SETUP_TOKEN_KEY = "system.setup_token"

logger = logging.getLogger(__name__)

router = APIRouter()

# In-process cache — avoids a DB hit on every single request
_setup_done: bool = False

# One-time, randomly-generated token that must be supplied to complete first-run
# setup. It is printed to the container logs at startup and never served to a
# client, so an anonymous attacker who reaches the origin before the operator
# cannot race to claim the admin account.
_setup_token: str = ""


def get_or_create_setup_token() -> str:
    """Return the shared first-run setup token, generating + persisting it on the
    first call. Empty once setup is done.

    The token is stored in the settings table (SETUP_TOKEN_KEY) so every worker
    process validates against the SAME value. A module global alone gave each of
    the 2 workers its own token, 403-ing ~half of submissions (L11). The key
    contains "token", so the admin settings API masks it; it is never served to
    a client and is deleted when setup completes. The module global still acts as
    a per-process cache.
    """
    global _setup_token
    if is_setup_completed():
        return ""
    if _setup_token:
        return _setup_token

    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == SETUP_TOKEN_KEY).first()
        if row and row.value:
            _setup_token = row.value
            return _setup_token

        token = secrets.token_urlsafe(24)
        db.add(Setting(
            key=SETUP_TOKEN_KEY,
            value=token,
            description="One-time first-run setup token (never served to clients)",
        ))
        try:
            db.commit()
            _setup_token = token
        except IntegrityError:
            # Another worker created it first — re-read the winning value.
            db.rollback()
            row = db.query(Setting).filter(Setting.key == SETUP_TOKEN_KEY).first()
            if row and row.value:
                _setup_token = row.value
        return _setup_token
    finally:
        db.close()


def setup_token_matches(supplied: str, expected: str) -> bool:
    """Constant-time check of a submitted setup token. Compared as bytes:
    compare_digest refuses str with non-ASCII characters (TypeError, a 500),
    so a token like "café" must simply be a wrong token. A lone surrogate
    ("\\ud800" in the JSON) survives parsing but can't be encoded; the real
    token is ASCII, so that too is a wrong token."""
    if not supplied or not expected:
        return False
    try:
        supplied_bytes = supplied.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(supplied_bytes, expected.encode("utf-8"))


def is_setup_completed() -> bool:
    """Check whether initial setup has already been completed.

    Uses a module-level cache so only the first call (per process) touches
    the database.
    """
    global _setup_done
    if _setup_done:
        return True

    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == "setup.completed").first()
        if row and row.value == "true":
            _setup_done = True
            return True
    finally:
        db.close()

    return False


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class SetupRequest(BaseModel):
    username: str
    password: str
    password_confirm: str
    setup_token: str = ""
    secret_key: str = ""
    plex_url: str = ""
    plex_token: str = ""

    @field_validator("username")
    @classmethod
    def username_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Username must not be empty")
        return v.strip()

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class SetupTestConnectionRequest(BaseModel):
    """The wizard's Plex test: Plex is the only integration it offers."""
    setup_token: str = ""
    service: Literal["plex"] = "plex"
    url: str = ""
    credentials: str = ""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/setup", response_class=HTMLResponse, tags=["Setup"])
async def setup_page(request: Request):
    """Serve the setup wizard page (or redirect if already completed)."""
    if is_setup_completed():
        return RedirectResponse(url="/login", status_code=302)
    from app.pages import render_page
    return render_page("setup", request, None)


@router.post("/api/setup/test-connection", tags=["Setup"])
@limiter.limit("10/minute")
async def setup_test_connection(request: Request, body: SetupTestConnectionRequest):
    """Test the Plex details on the wizard's last step.

    Nobody has a session before setup, so the wizard can't use the admin-only
    /api/admin/test-connection. This route takes the first-run setup token
    instead: the same trust as completing setup, which with that token can
    create the admin account outright. Closed once setup is done. It runs the
    status-light probe, so the token goes in a header, redirects are not
    followed and the address is checked off the event loop."""
    if is_setup_completed():
        return JSONResponse(status_code=403, content={"detail": "Setup has already been completed."})
    expected_token = get_or_create_setup_token()
    if not setup_token_matches(body.setup_token, expected_token):
        return JSONResponse(
            status_code=403,
            content={"detail": "The setup token isn't right. Go back to the first step and check it."},
        )
    from app.services.integration_health import probe_one
    result = await probe_one("plex", {
        "integration.plex.url": body.url.strip(),
        "integration.plex.token": body.credentials.strip(),
    })
    return {"success": result["state"] == "ok", "message": result["reason"], "state": result["state"]}


@router.post("/api/setup/complete", tags=["Setup"])
@limiter.limit("5/minute")
async def complete_setup(request: Request, body: SetupRequest):
    """Finalise initial setup: create admin user, store config."""
    if is_setup_completed():
        return JSONResponse(
            status_code=403,
            content={"detail": "Setup has already been completed."},
        )

    # Require the first-run setup token (printed to the container logs at startup).
    # Blocks an anonymous attacker from racing to create the admin account.
    expected_token = get_or_create_setup_token()
    if not setup_token_matches(body.setup_token, expected_token):
        return JSONResponse(
            status_code=403,
            content={"detail": "Invalid or missing setup token. Check the container logs for the setup token (docker compose logs webservarr | grep -i 'setup token')."},
        )

    # Validate passwords match
    if body.password != body.password_confirm:
        return JSONResponse(
            status_code=400,
            content={"detail": "Passwords do not match."},
        )

    # Validate the optional Plex URL through the same anti-SSRF guard /settings
    # uses, so the setup wizard can't seed a loopback/link-local/metadata URL
    # that the poller would later fetch (L16).
    if body.plex_url.strip() and not is_safe_integration_url(body.plex_url.strip()):
        return JSONResponse(
            status_code=400,
            content={"detail": "Plex URL must be http/https and not a loopback, link-local, or metadata address."},
        )

    # Determine secret key
    secret_key = body.secret_key.strip() or secrets.token_hex(32)

    db = SessionLocal()
    try:
        # Create admin user
        password_hash = bcrypt.hash(body.password)
        admin = User(
            username=body.username,
            email="admin@localhost",
            display_name=body.username,
            password_hash=password_hash,
            is_admin=True,
            is_active=True,
        )
        db.add(admin)

        # Store secret key (upsert — seed_secret_key may have pre-populated it)
        existing_key = db.query(Setting).filter(Setting.key == "system.secret_key").first()
        if existing_key:
            existing_key.value = secret_key
        else:
            db.add(Setting(
                key="system.secret_key",
                value=secret_key,
                description="Secret key for session signing (set during setup)",
            ))

        # Optional Plex integration
        if body.plex_url.strip():
            existing = db.query(Setting).filter(Setting.key == "integration.plex.url").first()
            if existing:
                existing.value = body.plex_url.strip()
            else:
                db.add(Setting(
                    key="integration.plex.url",
                    value=body.plex_url.strip(),
                    description="Plex server URL",
                ))

        if body.plex_token.strip():
            existing = db.query(Setting).filter(Setting.key == "integration.plex.token").first()
            if existing:
                existing.value = body.plex_token.strip()
            else:
                db.add(Setting(
                    key="integration.plex.token",
                    value=body.plex_token.strip(),
                    description="Plex authentication token",
                ))

        # Mark setup as completed
        db.add(Setting(
            key="setup.completed",
            value="true",
            description="Initial setup wizard has been completed",
        ))

        # The one-time setup token has served its purpose — remove it (L11).
        token_row = db.query(Setting).filter(Setting.key == SETUP_TOKEN_KEY).first()
        if token_row:
            db.delete(token_row)

        db.commit()

        # Update in-process secret key so sessions work immediately
        from app.config import settings as app_settings
        app_settings.app_secret_key = secret_key

        # Set module cache
        global _setup_done, _setup_token
        _setup_done = True
        _setup_token = ""

        logger.info("Setup completed — admin user '%s' created", body.username)

        return JSONResponse(
            status_code=200,
            content={"detail": "Setup completed successfully.", "redirect": "/login"},
        )
    except Exception as e:
        db.rollback()
        # Log the detail server-side; return a generic message to the client (L15).
        logger.exception("Setup failed: %s", e)
        return JSONResponse(
            status_code=500,
            content={"detail": "Setup failed. Check the server logs for details."},
        )
    finally:
        db.close()
