/**
 * WebServarr — the audiobook player's listening features (ES module,
 * document-lifetime)
 *
 * Skip length, speed, the sleep timer, smart rewind, undo for big jumps, the
 * keyboard shortcuts, the listening history, the handoff prompt and the next
 * book in the series, on top of the engine (engine.js, WS.player) and its
 * view (ui.js, WS.playerUI). Loaded by the shell partial as its own module
 * script right after ui.js (so it carries its own asset stamp); nothing
 * imports it. Like the engine it lives as long as the document: its
 * listeners are added once, and its timers run only while a sleep timer, a
 * settings save is pending. Design:
 * docs/superpowers/specs/2026-09-28-audiobook-player-design.md, section 8.
 * Styles: theme.css "Audiobook player" (theme variables only).
 *
 * Settings (per listener, GET/PUT /api/player/prefs): read once, when the
 * first book starts loading (so a page where nobody plays never asks, and a
 * site with the player off sees no request), and handed to the engine
 * (applyPrefs, a 'prefs' change, so the skip buttons and the speed follow
 * while paused). Until then, and for an account
 * the player is not for (401, 403, 404), the defaults (10 s, 1x, smart rewind
 * on), with no error; a read that failed otherwise is tried again when the
 * next book opens. A change is sent a moment later (only what changed here,
 * kept until the server takes it: a failed save goes again with the next
 * change), and at once when the page is left. One save at a time, so the
 * server never takes an older one after a newer.
 *
 * - Skip length: 5 to 60 s, in the full player's settings (its top right).
 * - Speed: 0.75x to 2x in 0.05 steps (a stepper and presets).
 * - Sleep timer: 15, 30 or 60 minutes of listening (the count stands still
 *   while paused), or the end of the chapter (across parts: book time). Over
 *   the last 10 s the volume fades, then playback pauses (a pause, so it is
 *   saved at once) and the volume comes back. A pause (or a stop) during the
 *   fade, cancelling, or another book ends it, the volume restored. The time
 *   left shows in its slot.
 * - Smart rewind (a per-listener switch): playback that starts again after a
 *   pause (Play, or Retry after a stop that came while paused) goes back by
 *   rewindFor(the time since the pause); a book opened at a saved place goes
 *   back by rewindFor(how old that place is, in the server's clock, so a
 *   device clock that is off never counts), once, at that open's first real
 *   playback: an open that never plays moves and saves nothing. Never before
 *   the book's start, and never into (or across) a part this browser can't
 *   play. One rewind per break: a pause counts only after real listening
 *   (HEARD_MS of book time since playback started or was rewound), so a
 *   quick pause and play (a headset's double tap) never rewinds again, and
 *   the open's rewind and a pause's never both happen for one break. A place
 *   the listener moves to is theirs: no rewind from it. No
 *   rewind while the listener's settings are unknown (their read failed).
 *   Smart rewind is a playback aid only: it never moves the saved place
 *   back (engine rewind(), saves.js keeps the place it went back from until
 *   playback passes it; a move of the listener's own saves as ever).
 * - Undo: a seek of more than 2 minutes (the scrubber, a chapter, a skip, the
 *   lock screen) shows "Jumped back|ahead <delta>." with Undo for 8 s. Undo
 *   goes back to where that jump started, and raises no notice of its own; a
 *   second big jump replaces the first's notice and place. Placing a book
 *   whose files changed (a move marked place) and any move while it is held
 *   offer no Undo.
 * - Keys: Space plays or pauses, the left and right arrows skip by the skip
 *   length, [ and ] change the speed by 0.05; a held key acts once. Inside the full player they are
 *   always on (WS.playerUI.onKey; Space on a focused button presses the
 *   button). With it closed, on the page (document, bubble phase), only when
 *   a book is loaded and the key is nobody else's: not already handled, not
 *   in a field or on a button or other control, not on the reader (its own
 *   Space and arrows), not under a page's tour or a WSUI dialog.
 * - History (GET /api/player/history/<book>, a page at a time): the log
 *   grouped into listening sessions, newest first. A gap of more than 10
 *   minutes, another device, or another copy of the book (an earlier copy's
 *   entries: earlier_copy) starts a new session; a session running across
 *   two pages is one. Each shows when it started and ended, where it ended
 *   ("Chapter 3 · 1:02:03 into the book · 34%": that copy's chapter, book
 *   time and how far through), the chapters it covered when more than one
 *   ("Chapters 2 to 3"), the device, and "Earlier copy" for an earlier
 *   copy's. A tap goes to where it ended (a seek: the listener's own
 *   move, with Undo over 2 minutes; while the book is held because its files
 *   changed, it moves the helper's chosen spot and the helper shows again).
 *   A session whose part is gone (the files changed, or an earlier copy)
 *   opens the "Find your place" helper (findplace.js) with it as the old
 *   place. "Show older" loads the next page.
 * - Handoff: a book that opens at a place saved by ANOTHER device (its
 *   device_id, else its label when either side has no id) in the last 24
 *   hours, when this browser has its own place in the book (one the listener
 *   played or moved to here) more than 30 s from it, opens paused and asks
 *   "Continue from <time> (<device>, <ago>)?", keeping this browser's own
 *   place in the local copy meanwhile. Continue moves to the other device's
 *   place (a seek) and plays; Start from here moves to this browser's place
 *   and plays; either is saved as the newest place. Play pressed instead, or
 *   any move, is the listener's answer: the question goes.
 * - The same question at open for a Plex app's place (Plexamp, the Plex
 *   app) that beats this browser's own place when that place was never
 *   saved (played on without answering a question, or offline) and is more
 *   than 30 s away: Continue goes to Plex's place, Start from here to this
 *   browser's own.
 * - Conflict (spec 11b): the server refuses a save over another device's
 *   newer place (409). Playback pauses there and the same question is asked:
 *   Continue moves to the stored place and plays; Keep listening here saves
 *   this place over it (a deliberate override) and plays. Until then nothing
 *   is saved to the server (the local copy follows the place); playing on
 *   without answering is allowed and still saves nothing.
 * - Up next: at the end of the book, the next in its series
 *   (GET /api/player/next/<book>): "Up next: <title>" with Play, which opens
 *   it where the listener left off. It never starts by itself.
 *
 * Pure (importable by Node, no DOM at import time):
 *   rewindFor(awayMs)                     ms to go back: 0, 3 s, 10 s or 30 s
 *   rewindTarget(parts, fromMs, backMs)   the book ms to go back to, or null
 *   stepSpeed(speed, dir)                 the next speed up (1) or down (-1)
 *   formatSpeed(x)                        "1×", "1.25×"
 *   formatDelta(ms), jumpMessage(from, to)   "12 min", "Jumped back 12 min."
 *   formatCountdown(ms)                   "14:32", "1:00:00"
 *   chapterEnd(state)                     the current chapter's end, book ms
 *   otherDevice(copy, me)                 another device's copy (by id, else by label)
 *   handoffOffer(info)                    the open's handoff question (engine setOpenGate info): a Plex
 *                                         app's place when the book resumes from it, else another
 *                                         device's WebServarr copy; or null
 *   conflictOffer(warning, me, placeMs)   the question for a 409 (saves.js 'conflict' warning)
 *   handoffMessage(offer)                 "Continue from 1:02:03 (Chrome on Android, 3 min ago)?",
 *                                         "(another Chrome on Linux, ...)" for this device's own label
 *   formatAgo(ms)                         "just now", "3 min ago", "2 h ago", "3 days ago"
 *   groupSessions(entries, placeMs)       history entries (newest first) as sessions, newest first
 *   sessionWhen(session, now), sessionChapters(session, chapters)   a session's lines
 *   sessionPlace(session, chapters, durationMs)   "Chapter 3 · 1:02:03 into the book · 34%"
 *   chapterName(label)                    "Chapter 3" for a bare number, else the label
 *   createFeatures(env)                   the features, given their surroundings
 *   boot(win, overrides)                  WS.playerFeatures
 *
 * WS.playerFeatures (for Task 9 and the tests):
 *   sleep(kind, minutes)   kind 'minutes' (with 15, 30 or 60) or 'chapter'
 *   cancelSleep()
 *   sleepState() -> { kind, minutes, leftMs } | null
 *   prefs() -> { skip_s, speed, smart_rewind }
 *   showHistory(opener)   the history panel (the helper's "Show history")
 */

export const SKIP_CHOICES = [5, 10, 15, 30, 45, 60];
export const SPEED_MIN = 0.75;
export const SPEED_MAX = 2;
export const SPEED_STEP = 0.05;
export const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2];
export const SLEEP_MINUTES = [15, 30, 60];
export const FADE_MS = 10000;          // the sleep timer's fade
export const FADE_TICK_MS = 100;
export const UNDO_OVER_MS = 120000;    // a seek further than this can be undone
export const UNDO_MS = 8000;
export const SAVE_PREFS_MS = 800;
export const HEARD_MS = 1000;          // real progress that counts as listening (book ms)
export const PREFS_URL = '/api/player/prefs';
export const HISTORY_URL = '/api/player/history/';
export const NEXT_URL = '/api/player/next/';
export const SESSION_GAP_MS = 600000;     // a longer gap in the log starts a new session
export const HANDOFF_WITHIN_MS = 86400000; // another device's place this recent is offered on open
export const HANDOFF_APART_MS = 30000;    // places closer than this are the same place
export const OWN_PAST_ACK_MS = 10000;     // the open holds at this browser's copy only this far past its ack
export const DEFAULTS = Object.freeze({ skip_s: 10, speed: 1, smart_rewind: true });

const WIDE = '(min-width: 1024px)';
const RESUME_LOST = "Couldn't find your saved place in this book";
// Roles whose element takes Space or the arrows itself.
const CONTROL_ROLES = /^(button|link|textbox|searchbox|combobox|spinbutton|slider|scrollbar|listbox|option|menu|menubar|menuitem|menuitemcheckbox|menuitemradio|tab|tablist|radio|radiogroup|checkbox|switch|gridcell|treeitem|tree|grid)$/;
// Input types that are no text entry: Space and the arrows mean nothing to them
// (a range's own arrows are handled by the player's scrubber).
const NOT_TEXT = /^(range|button|checkbox|radio|submit|reset|image|color|file)$/;

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/* How far smart rewind goes back after this long away: under 10 s nothing,
   under a minute 3 s, under an hour 10 s, else 30 s. */
export function rewindFor(awayMs) {
  const a = Number(awayMs);
  if (!isFinite(a) || a < 10000) return 0;
  if (a < 60000) return 3000;
  if (a < 3600000) return 10000;
  return 30000;
}

// The part a book time is in: a part's first instant is that part's.
function partAt(parts, ms) {
  for (let i = 0; i < parts.length; i++) {
    if (ms < num(parts[i].start_ms) + num(parts[i].duration_ms) || i === parts.length - 1) return i;
  }
  return -1;
}

/* Where going back backMs from fromMs lands: never before the book's start,
   never into or across a part that can't play (then the start of the first
   playable part after it), and nowhere at all from a part that can't play.
   null: no move. */
export function rewindTarget(parts, fromMs, backMs) {
  const from = Number(fromMs);
  const back = Number(backMs);
  if (!isFinite(from) || !isFinite(back) || back <= 0) return null;
  let to = Math.max(0, from - back);
  if (Array.isArray(parts) && parts.length) {
    const j = partAt(parts, from);
    if (j === -1 || !parts[j].playable) return null;
    const i = partAt(parts, to);
    for (let k = j - 1; k >= i; k--) {
      if (!parts[k].playable) {
        to = num(parts[k + 1].start_ms);
        break;
      }
    }
  }
  return to < from ? to : null;
}

export function stepSpeed(speed, dir) {
  const v = Math.round((num(speed) + (dir < 0 ? -SPEED_STEP : SPEED_STEP)) / SPEED_STEP) * SPEED_STEP;
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, v)) * 100) / 100;
}

export function formatSpeed(x) {
  return String(Math.round(num(x) * 100) / 100) + '×';
}

// Whole minutes (a jump worth undoing is over 2 of them), hours past 60.
export function formatDelta(ms) {
  const mins = Math.round(Math.abs(num(ms)) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return mins + ' min';
  return m ? h + ' h ' + m + ' min' : h + ' h';
}

export function jumpMessage(fromMs, toMs) {
  return 'Jumped ' + (num(toMs) < num(fromMs) ? 'back ' : 'ahead ') + formatDelta(num(toMs) - num(fromMs)) + '.';
}

// Seconds rounded up: the timer shows 0:01 until it is done.
export function formatCountdown(ms) {
  const t = Math.max(0, Math.ceil(num(ms) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

/* The book ms where the current chapter ends (its end, else the next one's
   start, else the book's end); null with no chapters. */
export function chapterEnd(state) {
  const s = state || {};
  const list = Array.isArray(s.chapters) ? s.chapters : [];
  const i = num(s.chapterIndex);
  if (!s.book || !list.length || i < 0 || i >= list.length) return null;
  const start = num(list[i].start_ms);
  let end = num(list[i].end_ms);
  if (!(end > start)) end = i + 1 < list.length ? num(list[i + 1].start_ms) : num(s.bookDurationMs);
  return Math.max(start, end);
}

// A book time as a clock: "4:05", "1:02:03".
function clock(ms) {
  const t = Math.max(0, Math.floor(num(ms) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

const DEVICE_ID = /^[a-z0-9]{16,40}$/;

function idOf(v) {
  return typeof v === 'string' && DEVICE_ID.test(v) ? v : '';
}

/* Is the copy another device's? By the browsers' own ids when both have
   one, else by the device labels (both known and different). */
export function otherDevice(copy, me) {
  const c = copy || {};
  const m = me || {};
  const a = idOf(c.device_id);
  const b = idOf(m.device_id);
  if (a && b) return a !== b;
  const la = typeof c.device === 'string' ? c.device : '';
  const lb = typeof m.device === 'string' ? m.device : '';
  return !!la && !!lb && la !== lb;
}

function ageOf(nowIso, atIso) {
  const a = Date.parse(nowIso) - Date.parse(atIso);
  return isFinite(a) ? Math.max(0, a) : NaN;
}

/* The handoff question for an open (the engine's setOpenGate info), or null.
   Asked when WebServarr's copy (web) was saved by another device and this
   browser has its own place in the book (played or moved to here) more than
   30 s from it, and either
   - the book resumes from that copy and it is under 24 hours old (server's
     clock), or
   - this browser's place is one the server never took (own.acked false: it
     played on offline, or after a refused save, or its last save's answer
     never came back), whatever its age or stamp: it is never overwritten or
     pushed without asking.
   The open then holds at the newer of the two by stamp: the web place
   ({ at: 'web' }), or this browser's own ({ at: 'own' }) when it is stamped
   later (listening here the server never heard of: a plain Play goes on
   from it, and the question offers the web place). A copy capped by a
   refused save is stamped no later than the place that refused it, so it
   holds at the web place. When the web place is in a part this browser
   can't play, it holds at this browser's own (other.canGo false). (Plex's
   echoes of our own saves never get here: GET /position leaves out a Plex
   copy of a place WebServarr logged.) */
export function handoffOffer(info) {
  const i = info || {};
  // The newest other place is the one offered: a Plex app's, when the book
  // resumes from it, before another device's older WebServarr copy.
  const viaPlex = plexOffer(i);
  if (viaPlex) return viaPlex;
  return webOffer(i);
}

function webOffer(i) {
  const web = i.web || (i.resumed && i.resumed.source === 'web' ? i.resumed : null);
  const own = i.own;
  if (!web || typeof web.bookMs !== 'number' || !otherDevice(web, i.me)) return null;
  if (!own || own.own !== true || typeof own.bookMs !== 'number') return null;
  if (Math.abs(own.bookMs - web.bookMs) <= HANDOFF_APART_MS) return null;
  const age = ageOf(i.now, web.updated_at);
  const recent = !!i.resumed && i.resumed.source === 'web' && age <= HANDOFF_WITHIN_MS;
  if (!recent && own.acked === true) return null;
  const canGo = web.playable !== false;
  // Newer by stamp and at least 10 s of book time past its last acked place
  // (real listening, not a stray Play's moment; a copy with no acked place
  // recorded counts as far past it).
  const past = typeof own.ackedBookMs === 'number' ? own.bookMs - own.ackedBookMs : Infinity;
  const ownNewer = Date.parse(own.updated_at) > Date.parse(web.updated_at) && past >= OWN_PAST_ACK_MS;
  return {
    other: { bookMs: web.bookMs, device: web.device || '', agoMs: isFinite(age) ? age : null, sameLabel: sameLabel(web, i.me), canGo: canGo },
    own: { bookMs: own.bookMs },
    at: canGo && !ownNewer ? 'web' : 'own'
  };
}

/* The open's question for a Plex app's place (Plexamp, the Plex app): asked
   when the book resumes from Plex's copy (it beat this browser's own) while
   this browser holds its own place the server never took (played on after a
   question it did not answer, or offline), more than 30 s from it. Holds at
   Plex's place ({ at: 'plex' }; at this browser's own when Plex's can't
   play here). Continue goes to Plex's place, Start from here to this
   browser's own; either is saved as the newest place. */
function plexOffer(i) {
  const plex = i.plex || (i.resumed && i.resumed.source === 'plex' ? i.resumed : null);
  const own = i.own;
  if (!plex || typeof plex.bookMs !== 'number' || !i.resumed || i.resumed.source !== 'plex') return null;
  if (!own || own.own !== true || own.acked === true || typeof own.bookMs !== 'number') return null;
  if (Math.abs(own.bookMs - plex.bookMs) <= HANDOFF_APART_MS) return null;
  const age = ageOf(i.now, plex.updated_at);
  const canGo = plex.playable !== false;
  return {
    other: { bookMs: plex.bookMs, device: plex.device || '', agoMs: isFinite(age) ? age : null, sameLabel: false, canGo: canGo },
    own: { bookMs: own.bookMs },
    at: canGo ? 'plex' : 'own'
  };
}

// Another device with this one's label ("Chrome on Linux" twice).
function sameLabel(copy, me) {
  const a = copy && typeof copy.device === 'string' ? copy.device : '';
  return !!a && !!me && a === me.device;
}

/* The question for a 409 (saves.js { kind: 'conflict', conflict, now }):
   the stored place, whose device and how long ago. placeMs(track, offset)
   is its book time (null: not in this book, so there is nowhere to go). */
export function conflictOffer(w, me, placeMs) {
  const c = (w && w.conflict) || {};
  let at = null;
  if (typeof placeMs === 'function' && c.track) {
    const b = placeMs(String(c.track), Number(c.offset_ms));
    if (typeof b === 'number' && isFinite(b)) at = b;
  }
  const age = ageOf(w && w.now, c.updated_at);
  return { other: { bookMs: at, device: c.device || '', agoMs: isFinite(age) ? age : null, sameLabel: sameLabel(c, me) } };
}

export function formatAgo(ms) {
  const v = Number(ms);
  if (!isFinite(v) || v < 60000) return 'just now';
  const mins = Math.floor(v / 60000);
  if (mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' h ago';
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : days + ' days ago';
}

/* The question. A device with this one's label is "another <label>", so two
   phones of one kind don't read as this one. */
export function handoffMessage(offer) {
  const o = (offer && offer.other) || {};
  const who = !o.device ? 'another device' : o.sameLabel ? 'another ' + o.device : o.device;
  return 'Continue from ' + clock(o.bookMs) + ' (' + who + ', ' + formatAgo(o.agoMs) + ')?';
}

/* History entries (newest first, as GET /history gives them, several pages
   joined) as listening sessions, newest first. A gap of more than 10
   minutes, another device, or another copy of the book (book_key), starts a
   new one. placeMs(track, offset) is a place's book time (null when the book
   has no such part). Each session:
   { start, end (ms), device, device_id, endPlace { track, offset_ms },
     endMs (null: not in the book), fromMs, toMs (the book time covered, null
     when none of its places is in the book), count, and from the entry it
     ended at, as that copy saved it: endBookMs, endDurationMs, endLabel
     (null when not saved), bookKey, earlier (an earlier copy's) }. */
function wholeMs(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;
}

export function groupSessions(entries, placeMs) {
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  let cur = null;
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const at = Date.parse(e.at);
    if (!isFinite(at)) continue;
    const devId = idOf(e.device_id);
    const copy = typeof e.book_key === 'string' ? e.book_key : '';
    const who = copy + '|' + (devId ? 'id:' + devId : 'label:' + (typeof e.device === 'string' ? e.device : ''));
    let ms = null;
    if (typeof placeMs === 'function' && e.track != null && typeof e.offset_ms === 'number') {
      const b = placeMs(String(e.track), e.offset_ms);
      if (typeof b === 'number' && isFinite(b)) ms = b;
    }
    if (!cur || cur.who !== who || cur.start - at > SESSION_GAP_MS) {
      cur = {
        who: who, start: at, end: at,
        device: typeof e.device === 'string' ? e.device : '', device_id: devId,
        endPlace: { track: String(e.track), offset_ms: num(e.offset_ms) },
        endMs: ms, fromMs: ms, toMs: ms, count: 0,
        endBookMs: wholeMs(e.book_ms), endDurationMs: wholeMs(e.book_duration_ms),
        endLabel: typeof e.chapter_label === 'string' && e.chapter_label ? e.chapter_label : null,
        bookKey: copy || null, earlier: e.earlier_copy === true
      };
      out.push(cur);
    }
    cur.start = at;
    cur.count += 1;
    if (ms !== null) {
      cur.fromMs = cur.fromMs === null ? ms : Math.min(cur.fromMs, ms);
      cur.toMs = cur.toMs === null ? ms : Math.max(cur.toMs, ms);
    }
  }
  return out.map(function (x) {
    return {
      start: x.start, end: x.end, device: x.device, device_id: x.device_id, endPlace: x.endPlace,
      endMs: x.endMs, fromMs: x.fromMs, toMs: x.toMs, count: x.count,
      endBookMs: x.endBookMs, endDurationMs: x.endDurationMs, endLabel: x.endLabel,
      bookKey: x.bookKey, earlier: x.earlier
    };
  });
}

function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function timeText(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/* When a session was: "Today · 9:14 PM to 9:52 PM", "Yesterday · ...",
   "Tue · ..." within the week, else "Sep 12 · ..." (with the year when it is
   another year's). */
export function sessionWhen(session, nowMs) {
  const s = session || {};
  const start = num(s.start);
  const end = num(s.end);
  const days = Math.round((dayStart(num(nowMs)) - dayStart(start)) / 86400000);
  let day;
  if (days <= 0) day = 'Today';
  else if (days === 1) day = 'Yesterday';
  else if (days < 7) day = new Date(start).toLocaleDateString([], { weekday: 'short' });
  else if (new Date(start).getFullYear() === new Date(num(nowMs)).getFullYear()) day = new Date(start).toLocaleDateString([], { month: 'short', day: 'numeric' });
  else day = new Date(start).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const a = timeText(start);
  const b = timeText(end);
  return day + ' · ' + (a === b ? a : a + ' to ' + b);
}

// The chapter a book time is in: the last one starting at or before it.
function chapterIndexAt(chapters, ms) {
  let found = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (num(chapters[i].start_ms) <= ms) found = i;
    else break;
  }
  return found === -1 && chapters.length ? 0 : found;
}

/* The chapters a session covered: the one chapter's label, or "Chapters 3
   to 5". '' when the book has no chapters or none of its places is known. */
export function sessionChapters(session, chapters) {
  const s = session || {};
  const list = Array.isArray(chapters) ? chapters : [];
  if (!list.length || s.fromMs === null || s.fromMs === undefined || s.toMs === null || s.toMs === undefined) return '';
  const a = chapterIndexAt(list, num(s.fromMs));
  const b = chapterIndexAt(list, num(s.toMs));
  if (a === b) return String(list[a].label || 'Chapter ' + (a + 1));
  return 'Chapters ' + (a + 1) + ' to ' + (b + 1);
}

/* A chapter's label as a name: "Chapter 3" for a bare number (or Roman numeral),
   else the label as the book has it ("Part 2 of 17", "Chapter 3", "The
   Letter"), never "Chapter Chapter 3". */
export function chapterName(label) {
  const t = typeof label === 'string' ? label.trim() : '';
  return /^(?:\d+|(?=[MDCLXVI])M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/.test(t) ? 'Chapter ' + t : t;
}

// A book time with its hours always: "0:12:05" (never read as a time of day).
function bookClock(ms) {
  const t = Math.max(0, Math.floor(num(ms) / 1000));
  return Math.floor(t / 3600) + ':' + pad(Math.floor((t % 3600) / 60)) + ':' + pad(t % 60);
}

/* Where a session ended, in terms that survive the files changing: that
   copy's chapter, the book time and how far through the book, from what
   the entry saved ("Chapter 3 · 1:02:03 into the book · 34%"). An entry
   saved before the book time was kept falls back to this copy (its chapters
   and length), when its part is still here; '' when nothing is known. */
export function sessionPlace(session, chapters, durationMs) {
  const s = session || {};
  const list = Array.isArray(chapters) ? chapters : [];
  const here = typeof s.endMs === 'number' && isFinite(s.endMs) ? s.endMs : null;
  const at = typeof s.endBookMs === 'number' ? s.endBookMs : here;
  let label = typeof s.endLabel === 'string' ? s.endLabel : '';
  if (!label && here !== null && list.length) {
    const i = chapterIndexAt(list, here);
    label = String(list[i].label || String(i + 1));
  }
  let total = typeof s.endBookMs === 'number' ? s.endDurationMs : num(durationMs);
  if (typeof total !== 'number' || !(total > 0)) total = null;
  const out = [];
  if (label) out.push(chapterName(label));
  if (at !== null) out.push(bookClock(at) + ' into the book');
  if (at !== null && total !== null) out.push(Math.max(0, Math.min(100, Math.floor((at / total) * 100))) + '%');
  return out.join(' · ');
}

// ---------------------------------------------------------------------------
// The features
// ---------------------------------------------------------------------------

/* env: { player (WS.player), ui (WS.playerUI), doc, win (its pagehide and
   the router's ws:before-hard-nav), fetch, now() (wall clock: time away),
   mono() (a clock the system never steps: the sleep timer), setTimeout,
   clearTimeout, matchMedia, isDialogOpen(), pathname(), tourActive(),
   findPlace() -> WS.playerFindPlace or null }. */
export function createFeatures(env) {
  const player = env.player;
  const ui = env.ui;
  const doc = env.doc;
  const setT = env.setTimeout;
  const clearT = env.clearTimeout;
  const now = env.now || Date.now;
  const mono = env.mono || now;
  const fetchFn = env.fetch || null;

  function logError(e) {
    console.error('[player] the listening features failed', e);
  }

  function matches(q) {
    try {
      return !!(env.matchMedia && env.matchMedia(q).matches);
    } catch (e) {
      return false;
    }
  }

  function h(tag, props, kids) {
    const n = doc.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (kids) kids.forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function icon(name, cls) {
    return h('span', { class: 'material-symbols-outlined' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', text: name });
  }

  function setText(el, v) {
    const t = v == null ? '' : String(v);
    if (el.textContent !== t) el.textContent = t;
  }

  function setAttr(el, k, v) {
    if (v === null) {
      if (el.hasAttribute(k)) el.removeAttribute(k);
    } else if (el.getAttribute(k) !== v) {
      el.setAttribute(k, v);
    }
  }

  // ---- Settings ----

  const prefs = { skip_s: DEFAULTS.skip_s, speed: DEFAULTS.speed, smart_rewind: DEFAULTS.smart_rewind };
  const touched = new Set();   // changed here: never overwritten by a late read
  const unsent = new Map();    // changed here and not yet taken by the server: key -> its change's number
  let changes = 0;
  let putTimer = null;
  let loadState = 'idle';      // 'loading', 'done', or 'retry' (try again at the next open)

  function loadPrefs() {
    if (!fetchFn || loadState === 'loading' || loadState === 'done') return;
    loadState = 'loading';
    let asked;
    try {
      asked = Promise.resolve(fetchFn(PREFS_URL, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      }));
    } catch (e) {
      asked = Promise.reject(e);
    }
    asked.then(function (resp) {
      // Not this account's player (signed out, no Plex identity, the player
      // off): the defaults, and nothing to say.
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) return null;
      if (!resp.ok) throw new Error('prefs ' + resp.status);
      return resp.json();
    }).then(function (data) {
      loadState = 'done';
      if (data && typeof data === 'object') take(data);
    }, function () {
      loadState = 'retry';
    });
  }

  function take(data) {
    if (!touched.has('skip_s') && typeof data.skip_s === 'number' && isFinite(data.skip_s)) prefs.skip_s = data.skip_s;
    if (!touched.has('speed') && typeof data.speed === 'number' && isFinite(data.speed)) prefs.speed = data.speed;
    if (!touched.has('smart_rewind') && typeof data.smart_rewind === 'boolean') prefs.smart_rewind = data.smart_rewind;
    const got = player.applyPrefs({ skip: prefs.skip_s, speed: prefs.speed });
    if (got) {
      prefs.skip_s = got.skip;
      prefs.speed = got.speed;
    }
    drawAll();
  }

  // Known: read from the server, or the player is not this account's (the
  // defaults, which then hold). Until then nothing is decided on them.
  function prefsKnown() {
    return loadState === 'done';
  }

  function changePref(key, value) {
    prefs[key] = value;
    touched.add(key);
    changes += 1;
    unsent.set(key, changes);
    if (putTimer !== null) clearT(putTimer);
    putTimer = setT(function () {
      putTimer = null;
      sendPrefs(false);
    }, SAVE_PREFS_MS);
  }

  /* Every key changed here and not yet taken by the server, never the
     rest: a read that failed must not put the defaults over what the
     listener saved elsewhere. A key stays until a 2xx takes it (as it was
     sent: a newer change of it stays), so a failed save (the network, 429,
     503) goes again with the next change, and on leaving. One save at a
     time, so the server never takes an older one after a newer: a change
     made while one is in flight goes when it returns, as the latest of
     everything unsent. Leaving sends at once (keepalive: the page is going),
     and that save is in flight like any other. One sent while another was
     still out may land before it, so its 2xx takes nothing: those keys go
     again, after the other returns, or when the page comes back from the
     back-forward cache. */
  let putsOut = 0;
  let putAgain = false;
  function sendPrefs(leaving) {
    if (putTimer !== null) {
      clearT(putTimer);
      putTimer = null;
    }
    if (!unsent.size || !fetchFn) return;
    if (putsOut > 0 && !leaving) {
      putAgain = true;
      return;
    }
    const overlapped = putsOut > 0;
    // Its answer cannot be trusted over the other's: send again after both.
    if (overlapped) putAgain = true;
    else putAgain = false;
    putsOut += 1;
    const sent = new Map(unsent);
    const body = {};
    sent.forEach(function (n, k) { body[k] = prefs[k]; });
    let asked;
    try {
      asked = Promise.resolve(fetchFn(PREFS_URL, {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: !!leaving,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      }));
    } catch (e) {
      asked = Promise.reject(e);
    }
    asked.then(function (resp) {
      if (!overlapped && resp && resp.status >= 200 && resp.status < 300) {
        sent.forEach(function (n, k) {
          if (unsent.get(k) === n) unsent.delete(k);
        });
      }
    }, function () { /* kept: the next change, or leaving, sends it again */ }).then(function () {
      putsOut -= 1;
      // Changed meanwhile, or overlapped: now, as the latest state.
      if (putsOut === 0 && putAgain) {
        putAgain = false;
        sendPrefs(false);
      }
    });
  }

  function setSkip(n) {
    const v = player.setSkip(n);
    changePref('skip_s', v);
    drawAll();
  }

  function setSpeed(x) {
    const v = player.setSpeed(x);
    changePref('speed', v);
    drawAll();
  }

  function setRewind(on) {
    changePref('smart_rewind', !!on);
    drawAll();
  }

  // ---- Moving the place (smart rewind, undo) ----

  let ownSeek = false;         // smart rewind is moving the place
  let undoing = false;         // Undo is

  // Back backMs from fromMs (book ms), within what can play. Listening is
  // counted afresh from where it lands.
  function rewindBy(fromMs, backMs) {
    if (!(backMs > 0) || !player.state().book) return;
    let parts = [];
    try {
      parts = player.parts();
    } catch (e) { /* no parts: the book's start is the only limit */ }
    const to = rewindTarget(parts, fromMs, backMs);
    if (to === null) return;
    ownSeek = true;
    try {
      // Marked as a rewind: the saved place is not moved back (saves.js).
      if (typeof player.rewind === 'function') player.rewind(to);
      else player.seek(to);
    } finally {
      ownSeek = false;
    }
    startAt = player.state().bookMs;
    heard = false;
  }

  let undo = null;             // { book, from, notice }: the last big jump

  function offerUndo(book, from, to) {
    const entry = { book: book, from: from, notice: null };
    undo = entry;
    entry.notice = ui.notify(jumpMessage(from, to), {
      id: 'undo',
      duration: UNDO_MS,
      action: { label: 'Undo', run: function () { runUndo(entry); } }
    });
  }

  function runUndo(entry) {
    if (undo !== entry) return;
    undo = null;
    if (player.state().book !== entry.book) return;
    undoing = true;
    try {
      player.seek(entry.from);
    } finally {
      undoing = false;
    }
  }

  function dropUndo() {
    const u = undo;
    undo = null;
    if (u && u.notice) u.notice.remove();
  }

  // ---- The sleep timer ----

  // { kind, minutes, leftMs (minutes: listening left), endMs (chapter: where
  // it ends), lastMono (playing at the last tick: when), fading, vol0, timer }
  let sleep = null;
  let sleepPausing = false;

  function sleepLeft(sl, s) {
    if (sl.kind === 'chapter') {
      const speed = num(s.speed) > 0 ? num(s.speed) : 1;
      return (num(sl.endMs) - num(s.bookMs)) / speed;
    }
    return sl.leftMs;
  }

  function startSleep(kind, minutes) {
    cancelSleep();
    const s = player.state();
    if (!s.book) return false;
    const sl = { kind: kind === 'chapter' ? 'chapter' : 'minutes', minutes: 0, leftMs: 0, endMs: null,
      lastMono: null, fading: false, vol0: null, timer: null };
    if (sl.kind === 'chapter') {
      sl.endMs = chapterEnd(s);
      if (sl.endMs === null) return false;
    } else {
      const m = Number(minutes);
      if (SLEEP_MINUTES.indexOf(m) === -1) return false;
      sl.minutes = m;
      sl.leftMs = m * 60000;
    }
    sleep = sl;
    tickSleep();
    return true;
  }

  function stopTimer(sl) {
    if (sl && sl.timer !== null) {
      clearT(sl.timer);
      sl.timer = null;
    }
  }

  function unfade(sl) {
    if (!sl.fading) return;
    sl.fading = false;
    player.setVolume(sl.vol0);
  }

  function cancelSleep() {
    const sl = sleep;
    if (!sl) return;
    sleep = null;
    stopTimer(sl);
    unfade(sl);
    drawSleep(null);
  }

  // Done: the pause (saved at once, as any pause), then the volume back.
  function finishSleep() {
    const sl = sleep;
    sleep = null;
    stopTimer(sl);
    sleepPausing = true;
    try {
      player.pause();
    } finally {
      sleepPausing = false;
    }
    unfade(sl);
    drawSleep(null);
  }

  /* Counts the timer down (listening time, from the clock), fades the
     volume over its last 10 s and ends it. Run on every engine change (its
     timeupdate goes on in a background tab) and by its own timer. */
  function tickSleep() {
    const sl = sleep;
    if (!sl) return;
    stopTimer(sl);
    const s = player.state();
    const t = mono();
    if (sl.kind === 'minutes' && sl.lastMono !== null) sl.leftMs -= Math.max(0, t - sl.lastMono);
    sl.lastMono = s.playing ? t : null;
    const left = sleepLeft(sl, s);
    if (left <= 0) {
      finishSleep();
      return;
    }
    if (s.playing && left <= FADE_MS) {
      if (!sl.fading) {
        sl.vol0 = player.setVolume();
        sl.fading = true;
      }
      const x = left / FADE_MS;
      player.setVolume(sl.vol0 * x * x);
    } else {
      // Moved back out of the last 10 s (a seek): full volume again.
      unfade(sl);
    }
    drawSleep(left);
    if (s.playing) {
      sl.timer = setT(function () {
        sl.timer = null;
        if (sleep === sl) tickSleep();
      }, sl.fading ? FADE_TICK_MS : Math.max(FADE_TICK_MS, Math.min(1000, left - FADE_MS)));
    }
  }

  // ---- The engine ----

  // Handoff (below): the question showing { book, offer, kind ('open' |
  // 'conflict'), prompt }; the one an open's gate held its book for, asked
  // at its 'open' { book, offer }.
  let handoff = null;
  let pendingOpen = null;
  let upNext = null;           // { book, prompt }: the next book offered at the end
  let hist = null;             // the history loaded (see History)

  let lastBook = null;
  let lastPlaying = false;
  let pausedAt = null;         // wall ms of the last pause after listening
  // Listened since playback last started: it has really moved on HEARD_MS
  // (book time) from where it started or was last rewound to (startAt). A
  // timeupdate at the same place (after a seek, or a play) is not listening,
  // so a quick pause and play (a headset's double tap) is no new break.
  let heard = false;
  let startAt = null;
  // The rewind a book opened at a saved place owes, taken at its first real
  // playback (never before: an open that never plays moves nothing, and
  // nothing is saved for it): { from (book ms it opened at), age (how old
  // the place was then, the server's clock), since (mono, then) }.
  let openRewind = null;

  function onChange(d) {
    const s = d && d.state ? d.state : player.state();
    const r = d ? d.reason : '';
    const was = lastPlaying;
    lastPlaying = !!s.playing;
    if (s.book !== lastBook) {
      lastBook = s.book;
      cancelSleep();
      dropUndo();
      pausedAt = null;
      heard = false;
      startAt = null;
      openRewind = null;
      dropHandoff();
      dropUpNext();
      bookChanged();
    }
    // Playing, a stop, or a move of the listener's own: the open's question
    // is answered. (A conflict's stays until it is answered: nothing is
    // saved meanwhile.)
    const moved = r === 'seek' || r === 'skip' || r === 'jump';
    if (handoff && handoff.kind === 'open' && (s.playing || s.error || (moved && !ownSeek))) dropHandoff();
    if (s.playing) dropUpNext();
    if (moved && !ownSeek) {
      // A place the listener chose while paused is theirs: no rewind from it,
      // nor from the place the book opened at once they have moved.
      if (!s.playing) pausedAt = null;
      openRewind = null;
      // Listening is measured afresh from the place they moved to.
      startAt = s.bookMs;
      heard = false;
      if (sleep && sleep.kind === 'chapter') {
        sleep.endMs = chapterEnd(s);
        if (sleep.endMs === null) cancelSleep();
      }
      // No Undo for placing a book whose files changed (confirmPlace's moves,
      // marked place) or for any move while it is held: Undo would take the
      // listener back to the held start, never their place.
      if (!undoing && !d.place && !s.filesChanged && typeof d.from === 'number' && typeof d.to === 'number' &&
          Math.abs(d.to - d.from) > UNDO_OVER_MS) {
        offerUndo(s.book, d.from, d.to);
      }
    }
    if (r === 'time' && s.playing && !heard && startAt !== null && s.bookMs - startAt >= HEARD_MS) heard = true;
    if (was && !s.playing) {
      // A pause (or a stop) during the fade ends the timer, volume restored.
      if (sleep && sleep.fading && !sleepPausing) cancelSleep();
      if (r === 'pause' && heard) pausedAt = now();
      heard = false;
    }
    if (r === 'ended') {
      cancelSleep();
      askNext(s.book);
    }
    // The listener's settings: read when the first book starts loading.
    if (r === 'loading' && loadState === 'idle') loadPrefs();
    if (r === 'open') {
      // The open's gate held the book for the handoff question: ask it now.
      const p = pendingOpen;
      pendingOpen = null;
      if (p && p.book === s.book && !s.playing && !s.error) showHandoff(p.offer, 'open');
      if (loadState === 'retry') loadPrefs();
      const from = s.resumedFrom;
      openRewind = from && typeof from.age_ms === 'number' && isFinite(from.age_ms)
        ? { from: s.bookMs, age: from.age_ms, since: mono() } : null;
    }
    // The first real playback of a book opened at a saved place: playback has
    // moved on from where it opened. The time away runs on to now.
    if (openRewind && r === 'time' && s.playing && s.bookMs > openRewind.from) {
      const o = openRewind;
      openRewind = null;
      // One rewind per break: this one stands for any pause before it.
      pausedAt = null;
      if (prefsKnown() && prefs.smart_rewind) rewindBy(o.from, rewindFor(o.age + Math.max(0, mono() - o.since)));
    }
    if (!was && s.playing) {
      const at = pausedAt;
      pausedAt = null;
      heard = false;
      startAt = s.bookMs;
      // Play again after a pause, or Retry after a stop that came while paused.
      if ((r === 'play' || r === 'retry') && at !== null && prefsKnown() && prefs.smart_rewind) {
        // One rewind per break: the open's, if still owed, is this one.
        openRewind = null;
        rewindBy(s.bookMs, rewindFor(now() - at));
      }
    }
    tickSleep();
    if (r !== 'time') drawAll();
  }

  player.on('change', function (d) {
    try {
      onChange(d);
    } catch (e) {
      logError(e);
    }
  });

  function getJSON(url) {
    if (!fetchFn) return Promise.reject(new Error('no fetch'));
    let asked;
    try {
      asked = Promise.resolve(fetchFn(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      }));
    } catch (e) {
      asked = Promise.reject(e);
    }
    return asked.then(function (resp) {
      if (!resp || !resp.ok) throw new Error('status ' + (resp && resp.status));
      return resp.json();
    });
  }

  // ---- Handoff and conflicts ----

  function dropHandoff() {
    const h = handoff;
    handoff = null;
    if (h && h.prompt) h.prompt.remove();
  }

  function showHandoff(offer, kind) {
    dropHandoff();
    const book = player.state().book;
    if (!book) return;
    const entry = { book: book, offer: offer, kind: kind, prompt: null };
    handoff = entry;
    const actions = [];
    const canGo = typeof offer.other.bookMs === 'number' && offer.other.canGo !== false;
    if (canGo) {
      actions.push({ label: 'Continue', primary: true, run: function () { chooseHandoff(entry, 'other'); } });
    }
    actions.push({ label: kind === 'conflict' ? 'Keep listening here' : 'Start from here',
      primary: !actions.length, run: function () { chooseHandoff(entry, 'own'); } });
    // At an open where the other place can't play here: the question can
    // wait (nothing is saved or overwritten until the listener plays or moves).
    if (!canGo && kind === 'open') {
      actions.push({ label: 'Not now', run: function () { if (handoff === entry) handoff = null; } });
    }
    entry.prompt = ui.prompt({ id: 'handoff', message: handoffMessage(offer), actions: actions });
  }

  function playNow() {
    let r;
    try {
      r = player.play();
    } catch (e) {
      logError(e);
      return;
    }
    if (r && typeof r.catch === 'function') r.catch(logError);
  }

  /* The listener's answer, each a move of their own (saved as the newest
     place). Continue: to the other device's place. At an open, Start from
     here: to this browser's place. At a conflict, Keep listening here: the
     place here is saved over the stored one. Then play. */
  function chooseHandoff(entry, which) {
    if (handoff !== entry) return;
    handoff = null;
    const s = player.state();
    if (s.book !== entry.book) return;
    // At the open, the move is the answer: kept (unsaved) even if a late
    // read finds the other place has moved on and asks again.
    const answer = { answer: entry.kind === 'open' };
    if (which === 'other') player.seek(entry.offer.other.bookMs, answer);
    else if (entry.kind === 'open') player.seek(entry.offer.own.bookMs, answer);
    // After the move: the save that resumes carries the place chosen.
    const held = !!player.state().filesChanged;
    if (entry.kind === 'conflict' && typeof player.resolveConflict === 'function') player.resolveConflict();
    // A confirm (the files changed) that landed at the book's very end does
    // not play on: a Play there would start the book again from 0:00.
    const now2 = player.state();
    if (held && !now2.filesChanged && now2.book && now2.bookDurationMs > 0 && now2.bookMs >= now2.bookDurationMs) return;
    playNow();
  }

  if (typeof player.setOpenGate === 'function') {
    player.setOpenGate(function (info) {
      const offer = handoffOffer(info);
      pendingOpen = offer ? { book: info.book, offer: offer } : null;
      return offer ? { at: offer.at } : null;
    });
  }

  // The server refused a save over another device's newer place: pause
  // there and ask.
  player.on('warning', function (w) {
    try {
      if (!w || w.kind !== 'conflict') return;
      const s = player.state();
      if (!s.book || w.book !== s.book) return;
      if (s.playing) player.pause();
      const offer = conflictOffer(w, player.me(), function (t, o) { return player.placeMs(t, o); });
      // A place in a part this browser can't play is nowhere to go.
      if (typeof offer.other.bookMs === 'number') {
        let parts = [];
        try {
          parts = player.parts();
        } catch (e) { /* none known */ }
        const i = partAt(parts, offer.other.bookMs);
        if (i !== -1 && !parts[i].playable) offer.other.canGo = false;
      }
      showHandoff(offer, 'conflict');
    } catch (e) {
      logError(e);
    }
  });

  // ---- Up next ----

  function dropUpNext() {
    const u = upNext;
    upNext = null;
    if (u && u.prompt) u.prompt.remove();
  }

  // At the end of the book: the next in its series, offered, never started.
  function askNext(book) {
    if (!book) return;
    dropUpNext();
    const entry = { book: book, prompt: null };
    upNext = entry;
    getJSON(NEXT_URL + encodeURIComponent(book)).then(function (data) {
      const next = data && data.next;
      if (upNext !== entry || player.state().book !== book || !next || typeof next.key !== 'string' || !next.key) return;
      entry.prompt = ui.prompt({
        id: 'upnext',
        message: 'Up next: ' + String(next.title || ''),
        actions: [
          { label: 'Play', primary: true, run: function () { playNext(entry, next.key); } },
          { label: 'Not now', run: function () { if (upNext === entry) upNext = null; } }
        ]
      });
    }, function () { /* no offer: nothing to say */ });
  }

  function playNext(entry, key) {
    if (upNext === entry) upNext = null;
    let r;
    try {
      r = player.open(key);
    } catch (e) {
      logError(e);
      return;
    }
    if (r && typeof r.catch === 'function') r.catch(logError);
  }

  // ---- The keys ----

  function toggle() {
    let r;
    try {
      r = player.toggle();
    } catch (e) {
      logError(e);
      return;
    }
    if (r && typeof r.catch === 'function') {
      r.catch(function (err) {
        if (err && err.name === 'UnknownTrack') ui.notify(RESUME_LOST, { id: 'resume-lost' });
        else logError(err);
      });
    }
  }

  function textEntry(t) {
    if (!t || t.nodeType !== 1) return false;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !NOT_TEXT.test(String(t.getAttribute('type') || 'text').toLowerCase());
    return editable(t);
  }

  function editable(t) {
    if (t.isContentEditable) return true;
    const c = t.closest ? t.closest('[contenteditable]') : null;
    return !!c && String(c.getAttribute('contenteditable')).toLowerCase() !== 'false';
  }

  function control(t) {
    if (!t || t.nodeType !== 1) return false;
    const tag = t.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
    const role = t.getAttribute('role');
    return !!role && CONTROL_ROLES.test(role);
  }

  // A field, a button or another control: the key is its own.
  function owned(t) {
    if (!t || t.nodeType !== 1) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable(t) || control(t);
  }

  function act(e, inPlayer) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const s = player.state();
    if (!s.book) return;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar') {
      // Space on a focused button presses it.
      if (e.shiftKey || (inPlayer && control(e.target))) return;
      e.preventDefault();
      if (!e.repeat) toggle();
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (e.shiftKey) return;
      e.preventDefault();
      // One skip a press: a held key does not run on to the book's end.
      if (e.repeat) return;
      const n = num(player.setSkip()) || DEFAULTS.skip_s;
      player.skip(k === 'ArrowLeft' ? -n : n);
    } else if (k === '[' || k === ']') {
      e.preventDefault();
      if (e.repeat) return;
      setSpeed(stepSpeed(s.speed, k === ']' ? 1 : -1));
    }
  }

  function dialogOpen() {
    try {
      return !!(env.isDialogOpen && env.isDialogOpen());
    } catch (e) {
      return false;
    }
  }

  function onReader() {
    let p = '';
    try {
      p = String(env.pathname ? env.pathname() : '');
    } catch (e) {
      p = '';
    }
    return p === '/reader' || p.indexOf('/reader/') === 0;
  }

  function tourActive() {
    try {
      return !!(env.tourActive && env.tourActive());
    } catch (e) {
      return false;
    }
  }

  // With the full player closed: a key on the page that nobody else owns.
  function onDocKey(e) {
    try {
      if (e.defaultPrevented || ui.isOpen() || owned(e.target) || onReader() || tourActive() || dialogOpen()) return;
      act(e, false);
    } catch (err) {
      logError(err);
    }
  }

  ui.onKey(function (e) {
    if (textEntry(e.target)) return;
    act(e, true);
  });
  doc.addEventListener('keydown', onDocKey);

  // ---- Leaving: the settings not sent yet go now ----

  const win = env.win || null;
  if (win && typeof win.addEventListener === 'function') {
    ['pagehide', 'ws:before-hard-nav'].forEach(function (type) {
      win.addEventListener(type, function () { sendPrefs(true); });
    });
    // Back from the back-forward cache: what the leave did not get taken goes.
    win.addEventListener('pageshow', function (e) {
      if (e && e.persisted) sendPrefs(false);
    });
  }

  // ---- The controls ----

  function hideOnPhone(p) {
    if (!matches(WIDE)) p.hide();
  }

  // Settings: the skip length and smart rewind, in the top right.
  const settingsBtn = h('button', { type: 'button', class: 'wsp-icon-btn', 'aria-label': 'Playback settings' }, [icon('tune')]);
  const settings = ui.panel('settings', { title: 'Playback settings' });
  const skipChips = h('div', { class: 'wsp-chips', role: 'group', 'aria-labelledby': 'wspSkipHead' });
  const rewindSwitch = h('button', {
    type: 'button', class: 'wsp-switch', role: 'switch', 'aria-checked': 'true',
    'aria-labelledby': 'wspRewindHead', 'aria-describedby': 'wspRewindNote'
  });
  settings.body.appendChild(h('div', { class: 'wsp-opt-sec' }, [
    h('h4', { class: 'wsp-opt-head', id: 'wspSkipHead', text: 'Skip length' }),
    h('p', { class: 'wsp-opt-note', text: 'How far the back and forward buttons go.' }),
    skipChips
  ]));
  settings.body.appendChild(h('div', { class: 'wsp-opt-sec wsp-opt-row' }, [
    h('div', null, [
      h('h4', { class: 'wsp-opt-head', id: 'wspRewindHead', text: 'Smart rewind' }),
      h('p', { class: 'wsp-opt-note', id: 'wspRewindNote', text: 'When you press play again, go back a few seconds, more the longer you were away.' })
    ]),
    rewindSwitch
  ]));
  function kbd(t) { return h('kbd', { class: 'wsp-kbd', text: t }); }
  settings.body.appendChild(h('div', { class: 'wsp-opt-sec wsp-keys' }, [
    h('h4', { class: 'wsp-opt-head', text: 'Keyboard' }),
    h('ul', { class: 'wsp-key-list' }, [
      h('li', null, [kbd('Space'), h('span', { text: 'Play or pause' })]),
      h('li', null, [kbd('←'), kbd('→'), h('span', { text: 'Back or forward' })]),
      h('li', null, [kbd('['), kbd(']'), h('span', { text: 'Slower or faster' })])
    ])
  ]));
  let skipDrawn = '';
  function drawSkipChips(current) {
    const list = SKIP_CHOICES.slice();
    if (list.indexOf(current) === -1) {
      list.push(current);
      list.sort(function (a, b) { return a - b; });
    }
    const key = list.join(',');
    if (key !== skipDrawn) {
      skipDrawn = key;
      skipChips.textContent = '';
      list.forEach(function (n) {
        skipChips.appendChild(h('button', {
          type: 'button', class: 'wsp-chip', 'data-skip': String(n), 'aria-pressed': 'false',
          'aria-label': n + ' seconds', text: n + ' s'
        }));
      });
    }
    skipChips.querySelectorAll('.wsp-chip').forEach(function (b) {
      setAttr(b, 'aria-pressed', Number(b.getAttribute('data-skip')) === current ? 'true' : 'false');
    });
  }
  skipChips.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-skip]') : null;
    if (b) setSkip(Number(b.getAttribute('data-skip')));
  });
  rewindSwitch.addEventListener('click', function () { setRewind(!prefs.smart_rewind); });
  settingsBtn.addEventListener('click', function () { settings.show(settingsBtn); });
  ui.fill('menu', settingsBtn);

  // Speed: a stepper and the usual presets.
  const speedBtn = ui.actionButton({ text: formatSpeed(1), label: 'Speed' });
  const speedText = speedBtn.querySelector('.wsp-action-text');
  const speedPanel = ui.panel('speed', { title: 'Speed' });
  const slower = h('button', { type: 'button', class: 'wsp-icon-btn wsp-step', 'aria-label': 'Slower' }, [icon('remove')]);
  const faster = h('button', { type: 'button', class: 'wsp-icon-btn wsp-step', 'aria-label': 'Faster' }, [icon('add')]);
  const speedNow = h('p', { class: 'wsp-speed-now', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const speedChips = h('div', { class: 'wsp-chips', role: 'group', 'aria-label': 'Speeds' });
  SPEED_PRESETS.forEach(function (x) {
    speedChips.appendChild(h('button', { type: 'button', class: 'wsp-chip', 'data-speed': String(x), 'aria-pressed': 'false', text: formatSpeed(x) }));
  });
  speedPanel.body.appendChild(h('div', { class: 'wsp-opt-sec' }, [
    h('div', { class: 'wsp-speed' }, [slower, speedNow, faster]),
    speedChips
  ]));
  slower.addEventListener('click', function () { setSpeed(stepSpeed(player.state().speed, -1)); });
  faster.addEventListener('click', function () { setSpeed(stepSpeed(player.state().speed, 1)); });
  speedChips.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-speed]') : null;
    if (b) setSpeed(Number(b.getAttribute('data-speed')));
  });
  speedBtn.addEventListener('click', function () { speedPanel.show(speedBtn); });
  ui.fill('speed', speedBtn);

  function drawSpeed(x) {
    const label = formatSpeed(x);
    if (speedText) setText(speedText, label);
    setAttr(speedBtn, 'aria-label', 'Speed, ' + label.replace('×', ' times'));
    setText(speedNow, label);
    slower.disabled = x <= SPEED_MIN;
    faster.disabled = x >= SPEED_MAX;
    speedChips.querySelectorAll('.wsp-chip').forEach(function (b) {
      setAttr(b, 'aria-pressed', Number(b.getAttribute('data-speed')) === x ? 'true' : 'false');
    });
  }

  // The sleep timer: its time left shows on its button.
  const sleepBtn = ui.actionButton({ icon: 'bedtime', label: 'Sleep' });
  const sleepLabel = sleepBtn.querySelector('.wsp-action-label');
  const sleepPanel = ui.panel('sleep', { title: 'Sleep timer' });
  const sleepNote = h('p', { class: 'wsp-opt-note wsp-sleep-note' });
  const sleepList = h('ul', { class: 'wsp-rows', role: 'list' });
  function sleepRow(text, kind, minutes) {
    const b = h('button', { type: 'button', class: 'wsp-row', 'data-kind': kind, 'data-minutes': minutes ? String(minutes) : null, 'aria-pressed': 'false' }, [
      h('span', { class: 'wsp-row-text', text: text }),
      icon('check', 'wsp-row-check')
    ]);
    sleepList.appendChild(h('li', null, [b]));
    return b;
  }
  SLEEP_MINUTES.forEach(function (m) { sleepRow(m + ' minutes', 'minutes', m); });
  const chapterRow = sleepRow('End of chapter', 'chapter', 0);
  const sleepOff = h('button', { type: 'button', class: 'wsp-row wsp-row-off', hidden: true }, [
    h('span', { class: 'wsp-row-text', text: 'Turn off the timer' })
  ]);
  sleepList.appendChild(h('li', null, [sleepOff]));
  sleepPanel.body.appendChild(h('div', { class: 'wsp-opt-sec' }, [sleepNote, sleepList]));
  sleepList.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('.wsp-row') : null;
    if (!b) return;
    if (b === sleepOff) {
      cancelSleep();
    } else if (!startSleep(b.getAttribute('data-kind'), Number(b.getAttribute('data-minutes')))) {
      return;
    }
    // On a phone the list covers the player: back to it, to see the timer.
    hideOnPhone(sleepPanel);
  });
  sleepBtn.addEventListener('click', function () { sleepPanel.show(sleepBtn); });
  ui.fill('sleep', sleepBtn);

  let sleepMinutesSaid = null;
  function drawSleep(left) {
    const on = !!sleep && left !== null;
    sleepBtn.classList.toggle('is-on', on);
    if (sleepLabel) setText(sleepLabel, on ? formatCountdown(left) : 'Sleep');
    // The spoken label changes by the minute, not the second.
    const mins = on ? Math.max(1, Math.ceil(left / 60000)) : null;
    if (mins !== sleepMinutesSaid) {
      sleepMinutesSaid = mins;
      setAttr(sleepBtn, 'aria-label', on ? 'Sleep timer, ' + mins + (mins === 1 ? ' minute' : ' minutes') + ' left' : 'Sleep timer');
    }
    if (!on) setText(sleepNote, 'Pause playback after a while, fading out gently.');
    else if (sleep.kind === 'chapter') setText(sleepNote, 'Pausing at the end of this chapter, in ' + formatCountdown(left) + '.');
    else setText(sleepNote, 'Pausing in ' + formatCountdown(left) + (player.state().playing ? '.' : ' of listening.'));
    setAttr(sleepOff, 'hidden', on ? null : '');
    sleepList.querySelectorAll('.wsp-row[data-kind]').forEach(function (b) {
      const pressed = on && b.getAttribute('data-kind') === sleep.kind &&
        (sleep.kind === 'chapter' || Number(b.getAttribute('data-minutes')) === sleep.minutes);
      setAttr(b, 'aria-pressed', pressed ? 'true' : 'false');
    });
  }

  // History: the book's listening sessions, a tap goes to where one ended.
  const historyBtn = ui.actionButton({ icon: 'history', label: 'History' });
  const historyPanel = ui.panel('history', { title: 'History' });
  const histNote = h('p', { class: 'wsp-opt-note wsp-hist-note', role: 'status' });
  const histList = h('ul', { class: 'wsp-rows wsp-hist', role: 'list' });
  const histMore = h('button', { type: 'button', class: 'wsp-row wsp-hist-more', hidden: true }, [
    h('span', { class: 'wsp-row-text', text: 'Show older' })
  ]);
  historyPanel.body.appendChild(h('div', { class: 'wsp-opt-sec' }, [histNote, histList, histMore]));

  // hist: { book, gen, entries (newest first, every page so far), next (the
  // cursor for older ones, null: no more), loading, failed, sessions }.
  let histGen = 0;

  function bookChanged() {
    hist = null;
    histList.textContent = '';
    setText(histNote, '');
    setAttr(histMore, 'hidden', '');
    if (historyPanel.shown && player.state().book) loadHistory(false);
  }

  function loadHistory(older) {
    const book = player.state().book;
    if (!book) return;
    if (!older || !hist || hist.book !== book) {
      histGen += 1;
      hist = { book: book, gen: histGen, entries: [], next: null, loading: false, failed: false, sessions: [] };
    }
    const h0 = hist;
    if (h0.loading || (older && !h0.next)) return;
    h0.loading = true;
    h0.failed = false;
    drawHistory();
    const url = HISTORY_URL + encodeURIComponent(book) + (older ? '?before=' + encodeURIComponent(h0.next) : '');
    getJSON(url).then(function (data) {
      if (hist !== h0) return;
      h0.loading = false;
      const entries = data && Array.isArray(data.entries) ? data.entries : [];
      h0.entries = h0.entries.concat(entries);
      h0.next = data && typeof data.next_before === 'string' && data.next_before ? data.next_before : null;
      drawHistory();
    }, function () {
      if (hist !== h0) return;
      h0.loading = false;
      h0.failed = true;
      drawHistory();
    });
  }

  function drawHistory() {
    const hs = hist;
    if (!hs) return;
    const s = player.state();
    // Regrouped from every page each time: a session across two pages is one.
    hs.sessions = groupSessions(hs.entries, function (track, offset) { return player.placeMs(track, offset); });
    histList.textContent = '';
    const nowMs = now();
    const canFind = !!helper();
    hs.sessions.forEach(function (x, i) {
      const when = sessionWhen(x, nowMs);
      const where = sessionPlace(x, s.chapters, s.bookDurationMs);
      // The chapters it covered, when more than the one it ended in.
      const covered = sessionChapters(x, s.chapters);
      const range = covered.indexOf('Chapters ') === 0 ? covered : '';
      const device = x.device || 'Another device';
      // Its part is gone (the files changed, or an earlier copy): the helper
      // finds the place in this copy.
      const gone = x.endMs === null;
      const b = h('button', {
        type: 'button', class: 'wsp-row wsp-hist-row', 'data-session': String(i),
        disabled: gone && !canFind ? true : null,
        'aria-label': [when, where, range, device + (x.earlier ? ', earlier copy' : '')].filter(Boolean).join(', ') +
          (gone ? (canFind ? '. Find this place in this copy' : '') : '. Go to where it ended')
      }, [
        h('span', { class: 'wsp-row-text' }, [
          h('span', { class: 'wsp-hist-when', text: when }),
          where ? h('span', { class: 'wsp-hist-what', text: where }) : null,
          h('span', { class: 'wsp-hist-dev' }, [
            h('span', { class: 'wsp-hist-device', text: range ? range + ' · ' + device : device }),
            x.earlier ? h('span', { class: 'wsp-hist-tag', text: 'Earlier copy' }) : null
          ])
        ]),
        gone && canFind ? icon('travel_explore', 'wsp-hist-find') : null
      ]);
      histList.appendChild(h('li', null, [b]));
    });
    let note = '';
    if (hs.loading && !hs.entries.length) note = 'Loading…';
    else if (hs.failed) note = "Couldn't load your listening history.";
    else if (!hs.sessions.length) note = 'No listening history for this book yet.';
    setText(histNote, note);
    const more = hs.failed || (!!hs.next && !hs.loading);
    setAttr(histMore, 'hidden', more ? null : '');
    setText(histMore.firstChild, hs.failed ? 'Try again' : 'Show older');
  }

  // The "Find your place" helper (findplace.js), loaded after this.
  function helper() {
    try {
      const f = typeof env.findPlace === 'function' ? env.findPlace() : null;
      return f && typeof f.open === 'function' ? f : null;
    } catch (e) {
      return null;
    }
  }

  // A session as the helper's old place (as state().filesChanged.old).
  function oldPlace(x) {
    return {
      track: x.endPlace.track, offset_ms: x.endPlace.offset_ms,
      book_ms: x.endBookMs, book_duration_ms: x.endDurationMs, chapter_label: x.endLabel,
      updated_at: new Date(x.end).toISOString(), source: 'history',
      linked_from: x.earlier ? x.bookKey : null, book_title: null, narrator: null, earlier: x.earlier
    };
  }

  histList.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-session]') : null;
    if (!b || !hist || hist.book !== player.state().book) return;
    const x = hist.sessions[Number(b.getAttribute('data-session'))];
    if (!x) return;
    const fp = helper();
    if (x.endMs === null) {
      // Its part is gone: the helper, with this as the place to find.
      if (fp) fp.open(oldPlace(x), b);
      return;
    }
    // The listener's own move: saved as their place, with Undo over 2 minutes.
    // Held for the book's changed files, it is the helper's chosen spot
    // (nothing saved): back to the helper, to use it.
    player.seek(x.endMs);
    if (fp && player.state().filesChanged) fp.open(null, b);
    // On a phone the list covers the player: back to it, to see the jump.
    else hideOnPhone(historyPanel);
  });
  histMore.addEventListener('click', function () {
    loadHistory(!(hist && hist.failed && !hist.entries.length));
  });
  function showHistory(opener) {
    historyPanel.show(opener && opener.nodeType === 1 ? opener : historyBtn);
    loadHistory(false);
  }
  historyBtn.addEventListener('click', function () { showHistory(historyBtn); });
  ui.fill('history', historyBtn);

  function drawAll() {
    const s = player.state();
    drawSpeed(num(s.speed) || 1);
    drawSkipChips(num(player.setSkip()) || DEFAULTS.skip_s);
    setAttr(rewindSwitch, 'aria-checked', prefs.smart_rewind ? 'true' : 'false');
    const chapters = Array.isArray(s.chapters) ? s.chapters.length : 0;
    setAttr(chapterRow.parentNode, 'hidden', chapters ? null : '');
    if (!sleep) drawSleep(null);
  }

  drawAll();

  return {
    sleep: startSleep,
    cancelSleep: cancelSleep,
    sleepState: function () {
      if (!sleep) return null;
      return { kind: sleep.kind, minutes: sleep.minutes, leftMs: sleepLeft(sleep, player.state()) };
    },
    prefs: function () { return { skip_s: prefs.skip_s, speed: prefs.speed, smart_rewind: prefs.smart_rewind }; },
    showHistory: function (opener) { showHistory(opener); }
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/* Adds the features to the engine and view booted before it (WS.player,
   WS.playerUI), once per document, as WS.playerFeatures. Returns them, or
   null on a page without the player. */
export function boot(win, overrides) {
  const WS = win.WS || (win.WS = {});
  if (WS.playerFeatures) return WS.playerFeatures;
  const player = (overrides && overrides.player) || WS.player;
  const ui = (overrides && overrides.ui) || WS.playerUI;
  if (!player || !ui) return null;
  const doc = win.document;
  const perf = win.performance;
  const features = createFeatures(Object.assign({
    player: player,
    ui: ui,
    doc: doc,
    win: win,
    fetch: typeof win.fetch === 'function' ? win.fetch.bind(win) : null,
    now: Date.now,
    mono: perf && typeof perf.now === 'function' ? function () { return perf.now(); } : Date.now,
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    matchMedia: typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null,
    isDialogOpen: function () { return !!(win.WSUI && win.WSUI.isDialogOpen && win.WSUI.isDialogOpen()); },
    pathname: function () { return win.location.pathname; },
    // The "Find your place" helper loads after this (findplace.js).
    findPlace: function () { return WS.playerFindPlace || null; },
    // A page's tour (tour.js) shows its layer while it runs.
    tourActive: function () {
      const layer = doc.getElementById('tourLayer');
      return !!layer && !layer.classList.contains('hidden');
    }
  }, overrides || {}));
  WS.playerFeatures = features;
  return features;
}

if (typeof window !== 'undefined' && window.document) boot(window);
