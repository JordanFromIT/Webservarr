"""
Public branding API - returns theme and branding settings without authentication.
Used by frontend theme-loader to apply branding before auth check.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Setting

router = APIRouter()

# Default values for all branding/theme keys
DEFAULTS = {
    "branding.app_name": "HMS Dashboard",
    "branding.tagline": "Home Media Server Management",
    "branding.logo_url": "",
    "branding.show_default_credentials": "true",
    "theme.color_primary": "#125793",
    "theme.color_secondary": "#2C6DA1",
    "theme.color_accent": "#4684B0",
    "theme.color_text": "#BEEEF4",
    "theme.color_background": "#000000",
    "theme.font": "Spline Sans",
    "theme.dark_mode": "true",
    "theme.custom_css": "",
    # Feature flags
    "features.show_requests": "false",
    # Sidebar labels
    "sidebar.label_home": "Home",
    "sidebar.label_requests": "Requests",
    "sidebar.label_requests2": "Requests",
    "sidebar.label_issues": "Issues",
    "sidebar.label_settings": "Settings",
}


@router.get("/branding")
async def get_branding(db: Session = Depends(get_db)):
    """
    Public endpoint - returns branding and theme settings.
    No authentication required. Frontend loads this on every page.
    """
    # Fetch all branding/theme settings in one query
    keys = list(DEFAULTS.keys())
    rows = db.query(Setting).filter(Setting.key.in_(keys)).all()
    db_values = {row.key: row.value for row in rows}

    # Merge DB values over defaults
    def get(key: str) -> str:
        return db_values.get(key, DEFAULTS[key])

    return {
        "app_name": get("branding.app_name"),
        "tagline": get("branding.tagline"),
        "logo_url": get("branding.logo_url"),
        "show_default_credentials": get("branding.show_default_credentials") == "true",
        "colors": {
            "primary": get("theme.color_primary"),
            "secondary": get("theme.color_secondary"),
            "accent": get("theme.color_accent"),
            "text": get("theme.color_text"),
            "background": get("theme.color_background"),
        },
        "font": get("theme.font"),
        "dark_mode": get("theme.dark_mode") == "true",
        "custom_css": get("theme.custom_css"),
        "features": {
            "show_requests": get("features.show_requests") == "true",
        },
        "sidebar_labels": {
            "home": get("sidebar.label_home"),
            "requests": get("sidebar.label_requests"),
            "requests2": get("sidebar.label_requests2"),
            "issues": get("sidebar.label_issues"),
            "settings": get("sidebar.label_settings"),
        },
    }
