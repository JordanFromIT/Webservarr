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
from app.home_event_log import PINNED_EMPTY as EVENT_PINNED_EMPTY, render_pinned
from app.settings_registry import (
    COLOR_KEYS, FROST_STRENGTHS, GAUGE_IDS, PAGE_ADDRESSES, PAGE_DEFAULTS, SIDEBAR_PAGE_IDS, normalize_page_order, safe_color,
    safe_font,
)
from app.settings_registry import REGISTRY as _REGISTRY
from app.utils import identity_email, identity_key, safe_http_url, same_origin_path

logger = logging.getLogger(__name__)

# Where the static files live inside the container. Module-level so tests can
# point it at a temporary directory.
STATIC_DIR = "/app/app/static"

# ---------------------------------------------------------------------------
# Navigation registry
# ---------------------------------------------------------------------------
#
# The one list of destinations. Routes are fixed (page addresses are not
# configurable) and, like the labels, sublabels and icons shipped as
# defaults, come from app/settings_registry.py; the operator's overrides,
# switches and order come from the branding payload (Settings) and are
# applied in visible_nav_items().

_NAV_HREF = PAGE_ADDRESSES
_NAV_EXTRA = {
    # The pending-requests count rides on the one Requests item.
    "requests": {"badge": "requestsBadge"},
    # Books only exists while there is something to read or hear: Kavita, or
    # the Plex audiobook library (features.books_configured).
    "library": {"feature": "books_configured"},
    "settings": {"admin_only": True},
}
NAV_ITEMS = [
    dict({"id": pid, "href": _NAV_HREF[pid], "label": PAGE_DEFAULTS[pid][0],
          "sublabel": PAGE_DEFAULTS[pid][1], "icon": PAGE_DEFAULTS[pid][2]}, **_NAV_EXTRA.get(pid, {}))
    for pid in SIDEBAR_PAGE_IDS
]

# Which nav item a page highlights. The news archive and the status feed are
# part of Home; the Seerr embed is what Requests shows when its source is
# "seerr_embed".
PAGE_NAV = {
    "index": "home",
    "news": "home",
    "status": "home",
    "requests": "requests",
    "requests-embed": "requests",
    "issues": "issues",
    "calendar": "calendar",
    "tickets": "tickets",
    "books": "library",
    "book": "library",
    "books-person": "library",
    "books-series": "library",
    "books-stats": "library",
    "wiki": "wiki",
    "settings": "settings",
}

# ---------------------------------------------------------------------------
# Theme: colours, font
# ---------------------------------------------------------------------------

DEFAULT_FONT = _REGISTRY["theme.font"].default

# The registry's colour defaults, which safe_color falls back to;
# app/static/css/theme.css repeats them as :root defaults (a test keeps the two equal).
_DEFAULT_COLORS = {key: _REGISTRY["theme.color_" + key].default for key in COLOR_KEYS}
# (css variable suffix, branding colour key): --color-media-tv from media_tv.
_COLOR_VARS = [(key.replace("_", "-"), key) for key in COLOR_KEYS]


def _rgb(hex_value: str) -> str:
    """'#125793' -> '18 87 147' (the triplet form Tailwind's alpha syntax needs)."""
    h = hex_value.lstrip("#")
    return f"{int(h[0:2], 16)} {int(h[2:4], 16)} {int(h[4:6], 16)}"


# One rule with the branding payload (app/settings_registry.safe_font /
# safe_color): the payload is already safe, and this keeps the page's own
# #ws-theme and #ws-font safe for any branding dict it is handed.
_safe_font = safe_font


def _safe_url(value) -> str:
    """Only http(s) or a same-origin absolute path may reach an attribute."""
    v = (value or "").strip()
    if v.lower().startswith(("https://", "http://")):  # schemes are case-insensitive
        return safe_http_url(v)
    return same_origin_path(v)


def theme_style(branding: dict) -> str:
    """Inline :root variables so the first paint is already in the operator's colours."""
    return '<style id="ws-theme">' + theme_css(branding) + "</style>"


def theme_css(branding: dict) -> str:
    """The rule #ws-theme holds (theme_style). Also sent by GET
    /api/admin/settings/shell, which Settings writes into #ws-theme after a save."""
    colors = branding.get("colors") or {}
    decls = []
    for var, key in _COLOR_VARS:
        hexv = safe_color("theme.color_" + key, colors.get(key))
        decls.append(f"--color-{var}:{_rgb(hexv)}")
        decls.append(f"--hex-{var}:{hexv}")
    # Home's gauge rings: the accent, or with colourful gauges on their own
    # colours. Decided here, so the first paint is already right.
    colourful = branding.get("gauges_colourful") is True
    for g in GAUGE_IDS:
        decls.append(f"--ws-gauge-{g}:var(--color-{'gauge-' + g if colourful else 'accent'})")
    decls.append(f'--font-display:"{_safe_font(branding.get("font"))}",sans-serif')
    # Every frosted surface's blur (theme.css .ws-frost and the sign-in card),
    # and the rest of the frost's strengths, as the numbers theme.css's one
    # recipe multiplies by (Frosted surfaces): the first paint is already right.
    decls.append(f"--ws-frost-blur:blur({frost_blur(branding)}px)")
    for key in FROST_STRENGTHS:
        decls.append(f"{FROST_VARS[key]}:{frost_value(branding, key) / 100:g}")
    return ":root{" + ";".join(decls) + "}"


# Each strength's custom property: a number theme.css multiplies by. Tint,
# sheen and grain are opacities (25 hundredths is .25); highlight, depth and
# saturation scale the slab's own values (100 percent is 1).
FROST_VARS = {
    "frost_tint": "--ws-frost-tint-a",
    "frost_highlight": "--ws-frost-hl",
    "frost_sheen": "--ws-frost-sheen",
    "frost_grain": "--ws-frost-grain",
    "frost_depth": "--ws-frost-depth",
    "frost_saturation": "--ws-frost-sat",
}


def frost_value(branding: dict, key: str) -> int:
    """A frost setting from the payload (frost_blur, frost_tint, ...): its
    whole number inside the registry's bounds, else the registry default."""
    d = _REGISTRY["theme." + key]
    v = branding.get(key)
    if isinstance(v, bool) or not isinstance(v, int):
        return int(d.default)
    return max(d.min, min(d.max, v))


def frost_blur(branding: dict) -> int:
    """The frosted surfaces' blur in px (default 15, the glass slab)."""
    return frost_value(branding, "frost_blur")


def custom_css_style(branding: dict) -> str:
    """The operator's custom CSS as a <style>, or "" when there is none.

    Written as the last thing in <head> (see _inject_head), after app.css,
    theme.css and the page's own styles, so an ordinary rule wins at equal
    specificity. A <style> is raw text that ends only at "</style" (any
    case), so every "</" is written "<\\/": to CSS the same two characters
    (a backslash before "/" just means "/"), and it can't end the element.
    A bare "<" is left alone: media and container range queries need it.
    The #ws-data copy is escaped for JSON, as before."""
    css = branding.get("custom_css")
    if not isinstance(css, str) or not css.strip():
        return ""
    return '<style id="webservarr-custom-css">' + css.replace("</", "<\\/") + "</style>"


def font_links(branding: dict) -> str:
    """
    The display font, loaded statically with preconnects (no runtime injection).

    display=optional, not swap: each page is a new document, and with swap its
    first frame paints in the fallback font whenever the (cached) font file
    hasn't been read back yet, then re-lays out every line in the real one -
    titles rewrap, tabs change width, buttons hop. optional gives the font a
    short wait, which a cached file always makes, and otherwise keeps the
    fallback for that page instead of swapping. A first-ever visit may show
    the fallback once; every page after that has the font from its first frame.
    """
    href = font_href(branding)
    return (
        '<link rel="preconnect" href="https://fonts.googleapis.com">'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
        f'<link id="ws-font" rel="stylesheet" href="{html.escape(href, quote=True)}">'
    )


ICON_FONT = "/static/fonts/material-symbols-outlined.woff2"


def icon_font_head() -> str:
    """
    The icon font: a trimmed, self-hosted Material Symbols Outlined
    (scripts/build_icon_font.py), about 33 KB.

    Not preloaded: measured on a throttled phone (1.6 Mbps, 150 ms), a
    preload made it share the first second with the stylesheets and moved
    the LCP (text) about 300 ms later on Home and 150 ms on /login, for icons
    that arrive about half a second sooner. Fetched once the page lays out
    an icon, it is still in well before the old 1.1 MB font was.

    Its address carries the file's content stamp, written here because the
    ?v= rewrite never reaches a url() inside CSS, so it is cached for a year
    and a new build is fetched at once. The class rules are Google's own for
    this family, and come before app.css as Google's stylesheet did, so a
    utility on an icon (font-bold on the logo stand-in) still wins.
    font-display: block, as before: a ligature painted in a fallback font is
    a word, not an icon.
    """
    href = html.escape(f"{ICON_FONT}?v={asset_stamp(ICON_FONT)}", quote=True)
    return (
        "<style>"
        "@font-face{font-family:'Material Symbols Outlined';font-style:normal;font-weight:400 700;"
        f"font-display:block;src:url({href}) format('woff2')}}"
        ".material-symbols-outlined{font-family:'Material Symbols Outlined';font-weight:normal;"
        "font-style:normal;font-size:24px;line-height:1;letter-spacing:normal;text-transform:none;"
        "display:inline-block;white-space:nowrap;word-wrap:normal;direction:ltr;"
        "-webkit-font-feature-settings:'liga';-webkit-font-smoothing:antialiased}"
        "</style>"
    )


def font_href(branding: dict) -> str:
    """The display font's stylesheet address (#ws-font; font_links)."""
    family = _safe_font(branding.get("font"))
    return (
        "https://fonts.googleapis.com/css2?family="
        + urllib.parse.quote_plus(family)
        + ":wght@300;400;500;600;700&display=optional"
    )


# ---------------------------------------------------------------------------
# The home-screen app: manifest, icons, browser colour
# ---------------------------------------------------------------------------
#
# Every page (and /login) links /manifest.webmanifest, an apple-touch-icon and
# a theme-color, so a phone can add the site to its home screen and open it
# full-screen. All of it follows the branding: the site name, the background
# colour and the operator's "Home-screen icon" (branding.app_icon_url), whose
# default is the bundled pair below. Design:
# docs/superpowers/specs/2026-10-04-mobile-nav-and-home-screen-design.md, Part 2.

APP_ICON_192 = "/static/webservarr-app-192.png"
APP_ICON_512 = "/static/webservarr-app-512.png"
# The bundled icon keeps its artwork inside the centre 80% circle, so it is
# also safe for launchers that crop icons to their own shape (maskable).
_BUNDLED_ICONS = (
    {"src": APP_ICON_192, "sizes": "192x192", "type": "image/png", "purpose": "any"},
    {"src": APP_ICON_512, "sizes": "512x512", "type": "image/png", "purpose": "any"},
    {"src": APP_ICON_512, "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
)
_ICON_TYPES = {".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
# Browsers want a square icon of at least this size before they offer to install.
_MIN_ICON_PX = 144
# Copy that stands in for the site's name when the operator left it empty.
NO_NAME = "this site"


def _custom_app_icon(branding: dict) -> str:
    """The operator's own home-screen icon, or "" for the bundled pair."""
    v = _safe_url(branding.get("app_icon_url"))
    return "" if v == APP_ICON_512 else v


def touch_icon(branding: dict) -> str:
    """The apple-touch-icon (and Home's "Add to home screen" picture)."""
    return _custom_app_icon(branding) or APP_ICON_192


def theme_color(branding: dict) -> str:
    """The browser's colour around the page: the theme's background, so the
    status bar and the installed app's title bar match the top bar."""
    return safe_color("theme.color_background", (branding.get("colors") or {}).get("background"))


def _png_size(static_path: str):
    """(width, height) of a PNG under /static/, or None."""
    got = _read_static_bytes(static_path)
    if not got:
        return None
    data = got[0]
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def app_icons(branding: dict) -> list:
    """The manifest's icons. A file on this site declares its real size (a
    browser ignores an icon whose size is wrong) and falls back to the bundled
    pair when it is not a square PNG a browser would accept; a web address
    can't be measured here, so it declares the size the setting asks for."""
    bundled = [dict(i) for i in _BUNDLED_ICONS]
    src = _custom_app_icon(branding)
    if not src:
        return bundled
    path = urllib.parse.urlsplit(src).path if src.startswith("/") else ""
    if path.startswith("/static/"):
        size = _png_size(path)
        if not size or size[0] != size[1] or size[0] < _MIN_ICON_PX:
            return bundled
        return [{"src": src, "sizes": f"{size[0]}x{size[1]}", "type": "image/png", "purpose": "any"}]
    icon = {"src": src, "sizes": "512x512", "purpose": "any"}
    kind = _ICON_TYPES.get(os.path.splitext(urllib.parse.urlsplit(src).path)[1].lower())
    if kind:
        icon["type"] = kind
    return [icon]


def web_manifest(branding: dict) -> dict:
    """GET /manifest.webmanifest. An installed app always has a name: the
    site's, else its tagline, else the shipped one."""
    tagline = (branding.get("tagline") or "").strip()
    name = _site_name(branding) or tagline or _REGISTRY["branding.app_name"].default
    colour = theme_color(branding)
    manifest = {
        "id": "/",
        "name": name,
        "short_name": name,
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": colour,
        "theme_color": colour,
        "icons": app_icons(branding),
    }
    if tagline:
        manifest["description"] = tagline
    return manifest


def app_head_links(branding: dict) -> str:
    return (
        '<link rel="manifest" href="/manifest.webmanifest">'
        f'<link rel="apple-touch-icon" href="{html.escape(touch_icon(branding), quote=True)}">'
        f'<meta name="theme-color" content="{theme_color(branding)}">'
    )


# ---------------------------------------------------------------------------
# Data block and user
# ---------------------------------------------------------------------------

def data_block(branding: dict, user: Optional[dict], version: str, name: str,
               setup: Optional[dict] = None) -> str:
    """
    The payload the client reads at parse time.

    It is data, not code: a JSON script type never executes, so CSP does not
    apply. Every '<' is emitted as \\u003c so no value can close the element.

    setup: which connections are set up (settings_setup), on the Settings
    page only.
    """
    payload = {"branding": branding, "user": user, "version": version, "page": name}
    if setup is not None:
        payload["setup"] = setup
    text = json.dumps(payload, separators=(",", ":")).replace("<", "\\u003c")
    return f'<script id="ws-data" type="application/json">{text}</script>'


def public_user(session: Optional[dict]) -> Optional[dict]:
    """The same shape /auth/check-session returns, from the Redis session dict.

    has_email says whether the account can receive notifications and push
    (see utils.identity_email); the address itself never goes into the page.
    identity_key is an opaque key for the account identity that owns this
    user's rows (utils.identity_key over tickets.account_identity; "" when
    there is none). The audiobook player keys its local copy of the
    listener's place by it, so a shared browser never resumes one person at
    another's place. The identity itself (a Plex account id) never goes into
    the page.
    """
    if not session:
        return None
    from app.routers.tickets import account_identity
    return {
        "username": session.get("username", ""),
        "display_name": session.get("display_name", ""),
        "is_admin": session.get("is_admin", "false") == "true",
        "avatar_url": _safe_url(session.get("avatar_url", "")),
        "auth_method": session.get("auth_method", ""),
        "has_email": bool(identity_email(session.get("email"))),
        "identity_key": identity_key(account_identity(session)),
    }


# ---------------------------------------------------------------------------
# Navigation rendering
# ---------------------------------------------------------------------------
#
# Class lists are literal strings here on purpose: this file is in the Tailwind
# content globs (tailwind.config.js), so every class below is compiled.

_LINK_ACTIVE = (
    '<a class="relative flex items-center gap-3 px-4 py-2.5 rounded-lg bg-primary text-bright '
    'font-bold transition-all shadow-baltic-blue/20" href="{href}" aria-current="page">'
    '<span class="ws-nav-icon material-symbols-outlined fill-1 shrink-0" aria-hidden="true">{icon}</span>{label}{badge}</a>'
)
_LINK = (
    '<a class="relative flex items-center gap-3 px-4 py-2.5 rounded-lg hover:bg-frosted-blue/5 text-frosted-blue '
    'transition-all group" href="{href}">'
    '<span class="ws-nav-icon material-symbols-outlined text-steel-blue group-hover:text-frosted-blue transition-colors shrink-0" aria-hidden="true">{icon}</span>'
    '{label}{badge}</a>'
)
# A sublabel stacks under the label instead of sitting beside it, so the nav
# keeps one scannable column of names with the clarification as secondary
# text. On the active pill it is the pill's own Bright text at 80%, which
# still clears 4.5:1 on Primary (opacity-70 did not).
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


# ---------------------------------------------------------------------------
# Phone navigation (below lg): the tab bar, the More sheet, the top bar
# ---------------------------------------------------------------------------
#
# The first TAB_COUNT pages the user can see, in the operator's order, are
# tabs (five, plus More, fit a 320px screen: theme.css .ws-tabbar-list); the
# last tab is always More, which holds the rest of the pages and
# then "Add to home screen", the welcome tour and Sign out (the partial).
# More stays even when every page fits as a tab, since sign-out lives there.
# Design: docs/superpowers/specs/2026-10-04-mobile-nav-and-home-screen-design.md.
# The active tab is marked by aria-current, which theme.css draws (a filled
# icon on a primary pill, a bolder label), so it never rests on colour alone.

TAB_COUNT = 5

_TAB = (
    '<li><a class="ws-navtab" href="{href}"{current}>'
    '<span class="ws-navtab-icon"><span class="material-symbols-outlined" aria-hidden="true">{icon}</span>{badge}</span>'
    '<span class="ws-navtab-label">{label}</span></a></li>'
)
_TAB_BADGE = '<span data-badge="{bid}" class="ws-navtab-badge hidden"></span>'
# aria-current="true" (not "page"): More is the current tab while the page is
# one of its rows; the row itself carries aria-current="page".
_MORE_TAB = (
    '<li><button type="button" id="wsMoreBtn" class="ws-navtab" aria-haspopup="dialog" aria-expanded="false" '
    'aria-controls="wsMoreSheet"{current}>'
    '<span class="ws-navtab-icon"><span class="material-symbols-outlined" aria-hidden="true">more_horiz</span></span>'
    '<span class="ws-navtab-label">More</span></button></li>'
)
_ROW = (
    '<li><a class="ws-sheet-row" href="{href}"{current}>'
    '<span class="material-symbols-outlined ws-sheet-row-icon" aria-hidden="true">{icon}</span>'
    '<span class="ws-sheet-row-text"><span class="ws-sheet-row-line"><span class="ws-sheet-row-label">{label}</span>'
    '{flag}</span>{sub}</span>{badge}</a></li>'
)
_ROW_SUB = '<span class="ws-sheet-row-sub">{sub}</span>'
_ROW_BADGE = '<span data-badge="{bid}" class="ws-sheet-badge hidden"></span>'


def phone_nav_items(branding: dict, is_admin: bool) -> tuple:
    """(tabs, more): the pages this user sees, split where the tab bar ends."""
    items = visible_nav_items(branding, is_admin)
    return items[:TAB_COUNT], items[TAB_COUNT:]


def render_tabs(tabs: list, more: list, active_id: Optional[str]) -> str:
    parts = []
    for it in tabs:
        badge = _TAB_BADGE.format(bid=html.escape(it["badge"], quote=True)) if it.get("badge") else ""
        parts.append(_TAB.format(
            href=html.escape(it["href"], quote=True),
            current=' aria-current="page"' if it["id"] == active_id else "",
            icon=html.escape(it["icon"]),
            badge=badge,
            label=html.escape(it["label"]),
        ))
    in_more = any(it["id"] == active_id for it in more)
    parts.append(_MORE_TAB.format(current=' aria-current="true"' if in_more else ""))
    return "\n".join(parts)


def render_more_links(more: list, active_id: Optional[str]) -> str:
    parts = []
    for it in more:
        sub = it.get("sublabel") or ""
        parts.append(_ROW.format(
            href=html.escape(it["href"], quote=True),
            current=' aria-current="page"' if it["id"] == active_id else "",
            icon=html.escape(it["icon"]),
            label=html.escape(it["label"]),
            flag=_NEW_FLAG if it["new"] else "",
            sub=_ROW_SUB.format(sub=html.escape(sub)) if sub else "",
            badge=_ROW_BADGE.format(bid=html.escape(it["badge"], quote=True)) if it.get("badge") else "",
        ))
    return "\n".join(parts)


def bar_title(branding: dict, active_id: Optional[str], static_title: str = "") -> str:
    """The phone top bar's words: the label of the nav item the page belongs
    to (the operator's, so it matches the tab), else the page's own title."""
    if active_id:
        return (branding.get("sidebar_labels") or {}).get(active_id) or PAGE_DEFAULTS[active_id][0]
    m = _TITLE_SUFFIX_RE.match(static_title or "")
    return m.group("suffix") if m else ""


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
                subcls="text-bright/80" if active else "text-steel-blue",
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
# The Books pages' book pop-up (partials/book-dialog.html): one copy, written
# wherever a page carries the marker (books, books-person, books-series).
BOOK_DIALOG_MARKER = "<!-- ws:book-dialog -->"
# The event log (partials/shell-event-log.html) goes where a page carries
# this marker: the top of its content, on every shell page but the reader.
# flags["feed_off"] renders it hidden; flags["event_pinned"] ({"items",
# "now_ms"}) writes the pinned rows into the empty list,
# home_event_log.PINNED_EMPTY (event_log_html).
EVENT_LOG_MARKER = "<!-- ws:event-log -->"
EVENT_LOG_OPEN = '<section id="wsEventLog"'
# Home's news cards: flags["home_news"] replaces the skeleton between these
# with the real cards (app/home_news.py) and marks the section arrived.
HOME_NEWS_OPEN = "<!-- ws:home-news -->"
HOME_NEWS_CLOSE = "<!-- /ws:home-news -->"
HOME_NEWS_SECTION = '<section data-arrive="news" class="lg:order-3"'
HOME_NEWS_VIEW_ALL = 'id="newsViewAll" class="invisible '


def _partial(filename: str) -> str:
    path = os.path.join(STATIC_DIR, "partials", filename)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _partial_body(filename: str) -> str:
    """A partial without the comment that opens it (its documentation), for
    one that is written into the page more than once or on every page."""
    text = _partial(filename).lstrip()
    if text.startswith("<!--"):
        text = text[text.index("-->") + 3:]
    return text.strip()


_SLOT_RE = re.compile(r"\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}")


def fill(template: str, values: dict) -> str:
    """Tiny substitution: {{key}} is HTML-escaped, {{{key}}} is inserted raw
    (only for HTML this module rendered itself). Unknown keys become empty.
    One pass: what a slot inserts is never read for slots itself, so an
    operator's text that happens to contain "{{user_name}}" stays text."""
    def slot(m):
        if m.group(1) is not None:
            return str(values.get(m.group(1), ""))
        return html.escape(str(values.get(m.group(2), "")), quote=True)
    return _SLOT_RE.sub(slot, template)


def _site_name(branding: dict) -> str:
    """The operator's site name, trimmed. It may be "": an empty name is a
    deliberate choice (Settings > General) and the logo then stands alone.
    Only a payload with no name at all falls back to the shipped default."""
    value = branding.get("app_name")
    if value is None:
        value = _REGISTRY["branding.app_name"].default
    return str(value).strip()


def shell_values(branding: dict, user: Optional[dict], version: str, name: str, static_title: str = "") -> dict:
    is_admin = bool(user and user.get("is_admin"))
    icons = branding.get("icons") or {}
    site_name = _site_name(branding)
    active = PAGE_NAV.get(name)
    tabs, more = phone_nav_items(branding, is_admin)

    logo = _safe_url(branding.get("logo_url"))
    logo_icon = html.escape(icons.get("sidebar_logo") or _REGISTRY["icon.sidebar_logo"].default)
    # branding.show_name off: the logo stands alone and carries the name. It
    # takes the room the name and its gap took, and more of the block's own
    # padding, so it is larger while the nav below starts where it always does.
    named = branding.get("show_name") is not False
    logo_alt = "Logo" if named else html.escape(site_name or "Logo", quote=True)
    if logo:
        # A fixed box: an unsized image would push the whole nav down the
        # moment it arrived on a cold load (the one layout shift the shell had).
        # Named: 96px tall over the name. Alone: the sidebar's width less 12px
        # a side (the block's 24px padding, less 12) and 144px tall, 8px of it
        # taken from the padding above and below, so the block stays 176px
        # tall, as it is named (96 + 12 + the name's line, near enough). A wide
        # logo fills the width; a tall one stops at 144px (object-contain).
        box = "w-full h-24 mb-3" if named else "-mx-3 -my-2 w-[calc(100%+1.5rem)] max-w-none h-36"
        logo_html = (
            f'<img src="{html.escape(logo, quote=True)}" alt="{logo_alt}" '
            f'class="{box} rounded-lg object-contain">'
        )
    elif named:
        logo_html = (
            '<div class="size-14 bg-primary rounded-lg flex items-center justify-center '
            'shadow-lg shadow-baltic-blue/20 mb-3">'
            f'<span class="material-symbols-outlined text-bright font-bold text-3xl" aria-hidden="true">{logo_icon}</span>'
            '</div>'
        )
    else:
        logo_html = (
            f'<div role="img" aria-label="{logo_alt}" class="size-20 bg-primary rounded-lg flex items-center '
            'justify-center shadow-lg shadow-baltic-blue/20">'
            f'<span class="material-symbols-outlined text-bright font-bold text-hero" aria-hidden="true">{logo_icon}</span>'
            '</div>'
        )

    avatar = (user or {}).get("avatar_url") or ""
    avatar_style = ""
    if avatar:
        # Unquoted url(): percent-encoding removes every character that could
        # end the token (quotes, parens, whitespace, backslash), and the value
        # is then attribute-escaped by fill(). Scheme checked by public_user().
        css_url = urllib.parse.quote(avatar, safe="/:?&=%.-_~+@#,;")
        avatar_style = f"background-image:url({css_url});background-size:cover;background-position:center"

    brand = {
        # May be empty (Settings > General), or switched off there
        # (branding.show_name): the sidebar then shows the logo alone.
        "app_name": site_name if named else "",
        "app_name_cls": "" if site_name and named else "hidden",
        "logo_html": logo_html,
    }
    return {
        **brand,
        # The logo and name as the sidebar shows them; also sent by GET
        # /api/admin/settings/shell (shell_fragment).
        "brand_html": fill(_partial("shell-brand.html"), brand).strip(),
        "nav_links": render_nav_links(branding, is_admin, active),
        # Phones: the tab bar, the More sheet's pages, the top bar's words.
        "tab_links": render_tabs(tabs, more, active),
        "more_links": render_more_links(more, active),
        "bar_title": bar_title(branding, active, static_title),
        # "Add to home screen": the site's name, or words that stand in for one.
        "install_name": site_name or NO_NAME,
        "version": ("v" + version) if version else "",
        "admin_block": "" if is_admin else "hidden",
        "user_name": (user or {}).get("display_name") or (user or {}).get("username") or "",
        "user_role": ("Admin" if is_admin else "User") if user else "",
        "avatar_style": avatar_style,
        # The server's gauges, the same markup in both headers. Always in the
        # shell: they show while html[data-netdata] says Netdata is set up
        # (theme.css), which a soft navigation keeps current.
        "gauges_html": _partial_body("shell-gauges.html"),
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


def safe_theme_branding(branding: dict) -> dict:
    """The branding payload with the shipped colours and font: Settings in
    safe colours (/settings?theme=safe), the way back from a theme that made
    it unreadable. The custom CSS stays in the payload (the Appearance
    skeleton reads it) but the page doesn't apply it (render_html). So does
    gauges_colourful, which the skeleton shows the gauge pickers by; the
    gauge colours it would pick are the shipped ones too."""
    return dict(branding, colors=dict(_DEFAULT_COLORS), font=DEFAULT_FONT)


def page_title(branding: dict, static_title: str) -> str:
    """The page's <title>: the static file's "WebServarr - Settings" with the
    brand half swapped for the operator's site name. No name: just the page
    name, or the tagline for a page without one."""
    app_name = _site_name(branding)
    suffix_match = _TITLE_SUFFIX_RE.match(static_title)
    suffix = suffix_match.group("suffix") if suffix_match else ""
    if app_name:
        return f"{app_name} - {suffix}" if suffix else app_name
    return suffix or (branding.get("tagline") or "").strip()


def shell_fragment(branding: dict, is_admin: bool, active_id: Optional[str], static_title: str) -> dict:
    """Everything a page already on screen shows from the branding and the
    router never swaps (only #wsPage, the title and <html> flags change on a
    soft navigation): the nav, the phone's tab bar, More pages and top-bar
    words, the logo and name, the <head> theme, font, custom CSS and browser
    colour, the favicon and home-screen icon, the page's title, whether the
    sidebar shows its icons (<html data-nav-icons-off>), and the payload itself.
    GET /api/admin/settings/shell sends it; Settings writes it in after a save.
    Rendered by the same code as every page, so it cannot drift."""
    values = shell_values(branding, {"is_admin": is_admin}, "", "")
    custom = branding.get("custom_css")
    tabs, more = phone_nav_items(branding, is_admin)
    return {
        "nav_html": render_nav_links(branding, is_admin, active_id),
        "brand_html": values["brand_html"],
        "tabs_html": render_tabs(tabs, more, active_id),
        "more_html": render_more_links(more, active_id),
        "bar_title": bar_title(branding, active_id, static_title),
        "theme_color": theme_color(branding),
        "touch_icon": touch_icon(branding),
        "theme_css": theme_css(branding),
        "font_href": font_href(branding),
        "custom_css": custom if isinstance(custom, str) and custom.strip() else "",
        "favicon": _safe_url(branding.get("logo_url")) or "/static/webservarr.svg",
        "title": page_title(branding, static_title),
        "nav_icons": branding.get("nav_icons") is not False,
        "branding": branding,
    }


def _inject_head(content: str, branding: dict, user: Optional[dict], version: str,
                 name: str, base_url: str, path: str, setup: Optional[dict] = None,
                 custom_css: bool = True) -> str:
    """Rewrite <title> and append, right after it: preview tags, theme, font, data.
    The custom CSS goes last in <head> instead, after every stylesheet."""
    app_name, tags = _preview_meta(branding, base_url, path)
    # A page with no descriptive title of its own, on a site with no name,
    # falls back to the tagline (or nothing) rather than a dangling " - ".
    bare_title = app_name or (branding.get("tagline") or "").strip()
    extra = "\n".join([tags, app_head_links(branding), theme_style(branding), font_links(branding),
                       icon_font_head(), data_block(branding, user, version, name, setup)])

    def _rewrite(match):
        inner = match.group(0)[len("<title>"):-len("</title>")]
        return f"<title>{html.escape(page_title(branding, inner))}</title>\n{extra}"

    content, count = _TITLE_RE.subn(_rewrite, content, count=1)
    if count == 0:
        # No <title> to anchor to; fall back to the top of <head>.
        content = content.replace(
            "<head>", f"<head>\n<title>{html.escape(bare_title)}</title>\n{extra}", 1
        )
    custom = custom_css_style(branding) if custom_css else ""
    if custom:
        if "</head>" in content:
            content = content.replace("</head>", custom + "\n</head>", 1)
        else:  # no </head> to anchor to: after the theme, which is at least early
            content = content.replace(extra, extra + "\n" + custom, 1)
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
# A converted page's #wsPage names its module in data-ws-module, which the
# router imports, so that URL is stamped the same way; data-ws-dep names a
# file that module loads (the Books pages' card helpers), stamped the same way,
# so a cached old file is never paired with a new module.

_ASSET_VERSION_RE = re.compile(r'(?P<attr>(?:src|href|data-ws-module|data-ws-dep)="(?P<path>/static/[^"?]+)\?v=)[^"]*"')
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
# The card's logo (login.js sets its src from the branding before the first
# paint). With the name switched off (branding.show_name) it takes a taller box
# from sm up and the heading stays for screen readers only, so the page keeps
# its one h1. That heading already says the name, so the logo is then
# decorative (alt="") rather than a second reading of it.
_LOGIN_LOGO_RE = re.compile(r'(<img id="loginLogo" alt=")[^"]*(" class=")([^"]*)(")')
LOGIN_LOGO_ALONE_CLS = "sm:h-56"
# The sign-in card's places other than the default (the registry's choices
# after the first), each a data-login-card value login.html styles.
LOGIN_CARD_MOVED = _REGISTRY["login.card_position"].choices[1:]


def _fill_login_name(out: str, branding: dict) -> str:
    site_name = _site_name(branding)
    named = branding.get("show_name") is not False

    def _sub(m):
        classes = [c for c in m.group(2).split() if c not in ("hidden", "sr-only")]
        if not site_name:
            classes.append("hidden")
        elif not named:
            classes.append("sr-only")
        return f"{m.group(1)}{' '.join(classes)}{m.group(3)}{html.escape(site_name)}{m.group(4)}"

    def _logo(m):
        classes = [c for c in m.group(3).split() if c != LOGIN_LOGO_ALONE_CLS]
        alt = "Logo"
        if not named:
            classes.append(LOGIN_LOGO_ALONE_CLS)
            alt = "" if site_name else "Logo"
        return f"{m.group(1)}{html.escape(alt, quote=True)}{m.group(2)}{' '.join(classes)}{m.group(4)}"

    out = _LOGIN_NAME_RE.sub(_sub, out, count=1)
    return _LOGIN_LOGO_RE.sub(_logo, out, count=1)


# ---------------------------------------------------------------------------
# Soft navigation: page styles and the persistent slots
# ---------------------------------------------------------------------------
#
# A converted page wraps its content in #wsPage; the router swaps only that
# element, so the page's own <head> styles are tagged for it to swap too.
# Tagged before _inject_head runs, so the shared styles the server adds
# (#ws-theme, the operator's custom CSS) are never the page's to remove.

_WS_PAGE_MARK = 'id="wsPage"'
_HEAD_STYLE_RE = re.compile(r"<style\b", re.IGNORECASE)

# The one player, the one live region and the soft navigation's progress bar
# on every shell page, outside <main> so a page swap never touches them. The
# sidebar partial fills its marker before <main>, so they go in just before
# </body> instead. The bar is hidden at rest; router.js shows it while a
# navigation is still loading after a moment (theme.css #wsProgress).
SHELL_SLOTS = (
    '<div id="wsPlayer" hidden></div>\n'
    '<div id="wsLive" class="sr-only" aria-live="polite"></div>\n'
    '<div id="wsProgress" hidden aria-hidden="true"></div>\n'
)


def _tag_page_styles(content: str) -> str:
    if _WS_PAGE_MARK not in content:
        return content
    head_end = content.lower().find("</head>")
    if head_end == -1:
        return content
    head = _HEAD_STYLE_RE.sub("<style data-ws-page-style", content[:head_end])
    return head + content[head_end:]


# A shell page covers the whole screen (viewport-fit=cover), so the phone's
# tab bar can pad for the home indicator with env(safe-area-inset-bottom),
# which is 0 otherwise. Added here, once, rather than in every page file.
_VIEWPORT_RE = re.compile(r'(<meta\b[^>]*\bcontent=")([^"]*)("[^>]*\bname="viewport"[^>]*>)', re.IGNORECASE)


def _cover_viewport(content: str) -> str:
    def _sub(m):
        value = m.group(2)
        if "viewport-fit" not in value:
            value = value.rstrip(" ,") + ", viewport-fit=cover"
        return m.group(1) + value + m.group(3)
    return _VIEWPORT_RE.sub(_sub, content, count=1)


def event_log_html(flags: dict) -> str:
    """The event log as this page's first paint shows it: hidden when the
    feed is off and empty, else with the pinned rows already written, as the
    script (js/event-log.js) would write them, so it takes them over as they
    are and nothing under the section moves."""
    out = _partial_body("shell-event-log.html")
    if flags.get("feed_off"):
        return out.replace(EVENT_LOG_OPEN, EVENT_LOG_OPEN + " hidden", 1)
    pinned = flags.get("event_pinned")
    if pinned is not None and EVENT_PINNED_EMPTY in out:
        out = out.replace(EVENT_PINNED_EMPTY, render_pinned(pinned.get("items") or [], int(pinned["now_ms"])), 1)
    return out


def _add_shell_slots(content: str) -> str:
    at = content.lower().rfind("</body>")
    if at == -1:
        return content + SHELL_SLOTS
    return content[:at] + SHELL_SLOTS + content[at:]


def render_html(page_html: str, *, name: str, branding: dict, user: Optional[dict],
                version: str, base_url: str, path: str, flags: dict) -> str:
    """Pure: turn a static page into the document this user should receive.

    flags["safe_theme"]: Settings in safe colours; pass safe_theme_branding()
    as the branding. The page carries no custom CSS and is marked
    <html data-safe-theme>, which shows its notice and keeps colour previews
    in the preview cards."""
    safe = bool(flags.get("safe_theme"))
    title = _TITLE_RE.search(page_html)
    static_title = title.group(0)[len("<title>"):-len("</title>")] if title else ""
    out = _inject_head(_tag_page_styles(page_html), branding, user, version, name, base_url, path,
                       flags.get("setup"), custom_css=not safe)

    if SIDEBAR_MARKER in out or HEADER_MARKER in out:
        out = _cover_viewport(out)
        out = _add_shell_slots(out)
        values = shell_values(branding, user, version, name, static_title)
        out = out.replace(SIDEBAR_MARKER, fill(_partial("shell-sidebar.html"), values), 1)
        header = fill(_partial("shell-header.html"), values)
        if flags.get("page_off"):
            header += PAGE_OFF_BANNER
        out = out.replace(HEADER_MARKER, header, 1)

    if BOOK_DIALOG_MARKER in out:
        out = out.replace(BOOK_DIALOG_MARKER, _partial("book-dialog.html"), 1)

    if name == "login":
        out = _fill_login_name(out, branding)

    if EVENT_LOG_MARKER in out and name != "reader":
        # The event log at the top of the page's content (event_log_html).
        # The reader is full-screen and has no marker; it is skipped anyway.
        out = out.replace(EVENT_LOG_MARKER, event_log_html(flags), 1)

    news = flags.get("home_news") if name == "index" else None
    if news is not None and HOME_NEWS_OPEN in out and HOME_NEWS_CLOSE in out:
        # Home's news, written as the page script would write it, so the
        # section is its real height from the first paint (on a phone it sits
        # above Service Health). data-arrived tells WS.arrive it is in place:
        # the script's first write is not played as an arrival.
        from app.home_news import render_home_news
        start = out.index(HOME_NEWS_OPEN)
        end = out.index(HOME_NEWS_CLOSE, start) + len(HOME_NEWS_CLOSE)
        cards = render_home_news(news.get("posts") or [], int(news.get("count") or 3), int(news["now_ms"]))
        out = out[:start] + cards + out[end:]
        out = out.replace(HOME_NEWS_SECTION, HOME_NEWS_SECTION + " data-arrived", 1)
        out = out.replace(HOME_NEWS_VIEW_ALL, 'id="newsViewAll" class="', 1)

    attrs = f' data-page="{html.escape(name, quote=True)}"'
    if user and user.get("is_admin"):
        attrs += " data-admin"
    if name == "reader":
        # A full-screen view: the shell stays in the document (and #wsPlayer
        # on screen) but its sidebar, header and phone bar are hidden
        # (theme.css). The router brings the flag in step on every swap.
        attrs += ' data-shell="hidden"'
    if name == "login" and branding.get("login_card") in LOGIN_CARD_MOVED:
        # The sign-in card to one side on a wide screen (login.card_position),
        # placed by login.html's CSS from this mark, so it is there from the
        # first paint. Centre, the default, carries no mark.
        attrs += f' data-login-card="{branding["login_card"]}"'
    if name == "index":
        off =[sid for sid, on in (branding.get("home_sections") or {}).items() if on is False]
        if off:
            attrs += f' data-home-hide="{html.escape(" ".join(off), quote=True)}"'
    if branding.get("section_icons") is True:
        # Every page: without the mark theme.css hides .ws-section-icon from
        # the first paint, and the router copies it on each soft navigation.
        attrs += " data-section-icons"
    if branding.get("nav_icons") is False:
        # Every page: under the mark theme.css hides the sidebar's .ws-nav-icon
        # from the first paint, and the router copies it on each soft navigation.
        attrs += " data-nav-icons-off"
    if flags.get("netdata"):
        attrs += " data-netdata"
    if safe:
        attrs += " data-safe-theme"
    if flags.get("rs_empty"):
        # /requests: nothing waiting in Request Status, so the section is
        # collapsed from the first paint (requests.html).
        attrs += " data-rs-empty"
    if flags.get("book_open"):
        # /books/<id>: the Books page with the book's pop-up on screen from the
        # first paint (partials/book-dialog.html); pages/book.js takes it over.
        attrs += " data-book-open"
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


# The connections whose being set up changes the shape of a Settings tab: the
# Sign-in tab's Plex hint and Authentik fields, the Pages rows that say a page
# needs one. The Settings skeleton (settings.html) takes that shape before the
# first paint from these. Booleans only, and only on the admin-only Settings
# page: which services an install uses is not for every visitor.
_SETUP_KEYS = (
    "integration.plex.url", "integration.plex.token", "integration.seerr.url", "integration.chaptarr.url",
    "integration.sonarr.url", "integration.radarr.url", "integration.kavita.url",
    "integration.plex.audiobook_library",
    "integration.authentik.url", "integration.authentik.client_secret",
)


def settings_setup() -> dict:
    """{connection: set up?} for the Settings skeleton, plus push_reason: the
    line the Notifications tab's push status will show when push can't send
    (a fixed server message, the same rule as GET /api/admin/notifications/status),
    or None when it can. All False / None if the database is unavailable."""
    values = {}
    push_reason = None
    db = None
    try:
        from app.models import Setting
        from app.services import push

        db = SessionLocal()
        values = {r.key: r.value for r in db.query(Setting).filter(Setting.key.in_(_SETUP_KEYS)).all()}
        push_reason = push.status_reason(db)
    except Exception:  # pragma: no cover - defensive
        logger.warning("Could not read setup flags for the Settings page", exc_info=True)
    finally:
        if db is not None:
            db.close()

    def has(key: str) -> bool:   # truthy, as the tabs test api.saved(key)
        return bool(values.get(key))

    return {
        "plex": has("integration.plex.url") and has("integration.plex.token"),
        "seerr": has("integration.seerr.url"),
        "chaptarr": has("integration.chaptarr.url"),
        "sonarr": has("integration.sonarr.url"),
        "radarr": has("integration.radarr.url"),
        "kavita": has("integration.kavita.url"),
        "audiobooks": has("integration.plex.audiobook_library"),
        "authentik_url": has("integration.authentik.url"),
        "authentik_secret": has("integration.authentik.client_secret"),
        "push_reason": push_reason,
    }


def render_page(name: str, request: Optional[Request], user: Optional[dict],
                gate: Optional[str] = None, pick: Optional[Callable[[dict], str]] = None,
                extra_flags: Optional[dict] = None):
    """Read app/static/<name>.html, render it for this user, and return it, or 404.

    gate: the nav page id this route belongs to. When the operator switched it
    off, members are sent home (302) and admins get the page with a banner.
    pick: chooses the file from the branding payload (used by /requests, which
    shows the Seerr embed when that is the chosen source).
    extra_flags: route-specific render flags (render_html), e.g. rs_empty."""
    branding, flags = load_context(user is not None)
    if extra_flags:
        # A route's flag may depend on the branding (Home's news reads the
        # homepage count and whether the section is on): pass a function of it.
        flags = dict(flags, **{k: (v(branding) if callable(v) else v) for k, v in extra_flags.items()})
    if gate and page_is_off(gate, branding):
        if not (user and user.get("is_admin") == "true"):
            return RedirectResponse(url="/", status_code=302)
        flags = dict(flags, page_off=True)
    if pick is not None:
        name = pick(branding)
    if name == "settings" and user and user.get("is_admin") == "true":
        flags = dict(flags, setup=settings_setup())
        # The way back from an unreadable theme: Settings in the shipped
        # colours and font, without the custom CSS, on this one request.
        # Nothing is saved; the rest of the site keeps the operator's theme.
        if request is not None and request.query_params.get("theme") == "safe":
            branding = safe_theme_branding(branding)
            flags = dict(flags, safe_theme=True)

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
