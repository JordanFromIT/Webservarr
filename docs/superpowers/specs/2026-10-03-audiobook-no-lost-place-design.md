# Audiobooks: no lost place, ever

Sub-project 2.6 of WebServarr v2.0.0. Status: design approved in conversation 2026-10-03.
It builds on `2026-09-30-audiobook-files-changed-design.md` ("the 2.5 spec") and the player spec
(`2026-09-28-audiobook-player-design.md`). All of their rules still apply unless changed here.

## 1. Goal

The 2.5 build left four low-severity gaps parked. The owner's rule is that a book must never
break: no lost place, no wrong place, no out-of-order tracks. This closes all four.

1. The work key is a heuristic. Some renames are not matched, so a re-added book does not inherit
   its place (a miss), and some different works share a key (a false match).
2. A side-by-side edition can still be offered an earlier copy's place, through a two-worker race
   or after a Plex failure during the first copy's confirm.
3. A pathological stall pattern can stretch a preview beyond its budget.
4. Track numbers of 7 or more digits sort out of order.

## 2. Decisions

- **The work key becomes a hint, not the only path.** Automatic linking stays as in the 2.5 spec.
  A manual safety net (section 3) catches every miss, so the matcher can favour precision over
  recall.
- **One successor per earlier copy, enforced by the database**, including claims that could not
  yet be verified (section 4).
- **A hard wall-clock ceiling on previews** (section 5).
- **Natural sort compares numbers by length, then digits** (section 6).

## 3. The safety net: "Were you listening to one of these?"

- **When it shows.** A book opens and the listener has no place of their own for it, and no linked
  earlier copy is offered (2.5 spec section 4). The player then asks the server for the listener's
  *orphaned places*.
- **Orphaned place.** One of the listener's own position rows where all of these hold:
  - its book is gone from the library (the book's key, album and disc, is not in the library's
    listing: a disc that left a box set that stayed is gone);
  - it is not finished: the latest event is not an `end` mark (a book listened to again after
    its end is a place again), and its `book_ms` is under 97% of its `book_duration_ms` when
    both are known;
  - it has no successor still in the library and no pending claim (section 4).
- **Bounds.** The newest 200 unfinished rows by `updated_at`, one listing of the library per
  request (every presence check is made against it, in memory, chains of any length included),
  and at most 10 places returned. Scoped by identity. Rows by the same author as the opened
  book come first, then by recency.
- **What the listener sees.** Before the player plays anything, a panel in the full player titled
  "Were you listening to one of these?". Each row shows the old title, the narrator, the book time
  and percentage, and when it was last listened to. There is also "None of these".
- **Picking one.** It becomes the earlier copy and goes through the 2.5 helper exactly as an
  automatically linked copy does: the book is held, nothing is saved, and the listener confirms a
  spot. Confirming stores `linked_from` with a `manual` flag. The server accepts a manual link
  when the old album is gone and the successor rule (section 4) allows it. It does not require a
  work-key match.
- **"None of these".** It is stored on the server per listener and book key, so it holds on every
  device. The question never shows again for that book. The book then opens as a new book.
- **Errors.** If the orphan lookup fails (503 or timeout), the book opens as it does today, and
  the question is asked at the next open.
- **History.** Entries from a manually linked copy show the "earlier copy" label, as in the 2.5
  spec section 6.

### Matcher precision

The safety net now catches misses, so the matcher is tightened to remove false matches:
- Vol., Book and No. are distinct kinds ("Vol. 2" no longer equals "Book 2").
- Number words (one to twenty), ordinals and Roman numerals are read wherever a book number can
  appear, including after non-marker words and in a "Read by" part.
- Per-disc keys of a multi-disc album include the album's own work title (its work key's text,
  not its Plex key, which a re-added album does not keep), so two different albums whose discs
  share a title never share a key, and a box set re-added under the same title still does.
- Numbers that go with a dropped narrator part ("Read by X, Series 2") become tokens of their own
  kind, and a token is a punctuation mark, so no title can spell one.
- In the narration ("Read by ...") only the narrator's name is dropped: numbers of any size
  (words, other scripts' digits, Roman numerals), single capital letters, text after a colon,
  dash or closing bracket and any segment that holds a number all stay. Accents are folded for
  Latin letters only (kana voicing is a difference). A symbol that is a digit but has no decimal
  value is a word, and a title no key can be made of is a book with no key, never an error.
- A re-rip's noise is folded: a bracketed year, format or bitrate tag, ASIN, "(Unabridged)"
  wherever it stands, leading zeros, and the size of a set ("Book 2 of 5" is "Book 2"). Other
  productions ((Graphic Audio), (BBC Radio 4), (Audible Original)) and Vol., No. and Part against
  Book stay different.
- The author is kept with each place (position row), so the orphan lookup can put the same
  author first; rows saved before it was kept sort by recency only.
- The disc-1 gap of a re-added box set (2.5 ledger T1S5) is closed by reading the album's tracks
  whenever the album-level pre-check misses. It stays within the existing read bound.

## 4. One successor per earlier copy

- **Claims.** A confirm that carries `linked_from` writes a claim for that earlier copy in the same
  transaction as the save. A unique index on (identity, claimed earlier key) ensures only one book
  key can hold the claim.
- **Unverified claims.** If verification fails (Plex unavailable), the claim is stored as pending
  and the response is `linked: null`. A pending claim blocks other copies exactly like a verified
  one. It is re-verified at the next check-in for that book, whether or not the request carries
  the link (the browser may have lost it, or the listener moved to another device): if it
  verifies, it becomes verified and the row keeps the link; if the old album turns out to be
  present again, it is dropped; if Plex is unavailable, it stays pending. A request that carries
  the link is answered `linked` true, false or null as before; one that does not gets no `linked`.
- **Successor rule.** An earlier copy is offered (automatically or in the safety net) only when no
  other book key holds a claim on it, verified or pending, whose album is still in the library.
  A claim whose holder's album is also gone does not block, so chains keep working (A to B to C).
- **Race.** Two concurrent confirms for different book keys claiming the same earlier copy: one
  wins, and the other gets `linked: false` with its own place saved normally, unlinked.

## 5. Preview ceiling

A preview stops when its 15 s budget is used (book time plus wall clock, stalls free, as now), or
after 60 s of wall clock since it started, whichever comes first. Nothing is saved, as now.

## 6. Natural sort

Digit runs compare by value: strip leading zeros, then compare by length, then by the digits.
Runs of any length must never raise. Order for names with runs of 1 to 6 digits is unchanged.

## 7. Testing

- **Python:**
  - orphan lookup: scoping, bounds, unfinished filter, author-first order, successor and claim
    exclusion;
  - "None of these" persistence;
  - manual link acceptance and refusal;
  - claim uniqueness under two concurrent workers;
  - pending claim lifecycle;
  - matcher precision cases (each 2.5 parked T1 item gets a test);
  - natural-sort fuzz against the old order for runs of 1 to 6 digits.
- **Node runtime:**
  - the safety-net panel: shows only when ruled, nothing saved or played while it is open, a pick
    leads into the helper, "None of these" stays dismissed;
  - lock-screen Play while it is open;
  - a reload while it is open;
  - the preview ceiling under a stall pattern.
- **On dev:** the safety net with a test identity's rows pointing at a book key that is not in the
  library; restore afterwards. No new copies in the Plex library.

## 8. Out of scope

Matching audio content between copies, and carrying a place between editions that both stay in
the library (unchanged from the 2.5 spec).
