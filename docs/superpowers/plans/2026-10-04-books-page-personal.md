# Books page, personal features (3b): implementation plan

> **For agentic workers:** carry this plan out task by task with superpowers:subagent-driven-development.

**Goal:** add My list, the Up next queue, 1-5 star ratings (written through to Kavita and Plex) and "try a sample" to the Books pages.

**Spec:** `docs/superpowers/specs/2026-10-04-books-page-personal-design.md`. Read it first.

**Process (Jordan, 2026-10-04):**
- Coders run on Opus.
- No bug-hunter.
- Each task's own tests are the gate.
- One full live check happens at the end of Task 3, using the dev test kit (`scripts/devkit/`).
- Try changes on dev with `ws-dev-sync <paths>` and refresh dev with `ws-dev-sync --reset`.

## Global Constraints

These come from the 3a plan's Global Constraints (`docs/superpowers/plans/2026-10-03-books-page-core.md`) and still hold:
- Use only the whitelisted commands, and never chain push, pull or unittest.
- Work on dev only. No production, no merges, no tags.
- Use the repo identity, with no Claude/Anthropic trailer.
- No instance names in committed files.
- Return 4xx or 503 only.
- No module-level caches.
- Scope everything by identity.
- Write ES2017, use textContent only, and use theme variables only.
- Zero CLS and no overflow at 320 px.
- Never print secrets.

Rules specific to this plan:
- **Plex ratings:** `rating = stars × 2`.
- **Audio sample:** exactly 300000 ms.
- **Write-through:** never blocks or reverts the WebServarr rating.
- **Visibility:** identical to 3a.

## Review Focus

1. **Merged books.** List, queue and rating rows follow `merged_into` with no duplicates, and the right row wins on conflict. *(Task 1)*
2. **Two tabs reordering one queue.** Positions stay dense and unique, and nothing is lost. *(Task 1)*
3. **The Up next offer while the player is holding** (Find your place, a conflict, files changed). It never opens over the hold. *(Task 3)*
4. **Sample isolation.** A sample makes no check-in, no `/:/timeline`, no scrobble and no queue change. After it ends, the main player is exactly as it was. *(Task 2)*
5. **Rating write-through when the person has no Kavita link, or Plex refuses.** The state goes to pending, then retries, then reaches ok. Clearing works the same way. *(Task 1)*

---

### Task 1: Server: list, queue, ratings with write-through

**Files:**
- `app/models.py`
- `app/seed.py` (migrations)
- new `app/services/book_personal.py`
- `app/routers/books.py`, or a new `app/routers/book_personal.py` registered in `main.py`
- `app/integrations/kavita.py` (chapter rating write)
- `app/integrations/plex_player.py` (`/:/rate`)
- `app/routers/kavita_proxy.py` allowlist, only if the server needs it
- `app/services/book_catalog.py` (merge moves)
- the background loop for rating retries
- tests

**Produces:**
- **My list**
  - `GET /api/books/me/list` returns `{items:[BookCard]}`
  - `PUT /api/books/{id}/list` adds the book; `DELETE /api/books/{id}/list` removes it.
- **Up next**
  - `GET /api/books/me/queue` returns `{items:[BookCard+position]}`
  - `PUT /api/books/{id}/queue` appends the book; `DELETE /api/books/{id}/queue` removes it.
  - `POST /api/books/me/queue/move` takes `{book_id, to}`.
  - `GET /api/books/me/queue/next-audio?after=<book_id>` returns `{book, edition_key}|{book:null}`.
- **Ratings**
  - `PUT /api/books/{id}/rating` takes `{stars:1-5}`; `DELETE /api/books/{id}/rating` clears it.
  - `GET /api/books/{id}` gains `{my_list: bool, queue_position: int|null, my_rating: int|null}`.
- **Same-origin and identity.** Every write checks same-origin and is identity-scoped.

- [ ] Write the failing tests:
  - create, read, update and delete for the list, queue and ratings;
  - concurrent moves;
  - merge moves (Review Focus 1);
  - identity isolation;
  - write-through success, refusal, pending, retry and clear, with fakes (Review Focus 5);
  - the migration under 2 workers.
- [ ] Run them and confirm they fail.
- [ ] Implement.
- [ ] Run the full Python suite and confirm it passes. Restart dev.
- [ ] Commit `feat(books): My list, Up next and ratings that write through to Kavita and Plex`.

### Task 2: Player and reader: samples and the queue offer

**Files:**
- `app/static/js/player/*` (sample engine instance; the ended-offer hook in features.js)
- `app/static/js/pages/reader.js` (sample mode)
- tests in `app/tests/js/`

**Consumes:** `next-audio` from Task 1.

**Produces:**
- `WS.player.sample(editionKey)` and `WS.player.stopSample()`, emitting `sample-change`.
- Reader route `/reader?seriesId=&chapterId=&sample=1`.
- The ended offer reads the queue first and falls back to the series offer.

- [ ] Write the failing runtime tests:
  - Review Focus 3 and 4;
  - the 5-minute stop;
  - the main player is paused and restored;
  - reader sample mode sends no progress POST and has no bookmarks.
- [ ] Run them and confirm they fail.
- [ ] Implement.
- [ ] Run `npm run test:js` and the Python suite, and confirm they pass.
- [ ] Commit `feat(books): try a sample without saving anything, and an Up next offer when a book ends`.

### Task 3: UI and live check

**Files:**
- `app/static/js/pages/book.js`: list toggle, queue button, stars, sample buttons.
- `app/static/js/pages/books.js`: My list and Up next rows, with move up/down, remove, play/read.
- CSS and tests.

**Consumes:** Tasks 1 and 2.

- [ ] Write the failing runtime tests for every control and row, including keyboard access, CLS 0 and no overflow at 320 px.
- [ ] Implement.
- [ ] Run both suites.
- [ ] Do the full live check from spec section 9 on dev with the devkit, at 1440 and 320 px. Restore everything, including the Kavita and Plex ratings.
- [ ] Commit `feat(books): My list, Up next, ratings and samples on the book and Books pages`.
