"""
Seed the database with defaults on first startup.
"""

import logging
import secrets
from passlib.hash import bcrypt
from sqlalchemy.orm import Session
from app.models import User, Setting

logger = logging.getLogger(__name__)

DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "admin123"

# Default branding/theme settings (inserted only if missing)
DEFAULT_SETTINGS = {
    "branding.app_name": ("WebServarr", "Application display name"),
    "branding.tagline": ("Media Server Management", "Tagline shown on login page"),
    "branding.logo_url": ("", "URL to custom logo image"),
    "theme.color_primary": ("#125793", "Primary brand color (Baltic Blue)"),
    "theme.color_secondary": ("#2C6DA1", "Secondary brand color (Cornflower Ocean)"),
    "theme.color_accent": ("#4684B0", "Accent color (Steel Blue)"),
    "theme.color_text": ("#BEEEF4", "Text color (Frosted Blue)"),
    "theme.color_background": ("#000000", "Background color"),
    "theme.font": ("Spline Sans", "Google Font family name"),
    "theme.custom_css": ("", "Custom CSS injected into all pages"),
    # Feature flags
    "features.show_requests": ("false", "Show Overseerr iframe Requests (Embed) page in sidebar"),
    "features.show_simple_auth": ("true", "Show local username/password login on login page"),
    "features.login_backgrounds": ("true", "Show rotating TMDB backgrounds on login page"),
    # Sidebar labels
    "sidebar.label_home": ("Home", "Sidebar label for Home page"),
    "sidebar.label_requests": ("Requests", "Sidebar label for Requests page"),
    "sidebar.label_requests_embed": ("Requests (Embed)", "Sidebar label for Requests (Embed) page"),
    "sidebar.label_issues": ("Issues", "Sidebar label for Issues page"),
    "sidebar.label_calendar": ("Calendar", "Sidebar label for Calendar page"),
    "sidebar.label_settings": ("Settings", "Sidebar label for Settings page"),
    # Configurable icons (Material Symbols icon names)
    "icon.nav_home": ("home", "Sidebar icon for Home page"),
    "icon.nav_requests": ("movie", "Sidebar icon for Requests page"),
    "icon.nav_requests_embed": ("download", "Sidebar icon for Requests (Embed) page"),
    "icon.nav_issues": ("report_problem", "Sidebar icon for Issues page"),
    "icon.nav_calendar": ("calendar_month", "Sidebar icon for Calendar page"),
    "icon.nav_settings": ("settings", "Sidebar icon for Settings page"),
    "icon.sidebar_logo": ("settings_input_component", "Icon shown in sidebar logo area"),
    "icon.section_services": ("health_metrics", "Homepage icon for Service Health section"),
    "icon.section_news": ("newspaper", "Homepage icon for News & Updates section"),
    "icon.section_streams": ("play_circle", "Homepage icon for Active Streams section"),
    "icon.section_releases": ("calendar_month", "Homepage icon for Upcoming Releases section"),
    # Netdata gauge labels
    "netdata.cpu_label": ("", "Label under CPU gauge (e.g. 16C/32T)"),
    "netdata.ram_label": ("", "Label under RAM gauge (e.g. 64 GB). Auto-detects if empty."),
    "netdata.net_label": ("", "Label under Network gauge (e.g. 1 Gbps). Auto-detects if empty."),
    # Notification polling intervals (seconds)
    "notifications.poll_interval_overseerr": ("60", "Seconds between Overseerr notification checks"),
    "notifications.poll_interval_monitors": ("60", "Seconds between Uptime Kuma notification checks"),
    "notifications.poll_interval_news": ("60", "Seconds between news post notification checks"),
    # Authentik OIDC (overrides env vars when set)
    "integration.authentik.url": ("", "Authentik base URL (e.g., https://auth.example.com)"),
    "integration.authentik.client_id": ("", "Authentik OAuth2 client ID"),
    "integration.authentik.client_secret": ("", "Authentik OAuth2 client secret"),
    "integration.authentik.app_slug": ("", "Authentik application slug (for logout URL)"),
    # Ticket system
    "features.show_tickets": ("true", "Show Tickets page in sidebar"),
    "sidebar.label_tickets": ("Tickets", "Sidebar label for Tickets page"),
    "icon.nav_tickets": ("confirmation_number", "Sidebar icon for Tickets page"),
    "notifications.poll_interval_tickets": ("60", "Seconds between ticket notification checks"),
}


def seed_default_admin(db: Session) -> None:
    """Create a default admin user if no users exist."""
    user_count = db.query(User).count()
    if user_count > 0:
        return

    password_hash = bcrypt.hash(DEFAULT_ADMIN_PASSWORD)
    admin = User(
        username=DEFAULT_ADMIN_USERNAME,
        email="admin@localhost",
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


def seed_vapid_keys(db: Session) -> None:
    """Generate and store VAPID key pair for Web Push notifications.
    Skips if keys already exist. Handles pywebpush not being installed."""
    from sqlalchemy.exc import IntegrityError

    # Check if public key already exists — if so, nothing to do
    existing = db.query(Setting).filter(
        Setting.key == "notifications.vapid_public_key"
    ).first()
    if existing:
        return

    try:
        from py_vapid import Vapid
        from py_vapid.utils import b64urlencode
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        logger.warning(
            "pywebpush not installed — skipping VAPID key generation. "
            "Install pywebpush>=2.0.0 to enable push notifications."
        )
        return

    # Generate a new ECDSA key pair
    vapid = Vapid()
    vapid.generate_keys()

    # Export public key as URL-safe base64 (uncompressed point, no padding)
    public_key_b64 = b64urlencode(
        vapid.public_key.public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
    )

    # Export private key as PEM string
    private_key_pem = vapid.private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    # Store both keys in Settings
    try:
        db.add(Setting(
            key="notifications.vapid_public_key",
            value=public_key_b64,
            description="VAPID public key for Web Push (auto-generated)",
        ))
        db.add(Setting(
            key="notifications.vapid_private_key",
            value=private_key_pem,
            description="VAPID private key for Web Push (auto-generated, keep secret)",
        ))
        db.commit()
        logger.info("Generated and stored VAPID key pair for Web Push notifications")
    except IntegrityError:
        db.rollback()  # Another worker already generated keys
        logger.debug("VAPID keys already exist (race condition), skipping")


def seed_secret_key(db: Session) -> str:
    """Auto-generate SECRET_KEY on first startup and store in Settings."""
    from sqlalchemy.exc import IntegrityError

    existing = db.query(Setting).filter(Setting.key == "system.secret_key").first()
    if existing:
        return existing.value

    key = secrets.token_hex(32)
    setting = Setting(
        key="system.secret_key",
        value=key,
        description="Auto-generated secret key for session signing",
    )
    db.add(setting)
    try:
        db.commit()
        logger.info("Generated and stored secret key for session signing")
    except IntegrityError:
        db.rollback()
        existing = db.query(Setting).filter(Setting.key == "system.secret_key").first()
        return existing.value if existing else key
    return key


def seed_default_news(db: Session) -> None:
    """Seed default news posts for fresh installs. Skips if any posts exist."""
    from app.models import NewsPost
    from app.routers.news import render_markdown
    from datetime import datetime, timezone

    if db.query(NewsPost).count() > 0:
        return

    now = datetime.now(timezone.utc)

    posts = [
        {
            "title": "Welcome to WebServarr",
            "content": (
                "## Welcome to WebServarr\n\n"
                "WebServarr is your self-hosted media server portal. Here's what you can do:\n\n"
                "- **Plex Streams** — Monitor active streams and playback quality in real time\n"
                "- **Service Health** — Status tiles powered by Uptime Kuma\n"
                "- **System Gauges** — CPU, RAM, and network stats from Netdata\n"
                "- **Media Requests** — Search and request movies and TV shows via Overseerr\n"
                "- **Release Calendar** — Upcoming movies and episodes from Radarr and Sonarr\n"
                "- **Notifications** — In-app and browser push notifications\n"
                "- **Theme Engine** — Colors, fonts, logos, and custom CSS\n\n"
                "Head to **Settings** to connect your integrations and get started."
            ),
            "pinned": True,
        },
        {
            "title": "[Example] Server Maintenance Notice",
            "content": (
                "> **Note:** This is an example post showing news formatting. "
                "Edit or delete it from **Settings > News**.\n\n"
                "We will be performing routine maintenance on **Saturday** from 2:00 AM to 4:00 AM.\n\n"
                "**Services affected:**\n"
                "- Media streaming (Plex)\n"
                "- Media requests (Overseerr)\n\n"
                "Expected downtime: ~30 minutes. Thank you for your patience!"
            ),
            "pinned": False,
        },
    ]

    for post_data in posts:
        content_html = render_markdown(post_data["content"])
        post = NewsPost(
            title=post_data["title"],
            content=post_data["content"],
            content_html=content_html,
            author_id="system",
            author_name="WebServarr",
            published=True,
            published_at=now,
            pinned=post_data["pinned"],
        )
        db.add(post)

    db.commit()
    logger.info("Seeded %d default news posts", len(posts))


def migrate_news_rebrand(db: Session) -> None:
    """One-time migration: update news post titles/content from HMS Dashboard to WebServarr branding.
    Guarded by a migration marker in Settings so it runs exactly once."""
    from sqlalchemy.exc import IntegrityError
    from app.models import NewsPost
    from app.routers.news import render_markdown

    # Skip if already ran
    if db.query(Setting).filter(Setting.key == "migration.news_rebrand_v1").first():
        return

    # Update the welcome post
    welcome = db.query(NewsPost).filter(NewsPost.title == "Welcome to HMS Dashboard").first()
    if welcome:
        new_content = (
            "## Welcome to WebServarr\n\n"
            "WebServarr is your self-hosted media server portal. Here's what you can do:\n\n"
            "- **Plex Streams** — Monitor active streams and playback quality in real time\n"
            "- **Service Health** — Status tiles powered by Uptime Kuma\n"
            "- **System Gauges** — CPU, RAM, and network stats from Netdata\n"
            "- **Media Requests** — Search and request movies and TV shows via Overseerr\n"
            "- **Release Calendar** — Upcoming movies and episodes from Radarr and Sonarr\n"
            "- **Notifications** — In-app and browser push notifications\n"
            "- **Theme Engine** — Colors, fonts, logos, and custom CSS\n\n"
            "Head to **Settings** to connect your integrations and get started."
        )
        welcome.title = "Welcome to WebServarr"
        welcome.content = new_content
        welcome.content_html = render_markdown(new_content)

    # Rename and update the maintenance example post
    maintenance = db.query(NewsPost).filter(
        NewsPost.title == "Server Maintenance Scheduled"
    ).first()
    if maintenance:
        new_content = (
            "> **Note:** This is an example post showing news formatting. "
            "Edit or delete it from **Settings > News**.\n\n"
            "We will be performing routine maintenance on **Saturday** from 2:00 AM to 4:00 AM.\n\n"
            "**Services affected:**\n"
            "- Media streaming (Plex)\n"
            "- Media requests (Overseerr)\n\n"
            "Expected downtime: ~30 minutes. Thank you for your patience!"
        )
        maintenance.title = "[Example] Server Maintenance Notice"
        maintenance.content = new_content
        maintenance.content_html = render_markdown(new_content)

    # Delete the test post
    test_post = db.query(NewsPost).filter(NewsPost.title == "test").first()
    if test_post:
        db.delete(test_post)

    # Add migration marker in the same transaction as the data changes (atomic)
    db.add(Setting(
        key="migration.news_rebrand_v1",
        value="done",
        description="One-time news post rebrand migration (HMS Dashboard -> WebServarr)",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.news_rebrand_v1 marker already exists (race), skipping")
        return

    logger.info("Completed one-time news rebrand migration")


def migrate_requests_rename(db: Session) -> None:
    """One-time migration: rename requests2 settings keys to match the
    requests/requests-embed URL rename.
    Guarded by migration.requests_rename_v1 marker."""
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.requests_rename_v1").first():
        return

    # Rename order matters: move the old iframe keys out first, then move native keys in.
    renames = [
        # Old iframe keys → new embed keys
        ("sidebar.label_requests", "sidebar.label_requests_embed"),
        ("icon.nav_requests", "icon.nav_requests_embed"),
        # Old native keys → new primary keys
        ("sidebar.label_requests2", "sidebar.label_requests"),
        ("icon.nav_requests2", "icon.nav_requests"),
    ]

    for old_key, new_key in renames:
        row = db.query(Setting).filter(Setting.key == old_key).first()
        if row:
            # Delete any existing row at the target key to avoid unique constraint
            existing_target = db.query(Setting).filter(Setting.key == new_key).first()
            if existing_target:
                db.delete(existing_target)
            row.key = new_key
            db.flush()

    db.add(Setting(
        key="migration.requests_rename_v1",
        value="done",
        description="One-time requests2 → requests-embed rename migration",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.requests_rename_v1 marker already exists (race), skipping")
        return

    logger.info("Completed one-time requests rename migration")
