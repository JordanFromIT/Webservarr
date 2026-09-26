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
from app.settings_registry import (
    HOME_SECTION_IDS, REGISTRY, SIDEBAR_PAGE_IDS, normalize_page_order, public_defaults, safe_color, safe_font,
    switch_is_off,
)
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
    the card simply does not render instead of producing a dead link. So does
    every hook while the Wiki page is switched off: its link would only send a
    member home, and the hidden wiki's page titles would reach them. Off means
    no card, for admins too.
    """
    hooks = {"tickets": None, "issues": None, "playback": None}
    if not is_signed_in or switch_is_off(get("sidebar.enabled_wiki")):
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

    pages = SIDEBAR_PAGE_IDS
    source = get("requests.source")
    icons = {"nav_" + p: get("icon.nav_" + p) for p in pages}
    icons["sidebar_logo"] = get("icon.sidebar_logo")
    for sid in HOME_SECTION_IDS:
        icons["section_" + sid] = get("icon.section_" + sid)

    return {
        "app_name": get("branding.app_name"),
        "tagline": get("branding.tagline"),
        "logo_url": safe_logo_url(get("branding.logo_url")),
        # Font and colours are made safe here, with the page renderer's own
        # rule: theme-loader.js applies them inline on every page, over the
        # server's #ws-theme, so a legacy or hand-edited row would otherwise
        # break the whole site. Anything off becomes its registry default.
        # The media type accents (media_*) are distinct hues; see app/settings_registry.py.
        "colors": {
            key: safe_color("theme.color_" + key, get("theme.color_" + key))
            for key in ("primary", "secondary", "accent", "text", "text_secondary", "background",
                        "media_movie", "media_tv", "media_book")
        },
        "font": safe_font(get("theme.font")),
        "custom_css": get("theme.custom_css"),
        "features": {
            "show_simple_auth": get("features.show_simple_auth") == "true",
            "show_plex_auth": get("features.show_plex_auth") != "false",
            "show_authentik_auth": get("features.show_authentik_auth") == "true",
            "login_backgrounds": get("features.login_backgrounds") == "true",
            # eBooks can only exist while Kavita is configured. The page's own
            # on/off switch is sidebar_enabled["library"]. Named apart from the
            # retired features.show_books setting, which this is not.
            "ebooks_configured": bool(get("integration.kavita.url")),
        },
        "requests_source": source if source in ("native", "seerr_embed") else "native",
        "pages_order": normalize_page_order(get("pages.order")),
        "home_sections": {sid: get("home.section_" + sid) != "false" for sid in HOME_SECTION_IDS},
        "wiki_hooks": wiki_hooks,
        "sidebar_labels": {p: get("sidebar.label_" + p) for p in pages},
        "sidebar_sublabels": {p: get("sidebar.sublabel_" + p) for p in pages},
        # Home and Settings are always on: Home is where everyone lands, and
        # hiding Settings would lock the admin out of the page that turns it back on.
        "sidebar_enabled": {
            p: True if p in ("home", "settings") else not switch_is_off(get("sidebar.enabled_" + p)) for p in pages
        },
        "sidebar_new": {p: get("sidebar.new_" + p) == "true" for p in pages},
        "icons": icons,
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
