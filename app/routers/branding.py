"""
Public branding API - returns theme and branding settings without authentication.
Used by frontend theme-loader to apply branding before auth check.
"""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.limiter import limiter
from app.models import Setting

router = APIRouter()

# Default values for all branding/theme keys
DEFAULTS = {
    "branding.app_name": "WebServarr",
    "branding.tagline": "Media Server Management",
    "branding.logo_url": "",
    "theme.color_primary": "#125793",
    "theme.color_secondary": "#2C6DA1",
    "theme.color_accent": "#4684B0",
    "theme.color_text": "#BEEEF4",
    "theme.color_background": "#000000",
    "theme.font": "Spline Sans",
    "theme.custom_css": "",
    # Feature flags
    "features.show_requests": "false",
    "features.show_simple_auth": "true",
    "features.login_backgrounds": "true",
    "features.show_tickets": "true",
    # Sidebar labels
    "sidebar.label_home": "Home",
    "sidebar.label_requests": "Requests",
    "sidebar.label_requests2": "Requests",
    "sidebar.label_issues": "Issues",
    "sidebar.label_calendar": "Calendar",
    "sidebar.label_tickets": "Tickets",
    "sidebar.label_settings": "Settings",
    # Configurable icons
    "icon.nav_home": "home",
    "icon.nav_requests": "download",
    "icon.nav_requests2": "movie",
    "icon.nav_issues": "report_problem",
    "icon.nav_calendar": "calendar_month",
    "icon.nav_tickets": "confirmation_number",
    "icon.nav_settings": "settings",
    "icon.sidebar_logo": "settings_input_component",
    "icon.section_services": "health_metrics",
    "icon.section_news": "newspaper",
    "icon.section_streams": "play_circle",
    "icon.section_releases": "calendar_month",
}


@router.get("/branding")
@limiter.limit("60/minute")
async def get_branding(request: Request, db: Session = Depends(get_db)):
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
        "plex": bool(plex_url and plex_token),
        "authentik": bool(authentik_url and authentik_client_id),
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
            "background": get("theme.color_background"),
        },
        "font": get("theme.font"),
        "custom_css": get("theme.custom_css"),
        "features": {
            "show_requests": get("features.show_requests") == "true",
            "show_simple_auth": get("features.show_simple_auth") == "true",
            "login_backgrounds": get("features.login_backgrounds") == "true",
            "show_tickets": get("features.show_tickets") == "true",
        },
        "sidebar_labels": {
            "home": get("sidebar.label_home"),
            "requests": get("sidebar.label_requests"),
            "requests2": get("sidebar.label_requests2"),
            "issues": get("sidebar.label_issues"),
            "calendar": get("sidebar.label_calendar"),
            "tickets": get("sidebar.label_tickets"),
            "settings": get("sidebar.label_settings"),
        },
        "icons": {
            "nav_home": get("icon.nav_home"),
            "nav_requests": get("icon.nav_requests"),
            "nav_requests2": get("icon.nav_requests2"),
            "nav_issues": get("icon.nav_issues"),
            "nav_calendar": get("icon.nav_calendar"),
            "nav_tickets": get("icon.nav_tickets"),
            "nav_settings": get("icon.nav_settings"),
            "sidebar_logo": get("icon.sidebar_logo"),
            "section_services": get("icon.section_services"),
            "section_news": get("icon.section_news"),
            "section_streams": get("icon.section_streams"),
            "section_releases": get("icon.section_releases"),
        },
        "auth_methods": auth_methods,
        "vapid_public_key": vapid_row.value if vapid_row else None,
    }
