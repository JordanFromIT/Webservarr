# Audiobook Player Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project rule on who writes code:** the orchestrating session writes and reviews no code. This
> plan specifies behaviour, interfaces and tests; `ws-coder` implements; one `ws-bug-hunter` per
> changed file reviews each task; proven bugs go back to `ws-coder` until a hunt is clean.

**Goal:** Listeners with a Plex identity play audiobooks from the operator's Plex server in the
browser, site-wide, with a position engine that never loses their place.

**Architecture:** A server-side Plex bridge and player API (FastAPI) keep the master position and
a check-in log per identity and book, and write through to Plex. A document-lifetime ES-module
engine in `#wsPlayer` streams from Plex's own HTTPS connection, runs the save loop, and drives a
mini bar and a full-screen player.

**Tech Stack:** FastAPI, SQLAlchemy/SQLite, Redis sessions, httpx; vanilla JS ES modules; Node
tests with happy-dom (dev-only); stdlib unittest; Chrome DevTools MCP on the dev instance.

**Spec:** `docs/superpowers/specs/2026-09-28-audiobook-player-design.md`

## Global Constraints

- Branch `dev` only; never merge to `main`, never tag, never touch production.
- Commits authored by the repo identity only; no Claude/Anthropic trailer; nothing committed names
  the operator's instance (the `WEBSERVARR_FORBIDDEN_STRINGS` guard).
- Run each of these as its own Bash call in exactly this form, never chained:
  `git push origin dev`; `ssh webserver "cd ~/webservarr-dev && git pull --ff-only"`;
  the dev-container unittest command exactly as the `ws-coder` agent definition gives it (it
  carries the operator's forbidden-strings list);
  `ssh webserver docker restart webservarr-dev` (after Python changes; re-mint sessions after);
  session minting `ssh webserver "docker exec webservarr-dev python -c \"...\""`. If one is
  denied, stop and report BLOCKED with the exact command.
- Test sessions for the player need a Plex identity: mint with `auth_method: 'plex'`,
  `plex_account_id`, and a Plex token only if the operator provides one; otherwise stub Plex at the
  HTTP layer in tests and say so. Never invent or print real tokens.
- After any edit under `app/static/` or to `app/pages.py`: `npm run build:css` and commit
  `app/static/css/app.css`.
- Text colours from theme variables only; reduced motion respected; no inline script or handler
  (CSP `script-src 'self'`).
- Page code follows the sub-project 1 contract; the player engine is document-lifetime (not a page
  module) but its listeners and timers are owned and torn down by the engine itself.
- Everything keyed by account identity (`app/routers/tickets.py account_identity(user)`), never
  username. uvicorn runs 2 workers: no module-level caches; per-listener Plex data lives in the
  Redis session. API errors 4xx or 503 only. New routes rate-limited via `app.limiter`.
- Defaults for any new setting live in both `app/routers/branding.py DEFAULTS` and
  `app/seed.py DEFAULT_SETTINGS` when the registry requires it.
- JS tests: add each new `.mjs` to `npm run test:js` and to CI's js-checks job.

## Review Focus

1. **Home Wi-Fi to mobile data mid-listen:** the stream errors when the local connection vanishes;
   the engine must reconnect on the remote URI and continue at the same offset within a few
   seconds, without a save regressing. Owner: Task 5 (test `a network switch resumes on the other
   connection at the same offset`).
2. **Same book open on two devices or tabs:** check-ins interleave; the stored position is the most
   recently received, a psid never regresses itself, and the older device shows the handoff prompt
   next time it opens the book rather than silently overwriting. Owner: Task 4 (server) and Task 9
   (prompt).
3. **Phone screen off / background tab:** timers are throttled; saves must still happen while audio
   plays, driven by the audio element's `timeupdate`, not only `setInterval`; the 30 s warning must
   not fire just because the page is hidden. Owner: Task 6 (test `background throttling still
   saves from timeupdate and does not warn`).
4. **Long single-file book (17 h) and chapter boundaries:** seeking far works over Range; an offset
   exactly on a chapter start belongs to that chapter; the last chapter's end equals the duration.
   Owner: Task 5 (test `chapter lookup at exact boundaries`).
5. **Signed out mid-listen** (a deploy restarts Redis): the next check-in 401s; the local copy keeps
   the place; after sign-in the local copy, being newer, is sent and resumed. Owner: Task 6 (test
   `a 401 keeps the local copy and it wins after sign-in`).

---

### Task 1: Router items carried from sub-project 1 (N1-N4)

**Files:**
- Modify: `app/static/js/router.js`, `app/static/js/settings/kit.js`
- Test: `app/tests/js/router_runtime.mjs`

**Interfaces:** none new. Behaviour per spec section 10.

- [ ] **Step 1: Failing runtime tests** in `router_runtime.mjs`:
  - `N1 a Settings tab hash never lands on the previous entry during a held Back` (Settings dirty,
    Back held by the guard, Settings' 0 ms setHash fires: the previous entry's URL is unchanged).
  - `N2 a click during a Back crossfade does not get the old scroll` (pop to a page saved at 500,
    click another link before the transition finishes: the new page scrolls to 0).
  - `N3 the entry counter stays right after a throwing pushState, an iframe step and a Settings tab
    push` (then Back twice lands on the expected URLs).
  - `N4 the progress bar clears when visit() throws after it started`.
- [ ] **Step 2:** run `node app/tests/js/router_runtime.mjs`; expect those four to FAIL.
- [ ] **Step 3:** implement per spec section 10.
- [ ] **Step 4:** `npm run test:js` all pass; Python suite on dev green.
- [ ] **Step 5:** browser: Settings dirty + Back held + tab switch; Back through Settings tabs,
  wiki and plain pages; no console errors.
- [ ] **Step 6:** commit `fix(nav): settings tab hash, crossfade scroll, entry counter and progress bar edge cases`; push; pull on dev.

---

### Task 2: Data model, audiobook library setting, log pruning

**Files:**
- Modify: `app/models.py` (add `ListeningPosition`, `ListeningLog`, `PlayerPrefs`),
  `app/settings_registry.py` (add `integration.plex.audiobook_library`), `app/seed.py`
  and `app/routers/branding.py` (defaults if the registry requires both), `app/database.py` (only if
  new tables need registering), the Settings integrations tab (`app/static/js/settings/integrations.js`)
  for the new field, next to the Plex fields
- Create: `app/services/listening.py` (store helpers and pruning)
- Test: `app/tests/test_listening_store.py`

**Interfaces:**
- Produces (Python, `app/services/listening.py`):
  - `save_checkin(db, identity: str, book: str, track: str, offset_ms: int, duration_ms: int,
    event: str, device: str, psid: str, seq: int) -> dict` returns
    `{"stored": bool, "updated_at": iso8601}`; `stored` is False when `(psid, seq)` is older than
    the stored row's for the same psid. Always appends to the log unless `stored` is False.
  - `get_position(db, identity, book) -> dict | None` returns
    `{"track", "offset_ms", "duration_ms", "updated_at", "device", "source"}`.
  - `get_history(db, identity, book, limit=200) -> list[dict]` newest first.
  - `get_prefs(db, identity) -> dict` (`skip_s` 10, `speed` 1.0, `smart_rewind` True defaults);
    `put_prefs(db, identity, **fields) -> dict` validates skip 5..60, speed 0.75..2.0 in 0.05 steps.
  - `prune_log(db, now=None) -> int` deletes rows older than 180 days.
- Tables: `listening_positions (identity, book_key, track_key, offset_ms, duration_ms, updated_at,
  device, source, psid, seq)` unique `(identity, book_key)`; `listening_log (id, identity,
  book_key, track_key, offset_ms, device, event, at)` indexed `(identity, book_key, at)`;
  `player_prefs (identity pk, skip_s, speed, smart_rewind)`.
- Setting: `integration.plex.audiobook_library` text, empty default, admin-only, validated as a
  numeric Plex section key or empty; empty means the player is off.

- [ ] **Step 1: Failing tests** in `test_listening_store.py`: save then get; an older seq from the
  same psid is not stored and not logged; a different psid always stores (most recent received
  wins); identities are isolated; prefs defaults and validation (skip 4 and 61 rejected, speed
  2.05 rejected); prune removes 181-day rows and keeps 179-day rows; the setting validates and is
  admin-only in the settings API.
- [ ] **Step 2:** run them in the dev container; expect FAIL.
- [ ] **Step 3:** implement; prune runs at startup and at most once a day (a timestamp setting row,
  not a module cache).
- [ ] **Step 4:** full suite green; restart dev; tables exist; the Settings field saves.
- [ ] **Step 5:** commit `feat(player): listening store, player prefs and the audiobook library setting`; push; pull.

---

### Task 3: Plex bridge

**Files:**
- Create: `app/integrations/plex_player.py`
- Test: `app/tests/test_plex_player.py`

**Interfaces:**
- Consumes: `app/integrations/plex.py _get_config()` (admin url and token),
  `integration.plex.audiobook_library`.
- Produces (async):
  - `server_access(session: dict) -> dict` returns `{"token": str, "uris": {"local": [...],
    "remote": [...]}}` for the configured server (matched by machine identifier from the server's
    `/identity`), fetched with the listener's own Plex token from plex.tv resources, cached in the
    session under `player_server` for 6 h; raises `PlayerUnavailable` (maps to 503) on failure.
  - `list_books() -> list[dict]` with `key` ("<albumRatingKey>:<disc>"), `title`, `author`,
    `series`, `narrator`, `cover`, `duration_ms`, `shape` ("single" or "parts").
  - `book_detail(key: str) -> dict` with `tracks` ([{key, part_path, duration_ms, index}]),
    `chapters` ([{index, label, start_ms, end_ms, track}]), `cover`, `title`, `author`.
    Single-file books map Plex chapters to "Chapter N of M"; multi-part books map each track to
    "Part N of M".
  - `plex_position(session, key) -> dict | None` converts per-track `viewOffset`/`viewCount`/
    `lastViewedAt` (read with the listener's server token) to a book position with timestamp.
  - `timeline(session, track_key: str, state: str, time_ms: int, duration_ms: int) -> None`,
    best-effort (errors logged, never raised to the caller).
  - `assert_in_library(key: str) -> None` raises `NotInLibrary` (maps to 404) unless the album
    belongs to the configured section.

- [ ] **Step 1: Failing tests** with Plex stubbed at the httpx layer: server match by machine id;
  local and remote URIs split; session caching and 6 h expiry; a single-file book yields titled
  "Chapter N of M" chapters; a multi-part book yields "Part N of M"; `plex_position` picks the
  in-progress track and sums finished parts; `timeline` sends the documented params with the
  listener's server token and swallows errors; `assert_in_library` rejects a key from another
  section; plex.tv down raises `PlayerUnavailable`; no token is ever logged (assert on caplog).
- [ ] **Step 2:** run; FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** green; also a read-only live check on dev against the real server with the admin
  config (list_books count > 0, one book of each shape resolves chapters). Print no tokens.
- [ ] **Step 5:** commit `feat(player): Plex bridge for books, chapters, positions and timeline`; push; pull.

---

### Task 4: Player API and CSP media-src

**Files:**
- Create: `app/routers/player.py`
- Modify: `app/main.py` (include router at `/api/player`; CSP gains
  `media-src 'self' https://*.plex.direct:32400`)
- Test: `app/tests/test_player_api.py`, `app/tests/test_headers.py`

**Interfaces:**
- Consumes: Task 2 store, Task 3 bridge, `account_identity(user)`.
- Produces: the endpoints of spec section 5.3, JSON shapes:
  - `GET /api/player/books` -> `{"books": [...]}` (Task 3 shape).
  - `GET /api/player/book/{key}` -> `{...book_detail, "stream": {"token", "uris": {"local": [],
    "remote": []}}}`.
  - `GET /api/player/position/{key}` -> `{"web": pos|null, "plex": pos|null}`.
  - `POST /api/player/checkin` body `{book, track, offset_ms, duration_ms, event, device, psid, seq}`
    -> `{"stored": bool, "updated_at"}`; forwards to `timeline` after storing.
  - `GET /api/player/history/{key}` -> `{"entries": [...]}`.
  - `GET/PUT /api/player/prefs`.
  - All: 401 without a session; 403 for a session without a Plex identity (local accounts); 404 for
    keys outside the library; 503 when Plex is unavailable; player off (setting empty) -> 404 on
    every route. Rate limits: checkin 30/minute, others 60/minute.

- [ ] **Step 1: Failing tests:** each status code path; identity isolation (listener A never reads
  or writes B's position, history or prefs, including by changing `book`); a checkin stores and
  forwards; an older seq from the same psid returns `stored:false` and does not forward; the
  Review Focus 2 case (two psids interleaving: stored = most recently received; each psid never
  regresses itself); CSP header contains the exact `media-src` and nothing else loosened; checkin
  body validation (negative offset, offset > duration, unknown event rejected with 422).
- [ ] **Step 2:** run; FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** green; restart dev; `curl` the routes with a minted Plex-identity session.
- [ ] **Step 5:** commit `feat(player): player API with identity-scoped positions, history and prefs`; push; pull.

---

### Task 5: Playback engine core

**Files:**
- Create: `app/static/js/player/engine.js` (ES module, document-lifetime)
- Modify: `app/static/partials/shell-sidebar.html` (load the engine module after the router),
  `tailwind.config.js` content if needed
- Test: `app/tests/js/player_engine.mjs` (happy-dom, fake audio element and fake timers)

**Interfaces:**
- Consumes: Task 4 API, `#wsPlayer`, `WS.router` events.
- Produces `window.WS.player`:
  - `open(bookKey: string, opts?: {at?: {track, offset_ms}}) -> Promise<void>`
  - `play()`, `pause()`, `toggle()`, `seek(bookMs: number)`, `skip(deltaS: number)`,
    `jumpToChapter(index: number)`, `setSpeed(x: number)`
  - `state() -> {book, title, author, cover, chapters, chapterIndex, bookMs, bookDurationMs,
    playing, speed, connection: 'local'|'remote'|null, lastSavedAt, saveError: boolean}`
  - `on(event: 'change'|'ended'|'error'|'warning', fn) -> unsubscribe`
- Book time <-> (track, offset) mapping helpers exported for tests:
  `toTrackOffset(tracks, bookMs)`, `toBookMs(tracks, trackKey, offsetMs)`,
  `chapterAt(chapters, bookMs)`.

- [ ] **Step 1: Failing tests:** mapping helpers both ways at part boundaries; `chapterAt` at exact
  chapter starts and the final end (Review Focus 4); `open` probes local with a 1.5 s timeout then
  falls back to remote; a network error on the current connection switches to the other and
  resumes at the same offset (Review Focus 1); both connections failing emits `error` with
  "Can't reach the media server" and a retry, and never changes the saved position; a part that
  404s or fails to decode is skipped with a notice and no position past it is ever saved; end of a
  part advances to the next part at 0; end of the last part emits `ended`; `setSpeed` sets `playbackRate` and clamps; Media Session metadata and
  action handlers (play, pause, seekbackward, seekforward, seekto; no previoustrack/nexttrack).
- [ ] **Step 2:** run; FAIL.
- [ ] **Step 3:** implement; the stream URL is `<uri><part_path>?X-Plex-Token=<token>` built only
  in memory, never logged.
- [ ] **Step 4:** tests green; browser on dev: `WS.player.open(<a real key>)` from the console,
  audio plays across soft navigations (no UI yet), no console errors, no CSP violations.
- [ ] **Step 5:** commit `feat(player): playback engine with parts, chapters and connection fallback`; push; pull.

---

### Task 6: Save loop, local copy, resume, warning

**Files:**
- Create: `app/static/js/player/saves.js` (imported by the engine)
- Modify: `app/static/js/player/engine.js`
- Test: `app/tests/js/player_saves.mjs`

**Interfaces:**
- Consumes: Task 4 checkin/position API, Task 5 engine events.
- Produces: `createSaver({post, now, storage, identity}) -> {start(book), stop(), note(event),
  flush(kind: 'beacon'|'fetch'), lastSavedAt, onWarning(fn)}` used by the engine;
  `resolveResume({web, plex, local}) -> {source, track, offset_ms}` (newest by timestamp);
  `deviceLabel(userAgent) -> string` ("<Browser> on <OS>", e.g. "Chrome on Android"), sent as
  `device` on every check-in.

- [ ] **Step 1: Failing tests (fake timers):** a save every 10 s while playing; immediate saves on
  pause, skip, seek, chapter jump; `ws:before-hard-nav`, `pagehide` and hidden-visibility use the
  beacon; `seq` strictly increases and a psid is stable per page session; local copy written on
  every position change; `resolveResume` picks the newest of the three and sends a newer local copy
  immediately; warning after 30 s without success while playing, backoff 10/20/30 s, clears on the
  next success; Review Focus 3 (background: interval throttled, `timeupdate` still drives saves,
  no warning while hidden unless saves actually fail); Review Focus 5 (401: local copy kept, after
  sign-in the local copy wins and is posted).
- [ ] **Step 2:** run; FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests green; browser: play, throttle to offline, the warning appears within ~30 s
  and clears when back online; close the tab mid-play, reopen, resume within 10 s of the stop.
- [ ] **Step 5:** commit `feat(player): save loop, local copy, resume merge and the not-saved warning`; push; pull.

---

### Task 7: Mini bar and full-screen player

**Files:**
- Create: `app/static/js/player/ui.js`
- Modify: `app/static/css/theme.css` (player styles, theme variables only), shell partial if the
  markup lives there
- Test: `app/tests/js/player_ui.mjs`, `app/tests/test_soft_nav.py` (static contract: no inline
  handlers, theme vars)

**Interfaces:**
- Consumes: `WS.player` state and events.
- Produces: mini bar in `#wsPlayer` (cover, title, chapter label, time left, play/pause, progress
  line; its height sets `--ws-player-h`); full-screen overlay (cover, title, author and narrator,
  chapter scrubber, chapter time, book time left at speed, "finishes around" clock, skip, play,
  speed, sleep, chapters, history slots) opened by tapping the bar, closed by swipe-down, the close
  button or Escape; focus trap while open; the save warning rendered in both with a live region.

- [ ] **Step 1: Failing tests:** bar hidden until a book is open, then `--ws-player-h` matches its
  height; open and close paths including Escape and focus return; warning text and live region
  update; time left at 1.5x is two thirds of 1x; reduced motion disables the slide.
- [ ] **Step 2:** run; FAIL.
- [ ] **Step 3:** implement; `npm run build:css`.
- [ ] **Step 4:** browser at 1440 and 390 px on every page: nothing covered by the bar, the overlay
  above the top bar, soft navigation keeps the same bar node.
- [ ] **Step 5:** commit `feat(player): mini bar and full-screen player`; push; pull.

---

### Task 8: Listening features

**Files:**
- Create: `app/static/js/player/features.js`
- Modify: `app/static/js/player/engine.js`, `app/static/js/player/ui.js`
- Test: `app/tests/js/player_features.mjs`

**Interfaces:**
- Consumes: prefs API (Task 4), engine, UI.
- Produces: skip length setting (5-60 s) in the full player's menu; speed 0.75-2x in 0.05 steps;
  sleep timer 15/30/60 min and end of chapter with a 10 s fade then pause and save; smart rewind
  (under 10 s away 0 s, under 1 min 3 s, under 1 h 10 s, else 30 s; per-listener toggle); undo
  after any seek over 2 min ("Jumped <delta>. Undo", 8 s); keyboard (space, arrows by the skip
  length, `[` and `]` speed; ignored while typing in a field).

- [ ] **Step 1: Failing tests** for each rule above, including the smart rewind thresholds at their
  exact edges, sleep at end of chapter across a part boundary, keyboard ignored in inputs.
- [ ] **Step 2:** run; FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** green; browser spot-checks of each control.
- [ ] **Step 5:** commit `feat(player): skip, speed, sleep timer, smart rewind, undo and keyboard`; push; pull.

---

### Task 9: History, handoff, next in series

**Files:**
- Modify: `app/static/js/player/features.js`, `app/static/js/player/ui.js`,
  `app/integrations/plex_player.py` (series next lookup), `app/routers/player.py` (next-in-series
  endpoint `GET /api/player/next/{key}` -> `{"next": book|null}`)
- Test: `app/tests/js/player_features.mjs`, `app/tests/test_player_api.py`

**Interfaces:**
- Produces: history list grouped into sessions (start, end, chapters covered, device) with tap to
  jump back; handoff prompt when the newest position is from another device within 24 h
  ("Continue from <time> (<device>, <ago>)?" Continue / Start from here); at the end of the last
  part, "Up next: <title>" with Play, never auto-starting.

- [ ] **Step 1: Failing tests:** session grouping from log rows (a gap over 10 min splits
  sessions); jump-back seeks to the session end; handoff shown only for another device within
  24 h; next-in-series resolves the next book in the same series by index, none for standalone;
  no auto-start.
- [ ] **Step 2:** run; FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** green; browser: open the same book from a second minted "device" label and see the
  prompt.
- [ ] **Step 5:** commit `feat(player): listening history, device handoff and next in series`; push; pull.

---

### Task 10: Test launcher and whole-system verification

**Files:**
- Create: `app/static/player-test.html`, `app/static/js/pages/player-test.js` (a converted page
  module), route in `app/main.py` (admin-only, not linked from navigation)
- Test: `app/tests/test_player_api.py` (route gating), `app/tests/test_soft_nav.py` (contract)

**Interfaces:**
- Produces: an admin-only page listing `GET /api/player/books` with a Play button per book.

- [ ] **Step 1: Failing tests:** the route 404s for non-admins and when the player is off; the page
  follows the page contract.
- [ ] **Step 2:** run; FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** whole-system verification on dev with one real book of each shape:
  - start from the launcher, then a 50-round soak over all shell pages with real audio playing
    (`WS.debug.soak`, dwell 500, settle as needed): 0 interruptions, 0 leaks, 0 failures;
  - throttle then drop the network: warning within 30 s, clears on recovery, no lost position;
  - close the tab mid-play and reopen: resumes within 10 s;
  - phone width: nothing covered; the reader view keeps playing;
  - zero console errors and zero CSP violations.
- [ ] **Step 5:** commit `feat(player): admin test launcher`; push; pull.
