# Books page, core library (3a): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the eBooks page with a Books page. It is one library of ebooks (Kavita) and
audiobooks (Plex), paired into single entries. It adds book, author, narrator and series pages,
search with a request link, and one mixed Continue row on Books and Home.

**Architecture:**
- A stored catalog: `books`, `book_pair_overrides` and `book_catalog_meta`.
  - A rebuild service reads Kavita (server API key) and the Plex audiobook section (the player's
    `list_books`).
  - It pairs entries by the player's `work_key`, applies admin overrides, and keeps the last good
    side of the catalog when a source fails.
  - It runs every 15 min from the existing background loop, after a Chaptarr webhook, and on
    demand.
- A `books` router serves the catalog and the per-person views. Progress is read live: Kavita
  through the caller's Kavita JWT, audiobooks through the player's position store.
- New page modules in the soft-navigation shell render the pages.

**Tech stack:**
- FastAPI, SQLAlchemy/SQLite (2 uvicorn workers), Redis;
- vanilla ES modules;
- node + happy-dom runtime tests;
- stdlib unittest on the dev container.

**Spec:** `docs/superpowers/specs/2026-10-03-books-page-core-design.md`. Read it first; this
plan argues from it.

## Global Constraints

- **Commands:** the whitelist is in the plan workspace's `context.md`.
  - Never chain push, pull, unittest or minting commands.
  - Never redirect unittest output.
  - `git -C <repo> push origin dev` is accepted.
- **Python suite:** it runs on dev only:
  `ssh webserver "docker exec -e WEBSERVARR_FORBIDDEN_STRINGS='hmserver,HMServer,HMS Dashboard' webservarr-dev python -m unittest discover -s /app/app/tests -t /app"`.
  - Update dev with `ssh webserver "cd ~/webservarr-dev && git pull --ff-only"`.
  - Run `ssh webserver "docker restart webservarr-dev"` after Python changes.
- **JS suite:** `npm run test:js` runs locally.
- **Run `npm run build:css` after markup or CSS edits.** Commit `app/static/css/app.css`.
- **Branch and production:** work on `dev` only. Never touch production (`~/webservarr`,
  container `webservarr`). No merges to main, no `v*` tags.
- **Commits:** use the repo identity, with NO Claude/Anthropic trailer. Nothing committed may
  contain `hmserver`, `HMServer` or `HMS Dashboard`. Shipped defaults stay generic.
- **Server rules:**
  - Status codes are 4xx or 503 only, never 500.
  - No module-level caches (2 workers).
  - Every per-person query is scoped by identity.
  - Inputs are validated like the existing player routes (types, bounds, string lengths).
- **Frontend rules:**
  - ES2017 with no regex lookbehind.
  - textContent only.
  - Theme CSS variables only.
  - Reduced motion is respected.
  - `script-src 'self'`.
  - New modules get a stamped script tag, both debug-leaks lists, and a CI entry (package.json
    and `.github/workflows/docker-publish.yml`).
- **UI quality:** consumer streaming-service polish for non-technical users. The design contract
  is `~/Dropbox/AI/Personal-Projects/Webservarr/UI-DESIGN-REVIEW-2026-08-15.md` Part 5:
  - skeletons reserve their layout;
  - top-down arrival;
  - no layout shift;
  - the mobile scroll hint;
  - layouts work at 320 px.
- **Plex token:** the admin Plex token may be read only inside the dev container, and is never
  printed.
- **Pairing:** an exact `work_key` match only. Overrides always win. A source that fails a read
  never has its rows deleted.
- **Continue row:** at most 12 entries, newest activity first. A book in both formats shows once,
  under the newer activity.
- **Rebuild:** every 900 s, after a Chaptarr import webhook, and on demand. One runner at a time
  across the workers.

## Review Focus

1. **A failed source mid-rebuild.** Kavita returns 503 (or Plex is down) during a rebuild. That
   side's rows, their `books.id` and any Continue entries pointing at them must survive
   unchanged. Owner: Task 1.
2. **Stable ids when pairing changes.** An ebook and an audiobook become paired (or are split
   apart by an override). Existing ids must stay reachable: a link to the old id still opens the
   right book, never a 404 or a different book. Owner: Task 1 (id policy) and Task 2 (redirects
   for merged ids).
3. **A user who can't see a Kavita library.** That user must not see its books anywhere: grid,
   search, person pages, series pages or Continue. Owner: Task 2.
4. **Names with punctuation and unicode in URLs.** Author, narrator and series pages, for names
   like "J. R. R. Tolkien", "Brontë", "Le Guin, Ursula K." or a name containing "/". They must
   round-trip through the URL to the right page. Owner: Task 2 (lookup) and Task 4 (link
   building).
5. **The Continue row with Kavita down.** When Kavita is down, the row still shows the audiobook
   entries, plus a quiet note. It never empties and never blocks the page. Owner: Task 2 (API)
   and Task 3 (render).

---

### Task 1: Catalog store and rebuild

**Files:**
- Modify: `app/models.py` (models `Book`, `BookPairOverride`, `BookCatalogMeta`)
- Modify: `app/seed.py` (migration, safe with 2 workers at start-up, in the existing migration
  style)
- Create: `app/services/book_catalog.py`
- Modify: `app/integrations/` to add a server-side Kavita catalog read. Create
  `app/integrations/kavita.py` if no client exists; `kavita_proxy.py` is the browser proxy and
  stays as it is.
- Modify: `app/settings_registry.py` (new secret setting `integration.kavita.api_key`, label
  "Kavita API key (for the Books catalog)")
- Modify: `app/services/notification_poller.py`, or the background loop that owns periodic work,
  to schedule the rebuild
- Create: a Chaptarr import webhook route, `POST /api/webhooks/chaptarr`. Authenticate it with a
  shared secret setting, `integration.chaptarr.webhook_secret`, compared in constant time. Chaptarr sends it as the HTTP Basic password from its webhook Username/Password fields (any username). The Settings Books panel shows the full webhook URL and can generate and copy the secret.
  - It accepts only Chaptarr's import or "Download" event types.
  - It triggers a rebuild.
  - Unknown events get 204, and nothing runs.
- Test: `app/tests/test_book_catalog.py`

**Interfaces:**
- **Consumes:**
  - `app/integrations/plex_player.list_books()` (async, the audiobook section listing);
  - `plex_player.work_key(author, title, narrator="")` and `plex_player.album_work_key(album)`.
    These are the same keys the player stores, so a book's catalog key equals its player key.
- **Produces:**
  - `book_catalog.rebuild(reason: str) -> dict`, returning `{"ok": bool, "ebooks": int,
    "audiobooks": int, "books": int, "errors": {"kavita": str|None, "plex": str|None},
    "skipped": bool}`.
    - `skipped` is true when another rebuild holds the lock.
  - `book_catalog.catalog_status() -> dict` with `{"last_rebuild_at", "last_ok_at", "counts",
    "errors", "running"}`.
  - `Book` columns, exactly as spec section 3.1:
    - `id`, `work_key`, `title`, `sort_title`, `author`, `narrator`, `series`, `series_number`;
    - `description`;
    - `kavita_series_id`, `kavita_library_id`, `plex_book_key`;
    - `added_at`, `ebook_added_at`, `audio_added_at`;
    - `cover_source`, `updated_at`.
  - A `Book.merged_into` column (nullable int). When two existing rows become one, the losing
    row keeps its id with `merged_into` set, so old links can redirect (Review Focus 2).
  - `BookPairOverride`: `kavita_series_id`, `plex_book_key`, `action` (`pair`|`apart`),
    `created_by`, `created_at`. Unique on the pair.
- **Id policy:**
  - A row is matched across rebuilds by its Kavita id or its Plex key, never by title.
  - When a pair forms, the audiobook's row is kept and the ebook's row gets `merged_into`.
  - When a pair splits, a new row is created for the side that leaves, unless an old
    `merged_into` row for it exists, which is revived.
- **Lock:** a Redis lock with expiry, the same pattern the poller's lock uses. No module-level
  state.

- [ ] **Step 1: Write failing tests** in `app/tests/test_book_catalog.py`. Kavita and Plex are
  faked at the integration boundary.
  - Pairing: an exact work key pairs; differing keys stay apart.
  - Overrides:
    - a `pair` override joins differing keys;
    - an `apart` override splits matching keys;
    - a new `pair` for the same item replaces the old one.
  - Keep-last-good:
    - Kavita raises, so the ebook rows, ids and counts are unchanged and `errors.kavita` is set;
    - Plex raises, which does the same for the audiobook side;
    - both raise, so nothing changes and `ok` is false.
  - A successful read removes rows that are gone from that source only.
  - Stable ids across 3 rebuilds with no changes.
  - A pair forming sets `merged_into`; a split revives the old row (Review Focus 1 and 2).
  - The lock: two concurrent `rebuild()` calls, one runs and the other returns `skipped: true`.
    Use two real processes on one SQLite file.
  - The migration on a copy of an existing (pre-3a) database, with 2 processes starting at once.
  - The webhook: a wrong secret gets 401, an unknown event gets 204 and no rebuild, and an import
    event triggers a rebuild.
- [ ] **Step 2:** Run them and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full Python suite and confirm it PASSES.
- [ ] **Step 5:** Pull on dev and restart dev.
  - Set `integration.kavita.api_key` on dev only if Jordan has provided one. Otherwise run the
    rebuild with Plex only and report that the Kavita side is pending the key. Never invent a
    key.
  - Run one live rebuild on dev. Report the counts, and the pairs it formed with real titles.
- [ ] **Step 6:** Commit `feat(books): a combined ebook and audiobook catalog, rebuilt from Kavita
  and Plex with pairing overrides`. Push, then pull on dev.

### Task 2: Books APIs

**Files:**
- Create: `app/routers/books.py` (register it in `app/main.py`)
- Modify: `app/services/book_catalog.py` (query helpers only)
- Test: `app/tests/test_books_api.py`

**Interfaces:**
- **Consumes:**
  - Task 1's models and `catalog_status()`;
  - the player's position store, `app/services/listening.py`, for audiobook progress;
  - the caller's Kavita JWT from their session (see `kavita_proxy.py`) for ebook progress and the
    libraries the user can see.
- **Produces.** All endpoints are signed-in only and scoped by identity.
  - `GET /api/books`
    - Query: `format` = `all`|`ebook`|`audio`, `sort` = `added`|`title`|`author`, `cursor`,
      `limit` (at most 60).
    - Returns `{items: [BookCard], next_cursor}`.
    - Each series is collapsed into one card, `{kind: "series", series, count, cover_book_id,
      formats}`. Other entries are `{kind: "book", id, title, author, cover_url, formats:
      ["ebook","audio"]}`.
  - `GET /api/books/{id}`
    - Returns `{book, formats: {ebook: {available, progress, read_url}|null, audio: {available,
      progress, book_key}|null}, request_links: {...}}`.
    - A merged id answers 301 to the surviving id's path (Review Focus 2). An unknown id is 404.
  - `GET /api/books/search?q=` (1 to 100 characters)
    - Returns `{items: [BookCard], request_url}`.
    - `request_url` is `/requests?q=<q>`, URL-encoded.
    - Ranking puts title matches first, then series, then people. Matching is case- and
      accent-insensitive.
  - `GET /api/books/person?role=author|narrator&name=` and `GET /api/books/series?name=`. The
    names travel in the query string (Review Focus 4). Series order is by `series_number`, with
    nulls last.
  - `GET /api/books/continue`
    - Returns `{items: [ContinueCard], notes: [{source: "kavita"|"plex", text}]}`, with at most
      12 items.
    - Each item is `{book_id, format, progress_label, resume}`, where `progress_label` is
      "Ch. 12 · 43%" or "2h 10m left".
    - When a source fails, its items are dropped and a note is added. The response is still 200
      (Review Focus 5).
  - Admin only:
    - `GET /api/admin/books/status`
    - `POST /api/admin/books/rebuild`
    - `GET /api/admin/books/unpaired`
    - `GET|POST|DELETE /api/admin/books/overrides`
  - Cover images go through an authenticated same-origin proxy route, `GET
    /api/books/{id}/cover`, with bounded size and an allowlisted content type. Never hotlink.
- **Kavita visibility (Review Focus 3).** Ebook rows are filtered to the libraries the caller's
  Kavita account can reach. Read that list through their JWT. If it can't be read, show no ebooks
  rather than all of them.

- [ ] **Step 1: Write failing tests:**
  - every endpoint's shape, status codes, validation and limits;
  - cursor paging that is stable across a rebuild;
  - series collapsing;
  - the merged-id 301;
  - search ranking and normalisation;
  - person and series names with punctuation, unicode, a comma and "/" (Review Focus 4);
  - Continue ordering, the de-dupe of a book in both formats, the 12 cap, and Kavita down giving
    audio items plus a note (Review Focus 5);
  - the Kavita library filter on every endpoint, including search and person/series pages
    (Review Focus 3);
  - admin-only enforcement;
  - identity isolation;
  - the cover proxy rejecting non-image content.
- [ ] **Step 2:** Run them and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full Python suite and confirm it PASSES. Restart dev, then call each
  endpoint once on dev as a signed-in test session.
- [ ] **Step 5:** Commit `feat(books): the Books APIs for the library, a book, people, series,
  search and Continue`. Push, then pull on dev.

### Task 3: The Books page

**Files:**
- Create: `app/static/js/pages/books.js` (the page module) and its partial or HTML, following
  how `library.js` is wired.
- Modify: `app/pages.py`. Rename the nav entry from eBooks to "Books", at `/books`. The old
  eBooks route answers with a redirect to `/books`. Keep the `ebooks_configured` feature gate
  only if no audiobooks exist; show Books when either Kavita or Plex audiobooks is configured.
- Modify: `app/static/js/pages/requests.js`. On load, read `q` from the URL and run that search.
- Modify: CSS, `debug-leaks.js` and CI as the Global Constraints require.
- Test: `app/tests/js/books_page.mjs` and `app/tests/test_soft_nav.py` (route and partial pins)

**Interfaces:**
- **Consumes:** Task 2's `/api/books`, `/api/books/search` and `/api/books/continue`.
- **Produces:**
  - `renderBookCard(card)` and `renderContinueRow(items, notes, {compact})`, exported for reuse
    by Task 4 and Task 5.
  - Book cards link to `/books/<id>`; series cards link to `/books/series?name=<encoded>`.

- [ ] **Step 1: Write failing runtime tests:**
  - the skeleton, then the render;
  - the chips filter;
  - the sort;
  - paging or progressive loading;
  - series cards;
  - format badges;
  - search with a debounce;
  - the empty search showing "Can't find it? Request it" linking to `request_url`;
  - the Continue row, including the notes when Kavita is down;
  - the building state when the catalog is empty and a rebuild is running;
  - textContent only;
  - the Requests page running the `q` search on load;
  - the old route redirecting.
- [ ] **Step 2:** Run them and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:js` and the Python suite, and confirm they PASS.
  - Do a browser check on dev at 1440 and 320 px with the real library: no horizontal overflow,
    no layout shift.
  - The Chrome DevTools MCP may fail on aiserver ("Missing X server"). If it does, use headless
    Brave over CDP.
- [ ] **Step 5:** Commit `feat(books): the Books page replaces eBooks, with one library,
  search and a Continue row`. Push, then pull on dev.

### Task 4: Book, person and series pages

**Files:**
- Create: `app/static/js/pages/book.js` and `app/static/js/pages/books-list.js` (person and
  series), plus their partials.
- Modify: `app/pages.py` (routes `/books/<id>`, `/books/person`, `/books/series`).
- Modify: CSS, `debug-leaks.js`, CI.
- Test: `app/tests/js/book_page.mjs`, `app/tests/test_soft_nav.py`

**Interfaces:**
- **Consumes:** Task 2's `/api/books/{id}`, `/api/books/person` and `/api/books/series`; Task 3's
  `renderBookCard`.
- Read uses the existing reader view hand-off: see `reader.js` and how `library.js` opens a book
  today.
- Listen uses the player's public open API: see `app/static/js/player/engine.js` and
  `player-test.js`.
- **Produces:** a `/books/<id>` page with the following.
  - Read and Listen buttons, each with progress or a disabled state.
  - Request links for a missing format, to `/requests?q=<title author>`.
  - Linked author, narrator and series names, URL-encoded as query parameters (Review Focus 4).

- [ ] **Step 1: Write failing runtime tests:**
  - the book page in each case: both formats, ebook only, audio only, Kavita down, Plex down;
  - Read opens the reader at its place;
  - Listen opens the player;
  - the request links;
  - the merged-id redirect is followed;
  - a person page and a series page in order, with nulls last;
  - names with punctuation and unicode round-trip through the links (Review Focus 4).
- [ ] **Step 2:** Run them and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and confirm they PASS. Browser check on dev at 1440 and 320 px:
  open a real paired book; Read lands at the reader's place; Listen plays; a series page is in
  order.
- [ ] **Step 5:** Commit `feat(books): book, author, narrator and series pages`. Push, then pull.

### Task 5: Home Continue row, the Settings Books panel, and the live check

**Files:**
- Modify: `app/static/js/pages/home.js` (the compact Continue row through `renderContinueRow(...,
  {compact: true})`, hidden when empty).
- Modify: `app/static/js/pages/settings.js` (or its module) to add an admin "Books" panel. It
  shows:
  - the status;
  - a Rebuild now button;
  - unpaired lists, with pair and keep-apart actions;
  - the current overrides, with remove.
- Modify: the CSS.
- Test: `app/tests/js/home_continue.mjs`, `app/tests/js/settings_books.mjs`

**Interfaces:**
- **Consumes:** Task 2's admin endpoints and `/api/books/continue`; Task 3's
  `renderContinueRow`.

- [ ] **Step 1: Write failing runtime tests:**
  - Home shows the compact row, hides it when empty, and shows the Kavita-down note;
  - the Settings panel's actions call the right endpoints;
  - a pair shows up as paired after a rebuild;
  - non-admins never see the panel.
- [ ] **Step 2:** Run them and confirm they FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:js` and the Python suite, and confirm they PASS.
- [ ] **Step 5: Live check on dev** (spec section 9), at 1440 and 320 px with the real library:
  - Books, a paired book page, and a series page in order;
  - search and its request link landing pre-searched on Requests;
  - Continue on Books and Home after a real 1-minute listen;
  - pair and unpair in Settings, then rebuild;
  - Kavita down and Plex down, simulated with request interception, not by stopping services.

  Restore every row, override, session and Plex view state you touch. Don't add anything to the
  Plex or Kavita libraries.
- [ ] **Step 6:** Commit `feat(books): Continue on Home and a Books panel in Settings`. Push,
  then pull on dev.
