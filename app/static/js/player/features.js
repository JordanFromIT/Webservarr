/**
 * WebServarr — the audiobook player's listening features (ES module,
 * document-lifetime)
 *
 * Skip length, speed, the sleep timer, smart rewind, undo for big jumps and
 * the keyboard shortcuts, on top of the engine (engine.js, WS.player) and its
 * view (ui.js, WS.playerUI). Loaded by the shell partial as its own module
 * script right after ui.js (so it carries its own asset stamp); nothing
 * imports it. Like the engine it lives as long as the document: its
 * listeners are added once, and its timers run only while a sleep timer or a
 * settings save is pending. Design:
 * docs/superpowers/specs/2026-09-28-audiobook-player-design.md, section 8.
 * Styles: theme.css "Audiobook player" (theme variables only).
 *
 * Settings (per listener, GET/PUT /api/player/prefs): read once when the page
 * loads, and handed to the engine (applyPrefs, a 'prefs' change, so the skip
 * buttons and the speed follow while paused). Until then, and for an account
 * the player is not for (401, 403, 404), the defaults (10 s, 1x, smart rewind
 * on), with no error; a read that failed otherwise is tried again when the
 * next book opens. A change is sent a moment later (only what changed here,
 * kept until the server takes it: a failed save goes again with the next
 * change), and at once when the page is left.
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
 *   play. A place the listener moves to is theirs: no rewind from it. No
 *   rewind while the listener's settings are unknown (their read failed).
 *   The rewound place is saved like any seek.
 * - Undo: a seek of more than 2 minutes (the scrubber, a chapter, a skip, the
 *   lock screen) shows "Jumped back|ahead <delta>." with Undo for 8 s. Undo
 *   goes back to where that jump started, and raises no notice of its own; a
 *   second big jump replaces the first's notice and place.
 * - Keys: Space plays or pauses, the left and right arrows skip by the skip
 *   length, [ and ] change the speed by 0.05; a held key acts once. Inside the full player they are
 *   always on (WS.playerUI.onKey; Space on a focused button presses the
 *   button). With it closed, on the page (document, bubble phase), only when
 *   a book is loaded and the key is nobody else's: not already handled, not
 *   in a field or on a button or other control, not on the reader (its own
 *   Space and arrows), not under a page's tour or a WSUI dialog.
 *
 * Pure (importable by Node, no DOM at import time):
 *   rewindFor(awayMs)                     ms to go back: 0, 3 s, 10 s or 30 s
 *   rewindTarget(parts, fromMs, backMs)   the book ms to go back to, or null
 *   stepSpeed(speed, dir)                 the next speed up (1) or down (-1)
 *   formatSpeed(x)                        "1×", "1.25×"
 *   formatDelta(ms), jumpMessage(from, to)   "12 min", "Jumped back 12 min."
 *   formatCountdown(ms)                   "14:32", "1:00:00"
 *   chapterEnd(state)                     the current chapter's end, book ms
 *   createFeatures(env)                   the features, given their surroundings
 *   boot(win, overrides)                  WS.playerFeatures
 *
 * WS.playerFeatures (for Task 9 and the tests):
 *   sleep(kind, minutes)   kind 'minutes' (with 15, 30 or 60) or 'chapter'
 *   cancelSleep()
 *   sleepState() -> { kind, minutes, leftMs } | null
 *   prefs() -> { skip_s, speed, smart_rewind }
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
export const PREFS_URL = '/api/player/prefs';
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

// ---------------------------------------------------------------------------
// The features
// ---------------------------------------------------------------------------

/* env: { player (WS.player), ui (WS.playerUI), doc, win (its pagehide and
   the router's ws:before-hard-nav), fetch, now() (wall clock: time away),
   mono() (a clock the system never steps: the sleep timer), setTimeout,
   clearTimeout, matchMedia, isDialogOpen(), pathname(), tourActive() }. */
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
     503) goes again with the next change, and on leaving. */
  function sendPrefs(leaving) {
    if (putTimer !== null) {
      clearT(putTimer);
      putTimer = null;
    }
    if (!unsent.size || !fetchFn) return;
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
      if (!resp || !(resp.status >= 200 && resp.status < 300)) return;
      sent.forEach(function (n, k) {
        if (unsent.get(k) === n) unsent.delete(k);
      });
    }, function () { /* kept: the next change, or leaving, sends it again */ });
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

  // Back backMs from fromMs (book ms), within what can play.
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
      player.seek(to);
    } finally {
      ownSeek = false;
    }
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

  let lastBook = null;
  let lastPlaying = false;
  let pausedAt = null;         // wall ms of the last pause after listening
  let heard = false;           // playback has moved since it last started
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
      openRewind = null;
    }
    const moved = r === 'seek' || r === 'skip' || r === 'jump';
    if (moved && !ownSeek) {
      // A place the listener chose while paused is theirs: no rewind from it,
      // nor from the place the book opened at once they have moved.
      if (!s.playing) pausedAt = null;
      openRewind = null;
      if (sleep && sleep.kind === 'chapter') {
        sleep.endMs = chapterEnd(s);
        if (sleep.endMs === null) cancelSleep();
      }
      if (!undoing && typeof d.from === 'number' && typeof d.to === 'number' &&
          Math.abs(d.to - d.from) > UNDO_OVER_MS) {
        offerUndo(s.book, d.from, d.to);
      }
    }
    if (r === 'time' && s.playing) heard = true;
    if (was && !s.playing) {
      // A pause (or a stop) during the fade ends the timer, volume restored.
      if (sleep && sleep.fading && !sleepPausing) cancelSleep();
      if (r === 'pause' && heard) pausedAt = now();
      heard = false;
    }
    if (r === 'ended') cancelSleep();
    if (r === 'open') {
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
      if (prefsKnown() && prefs.smart_rewind) rewindBy(o.from, rewindFor(o.age + Math.max(0, mono() - o.since)));
    }
    if (!was && s.playing) {
      const at = pausedAt;
      pausedAt = null;
      heard = false;
      // Play again after a pause, or Retry after a stop that came while paused.
      if ((r === 'play' || r === 'retry') && at !== null && prefsKnown() && prefs.smart_rewind) {
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
  loadPrefs();

  return {
    sleep: startSleep,
    cancelSleep: cancelSleep,
    sleepState: function () {
      if (!sleep) return null;
      return { kind: sleep.kind, minutes: sleep.minutes, leftMs: sleepLeft(sleep, player.state()) };
    },
    prefs: function () { return { skip_s: prefs.skip_s, speed: prefs.speed, smart_rewind: prefs.smart_rewind }; }
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
