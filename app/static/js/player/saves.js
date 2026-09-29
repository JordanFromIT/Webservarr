/**
 * WebServarr — the audiobook player's saves (ES module)
 *
 * Never lose the listener's place. The engine (engine.js) reports every
 * change; this module saves the place to POST /api/player/checkin, keeps a
 * copy in localStorage, picks the place to resume from, and says when saves
 * are failing. Design: docs/superpowers/specs/2026-09-28-audiobook-player-design.md,
 * sections 5.3, 6 and 9.
 *
 * Save loop: while playing, a save every 10 s, driven by the changes the
 * engine reports (the element's timeupdate goes on in a background tab where
 * timers are throttled); a timer is only the fallback. Play, pause, seek,
 * skip, chapter jump, the end of the book and playback stopping on an error
 * are saved at once (a seek or jump while paused goes as a pause). One save is
 * in flight per book: whatever happens meanwhile folds into one follow-up
 * with the place as it is then, and saves are at least 1 s apart. Every save
 * carries the current place and a fresh seq (never a stale body), under one
 * psid for the page session. A failure (a network error, no answer in 15 s,
 * any status but 2xx, 429 included) backs off 10, 20, then 30 s; time the
 * page spent frozen or hidden does not count against the 15 s. Scheduling
 * runs on performance.now, so a stepped system clock never holds a save.
 * Only a place the listener played or moved to is sent (an untouched
 * opening place never is), and only while it is under 2 minutes old: an
 * older unsaved place (a phone paused offline, back online hours later)
 * stays in the local copy, stamped when it was reached, for the next open's
 * merge to weigh. A newer local copy the book opens at counts as reached
 * when it opens: it is sent at once, then under the same 2 minutes. A 401 means
 * the session ended: nothing more is sent, the local copy keeps the place,
 * and the listener is sent to sign in (shell.js WS.leaveTo, through the
 * router, so ws:before-hard-nav runs first).
 * Hard exits (ws:before-hard-nav, pagehide, the page hidden) send a beacon.
 * A paused place within 1 s of the one the server took (the element's last
 * timeupdate lands just past a saved pause) is that saved place: it is not
 * sent again, by a save, a beacon or stop()'s last save.
 *
 * Other devices (spec 11b): every save carries `base`, the server's
 * timestamp of the place this page last saw (the position read at open,
 * then each save the server took). The server refuses a save over another
 * device's newer place with 409 and that place. Then nothing more is sent:
 * onWarning gets { kind: 'conflict', book, conflict: { track, offset_ms,
 * device, updated_at }, now }, the local copy keeps following the place,
 * and resolveConflict() (the listener's answer) takes the stored timestamp
 * as the new base and lets saves go again. A beacon or last save refused
 * that way is dropped.
 * Smart rewind (a change the engine marks { rewind: true }) never moves the
 * saved place back: until playback passes the place it went back from, that
 * place is what every save (and the local copy) carries; the listener's own
 * seek, skip or jump, another book or a close ends that.
 *
 * Device: every save carries the device label ("Chrome on Android") and this
 * browser's own random id (device_id), made once and kept in localStorage
 * (for the page session only where storage throws), so the handoff prompt
 * can tell two phones of one kind apart, and a reload is still this device.
 *
 * Local copy: every change of place is written to localStorage under the
 * listener's identity key (WS.user.identity_key, from #ws-data: an opaque
 * HMAC of the account identity, so no account id sits in storage) and the
 * book, stamped when the place is reached, in the server's clock as last
 * measured (from a stored check-in, or the server's `now` on GET /position,
 * measured before the resume merge compares copies; kept across page
 * sessions), so it compares fairly with the server's copies from a fast or
 * slow device, and marked `own` once the listener has played or moved to it
 * here (an untouched opening place, taken from another device, is not this
 * device's own place). Storage can
 * throw (a private window): every call is guarded, and saves go on without.
 *
 * Warning: while playing, once saves have failed and the place has gone
 * unsaved for 30 s, onWarning gets { kind: 'not-saved', active: true,
 * lastSavedAt, message }; the next success sends active: false. A page that
 * is only hidden never warns: it takes a failure.
 *
 * Pure (importable by Node, no DOM at import time):
 *   deviceLabel(userAgent)            "<Browser> on <OS>", e.g. "Chrome on Android"
 *   deviceIdFrom(storage)             this browser's id: the stored one, else a new one
 *                                     (stored when storage lets it)
 *   isDeviceId(v)                     16 to 40 lower-case letters and digits
 *   resumeOrder({ web, plex, local }) every usable copy, newest first:
 *                                     [{ source, track, offset_ms, duration_ms, updated_at, device, device_id }]
 *   resolveResume({ web, plex, local }) the newest of them, or null
 *   createSaver(o)                    the saver, given its surroundings (tests)
 *   browserSaver(win, o)              a saver wired to the page (fetch, sendBeacon,
 *                                     localStorage, WS.user, pagehide and friends)
 *
 * createSaver({ post(body, kind) -> Promise<{ status, data }> | boolean (a beacon),
 *               now (wall clock), mono (monotonic; default performance.now),
 *               storage, identity (the identity key: string or function), device,
 *               deviceId, setTimeout, clearTimeout, onSignedOut, formatTime, psid })
 *   start(book, { push, savedAt, held, keepLocal })
 *                                   push: the place the book opens at is newer
 *                                   than the server's (a local copy): send it at
 *                                   once (it counts as reached now, so after 2
 *                                   minutes unsaved it stays local). savedAt: the server's last save of it
 *                                   (ISO), "Last saved" until this page saves.
 *                                   held: { track, offset_ms } the server holds
 *                                   already (the book resumed from it).
 *                                   savedAt is also the first `base`.
 *                                   keepLocal: leave this browser's local copy
 *                                   as it is until the listener plays or moves
 *                                   (the open's handoff question is showing).
 *   stop()                          saves the last place once (if it needs it; its
 *                                   seq is taken at once, so whatever opens next
 *                                   outranks it), ends an active warning with
 *                                   active: false, then no timers are left.
 *                                   A pause or move still in flight gets a last
 *                                   'leave' of its place, sent only if it fails.
 *   resolveConflict() -> conflict | null   the listener answered a 409: saves go
 *                                   again, over the place it showed
 *   note(change)                    each engine change { reason, state, rewind }
 *   flush('beacon' | 'fetch', event) send now: a beacon, or a fetch past the backoff
 *   wake()                          back from frozen or hidden: the save in flight
 *                                   gets its full 15 s again
 *   clockProbe() -> done(serverNow) measure the clock against a server answer
 *   readLocal(book) -> { track, offset_ms, duration_ms, updated_at, device, own } | null
 *   resumeFrom(book, { web, plex }) -> resumeOrder with the local copy
 *   onWarning(fn) -> unsubscribe
 *   lastSavedAt (ms, this page's clock, or null), warning (bool), psid,
 *   device (the label), deviceId ('' when none was given)
 *
 * In the browser, loaded as its own module script before engine.js (so it
 * carries its own asset stamp), it sets WS.playerSaves for the engine's boot.
 */

export const SAVE_EVERY_MS = 10000;     // while playing
export const MIN_GAP_MS = 1000;         // between any two saves
export const WARN_AFTER_MS = 30000;     // unsaved this long while playing, with saves failing
export const BACKOFF_MS = [10000, 20000, 30000];
export const POST_TIMEOUT_MS = 15000;   // a save not answered by then has failed
export const PLEX_ECHO_MS = 2000;       // Plex's copy of a save forwarded to it is stamped a moment later
export const FRESH_MS = 120000;         // an unsaved place older than this stays local (see sendable)
export const FREEZE_MS = 5000;          // a silence this long while playing: the page was frozen
export const DRIFT_MS = 1000;           // paused, this close to the saved place is the saved place
export const NOT_SAVED = "Your place isn't being saved.";

const CHECKIN_URL = '/api/player/checkin';
const STORE_PREFIX = 'ws-player:';
const CLOCK_KEY = STORE_PREFIX + 'clock';
const DEVICE_KEY = STORE_PREFIX + 'device';
const DEVICE_MAX = 80;
const DEVICE_ID = /^[a-z0-9]{16,40}$/;

// The check-in event for an engine change, and whether it is saved at once.
const EVENTS = {
  play: ['play', true],
  pause: ['pause', true],
  seek: ['seek', true],
  skip: ['seek', true],
  jump: ['jump', true],
  ended: ['end', true],
  // Playback stopped on a failure: the place it holds (frozen there) is saved
  // as a pause, so the seconds since the last save are not lost.
  error: ['pause', true]
};
// The listener's own moves: they end a smart rewind's floor.
const MOVES = { seek: true, skip: true, jump: true };
// Equal times: WebServarr's own copy, then this browser's, then Plex's.
const RANK = { web: 0, local: 1, plex: 2 };

function noop() {}

// ---------------------------------------------------------------------------
// Device label
// ---------------------------------------------------------------------------

export function deviceLabel(ua) {
  const s = typeof ua === 'string' ? ua : '';
  let browser = 'Web browser';
  if (/\bEdg(?:e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/\bOPR\/|\bOpera\b/.test(s)) browser = 'Opera';
  else if (/\bSamsungBrowser\//.test(s)) browser = 'Samsung Internet';
  else if (/\bFirefox\/|\bFxiOS\//.test(s)) browser = 'Firefox';
  else if (/\bChrome\/|\bCriOS\/|\bChromium\//.test(s)) browser = 'Chrome';
  else if (/\bSafari\//.test(s) && /\bVersion\//.test(s)) browser = 'Safari';
  let os = '';
  if (/\bAndroid\b/.test(s)) os = 'Android';
  else if (/\biPhone\b|\biPod\b/.test(s)) os = 'iPhone';
  else if (/\biPad\b/.test(s)) os = 'iPad';
  else if (/\bCrOS\b/.test(s)) os = 'ChromeOS';
  else if (/\bWindows\b/.test(s)) os = 'Windows';
  else if (/\bMacintosh\b|\bMac OS X\b/.test(s)) os = 'macOS';
  else if (/\bLinux\b|\bX11\b/.test(s)) os = 'Linux';
  return (os ? browser + ' on ' + os : browser).slice(0, DEVICE_MAX);
}

/* This browser's own id: random, 32 lower-case letters and digits. */
function newDeviceId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  let out = '';
  try {
    if (c && typeof c.getRandomValues === 'function') {
      // 252 is the largest multiple of 36 under 256: no letter is likelier.
      while (out.length < 32) {
        c.getRandomValues(new Uint8Array(40)).forEach(function (b) {
          if (b < 252 && out.length < 32) out += abc[b % 36];
        });
      }
      return out;
    }
  } catch (e) { out = ''; }
  while (out.length < 32) out += abc[Math.floor(Math.random() * 36)];
  return out;
}

export function isDeviceId(v) {
  return typeof v === 'string' && DEVICE_ID.test(v);
}

/* The id this browser keeps for itself: the stored one, else a new one,
   stored if storage lets it. Where storage throws (a private window) the new
   one lasts for the page session. */
export function deviceIdFrom(storage) {
  let kept = null;
  try {
    kept = storage ? storage.getItem(DEVICE_KEY) : null;
  } catch (e) { kept = null; }
  if (isDeviceId(kept)) return kept;
  const id = newDeviceId();
  try {
    if (storage) storage.setItem(DEVICE_KEY, id);
  } catch (e) { /* this page session only */ }
  return id;
}

// ---------------------------------------------------------------------------
// Resume: the newest copy
// ---------------------------------------------------------------------------

function timeOf(v) {
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v) return Date.parse(v);
  return NaN;
}

function copyOf(source, p) {
  if (!p || typeof p !== 'object') return null;
  const track = p.track == null ? '' : String(p.track);
  const offset = typeof p.offset_ms === 'number' ? p.offset_ms : NaN;
  const at = timeOf(p.updated_at);
  if (!track || !isFinite(offset) || offset < 0 || !isFinite(at)) return null;
  const duration = Number(p.duration_ms);
  return {
    source: source,
    track: track,
    offset_ms: Math.round(offset),
    duration_ms: isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    updated_at: new Date(at).toISOString(),
    device: typeof p.device === 'string' ? p.device : '',
    device_id: isDeviceId(p.device_id) ? p.device_id : '',
    // Plex stamps its copy of a save WebServarr forwarded after it, in whole
    // seconds: that echo is not a newer place.
    rankAt: source === 'plex' ? at - PLEX_ECHO_MS : at
  };
}

export function resumeOrder(copies) {
  const c = copies || {};
  const list = [copyOf('web', c.web), copyOf('local', c.local), copyOf('plex', c.plex)].filter(Boolean);
  list.sort(function (a, b) { return (b.rankAt - a.rankAt) || (RANK[a.source] - RANK[b.source]); });
  return list.map(function (x) {
    return { source: x.source, track: x.track, offset_ms: x.offset_ms, duration_ms: x.duration_ms, updated_at: x.updated_at, device: x.device, device_id: x.device_id };
  });
}

export function resolveResume(copies) {
  return resumeOrder(copies)[0] || null;
}

// ---------------------------------------------------------------------------
// The saver
// ---------------------------------------------------------------------------

function placeOf(p) {
  if (!p || typeof p !== 'object' || p.track == null || p.track === '') return null;
  // Only a number is an offset (Number(null) would be 0: the start of the part).
  if (typeof p.offset_ms !== 'number') return null;
  let offset = Math.round(p.offset_ms);
  let duration = Math.round(Number(p.duration_ms));
  if (!isFinite(offset) || offset < 0) return null;
  if (!isFinite(duration) || duration < 0) duration = 0;
  if (offset > duration) offset = duration;       // the server refuses an offset past the part
  return { track: String(p.track), offset_ms: offset, duration_ms: duration };
}

function samePlace(a, b) {
  return !!a && !!b && a.track === b.track && a.offset_ms === b.offset_ms;
}

function newPsid() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  try {
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      return Array.from(c.getRandomValues(new Uint8Array(16)), function (b) { return (b + 256).toString(16).slice(1); }).join('');
    }
  } catch (e) { /* below */ }
  return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// A clock the system never steps (performance.now), for scheduling.
function monotonic() {
  const perf = typeof performance !== 'undefined' ? performance : null;
  if (perf && typeof perf.now === 'function') return function () { return perf.now(); };
  return Date.now;
}

function clockTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

export function createSaver(o) {
  const post = o.post;
  const now = o.now || Date.now;          // wall clock: stamps, "Last saved", the age of a place
  const mono = o.mono || monotonic();     // scheduling: never stepped by the system clock
  const storage = o.storage || null;
  const identityOf = typeof o.identity === 'function' ? o.identity : function () { return o.identity; };
  const device = typeof o.device === 'string' ? o.device.slice(0, DEVICE_MAX) : '';
  const deviceId = isDeviceId(o.deviceId) ? o.deviceId : '';
  const setT = o.setTimeout;
  const clearT = o.clearTimeout;
  const formatTime = typeof o.formatTime === 'function' ? o.formatTime : clockTime;
  const psid = typeof o.psid === 'string' && o.psid ? o.psid : newPsid();

  const warnFns = new Set();
  let seq = 0;
  let requests = 0;
  let run = null;             // the book being saved (see newRun)
  let signedOut = false;
  let lastSavedAt = null;
  let warning = false;
  let lastBeacon = '';
  let leftAt = '';            // the place a leave beacon went from: the page is going

  // ---- Storage (it can throw anywhere: a private window, a full quota) ----

  function stored(fn) {
    if (!storage) return null;
    try {
      return fn(storage);
    } catch (e) {
      return null;
    }
  }

  function identity() {
    let v = '';
    try { v = identityOf(); } catch (e) { v = ''; }
    return typeof v === 'string' ? v : '';
  }

  // How far the server's clock is ahead of this one, as last measured (by a
  // stored check-in, or the server's `now` on GET /position), kept for the
  // next page session. Any measured value is kept: a device days out is
  // exactly the one that needs it.
  let skew = (function () {
    const raw = stored(function (s) { return s.getItem(CLOCK_KEY); });
    const v = raw === null || raw === '' ? NaN : Number(raw);
    return isFinite(v) ? v : 0;
  })();

  function measureSkew(serverAt, sentWall, receivedWall) {
    const v = Math.round(serverAt - (sentWall + receivedWall) / 2);
    if (!isFinite(v)) return;
    skew = v;
    stored(function (s) { s.setItem(CLOCK_KEY, String(v)); });
  }

  /* Starts a clock measurement against a server answer: call it before the
     request, and the function it returns with the server's `now` (ISO). */
  function clockProbe() {
    const sent = now();
    return function (serverNow) {
      const at = timeOf(serverNow);
      if (isFinite(at)) measureSkew(at, sent, now());
    };
  }

  function localKey(id, book) {
    return STORE_PREFIX + 'place:' + id + ':' + book;
  }

  function readLocal(book) {
    const id = identity();
    if (!id || !book) return null;
    const raw = stored(function (s) { return s.getItem(localKey(id, String(book))); });
    if (typeof raw !== 'string' || !raw) return null;
    let v;
    try { v = JSON.parse(raw); } catch (e) { return null; }
    const c = copyOf('local', v);
    if (!c) return null;
    return { track: c.track, offset_ms: c.offset_ms, duration_ms: c.duration_ms, updated_at: c.updated_at, device: c.device, own: v.own === true };
  }

  // Stamped when the place is reached, in the server's clock. own: the
  // listener played or moved to it here.
  function writeLocal(book, place, own) {
    const id = identity();
    if (!id) return;
    const value = JSON.stringify({
      track: place.track,
      offset_ms: place.offset_ms,
      duration_ms: place.duration_ms,
      updated_at: new Date(now() + skew).toISOString(),
      device: device,
      own: !!own
    });
    stored(function (s) { s.setItem(localKey(id, book), value); });
  }

  // ---- A book being saved ----

  function newRun(book) {
    return {
      book: book,
      latest: null,           // the place, as last reported
      latestBookMs: NaN,      // its book time
      floor: null,            // { place, bookMs }: after a smart rewind, the place saved until playback passes it
      playing: false,
      reachedWall: null,      // when the place was last reached (played to, moved to, acted on);
      reachedMono: null,      // null: untouched since the book opened
      event: null,            // what the next save is for, if not a plain checkin
      urgent: false,          // save as soon as the gap allows
      acked: null,            // the place the server last took
      dirtySince: null,       // when (mono) the place first differed from that
      lastSendAt: -Infinity,  // mono
      lastNoteAt: null,       // mono, of the last change reported while playing
      inFlight: null,         // { id, at, from (its timeout counts from), wall, place, event }
      failures: 0,
      failedSinceOk: false,
      backoffUntil: 0,        // mono
      timer: null,
      timerAt: Infinity,      // mono
      stopped: false,
      final: null,            // the body stop() still owes
      fallback: null,         // the body stop() owes only if the save in flight fails
      base: null,             // the server's timestamp of the place this page last saw
      conflict: null,         // a 409 not yet answered: nothing is sent meanwhile
      keepLocal: false        // leave the local copy alone until the listener acts
    };
  }

  /* Paused within DRIFT_MS of the place the server took, on its part: the
     element's last timeupdate after a pause lands a moment past the saved
     pause (about 250 ms). That is the saved place, not a new one: a close
     or a hard exit must not send it as a 'leave' over a newer place another
     device saved meanwhile. The local copy still follows it. */
  function nearAcked(r) {
    return !r.playing && !!r.acked && r.latest.track === r.acked.track &&
      Math.abs(r.latest.offset_ms - r.acked.offset_ms) <= DRIFT_MS;
  }

  function dirty(r) {
    return !!r.latest && (r.event !== null || (!samePlace(r.latest, r.acked) && !nearAcked(r)));
  }

  /* May this place go to the server? Only one the listener played or moved
     to (never an untouched opening place), and only while it is recent: a
     place reached over 2 minutes ago and still unsaved stays in the local
     copy, stamped when it was reached, and the next open's merge decides.
     A newer local copy the book opens at counts as reached when it opens
     (start({ push })): sent at once, and under the same 2 minutes. */
  function sendable(r) {
    if (!r.latest || r.reachedMono === null) return false;
    return mono() - r.reachedMono <= FRESH_MS && now() - r.reachedWall <= FRESH_MS;
  }

  function body(book, place, event, base) {
    seq += 1;
    const b = {
      book: book,
      track: place.track,
      offset_ms: place.offset_ms,
      duration_ms: place.duration_ms,
      event: event,
      device: device,
      psid: psid,
      seq: seq,
      base: typeof base === 'string' && base ? base : null
    };
    if (deviceId) b.device_id = deviceId;
    return b;
  }

  // When (mono) the next save is due: Infinity for none.
  function dueAt(r) {
    if (r.stopped || r.inFlight || signedOut || r.conflict || !dirty(r) || !sendable(r)) return Infinity;
    let at;
    if (r.failures > 0) at = r.backoffUntil;          // what happens meanwhile waits for the retry
    else if (r.urgent) at = -Infinity;
    else if (r.playing) at = r.lastSendAt + SAVE_EVERY_MS;
    else return Infinity;
    return Math.max(at, r.lastSendAt + MIN_GAP_MS);
  }

  function send(r) {
    const place = r.latest;
    const event = r.event || (r.playing ? 'checkin' : 'pause');
    r.event = null;
    r.urgent = false;
    requests += 1;
    const id = requests;
    const at = mono();
    r.inFlight = { id: id, at: at, from: at, wall: now(), place: place, event: event };
    r.lastSendAt = at;
    let p;
    try {
      p = Promise.resolve(post(body(r.book, place, event, r.base), 'fetch'));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(function (res) { answered(r, id, res); }, function () { answered(r, id, null); });
  }

  // The answer to save `id`; false when it is not the one in flight (it was
  // given up on already).
  function settle(r, id, res) {
    if (!r.inFlight || r.inFlight.id !== id) return false;
    const sent = r.inFlight;
    r.inFlight = null;
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (status >= 200 && status < 300) {
      r.acked = sent.place;
      r.failures = 0;
      r.failedSinceOk = false;
      r.backoffUntil = 0;
      r.dirtySince = samePlace(r.latest, r.acked) ? null : sent.at;
      if (!r.stopped) lastSavedAt = now();
      const data = res.data;
      if (data && data.stored === true && typeof data.updated_at === 'string') {
        const at = Date.parse(data.updated_at);
        if (isFinite(at)) measureSkew(at, sent.wall, now());
        r.base = data.updated_at;
      }
      return true;
    }
    // Another device's newer place: not a failure (no backoff, no warning).
    // Nothing more is sent until the listener answers (resolveConflict).
    const c = status === 409 && res.data && res.data.conflict;
    if (c && typeof c === 'object') {
      if (r.event === null && sent.event !== 'checkin') r.event = sent.event;
      r.conflict = {
        track: String(c.track == null ? '' : c.track),
        offset_ms: Number(c.offset_ms),
        device: typeof c.device === 'string' ? c.device : '',
        updated_at: typeof c.updated_at === 'string' ? c.updated_at : null,
        now: typeof res.data.now === 'string' ? res.data.now : null
      };
      return true;
    }
    // Keep what the failed save was for (a pause, the end), unless something
    // newer has come since.
    if (r.event === null && sent.event !== 'checkin') r.event = sent.event;
    r.failures += 1;
    r.failedSinceOk = true;
    r.backoffUntil = mono() + BACKOFF_MS[Math.min(r.failures, BACKOFF_MS.length) - 1];
    if (status === 401) signOut();
    return true;
  }

  function answered(r, id, res) {
    const before = r.conflict;
    if (!settle(r, id, res)) return;
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (r.stopped) {
      // Refused for another device's newer place: the last save would be too.
      if (r.conflict) {
        r.final = null;
        r.fallback = null;
      }
      sendFinal(r, !(status >= 200 && status < 300));
      return;
    }
    if (r.conflict && r.conflict !== before) {
      const c = r.conflict;
      tell({ kind: 'conflict', book: r.book, conflict: { track: c.track, offset_ms: c.offset_ms, device: c.device, updated_at: c.updated_at }, now: c.now });
    }
    step();
  }

  function signOut() {
    if (signedOut) return;
    signedOut = true;
    if (typeof o.onSignedOut === 'function') {
      try {
        o.onSignedOut();
      } catch (e) {
        console.error('[player] the sign-in path failed', e);
      }
    }
  }

  // The page was frozen or hidden: that time does not count against the
  // save in flight. Its 15 s start again.
  function wakeRun(r) {
    if (r && r.inFlight) r.inFlight.from = mono();
  }

  function step() {
    const r = run;
    if (!r || r.stopped) return;
    if (r.inFlight && mono() - r.inFlight.from >= POST_TIMEOUT_MS) settle(r, r.inFlight.id, null);
    if (mono() >= dueAt(r)) send(r);
    checkWarning();
    arm(r);
  }

  // One timer, for the next thing due. It is the fallback: in a background
  // tab it may not fire for a minute, and the engine's changes drive step().
  function arm(r) {
    let next = dueAt(r);
    if (r.inFlight) next = Math.min(next, r.inFlight.from + POST_TIMEOUT_MS);
    if (!warning && r.playing && r.failedSinceOk && r.dirtySince !== null) {
      next = Math.min(next, r.dirtySince + WARN_AFTER_MS);
    }
    if (next === r.timerAt) return;
    if (r.timer !== null) clearT(r.timer);
    r.timer = null;
    r.timerAt = next;
    if (next === Infinity) return;
    r.timer = setT(function () {
      const late = mono() - r.timerAt;
      r.timer = null;
      r.timerAt = Infinity;
      // Far later than asked: the page was frozen or throttled meanwhile.
      if (late > FREEZE_MS) wakeRun(r);
      step();
    }, Math.max(0, next - mono()));
  }

  // ---- The warning ----

  function message() {
    return lastSavedAt === null ? NOT_SAVED : NOT_SAVED + ' Last saved ' + formatTime(lastSavedAt) + '.';
  }

  function tell(w) {
    Array.from(warnFns).forEach(function (fn) {
      try {
        fn(w);
      } catch (e) {
        console.error('[player] a warning listener failed', e);
      }
    });
  }

  function checkWarning() {
    const r = run;
    let on = warning;
    if (!r || r.stopped || !r.failedSinceOk) on = false;
    else if (!warning && r.playing && r.dirtySince !== null && mono() - r.dirtySince >= WARN_AFTER_MS) on = true;
    if (on === warning) return;
    warning = on;
    tell({ kind: 'not-saved', active: on, lastSavedAt: lastSavedAt, message: on ? message() : '' });
  }

  // ---- The engine's side ----

  function note(change) {
    const r = run;
    if (!r || r.stopped || !change || !change.state || change.state.book !== r.book) return;
    const st = change.state;
    const wasPlaying = r.playing;
    // Playing, the engine reports several changes a second: a long silence
    // means the page was frozen, which does not count against a save.
    const t = mono();
    if (wasPlaying && r.lastNoteAt !== null && t - r.lastNoteAt > FREEZE_MS) wakeRun(r);
    r.playing = !!st.playing;
    r.lastNoteAt = r.playing ? t : null;
    // Playback started again (Play, or Retry after an error): a pause still
    // waiting to go (an error's, never sent) is over. The next save is a play.
    if (r.playing && !wasPlaying && r.event === 'pause') r.event = 'play';
    let place = placeOf(st.position);
    // Smart rewind (a seek the engine marks { rewind }) is a playback aid: it
    // never moves the saved place back. From it until playback passes the
    // place it went back from, that place is what is saved (and kept
    // locally); a move of the listener's own (seek, skip, jump), another book
    // or a close ends the floor.
    const bookMs = Number(st.bookMs);
    if (change.rewind) {
      if (!r.floor && r.latest && isFinite(r.latestBookMs)) r.floor = { place: r.latest, bookMs: r.latestBookMs };
    } else if (r.floor && (MOVES[change.reason] || !(bookMs < r.floor.bookMs))) {
      r.floor = null;
    }
    if (r.floor && place) place = r.floor.place;
    // The engine reports a start more than once (asked, then playing): one
    // save. A rewind is not the listener's act: nothing to save for it.
    const ev = change.rewind || (change.reason === 'play' && wasPlaying) ? null : EVENTS[change.reason];
    if (place) {
      const moved = !samePlace(place, r.latest);
      // Reached by the listener: an act of theirs, or playback moving on.
      // Opening at a place (and the element settling there) is neither, and
      // nor is an error: the place it holds was reached by playback, if at all.
      const reached = (EVENTS[change.reason] && change.reason !== 'error' && !change.rewind) || (r.playing && moved);
      // The open's handoff question keeps this browser's own place in the
      // local copy until the listener acts.
      if (reached) r.keepLocal = false;
      if (moved && !r.keepLocal) {
        writeLocal(r.book, place, reached || r.reachedMono !== null);
      }
      if (moved) {
        if (r.dirtySince === null && !samePlace(place, r.acked)) r.dirtySince = t;
      }
      if (reached) {
        r.reachedMono = t;
        r.reachedWall = now();
      }
      r.latest = place;
      r.latestBookMs = r.floor ? r.floor.bookMs : bookMs;
    }
    // A change whose position is null is never saved.
    if (ev && place) {
      let name = ev[0];
      // A seek or jump while paused is not playback (Plex would show it playing).
      if ((name === 'seek' || name === 'jump') && !r.playing) name = 'pause';
      r.event = name;
      if (ev[1]) r.urgent = true;
    }
    step();
  }

  function start(book, opts) {
    stop();
    opts = opts || {};
    run = newRun(String(book));
    warning = false;
    lastBeacon = '';
    leftAt = '';
    const saved = timeOf(opts.savedAt);
    lastSavedAt = isFinite(saved) ? saved - skew : null;
    // The place the server already holds needs no save until it moves.
    run.acked = placeOf(opts.held);
    run.base = typeof opts.savedAt === 'string' && opts.savedAt ? opts.savedAt : null;
    run.keepLocal = !!opts.keepLocal;
    // A newer local copy the book opens at is sent at once: opening from it
    // counts as reaching it, so it obeys the same 2 minutes as any place.
    if (opts.push) {
      run.urgent = true;
      run.reachedMono = mono();
      run.reachedWall = now();
    }
  }

  function stop() {
    const r = run;
    if (!r) return;
    run = null;
    r.stopped = true;
    if (r.timer !== null) clearT(r.timer);
    r.timer = null;
    const was = warning;
    const savedAt = lastSavedAt;
    warning = false;
    lastSavedAt = null;
    // Listeners hear the warning end, not just stop being told about it.
    if (was) tell({ kind: 'not-saved', active: false, lastSavedAt: savedAt, message: '' });
    if (signedOut || r.conflict) return;
    // Its seq is taken now: every save of whatever opens next outranks it,
    // so the server never takes this place over a later one (a late final
    // from the same psid is refused).
    if (r.latest && sendable(r) && (r.playing || dirty(r))) {
      r.final = body(r.book, r.latest, r.event === 'end' ? 'end' : 'leave', r.base);
    } else if (r.inFlight && r.inFlight.event !== 'checkin') {
      // A pause or a move still in flight is the last word, unless it fails:
      // then this 'leave' of its place goes instead (Plex is told it stopped).
      r.fallback = body(r.book, r.inFlight.place, r.inFlight.event === 'end' ? 'end' : 'leave', r.base);
    }
    if (!r.final && !r.fallback) return;
    if (!r.inFlight) {
      sendFinal(r, false);
      return;
    }
    // One in flight at a time: the final save waits for it, as long as a
    // save may take.
    r.timer = setT(function () {
      r.timer = null;
      r.inFlight = null;
      sendFinal(r, true);
    }, Math.max(0, r.inFlight.from + POST_TIMEOUT_MS - mono()));
  }

  // failed: the save that was in flight did not get through.
  function sendFinal(r, failed) {
    const b = r.final || (failed ? r.fallback : null);
    r.final = null;
    r.fallback = null;
    if (r.timer !== null) clearT(r.timer);
    r.timer = null;
    if (!b || signedOut) return;
    try {
      Promise.resolve(post(b, 'fetch')).catch(noop);
    } catch (e) { /* the local copy has it */ }
  }

  function flush(kind, event) {
    const r = run;
    if (!r || r.stopped || signedOut || r.conflict || !r.latest || !sendable(r)) return false;
    if (kind === 'beacon') {
      let place = r.latest;
      if (!r.playing && !dirty(r)) {
        // A pause or a move still in flight: the page may not live to hear
        // its answer, so its place goes as the beacon.
        if (!r.inFlight || r.inFlight.event === 'checkin') return false;
        place = r.inFlight.place;
      }
      const at = r.book + '|' + place.track + '|' + place.offset_ms;
      // Leaving, Chrome fires pagehide and then visibilitychange: after the
      // leave, a hidden page's checkin would tell Plex it still plays.
      if (!event && at === leftAt) return false;
      const ev = r.event === 'end' ? 'end' : event || (r.playing ? 'checkin' : r.event || 'pause');
      const key = at + '|' + ev;
      if (key === lastBeacon) return false;
      lastBeacon = key;
      if (ev === 'leave') leftAt = at;
      try {
        post(body(r.book, place, ev, r.base), 'beacon');
      } catch (e) {
        return false;
      }
      return true;
    }
    if (!dirty(r)) return false;
    r.backoffUntil = 0;
    r.urgent = true;
    step();
    return true;
  }

  /* The listener answered a 409 (Continue, or Keep listening here): the
     place it showed is the one this page has now seen, so saves go again
     with its timestamp as the base. Returns the conflict, or null. */
  function resolveConflict() {
    const r = run;
    if (!r || !r.conflict) return null;
    const c = r.conflict;
    r.conflict = null;
    if (c.updated_at) r.base = c.updated_at;
    step();
    return { track: c.track, offset_ms: c.offset_ms, device: c.device, updated_at: c.updated_at };
  }

  function resumeFrom(book, copies) {
    const c = copies || {};
    return resumeOrder({ web: c.web, plex: c.plex, local: readLocal(book) });
  }

  return {
    start: start,
    stop: stop,
    note: note,
    flush: flush,
    wake: function () {
      wakeRun(run);
      if (run) step();
    },
    clockProbe: clockProbe,
    readLocal: readLocal,
    resumeFrom: resumeFrom,
    resolveConflict: resolveConflict,
    onWarning: function (fn) {
      if (typeof fn !== 'function') return noop;
      warnFns.add(fn);
      return function () { warnFns.delete(fn); };
    },
    get lastSavedAt() { return lastSavedAt; },
    get warning() { return warning; },
    get psid() { return psid; },
    get device() { return device; },
    get deviceId() { return deviceId; }
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/* A saver wired to the page. Its fetch and timers are the window's own,
   taken now (o overrides them, for tests). The listeners it adds live as
   long as the document, like the engine. */
export function browserSaver(win, o) {
  o = o || {};
  const nav = win.navigator || {};
  const doc = win.document || null;
  let storage = null;
  if (o.storage !== undefined) storage = o.storage;
  else {
    try { storage = win.localStorage || null; } catch (e) { storage = null; }
  }
  const fetchFn = o.fetch || (typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  const beacon = o.sendBeacon || (typeof nav.sendBeacon === 'function' ? nav.sendBeacon.bind(nav) : null);
  const BlobCtor = win.Blob || (typeof Blob !== 'undefined' ? Blob : null);

  function keepalive(json) {
    if (!fetchFn) return;
    try {
      Promise.resolve(fetchFn(CHECKIN_URL, {
        method: 'POST', keepalive: true, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: json
      })).catch(noop);
    } catch (e) { /* the local copy has it */ }
  }

  function post(b, kind) {
    const json = JSON.stringify(b);
    if (kind === 'beacon') {
      let queued = false;
      if (beacon && BlobCtor) {
        try {
          queued = !!beacon(CHECKIN_URL, new BlobCtor([json], { type: 'application/json' }));
        } catch (e) {
          queued = false;
        }
      }
      if (!queued) keepalive(json);
      return queued;
    }
    if (!fetchFn) return Promise.reject(new Error('no fetch'));
    const init = {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: json
    };
    try {
      const AS = win.AbortSignal;
      if (AS && typeof AS.timeout === 'function') init.signal = AS.timeout(POST_TIMEOUT_MS);
    } catch (e) { /* the saver gives up on it by itself */ }
    return Promise.resolve(fetchFn(CHECKIN_URL, init)).then(function (resp) {
      return Promise.resolve().then(function () { return resp.json(); }).then(
        function (data) { return { status: resp.status, data: data }; },
        function () { return { status: resp.status, data: null }; }
      );
    });
  }

  const saver = createSaver({
    post: post,
    now: o.now || Date.now,
    mono: o.mono || o.now || (win.performance && typeof win.performance.now === 'function'
      ? function () { return win.performance.now(); } : undefined),
    storage: storage,
    identity: function () {
      const u = win.WS && win.WS.user;
      const k = u && u.identity_key;
      return typeof k === 'string' && /^[0-9a-f]{16,64}$/.test(k) ? k : '';
    },
    device: deviceLabel(nav.userAgent || ''),
    deviceId: o.deviceId !== undefined ? o.deviceId : deviceIdFrom(storage),
    setTimeout: o.setTimeout || win.setTimeout.bind(win),
    clearTimeout: o.clearTimeout || win.clearTimeout.bind(win),
    // The session ended: the router's sign-in path (ws:before-hard-nav first).
    onSignedOut: function () {
      const WS = win.WS || {};
      if (typeof WS.leaveTo === 'function') WS.leaveTo('/login');
      else win.location.assign('/login');
    }
  });

  win.addEventListener('ws:before-hard-nav', function () { saver.flush('beacon', 'leave'); });
  win.addEventListener('pagehide', function () { saver.flush('beacon', 'leave'); });
  win.addEventListener('online', function () { saver.flush('fetch'); });
  // Back from frozen or hidden: that time does not count against a save.
  win.addEventListener('pageshow', function () { saver.wake(); });
  if (doc) {
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') saver.flush('beacon');
      else saver.wake();
    });
    doc.addEventListener('resume', function () { saver.wake(); });
  }
  return saver;
}

if (typeof window !== 'undefined' && window.document) {
  const WS = window.WS || (window.WS = {});
  WS.playerSaves = {
    createSaver: createSaver,
    browserSaver: browserSaver,
    resumeOrder: resumeOrder,
    resolveResume: resolveResume,
    deviceLabel: deviceLabel,
    deviceIdFrom: deviceIdFrom,
    isDeviceId: isDeviceId
  };
}
