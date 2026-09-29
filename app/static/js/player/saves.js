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
 * are saved at once. One save is
 * in flight per book: whatever happens meanwhile folds into one follow-up
 * with the place as it is then, and saves are at least 1 s apart. Every save
 * carries the current place and a fresh seq (never a stale body), under one
 * psid for the page session. A failure (a network error, no answer in 15 s,
 * any status but 2xx, 429 included) backs off 10, 20, then 30 s. A 401 means
 * the session ended: nothing more is sent, the local copy keeps the place,
 * and the listener is sent to sign in (shell.js WS.leaveTo, through the
 * router, so ws:before-hard-nav runs first).
 * Hard exits (ws:before-hard-nav, pagehide, the page hidden) send a beacon.
 *
 * Local copy: every change of place is written to localStorage under the
 * listener's account identity (WS.user.identity, from #ws-data) and the
 * book, stamped in the server's clock as last measured, so it compares
 * fairly with the server's copies from a fast or slow device. Storage can
 * throw (a private window): every call is guarded, and saves go on without.
 *
 * Warning: while playing, once saves have failed and the place has gone
 * unsaved for 30 s, onWarning gets { kind: 'not-saved', active: true,
 * lastSavedAt, message }; the next success sends active: false. A page that
 * is only hidden never warns: it takes a failure.
 *
 * Pure (importable by Node, no DOM at import time):
 *   deviceLabel(userAgent)            "<Browser> on <OS>", e.g. "Chrome on Android"
 *   resumeOrder({ web, plex, local }) every usable copy, newest first:
 *                                     [{ source, track, offset_ms, duration_ms, updated_at, device }]
 *   resolveResume({ web, plex, local }) the newest of them, or null
 *   createSaver(o)                    the saver, given its surroundings (tests)
 *   browserSaver(win, o)              a saver wired to the page (fetch, sendBeacon,
 *                                     localStorage, WS.user, pagehide and friends)
 *
 * createSaver({ post(body, kind) -> Promise<{ status, data }> | boolean (a beacon),
 *               now, storage, identity (string or function), device,
 *               setTimeout, clearTimeout, onSignedOut, formatTime, psid })
 *   start(book, { push, savedAt, held })
 *                                   push: the place the book opens at is newer
 *                                   than the server's (a local copy): send it at
 *                                   once. savedAt: the server's last save of it
 *                                   (ISO), "Last saved" until this page saves.
 *                                   held: { track, offset_ms } the server holds
 *                                   already (the book resumed from it).
 *   stop()                          saves the last place once (if it needs it),
 *                                   then no timers are left
 *   note(change)                    each engine change { reason, state }
 *   flush('beacon' | 'fetch', event) send now: a beacon, or a fetch past the backoff
 *   readLocal(book), resumeFrom(book, { web, plex }) -> resumeOrder with the local copy
 *   onWarning(fn) -> unsubscribe
 *   lastSavedAt (ms, this page's clock, or null), warning (bool), psid
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
export const NOT_SAVED = "Your place isn't being saved.";

const CHECKIN_URL = '/api/player/checkin';
const STORE_PREFIX = 'ws-player:';
const CLOCK_KEY = STORE_PREFIX + 'clock';
const DEVICE_MAX = 80;
const SKEW_MAX_MS = 7 * 24 * 3600 * 1000;

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
    return { source: x.source, track: x.track, offset_ms: x.offset_ms, duration_ms: x.duration_ms, updated_at: x.updated_at, device: x.device };
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
  let offset = Math.round(Number(p.offset_ms));
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

function clockTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

export function createSaver(o) {
  const post = o.post;
  const now = o.now || Date.now;
  const storage = o.storage || null;
  const identityOf = typeof o.identity === 'function' ? o.identity : function () { return o.identity; };
  const device = typeof o.device === 'string' ? o.device.slice(0, DEVICE_MAX) : '';
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

  // How far the server's clock is ahead of this one, as last measured.
  let skew = (function () {
    const v = Number(stored(function (s) { return s.getItem(CLOCK_KEY); }));
    return isFinite(v) && Math.abs(v) < SKEW_MAX_MS ? v : 0;
  })();

  function measureSkew(serverAt, sentAt) {
    const v = Math.round(serverAt - (sentAt + now()) / 2);
    if (!isFinite(v) || Math.abs(v) >= SKEW_MAX_MS) return;
    skew = v;
    stored(function (s) { s.setItem(CLOCK_KEY, String(v)); });
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
    return { track: c.track, offset_ms: c.offset_ms, duration_ms: c.duration_ms, updated_at: c.updated_at, device: c.device };
  }

  function writeLocal(book, place) {
    const id = identity();
    if (!id) return;
    const value = JSON.stringify({
      track: place.track,
      offset_ms: place.offset_ms,
      duration_ms: place.duration_ms,
      updated_at: new Date(now() + skew).toISOString(),
      device: device
    });
    stored(function (s) { s.setItem(localKey(id, book), value); });
  }

  // ---- A book being saved ----

  function newRun(book) {
    return {
      book: book,
      latest: null,           // the place, as last reported
      playing: false,
      event: null,            // what the next save is for, if not a plain checkin
      urgent: false,          // save as soon as the gap allows
      acked: null,            // the place the server last took
      dirtySince: null,       // when the place first differed from that
      lastSendAt: -Infinity,
      inFlight: null,         // { id, at, place, event }
      failures: 0,
      failedSinceOk: false,
      backoffUntil: 0,
      timer: null,
      timerAt: Infinity,
      stopped: false,
      final: null             // the save stop() still owes
    };
  }

  function dirty(r) {
    return !!r.latest && (r.event !== null || !samePlace(r.latest, r.acked));
  }

  function body(book, place, event) {
    seq += 1;
    return {
      book: book,
      track: place.track,
      offset_ms: place.offset_ms,
      duration_ms: place.duration_ms,
      event: event,
      device: device,
      psid: psid,
      seq: seq
    };
  }

  // When the next save is due: Infinity for none.
  function dueAt(r) {
    if (r.stopped || r.inFlight || signedOut || !dirty(r)) return Infinity;
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
    const at = now();
    r.inFlight = { id: id, at: at, place: place, event: event };
    r.lastSendAt = at;
    let p;
    try {
      p = Promise.resolve(post(body(r.book, place, event), 'fetch'));
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
        if (isFinite(at)) measureSkew(at, sent.at);
      }
      return true;
    }
    // Keep what the failed save was for (a pause, the end), unless something
    // newer has come since.
    if (r.event === null && sent.event !== 'checkin') r.event = sent.event;
    r.failures += 1;
    r.failedSinceOk = true;
    r.backoffUntil = now() + BACKOFF_MS[Math.min(r.failures, BACKOFF_MS.length) - 1];
    if (status === 401) signOut();
    return true;
  }

  function answered(r, id, res) {
    if (!settle(r, id, res)) return;
    if (r.stopped) {
      sendFinal(r);
      return;
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

  function step() {
    const r = run;
    if (!r || r.stopped) return;
    if (r.inFlight && now() - r.inFlight.at >= POST_TIMEOUT_MS) settle(r, r.inFlight.id, null);
    if (now() >= dueAt(r)) send(r);
    checkWarning();
    arm(r);
  }

  // One timer, for the next thing due. It is the fallback: in a background
  // tab it may not fire for a minute, and the engine's changes drive step().
  function arm(r) {
    let next = dueAt(r);
    if (r.inFlight) next = Math.min(next, r.inFlight.at + POST_TIMEOUT_MS);
    if (!warning && r.playing && r.failedSinceOk && r.dirtySince !== null) {
      next = Math.min(next, r.dirtySince + WARN_AFTER_MS);
    }
    if (next === r.timerAt) return;
    if (r.timer !== null) clearT(r.timer);
    r.timer = null;
    r.timerAt = next;
    if (next === Infinity) return;
    r.timer = setT(function () {
      r.timer = null;
      r.timerAt = Infinity;
      step();
    }, Math.max(0, next - now()));
  }

  // ---- The warning ----

  function message() {
    return lastSavedAt === null ? NOT_SAVED : NOT_SAVED + ' Last saved ' + formatTime(lastSavedAt) + '.';
  }

  function checkWarning() {
    const r = run;
    let on = warning;
    if (!r || r.stopped || !r.failedSinceOk) on = false;
    else if (!warning && r.playing && r.dirtySince !== null && now() - r.dirtySince >= WARN_AFTER_MS) on = true;
    if (on === warning) return;
    warning = on;
    const w = { kind: 'not-saved', active: on, lastSavedAt: lastSavedAt, message: on ? message() : '' };
    Array.from(warnFns).forEach(function (fn) {
      try {
        fn(w);
      } catch (e) {
        console.error('[player] a warning listener failed', e);
      }
    });
  }

  // ---- The engine's side ----

  function note(change) {
    const r = run;
    if (!r || r.stopped || !change || !change.state || change.state.book !== r.book) return;
    const st = change.state;
    const wasPlaying = r.playing;
    r.playing = !!st.playing;
    const place = placeOf(st.position);
    if (place) {
      if (!samePlace(place, r.latest)) {
        writeLocal(r.book, place);
        if (r.dirtySince === null && !samePlace(place, r.acked)) r.dirtySince = now();
      }
      r.latest = place;
    }
    // The engine reports a start more than once (asked, then playing): one save.
    const ev = change.reason === 'play' && wasPlaying ? null : EVENTS[change.reason];
    // A change whose position is null is never saved.
    if (ev && place) {
      r.event = ev[0];
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
    const saved = timeOf(opts.savedAt);
    lastSavedAt = isFinite(saved) ? saved - skew : null;
    // The place the server already holds needs no save until it moves.
    run.acked = placeOf(opts.held);
    if (opts.push) run.urgent = true;
  }

  function stop() {
    const r = run;
    if (!r) return;
    run = null;
    r.stopped = true;
    if (r.timer !== null) clearT(r.timer);
    r.timer = null;
    warning = false;
    lastSavedAt = null;
    if (signedOut || !r.latest || !(r.playing || dirty(r))) return;
    r.final = { event: r.event === 'end' ? 'end' : 'leave' };
    if (!r.inFlight) {
      sendFinal(r);
      return;
    }
    // One in flight at a time: the final save waits for it, as long as a
    // save may take.
    r.timer = setT(function () {
      r.timer = null;
      r.inFlight = null;
      sendFinal(r);
    }, Math.max(0, r.inFlight.at + POST_TIMEOUT_MS - now()));
  }

  function sendFinal(r) {
    if (!r.final) return;
    const f = r.final;
    r.final = null;
    if (r.timer !== null) clearT(r.timer);
    r.timer = null;
    if (signedOut) return;
    try {
      Promise.resolve(post(body(r.book, r.latest, f.event), 'fetch')).catch(noop);
    } catch (e) { /* the local copy has it */ }
  }

  function flush(kind, event) {
    const r = run;
    if (!r || r.stopped || signedOut || !r.latest) return false;
    if (kind === 'beacon') {
      if (!r.playing && !dirty(r)) return false;
      const ev = r.event === 'end' ? 'end' : event || (r.playing ? 'checkin' : r.event || 'pause');
      const key = r.book + '|' + r.latest.track + '|' + r.latest.offset_ms + '|' + ev;
      if (key === lastBeacon) return false;
      lastBeacon = key;
      try {
        post(body(r.book, r.latest, ev), 'beacon');
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

  function resumeFrom(book, copies) {
    const c = copies || {};
    return resumeOrder({ web: c.web, plex: c.plex, local: readLocal(book) });
  }

  return {
    start: start,
    stop: stop,
    note: note,
    flush: flush,
    readLocal: readLocal,
    resumeFrom: resumeFrom,
    onWarning: function (fn) {
      if (typeof fn !== 'function') return noop;
      warnFns.add(fn);
      return function () { warnFns.delete(fn); };
    },
    get lastSavedAt() { return lastSavedAt; },
    get warning() { return warning; },
    get psid() { return psid; }
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
    storage: storage,
    identity: function () {
      const u = win.WS && win.WS.user;
      return u && typeof u.identity === 'string' ? u.identity : '';
    },
    device: deviceLabel(nav.userAgent || ''),
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
  if (doc) {
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') saver.flush('beacon');
    });
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
    deviceLabel: deviceLabel
  };
}
