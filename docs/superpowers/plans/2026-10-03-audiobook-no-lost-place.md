# Audiobooks, no lost place: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four gaps parked in 2.5, so a listener never loses a place, never gets a
wrong one, and tracks never play out of order.

**Architecture:**
- The server stores one claim per earlier copy behind a unique index, including pending claims.
- Natural sort compares digit runs by length, then by digits.
- The work-key matcher favours precision.
- A new orphan lookup returns the listener's unfinished places on albums that are gone.
- The player offers those orphans in a "Were you listening to one of these?" panel when a book
  opens with no place. A pick goes through the existing 2.5 helper as a manually linked copy.
- Previews get a 60 s wall-clock ceiling.

**Tech stack:**
- FastAPI, SQLAlchemy/SQLite;
- vanilla ES modules;
- node + happy-dom runtime tests;
- stdlib unittest in the dev container.

**Spec:** `docs/superpowers/specs/2026-10-03-audiobook-no-lost-place-design.md`. It builds on
`2026-09-30-audiobook-files-changed-design.md` and `2026-09-28-audiobook-player-design.md`.

## Global Constraints

- Everything from the 2.5 plan's Global Constraints still holds:
  - no co-author trailer and no instance names in commits;
  - never touch production;
  - exact whitelisted commands, never chained, unittest output never redirected;
  - 4xx/503 only;
  - no module-level caches;
  - theme variables only;
  - `script-src 'self'`;
  - textContent only;
  - ES2017 with no regex lookbehind;
  - every guarantee already hunted clean keeps holding (see the 2.5 ledger).
- Never save or play on the listener's behalf while the safety-net panel or the helper is open.
- Every new query is scoped by identity and bounded.
- Orphan lookup:
  - at most the newest 10 candidate rows, with at most 10 album checks per request;
  - "unfinished" means no `end` mark and `book_ms` under 97% of `book_duration_ms` when both
    are known.
- One successor per earlier copy: a unique index on (identity, claimed earlier key). A pending
  claim blocks like a verified one. A claim whose holder's album is also gone does not block.
- Preview ceiling: 60000 ms of wall clock since the preview started, on top of the 15 s budget.
- Natural sort: strip leading zeros, then compare by length, then by digits. The order for runs of
  1 to 6 digits is unchanged.

## Review Focus

1. **Brand-new books and orphans.** A listener with orphans who opens a genuinely new book is asked
   once. "None of these" must stick on every device, and must never ask again for that book.
2. **A pick that becomes a link.** A manual pick on a book that is a different work is a valid
   listener choice. The server must still refuse it when the old album is present, or when another
   present copy holds the claim.
3. **Pending claims after Plex comes back.** If the old album reappears, the pending claim is
   dropped and the place stays saved.
4. **Migration on an existing database under two workers.** The claims table or columns are
   added, and existing verified links (`linked_from` rows) are back-filled as claims, so the
   successor rule holds for links made in 2.5.
5. **Lock-screen Play and reloads while the safety-net panel is open.** Nothing plays or saves,
   and the panel opens again.

---

### Task 1: Server, claims and natural sort

**Files:**
- Modify: `app/models.py`, `app/seed.py` (migration and back-fill),
  `app/services/listening.py`, `app/routers/player.py`, `app/integrations/plex_player.py`
  (`_natural`)
- Test: `app/tests/` (the existing player and listening test modules)

**Interfaces:**
- Produces: claims with states `verified` and `pending`, written in the same transaction as the
  check-in that carries `linked_from`.
- The check-in response `linked` stays `true | false | null`. `null` now means "pending claim
  stored".
- `_earlier_copy` and link verification use the claim-based successor rule from spec 4.

- [ ] **Step 1:** Write failing tests:
  - two concurrent confirms from different book keys claiming one earlier copy, run under two
    real processes: exactly one claim, and the loser gets `linked:false` with its place saved;
  - pending claim on PlayerUnavailable, which blocks a side-by-side edition;
  - pending to verified on resend; pending dropped when the old album is present again;
  - chains A to B to C, where a gone holder does not block;
  - the back-fill of existing `linked_from` rows;
  - identity isolation;
  - natural sort: 999999 before 1000000; a 100000-digit run does not raise; a fuzz of runs of 1
    to 6 digits gives the same order as at HEAD.
- [ ] **Step 2:** Run them and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full Python suite and confirm it PASSES. Restart dev after the pull.
- [ ] **Step 5:** Commit `fix(player): one claim per earlier copy, pending claims included, and
  numbers of any length sort right`. Push, then pull.

### Task 2: Server, matcher precision, orphan lookup, manual links

**Files:**
- Modify: `app/integrations/plex_player.py` (work key), `app/services/listening.py`,
  `app/routers/player.py`, `app/models.py` and `app/seed.py` if a dismissal store is needed
- Test: `app/tests/`

**Interfaces:**
- Consumes: Task 1's claims and successor rule.
- Produces:
  - `GET /api/player/orphans/{book_key}` returns `{orphans: [{key, book_title, narrator,
    book_ms, book_duration_ms, chapter_label, updated_at, author_match}], dismissed: bool}`.
    The list is ordered author first, then by recency, with at most 10 entries. Returns 503 when
    Plex is unavailable.
  - `POST /api/player/orphans/{book_key}/dismiss` stores "None of these" for the listener and
    book key.
  - Check-in accepts `link_manual: true` alongside `linked_from`. A manual link skips the work-key
    match, but every other rule still applies: the old album must be gone, the claim must be
    free, and the row must be the listener's own.
  - Work key: Vol/Book/No become distinct kinds; number words one to twenty, ordinals and Roman
    numerals are read everywhere; per-disc keys include the album key; T1S5 reads the tracks when
    the album-level pre-check misses.

- [ ] **Step 1:** Write failing tests.
  - The orphan lookup:
    - its bounds: 10 rows and 10 album checks;
    - the unfinished filter at 97% and the `end` mark;
    - author-first ordering;
    - successor and claim exclusion;
    - identity isolation;
    - 503 on Plex failure.
  - The dismissal: it persists, and it is per book key.
  - Manual links: accepted when the old album is gone and the claim is free. Refused when the
    album is present, when another copy holds the claim, or when the row belongs to another
    identity.
  - The work key: one test per 2.5 parked T1 item, plus a regression run of the live library
    keying. Record which groups change and explain each one.
- [ ] **Step 2:** Run the tests and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite and confirm it PASSES. Restart dev after the pull.
- [ ] **Step 5:** Commit `feat(player): places on books that left the library can be found and
  claimed by hand, and the book matcher no longer joins different works`. Push, then pull.

### Task 3: Player, the safety-net panel and the preview ceiling

**Files:**
- Modify: `app/static/js/player/findplace.js` (or a new module, if the coder judges it cleaner;
  if new, add it to the shell partial, the debug-leaks lists and CI), `engine.js`, `features.js`,
  `ui.js`, CSS
- Test: `app/tests/js/player_findplace.mjs`, `player_engine.mjs`, `player_features.mjs`

**Interfaces:**
- Consumes: Task 2's endpoints.
- The panel shows when a book opens with no own place and no linked earlier copy, and the lookup
  returns orphans that have not been dismissed.
- While the panel is open, the book is held, exactly like the 2.5 "files changed" hold: nothing is
  saved or played, and a lock-screen Play is held.
- A pick enters the 2.5 helper with that orphan as the old place, as a linked copy with
  `link_manual`.
- "None of these" calls dismiss, releases the hold, and opens the book as new.
- A failed lookup opens the book as today.
- Preview ceiling: 60000 ms of wall clock.

- [ ] **Step 1:** Write failing tests:
  - the panel shows only when ruled;
  - while it is open, 0 saves and 0 plays, including a lock-screen Play;
  - a reload reopens it;
  - a pick enters the helper, and confirming sends `linked_from` plus `link_manual`;
  - "None of these" sticks;
  - a lookup failure opens the book normally;
  - the preview stops at 60 s of wall clock under a stall-before-every-timeupdate pattern.
- [ ] **Step 2:** Run the tests and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and confirm they PASS. Check in the browser on dev at 1440 and
  320 px with a test identity whose rows point at a book key that is not in the library. Restore
  everything afterwards.
- [ ] **Step 5:** Commit `feat(player): a new book asks "Were you listening to one of these?" when
  places were left on books that are gone`. Push, then pull.

### Task 4: Live verification on dev

**Files:** none, apart from any fixes the checks force.

- [ ] **Step 1:** Run the safety net end to end on dev:
  - seed a test identity's rows on a book key that is not in the library;
  - open a real book: the question shows;
  - pick one, preview, and confirm: the server stores `linked_from` with a manual claim;
  - "None of these" on another book sticks after a reload and on a second browser profile.
- [ ] **Step 2:** Check claims: a second book cannot claim the same orphan.
- [ ] **Step 3:** Restore all rows, prefs, sessions and Plex state. No copies go into the Plex
  library.
