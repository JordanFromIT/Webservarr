"""
Public branding API - returns theme and branding settings without authentication.
Used by frontend theme-loader to apply branding before auth check.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user_optional
from app.limiter import limiter
from app.models import Setting

router = APIRouter()

# Default values for all branding/theme keys
DEFAULTS = {
    "branding.app_name": "WebServarr",
    "branding.tagline": "Media Server Management",
    "branding.logo_url": "/static/webservarr.svg",
    "theme.color_primary": "#125793",
    "theme.color_secondary": "#2C6DA1",
    "theme.color_accent": "#4684B0",
    "theme.color_text": "#BEEEF4",
    "theme.color_text_secondary": "#FFFFFF",
    "theme.color_background": "#000000",
    "theme.color_media_movie": "#E9D5FF",
    "theme.color_media_tv": "#67E8F9",
    "theme.color_media_book": "#FCD34D",
    "theme.font": "Spline Sans",
    "theme.custom_css": "",
    # Feature flags
    "features.show_requests": "false",
    "features.show_simple_auth": "true",
    "features.show_plex_auth": "false",
    "features.show_authentik_auth": "false",
    "features.login_backgrounds": "true",
    "features.show_tickets": "true",
    "features.show_books": "true",
    # Kavita ebook backend; show_books also requires this to be set
    "integration.kavita.url": "",
    # Sidebar labels
    "sidebar.label_home": "Home",
    "sidebar.label_requests": "Requests",
    "sidebar.label_requests_embed": "Requests (Embed)",
    "sidebar.label_issues": "Issues",
    "sidebar.label_calendar": "Calendar",
    "sidebar.label_tickets": "Tickets",
    "sidebar.label_library": "eBooks",
    "sidebar.label_settings": "Settings",
    "sidebar.label_wiki": "Wiki",
    # Sidebar sublabels. The label names the destination, the sublabel says what
    # you do there. Every item carries one: descriptions on only some entries
    # read as unfinished, and the pair only tells Issues apart from Tickets if
    # the whole list speaks in one voice. All are verb phrases for that reason.
    # Blank still hides the line, so an admin can opt any item out.
    "sidebar.sublabel_home": "See what's happening",
    "sidebar.sublabel_requests": "Request a movie or show",
    "sidebar.sublabel_requests_embed": "Request through Seerr",
    "sidebar.sublabel_issues": "Report a problem with media",
    "sidebar.sublabel_calendar": "See upcoming releases",
    "sidebar.sublabel_tickets": "Get help from the admin",
    "sidebar.sublabel_library": "Read books in your browser",
    "sidebar.sublabel_settings": "Manage the site",
    "sidebar.sublabel_wiki": "Read guides and how-tos",
    # Per-page "New!" flags. Admin-controlled rather than self-retiring: the
    # admin decides how long a section counts as new, and turns it off when it
    # stops being news. Off everywhere on a fresh install - nothing is new when
    # the whole site is.
    "sidebar.new_home": "false",
    "sidebar.new_requests": "false",
    "sidebar.new_requests_embed": "false",
    "sidebar.new_issues": "false",
    "sidebar.new_calendar": "false",
    "sidebar.new_tickets": "false",
    "sidebar.new_library": "false",
    "sidebar.new_settings": "false",
    "sidebar.new_wiki": "false",
    # Per-page sidebar visibility. Separate keys from the features.* flags so no
    # setting is written from two places in the UI - a Customization save and a
    # System save would otherwise race and clobber each other. Both must be true
    # for a gated page to appear.
    "sidebar.enabled_home": "true",
    "sidebar.enabled_requests": "true",
    "sidebar.enabled_requests_embed": "true",
    "sidebar.enabled_issues": "true",
    "sidebar.enabled_calendar": "true",
    "sidebar.enabled_tickets": "true",
    "sidebar.enabled_library": "true",
    "sidebar.enabled_wiki": "true",
    # Settings is deliberately absent: hiding it locks the admin out of the only
    # page that could turn it back on.
    # Configurable icons
    "icon.nav_home": "home",
    "icon.nav_requests": "movie",
    "icon.nav_requests_embed": "download",
    "icon.nav_issues": "report_problem",
    "icon.nav_calendar": "calendar_month",
    "icon.nav_tickets": "confirmation_number",
    "icon.nav_library": "menu_book",
    "icon.nav_settings": "settings",
    "icon.nav_wiki": "library_books",
    # Contextual pointers into the wiki; each holds a page slug or is empty.
    "wiki.hook_tickets": "",
    "wiki.hook_issues": "",
    "wiki.hook_playback": "",
    "icon.sidebar_logo": "settings_input_component",
    "icon.section_services": "health_metrics",
    "icon.section_news": "newspaper",
    "icon.section_streams": "play_circle",
    "icon.section_releases": "calendar_month",
    "icon.section_requests": "shopping_cart",
    # Homepage news window. Old posts stop appearing on the homepage rather than
    # accumulating down the page forever; the /news archive still holds them all.
    "news.homepage_count": "3",
    "news.homepage_max_age_days": "30",
}


def _int_setting(raw: str, fallback: int, low: int, high: int) -> int:
    """
    Coerce a settings-table string to an int inside [low, high].

    Settings are free-text rows, so a hand-edited or half-saved value must not
    be able to blank the homepage news feed. Anything unparseable falls back to
    the default rather than raising.
    """
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, value))


def _resolve_wiki_hooks(db: Session, get, is_signed_in: bool) -> dict:
    """Turn the three hook settings into {slug, title} pairs the frontend can
    render directly.

    Resolved here rather than client-side because /api/branding already fires on
    every page load -- a second round trip per hook would buy nothing.

    Gated on a session because this endpoint is public: the wiki is deliberately
    readable only when signed in, so returning page titles to an anonymous caller
    would leak content the wiki itself refuses to serve. Logged-out callers get
    nulls, which the login page has no use for anyway.

    A hook pointing at a deleted or unpublished page also resolves to None, so
    the card simply does not render instead of producing a dead link.
    """
    hooks = {"tickets": None, "issues": None, "playback": None}
    if not is_signed_in:
        return hooks

    from app.models import WikiPage

    for name, key in (
        ("tickets", "wiki.hook_tickets"),
        ("issues", "wiki.hook_issues"),
        ("playback", "wiki.hook_playback"),
    ):
        slug = (get(key) or "").strip()
        if not slug:
            continue
        page = db.query(WikiPage).filter(
            WikiPage.slug == slug,
            WikiPage.published.is_(True),
        ).first()
        if page:
            hooks[name] = {"slug": page.slug, "title": page.title}
    return hooks


@router.get("/branding")
@limiter.limit("60/minute")
async def get_branding(
    request: Request,
    db: Session = Depends(get_db),
    current_user: Optional[dict] = Depends(get_current_user_optional),
):
    """
    Public endpoint - returns branding and theme settings.
    No authentication required. Frontend loads this on every page.
    """
    # Fetch all branding/theme settings in one query
    keys = list(DEFAULTS.keys())
    rows = db.query(Setting).filter(Setting.key.in_(keys)).all()
    db_values = {row.key: row.value for row in rows}

    # Also fetch VAPID public key for push subscriptions
    vapid_row = db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").first()

    # Fetch auth-related settings for auth_methods
    auth_keys = [
        "integration.plex.url",
        "integration.plex.token",
        "integration.authentik.url",
        "integration.authentik.client_id",
    ]
    auth_rows = db.query(Setting).filter(Setting.key.in_(auth_keys)).all()
    auth_values = {row.key: row.value for row in auth_rows}

    # Merge DB values over defaults
    def get(key: str) -> str:
        return db_values.get(key, DEFAULTS[key])

    # Check which auth methods are available
    plex_url = auth_values.get("integration.plex.url")
    plex_token = auth_values.get("integration.plex.token")
    authentik_url = auth_values.get("integration.authentik.url")
    authentik_client_id = auth_values.get("integration.authentik.client_id")

    auth_methods = {
        "simple": get("features.show_simple_auth") != "false",
        "plex": get("features.show_plex_auth") != "false" and bool(plex_url and plex_token),
        "authentik": get("features.show_authentik_auth") == "true" and bool(authentik_url and authentik_client_id),
    }

    return {
        "app_name": get("branding.app_name"),
        "tagline": get("branding.tagline"),
        "logo_url": get("branding.logo_url"),
        "colors": {
            "primary": get("theme.color_primary"),
            "secondary": get("theme.color_secondary"),
            "accent": get("theme.color_accent"),
            "text": get("theme.color_text"),
            "text_secondary": get("theme.color_text_secondary"),
            "background": get("theme.color_background"),
            # Media type accents - see seed.py for why these are distinct hues.
            "media_movie": get("theme.color_media_movie"),
            "media_tv": get("theme.color_media_tv"),
            "media_book": get("theme.color_media_book"),
        },
        "font": get("theme.font"),
        "custom_css": get("theme.custom_css"),
        "features": {
            "show_requests": get("features.show_requests") == "true",
            "show_simple_auth": get("features.show_simple_auth") == "true",
            "show_plex_auth": get("features.show_plex_auth") != "false",
            "show_authentik_auth": get("features.show_authentik_auth") == "true",
            "login_backgrounds": get("features.login_backgrounds") == "true",
            "show_tickets": get("features.show_tickets") == "true",
            # Requires both the admin toggle and a configured Kavita, so the nav
            # entry can never point at a library that does not exist.
            "show_books": (
                get("features.show_books") == "true"
                and bool(get("integration.kavita.url"))
            ),
        },
        "wiki_hooks": _resolve_wiki_hooks(db, get, current_user is not None),
        "sidebar_labels": {
            "home": get("sidebar.label_home"),
            "requests": get("sidebar.label_requests"),
            "requests-embed": get("sidebar.label_requests_embed"),
            "issues": get("sidebar.label_issues"),
            "calendar": get("sidebar.label_calendar"),
            "tickets": get("sidebar.label_tickets"),
            "library": get("sidebar.label_library"),
            "settings": get("sidebar.label_settings"),
            "wiki": get("sidebar.label_wiki"),
        },
        "sidebar_sublabels": {
            "home": get("sidebar.sublabel_home"),
            "requests": get("sidebar.sublabel_requests"),
            "requests-embed": get("sidebar.sublabel_requests_embed"),
            "issues": get("sidebar.sublabel_issues"),
            "calendar": get("sidebar.sublabel_calendar"),
            "tickets": get("sidebar.sublabel_tickets"),
            "library": get("sidebar.sublabel_library"),
            "settings": get("sidebar.sublabel_settings"),
            "wiki": get("sidebar.sublabel_wiki"),
        },
        "sidebar_enabled": {
            "home": get("sidebar.enabled_home") != "false",
            "requests": get("sidebar.enabled_requests") != "false",
            "requests-embed": get("sidebar.enabled_requests_embed") != "false",
            "issues": get("sidebar.enabled_issues") != "false",
            "calendar": get("sidebar.enabled_calendar") != "false",
            "tickets": get("sidebar.enabled_tickets") != "false",
            "library": get("sidebar.enabled_library") != "false",
            "wiki": get("sidebar.enabled_wiki") != "false",
            # Always true; there is no key for it. See DEFAULTS.
            "settings": True,
        },
        "sidebar_new": {
            "home": get("sidebar.new_home") == "true",
            "requests": get("sidebar.new_requests") == "true",
            "requests-embed": get("sidebar.new_requests_embed") == "true",
            "issues": get("sidebar.new_issues") == "true",
            "calendar": get("sidebar.new_calendar") == "true",
            "tickets": get("sidebar.new_tickets") == "true",
            "library": get("sidebar.new_library") == "true",
            "wiki": get("sidebar.new_wiki") == "true",
            "settings": get("sidebar.new_settings") == "true",
        },
        "icons": {
            "nav_home": get("icon.nav_home"),
            "nav_requests": get("icon.nav_requests"),
            "nav_requests-embed": get("icon.nav_requests_embed"),
            "nav_issues": get("icon.nav_issues"),
            "nav_calendar": get("icon.nav_calendar"),
            "nav_tickets": get("icon.nav_tickets"),
            "nav_library": get("icon.nav_library"),
            "nav_wiki": get("icon.nav_wiki"),
            "nav_settings": get("icon.nav_settings"),
            "sidebar_logo": get("icon.sidebar_logo"),
            "section_services": get("icon.section_services"),
            "section_news": get("icon.section_news"),
            "section_streams": get("icon.section_streams"),
            "section_releases": get("icon.section_releases"),
            "section_requests": get("icon.section_requests"),
        },
        "news": {
            "homepage_count": _int_setting(get("news.homepage_count"), 3, 1, 20),
            "homepage_max_age_days": _int_setting(get("news.homepage_max_age_days"), 30, 0, 3650),
        },
        "auth_methods": auth_methods,
        "vapid_public_key": vapid_row.value if vapid_row else None,
    }
