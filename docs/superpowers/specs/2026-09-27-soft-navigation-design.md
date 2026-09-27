# Soft navigation: design

Sub-project 1 of WebServarr v2.0.0. Status: design approved in conversation 2026-09-27, spec
awaiting review.

## 1. Goal

Moving between pages swaps only the page content. The sidebar, header, mobile bar and a new
player slot are never torn down, so audio started in one page keeps playing on every other page.
Sub-project 2 (the audiobook player) depends on this; nothing in this sub-project plays real
audio.

Secondary results, not goals in their own right:

- The "sidebar does not even blink" feel asked for in the 2026-09-12 navigation work becomes
  literal (same DOM node) instead of visual (view-transition snapshot).
- Every page script moves out of inline `<script>` into a file, so `script-src` can drop
  `'unsafe-inline'`.

## 2. Why this reverses the 2026-09-12 decision

`2026-09-12-navigation-load-feel-design.md` section 5 rejected a client-side router (option C)
because the page scripts assume a fresh document, and chose cross-document view transitions,
which give the same look with no rewrite. That reasoning still holds for looks. It does not hold
for audio: a cross-document navigation destroys the document, and with it any `<audio>` element,
no matter how smooth the transition looks. Site-wide playback is only possible if the document
survives navigation.

Everything that spec built stays and is reused: server-stamped shell, `#ws-data` block,
precompiled `app.css`, `WS.poll`, `WS.swr`, `WS.arrive`, `WS.setHTML`, `WS.serviceStatus`, the
status pill cache. The page scripts are about 8,000 inline lines across 13 files today (down from
the 16k counted then).

## 3. Scope

In:

- A router in `app/static/js/shell.js`.
- A page module contract, and every shell page converted to it: Home, News, Settings, Calendar,
  Issues, Tickets, Wiki, eBooks, Requests (including its Seerr-embed mode).
- The reader (`/reader`) converted to a full-screen view inside the same document.
- An empty, persistent player slot in the shell partial.
- A leak checker and a navigation test suite.
- CSP `script-src 'self'` once no inline script or inline event handler remains.

Out:

- Login (`/login`) and setup (`/setup`) stay ordinary full-page documents. Nobody is listening
  before sign-in.
- Any visual redesign, any AI-giveaway audit finding, any security audit finding. Those run
  after all v2.0 programming, per the v2.0 plan. A page's markup changes only as far as the
  contract needs (a content wrapper, inline handlers moved to listeners).
- The player itself (sub-project 2) and the Books page (sub-project 3).

## 4. Architecture

### 4.1 Document layout

The server keeps rendering every page in full, exactly as `render_html` does today. Each
converted page wraps everything below the header in one element:

```html
<main ...>
  <!-- ws:header -->
  <div id="wsPage" data-ws-module="/static/js/pages/news.js?v=..."> ...page content... </div>
</main>
<div id="wsPlayer" hidden></div>   <!-- in the sidebar partial, outside <main> -->
```

- `#wsPage` is the only region the router replaces.
- `data-ws-module` names the page's module. A page without it is unconverted.
- `#wsPlayer` lives in the shell partial, so every shell page has exactly one. It is fixed to the
  bottom of the viewport above the mobile bar. While `hidden` it takes no space. When shown it
  sets `--ws-player-h` on `<html>`, and the page scroll containers pad their bottom by that
  amount, so no content is ever covered.

### 4.2 Page module contract

```js
// app/static/js/pages/<page>.js
export async function mount(ctx) {
  // ctx.root    the #wsPage element just inserted
  // ctx.signal  AbortSignal, aborted when the page is left
  // ctx.poll(fn, ms)        WS.poll bound to ctx.signal
  // ctx.setTimeout(fn, ms)  a timeout cleared when the signal aborts
  // ctx.onNavigate(fn)      optional: claim in-page URLs (Wiki only, see section 6)
  // ctx.url     URL of this page (query and path params)
  // ctx.data    the parsed #ws-data block for this page
  // optional: return a function; it runs on leave, after the signal aborts
}
```

Rules every converted page follows:

1. Every `addEventListener` passes `{ signal: ctx.signal }`, including listeners on `document`
   and `window`.
2. Every `fetch` passes `signal: ctx.signal`. An aborted fetch is not an error and shows nothing.
3. Intervals go through `ctx.poll`. One-off timers go through `ctx.setTimeout` (cleared on
   abort). No raw `setInterval`.
4. No inline `on*=` attributes, in HTML or in HTML built by JS. Use delegated listeners on
   `ctx.root` keyed by `data-action`.
5. Module-level variables may hold data between visits (that is the point of `WS.swr`), never
   DOM nodes.
6. `mount` must be safe to run many times in one document: nothing it does may assume it is the
   first run.

`WS.arrive` ordering resets on each mount. The guided tour (`tour.js`) is started by the page
module if the page has one, and torn down on leave.

### 4.3 Shared scripts

`theme-loader.js`, `auth.js`, `shell.js`, `ui.js`, `notifications.js` and `tour.js` load once with
the shell and are never re-run. Page modules use them through `window.WS` and their existing
globals. Page-only helpers that exist today as separate files (`news-editor.js`,
`wiki-editor.js`, `wiki-categories.js`, `wiki-hook.js`, `kavita-connect.js`, the
`js/settings/*` modules) are imported by the page module; ES module caching makes the second
import free.

### 4.4 Page styles

Six of the converted pages (News, Issues, Wiki, eBooks, Requests, reader) carry page-specific
`<style>` blocks in `<head>`. The server tags those blocks
`data-ws-page-style`. On swap the router removes the old page's tagged blocks and inserts the new
page's. Shared styles (`app.css`, `theme.css`, `#ws-theme`, fonts) are never touched.

## 5. The router

### 5.1 Which clicks it takes

It handles a click on an `<a>` only when all of these hold; otherwise the browser does its normal
thing:

- primary button, no modifier keys, no `target`, no `download`, no `data-ws-hard`;
- same origin;
- the path is not under `/auth/`, `/api/`, `/kavita/`, `/static/`, `/uploads/`, and is not
  `/login` or `/setup`;
- it is not a same-page hash link.

`popstate` (back and forward) goes through the same swap for entries the router created.

### 5.2 The swap, in order

1. Look up a prefetched response for the URL (5.4), else `fetch(url, { credentials:
   'same-origin', headers: { 'X-WS-Nav': '1' } })`.
2. If the response ended somewhere other than the requested path (a redirect, for example an
   expired session sent to `/login`), or is not HTML, go to the final URL with a full navigation
   (5.6).
3. Parse with `DOMParser`. If the new document has no `#wsPage[data-ws-module]`, it is an
   unconverted page: full navigation to it (5.6).
4. `import()` the new module before touching the DOM, so a broken module never leaves a blank
   page. On import failure: full navigation.
5. Abort the old page's signal and run its cleanup function.
6. Inside `document.startViewTransition` where supported (reduced motion: none): replace
   `#wsPage`, swap tagged page styles, set `document.title`, `<html data-page>` and any other
   `data-*` flags the server put on `<html>`, replace `#ws-data` and refresh `WS.data`, and move
   the active nav highlight.
7. `history.pushState` (new navigation) or nothing (popstate). Each history entry stores its
   scroll position; before leaving, the current entry's scroll is saved with
   `history.replaceState`.
8. Scroll: new navigation goes to top; back and forward restore the saved position after mount.
9. Focus moves to the page's first `h1` (made focusable with `tabindex="-1"`), and a polite
   live region in the shell announces the new title.
10. `mount(ctx)` runs.

Only one swap runs at a time. A second click while one is in flight aborts the first fetch and
wins.

### 5.3 First load

A cold load (typed URL, reload, deep link) is served in full by the server as today; `shell.js`
reads `#wsPage[data-ws-module]` and mounts it. The router records the initial history entry with
`replaceState`.

### 5.4 Prefetch

Hovering, focusing or touching a qualifying link starts the fetch and keeps its promise for 30
seconds, single use. This replaces two current mechanisms, removed once every page is
converted: the sidebar's speculation-rules prerender (it would prerender documents the router
never shows) and the service worker's `ws-pages-*` page cache. The service worker's other
duties are unchanged.

### 5.5 Failure handling

- Network error or 5xx on the fetch: stay on the current page, show the standard error toast
  with a Retry action. Do not fall back to a full navigation, because that would kill audio for a
  transient fault.
- A module whose `mount` throws: log it, render the page's standard error state inside `#wsPage`,
  and keep the shell and player alive.

### 5.6 Full navigations

Every full navigation the router starts (redirects, unconverted pages, import failures), plus
sign-out, dispatches a `ws:before-hard-nav` event on `window` first and waits for its handlers,
with a 500 ms cap. Sub-project 2 hooks this to save the listening position. `pagehide` remains the
backstop for navigations the router does not start (typing a URL, closing the tab).

## 6. Conversion order

Each step is its own task in the plan, and each page is complete, including its tests, before the
next starts.

1. Router core, contract helpers (`ctx`), page-style tagging in `pages.py`, `#wsPlayer` slot,
   leak checker, navigation test harness. No page converted: every click is a full navigation,
   which proves the fallback.
2. News.
3. Settings (exercises imported page-only modules).
4. Calendar.
5. Issues.
6. Tickets.
7. Wiki. It already rewrites the address bar between wiki pages; its internal navigation keeps
   doing that. While the wiki module is mounted, the router offers any `/wiki` URL to the
   handler it registered with `ctx.onNavigate`; if the handler accepts, the router only records
   history and does not re-mount the page.
8. Home.
9. eBooks (`/ebooks`) and the reader (`/reader`) as a full-screen view: the shell is hidden with
   a `data-shell="hidden"` flag on `<html>`, `#wsPlayer` stays in the document.
10. Requests, including the Seerr-embed mode.
11. Finish: confirm no inline script and no inline handler remains anywhere in served HTML or
    JS-built markup, set `script-src 'self'`, remove `@view-transition { navigation: auto }`
    and the shell `view-transition-name`s, the speculation rules, and the service worker page
    cache.

## 7. Testing and acceptance

Automated, run on every task:

- Existing unit test suite passes.
- New server tests: page-style tagging, `data-ws-module` present on converted pages, CSP header
  value at the end state.
- Leak checker (debug mode only, enabled by `?ws-debug=leaks`): while a module mounts, the
  router tracks every listener, timer, interval and fetch it creates. After leave, any still
  alive is reported with the page name and a stack. Zero is the pass mark.

In a real browser on the dev instance (Chrome DevTools MCP), per converted page:

- 50 round trips between the page and its neighbours: the leak checker reports zero, JS heap and
  listener count return to baseline, and no network request is sent by a page after it is left.
- Zero console errors on cold load, soft navigation, back, forward and reload.
- Deep links and reload land on the same page and state (including `/wiki/<slug>` and
  `/reader?...`).
- The shell elements are the same DOM nodes before and after navigation (checked by identity).
- A test-only audio element in `#wsPlayer` (debug mode) plays uninterrupted across the 50 round
  trips.
- An unconverted page still loads by full navigation and works.
- Keyboard: focus lands on the page heading, and the live region announces the title.

At the end of the sub-project: every item above for every page, plus no `'unsafe-inline'` in
`script-src` and no CSP violations reported in the console on any page.

## 8. How it is built

All work is on `dev`. `dev` does not merge to `main` until all of v2.0.0 is complete. Fixes for
the released version branch from `main`, ship as v1.11.x, and are merged into `dev`.

Per task:

1. `ws-coder` implements the task, runs the tests, and verifies on the dev instance.
2. One `ws-bug-hunter` per changed file, in parallel, given the task's diff range. Each assumes
   the code is wrong.
3. Every proven bug goes back to `ws-coder`; the hunters re-run on the new diff. The task is done
   when a hunt comes back clean.
4. The orchestrating session reviews the final diff before the next task starts.

## 9. Risks

- **A page that almost follows the contract.** One missed listener keeps an old page alive in
  memory and doing work. The leak checker and the 50-round-trip test exist for this.
- **Code that reads `DOMContentLoaded` or `window.onload`.** Neither fires on a soft
  navigation. The conversion replaces every such hook with `mount`.
- **Third-party embeds** (the Seerr iframe) keep their own document; the swap removes the iframe
  like any other node. Nothing else needs to happen.
- **Browsers without `startViewTransition`**: the swap happens without animation.
