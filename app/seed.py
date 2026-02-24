"""
Seed the database with defaults on first startup.
"""

import logging
from passlib.hash import bcrypt
from sqlalchemy.orm import Session
from app.models import User, Setting

logger = logging.getLogger(__name__)

DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "admin123"

# Default branding/theme settings (inserted only if missing)
DEFAULT_SETTINGS = {
    "branding.app_name": ("HMS Dashboard", "Application display name"),
    "branding.tagline": ("Home Media Server Management", "Tagline shown on login page"),
    "branding.logo_url": ("", "URL to custom logo image"),
    "branding.show_default_credentials": ("true", "Show default credentials hint on login page"),
    "theme.color_primary": ("#125793", "Primary brand color (Baltic Blue)"),
    "theme.color_secondary": ("#2C6DA1", "Secondary brand color (Cornflower Ocean)"),
    "theme.color_accent": ("#4684B0", "Accent color (Steel Blue)"),
    "theme.color_text": ("#BEEEF4", "Text color (Frosted Blue)"),
    "theme.color_background": ("#000000", "Background color"),
    "theme.font": ("Spline Sans", "Google Font family name"),
    "theme.dark_mode": ("true", "Enable dark mode"),
    "theme.custom_css": ("", "Custom CSS injected into all pages"),
    # Feature flags
    "features.show_requests": ("false", "Show Overseerr iframe Requests page in sidebar"),
    # Sidebar labels
    "sidebar.label_home": ("Home", "Sidebar label for Home page"),
    "sidebar.label_requests": ("Requests", "Sidebar label for Requests iframe page"),
    "sidebar.label_requests2": ("Requests", "Sidebar label for native Requests page"),
    "sidebar.label_issues": ("Issues", "Sidebar label for Issues page"),
    "sidebar.label_settings": ("Settings", "Sidebar label for Settings page"),
}


def seed_default_admin(db: Session) -> None:
    """Create a default admin user if no users exist."""
    user_count = db.query(User).count()
    if user_count > 0:
        return

    password_hash = bcrypt.hash(DEFAULT_ADMIN_PASSWORD)
    admin = User(
        username=DEFAULT_ADMIN_USERNAME,
        email="admin@hmserver.tv",
        display_name="Admin",
        password_hash=password_hash,
        is_admin=True,
        is_active=True,
    )
    db.add(admin)
    db.commit()
    logger.warning(
        "Created default admin user '%s' with default password. "
        "Change the password immediately.",
        DEFAULT_ADMIN_USERNAME,
    )


def seed_default_settings(db: Session) -> None:
    """Insert default branding/theme settings if they don't exist.
    Uses per-key commits to handle race conditions with multiple workers."""
    from sqlalchemy.exc import IntegrityError

    added = 0
    for key, (value, description) in DEFAULT_SETTINGS.items():
        existing = db.query(Setting).filter(Setting.key == key).first()
        if existing:
            continue
        try:
            db.add(Setting(key=key, value=value, description=description))
            db.commit()
            added += 1
        except IntegrityError:
            db.rollback()  # Another worker already inserted it

    if added:
        logger.info("Seeded %d default branding/theme settings", added)
