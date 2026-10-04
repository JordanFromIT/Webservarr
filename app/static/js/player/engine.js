/**
 * WebServarr — audiobook playback engine (ES module, document-lifetime)
 *
 * One <audio> element in #wsPlayer, which soft navigation never touches, so
 * a book started on any page keeps playing on every page. Loaded once by the
 * shell partial after the router; not a page module: it lives as long as the
 * document, and its own timers and listeners are its to tear down (close()).
 * Design: docs/superpowers/specs/2026-09-28-audiobook-player-design.md,
 * sections 4, 6 and 9.
 *
 * A book is its parts (tracks) laid end to end: book time is the durations
 * of the parts before plus the offset in the current part. The audio streams
 * straight from the Plex server's own https connection, with the listener's
 * server token in the query string (an <audio> element cannot send headers).
 * That URL is built here, in memory, only when it is handed to an element's
 * src: the token is never logged, never in an error, an event or state(), and
 * never in the page except in that src.
 *
 * Connection: the local connection is tried first with a throwaway element
 * that loads only metadata (a fetch would be refused: connect-src is 'self'),
 * 1.5 s at most, else the remote one; the choice is kept for the page
 * session. Where the browser gates private addresses behind a Local Network
 * Access prompt, local is tried only if that permission is already granted:
 * the engine never makes the browser ask. When the stream fails, in order:
 * the other connection at the same offset; then a fresh token
 * (GET /api/player/book/<key>?refresh=1) once; then "Can't reach the media
 * server" with a retry. A stream that stops without an error (8 s waiting
 * with nothing arriving) counts as a failure. Only a part that will not load
 * or decode (never a dropped connection) can be skipped, with a notice, and
 * only when it fails that way twice, the second time on a connection just
 * shown to work (another part, or the same one, loads its metadata there).
 * The place (state().position, what the save loop stores) never moves
 * because of a failure, and is frozen in the error state: after a skipped
 * part it stays where the failed part stopped until the next part has really
 * played (1 s of it), so a run of broken parts never carries it past the
 * first.
 *
 * Formats (spec 11a): before a part is loaded or probed, the browser is asked
 * (canPlayType, with the container and codec Plex reports) whether it can
 * decode it. The player plays direct only: a part it cannot decode is never
 * loaded or probed, and the listener sees "This book's audio format can't
 * play in this browser" (no retry: trying again cannot help), with the place
 * where it was. A format the engine does not know (an unknown or empty
 * codec) plays as before. In a book where only some parts are undecodable,
 * playback stops where such a part begins (the end of the part before, or
 * the place it opened at) and never passes over it. A seek or chapter jump
 * into one is refused with a 'warning' { kind: 'part-format' } ("This part's
 * format can't play in this browser"); playback, the place and saving go on
 * as they were. Only decodable parts are ever played, probed or saved.
 *
 * Pure (importable by Node, no DOM at import time):
 *   toTrackOffset(tracks, bookMs)  -> { index, track, offset_ms } | null
 *   toBookMs(tracks, trackKey, offsetMs) -> number | null
 *   chapterAt(chapters, bookMs)    -> the chapter's position in the list, -1 if none
 *   mimeFor(container, codec, profile) -> the MIME type for canPlayType, '' if unknown
 *   createEngine(env)              the engine, given its surroundings (tests)
 *   boot(win, overrides)           mounts the engine in #wsPlayer as WS.player
 *   UnknownTrack                   open()'s rejection for a place not in the book
 *
 * In the browser, window.WS.player:
 *   open(key, { at: { track, offset_ms }, autoplay, resume }) -> Promise<void>
 *       loads the book (at the place given, else where the listener left
 *       off, else its start) and plays it (autoplay false: loads only).
 *       Resolves once playback is set going; a failure is an 'error' event
 *       and state().error. It rejects only with UnknownTrack: the place
 *       given is in a part the book does not have; then nothing is loaded
 *       and no place is reported (the 'loading' change is followed by a
 *       'close' one, no book, no place).
 *       Where the listener left off (with a saver, and no at; resume: false
 *       skips it): the newest of WebServarr's copy, Plex's and this
 *       browser's (GET /api/player/position/<key> and the local copy). A
 *       local copy that wins is sent to the server at once. If the copies
 *       cannot be read, the open fails like a failed book fetch (with a
 *       retry), so nothing ever starts from 0 over a place it did not see.
 *       The book's files changed (spec 2.5): when the newest copy's part is
 *       not in the book, or it is the place in an earlier copy of the book
 *       (the web copy's linked_from), the book opens held at its start,
 *       loaded and paused, with state().filesChanged set and a 'warning'
 *       { kind: 'files-changed' }. It never jumps on its own (not to an
 *       older copy either). Held, nothing is saved (no check-in, beacon or
 *       last save) and the local copy keeps the old place. Playback while
 *       held is only ever a bounded preview: Play (the bar, the keyboard,
 *       the lock screen, the element's own controls) and Retry resume a
 *       preview paused before its end, else start a fresh one at the
 *       helper's chosen spot (state().filesChanged.spot). A move (seek,
 *       skip, chapter jump, seekto, the scrubber) ends the preview, pauses,
 *       and only moves that spot (a skip, the lock screen's seek back and
 *       forward and the arrow keys from that spot, not from the playhead);
 *       smart rewind does nothing. previewAt,
 *       confirmPlace and startOver are the way out. The element played
 *       from outside while held (no Media Session) adopts a paused preview,
 *       else becomes a fresh one; it is never paused and played again there.
 *       confirmPlace's move never waits on a late Play's re-read.
 *       The safety net (spec 2.6): a book the listener has no place in at all
 *       (no copy in WebServarr, Plex or this browser, none a Plex read that
 *       failed; a copy this browser only kept as the book's opening place,
 *       never played or moved here, is no place), opened without an `at`,
 *       asks the server for their places on
 *       books that left the library (GET /api/player/orphans/<key>, alongside
 *       the book, ORPHANS_WAIT_MS at most). With any, the book opens held
 *       (state().safetyNet, a 'warning' { kind: 'safety-net' }) at its start,
 *       loaded and paused, the saves held as for the files changed (nothing
 *       sent, no beacon, no last save, the local copy untouched), and
 *       stricter: nothing plays, not even a preview. play(), toggle(),
 *       retry(), the lock screen's Play, the element's own controls, and every
 *       move (seek, skip, chapter jump, seekto, rewind) do nothing until
 *       pickOrphan or dismissOrphans answers it. A lookup that finds none
 *       gives no question: the book opens as it always did. A lookup that
 *       FAILS (an error status, a network error, ORPHANS_WAIT_MS without an
 *       answer, or Plex unreadable with no other place known) is not "none":
 *       the book is held the same way with state().safetyNet.failed true and
 *       no places, and never plays or saves on its own. retryOrphans() opens
 *       it afresh (what the second try finds decides); startAsNew() is the
 *       listener's explicit choice of a new book. A reload asks again, since
 *       nothing was saved.
 *       Booted without its saves (saves.js failed to load or run), open()
 *       never opens a book: an 'unsupported' error, "The player couldn't
 *       start. Please update your browser." (no retry).
 *   play(), pause(), toggle()
 *       A late Play (spec 11b): play() or retry() after 5 minutes or more
 *       without playing, by the wall clock (a device asleep counts), first
 *       reads the saved places again (GET /api/player/position/<key>, 4 s at
 *       most; state().checking meanwhile), and so does a move made while
 *       paused (seek, skip, chapter jump, the lock screen's). If WebServarr's
 *       copy was saved since by another page session (another device, or
 *       another tab of this browser), or Plex holds a place from a Plex app
 *       newer than what this page last saw, somewhere else, the Play or move
 *       does not happen and a 'warning' { kind: 'conflict' } asks where to go
 *       on (as a 409 does): nothing is saved until the listener answers
 *       (resolveConflict), and a Play meanwhile plays without saving. A
 *       failed or slow read goes on. The lock screen's Play takes the same
 *       path. pause() or toggle() during a Play's read cancels it and stops
 *       an element playing meanwhile. pause(), and toggle() whenever
 *       anything plays, always stop the element, even one playing without
 *       the engine knowing. Held for the book's changed files there is no
 *       late Play (a Play is a preview, nothing is saved); confirmPlace
 *       re-reads for itself (see it).
 *   seek(bookMs, { answer }), skip(deltaS), jumpToChapter(i)   i: a position in state().chapters;
 *       answer: the move answers the open's question (features.js): if a
 *       late read then asks again, it still happens, unsaved
 *   rewind(bookMs)    smart rewind's seek (features.js): a 'seek' change marked
 *                     { rewind: true }; the saves keep the place it went back
 *                     from until playback passes it (saves.js). Nothing while
 *                     the files changed are held.
 *   previewAt(bookMs) -> bool   held for the book's changed files: plays
 *                     PREVIEW_MS (15 s) from bookMs without saving (a
 *                     'preview' change), then pauses; a second call replaces
 *                     the first. It stops 1 s short of the book's end or of
 *                     a part this browser can't decode (near one, it is the
 *                     15 s before it, within the part), and after 15 s of
 *                     playing by the wall clock (more at a speed under 1x),
 *                     so a seek from outside the engine can't stretch it.
 *                     Buffering does not count: the wall time restarts at
 *                     the first timeupdate after a 'waiting', and each
 *                     timeupdate counts 1 s at most (a stall the element
 *                     reports no 'waiting' for costs under 1 s). But never
 *                     longer than PREVIEW_CEILING_MS (60 s) of wall clock
 *                     spent playing, stalls and buffering counted (paused
 *                     time is not), so a stream that stalls before every
 *                     timeupdate can't stretch it (spec 2.6).
 *                     false: not held, or a part this browser can't decode
 *                     (with a 'part-format' warning).
 *   pickOrphan(key) -> bool  the safety net's question is open: the listener
 *                     picked that place (one of state().safetyNet.orphans) as
 *                     this book's earlier copy. It leads into the files
 *                     changed hold with it as the old place (state().filesChanged.old:
 *                     linked_from key, manual true, source 'orphan', its
 *                     book_ms, book_duration_ms, chapter_label, book_title,
 *                     narrator), and the same 'files-changed' warning, so the
 *                     "Find your place" helper takes it from there. Nothing
 *                     is saved yet; confirmPlace sends linked_from with
 *                     link_manual: true (startOver sends no link). false: no
 *                     question open, or a key that was not offered.
 *   unpickOrphan() -> bool  "Not this book": from a pick, before it is
 *                     confirmed (nothing waiting on a read or a question),
 *                     back to the question with the same places: the book at
 *                     its start, held, nothing saved. false otherwise.
 *   retryOrphans() -> bool  "Try again" after a failed lookup: the book is
 *                     opened afresh as it was; false when no failed lookup
 *                     waits.
 *   startAsNew() -> bool  "Start this book" after a failed lookup: a new
 *                     book (as dismissOrphans, but nothing is told to the
 *                     server); false when no failed lookup waits.
 *   dismissOrphans() -> bool  "None of these": the server is told
 *                     (POST /api/player/orphans/<key>/dismiss, in the
 *                     background; per listener and book, so it holds on every
 *                     device), the hold ends, and the book is a new book:
 *                     nothing is saved until it is played (a start-over
 *                     release of the saves, no place moved), and it plays now
 *                     when the open was to play, through the late Play's
 *                     re-read as any Play (after RECHECK_AFTER_MS a newer
 *                     place elsewhere is asked about, never overwritten by
 *                     0:00). false: no question open.
 *   confirmPlace(bookMs) -> bool  held: the listener places the book at bookMs.
 *                     An explicit move (a 'seek' change marked { place: true })
 *                     that ends the hold and is saved once (it ends any smart
 *                     rewind floor; compare-and-swap applies as to any save).
 *                     A place from an earlier copy sends its linked_from with
 *                     the saves until the server says whether it linked it.
 *                     The held playhead moves to the spot at once (a 'seek'
 *                     marked { place: true } too, nothing saved); then the
 *                     saved places are always read again first, still held
 *                     (checking; RECHECK_WAIT_MS at most): a newer place
 *                     another device or a Plex app saved meanwhile is asked
 *                     about (a 'conflict' warning) and the confirm waits for
 *                     the answer (resolveConflict: Continue lands at the other
 *                     place exactly, as that device or app left it, with no
 *                     end margin; Keep listening here at the spot). The book
 *                     stays held until the confirm's move lands, at the
 *                     chosen spot: a move made meanwhile (a skip, a seek, a
 *                     chapter jump, a preview elsewhere) counts, and its
 *                     linked_from goes with it wherever it lands. A Play made
 *                     during the read (a preview meanwhile) plays on from
 *                     there once it lands, unless a Pause took it back; once
 *                     asked, the answer decides. false as previewAt.
 *                     Wherever else it is asked to land (the listener's own
 *                     spot), it lands no nearer the book's end than
 *                     PLACE_END_MS (30 s; 0 for a shorter book), so the next
 *                     Play never starts the book again. Where that margin
 *                     falls in a part this browser can't decode, it lands at
 *                     the last playable spot before it, but only within
 *                     PLACE_WALK_MS (60 s) of where the margin alone would
 *                     put it. Further back than that it never lands: the book
 *                     stays held (a 'part-format' warning marked landing:
 *                     true, as when there is nowhere playable at all) for the
 *                     helper to show that spot and why; confirmPlace asked
 *                     for such a spot is false, and only moves the held spot
 *                     to it (nothing confirmed).
 *   startOver() -> bool  confirmPlace(0), never sending linked_from
 *   setSpeed(x)       0.75 to 2 in 0.05 steps (clamped, rounded); returns the speed
 *   setSkip(s)        the skip length (the skip buttons and the Media Session
 *                     seek back and forward), 5 to 60 s (clamped, rounded; a
 *                     finite number only); returns it. A new value is a
 *                     'prefs' change.
 *   applyPrefs({ skip, speed })  the listener's saved settings (features.js):
 *                     each a number or left as it is; then one 'prefs' change.
 *                     Returns { skip, speed }.
 *   setVolume(v)      the element's volume, 0 to 1 (the sleep timer's fade);
 *                     returns it. No change event.
 *   parts()           [{ start_ms, duration_ms, playable }] of the book, in
 *                     book time; playable false: a format this browser can't
 *                     decode (never a place to move to)
 *   retry()           after an error: again from the place. After a failed
 *                     first fetch it opens the book again, so like open() it
 *                     can reject with UnknownTrack.
 *   close()           stops and forgets the book
 *   setOpenGate(fn)   fn(info) is asked once per open() that resumes where the
 *                     listener left off, before anything plays (features.js:
 *                     the handoff prompt). info: { book, resumed: the copy it
 *                     resumes from ({ source, track, offset_ms, updated_at,
 *                     device, device_id, bookMs } or null), web:
 *                     WebServarr's copy ({ source, track, offset_ms,
 *                     updated_at, device, device_id, bookMs (null: not in
 *                     this book), playable } or null), own: this browser's
 *                     own copy ({ track, offset_ms, updated_at, device, own,
 *                     acked, bookMs, ackedBookMs (its last acked place, or
 *                     null) } or null), plex: Plex's copy (a Plex app's
 *                     place, as web) or null, now (the server's clock, ISO,
 *                     or null), me: { device_id, device } }. An answer
 *                     { at: 'web' } holds the open paused at WebServarr's
 *                     place, { at: 'plex' } at Plex's, { at: 'own' } at this
 *                     browser's own (the newer by stamp, or the only one
 *                     that can play here);
 *                     nothing is pushed and the local copy is left as it was
 *                     until the listener plays or moves.
 *   resolveConflict() the listener answered a 409 (saves.js 'conflict'
 *                     warning): saves go again. Returns the conflict or null
 *                     (also while recheckPlex reads).
 *   recheckPlex() -> Promise<'same'|'moved'|'failed'> | null   a Plex app's
 *                     question (a late Play's or a confirm's read found its
 *                     newer place) left showing: features.js asks this before
 *                     an answer given over 2 minutes later (spec 2.5 section
 *                     7). The saved places are read again (RECHECK_WAIT_MS at
 *                     most); nothing is saved, landed or released meanwhile.
 *                     'moved': the Plex app moved on, and the question is
 *                     asked again at its new place (a 'conflict' warning; a
 *                     later Continue goes there); nothing else changes.
 *                     'same': the answer goes on ('paused': and the
 *                     listener paused meanwhile, even with nothing playing,
 *                     so it does not play; also when the read is
 *                     refused with a 4xx other than 401, 408 or 429: the
 *                     answer's check-in meets it, as before). 'failed': the
 *                     read failed (no network, 408, 429, 5xx), took too
 *                     long, or the server could not read Plex (plex_error);
 *                     on a 401 the saves' sign-in path is taken first.
 *                     Nothing changes. null: no Plex app's question waits
 *                     (nothing read). One read at a time.
 *   placeMs(track, offsetMs)  the book time of a place in the loaded book, or null
 *   own()             this browser's own copy of the loaded book's place (as
 *                     in setOpenGate's info), or null
 *   me()              { device_id, device }: how saves name this browser
 *   state()           { book (the key), title, author, narrator, series, cover,
 *                       chapters, chapterIndex, trackIndex, bookMs, bookDurationMs,
 *                       position: { track, offset_ms, duration_ms } | null,
 *                       playing, loading, speed, connection: 'local'|'remote'|null,
 *                       error: { code, message } | null, lastSavedAt, saveError,
 *                       resumedFrom: { source, device, updated_at, age_ms } | null,
 *                       filesChanged: { old: { track, offset_ms, book_ms,
 *                         book_duration_ms, chapter_label, updated_at, source,
 *                         linked_from, book_title, narrator, manual }, spot } | null,
 *                       safetyNet: { failed, orphans: [{ key, book_title, narrator,
 *                         book_ms, book_duration_ms, chapter_label, updated_at }] } | null }
 *       filesChanged: the book's files changed (see open): the place saved
 *       before (source 'web', 'plex' or 'local'; a field that copy lacks is
 *       null; linked_from: the earlier copy's key when it came from one;
 *       source 'orphan' and manual true: the listener picked it from the
 *       safety net, see pickOrphan);
 *       spot: the helper's chosen spot in book ms (0 at the open, then the
 *       last preview's start or move's landing), where Play previews.
 *       safetyNet: the book is held while the listener is asked whether one of
 *       their places on books that left the library was this one (see open).
 *       bookMs is the playhead (what to show); position is the place to save.
 *       They differ only while a skipped part's successor has not played yet.
 *       lastSavedAt: ms (this device's clock) of the last save the server
 *       took, or null; saveError: the "not saved" warning is showing.
 *       checking: a late Play is reading the saved places first (see play()).
 *       resumedFrom: which copy open() resumed from ('web', 'plex', 'local');
 *       age_ms: how old that place was when it was read, in the server's
 *       clock (its `now` on GET /position less the copy's updated_at, which
 *       is the server's clock too), so a device clock that is off never
 *       counts; null when the server gave no time.
 *   on(event, fn) -> unsubscribe; fn gets one object:
 *     'change'   { reason, state } and, for 'seek' | 'skip' | 'jump', from and to
 *                (book ms). reason: 'loading' (a book is being fetched), 'open'
 *                (its parts and chapters are known), 'play', 'pause', 'time' (the
 *                element's timeupdate while playing), 'seek', 'skip', 'jump',
 *                'part' (one part ended, the next starts at 0), 'part-skipped',
 *                'connection' (switched, or refreshed its token), 'speed',
 *                'ready' (loaded, not playing), 'retry', 'error', 'ended', 'close',
 *                'save' (state().saveError changed), 'prefs' (the skip length or
 *                the listener's settings changed), 'checking' (a late Play's read
 *                of the saved places started or ended), 'preview' (previewAt
 *                moved to its spot). confirmPlace's moves are 'seek's with
 *                place: true (the held playhead to the spot, then the one
 *                that lands).
 *     'ended'    { state } at the end of the last part
 *     'error'    { code, message, retry: function | null }; code 'unreachable',
 *                'part', 'format' (no retry), 'forbidden', 'not-found', 'signed-out',
 *                'busy', 'empty', 'unsupported' (no saves: see open; no retry)
 *     'warning'  { kind: 'part-skipped', message }
 *                { kind: 'files-changed', book, old } (see open; old as in
 *                  state().filesChanged)
 *                { kind: 'safety-net', book, failed, orphans } (see open; as in
 *                  state().safetyNet)
 *                { kind: 'part-format', message, landing } (a seek, preview or
 *                  confirm into a part that can't play; landing: true when a
 *                  confirm waiting on its read or question could not land,
 *                  so the book stays held and that confirm is over)
 *                { kind: 'conflict', book, conflict: { track, offset_ms, device,
 *                  updated_at }, now } (saves.js on a 409, or a late Play's
 *                  re-read: another page's or Plex's newer place)
 *                { kind: 'not-saved', active, lastSavedAt, message } (saves.js):
 *                active true: "Your place isn't being saved. Last saved <time>."
 *                to show; false: it cleared (a save succeeded, or the book was
 *                closed or switched while it showed), with a 'save' change
 *
 * Saving (saves.js) is injected as env.saver: the engine hands it every
 * change and opens and stops it with each book. Without one (the engine's
 * own tests) nothing is saved and open() does not look for a place.
 */

export const PROBE_MS = 1500;          // the local connection's probe
export const STALL_MS = 8000;          // waiting with nothing arriving: the stream has failed
export const PLAYED_MS = 1000;         // this much real playback shows a part plays
export const SPEED_MIN = 0.75;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.05;
export const SKIP_S = 10;              // Media Session seek back and forward: the default
export const SKIP_MIN_S = 5;
export const SKIP_MAX_S = 60;
export const UNREACHABLE = "Can't reach the media server";
export const PLAYER_BROKEN = "The player couldn't start. Please update your browser.";
export const PREVIEW_MS = 15000;       // previewAt plays this much of the book from a spot
export const PREVIEW_CEILING_MS = 60000; // ... and never longer than this by the wall clock, stalls and all
export const ORPHANS_WAIT_MS = 5000;   // a new book waits this long at most for the safety net's lookup
const PREVIEW_END_GAP_MS = 1000;       // ... stopping this short of the book's end (never ending it)
const PREVIEW_WALL_STEP_MS = 1000;     // ... its wall time counting this much at most per timeupdate
export const PLACE_END_MS = 30000;     // a confirmed place is never nearer the book's end than this
export const PLACE_WALK_MS = 60000;    // ... nor moved back further than this for a part that can't play, unasked
export const FORMAT_UNSUPPORTED = "This book's audio format can't play in this browser";
export const PART_FORMAT = "This part's format can't play in this browser";
export const RECHECK_AFTER_MS = 300000;  // a Play after this long without playing re-reads the saved places
export const RECHECK_WAIT_MS = 4000;     // ... waiting this long at most, then playing on
const PLEX_LATER_MS = 2000;              // Plex's copy of a save of ours is stamped a moment after it
const SAME_PLACE_MS = 1000;              // another page's place this close to this one is this one

const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MP4 = ['mp4', 'm4a', 'm4b', 'mov'];
const BOOK_KEY = /^[0-9]{1,20}:[0-9]{1,6}$/;   // a book's key, as the server checks an earlier copy's
const ORPHANS_MAX = 10;                  // the most places the safety net offers

// ---------------------------------------------------------------------------
// Book time
// ---------------------------------------------------------------------------

function durationOf(track) {
  const d = Number(track && track.duration_ms);
  return isFinite(d) && d > 0 ? d : 0;
}

function clampNumber(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* The part and the offset in it for a book time. A part's first instant is
   that part's (the end of one part is the start of the next); the end of the
   book is the end of the last part; outside the book is clamped to it. */
export function toTrackOffset(tracks, bookMs) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  let ms = Number(bookMs);
  if (!isFinite(ms) || ms < 0) ms = 0;
  let start = 0;
  for (let i = 0; i < tracks.length; i++) {
    const d = durationOf(tracks[i]);
    if (ms < start + d || i === tracks.length - 1) {
      return { index: i, track: String(tracks[i].key), offset_ms: clampNumber(ms - start, 0, d) };
    }
    start += d;
  }
  return null;
}

/* The book time of an offset in a part (clamped to the part), or null for a
   part that is not the book's. */
export function toBookMs(tracks, trackKey, offsetMs) {
  if (!Array.isArray(tracks)) return null;
  let start = 0;
  for (let i = 0; i < tracks.length; i++) {
    const d = durationOf(tracks[i]);
    if (String(tracks[i].key) === String(trackKey)) {
      let off = Number(offsetMs);
      if (!isFinite(off)) off = 0;
      return start + clampNumber(off, 0, d);
    }
    start += d;
  }
  return null;
}

/* The chapter a book time is in, as its position in the list: the last one
   starting at or before it. An offset exactly on a chapter's start is that
   chapter's; the book's end (the last chapter's end) is the last chapter's;
   before the first is the first. -1 when there are none. */
export function chapterAt(chapters, bookMs) {
  if (!Array.isArray(chapters) || !chapters.length) return -1;
  const ms = Number(bookMs);
  let lo = 0;
  let hi = chapters.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(chapters[mid].start_ms) <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/* open()'s rejection when the place it was given is in a part this book
   does not have (the book changed in Plex since the place was saved). Nothing
   is loaded and no place is reported, so no save can overwrite the stored one
   with the start of the book; the caller decides where to start. */
export class UnknownTrack extends Error {
  constructor(track) {
    super("The saved place is in a part this book doesn't have");
    this.name = 'UnknownTrack';
    this.track = String(track);
  }
}

/* The place saved before the book's files changed (spec 2.5), as
   state().filesChanged.old gives it to the "Find your place" helper: copy is
   the newest copy (saves.js resumeOrder), raw the copy as it came (GET
   /position's web or plex copy, or the local copy), link its linked_from.
   A field the copy doesn't have is null. */
function oldPlaceOf(copy, raw, link) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ms = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : null; };
  const text = function (v) { return typeof v === 'string' && v ? v : null; };
  return {
    track: String(copy.track),
    offset_ms: copy.offset_ms,
    book_ms: ms(r.book_ms),
    book_duration_ms: ms(r.book_duration_ms),
    chapter_label: text(r.chapter_label),
    updated_at: copy.updated_at,
    source: copy.source,
    linked_from: link || null,
    // Which copy it was, as the library named it (an earlier copy's title
    // and narrator: the helper shows them, so a wrong match is plain).
    book_title: text(r.book_title),
    narrator: text(r.narrator)
  };
}

/* One place the server offered from a book that left the library (GET
   /api/player/orphans/<key>), cleaned: null for one without a well formed
   book key. A field it lacks is null. */
function orphanOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !BOOK_KEY.test(raw.key)) return null;
  const ms = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : null; };
  const text = function (v) { return typeof v === 'string' && v ? v : null; };
  return {
    key: raw.key,
    book_title: text(raw.book_title),
    narrator: text(raw.narrator),
    book_ms: ms(raw.book_ms),
    book_duration_ms: ms(raw.book_duration_ms),
    chapter_label: text(raw.chapter_label),
    updated_at: text(raw.updated_at)
  };
}

/* The places the server offered, cleaned: at most ORPHANS_MAX, one per book. */
function orphanList(raw) {
  const out = [];
  const seen = new Set();
  (Array.isArray(raw) ? raw : []).forEach(function (r) {
    const o = out.length < ORPHANS_MAX ? orphanOf(r) : null;
    if (!o || seen.has(o.key)) return;
    seen.add(o.key);
    out.push(o);
  });
  return out;
}

/* A place the listener picked from the safety net, as the "Find your place"
   helper takes an old place (see oldPlaceOf): from an earlier copy of the
   book (linked_from), by the listener's own hand (manual). It has no part of
   its own in this book, only the book time. */
function oldPlaceOfOrphan(o) {
  return {
    track: '',
    offset_ms: 0,
    book_ms: o.book_ms,
    book_duration_ms: o.book_duration_ms,
    chapter_label: o.chapter_label,
    updated_at: o.updated_at,
    source: 'orphan',
    linked_from: o.key,
    book_title: o.book_title,
    narrator: o.narrator,
    manual: true
  };
}

/* The MIME type, codecs included, that a track's container and codec (as
   Plex reports them) make, for the browser's canPlayType. '' when the codec
   is unknown or empty: such a track plays direct, as before. */
export function mimeFor(container, codec, profile) {
  const c = String(container || '').toLowerCase();
  const k = String(codec || '').toLowerCase();
  const p = String(profile || '').toLowerCase();
  const mp4 = MP4.indexOf(c) !== -1;
  const inMp4 = function (codecs) { return mp4 ? 'audio/mp4; codecs="' + codecs + '"' : ''; };
  switch (k) {
    case 'mp3':
      return c === 'mp3' ? 'audio/mpeg' : inMp4('mp4a.6B');
    case 'aac':
      if (c === 'aac') return 'audio/aac';
      if (p.indexOf('v2') !== -1) return inMp4('mp4a.40.29');
      if (p.indexOf('he') !== -1) return inMp4('mp4a.40.5');
      return inMp4('mp4a.40.2');
    case 'eac3':
      return inMp4('ec-3');
    case 'ac3':
      return inMp4('ac-3');
    case 'alac':
      return inMp4('alac');
    case 'flac':
      return c === 'flac' ? 'audio/flac' : inMp4('flac');
    case 'opus':
      return c === 'ogg' ? 'audio/ogg; codecs="opus"' : c === 'webm' ? 'audio/webm; codecs="opus"' : inMp4('opus');
    case 'vorbis':
      return c === 'ogg' ? 'audio/ogg; codecs="vorbis"' : c === 'webm' ? 'audio/webm; codecs="vorbis"' : '';
    default:
      return '';
  }
}

// Only a finite number is a skip length; anything else (null, '', false, a
// string) changes nothing.
function roundSkip(x) {
  if (typeof x !== 'number' || !isFinite(x)) return null;
  return clampNumber(Math.round(x), SKIP_MIN_S, SKIP_MAX_S);
}

function roundSpeed(x) {
  const v = Number(x);
  if (!isFinite(v)) return null;
  const stepped = Math.round(v / SPEED_STEP) * SPEED_STEP;
  return Math.round(clampNumber(stepped, SPEED_MIN, SPEED_MAX) * 100) / 100;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/* env: { host (where the element goes), createAudio(), fetch, setTimeout,
   clearTimeout, mediaSession, MediaMetadata, permissions, baseUrl,
   skipSeconds, saver (saves.js createSaver) }. */
export function createEngine(env) {
  const setT = env.setTimeout;
  const clearT = env.clearTimeout;
  const fetchFn = env.fetch;
  const session = env.mediaSession || null;
  const Metadata = env.MediaMetadata || null;
  const baseUrl = env.baseUrl || '';
  const saver = env.saver || null;
  // The page booted without its saves (boot): no book is ever opened.
  const noSaver = !!env.noSaver && !saver;
  // The wall clock: a late Play is measured with it, so time the device
  // spent asleep counts (a monotonic clock stands still then).
  const wallNow = typeof env.now === 'function' ? env.now : Date.now;
  let skipS = roundSkip(env.skipSeconds) || SKIP_S;

  const audio = env.createAudio();
  audio.preload = 'auto';
  if (audio.setAttribute) audio.setAttribute('data-ws-player-audio', '');
  if (env.host) env.host.appendChild(audio);

  /* Can this browser decode the track? Asked once per track, before it is
     ever loaded or probed. A format the engine does not know plays direct,
     as always; one the browser says it cannot play ('') is undecodable. */
  function undecodable(t) {
    const mime = mimeFor(t.container, t.codec, t.profile);
    if (!mime || typeof audio.canPlayType !== 'function') return false;
    try {
      return audio.canPlayType(mime) === '';
    } catch (e) {
      return false;
    }
  }

  function blocked(index) {
    return !!(book && book.tracks[index] && book.tracks[index].undecodable);
  }

  /* Playback has reached an undecodable part (or the book opened into one):
     stop at `at` (a place in a decodable part the listener reached, or the
     place the book opened at), never loading or probing the part, with no
     retry. Everything still pending (a load, a probe, a step of the failure
     ladder) is superseded, so nothing plays under the message. */
  function formatStop(at) {
    gen += 1;
    if (at) {
      playhead = { index: at.index, offset: at.offset };
      target = { index: at.index, offset: at.offset };
    }
    stopWith('format', FORMAT_UNSUPPORTED, null);
  }
  const handlers = { change: new Set(), ended: new Set(), error: new Set(), warning: new Set() };

  // The book: { key, title, author, narrator, series, cover, tracks, starts,
  // durationMs, chapters }. The stream's token and URIs are kept apart from
  // it, and never leave this closure except inside an element's src.
  let book = null;
  let stream = null;
  let lastOpen = null;        // { key, opts } of the last open(), for its retry
  let openGen = 0;
  let openGate = null;        // setOpenGate
  let resumedFrom = null;     // { source, device, updated_at } the open resumed from
  let unchosen = false;       // the book opened into an undecodable part: no connection chosen yet
  // The book's files changed (spec 2.5): { old } the place saved before,
  // held until the listener places the book (confirmPlace, startOver); and
  // the preview playing meanwhile, { start, end (book ms), done }.
  let files = null;
  let preview = null;
  let ceilingTimer = null;    // the preview's PREVIEW_CEILING_MS, while it plays
  // The safety net (spec 2.6): a book the listener has no place in, while
  // they are asked whether one of their places on books that left the library
  // was this one. { orphans, autoplay }. Held like the files changed, and
  // stricter: nothing is saved, and nothing plays, not even a preview.
  let net = null;

  // Where: the loaded part and its connection, the playhead, where the load
  // is heading, and the place held after a skipped part.
  let cur = null;             // { index, side }
  let playhead = null;        // { index, offset }
  let target = null;          // { index, offset }
  let hold = null;            // { index, offset } | null

  // The load in progress. gen changes with every src handed to the element;
  // anything waiting (a probe, a refresh) checks it is still the same.
  let gen = 0;
  let pending = false;        // the element's time is not the playhead yet
  let seekApplied = false;
  let metaLoaded = false;
  let failedGen = -1;
  // A part being loaded once more after it would not load or decode where the
  // connection was just shown to work: { index, side }. Failing the same way
  // again, it is skipped.
  let partSuspect = null;

  let wantPlay = false;
  let loading = false;
  // A late Play (see play()): since when (wall ms) this page has neither
  // played nor read the saved places (null: no book), the read in progress,
  // and the newest Plex stamp this page has seen.
  let quietSince = null;
  let checking = null;
  let plexSeenAt = -Infinity;
  // The Plex app's place the question waiting asks about ({ track,
  // offset_ms, t: its stamp }, null when none does), and the read before a
  // late answer to it in progress (recheckPlex).
  let plexAsked = null;
  let rechecking = null;
  let wasPlaying = false;
  let speed = 1;
  let error = null;           // { code, message }
  let errorRetry = null;

  // Connection: the choice kept for the page session, what has loaded on
  // each side with the current token, and the failure ladder's progress.
  let chosen = null;
  let localOk = null;         // may the local side be used (the permission gate), once known
  let localAsk = null;        // the permission question in flight
  const proven = new Map();   // side -> index of a part that loaded there
  const tried = new Set();
  let refreshed = false;

  let watchdog = null;
  const probes = new Map();   // live probe element -> its finish(ok)
  let probeCount = 0;
  let sessionReady = false;

  // The saves' warning: an event to show or clear, and a change so a view
  // drawn from state() follows.
  if (saver && typeof saver.onWarning === 'function') {
    saver.onWarning(function (w) {
      emit('warning', w);
      changed('save');
    });
  }

  // ---- Events ----

  function emit(type, detail) {
    for (const fn of Array.from(handlers[type])) {
      try {
        fn(detail);
      } catch (e) {
        console.error('[player] a ' + type + ' listener failed', e);
      }
    }
  }

  function changed(reason, extra) {
    const detail = Object.assign({ reason: reason }, extra || {});
    // Playback stopped: the quiet time a late Play measures starts now.
    const on = !!(book && wantPlay && !error);
    if (wasPlaying && !on) {
      quietSince = wallNow();
      // A preview's wall time counts only while it plays.
      if (preview) {
        preview.lastWall = null;
        if (preview.wallFrom !== null) preview.wallUsed += wallNow() - preview.wallFrom;
        preview.wallFrom = null;
      }
      stopCeiling();
    }
    // ... and its ceiling clock runs from the moment it is wanted playing.
    if (!wasPlaying && on && preview && preview.wallFrom === null) {
      preview.wallFrom = wallNow();
      armCeiling(preview);
    }
    wasPlaying = on;
    if (saver) {
      // First, so this change already carries what saving it changed. The
      // place's own book time too: it differs from the playhead's while a
      // skipped part's successor has not played yet.
      const place = hold || playhead;
      const ms = book && place ? book.starts[place.index] + place.offset : NaN;
      const ci = book && place ? chapterAt(book.chapters, ms) : -1;
      try {
        saver.note({ reason: reason, state: state(), rewind: !!(extra && extra.rewind),
          from: extra ? extra.from : undefined, to: extra ? extra.to : undefined,
          placeMs: ms,
          // Its chapter's label, which with the book time survives the
          // book's files changing (spec 2.5).
          placeLabel: ci !== -1 && book.chapters[ci] && typeof book.chapters[ci].label === 'string' ? book.chapters[ci].label : '',
          place: !!(extra && extra.place) });
      } catch (e) {
        console.error('[player] saving failed', e);
      }
    }
    detail.state = state();
    emit('change', detail);
    if (reason !== 'time') sessionPosition();
  }

  function setLoading(on) {
    loading = on;
  }

  // ---- State ----

  function bookMsNow() {
    if (!book || !playhead) return 0;
    return book.starts[playhead.index] + playhead.offset;
  }

  function state() {
    const bookMs = bookMsNow();
    const place = hold || playhead;
    return {
      book: book ? book.key : null,
      title: book ? book.title : '',
      author: book ? book.author : '',
      narrator: book ? book.narrator : '',
      series: book ? book.series : '',
      cover: book ? book.cover : '',
      chapters: book ? book.chapters : [],
      chapterIndex: book ? chapterAt(book.chapters, bookMs) : -1,
      trackIndex: book && playhead ? playhead.index : -1,
      bookMs: bookMs,
      bookDurationMs: book ? book.durationMs : 0,
      position: book && place ? {
        track: String(book.tracks[place.index].key),
        offset_ms: Math.round(place.offset),
        duration_ms: durationOf(book.tracks[place.index])
      } : null,
      playing: !!(book && wantPlay && !error),
      loading: loading,
      speed: speed,
      connection: book && cur ? cur.side : null,
      error: error ? { code: error.code, message: error.message } : null,
      checking: !!checking || !!(files && files.reading),
      lastSavedAt: saver ? saver.lastSavedAt : null,
      saveError: saver ? !!saver.warning : false,
      resumedFrom: resumedFrom,
      filesChanged: book && files ? { old: Object.assign({}, files.old), spot: files.spot } : null,
      safetyNet: book && net ? { failed: net.failed, orphans: net.orphans.map(function (o) { return Object.assign({}, o); }) } : null
    };
  }

  // ---- Streams ----

  function hasSide(side) {
    return !!(stream && stream.uris && Array.isArray(stream.uris[side]) && stream.uris[side].length);
  }

  // A side the engine may load: the local one only once localAllowed() has
  // said yes, so it is never loaded where the browser would ask first.
  function usable(side) {
    return hasSide(side) && (side !== 'local' || localOk === true);
  }

  /* May the local connection be tried without a prompt? Chrome asks "access
     devices on your local network" the first time a public page loads from a
     private address, and plex.direct names resolve to one from anywhere. So
     only when that permission is already granted; 'prompt' or 'denied' (or
     no answer in time) is no. A browser that has no such permission (the
     query rejects) has no gate: yes. Asked once per page session. */
  function localAllowed() {
    if (localOk !== null) return Promise.resolve(localOk);
    if (!localAsk) {
      const perms = env.permissions;
      if (!perms || typeof perms.query !== 'function') {
        localOk = true;
        return Promise.resolve(true);
      }
      localAsk = new Promise(function (resolve) {
        let timer = null;
        function settle(ok) {
          if (timer === null) return;
          clearT(timer);
          timer = null;
          localOk = ok;
          localAsk = null;
          resolve(ok);
        }
        timer = setT(function () { settle(false); }, PROBE_MS);
        let asked;
        try {
          asked = Promise.resolve(perms.query({ name: 'local-network-access' }));
        } catch (e) {
          asked = Promise.reject(e);
        }
        asked.then(function (status) {
          const st = status && status.state;
          settle(st === 'granted' ? true : st === 'prompt' || st === 'denied' ? false : true);
        }, function () { settle(true); });
      });
    }
    return localAsk;
  }

  function otherSide(side) {
    return side === 'local' ? 'remote' : 'local';
  }

  function preferredSide() {
    if (chosen && usable(chosen)) return chosen;
    if (usable('local')) return 'local';
    return usable('remote') ? 'remote' : null;
  }

  // Built only to be handed to an element's src, never stored or logged.
  function urlFor(side, index) {
    if (!usable(side) || !book || !book.tracks[index]) return '';
    const origin = String(stream.uris[side][0]).replace(/\/+$/, '');
    return origin + book.tracks[index].part_path + '?X-Plex-Token=' + encodeURIComponent(stream.token);
  }

  /* Does this side answer for this part? A throwaway element loads only its
     metadata, 1.5 s at most, and is then emptied so it holds no connection.
     Its handlers are properties, dropped with it. */
  function probe(side, index) {
    return new Promise(function (resolve) {
      // A URL of its own every time: a URL the element loaded before can be
      // answered from the browser's media cache with the server gone, and a
      // probe must ask the server.
      const base = urlFor(side, index);
      probeCount += 1;
      const url = base ? base + '&wsprobe=' + probeCount.toString(36) + Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8) : '';
      if (!url) {
        resolve(false);
        return;
      }
      const el = env.createAudio();
      let timer = null;
      function finish(ok) {
        if (!probes.has(el)) return;
        probes.delete(el);
        clearT(timer);
        el.onloadedmetadata = null;
        el.onerror = null;
        try {
          el.removeAttribute('src');
          el.load();
        } catch (e) { /* nothing to release */ }
        if (ok) proven.set(side, index);
        resolve(ok);
      }
      probes.set(el, finish);
      el.preload = 'metadata';
      el.muted = true;
      el.onloadedmetadata = function () { finish(true); };
      el.onerror = function () { finish(false); };
      timer = setT(function () { finish(false); }, PROBE_MS);
      el.src = url;
    });
  }

  async function chooseSide(index) {
    if (chosen && usable(chosen)) return chosen;
    if (hasSide('local') && await localAllowed()) {
      if (await probe('local', index)) return 'local';
      return usable('remote') ? 'remote' : 'local';
    }
    return usable('remote') ? 'remote' : null;
  }

  // ---- Loading a part ----

  function applyRate() {
    try {
      audio.defaultPlaybackRate = speed;
      audio.playbackRate = speed;
    } catch (e) { /* not while the element has no media */ }
  }

  function load(index, offset, side) {
    gen += 1;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    disarm();
    cur = { index: index, side: side };
    target = { index: index, offset: offset };
    playhead = { index: index, offset: offset };
    setLoading(true);
    audio.src = urlFor(side, index);
    applyRate();
    if (wantPlay) startPlay();
  }

  function startPlay() {
    const g = gen;
    arm();
    let p = null;
    try {
      p = audio.play();
    } catch (e) {
      p = null;
    }
    if (p && typeof p.catch === 'function') {
      p.catch(function (e) {
        // A newer load interrupted it (AbortError), or the element failed
        // (its error event handles that). Only a refusal is the listener's.
        if (g !== gen || !wantPlay || !e || e.name !== 'NotAllowedError') return;
        wantPlay = false;
        disarm();
        if (metaLoaded) setLoading(false);
        sessionState();
        changed('pause');
      });
    }
  }

  // ---- The stall watchdog ----

  function arm() {
    disarm();
    const g = gen;
    watchdog = setT(function () {
      watchdog = null;
      if (g === gen && book && wantPlay) fail('network');
    }, STALL_MS);
  }

  function disarm() {
    if (watchdog !== null) {
      clearT(watchdog);
      watchdog = null;
    }
  }

  // ---- The element ----

  audio.addEventListener('loadedmetadata', function () {
    if (!book || !cur || !pending) return;
    metaLoaded = true;
    proven.set(cur.side, cur.index);
    applyRate();
    if (!seekApplied) {
      if (target.offset > 0) {
        try {
          audio.currentTime = target.offset / 1000;
        } catch (e) { /* applied on the next seek */ }
      }
      seekApplied = true;
    }
    if (!wantPlay && loading) {
      setLoading(false);
      changed('ready');
    }
  });

  audio.addEventListener('progress', function () {
    // Data is arriving: the connection is alive, whatever the playhead does.
    if (watchdog !== null && wantPlay) arm();
  });

  audio.addEventListener('waiting', function () {
    if (book && wantPlay) arm();
    // Buffering is not playing: a preview's wall time starts again from the
    // next timeupdate (the stall costs it nothing).
    if (preview) preview.lastWall = null;
    previewCeiling();
  });

  audio.addEventListener('playing', function () {
    if (!book || !cur) return;
    previewCeiling();
    disarm();
    if (pending && seekApplied) pending = false;
    // This connection works: the failure ladder starts afresh next time.
    chosen = cur.side;
    tried.clear();
    refreshed = false;
    if (loading) {
      setLoading(false);
      changed('play');
    }
  });

  audio.addEventListener('timeupdate', function () {
    // The place is frozen in the error state: emptying the element there
    // resets its time to 0, which is not where the listener is.
    if (!book || !cur || error) return;
    if (pending) {
      if (!seekApplied || audio.seeking) return;
      pending = false;
    }
    const d = durationOf(book.tracks[cur.index]);
    let off = Math.round(Number(audio.currentTime) * 1000);
    if (!isFinite(off) || off < 0) off = 0;
    if (off > d) off = d;
    const moved = !playhead || playhead.index !== cur.index || playhead.offset !== off;
    playhead = { index: cur.index, offset: off };
    if (hold && !audio.paused && off >= target.offset + PLAYED_MS) hold = null;
    // A part loaded again after failing plays on (not just starts): it is fine.
    if (partSuspect && !audio.paused && off >= target.offset + PLAYED_MS) partSuspect = null;
    if (moved && wantPlay && !audio.paused) disarm();
    changed('time');
    // A preview (the book's files changed) stops after its 15 s.
    // ... and after as long by the wall clock, so a seek from outside the
    // engine (back before its start) can't stretch it.
    // Buffering is not playing: a 'waiting' restarts the count, and each
    // step counts PREVIEW_WALL_STEP_MS at most (a stall with no 'waiting').
    if (files && preview && !preview.done && wantPlay) {
      const w = wallNow();
      if (preview.lastWall !== null) preview.played += clampNumber(w - preview.lastWall, 0, PREVIEW_WALL_STEP_MS);
      preview.lastWall = w;
      if (bookMsNow() >= preview.end || preview.played >= PREVIEW_MS / Math.min(1, speed)) {
        preview.done = true;
        pause();
      }
    }
    previewCeiling();
  });

  audio.addEventListener('play', function () {
    // Started from outside the engine (the browser's own controls).
    if (!book) return;
    // Held for the book's changed files: only a bounded preview plays (the
    // engine starting one has wantPlay set already). A preview paused before
    // its end adopts this play as it is (below). Otherwise this play becomes
    // a fresh preview at the helper's chosen spot, started on the element
    // as it plays. Never pause the element and then play it here: its
    // queued 'pause' and 'play' events would answer each other for ever.
    // The safety net's question is open: nothing plays, however it started.
    if (net && !wantPlay) {
      stopElement();
      return;
    }
    if (files && files.reading && !wantPlay) files.play = true;
    if (files && !wantPlay && !pending && !error && !previewPaused()) {
      if (!startPreview(files.spot)) stopElement();
      return;
    }
    if (files && !wantPlay && (pending || error)) {
      // Nothing to adopt yet (a load, or an error): the element waits.
      stopElement();
      return;
    }
    if (pending || wantPlay || error) return;
    wantPlay = true;
    sessionState();
    changed('play');
  });

  audio.addEventListener('pause', function () {
    // The element pauses itself at the end of a part and when its src
    // changes; anything else is the browser or the system pausing it.
    if (!book || pending || audio.ended || !wantPlay) return;
    if (files) files.play = false;
    wantPlay = false;
    disarm();
    sessionState();
    changed('pause');
  });

  audio.addEventListener('ended', function () {
    if (!book || !cur || !audio.ended) return;
    const i = cur.index;
    hold = null;
    partSuspect = null;
    if (i + 1 < book.tracks.length) {
      if (blocked(i + 1)) {
        // The next part can't play here: stop at the end of this one.
        formatStop({ index: i, offset: durationOf(book.tracks[i]) });
        return;
      }
      load(i + 1, 0, cur.side);
      changed('part');
      return;
    }
    playhead = { index: i, offset: durationOf(book.tracks[i]) };
    wantPlay = false;
    if (preview) preview.done = true;
    disarm();
    setLoading(false);
    sessionState();
    changed('ended');
    emit('ended', { state: state() });
  });

  audio.addEventListener('error', function () {
    const err = audio.error;
    if (!book || !cur || !err || err.code === MEDIA_ERR_ABORTED) return;
    fail(err.code === MEDIA_ERR_NETWORK ? 'network' : 'media');
  });

  // ---- Failures ----

  /* The stream failed at the playhead. kind: 'network' (the connection
     dropped or stalled) or 'media' (the part would not load or decode; a
     404, a refused token and an unreachable host look the same here).

     Only a media failure can be the part's fault, and a part is skipped only
     when it fails that way twice: once, then again when loaded afresh on a
     connection just shown to work (another part, or this one, loads its
     metadata there). Anything else goes up the connection ladder and, at its
     top, to the error state, where the place is held for Retry. */
  async function fail(kind) {
    if (failedGen === gen || !book || !cur) return;
    failedGen = gen;
    const g = gen;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    disarm();
    const at = { index: playhead.index, offset: playhead.offset };
    const side = cur.side;
    const suspect = partSuspect;
    partSuspect = null;
    setLoading(true);

    if (kind === 'media') {
      if (suspect && suspect.index === at.index && suspect.side === side) {
        skipPart(at, side);
        return;
      }
      if (proven.has(side)) {
        const ok = await probe(side, verifyIndex(side, at.index));
        if (g !== gen) return;
        if (ok) {
          retryPart(at, side);
          return;
        }
      }
    }

    // 1. The other connection, at the same offset.
    tried.add(side);
    const other = otherSide(side);
    if (usable(other) && !tried.has(other)) {
      load(at.index, at.offset, other);
      changed('connection');
      return;
    }

    // 2. A fresh token and connections, once.
    if (!refreshed) {
      refreshed = true;
      let data = null;
      try {
        data = await fetchBook(book.key, true);
      } catch (e) {
        data = null;
      }
      if (g !== gen || !book) return;
      if (data) {
        stream = { token: String(data.stream.token || ''), uris: data.stream.uris || {} };
        proven.clear();
        tried.clear();
        const next = preferredSide();
        if (next) {
          load(at.index, at.offset, next);
          changed('connection');
          return;
        }
      }
    }

    // 3. A part that would not load: if the server answers for another part
    //    (a missing first part, before anything was shown to work), this
    //    part is loaded once more, and skipped if it fails that way again.
    if (kind === 'media') {
      const s = preferredSide();
      const ok = !!s && await probe(s, verifyIndex(s, at.index));
      if (g !== gen) return;
      if (ok) {
        retryPart(at, s);
        return;
      }
    }

    stopWith('unreachable', UNREACHABLE, retry);
  }

  function retryPart(at, side) {
    load(at.index, at.offset, side);
    partSuspect = { index: at.index, side: side };
    changed('connection');
  }

  // A part to test the connection with: one that loaded there, else a
  // neighbour, else (a single file) the part itself.
  function verifyIndex(side, index) {
    const good = proven.get(side);
    if (good !== undefined && good !== index) return good;
    if (index > 0 && !blocked(index - 1)) return index - 1;
    if (index + 1 < book.tracks.length && !blocked(index + 1)) return index + 1;
    return index;
  }

  function skipPart(at, side) {
    if (!hold) hold = { index: at.index, offset: at.offset };
    const n = book.tracks.length;
    // Before a part this browser can't decode nothing is skipped (playback
    // stops there, and the error below says so): no "skipped" notice.
    if (!(at.index + 1 < n && blocked(at.index + 1))) {
      emit('warning', {
        kind: 'part-skipped',
        message: 'Part ' + (at.index + 1) + ' of ' + n + " couldn't be played, so it was skipped."
      });
    }
    // Never into a part this browser can't decode: that is the end of what
    // can play, as after the last part.
    if (at.index + 1 < n && !blocked(at.index + 1)) {
      load(at.index + 1, 0, side);
      changed('part-skipped');
      return;
    }
    cur = { index: at.index, side: side };
    stopWith('part', "The rest of this book couldn't be played.", retry);
  }

  function stopWith(code, message, retryFn) {
    wantPlay = false;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    partSuspect = null;
    disarm();
    try {
      audio.pause();
    } catch (e) { /* already */ }
    release();
    setLoading(false);
    error = { code: code, message: message };
    errorRetry = retryFn || null;
    sessionState();
    emit('error', { code: code, message: message, retry: errorRetry });
    changed('error');
  }

  // Empty the element, so it holds no connection and no URL.
  function release() {
    if (audio.getAttribute && audio.getAttribute('src') === null) return;
    try {
      audio.removeAttribute('src');
      audio.load();
    } catch (e) { /* nothing held */ }
  }

  // ---- The book ----

  async function fetchBook(key, refresh) {
    let resp;
    try {
      resp = await fetchFn('/api/player/book/' + encodeURIComponent(key) + (refresh ? '?refresh=1' : ''), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
    } catch (e) {
      throw { status: 0, detail: '' };
    }
    if (!resp.ok) {
      let detail = '';
      try {
        const body = await resp.json();
        if (body && typeof body.detail === 'string' && body.detail.length <= 200) detail = body.detail;
      } catch (e) { /* no body */ }
      throw { status: resp.status, detail: detail };
    }
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw { status: 0, detail: '' };
    }
    if (!data || !Array.isArray(data.tracks) || !data.stream || typeof data.stream !== 'object') {
      throw { status: 0, detail: '' };
    }
    return data;
  }

  /* This listener's saved copies of the place: { web, plex }, either null.
     Fails like fetchBook, so the open fails rather than starting from 0 over
     a place it could not see. */
  async function fetchPlaces(key) {
    let clockDone = null;
    try {
      clockDone = typeof saver.clockProbe === 'function' ? saver.clockProbe() : null;
    } catch (e) { /* no clock measure */ }
    let resp;
    try {
      resp = await fetchFn('/api/player/position/' + encodeURIComponent(key), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
    } catch (e) {
      throw { status: 0, detail: '' };
    }
    if (!resp.ok) throw { status: resp.status, detail: '' };
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw { status: 0, detail: '' };
    }
    if (!data || typeof data !== 'object') throw { status: 0, detail: '' };
    // The clock first, so the local copy is weighed in the server's time.
    try {
      if (clockDone) clockDone(data.now);
    } catch (e) { /* no clock measure */ }
    // plexError: Plex could not be read (its null is no answer, not "no place").
    return { web: data.web || null, plex: data.plex || null, now: typeof data.now === 'string' ? data.now : null,
      plexError: data.plex_error === true };
  }

  function makeBook(key, data) {
    const tracks = data.tracks.map(function (t) {
      const format = {
        container: String(t.container || ''),
        codec: String(t.codec || ''),
        profile: String(t.profile || '')
      };
      return Object.freeze({
        key: String(t.key),
        part_path: String(t.part_path || ''),
        duration_ms: durationOf(t),
        index: t.index,
        container: format.container,
        codec: format.codec,
        profile: format.profile,
        undecodable: undecodable(format)
      });
    });
    const starts = [];
    let sum = 0;
    tracks.forEach(function (t) {
      starts.push(sum);
      sum += t.duration_ms;
    });
    const chapters = Object.freeze((Array.isArray(data.chapters) ? data.chapters : []).map(function (c) {
      return Object.freeze(Object.assign({}, c));
    }));
    return {
      key: key,
      title: String(data.title || ''),
      author: String(data.author || ''),
      narrator: String(data.narrator || ''),
      series: String(data.series || ''),
      cover: String(data.cover || ''),
      tracks: tracks,
      starts: starts,
      durationMs: sum,
      chapters: chapters
    };
  }

  function openError(e, retryFn) {
    const status = e && typeof e.status === 'number' ? e.status : 0;
    const detail = e && e.detail ? e.detail : '';
    if (status === 401) return { code: 'signed-out', message: 'Your session has ended. Sign in again to listen.', retry: null };
    if (status === 403) return { code: 'forbidden', message: detail || "Your account can't play audiobooks here.", retry: null };
    if (status === 404) return { code: 'not-found', message: "This book isn't available.", retry: null };
    if (status === 429) return { code: 'busy', message: 'Too many requests. Try again in a moment.', retry: retryFn };
    return { code: 'unreachable', message: UNREACHABLE, retry: retryFn };
  }

  // Stops whatever plays and forgets the book (the connection choice stays).
  function teardown() {
    // The saves first, while they still know the place: its last save.
    if (saver) {
      try {
        saver.stop();
      } catch (e) {
        console.error('[player] saving failed', e);
      }
    }
    resumedFrom = null;
    unchosen = false;
    if (files && files.timer !== null && files.timer !== undefined) clearT(files.timer);
    files = null;
    net = null;
    preview = null;
    stopCeiling();
    checking = null;
    quietSince = null;
    plexSeenAt = -Infinity;
    plexAsked = null;
    if (rechecking) rechecking.stop();
    wasPlaying = false;
    gen += 1;
    wantPlay = false;
    pending = true;
    seekApplied = false;
    metaLoaded = false;
    partSuspect = null;
    disarm();
    Array.from(probes.values()).forEach(function (finish) { finish(false); });
    try {
      audio.pause();
    } catch (e) { /* already */ }
    release();
    book = null;
    stream = null;
    cur = null;
    playhead = null;
    target = null;
    hold = null;
    error = null;
    errorRetry = null;
    setLoading(false);
    proven.clear();
    tried.clear();
    refreshed = false;
    // Nothing plays: the lock screen shows nothing (a failed open included).
    if (session) {
      try {
        session.metadata = null;
        session.playbackState = 'none';
      } catch (e) { /* not supported */ }
    }
  }


  /* The listener's places on books that left the library, which this book
     might be (GET /api/player/orphans/<key>): a list (empty: none), or null
     for a lookup that failed or took ORPHANS_WAIT_MS. A failed lookup is not
     "none": the book stays held (see open). */
  async function lookupOrphans(key) {
    let timer = null;
    const timeout = new Promise(function (resolve) {
      timer = setT(function () {
        timer = null;
        resolve(null);
      }, ORPHANS_WAIT_MS);
    });
    const asked = (async function () {
      const resp = await fetchFn('/api/player/orphans/' + encodeURIComponent(key), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data || !Array.isArray(data.orphans)) return null;
      return orphanList(data.orphans);
    })().catch(function () { return null; });
    const got = await Promise.race([asked, timeout]);
    if (timer !== null) clearT(timer);
    return got;
  }

  async function open(key, opts) {
    opts = opts || {};
    key = key == null ? '' : String(key);
    if (!key) return;
    const autoplay = opts.autoplay !== false;
    if (book && book.key === key && !opts.at && !error) {
      if (autoplay) await play();
      return;
    }
    const my = ++openGen;
    teardown();
    if (noSaver) {
      // Never play from 0:00 over a place it can't read or save.
      lastOpen = null;
      error = { code: 'unsupported', message: PLAYER_BROKEN };
      errorRetry = null;
      emit('error', { code: 'unsupported', message: PLAYER_BROKEN, retry: null });
      changed('error');
      return;
    }
    lastOpen = { key: key, opts: opts };
    setLoading(true);
    changed('loading');
    const resume = !!saver && !opts.at && opts.resume !== false;
    const placesAsked = resume ? fetchPlaces(key).then(
      function (v) { return { places: v }; },
      function (e) { return { failed: e }; }
    ) : null;
    // The safety net (spec 2.6): with no place of the listener's in the book
    // at all, their places on books that left the library are asked for,
    // alongside the book. Never an error: a lookup that fails is no question.
    // The copies are weighed once (the open weighs them again below). What
    // comes of it: undefined (not asked), a list (the answer, empty or not)
    // or null (a lookup that failed, or one that could not be made because
    // Plex could not be read: a place there may be unseen).
    let weighed = null;
    const orphansAsked = placesAsked ? placesAsked.then(function (got) {
      if (!got.places || opts.at) return undefined;
      try {
        weighed = saver.resumeFrom(key, got.places) || [];
      } catch (e) {
        console.error('[player] saving failed', e);
        return undefined;
      }
      // A copy this browser only kept as the book's opening place (opened,
      // never played or moved here) is no place of the listener's: a lookup
      // that failed at the last open must not hide the question now.
      const local = localCopy(key);
      const mine = weighed.filter(function (c) { return !(c.source === 'local' && !(local && local.own === true)); });
      if (mine.length) return undefined;
      return got.places.plexError ? null : lookupOrphans(key);
    }) : null;
    let data;
    let places = null;
    let orphans;
    try {
      data = await fetchBook(key, false);
      if (placesAsked) {
        const got = await placesAsked;
        if (got.failed) throw got.failed;
        places = got.places;
        orphans = await orphansAsked;
      }
    } catch (e) {
      if (my !== openGen) return;
      const err = openError(e, function () { return open(key, opts); });
      setLoading(false);
      error = { code: err.code, message: err.message };
      errorRetry = err.retry;
      emit('error', err);
      changed('error');
      return;
    }
    if (my !== openGen) return;
    book = makeBook(key, data);
    stream = { token: String(data.stream.token || ''), uris: data.stream.uris || {} };
    if (!book.tracks.length) {
      stopWith('empty', 'This book has nothing to play.', null);
      return;
    }
    let startMs = 0;
    if (opts.at) {
      const b = typeof opts.at === 'object' ? toBookMs(book.tracks, opts.at.track, opts.at.offset_ms) : null;
      if (b === null) {
        const track = typeof opts.at === 'object' ? opts.at.track : opts.at;
        book = null;
        stream = null;
        setLoading(false);
        // Listeners saw 'loading': they see it end, with no book and no place.
        changed('close');
        throw new UnknownTrack(track);
      }
      startMs = b;
    }
    // Where the listener left off: the newest copy. When its part is not in
    // the book, or it is the place in an earlier copy of the book (the web
    // copy's linked_from), the book's files changed (spec 2.5): the book
    // opens held at its start for the listener to place it, and never jumps
    // anywhere on its own (not even to an older copy whose part it has).
    let resumed = null;
    let changedFrom = null;
    if (places && places.plex && typeof places.plex === 'object') {
      const t = Date.parse(places.plex.updated_at);
      if (isFinite(t)) plexSeenAt = t;
    }
    if (places) {
      let order = [];
      try {
        order = weighed || saver.resumeFrom(key, places) || [];
      } catch (e) {
        console.error('[player] saving failed', e);
      }
      // A copy this browser only kept as a book's opening place (never played
      // or moved here) is no place of the listener's, so one in a part the
      // book no longer has (its files were replaced since) is not a place
      // that changed: it is skipped, as the safety net's lookup skips it.
      const kept = localCopy(key);
      const untouched = !(kept && kept.own === true);
      const newest = order.find(function (c) {
        return !(c.source === 'local' && untouched && toBookMs(book.tracks, c.track, c.offset_ms) === null);
      }) || null;
      if (newest) {
        const b = toBookMs(book.tracks, newest.track, newest.offset_ms);
        const w = places.web && typeof places.web === 'object' ? places.web : null;
        const link = newest.source === 'web' && w && typeof w.linked_from === 'string' && w.linked_from ? w.linked_from : null;
        if (b === null || link) {
          const raw = newest.source === 'web' ? w : newest.source === 'plex' ? places.plex : localCopy(key);
          changedFrom = oldPlaceOf(newest, raw, link);
        } else {
          startMs = b;
          resumed = newest;
        }
      }
    }
    // The handoff gate sees this browser's own copy before the open can
    // overwrite it (features.js). A hold opens paused at WebServarr's place
    // ({ at: 'web' }), at Plex's ({ at: 'plex' }: a Plex app's place that
    // beats this browser's own unsaved one), or at this browser's own
    // ({ at: 'own' }: stamped later, or that place can't play here);
    // nothing is pushed then.
    const mine = places ? own() : null;
    let webCopy = null;
    let plexCopy = null;
    let held = null;
    const copyFrom = function (source, w) {
      return { source: source, track: String(w.track), offset_ms: Number(w.offset_ms), duration_ms: Number(w.duration_ms) || 0,
        updated_at: w.updated_at, device: typeof w.device === 'string' ? w.device : '', device_id: w.device_id || '' };
    };
    if (places && places.web && typeof places.web === 'object') webCopy = copyFrom('web', places.web);
    if (places && places.plex && typeof places.plex === 'object') plexCopy = copyFrom('plex', places.plex);
    // The files changed: the listener places the book first; the handoff
    // and conflict rules then apply to that place (through its save).
    const lookupFailed = orphans === null && !changedFrom;
    const asking = !changedFrom && (lookupFailed || !!(orphans && orphans.length));
    // The question starts the book at its start, whatever opening place this
    // browser kept (the lookup found it is no place of the listener's).
    if (asking && resumed) {
      resumed = null;
      startMs = 0;
    }
    if (openGate && places && !opts.at && !changedFrom && !asking) {
      const msOf = function (c) { return c ? toBookMs(book.tracks, c.track, c.offset_ms) : null; };
      const canPlay = function (ms) { return ms !== null && !blocked(toTrackOffset(book.tracks, ms).index); };
      const webMs = msOf(webCopy);
      const plexMs = msOf(plexCopy);
      const playable = canPlay(webMs);
      try {
        held = openGate({
          book: key,
          resumed: resumed ? Object.assign({}, resumed, { bookMs: startMs }) : null,
          web: webCopy ? Object.assign({}, webCopy, { bookMs: webMs, playable: playable }) : null,
          plex: plexCopy ? Object.assign({}, plexCopy, { bookMs: plexMs, playable: canPlay(plexMs) }) : null,
          own: mine,
          now: places.now || null,
          me: me()
        }) || null;
      } catch (e) {
        console.error('[player] the open gate failed', e);
        held = null;
      }
      if (held && held.at === 'own' && mine) {
        startMs = mine.bookMs;
        resumed = Object.assign({ source: 'local' }, mine);
      } else if (held && held.at === 'plex' && plexMs !== null) {
        startMs = plexMs;
        resumed = plexCopy;
      } else if (held && held.at !== 'plex' && webMs !== null) {
        startMs = webMs;
        resumed = webCopy;
      } else {
        held = null;
      }
    }
    const to = toTrackOffset(book.tracks, startMs);
    playhead = { index: to.index, offset: to.offset_ms };
    target = { index: to.index, offset: to.offset_ms };
    const cannot = blocked(to.index);
    let age = null;
    if (resumed && places) {
      const a = Date.parse(places.now) - Date.parse(resumed.updated_at);
      if (isFinite(a)) age = Math.max(0, a);
    }
    resumedFrom = resumed ? { source: resumed.source, device: resumed.device, updated_at: resumed.updated_at, age_ms: age } : null;
    // spot: the helper's chosen spot (book ms), where Play previews while held.
    files = changedFrom ? { old: changedFrom, spot: startMs, pending: null, reading: false, asked: false, timer: null, play: false } : null;
    net = asking ? { orphans: lookupFailed ? [] : orphans, failed: lookupFailed, autoplay: autoplay } : null;
    if (saver) {
      try {
        saver.start(key, {
          // A local copy newer than the server's goes to the server at once
          // (not for a part that can't play here, nor while the handoff
          // question holds the open: nothing is saved then), but only this
          // browser's own place the server never took: a copy of an opening
          // place nobody listened from, or one the server has, is no newer
          // listening to send (it would take the row from the device that
          // saved it, which then gets a false 409).
          push: !!(resumed && resumed.source === 'local' && mine && mine.own === true && mine.acked !== true) &&
            !cannot && !held,
          // The local copy of an untouched opening place keeps this stamp.
          openedAt: resumed ? resumed.updated_at : null,
          savedAt: places && places.web ? places.web.updated_at : null,
          held: held ? webCopy : resumed && resumed.source === 'web' ? resumed : null,
          // This browser's own place stays in the local copy until the
          // listener answers, plays or moves: while the question shows, and
          // while that place is one the server never took.
          keepLocal: !!held || !!files || !!net || !!(mine && mine.own === true && mine.acked !== true),
          // The files changed, or the safety net's question is open: nothing
          // is saved, and the local copy keeps what it has, until the
          // listener places the book or answers.
          files: !!files || !!net
        });
      } catch (e) {
        console.error('[player] saving failed', e);
      }
    }
    installSession();
    sessionMetadata();
    // The saved places were just read (or the place was given): a Play from
    // here is not late until RECHECK_AFTER_MS of not playing.
    quietSince = wallNow();
    changed('open');
    if (files) emit('warning', { kind: 'files-changed', book: key, old: Object.assign({}, files.old) });
    if (net) emit('warning', { kind: 'safety-net', book: key, failed: net.failed, orphans: net.orphans.map(function (o) { return Object.assign({}, o); }) });
    if (cannot) {
      unchosen = true;
      // The place as it was given: a saved place at the very end of the part
      // before stays there, rather than becoming the start of this one.
      const given = opts.at && typeof opts.at === 'object' ? opts.at : resumed;
      let at = null;
      if (given) {
        const gi = book.tracks.findIndex(function (t) { return t.key === String(given.track); });
        if (gi !== -1 && gi !== to.index && !blocked(gi)) {
          const off = Number(given.offset_ms);
          at = { index: gi, offset: clampNumber(isFinite(off) ? off : 0, 0, durationOf(book.tracks[gi])) };
        }
      }
      formatStop(at);
      return;
    }
    const side = await chooseSide(to.index);
    if (my !== openGen || !book) return;
    if (!side) {
      stopWith('unreachable', UNREACHABLE, retry);
      return;
    }
    chosen = side;
    // Held (the handoff question, or the files changed): loaded, not played.
    // The open's own finding, not `files`: a confirm or startOver during the
    // connection choice has ended the hold, and is no Play either.
    wantPlay = (autoplay && !held && !changedFrom && !asking) || wantPlay;
    load(playhead.index, playhead.offset, side);
    sessionState();
    changed(wantPlay ? 'play' : 'ready');
  }

  // ---- Controls ----

  function atEnd() {
    return !!(book && playhead && playhead.index === book.tracks.length - 1 &&
      playhead.offset >= durationOf(book.tracks[playhead.index]));
  }

  /* Play. Held for the book's changed files (the bar, the keyboard, the
     lock screen and Retry all come here), it only ever plays a bounded
     preview: it resumes one paused before its end, else starts a fresh one
     at the helper's chosen spot. Nothing else plays until the listener
     places the book. */
  function play() {
    // The safety net's question is open (the lock screen's Play included):
    // nothing plays until the listener answers it.
    if (net && book) return Promise.resolve();
    // A Play while a Plex app's question is read again: the answer that
    // follows may play (recheckPlex).
    if (rechecking) rechecking.paused = false;
    if (files && book) return heldPlay(playOn);
    return playOn();
  }

  function heldPlay(resume) {
    // While a confirm reads the saved places, a Play plays on from where
    // it lands (land); meanwhile it is a preview, as ever.
    if (files.reading) files.play = true;
    if (previewPaused()) return resume();
    if (wantPlay) return Promise.resolve();
    startPreview(files.spot);
    return Promise.resolve();
  }

  // A preview stopped (paused, or by a failure) before its end.
  function previewPaused() {
    return !!(files && preview && !preview.done && !wantPlay);
  }

  function playOn() {
    if (!book) return Promise.resolve();
    if (error) return retryOn();
    if (wantPlay) return Promise.resolve();
    // The format first: at the end of a book whose first part can't play
    // here there is nothing to re-check.
    if (cur && atEnd() && blocked(0)) {
      formatStop(null);
      return Promise.resolve();
    }
    if (lateCheck(play, true)) return Promise.resolve();
    wantPlay = true;
    if (!cur) {
      // Still choosing a connection: open() starts it.
      changed('play');
      return Promise.resolve();
    }
    if (atEnd()) {
      if (blocked(0)) {
        formatStop(null);
        return Promise.resolve();
      }
      hold = null;
      load(0, 0, cur.side);
    } else {
      startPlay();
    }
    sessionState();
    changed('play');
    return Promise.resolve();
  }

  function pause() {
    if (checking && checking.plays) {
      // A late Play still reading the saved places: it does not happen, and
      // an element playing meanwhile (from outside) stops too.
      checking = null;
      stopElement();
      changed('checking');
      return;
    }
    if (!book) return;
    if (!wantPlay) {
      // The element playing on its own, unknown to the engine: Pause always
      // stops it.
      stopElement();
      return;
    }
    wantPlay = false;
    disarm();
    try {
      audio.pause();
    } catch (e) { /* already */ }
    sessionState();
    changed('pause');
  }

  // Stops the element where the engine doesn't want it playing. Its queued
  // 'pause' finds wantPlay off and changes nothing.
  function stopElement() {
    if (audio.paused) return;
    try {
      audio.pause();
    } catch (e) { /* already */ }
  }

  // The listener's Pause (the bar, the keyboard, the lock screen): it also
  // takes back a Play made while a confirm reads the saved places.
  function userPause() {
    if (files) files.play = false;
    // Paused while a Plex app's question is read again (even with nothing
    // playing): the answer that follows does not play (recheckPlex).
    if (rechecking) rechecking.paused = true;
    pause();
  }

  function toggle() {
    // The bar's button and the keyboard: Pause whenever anything plays.
    if (wantPlay || (checking && checking.plays) || (book && !audio.paused)) userPause();
    else return play();
  }

  // extra: more for the change (confirmPlace's { place: true }).
  function seek(bookMs, reason, rewind, answer, extra) {
    if (!book || !playhead) return;
    // The safety net's question is open: the book stays at its start.
    if (net) return;
    const v = Number(bookMs);
    if (!isFinite(v)) return;
    // A move while paused, after RECHECK_AFTER_MS quiet, is saved at once:
    // like a late Play it reads the saved places first (smart rewind is no
    // move of the listener's, and only follows a Play).
    // The confirm's own move (extra.place) never waits on that read: it is
    // the listener's explicit choice, and the hold it ends must not end
    // without it.
    if (!wantPlay && !rewind && !(extra && extra.place)) {
      const again = function () { seek(v, reason, rewind, false, extra); };
      again.answer = !!answer;
      if (lateCheck(again, false)) return;
    }
    const from = bookMsNow();
    const to = toTrackOffset(book.tracks, clampNumber(v, 0, book.durationMs));
    if (blocked(to.index)) {
      // Not into a part that can't play here: refused. Playback, the place
      // and saving carry on as they were.
      emit('warning', { kind: 'part-format', message: PART_FORMAT });
      return;
    }
    // Held for the book's changed files, a move (a seek, skip, chapter jump,
    // the lock screen's seekto, the scrubber) only moves the helper's chosen
    // spot: it ends the preview, and playback with it. Playback while held
    // is only ever a bounded preview.
    if (files && reason !== 'preview') {
      if (preview) preview.done = true;
      if (wantPlay) pause();
    }
    hold = null;
    partSuspect = null;
    const next = { index: to.index, offset: to.offset_ms };
    if (error || !cur) {
      // Nothing loaded (an error, or still choosing): the place moves, and
      // play or retry loads it.
      playhead = next;
      target = { index: next.index, offset: next.offset };
    } else if (to.index === cur.index && metaLoaded) {
      playhead = next;
      target = { index: next.index, offset: next.offset };
      seekApplied = true;
      try {
        audio.currentTime = next.offset / 1000;
      } catch (e) { /* applied with the next load */ }
    } else if (to.index === cur.index && pending && !seekApplied && failedGen !== gen) {
      // Its metadata is still loading: it seeks there when it arrives. (A
      // load that failed is loaded again, which also ends its recovery.)
      playhead = next;
      target = { index: next.index, offset: next.offset };
    } else {
      load(next.index, next.offset, cur.side);
    }
    // Held for the book's changed files, the listener's move is the helper's
    // chosen spot (a preview's own move already set it).
    if (files && reason !== 'preview') files.spot = bookMsNow();
    const detail = rewind ? { from: from, to: bookMsNow(), rewind: true } : { from: from, to: bookMsNow() };
    changed(reason || 'seek', Object.assign(detail, extra || {}));
  }

  // Where a preview from a book time must stop before: the start of the
  // next part this browser can't decode, else the book's end.
  function previewWall(ms) {
    const i = toTrackOffset(book.tracks, ms).index;
    for (let j = i + 1; j < book.tracks.length; j++) {
      if (blocked(j)) return book.starts[j];
    }
    return book.durationMs;
  }

  // A preview from a book time: PREVIEW_MS of it, stopping PREVIEW_END_GAP_MS
  // short of that wall (so it never ends the book or reaches a part that
  // can't play: the element's end of a part would go on into it).
  function previewFrom(ms) {
    return {
      start: ms, end: Math.min(ms + PREVIEW_MS, previewWall(ms) - PREVIEW_END_GAP_MS), done: false, played: 0, lastWall: null,
      // The ceiling's clock: wall ms spent wanted playing, stalls and
      // buffering included (wallFrom: since when it is running, or null).
      wallUsed: 0, wallFrom: wantPlay ? wallNow() : null
    };
  }

  /* A preview never outlasts PREVIEW_CEILING_MS of wall clock spent playing,
     whatever the element reports: a stream that stalls before every
     timeupdate (each step counting 1 s at most above) can't stretch it. Asked
     at every event that tells the time (a timeupdate, waiting, playing). */
  function stopCeiling() {
    if (ceilingTimer !== null) clearT(ceilingTimer);
    ceilingTimer = null;
  }

  // The ceiling also has a timer of its own, so a stream that reports nothing
  // at all can't outlast it either.
  function armCeiling(p) {
    stopCeiling();
    ceilingTimer = setT(function () {
      ceilingTimer = null;
      if (preview === p) previewCeiling();
    }, Math.max(0, PREVIEW_CEILING_MS - p.wallUsed));
  }

  function previewCeiling() {
    if (!files || !preview || preview.done || !wantPlay || preview.wallFrom === null) return;
    if (preview.wallUsed + (wallNow() - preview.wallFrom) >= PREVIEW_CEILING_MS) {
      preview.done = true;
      pause();
    }
  }

  /* Starts a preview at a book time (see previewAt); false when it is in a
     part this browser can't decode. Too close to the wall, it is the
     PREVIEW_MS before it (within the part). */
  function startPreview(ms) {
    let start = clampNumber(ms, 0, book.durationMs);
    const at = toTrackOffset(book.tracks, start);
    if (blocked(at.index)) {
      emit('warning', { kind: 'part-format', message: PART_FORMAT });
      return false;
    }
    const wall = previewWall(start);
    if (start > wall - PREVIEW_END_GAP_MS) start = Math.max(book.starts[at.index], wall - PREVIEW_MS);
    preview = previewFrom(start);
    stopCeiling();
    if (wantPlay) armCeiling(preview);
    files.spot = start;
    seek(start, 'preview');
    if (!wantPlay) {
      const p = playOn();
      if (p && typeof p.catch === 'function') p.catch(function (e) { console.error('[player] the preview failed', e); });
    }
    return true;
  }

  /* The book's files changed (spec 2.5): play PREVIEW_MS from a spot without
     saving, then pause. A second call replaces the first. At the very end of
     the book, the PREVIEW_MS before it, stopping short of the end (a preview
     never ends the book). Refused (false) when the book is not held, or
     the spot is in a part this browser can't decode ('part-format'). */
  function previewAt(bookMs) {
    if (!files || !book || !playhead) return false;
    const v = Number(bookMs);
    if (!isFinite(v)) return false;
    return startPreview(v);
  }

  /* The book's files changed: the listener places it at bookMs. An explicit
     move (a 'seek' change marked { place: true }): the hold ends, and that
     move is saved (once; it ends any floor, and compare-and-swap applies as
     for any save). link: the place came from an earlier copy of the book, so
     its key goes with the saves until the server links it (ruling (c): only
     for a spot the listener confirms, never startOver). Refused (false) when
     the book is not held, or the spot is in a part this browser can't
     decode.
     The held playhead moves to the spot at once. The saved places are then
     always read again first, still held: the confirm lands when the read
     ends (or after RECHECK_WAIT_MS). If another device, or a Plex
     app, saved a newer place meanwhile, that is asked about (a 'conflict'
     warning) inside the hold, and the confirm waits for the answer
     (resolveConflict): Continue's move to the other place, else the spot
     confirmed. Play or Pause meanwhile only preview: the book stays held
     until the confirm's move lands. */
  function place(bookMs, link) {
    if (!files || !book || !playhead) return false;
    const n = Number(bookMs);
    if (!isFinite(n)) return false;
    // A spot in a part this browser can't decode is refused; one the end
    // margin pulls into such a part lands at the last playable spot before
    // it (landingSpot).
    const asked = clampNumber(n, 0, book.durationMs);
    const v = blocked(toTrackOffset(book.tracks, asked).index) ? null : landingSpot(asked, asked);
    if (v === null) {
      emit('warning', { kind: 'part-format', message: PART_FORMAT });
      return false;
    }
    // One the margin would pull back further than PLACE_WALK_MS is never
    // placed unasked: the held spot only moves to it, so the helper shows
    // where it could land and why (a confirm waiting meanwhile lands from it,
    // so it stays held too).
    if (walkedFar(asked, v)) {
      seek(asked);
      return false;
    }
    // A preview playing stops first, still held (nothing is sent for it).
    preview = null;
    pause();
    // A later confirm replaces one still waiting on its read or question.
    files.pending = { v: v, link: !!link };
    // The held playhead goes to the spot (the chosen spot with it), so what
    // shows, and any move while the confirm waits, start from there. Still
    // held: nothing is saved for it.
    seek(v, 'seek', false, false, { place: true });
    files.spot = v;
    if (files.reading || files.asked) return true;
    // The saved places are always read again first: another device or a
    // Plex app may have saved a newer place since the book was held, and a
    // preview (playing) since then shows nothing of it.
    if (saver) {
      confirmRead();
      return true;
    }
    land(v, false);
    return true;
  }

  /* The safety net (spec 2.6): the listener picked one of the places offered
     (state().safetyNet.orphans) as the earlier copy of this book. It goes
     through the "Find your place" helper exactly as an automatically linked
     copy does: the book stays held (nothing saved, the saves already held),
     state().filesChanged is that place, and the same 'files-changed' warning
     follows; confirming it sends linked_from with link_manual. false when no
     question is open or the key is not one of the places. */
  function pickOrphan(orphanKey) {
    if (!net || !book) return false;
    const key = String(orphanKey);
    const picked = net.orphans.find(function (o) { return o.key === key; });
    if (!picked) return false;
    // fromNet: where "Not this book" (unpickOrphan) goes back to.
    const fromNet = { orphans: net.orphans, autoplay: net.autoplay };
    net = null;
    files = { old: oldPlaceOfOrphan(picked), spot: bookMsNow(), pending: null, reading: false, asked: false, timer: null, play: false, fromNet: fromNet };
    changed('safety-net');
    emit('warning', { kind: 'files-changed', book: book.key, old: Object.assign({}, files.old) });
    return true;
  }

  /* "Not this book": the listener picked a place and has not confirmed it;
     back to the list of places. Nothing was saved and nothing is: the book
     goes back to its start, held, as the question was. false when the book
     is not held by a pick, or a confirm is already waiting (on its read or
     the question that read asked). */
  function unpickOrphan() {
    if (!files || !files.fromNet || !book || !playhead) return false;
    if (files.pending || files.reading || files.asked) return false;
    const back = files.fromNet;
    // A preview stops; the held playhead goes back to the start (still held,
    // so nothing is saved for either).
    preview = null;
    if (wantPlay) pause();
    seek(0, 'seek');
    files = null;
    net = { orphans: back.orphans, failed: false, autoplay: back.autoplay };
    changed('safety-net');
    emit('warning', { kind: 'safety-net', book: book.key, failed: false, orphans: net.orphans.map(function (o) { return Object.assign({}, o); }) });
    return true;
  }

  /* "None of these": the server is told (per listener and book, so it holds
     on every device), the hold ends and the book is a new book: nothing is
     saved until it is played, and it plays now if the open was to play. The
     server is told in the background; if that fails the question comes again
     at the next open, and this open goes on. false when no question is open. */
  function dismissOrphans() {
    if (!net || !book || net.failed) return false;
    const mine = net;
    const key = book.key;
    net = null;
    try {
      Promise.resolve(fetchFn('/api/player/orphans/' + encodeURIComponent(key) + '/dismiss', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      })).then(function (resp) {
        if (!resp || !resp.ok) console.error('[player] "None of these" was not stored', resp && resp.status);
      }, function (e) {
        console.error('[player] "None of these" was not stored', e);
      });
    } catch (e) {
      console.error('[player] "None of these" was not stored', e);
    }
    releaseAsNew(key, mine);
    return true;
  }

  /* The hold ends and the book is a new book: the saves released with no
     place moved (nothing is saved until it is played), and it plays now when
     the open was to play. quietSince is left as the open set it: a Play after
     RECHECK_AFTER_MS reads the saved places first, so a place another device
     or a Plex app saved while the question was open is asked about, never
     overwritten with 0:00. */
  function releaseAsNew(key, held) {
    if (saver && typeof saver.releaseFiles === 'function') {
      try {
        saver.releaseFiles(key, null, { startOver: true });
      } catch (e) {
        console.error('[player] saving failed', e);
      }
    }
    changed('safety-net');
    if (held.autoplay) {
      const p = play();
      if (p && typeof p.catch === 'function') p.catch(function (e) { console.error('[player] playing failed', e); });
    }
  }

  /* The safety net's lookup failed (state().safetyNet.failed): the listener
     chose to start this book as a new book anyway. Nothing is stored on the
     server (nothing was asked); otherwise as "None of these". false when no
     failed lookup is waiting. */
  function startAsNew() {
    if (!net || !book || !net.failed) return false;
    const mine = net;
    net = null;
    releaseAsNew(book.key, mine);
    return true;
  }

  /* "Try again" after a failed lookup: the book is opened afresh as it was
     (the saved places read again, the lookup made again), so whatever the
     second try finds decides: a place to resume, the question, or a new
     book. Held meanwhile; if it fails again, the same hold returns. false
     when no failed lookup is waiting. */
  function retryOrphans() {
    if (!net || !book || !net.failed || !lastOpen) return false;
    const again = lastOpen;
    teardown();
    const p = open(again.key, again.opts);
    if (p && typeof p.catch === 'function') p.catch(function (e) { console.error('[player] opening failed', e); });
    return true;
  }

  // How far into the book a confirm may place it: PLACE_END_MS short of the
  // end (0 for a shorter book). A place at the very end would make the next
  // Play start the book again from 0:00.
  function placeLimit() {
    return Math.max(0, book.durationMs - PLACE_END_MS);
  }

  /* Where a confirm lands for `at`: within placeLimit(), in a part this
     browser can play. Clamped into a part it can't (a book whose last
     30 s are in one), the last playable spot before it, PLACE_END_MS short
     of that part's end where the part is long enough; with none, the spot
     the confirm was made at (place() checked it); else null. A spot that
     is in such a part without the margin's pull is returned as it is. */
  function landingSpot(at, fallback) {
    const lim = placeLimit();
    const v = clampNumber(Number(at) || 0, 0, lim);
    const i = toTrackOffset(book.tracks, v).index;
    // Only the margin's pull is moved on: a spot asked for in such a part is
    // the listener's, and seek() refuses it as ever.
    if (!blocked(i) || v >= (Number(at) || 0)) return v;
    for (let j = i - 1; j >= 0; j--) {
      if (blocked(j)) continue;
      const end = book.starts[j] + durationOf(book.tracks[j]);
      return Math.max(book.starts[j], Math.min(lim, end - PLACE_END_MS));
    }
    const f = clampNumber(Number(fallback), 0, lim);
    return isFinite(f) && !blocked(toTrackOffset(book.tracks, f).index) ? f : null;
  }

  // A landing at `to` for a spot asked at `at` moved further than
  // PLACE_WALK_MS from where the end margin alone puts `at` (a part this
  // browser can't decode in between, or the confirm's own spot taken
  // instead): never done without the listener seeing it.
  function walkedFar(at, to) {
    return Math.abs(clampNumber(Number(at) || 0, 0, placeLimit()) - to) > PLACE_WALK_MS;
  }

  // The confirm lands at `at` (the chosen spot: a move made while it waited
  // counts, within placeLimit() and playable here: landingSpot): the hold
  // ends, then its one explicit move. Never one without the other: with
  // nowhere playable to land, or only further than PLACE_WALK_MS from it,
  // the book stays held (a 'part-format' warning, landing: true) for the
  // listener to choose again, the spot left where it was so the helper
  // shows where it could land. exact: `at` is another device's or a Plex
  // app's place (the question's Continue): there exactly, no end margin,
  // where it can play. A confirmPlace's link goes with it wherever it lands
  // (never a startOver's). carry: a Play made while the confirm read the
  // saved places plays on from there, never from the book's end (it would
  // start again).
  function land(at, carry, exact) {
    const p = files.pending;
    const old = files.old;
    const there = clampNumber(Number(at) || 0, 0, book.durationMs);
    const isExact = !!exact && !blocked(toTrackOffset(book.tracks, there).index);
    let to = isExact ? there : landingSpot(at, p.v);
    // Never a seek that would be refused: then the spot the confirm was
    // made at, else nowhere (held).
    if (to !== null && blocked(toTrackOffset(book.tracks, to).index)) to = landingSpot(p.v, null);
    if (to !== null && blocked(toTrackOffset(book.tracks, to).index)) to = null;
    if (to !== null && !isExact && walkedFar(at, to)) to = null;
    preview = null;
    if (!carry) pause();
    if (files.timer !== null && files.timer !== undefined) clearT(files.timer);
    if (to === null) {
      files.timer = null;
      files.pending = null;
      files.reading = false;
      files.asked = false;
      if (carry) pause();
      emit('warning', { kind: 'part-format', message: PART_FORMAT, landing: true });
      changed('checking');
      return;
    }
    files = null;
    if (saver && typeof saver.releaseFiles === 'function') {
      try {
        saver.releaseFiles(book.key, p.link && old.linked_from ? old.linked_from : null,
          { startOver: !p.link, manual: !!old.manual });
      } catch (e) {
        console.error('[player] saving failed', e);
      }
    }
    seek(to, 'seek', false, true, { place: true });
    if (carry && book && !wantPlay && !atEnd()) {
      const pr = playOn();
      if (pr && typeof pr.catch === 'function') pr.catch(function (e) { console.error('[player] playing failed', e); });
    }
  }

  /* A confirm: the saved places read again, still held
     (state().checking meanwhile). Asked: the confirm waits for the answer.
     Else (nothing newer, or the read failed or took RECHECK_WAIT_MS) it
     lands. */
  function confirmRead() {
    const my = files;
    const key = book.key;
    const gen0 = openGen;
    let seen = null;
    try {
      seen = typeof saver.lastSeen === 'function' ? saver.lastSeen(key) : null;
    } catch (e) {
      seen = null;
    }
    my.reading = true;
    my.play = false;
    function finish(places) {
      if (my.timer !== null) clearT(my.timer);
      my.timer = null;
      if (files !== my || !my.reading || openGen !== gen0 || !book || book.key !== key) return;
      my.reading = false;
      let asked = false;
      try {
        asked = !!places && !!seen && askIfElsewhere(places, seen, my.spot);
      } catch (e) {
        console.error('[player] the re-check failed', e);
      }
      if (asked) {
        my.asked = true;
        changed('checking');
        return;
      }
      quietSince = wallNow();
      changed('checking');
      land(my.spot, !!my.play);
    }
    my.timer = setT(function () {
      my.timer = null;
      finish(null);
    }, RECHECK_WAIT_MS);
    let asking;
    try {
      asking = fetchPlaces(key);
    } catch (e) {
      asking = Promise.reject(e);
    }
    asking.then(finish, function () { finish(null); });
    changed('checking');
  }

  function skip(deltaS) {
    const d = Number(deltaS);
    if (!book || !isFinite(d)) return;
    // Waiting on a late move's read, a skip stays relative: three skips back
    // queued behind one read go back three times, from wherever it is then.
    if (!wantPlay && lateCheck(function () { skip(d); }, false)) return;
    // Held for the book's changed files, a skip moves the helper's chosen
    // spot (the place a confirm waits to land at, too), not the playhead (a
    // preview's, or where the hold left it).
    seek((files ? files.spot : bookMsNow()) + d * 1000, 'skip');
  }

  function jumpToChapter(i) {
    if (!book) return;
    const c = book.chapters[Number(i)];
    if (!c) return;
    seek(Number(c.start_ms), 'jump');
  }

  function setSkip(x) {
    const v = roundSkip(x);
    if (v !== null && v !== skipS) {
      skipS = v;
      // So what shows the skip length follows, while paused too.
      changed('prefs');
    }
    return skipS;
  }

  /* The listener's settings, as loaded or changed (features.js): numbers
     only; anything else leaves that one as it is. One 'prefs' change after. */
  function applyPrefs(p) {
    p = p || {};
    const s = roundSkip(p.skip);
    if (s !== null) skipS = s;
    const v = typeof p.speed === 'number' ? roundSpeed(p.speed) : null;
    if (v !== null) {
      speed = v;
      applyRate();
    }
    changed('prefs');
    return { skip: skipS, speed: speed };
  }

  /* The element's volume, 0 to 1 (the sleep timer's fade); no argument, or
     anything but a finite number, only reads it. Where the browser does not
     let a page set it (iOS), it stays as it is. */
  function setVolume(x) {
    if (typeof x === 'number' && isFinite(x)) {
      try {
        audio.volume = clampNumber(x, 0, 1);
      } catch (e) { /* not settable here */ }
    }
    const v = Number(audio.volume);
    return isFinite(v) ? v : 1;
  }

  /* The book's parts in book time, and whether each can play here (not a
     format this browser cannot decode): [{ start_ms, duration_ms, playable }]. */
  function parts() {
    if (!book) return [];
    return book.tracks.map(function (t, i) {
      return { start_ms: book.starts[i], duration_ms: t.duration_ms, playable: !t.undecodable };
    });
  }

  function setSpeed(x) {
    const v = roundSpeed(x);
    if (v === null) return speed;
    speed = v;
    applyRate();
    changed('speed');
    return speed;
  }

  // Held for the book's changed files, Retry (as Play) only plays a preview.
  function retry() {
    if (net && book) return Promise.resolve();
    if (files && book) return heldPlay(retryOn);
    return retryOn();
  }

  function retryOn() {
    if (!book) {
      if (lastOpen) return open(lastOpen.key, lastOpen.opts);
      return Promise.resolve();
    }
    if (!error || !playhead) return Promise.resolve();
    // From the place held after a skipped part, else the playhead.
    const from = hold || playhead;
    // Not in, nor at the end of a part just before, a part that can't play
    // here (at the book's end: its first part, where Play starts again).
    if (blocked(from.index) || beforeBlocked(from)) {
      formatStop(null);
      return Promise.resolve();
    }
    if (lateCheck(retry, true)) return Promise.resolve();
    if (unchosen) return retryChoosing(from);
    const side = preferredSide();
    partSuspect = null;
    error = null;
    errorRetry = null;
    tried.clear();
    refreshed = false;
    failedGen = -1;
    wantPlay = true;
    if (!side) {
      stopWith('unreachable', UNREACHABLE, retry);
      return Promise.resolve();
    }
    load(from.index, from.offset, side);
    sessionState();
    changed('retry');
    return Promise.resolve();
  }

  /* Retry in a book that opened into an undecodable part: no connection was
     ever chosen, so choose one now, as open() does (the local gate and
     probe included), then load the place. */
  async function retryChoosing(from) {
    const my = openGen;
    const g = ++gen;
    partSuspect = null;
    error = null;
    errorRetry = null;
    failedGen = -1;
    wantPlay = true;
    setLoading(true);
    changed('retry');
    const side = await chooseSide(from.index);
    if (my !== openGen || g !== gen || !book || error) return;
    unchosen = false;
    if (!side) {
      stopWith('unreachable', UNREACHABLE, retry);
      return;
    }
    chosen = side;
    // Where the place is now (the listener may have moved while the
    // connection was chosen), playing only if they have not paused meanwhile.
    load(playhead.index, playhead.offset, side);
    sessionState();
    changed(wantPlay ? 'play' : 'ready');
  }

  // At the end of a part whose next part can't play here (or, at the end of
  // the book, whose first part can't): nowhere to go on to.
  function beforeBlocked(at) {
    if (!book || at.offset < durationOf(book.tracks[at.index])) return false;
    return at.index + 1 < book.tracks.length ? blocked(at.index + 1) : blocked(0);
  }

  /* A late Play or move: after RECHECK_AFTER_MS without playing (wall
     clock), the saved places are read again before `then` (play, retry, or
     a move while paused; plays: it starts playback) goes on. true: it goes
     on later, from the read, in order with anything asked meanwhile (or not
     at all: another place is newer and the listener is asked, or a Pause
     cancelled the Play). */
  function lateCheck(then, plays) {
    // Held for the book's changed files nothing is saved, so there is
    // nothing to re-check (a confirm re-reads for itself: confirmRead).
    if (files || net) return false;
    if (checking) {
      checking.queue.push(then);
      if (plays) checking.plays = true;
      return true;
    }
    if (!saver || !book || quietSince === null || !(wallNow() - quietSince >= RECHECK_AFTER_MS)) return false;
    let seen = null;
    try {
      seen = typeof saver.lastSeen === 'function' ? saver.lastSeen(book.key) : null;
    } catch (e) {
      seen = null;
    }
    // A 409 not yet answered: its question is the one to answer.
    if (!seen || seen.conflict) return false;
    const key = book.key;
    const my = { open: openGen, queue: [then], plays: !!plays };
    checking = my;
    let timer = null;
    function finish(places) {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      if (checking !== my) return;
      checking = null;
      if (my.open !== openGen || !book || book.key !== key) return;
      let asked = false;
      try {
        asked = !!places && askIfElsewhere(places, seen);
      } catch (e) {
        console.error('[player] the re-check failed', e);
      }
      if (asked) {
        // Held: nothing it was asked for happens, and the quiet time goes
        // on until the listener answers (resolveConflict). Except the move
        // that answered the open's question: it still happens, unsaved (the
        // new question holds saves), so "Keep listening here" means the
        // place the listener chose, and the local copy keeps it (unacked)
        // if they close instead.
        changed('checking');
        my.queue.forEach(function (fn) { if (fn.answer) fn(); });
        return;
      }
      quietSince = wallNow();
      // The read is over (state().checking false) even when nothing queued
      // changes anything (a move refused into a part that can't play).
      changed('checking');
      my.queue.forEach(function (fn) { fn(); });
    }
    timer = setT(function () {
      timer = null;
      finish(null);
    }, RECHECK_WAIT_MS);
    let asking;
    try {
      asking = fetchPlaces(key);
    } catch (e) {
      asking = Promise.reject(e);
    }
    asking.then(finish, function () { finish(null); });
    changed('checking');
    return true;
  }

  /* The places read before a late Play. Another place saved since this page
     last saw the book, and not this very place, holds the Play and asks:
     WebServarr's copy saved by another page session (another device, or
     another tab of this browser), or Plex's copy (not an echo of ours:
     GET /position leaves those out) newer than anything this page saw. The
     newer of the two that is somewhere else is asked about. true: asked. */
  // hereMs: the place to compare with (a confirm's spot), else the playhead's.
  function askIfElsewhere(places, seen, hereAt) {
    const at = hold || playhead;
    if (!book || !at) return false;
    const base = typeof seen.base === 'string' ? Date.parse(seen.base) : NaN;
    const found = [];
    const w = places.web;
    if (w && typeof w === 'object' && !(typeof w.psid === 'string' && w.psid === seen.psid)) {
      const t = Date.parse(w.updated_at);
      if (isFinite(t) && !(t <= base)) found.push({ web: true, copy: w, t: t });
    }
    const p = places.plex;
    if (p && typeof p === 'object') {
      const t = Date.parse(p.updated_at);
      if (isFinite(t)) {
        const since = Math.max(isFinite(base) ? base : -Infinity, plexSeenAt);
        if (t - PLEX_LATER_MS > since) found.push({ web: false, copy: p, t: t });
      }
    }
    found.sort(function (a, b) { return b.t - a.t; });
    const hereMs = typeof hereAt === 'number' ? hereAt : book.starts[at.index] + at.offset;
    const now = typeof places.now === 'string' ? places.now : null;
    for (const f of found) {
      const c = f.copy;
      const otherMs = toBookMs(book.tracks, c.track, c.offset_ms);
      if (otherMs !== null && Math.abs(otherMs - hereMs) <= SAME_PLACE_MS) {
        // This very place: nothing to ask. Its time is what this page has seen.
        if (f.web && typeof saver.adoptBase === 'function') saver.adoptBase(book.key, c.updated_at);
        else if (!f.web) plexSeenAt = Math.max(plexSeenAt, f.t);
        continue;
      }
      const conflict = { track: String(c.track), offset_ms: Number(c.offset_ms),
        device: typeof c.device === 'string' ? c.device : '', updated_at: String(c.updated_at) };
      // Either as a 409: nothing is saved until the listener answers. A Plex
      // app's place keeps the base as it was (the server refused nothing).
      const asked = typeof saver.otherSaved === 'function' && !!saver.otherSaved(book.key, conflict, now, !f.web);
      // A Plex app's place, which nothing on the server guards, is read
      // again before a late answer (recheckPlex).
      plexAsked = asked && !f.web ? { track: conflict.track, offset_ms: conflict.offset_ms, t: f.t } : null;
      return asked;
    }
    return false;
  }

  /* A Plex app's question left showing (features.js; spec 2.5 section 7):
     before its answer, the saved places are read again (RECHECK_WAIT_MS at
     most). Nothing is saved, landed or released meanwhile: the question
     holds the saves, and a confirm's hold, as before. null: no Plex app's
     question waits (nothing to read; the answer goes on). Else a promise
     of 'same' (the Plex app has not moved on: the answer goes on), 'moved'
     (it has: the question is asked again at its new place, a 'conflict'
     warning, and nothing else changes) or 'failed' (the read failed or
     took too long, or the book went: nothing changes). One read at a time:
     a call while one is in progress gets its promise. */
  function recheckPlex() {
    if (rechecking) return rechecking.promise;
    if (!saver || !book || !plexAsked) return null;
    let seen = null;
    try {
      seen = typeof saver.lastSeen === 'function' ? saver.lastSeen(book.key) : null;
    } catch (e) {
      seen = null;
    }
    if (!seen || !seen.conflict) return null;
    const key = book.key;
    const gen0 = openGen;
    const asked = plexAsked;
    let resolve = null;
    const my = { promise: new Promise(function (r) { resolve = r; }), timer: null, stop: null, paused: false };
    function end(result) {
      if (rechecking !== my) return;
      rechecking = null;
      if (my.timer !== null) clearT(my.timer);
      my.timer = null;
      resolve(result === 'same' && my.paused ? 'paused' : result);
    }
    my.stop = function () { end('failed'); };
    // A refused read: 401, the session ended (the saves' sign-in path, as a
    // check-in's 401; nothing is acted on). Any other refusal (a 404: the
    // book is gone) is answered as before this read existed: the answer
    // goes on, and its check-in meets the same refusal ("not saved").
    // Only what may pass (no network, a timeout, 408, 429, 5xx) is 'failed'.
    function refused(e) {
      if (rechecking !== my) return;
      const status = e && typeof e.status === 'number' ? e.status : 0;
      if (status === 401) {
        try {
          if (typeof saver.sessionEnded === 'function') saver.sessionEnded();
        } catch (x) {
          console.error('[player] saving failed', x);
        }
        end('failed');
        return;
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        end('same');
        return;
      }
      finish(null);
    }
    function finish(places) {
      if (rechecking !== my) return;
      // Plex could not be read: its place may have moved unseen.
      if (!places || places.plexError || openGen !== gen0 || !book || book.key !== key || plexAsked !== asked) {
        end('failed');
        return;
      }
      const p = places.plex && typeof places.plex === 'object' ? places.plex : null;
      const t = p ? Date.parse(p.updated_at) : NaN;
      const off = p ? Number(p.offset_ms) : NaN;
      // Moved on: stamped later than the place asked about, and elsewhere.
      if (isFinite(t) && t > asked.t && isFinite(off) &&
          !(String(p.track) === asked.track && Math.abs(off - asked.offset_ms) <= SAME_PLACE_MS)) {
        const conflict = { track: String(p.track), offset_ms: off,
          device: typeof p.device === 'string' ? p.device : '', updated_at: String(p.updated_at) };
        let again = false;
        try {
          again = !!saver.otherSaved(key, conflict, typeof places.now === 'string' ? places.now : null, true);
        } catch (e) {
          console.error('[player] the re-check failed', e);
        }
        if (again) {
          plexAsked = { track: conflict.track, offset_ms: off, t: t };
          end('moved');
          return;
        }
        end('failed');
        return;
      }
      end('same');
    }
    rechecking = my;
    my.timer = setT(function () {
      my.timer = null;
      finish(null);
    }, RECHECK_WAIT_MS);
    let asking;
    try {
      asking = fetchPlaces(key);
    } catch (e) {
      asking = Promise.reject(e);
    }
    asking.then(finish, refused);
    return my.promise;
  }

  function placeMs(track, offsetMs) {
    return book ? toBookMs(book.tracks, track, offsetMs) : null;
  }

  function me() {
    return {
      device_id: saver && typeof saver.deviceId === 'string' ? saver.deviceId : '',
      device: saver && typeof saver.device === 'string' ? saver.device : ''
    };
  }

  // This browser's local copy of a book's place, as saves.js reads it, or null.
  function localCopy(key) {
    if (!saver || typeof saver.readLocal !== 'function') return null;
    try {
      return saver.readLocal(key);
    } catch (e) {
      return null;
    }
  }

  function own() {
    if (!book || !saver || typeof saver.readLocal !== 'function') return null;
    let c = null;
    try {
      c = saver.readLocal(book.key);
    } catch (e) {
      c = null;
    }
    const b = c ? toBookMs(book.tracks, c.track, c.offset_ms) : null;
    const ab = c && c.ackedAt ? toBookMs(book.tracks, c.ackedAt.track, c.ackedAt.offset_ms) : null;
    return c && b !== null ? Object.assign({}, c, { bookMs: b, ackedBookMs: ab }) : null;
  }

  function close() {
    openGen += 1;
    const had = !!(book || error);
    teardown();
    lastOpen = null;
    if (had) changed('close');
  }

  function on(type, fn) {
    const set = handlers[type];
    if (!set || typeof fn !== 'function') return function () {};
    set.add(fn);
    return function () { set.delete(fn); };
  }

  // ---- Media Session (lock screen, headphones, keyboard media keys) ----

  function installSession() {
    if (!session || sessionReady || typeof session.setActionHandler !== 'function') return;
    sessionReady = true;
    const actions = {
      play: function () { play(); },
      pause: function () { userPause(); },
      seekbackward: function (d) { skip(-((d && d.seekOffset) || skipS)); },
      seekforward: function (d) { skip((d && d.seekOffset) || skipS); },
      seekto: function (d) {
        if (d && isFinite(d.seekTime)) seek(Number(d.seekTime) * 1000);
      },
      // Chapters are not skip buttons: no previous and next track.
      previoustrack: null,
      nexttrack: null
    };
    Object.keys(actions).forEach(function (name) {
      try {
        session.setActionHandler(name, actions[name]);
      } catch (e) { /* this browser has no such action */ }
    });
  }

  function sessionMetadata() {
    if (!session) return;
    try {
      if (!book || !Metadata) {
        session.metadata = null;
        return;
      }
      const artwork = [];
      if (book.cover) artwork.push({ src: new URL(book.cover, baseUrl).href });
      session.metadata = new Metadata({ title: book.title, artist: book.author, album: book.series, artwork: artwork });
    } catch (e) { /* not supported */ }
  }

  function sessionState() {
    if (!session) return;
    try {
      session.playbackState = !book ? 'none' : (wantPlay && !error ? 'playing' : 'paused');
    } catch (e) { /* not supported */ }
  }

  function sessionPosition() {
    if (!session || typeof session.setPositionState !== 'function' || !book || !(book.durationMs > 0)) return;
    try {
      session.setPositionState({
        duration: book.durationMs / 1000,
        playbackRate: speed,
        position: Math.min(bookMsNow(), book.durationMs) / 1000
      });
    } catch (e) { /* not supported */ }
  }

  return {
    open: open,
    play: play,
    pause: userPause,
    toggle: toggle,
    seek: function (bookMs, o) { seek(bookMs, 'seek', false, !!(o && o.answer)); },
    // Smart rewind is a playback aid: a preview (the files changed) plays exactly.
    rewind: function (bookMs) { if (!files) seek(bookMs, 'seek', true); },
    previewAt: previewAt,
    pickOrphan: pickOrphan,
    unpickOrphan: unpickOrphan,
    startAsNew: startAsNew,
    retryOrphans: retryOrphans,
    dismissOrphans: dismissOrphans,
    confirmPlace: function (bookMs) { return place(bookMs, true); },
    startOver: function () { return place(0, false); },
    skip: skip,
    jumpToChapter: jumpToChapter,
    setSpeed: setSpeed,
    setSkip: setSkip,
    applyPrefs: applyPrefs,
    setVolume: setVolume,
    parts: parts,
    retry: retry,
    close: close,
    state: state,
    on: on,
    setOpenGate: function (fn) { openGate = typeof fn === 'function' ? fn : null; },
    recheckPlex: recheckPlex,
    resolveConflict: function () {
      if (!saver || typeof saver.resolveConflict !== 'function') return null;
      // Not while a late answer's read is in progress: what it finds decides.
      if (rechecking) return null;
      // Answered: no question waits now (a later one sets its own).
      plexAsked = null;
      let c = null;
      try {
        c = saver.resolveConflict();
      } catch (e) {
        console.error('[player] saving failed', e);
        return null;
      }
      if (c) {
        // Answered: what was asked about is seen now, so the Play that
        // follows goes straight on (no second read, no second question).
        quietSince = wallNow();
        const t = c.plex ? Date.parse(c.updated_at) : NaN;
        if (isFinite(t)) plexSeenAt = Math.max(plexSeenAt, t);
        // A question asked before a confirm (the files changed): the confirm
        // lands now, where the answer left the chosen spot (Continue moved
        // it to the other place; Keep listening here left it). At the other
        // place it lands exactly: that is where the other device or Plex app
        // really is, so neither the end margin nor a walk back applies.
        if (files && files.asked && files.pending) {
          files.asked = false;
          const other = placeMs(c.track, c.offset_ms);
          // The answer decides what plays (features.js plays on it), not
          // a Play made during the read.
          land(files.spot, false, other !== null && files.spot === other);
        }
      }
      return c;
    },
    placeMs: placeMs,
    own: own,
    me: me
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/* Mounts the engine in #wsPlayer as WS.player, once per document. Its fetch
   and timers are the window's own, taken now. Returns the engine, or null on
   a page without the shell. */
export function boot(win, overrides) {
  const WS = win.WS || (win.WS = {});
  if (WS.player) return WS.player;
  const doc = win.document;
  const host = doc.getElementById('wsPlayer');
  if (!host) return null;
  const nav = win.navigator || {};
  // Saving comes from saves.js, loaded as its own module just before this
  // one (WS.playerSaves), so each file keeps its own asset stamp.
  const saves = WS.playerSaves;
  // No saves (saves.js failed to load or run, as a syntax an old browser
  // can't parse would make it): the engine refuses to open books rather than
  // play from 0:00 with nothing saved. A test passing its own saver (even
  // null) decides for itself.
  let saver = null;
  const given = !!(overrides && 'saver' in overrides);
  if (!given) {
    try {
      saver = saves && typeof saves.browserSaver === 'function' ? saves.browserSaver(win) : null;
    } catch (e) {
      console.error('[player] saving could not start', e);
      saver = null;
    }
  }
  const engine = createEngine(Object.assign({
    host: host,
    createAudio: function () { return doc.createElement('audio'); },
    fetch: win.fetch.bind(win),
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    mediaSession: nav.mediaSession || null,
    permissions: nav.permissions || null,
    MediaMetadata: win.MediaMetadata || null,
    baseUrl: win.location.href,
    saver: saver,
    noSaver: !given && !saver
  }, overrides || {}));
  WS.player = engine;
  return engine;
}

if (typeof window !== 'undefined' && window.document) boot(window);
