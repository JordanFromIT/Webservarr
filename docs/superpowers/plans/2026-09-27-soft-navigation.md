# Soft Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project rule on who writes code:** the orchestrating session writes no code and reviews no
> code. This plan therefore specifies behaviour, interfaces and tests precisely, and leaves the
> implementation to the `ws-coder` agent. Every task is followed by one `ws-bug-hunter` per
> changed file; proven bugs go back to `ws-coder` until a hunt comes back clean.

**Goal:** Moving between pages swaps only the page content, so the shell and a persistent player
slot survive navigation and audio can play site-wide.

**Architecture:** An ES-module router (`app/static/js/router.js`) intercepts qualifying link
clicks, fetches the server-rendered page, swaps `#wsPage`, and mounts that page's ES module
(`app/static/js/pages/<page>.js`) through a small context object whose `AbortSignal` tears
everything down on leave. Pages convert one at a time; an unconverted page is reached by a
normal full navigation.

**Tech Stack:** FastAPI (server render in `app/pages.py`), vanilla JS (ES modules for router and
pages, existing classic scripts for the shell), Tailwind CLI build, stdlib `unittest`, Node for
pure-function JS tests, Chrome DevTools MCP (Brave) against the dev instance.

**Spec:** `docs/superpowers/specs/2026-09-27-soft-navigation-design.md`

## Global Constraints

- Work on branch `dev` only. Never merge to `main`, never create or push a tag, never touch
  the production container. Push with `git push origin dev`.
- Commits authored as the repo's configured identity only. No `Co-Authored-By`, no
  Claude/Anthropic trailer, no session link.
- Nothing committed may contain the operator's instance name or hostnames (the
  `WEBSERVARR_FORBIDDEN_STRINGS` guard enforces this).
- After any edit under `app/static/` or to `app/pages.py`: `npm run build:css` and commit
  `app/static/css/app.css` (a test fails otherwise).
- No new Python dependencies. No new runtime JS dependencies. No framework.
- Text colours come from theme variables only (existing theme-engine rule).
- Login (`/login`) and setup (`/setup`) stay full-page documents and are never converted.
- No visual redesign and no AI-giveaway or security-audit fixes in this plan; markup changes only
  as far as the contract needs.
- Python tests: `ssh webserver "docker exec -e WEBSERVARR_FORBIDDEN_STRINGS='<operator list>' webservarr-dev python -m unittest discover -s /app/app/tests -t /app -v"` (the `ws-coder` agent definition has the exact list).
- JS tests: `npm run test:js` locally (add each new `.mjs` to that script).
- Dev instance: after pushing, `ssh webserver "cd ~/webservarr-dev && git pull --ff-only"`;
  HTML/JS/CSS are live at once, Python changes need `docker restart webservarr-dev` (logs every
  dev user out).

## Review Focus

1. **Session expiry mid-navigation:** a soft navigation whose fetch is redirected to `/login` must
   do a full navigation to the login page, after dispatching `ws:before-hard-nav`, never paint the
   login page inside `#wsPage`. Test owner: Task 2 (`decide()` vectors) and Task 3 (browser check).
2. **Double click / rapid clicks:** clicking a second link while the first fetch is in flight must
   end on the second page with exactly one mounted module. Test owner: Task 2 (browser check in
   Task 3 soak includes interleaved navigations).
3. **Back after a soft navigation into a page that later fails:** popstate to an entry whose fetch
   now returns 500 keeps the current page and shows the Retry toast; the address bar must be put
   back to the current page's URL. Test owner: Task 2 `decide()` vectors plus Task 3 browser check.
4. **A page module that throws in `mount`:** the shell, header and player stay alive and usable;
   the page shows its error state; the next navigation works. Test owner: Task 3 (debug module
   `?ws-debug=throw` check).
5. **Admin-only page reached by a non-admin via history:** `/settings` redirects non-admins to `/`;
   a soft navigation there must end as a full navigation to `/` (redirect rule), never a blank
   page. Test owner: Task 5 browser check with the non-admin test session.

---

## Shared procedures (referenced by every task; repeated here so each task reads alone)

**Test sign-in on the dev instance (never production).** The DevTools browser starts with an
empty profile, so sign in by minting a session directly in the dev container's Redis:

```bash
ssh webserver "docker exec webservarr-dev python -c \"
import asyncio, json
from app.auth import session_manager
async def main():
    sid = session_manager.generate_session_id()
    await session_manager.create_session(sid, {
        'user_id': 'ws-test-admin', 'username': 'ws-test-admin', 'display_name': 'WS Test Admin',
        'email': '', 'is_admin': 'true', 'auth_method': 'simple', 'plex_token': '', 'avatar_url': '', 'id_token': ''})
    print(sid)
asyncio.run(main())\""
```

Use `'is_admin': 'false'` and user `ws-test-user` for the non-admin session. In the browser, open
the dev instance's `/login`, run `document.cookie = "webservarr_session=<sid>; path=/; secure"`
with `evaluate_script`, then navigate to `/`. If `create_session` rejects these fields, read
`app/auth.py:181` and adjust the dict; report what worked.

**Soak check (per converted page):** load the page with `?ws-debug=leaks`, then in the console run
`await WS.debug.soak(['/<page>', '/<neighbour1>', '/<neighbour2>'], 50)`. It returns
`{ navigations, leaks: [...], heapDelta, listenerDelta, requestsAfterLeave }`. Pass mark:
`leaks.length === 0`, `requestsAfterLeave === 0`, `listenerDelta === 0`, `heapDelta` reported
(a steady climb across two consecutive soaks is a fail), and the debug audio element
(`?ws-debug=leaks` puts a 440 Hz test tone in `#wsPlayer`) reports `interruptions === 0`.

**Per-page browser checks (every conversion task):**
- Zero console errors on: cold load, soft navigation in, soft navigation out, back, forward,
  reload.
- Deep link and reload land on the same page and state.
- `WS.debug.shellIdentity()` returns `true` after navigating (sidebar, header, mobile bar and
  `#wsPlayer` are the same DOM nodes as before).
- Keyboard: after a soft navigation focus is on the page `h1` and the live region text equals the
  new `document.title`.
- An unconverted page linked from this page still opens by full navigation and works.
- Soak check passes.

---

### Task 1: Server side: page wrapper stamping, page styles, player slot

**Files:**
- Modify: `app/pages.py` (`_ASSET_VERSION_RE` near line 579, `_inject_head`, `render_html` near line 647)
- Modify: `app/static/partials/shell-sidebar.html` (add `#wsPlayer` and the live region)
- Modify: `app/static/css/theme.css` (player slot layout, `--ws-player-h`, `data-shell="hidden"`)
- Create: `app/tests/test_soft_nav.py`
- Modify: `app/tests/test_pages.py`

**Interfaces:**
- Produces: `data-ws-module="/static/js/pages/<page>.js?v=<stamp>"` attributes get the same
  `?v=` content-hash stamping as `src`/`href`.
- Produces: every `<style>` element inside `<head>` of a page that has a `#wsPage` wrapper is
  rendered with `data-ws-page-style`; shared styles (`#ws-theme`, custom CSS block, `app.css`,
  `theme.css`, font links) are not tagged.
- Produces: exactly one `<div id="wsPlayer" hidden></div>` and one
  `<div id="wsLive" class="sr-only" aria-live="polite"></div>` on every shell page, outside
  `<main>`.
- Produces: CSS: `#wsPlayer` fixed to the bottom above the mobile bar; `html` custom property
  `--ws-player-h` (default `0px`); each page scroll container pads its bottom by
  `var(--ws-player-h)`; `html[data-shell="hidden"]` hides sidebar, header and mobile bar but not
  `#wsPlayer`.

- [ ] **Step 1: Write the failing tests** in `app/tests/test_pages.py`:
  - `test_ws_module_attribute_is_stamped`: render a page string containing
    `<div id="wsPage" data-ws-module="/static/js/pages/news.js?v=1">` and assert the output
    contains `data-ws-module="/static/js/pages/news.js?v=` followed by the same stamp format
    `asset_stamp()` returns (version, dash, 8 hex).
  - `test_page_styles_are_tagged_only_on_wrapped_pages`: a page with `#wsPage` and a head
    `<style>.x{}</style>` renders `<style data-ws-page-style>`; the injected `<style id="ws-theme">`
    is not tagged; a page without `#wsPage` has no `data-ws-page-style` anywhere.
  - `test_player_slot_and_live_region_once`: render every name in `SHELL_PAGES` (from
    `test_shell_contract.py`) through `render_html` and assert `id="wsPlayer"` and `id="wsLive"`
    each occur exactly once and appear after the closing `</main>`.
  And create `app/tests/test_soft_nav.py` with a `CONVERTED = []` list and these tests (they
  pass trivially while the list is empty; each page task appends its page):
  - `test_converted_pages_have_module_wrapper`: exactly one `id="wsPage"` with
    `data-ws-module="/static/js/pages/<name>.js?v=1"`, and the module file exists.
  - `test_converted_pages_have_no_inline_script`: no `<script>` without `src` except
    `type="application/json"` and `type="speculationrules"`.
  - `test_converted_pages_have_no_inline_handlers`: no `on[a-z]+=` attribute in the HTML, and none
    inside string literals in the page module (scan the module source for `on[a-z]+=\\?["']`).
  - `test_modules_follow_the_contract`: using `js_code_only()` from `test_shell_contract.py`, the
    module has no `setInterval(`, no `DOMContentLoaded`, no `window.onload`, exports `mount`, and
    every `addEventListener(` call's argument text contains `signal`.
  - `test_page_helpers_are_declared`: every `<script src="/static/js/...">` inside the page other
    than the shell set (`theme-loader.js`, `auth.js`, `shell.js`, `ui.js`, `notifications.js`,
    `router.js`) carries `data-ws-page-script`.
- [ ] **Step 2: Run the tests** (Python test command in Global Constraints). Expected: the three
  `test_pages.py` tests FAIL; `test_soft_nav.py` passes (empty list).
- [ ] **Step 3: Implement** the stamping regex extension, the head-style tagging (only when the
  page contains `id="wsPage"`), the two shell elements in `shell-sidebar.html` (placed so they
  render after `</main>`; if the partial's position makes that impossible, add them through
  `render_html` just before `</body>` and say so), and the CSS.
- [ ] **Step 4: `npm run build:css`**, run the Python tests. Expected: all pass, including every
  pre-existing test.
- [ ] **Step 5: Dev check:** push, pull on dev, open any shell page signed in (test sign-in
  procedure): `#wsPlayer` exists, is hidden, takes no space, no layout shift, no console errors.
- [ ] **Step 6: Commit** `feat(shell): page wrapper stamping, page-scoped styles, persistent player slot` and push `dev`.

---

### Task 2: Router core

**Files:**
- Create: `app/static/js/router.js` (ES module)
- Modify: `app/static/partials/shell-sidebar.html` (load `<script type="module" src="/static/js/router.js?v=1"></script>`)
- Modify: `app/static/js/shell.js` (expose `WS.router` after the module registers; sign-out path dispatches `ws:before-hard-nav` via the router)
- Create: `app/tests/js/router.mjs`, `app/tests/router_vectors.json`
- Modify: `package.json` (`test:js` runs `router.mjs`)

**Interfaces:**
- Produces (pure, importable by Node, no DOM access at import time):
  - `export function qualifies(href, baseHref, attrs)` returns boolean.
    `attrs = { target, download, hard, button, meta, ctrl, shift, alt }`. True only when every
    rule in spec 5.1 holds. Excluded path prefixes: `/auth/`, `/api/`, `/kavita/`, `/static/`,
    `/uploads/`; excluded exact paths: `/login`, `/setup`; same-page hash links excluded.
  - `export function decide(requestedUrl, response)` where
    `response = { ok, status, finalUrl, redirected, contentType, hasModule }` returns one of
    `{ action: 'swap' }`, `{ action: 'hard', url }` (redirect to another path, non-HTML,
    unconverted page), `{ action: 'stay', reason: 'network'|'server' }` (network error is
    represented by `response === null`; 5xx gives `'server'`).
- Produces (browser):
  - `WS.router.navigate(url, { replace = false } = {})` returns a Promise resolving when mounted.
  - `WS.router.current` = `{ url, module, controller }`.
  - Event `ws:before-hard-nav` on `window`, `detail: { url }`; the router awaits
    `Promise.allSettled` of handler-returned promises collected via `event.detail.waitUntil(p)`,
    capped at 500 ms.
  - Event `ws:page-mounted` on `window`, `detail: { url, page }` after each mount.
  - Page context passed to `mount(ctx)`:
    `{ root, signal, url, data, poll(fn, ms), setTimeout(fn, ms), onNavigate(handler) }`.
    `ctx.poll` wraps `WS.poll` and calls its returned `stop` on abort. `ctx.setTimeout` clears on
    abort. `onNavigate(handler)`: `handler(url)` returns `true` to claim an in-page URL.
- Consumes: Task 1's `#wsPage[data-ws-module]`, `data-ws-page-style`, `data-ws-page-script`,
  `#wsLive`.

Behaviour (spec section 5, all of it): click interception on `document` for `a[href]`; swap order
exactly as spec 5.2 steps 1 to 10; one swap at a time with the newest click winning (abort the
previous fetch with its own `AbortController`); `popstate` for router-created entries;
`history.state = { ws: 1, scrollY }`; scroll save with `replaceState` before leaving; first load
mounts the page's module and `replaceState`s the initial entry; page-helper scripts
(`data-ws-page-script`) are loaded once each, keyed by path without query, awaited before
`mount`; hover/focus/touchstart prefetch held 30 s, single use; `startViewTransition` when
available and `prefers-reduced-motion` is not `reduce`; failure handling per spec 5.5 including
restoring the address bar when a popstate navigation stays; `ws:before-hard-nav` before every
router-started full navigation and before sign-out.

- [ ] **Step 1: Write the failing Node test** `app/tests/js/router.mjs` importing `qualifies`
  and `decide` from `../../static/js/router.js` and asserting every case in
  `app/tests/router_vectors.json`. Vectors must include at least: same-origin `/news` (true),
  `/wiki/getting-started` (true), `/reader?id=5` (true), `/auth/logout` (false),
  `/api/x` (false), `/kavita/x` (false), `/static/a.png` (false), `/uploads/a.png` (false),
  `/login` (false), `/setup` (false), `#top` on the same page (false), `/news#top` from `/`
  (true), other origin (false), `target=_blank` (false), `download` (false), `hard` (false),
  middle button (false), each modifier key (false). `decide` cases: 200 HTML with module (swap),
  200 HTML without module (hard to requested), redirected to `/login` (hard to `/login`),
  redirected to `/` from `/settings` (hard to `/`), `application/json` (hard), 500 (stay
  server), 503 (stay server), `null` (stay network), 404 HTML without module (hard).
- [ ] **Step 2: Run** `node app/tests/js/router.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `router.js`, the partial's module tag, and the `WS.router` exposure.
  With no page converted, every qualifying click ends in `decide()` returning `hard`, so the
  site behaves exactly as today.
- [ ] **Step 4: Run** `npm run test:js` and the Python tests. Expected: all pass.
- [ ] **Step 5: `npm run build:css`**, commit
  `feat(nav): router core; every page still loads in full until converted`, push `dev`.

---

### Task 3: Leak checker, soak, debug tone, and proving the fallback

**Files:**
- Create: `app/static/js/debug-leaks.js` (ES module, loaded by `router.js` only when the URL has
  `ws-debug=leaks` or `sessionStorage['ws.debug']` contains `leaks`)
- Create: `app/static/js/pages/_debug-throw.js` (a module whose `mount` throws; only reachable in
  debug mode)
- Modify: `app/static/js/router.js` (debug hooks)

**Interfaces:**
- Produces `WS.debug.leaks.start(pageName)` / `WS.debug.leaks.stop()` returning
  `[{ kind: 'listener'|'timer'|'interval'|'fetch', page, stack }]` for items created during that
  page's mount that are still alive after its signal aborted. Implemented by wrapping
  `EventTarget.prototype.addEventListener`, `setTimeout`, `setInterval`, and `fetch` only in
  debug mode.
- Produces `WS.debug.soak(urls, rounds)` returning
  `{ navigations, leaks, heapDelta, listenerDelta, requestsAfterLeave, interruptions }`.
  `heapDelta` uses `performance.memory.usedJSHeapSize` when present, else `null`.
  `requestsAfterLeave` counts `fetch` calls attributed to a page after it was left.
  The soak interleaves: every fifth round, it starts a navigation and immediately starts
  another, and asserts only the second page ends mounted.
- Produces `WS.debug.shellIdentity()` returning `true` when the four shell elements are the same
  nodes recorded at first load.
- Produces the throw check: when the URL or `sessionStorage['ws.debug']` contains `throw`, the
  router mounts `pages/_debug-throw.js` instead of the target page's module on the next soft
  navigation (once), so the error path can be exercised without breaking a real page.
- Produces the debug tone: in debug mode `#wsPlayer` is unhidden and holds an `<audio loop>`
  playing a generated 440 Hz WAV data URI; `interruptions` counts `pause`/`emptied`/`abort`
  events on it.
- Consumes: Task 2 `WS.router`, `ws:page-mounted`.

- [ ] **Step 1: Write the failing test** in `app/tests/test_soft_nav.py`:
  `test_debug_code_only_loads_in_debug_mode`: `router.js` imports `debug-leaks.js` only inside a
  branch guarded by the debug check (assert the import string appears only in a dynamic
  `import(` call, never a static `import ... from`), and no shell page references
  `debug-leaks.js` or `_debug-throw.js` directly.
- [ ] **Step 2: Run** the Python tests. Expected: FAIL.
- [ ] **Step 3: Implement** the debug module and hooks.
- [ ] **Step 4: Run** Python and JS tests. Expected: all pass.
- [ ] **Step 5: Browser proof of the fallback** (test sign-in procedure, admin session):
  - With no page converted, clicking every sidebar item performs a full navigation and each page
    works; zero console errors.
  - Expired session: delete the session key in dev Redis
    (`docker exec webservarr-dev python -c ...` using `session_manager.delete_session(sid)` or
    the equivalent method in `app/auth.py`), click a sidebar link: ends on `/login` by full
    navigation, and a `ws:before-hard-nav` listener added in the console fired first.
  - Record these results for the report.
  - Re-run the two checks below at Task 4 (the first converted page), since they need a soft
    navigation to exist, and report them there:
    - Review Focus 3: soft-navigate News to Home, set DevTools network to offline, press Back:
      the page stays on Home, the Retry toast shows, and `location.pathname` is back to `/`.
    - Review Focus 4: with `ws-debug=throw` set, soft-navigate to News: the error state shows in
      `#wsPage`, the sidebar, header and debug tone keep working, and the next navigation mounts
      normally.
- [ ] **Step 6: Commit** `feat(nav): leak checker and soak for page conversions (debug only)`, push `dev`.

---

### Task 4: Convert News

**Files:**
- Modify: `app/static/news.html` (wrap content below the header in
  `<div id="wsPage" data-ws-module="/static/js/pages/news.js?v=1">`; remove the inline
  `<script>`; mark `news-editor.js` with `data-ws-page-script`)
- Create: `app/static/js/pages/news.js`
- Modify: `app/static/js/news-editor.js` (only if it touches the DOM at load: it must only define
  functions at load and expose an init the module calls from `mount` with `ctx`)
- Modify: `app/tests/test_soft_nav.py` (`CONVERTED.append('news')`)

**Interfaces:**
- Consumes: Task 2 `mount(ctx)` contract, Task 3 debug tools.
- Produces: `export async function mount(ctx)` in `pages/news.js`.

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }` (including on `document`/`window`); every `fetch` passes
`signal: ctx.signal` and treats `AbortError` as silent; intervals via `ctx.poll`; one-off timers
via `ctx.setTimeout`; no inline `on*=` in HTML or in HTML strings built by JS (use delegated
listeners on `ctx.root` keyed by `data-action`); module-level state may cache data, never DOM
nodes; `mount` safe to run repeatedly; `DOMContentLoaded`/`window.onload` hooks become `mount`.
The page's head `<style>` stays in the head (Task 1 tags it).

- [ ] **Step 1: Add `'news'` to `CONVERTED`.** Run Python tests. Expected: the five
  `test_soft_nav.py` tests FAIL for news.
- [ ] **Step 2: Convert** the page and its helper to the contract.
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests. Expected: all pass.
- [ ] **Step 4: Browser checks:** all "Per-page browser checks" above for `/news`, soak with
  `['/news', '/', '/calendar']`, plus: open a news post and return; admin editor opens, saves and
  closes after a soft navigation in (admin session); the non-admin session sees no editor; and
  the two deferred Task 3 checks (Review Focus 3 and 4).
- [ ] **Step 5: Commit** `feat(nav): News is a soft-navigation page`, push `dev`.

---

### Task 5: Convert Settings

**Files:**
- Modify: `app/static/settings.html` (wrapper; remove its 4 inline `<script>` blocks; mark the 7
  `js/settings/*.js` helpers `data-ws-page-script`)
- Create: `app/static/js/pages/settings.js`
- Modify: `app/static/js/settings/general.js`, `pages.js`, `appearance.js`, `signin.js`,
  `integrations.js`, `kit.js`, `signin-rule.js` (each must only define functions at load and
  expose an init taking `ctx`, called from `pages/settings.js` `mount`)
- Modify: `app/tests/test_soft_nav.py` (`CONVERTED.append('settings')`)
- Modify: `app/tests/js/same_address.mjs` only if the extraction markers in `integrations.js`
  moved (it must still find `sameAddress`)

**Interfaces:**
- Consumes: Task 2 contract. Produces: `pages/settings.js` `mount(ctx)`.

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }`; every `fetch` passes `signal: ctx.signal`, `AbortError` silent;
intervals via `ctx.poll`; timers via `ctx.setTimeout`; no inline `on*=`; module state holds data,
never DOM nodes; `mount` re-runnable; no `DOMContentLoaded`/`window.onload`.
Settings-specific: an unsaved-changes guard, if one exists, must also run on soft navigation away
(listen for the router's navigation and cancel it with a confirm, or use `beforeunload` for hard
navigations only). Report which applies.

- [ ] **Step 1: Add `'settings'` to `CONVERTED`.** Run tests. Expected: FAIL for settings.
- [ ] **Step 2: Convert** the page and the seven helpers.
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests (`same_address.mjs` must pass).
- [ ] **Step 4: Browser checks:** all per-page checks for `/settings` (admin session), soak with
  `['/settings', '/', '/news']`; every settings tab opens and one setting per tab saves after a
  soft navigation in; Review Focus 5: with the non-admin session, `WS.router.navigate('/settings')`
  ends on `/` by full navigation with no blank page.
- [ ] **Step 5: Commit** `feat(nav): Settings is a soft-navigation page`, push `dev`.

---

### Task 6: Convert Calendar

**Files:**
- Modify: `app/static/calendar.html` (wrapper; remove inline `<script>`)
- Create: `app/static/js/pages/calendar.js`
- Modify: `app/tests/test_soft_nav.py` (`CONVERTED.append('calendar')`)

**Interfaces:** Consumes Task 2 contract. Produces `pages/calendar.js` `mount(ctx)`.

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }`; every `fetch` passes `signal: ctx.signal`, `AbortError` silent;
intervals via `ctx.poll`; timers via `ctx.setTimeout`; no inline `on*=`; module state holds data,
never DOM nodes; `mount` re-runnable; no `DOMContentLoaded`/`window.onload`.

- [ ] **Step 1: Add `'calendar'` to `CONVERTED`.** Run tests. Expected: FAIL for calendar.
- [ ] **Step 2: Convert.**
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests.
- [ ] **Step 4: Browser checks:** all per-page checks for `/calendar`, soak with
  `['/calendar', '/', '/news']`; month/week switching and date navigation work after a soft
  navigation in and after back/forward.
- [ ] **Step 5: Commit** `feat(nav): Calendar is a soft-navigation page`, push `dev`.

---

### Task 7: Convert Issues

**Files:**
- Modify: `app/static/issues.html` (wrapper; remove inline `<script>`; replace its 20 inline
  `on*=` handlers with `data-action` attributes; mark `wiki-hook.js` `data-ws-page-script`)
- Create: `app/static/js/pages/issues.js`
- Modify: `app/static/js/wiki-hook.js` (define-only at load; init called from `mount`)
- Modify: `app/tests/test_soft_nav.py` (`CONVERTED.append('issues')`)

**Interfaces:** Consumes Task 2 contract. Produces `pages/issues.js` `mount(ctx)`, and
`wiki-hook.js` exposes an init taking `ctx` (Task 8 uses the same init).

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }`; every `fetch` passes `signal: ctx.signal`, `AbortError` silent;
intervals via `ctx.poll`; timers via `ctx.setTimeout`; no inline `on*=` (HTML or JS-built
strings; delegated listeners on `ctx.root` keyed by `data-action`); module state holds data,
never DOM nodes; `mount` re-runnable; no `DOMContentLoaded`/`window.onload`.

- [ ] **Step 1: Add `'issues'` to `CONVERTED`.** Run tests. Expected: FAIL for issues.
- [ ] **Step 2: Convert** the page and `wiki-hook.js`.
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests.
- [ ] **Step 4: Browser checks:** all per-page checks for `/issues`, soak with
  `['/issues', '/', '/tickets']` (Tickets is still unconverted here, so it is also the
  full-navigation check); every former inline-handler control still works (list them in the
  report with pass/fail).
- [ ] **Step 5: Commit** `feat(nav): Issues is a soft-navigation page`, push `dev`.

---

### Task 8: Convert Tickets

**Files:**
- Modify: `app/static/tickets.html` (wrapper; remove inline `<script>`; replace its 20 inline
  `on*=` handlers with `data-action`; mark `wiki-hook.js` `data-ws-page-script`)
- Create: `app/static/js/pages/tickets.js`
- Modify: `app/tests/test_soft_nav.py` (`CONVERTED.append('tickets')`)
- Modify: `app/tests/test_tickets_page.py` if it asserts on markup the conversion moved (keep its
  intent; report every assertion changed)

**Interfaces:** Consumes Task 2 contract and Task 7's `wiki-hook.js` init. Produces
`pages/tickets.js` `mount(ctx)`.

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }`; every `fetch` passes `signal: ctx.signal`, `AbortError` silent;
intervals via `ctx.poll`; timers via `ctx.setTimeout`; no inline `on*=` (HTML or JS-built
strings); module state holds data, never DOM nodes; `mount` re-runnable; no
`DOMContentLoaded`/`window.onload`.

- [ ] **Step 1: Add `'tickets'` to `CONVERTED`.** Run tests. Expected: FAIL for tickets.
- [ ] **Step 2: Convert.**
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests.
- [ ] **Step 4: Browser checks:** all per-page checks for `/tickets`, soak with
  `['/tickets', '/issues', '/']`; create a ticket, reply, and change status after a soft
  navigation in (admin and non-admin sessions); every former inline-handler control works.
- [ ] **Step 5: Commit** `feat(nav): Tickets is a soft-navigation page`, push `dev`.

---

### Task 9: Convert Wiki

**Files:**
- Modify: `app/static/wiki.html` (wrapper; remove inline `<script>`; mark `wiki-categories.js`
  and `wiki-editor.js` `data-ws-page-script`)
- Create: `app/static/js/pages/wiki.js`
- Modify: `app/static/js/wiki-categories.js`, `app/static/js/wiki-editor.js` (define-only at
  load; init from `mount`)
- Modify: `app/tests/test_soft_nav.py` (`CONVERTED.append('wiki')`)

**Interfaces:** Consumes Task 2 contract including `ctx.onNavigate`. Produces
`pages/wiki.js` `mount(ctx)`.

The wiki's existing internal navigation (`history.pushState` at `wiki.html:240` and `:664`)
moves into the module: in-wiki link clicks go through the router; the module registers
`ctx.onNavigate(url => url.pathname === '/wiki' || url.pathname.startsWith('/wiki/') ? (renderArticle(url), true) : false)`
so the router records history without re-mounting. The module's own `pushState` calls are
removed (the router owns history). `popstate` between two wiki entries also goes to the handler.

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }`; every `fetch` passes `signal: ctx.signal`, `AbortError` silent;
intervals via `ctx.poll`; timers via `ctx.setTimeout`; no inline `on*=`; module state holds data,
never DOM nodes; `mount` re-runnable; no `DOMContentLoaded`/`window.onload`.

- [ ] **Step 1: Add `'wiki'` to `CONVERTED`**, and add
  `test_wiki_module_does_not_push_history`: `pages/wiki.js` code (via `js_code_only`) contains no
  `pushState(`. Run tests. Expected: FAIL.
- [ ] **Step 2: Convert** the page and helpers.
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests.
- [ ] **Step 4: Browser checks:** all per-page checks for `/wiki` and `/wiki/<slug>` (deep link
  and reload), soak with `['/wiki', '/wiki/<a real slug on dev>', '/', '/news']`; moving between
  three articles then Back three times walks the articles in reverse and a fourth Back leaves the
  wiki; the admin editor works after a soft navigation in.
- [ ] **Step 5: Commit** `feat(nav): Wiki is a soft-navigation page`, push `dev`.

---

### Task 10: Convert Home

**Files:**
- Modify: `app/static/index.html` (wrapper; remove its 2 inline `<script>` blocks; replace its 3
  inline handlers)
- Create: `app/static/js/pages/home.js`
- Modify: `app/tests/test_soft_nav.py` (`CONVERTED.append('index')`, module path
  `/static/js/pages/home.js`; make the test map page names to module names where they differ)
- Modify: `app/tests/test_pages.py` home-section tests if markup moved (keep intent; report
  changes)

**Interfaces:** Consumes Task 2 contract and `WS.serviceStatus()` (shared with the header pill;
it must stay one request). Produces `pages/home.js` `mount(ctx)`.

`html[data-home-hide]` is set by the server per page; the router's step 6 must copy it (and every
other server `data-*` flag on `<html>`) on each swap, and remove flags the new page lacks.
Verify that here.

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }`; every `fetch` passes `signal: ctx.signal`, `AbortError` silent;
intervals via `ctx.poll` (every gauge and status poll); timers via `ctx.setTimeout`; no inline
`on*=`; module state holds data, never DOM nodes; `mount` re-runnable; no
`DOMContentLoaded`/`window.onload`.

- [ ] **Step 1: Add `'index'` to `CONVERTED`.** Run tests. Expected: FAIL for index.
- [ ] **Step 2: Convert.**
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests.
- [ ] **Step 4: Browser checks:** all per-page checks for `/`, soak with
  `['/', '/news', '/calendar']`; after leaving Home, the network panel shows no gauge or status
  polling from Home (the header pill's own refresh is allowed); with a home section switched off
  in settings, `data-home-hide` is present on Home and absent after navigating to News.
- [ ] **Step 5: Commit** `feat(nav): Home is a soft-navigation page`, push `dev`.

---

### Task 11: Convert eBooks and the reader

**Files:**
- Modify: `app/static/library.html` (wrapper; remove its 2 inline `<script>` blocks; replace its
  2 inline handlers; mark `tour.js` and `kavita-connect.js` `data-ws-page-script`)
- Create: `app/static/js/pages/library.js`
- Modify: `app/static/reader.html` (add the shell markers so the server renders the shell; add
  `#wsPage` with `data-ws-module="/static/js/pages/reader.js?v=1"`; the server sets
  `data-shell="hidden"` on `<html>` for `name == "reader"`)
- Create: `app/static/js/pages/reader.js`
- Modify: `app/pages.py` (`data-shell="hidden"` for the reader), `app/static/js/tour.js`,
  `app/static/js/kavita-connect.js` (define-only at load; init from `mount`; the tour tears down
  on abort)
- Modify: `app/tests/test_shell_contract.py` (`reader` moves from `BARE_PAGES` to
  `SHELL_PAGES`), `app/tests/test_soft_nav.py` (`CONVERTED += ['library', 'reader']`)

**Interfaces:** Consumes Task 1 `data-shell="hidden"` CSS, Task 2 contract. Produces
`pages/library.js` and `pages/reader.js` `mount(ctx)`.

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }` (the reader's key and resize listeners included); every `fetch` passes
`signal: ctx.signal`, `AbortError` silent; intervals via `ctx.poll`; timers via `ctx.setTimeout`;
no inline `on*=`; module state holds data, never DOM nodes; `mount` re-runnable; no
`DOMContentLoaded`/`window.onload`. The reader saves reading progress to Kavita on leave through
its existing mechanism; confirm it still fires on soft navigation (it must run in the unmount
function, before the signal's fetches are aborted, or use its own non-aborted request).

- [ ] **Step 1: Update the contract lists.** Run tests. Expected: FAIL for library and reader.
- [ ] **Step 2: Convert** both pages and the helpers; add the `data-shell` flag.
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests.
- [ ] **Step 4: Browser checks:** all per-page checks for `/ebooks` and `/reader?...`, soak with
  `['/ebooks', '/', '/news']`; open a book from eBooks: shell hidden, `#wsPlayer` still the same
  node and the debug tone uninterrupted; turn pages, go Back to eBooks, reopen: Kavita shows the
  saved position; the eBooks guide (tour) starts and is gone after leaving.
- [ ] **Step 5: Commit** `feat(nav): eBooks and the reader are soft-navigation pages`, push `dev`.

---

### Task 12: Convert Requests

**Files:**
- Modify: `app/static/requests.html` (wrapper; remove its 2 inline `<script>` blocks; replace its
  16 inline handlers, including those in JS-built markup)
- Create: `app/static/js/pages/requests.js`
- Modify: `app/tests/test_soft_nav.py` (`CONVERTED.append('requests')`)
- Modify: `app/tests/test_request_modal_ids.py`, `app/tests/test_request_status_labels.py`,
  `app/tests/test_push_prompt_grant.py` if they read code from `requests.html` (point them at
  `pages/requests.js`; keep every assertion's intent; report changes)

**Interfaces:** Consumes Task 2 contract. Produces `pages/requests.js` `mount(ctx)`.

Requests has 13 timers/listeners on `document`/`window` and the Seerr-embed mode (an iframe). All
of them move under `ctx`. The embed's side-effect request (Seerr SSO POST) runs from `mount`.

Contract rules (spec 4.2), all mandatory: every `addEventListener` passes
`{ signal: ctx.signal }`; every `fetch` passes `signal: ctx.signal`, `AbortError` silent;
intervals via `ctx.poll`; timers via `ctx.setTimeout`; no inline `on*=` (HTML or JS-built
strings); module state holds data, never DOM nodes; `mount` re-runnable; no
`DOMContentLoaded`/`window.onload`.

- [ ] **Step 1: Add `'requests'` to `CONVERTED`.** Run tests. Expected: FAIL for requests.
- [ ] **Step 2: Convert.**
- [ ] **Step 3: `npm run build:css`**, run Python and JS tests.
- [ ] **Step 4: Browser checks:** all per-page checks for `/requests`, soak with
  `['/requests', '/', '/ebooks']`; search, discover shelves, the trending poster modal (movie,
  TV, book and audiobook requests send the right ids; do not actually submit more than one real
  request, and cancel it afterwards), Request Status section, and, if the dev instance has the
  Seerr embed configured, embed mode loads and leaving it removes the iframe.
- [ ] **Step 5: Commit** `feat(nav): Requests is a soft-navigation page`, push `dev`.

---

### Task 13: Finish: strict CSP and retiring the old navigation

**Files:**
- Modify: `app/main.py` (CSP `script-src 'self'`, near line 309)
- Modify: `app/static/css/theme.css` (remove `@view-transition { navigation: auto; }` and the
  `ws-sidebar`/`ws-header`/`ws-topbar`/`ws-content` names, near lines 452 to 470; keep any rules
  the router's same-document transition uses)
- Modify: `app/static/partials/shell-sidebar.html` (remove the speculation-rules block, lines 80
  to 91)
- Modify: `app/static/sw.js` (remove the page-prefetch cache and its message/fetch handling;
  keep push; the activate handler still deletes old `ws-pages-*` caches)
- Modify: `app/static/js/shell.js` (remove the service-worker hover prefetch near line 217 and
  `whenActive`'s prerender branch if nothing needs it; keep `WS.clearPageCache` as a harmless
  no-op if callers remain, or remove it with its callers)
- Modify: `app/tests/test_headers.py`, `app/tests/test_soft_nav.py`

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Write the failing tests:**
  - `test_headers.py::test_csp_script_src_is_self_only`: the CSP header's `script-src` directive
    is exactly `'self'`.
  - `test_soft_nav.py::test_no_inline_script_anywhere`: every file in `app/static/*.html`
    (including login and setup) has no `<script>` without `src` except
    `type="application/json"`, and no `on[a-z]+=` attribute; every `.js` under `app/static/js/`
    has no `on[a-z]+=` inside string literals.
  - `test_soft_nav.py::test_old_navigation_removed`: no `speculationrules` in any partial or page,
    no `@view-transition` in `theme.css`, no `ws-pages-` cache writes in `sw.js` (the activate
    cleanup may still name it).
- [ ] **Step 2: Run.** Expected: FAIL. If login or setup still carry inline scripts, move them to
  files (`/static/js/login.js`, `/static/js/setup.js`) in this task; they stay full-page documents.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npm run build:css`**, run Python and JS tests. Expected: all pass.
- [ ] **Step 5: Browser checks, whole site:** every page (including login and setup on a fresh
  session) loads with zero console errors and zero CSP violations; a full soak across all
  converted pages
  `WS.debug.soak(['/', '/requests', '/ebooks', '/news', '/wiki', '/calendar', '/issues', '/tickets', '/settings'], 50)`
  passes (admin session); sign-out from a soft-navigated page fires `ws:before-hard-nav` and lands
  on login; the service worker still delivers a push notification (send a test push from
  Settings).
- [ ] **Step 6: Commit** `feat(nav): strict script CSP; retire cross-document transitions, speculation rules and the page cache`, push `dev`.
