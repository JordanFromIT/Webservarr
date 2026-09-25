"""
The settings registry: the one definition of every operator setting.

Every setting an admin can change is declared here once, with its shipped
default, its type and its validation. These take their defaults from this
module rather than keeping their own copy:

  * seeding: app/seed.py DEFAULT_SETTINGS is seed_defaults();
  * the branding payload: app/routers/branding.py DEFAULTS is public_defaults()
    plus the Kavita URL, and the home page news window's fallback and bounds
    are the news.* entries' default, min and max;
  * the page renderer (app/pages.py): the colour, font, site name and logo
    icon fallbacks and the nav items' labels, sublabels and icons;
  * the settings API (app/routers/admin_settings.py), which also serves the
    defaults to the Settings page through GET /api/admin/settings?view=registry.

Still outside it: the integration clients and the notification poller keep
their own fallback for a missing row (Chaptarr profile ids, the Netdata unit
and gauge maximum, the Uptime Kuma slug, the poll intervals), and the static
front end repeats some defaults (app/static/css/theme.css repeats the colours
as :root defaults, which a test keeps equal to this module; the old Settings
page carries its own fallbacks until it is replaced).

Changing a default here does nothing on installs that already have the row:
seeding only inserts missing keys, so an operator's choices survive upgrades.
Pair a changed default with a migration in app/seed.py that upgrades rows
still holding the old value (see migrate_nav_sublabels_v2).

Internal rows (system.secret_key, setup.*, seed.*, migration.*, VAPID keys,
per-user notify.* preferences) are deliberately absent: they are not operator
settings and the settings API must never write them.
"""

import json
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Pattern, Tuple

MASK = "***masked***"

SIDEBAR_PAGE_IDS = ("home", "requests", "issues", "calendar", "tickets", "library", "wiki", "settings")
DEFAULT_PAGE_ORDER = list(SIDEBAR_PAGE_IDS)
HOME_SECTION_IDS = ("services", "news", "streams", "releases", "requests")
TYPES = ("text", "url", "bool", "int", "color", "icon", "enum", "json")

# page id -> (label, sublabel, icon). Label names the destination; the
# sublabel says what you do there. Every page carries one, always a verb
# phrase: descriptions on only some entries read as unfinished, and the pair
# only tells Issues apart from Tickets if the whole list speaks in one voice.
# A blank sublabel still hides the line, so an admin can opt any page out.
PAGE_DEFAULTS: Dict[str, Tuple[str, str, str]] = {
    "home": ("Home", "See what's happening", "home"),
    "requests": ("Requests", "Request a movie or show", "movie"),
    "issues": ("Issues", "Report a problem with media", "report_problem"),
    "calendar": ("Calendar", "See upcoming releases", "calendar_month"),
    "tickets": ("Tickets", "Get help from the admin", "confirmation_number"),
    "library": ("eBooks", "Read books in your browser", "menu_book"),
    "wiki": ("Wiki", "Read guides and how-tos", "library_books"),
    "settings": ("Settings", "Manage the site", "settings"),
}

# page id -> its address. Routes, not settings: fixed, never stored. The one
# copy: the nav (app/pages.py) renders from it and the Settings view serves
# it to the Pages tab.
PAGE_ADDRESSES: Dict[str, str] = {
    "home": "/", "requests": "/requests", "issues": "/issues", "calendar": "/calendar",
    "tickets": "/tickets", "library": "/ebooks", "wiki": "/wiki", "settings": "/settings",
}

_HOME_SECTION_DEFAULTS = {
    # section id -> (display name, icon)
    "services": ("Service Health", "health_metrics"),
    "news": ("News & Updates", "newspaper"),
    "streams": ("Active Streams", "play_circle"),
    "releases": ("Upcoming Releases", "calendar_month"),
    "requests": ("Recent Requests", "shopping_cart"),
}


@dataclass(frozen=True)
class SettingDef:
    key: str
    default: str
    type: str
    description: str
    secret: bool = False
    public: bool = False
    seed: bool = True
    deprecated: bool = False
    min: Optional[int] = None
    max: Optional[int] = None
    choices: Optional[Tuple[str, ...]] = None
    max_length: int = 500
    allow_empty: bool = True
    allow_relative: bool = False
    ssrf_check: bool = False
    pattern: Optional[str] = None
    pattern_hint: Optional[str] = None


def _text(key, default, description, **kw):
    return SettingDef(key, default, "text", description, **kw)


def _url(key, default, description, **kw):
    return SettingDef(key, default, "url", description, **kw)


def _bool(key, default, description, **kw):
    return SettingDef(key, default, "bool", description, **kw)


def _int(key, default, description, lo, hi, **kw):
    kw.setdefault("allow_empty", False)
    return SettingDef(key, default, "int", description, min=lo, max=hi, **kw)


def _color(key, default, description):
    return SettingDef(key, default, "color", description, public=True, allow_empty=False)


def _icon(key, default, description, **kw):
    return SettingDef(key, default, "icon", description, max_length=64, allow_empty=False, **kw)


def _secret(key, description, **kw):
    return SettingDef(key, "", "text", description, secret=True, **kw)


_SLUG = r"[a-z0-9\-]*"
_SLUG_HINT = "Use lowercase letters, digits and hyphens only"
_TOKEN = r"[A-Za-z0-9_\-]*"
_TOKEN_HINT = "Use letters, digits, hyphens and underscores only"


def _build() -> List[SettingDef]:
    d: List[SettingDef] = [
        # ---- General ----
        _text("branding.app_name", "WebServarr", "Site name shown in the sidebar, login page and browser tab",
              public=True, max_length=80),
        _text("branding.tagline", "Media Server Management", "Tagline shown on the login page and in link previews",
              public=True, max_length=160),
        _url("branding.logo_url", "/static/webservarr.svg", "Logo image (uploaded file or web address)",
             public=True, allow_relative=True),
        _icon("icon.sidebar_logo", "settings_input_component", "Icon shown in place of a logo when none is set",
              public=True),
        # ---- Appearance ----
        _color("theme.color_primary", "#125793", "Primary colour"),
        _color("theme.color_secondary", "#2C6DA1", "Secondary colour"),
        _color("theme.color_accent", "#4684B0", "Accent colour"),
        _color("theme.color_text", "#BEEEF4", "Text colour"),
        _color("theme.color_text_secondary", "#FFFFFF", "Bright text colour (buttons, highlights)"),
        _color("theme.color_background", "#000000", "Background colour"),
        # Media type accents identify what a thing is, so they are three distinct
        # hues rather than shades of the brand colour (defaults clear 4.5:1 on primary).
        _color("theme.color_media_movie", "#E9D5FF", "Accent for movies"),
        _color("theme.color_media_tv", "#67E8F9", "Accent for TV shows"),
        _color("theme.color_media_book", "#FCD34D", "Accent for books and audiobooks"),
        _text("theme.font", "Spline Sans", "Google Font family name", public=True, allow_empty=False,
              max_length=60, pattern=r"[A-Za-z0-9 \-]{1,60}", pattern_hint="Use a Google Font family name"),
        _text("theme.custom_css", "", "Custom CSS added to every page", public=True, max_length=20000),
        # ---- Sign-in ----
        _bool("features.show_simple_auth", "true", "Allow username and password sign-in", public=True),
        _bool("features.show_plex_auth", "false", "Allow Plex sign-in", public=True),
        _bool("features.show_authentik_auth", "false", "Allow Authentik sign-in", public=True),
        _url("integration.authentik.url", "", "Authentik address", ssrf_check=True),
        _text("integration.authentik.client_id", "", "Authentik client ID", max_length=200),
        _secret("integration.authentik.client_secret", "Authentik client secret"),
        _text("integration.authentik.app_slug", "", "Authentik application slug (used for sign-out)",
              max_length=100, pattern=_TOKEN, pattern_hint=_TOKEN_HINT),
        _text("system.admin_email", "", "People who sign in with this email become admins", seed=False,
              max_length=254, pattern=r"[^@\s]+@[^@\s]+\.[^@\s]+", pattern_hint="Enter a full email address"),
    ]

    # ---- Pages ----
    for pid, (label, sublabel, icon) in PAGE_DEFAULTS.items():
        d.append(_text(f"sidebar.label_{pid}", label, f"Sidebar label for {label}", public=True,
                       max_length=40, allow_empty=False))
        d.append(_text(f"sidebar.sublabel_{pid}", sublabel, f"Sidebar sublabel for {label}", public=True,
                       max_length=60))
        if pid != "settings":   # Settings has no switch: hiding it would lock the admin out
            d.append(_bool(f"sidebar.enabled_{pid}", "true", f"{label} page is on", public=True))
        # Admin-controlled rather than self-retiring: the admin decides how long a
        # page counts as new. Off on a fresh install, where nothing is new.
        d.append(_bool(f"sidebar.new_{pid}", "false", f"Show a New! flag on {label}", public=True))
        d.append(_icon(f"icon.nav_{pid}", icon, f"Sidebar icon for {label}", public=True))
    d += [
        SettingDef("pages.order", json.dumps(DEFAULT_PAGE_ORDER), "json",
                   "Sidebar order (Home first, Settings last)", public=True, max_length=400, allow_empty=False),
        SettingDef("requests.source", "native", "enum", "What the Requests page shows",
                   public=True, choices=("native", "seerr_embed"), allow_empty=False),
    ]
    for sid, (name, icon) in _HOME_SECTION_DEFAULTS.items():
        d.append(_bool(f"home.section_{sid}", "true", f"Show {name} on the home page", public=True))
        d.append(_icon(f"icon.section_{sid}", icon, f"Home page icon for {name}", public=True))
    d += [
        # Home page news window: old posts drop off the home page rather than piling
        # up forever; the /news archive still holds them all.
        _int("news.homepage_count", "3", "News posts shown on the home page", 1, 20, public=True),
        _int("news.homepage_max_age_days", "30", "Hide home page news older than this many days (0 = never)",
             0, 3650, public=True),
        _bool("features.login_backgrounds", "true", "Rotating artwork behind the login page", public=True),
        _text("wiki.hook_tickets", "", "Wiki page shown as help on Tickets", public=True, max_length=220,
              pattern=_SLUG, pattern_hint=_SLUG_HINT),
        _text("wiki.hook_issues", "", "Wiki page shown as help on Issues", public=True, max_length=220,
              pattern=_SLUG, pattern_hint=_SLUG_HINT),
        _text("wiki.hook_playback", "", "Wiki page shown as help for playback problems", public=True,
              max_length=220, pattern=_SLUG, pattern_hint=_SLUG_HINT),
    ]

    # ---- Integrations ----
    d += [
        _url("integration.plex.url", "", "Plex address", ssrf_check=True, seed=False),
        _secret("integration.plex.token", "Plex token", seed=False),
        _url("integration.seerr.url", "", "Seerr address", ssrf_check=True, seed=False),
        _secret("integration.seerr.api_key", "Seerr API key", seed=False),
        _url("integration.chaptarr.url", "", "Chaptarr address", ssrf_check=True),
        _secret("integration.chaptarr.api_key", "Chaptarr API key"),
        _text("integration.chaptarr.root_folder", "", "Chaptarr root folder for eBooks"),
        # Chaptarr ids may be empty: the client falls back to a stock install's profiles.
        _int("integration.chaptarr.quality_profile_id", "1", "Chaptarr quality profile for eBooks", 1, 1000000,
             allow_empty=True),
        _int("integration.chaptarr.metadata_profile_id", "2", "Chaptarr metadata profile for eBooks", 1, 1000000,
             allow_empty=True),
        _text("integration.chaptarr.audiobook_root_folder", "", "Chaptarr root folder for audiobooks"),
        _int("integration.chaptarr.audiobook_quality_profile_id", "2", "Chaptarr quality profile for audiobooks",
             1, 1000000, allow_empty=True),
        _int("integration.chaptarr.audiobook_metadata_profile_id", "1", "Chaptarr metadata profile for audiobooks",
             1, 1000000, allow_empty=True),
        _url("integration.kavita.url", "", "Kavita address", ssrf_check=True),
        _secret("integration.nyt.api_key", "New York Times Books API key"),
        _url("integration.sonarr.url", "", "Sonarr address", ssrf_check=True, seed=False),
        _secret("integration.sonarr.api_key", "Sonarr API key", seed=False),
        _url("integration.radarr.url", "", "Radarr address", ssrf_check=True, seed=False),
        _secret("integration.radarr.api_key", "Radarr API key", seed=False),
        _url("integration.uptime_kuma.url", "", "Uptime Kuma address", ssrf_check=True, seed=False),
        _text("integration.uptime_kuma.slug", "default", "Uptime Kuma status page slug", seed=False,
              max_length=100, pattern=_TOKEN, pattern_hint=_TOKEN_HINT),
        _url("integration.netdata.url", "", "Netdata address", ssrf_check=True, seed=False),
        _secret("integration.netdata.api_key", "Netdata API token", seed=False),
        _text("netdata.cpu_label", "", "Label under the CPU gauge", max_length=40),
        _text("netdata.ram_label", "", "Label under the RAM gauge (blank = detect)", max_length=40),
        _text("netdata.net_label", "", "Label under the network gauge (blank = detect)", max_length=40),
        SettingDef("netdata.net_unit", "mbps", "enum", "Network speed unit", choices=("mbps", "MBps"),
                   allow_empty=False),
        _int("netdata.net_max", "1000", "Network gauge maximum, in the chosen unit", 1, 1000000),
    ]

    # ---- Notifications ----
    for name, label in (("seerr", "request"), ("monitors", "service"), ("news", "news"), ("tickets", "ticket")):
        d.append(_int(f"notifications.poll_interval_{name}", "60",
                      f"Seconds between {label} notification checks", 30, 3600))

    # ---- Retired by the redesign (decision 2 in the plan) ----
    # Folded into one switch per page and one Requests item: no longer seeded
    # or read by the branding builder. Their rows are left alone, and the
    # settings API still accepts them while the old Settings page sends them.
    retired = {"deprecated": True, "seed": False}
    d += [
        _bool("features.show_requests", "false", "Old: show the Seerr embed page", public=True, **retired),
        _bool("features.show_tickets", "true", "Old: Tickets feature flag", public=True, **retired),
        _bool("features.show_books", "true", "Old: eBooks feature flag", public=True, **retired),
        _text("sidebar.label_requests_embed", "Requests (Embed)", "Old: Seerr embed label", public=True,
              max_length=40, allow_empty=False, **retired),
        _text("sidebar.sublabel_requests_embed", "Request through Seerr", "Old: Seerr embed sublabel",
              public=True, max_length=60, **retired),
        _bool("sidebar.enabled_requests_embed", "true", "Old: Seerr embed switch", public=True, **retired),
        _bool("sidebar.new_requests_embed", "false", "Old: Seerr embed New! flag", public=True, **retired),
        _icon("icon.nav_requests_embed", "download", "Old: Seerr embed icon", public=True, **retired),
        # Never read by app/integrations/uptime_kuma.py (the status page API is public).
        _secret("integration.uptime_kuma.api_key", "Old: unused Uptime Kuma API key", deprecated=True, seed=False),
    ]
    return d


_DEFS: List[SettingDef] = _build()
REGISTRY: Dict[str, SettingDef] = {x.key: x for x in _DEFS}
assert len(REGISTRY) == len(_DEFS), "duplicate key in the settings registry"

# Per-user rows that also live in the settings table. Not operator settings:
# never seeded, listed, exported or accepted by the settings API. Their own
# code (app/routers/notifications.py, app/services/notification_poller.py)
# reads and writes them directly.
USER_DATA_PATTERNS: Tuple[Pattern[str], ...] = (
    re.compile(r"^notify\.[0-9a-f]{16}\.[a-z_]+$"),       # notification preferences
)
USER_DATA_MESSAGE = "This is per-user data and can't be changed here"


def is_user_data(key: str) -> bool:
    return any(rx.match(key or "") for rx in USER_DATA_PATTERNS)


PATTERN_DEFS: List[Tuple[Pattern[str], SettingDef]] = [
    (re.compile(r"^monitor\.(\d{1,9})\.enabled$"),
     SettingDef("monitor.{id}.enabled", "true", "bool", "Show this monitor on the home page", seed=False)),
    (re.compile(r"^monitor\.(\d{1,9})\.icon$"),
     SettingDef("monitor.{id}.icon", "", "text", "Icon for this monitor", seed=False, max_length=200,
                pattern=r"[A-Za-z0-9\-_/.:]*", pattern_hint="Use an icon name or image address")),
]


def get_def(key: str) -> Optional[SettingDef]:
    if is_user_data(key):
        return None
    d = REGISTRY.get(key)
    if d is not None:
        return d
    for rx, pd in PATTERN_DEFS:
        if rx.match(key or ""):
            return pd
    return None


def active_defs() -> List[SettingDef]:
    return [x for x in _DEFS if not x.deprecated]


def seed_defaults() -> Dict[str, Tuple[str, str]]:
    return {x.key: (x.default, x.description) for x in _DEFS if x.seed and not x.deprecated}


def switch_is_off(value: Optional[str]) -> bool:
    """True when a stored on/off switch (sidebar.enabled_<page>) means off.

    The one reader for page switches: the page gate (via build_branding) and
    each page's API gate use it, so an out-of-band value such as " False "
    cannot turn a page off in one place and leave it on in the other. Anything
    but "false" (after strip, any case), a missing row included, means on."""
    return (value or "").strip().lower() == "false"


def public_defaults() -> Dict[str, str]:
    return {x.key: x.default for x in _DEFS if x.public and not x.deprecated}


def mask(key: str, value: Optional[str]) -> str:
    d = get_def(key)
    if d is not None and d.secret:
        return MASK if value else ""
    return "" if value is None else value


def meta_for(d: SettingDef) -> dict:
    return {
        "type": d.type, "default": d.default, "secret": d.secret, "public": d.public,
        "description": d.description, "min": d.min, "max": d.max,
        "choices": list(d.choices) if d.choices else None, "max_length": d.max_length,
        "allow_empty": d.allow_empty, "allow_relative": d.allow_relative, "pattern": d.pattern,
    }


_HEX = re.compile(r"#[0-9a-fA-F]{6}")
_ICON = re.compile(r"[a-z0-9_]{1,64}")
_INT = re.compile(r"-?[0-9]{1,9}")   # ASCII digits only: \d also matches other scripts' digits


def safe_font(value) -> str:
    """The display font as it may reach CSS or a font URL: the stored name,
    trimmed, when it full-matches theme.font's pattern, else its default.

    The one rule for the branding payload (app/routers/branding.py, which
    theme-loader.js applies inline on every page) and the page renderer's
    #ws-theme / #ws-font (app/pages.py), so the two can't drift. A legacy or
    hand-edited row never reaches the browser."""
    d = REGISTRY["theme.font"]
    v = value.strip() if isinstance(value, str) else ""
    return v if d.pattern and re.fullmatch(d.pattern, v) else d.default


def safe_color(key: str, value) -> str:
    """A stored theme colour as it may reach CSS: exactly #rrggbb, else the
    key's registry default. Shared like safe_font."""
    return value if isinstance(value, str) and _HEX.fullmatch(value) else REGISTRY[key].default


def _validate_url(d: SettingDef, v: str) -> Optional[str]:
    # Imported here: app.utils and app.routers.branding pull in the app, and the
    # branding router will itself import this module for its defaults.
    from app.utils import is_safe_integration_url, safe_http_url, same_origin_path

    if any(c.isspace() for c in v) or "\\" in v:
        return "Addresses can't contain spaces or backslashes"
    if d.allow_relative and v.startswith("/"):
        if not same_origin_path(v):
            return "Enter a full address starting with https://, or a path on this site"
    elif not safe_http_url(v):
        # safe_http_url parses the whole URL (an unclosed "[::1" or a port
        # past 65535 is refused, not raised), so nothing below sees a URL
        # that fails to parse.
        if d.allow_relative:
            return "Enter a full address starting with https://, or a path on this site"
        return "Enter a full address starting with http:// or https://"
    if d.key == "branding.logo_url":
        # The branding builder blanks any logo safe_logo_url rejects, so a logo
        # stored past that rule would silently vanish: store only what it serves.
        from app.routers.branding import safe_logo_url
        if not safe_logo_url(v):
            return "Enter a full address starting with https://, or a path on this site"
    if d.ssrf_check and not is_safe_integration_url(v):
        return "That address isn't allowed (loopback, link-local and metadata addresses are blocked)"
    return None


def _validate_page_order(v: str) -> Optional[str]:
    try:
        items = json.loads(v)
    except ValueError:
        return "Page order is not valid"
    if not isinstance(items, list) or not all(isinstance(i, str) for i in items):
        return "Page order is not valid"
    if len(items) != len(SIDEBAR_PAGE_IDS) or set(items) != set(SIDEBAR_PAGE_IDS):
        return "Page order must list every page exactly once"
    if items[0] != "home" or items[-1] != "settings":
        return "Home must come first and Settings last"
    return None


def validate_value(key: str, value: str) -> Optional[str]:
    """A plain-English reason the value can't be stored, or None when it can."""
    if is_user_data(key):
        return USER_DATA_MESSAGE
    d = get_def(key)
    if d is None:
        return "Unknown setting"
    if not isinstance(value, str):
        return "Must be text"
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        # A lone UTF-16 surrogate: SQLite can't bind it, so the write would 500.
        return "Contains characters that can't be stored"
    if "\x00" in value:
        return "Contains a character that isn't allowed"
    if d.type == "bool":
        return None if value in ("true", "false") else "Must be on or off"
    if value == "":
        return None if d.allow_empty else "This can't be empty"
    if len(value) > d.max_length:
        return f"Must be {d.max_length} characters or fewer"
    if d.type == "int":
        if not _INT.fullmatch(value):
            return "Enter a whole number"
        n = int(value)
        if (d.min is not None and n < d.min) or (d.max is not None and n > d.max):
            return f"Enter a number from {d.min} to {d.max}"
        return None
    if d.type == "enum":
        return None if value in (d.choices or ()) else "Choose one of: " + ", ".join(d.choices or ())
    if d.type == "color":
        return None if _HEX.fullmatch(value) else "Enter a colour like #125793"
    if d.type == "icon":
        return None if _ICON.fullmatch(value) else "Use an icon name (lowercase letters, digits and _)"
    if d.type == "url":
        return _validate_url(d, value)
    if d.type == "json":
        if d.key == "pages.order":
            return _validate_page_order(value)
        try:
            json.loads(value)
        except ValueError:
            return "Not valid JSON"
        return None
    if d.pattern and not re.fullmatch(d.pattern, value):
        return d.pattern_hint or "That value isn't allowed"
    return None


def normalize_page_order(raw: Optional[str]) -> List[str]:
    """Always a renderable order: Home first, Settings last, every known page once.

    Unknown ids are dropped, duplicates collapse, and pages missing from a stale
    value (for example one added in a later release) are appended before Settings
    in their default position order."""
    try:
        items = json.loads(raw) if isinstance(raw, str) and raw.strip() else []
    except ValueError:
        items = []
    if not isinstance(items, list):
        items = []
    middle: List[str] = []
    for it in items:
        if isinstance(it, str) and it in SIDEBAR_PAGE_IDS and it not in ("home", "settings") and it not in middle:
            middle.append(it)
    for pid in DEFAULT_PAGE_ORDER:
        if pid not in ("home", "settings") and pid not in middle:
            middle.append(pid)
    return ["home"] + middle + ["settings"]
