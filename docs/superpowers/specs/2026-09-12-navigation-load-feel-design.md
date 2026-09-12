# Navigation & load feel — design

Date: 2026-09-12. Branch: `dev`. Design contract: `UI-DESIGN-REVIEW-2026-08-15.md`
Part 5, "Navigation & load feel" + "Craft floor" (parent directory, outside the repo).

The complaint, in the operator's words: every sidebar click tears the whole page down and
rebuilds it; each page loads its pieces in a different order and with a different loading
style; the sidebar, header, status pill and avatar all visibly reset; revisiting a page
reloads everything. Target: Radarr/Sonarr — click, and only the content that changes changes.

---

## 1. What the recording shows

`Screencast_20260912_101935.webm`, 17.5 s, 60 fps, desktop viewport 1908×975. Frames
sampled at 4 fps. Timeline of the eight navigations:

| t (s) | Action | What is visible in the frame right after the click |
|------:|--------|------------------------------------------------------|
| 2.50 | Home → Home (reload) | Sidebar shows logo + app name only; every nav item gone. Header pill reads "LOADING…", avatar is a blank blue disc. Content shows five "Loading services… / news… / streams… / releases… / requests…" blocks. 250 ms later everything is back. |
| 4.75 | Home → Requests | Same shell reset. Content: four stat cards full of `--`, empty poster rows, "Loading requests…". Posters arrive 0.75 s later in three separate pops. |
| 6.25 | Requests → Issues | Same shell reset. `--` stat tiles, a spinner + "Loading issues…", then the counts and the empty state arrive separately. |
| 8.00 | Issues → Calendar | Same shell reset; main area completely empty for 250 ms, then a spinner "Loading calendar…", then the whole grid pops in. |
| 10.25 | Calendar → Tickets | Same shell reset; `--` tiles, spinner "Loading tickets…", then counts, then the empty state. |
| 12.00 | Tickets → Home | Everything from the 2.50 s frame again: nothing from ten seconds earlier is reused. |
| 14.25 | Home → Settings | Same shell reset, then the accordion appears in one block. |

Every navigation shows the same three shell symptoms (nav items vanish, pill flips to
"LOADING…", avatar blanks) regardless of page, and a different content-loading style on
every page.

## 2. Inventory — how each page is built today

Every route in `app/main.py` reads a static file and returns it via `_serve_page`, which
already rewrites the document server-side (`<title>`, Open Graph tags, `?v=` asset stamps).
`/setup` is served raw by `app/routers/setup.py`. `/wiki/{slug}` serves `wiki.html`.

| Route / file | Shell | Shell built by | Fetches on load (before any content) | Content loading style | Layout-shift sources |
|---|---|---|---|---|---|
| `/` index.html | sidebar + header + mobile bar | JS (`sidebar.js`, `header.js`) | `/api/branding`, `/auth/check-session`, `/api/integrations/service-status`, `/health`, notifications | Icon + "Loading X…" text ×5; 8 concurrent fetches; `innerHTML` on arrival in network order | Netdata gauge block `hidden`→shown pushes tiles down; "View all" link `hidden`→`flex`; gauges block re-hides on error |
| `/requests` requests.html | same | JS | same 4 + notifications + request-status grid + trending shelves | Poster-row skeletons (good); 16 stat cells `--`; "Loading requests…" | Search bar relocates on first keystroke (deliberate); stat `--`→numbers reflow slightly |
| `/requests-embed` | same (no notifications) | JS | same 4, then `POST seerr-auth`, `seerr-url` | "Loading Seerr…" text, then iframe | iframe insert |
| `/issues` issues.html | same | JS | same 4 + notifications + counts + list | spinner "Loading…" + `--` tiles + "Loading issues…" | none major |
| `/calendar` calendar.html | same | JS | same 4 + notifications + month | empty area → JS-built headers → spinner "Loading calendar…" → grid | day headers and grid are both JS-built, so the area is empty at first paint |
| `/tickets` tickets.html | same | JS | same 4 + notifications + counts + list | spinner "Loading…" + `--` ×4 + "Loading tickets…" | none major |
| `/library` library.html | same | JS | same 4 + notifications + shelves + page | spinner "Loading your library…" | shelves insert |
| `/news` news.html | same | JS | same 4 + notifications + page 1 | "Loading news…" text | none |
| `/wiki`, `/wiki/{slug}` wiki.html | same | JS | same 4 + notifications | Skeletons (good), but rendering waits for `check-session` | none |
| `/settings` settings.html | same | JS | same 4 + notifications + every settings group | "Loading monitors…" text etc. | accordion |
| `/reader` reader.html | none (immersive) | — | `/api/branding`, `/auth/check-session`, book | spinner | own paging model |
| `/login` login.html | none | — | `/api/branding` (again, if not cached), `status-summary`, `check-session` | pill "Loading…"; form hidden until auth methods resolve (keep — v1.4.2 flash fix) | slideshow |
| `/setup` setup.html | none | — | `/api/branding` | — | — |

Common to all 13 files: Tailwind Play CDN (`cdn.tailwindcss.com`, ~400 KB of JS that
scans the DOM and generates CSS at runtime, on every document), an identical inline
`tailwind.config` copied into 10 files (settings drops `container-queries`; login/setup/
reader drift slightly), Material Symbols via Google Fonts, `theme-loader.js` in `<head>`,
`theme.css`. The display font (`Spline Sans` by default) is injected by `theme-loader.js`
at runtime after branding is known, never from static markup.

## 3. Root causes, mapped to the symptoms

**A. The shell is constructed by JS after the document loads, and hidden until an auth
round-trip resolves.** `#sidebar-root` and `#header-root` are empty divs. `header.js` runs
at the end of `<body>` and builds a header whose pill literally says "Loading…", whose
name/role are empty and whose avatar is a gradient disc. `sidebar.js` builds the sidebar
from `window.WEBSERVARR_THEME` (a 5-minute `localStorage` copy of `/api/branding`, or
built-in defaults) with the `<nav>` at `opacity-0`; `showAdminNav()` fades it in only after
`checkAuth()` has awaited `/auth/check-session`. It then polls every 100 ms (up to 4 s)
and rebuilds the entire sidebar `innerHTML` once branding "features" land, replaying the
fade — so on a cold cache the nav can flash twice. This is the vanishing nav, the blank
avatar and the empty name.

**B. The status pill is fetched live from Uptime Kuma on every navigation.** `auth.js`
`loadSystemStatus()` calls `/api/integrations/service-status`, which proxies to Uptime Kuma
with a 5 s timeout, on every page. Until it answers the pill says "LOADING…" — even though
the answer is almost always the one from three seconds ago. Nothing is cached.

**C. Four shell fetches per click.** `/api/branding` (always re-fetched even when cached),
`/auth/check-session`, `/api/integrations/service-status`, `/health` (for the version
label), plus the notifications unread-count. None of this information changes between
clicks; all of it is already known to the server at the moment it serves the page (the
page routes already look the session up in Redis to decide whether to redirect).

**D. Tailwind is compiled in the browser on every document.** The Play CDN is the single
largest cost per navigation and the reason unstyled flashes are even possible.

**E. Content arrives in network order with no reserved layout.** Loaders write `innerHTML`
the moment their fetch resolves. Placeholders are text or spinners that do not match the
final size, so the page moves as things land. The dashboard's Netdata block starts
`hidden` and un-hides when stats arrive, shoving the service tiles down. The 30 s polls
rebuild sections wholesale (`innerHTML`) even when nothing changed (only the streams
section compares first).

**F. Nothing is remembered between pages.** No page data is cached, nothing is
prefetched, and the shell re-verifies itself from scratch, so returning to a page ten
seconds later is indistinguishable from a cold load.

## 4. Where the code conflicts with the design contract

- "Nav: static HTML in the page (JS decorates, never constructs)" — violated everywhere
  (A above). Fixed by this work.
- "Cache the shell's data in `sessionStorage`" — code uses `localStorage` with a 5-minute
  TTL and still fetches every time. This design goes one step further than the contract
  (see §5): the server stamps the shell and its data into the document, so no client cache
  is needed for the shell at all. The contract's *goal* (instant, no per-click branding
  fetch, no name/theme flash) is met more robustly; the mechanism differs and is noted here.
- "Load the display font statically in every `<head>` with `preconnect`" — violated; the
  font link is injected at runtime. Fixed by this work.
- "Skeletons reserve the exact final layout; nothing un-hides or resizes" — violated on
  every page except `requests.html` (poster rows) and `wiki.html`. Fixed by this work.
- "Polling refreshes diff-update the DOM" — only the streams section does. Fixed by this
  work with a compare-before-write helper (not a virtual DOM).
- "Scroll-down hint: one shared component, render only when there is content below the
  fold" — six copy-pasted blocks that never check scrollability; `library.html` has none.
  Folded into the shared shell since every page's shell is being replaced anyway.
- Layout section: "top bar on desktop, bottom tab bar on mobile" — the site has a left
  sidebar with a mobile drawer, and the operator's stated reference (Radarr/Sonarr) is a
  sidebar. **This work keeps the sidebar.** Because the shell becomes a single partial,
  switching to a top bar later is a one-file change; that decision is left to Jordan.
- Premiere spec guardrail "no build step, no new dependencies" — superseded by Jordan's
  explicit approval (2026-09-12) of a precompiled Tailwind stylesheet. Node is a
  *development* dependency only; the built CSS is committed and the Docker image is unchanged.
- Colour hard rule (no Tailwind palette colours on text): the status pill and the stat
  tiles use `text-green-500`, `text-amber-400`, `text-blue-400`. Out of scope here (it is
  step 3 "The system" in the review's order of work); listed as deferred.

## 5. Approaches, ranked

### A — Server-stamped shell + precompiled CSS + cross-document view transitions (recommended)

The server already rewrites each page at serve time and already knows the session. Extend
that: render the sidebar/header/mobile bar *into the HTML* with the operator's branding and
the signed-in user's name, role, avatar and admin state, inline the theme variables, font
link and a JSON data block, and serve precompiled CSS. The document paints complete on
first byte; JS only wires menus, the drawer and polling. `@view-transition` makes the
identically-named shell parts persist visually across the full-document navigation and
crossfades only the content. Speculation Rules prerender the next page on hover.
Skeletons reserve final layout; a small arrival helper reveals sections top-down.

- Pros: zero shell fetches per click (4 → 0); no cache-staleness class of bugs (a rebrand
  or role change is live on the next page); works for cold caches, private windows and
  first visits; one source of truth for the nav (Python registry + one partial); every
  page's `<head>`/shell is generated, so the 13-file drift disappears; view transitions and
  prerender are pure progressive enhancement.
- Cons: `_serve_page` grows into a small page renderer (`app/pages.py`) — more Python,
  more to test; Firefox gets no cross-document transition (still gets the stationary
  static shell, just without the crossfade).

### B — Contract-literal: static shell markup in every file + `sessionStorage` cache

Bake identical shell markup into all 11 pages by hand; `theme-loader`/`auth.js` render
labels, avatar and admin items from a `sessionStorage` copy of `/api/branding` and
`/auth/check-session`, revalidating in the background. Same CSS/view-transition/skeleton
work as A.

- Pros: no backend change.
- Cons: eleven copies of the shell to keep in step (the exact failure mode two sessions
  already hit with `?v=` stamps); the first page of every tab still fetches and flashes
  (cold `sessionStorage`); a rebrand or admin change is stale until revalidation lands;
  labels/icons/feature flags still need JS to *construct* nav items, which the contract
  forbids. Strictly worse than A on the contract's own goals.

### C — Client-side router (fetch the next page and swap `<main>`)

A Turbo/htmx-style layer: intercept nav clicks, fetch the target HTML, swap the content
region, keep the shell DOM alive.

- Pros: the shell is literally the same DOM node; polling can carry across pages.
- Cons: every page's inline `<script>` assumes a fresh document (globals, `DOMContentLoaded`,
  `setInterval`s, delegated listeners on `document`); making 16 k lines of page JS
  re-entrant and leak-free is a rewrite, not a fix. Browser-native cross-document view
  transitions give the same *visual* result without that risk. Rejected.

**Recommendation: A.** It is the only option that removes the per-click work instead of
hiding it, and it lands the contract's "JS decorates, never constructs" rule literally.

## 6. Design (approach A)

### 6.1 Server: `app/pages.py`

`render_page(name, request, user) -> HTMLResponse` replaces `_serve_page` and is used by
every HTML route in `main.py` and by `/setup`.

1. Read `app/static/<name>.html` (every request — the dev instance bind-mounts `app/`).
2. Build branding with `build_branding(db, signed_in)` — the dict-building body of
   `GET /api/branding`, moved into `app/routers/branding.py` as a plain function so the API
   and the renderer cannot drift.
3. Inject into `<head>` (after `<title>`, alongside the existing OG tags):
   - `<style id="ws-theme">:root{--color-primary:R G B; …; --font-display:"Name",sans-serif}</style>`
     Hex values are validated (`^#[0-9a-fA-F]{6}$`), the font family is validated
     (`^[A-Za-z0-9 \-]{1,60}$`); anything else falls back to the shipped default.
   - `<link rel="preconnect" href="https://fonts.googleapis.com">`,
     `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`, and the
     display-font stylesheet `<link>` (URL-encoded family, attribute-escaped).
   - `<script id="ws-data" type="application/json">{"branding":…,"user":…,"version":…,"page":…}</script>`
     `json.dumps` output has every `<` replaced with `<`, so it can never close the
     script element. It is data, not code: CSP does not apply and nothing executes.
   - `<html>` gains `data-page="<name>"`, `data-admin` (admins only) and `data-netdata`
     (when `integration.netdata.url` is set), so static CSS can reserve or drop page
     regions without JS.
4. Replace `<!-- ws:sidebar -->` and `<!-- ws:header -->` markers in the page with the
   rendered partials from `app/static/partials/shell-sidebar.html` and
   `shell-header.html`. Substitution is a tiny `{{name}}` replacer with HTML escaping; no
   Jinja (not in `requirements.txt`, and adding dependencies is off-limits). Nav items come
   from a Python registry `NAV_ITEMS` (id, href, default label/sublabel/icon, feature flag,
   admin-only) — the one in `sidebar.js` today, moved. Labels, sublabels, icons, "New!"
   flags and per-item enabled switches apply from branding exactly as `sidebar.js` does
   now. Admin-only items are simply not emitted for non-admins. The active item is the
   page name. The version label is `settings.app_version`.
   User values: display name (fallback username), role label, avatar URL — escaped; the
   avatar is only emitted when it starts with `https://`, `http://` or `/`.
5. Stamp `?v=` markers with `<app_version>-<8 hex of the file's SHA-1>` (cached per path
   and mtime), so a dev edit or a release both invalidate exactly once. Pages that are not
   served through `render_page` (none) would keep the old behaviour.
6. Existing title/OG behaviour is unchanged.

`main.py`: `_require_session` returns the session dict (or `None`) so routes pass the user
in; `/settings` additionally redirects non-admins to `/` (the client check stays as a
belt). CSP loses `https://cdn.tailwindcss.com` from `script-src` and `style-src`.

### 6.2 Client: `app/static/js/shell.js` (replaces `sidebar.js` + `header.js`)

Self-initialises on `DOMContentLoaded`. Exposes one namespace, `window.WS`:

- `WS.data` — the parsed `#ws-data` block. `theme-loader.js` reads it synchronously in
  `<head>` and sets `window.WEBSERVARR_THEME` (kept — 7 files read it) before any body
  script runs; its `localStorage` cache and per-page `/api/branding` fetch are removed.
  Fallback: if the block is missing (a page served some other way), it fetches as before.
- `checkAuth(options)` (in `auth.js`, kept for its callers) resolves immediately from
  `WS.data.user`; the `/auth/check-session` fetch remains only as a fallback when no data
  block is present. Every page's init drops `initSidebar()`, `showAdminNav()`,
  `loadSystemStatus()`, `loadAppVersion()` and the copy-pasted header/menu wiring.
- Status pill: rendered from `sessionStorage['ws.status.<user>']` at init (any age, then
  revalidated); fetched via `WS.serviceStatus()` — a deduplicated promise the dashboard's
  tile loader also uses (one request instead of two). Unknown state: the pill is
  `visibility:hidden` with its space reserved. Never the word "Loading".
- Menus, drawer, logout (clears the `ws.*` sessionStorage keys first), notifications
  (`initNotifications()` is called by the shell; its discovery contract — bells with
  `title="Notifications"`, a `<header>` with `lg:flex` — is preserved in the partial).
- `WS.whenActive(fn)` — runs now, or on `prerenderingchange` when the document is being
  prerendered. `WS.poll(fn, ms)` — an interval that starts only when active, skips ticks
  while `document.hidden`, and runs once on `pageshow` from bfcache. All page
  `setInterval`s move to it; side-effect requests (`requests-embed`'s Seerr SSO POST) go
  behind `WS.whenActive`.
- `WS.arrive(key, write)` — arrival orchestration. Sections are declared in DOM order with
  `data-arrive="key"`. The first `arrive` for a key queues `write()` until every earlier
  key has arrived, then runs it and adds `.ws-in` (12 px fade-up, 200 ms ease-out, 60 ms
  stagger; reduced-motion: instant). A 1.2 s gate lifts the ordering so one slow
  integration cannot hold the page. Later calls for an already-arrived key run `write()`
  immediately with no animation (polls).
- `WS.setHTML(el, html)` — writes only when the string differs from the last write to that
  element. Used by every poller.
- `WS.swr(key, fetcher, render, maxAge)` — stale-while-revalidate for page data: calls
  `render(cached)` synchronously if a `sessionStorage` entry exists (namespaced by user),
  then fetches, stores, and calls `render(fresh)` if it differs. A revisit paints real
  content instantly instead of skeletons, in any browser.
- Scroll hint: markup lives in the sidebar partial; the shell shows it only when the
  page's scroll container overflows (checked on load, resize and content changes via
  `ResizeObserver`), fades at the bottom, mobile only, static arrow under reduced motion.
  Excluded pages (reader/login/setup) have no shell.

### 6.3 CSS

- `app/static/css/app.css` — Tailwind 3.4 CLI output, minified, committed. Config:
  `tailwind.config.js` at repo root with the one shared theme extension (the block that is
  copied into 10 files today), plugins `@tailwindcss/forms` and
  `@tailwindcss/container-queries` (the union of what the pages request), content globs
  `app/static/**/*.html`, `app/static/js/**/*.js`, `app/pages.py`. `package.json`
  (devDependencies only) + `npm run build:css` / `npm run watch:css`. `node_modules/`
  ignored. The first line of `app.css` is `/* ws-css:<hash> */`, where the hash covers every
  content file; a unit test recomputes it, so an HTML edit shipped without a rebuild fails
  the test instead of shipping unstyled markup.
- `theme.css` gains: view-transition rules (`@view-transition{navigation:auto}`, names on
  `#desktopSidebar`, `#appHeader`, `#mobileTopBar`, `#pageContent`; content crossfade
  180 ms ease-out; shell parts 0 ms; `prefers-reduced-motion` → `navigation:none`),
  the skeleton primitives (`.skel`, `.skel-line`, `.skel-num`, `.skel-tile`, `.skel-card`,
  `.skel-row`, shimmer via `--color-text` at 6 %→10 %, static under reduced motion), the
  `.ws-in` entrance, and the status-pill state classes.
- Every page: the CDN `<script>` + `tailwind.config` block becomes
  `<link rel="stylesheet" href="/static/css/app.css?v=1">`; the display font and
  preconnects come from the server.

### 6.4 Speculation rules

In the sidebar partial:

```json
{"prerender":[{"where":{"selector_matches":"#desktopNav a, #drawerNav a"},"eagerness":"moderate"}],
 "prefetch": [{"where":{"selector_matches":"#desktopNav a, #drawerNav a"},"eagerness":"moderate"}]}
```

Only the nav links qualify — never `/auth/*` (logout is a GET), `/reader`, `/kavita/*` or
API URLs. A prerendered page loads its data (so activation is instant) but starts no
timers and performs no side-effect requests until activated (`WS.whenActive`).

### 6.5 Per-page loading states (one language)

Skeletons that match the final layout replace every "Loading…" text and spinner:

| Page | Skeleton at first paint | Arrival order |
|---|---|---|
| index | 3 service tiles; gauge block reserved (only when `data-netdata`); 2 news cards; 1 stream card; 3 release rows; 3 request rows | services → news → streams → releases → requests |
| requests | stat numbers as `.skel-num`; poster rows (existing); status grid rows | stats → shelves → status |
| issues, tickets | `.skel-num` ×3/×4; 3 list rows | counts → list |
| calendar | static 7-day header + 35-cell grid at final cell height | month |
| news | 3 cards | page |
| wiki | existing skeletons, rendered immediately (no auth wait) | index/page |
| library | shelf row + grid skeletons | shelves → grid |
| settings | skeleton rows in the two "Loading…" lists | n/a |
| requests-embed | one full-height panel | iframe |

Nothing toggles `hidden` after load in a way that moves content; error states replace
content in place at the same size.

### 6.6 Security notes

All stamped strings are HTML-escaped; JSON is `<`-escaped; colours and font names are
validated with allow-list regexes; avatar/logo URLs are attribute-escaped and
scheme-checked; custom CSS keeps its current path (`theme-loader` sets it via
`textContent`, never markup). `sessionStorage` caches are namespaced by user and cleared on
logout. CSP is tightened, not loosened.

### 6.7 Testing

`app/tests/` (stdlib `unittest`, run inside the dev container:
`docker exec webservarr-dev python -m unittest discover -s /app/app/tests -t /app`):

- `test_pages.py` — shell insertion, active item, admin-only emission, escaping, JSON
  escaping, colour/font validation, asset hashing, title rewrite retained, marker-less
  pages untouched.
- `test_css_build.py` — hash guard; no CDN reference or inline `tailwind.config` remains;
  every page links `app.css`.
- `test_shell_contract.py` — no `sidebar-root`/`header-root`/`initSidebar`/`showAdminNav`
  leftovers; partial keeps `title="Notifications"` and the `lg:flex` header; every shell
  page carries both markers; no instance-specific strings.

Browser verification (Chrome DevTools MCP against the VPS dev instance): zero console
errors on every route, shell nodes provably identical between pages (same outerHTML for
the sidebar and header across navigations), layout-shift score from a performance trace,
and a before/after recording for Jordan.

### 6.8 Out of scope / deferred

- Top bar + bottom tab bar layout (contract Layout section) — Jordan's call; one-file change later.
- Promoting status colours to theme-engine tokens; other colour-budget work.
- Making Netdata gauges admin-only (product change).
- Node-level DOM diffing for polls (compare-before-write is enough for the flicker).
- Firefox cross-document view transitions (browser support).
