"""
How an integration's stored settings are read: one reader for the real
clients and for the Settings status lights and Test.

The clients (app/integrations/*) read their address, credential and Uptime
Kuma slug through these functions from the settings table; the probe behind
the lights and Test (app/services/integration_health.py) reads the same
values through the same functions from the settings it is given. So a light
tests exactly the address, credential and page the client will use, and a
value the client can't work with can't look green.

Values are used as stored, never trimmed: Settings refuses a secret with
spaces around it (app/settings_registry.py), and the probe names one that an
older version stored instead of quietly testing a cleaned-up copy.
"""

from typing import Dict, Iterable, Mapping, Optional

from app.database import SessionLocal
from app.models import Setting
from app.settings_registry import REGISTRY

CREDENTIAL_KEYS: Dict[str, str] = {
    "plex": "integration.plex.token",
    "seerr": "integration.seerr.api_key",
    "chaptarr": "integration.chaptarr.api_key",
    "nyt": "integration.nyt.api_key",
    "sonarr": "integration.sonarr.api_key",
    "radarr": "integration.radarr.api_key",
    "netdata": "integration.netdata.api_key",
}

KUMA_SLUG_KEY = "integration.uptime_kuma.slug"
# The registry default for the slug ("default", Uptime Kuma's own default
# status page); an empty or missing row means this page.
DEFAULT_KUMA_SLUG = REGISTRY[KUMA_SLUG_KEY].default


def url_key(service: str) -> str:
    return f"integration.{service}.url"


def read(keys: Iterable[str]) -> Dict[str, Optional[str]]:
    """The stored value of each key (None when it has no row), in one short session."""
    keys = list(keys)
    db = SessionLocal()
    try:
        rows = db.query(Setting).filter(Setting.key.in_(keys)).all()
        found = {row.key: row.value for row in rows}
    finally:
        db.close()
    return {k: found.get(k) for k in keys}


def base_url(service: str, values: Mapping[str, Optional[str]]) -> Optional[str]:
    """The address requests are built on: as stored, without a trailing slash."""
    raw = values.get(url_key(service))
    return raw.rstrip("/") if raw else None


def credential(service: str, values: Mapping[str, Optional[str]]) -> Optional[str]:
    """The token or API key, exactly as stored and sent."""
    key = CREDENTIAL_KEYS.get(service)
    return (values.get(key) or None) if key else None


def kuma_slug(values: Mapping[str, Optional[str]]) -> str:
    """The Uptime Kuma status page: the stored slug, or the default page when empty."""
    return (values.get(KUMA_SLUG_KEY) or "").strip() or DEFAULT_KUMA_SLUG


def padded(value: Optional[str]) -> bool:
    """True for a value with whitespace around it, which no client can send."""
    return bool(value) and value != value.strip()
