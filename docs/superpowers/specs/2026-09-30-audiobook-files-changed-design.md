# Audiobook files changed: keep the listener's place

Sub-project 2.5 of WebServarr v2.0.0. Status: design approved in conversation 2026-09-30.
It builds on the audiobook player (spec `2026-09-28-audiobook-player-design.md`, "the player
spec"). Its rules on saving, the save floor, compare-and-swap (11b) and format blocking (11a) all
still apply.

## 1. Goal

An operator sometimes deletes an audiobook's files and replaces them: to fix audio quality,
change format, merge parts into one file, split one file into parts, or swap editions. After
that, a listener must not silently lose their place or their listening history.

The new files may be split differently from the old ones. Their chapters may differ, and they
may even be a different recording, so the player never assumes the old place maps onto the new
files. It keeps the old place safe and helps the listener find the spot.

Also in scope: the parked PR3. A Plex-app question left open while the Plex app moves on is
answered with a stale place.

## 2. Decisions

- Every save and every history row also records where the listener was in terms that survive a
  file change:
  - book time: ms from the start of the book;
  - the book's total length, so the place can also be read as a percentage;
  - the chapter name of that copy;
  - the narrator;
  - a work key identifying the book independently of its files.
- When the saved file no longer exists in the book, the player opens a "Find your place" helper.
  It never jumps on its own. Nothing is saved, and the old place stays stored untouched, until
  the listener confirms a spot.
- A book that reappears as a new Plex album inherits the earlier copy's place and history
  automatically, but only when the earlier album is gone from the library. Resume then goes
  through the helper. Editions that exist side by side (for example two narrators of one title)
  are never merged.
- History entries show book time, percentage and that copy's chapter name. Tapping an entry
  whose file is gone opens the helper at that spot.

## 3. Data

Five more nullable columns go on `listening_positions` and `listening_log`, following the
project's migration style:

| Column | Meaning | Written by |
|---|---|---|
| `book_ms` | ms from the start of the book | the player (it already knows it), clamped by the server to 0 through `book_duration_ms` |
| `book_duration_ms` | the book's total length when saved | the server, from the album it already reads on every check-in |
| `chapter_label` | that copy's chapter name at the place (max 200 characters) | the player |
| `work_key` | a stable identity for the book | the server |
| `narrator` | the narrator of that copy | the server |

- **Work key.** It is a hash of the normalised author plus the normalised title. Normalising
  lowercases, strips punctuation, and removes edition and format suffixes such as "(Full-Cast
  Edition)", "Unabridged" and narrator suffixes. It reuses the title normalising already in the
  next-in-series code where possible.
- **Existing rows.** They keep nulls. The player is not in production yet, so there is no real
  data to convert.
- **Check-in body.** It gains optional `book_ms` and `chapter_label`. Validation follows the
  existing rules: types, bounds, string length, and the JSON-walk guard.

## 4. Detecting a change

- **Files changed within the same album.** When `open()` meets a saved track that is not in the
  book (today's `UnknownTrack`), the player opens the helper instead of the "Couldn't find your
  saved place" notice and the fallback to 0. The same applies to a resume copy (web, local or
  Plex) that names a missing track.
- **Re-added as a new album.** When `GET /api/player/position/{key}` finds no row of the
  listener's own for `key`, the server looks for the listener's rows with the same `work_key`
  under a different book key whose album is no longer in the library. The newest such row is
  returned as the web copy with `linked_from: <old key>`. The player treats it as "files
  changed" and opens the helper.
- **Scoping.** Every lookup is scoped by identity, exactly like every other query.

## 5. The "Find your place" helper

A panel in the full player that holds playback and saves while it is open, the same way the
conflict question does.

- **What it shows about the old place:**
  - the book time, for example 3:12:40;
  - how far through the book it was, for example 64%;
  - the old chapter name;
  - when it was last listened to.
- **Two candidate spots in the current copy:**
  - "Same time": the same book time, clamped to this copy's length.
  - "Same point in the book": the same percentage of this copy's length.

  Each shows the current copy's chapter at that spot, by this copy's own chapter names. When the
  two candidates are within 5 s of each other, only one is shown.
- **Preview:** plays 15 s from a candidate without saving anything.
- **Nudge:** a scrubber moves the chosen candidate before confirming.
- **Use this spot:** confirming is an explicit move. It saves (it ends the floor, and CAS applies
  as usual), and the helper closes.
- **Other choices:**
  - "Show history" opens the history list.
  - "Start from the beginning" is also an explicit move.
- **Missing data, undecodable spots.** If the old place data has no `book_ms`, which is the case for rows
  saved before this change, the helper shows only history and "Start from the beginning". A
  candidate in a part this browser cannot decode is shown as unavailable.
- **Order with other questions.** The helper comes first. Once it has been answered, the handoff
  and conflict rules apply as usual, using the confirmed spot.
- **Lock screen.** While the helper is open, a lock-screen Play is held exactly like the
  conflict question holds it. The old place is never overwritten until the listener confirms.

## 6. History

- **Entries show:**
  - book time;
  - percentage;
  - that copy's chapter name;
  - the device;
  - the time.
- **Earlier copies.** Entries from an earlier copy, linked as in section 4, are listed with an
  "earlier copy" label.
- **Tapping.** An entry whose track still exists jumps as it does today. An entry whose track is
  gone opens the helper, with that entry as the old place.

## 7. PR3: a Plex-app question left open

When the listener answers a Plex-app question that has been showing for more than 2 minutes,
the player first reads the position again. If the Plex app's place has moved on, the question
updates to the new place and nothing is acted on. A read that fails or times out after 4 s keeps
the question as it is and lets the listener answer again.

## 8. Error handling

- A missing `book_duration_ms` on the old place means no percentage candidate.
- Clamping keeps every candidate inside the current copy's length.
- The helper never saves on its own. Closing the tab keeps the old place as it is, and the
  helper opens again at the next open.
- Server lookups for linked copies are bounded, indexed on `(identity, work_key)`, and never
  return another identity's rows.

## 9. Testing and acceptance

- **Python:**
  - the new columns;
  - check-in validation and clamping;
  - work key normalising, with editions kept apart;
  - linked lookup only when the old album is gone;
  - identity isolation;
  - the migration on an existing database, under two workers at start-up.
- **Node runtime:**
  - the helper opens on a missing track and on a linked copy;
  - both candidates, the within-5 s merge, clamping, preview with no save, nudge, confirm saves
    as an explicit move;
  - closing keeps the old place;
  - lock-screen Play is held;
  - the order with the conflict question;
  - history labels and taps;
  - PR3 re-read and update, and its failure path.
- **On the dev instance:**
  - with a test book, rename its file so Plex sees a new track: the helper opens, the preview
    plays, confirming saves, and the old place is intact before confirming;
  - move a test book to a new album: its history and place are inherited, and a side-by-side
    edition is not merged;
  - PR3 with a simulated Plex-app place.
  - Restore every file and all Plex state afterwards.

## 10. Out of scope

- Matching audio content between copies, such as fingerprinting.
- Carrying a place between two editions that both stay in the library.
- Converting existing rows.

## 11. How it is built

The same loop as the player:
1. `ws-coder` implements each task on `dev`.
2. One `ws-bug-hunter` checks each changed file.
3. Proven bugs go back to the coder until the hunt is clean.
4. A final whole-branch review closes the work.
