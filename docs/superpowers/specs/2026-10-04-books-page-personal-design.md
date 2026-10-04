# Books page, slice 3b: personal features

Sub-project 3b of WebServarr v2.0.0. Design approved in conversation on 2026-10-04.

It builds on:
- 3a, the books core (`2026-10-03-books-page-core-design.md`);
- the audiobook player (`2026-09-28-audiobook-player-design.md`), plus the 2.5 and 2.6 specs.

The data spike behind these decisions is `.superpowers/sdd/3b-spike.md`.

## 1. Goal

Each person can keep a list of books they want, queue what comes next, rate books, and try a
sample before starting. All of this works per book, in either format.

## 2. Decisions

- **My list.** Stored in WebServarr, per person and per catalog book. Kavita's Want to read is
  not used: it only holds whole series, and it can't hold audio-only books.
- **Up next.** A per-person queue in WebServarr. When an audiobook ends, the first queued
  audiobook is offered ("Up next: <title>, Play") and waits for a tap. It takes priority over the
  existing series offer. Ebooks in the queue form a read-next list and never open by themselves.
- **Ratings.** 1 to 5 stars per person and book. WebServarr stores them, is the source of truth,
  and is what the site shows. Each rating is also written to Kavita (the book's chapter rating)
  and to Plex (every audiobook edition of the book, `rating = stars × 2`), using the person's own
  Kavita link and Plex token. Clearing a rating clears it in all three.
- **Try a sample.** Nothing is saved anywhere. Audio plays 5 minutes from the start of the
  preferred edition. An ebook opens its first chapter read-only.

## 3. Data

All tables are scoped by identity. Migrations follow the existing style and are safe with 2
workers starting at once.

| Table | Columns | Notes |
|---|---|---|
| `book_list` | identity, book_id, added_at | unique (identity, book_id) |
| `book_queue` | identity, book_id, position, added_at | unique (identity, book_id); positions are dense from 0 |
| `book_ratings` | identity, book_id, stars (1-5), updated_at, kavita_state, plex_state | each state is `ok`, `pending` or `failed:<reason>` |

**Merged books.** When a catalog rebuild merges a book (`merged_into`), its list, queue and rating
rows move to the surviving id in the same transaction:
- duplicates collapse;
- in the queue, the earlier position wins;
- for ratings, the newer rating wins.

**Removed books.** Rows for a book that has left the catalog are kept but hidden, and come back if
the book returns.

## 4. My list

- **Book page:** an "Add to My list" / "On My list" toggle.
- **Books page:** a "My list" row, newest first, with format badges. It is hidden when the list is
  empty.
- **Visibility:** respected exactly as in 3a.

## 5. Up next

- **Adding.** "Add to Up next" on the book page appends the book to the queue. If the book is
  already queued, the page shows its position and a Remove button.
- **The Books row.** An "Up next" row on Books shows the queue in order. Each entry has Move up,
  Move down (keyboard accessible), Remove, and Play or Read.
- **When an audiobook ends.** The player offers the first queued audiobook the person can access,
  other than the one that just ended. Nothing starts without a tap.
  - The queued offer replaces the series offer for that ending.
  - Playing a queued book removes it from the queue.
  - The offer never opens a book while the player is holding (Find your place, a conflict, or
    files changed). It goes through the normal open path, so all of the 2.5 and 2.6 rules apply.
- **Editions.** The edition is chosen at play time: the preferred edition, by the same rule as the
  3a book page.
- **Exclusions.** A sample never touches the queue. Ebook entries never open on their own.

## 6. Ratings

- **On the book page.** Stars from 1 to 5, keyboard accessible, plus a clear option. Only the
  person's own rating is shown; there are no averages and no one else's ratings.
- **Saving.** The WebServarr row saves first and the page updates at once.
- **Write-through.** Each target is then written in the background.
  - **Kavita:** the chapter rating, using the person's Kavita link. With no link, the write waits
    (`pending`) until the next time a link exists.
  - **Plex:** `PUT /:/rate` for each edition's item, using the person's Plex token. Clearing sends
    Plex's clear value.
- **Failures.** A failed write is marked `pending`. It is retried on the next rating change, on a
  visit to that book page, and in the background loop, with backoff and a limit. A failure never
  blocks or reverts the WebServarr rating.
- **Proxy allowlist.** Extend it only for the exact Kavita rating endpoints the server uses. The
  browser never calls Kavita's rating endpoints directly.

## 7. Try a sample

- **Audio: "Try a sample".**
  - Pauses the main player.
  - Plays from 0:00 of the preferred edition in a separate engine instance with no saver.
  - Stops at 5 minutes or when the person stops it.
  - Never writes a WebServarr place, a Plex timeline or a scrobble, and never touches the queue.
  - Shows a "Sample" label, a stop control and the time left.
- **Ebook: "Read a sample".**
  - Opens the reader on the book's first chapter in sample mode.
  - Doesn't restore or save progress; bookmarks are off.
  - A "Sample" banner offers "Start reading" (normal Read) and "Close".
  - The browser enforces this; accepted as is.
- **Availability.** Each button appears only for a format the person can access.

## 8. Errors

- Responses are 4xx or 503 only, never 500.
- Every route is scoped by identity and validates input like the 3a routes.
- **When Kavita or Plex is down:**
  - list and queue still work;
  - a rating saves and its write-through waits;
  - samples for that format show "unavailable right now".

## 9. Testing

- **Python:**
  - list, queue and rating create, read, update and delete;
  - queue ordering, including concurrent reorders;
  - merge moves;
  - identity isolation;
  - write-through against fake Kavita and Plex (success, refusal, retry, clear);
  - the migration under 2 workers.
- **Node runtime:**
  - the book page buttons and stars;
  - the My list and Up next rows;
  - the ended offer takes priority and never auto-starts;
  - the sample engine sends no check-in or timeline, stops at 5 minutes, and pauses the main
    player;
  - the reader's sample mode makes no progress POST.
- **One live check on dev at the end, using the dev test kit:**
  - add a book to the list and the queue, then reorder the queue;
  - finish a short listen and see the queued offer;
  - rate a book, verify the rating in Kavita and Plex, then clear it;
  - try both samples and confirm on the network that nothing is written;
  - restore everything afterwards.

## 10. Out of scope

- Averages and popularity (3c).
- Sharing lists, or more than one list per person.
- Importing Kavita's Want to read.
