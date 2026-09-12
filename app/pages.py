"""
Server-side page rendering.

Every HTML route reads a static file and passes it through here. The page
leaves the server with:

  * the shell (sidebar, header, mobile bar) already in the markup, rendered
    for the signed-in user and the operator's branding;
  * the theme variables and the display font already in <head>;
  * a JSON data block (#ws-data) carrying the branding payload, the user and
    the app version, which the client reads instead of fetching /api/branding,
    /auth/check-session and /health on every click.

The browser therefore paints a complete frame from the first byte and the
frame is byte-identical from page to page, which is what lets a cross-document
view transition keep it visually stationary. JavaScript only decorates.

Design: docs/superpowers/specs/2026-09-12-navigation-load-feel-design.md
"""

import hashlib
import html
import json
import logging
import os
import re
import urllib.parse
from typing import Optional

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.config import settings
from app.database import SessionLocal

logger = logging.getLogger(__name__)

# Where the static files live inside the container. Module-level so tests can
# point it at a temporary directory.
STATIC_DIR = "/app/app/static"

# ---------------------------------------------------------------------------
# Navigation registry
# ---------------------------------------------------------------------------
#
# The one list of destinations. Labels, sublabels and icons here are the
# shipped defaults; the operator's overrides come from the branding payload
# (Settings > Customization) and are applied in visible_nav_items().
#
# Label is the destination's name; sublabel says what you do there. Every
# item carries one -- descriptions on only some items read as unfinished,
# and the pair only disambiguates Issues from Tickets if the whole list is
# written in the same voice. All sublabels are verb phrases for that reason.
NAV_ITEMS = [
    {"id": "home", "href": "/", "label": "Home", "icon": "home",
     "sublabel": "See what's happening"},
    {"id": "requests", "href": "/requests", "label": "Requests", "icon": "movie",
     "sublabel": "Request a movie or show"},
    {"id": "requests-embed", "href": "/requests-embed", "label": "Requests (Embed)", "icon": "download",
     "sublabel": "Request through Seerr", "feature": "show_requests", "badge_id": "requestsBadge"},
    {"id": "issues", "href": "/issues", "label": "Issues", "icon": "report_problem",
     "sublabel": "Report a problem with media"},
    {"id": "calendar", "href": "/calendar", "label": "Calendar", "icon": "calendar_month",
     "sublabel": "See upcoming releases"},
    {"id": "tickets", "href": "/tickets", "label": "Tickets", "icon": "confirmation_number",
     "sublabel": "Get help from the admin", "feature": "show_tickets"},
    {"id": "library", "href": "/library", "label": "eBooks", "icon": "menu_book",
     "sublabel": "Read books in your browser", "feature": "show_books"},
    {"id": "wiki", "href": "/wiki", "label": "Wiki", "icon": "library_books",
     "sublabel": "Read guides and how-tos"},
    {"id": "settings", "href": "/settings", "label": "Settings", "icon": "settings",
     "sublabel": "Manage the site", "admin_only": True},
]

# Which nav item a page highlights. The news archive is part of Home.
PAGE_NAV = {
    "index": "home",
    "news": "home",
    "requests": "requests",
    "requests-embed": "requests-embed",
    "issues": "issues",
    "calendar": "calendar",
    "tickets": "tickets",
    "library": "library",
    "wiki": "wiki",
    "settings": "settings",
}

# ---------------------------------------------------------------------------
# Theme: colours, font
# ---------------------------------------------------------------------------

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_FONT = re.compile(r"^[A-Za-z0-9 \-]{1,60}$")
DEFAULT_FONT = "Spline Sans"

# Must match the :root defaults in app/static/css/theme.css.
_DEFAULT_COLORS = {
    "primary": "#125793",
    "secondary": "#2C6DA1",
    "accent": "#4684B0",
    "text": "#BEEEF4",
    "text_secondary": "#FFFFFF",
    "background": "#000000",
    "media_movie": "#E9D5FF",
    "media_tv": "#67E8F9",
    "media_book": "#FCD34D",
}
# (css variable suffix, branding colour key)
_COLOR_VARS = [
    ("primary", "primary"),
    ("secondary", "secondary"),
    ("accent", "accent"),
    ("text", "text"),
    ("text-secondary", "text_secondary"),
    ("background", "background"),
    ("media-movie", "media_movie"),
    ("media-tv", "media_tv"),
    ("media-book", "media_book"),
]


def _rgb(hex_value: str) -> str:
    """'#125793' -> '18 87 147' (the triplet form Tailwind's alpha syntax needs)."""
    h = hex_value.lstrip("#")
    return f"{int(h[0:2], 16)} {int(h[2:4], 16)} {int(h[4:6], 16)}"


def _safe_hex(value, fallback: str) -> str:
    return value if isinstance(value, str) and _HEX.match(value) else fallback


def _safe_font(value) -> str:
    if isinstance(value, str) and _FONT.match(value.strip()):
        return value.strip()
    return DEFAULT_FONT


def _safe_url(value) -> str:
    """Only http(s) or a same-origin absolute path may reach an attribute."""
    v = (value or "").strip()
    if v.startswith(("https://", "http://")):
        return v
    if v.startswith("/") and not v.startswith("//"):
        return v
    return ""


def theme_style(branding: dict) -> str:
    """Inline :root variables so the first paint is already in the operator's colours."""
    colors = branding.get("colors") or {}
    decls = []
    for var, key in _COLOR_VARS:
        hexv = _safe_hex(colors.get(key), _DEFAULT_COLORS[key])
        decls.append(f"--color-{var}:{_rgb(hexv)}")
        decls.append(f"--hex-{var}:{hexv}")
    decls.append(f'--font-display:"{_safe_font(branding.get("font"))}",sans-serif')
    return '<style id="ws-theme">:root{' + ";".join(decls) + "}</style>"


def font_links(branding: dict) -> str:
    """The display font, loaded statically with preconnects (no runtime injection)."""
    family = _safe_font(branding.get("font"))
    href = (
        "https://fonts.googleapis.com/css2?family="
        + urllib.parse.quote_plus(family)
        + ":wght@300;400;500;600;700&display=swap"
    )
    return (
        '<link rel="preconnect" href="https://fonts.googleapis.com">'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
        f'<link id="ws-font" rel="stylesheet" href="{html.escape(href, quote=True)}">'
    )


# ---------------------------------------------------------------------------
# Data block and user
# ---------------------------------------------------------------------------

def data_block(branding: dict, user: Optional[dict], version: str, name: str) -> str:
    """
    The payload the client reads at parse time.

    It is data, not code: a JSON script type never executes, so CSP does not
    apply. Every '<' is emitted as \\u003c so no value can close the element.
    """
    payload = {"branding": branding, "user": user, "version": version, "page": name}
    text = json.dumps(payload, separators=(",", ":")).replace("<", "\\u003c")
    return f'<script id="ws-data" type="application/json">{text}</script>'


def public_user(session: Optional[dict]) -> Optional[dict]:
    """The same shape /auth/check-session returns, from the Redis session dict."""
    if not session:
        return None
    return {
        "username": session.get("username", ""),
        "display_name": session.get("display_name", ""),
        "is_admin": session.get("is_admin", "false") == "true",
        "avatar_url": _safe_url(session.get("avatar_url", "")),
        "auth_method": session.get("auth_method", ""),
    }


# ---------------------------------------------------------------------------
# Navigation rendering
# ---------------------------------------------------------------------------
#
# Class lists are literal strings here on purpose: this file is in the Tailwind
# content globs (tailwind.config.js), so every class below is compiled.

_LINK_ACTIVE = (
    '<a class="relative flex items-center gap-3 px-4 py-2.5 rounded-lg bg-primary text-background-dark '
    'font-bold transition-all shadow-baltic-blue/20" href="{href}" aria-current="page">'
    '<span class="material-symbols-outlined fill-1 shrink-0">{icon}</span>{label}{badge}</a>'
)
_LINK = (
    '<a class="relative flex items-center gap-3 px-4 py-2.5 rounded-lg hover:bg-frosted-blue/5 text-frosted-blue '
    'transition-all group" href="{href}">'
    '<span class="material-symbols-outlined text-steel-blue group-hover:text-primary transition-colors shrink-0">{icon}</span>'
    '{label}{badge}</a>'
)
# A sublabel stacks under the label instead of sitting beside it, so the nav
# keeps one scannable column of names with the clarification as secondary
# text. On the active pill it rides the inherited colour at reduced opacity
# rather than introducing a second one.
_LABEL_WITH_SUB = (
    '<span class="flex flex-col min-w-0 leading-tight">'
    '<span class="truncate">{label}{flag}</span>'
    '<span class="text-[10px] font-normal truncate mt-0.5 {subcls}">{sub}</span>'
    '</span>'
)
_BADGE = '<span id="{bid}" class="ml-auto bg-primary/20 text-[10px] px-1.5 py-0.5 rounded font-bold hidden"></span>'
_NEW_FLAG = '<span class="nav-new-badge">New!</span>'


def visible_nav_items(branding: dict, is_admin: bool) -> list:
    """NAV_ITEMS filtered by role, feature flags and the operator's per-item switches,
    with label/sublabel/icon overrides applied."""
    features = branding.get("features") or {}
    enabled = branding.get("sidebar_enabled") or {}
    labels = branding.get("sidebar_labels") or {}
    sublabels = branding.get("sidebar_sublabels") or {}
    icons = branding.get("icons") or {}
    new_flags = branding.get("sidebar_new") or {}

    out = []
    for item in NAV_ITEMS:
        if item.get("admin_only") and not is_admin:
            continue
        # Settings has no switch: hiding it would lock the admin out of the
        # only page that could turn it back on.
        if item["id"] != "settings" and enabled.get(item["id"]) is False:
            continue
        if item.get("feature") and not features.get(item["feature"]):
            continue
        it = dict(item)
        if labels.get(item["id"]):
            it["label"] = labels[item["id"]]
        if icons.get("nav_" + item["id"]):
            it["icon"] = icons["nav_" + item["id"]]
        # Unlike label and icon, an empty sublabel is a real choice ("hide the
        # second line"), so test for presence rather than truthiness.
        if item["id"] in sublabels:
            it["sublabel"] = sublabels[item["id"]]
        it["new"] = bool(new_flags.get(item["id"]))
        out.append(it)
    return out


def render_nav_links(branding: dict, is_admin: bool, active_id: Optional[str]) -> str:
    parts = []
    for it in visible_nav_items(branding, is_admin):
        active = it["id"] == active_id
        flag = _NEW_FLAG if it["new"] else ""
        if it.get("sublabel"):
            label = _LABEL_WITH_SUB.format(
                label=html.escape(it["label"]),
                flag=flag,
                sub=html.escape(it["sublabel"]),
                subcls="opacity-70" if active else "text-steel-blue",
            )
        else:
            label = "<span>" + html.escape(it["label"]) + flag + "</span>"
        badge = _BADGE.format(bid=html.escape(it["badge_id"])) if it.get("badge_id") else ""
        template = _LINK_ACTIVE if active else _LINK
        parts.append(template.format(
            href=html.escape(it["href"], quote=True),
            icon=html.escape(it["icon"]),
            label=label,
            badge=badge,
        ))
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Shell partials
# ---------------------------------------------------------------------------

SIDEBAR_MARKER = "<!-- ws:sidebar -->"
HEADER_MARKER = "<!-- ws:header -->"


def _partial(filename: str) -> str:
    path = os.path.join(STATIC_DIR, "partials", filename)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


_RAW_RE = re.compile(r"\{\{\{(\w+)\}\}\}")
_ESC_RE = re.compile(r"\{\{(\w+)\}\}")


def fill(template: str, values: dict) -> str:
    """Tiny substitution: {{key}} is HTML-escaped, {{{key}}} is inserted raw
    (only for HTML this module rendered itself). Unknown keys become empty."""
    template = _RAW_RE.sub(lambda m: str(values.get(m.group(1), "")), template)
    return _ESC_RE.sub(lambda m: html.escape(str(values.get(m.group(1), "")), quote=True), template)


def shell_values(branding: dict, user: Optional[dict], version: str, name: str) -> dict:
    is_admin = bool(user and user.get("is_admin"))
    icons = branding.get("icons") or {}

    logo = _safe_url(branding.get("logo_url"))
    if logo:
        logo_html = (
            f'<img src="{html.escape(logo, quote=True)}" alt="Logo" '
            'class="w-full h-auto rounded-lg object-contain mb-3">'
        )
    else:
        logo_icon = html.escape(icons.get("sidebar_logo") or "settings_input_component")
        logo_html = (
            '<div class="size-14 bg-primary rounded-lg flex items-center justify-center '
            'shadow-lg shadow-baltic-blue/20 mb-3">'
            f'<span class="material-symbols-outlined text-background-dark font-bold text-3xl">{logo_icon}</span>'
            '</div>'
        )

    avatar = (user or {}).get("avatar_url") or ""
    avatar_style = ""
    if avatar:
        avatar_style = (
            f"background-image:url('{html.escape(avatar, quote=True)}');"
            "background-size:cover;background-position:center"
        )

    return {
        "app_name": branding.get("app_name") or "WebServarr",
        "logo_html": logo_html,
        "nav_links": render_nav_links(branding, is_admin, PAGE_NAV.get(name)),
        "version": ("v" + version) if version else "",
        "admin_block": "" if is_admin else "hidden",
        "user_name": (user or {}).get("display_name") or (user or {}).get("username") or "",
        "user_role": ("Admin" if is_admin else "User") if user else "",
        "avatar_style": avatar_style,
    }


# ---------------------------------------------------------------------------
# <head>: title, link preview, theme, font, data
# ---------------------------------------------------------------------------
#
# Messaging apps, Discord, Slack and search crawlers read the HTML they are
# served and never execute JavaScript, so whatever is baked into the static
# file is what the world sees. The pages ship with a hardcoded "WebServarr"
# title, which is why a shared link would otherwise preview under the
# software's name instead of the operator's.

_TITLE_RE = re.compile(r"<title>.*?</title>", re.IGNORECASE | re.DOTALL)

# Existing titles read "WebServarr - Control Center". Keep the descriptive half,
# swap the brand half, so every page stays self-describing in a browser tab.
_TITLE_SUFFIX_RE = re.compile(r"^\s*\S.*?\s+-\s+(?P<suffix>.+?)\s*$", re.DOTALL)


def _base_url(request: Optional[Request]) -> str:
    """Absolute scheme://host for this request, honouring a reverse proxy."""
    if request is None:
        return ""
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    if not proto:
        proto = request.url.scheme or "https"
    host = (
        request.headers.get("x-forwarded-host", "").split(",")[0].strip()
        or request.headers.get("host", "").strip()
        or request.url.netloc
    )
    if not host:
        return ""
    return f"{proto}://{host}"


def _preview_meta(branding: dict, base_url: str, path: str) -> tuple:
    """
    Build (app_name, meta_tags_html) for the link preview.

    The image is omitted when the logo is an SVG: no major messaging client
    renders SVG in a link card, and advertising one produces a preview with a
    broken thumbnail rather than the clean text-only card you get without it.
    """
    app_name = (branding.get("app_name") or "").strip() or "WebServarr"
    tagline = (branding.get("tagline") or "").strip()

    image_url = ""
    logo = (branding.get("logo_url") or "").strip()
    if logo and not logo.lower().endswith(".svg"):
        image_url = logo if logo.startswith(("http://", "https://")) else f"{base_url}{logo}"

    page_url = f"{base_url}{path}" if base_url and path else ""

    def e(v: str) -> str:
        return html.escape(v, quote=True)

    tags = [
        f'<meta property="og:site_name" content="{e(app_name)}">',
        f'<meta property="og:title" content="{e(app_name)}">',
        '<meta property="og:type" content="website">',
        f'<meta name="twitter:title" content="{e(app_name)}">',
    ]
    if tagline:
        tags.insert(0, f'<meta name="description" content="{e(tagline)}">')
        tags.append(f'<meta property="og:description" content="{e(tagline)}">')
        tags.append(f'<meta name="twitter:description" content="{e(tagline)}">')
    if page_url:
        tags.append(f'<meta property="og:url" content="{e(page_url)}">')
    if image_url:
        tags.append(f'<meta property="og:image" content="{e(image_url)}">')
        tags.append(f'<meta name="twitter:image" content="{e(image_url)}">')
        tags.append('<meta name="twitter:card" content="summary_large_image">')
    else:
        tags.append('<meta name="twitter:card" content="summary">')

    return app_name, "\n".join(tags)


def _inject_head(content: str, branding: dict, user: Optional[dict], version: str,
                 name: str, base_url: str, path: str) -> str:
    """Rewrite <title> and append, right after it: preview tags, theme, font, data."""
    app_name, tags = _preview_meta(branding, base_url, path)
    extra = "\n".join([tags, theme_style(branding), font_links(branding),
                       data_block(branding, user, version, name)])

    def _rewrite(match):
        inner = match.group(0)[len("<title>"):-len("</title>")]
        suffix_match = _TITLE_SUFFIX_RE.match(inner)
        title = f"{app_name} - {suffix_match.group('suffix')}" if suffix_match else app_name
        return f"<title>{html.escape(title)}</title>\n{extra}"

    content, count = _TITLE_RE.subn(_rewrite, content, count=1)
    if count == 0:
        # No <title> to anchor to; fall back to the top of <head>.
        content = content.replace(
            "<head>", f"<head>\n<title>{html.escape(app_name)}</title>\n{extra}", 1
        )
    return content


# ---------------------------------------------------------------------------
# Asset cache-busting
# ---------------------------------------------------------------------------
#
# Every page carries "?v=N" markers on its own script and link tags. The marker
# is rewritten at serve time to "<app version>-<content hash>", so a release
# and an edit on a bind-mounted dev checkout both invalidate the browser cache
# exactly once, and nobody has to remember to bump a number. Only local
# /static/ assets are touched, and only an existing ?v= marker is replaced.

_ASSET_VERSION_RE = re.compile(r'(?P<attr>(?:src|href)="(?P<path>/static/[^"?]+)\?v=)[^"]*"')
_stamp_cache: dict = {}


def _read_static_bytes(static_path: str):
    """(bytes, mtime) for a /static/... path, or None if it does not exist."""
    fs_path = os.path.join(STATIC_DIR, static_path[len("/static/"):])
    try:
        st = os.stat(fs_path)
        with open(fs_path, "rb") as f:
            return f.read(), st.st_mtime
    except OSError:
        return None


def asset_stamp(static_path: str) -> str:
    version = (settings.app_version or "dev").strip() or "dev"
    got = _read_static_bytes(static_path)
    if not got:
        return version
    data, mtime = got
    key = (static_path, mtime)
    if key not in _stamp_cache:
        _stamp_cache[key] = hashlib.sha1(data).hexdigest()[:8]
    return f"{version}-{_stamp_cache[key]}"


def _stamp_asset_versions(content: str) -> str:
    return _ASSET_VERSION_RE.sub(
        lambda m: f'{m.group("attr")}{asset_stamp(m.group("path"))}"', content
    )


# ---------------------------------------------------------------------------
# Renderer
# ---------------------------------------------------------------------------

def render_html(page_html: str, *, name: str, branding: dict, user: Optional[dict],
                version: str, base_url: str, path: str, flags: dict) -> str:
    """Pure: turn a static page into the document this user should receive."""
    out = _inject_head(page_html, branding, user, version, name, base_url, path)

    if SIDEBAR_MARKER in out or HEADER_MARKER in out:
        values = shell_values(branding, user, version, name)
        out = out.replace(SIDEBAR_MARKER, fill(_partial("shell-sidebar.html"), values), 1)
        out = out.replace(HEADER_MARKER, fill(_partial("shell-header.html"), values), 1)

    attrs = f' data-page="{html.escape(name, quote=True)}"'
    if user and user.get("is_admin"):
        attrs += " data-admin"
    if flags.get("netdata"):
        attrs += " data-netdata"
    out = re.sub(r"<html\b", "<html" + attrs, out, count=1)

    return _stamp_asset_versions(out)


def load_context(signed_in: bool) -> tuple:
    """(branding, flags) from the database; packaged defaults if it is unavailable.

    Deliberately its own short-lived session rather than a request dependency:
    every page route needs this, and a database hiccup must not stop a page
    from being served."""
    from app.routers.branding import EMPTY_WIKI_HOOKS, build_branding, load_branding

    db = None
    try:
        from app.models import Setting

        db = SessionLocal()
        branding = load_branding(db, signed_in)
        netdata = db.query(Setting).filter(Setting.key == "integration.netdata.url").first()
        flags = {"netdata": bool(netdata and netdata.value)}
    except Exception:  # pragma: no cover - defensive
        logger.warning("Could not load branding for page render; using defaults", exc_info=True)
        branding = build_branding({}, {}, None, dict(EMPTY_WIKI_HOOKS))
        flags = {"netdata": False}
    finally:
        if db is not None:
            db.close()
    return branding, flags


def render_page(name: str, request: Optional[Request], user: Optional[dict]):
    """Read app/static/<name>.html, render it for this user, and return it, or 404."""
    filepath = os.path.join(STATIC_DIR, name + ".html")
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            page_html = f.read()
    except FileNotFoundError:
        return JSONResponse(
            status_code=404,
            content={"detail": f"{name} page not found. Static files missing."},
        )

    branding, flags = load_context(user is not None)
    try:
        out = render_html(
            page_html,
            name=name,
            branding=branding,
            user=public_user(user),
            version=(settings.app_version or "dev"),
            base_url=_base_url(request),
            path=(request.url.path if request is not None else "/"),
            flags=flags,
        )
    except Exception:  # pragma: no cover - a rendering bug must never take a page down
        logger.warning("Page rendering failed for %s; serving the raw file", name, exc_info=True)
        out = page_html
    return HTMLResponse(content=out)
