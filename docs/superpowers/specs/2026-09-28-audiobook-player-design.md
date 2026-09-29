# Audiobook player and position engine: design

Sub-project 2 of WebServarr v2.0.0. Status: design approved in conversation 2026-09-28, spec
awaiting review. Builds on sub-project 1 (soft navigation): the shell, `#wsPlayer` and the router
survive navigation, so audio started anywhere keeps playing everywhere.

## 1. Goal

A listener signed in with a Plex identity can play audiobooks from the operator's Plex server in
the browser, keep listening while moving around the site, and never lose their place. Position
tracking is the top priority: frequent saves, a visible warning when saves stop landing, and a
resume that always picks the newest known position.

## 2. Decisions this spec carries

- Audio comes from the Plex library the operator selects as the audiobook library.
- The browser streams straight from Plex's own HTTPS address (the server's advertised
  `plex.direct` connection), never through WebServarr or a CDN proxy. It prefers the local
  connection when reachable, else the remote one.
- WebServarr holds the master position and a check-in log per listener and book, and writes every
  save through to Plex (`/:/timeline`), so Plex's own apps stay in sync and Plex reports the
  session as playing.
- Saves happen every 10 s while playing and immediately on pause, skip, seek, chapter jump,
  page leave and before any full navigation. If no save has succeeded for 30 s while playing, a
  warning shows the last saved time and saving keeps retrying.
- Resume uses the newest of three copies: WebServarr's, Plex's and a browser-local copy.
- Layout: a mini bar pinned to the bottom of every shell page that expands into a full-screen
  player.
- Only sessions with a Plex identity can play. Local accounts cannot: they have no Plex access.

## 3. Scope

In:

- A. The four router edge cases parked from sub-project 1 (N1-N4, section 10).
- B. Server: the audiobook library setting, the position store, the check-in log, the per-listener
  player preferences, the Plex bridge (per-listener server token, connection URIs, book
  structure, chapters, timeline write-through), and the CSP `media-src` allowance.
- C. The playback engine in `#wsPlayer`: part sequencing, chapter maths, the save loop, the
  local copy, resume merging, the warning state, Media Session, and saving before hard
  navigations.
- D. The mini bar and the full-screen player.
- E. Features: per-listener skip length, speed, sleep timer, smart rewind, time left at the current
  speed, undo big jumps, keyboard shortcuts, listening history with jump-back, a device handoff
  prompt, and a next-in-series offer.
- F. A hidden, admin-only test launcher that lists the library's books and starts one.

Out:

- The Books page and its combined ebook and audiobook library (sub-project 3). The launcher in F
  is a test tool only and is not linked from the navigation.
- Offline downloads, bookmarks, per-book speed, stats and ratings (sub-project 3 or later).

## 4. How a book maps to Plex

The audiobook library is a Plex music-type library organised as artist (author), then album
(series and narration), then disc (book), then tracks (files).

- **Book key:** the album `ratingKey` plus the disc number (`parentIndex`). A standalone book is
  one album with one disc.
- **Single-file book** (one track, e.g. `.m4b`): chapters come from
  `/library/metadata/<track>?includeChapters=1` as start and end offsets. Untitled chapters are
  shown as "Chapter N of M".
- **Multi-part book** (several tracks on one disc, e.g. `.mp3` parts): each part is a chapter
  ("Part N of M"), and playback advances to the next part automatically.
- **Book position:** `(book key, track ratingKey, offset ms)`. Book-level progress is computed as
  finished-track durations plus the current offset, over the total duration.
- **Streaming:** the track's Part key (`/library/parts/<id>/<ts>/file.<ext>`) supports HTTP Range,
  so seeking works.

## 5. Server

### 5.1 Settings

- `integration.plex.audiobook_library`: the Plex library section key. Empty means the player is
  off. It is admin-editable in Settings and registered with the other Plex settings. Its default
  is empty in both default tables.

### 5.2 Data (new tables, created by the project's migration style)

- `listening_positions`: identity, book key, track key, offset ms, duration ms, updated at,
  device label, and the source of the last write (web, plex, local). One row per identity and
  book.
- `listening_log`: identity, book key, track key, offset ms, device label, event (play, pause,
  checkin, seek, jump, leave, end), at. Rows are pruned after 180 days.
- `player_prefs`: identity, skip seconds (default 10), speed (default 1.0), smart rewind on.

All rows are keyed by the account identity from the ticket-ownership work (`plex:<id>`), never by
username.

### 5.3 API (all require a Plex-identity session; rate-limited; errors 4xx or 503)

- `GET /api/player/books`: the library's books (key, title, author, series, narrator, cover,
  duration, shape), used by the launcher.
- `GET /api/player/book/{key}`: the book's tracks, chapters, cover, and this listener's stream
  info: the connection URIs and the listener's own server access token.
- `GET /api/player/position/{key}`: WebServarr's position, plus Plex's per-track state converted
  to a book position, each with its timestamp.
- `POST /api/player/checkin`: `{book, track, offset, duration, event, device, psid, seq}`. It
  stores the position, appends to the log and forwards to Plex's `/:/timeline` with the
  listener's server token. It returns the stored timestamp.
  - `psid` is a random id per page session and `seq` increases within it. An older `seq` from
    the same `psid` never overwrites a newer stored position.
  - Across different page sessions or devices, the most recently received check-in wins. The
    handoff prompt (section 8) makes that choice visible to the listener.
  - `device` is a short label derived from the user agent (e.g. "Chrome on Android").
- `GET /api/player/history/{key}`: the log for this listener and book, newest first.
- `GET/PUT /api/player/prefs`: skip, speed and smart rewind.

The listener's server access token comes from plex.tv resources for the configured server
(matched by machine identifier), fetched with the listener's own Plex token. It is cached in the
listener's session (Redis), never in a module-level cache. Timeline writes use it server-side, and
the stream URL carries it because `<audio>` cannot send headers. It is the listener's own token
for this one server, the same one the Plex web app uses.

### 5.4 Security

- The CSP gains `media-src 'self' https://*.plex.direct:32400`, and the image source for covers if
  they load direct. No other directive loosens.
- A listener can only read and write their own positions, log and prefs: every query filters by
  the session identity.
- The book key and track key are validated as belonging to the configured audiobook library
  before any Plex call.

## 6. Playback engine (client)

`app/static/js/player/engine.js`, an ES module loaded by the shell and mounted into `#wsPlayer`.
It is not a page module: it lives for the document, not a page visit.

- **Audio:** one `<audio>` element in `#wsPlayer`, with its `src` set to the current part's
  stream URL. At the end of a part it moves to the next part of the same book.
- **Connection choice:** try the local connection URI with a 1.5 s probe (a small `HEAD` Range
  request); on failure use the remote one. Remember the choice per page session.
- **Save loop:** every 10 s while playing, plus immediately on pause, skip, seek, chapter jump, a
  `ws:before-hard-nav` event, `pagehide` and `visibilitychange` to hidden. Hard exits use
  `sendBeacon`. Saves are serialised per book with an increasing `seq`, so a later save always
  wins.
- **Local copy:** every position change is written to `localStorage` per identity and book, with
  a timestamp.
- **Resume:** on opening a book, take the newest of WebServarr, Plex and the local copy. A local
  copy newer than the server's is sent as a check-in immediately.
- **Warning:** while playing, if the last successful save is over 30 s old, show "Your place isn't
  being saved. Last saved <time>." in the mini bar and the full player. It clears on the next
  success. Retries back off (10 s, 20 s, 30 s cap).
- **Media Session:** title, author, artwork, and play/pause, seek back and forward (using the skip
  setting), position state. There are no previous and next track actions, because chapters are
  not skip buttons.
- **The reader:** the player keeps running under the full-screen reader view, which already leaves
  `#wsPlayer` in place.

## 7. Player UI

- **Mini bar**, shown whenever a book is loaded: cover, title, chapter label, time left in the
  book, play/pause, and a thin progress line. Its height sets `--ws-player-h`, so no page
  content is covered. Tapping it opens the full player.
- **Full-screen player:** cover, title, author and narrator, a chapter scrubber with the current
  chapter's time and the book's time left at the current speed plus a "finishes around" clock
  time, skip back and forward, play/pause, speed, sleep timer, the chapter list, and history. It
  closes by swipe-down, a close button or Escape, and it is an overlay above page content and the
  top bar.
- It follows the theme engine (theme variables only), handles reduced motion, and is accessible
  (labels, focus trap while open, live region for the save warning).

## 8. Features

- **Skip:** back and forward by the listener's setting (5 to 60 s, default 10). There are no
  skip-chapter buttons.
- **Speed:** 0.75x to 2x in 0.05 steps, stored per listener.
- **Sleep timer:** 15, 30 or 60 minutes, or end of chapter. The volume fades over the last 10 s,
  then playback pauses and a save is sent.
- **Smart rewind:** on resume after a pause, go back by 0 s under 10 s away, 3 s under 1 min,
  10 s under 1 h, and 30 s after that. It is a per-listener toggle.
- **Undo big jumps:** any seek over 2 minutes shows "Jumped <delta>. Undo" for 8 s.
- **Keyboard** (desktop, not while typing in a field): space for play/pause, the arrows for skip,
  `[` and `]` for speed.
- **History:** the full player lists sessions from the log (start, end, chapters covered, device),
  and tapping one jumps back to where it ended.
- **Handoff:** when a book is opened and the newest position came from a different device in the
  last 24 h, ask "Continue from <time> (<device>, <ago>)?" with Continue and Start from here.
- **Next in series:** at the end of the last part, if the album's series has a next book, show
  "Up next: <title>" with a Play button. It never starts on its own.

## 9. Error handling

- **Plex unreachable (both connections):** the player shows "Can't reach the media server" with
  Retry, and the saved position is untouched.
- **A part 404s or fails to decode:** skip to the next part with a notice, and never save a
  position past a part that didn't play.
- **Check-in failures:** covered by the warning in section 6. There is never a silent loss.
- **Session expired:** the next check-in returns 401. Save to the local copy and follow the
  router's sign-in path, and the local copy resumes after sign-in.

## 10. Router items carried from sub-project 1

- **N1:** Settings' 0 ms `setHash` races the router's `history.go` undo. Order them, or make
  Settings use the router's history API.
- **N2:** `commit()` reads `navToken` after the transition. Capture the visit token before the
  transition and bind the scroll restore to it.
- **N3:** the entry counter drifts after a throwing `pushState`, iframe steps, or Settings tab
  pushes that don't update `current.i`. Make the counter authoritative from `history.state` on
  every popstate and pushState.
- **N4:** the progress bar stays up if `visit()` throws after `busyStart`. Always clear it in a
  `finally`.

## 11. Testing and acceptance

- **Node runtime tests** (happy-dom, fake timers) on the engine: save cadence and the immediate
  triggers; `seq` ordering; resume merge across the three copies; warning timing and backoff;
  part advance; chapter labels for both shapes; smart rewind thresholds; the sleep timer and
  end-of-chapter; undo; beacon on a hard exit.
- **Python tests:** positions, log and prefs scoped by identity (no IDOR); `seq` ordering on the
  server; timeline forwarding with Plex stubbed; the library-membership check on keys; CSP
  `media-src`; the per-listener token fetch and session caching; 180-day pruning.
- **On the dev instance** with a real audiobook of each shape:
  - Play, navigate the whole site 50 rounds (the leak soak with real audio instead of the debug
    tone): zero interruptions and zero leaks.
  - Throttle and then drop the network: the warning appears within 30 s and clears on recovery.
  - Close the tab mid-play and reopen: resumes within 10 s of where it stopped.
  - The phone width layout and the mini bar never cover content.
- **Pre-release, by the operator on real devices:** lock-screen and headphone controls, Plexamp
  resuming where the browser stopped and the reverse, and the local-versus-remote connection
  switch when leaving home.

## 11a. Addendum (2026-09-29): formats the browser cannot decode

Found during the build: some audiobook editions use a codec that browsers cannot decode (for
example E-AC3 "Dolby Digital Plus + Atmos" in `.m4b`, which Chrome and Firefox cannot play and
Safari can).

Revised decision (operator, 2026-09-29, replacing the same day's "transcode on the fly"): the
player is direct play only. Live transcoding was built and then withdrawn: Chrome silently
reconnects a dropped transcode stream, Plex restarts it at its original offset, and the saved
place runs ahead of what the listener heard. No fix exists within the CSP in 5.4. Undecodable
files are converted in the library instead (an operator task outside the app).

- The book structure carries each track's container and codec. The engine asks the browser
  (`canPlayType`) before loading a track.
- A decodable track streams direct, exactly as in section 6.
- An undecodable track is not loaded. The listener sees "This book's audio format can't play in
  this browser", never "Can't reach the media server", and the saved place is untouched.

## 11b. Addendum (2026-09-29): cross-device writes are compare-and-swap

Found during the build: with "the most recently received check-in wins" across devices, a stale
page (a question left open, a phone asleep with the screen off, a retry after an outage, a
lock-screen Play) can post an old place over a newer one saved from another device. Client-side
re-checks cannot cover every entry point, so the server enforces it. This replaces the
cross-device sentence in 5.3.

- Every check-in carries `base`: the server timestamp this page last saw for the book (from the
  position read at open, or from its last acknowledged save).
- The server stores the check-in when no position exists yet, when the stored position came from
  the same device, or when the stored timestamp equals `base`. Otherwise it answers 409 with the
  stored place, device and timestamp, and stores nothing. Within one page session the `seq` rule
  in 5.3 is unchanged.
- On a 409 the player pauses, keeps its place in the local copy, and asks "Continue from <time>
  (<device>, <ago>)?": Continue moves to the stored place; "Keep listening here" sends again
  with the new `base`, a deliberate override. A refused beacon is dropped.
- The question at open (section 8) stays. Background re-checks are not needed.

## 12. How it is built

The same loop as sub-project 1: `ws-coder` implements each plan task on `dev`; one
`ws-bug-hunter` per changed file; proven bugs go back to the coder until a hunt comes back clean;
the orchestrator checks evidence and writes no code; a final whole-branch review closes the
sub-project.
