# Insights: reading and listening across everyone

Status: designed 2026-10-10; decisions approved by Jordan in chat. Not built. The build plan is
`docs/superpowers/plans/2026-10-10-insights.md`. This feature adds admin routes that read everyone's
reading and listening, so it joins the v2.0 security audit scope (roadmap step 6). The audit is not part
of this plan and stays on hold until Jordan says it is ready.

## 1. Purpose and success criteria

The admin wants to see how the server's books are used: who is reading or listening now, what each
person is in the middle of, what is popular, what is abandoned or never opened, and how habits look over
time. Today none of this has a page; parts of it exist only as each person's own Your stats.

The feature is done when all of these hold:

- An admin sees a new "Insights" link in the sidebar (and in the phone's More sheet) and can open
  `/insights`. Nobody else sees the link, and nobody else can open the page or any of its API routes:
  signed out gets 401 (or a redirect to `/login`), a member gets 403 (or a redirect to Home).
- The page shows all 15 features in five sections (section 7). Each section loads on its own; one that
  fails, or whose source is down, says so and never breaks the others.
- Every figure that is an estimate (Plex app time, Kavita's time, pages read across a gap of days) is
  labelled as an estimate on the page.
- Where tracking is new, the section says "Tracking started on <date>" instead of showing an empty chart.
- People are told on their own Your stats page that the admin can see their reading and listening
  (section 10), and the code comments that promised otherwise say so.
- The page works at 390 and 1440 wide, with a keyboard and a screen reader, and CI is green.

## 2. Decisions (Jordan, 2026-10-10)

- **Page:** a new admin-only page, "Insights", with its own sidebar entry, shown to admins only.
  It is gated on the server exactly like Settings: the page route, its soft-navigation fetch and every
  API route. Every new `/api/admin` route must pass the OpenAPI sweep in
  `app/tests/test_settings_gate.py`.
- **All 15 features**, in five sections:
  - Right now: (1) now reading or listening, live.
  - People: (2) current books and progress, (3) last active, (4) personal history (click a person).
  - Trends, with a period picker: (5) hours listened and pages read over time, (6) active readers per
    week, (7) top books, (8) top authors and series.
  - Books: (9) per-book detail, (10) abandoned books (30 or more days untouched), (11) never opened,
    (12) finish rate and drop-off chapter.
  - Habits: (13) web versus Plex split, (14) time-of-day heatmap, (15) requested then read.
- **Three phases:**
  - (A) everything the existing audio data already supports;
  - (B) small schema additions shipped early, so their history starts at deploy: a book-requester table
    (15), a `source` column on `listening_log` (13), an hourly rollup (14, and beyond 180 days),
    recording the Kavita user id at Kavita connect, and daily Kavita page snapshots (5 pages, and the
    ebook parts of the other features);
  - (C) ebook data through Kavita admin queries, and Plexamp "listening now" from Plex's Track sessions.
- **Order:** the phase B schema work is the first task of the plan, so its data starts accruing as early
  as possible.
- **Privacy ("tell them, then show you"):** see section 10. Per-person views ship only together with
  the wording change. `POPULAR_MIN` in `app/services/book_discovery.py` stays as it is for the
  member-facing Popular shelf.
- **Mockup gate:** a static mockup of the page at 390 and 1440 is a hard gate before any front-end task.
  Jordan approves it. Backend tasks may run meanwhile. Jordan's rule: one blue primary button per view
  (this page needs none; section 7).
- **Audit:** Insights joins the v2.0 security audit scope. The audit is not part of this plan.

### 2.1 Choices made in this design (beyond the approved list)

These follow from the approved decisions; each is small and called out so Jordan can overrule it.

1. **The sidebar link is fixed, not a configurable page.** Insights sits just above Settings for admins.
   It is not added to Settings > Pages (no switch, label, order or New flag), so the page-order rules
   ("Home first, Settings last, every page once") and the Pages tab stay exactly as they are.
2. **The hourly rollup is keyed by person, hour, book and source**, not just person and hour. The same
   table then carries top books, per-book time and the web/Plex split past the log's 180 days. Its first
   run rolls up the whole existing log, so the heatmap has history from the first day.
3. **Phase B Kavita snapshots come from reads WebServarr already makes with each person's own Kavita
   link:** their Your stats page, their Books Continue row and a book's pop-up. The Continue row adds one
   background read of the person's totals, at most once a day. Phase C adds a nightly sweep with the admin
   key for everyone who has connected Kavita, so days without a visit fill in.
4. **"Reading now" comes from WebServarr's own reader.** Kavita has no live sessions, so the Kavita proxy
   notes each reader progress save in Redis for five minutes. Reading in Kavita's own app shows up a day
   later through the nightly sweep, never as "now".
5. **Requested books are matched to the library by title.** Chaptarr's request answer carries no author
   without changing its tested shape, so the match is on the folded title (`book_catalog.fold`) and the
   page says "matched by title".
6. **The browser never gets an account identity.** People are keyed by `utils.identity_key` (an HMAC of
   the identity), as the rest of the site does.
7. **Plexamp sessions are parsed by a sibling of `plex.get_active_streams`** (same `/status/sessions`
   answer, its Track elements), so the Home dashboard's stream list stays video only.

## 3. What each feature can show

Labels: **READY** works from data that exists today; **NEW TRACKING** needs data this feature starts
recording (it has history only from the deploy date, shown on the page); **ESTIMATE** is a figure the
page must label as an estimate. The phase says when it first appears.

| # | Feature | Audio source | Ebook source | Labels | Phase |
|---|---|---|---|---|---|
| 1 | Now reading or listening | Web player: a place saved in the last 10 min whose last log row is not `leave` or `end` (playing when saved in the last 60 s) | WebServarr's reader: progress saves seen by the Kavita proxy (Redis, 5 min) | READY (web); Plexamp and reader in C | A, C |
| 2 | Current books and progress | `listening_positions`, unfinished, touched in 30 days; Plex app plays in 30 days (no percent) | `ebook_places`, unfinished, read in 30 days | READY (audio), NEW TRACKING (ebook) | A, B |
| 3 | Last active | Newest of: place saved, Plex play, Books visit (`book_visits`), request | `ebook_places.read_at` | READY, NEW TRACKING (ebook, requests) | A, B |
| 4 | Personal history | All of the person's places, hourly listening, Plex plays, 12 weeks of bars | Their ebook places, latest Kavita totals | READY, ESTIMATE (Plex), NEW TRACKING (ebook) | A, B |
| 5 | Hours listened, pages read over time | `listening_hourly` plus the log since the last rollup; Plex plays at track length | `reading_totals` day-to-day rise | READY, ESTIMATE (Plex, pages across gaps), NEW TRACKING (pages) | A, B |
| 6 | Active readers per week | Anyone with web time or a Plex play that week | Anyone whose pages rose or who read an ebook that week | READY, NEW TRACKING (ebook) | A, B |
| 7 | Top books | Time (web plus Plex estimate) and people per book | People per ebook | READY, ESTIMATE (Plex) | A, B |
| 8 | Top authors and series | As 7, grouped by the catalog's author and series | As 7 | READY | A, B |
| 9 | Per-book detail | Everyone's place, time and finish in the book's editions | `ebook_places` for the book | READY, NEW TRACKING (ebook) | A, B |
| 10 | Abandoned (30+ days untouched) | Unfinished places at least 5 min in, untouched 30 days | Unfinished ebook places, untouched 30 days | READY, NEW TRACKING (ebook) | A, B |
| 11 | Never opened | Live books no one has a place in, no log rows, no Plex play | No ebook place | READY (audio); ebook complete only after C | A, B, C |
| 12 | Finish rate and drop-off chapter | Started (5 min in) against finished; most common chapter among abandoned places (2 or more people) | Started against finished; no chapter until C | READY (audio), NEW TRACKING (ebook) | A, B |
| 13 | Web versus Plex split | Web: `listening_hourly` by `source`; Plex apps: history plays not caused by the web player | n/a | READY, ESTIMATE (Plex) | A |
| 14 | Time-of-day heatmap | Web hours (beyond 180 days through the rollup); Plex plays at their hour | n/a | READY (180 days back), ESTIMATE (Plex) | A, B |
| 15 | Requested then read | `book_requesters` matched by title; first activity by the requester after the request | Same | NEW TRACKING | B |

Phase C adds, through Kavita admin queries: lifetime totals for every linked person every night (pages
per day without a visit), and reading history (which ebooks were opened, and when), which completes 2, 3,
6, 7, 9, 10 and 11 for people who read only in Kavita's own app.

## 4. Sources in detail

### 4.1 Web player listening (real time)

The player checks in every 10 s while it plays; each stored check-in is a `listening_log` row
(`app/models.py` ListeningLog, around line 457; pruned after 180 days, `listening.LOG_DAYS`,
`app/services/listening.py` line 59). Time listened is wall time: the gap from a playing row to the
listener's next row when that gap is 30 s or less (`listening.listened_spans`, line 871), the same rule
Your stats uses, so two devices at once never count twice.

Insights reads finished hours from `listening_hourly` (section 5) and the hours since the last rollup
straight from the log.

### 4.2 Plex app listening (estimate)

Plex's own history (`/status/sessions/history/all`, read with the admin token, as
`plex_player.play_history` already does for Popular) has one play per track: account id, album, disc,
track and `viewedAt`. Insights counts each play at the track's length, from one read of every track in
the audiobook library (`plex_player.track_durations`, new). That is an estimate: a play counts when Plex
records it, whatever part of the track was heard, and a single-file book is one long play.

The web player also reports to Plex's timeline (`plex_player.timeline`), so some history plays are the
web player's own. A play is left out as the web player's when the same person listened to the same book
on the web at any time from the track's length before the play, less one hour, to one hour after it.

Plex numbers the server's owner `1` in its own history; every other account id is the plex.tv id. Task 4
of the plan proves this read-only before anything relies on it, and maps `1` to the owner's plex.tv id
(from plex.tv's account for the admin token).

Names come from plex.tv: each accepted share's `invited` account (`owned/accepted`, already proven by
the request access work) and the owner's own account. A person with no known name is shown as
"Account <last four digits>".

### 4.3 Reading (Kavita)

- **Totals:** `kavita.reading_stats` gives a person's lifetime pages, words and hours. Insights keeps one
  `reading_totals` row per person per UTC day (the last read that day). Pages read on a day are the rise
  from the person's previous row; across a gap of days the rise lands on the later day, which is an
  estimate. A total that goes down (Kavita reset) counts nothing.
- **Places:** `kavita.book_places` gives the page, the page count and Kavita's `lastModifiedUtc` per
  book. Insights keeps one `ebook_places` row per person per catalog book, replaced on every read.
- **Kavita time spent** (`timeSpentReading`) is Kavita's own estimate; the page labels it so.
- **Phase B readers:** the person's own link, on reads that already happen (Your stats, the Continue
  row, a book's pop-up) plus one background totals read from the Continue row at most once a day.
- **Phase C:** the admin key (`integration.kavita.api_key`) exchanged for a token as the catalog does
  (`kavita._token`), then per linked person: their totals and their reading history. The endpoints are
  unverified today; Phase C's first task proves them read-only against dev's Kavita and records the result
  here, and the plan stops for Jordan if they do not answer as expected.

### 4.4 Requests

The Requests page's book request (`app/routers/integrations.py` create_chaptarr_request, line 713) logs
who asked only to the application log, and the per-user cap counter in Redis expires after 24 h
(line 686). Insights adds a `book_requesters` row for each request Chaptarr took ("Already in the
library" is not a request).

### 4.5 Live sessions (phase C)

- **Plexamp and other Plex apps:** `/status/sessions` Track elements in the audiobook library section,
  read with the admin token, cached 15 s. Sessions whose player product is WebServarr are the web
  player's own and are skipped (they are already in the web list).
- **WebServarr's reader:** the reader saves progress through the Kavita proxy
  (`POST /kavita/api/Reader/progress`, `app/static/js/pages/reader.js` line 697). After Kavita accepts
  one, the proxy writes `webservarr:insights:reading:<identity key>` to Redis for 300 s with the book's
  volume id, chapter id, page and the time. Nothing else about the request is kept.

## 5. Schema additions and migrations

`Base.metadata.create_all` creates new tables on existing databases. A new column on an existing table
needs a migration in `app/seed.py`, registered in `app/database.py` `init_db`, guarded by
`PRAGMA table_info` and idempotent, as `migrate_listening_device_id` is.

| Change | Phase | Migration | Written by |
|---|---|---|---|
| `listening_log.source` VARCHAR(10) NOT NULL DEFAULT 'web' | B | `migrate_listening_log_source`. Every existing row came from the web player (the only writer of the log), so `web` is true for them | `listening.save_checkin` (both of its log writes) |
| `listening_hourly` (id, identity, hour, book_key, source, ms); unique (identity, hour, book_key, source); index on hour | B | new table | `listening.roll_up_hours`, in the hourly Books pass and before every log prune |
| `book_requesters` (id, identity, foreign_id, title, format, requested_at); indexes on identity and requested_at | B | new table | the book request route, after Chaptarr took the request |
| `kavita_links` (identity primary key, kavita_user_id, kavita_username, linked_at) | B | new table | `/signin-oidc`, from Kavita's `/api/account` answer (id and username only) |
| `reading_totals` (id, identity, day, pages, words, hours, seen_at); unique (identity, day) | B | new table | Your stats, the Continue row's daily background read, the nightly sweep (C) |
| `ebook_places` (id, identity, book_id, page, pages, read_at, seen_at); unique (identity, book_id); index on book_id | B | new table | the Continue row, a book's pop-up, the nightly sweep (C, opened books only, never over a real page) |
| Setting `insights.tracking_started` (internal) | B | `migrate_insights_started_v1` writes today's UTC date once | the migration |
| Settings `listening.hours_through`, `insights.kavita_swept_at`, `insights.kavita_sweep_error` (internal) | B, C | none | the rollup and the sweep |

**The hourly rollup.** Every complete UTC hour from 48 hours before the marker on is worked out again
from the log and replaces what was there, so check-ins that arrive late (a phone that synced afterwards)
still count. An hour older than that is final. The first run starts at the oldest log row. The first
statement is a write, so SQLite's write lock is held before the marker is read, and two workers cannot
both roll up. The log prune never deletes a row within 48 hours before the hourly marker.

Every writer runs after its route has done its own job. A database failure in a writer is logged (its
kind only) and rolled back, never raised to the person (`insights_store.best_effort`).

## 6. API routes

All are `GET`, under `/api/admin/insights`, in `app/routers/insights.py`, mounted with the other admin
routers in `app/main.py`. Every route depends on `require_admin` (401 signed out, 403 member, the
OpenAPI sweep in `test_settings_gate.py` covers them) and on the app limiter at 60 a minute. They only
read.

| Route | Answer | Cache |
|---|---|---|
| `/now` | `{listening: [...], reading: [...], unavailable, checked_at}` | none (the page asks every 30 s); Plex sessions 15 s |
| `/people` | `{people: [{key, name, last_active, last_what, listened_ms_30d, plex_ms_30d, current: [...]}], unavailable, tracking}` | 5 min |
| `/person?key=&tz=` | `{key, name, last_active, totals, weekly, books, requests, unavailable, tracking}`; 404 for an unknown key | 5 min |
| `/trends?period=&tz=` | `{period, bucket, buckets, active, top_books, top_authors, top_series, unavailable, tracking}` | 5 min |
| `/books?period=` | `{abandoned, never_opened: {count, items}, finish, unavailable, tracking}` | 5 min |
| `/book/{book_id}` | `{book_id, title, author, series, formats, people, totals, drop_off, requested_by, unavailable}`; 404 for an unknown book | 5 min |
| `/habits?period=&tz=` | `{split, heatmap (7 x 24, Monday first), requested: {total, read, items}, unavailable, tracking}` | 5 min |

- `period` is one of `30d`, `90d` (default), `1y`, `all`. Buckets: day for 30d, week (Monday) for 90d,
  month for 1y and all.
- `tz` is the browser's IANA zone, checked as Your stats checks it (`routers/book_discovery._zone`);
  anything unknown is UTC. Days, weeks, buckets and the heatmap are in that zone.
- `key` is `utils.identity_key(identity)`: 24 hex characters. The server finds the person by comparing
  keys of everyone it knows; an identity never reaches the browser.
- `unavailable` lists the sources that could not be read for this answer: `plex`, `kavita`. An answer
  with something unavailable is never cached.
- `tracking` gives the date each new kind of record began: `{requests, reading, ebook_places, hours}`.
- Errors: 4xx or 503 only. A database that cannot be read is 503 "Insights can't be read right now".

## 7. The page

`/insights`, served by `app/main.py` like `/settings`: signed out is redirected to `/login`, a member to
`/`, for a full load and for the router's soft navigation (`X-WS-Nav: 1`) alike. The raw
`/static/insights.html` is never served (`_StaticFiles`). It is a soft-navigation page with its own
module, `app/static/js/pages/insights.js`.

**Sidebar:** an "Insights" link with the `insights` icon and the sublabel "See reading and listening",
just above Settings, for admins only (section 2.1). On a phone it is a row in the More sheet.

**Header:** "Insights", then "Reading and listening across everyone. Only admins can see this page."

**Sections, each with its own skeleton and its own load:**

1. **Right now.** Who is listening (web player, and Plex apps from C) or reading (WebServarr's reader,
   C): name, book, playing or paused, where, how far. Refreshed every 30 s while the page is visible.
   Empty: "No one is listening or reading right now."
2. **People.** One row per person, most recently active first: name, "Last active 3 hr ago" (and what),
   time listened in the last 30 days (Plex part marked as an estimate), up to five current books with
   their progress. A row opens the person's history in the detail dialog: totals, 12 weekly bars (web
   and Plex apps, the Plex part labelled "estimate"), every book they touched with progress and time, and
   their requests. Empty: "No one has listened or read yet."
3. **Trends**, under the period picker: hours listened per bucket (web and Plex apps stacked, the Plex
   part labelled "estimate") with pages read per bucket beside it; active people per week; top books,
   top authors, top series. A book opens its detail.
4. **Books**, under the period picker: abandoned books (person, book, progress, last touched); never
   opened (count, then the newest 50 added); finish rate per book started by two or more people, with the
   drop-off chapter when two or more stopped in the same one. A book opens its detail: everyone's progress,
   time, finishes, drop-off and who requested it.
5. **Habits**, under the period picker: the web and Plex apps split as one bar with both figures in words
   (Plex labelled "estimate"); the time-of-day heatmap as a table (7 days by 24 hours, each cell's time in
   words for a screen reader, the busiest hour named above it); requested then read ("4 of 9 requested
   books were started by the person who asked", then the list, "matched by title").

**Period picker:** one control above Trends, Books and Habits, buttons for 30 days, 90 days, 1 year and
All time, `aria-pressed` on the chosen one. The choice is remembered in `localStorage` for this browser
(read and written inside try/catch; the page works without it).

**Buttons:** the page has no blue primary button. Its only buttons are the period picker, the dialog's
Close and a section's "Try again", all in the neutral style. This keeps Jordan's rule (at most one blue
primary button per view).

**Empty and new-tracking states:** a section with nothing to show says what it will show and, for data
that is new, "Tracking started on 11 Oct 2026" (the date from `tracking`, formatted in the browser).

**Unavailable:** when `unavailable` lists `plex`, the sections that use Plex show one line, "Plex isn't
answering, so listening in Plex apps is missing here.", and still draw what they have. `kavita` (C):
"Kavita didn't answer the last nightly read, so reading may be a day behind." A section whose own request
fails shows "This part couldn't load." with "Try again"; the other sections are untouched.

**Accessibility:** every chart is plain elements with its figures in words (as Your stats does); the
heatmap is a real table; the dialog is a native `<dialog>` opened with `showModal` (focus moves in, Escape
closes, focus returns to the row that opened it). Everything from the server is set with `textContent`.

**Mockup gate:** `docs/mockups/insights.html`, every section and the detail dialog at 390 and 1440, with
empty, new-tracking, unavailable and failed states. Jordan approves it before Tasks 8 and 9 start.

## 8. Performance

- **Two uvicorn workers, SQLite, Redis.** Nothing is held in a module between requests. Shared caches are
  Redis keys under `webservarr:insights:v1:`.
- **Heavy aggregates are cached in Redis for 5 minutes** per route, period and zone. An answer with an
  unavailable source is not cached, so the next load tries again.
- **Listening is read from the hourly table**, not the raw log: at most one row per person, hour, book and
  source. Only the hours since the last rollup (at most about two) come from the log.
- **No N+1 calls to Plex or Kavita per person.** A page load reaches Plex at most four times, all cached:
  the play history (one paged read, 10 min), track lengths (one read, 6 h), plex.tv people (two reads,
  1 h) and, from C, live sessions (one read, 15 s). It never calls Kavita. The Phase C sweep calls Kavita
  once per linked person per night, in the background, one person at a time.
- **SQLite IN lists** are chunked at 400 keys, as `book_catalog.live_editions` does.

## 9. Retention

| Data | Kept |
|---|---|
| `listening_log` | 180 days, unchanged |
| `listening_hourly` | 730 days (deleted by the daily log prune) |
| `listening_daily` | unchanged (all time) |
| `book_requesters` | 730 days after the request |
| `reading_totals` | 730 days |
| `ebook_places` | until 730 days after WebServarr last saw the place |
| `kavita_links` | one row per person, replaced at each connect |
| Redis answer caches | 5 minutes |
| Redis Plex caches | history 10 min, track lengths 6 h, people 1 h, sessions 15 s |
| Redis "reading now" | 5 minutes |

The 730-day prune of the new tables runs in the hourly Books pass (`book_discovery.refresh`).

## 10. Privacy wording

"Tell them, then show you": people are told, and the per-person views ship in the same change as the
wording.

- `app/static/books-stats.html` line 41: "Only you can see these." becomes "You and the admin can see
  these." (`app/tests/js/books_stats.mjs` pins the line and changes with it.)
- Code comments that promise owner-only visibility say the admin sees it on Insights:
  - `app/models.py` around lines 365 to 367 (the audiobook player block);
  - `app/models.py` around lines 683 to 685 (the Books discovery block);
  - `app/integrations/plex_player.py` around line 668 (`play_history`'s account ids);
  - `app/services/listening.py` lines 5 to 7 (the module docstring says a listener reads only their own
    rows; true for the player's routes, and it now names Insights as the admin's reader).
- The Books notice gains "So I can keep improving it, I can see what's read and listened to here." That
  notice is being redone separately; this plan does not edit it. The final task checks whether it has
  shipped and tells Jordan if it has not.
- `POPULAR_MIN` stays for the member-facing Popular shelf. Insights is admin only, so its counts are not
  floored.
- What reaches the browser: names, opaque keys, book titles and figures. Never an identity, an email, a
  Plex or Kavita account id, a token or a device id.

## 11. Error handling

- **Plex down or slow** (history, track lengths, sessions): the route answers 200 with what WebServarr's
  own records say and `unavailable: ["plex"]`; the page shows the Plex line in the sections that use it.
  plex.tv people unavailable: names fall back to "Account 1234"; nothing else changes.
- **No audiobook library configured:** Plex plays are an empty list, not unavailable.
- **Kavita down:** no page route calls Kavita. A failed nightly sweep records
  `insights.kavita_sweep_error`; answers then list `kavita` as unavailable until a sweep succeeds.
- **Database unreadable:** that route answers 503; the page shows "This part couldn't load." with Try
  again for that section only.
- **Writers** (requests, Kavita link, totals, places, rollup) never fail the route that called them.
- **Redis down:** caches are skipped and the answer is computed; the reading-now note is skipped.
- **Unknown person key or book id:** 404, and the dialog says "That person or book isn't here any more."

## 12. Testing

- **Python (unittest, in the dev container):** the migration on an old table and on a fresh one; the
  log's `source`; the hourly rollup (first run over the whole log, the current hour waiting, the 48-hour
  redo, final older hours, two devices at once, idempotence); the prune guard; each writer and its route
  hook; Plex history parsing and track lengths against an `httpx.MockTransport`; plex.tv people against a
  fake; every Insights aggregate on an in-memory database with fixed plays; the echo rule; the time-zone
  cases (midnight, a half-hour zone); empty installs; Plex unavailable; the router's admin, member and
  signed-out answers, caching and never caching a degraded answer; the page route's gate and the raw file
  404; the sidebar for admin and member; the sweep and the live notes with fakes.
- **happy-dom (`npm run test:js`):** the page module over its own markup with a scripted network: each
  section's first write, one section failing while others draw, the Plex line, empty and tracking
  states, text only, the dialog for a person and a book, the period picker and its memory, the 30 s
  refresh, and a page that was left.
- **Static tests:** the page is a shell page and a soft-navigation page (`SHELL_PAGES`, `CONVERTED`); its
  module reads through one `readLive` (one `getJSON(` call), uses `ctx` timers, writes text only; the
  icon-font test passes.
- **Live (ws-dev-browser):** admin and member, 390 and 1440, with dev kit seeds, at the end of each
  front-end task and once for the whole feature.

## 13. Risks

1. **Plex's history account ids** might not be the plex.tv ids (owner `1` is assumed). Task 4 proves it
   read-only; if it fails, Plex app listening stays out of Insights until Jordan decides.
2. **The echo rule** might drop a real Plexamp play when the same person also used the web player within
   the hour, or keep a web player play whose track ran longer than its length suggests. Both only move the
   Plex estimate, which is labelled.
3. **Kavita admin endpoints** for another user's stats and history are unverified. If they refuse the
   admin key, Phase C stops and the Phase B snapshots (from each person's own link) stay the only ebook
   source.
4. **Matching requests by title** misses a request whose Chaptarr title differs from the library's (a
   subtitle). Those show "not in the library yet".
5. **Reading totals across gaps:** a person who reads Monday to Friday and visits only on Friday shows
   all of it on Friday until Phase C's nightly sweep. Labelled as an estimate.
6. **Privacy:** the page shows everyone's habits to the admin. Mitigated by the wording (section 10), the
   admin-only gate on every way in, and the security audit.
7. **Load:** a long first rollup on a large log. The log holds at most 180 days and the first run happens
   once, in the leader's background pass.

## 14. Build order

The plan's tasks, in order: (1) listening tracking, (2) requests, Kavita link and reading snapshots,
(3) the mockup (Jordan gate), (4) Plex readers with the read-only proof, (5) the core API with the
privacy wording, (6) trends, books, book and habits, (7) dev kit seeds, (8) the page with Right now and
People (after Jordan approves 3), (9) Trends, Books and Habits (after 3), (10) the Kavita admin proof,
(11) the nightly Kavita sweep, (12) live sessions, (13) the whole-feature live check and CI.
