# Books page, slice 3c: discovery

Sub-project 3c of WebServarr v2.0.0. Status: designed by the orchestrator on 2026-10-04 with
defaults. Jordan delegated this ("3c with my defaults") while away and will review it on dev.
Anything he wants changed becomes a follow-up. This builds on 3a and 3b. The data spike behind
the decisions is `.superpowers/sdd/2026-10-04-books-page-discovery/3c-spike.md`.

## 1. Goal

Help people notice what's new, what others on the server are enjoying (without exposing anyone),
and their own listening, and tell them when the next book in a series they follow arrives.

## 2. Decisions and defaults

1. **Recently added.** A shelf on Books shows the 12 newest books added in the last 30 days.
   - A book's "new" date is the later of its ebook date and its audio date. That way a format
     added later (Queen of Shadows, ebook added 10-04) still counts as new.
   - A **New** badge shows on books added since the person's previous visit. No badges on a
     first visit.
2. **Last visit.** Recorded per person in a new table, `book_visits`:
   - `identity` and `email`;
   - `seen_at` and `prev_seen_at`.

   A visit is a load of the Books page. `prev_seen_at` rolls forward when the last visit is
   more than 30 minutes old, so that browsing doesn't clear badges mid-session. The email
   column also closes the identity-to-email gap for notifications.
3. **Popular on the server.** Audio only for now.
   - The count is distinct people per book over 90 days, from WebServarr's own listening data
     (positions and log), plus Plex play history read with the admin token.
   - A book shows only when **at least 3 different people** listened, so it can never point to
     one person.
   - Only the book and a rounded count are shown ("3+ listeners"); never who.
   - Counts are computed at most hourly and stored in a table, not a module cache.
   - The shelf is hidden when nothing qualifies, which is the case today because no one has
     listening history yet.
   - Ebook popularity is **deferred**. The admin API can't count readers per book, and counting
     through the proxy would break the rule that WebServarr stores no reading state.
4. **Listening stats.** Private, own identity only, shown on a "Your stats" panel reached from
   Books:
   - time listened (last 6 months and all time);
   - books finished;
   - current streak (days in a row with listening);
   - time per week (last 12 weeks);
   - top authors.

   **Rollup:** a daily rollup table, `listening_daily(identity, day, ms, books)`, is filled
   before the 180-day log prune. All-time totals survive the prune this way; if the rollup
   didn't exist, they would be lost.

   **Reading stats:** pages and time from Kavita, read through the person's own Kavita link.
   They show only while the link is live. Otherwise the panel shows a quiet "Connect your ebook
   library to include reading" note.
5. **New in your series.**
   - **Following a series.** A person follows a series when any of these is true:
     - they started an earlier book in audio (at least 5 minutes);
     - any book of the series is on their My list;
     - they pressed **Follow** on the series page. This explicit toggle covers ebook-only
       readers. There is an **Unfollow** too.
   - **Ebook readers.** Following from ebook reading is recorded opportunistically: when the
     Books Continue row sees an in-progress ebook through the person's live link, the person
     follows that series.
   - **Detecting new books.** After each catalog rebuild, the newly added books are diffed
     against a `book_announced` table.
     - That table is seeded at deploy so the existing 22 books are never announced.
     - Only a book with a series_number higher than the one the person has reached triggers a
       notification. Unnumbered books never do.
   - **Delivery.** One grouped notification per person per series per rebuild ("New in Harry
     Potter: 2 books"), through the existing notification and push system, with the email taken
     from `book_visits`.
   - **Preference.** A new "Books" category in the existing preferences modal, on by default.

## 3. Data

These are new tables. They follow the existing migration style, are safe with 2 workers, and
every one is scoped by identity.

| Table | Columns |
|---|---|
| `book_visits` | identity (unique), email, seen_at, prev_seen_at |
| `book_popularity` | book_id, listeners (int), computed_at |
| `listening_daily` | identity, day, ms, books_touched; unique on (identity, day) |
| `book_follows` | identity, series, source (`listen`, `list`, `manual`, `read`), created_at; unique on (identity, series) |
| `book_announced` | book_id, announced_at |

When books merge, follows and visits need no change: follows are keyed by series name.

## 4. Pages

**Books shelves, top to bottom:**
1. Continue
2. Up next
3. My list
4. Recently added
5. Popular on the server
6. the library grid

Shelves with nothing to show are hidden. Every shelf reserves its space using the 3a pattern, so
CLS stays at 0.

**Series page:** a Follow/Unfollow toggle.

**"Your stats":** a page at `/books/stats`, linked from Books. It uses simple bars made with CSS
and theme variables only, no chart library, and works at 320 px.

## 5. Errors

- Responses are 4xx or 503 only, never 500.
- **Plex history unavailable:** popularity uses WebServarr data alone.
- **Notifications:** a failed push never blocks a rebuild. Delivery is retried by the existing
  poller pattern.
- **Privacy:**
  - No endpoint ever returns another person's identity, email or per-person data.
  - Popularity responses never include a count under 3.

## 6. Testing

- **Python:**
  - the New-badge window logic;
  - the visit roll-forward;
  - popularity: the floor of 3, the 90-day window, the Plex fallback;
  - the rollup before the prune;
  - stats maths;
  - follows from each source;
  - announce diffing and grouping;
  - seeding;
  - notification preference gating;
  - identity isolation;
  - migrations.
- **Node runtime:** the shelves, the badges, the stats page, and the Follow toggle.
- **Live check on dev** with the dev test kit: seed listening for 3 test identities so Popular
  appears; seed a visit to show New badges; run a simulated import (a test catalog row) so a
  follower gets a grouped notification. Restore everything afterwards.

## 7. Open points for Jordan (defaults applied, easy to change)

- Popularity floor 3, window 90 days, ebooks excluded for now.
- Rollup of listening into daily totals.
- Explicit Follow on series pages.
- "Books" notifications on by default.
