"""
Setup wizard router — first-run configuration.

Guides the admin through initial account creation and optional
integration setup. Once completed, the wizard is permanently locked
out via the `setup.completed` setting.
"""

import logging
import secrets

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from passlib.hash import bcrypt
from pydantic import BaseModel, field_validator

from app.database import SessionLocal
from app.limiter import limiter
from app.models import Setting, User

logger = logging.getLogger(__name__)

router = APIRouter()

# In-process cache — avoids a DB hit on every single request
_setup_done: bool = False


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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/setup", response_class=HTMLResponse, tags=["Setup"])
async def setup_page():
    """Serve the setup wizard page (or redirect if already completed)."""
    if is_setup_completed():
        return RedirectResponse(url="/login", status_code=302)

    try:
        with open("/app/app/static/setup.html", "r") as f:
            return HTMLResponse(content=f.read())
    except FileNotFoundError:
        return JSONResponse(
            status_code=404,
            content={"detail": "Setup page not found. Static files missing."},
        )


@router.post("/api/setup/complete", tags=["Setup"])
@limiter.limit("5/minute")
async def complete_setup(request: Request, body: SetupRequest):
    """Finalise initial setup: create admin user, store config."""
    if is_setup_completed():
        return JSONResponse(
            status_code=403,
            content={"detail": "Setup has already been completed."},
        )

    # Validate passwords match
    if body.password != body.password_confirm:
        return JSONResponse(
            status_code=400,
            content={"detail": "Passwords do not match."},
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

        db.commit()

        # Update in-process secret key so sessions work immediately
        from app.config import settings as app_settings
        app_settings.app_secret_key = secret_key

        # Set module cache
        global _setup_done
        _setup_done = True

        logger.info("Setup completed — admin user '%s' created", body.username)

        return JSONResponse(
            status_code=200,
            content={"detail": "Setup completed successfully.", "redirect": "/login"},
        )
    except Exception as e:
        db.rollback()
        logger.error("Setup failed: %s", e)
        return JSONResponse(
            status_code=500,
            content={"detail": f"Setup failed: {e}"},
        )
    finally:
        db.close()
