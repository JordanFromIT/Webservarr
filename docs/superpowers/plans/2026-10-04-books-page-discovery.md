# Books page, discovery (3c): implementation plan

> **For agentic workers:** carry this plan out task by task with
> superpowers:subagent-driven-development.

**Goal:**
- Recently added, with New badges.
- Popular on the server (audio only, at least 3 listeners, counts only).
- Private listening stats, with a daily rollup.
- "New in your series" notifications, including follows.

**Spec:** `docs/superpowers/specs/2026-10-04-books-page-discovery-design.md`. Read it first.

**Process (Jordan, 2026-10-04):**
- Coders run on Opus.
- There is no bug-hunter; each task's own tests are the gate.
- One full live check runs at the end of Task 2, using the dev test kit (`scripts/devkit/`).
- `ws-dev-sync` for dev trials; `ws-dev-sync --reset` after a push.

## Global Constraints

The 3a and 3b plans' Global Constraints all still apply:
- whitelisted commands only, never chained;
- dev branch only, no prod, no merges, no tags;
- repo identity, no trailer, no instance names;
- 4xx/503 only;
- no module caches;
- every query scoped by identity;
- ES2017, textContent only, theme variables;
- CLS 0 and no overflow at 320 px;
- never print secrets.

Privacy is absolute:
- No response carries another person's identity, email or per-person data.
- Popularity counts below 3 are never returned.

## Review Focus

1. **Popularity floor.** A book with 1 or 2 listeners never appears, at any window edge.
   *(Task 1)*
2. **The rollup across the 180-day prune.** All-time totals are unchanged after a prune.
   *(Task 1)*
3. **Burst imports.** 7 books in one second give one grouped notification per series per
   person, with no double sends across 2 workers. *(Task 1)*
4. **New badge on a first visit.** No badges show, and a rapid revisit within 30 min does not
   clear them. *(Task 1 logic, Task 2 UI)*
5. **Seeding the existing 22 books.** They are never announced, including on a fresh database
   and on the first rebuild after deploy. *(Task 1)*

---

### Task 1: Server

**Files:**
- `app/models.py`
- `app/seed.py` (migrations; seeds `book_announced` from the existing catalog)
- new `app/services/book_discovery.py`
- `app/routers/books.py`, or a new router
- `app/services/listening.py` (rollup before the prune)
- `app/services/book_catalog.py` (an announce hook after a rebuild)
- the notification and push code (new "books" category plus a preference)
- the background loop (hourly popularity, rollup)
- tests

**Produces:**
- `GET /api/books/recent` returns `{items:[BookCard+is_new]}`, and records the visit.
- `GET /api/books/popular` returns `{items:[BookCard+listeners_label]}`.
- `GET /api/books/me/stats` returns
  `{listened_ms_6mo, listened_ms_all, finished, streak_days, weekly:[{week, ms}], top_authors:[...], reading:{...}|null, notes}`.
- `PUT /api/books/series/follow` and `DELETE /api/books/series/follow`, each with
  `{series}`.
- `GET /api/books/series` gains `following: bool`.
- The notification preference category is `books`.

Every write checks same-origin, and every query is scoped by identity.

- [ ] Write failing tests covering Review Focus 1-5, the stats maths, follows from every source,
      preference gating, identity isolation, and migrations under 2 workers.
- [ ] Run them and confirm they fail.
- [ ] Implement.
- [ ] Run the full Python suite and confirm it passes. Restart dev.
- [ ] Commit `feat(books): recently added, popular, listening stats and new-in-series
      notifications`.

### Task 2: UI and the live check

**Files:**
- `app/static/js/pages/books.js` (Recently added and Popular shelves, New badges, a stats link)
- a new stats page module `/books/stats` (with route, partial and CI entry)
- `books-list.js` (the Follow toggle)
- the preferences modal (the "Books" category)
- CSS and tests

**Consumes:** Task 1.

- [ ] Write failing runtime tests for every shelf, the badges, the stats page and the Follow
      toggle, including CLS 0 and 320 px.
- [ ] Implement.
- [ ] Run both suites and confirm they pass.
- [ ] Do the full live check from spec section 6 with the devkit at 1440 and 320 px. Restore
      everything afterwards.
- [ ] Commit `feat(books): discovery shelves, your stats page and series follow`.
