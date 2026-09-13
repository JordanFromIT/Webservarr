# Navigation & Load Feel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every sidebar click feel instant and stationary: the shell paints complete on first byte, only content changes, one loading language, zero post-load layout shift, instant revisits.

**Architecture:** The server (`app/pages.py`) renders the sidebar/header/mobile bar into each page with the operator's branding and the signed-in user, inlines theme variables + a JSON data block, and serves precompiled Tailwind CSS. A single client module (`shell.js`) decorates the static shell, caches the status pill, orchestrates section arrival, gates polling on prerender/visibility, and provides stale-while-revalidate page data. Cross-document view transitions + speculation rules make the frame persist and the next page pre-load.

**Tech Stack:** FastAPI (Python 3.11, stdlib only — no new Python deps), vanilla JS, Tailwind 3.4 CLI (Node dev dependency only; output committed), stdlib `unittest`.

**Spec:** `docs/superpowers/specs/2026-09-12-navigation-load-feel-design.md`

## Global Constraints

- Branch `dev` only. Never push `main`, never create a `v*` tag (tag push = production deploy).
- Commits authored as Jordan (`JordanFromIT`). No Claude/Anthropic co-author trailer.
- Do not touch `requirements.in` / `requirements.txt`. No new Python dependencies.
- Nothing committed may contain the operator's instance name, hostname or branding. Defaults stay `WebServarr`.
- The app cannot run on the laptop. Python tests run in the VPS dev container: `docker exec webservarr-dev python -m unittest discover -s /app/app/tests -t /app -v`. Only `app/` is bind-mounted, so tests live in `app/tests/`.
- Preserve: `#loginForm { visibility:hidden }` + `.auth-ready` reveal in `login.html`; `sw.js` untouched; notifications.js discovery contract (bells with `title="Notifications"`, a `<header>` whose class list has `lg:flex`); every element ID any page script references (`headerUsername`, `headerRole`, `headerAvatar`, `userMenuBtn`, `userMenuDropdown`, `mobileUsername`, `mobileRole`, `mobileTopBar`, `systemStatus`, `requestsBadge`, `desktopNav`, `drawerNav`, `scrollDownHint`).
- No fetch() endpoint/method/payload changes on the API.
- Sidebar layout stays (left sidebar + mobile drawer). Top-bar/bottom-tab layout is deferred.

**Deploy-to-dev loop after each push:**
```bash
git push origin dev
ssh webserver "cd ~/webservarr-dev && git pull --ff-only && docker restart webservarr-dev"
ssh -O forward -L 7980:127.0.0.1:7980 webserver   # once per session
# browse http://localhost:7980
```

---

## File map

| File | Responsibility |
|---|---|
| `package.json`, `tailwind.config.js`, `app/static/css/tailwind.src.css` | Tailwind build inputs (dev only) |
| `scripts/stamp-css.mjs` | Prepends `/* ws-css:<hash> */` to the built CSS |
| `app/static/css/app.css` | Built, minified, committed stylesheet |
| `app/static/css/theme.css` | Runtime CSS: theme vars, skeletons, view transitions, entrance, pill states, scroll hint |
| `app/pages.py` | Server page renderer: shell partials, inline theme/data, asset hashing, title/OG (moved from main.py) |
| `app/routers/branding.py` | `build_branding()` pure function + `load_branding()` shared by API and renderer |
| `app/static/partials/shell-sidebar.html`, `shell-header.html` | The shell markup (one source of truth) |
| `app/static/js/shell.js` | `window.WS`: shell wiring, status pill, arrive, poll, swr, setHTML, scroll hint |
| `app/static/js/theme-loader.js` | Reads `#ws-data`; fallback fetch |
| `app/static/js/auth.js` | `checkAuth()` resolves from `WS.user`; helpers kept; `loadSystemStatus`/`loadAppVersion` removed |
| `app/main.py`, `app/routers/setup.py` | Routes use `render_page`; CSP tightened |
| `app/tests/test_pages.py`, `test_css_build.py`, `test_shell_contract.py` | Regression guards |
| Every `app/static/*.html` | CDN → app.css; markers; init cleanup; skeletons; `WS.poll`/`WS.arrive`/`WS.swr` |

Deleted: `app/static/js/sidebar.js`, `app/static/js/header.js`.

---

### Task 1: Precompiled Tailwind stylesheet

**Files:**
- Create: `package.json`, `tailwind.config.js`, `app/static/css/tailwind.src.css`, `scripts/stamp-css.mjs`, `app/static/css/app.css` (built), `app/tests/__init__.py`, `app/tests/test_css_build.py`
- Modify: `.gitignore` (add `node_modules/`), `.dockerignore` (add `node_modules/`, `app/tests/`), `README.md:107` + new Development section, `app/main.py` CSP, all 13 `app/static/*.html` heads

**Interfaces:**
- Produces: `app/static/css/app.css` linked as `<link rel="stylesheet" href="/static/css/app.css?v=1">`; hash algorithm `css_content_hash(root) -> str` (16 hex) implemented identically in `scripts/stamp-css.mjs` and `app/tests/test_css_build.py`.

- [ ] **Step 1: Write the failing test**

`app/tests/__init__.py` empty. `app/tests/test_css_build.py`:

```python
"""The stylesheet is compiled at development time and committed. Tailwind only
emits classes it saw in the content files, so an HTML edit shipped without a
rebuild silently loses styling. The build stamps a hash of every content file
into the first line of app.css; this test recomputes it."""
import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # repo root, or /app in the container
STATIC = ROOT / "app" / "static"

CONTENT_GLOBS = [
    ("app/static", "*.html"),
    ("app/static/partials", "*.html"),
    ("app/static/js", "*.js"),
    ("app", "pages.py"),
    ("app/static/css", "tailwind.src.css"),
]


def content_files(root: Path):
    files = []
    for rel_dir, pattern in CONTENT_GLOBS:
        files.extend(p for p in (root / rel_dir).glob(pattern) if p.is_file())
    return sorted(set(files), key=lambda p: p.relative_to(root).as_posix())


def css_content_hash(root: Path) -> str:
    h = hashlib.sha256()
    for p in content_files(root):
        h.update((p.relative_to(root).as_posix() + "\n").encode())
        h.update(p.read_bytes())
        h.update(b"\n")
    return h.hexdigest()[:16]


class CssBuildTests(unittest.TestCase):
    def test_app_css_is_current(self):
        css = STATIC / "css" / "app.css"
        self.assertTrue(css.exists(), "app/static/css/app.css missing — run `npm run build:css`")
        first = css.read_text(encoding="utf-8").splitlines()[0]
        m = re.match(r"/\* ws-css:([0-9a-f]{16}) \*/", first)
        self.assertIsNotNone(m, "app.css has no ws-css stamp — run `npm run build:css`")
        self.assertEqual(m.group(1), css_content_hash(ROOT),
                         "app.css is stale — run `npm run build:css` and commit the result")

    def test_no_page_uses_the_play_cdn(self):
        for page in sorted(STATIC.glob("*.html")):
            html = page.read_text(encoding="utf-8")
            self.assertNotIn("cdn.tailwindcss.com", html, page.name)
            self.assertNotIn("tailwind.config", html, page.name)
            self.assertIn('href="/static/css/app.css?v=', html, page.name)
```

- [ ] **Step 2: Run it to verify it fails**

Locally: `python3 -m unittest app.tests.test_css_build -v` → FAIL (app.css missing; CDN present).

- [ ] **Step 3: Build inputs**

`package.json`:
```json
{
  "name": "webservarr-css",
  "private": true,
  "description": "Development-only toolchain: compiles app/static/css/app.css. The runtime has no Node.",
  "scripts": {
    "build:css": "tailwindcss -c tailwind.config.js -i app/static/css/tailwind.src.css -o app/static/css/app.css --minify && node scripts/stamp-css.mjs",
    "watch:css": "tailwindcss -c tailwind.config.js -i app/static/css/tailwind.src.css -o app/static/css/app.css --watch"
  },
  "devDependencies": {
    "@tailwindcss/container-queries": "^0.1.1",
    "@tailwindcss/forms": "^0.5.10",
    "tailwindcss": "^3.4.17"
  }
}
```

`tailwind.config.js` (the one block currently copied into ten pages):
```js
/** Tailwind is compiled once (`npm run build:css`) and the output is committed.
 *  Colours are RGB triplets set by theme.css / the server-inlined theme, so an
 *  operator's palette applies without a rebuild. */
module.exports = {
  content: [
    "./app/static/*.html",
    "./app/static/partials/*.html",
    "./app/static/js/*.js",
    "./app/pages.py",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "primary": "rgb(var(--color-primary) / <alpha-value>)",
        "baltic-blue": "rgb(var(--color-primary) / <alpha-value>)",
        "cornflower-ocean": "rgb(var(--color-secondary) / <alpha-value>)",
        "steel-blue": "rgb(var(--color-accent) / <alpha-value>)",
        "frosted-blue": "rgb(var(--color-text) / <alpha-value>)",
        "bright": "rgb(var(--color-text-secondary) / <alpha-value>)",
        "background-dark": "rgb(var(--color-background) / <alpha-value>)",
      },
      fontFamily: { "display": ["var(--font-display)", "sans-serif"] },
    },
  },
  plugins: [require("@tailwindcss/forms"), require("@tailwindcss/container-queries")],
};
```

`app/static/css/tailwind.src.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`scripts/stamp-css.mjs` (same algorithm as the test, byte for byte):
```js
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const GLOBS = [["app/static", /\.html$/], ["app/static/partials", /\.html$/], ["app/static/js", /\.js$/], ["app", /^pages\.py$/], ["app/static/css", /^tailwind\.src\.css$/]];

const files = new Set();
for (const [dir, re] of GLOBS) {
  let names = [];
  try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
  for (const n of names) {
    const p = join(ROOT, dir, n);
    if (re.test(n) && statSync(p).isFile()) files.add(p);
  }
}
const sorted = [...files].sort((a, b) => rel(a).localeCompare(rel(b)));
function rel(p) { return relative(ROOT, p).split(sep).join("/"); }

const h = createHash("sha256");
for (const p of sorted) { h.update(rel(p) + "\n"); h.update(readFileSync(p)); h.update("\n"); }
const hash = h.digest("hex").slice(0, 16);

const out = join(ROOT, "app/static/css/app.css");
const body = readFileSync(out, "utf8").replace(/^\/\* ws-css:[0-9a-f]{16} \*\/\n/, "");
writeFileSync(out, `/* ws-css:${hash} */\n` + body);
console.log(`stamped app.css with ws-css:${hash} (${sorted.length} content files)`);
```

Note: `localeCompare` vs Python's default sort can disagree on case/punctuation. Use `a < b ? -1 : a > b ? 1 : 0` on the posix relative strings instead of `localeCompare` so both sides sort by code point.

- [ ] **Step 4: Swap every page head**

In all 13 `app/static/*.html`: delete the `<script src="https://cdn.tailwindcss.com…"></script>` line and the whole `<script>tailwind.config = {…}</script>` block; add `<link href="/static/css/app.css?v=1" rel="stylesheet"/>` immediately before the `theme.css` link. Keep the Material Symbols link.

- [ ] **Step 5: Build and stamp**

```bash
npm install
npm run build:css
head -c 120 app/static/css/app.css
```
Expected: first line `/* ws-css:<16 hex> */`, file ~40–80 KB.

- [ ] **Step 6: Tighten CSP and docs**

`app/main.py` `add_security_headers`: `"script-src 'self' 'unsafe-inline'"` and `"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"`. `.gitignore` += `node_modules/`. `.dockerignore` += `node_modules/` and `app/tests/`. README line 107 → `- **Frontend:** Vanilla JavaScript, precompiled Tailwind CSS, Material Design Icons` and a new section:

```markdown
## Development

The stylesheet is compiled with the Tailwind CLI and the output (`app/static/css/app.css`)
is committed, so the running app never needs Node. After editing any HTML or JS:

    npm install          # once
    npm run build:css    # or: npm run watch:css

A unit test fails if the committed CSS is older than the markup it was built from.
Python tests: `python -m unittest discover -s app/tests -t . -v` (run inside the container
on a Docker host: `docker exec <container> python -m unittest discover -s /app/app/tests -t /app -v`).
```

- [ ] **Step 7: Run the tests (local Python is enough for this one)**

`python3 -m unittest app.tests.test_css_build -v` → PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tailwind.config.js scripts/stamp-css.mjs app/static/css/tailwind.src.css app/static/css/app.css app/tests app/static/*.html app/main.py .gitignore .dockerignore README.md
git commit -m "build: precompile Tailwind; drop the Play CDN from every page and the CSP"
```

---

### Task 2: Server page renderer (`app/pages.py`) and shell partials

**Files:**
- Create: `app/pages.py`, `app/static/partials/shell-sidebar.html`, `app/static/partials/shell-header.html`, `app/tests/test_pages.py`
- Modify: `app/routers/branding.py` (extract `build_branding`/`load_branding`), `app/main.py` (routes → `render_page`; remove moved helpers), `app/routers/setup.py:100-113`

**Interfaces:**
- Produces:
  - `app.routers.branding.build_branding(values: dict, auth_values: dict, vapid_public_key: str|None, wiki_hooks: dict) -> dict` (pure; same shape as `GET /api/branding`)
  - `app.routers.branding.load_branding(db, signed_in: bool) -> dict`
  - `app.pages.NAV_ITEMS: list[dict]`, `app.pages.PAGE_NAV = {"index": "home", "news": "home", ...}`
  - `app.pages.render_html(html: str, *, name: str, branding: dict, user: dict|None, version: str, base_url: str, path: str, flags: dict) -> str` (pure)
  - `app.pages.render_page(name: str, request, user: dict|None) -> Response` (I/O wrapper; 404 JSON if the file is missing)
  - `app.pages.asset_stamp(static_path: str) -> str` → `"<version>-<8 hex sha1>"`, cached by (path, mtime)
  - Markers pages must carry: `<!-- ws:sidebar -->`, `<!-- ws:header -->`
  - Head injection (right after `</title>`): OG tags (existing), `<style id="ws-theme">`, preconnects, `<link id="ws-font" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=…">`, `<script id="ws-data" type="application/json">`
  - `<html>` attributes: `data-page`, `data-admin` (admins), `data-netdata` (netdata url set)
  - JSON shape: `{"branding": {...}, "user": {"username","display_name","is_admin": bool,"avatar_url","auth_method"} | null, "version": "1.2.3", "page": "index"}`

- [ ] **Step 1: Write the failing tests** (`app/tests/test_pages.py`)

```python
import json
import re
import unittest
from unittest import mock

from app.pages import render_html, asset_stamp, NAV_ITEMS, PAGE_NAV
from app.routers.branding import build_branding

PAGE = ('<!DOCTYPE html><html class="dark" lang="en"><head><meta charset="utf-8"/>'
        '<title>WebServarr - Control Center</title>'
        '<script src="/static/js/theme-loader.js"></script>'
        '<link href="/static/css/app.css?v=1" rel="stylesheet"/></head>'
        '<body><!-- ws:sidebar --><main><!-- ws:header --><p>hi</p></main></body></html>')

ADMIN = {"username": "root", "display_name": "", "is_admin": "true", "avatar_url": "/static/a.png", "auth_method": "simple"}
MEMBER = {"username": "sam", "display_name": "Sam <b>", "is_admin": "false", "avatar_url": "javascript:alert(1)", "auth_method": "plex"}


def render(user=ADMIN, name="index", branding=None, flags=None):
    return render_html(PAGE, name=name, branding=branding or build_branding({}, {}, None, {}),
                       user=user, version="9.9.9", base_url="https://example.test", path="/", flags=flags or {})


class ShellRendering(unittest.TestCase):
    def test_sidebar_and_header_replace_markers(self):
        out = render()
        self.assertNotIn("ws:sidebar", out)
        self.assertNotIn("ws:header", out)
        self.assertIn('id="desktopSidebar"', out)
        self.assertIn('id="appHeader"', out)
        self.assertIn('title="Notifications"', out)
        self.assertRegex(out, r'<header[^>]*class="[^"]*lg:flex')

    def test_active_item_is_marked(self):
        out = render(name="calendar")
        self.assertRegex(out, r'<a[^>]*href="/calendar"[^>]*aria-current="page"')
        self.assertNotRegex(out, r'<a[^>]*href="/issues"[^>]*aria-current="page"')

    def test_admin_only_items_emitted_only_for_admins(self):
        self.assertIn('href="/settings"', render(user=ADMIN))
        self.assertNotIn('href="/settings"', render(user=MEMBER))
        self.assertIn('data-admin', render(user=ADMIN).split("<head>")[0])
        self.assertNotIn('data-admin', render(user=MEMBER).split("<head>")[0])

    def test_feature_gated_and_disabled_items(self):
        b = build_branding({"features.show_tickets": "false", "sidebar.enabled_calendar": "false"}, {}, None, {})
        out = render(branding=b)
        self.assertNotIn('href="/tickets"', out)
        self.assertNotIn('href="/calendar"', out)
        self.assertIn('href="/issues"', out)

    def test_labels_icons_sublabels_and_new_flag_apply(self):
        b = build_branding({"sidebar.label_issues": "Problems", "icon.nav_issues": "bug_report",
                            "sidebar.sublabel_issues": "", "sidebar.new_issues": "true"}, {}, None, {})
        out = render(branding=b)
        self.assertIn(">Problems<", out.replace("\n", ""))
        self.assertIn(">bug_report<", out)
        self.assertIn('class="nav-new-badge"', out)

    def test_user_strings_are_escaped_and_bad_avatar_dropped(self):
        out = render(user=MEMBER)
        self.assertIn("Sam &lt;b&gt;", out)
        self.assertNotIn("javascript:", out)
        self.assertIn("background-image:url('/static/a.png')", render(user=ADMIN))

    def test_head_gets_theme_font_and_data(self):
        out = render()
        self.assertIn('<style id="ws-theme">', out)
        self.assertIn("--color-primary:18 87 147", out)
        self.assertIn('<link id="ws-font" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Spline+Sans', out)
        self.assertIn('rel="preconnect" href="https://fonts.gstatic.com" crossorigin', out)
        data = json.loads(re.search(r'<script id="ws-data" type="application/json">(.*?)</script>', out, re.S).group(1))
        self.assertEqual(data["user"]["username"], "root")
        self.assertIs(data["user"]["is_admin"], True)
        self.assertEqual(data["version"], "9.9.9")
        self.assertEqual(data["page"], "index")
        self.assertEqual(data["branding"]["app_name"], "WebServarr")

    def test_data_block_cannot_close_itself(self):
        b = build_branding({"branding.app_name": "</script><script>alert(1)</script>"}, {}, None, {})
        out = render(branding=b)
        block = re.search(r'<script id="ws-data" type="application/json">(.*?)</script>', out, re.S).group(1)
        self.assertNotIn("</script", block)
        self.assertIn("\\u003c/script", block)
        self.assertIn("&lt;/script&gt;", out)   # the sidebar app-name is escaped too

    def test_invalid_colour_and_font_fall_back(self):
        b = build_branding({"theme.color_primary": "red; } body{display:none", "theme.font": "Evil\"; @import"}, {}, None, {})
        out = render(branding=b)
        self.assertIn("--color-primary:18 87 147", out)
        self.assertIn("family=Spline+Sans", out)

    def test_ws_data_precedes_theme_loader(self):
        out = render()
        self.assertLess(out.index('id="ws-data"'), out.index("theme-loader.js"))

    def test_title_rewrite_and_og_kept(self):
        out = render(branding=build_branding({"branding.app_name": "My Server"}, {}, None, {}))
        self.assertIn("<title>My Server - Control Center</title>", out)
        self.assertIn('property="og:site_name" content="My Server"', out)

    def test_netdata_flag(self):
        self.assertIn("data-netdata", render(flags={"netdata": True}).split("<head>")[0])
        self.assertNotIn("data-netdata", render(flags={"netdata": False}).split("<head>")[0])

    def test_pages_without_markers_are_left_alone(self):
        out = render_html("<html><head><title>WebServarr - Login</title></head><body>x</body></html>",
                          name="login", branding=build_branding({}, {}, None, {}), user=None,
                          version="1", base_url="", path="/login", flags={})
        self.assertNotIn("desktopSidebar", out)
        self.assertIn('"user": null', out.replace("\n", ""))

    def test_asset_stamp_uses_content_hash(self):
        with mock.patch("app.pages.settings") as s, mock.patch("app.pages._read_static_bytes", return_value=(b"abc", 1.0)):
            s.app_version = "1.0.0"
            self.assertEqual(asset_stamp("/static/js/shell.js"), "1.0.0-a9993e36")
        with mock.patch("app.pages.settings") as s, mock.patch("app.pages._read_static_bytes", return_value=None):
            s.app_version = "1.0.0"
            self.assertEqual(asset_stamp("/static/js/missing.js"), "1.0.0")

    def test_every_nav_item_has_a_page_mapping_target(self):
        ids = {i["id"] for i in NAV_ITEMS}
        for page, nav in PAGE_NAV.items():
            self.assertIn(nav, ids, page)
```

- [ ] **Step 2: Run to verify they fail**

`python3 -m unittest app.tests.test_pages -v` → ImportError (`app.pages` missing).

- [ ] **Step 3: Refactor `branding.py`**

Move the body of `get_branding` into:

```python
def build_branding(values: dict, auth_values: dict, vapid_public_key, wiki_hooks: dict) -> dict:
    def get(key: str) -> str:
        return values.get(key, DEFAULTS[key])
    plex_url = auth_values.get("integration.plex.url"); plex_token = auth_values.get("integration.plex.token")
    authentik_url = auth_values.get("integration.authentik.url"); authentik_client_id = auth_values.get("integration.authentik.client_id")
    auth_methods = {…as today…}
    return {…exactly today's dict, with "wiki_hooks": wiki_hooks, "vapid_public_key": vapid_public_key…}


def load_branding(db: Session, signed_in: bool) -> dict:
    rows = db.query(Setting).filter(Setting.key.in_(list(DEFAULTS.keys()))).all()
    values = {r.key: r.value for r in rows}
    vapid_row = db.query(Setting).filter(Setting.key == "notifications.vapid_public_key").first()
    auth_rows = db.query(Setting).filter(Setting.key.in_(AUTH_KEYS)).all()
    auth_values = {r.key: r.value for r in auth_rows}
    hooks = _resolve_wiki_hooks(db, lambda k: values.get(k, DEFAULTS[k]), signed_in)
    return build_branding(values, auth_values, vapid_row.value if vapid_row else None, hooks)
```
`get_branding` becomes `return load_branding(db, current_user is not None)`.

- [ ] **Step 4: Write `app/pages.py`**

```python
"""
Server-side page rendering.

Every HTML route reads a static file and passes it through here. The page
leaves the server with the shell (sidebar, header, mobile bar) already in the
markup for the signed-in user and the operator's branding, the theme variables
and display font already in <head>, and a JSON data block the client reads
instead of fetching /api/branding and /auth/check-session on every click.
The browser therefore paints a complete frame from the first byte; JS only
decorates. See docs/superpowers/specs/2026-09-12-navigation-load-feel-design.md.
"""
import hashlib, html, json, logging, os, re, urllib.parse
from typing import Optional
from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse
from app.config import settings
from app.database import SessionLocal

logger = logging.getLogger(__name__)
STATIC_DIR = "/app/app/static"

NAV_ITEMS = [
    {"id": "home", "href": "/", "label": "Home", "icon": "home", "sublabel": "See what's happening"},
    {"id": "requests", "href": "/requests", "label": "Requests", "icon": "movie", "sublabel": "Request a movie or show"},
    {"id": "requests-embed", "href": "/requests-embed", "label": "Requests (Embed)", "icon": "download",
     "sublabel": "Request through Seerr", "feature": "show_requests", "badge_id": "requestsBadge"},
    {"id": "issues", "href": "/issues", "label": "Issues", "icon": "report_problem", "sublabel": "Report a problem with media"},
    {"id": "calendar", "href": "/calendar", "label": "Calendar", "icon": "calendar_month", "sublabel": "See upcoming releases"},
    {"id": "tickets", "href": "/tickets", "label": "Tickets", "icon": "confirmation_number", "sublabel": "Get help from the admin", "feature": "show_tickets"},
    {"id": "library", "href": "/library", "label": "eBooks", "icon": "menu_book", "sublabel": "Read books in your browser", "feature": "show_books"},
    {"id": "wiki", "href": "/wiki", "label": "Wiki", "icon": "library_books", "sublabel": "Read guides and how-tos"},
    {"id": "settings", "href": "/settings", "label": "Settings", "icon": "settings", "sublabel": "Manage the site", "admin_only": True},
]
PAGE_NAV = {"index": "home", "news": "home", "requests": "requests", "requests-embed": "requests-embed",
            "issues": "issues", "calendar": "calendar", "tickets": "tickets", "library": "library",
            "wiki": "wiki", "settings": "settings"}

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_FONT = re.compile(r"^[A-Za-z0-9 \-]{1,60}$")
_DEFAULT_COLORS = {"primary": "#125793", "secondary": "#2C6DA1", "accent": "#4684B0", "text": "#BEEEF4",
                   "text_secondary": "#FFFFFF", "background": "#000000", "media_movie": "#E9D5FF",
                   "media_tv": "#67E8F9", "media_book": "#FCD34D"}
_COLOR_VARS = [("primary", "primary"), ("secondary", "secondary"), ("accent", "accent"), ("text", "text"),
               ("text-secondary", "text_secondary"), ("background", "background"),
               ("media-movie", "media_movie"), ("media-tv", "media_tv"), ("media-book", "media_book")]

def _rgb(hex_value: str) -> str:
    h = hex_value.lstrip("#"); return f"{int(h[0:2],16)} {int(h[2:4],16)} {int(h[4:6],16)}"

def _safe_hex(value, fallback): return value if isinstance(value, str) and _HEX.match(value) else fallback
def _safe_font(value): return value.strip() if isinstance(value, str) and _FONT.match(value.strip()) else "Spline Sans"
def _safe_url(value) -> str:
    v = (value or "").strip()
    return v if v.startswith(("https://", "http://", "/")) and not v.startswith("//") else ""

def theme_style(branding: dict) -> str:
    c = branding.get("colors") or {}
    decls = []
    for var, key in _COLOR_VARS:
        hexv = _safe_hex(c.get(key), _DEFAULT_COLORS[key])
        decls.append(f"--color-{var}:{_rgb(hexv)}"); decls.append(f"--hex-{var}:{hexv}")
    decls.append(f'--font-display:"{_safe_font(branding.get("font"))}",sans-serif')
    return '<style id="ws-theme">:root{' + ";".join(decls) + "}</style>"

def font_links(branding: dict) -> str:
    family = _safe_font(branding.get("font"))
    href = "https://fonts.googleapis.com/css2?family=" + urllib.parse.quote_plus(family) + ":wght@300;400;500;600;700&display=swap"
    return ('<link rel="preconnect" href="https://fonts.googleapis.com">'
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
            f'<link id="ws-font" rel="stylesheet" href="{html.escape(href, quote=True)}">')

def data_block(branding, user, version, name) -> str:
    payload = {"branding": branding, "user": user, "version": version, "page": name}
    text = json.dumps(payload, separators=(",", ":")).replace("<", "\\u003c")
    return f'<script id="ws-data" type="application/json">{text}</script>'

def public_user(session: Optional[dict]) -> Optional[dict]:
    if not session: return None
    return {"username": session.get("username", ""), "display_name": session.get("display_name", ""),
            "is_admin": session.get("is_admin", "false") == "true",
            "avatar_url": _safe_url(session.get("avatar_url", "")), "auth_method": session.get("auth_method", "")}
```

Nav rendering (classes are literal strings here so Tailwind's scan sees them — `app/pages.py` is in the content globs):

```python
_LINK_ACTIVE = ('<a class="relative flex items-center gap-3 px-4 py-2.5 rounded-lg bg-primary text-background-dark '
                'font-bold transition-all shadow-baltic-blue/20" href="{href}" aria-current="page">'
                '<span class="material-symbols-outlined fill-1 shrink-0">{icon}</span>{label}{badge}</a>')
_LINK = ('<a class="relative flex items-center gap-3 px-4 py-2.5 rounded-lg hover:bg-frosted-blue/5 text-frosted-blue '
         'transition-all group" href="{href}"><span class="material-symbols-outlined text-steel-blue '
         'group-hover:text-primary transition-colors shrink-0">{icon}</span>{label}{badge}</a>')
_LABEL_WITH_SUB = ('<span class="flex flex-col min-w-0 leading-tight"><span class="truncate">{label}{flag}</span>'
                   '<span class="text-[10px] font-normal truncate mt-0.5 {subcls}">{sub}</span></span>')
_BADGE = '<span id="{bid}" class="ml-auto bg-primary/20 text-[10px] px-1.5 py-0.5 rounded font-bold hidden"></span>'

def visible_nav_items(branding: dict, is_admin: bool) -> list:
    features = branding.get("features") or {}; enabled = branding.get("sidebar_enabled") or {}
    labels = branding.get("sidebar_labels") or {}; subs = branding.get("sidebar_sublabels") or {}
    icons = branding.get("icons") or {}; new = branding.get("sidebar_new") or {}
    out = []
    for item in NAV_ITEMS:
        if item.get("admin_only") and not is_admin: continue
        if item["id"] != "settings" and enabled.get(item["id"]) is False: continue
        if item.get("feature") and not features.get(item["feature"]): continue
        it = dict(item)
        if labels.get(item["id"]): it["label"] = labels[item["id"]]
        if icons.get("nav_" + item["id"]): it["icon"] = icons["nav_" + item["id"]]
        if item["id"] in subs: it["sublabel"] = subs[item["id"]]     # empty string hides the line
        it["new"] = bool(new.get(item["id"]))
        out.append(it)
    return out

def render_nav_links(branding, is_admin, active_id) -> str:
    parts = []
    for it in visible_nav_items(branding, is_admin):
        active = it["id"] == active_id
        flag = '<span class="nav-new-badge">New!</span>' if it["new"] else ""
        if it.get("sublabel"):
            label = _LABEL_WITH_SUB.format(label=html.escape(it["label"]), flag=flag, sub=html.escape(it["sublabel"]),
                                           subcls="opacity-70" if active else "text-steel-blue")
        else:
            label = "<span>" + html.escape(it["label"]) + flag + "</span>"
        badge = _BADGE.format(bid=html.escape(it["badge_id"])) if it.get("badge_id") else ""
        tpl = _LINK_ACTIVE if active else _LINK
        parts.append(tpl.format(href=html.escape(it["href"]), icon=html.escape(it["icon"]), label=label, badge=badge))
    return "\n".join(parts)
```

Partial substitution and the top-level renderer:

```python
_PARTIALS = {}
def _partial(name: str) -> str:
    path = os.path.join(STATIC_DIR, "partials", name)
    with open(path, "r", encoding="utf-8") as f: return f.read()

def fill(template: str, values: dict) -> str:
    """{{key}} is HTML-escaped; {{{key}}} is inserted raw (pre-rendered HTML only)."""
    def raw(m): return values.get(m.group(1), "")
    def esc(m): return html.escape(str(values.get(m.group(1), "")), quote=True)
    return re.sub(r"\{\{(\w+)\}\}", esc, re.sub(r"\{\{\{(\w+)\}\}\}", raw, template))

def shell_values(branding, user, version, name) -> dict:
    is_admin = bool(user and user.get("is_admin"))
    logo = _safe_url(branding.get("logo_url"))
    icons = branding.get("icons") or {}
    logo_html = (f'<img src="{html.escape(logo, True)}" alt="Logo" class="w-full h-auto rounded-lg object-contain mb-3">' if logo else
                 '<div class="size-14 bg-primary rounded-lg flex items-center justify-center shadow-lg shadow-baltic-blue/20 mb-3">'
                 f'<span class="material-symbols-outlined text-background-dark font-bold text-3xl">{html.escape(icons.get("sidebar_logo") or "settings_input_component")}</span></div>')
    avatar = user.get("avatar_url") if user else ""
    return {
        "app_name": branding.get("app_name") or "WebServarr",
        "logo_html": logo_html,
        "nav_links": render_nav_links(branding, is_admin, PAGE_NAV.get(name)),
        "version": "v" + version if version else "",
        "admin_block": "" if is_admin else "hidden",
        "user_name": (user or {}).get("display_name") or (user or {}).get("username") or "",
        "user_role": ("Admin" if is_admin else "User") if user else "",
        "avatar_style": f"background-image:url('{html.escape(avatar, True)}');background-size:cover;background-position:center" if avatar else "",
    }

def render_html(page_html, *, name, branding, user, version, base_url, path, flags) -> str:
    out = _inject_head(page_html, branding, user, version, name, base_url, path)   # title/OG (moved from main.py) + theme + fonts + data
    if "<!-- ws:sidebar -->" in out or "<!-- ws:header -->" in out:
        values = shell_values(branding, user, version, name)
        out = out.replace("<!-- ws:sidebar -->", fill(_partial("shell-sidebar.html"), values), 1)
        out = out.replace("<!-- ws:header -->", fill(_partial("shell-header.html"), values), 1)
    attrs = f' data-page="{html.escape(name, True)}"'
    if user and user.get("is_admin"): attrs += " data-admin"
    if flags.get("netdata"): attrs += " data-netdata"
    out = re.sub(r"<html\b", "<html" + attrs, out, count=1)
    return _stamp_asset_versions(out)
```

`_inject_head` = today's `_inject_preview_meta` logic (title suffix regex, OG tags built from `branding["app_name"/"tagline"/"logo_url"]` and `base_url`/`path`), appending `theme_style()`, `font_links()`, `data_block()` after the OG tags. `_base_url(request)` moves over unchanged.

Asset stamping:

```python
_ASSET_VERSION_RE = re.compile(r'(?P<attr>(?:src|href)="(?P<path>/static/[^"?]+)\?v=)[^"]*"')
_stamp_cache = {}

def _read_static_bytes(static_path: str):
    fs = os.path.join(STATIC_DIR, static_path[len("/static/"):])
    try:
        st = os.stat(fs)
        with open(fs, "rb") as f: return f.read(), st.st_mtime
    except OSError:
        return None

def asset_stamp(static_path: str) -> str:
    version = (settings.app_version or "dev").strip() or "dev"
    got = _read_static_bytes(static_path)
    if not got: return version
    data, mtime = got
    key = (static_path, mtime)
    if key not in _stamp_cache:
        _stamp_cache[key] = hashlib.sha1(data).hexdigest()[:8]
    return f"{version}-{_stamp_cache[key]}"

def _stamp_asset_versions(content: str) -> str:
    return _ASSET_VERSION_RE.sub(lambda m: f'{m.group("attr")}{asset_stamp(m.group("path"))}"', content)
```

I/O wrapper:

```python
def load_context(signed_in: bool):
    """(branding, flags) from the DB; packaged defaults if the DB is unavailable."""
    from app.routers.branding import build_branding, load_branding
    from app.models import Setting
    db = SessionLocal()
    try:
        branding = load_branding(db, signed_in)
        nd = db.query(Setting).filter(Setting.key == "integration.netdata.url").first()
        flags = {"netdata": bool(nd and nd.value)}
    except Exception:
        logger.warning("Could not load branding for page render; using defaults", exc_info=True)
        branding, flags = build_branding({}, {}, None, {"tickets": None, "issues": None, "playback": None}), {"netdata": False}
    finally:
        db.close()
    return branding, flags

def render_page(name: str, request: Optional[Request], user: Optional[dict]):
    filepath = os.path.join(STATIC_DIR, name + ".html")
    try:
        with open(filepath, "r", encoding="utf-8") as f: page_html = f.read()
    except FileNotFoundError:
        return JSONResponse(status_code=404, content={"detail": f"{name} page not found. Static files missing."})
    branding, flags = load_context(user is not None)
    try:
        out = render_html(page_html, name=name, branding=branding, user=public_user(user),
                          version=(settings.app_version or "dev"), base_url=_base_url(request),
                          path=request.url.path if request else "/", flags=flags)
    except Exception:   # a rendering bug must never take a page down
        logger.warning("Page rendering failed for %s; serving the raw file", name, exc_info=True)
        out = page_html
    return HTMLResponse(content=out)
```

- [ ] **Step 5: Write the partials**

`app/static/partials/shell-sidebar.html` — the markup `sidebar.js` builds today, minus `opacity-0` on the navs, minus `style="display:none"` on admin items (admins get them rendered; others don't), plus `view-transition-name`s, the speculation rules, and the shared scroll hint:

```html
<aside id="desktopSidebar" class="hidden lg:flex w-64 bg-baltic-blue/20 border-r border-steel-blue/30 flex-col h-screen shrink-0">
  <div class="p-6 flex flex-col items-center">
    {{{logo_html}}}
    <h1 class="text-frosted-blue font-bold text-lg leading-none text-center">{{app_name}}</h1>
  </div>
  <nav id="desktopNav" class="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-1" aria-label="Main">
{{{nav_links}}}
  </nav>
  <div class="p-4 border-t border-steel-blue/20">
    <p id="appVersion" class="text-steel-blue text-[10px] text-center {{admin_block}}">{{version}}</p>
  </div>
</aside>
<div id="mobileTopBar" class="lg:hidden sticky top-0 z-40 h-14 bg-black/80 backdrop-blur-md border-b border-steel-blue/20 flex items-center justify-between px-4">
  <button id="hamburgerBtn" class="p-2 text-steel-blue hover:text-bright transition-colors" aria-label="Open menu"><span class="material-symbols-outlined">menu</span></button>
  <span class="text-frosted-blue font-bold text-sm truncate max-w-[40%]">{{app_name}}</span>
  <div class="relative flex items-center gap-1 sm:gap-2 min-w-0">
    <button class="relative p-1.5 sm:p-2 text-steel-blue hover:text-frosted-blue transition-colors shrink-0" title="Notifications" aria-label="Notifications"><span class="material-symbols-outlined">notifications</span></button>
    <button id="mobileUserMenuBtn" class="flex items-center gap-1.5 sm:gap-2 cursor-pointer hover:opacity-80 transition-opacity min-w-0" aria-label="Account menu">
      <div class="text-right min-w-0">
        <p id="mobileUsername" class="text-xs font-bold text-frosted-blue leading-none truncate max-w-[80px] sm:max-w-[120px]">{{user_name}}</p>
        <p id="mobileRole" class="text-[10px] text-steel-blue hidden sm:block">{{user_role}}</p>
      </div>
    </button>
    <div id="mobileUserMenuDropdown" class="hidden absolute right-0 top-full mt-2 w-48 bg-black/95 border border-steel-blue/30 rounded-xl shadow-xl py-2 z-50">
      <a href="/settings" class="flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors {{admin_block}}"><span class="material-symbols-outlined text-steel-blue text-sm">manage_accounts</span>Account Settings</a>
      <button data-logout class="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors text-left"><span class="material-symbols-outlined text-steel-blue text-sm">logout</span>Sign Out</button>
    </div>
  </div>
</div>
<div id="drawerOverlay" class="lg:hidden fixed inset-0 z-50 bg-black/60 hidden" style="backdrop-filter:blur(2px)">
  <aside id="drawerPanel" class="w-72 bg-background-dark border-r border-steel-blue/30 h-full flex flex-col transform -translate-x-full transition-transform duration-300">
    <div class="p-6">
      <div class="flex items-center justify-between mb-3"><div class="flex-1"></div>
        <button id="drawerCloseBtn" class="p-1 text-steel-blue hover:text-bright transition-colors" aria-label="Close menu"><span class="material-symbols-outlined">close</span></button></div>
      <div class="flex flex-col items-center">{{{logo_html}}}<h1 class="text-frosted-blue font-bold text-lg leading-none text-center">{{app_name}}</h1></div>
    </div>
    <nav id="drawerNav" class="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-1" aria-label="Main">
{{{nav_links}}}
    </nav>
    <div class="p-4 border-t border-steel-blue/20">
      <button data-logout class="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium text-steel-blue hover:text-bright transition-colors"><span class="material-symbols-outlined text-sm">logout</span> Sign Out</button>
      <p class="appVersionMobile text-steel-blue text-[10px] text-center mt-2 {{admin_block}}">{{version}}</p>
    </div>
  </aside>
</div>
<div id="scrollDownHint" class="fixed bottom-6 left-1/2 -translate-x-1/2 pointer-events-none lg:hidden transition-opacity duration-300 opacity-0" aria-hidden="true">
  <span class="material-symbols-outlined text-steel-blue text-4xl animate-bounce motion-reduce:animate-none">arrow_downward</span>
</div>
<script type="speculationrules">
{"prerender":[{"where":{"selector_matches":"#desktopNav a, #drawerNav a"},"eagerness":"moderate"}],
 "prefetch":[{"where":{"selector_matches":"#desktopNav a, #drawerNav a"},"eagerness":"moderate"}]}
</script>
```

Note the nav badge id `requestsBadge` is emitted twice (desktop + drawer) exactly as today (`sidebar.js` emitted the same `navLinks` string into both navs). `index.html`'s `loadRequestCount` uses `getElementById` and so only updates the first; unchanged behaviour.

`app/static/partials/shell-header.html` — `header.js`'s markup, with the pill starting unknown (invisible, space reserved) and the user pre-filled:

```html
<header id="appHeader" class="h-16 border-b border-steel-blue/20 hidden lg:flex items-center justify-between px-8 bg-black/40 backdrop-blur-md relative z-50">
  <div class="flex items-center gap-6">
    <div id="systemStatus" data-state="unknown" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-steel-blue/10 border border-steel-blue/30">
      <span data-status-dot class="flex size-2 rounded-full bg-steel-blue"></span>
      <span data-status-text class="text-steel-blue text-xs font-bold uppercase tracking-widest">&nbsp;</span>
    </div>
  </div>
  <div class="flex items-center gap-4">
    <button class="relative p-2 text-steel-blue hover:text-frosted-blue transition-colors group" title="Notifications" aria-label="Notifications"><span class="material-symbols-outlined">notifications</span></button>
    <div class="relative">
      <button id="userMenuBtn" class="flex items-center gap-3 pl-4 cursor-pointer hover:opacity-80 transition-opacity" aria-label="Account menu">
        <div class="text-right">
          <p id="headerUsername" class="text-sm font-bold text-frosted-blue leading-none">{{user_name}}</p>
          <p id="headerRole" class="text-[10px] text-frosted-blue/60 mt-1">{{user_role}}</p>
        </div>
        <div id="headerAvatar" class="size-9 rounded-full bg-gradient-to-br from-baltic-blue to-cornflower-ocean border border-steel-blue/40" style="{{avatar_style}}"></div>
      </button>
      <div id="userMenuDropdown" class="hidden absolute right-0 top-full mt-2 w-48 bg-black/95 border border-steel-blue/30 rounded-xl shadow-xl py-2 z-50">
        <a href="/settings" class="flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors {{admin_block}}"><span class="material-symbols-outlined text-steel-blue text-sm">manage_accounts</span>Account Settings</a>
        <button data-logout class="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors text-left"><span class="material-symbols-outlined text-steel-blue text-sm">logout</span>Sign Out</button>
      </div>
    </div>
  </div>
</header>
```

- [ ] **Step 6: Wire routes**

`app/main.py`: delete `_TITLE_RE`, `_TITLE_SUFFIX_RE`, `_branding_for_preview`, `_base_url`, `_preview_meta`, `_ASSET_VERSION_RE`, `_stamp_asset_versions`, `_inject_preview_meta`, `_serve_page` (all now in `pages.py`). `_require_session` returns the session dict or `None`. Each page route becomes:

```python
user = await _require_session(session_id)
if not user:
    return RedirectResponse(url="/login", status_code=302)
return render_page("index", request, user)
```
`/login` → `render_page("login", request, None)`; `/settings` additionally `if user.get("is_admin") != "true": return RedirectResponse(url="/", status_code=302)`. `app/routers/setup.py` → `from app.pages import render_page` … `return render_page("setup", request, None)` (add `request: Request` to the signature).

- [ ] **Step 7: Run the tests in the container** (push → pull → restart first)

`ssh webserver "docker exec webservarr-dev python -m unittest discover -s /app/app/tests -t /app -v"` → all PASS. Also `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7980/login` on the VPS → 200, and the login HTML contains `id="ws-data"`.

- [ ] **Step 8: Commit**

```bash
git add app/pages.py app/routers/branding.py app/main.py app/routers/setup.py app/static/partials app/tests/test_pages.py
git commit -m "feat: render the page shell on the server — nav, user and theme arrive in the first byte"
```

(Pages still carry `#sidebar-root`/`#header-root`; the JS shell still builds. Nothing is broken at this commit: markers are absent so `render_html` leaves the body alone, and the head additions are inert until Task 3.)

---

### Task 3: Client shell (`shell.js`), `theme-loader.js`, `auth.js`, and page cutover

**Files:**
- Create: `app/static/js/shell.js`, `app/tests/test_shell_contract.py`
- Modify: `app/static/js/theme-loader.js`, `app/static/js/auth.js`, `app/static/css/theme.css`, all 10 shell pages (index, requests, requests-embed, issues, calendar, tickets, library, news, wiki, settings), `app/static/js/wiki-hook.js` (drop the retry loop)
- Delete: `app/static/js/sidebar.js`, `app/static/js/header.js`

**Interfaces:**
- Produces `window.WS`:
  - `WS.data` (parsed `#ws-data`), `WS.user` (or `null`), `WS.page`
  - `WS.ready(fn)` — run after DOMContentLoaded (or now)
  - `WS.whenActive(fn)` — now, or on `prerenderingchange`
  - `WS.poll(fn, ms) -> stop()` — visibility-aware interval, starts when active, runs `fn` once on activation if the page was prerendered >10 s ago, on `visibilitychange` to visible, and on bfcache `pageshow`
  - `WS.serviceStatus() -> Promise<Array>` — deduplicated `/api/integrations/service-status`, paints the pill, caches in `sessionStorage`
  - `WS.setHTML(el, html)` — skip identical writes
  - `WS.arrive(key, write)` and `WS.swr(key, fetcher, render, maxAge)` (implemented in Task 5 and 6; stubs here: `arrive` runs `write()` immediately, `swr` just fetches)
- `checkAuth(options)` unchanged signature; resolves from `WS.user`.
- `window.WEBSERVARR_THEME` still set by `theme-loader.js` before body scripts run.

- [ ] **Step 1: Write the contract test** (`app/tests/test_shell_contract.py`)

```python
import re, unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "static"
SHELL_PAGES = ["index", "requests", "requests-embed", "issues", "calendar", "tickets", "library", "news", "wiki", "settings"]
FORBIDDEN_STRINGS = ["hmserver", "HMServer", "HMS Dashboard"]


class ShellContract(unittest.TestCase):
    def read(self, name): return (STATIC / f"{name}.html").read_text(encoding="utf-8")

    def test_shell_pages_carry_both_markers_and_no_js_mounts(self):
        for n in SHELL_PAGES:
            h = self.read(n)
            self.assertIn("<!-- ws:sidebar -->", h, n); self.assertIn("<!-- ws:header -->", h, n)
            for bad in ("sidebar-root", "header-root", "initSidebar(", "showAdminNav(", "loadSystemStatus(", "loadAppVersion(", "sidebar.js", "header.js", 'id="scrollDownHint"'):
                self.assertNotIn(bad, h, f"{n}: {bad}")
            self.assertIn("/static/js/shell.js", h, n)
            self.assertLess(h.index("<title>"), h.index("theme-loader.js"), n)

    def test_pages_without_shell_do_not_reference_it(self):
        for n in ("login", "setup", "reader"):
            h = self.read(n)
            self.assertNotIn("ws:sidebar", h); self.assertNotIn("shell.js", h)

    def test_partials_keep_the_notification_and_menu_contracts(self):
        side = (STATIC / "partials" / "shell-sidebar.html").read_text(); head = (STATIC / "partials" / "shell-header.html").read_text()
        self.assertEqual(head.count('title="Notifications"'), 1); self.assertEqual(side.count('title="Notifications"'), 1)
        self.assertRegex(head, r'<header[^>]*class="[^"]*lg:flex')
        for i in ("desktopSidebar", "desktopNav", "drawerNav", "drawerOverlay", "drawerPanel", "hamburgerBtn", "drawerCloseBtn", "mobileTopBar", "mobileUserMenuBtn", "mobileUserMenuDropdown", "mobileUsername", "mobileRole", "scrollDownHint", "appVersion"):
            self.assertIn(f'id="{i}"', side, i)
        for i in ("appHeader", "systemStatus", "userMenuBtn", "userMenuDropdown", "headerUsername", "headerRole", "headerAvatar"):
            self.assertIn(f'id="{i}"', head, i)
        self.assertNotIn("Loading", head)

    def test_no_instance_specific_strings(self):
        for p in list(STATIC.glob("*.html")) + list((STATIC / "partials").glob("*.html")) + list((STATIC / "js").glob("*.js")):
            t = p.read_text(encoding="utf-8")
            for bad in FORBIDDEN_STRINGS: self.assertNotIn(bad, t, p.name)

    def test_polls_go_through_ws_poll(self):
        for n in SHELL_PAGES:
            h = self.read(n)
            self.assertNotRegex(h, r"\bsetInterval\(", f"{n}: use WS.poll")
```

- [ ] **Step 2: Run to verify it fails** (`python3 -m unittest app.tests.test_shell_contract -v` → many failures).

- [ ] **Step 3: `theme-loader.js`**

Replace the file body's cache/fetch logic:

```js
(function () {
  'use strict';
  function hexToRgb(hex) { … unchanged … }
  function applyTheme(data) { … unchanged, except: skip the Google Fonts injection when document.getElementById('ws-font') exists … }

  function readInline() {
    var el = document.getElementById('ws-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  var inline = readInline();
  if (inline) {
    window.WS_DATA = inline;               // shell.js and auth.js read this
    applyTheme(inline.branding || {});
  } else {
    // A page served outside render_page(): fall back to the API once.
    window.WS_DATA = null;
    var run = function () {
      fetch('/api/branding').then(function (r) { return r.json(); }).then(applyTheme).catch(function () {});
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
  }
})();
```
Remove `CACHE_KEY`, `loadCached`, `localStorage` writes. In `settings.html`, delete the two `localStorage.removeItem('webservarr_branding')` lines (no-ops now).

- [ ] **Step 4: `auth.js`**

```js
async function checkAuth(options) {
  options = options || {};
  var stamped = window.WS_DATA && window.WS_DATA.user;
  if (stamped) {
    if (options.requireAdmin && !stamped.is_admin) { window.location.href = '/'; return null; }
    return stamped;
  }
  try { … existing fetch path, minus the header population (the shell owns it) … } catch (e) { window.location.href = '/login'; return null; }
}
```
Delete `loadSystemStatus` and `loadAppVersion`. Keep `wireLogout`, `escapeHtml`, `getTimeAgo`, `formatUptime`.

- [ ] **Step 5: `shell.js`**

```js
/**
 * WebServarr — page shell (client side)
 *
 * The sidebar, header and mobile bar arrive in the HTML already rendered for
 * this user (see app/pages.py). This module only decorates: menus, drawer,
 * logout, notifications, the status pill, the scroll hint, and the shared
 * helpers pages use to load content in a designed order. It never constructs
 * navigation.
 */
(function () {
  'use strict';
  var data = window.WS_DATA || null;
  var user = data && data.user ? data.user : null;
  var initAt = performance.now();
  var ns = 'ws:' + (user ? user.username : 'anon') + ':';

  function ss(key, value) {                 // sessionStorage with try/catch, namespaced by user
    try {
      if (arguments.length === 1) { var raw = sessionStorage.getItem(ns + key); return raw ? JSON.parse(raw) : null; }
      sessionStorage.setItem(ns + key, JSON.stringify(value));
    } catch (e) { return null; }
  }
  function clearCache() {
    try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('ws:') === 0) sessionStorage.removeItem(k); }); } catch (e) {}
  }

  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
  function whenActive(fn) { if (document.prerendering) document.addEventListener('prerenderingchange', fn, { once: true }); else fn(); }

  function poll(fn, ms) {
    var timer = null;
    function tick() { if (!document.hidden) fn(); }
    whenActive(function () {
      if (performance.now() - initAt > 10000) fn();      // prerendered a while ago: refresh on arrival
      timer = setInterval(tick, ms);
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && timer) fn(); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) fn(); });
    return function stop() { if (timer) clearInterval(timer); timer = null; };
  }

  var _lastHTML = new WeakMap();
  function setHTML(el, html) {
    if (!el) return false;
    if (_lastHTML.get(el) === html) return false;
    el.innerHTML = html; _lastHTML.set(el, html); return true;
  }

  // ---- Status pill ----
  var PILL = {
    ok:   { pill: 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/30', dot: 'flex size-2 rounded-full bg-green-500 animate-pulse', text: 'text-green-500 text-xs font-bold uppercase tracking-widest', label: 'All Systems Online' },
    warn: { pill: 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-yellow-500/10 border border-yellow-500/30', dot: 'flex size-2 rounded-full bg-yellow-500', text: 'text-yellow-500 text-xs font-bold uppercase tracking-widest', label: 'Degraded Performance' },
    err:  { pill: 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/30', dot: 'flex size-2 rounded-full bg-red-500', text: 'text-red-500 text-xs font-bold uppercase tracking-widest', label: 'System Issues Detected' }
  };
  function paintStatus(state) {
    var pill = document.getElementById('systemStatus'); if (!pill) return;
    var s = PILL[state]; if (!s) { pill.dataset.state = 'unknown'; return; }
    pill.className = s.pill; pill.dataset.state = state;
    pill.querySelector('[data-status-dot]').className = s.dot;
    var t = pill.querySelector('[data-status-text]'); t.className = s.text; t.textContent = s.label;
  }
  function summarise(services) {
    if (!Array.isArray(services) || !services.length) return null;
    if (services.some(function (s) { return s.status === 'down'; })) return 'err';
    if (services.some(function (s) { return s.status === 'degraded'; })) return 'warn';
    return 'ok';
  }
  var _statusPromise = null;
  function serviceStatus() {
    if (_statusPromise) return _statusPromise;
    _statusPromise = fetch('/api/integrations/service-status')
      .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
      .then(function (list) {
        var state = summarise(list);
        if (state) { paintStatus(state); ss('status', { state: state, list: list, t: Date.now() }); }
        setTimeout(function () { _statusPromise = null; }, 5000);
        return list;
      });
    return _statusPromise;
  }

  // ---- Chrome wiring (drawer, menus, logout) ----
  function wireChrome() {
    var overlay = document.getElementById('drawerOverlay'), panel = document.getElementById('drawerPanel');
    var open = function () { overlay.classList.remove('hidden'); void panel.offsetHeight; panel.classList.remove('-translate-x-full'); panel.classList.add('translate-x-0'); };
    var close = function () { panel.classList.remove('translate-x-0'); panel.classList.add('-translate-x-full'); setTimeout(function () { overlay.classList.add('hidden'); }, 300); };
    var hb = document.getElementById('hamburgerBtn'), cb = document.getElementById('drawerCloseBtn');
    if (hb && overlay && panel) hb.addEventListener('click', open);
    if (cb && overlay && panel) cb.addEventListener('click', close);
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    [['userMenuBtn', 'userMenuDropdown'], ['mobileUserMenuBtn', 'mobileUserMenuDropdown']].forEach(function (pair) {
      var btn = document.getElementById(pair[0]), menu = document.getElementById(pair[1]);
      if (!btn || !menu) return;
      btn.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('hidden'); });
      document.addEventListener('click', function () { menu.classList.add('hidden'); });
    });
    document.querySelectorAll('#logoutBtn, [data-logout]').forEach(function (b) {
      b.addEventListener('click', function () { clearCache(); window.location.href = '/auth/logout'; });
    });
  }

  // ---- Scroll hint (mobile only; shown only when there is content below the fold) ----
  function wireScrollHint() {
    var hint = document.getElementById('scrollDownHint'); if (!hint) return;
    function update() {
      var doc = document.documentElement;
      var canScroll = doc.scrollHeight > window.innerHeight + 24;
      var atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 20;
      hint.style.opacity = (canScroll && !atBottom) ? '1' : '0';
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(document.body);
    update();
  }

  window.WS = { data: data, user: user, page: data ? data.page : null, ready: ready, whenActive: whenActive, poll: poll,
                setHTML: setHTML, serviceStatus: serviceStatus, clearCache: clearCache,
                arrive: function (key, write) { if (write) write(); },        // replaced in Task 5
                swr: function (key, fetcher, render) { return fetcher().then(function (d) { render(d, false); return d; }); } }; // Task 6

  ready(function () {
    if (!document.getElementById('desktopSidebar')) return;   // page without a shell
    wireChrome();
    wireScrollHint();
    var cached = ss('status'); if (cached && cached.state) paintStatus(cached.state);
    whenActive(function () {
      serviceStatus();
      if (typeof window.initNotifications === 'function' && user) window.initNotifications();
    });
  });
})();
```

- [ ] **Step 6: `theme.css` additions**

```css
/* ---- Status pill: unknown state reserves its width without saying "Loading" ---- */
#systemStatus[data-state="unknown"] { visibility: hidden; }

/* ---- Cross-document view transitions: the frame stays, the content crossfades ---- */
@view-transition { navigation: auto; }
#desktopSidebar { view-transition-name: ws-sidebar; }
#appHeader      { view-transition-name: ws-header; }
#mobileTopBar   { view-transition-name: ws-topbar; }
main            { view-transition-name: ws-content; }
::view-transition-old(ws-sidebar), ::view-transition-new(ws-sidebar),
::view-transition-old(ws-header),  ::view-transition-new(ws-header),
::view-transition-old(ws-topbar),  ::view-transition-new(ws-topbar) { animation: none; }
::view-transition-old(ws-content) { animation: ws-vt-out 120ms ease-out both; }
::view-transition-new(ws-content) { animation: ws-vt-in 180ms ease-out both; }
::view-transition-old(root), ::view-transition-new(root) { animation: none; }
@keyframes ws-vt-out { to { opacity: 0; } }
@keyframes ws-vt-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  @view-transition { navigation: none; }
}
```

- [ ] **Step 7: Cut every shell page over**

For each of the 10 shell pages:
1. Replace `<div id="sidebar-root" class="lg:w-64 lg:shrink-0"></div>` with `<!-- ws:sidebar -->` and `<div id="header-root" class="hidden lg:block lg:h-16"></div>` with `<!-- ws:header -->`.
2. Delete the page's `<div id="scrollDownHint" …>…</div>` block and its scroll-hint IIFE in the init script.
3. Replace the `header.js?v=2` and `sidebar.js?v=NN` script tags with `<script src="/static/js/shell.js?v=1"></script>` (keep `auth.js` first, `notifications.js` after).
4. In the init: delete `initSidebar('…')`, `initNotifications()`, `showAdminNav(user.is_admin)`, `loadSystemStatus()`, the `headerUsername`/`headerRole`/`mobileUsername`/`mobileRole` population, and the `userMenuBtn`/`userMenuDropdown` wiring (`news`, `wiki`, `tickets`, `library`, `settings` all have copies). Keep `checkAuth()` and everything after it.
5. `setInterval(fn, ms)` → `WS.poll(fn, ms)`; `_refreshInterval = setInterval(…)` → `_stopRefresh = WS.poll(…)` and `clearInterval(_refreshInterval)` → `_stopRefresh && _stopRefresh()`.
6. `requests-embed.html`: wrap the `seerr-auth` POST + iframe insert in `WS.whenActive(async function () { … })`.
7. `index.html` `loadServices()` and the 30 s poll: replace `fetch('/api/integrations/service-status')` with `WS.serviceStatus()`; the pill refresh comes for free.
8. `wiki-hook.js`: `initWikiHook` calls `renderWikiHook` directly (branding is synchronous now).

Delete `sidebar.js` and `header.js`. `npm run build:css`.

- [ ] **Step 8: Deploy to dev, run all tests in the container, smoke every route**

`for r in / /requests /requests-embed /issues /calendar /tickets /library /news /wiki /settings /login; do curl -s -o /dev/null -w "$r %{http_code}\n" -b "$COOKIE" http://127.0.0.1:7980$r; done` (on the VPS, with a session cookie obtained from `POST /auth/simple-login` against the dev instance's admin). Then in Chrome: every page, zero console errors, sidebar visible before any XHR completes (DevTools Network throttled to Slow 3G to prove it).

- [ ] **Step 9: Commit**

```bash
git add -A app/static app/tests
git rm app/static/js/sidebar.js app/static/js/header.js
git commit -m "feat: the shell is static markup; JS decorates — no nav fade-in, no per-click branding, session or version fetch"
```

---

### Task 4: Skeletons that reserve final layout (per page)

**Files:**
- Modify: `app/static/css/theme.css` (skeleton primitives), `index.html`, `issues.html`, `tickets.html`, `calendar.html`, `news.html`, `requests.html` (stat cells), `library.html`, `settings.html` (two lists), `requests-embed.html`

**Interfaces:**
- Produces CSS classes: `.skel` (block shimmer), `.skel-line` (text line, `height:.85em`), `.skel-num` (inline number placeholder, `width:2.2ch;height:1em`), `.skel-tile`, `.skel-card`, `.skel-row`, `.skel-poster`.

- [ ] **Step 1: Primitives** (`theme.css`)

```css
/* ---- Skeletons: the shape of what is coming, in the theme's own text colour ---- */
.skel { position: relative; overflow: hidden; border-radius: 10px;
        background: rgb(var(--color-text) / 0.06); }
.skel::after { content: ""; position: absolute; inset: 0;
        background: linear-gradient(90deg, transparent, rgb(var(--color-text) / 0.06), transparent);
        transform: translateX(-100%); animation: ws-shimmer 1.4s ease-in-out infinite; }
.skel-line { height: .85em; border-radius: 6px; }
.skel-num  { display: inline-block; width: 2.2ch; height: 1em; vertical-align: -0.1em; border-radius: 6px; }
.skel-tile { height: 92px; border-radius: 12px; }
.skel-card { height: 116px; border-radius: 12px; }
.skel-row  { height: 56px; border-radius: 10px; }
.skel-poster { aspect-ratio: 2 / 3; border-radius: 12px; }
@keyframes ws-shimmer { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) { .skel::after { animation: none; } }
```

- [ ] **Step 2: index.html**

Replace the five "Loading …" placeholders:
- `#servicesContainer` initial content: three `<div class="skel skel-tile"></div>`.
- `#newsContainer`: two `<div class="skel skel-card"></div>`.
- `#streamsContainer`: one `<div class="skel rounded-2xl" style="aspect-ratio:16/9"></div>`.
- `#releasesContainer`: `<div class="space-y-2"><div class="skel skel-row"></div>×3</div>`.
- `#requestsBody`: three `<tr><td colspan="2" class="px-6 py-3"><div class="skel skel-line w-2/3"></div></td></tr>`.
- Netdata gauges: change `<div id="netdataGauges" class="hidden bg-baltic-blue/10 …">` to `class="bg-baltic-blue/10 …"` and add to `theme.css`: `html:not([data-netdata]) #netdataGauges { display: none; }`. In `loadSystemStats()`, delete both `gaugesEl.classList.add('hidden')` and the `.remove('hidden')` (the block never toggles; on error the numbers stay at their last value and the "--" placeholders remain on a cold load).
- `#newsViewAll`: keep `hidden` (it sits `ml-auto` in a flex row, so toggling it moves nothing else).

- [ ] **Step 3: issues.html and tickets.html**

Stat numbers: `<p … id="statTotal">--</p>` → `<p … id="statTotal"><span class="skel skel-num"></span></p>` (the loader writes `textContent`, which replaces the span). Lists: replace the spinner block with three `<div class="skel skel-row"></div>` inside a `space-y-2` wrapper. Delete the `Loading...` header spinner blocks (`issues.html:45-46`, `tickets.html:90-91`).

- [ ] **Step 4: calendar.html**

Ship the day-of-week header row and a 6×7 grid of `<div class="skel" style="min-height:96px"></div>` cells in static markup inside `#calendarGrid` (match the real cell `min-height` — read it from `renderMonth()`); `buildDayHeaders()` writes the same headers (idempotent). `renderMonth()` replaces the grid; the JS-created spinner (`calendar.html:197-201`) is deleted.

- [ ] **Step 5: news.html, library.html, settings.html, requests.html, requests-embed.html**

- news: three `.skel-card`. library: the "Loading your library…" block → a row of six `.skel-poster` inside the shelf container + a 6-column poster grid skeleton in `#bookGrid`. settings: `Loading monitors...` and `Loading news posts...` → three `.skel-row` each; `Loading categories…` → two `.skel-row`. requests: every `--` stat cell → `<span class="skel skel-num"></span>` (the loaders set `textContent`). requests-embed: `#iframeContainer` placeholder → one `<div class="skel h-full w-full rounded-2xl"></div>`.

- [ ] **Step 6: Build, deploy, verify no layout shift**

`npm run build:css`, push/pull/restart. In Chrome DevTools → Performance → record a load of `/`, `/issues`, `/tickets`, `/calendar`: Layout Shift cluster score must read 0.00 after the first paint (the only allowed shift is skeleton → shorter real content when a section is empty).

- [ ] **Step 7: Commit** — `git commit -m "feat: skeletons reserve the final layout on every page; nothing un-hides after load"`

---

### Task 5: Arrival orchestration (top-down reveal)

**Files:**
- Modify: `app/static/js/shell.js` (real `WS.arrive`), `theme.css` (`.ws-in` entrance), `index.html`, `issues.html`, `tickets.html`, `calendar.html`, `news.html`, `requests.html`, `library.html`, `wiki.html`

**Interfaces:**
- `WS.arrive(key: string, write: () => void)`: first call per key queues until every earlier `[data-arrive]` key (document order) has arrived or the 1.2 s gate lifts, then runs `write()` and adds `.ws-in` to `[data-arrive="key"]`; later calls run `write()` at once without animation.

- [ ] **Step 1: shell.js**

```js
  var _arr = { order: [], done: {}, queue: {}, gate: false, last: 0 };
  function arriveInit() {
    _arr.order = Array.prototype.map.call(document.querySelectorAll('[data-arrive]'), function (el) { return el.getAttribute('data-arrive'); });
    setTimeout(function () { _arr.gate = true; arriveFlush(); }, 1200);
  }
  function arrive(key, write) {
    if (_arr.done[key] || _arr.order.indexOf(key) === -1) { if (write) write(); return; }
    _arr.queue[key] = write || function () {};
    arriveFlush();
  }
  function arriveFlush() {
    for (var i = 0; i < _arr.order.length; i++) {
      var k = _arr.order[i];
      if (_arr.done[k]) continue;
      if (!(k in _arr.queue)) { if (_arr.gate) continue; return; }
      var w = _arr.queue[k]; delete _arr.queue[k]; _arr.done[k] = true;
      try { w(); } catch (e) { console.error(e); }
      var el = document.querySelector('[data-arrive="' + k + '"]');
      if (el) {
        var now = performance.now(), delay = Math.max(0, _arr.last + 60 - now);
        _arr.last = now + delay;
        el.style.animationDelay = delay + 'ms';
        el.classList.add('ws-in');
      }
    }
  }
```
Call `arriveInit()` inside `ready()` before `wireChrome()`; export `arrive`.

`theme.css`:
```css
[data-arrive].ws-in { animation: ws-fade-up 220ms ease-out both; }
@keyframes ws-fade-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { [data-arrive].ws-in { animation: none; } }
```

- [ ] **Step 2: Mark sections and route initial writes through `arrive`**

index: `data-arrive="services"` on the Service Health `<section>`, `"news"`, `"streams"`, `"releases"`, `"requests"` on the others. In each loader, the *initial* `innerHTML` write becomes `WS.arrive('services', function () { WS.setHTML(servicesContainer, html); })` (also error/empty branches). Because `arrive` runs later calls immediately, the 30 s polls need no change beyond `setHTML`.
issues/tickets: `data-arrive="counts"` on the stats row, `"list"` on the list. calendar: `"month"` on the grid wrapper. news: `"posts"`. requests: `"stats"`, `"shelves"`, `"status"`. library: `"shelves"`, `"grid"`. wiki: `"content"` (the view container).

- [ ] **Step 3: Build, deploy, verify** — throttle to Slow 3G; sections must appear top-down with visible stagger regardless of which XHR finished first; no section appears before the one above it unless >1.2 s passed.

- [ ] **Step 4: Commit** — `git commit -m "feat: sections arrive top-down in a designed order, not network order"`

---

### Task 6: Instant revisits — diff writes and stale-while-revalidate

**Files:**
- Modify: `shell.js` (real `WS.swr`), `index.html`, `issues.html`, `tickets.html`, `calendar.html`, `news.html`, `requests.html` (stats + trending), `wiki.html` (index)

**Interfaces:**
- `WS.swr(key, fetcher, render, maxAge=900000) -> Promise<data>`: renders the cached copy synchronously when present and younger than `maxAge`, then fetches; renders again only if the JSON differs; stores the fresh copy. Keys are namespaced by user; cleared on logout.

- [ ] **Step 1: shell.js**

```js
  function swr(key, fetcher, render, maxAge) {
    if (maxAge === undefined) maxAge = 15 * 60 * 1000;
    var cached = ss('swr:' + key);
    var cachedJSON = null;
    if (cached && (Date.now() - cached.t) < maxAge) {
      cachedJSON = JSON.stringify(cached.d);
      try { render(cached.d, true); } catch (e) { console.error(e); }
    }
    return fetcher().then(function (fresh) {
      var freshJSON = JSON.stringify(fresh);
      if (freshJSON !== cachedJSON) { try { render(fresh, false); } catch (e) { console.error(e); } }
      ss('swr:' + key, { t: Date.now(), d: fresh });
      return fresh;
    });
  }
```

- [ ] **Step 2: Convert loaders**

Pattern (dashboard news):
```js
async function loadNews() {
  var cfg = newsSettings();
  var url = '/api/news/?limit=' + (cfg.count + 1) + (cfg.maxAgeDays > 0 ? '&max_age_days=' + cfg.maxAgeDays : '');
  return WS.swr('news:' + url, function () { return fetch(url).then(function (r) { return r.json(); }); }, renderNews);
}
function renderNews(posts) { … the existing body from `if (!Array.isArray(posts)…` onward, with writes through WS.arrive('news', …)/WS.setHTML … }
```
Apply to: index (`loadNews`, `loadServices` via `WS.serviceStatus` — cache its list with key `services`), `loadActiveStreams` (maxAge 60 s), `loadRecentRequests`, `loadUpcomingReleases`; issues (`loadIssueCounts`, `loadIssues`); tickets (`loadCounts`, `loadTickets`); calendar (`fetchAndRender` per month key); news (page 1 only); requests (`RS.load` stats, trending shelves); wiki (index listing). Error branches: on fetch failure with a cached render already on screen, keep the cached content (do not replace with an error block).

- [ ] **Step 3: Verify** — visit `/`, wait for content, go to `/issues`, come back: the dashboard must paint with real content on first frame (no skeletons), then quietly refresh. Log out: `sessionStorage` has no `ws:` keys.

- [ ] **Step 4: Commit** — `git commit -m "feat: revisits paint from the last known data and refresh quietly; polls only write what changed"`

---

### Task 7: Browser verification and the before/after record

- [ ] **Step 1: Console** — every route (`/`, `/requests`, `/requests-embed`, `/issues`, `/calendar`, `/tickets`, `/library`, `/news`, `/wiki`, `/wiki/<slug>`, `/settings`, `/reader?…`, `/login`): zero console errors/warnings from our code.
- [ ] **Step 2: Stationary shell proof** — via `evaluate_script` on two consecutive pages: `document.getElementById('desktopSidebar').outerHTML` and `#appHeader.outerHTML` are byte-identical except for `aria-current` on the active link; no XHR to `/api/branding`, `/auth/check-session` or `/health` in the network log during navigation.
- [ ] **Step 3: Layout shift** — performance trace per page: CLS 0.00 after first paint.
- [ ] **Step 4: Recording** — `Screencast` equivalent: capture a frame series (4 fps contact sheet like the analysis) of the same eight-click path on the dev instance and save alongside the original for Jordan (`docs/mockups/nav-feel-after-2026-09-12.png` is *not* committed; put it in the parent directory next to the video).
- [ ] **Step 5: Docs** — `docs/setup.md` "Content Security" note no longer mentions the Tailwind CDN; CLAUDE.md (parent dir) key-paths block gains `app/pages.py`, `app/static/partials/`, `app/static/js/shell.js`, `app/static/css/app.css` and the build step. Commit docs.
