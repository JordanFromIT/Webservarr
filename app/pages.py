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
from typing import Callable, Optional

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from app.config import settings
from app.database import SessionLocal
from app.settings_registry import PAGE_DEFAULTS, SIDEBAR_PAGE_IDS, normalize_page_order
from app.settings_registry import REGISTRY as _REGISTRY
from app.utils import identity_email, safe_http_url, same_origin_path

logger = logging.getLogger(__name__)

# Where the static files live inside the container. Module-level so tests can
# point it at a temporary directory.
STATIC_DIR = "/app/app/static"

# ---------------------------------------------------------------------------
# Navigation registry
# ---------------------------------------------------------------------------
#
# The one list of destinations. Routes are fixed (page addresses are not
# configurable). Labels, sublabels and icons are the shipped defaults from
# app/settings_registry.py; the operator's overrides, switches and order come
# from the branding payload (Settings) and are applied in visible_nav_items().

_NAV_HREF = {
    "home": "/", "requests": "/requests", "issues": "/issues", "calendar": "/calendar",
    "tickets": "/tickets", "library": "/ebooks", "wiki": "/wiki", "settings": "/settings",
}
_NAV_EXTRA = {
    # The pending-requests count rides on the one Requests item.
    "requests": {"badge": "requestsBadge"},
    # eBooks only exists while Kavita is configured (features.show_books).
    "library": {"feature": "show_books"},
    "settings": {"admin_only": True},
}
NAV_ITEMS = [
    dict({"id": pid, "href": _NAV_HREF[pid], "label": PAGE_DEFAULTS[pid][0],
          "sublabel": PAGE_DEFAULTS[pid][1], "icon": PAGE_DEFAULTS[pid][2]}, **_NAV_EXTRA.get(pid, {}))
    for pid in SIDEBAR_PAGE_IDS
]

# Which nav item a page highlights. The news archive is part of Home; the
# Seerr embed is what Requests shows when its source is "seerr_embed".
PAGE_NAV = {
    "index": "home",
    "news": "home",
    "requests": "requests",
    "requests-embed": "requests",
    "issues": "issues",
    "calendar": "calendar",
    "tickets": "tickets",
    "library": "library",
    "wiki": "wiki",
    "settings": "settings",
    "settings-next": "settings",
}

# ---------------------------------------------------------------------------
# Theme: colours, font
# ---------------------------------------------------------------------------

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_FONT = re.compile(r"^[A-Za-z0-9 \-]{1,60}$")
DEFAULT_FONT = _REGISTRY["theme.font"].default

# Fallbacks when a stored colour is not a valid hex. Taken from the registry;
# app/static/css/theme.css repeats them as :root defaults (a test keeps the two equal).
_DEFAULT_COLORS = {
    key: _REGISTRY["theme.color_" + key].default
    for key in ("primary", "secondary", "accent", "text", "text_secondary", "background",
                "media_movie", "media_tv", "media_book")
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
    if v.lower().startswith(("https://", "http://")):  # schemes are case-insensitive
        return safe_http_url(v)
    return same_origin_path(v)


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
    """The same shape /auth/check-session returns, from the Redis session dict.

    has_email says whether the account can receive notifications and push
    (see utils.identity_email); the address itself never goes into the page.
    """
    if not session:
        return None
    return {
        "username": session.get("username", ""),
        "display_name": session.get("display_name", ""),
        "is_admin": session.get("is_admin", "false") == "true",
        "avatar_url": _safe_url(session.get("avatar_url", "")),
        "auth_method": session.get("auth_method", ""),
        "has_email": bool(identity_email(session.get("email"))),
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
#
# The New! flag is a sibling of the truncating label, never inside it:
# truncate is overflow:hidden, and the flag deliberately paints taller than
# the line it sits on (see .nav-new-badge in theme.css), so inside the label
# its top and bottom were clipped off. As a sibling it also stays visible when
# a long label truncates.
_LABEL_WITH_SUB = (
    '<span class="flex flex-col min-w-0 leading-tight">'
    '<span class="flex items-baseline min-w-0"><span class="truncate">{label}</span>{flag}</span>'
    '<span class="text-[10px] font-normal truncate mt-0.5 {subcls}">{sub}</span>'
    '</span>'
)
# A data attribute, not an id: the nav links are rendered twice (desktop
# sidebar and phone drawer), so an id would be duplicated on every page.
_BADGE = '<span data-badge="{bid}" class="ml-auto bg-primary/20 text-[10px] px-1.5 py-0.5 rounded font-bold hidden"></span>'
_NEW_FLAG = '<span class="nav-new-badge">New!</span>'


def visible_nav_items(branding: dict, is_admin: bool) -> list:
    """NAV_ITEMS in the operator's page order, filtered by role, feature flags
    and the operator's per-page switches, with label/sublabel/icon overrides applied."""
    features = branding.get("features") or {}
    enabled = branding.get("sidebar_enabled") or {}
    labels = branding.get("sidebar_labels") or {}
    sublabels = branding.get("sidebar_sublabels") or {}
    icons = branding.get("icons") or {}
    new_flags = branding.get("sidebar_new") or {}

    by_id = {item["id"]: item for item in NAV_ITEMS}
    order = normalize_page_order(json.dumps(branding.get("pages_order") or []))

    out = []
    for pid in order:
        item = by_id[pid]
        if item.get("admin_only") and not is_admin:
            continue
        # Home and Settings have no working switch (see build_branding): Home is
        # where everyone lands, and hiding Settings would lock the admin out of
        # the only page that could turn it back on.
        if pid not in ("home", "settings") and enabled.get(pid) is False:
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


def page_is_off(page_id: str, branding: dict) -> bool:
    """True when the operator switched this page off (Settings > Pages).
    Home and Settings cannot be switched off."""
    if page_id in ("home", "settings"):
        return False
    return (branding.get("sidebar_enabled") or {}).get(page_id) is False


# Shown to admins on a page that is switched off. Server-rendered under the
# header, so it is part of the first paint and moves nothing.
PAGE_OFF_BANNER = (
    '<div id="pageOffBanner" role="status" class="mx-4 lg:mx-8 mt-4 flex items-center gap-3 '
    'rounded-xl border border-frosted-blue/10 bg-primary/15 px-4 py-3 text-sm font-semibold text-frosted-blue">'
    '<span class="material-symbols-outlined text-base" aria-hidden="true">visibility_off</span>'
    'This page is turned off. Only admins can see it.</div>'
)


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
        badge = _BADGE.format(bid=html.escape(it["badge"], quote=True)) if it.get("badge") else ""
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


def _site_name(branding: dict) -> str:
    """The operator's site name, trimmed. It may be "": an empty name is a
    deliberate choice (Settings > General) and the logo then stands alone.
    Only a payload with no name at all falls back to the shipped default."""
    value = branding.get("app_name")
    if value is None:
        value = _REGISTRY["branding.app_name"].default
    return str(value).strip()


def shell_values(branding: dict, user: Optional[dict], version: str, name: str) -> dict:
    is_admin = bool(user and user.get("is_admin"))
    icons = branding.get("icons") or {}
    site_name = _site_name(branding)

    logo = _safe_url(branding.get("logo_url"))
    logo_icon = html.escape(icons.get("sidebar_logo") or _REGISTRY["icon.sidebar_logo"].default)
    if logo:
        # A fixed box: an unsized image would push the whole nav down the
        # moment it arrived on a cold load (the one layout shift the shell had).
        logo_html = (
            f'<img src="{html.escape(logo, quote=True)}" alt="Logo" '
            'class="w-full h-24 rounded-lg object-contain mb-3">'
        )
    else:
        logo_html = (
            '<div class="size-14 bg-primary rounded-lg flex items-center justify-center '
            'shadow-lg shadow-baltic-blue/20 mb-3">'
            f'<span class="material-symbols-outlined text-background-dark font-bold text-3xl">{logo_icon}</span>'
            '</div>'
        )

    # The phone top bar carries the site name; with no name it carries the
    # logo instead, so the bar is never unbranded. A fixed box again, so the
    # image arriving cannot move the buttons either side of it.
    bar_logo_html = ""
    if not site_name:
        if logo:
            mark = (f'<img src="{html.escape(logo, quote=True)}" alt="" '
                    'class="h-8 w-24 object-contain">')
        else:
            mark = ('<span class="size-8 bg-primary rounded-md flex items-center justify-center">'
                    f'<span class="material-symbols-outlined text-background-dark text-xl">{logo_icon}</span>'
                    '</span>')
        bar_logo_html = f'<a href="/" aria-label="Home" class="flex items-center justify-center max-w-[40%]">{mark}</a>'

    avatar = (user or {}).get("avatar_url") or ""
    avatar_style = ""
    if avatar:
        # Unquoted url(): percent-encoding removes every character that could
        # end the token (quotes, parens, whitespace, backslash), and the value
        # is then attribute-escaped by fill(). Scheme checked by public_user().
        css_url = urllib.parse.quote(avatar, safe="/:?&=%.-_~+@#,;")
        avatar_style = f"background-image:url({css_url});background-size:cover;background-position:center"

    return {
        # May be empty (Settings > General): the sidebar then shows the logo alone.
        "app_name": site_name,
        "app_name_cls": "" if site_name else "hidden",
        "bar_logo_html": bar_logo_html,
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
    Build (app_name, meta_tags_html) for the link preview. app_name may be "":
    the card then leads with the tagline and names no site.

    The image is omitted when the logo is an SVG: no major messaging client
    renders SVG in a link card, and advertising one produces a preview with a
    broken thumbnail rather than the clean text-only card you get without it.
    """
    app_name = _site_name(branding)
    tagline = (branding.get("tagline") or "").strip()
    display = app_name or tagline

    image_url = ""
    logo = (branding.get("logo_url") or "").strip()
    # The file part decides: logo URLs may carry a ?query or #fragment. A
    # value that does not parse gets no image rather than breaking the page.
    try:
        logo_path = urllib.parse.urlsplit(logo).path if logo else ""
    except ValueError:
        logo = logo_path = ""
    if logo and not logo_path.lower().endswith(".svg"):
        absolute = logo.lower().startswith(("http://", "https://"))
        image_url = logo if absolute else f"{base_url}{logo}"

    page_url = f"{base_url}{path}" if base_url and path else ""

    def e(v: str) -> str:
        return html.escape(v, quote=True)

    tags = ['<meta property="og:type" content="website">']
    if display:
        tags.insert(0, f'<meta property="og:title" content="{e(display)}">')
        tags.append(f'<meta name="twitter:title" content="{e(display)}">')
    if app_name:
        tags.insert(0, f'<meta property="og:site_name" content="{e(app_name)}">')
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
    # A page with no descriptive title of its own, on a site with no name,
    # falls back to the tagline (or nothing) rather than a dangling " - ".
    bare_title = app_name or (branding.get("tagline") or "").strip()
    extra = "\n".join([tags, theme_style(branding), font_links(branding),
                       data_block(branding, user, version, name)])

    def _rewrite(match):
        inner = match.group(0)[len("<title>"):-len("</title>")]
        suffix_match = _TITLE_SUFFIX_RE.match(inner)
        suffix = suffix_match.group("suffix") if suffix_match else ""
        if app_name:
            title = f"{app_name} - {suffix}" if suffix else app_name
        else:
            # No site name: the tab shows just the page name.
            title = suffix or bare_title
        return f"<title>{html.escape(title)}</title>\n{extra}"

    content, count = _TITLE_RE.subn(_rewrite, content, count=1)
    if count == 0:
        # No <title> to anchor to; fall back to the top of <head>.
        content = content.replace(
            "<head>", f"<head>\n<title>{html.escape(bare_title)}</title>\n{extra}", 1
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
    """(bytes, mtime) for a /static/... path confined under STATIC_DIR, or None.

    The path is taken from page markup, which includes operator-set values such
    as logo_url. It is resolved and confined here so a crafted "../" traversal
    (e.g. "/static/../../../dev/zero?v=1") cannot point the hasher at a file
    outside the static tree or at an endless device (L14). Only regular files
    inside STATIC_DIR are read."""
    rel = static_path[len("/static/"):]
    static_root = os.path.realpath(STATIC_DIR)
    fs_path = os.path.realpath(os.path.join(static_root, rel))
    if fs_path != static_root and not fs_path.startswith(static_root + os.sep):
        return None
    try:
        if not os.path.isfile(fs_path):
            return None
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

# The login card's site name. The page has no shell to fill, so this one
# element is rewritten in place: served with the operator's name, or hidden
# when there is none, so no script has to swap the static default after the
# first paint may already have shown it.
_LOGIN_NAME_RE = re.compile(r'(<h1 id="loginAppName" class=")([^"]*)(">)[^<]*(</h1>)')


def _fill_login_name(out: str, branding: dict) -> str:
    site_name = _site_name(branding)

    def _sub(m):
        classes = [c for c in m.group(2).split() if c != "hidden"]
        if not site_name:
            classes.append("hidden")
        return f"{m.group(1)}{' '.join(classes)}{m.group(3)}{html.escape(site_name)}{m.group(4)}"

    return _LOGIN_NAME_RE.sub(_sub, out, count=1)


def render_html(page_html: str, *, name: str, branding: dict, user: Optional[dict],
                version: str, base_url: str, path: str, flags: dict) -> str:
    """Pure: turn a static page into the document this user should receive."""
    out = _inject_head(page_html, branding, user, version, name, base_url, path)

    if SIDEBAR_MARKER in out or HEADER_MARKER in out:
        values = shell_values(branding, user, version, name)
        out = out.replace(SIDEBAR_MARKER, fill(_partial("shell-sidebar.html"), values), 1)
        header = fill(_partial("shell-header.html"), values)
        if flags.get("page_off"):
            header += PAGE_OFF_BANNER
        out = out.replace(HEADER_MARKER, header, 1)

    if name == "login":
        out = _fill_login_name(out, branding)

    attrs = f' data-page="{html.escape(name, quote=True)}"'
    if user and user.get("is_admin"):
        attrs += " data-admin"
    if name == "index":
        off = [sid for sid, on in (branding.get("home_sections") or {}).items() if on is False]
        if off:
            attrs += f' data-home-hide="{html.escape(" ".join(off), quote=True)}"'
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


def render_page(name: str, request: Optional[Request], user: Optional[dict],
                gate: Optional[str] = None, pick: Optional[Callable[[dict], str]] = None):
    """Read app/static/<name>.html, render it for this user, and return it, or 404.

    gate: the nav page id this route belongs to. When the operator switched it
    off, members are sent home (302) and admins get the page with a banner.
    pick: chooses the file from the branding payload (used by /requests, which
    shows the Seerr embed when that is the chosen source)."""
    branding, flags = load_context(user is not None)
    if gate and page_is_off(gate, branding):
        if not (user and user.get("is_admin") == "true"):
            return RedirectResponse(url="/", status_code=302)
        flags = dict(flags, page_off=True)
    if pick is not None:
        name = pick(branding)

    filepath = os.path.join(STATIC_DIR, name + ".html")
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            page_html = f.read()
    except FileNotFoundError:
        return JSONResponse(
            status_code=404,
            content={"detail": f"{name} page not found. Static files missing."},
        )

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
        # Encoded here, inside the guard: HTMLResponse would otherwise raise
        # outside it on a lone surrogate in some setting and 500 the page.
        try:
            body = out.encode("utf-8")
        except UnicodeEncodeError:
            # Keep the rendered shell; the unencodable character becomes "?".
            # Log the page, never the offending value.
            logger.warning("Page %s contained characters that can't be encoded; replaced them", name)
            body = out.encode("utf-8", "replace")
    except Exception:  # pragma: no cover - a rendering bug must never take a page down
        logger.warning("Page rendering failed for %s; serving the raw file", name, exc_info=True)
        body = page_html.encode("utf-8", "replace")
    return HTMLResponse(content=body)
