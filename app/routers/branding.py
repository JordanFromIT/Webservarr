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
from app.settings_registry import REGISTRY, public_defaults
from app.utils import safe_http_url, same_origin_path

router = APIRouter()

# Every key the branding builder reads, with its registry default. The Kavita
# URL is not public (it never leaves the server) but the builder needs it to
# decide whether the eBooks page exists.
DEFAULTS = {**public_defaults(), "integration.kavita.url": REGISTRY["integration.kavita.url"].default}


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


def _registry_int(key: str, raw: str) -> int:
    """_int_setting with the default and bounds of the key's registry entry."""
    d = REGISTRY[key]
    return _int_setting(raw, int(d.default), d.min, d.max)


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


AUTH_KEYS = [
    "integration.plex.url",
    "integration.plex.token",
    "integration.authentik.url",
    "integration.authentik.client_id",
]

EMPTY_WIKI_HOOKS = {"tickets": None, "issues": None, "playback": None}


def safe_logo_url(value) -> str:
    """The logo URL as it may reach any browser, or "".

    logo_url goes into /api/branding and every page's #ws-data block, and
    from there into the favicon on every page and the public login logo. An
    http(s) URL or a same-origin path passes; anything else (a
    "/\\evil.example/x.ico" that browsers resolve to another host, a
    javascript: URL, ...) becomes "", the same as no logo: the shell shows
    its sidebar icon (as pages._safe_url already did), and the favicon and
    login logo are left alone.
    """
    v = (value or "").strip() if isinstance(value, str) else ""
    if v.lower().startswith(("https://", "http://")):  # schemes are case-insensitive
        return safe_http_url(v)
    return same_origin_path(v)


def build_branding(values: dict, auth_values: dict, vapid_public_key: Optional[str], wiki_hooks: dict) -> dict:
    """
    Assemble the branding payload from raw setting values.

    Pure: no database access. Shared by GET /api/branding and by the page
    renderer (app/pages.py), which inlines the same payload into every page so
    the client never has to fetch it. Keeping one builder means the two cannot
    drift.
    """

    # Merge DB values over defaults
    def get(key: str) -> str:
        return values.get(key, DEFAULTS[key])

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
        "logo_url": safe_logo_url(get("branding.logo_url")),
        "colors": {
            "primary": get("theme.color_primary"),
            "secondary": get("theme.color_secondary"),
            "accent": get("theme.color_accent"),
            "text": get("theme.color_text"),
            "text_secondary": get("theme.color_text_secondary"),
            "background": get("theme.color_background"),
            # Media type accents - see app/settings_registry.py for why these are distinct hues.
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
        "wiki_hooks": wiki_hooks,
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
            # Always true; there is no key for it (see app/settings_registry.py).
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
            "homepage_count": _registry_int("news.homepage_count", get("news.homepage_count")),
            "homepage_max_age_days": _registry_int("news.homepage_max_age_days", get("news.homepage_max_age_days")),
        },
        "auth_methods": auth_methods,
        "vapid_public_key": vapid_public_key,
    }


def load_branding(db: Session, signed_in: bool) -> dict:
    """Read every branding-related setting and build the payload."""
    # Fetch all branding/theme settings in one query
    rows = db.query(Setting).filter(Setting.key.in_(list(DEFAULTS.keys()))).all()
    values = {row.key: row.value for row in rows}

    # Also fetch VAPID public key for push subscriptions
    vapid_row = db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").first()

    # Fetch auth-related settings for auth_methods
    auth_rows = db.query(Setting).filter(Setting.key.in_(AUTH_KEYS)).all()
    auth_values = {row.key: row.value for row in auth_rows}

    def get(key: str) -> str:
        return values.get(key, DEFAULTS[key])

    hooks = _resolve_wiki_hooks(db, get, signed_in)
    return build_branding(values, auth_values, vapid_row.value if vapid_row else None, hooks)


@router.get("/branding")
@limiter.limit("60/minute")
async def get_branding(
    request: Request,
    db: Session = Depends(get_db),
    current_user: Optional[dict] = Depends(get_current_user_optional),
):
    """
    Public endpoint - returns branding and theme settings.
    No authentication required. Pages receive the same payload inlined at
    serve time (app/pages.py); this endpoint remains for the settings
    preview and as the fallback for pages served some other way.
    """
    return load_branding(db, current_user is not None)
