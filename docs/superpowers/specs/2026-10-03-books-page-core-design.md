# Books page, slice 3a: the core library

Sub-project 3a of WebServarr v2.0.0. Status: design approved in conversation 2026-10-03.
Slices 3b (My list, Up next, ratings, samples) and 3c (Recently added, Popular, stats, "New in
your series") get their own specs later.

It builds on the audiobook player (`2026-09-28-audiobook-player-design.md`) and on the work key
and matcher from `2026-09-30-audiobook-files-changed-design.md` and
`2026-10-03-audiobook-no-lost-place-design.md`.

## 1. Goal

The eBooks page becomes **Books**: one library covering ebooks (Kavita) and audiobooks (Plex). A
book that exists in both formats shows once, with both formats available. Listeners and readers
find a book, see what formats exist, and pick up where they left off in either one.

## 2. Decisions

- **One combined library.** An ebook and an audiobook of the same work are one entry. Each cover
  carries badges for the formats that exist.
- **Pairing is automatic, and an admin can override it.** Two items are paired only when their
  work keys match exactly. Anything uncertain stays as two entries. A manual pair or "keep apart"
  set in Settings always wins and survives every rebuild.
- **A tap on a cover opens a book page.** It does not start reading or playback straight away.
- **Search covers the library.** When nothing matches, it links to the site's Requests page
  with the search already filled in.
- **One mixed Continue row** on Books and on Home, newest first. A book in progress in both
  formats appears once, under the format touched last.
- **Browsing** is a cover grid with format chips and a sort. A series collapses into one card.
- **A stored catalog.** A database table rebuilt from Kavita and Plex. Each person's progress is
  always read live, never stored in the catalog.

## 3. Catalog

A **book** is one work: at most one ebook and any number of audiobook editions (the same book
narrated more than once). Listen offers the narrators of its editions; a person's place stays
per edition, as the player keeps it.

- **The ebook is one book in Kavita, not a Kavita series.** A series can hold a whole run of
  books. The unit is a numbered volume, or a chapter where Kavita keeps a standalone book as one
  (a special or a loose chapter). Its id is the **chapter** that is read (a volume's first), the
  id the catalog follows and the reader opens. The Kavita series name is the book's `series`
  (empty when it is just this book) and the volume number its `series_number`.
- **An edition is one Plex book** (album or album:disc, as the player keys it).

### 3.1 Table `books`

Each row is one work. Columns:
- `id`
- `work_key`: the primary edition's key, else the ebook's
- `title`
- `sort_title`
- `author`
- `series`
- `series_number` (nullable, decimal)
- `description`
- `kavita_chapter_id` (nullable): the ebook, as above
- `kavita_volume_id` (nullable): its numbered volume, null for a standalone book
- `kavita_series_id` (nullable)
- `kavita_library_id` (nullable)
- `plex_book_key` (nullable): the primary edition, the earliest added. The row's text comes from
  it first. Narrators are not on the row: they are on the editions.
- `added_at`: the earliest of all sources
- `ebook_added_at`
- `audio_added_at`: the earliest edition
- `cover_source`: kavita or plex
- `updated_at`
- `merged_into` (nullable): see Stable ids

At least one of `kavita_chapter_id` and an edition is set on a live book.

### 3.1.1 Table `book_audio_editions`

Each row holds:
- `book_id`
- `plex_book_key` (unique: an edition is in exactly one book)
- `narrator`
- `added_at`

### 3.2 Table `book_pair_overrides`

Each row holds:
- `kavita_chapter_id`
- `plex_book_key` (one edition)
- `action`: `pair` or `apart`
- `created_by`
- `created_at`

Rules:
- It is unique per (kavita_chapter_id, plex_book_key).
- A `pair` override joins one edition to an ebook whatever their work keys say.
- An `apart` override keeps one edition out of that ebook's book even when the keys match.
- An edition is in at most one `pair` override: a new pair for the same edition replaces the old
  one. An ebook may be paired with several editions.

### 3.2.1 Pairing

- An ebook takes **every** edition whose work key equals its own, when it is the only ebook with
  that key. Two ebooks with one key are too uncertain: neither takes the editions.
- Editions with the same work key and no ebook are one book with several editions.
- An edition an override names never joins by key; the rest follow the rules above.
- Kavita titles carry the series in ways audiobook titles do not. Before the work key is made, a
  leading "<series> NN - " or "<series> Book N: " and a trailing ": <series>" or "(<series> #N)"
  come off the ebook's title (the title shown is unchanged).
- A Kavita book with no writer takes the author its series' other books agree on, or failing
  that the other books kept in the same folder. Kavita's "authors_sort" placeholder is not an
  author, and an author Kavita split at the comma ("Maas", "Sarah J.") is put back together.

### 3.3 Rebuild

- **When it runs:**
  - every 15 minutes in the existing background service;
  - right after a Chaptarr import webhook;
  - on demand from Settings ("Rebuild now").
- **How it runs:**
  1. It reads every book in Kavita (volumes and chapters, with their writers) and the Plex
     audiobook section listing (the player's books, with the player's work key for each).
  2. It computes work keys with the same matcher the player uses.
  3. It applies the overrides and writes the result in one transaction.
- **Only one rebuild runs at a time** across the two workers, using a lock row or an advisory
  file lock. A second request while one is running is a no-op.
- **Keep the last good catalog.** If either source fails, its side of the catalog is left as it
  was. Rows from that source are never deleted on a failed read. Only a successful read of a
  source may remove that source's rows that have gone.
- **Stable ids.** A book keeps its `books.id` across rebuilds whenever its Kavita chapter id or
  one of its editions' Plex keys is unchanged. Links and the Continue row depend on this.
  - When items that were in different rows become one book, the row that held an edition (the
    lowest id) is kept. The others stay behind as ghosts (`merged_into` set to the survivor, the
    ebook or edition key they held remembered), so an old link redirects to the right book.
  - When a book splits, the side that leaves gets its ghost back (revived), or a new row if it
    has none. A ghost whose book is gone goes with it. Ghosts never show as books.

## 4. Pages

All pages are page modules in the soft-navigation shell. They follow the design contract in
`UI-DESIGN-REVIEW-2026-08-15.md` Part 5:
- skeletons reserve their layout;
- content arrives top-down;
- the theme is applied through variables only;
- the mobile scroll hint is present;
- layouts work at 320 px.

### 4.1 Books (`/books`, replacing the eBooks route; the old route redirects)

1. **Search box.**
2. **Continue row** (section 6).
3. **Library grid.**
   - Format chips: All, Ebooks, Audiobooks.
   - Sort: Recently added (default), Title, Author.
   - Format badges on every cover.
   - A series appears as one card with its cover, name and book count, and opens the series
     page.
   - Books not in a series appear individually.
   - The grid is paged or progressively loaded so it stays fast with hundreds of books.
4. **Help button and first-visit guide.**
   - A help button beside the search box runs a four-step guide (the shared coach-mark engine,
     `tour.js`): search, the Continue row, the format chips, and opening a book (where Read and
     Listen live).
   - It starts by itself once, on a person's first visit, when the books are on screen. It is
     marked seen as soon as it has been shown, per person on that browser.
   - It never holds up the page: its layer is fixed, so nothing moves, and the page stays usable
     under it. A step with nothing to point at (no Continue row yet) is shown in the middle.

### 4.2 Book page (`/books/<id>`)

- **Shows:** cover, title, author, narrator, series name and number, description.
- **Read:** opens Kavita's reader at the reader's own saved place, through the existing reader
  view and hand-off.
- **Listen:** opens the player for the audiobook, and its normal resume rules apply.
- Each button shows the person's progress in that format.
- **A missing format** shows "Request the audiobook" or "Request the ebook", linking to the
  site's Requests page with the title (and author) prefilled.
- The author, narrator and series names are links to their pages.

### 4.3 Author, narrator and series pages

- `/books/author/<name>` and `/books/narrator/<name>` show a grid of that person's books.
- `/books/series/<name>` lists the series in reading order by `series_number`, with books that
  have no number last. Each entry shows its format badges and the person's progress.
- Names are matched case-insensitively after normalising whitespace.

## 5. Search

- **Fields:** title, author, narrator and series.
- **Matching:** case- and accent-insensitive substring matching, ranked with title matches first,
  then series, then people.
- **Results:** they appear as you type, with a short debounce.
- **No matches:** the page shows "Can't find it? Request it", linking to
  `/requests?q=<the search>`. The Requests page must read `q` and run that search on load; add
  that if it doesn't already.

## 6. Continue row (Books and Home)

- **What's in it:**
  - books with an unfinished place;
  - an ebook in progress in Kavita;
  - an audiobook with a saved player place that is not finished.
- **Order:** most recent activity first, at most 12 entries.
- **A book in progress in both formats** shows once, under the format with the newer activity.
- **Each card** shows the cover, a format badge, and progress: "Ch. 12 · 43%" for ebooks, or
  "2h 10m left" for audiobooks.
- **Tapping a card** (its cover or words) opens the book's own page. A round play button centred on
  the cover (shown on hover or focus with a mouse, always on touch) resumes in that format: the
  player for an audiobook, the reader for an ebook.
- **Home** shows the same row in a compact form, as its first section. If the person has
  nothing in progress, the row is hidden; it is also hidden, and never asked for, while the Books
  page is off. A note about a source (Kavita down, not connected) shows under the row; the "not
  connected" note links to Books, which runs the sign-in.
- **No layout shift.** Whether a person has a row (and a note) is remembered per person, so a
  person who had one last time gets its room from the first paint. A book started with Listen
  tells the next visit at once.

## 7. Admin: pairing in Settings

- A "Books" tab in Settings lists the catalog's unpaired ebooks and audiobook editions, the
  matched books, and the current overrides.
- From it an admin can:
  - pair an ebook with one audiobook edition (pick one of each);
  - keep one edition of a matched book apart from its ebook;
  - remove an override.
- A change shows at the next rebuild, and the tab says when one is waiting.
- It also shows when the catalog was last rebuilt, the count from each source, any source errors,
  and a "Rebuild now" button.
- Admin only (a member is sent away from Settings, and every admin route answers 403).
- The settings the catalog needs sit on their own cards under Integrations, so each saves with
  its address:
  - **Kavita** takes an API key (write-only: it shows "Saved", never the value). It is paired
    with the Kavita address (`ADDRESS_CREDENTIALS`): a new address needs the key entered again
    in the same save, and an import that moves the address clears it.
  - **Chaptarr** shows this site's webhook address (built from the address the page was opened
    at) and a webhook secret. The secret is made in the browser, shown once so it can be copied,
    and afterwards only "Saved". The steps to give Chaptarr are written beside it.

## 8. Errors

- **Kavita unreachable.** The catalog still shows. Read buttons and ebook progress are disabled
  with "Ebooks are unavailable right now".
- **Plex unreachable.** The same, for Listen and audiobook progress.
- **No catalog yet** (a first run whose rebuild hasn't finished). The page shows a building state,
  not an empty library.
- **Status codes.** Every endpoint returns 4xx or 503, never 500.
- **Scoping.** All per-person data (progress, Continue) is scoped by identity.
- **Hidden items stay hidden.** Kavita libraries a user cannot see in Kavita must not be shown
  to them. If Kavita's per-user library access can't be read, ebooks are filtered to the
  libraries the user's Kavita account can reach. Audiobooks follow the existing player access
  rules.

## 9. Testing

- **Python:**
  - rebuild: pairing by work key, overrides (pair, apart, replace), keep-last-good on a failure
    of either source, stable ids, the single-runner lock under two processes;
  - search ranking and normalisation;
  - the Continue merge and ordering;
  - the per-user Kavita library filter;
  - status codes;
  - the migration on an existing database.
- **Node runtime:**
  - each page module: skeleton, render, chips and sort, the empty-search request link, and the
    disabled-format states;
  - the Continue row.
- **On dev,** at 1440 and 320 px, with the real library:
  - Books, a book page in both formats, a series page in order;
  - search and its request link;
  - Continue on Books and Home;
  - pairing and unpairing in Settings;
  - Kavita down and Plex down (simulated).

## 10. Out of scope (later slices or never)

- **3b:** My list, Up next, ratings, try a sample.
- **3c:** Recently added with New badges, Popular, listening stats, "New in your series" push.
- **Not chosen:** bookmarks, offline downloads, per-book speed, genre shelves, sharing,
  mark finished/restart.

## 11. How it is built

Subagent-driven:
- `coder` (or `webdev` for the UI tasks) builds each task;
- one `bug-hunter` reviews each task's diff, with no re-review of fix rounds;
- one final whole-branch `bug-hunter` review.

The task split is about five tasks:
1. catalog and pairing;
2. the APIs;
3. the Books page;
4. the book, person and series pages;
5. Home, the admin panel and the live check.
