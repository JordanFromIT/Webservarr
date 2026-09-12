"""
Seed the database with defaults on first startup.
"""

import logging
import secrets
from sqlalchemy.orm import Session
from app.models import User, Setting

logger = logging.getLogger(__name__)

# Default branding/theme settings (inserted only if missing)
DEFAULT_SETTINGS = {
    "branding.app_name": ("WebServarr", "Application display name"),
    "branding.tagline": ("Media Server Management", "Tagline shown on login page"),
    "branding.logo_url": ("/static/webservarr.svg", "URL to custom logo image"),
    "theme.color_primary": ("#125793", "Primary brand color (Baltic Blue)"),
    "theme.color_secondary": ("#2C6DA1", "Secondary brand color (Cornflower Ocean)"),
    "theme.color_accent": ("#4684B0", "Accent color (Steel Blue)"),
    "theme.color_text": ("#BEEEF4", "Text primary color (Frosted Blue)"),
    "theme.color_text_secondary": ("#FFFFFF", "Text secondary color (contrast/buttons)"),
    "theme.color_background": ("#000000", "Background color"),
    # Media type accents. These identify what a card is - the noun in "Request
    # eBook", the type badge - so unlike the palette above they are deliberately
    # three distinct hues rather than shades of the brand colour. Defaults are
    # chosen to clear 4.5:1 against the primary fill they sit on.
    "theme.color_media_movie": ("#E9D5FF", "Accent for Movie results and badges"),
    "theme.color_media_tv": ("#67E8F9", "Accent for TV Show results and badges"),
    "theme.color_media_book": ("#FCD34D", "Accent for eBook results and badges"),
    "theme.font": ("Spline Sans", "Google Font family name"),
    "theme.custom_css": ("", "Custom CSS injected into all pages"),
    # Feature flags
    "features.show_requests": ("false", "Show Seerr iframe Requests (Embed) page in sidebar"),
    "features.show_simple_auth": ("true", "Show local username/password login on login page"),
    "features.login_backgrounds": ("true", "Show rotating TMDB backgrounds on login page"),
    # Sidebar labels
    "sidebar.label_home": ("Home", "Sidebar label for Home page"),
    "sidebar.label_requests": ("Requests", "Sidebar label for Requests page"),
    "sidebar.label_requests_embed": ("Requests (Embed)", "Sidebar label for Requests (Embed) page"),
    "sidebar.label_issues": ("Issues", "Sidebar label for the media-issue page"),
    "sidebar.label_tickets": ("Tickets", "Sidebar label for the support ticket page"),
    # Every nav item gets a sublabel; see branding.DEFAULTS for why.
    "sidebar.sublabel_home": ("See what's happening", "Sidebar sublabel for Home"),
    "sidebar.sublabel_requests": ("Request a movie or show", "Sidebar sublabel for Requests"),
    "sidebar.sublabel_requests_embed": ("Request through Seerr", "Sidebar sublabel for Requests (Embed)"),
    "sidebar.sublabel_issues": ("Report a problem with media", "Sidebar sublabel for Issues"),
    "sidebar.sublabel_calendar": ("See upcoming releases", "Sidebar sublabel for Calendar"),
    "sidebar.sublabel_tickets": ("Get help from the admin", "Sidebar sublabel for Tickets"),
    "sidebar.sublabel_library": ("Read books in your browser", "Sidebar sublabel for eBooks"),
    "sidebar.sublabel_settings": ("Manage the site", "Sidebar sublabel for Settings"),
    "sidebar.label_calendar": ("Calendar", "Sidebar label for Calendar page"),
    "sidebar.label_settings": ("Settings", "Sidebar label for Settings page"),
    # Wiki. library_books rather than menu_book, which eBooks already uses.
    "sidebar.label_wiki": ("Wiki", "Sidebar label for the Wiki page"),
    "sidebar.sublabel_wiki": ("Guides and how-tos", "Sidebar sublabel for Wiki"),
    "sidebar.enabled_wiki": ("true", "Show Wiki in the sidebar"),
    "sidebar.new_wiki": ("false", "Show a New! flag on the Wiki nav item"),
    "icon.nav_wiki": ("library_books", "Sidebar icon for Wiki page"),
    # Contextual pointers into the wiki. Each holds a page slug, or is empty.
    # Empty or dangling slugs render nothing rather than a broken link.
    "wiki.hook_tickets": ("", "Wiki page slug linked above the support ticket form"),
    "wiki.hook_issues": ("", "Wiki page slug linked above the media-issue form"),
    "wiki.hook_playback": ("", "Wiki page slug linked on the Playback Issue category"),
    # Configurable icons (Material Symbols icon names)
    "icon.nav_home": ("home", "Sidebar icon for Home page"),
    "icon.nav_requests": ("movie", "Sidebar icon for Requests page"),
    "icon.nav_requests_embed": ("download", "Sidebar icon for Requests (Embed) page"),
    "icon.nav_issues": ("report_problem", "Sidebar icon for the media-issue page"),
    "icon.nav_tickets": ("confirmation_number", "Sidebar icon for the support ticket page"),
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
    "netdata.net_unit": ("mbps", "Network speed unit: mbps (megabits/s) or MBps (megabytes/s)"),
    "netdata.net_max": ("1000", "Max network throughput for gauge percentage (in the selected unit)"),
    # Notification polling intervals (seconds)
    "notifications.poll_interval_seerr": ("60", "Seconds between Seerr notification checks"),
    "notifications.poll_interval_monitors": ("60", "Seconds between Uptime Kuma notification checks"),
    "notifications.poll_interval_news": ("60", "Seconds between news post notification checks"),
    # Authentik OIDC (overrides env vars when set)
    "integration.authentik.url": ("", "Authentik base URL (e.g., https://auth.example.com)"),
    "integration.authentik.client_id": ("", "Authentik OAuth2 client ID"),
    "integration.authentik.client_secret": ("", "Authentik OAuth2 client secret"),
    "integration.authentik.app_slug": ("", "Authentik application slug (for logout URL)"),
    # Kavita ebook backend (proxied; never exposed to the browser directly)
    "integration.kavita.url": ("", "Kavita base URL (e.g., http://192.168.1.100:5000)"),
    "features.show_books": ("true", "Show Library page in sidebar (also requires Kavita configured)"),
    "sidebar.label_library": ("eBooks", "Sidebar label for the eBooks/Library page"),
    "icon.nav_library": ("menu_book", "Sidebar icon for Library page"),
    # Chaptarr book acquisition (used by the Requests page)
    "integration.chaptarr.url": ("", "Chaptarr base URL (e.g., http://192.168.1.100:8789)"),
    "integration.chaptarr.api_key": ("", "Chaptarr API key"),
    "integration.chaptarr.root_folder": ("", "Chaptarr root folder path for requested books"),
    "integration.chaptarr.quality_profile_id": ("1", "Chaptarr quality profile id for requested books"),
    "integration.chaptarr.metadata_profile_id": ("2", "Chaptarr metadata profile id for requested books"),
    # Chaptarr keeps audiobooks in their own root folder with their own
    # profiles, so requesting one is the same call with a different trio.
    # Defaults match a stock Chaptarr install (Audiobook quality, Audiobook
    # Default metadata).
    "integration.chaptarr.audiobook_root_folder": ("", "Chaptarr root folder path for requested audiobooks"),
    "integration.chaptarr.audiobook_quality_profile_id": ("2", "Chaptarr quality profile id for requested audiobooks"),
    "integration.chaptarr.audiobook_metadata_profile_id": ("1", "Chaptarr metadata profile id for requested audiobooks"),
    "integration.nyt.api_key": ("", "New York Times Books API key (developer.nytimes.com) for trending shelves"),
    # Per-page sidebar visibility (Settings > Customization). ANDed with the
    # features.* flags above, so a gated page needs both. No key for Settings:
    # hiding it would lock the admin out of the page that turns it back on.
    "sidebar.enabled_home": ("true", "Show Home in the sidebar"),
    "sidebar.enabled_requests": ("true", "Show Requests in the sidebar"),
    "sidebar.enabled_requests_embed": ("true", "Show Requests (Embed) in the sidebar"),
    "sidebar.enabled_issues": ("true", "Show Issues in the sidebar"),
    "sidebar.enabled_calendar": ("true", "Show Calendar in the sidebar"),
    "sidebar.enabled_tickets": ("true", "Show Tickets in the sidebar"),
    "sidebar.enabled_library": ("true", "Show eBooks in the sidebar"),
    # Ticket system
    "features.show_tickets": ("true", "Show Tickets page in sidebar"),
    "sidebar.label_tickets": ("Tickets", "Sidebar label for Tickets page"),
    "icon.nav_tickets": ("confirmation_number", "Sidebar icon for Tickets page"),
    "notifications.poll_interval_tickets": ("60", "Seconds between ticket notification checks"),
}


def migrate_setup_completed(db: Session) -> None:
    """One-time migration: mark setup as completed for existing installs
    that already have an admin user (pre-wizard upgrades)."""
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "setup.completed").first():
        return

    admin_count = db.query(User).filter(User.is_admin == True).count()
    if admin_count > 0:
        db.add(Setting(
            key="setup.completed",
            value="true",
            description="Initial setup wizard has been completed",
        ))
        try:
            db.commit()
            logger.info("Existing install detected — marked setup as completed")
        except IntegrityError:
            db.rollback()


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
    """Seed default news posts for fresh installs. Guarded by migration marker."""
    from sqlalchemy.exc import IntegrityError
    from app.models import NewsPost
    from app.content import render_markdown
    from datetime import datetime, timezone

    if db.query(Setting).filter(Setting.key == "seed.default_news_v1").first():
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
                "- **Media Requests** — Search and request movies and TV shows via Seerr\n"
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
                "- Media requests (Seerr)\n\n"
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

    db.add(Setting(
        key="seed.default_news_v1",
        value="done",
        description="Default news posts have been seeded",
    ))

    try:
        db.commit()
        logger.info("Seeded %d default news posts", len(posts))
    except IntegrityError:
        db.rollback()
        logger.debug("Default news already seeded (race condition), skipping")


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


def migrate_nav_sublabels_v2(db: Session) -> None:
    """
    One-time migration: undo the v1.7.0 nav rename and reword the two sublabels.

    v1.7.0 replaced the "Issues"/"Tickets" labels with "Report a Problem" and
    "Contact Support" to make the pair self-explanatory. It worked, but only for
    those two entries -- the other six nav items kept bare one-word labels, so
    the list read as half-finished and the two long labels looked out of place.

    The clearer split turned out to belong in the sublabel, not the label: every
    item now keeps a short noun as its name and gains a verb phrase underneath,
    written in one voice across the whole nav. So the labels go back.

    Conditional on the stored value still being exactly what v1.7.0 shipped. A
    label the admin has since chosen is left alone -- this reverts a default, it
    does not overwrite anyone's wording. The six sublabels that have no row yet
    are handled by seed_default_settings, which inserts them with the new text.

    Guarded by migration.nav_sublabels_v2.
    """
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.nav_sublabels_v2").first():
        return

    # (key, the exact value v1.7.0 shipped, what it becomes)
    upgrades = [
        ("sidebar.label_issues", "Report a Problem", "Issues"),
        ("sidebar.label_tickets", "Contact Support", "Tickets"),
        ("icon.nav_tickets", "support_agent", "confirmation_number"),
        ("sidebar.sublabel_issues", "Issue with a movie or show", "Report a problem with media"),
        ("sidebar.sublabel_tickets", "Everything else", "Get help from the admin"),
    ]
    changed = []
    for key, old_value, new_value in upgrades:
        row = db.query(Setting).filter(Setting.key == key).first()
        if row and (row.value or "").strip() == old_value:
            row.value = new_value
            changed.append(key)

    db.add(Setting(
        key="migration.nav_sublabels_v2",
        value="done",
        description="One-time revert of the v1.7.0 nav label rename, plus sublabel rewording",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.nav_sublabels_v2 marker already exists (race), skipping")
        return

    if changed:
        logger.info("Completed nav sublabel migration (updated: %s)", ", ".join(changed))
    else:
        logger.info("Nav sublabel migration: nothing to change (labels are customised)")


def migrate_home_sublabel_v3(db: Session) -> None:
    """
    One-time migration: Home's sublabel becomes "See what's happening".

    "See what's playing" implied the page was only about active streams. The
    homepage also carries news, service health, system gauges and upcoming
    releases, so the wider phrasing describes what is actually there.

    Conditional on the stored value, as always -- an admin who wrote their own
    keeps it. Installs with no row yet get the new text from
    seed_default_settings instead.

    Guarded by migration.home_sublabel_v3.
    """
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.home_sublabel_v3").first():
        return

    row = db.query(Setting).filter(Setting.key == "sidebar.sublabel_home").first()
    changed = False
    if row and (row.value or "").strip() == "See what's playing":
        row.value = "See what's happening"
        changed = True

    db.add(Setting(
        key="migration.home_sublabel_v3",
        value="done",
        description="One-time Home sublabel rewording",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.home_sublabel_v3 marker already exists (race), skipping")
        return

    logger.info("Home sublabel migration: %s", "updated" if changed else "nothing to change (customised)")


def migrate_overseerr_to_seerr(db: Session) -> None:
    """One-time migration: rename integration.overseerr.* setting keys to
    integration.seerr.* and notifications.poll_interval_overseerr to
    notifications.poll_interval_seerr for existing installs.
    Guarded by migration.overseerr_to_seerr_v1 marker."""
    from sqlalchemy.exc import IntegrityError

    if db.query(Setting).filter(Setting.key == "migration.overseerr_to_seerr_v1").first():
        return

    renames = [
        ("integration.overseerr.url", "integration.seerr.url"),
        ("integration.overseerr.api_key", "integration.seerr.api_key"),
        ("notifications.poll_interval_overseerr", "notifications.poll_interval_seerr"),
    ]

    renamed = 0
    for old_key, new_key in renames:
        row = db.query(Setting).filter(Setting.key == old_key).first()
        if row:
            # Delete any existing row at the target key to avoid unique constraint
            existing_target = db.query(Setting).filter(Setting.key == new_key).first()
            if existing_target:
                db.delete(existing_target)
            row.key = new_key
            db.flush()
            renamed += 1

    # Also update the description on features.show_requests if it references Overseerr
    show_req = db.query(Setting).filter(Setting.key == "features.show_requests").first()
    if show_req and "Overseerr" in (show_req.description or ""):
        show_req.description = show_req.description.replace("Overseerr", "Seerr")

    db.add(Setting(
        key="migration.overseerr_to_seerr_v1",
        value="done",
        description="One-time migration: renamed overseerr setting keys to seerr",
    ))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        logger.debug("migration.overseerr_to_seerr_v1 marker already exists (race), skipping")
        return

    if renamed:
        logger.info("Completed Overseerr -> Seerr migration: renamed %d setting keys", renamed)
    else:
        logger.info("Completed Overseerr -> Seerr migration: no old keys found")
