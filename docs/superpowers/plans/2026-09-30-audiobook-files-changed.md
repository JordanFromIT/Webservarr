# Audiobook files changed: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an audiobook's files are replaced or the book is re-added, the listener never
silently loses their place or history. A "Find your place" helper lets them pick the spot.

**Architecture:**
- The server records extra fields on every save and history row, all of which survive a file
  change:
  - book time;
  - length;
  - chapter name;
  - narrator;
  - a work key.
- It links a re-added album to the rows of its earlier copy, but only when that earlier album is
  gone.
- The engine turns a missing saved track into a held "files changed" state instead of falling
  back to 0.
- A new player module shows the helper, which offers two candidates, a preview, a nudge and a
  confirm. History gains book-time labels and "earlier copy" entries.
- PR3 re-reads the position before a stale Plex-app question is acted on.

**Tech stack:**
- FastAPI;
- SQLAlchemy/SQLite;
- vanilla ES modules;
- node + happy-dom runtime tests;
- stdlib unittest in the dev container.

**Spec:** `docs/superpowers/specs/2026-09-30-audiobook-files-changed-design.md`. It builds on
`docs/superpowers/specs/2026-09-28-audiobook-player-design.md`, including addenda 11a and 11b.

## Global Constraints

- Everything from the player plan still holds:
  - commits carry no co-author trailer and no instance names (hmserver, HMServer, HMS Dashboard);
  - never touch production;
  - use the exact whitelisted commands, never chained, and never redirect unittest output;
  - status codes are 4xx or 503 only;
  - no module-level caches (there are 2 workers);
  - theme variables only;
  - `script-src 'self'`, with only media-src allowing `https://*.plex.direct:*`.
- Never save on the listener's behalf while the helper is open. The old place stays stored
  untouched until the listener confirms a spot or starts over.
- The two candidates:
  - "Same time" is the same book time, clamped to this copy's length.
  - "Same point in the book" is the same percentage of this copy's length.
  - When they are within 5 s of each other, show only one.
- The preview plays 15 s from a candidate without saving.
- Link a re-added copy only when the old album is no longer in the library. Editions that exist
  side by side are never merged.
- PR3: re-read the position when a Plex-app question has been showing for more than 2 minutes.
  If the read fails, time out after 4 s and leave the question as it is.
- Every new query is scoped by identity. Lookups for linked copies are indexed on
  `(identity, work_key)`.
- Every guarantee already hunted clean must keep holding:
  - T5E1/E2/E3/E6;
  - T6S1/S7;
  - T6E1;
  - the T8 floor;
  - T9C3;
  - compare-and-swap/409 and T9R1-R8;
  - FR1-FR6.

  Record these in `repo-notes/WebServarr/v2-subproject-2-player/progress.md` (Dropbox) and in
  the dev workspace ledger.

## Review Focus

1. Rows saved before this change have no `book_ms`. The helper must still open, offering only
   history and "Start from the beginning", with no crash and no 0:00 save. (Task 3 test.)
2. The new copy may be much shorter than the old place, for example a 20 h old place against a
   10 h new copy. Both candidates must be clamped inside the new copy, and the percentage
   candidate must be sensible. (Task 3 test.)
3. A tab closed, killed or reloaded while the helper is open must send nothing, including no
   beacon and no final save. The old place stays, and the helper opens again next time.
   (Task 2 test.)
4. Two editions side by side, such as Jim Dale and the full cast, both in the library, must never
   link, even with the same work key. (Task 1 test.)
5. A candidate that falls in a part this browser can't decode is shown as unavailable. Preview and
   confirm are refused for it. (Task 3 test.)

---

### Task 1: Store, API and bridge fields

**Files:**
- Modify:
  - `app/models.py`: five nullable columns on `ListeningPosition` and `ListeningLog`, plus an
    index on `(identity, work_key)`;
  - `app/database.py`: the migration, in the project's style, with the bounded create_all
    retry kept;
  - `app/services/listening.py`;
  - `app/routers/player.py`;
  - `app/integrations/plex_player.py`.
- Test: `app/tests/test_listening_store.py`, `app/tests/test_player_api.py`,
  `app/tests/test_plex_player.py`

**Interfaces:**
- **Produces (Python):**
  - `plex_player.work_key(author: str, title: str) -> str`. Normalises (lowercase; strip
    punctuation; remove edition, format and narrator suffixes such as "(Full-Cast Edition)",
    "Unabridged" and " - <narrator>"), then returns a sha256 hex string cut to 32 characters.
    Reuse the title normaliser from next-in-series where it fits.
  - `plex_player.book_identity(key: str) -> dict`. Returns `{"work_key", "narrator",
    "duration_ms"}` from the album the check-in already reads. No module cache.
  - `listening.save_checkin(...)` gains keyword arguments `book_ms=None, chapter_label=None,
    book_duration_ms=None, work_key=None, narrator=None`. It stores them on the position row and
    the log row. `book_ms` is clamped to `[0, book_duration_ms]` when both are known.
  - `listening.find_linked(db, identity, work_key, exclude_key) -> row | None`. Returns the
    newest position row of that identity with that work key under another book key, or None.
  - `listening.get_history_page(...)` entries gain `book_ms, book_duration_ms, chapter_label,
    book_key`.
- **Produces (HTTP):**
  - The check-in body gains optional `book_ms` (an int from 0 to 10^9) and `chapter_label` (a
    string of at most 200 characters, UTF-8 encodable).
  - The `GET /api/player/position/{key}` web copy gains `book_ms, book_duration_ms,
    chapter_label, narrator`, plus `linked_from` when it came from `find_linked`.
    `find_linked` is used only when the listener has no row for `key` AND
    `assert_in_library(old_key)` raises NotInLibrary.
  - `GET /api/player/history/{key}` includes the linked copy's entries (same rule), each with
    `earlier_copy: true`.

- [ ] **Step 1: Write failing tests.** Cover:
  - The new columns round-trip through `save_checkin`, and log rows carry them.
  - Clamping: `book_ms` above the duration stores the duration.
  - Check-in validation: `book_ms` that is negative, above 10^9, a float or a string gives 422.
    A 201-character `chapter_label` gives 422. A lone surrogate gives 422.
  - `work_key`:
    - "Harry Porter and the Stone (Full-Cast Edition)" and "Harry Porter and the Stone -
      Narrator Name" give the same key for the same author.
    - Different authors give different keys.
    - Use made-up titles only. No titles from the owner's library.
  - `find_linked`:
    - With no own row for the new key and the old album gone (NotInLibrary), it returns the old
      row, and /position shows `linked_from`.
    - With the old album still in the library, it returns nothing, so side-by-side editions stay
      apart (Review Focus 4).
    - Another identity's rows are never returned.
    - An own row for the new key means no link.
  - History includes earlier-copy entries only under the same rule.
  - The migration adds the columns on an existing database with rows, and two workers start
    safely.
  - The index is used (EXPLAIN QUERY PLAN).
- [ ] **Step 2:** Run the tests and confirm they FAIL. Use the exact whitelisted unittest command
  in the dev container.
- [ ] **Step 3:** Implement.
  - The check-in derives `book_duration_ms`, `work_key` and `narrator` through `book_identity()`
    from the album it already reads in `assert_in_library`, with no extra Plex call where
    possible.
  - The compare-and-swap, seq and 2-minute rules are unchanged.
- [ ] **Step 4:** Run the tests and confirm they PASS, then run the full suite. Restart dev.
- [ ] **Step 5:** Commit `feat(player): saves record book time, length, chapter, narrator and
  work key; a re-added book finds its earlier copy`. Push, then pull on dev.

### Task 2: Saver and engine, the held "files changed" state

**Files:**
- Modify: `app/static/js/player/saves.js`, `app/static/js/player/engine.js`
- Test: `app/tests/js/player_saves.mjs`, `app/tests/js/player_engine.mjs`

**Interfaces:**
- **Consumes:** Task 1's HTTP fields.
- **Produces (JS):**
  - Every check-in and beacon body carries `book_ms` (the engine's book time for the saved place)
    and `chapter_label` (the current chapter's label).
  - `state().filesChanged` is `null`, or `{old: {track, offset_ms, book_ms, book_duration_ms,
    chapter_label, updated_at, source, linked_from}}`.
  - Event `warning` with kind `files-changed` fires when that state begins.
  - `WS.player.previewAt(bookMs)` plays 15 s from `bookMs` without saving, then pauses. A second
    call replaces the first.
  - `WS.player.confirmPlace(bookMs)` is an explicit move to `bookMs`. It ends `filesChanged`,
    releases the hold, saves, ends the floor, and CAS applies.
  - `WS.player.startOver()` equals `confirmPlace(0)`.
  - While `filesChanged` is set:
    - saves are held exactly like the conflict hold, so nothing is sent: no check-in, no beacon,
      no final save;
    - the local copy is not overwritten;
    - a lock-screen or Media Session Play only resumes a preview and never saves.
- **Replaces:** the `UnknownTrack` path's fallback to 0 with its "Couldn't find your saved place"
  notice. Instead, a web, local or Plex copy that names a track not in the book, or a web copy
  with `linked_from`, enters `filesChanged`, holding at book time 0 without saving.

- [ ] **Step 1: Write failing tests.** Cover:
  - The body fields on fetch, beacon and final saves.
  - A missing track on open enters `filesChanged`, with 0 check-ins and the local copy unchanged.
  - `linked_from` enters `filesChanged`.
  - `previewAt` plays about 15 s with 0 check-ins.
  - `confirmPlace` saves exactly once as an explicit move, and ends the floor.
  - `startOver` saves 0.
  - Review Focus 3: close, pagehide, a killed page and a reload while held send nothing. The next
    open enters `filesChanged` again.
  - Lock-screen Play while held sends nothing.
  - Every earlier guarantee's tests still pass unchanged, apart from the replaced `UnknownTrack`
    fallback tests, which are rewritten to the new rule.
- [ ] **Step 2:** Run the tests and confirm they FAIL: `npm run test:js`.
- [ ] **Step 3:** Implement, reusing the conflict-hold mechanism rather than a second hold.
- [ ] **Step 4:** Run the tests and confirm they PASS. Re-run the scratchpad probe regression sets
  (rr6, rr7, t6e, saves-hunt, t8rr3, rr8, rev2, rr9-rr14, rr-final, rr-fr1-fr3). The only
  allowed differences are intended ones, and you must list them.
- [ ] **Step 5:** Commit `feat(player): a missing saved track holds the old place for the listener
  to place, never falling back to 0`. Push, then pull.

### Task 3: The "Find your place" helper and history labels

**Files:**
- Create: `app/static/js/player/findplace.js`. It holds the pure candidate logic and the panel.
  It is a document-lifetime module, loaded as its own stamped `<script type="module">` in the
  shell partial.
- Modify:
  - `app/static/js/player/ui.js`, for the panel slot if needed;
  - `app/static/js/player/features.js`, for the history labels and taps;
  - `app/static/css/theme.css`;
  - `app/static/partials/shell-sidebar.html`;
  - `app/static/js/debug-leaks.js`, to add findplace.js to the shell lists;
  - `package.json` and `.github/workflows/docker-publish.yml`, to run the new test.
- Test: `app/tests/js/player_findplace.mjs` (new), `app/tests/js/player_features.mjs`,
  `app/tests/test_soft_nav.py` (the static contract and leak-list pin)

**Interfaces:**
- **Consumes:** Task 2's `state().filesChanged`, `previewAt`, `confirmPlace` and `startOver`,
  and Task 1's history fields.
- **Produces:**
  - `candidates(old, durationMs, chapters, blocked) -> [{kind: 'time'|'percent', bookMs,
    chapterLabel, unavailable}]`.
    - "time" is `min(old.book_ms, durationMs)`.
    - "percent" is `round(old.book_ms / old.book_duration_ms * durationMs)`. It is absent when
      either value is missing.
    - When the two are within 5000 ms of each other, only "time" is kept.
    - With no `book_ms`, the result is `[]`.
    - `unavailable` is true when the spot falls in a part the browser can't decode.
  - The panel opens on the `files-changed` warning and holds focus inside the full player. It
    shows:
    - the old place: book time, percentage, the old chapter name, and "last listened <ago>";
    - each candidate with this copy's chapter label, a Preview button and a "Use this spot"
      button;
    - a scrubber to nudge the chosen spot;
    - "Show history";
    - "Start from the beginning".

    It uses textContent only and theme variables only. It works with CloseWatcher and Escape,
    where closing means "decide later": nothing is saved and the hold stays.
  - History entries show "Chapter <label> · <h:mm:ss> into the book · <n>%", the device and the
    time, and an "earlier copy" label when `earlier_copy` is set. Tapping an entry whose track is
    gone opens the helper with that entry as the old place.

- [ ] **Step 1: Write failing tests.**
  - `candidates()`:
    - both candidates;
    - the within-5 s merge;
    - Review Focus 2: a 20 h old place in a 10 h copy is clamped, and the percentage is sensible;
    - Review Focus 1: no `book_ms` gives `[]`, and the panel shows only history and start over;
    - Review Focus 5: an unavailable candidate has its preview and confirm disabled.
  - The panel:
    - it renders;
    - Preview calls `previewAt`;
    - "Use this spot" calls `confirmPlace` with the nudged value;
    - start over;
    - closing sends nothing.
  - History:
    - the labels;
    - the "earlier copy" label;
    - tapping a gone-track entry opens the helper.
  - The static contract: no inline handlers and no markup built from strings.
  - The leak-list pin includes findplace.js.
- [ ] **Step 2:** Run the tests and confirm they FAIL.
- [ ] **Step 3:** Implement, then run `npm run build:css`.
- [ ] **Step 4:** Run the tests and confirm they PASS. Check in the browser on dev with a minted
  session, at 1440 and 320 px, using a test book forced into `filesChanged`: set the local copy
  to a made-up track key. Restore everything afterwards.
- [ ] **Step 5:** Commit `feat(player): Find your place helper and history that survives file
  changes`. Push, then pull.

### Task 4: PR3, re-reading before a stale Plex-app question is answered

**Files:**
- Modify: `app/static/js/player/features.js`, and `engine.js` if the hold lives there
- Test: `app/tests/js/player_features.mjs`

**Interfaces:**
- **Consumes:** the existing FR1 Plex question and the re-read of `/api/player/position`.
- **Produces:** when a Plex-app question has been showing for more than 120000 ms by wall clock,
  any answer (Continue or "Keep listening here") first re-reads the position.
  - If the Plex-app place moved, the question updates to the new place and nothing is acted on.
  - If the read fails or times out after 4 s, the question stays and the listener can answer
    again. Nothing is acted on, and nothing is lost.

- [ ] **Step 1: Write failing tests.**
  - The q_stale scenario from the scratchpad's rr-fr3: after 10 min Plex moved, so the question
    updates and nothing is saved.
  - No movement means the answer proceeds.
  - A failed or timed-out read keeps the question and saves nothing.
  - Under 2 min there is no re-read.
- [ ] **Step 2:** Run the tests and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and confirm they PASS. Re-run the rr-fr1, rr-fr2 and rr-fr3
  probes: only intended differences.
- [ ] **Step 5:** Commit `fix(player): a Plex app question left open reads again before it is
  answered`. Push, then pull.

### Task 5: Live verification on dev

**Files:** none, apart from any fixes the checks force.

**Interfaces:**
- **Consumes:** everything above.
- **Produces:** evidence in the task report.

- [ ] **Step 1: Set up.** On the mediaserver, copy one small test audiobook into a NEW test
  folder in the Plex audiobook library. The copy must be read-only on the originals: no original
  file is touched. Let Plex scan it, and record its keys.
- [ ] **Step 2: Rename check.** With a minted session, play the test copy and save a place. Then
  rename its file so Plex sees a new track, and let Plex rescan.
  - The helper opens, and the old place is intact on the server.
  - The preview plays.
  - "Use this spot" saves.
- [ ] **Step 3: Re-add check.** Move the test copy's folder so Plex creates a new album and the
  old one disappears.
  - Its place and history are inherited ("earlier copy").
  - Confirm that a side-by-side edition in the real library, which is untouched, is never linked
    to it.
- [ ] **Step 4: PR3.** Check PR3 with a simulated Plex-app place, using timeline writes. Wait
  more than 2 minutes, then answer. The question updates.
- [ ] **Step 5: Restore.** Delete the test folder, and let Plex remove the items. Restore the
  owner's Plex state, rows, prefs and sessions. Report what was created and removed.
