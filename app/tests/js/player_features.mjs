// The audiobook player's listening features (app/static/js/player/features.js):
// skip length, speed, the sleep timer, smart rewind, undo for big jumps and
// the keyboard shortcuts, run in happy-dom on top of the REAL engine
// (engine.js), its real saves (saves.js) and its real view (ui.js), against a
// scripted Plex: a fake <audio> element that loads, plays in 250 ms ticks and
// ends each part, fake /api/player endpoints and fake timers, so part
// advances, part formats the browser can't play and the saved pause are the
// engine's own.
//
// Imports each module as it is, through a data: URL like player_engine.mjs
// (which also proves none touches the DOM at import time).
// FEATURES_JS=<path> runs the same cases against another copy of features.js.
// Run: node app/tests/js/player_features.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(p, 'utf8')));
const FEATURES_PATH = process.env.FEATURES_JS || join(here, '../../static/js/player/features.js');
const F = await load(FEATURES_PATH);
const E = await load(join(here, '../../static/js/player/engine.js'));
const S = await load(join(here, '../../static/js/player/saves.js'));
const U = await load(join(here, '../../static/js/player/ui.js'));

let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${current}: ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}
const realError = console.error;
const consoleErrors = [];
console.error = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('FAIL ')) return realError(...a);
  consoleErrors.push(a.map(String).join(' '));
};

async function run(name, fn) {
  current = name;
  try {
    await fn();
  } catch (e) {
    failed += 1;
    total += 1;
    realError(`FAIL ${name}: threw ${e && e.stack ? e.stack : e}`);
  }
}

// ---- Fake timers: one clock for the engine, saves, view and features ----
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock() {
  let now = 0;
  let ids = 0;
  const due = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms) { const id = ++ids; due.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { due.delete(id); },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const [id, t] of due) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        now = next[1].at;
        due.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

// ---- The library ----

const REMOTE = 'https://198-51-100-7.abcdef.plex.direct:32400';
const MIN = 60000;
const MP3 = { container: 'mp3', codec: 'mp3', profile: '' };
const EAC3 = { container: 'mp4', codec: 'eac3', profile: 'dolby digital plus + dolby atmos' };
// Chapters are the parts: chapter 1 ends where part 1 does.
const MULTI = {
  key: '500:1', title: 'Three Parts', author: 'A. Writer', narrator: '', series: '', cover: '', shape: 'parts',
  tracks: [
    { key: '501', part_path: '/library/parts/901/1/file.mp3', duration_ms: 600000, index: 1, ...MP3 },
    { key: '502', part_path: '/library/parts/902/1/file.mp3', duration_ms: 900000, index: 2, ...MP3 },
    { key: '503', part_path: '/library/parts/903/1/file.mp3', duration_ms: 300000, index: 3, ...MP3 }
  ],
  chapters: [
    { index: 1, label: 'Part 1 of 3', start_ms: 0, end_ms: 600000 },
    { index: 2, label: 'Part 2 of 3', start_ms: 600000, end_ms: 1500000 },
    { index: 3, label: 'Part 3 of 3', start_ms: 1500000, end_ms: 1800000 }
  ]
};
// A chapter that runs across the boundary between two parts.
const SPAN = {
  key: '510:1', title: 'Spanning', author: 'B. Writer', narrator: '', series: '', cover: '', shape: 'parts',
  tracks: [
    { key: '511', part_path: '/library/parts/911/1/file.mp3', duration_ms: 300000, index: 1, ...MP3 },
    { key: '512', part_path: '/library/parts/912/1/file.mp3', duration_ms: 300000, index: 2, ...MP3 }
  ],
  chapters: [
    { index: 1, label: 'One', start_ms: 0, end_ms: 200000 },
    { index: 2, label: 'Two', start_ms: 200000, end_ms: 500000 },
    { index: 3, label: 'Three', start_ms: 500000, end_ms: 600000 }
  ]
};
// The middle part is a format this browser can't decode (a short one).
const MIXED = {
  key: '520:1', title: 'Mixed', author: 'C. Writer', narrator: '', series: '', cover: '', shape: 'parts',
  tracks: [
    { key: '521', part_path: '/library/parts/921/1/file.mp3', duration_ms: 600000, index: 1, ...MP3 },
    { key: '522', part_path: '/library/parts/922/1/file.m4b', duration_ms: 20000, index: 2, ...EAC3 },
    { key: '523', part_path: '/library/parts/923/1/file.mp3', duration_ms: 300000, index: 3, ...MP3 }
  ],
  chapters: []
};
// Seventeen hours in one file, for the long timers.
const LONG_MS = 17 * 3600000;
const LONG = {
  key: '530:1', title: 'Long', author: 'D. Writer', narrator: '', series: '', cover: '', shape: 'single',
  tracks: [{ key: '531', part_path: '/library/parts/931/1/file.m4b', duration_ms: LONG_MS, index: 1, container: 'mp4', codec: 'aac', profile: 'lc' }],
  chapters: [
    { index: 1, label: 'Opening', start_ms: 0, end_ms: 36000000 },
    { index: 2, label: 'The rest', start_ms: 36000000, end_ms: LONG_MS }
  ]
};
const BOOKS = { [MULTI.key]: MULTI, [SPAN.key]: SPAN, [MIXED.key]: MIXED, [LONG.key]: LONG };
const trackByPath = new Map();
for (const b of Object.values(BOOKS)) for (const t of b.tracks) trackByPath.set(t.part_path, t);
const UNDECODABLE = new Set(['', 'audio/mp4; codecs="ec-3"']);

// A media element as far as the engine uses it (after player_engine.mjs's):
// a new src resets it; loads answer after 50 ms; playback moves 250 ms per
// 250 ms tick at 1x; the end of a part fires timeupdate, pause, ended.
class FakeAudio {
  constructor(t) {
    this.t = t;
    this.ls = new Map();
    this.attrs = new Map();
    this._src = '';
    this._t = 0;
    this.paused = true;
    this.ended = false;
    this.duration = NaN;
    this.error = null;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.readyState = 0;
    this.seeking = false;
    this.preload = 'auto';
    this.muted = false;
    this.volume = 1;
    this.gen = 0;
    this.ticking = false;
    this.onloadedmetadata = null;
    this.onerror = null;
  }
  canPlayType(mime) { return UNDECODABLE.has(mime) ? '' : 'probably'; }
  addEventListener(n, fn) { if (!this.ls.has(n)) this.ls.set(n, []); this.ls.get(n).push(fn); }
  removeEventListener(n, fn) { const a = this.ls.get(n); if (a && a.indexOf(fn) !== -1) a.splice(a.indexOf(fn), 1); }
  fire(n) {
    for (const fn of (this.ls.get(n) || []).slice()) fn.call(this, { type: n, target: this });
    const h = this['on' + n];
    if (typeof h === 'function') h.call(this, { type: n, target: this });
  }
  setAttribute(n, v) { if (n === 'src') this.src = v; else this.attrs.set(n, String(v)); }
  getAttribute(n) { return n === 'src' ? (this._src || null) : (this.attrs.has(n) ? this.attrs.get(n) : null); }
  removeAttribute(n) { if (n === 'src') this._src = ''; else this.attrs.delete(n); }
  get src() { return this._src; }
  set src(v) { this._src = String(v); this.select(); }
  load() { this.select(); }
  get currentTime() { return this._t; }
  set currentTime(v) {
    const d = isFinite(this.duration) ? this.duration : Infinity;
    this._t = Math.max(0, Math.min(Number(v), d));
    this.ended = false;
    if (this.readyState < 1) return;
    this.seeking = true;
    const g = this.gen;
    this.t.clock.setTimeout(() => {
      if (g !== this.gen) return;
      this.seeking = false;
      this.fire('timeupdate');
      this.fire('seeked');
    }, 10);
  }
  select() {
    const g = ++this.gen;
    this.error = null;
    this.ended = false;
    this.readyState = 0;
    this.duration = NaN;
    this.seeking = false;
    this.ticking = false;
    this.paused = true;
    this._t = 0;
    this.fire('emptied');
    if (!this._src) return;
    const path = new URL(this._src).pathname;
    this.part = path;
    const track = trackByPath.get(path);
    this.t.loads.push(path);
    this.t.clock.setTimeout(() => {
      if (g !== this.gen) return;
      if (!track || this.t.down) { this.error = { code: 4 }; this.fire('error'); return; }
      this.duration = track.duration_ms / 1000;
      this.readyState = 1;
      this.fire('loadedmetadata');
      if (g !== this.gen) return;
      // t.bufferMs: a slow stream, playable only that much later.
      const ready = () => {
        if (g !== this.gen) return;
        this.readyState = 4;
        this.fire('canplay');
        if (!this.paused) this.begin();
      };
      if (this.t.bufferMs) this.t.clock.setTimeout(ready, this.t.bufferMs);
      else ready();
    }, 50);
  }
  play() {
    if (this.t.blockAutoplay) {
      const e = new Error('play() needs a user gesture');
      e.name = 'NotAllowedError';
      return Promise.reject(e);
    }
    if (this.paused) {
      if (this.ended) { this._t = 0; this.ended = false; }
      this.paused = false;
      this.fire('play');
      if (this.readyState >= 3) this.begin();
      else if (this._src) this.fire('waiting');
    }
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.ticking = false;
    this.fire('pause');
  }
  begin() {
    if (this.paused || this.ticking) return;
    this.ticking = true;
    this.fire('playing');
    this.tick(this.gen);
  }
  tick(g) {
    this.t.clock.setTimeout(() => {
      if (g !== this.gen || this.paused || !this.ticking) return;
      if (this.seeking) { this.tick(g); return; }
      this._t = Math.min(this.duration, this._t + 0.25 * this.playbackRate);
      this.fire('timeupdate');
      if (this._t >= this.duration) {
        this.ticking = false;
        this.paused = true;
        this.ended = true;
        this.fire('pause');
        this.fire('ended');
        return;
      }
      this.tick(g);
    }, 250);
  }
}

const NOW0 = Date.UTC(2026, 8, 29, 18, 0, 0);
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });

// localStorage as far as the saves use it.
function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

/* The check-in server as app/services/listening.save_checkin keeps it
   (spec 11b): per book one row; the same psid's older seq is refused (200,
   stored false); the same page session (psid) or a base equal to the row's
   timestamp stores (a device id alone does not: another tab of the same
   browser is another page session); anything else is 409 with the row. A
   beacon gets the same rule and no answer. `down`: every check-in fails (the
   network). Shared by the pages of several "devices" on one clock. */
function casServer(clock) {
  const srv = { rows: {}, log: [], down: false };
  srv.at = () => new Date(NOW0 + clock.now).toISOString();
  srv.web = (book) => {
    const r = srv.rows[book];
    return r ? { track: r.track, offset_ms: r.offset_ms, duration_ms: r.duration_ms, updated_at: r.updated_at, device: r.device, device_id: r.device_id || null, psid: r.psid } : null;
  };
  srv.store = (b, kind) => {
    const row = srv.rows[b.book];
    const entry = { kind, event: b.event, track: b.track, offset_ms: b.offset_ms, psid: b.psid, device_id: b.device_id, base: b.base, t: clock.now };
    if (row && row.psid === b.psid && row.seq > b.seq) {
      srv.log.push(Object.assign(entry, { result: 'stale' }));
      return { status: 200, data: { stored: false, updated_at: row.updated_at } };
    }
    const same = !!row && row.psid === b.psid;
    if (row && !same && b.base !== row.updated_at) {
      srv.log.push(Object.assign(entry, { result: 'conflict' }));
      return { status: 409, data: { conflict: { track: row.track, offset_ms: row.offset_ms, device: row.device, updated_at: row.updated_at }, now: srv.at() } };
    }
    const at = srv.at();
    srv.rows[b.book] = { track: b.track, offset_ms: b.offset_ms, duration_ms: b.duration_ms, updated_at: at, device: b.device, device_id: b.device_id || null, psid: b.psid, seq: b.seq };
    srv.log.push(Object.assign(entry, { result: 'stored' }));
    return { status: 200, data: { stored: true, updated_at: at } };
  };
  return srv;
}

/* One page: the real engine, saves, view and features. o: { path, prefs
   (the GET's answer; a number is its status), places ({ web } for the
   resume), wide, noFeatures, storage and identity (the local copy),
   deviceId (this browser's id), and for two devices on one server: clock
   (shared), server (casServer), psid, device (the label) }. */
async function setup(o = {}) {
  const win = new Window({ url: 'https://ws.test' + (o.path || '/news') });
  const doc = win.document;
  doc.body.innerHTML = '<main><h1>News</h1><button id="pageBtn" type="button">Page</button>' +
    '<input id="field" type="text"><input id="box" type="checkbox"><textarea id="area"></textarea>' +
    '<select id="sel"><option>a</option></select><div id="editor" contenteditable="true"><p id="para">x</p></div>' +
    '<div id="tabs" role="tab" tabindex="0">Tab</div></main><div id="wsPlayer" hidden></div>';
  const clock = o.clock || fakeClock();
  const t = { win, doc, clock, loads: [], posts: [], fetches: [], puts: [], path: o.path || '/news', server: o.server || null };
  t.now = () => NOW0 + clock.now;
  // The server's clock: o.skewMs ahead of this device's (negative: behind).
  t.skew = o.skewMs || 0;
  t.serverNow = () => t.now() + t.skew;
  t.remote = o.remote || [REMOTE];
  t.putStatus = 200;
  t.putDelays = [];
  t.putStatuses = [];
  t.serverPrefs = {};
  t.noNow = false;
  t.prefsAnswer = o.prefs === undefined ? { skip_s: 10, speed: 1, smart_rewind: true } : o.prefs;
  t.places = o.places || { web: null, plex: null };
  // History pages by their cursor ('' the first); the next book per book.
  t.history = {};
  t.nextBooks = {};
  t.positionCalls = 0;
  t.positionMode = 'ok';      // 'down' (a network error) or 'hang' (never answers)
  async function fetchFn(url, init) {
    init = init || {};
    t.fetches.push({ url, method: init.method || 'GET', body: init.body, keepalive: !!init.keepalive });
    if (url === '/api/player/prefs') {
      if ((init.method || 'GET') === 'PUT') {
        const body = JSON.parse(init.body);
        t.puts.push(body);
        // t.putDelays: how long each PUT in turn takes; the server applies it
        // when it gets to it (t.serverPrefs), so PUTs can land out of order.
        const wait = t.putDelays.length ? t.putDelays.shift() : 0;
        if (wait) await new Promise((r) => clock.setTimeout(r, wait));
        const status = t.putStatuses.length ? t.putStatuses.shift() : t.putStatus;
        if (status === 0) throw new TypeError('Failed to fetch');
        if (status >= 200 && status < 300) Object.assign(t.serverPrefs, body);
        return response(status, {});
      }
      if (typeof t.prefsAnswer === 'number') return response(t.prefsAnswer, { detail: 'no' });
      return response(200, t.prefsAnswer);
    }
    let m = /^\/api\/player\/book\/([^?]+)/.exec(url);
    if (m) {
      const b = BOOKS[decodeURIComponent(m[1])];
      if (!b) return response(404, { detail: 'Not in the audiobook library' });
      return response(200, { ...b, stream: { token: 'tok', uris: { local: [], remote: t.remote } } });
    }
    m = /^\/api\/player\/history\/([^?]+)(?:\?before=(.+))?$/.exec(url);
    if (m) {
      const page = t.history[m[2] ? decodeURIComponent(m[2]) : ''];
      if (page === 'fail') return response(503, { detail: 'Plex is unavailable right now.' });
      return response(200, page || { entries: [], next_before: null });
    }
    m = /^\/api\/player\/next\/(.+)$/.exec(url);
    if (m) {
      const k = decodeURIComponent(m[1]);
      return response(200, { next: t.nextBooks[k] || null });
    }
    m = /^\/api\/player\/position\/(.+)$/.exec(url);
    if (m) {
      t.positionCalls += 1;
      if (t.positionMode === 'down') throw new TypeError('Failed to fetch');
      if (t.positionMode === 'hang') return new Promise(() => {});
      // t.positionStatus: the read refused with that status.
      if (t.positionStatus) return response(t.positionStatus, { detail: 'no' });
      // t.positionDelay: a slow read, answered that much later.
      if (t.positionDelay) await new Promise((r) => clock.setTimeout(r, t.positionDelay));
      const reply = t.server
        ? { web: t.server.web(decodeURIComponent(m[1])), plex: t.plexCopy || null }
        : { web: t.places.web, plex: t.places.plex || null };
      if (!t.noNow) reply.now = new Date(t.serverNow()).toISOString();
      // t.plexError: the server could not read Plex (plex null, plex_error true).
      if (t.plexError) { reply.plex = null; reply.plex_error = true; }
      return response(200, reply);
    }
    return response(404, {});
  }
  t.fetch = fetchFn;
  const saver = S.createSaver({
    post: (body, kind) => {
      t.posts.push(body);
      if (t.server) {
        if (t.server.down || t.offline) return kind === 'beacon' ? false : Promise.reject(new TypeError('Failed to fetch'));
        // t.hold: the server takes it, the answer never comes back (a page
        // killed, a network gone after sending).
        if (kind !== 'beacon' && t.hold) {
          t.server.store(body, kind);
          return new Promise(() => {});
        }
        // t.postDelay: the round trip, the server answering at its end.
        if (kind !== 'beacon' && t.postDelay) {
          return new Promise((res) => clock.setTimeout(() => res(t.server.store(body, kind)), t.postDelay));
        }
        const res = t.server.store(body, kind);
        return kind === 'beacon' ? true : Promise.resolve(res);
      }
      const at = new Date(t.serverNow()).toISOString();
      // o.stateful: the server keeps what it is sent, as WebServarr's copy.
      // Plex's copy of a stored save is an echo of it: GET /position leaves it out.
      if (o.stateful) t.places = { web: { track: body.track, offset_ms: body.offset_ms, duration_ms: body.duration_ms, updated_at: at, device: 'Test on Linux', device_id: body.device_id || null, psid: body.psid }, plex: null };
      return Promise.resolve({ status: 200, data: { stored: true, updated_at: at } });
    },
    now: t.now,
    mono: () => clock.now,
    storage: o.storage || null,
    identity: o.identity || '',
    device: o.device || 'Test on Linux',
    deviceId: o.deviceId,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    psid: o.psid || 'test-psid',
    onSignedOut: () => { t.signedOut += 1; }
  });
  t.signedOut = 0;
  t.saver = saver;
  const ms = {
    metadata: null, playbackState: 'none', handlers: new Map(),
    setActionHandler(a, fn) { this.handlers.set(a, fn); }, setPositionState() {}
  };
  t.ms = ms;
  const host = doc.getElementById('wsPlayer');
  // The engine's element is the fake one, kept aside (it is no DOM node).
  // o.wall: the engine's wall clock is this clock (plus t.wallExtra, time a
  // device spent asleep: its timers stood still); else the real Date.now.
  t.wallExtra = 0;
  t.engine = E.createEngine({
    now: o.wall ? () => t.now() + t.wallExtra : undefined,
    host: { appendChild(el) { t.audioEl = el; return el; } },
    createAudio: () => new FakeAudio(t),
    fetch: fetchFn,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    mediaSession: ms,
    MediaMetadata: class { constructor(i) { Object.assign(this, i); } },
    baseUrl: 'https://ws.test/news',
    saver
  });
  t.env = { wide: !!o.wide, dialog: false };
  const matchMedia = (q) => ({
    get matches() { return q.indexOf('min-width') !== -1 ? t.env.wide : false; },
    addEventListener() {}
  });
  t.ui = U.createUI({
    doc, host, player: t.engine, matchMedia,
    measure: () => 72,
    isVisible: (el) => !el.closest('[hidden]'),
    now: t.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ResizeObserver: null,
    isDialogOpen: () => t.env.dialog,
    leaveTo: () => {},
    win,
    CloseWatcher: null,
    hasActivation: () => true
  });
  // t.asleepMs: time a device spent asleep, as the features' wall clock
  // sees it (their timers stood still).
  t.asleepMs = 0;
  if (!o.noFeatures) {
    t.features = F.createFeatures({
      player: t.engine, ui: t.ui, doc, win, fetch: fetchFn,
      now: () => t.now() + t.asleepMs, mono: () => clock.now,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      matchMedia,
      isDialogOpen: () => t.env.dialog,
      pathname: () => t.path,
      tourActive: () => { const l = doc.getElementById('tourLayer'); return !!l && !l.classList.contains('hidden'); }
    });
  }
  await clock.advance(10);
  t.q = (sel) => doc.querySelector(sel);
  t.qa = (sel) => Array.from(doc.querySelectorAll(sel));
  t.st = () => t.engine.state();
  t.key = (target, k, extra = {}) => {
    const ev = new win.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra));
    target.dispatchEvent(ev);
    return ev;
  };
  t.notices = () => t.qa('.wsp-notice .wsp-notice-text').map((n) => n.textContent);
  t.undoBtn = () => t.qa('.wsp-notice-btn').find((b) => b.textContent === 'Undo') || null;
  t.label = (slot) => { const l = t.q(`.wsp-slot-${slot} .wsp-action-label`); return l ? l.textContent : null; };
  t.vol = () => t.audioEl.volume;
  // Plays from `ms` into the book (book ms), until it is playing.
  t.openAt = async (key, track, offset, extra = {}) => {
    const p = t.engine.open(key, Object.assign({ at: { track, offset_ms: offset } }, extra));
    await clock.advance(200);
    await p;
  };
  return t;
}

const bookMs = (t) => t.st().bookMs;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

await run('smart rewind thresholds at their exact edges', () => {
  const cases = [
    [0, 0], [9999, 0], [10000, 3000], [59999, 3000], [60000, 10000],
    [3599999, 10000], [3600000, 30000], [86400000, 30000], [-5, 0], [NaN, 0], [undefined, 0]
  ];
  for (const [away, want] of cases) check(`rewindFor(${away})`, F.rewindFor(away) === want, F.rewindFor(away));
});

await run('the rewind target: the book start, the part before, never a part that cannot play', () => {
  const parts = [
    { start_ms: 0, duration_ms: 600000, playable: true },
    { start_ms: 600000, duration_ms: 20000, playable: false },
    { start_ms: 620000, duration_ms: 300000, playable: true }
  ];
  check('clamped at the start', F.rewindTarget(parts, 2000, 30000) === 0);
  check('within a part', F.rewindTarget(parts, 100000, 10000) === 90000);
  check('back over a blocked part: the start of the part after it', F.rewindTarget(parts, 625000, 30000) === 620000);
  check('into a blocked part: the same', F.rewindTarget(parts, 630000, 20000) === 620000);
  check('from a blocked part: no move', F.rewindTarget(parts, 610000, 3000) === null);
  check('already at the start of what can play: no move', F.rewindTarget(parts, 620000, 30000) === null);
  check('at the book start: no move', F.rewindTarget(parts, 0, 30000) === null);
  check('no rewind asked: no move', F.rewindTarget(parts, 5000, 0) === null);
  const plain = [{ start_ms: 0, duration_ms: 300000, playable: true }, { start_ms: 300000, duration_ms: 300000, playable: true }];
  check('into the playable part before', F.rewindTarget(plain, 302000, 30000) === 272000);
});

await run('speed steps and labels', () => {
  check('up 0.05', F.stepSpeed(1, 1) === 1.05);
  check('down 0.05', F.stepSpeed(1.05, -1) === 1);
  check('clamped at 2', F.stepSpeed(2, 1) === 2);
  check('clamped at 0.75', F.stepSpeed(0.75, -1) === 0.75);
  check('no float drift', F.stepSpeed(1.1, 1) === 1.15 && F.stepSpeed(1.15, 1) === 1.2, [F.stepSpeed(1.1, 1), F.stepSpeed(1.15, 1)]);
  check('labels', F.formatSpeed(1) === '1×' && F.formatSpeed(1.25) === '1.25×' && F.formatSpeed(0.75) === '0.75×');
});

await run('jump and countdown text', () => {
  check('2 min', F.formatDelta(125000) === '2 min', F.formatDelta(125000));
  check('1 h 5 min', F.formatDelta(3900000) === '1 h 5 min');
  check('2 h', F.formatDelta(7200000) === '2 h');
  check('ahead', F.jumpMessage(0, 12 * MIN) === 'Jumped ahead 12 min.', F.jumpMessage(0, 12 * MIN));
  check('back', F.jumpMessage(12 * MIN, 0) === 'Jumped back 12 min.');
  check('15:00', F.formatCountdown(15 * MIN) === '15:00');
  check('rounds up', F.formatCountdown(1) === '0:01' && F.formatCountdown(59001) === '1:00');
  check('an hour', F.formatCountdown(60 * MIN) === '1:00:00');
  const st = { book: 'b', chapters: MULTI.chapters, chapterIndex: 1, bookDurationMs: 1800000 };
  check('the chapter end', F.chapterEnd(st) === 1500000);
  check('no chapters: none', F.chapterEnd({ book: 'b', chapters: [], chapterIndex: -1 }) === null);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

await run('settings load once, and reach the engine and the view while paused', async () => {
  const t = await setup({ prefs: { skip_s: 30, speed: 1.5, smart_rewind: false } });
  await t.openAt(MULTI.key, '502', 300000, { autoplay: false });
  const gets = t.fetches.filter((f) => f.url === '/api/player/prefs' && f.method === 'GET');
  check('one GET', gets.length === 1, gets.length);
  check('the engine has them', t.engine.setSkip() === 30 && t.st().speed === 1.5, [t.engine.setSkip(), t.st().speed]);
  check('paused', !t.st().playing);
  const back = t.qa('.wsp-skip-n').map((n) => n.textContent);
  check('the skip buttons say 30', back.join(',') === '30,30', back);
  check('the speed button says 1.5×', t.q('.wsp-slot-speed .wsp-action-text').textContent === '1.5×');
  check('smart rewind shown off', t.q('.wsp-switch').getAttribute('aria-checked') === 'false');
  const b0 = bookMs(t);
  t.ms.handlers.get('seekbackward')({ action: 'seekbackward' });
  check('the lock screen skips 30', bookMs(t) === b0 - 30000, bookMs(t) - b0);
  t.engine.close();
});

await run('the engine reports a prefs change and applies only numbers', async () => {
  const t = await setup({ noFeatures: true });
  const reasons = [];
  t.engine.on('change', (d) => reasons.push(d.reason));
  check('a new skip length is a prefs change', t.engine.setSkip(20) === 20 && reasons.pop() === 'prefs');
  const n = reasons.length;
  t.engine.setSkip(20);
  t.engine.setSkip();
  check('the same one, or a read, is none', reasons.length === n);
  const got = t.engine.applyPrefs({ skip: 45, speed: 1.25 });
  check('applyPrefs sets both, then one prefs change', got.skip === 45 && got.speed === 1.25 && reasons[reasons.length - 1] === 'prefs' && reasons.length === n + 1);
  t.engine.applyPrefs({ skip: '30', speed: null });
  check('strings and null change nothing', t.engine.setSkip() === 45 && t.st().speed === 1.25, [t.engine.setSkip(), t.st().speed]);
  check('setVolume clamps and reads', t.engine.setVolume(2) === 1 && t.engine.setVolume(0.25) === 0.25 && t.engine.setVolume() === 0.25 && t.engine.setVolume('x') === 0.25);
  check('parts() with no book is empty', Array.isArray(t.engine.parts()) && t.engine.parts().length === 0);
  await t.openAt(MIXED.key, '521', 1000, { autoplay: false });
  const parts = t.engine.parts();
  check('parts() in book time with what can play', JSON.stringify(parts) === JSON.stringify([
    { start_ms: 0, duration_ms: 600000, playable: true },
    { start_ms: 600000, duration_ms: 20000, playable: false },
    { start_ms: 620000, duration_ms: 300000, playable: true }
  ]), parts);
  t.engine.close();
});

for (const status of [401, 403, 404]) {
  await run(`settings answered ${status}: the defaults, no error, no second try`, async () => {
    const t = await setup({ prefs: status });
    check('defaults', t.engine.setSkip() === 10 && t.st().speed === 1 && t.features.prefs().smart_rewind === true);
    await t.openAt(MULTI.key, '501', 1000);
    check('no notice', t.notices().length === 0, t.notices());
    check('nothing logged', consoleErrors.length === 0, consoleErrors.splice(0));
    const gets = t.fetches.filter((f) => f.url === '/api/player/prefs' && f.method === 'GET');
    check('asked once', gets.length === 1, gets.length);
    t.engine.close();
  });
}

await run('settings that could not be read are asked again when a book opens', async () => {
  const t = await setup({ prefs: 503 });
  check('defaults meanwhile', t.engine.setSkip() === 10);
  const gets = () => t.fetches.filter((f) => f.url === '/api/player/prefs' && f.method === 'GET').length;
  // Read when the book starts loading (503), and again when it has opened.
  await t.openAt(MULTI.key, '501', 1000);
  check('read at the load, asked again at the open', gets() === 2, gets());
  t.engine.close();
  t.prefsAnswer = { skip_s: 15, speed: 1, smart_rewind: true };
  await t.openAt(MULTI.key, '501', 1000);
  check('asked again at the next open', gets() === 3, gets());
  check('and applied', t.engine.setSkip() === 15);
  check('no notice', t.notices().length === 0);
  t.engine.close();
});

// Final review F3: the settings are read when the first book starts
// loading, not at boot: a page where nobody plays (and a site with the
// player off, where every such read would be a 404) never asks.
await run('the settings are read at the first book, never at boot', async () => {
  const t = await setup({ prefs: { skip_s: 30, speed: 1.5, smart_rewind: false } });
  const gets = () => t.fetches.filter((f) => f.url === '/api/player/prefs' && f.method === 'GET').length;
  await t.clock.advance(60000);
  check('no read while nothing plays', gets() === 0, gets());
  check('the defaults meanwhile', t.engine.setSkip() === 10 && t.st().speed === 1);
  const p = t.engine.open(MULTI.key, { at: { track: '501', offset_ms: 1000 } });
  check('read as the book starts loading', gets() === 1, gets());
  await t.clock.advance(200);
  await p;
  check('applied', t.engine.setSkip() === 30 && t.st().speed === 1.5, [t.engine.setSkip(), t.st().speed]);
  t.engine.close();
  await t.openAt(MULTI.key, '502', 1000);
  check('read once only', gets() === 1, gets());
  t.engine.close();
});

await run('changes are sent a moment later, only what changed, and at once on leaving', async () => {
  const t = await setup({ prefs: 503 });
  await t.openAt(MULTI.key, '501', 1000);
  t.q('.wsp-slot-menu button').click();
  t.q('[data-skip="30"]').click();
  t.q('[data-skip="45"]').click();
  await t.clock.advance(700);
  check('nothing yet', t.puts.length === 0);
  await t.clock.advance(200);
  check('one PUT with only the skip', t.puts.length === 1 && JSON.stringify(t.puts[0]) === '{"skip_s":45}', t.puts);
  t.q('.wsp-switch').click();
  check('the switch says off', t.q('.wsp-switch').getAttribute('aria-checked') === 'false');
  t.win.dispatchEvent(new t.win.Event('pagehide'));
  const last = t.fetches[t.fetches.length - 1];
  check('sent at once on leaving, keepalive', t.puts.length === 2 && JSON.stringify(t.puts[1]) === '{"smart_rewind":false}' && last.keepalive, t.puts);
  // A late read never undoes what the listener changed here.
  t.prefsAnswer = { skip_s: 10, speed: 1, smart_rewind: true };
  t.engine.close();
  await t.openAt(MULTI.key, '501', 1000);
  check('kept', t.engine.setSkip() === 45 && t.features.prefs().smart_rewind === false, t.features.prefs());
  t.engine.close();
});

await run('a settings save that fails is kept, and goes again with the next change and on leaving', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '501', 1000);
  t.q('.wsp-slot-menu button').click();
  t.putStatus = 503;
  t.q('[data-skip="30"]').click();
  await t.clock.advance(900);
  check('tried', t.puts.length === 1 && JSON.stringify(t.puts[0]) === '{"skip_s":30}', t.puts);
  t.putStatus = 0;                    // the network is gone
  t.q('.wsp-switch').click();
  await t.clock.advance(900);
  check('the next change sends both', t.puts.length === 2 && JSON.stringify(t.puts[1]) === '{"skip_s":30,"smart_rewind":false}', t.puts);
  t.putStatus = 429;
  t.win.dispatchEvent(new t.win.Event('pagehide'));
  await t.clock.advance(10);
  check('leaving sends both again', t.puts.length === 3 && JSON.stringify(t.puts[2]) === '{"skip_s":30,"smart_rewind":false}', t.puts);
  t.putStatus = 200;
  t.win.dispatchEvent(new t.win.Event('pagehide'));
  await t.clock.advance(10);
  check('and once taken', t.puts.length === 4 && JSON.stringify(t.puts[3]) === '{"skip_s":30,"smart_rewind":false}', t.puts);
  t.win.dispatchEvent(new t.win.Event('pagehide'));
  await t.clock.advance(10);
  check('nothing is left to send', t.puts.length === 4, t.puts);
  t.q('[data-skip="45"]').click();
  await t.clock.advance(900);
  check('a later change sends only itself', JSON.stringify(t.puts[4]) === '{"skip_s":45}', t.puts);
  t.engine.close();
});

await run('one settings save at a time: a slow one is never overtaken', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '501', 1000);
  t.putDelays = [3000];
  t.q('.wsp-slot-speed button').click();
  t.q('[data-speed="1.25"]').click();
  await t.clock.advance(1000);         // the first save is out, and slow
  t.q('[data-speed="1.5"]').click();
  await t.clock.advance(1000);         // its debounce is over: it waits
  check('one in flight', t.puts.length === 1, t.puts);
  await t.clock.advance(3000);
  check('sent when the first returned, the latest', t.puts.length === 2 && JSON.stringify(t.puts[1]) === '{"speed":1.5}', t.puts);
  check('the server ends with the latest', t.serverPrefs.speed === 1.5, t.serverPrefs);
  t.engine.close();
});

for (const [fail, what] of [[503, 'a 503'], [0, 'the network']]) await run(`a save queued behind one that fails (${what}) still goes`, async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '501', 1000);
  t.putDelays = [3000];
  t.putStatuses = [fail];
  t.q('.wsp-slot-speed button').click();
  t.q('[data-speed="1.25"]').click();
  await t.clock.advance(1000);
  t.q('[data-speed="1.5"]').click();
  await t.clock.advance(5000);
  check('sent after the failure returned', t.puts.length === 2 && JSON.stringify(t.puts[1]) === '{"speed":1.5}', t.puts);
  check('the server has it', t.serverPrefs.speed === 1.5, t.serverPrefs);
  t.engine.close();
});

await run('the leave save counts as in flight: a race with it never loses the newest', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '501', 1000);
  t.putDelays = [3000, 0];
  t.q('.wsp-slot-speed button').click();
  t.q('[data-speed="1.25"]').click();
  await t.clock.advance(1000);         // 1.25 is out, and slow
  t.q('[data-speed="1.5"]').click();
  t.win.dispatchEvent(new t.win.Event('pagehide'));
  await t.clock.advance(10);
  check('the leave went at once', t.puts.length === 2 && JSON.stringify(t.puts[1]) === '{"speed":1.5}', t.puts);
  await t.clock.advance(4000);
  check('the slow one landed last, then the newest went again', t.puts.length === 3 && JSON.stringify(t.puts[2]) === '{"speed":1.5}', t.puts);
  check('the server ends with the newest', t.serverPrefs.speed === 1.5, t.serverPrefs);
  t.engine.close();
});

await run('back from the back-forward cache, a leave that failed is sent again', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '501', 1000);
  t.q('.wsp-slot-speed button').click();
  t.q('[data-speed="1.75"]').click();
  t.putStatus = 0;
  t.win.dispatchEvent(new t.win.Event('pagehide'));
  await t.clock.advance(10);
  check('the leave failed', t.puts.length === 1 && t.serverPrefs.speed === undefined, t.puts);
  t.putStatus = 200;
  // happy-dom's PageTransitionEvent drops persisted: set it as the browser does.
  const show = (persisted) => {
    const e = new t.win.Event('pageshow');
    Object.defineProperty(e, 'persisted', { value: persisted });
    t.win.dispatchEvent(e);
  };
  show(false);
  await t.clock.advance(10);
  check('an ordinary show sends nothing', t.puts.length === 1, t.puts);
  show(true);
  await t.clock.advance(10);
  check('restored: sent again', t.puts.length === 2 && t.serverPrefs.speed === 1.75, t.puts);
  t.engine.close();
});

await run('a change made while its key is being saved is not lost', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '501', 1000);
  t.putDelays = [3000];
  t.q('.wsp-slot-menu button').click();
  t.q('[data-skip="30"]').click();
  await t.clock.advance(1000);
  t.q('[data-skip="45"]').click();
  await t.clock.advance(5000);
  check('sent after the first returned', t.puts.length === 2 && JSON.stringify(t.puts[1]) === '{"skip_s":45}', t.puts);
  check('the server has 45', t.serverPrefs.skip_s === 45, t.serverPrefs);
  t.win.dispatchEvent(new t.win.Event('pagehide'));
  await t.clock.advance(10);
  check('nothing left', t.puts.length === 2, t.puts);
  t.engine.close();
});

await run('changing the skip length or the speed while paused sends no check-in', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  await t.clock.advance(3000);
  const n = t.posts.length;
  t.ui.open();
  t.q('.wsp-slot-menu button').click();
  t.q('[data-skip="45"]').click();
  t.q('.wsp-slot-speed button').click();
  t.q('[data-speed="1.5"]').click();
  t.key(t.q('.wsp-sheet'), ']');
  await t.clock.advance(15000);
  check('set', t.engine.setSkip() === 45 && t.st().speed === 1.55, [t.engine.setSkip(), t.st().speed]);
  check('no check-in', t.posts.length === n, t.posts.slice(n).map((b) => b.event));
  check('the settings were saved', t.puts.length === 1, t.puts);
  t.engine.close();
});

// ---------------------------------------------------------------------------
// Skip length and speed
// ---------------------------------------------------------------------------

await run('the skip length menu', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  t.ui.open();
  const menu = t.q('.wsp-slot-menu');
  check('the menu slot is filled and shown', !menu.hidden && menu.querySelector('button').getAttribute('aria-label') === 'Playback settings');
  check('the slot never starts a swipe', menu.hasAttribute('data-no-swipe'));
  menu.querySelector('button').click();
  check('its panel shows', t.q('[data-panel="settings"]') && !t.q('[data-panel="settings"]').hidden);
  const chips = t.qa('[data-skip]').map((b) => b.getAttribute('data-skip'));
  check('5 to 60 s', chips.join(',') === '5,10,15,30,45,60', chips);
  check('10 is pressed', t.q('[data-skip="10"]').getAttribute('aria-pressed') === 'true' && t.qa('[data-skip][aria-pressed="true"]').length === 1);
  t.q('[data-skip="30"]').click();
  check('the engine has 30', t.engine.setSkip() === 30);
  check('30 is pressed', t.q('[data-skip="30"]').getAttribute('aria-pressed') === 'true' && t.qa('[data-skip][aria-pressed="true"]').length === 1);
  check('the skip buttons say 30', t.qa('.wsp-skip-n').every((n) => n.textContent === '30'));
  check('labelled', t.qa('.wsp-skip').map((b) => b.getAttribute('aria-label')).join('|') === 'Back 30 seconds|Forward 30 seconds');
  const b0 = bookMs(t);
  t.qa('.wsp-skip')[0].click();
  check('back 30 s', bookMs(t) === b0 - 30000, bookMs(t) - b0);
  t.engine.close();
});

await run('speed: a stepper and presets, 0.75x to 2x in 0.05 steps', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  t.ui.open();
  const btn = t.q('.wsp-slot-speed button');
  check('the speed slot shows 1×', !t.q('.wsp-slot-speed').hidden && btn.querySelector('.wsp-action-text').textContent === '1×');
  btn.click();
  const faster = t.q('.wsp-step[aria-label="Faster"]');
  const slower = t.q('.wsp-step[aria-label="Slower"]');
  faster.click();
  check('1.05×', t.st().speed === 1.05 && t.q('.wsp-speed-now').textContent === '1.05×' && btn.querySelector('.wsp-action-text').textContent === '1.05×');
  check('the element plays at it', t.audioEl.playbackRate === 1.05);
  t.q('[data-speed="2"]').click();
  check('2× preset', t.st().speed === 2 && t.q('[data-speed="2"]').getAttribute('aria-pressed') === 'true');
  check('faster is disabled at 2×', faster.disabled === true);
  faster.click();
  check('stays 2', t.st().speed === 2);
  t.q('[data-speed="0.75"]').click();
  check('slower is disabled at 0.75×', slower.disabled === true && t.st().speed === 0.75);
  slower.click();
  check('stays 0.75', t.st().speed === 0.75);
  check('labelled for speech', btn.getAttribute('aria-label') === 'Speed, 0.75 times', btn.getAttribute('aria-label'));
  await t.clock.advance(900);
  check('saved', t.puts.length === 1 && t.puts[0].speed === 0.75, t.puts);
  t.engine.close();
});

// ---------------------------------------------------------------------------
// The sleep timer
// ---------------------------------------------------------------------------

await run('sleep 15 minutes: counts listening time, fades, pauses with a save, restores the volume', async () => {
  const t = await setup();
  await t.openAt(LONG.key, '531', 0);
  t.ui.open();
  t.q('.wsp-slot-sleep button').click();
  const rows = t.qa('.wsp-row[data-kind]').map((b) => b.textContent.replace('check', ''));
  check('15, 30, 60 and end of chapter', rows.join('|') === '15 minutes|30 minutes|60 minutes|End of chapter', rows);
  t.q('.wsp-row[data-minutes="15"]').click();
  check('it runs', t.features.sleepState() && t.features.sleepState().minutes === 15);
  check('the slot shows 15:00', t.label('sleep') === '15:00', t.label('sleep'));
  check('pressed', t.q('.wsp-row[data-minutes="15"]').getAttribute('aria-pressed') === 'true');
  await t.clock.advance(MIN + 300);
  check('14:00 a minute on', t.label('sleep') === '14:00', t.label('sleep'));
  t.engine.pause();
  await t.clock.advance(5 * MIN);
  check('paused: the count stands still', t.label('sleep') === '14:00', t.label('sleep'));
  await t.engine.play();
  await t.clock.advance(14 * MIN - 10300);
  check('full volume until the last 10 s', t.vol() === 1 && t.st().playing, t.vol());
  await t.clock.advance(5000);
  const mid = t.vol();
  check('fading at 5 s left', mid > 0.1 && mid < 0.5 && t.st().playing, mid);
  const posts = t.posts.length;
  await t.clock.advance(5100);
  check('paused at the end', !t.st().playing);
  check('a pause was saved at once', t.posts.slice(posts).some((b) => b.event === 'pause'), t.posts.slice(posts).map((b) => b.event));
  check('the volume is back', t.vol() === 1, t.vol());
  check('the timer is off', t.features.sleepState() === null && t.label('sleep') === 'Sleep');
  t.engine.close();
});

await run('sleep: cancel restores the volume, and a pause during the fade cancels it', async () => {
  const t = await setup();
  await t.openAt(LONG.key, '531', 0);
  t.features.sleep('minutes', 15);
  await t.clock.advance(15 * MIN - 4000);
  check('fading', t.vol() < 0.5, t.vol());
  t.features.cancelSleep();
  check('cancel: volume back and still playing', t.vol() === 1 && t.st().playing && t.label('sleep') === 'Sleep');
  t.features.sleep('minutes', 15);
  await t.clock.advance(15 * MIN - 4000);
  check('fading again', t.vol() < 0.5, t.vol());
  t.engine.pause();
  check('a pause in the fade ends the timer', t.features.sleepState() === null);
  check('and restores the volume', t.vol() === 1);
  await t.engine.play();
  await t.clock.advance(10000);
  check('nothing pauses it later', t.st().playing && t.vol() === 1);
  t.engine.close();
});

await run('sleep at the end of a chapter that ends at a part boundary', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '501', 585000);
  t.ui.open();
  t.q('.wsp-slot-sleep button').click();
  t.q('.wsp-row[data-kind="chapter"]').click();
  check('it runs to the chapter end', t.features.sleepState() && t.features.sleepState().kind === 'chapter');
  const left = t.features.sleepState().leftMs;
  check('the slot shows the time to the end', t.label('sleep') === F.formatCountdown(left), [t.label('sleep'), left]);
  await t.clock.advance(10000);
  check('fading in the last 10 s', t.vol() < 1 && t.st().playing, t.vol());
  const posts = t.posts.length;
  await t.clock.advance(6000);
  const st = t.st();
  check('paused', !st.playing, st.playing);
  check('at the chapter end, not into the next part', st.bookMs >= 599500 && st.bookMs <= 600500, st.bookMs);
  check('nothing of part 2 played', !t.audioEl.ticking);
  check('a pause was saved', t.posts.slice(posts).some((b) => b.event === 'pause'));
  check('the volume is back', t.vol() === 1);
  t.engine.close();
});

await run('sleep at the end of a chapter that runs across a part boundary', async () => {
  const t = await setup();
  await t.openAt(SPAN.key, '511', 290000);
  check('in chapter Two', t.st().chapterIndex === 1);
  t.features.sleep('chapter');
  check('210 s to its end', Math.abs(t.features.sleepState().leftMs - 210000) < 500, t.features.sleepState().leftMs);
  await t.clock.advance(30000);
  check('across the part boundary, still playing at full volume', t.st().trackIndex === 1 && t.st().playing && t.vol() === 1, [t.st().trackIndex, t.vol()]);
  await t.clock.advance(185000);
  const st = t.st();
  check('paused at the chapter end in the second part', !st.playing && st.trackIndex === 1 && st.bookMs >= 499500 && st.bookMs <= 500500, [st.playing, st.bookMs]);
  check('the volume is back', t.vol() === 1);
  t.engine.close();
});

await run('sleep at the end of a chapter at 1.5x, and after a seek into the next one', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '501', 540000);
  t.engine.setSpeed(1.5);
  t.features.sleep('chapter');
  check('60 s of book is 40 s at 1.5x', Math.abs(t.features.sleepState().leftMs - 40000) < 400, t.features.sleepState().leftMs);
  t.engine.jumpToChapter(1);
  check('a jump to the next chapter moves the end with it', Math.abs(t.features.sleepState().leftMs - 900000 / 1.5) < 400, t.features.sleepState().leftMs);
  t.engine.close();
  await t.openAt(MIXED.key, '521', 1000);
  t.ui.open();
  check('a book with no chapters offers no end of chapter', t.q('.wsp-row[data-kind="chapter"]').closest('[hidden]') !== null);
  check('and cannot start one', t.features.sleep('chapter') === false && t.features.sleepState() === null);
  t.engine.close();
});

await run('the sleep timer ends with its book', async () => {
  const t = await setup();
  await t.openAt(LONG.key, '531', 0);
  t.features.sleep('minutes', 30);
  await t.clock.advance(30 * MIN - 5000);
  check('fading', t.vol() < 1);
  t.engine.close();
  check('closed: off, volume back', t.features.sleepState() === null && t.vol() === 1);
  await t.openAt(LONG.key, '531', 0);
  t.features.sleep('minutes', 60);
  await t.clock.advance(MIN);
  await t.openAt(MULTI.key, '501', 0);
  check('another book: off', t.features.sleepState() === null && t.label('sleep') === 'Sleep');
  t.engine.close();
});

await run('choosing a sleep timer goes back to the player on a phone, not beside it', async () => {
  for (const wide of [false, true]) {
    const t = await setup({ wide });
    await t.openAt(LONG.key, '531', 0);
    t.ui.open();
    t.q('.wsp-slot-sleep button').click();
    check(`shown (${wide ? 'wide' : 'phone'})`, t.q('.wsp-full').getAttribute('data-view') === 'sleep');
    t.q('.wsp-row[data-minutes="30"]').click();
    const view = t.q('.wsp-full').getAttribute('data-view');
    check(wide ? 'wide: the panel stays' : 'phone: back to the player', wide ? view === 'sleep' : view === null, view);
    check('pressed', t.q('.wsp-row[data-minutes="30"]').getAttribute('aria-pressed') === 'true');
    t.q('.wsp-row-off').click();
    check('turned off', t.features.sleepState() === null && t.q('.wsp-row-off').hidden);
    t.engine.close();
  }
});

// ---------------------------------------------------------------------------
// Smart rewind
// ---------------------------------------------------------------------------

const EDGES = [[9999, 0], [10000, 3000], [59999, 3000], [60000, 10000], [3599999, 10000], [3600000, 30000]];
for (const [away, want] of EDGES) {
  await run(`smart rewind after a pause of ${away} ms goes back ${want} ms`, async () => {
    const t = await setup();
    await t.openAt(MULTI.key, '502', 300000);
    await t.clock.advance(2000);
    t.engine.pause();
    const at = bookMs(t);
    await t.clock.advance(away);
    const n = t.posts.length;
    await t.engine.play();
    check('went back', bookMs(t) === at - want, bookMs(t) - at);
    await t.clock.advance(1500);
    // Smart rewind is a playback aid: no save goes behind the place reached.
    check('no save behind the place reached', t.posts.slice(n).every((b) => b.track === '502' && b.offset_ms >= at - 600000), t.posts.slice(n).map((b) => [b.event, b.offset_ms]));
    check('and no save for the rewind itself', !t.posts.slice(n).some((b) => b.event === 'seek'), t.posts.slice(n).map((b) => b.event));
    t.engine.close();
  });
}

await run('smart rewind is a per-listener switch', async () => {
  const t = await setup({ prefs: { skip_s: 10, speed: 1, smart_rewind: false } });
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  const at = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('off: no rewind', bookMs(t) === at, bookMs(t) - at);
  t.engine.close();
});

await run('smart rewind goes back into the part before, never before the start', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 1000);
  await t.clock.advance(1000);
  t.engine.pause();
  const at = bookMs(t);
  await t.clock.advance(3600000);
  await t.engine.play();
  check('into part 1', t.st().trackIndex === 0 && bookMs(t) === at - 30000, [t.st().trackIndex, bookMs(t) - at]);
  await t.clock.advance(1000);
  check('and plays there', t.st().playing && t.audioEl.part === MULTI.tracks[0].part_path);
  t.engine.close();
  await t.openAt(MULTI.key, '501', 2000);
  await t.clock.advance(1500);
  t.engine.pause();
  await t.clock.advance(3600000);
  await t.engine.play();
  check('clamped at the book start', bookMs(t) === 0, bookMs(t));
  t.engine.close();
});

await run('smart rewind never moves into a part that cannot play', async () => {
  const t = await setup();
  await t.openAt(MIXED.key, '523', 3000);
  await t.clock.advance(2000);
  t.engine.pause();
  const warnings = [];
  t.engine.on('warning', (w) => warnings.push(w.kind));
  await t.clock.advance(3600000);
  await t.engine.play();
  check('the start of the part after it', t.st().trackIndex === 2 && t.st().position.offset_ms === 0, t.st().position);
  check('no refusal notice', warnings.indexOf('part-format') === -1 && t.notices().length === 0, [warnings, t.notices()]);
  t.engine.close();
});

await run('a place chosen while paused is not rewound', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  await t.clock.advance(3600000);
  t.engine.seek(1000000);
  await t.engine.play();
  check('played from the chosen place', bookMs(t) === 1000000, bookMs(t));
  t.engine.close();
});

// A book opened at a saved place goes back at its first real playback, by
// how old the place is in the server's clock.
const webAt = (t, track, offset, agoMs) => ({ track, offset_ms: offset, duration_ms: 900000, updated_at: new Date(t.serverNow() - agoMs).toISOString(), device: 'Phone' });
for (const [agoMs, want] of [[5000, 0], [45000, 3000], [2 * 3600000, 30000]]) {
  await run(`a book opened at a place saved ${agoMs} ms ago goes back ${want} ms, once it plays`, async () => {
    const t = await setup();
    t.places = { web: webAt(t, '502', 300000, agoMs) };
    const p = t.engine.open(MULTI.key);
    await t.clock.advance(100);
    await p;
    check('opened where it was saved', bookMs(t) === 900000, bookMs(t));
    check('nothing moved is sent before it plays', t.posts.every((b) => b.offset_ms === 300000), t.posts.map((b) => [b.event, b.offset_ms]));
    await t.clock.advance(400);
    check('then back by the rule', bookMs(t) >= 900000 - want && bookMs(t) < 900000 - want + 1000, bookMs(t) - 900000);
    await t.clock.advance(1500);
    const seeks = t.posts.filter((b) => b.event === 'seek');
    check('no seek saved, nothing behind the opened place', seeks.length === 0 && t.posts.every((b) => b.offset_ms >= 300000), t.posts.map((b) => [b.event, b.offset_ms]));
    const b1 = bookMs(t);
    await t.clock.advance(2000);
    check('once', bookMs(t) > b1, [b1, bookMs(t)]);
    check('no undo offered', t.notices().length === 0);
    t.engine.close();
  });
}

await run('opens that never play leave the saved place where it was (Plex unreachable)', async () => {
  const t = await setup({ remote: [], stateful: true });
  t.places = { web: webAt(t, '502', 300000, 2 * 3600000) };
  for (let i = 0; i < 3; i++) {
    const p = t.engine.open(MULTI.key);
    await t.clock.advance(200);
    await p;
    check(`open ${i + 1}: unreachable, nothing loaded`, t.st().error && t.st().error.code === 'unreachable' && t.loads.length === 0, t.st().error);
    check(`open ${i + 1}: the place is untouched`, bookMs(t) === 900000, bookMs(t));
    t.engine.close();
    await t.clock.advance(2 * 3600000);
  }
  const moved = t.posts.filter((b) => !(b.track === '502' && b.offset_ms === 300000));
  check('no save moved it', moved.length === 0, t.posts.map((b) => [b.event, b.track, b.offset_ms]));
});

await run('opens whose autoplay is refused leave the place; the first real play rewinds once', async () => {
  const t = await setup({ stateful: true });
  t.places = { web: webAt(t, '502', 300000, 2 * 3600000) };
  t.blockAutoplay = true;
  for (let i = 0; i < 3; i++) {
    const p = t.engine.open(MULTI.key);
    await t.clock.advance(300);
    await p;
    check(`open ${i + 1}: refused, paused at the saved place`, !t.st().playing && bookMs(t) === 900000, [t.st().playing, bookMs(t)]);
    if (i < 2) {
      t.engine.close();
      await t.clock.advance(10 * 60000);
    }
  }
  check('the server still has the place', t.places.web.track === '502' && t.places.web.offset_ms === 300000, t.places.web);
  // Each refused open still checked in at the same place (saves.js), so the
  // server's copy is 10 minutes old at the last open: that is its age.
  const age = Date.parse(t.places.web.updated_at);
  check('re-stamped, not moved, 10 minutes before the last open', t.serverNow() - age < 11 * 60000, t.serverNow() - age);
  t.blockAutoplay = false;
  await t.engine.play();
  await t.clock.advance(600);
  check('the tap plays from 10 s back, once', bookMs(t) >= 890000 && bookMs(t) < 891000, bookMs(t) - 900000);
  await t.clock.advance(1500);
  check('the saved place is not moved back', t.places.web.offset_ms >= 300000, t.places.web);
  t.engine.close();
});

await run('a place chosen after opening is not rewound when it plays', async () => {
  const t = await setup();
  t.places = { web: webAt(t, '502', 300000, 2 * 3600000) };
  const p = t.engine.open(MULTI.key, { autoplay: false });
  await t.clock.advance(100);
  await p;
  t.engine.seek(1000000);
  await t.engine.play();
  await t.clock.advance(1000);
  check('played on from the chosen place', bookMs(t) >= 1000000 && bookMs(t) < 1001500, bookMs(t));
  t.engine.close();
});

// The device clock is off: the place's age is the server's.
for (const [skew, agoMs, want, what] of [[-3600000, 5000, 0, 'an hour fast'], [120000, 61000, 10000, '2 minutes slow'], [-300000, 45000, 3000, '5 minutes fast']]) {
  await run(`a device ${what}: a place saved ${agoMs} ms ago goes back ${want} ms`, async () => {
    const t = await setup({ skewMs: skew });
    t.places = { web: webAt(t, '502', 300000, agoMs) };
    const p = t.engine.open(MULTI.key);
    await t.clock.advance(600);
    await p;
    const back = 900000 - bookMs(t);
    check('by the rule', back > want - 1000 && back <= want, back);
    t.engine.close();
  });
}

await run('a Retry after a pause rewinds as Play does', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  const at = bookMs(t);
  await t.clock.advance(2 * 3600000);
  // The stream fails while paused, and stays down.
  t.down = true;
  t.audioEl.error = { code: 2 };
  t.audioEl.fire('error');
  await t.clock.advance(5000);
  check('stopped with an error', t.st().error && t.st().error.code === 'unreachable', t.st().error);
  t.down = false;
  await t.engine.play();
  check('back 30 s', bookMs(t) === at - 30000, bookMs(t) - at);
  t.engine.close();
});

await run('smart rewind waits for the settings: none while they are unknown', async () => {
  const t = await setup({ prefs: 503 });
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  const at = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('no rewind on unknown settings', bookMs(t) === at, bookMs(t) - at);
  const gets = t.fetches.filter((f) => f.url === '/api/player/prefs' && f.method === 'GET');
  check('asked again at the open', gets.length === 2, gets.length);
  t.engine.close();
  t.prefsAnswer = { skip_s: 10, speed: 1, smart_rewind: true };
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  const at2 = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('known again: the rewind is back', bookMs(t) === at2 - 30000, bookMs(t) - at2);
  t.engine.close();
});

await run('an open with smart rewind off does not rewind', async () => {
  const t = await setup({ prefs: { skip_s: 10, speed: 1, smart_rewind: false } });
  t.places = { web: webAt(t, '502', 300000, 2 * 3600000) };
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(600);
  await p;
  check('played from the saved place', bookMs(t) > 900000 && bookMs(t) < 901000, bookMs(t) - 900000);
  t.engine.close();
});

await run('an open while the settings are unknown does not rewind either', async () => {
  const t = await setup({ prefs: 503 });
  t.places = { web: webAt(t, '502', 300000, 2 * 3600000) };
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(600);
  await p;
  check('played from the saved place', bookMs(t) > 900000 && bookMs(t) < 901000, bookMs(t) - 900000);
  t.engine.close();
});

await run('the time away of an opened book runs on until it plays', async () => {
  const t = await setup();
  t.places = { web: webAt(t, '502', 300000, 5000) };
  const p = t.engine.open(MULTI.key, { autoplay: false });
  await t.clock.advance(100);
  await p;
  await t.clock.advance(2 * 60000);
  await t.engine.play();
  await t.clock.advance(600);
  check('5 s old at the open, 2 min more before play: back 10 s', bookMs(t) >= 890000 && bookMs(t) < 891000, bookMs(t) - 900000);
  t.engine.close();
});

await run('play and a quick pause, again and again (a double tap): one rewind per break', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  const reached = bookMs(t);
  for (let i = 1; i <= 3; i++) {
    await t.clock.advance(2 * 3600000);
    await t.engine.play();
    await t.clock.advance(200);
    t.engine.pause();
    await t.clock.advance(1500);
    check(`cycle ${i}: one rewind in all`, bookMs(t) >= reached - 30000 && bookMs(t) <= reached - 30000 + 500, bookMs(t) - reached);
  }
  // Real listening (over HEARD_MS) makes the next pause a break again.
  await t.engine.play();
  await t.clock.advance(3000);
  t.engine.pause();
  const here = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('a real break rewinds again', bookMs(t) === here - 30000, bookMs(t) - here);
  t.engine.close();
});

await run('listening is counted from where a rewind lands', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  // 3 s heard after the 30 s rewind: well short of where it had been.
  await t.clock.advance(3000);
  t.engine.pause();
  const here = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('that was a break: back 30 s again', bookMs(t) === here - 30000, bookMs(t) - here);
  t.engine.close();
});

for (const [name, buffer, pauseAt, retry] of [
  ['a fast stream, paused 100 ms in', 0, 100, false],
  ['a slow stream (3 s to buffer), paused at 1 s', 3000, 1000, false],
  ['a slow stream, paused at 1 s, failing while paused, then Retry', 3000, 1000, true]
]) {
  await run(`an opened book paused before it plays (${name}): one rewind`, async () => {
    const t = await setup();
    t.bufferMs = buffer;
    t.places = { web: webAt(t, '502', 300000, 2 * 3600000) };
    const seeks = [];
    t.engine.on('change', (d) => { if (d.reason === 'seek') seeks.push([d.from, d.to]); });
    const p = t.engine.open(MULTI.key);
    await t.clock.advance(pauseAt);
    await p;
    t.engine.pause();
    await t.clock.advance(5 * MIN);
    if (retry) {
      t.down = true;
      t.audioEl.error = { code: 2 };
      t.audioEl.fire('error');
      await t.clock.advance(5000);
      check('stopped with an error', t.st().error && t.st().error.code === 'unreachable', t.st().error);
      t.down = false;
    }
    await t.engine.play();
    await t.clock.advance(20000);
    check('one rewind', seeks.length === 1 && seeks[0][1] === 870000, seeks);
    t.engine.close();
  });
}

await run('no server time on the saved place: no open rewind, never the device clock', async () => {
  const t = await setup();
  t.noNow = true;
  t.places = { web: webAt(t, '502', 300000, 2 * 3600000) };
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(600);
  await p;
  check('no age', t.st().resumedFrom && t.st().resumedFrom.age_ms === null, t.st().resumedFrom);
  check('played on from the saved place', bookMs(t) > 900000 && bookMs(t) < 901000, bookMs(t) - 900000);
  t.engine.close();
});

await run('reopening again and again never walks the saved place back', async () => {
  const t = await setup({ stateful: true });
  t.places = { web: webAt(t, '502', 300000, 2 * 3600000) };
  for (let i = 1; i <= 3; i++) {
    const p = t.engine.open(MULTI.key);
    await t.clock.advance(400);
    await p;
    check(`open ${i}: it rewound for playback`, bookMs(t) < 900000 - 20000, bookMs(t) - 900000);
    t.engine.pause();
    await t.clock.advance(1500);
    t.engine.close();
    await t.clock.advance(10);
    check(`open ${i}: the saved place is where it was`, t.places.web.track === '502' && t.places.web.offset_ms >= 300000 && t.places.web.offset_ms < 301500, t.places.web);
    await t.clock.advance(2 * 3600000);
  }
});

await run('a rewind is for playback only: the saved place moves on once playback passes it', async () => {
  const t = await setup({ stateful: true });
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(5000);
  t.engine.pause();
  await t.clock.advance(1500);
  const reached = t.places.web.offset_ms;
  await t.clock.advance(3600000);
  await t.engine.play();               // back 30 s
  await t.clock.advance(10000);
  t.engine.pause();
  await t.clock.advance(1500);
  check('a pause in the window saves the place reached', t.places.web.offset_ms === reached, [t.places.web.offset_ms, reached]);
  await t.engine.play();
  await t.clock.advance(25000);
  t.engine.pause();
  await t.clock.advance(1500);
  check('past it, saves as ever', t.places.web.offset_ms > reached, [t.places.web.offset_ms, reached]);
  const here = bookMs(t);
  await t.clock.advance(3600000);
  await t.engine.play();               // back 30 s again
  await t.clock.advance(1000);
  t.engine.skip(-60);                  // the listener's own move, inside the window
  await t.clock.advance(1500);
  t.engine.pause();
  await t.clock.advance(1500);
  check('a skip back inside the window saves the new place', t.places.web.offset_ms < here - 600000 - 60000 && t.places.web.offset_ms > here - 600000 - 90000, [t.places.web.offset_ms, here - 600000]);
  t.engine.close();
});

await run('a move while playing starts the listening count again', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(5000);
  t.engine.jumpToChapter(2);           // forward
  await t.clock.advance(300);
  t.engine.pause();
  const at = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('300 ms after a jump is no break', bookMs(t) === at, bookMs(t) - at);
  await t.clock.advance(5000);
  t.engine.skip(-60);                  // back
  await t.clock.advance(1500);
  t.engine.pause();
  const at2 = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('1.5 s heard after a move back is a break', bookMs(t) === at2 - 30000, bookMs(t) - at2);
  t.engine.close();
});

await run('under a second of listening is no break, over it is', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(3000);
  t.engine.pause();
  await t.clock.advance(2 * 3600000);
  await t.engine.play();               // back 30 s
  await t.clock.advance(750);
  t.engine.pause();
  const a = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('750 ms is no break', bookMs(t) === a, bookMs(t) - a);
  await t.clock.advance(1250);
  t.engine.pause();
  const b = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('1250 ms is', bookMs(t) === b - 30000, bookMs(t) - b);
  t.engine.close();
});

await run('a pause with nothing heard since the last resume arms no second rewind', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(2000);
  t.engine.pause();
  const at = bookMs(t);
  await t.clock.advance(2 * 3600000);
  await t.engine.play();
  check('back 30 s', bookMs(t) === at - 30000);
  t.engine.pause();
  await t.clock.advance(20000);
  await t.engine.play();
  check('no second rewind', bookMs(t) === at - 30000, bookMs(t) - at);
  t.engine.close();
});

// ---------------------------------------------------------------------------
// Undo big jumps
// ---------------------------------------------------------------------------

await run('undo after a big scrubber seek, for 8 s', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 60000);
  t.ui.open();
  const range = t.q('.wsp-range');
  range.value = String(780);       // 13 min into chapter 2 from 1 min: a jump of 12 min
  range.dispatchEvent(new t.win.Event('change', { bubbles: true }));
  check('the notice', t.notices().indexOf('Jumped ahead 12 min.') !== -1, t.notices());
  check('with Undo', !!t.undoBtn());
  await t.clock.advance(7900);
  check('still there at 7.9 s', !!t.undoBtn());
  await t.clock.advance(200);
  check('gone at 8 s', !t.undoBtn() && t.notices().length === 0, t.notices());
  t.engine.close();
});

await run('undo a chapter jump: back to the place before it, and no notice of its own', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 60000);
  const before = bookMs(t);
  t.engine.jumpToChapter(2);
  check('jumped', bookMs(t) === 1500000);
  check('the notice', t.notices()[0] === 'Jumped ahead ' + F.formatDelta(1500000 - before) + '.', t.notices());
  t.undoBtn().click();
  check('back where it was', bookMs(t) === before, bookMs(t));
  check('no notice for the undo', t.notices().length === 0, t.notices());
  t.engine.close();
});

await run('a second big jump replaces the notice, and Undo goes to before that jump', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 60000);
  t.engine.seek(1200000);
  const mid = bookMs(t);
  t.engine.seek(100000);
  check('one notice', t.qa('.wsp-notice').length === 1 && t.notices()[0] === 'Jumped back ' + F.formatDelta(mid - 100000) + '.', t.notices());
  t.undoBtn().click();
  check('back to before the second jump', bookMs(t) === mid, bookMs(t));
  t.engine.close();
});

await run('undo: skips and the lock screen count, 2 minutes or less does not', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  t.engine.seek(bookMs(t) + 120000);
  check('exactly 2 min: no notice', t.notices().length === 0);
  t.engine.skip(-30);
  check('a small skip: none', t.notices().length === 0);
  const b0 = bookMs(t);
  t.ms.handlers.get('seekforward')({ action: 'seekforward', seekOffset: 121 });
  check('a lock-screen skip over 2 min', t.notices()[0] === 'Jumped ahead 2 min.', t.notices());
  t.undoBtn().click();
  check('undone', bookMs(t) === b0);
  t.ms.handlers.get('seekto')({ action: 'seekto', seekTime: 1700 });
  check('lock-screen seekto over 2 min', t.notices().length === 1 && /^Jumped ahead /.test(t.notices()[0]), t.notices());
  t.engine.close();
});

await run('the undo notice goes with its book', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 60000);
  t.engine.seek(1500000);
  check('offered', !!t.undoBtn());
  t.engine.close();
  check('gone on close', !t.undoBtn());
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

await run('keys on a page with the player closed', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  const b = t.doc.body;
  let ev = t.key(b, ' ');
  check('Space pauses', !t.st().playing && ev.defaultPrevented);
  t.key(b, ' ');
  await t.clock.advance(100);
  check('Space plays', t.st().playing);
  const b0 = bookMs(t);
  ev = t.key(b, 'ArrowRight');
  check('right: forward by the skip length', bookMs(t) === b0 + 10000 && ev.defaultPrevented, bookMs(t) - b0);
  t.key(b, 'ArrowLeft');
  check('left: back', bookMs(t) === b0);
  t.engine.setSkip(30);
  t.key(b, 'ArrowLeft');
  check('the skip length as set', bookMs(t) === b0 - 30000, bookMs(t) - b0);
  t.key(b, ']');
  check('] faster by 0.05', t.st().speed === 1.05);
  t.key(b, '[');
  t.key(b, '[');
  check('[ slower by 0.05', t.st().speed === 0.95);
  t.engine.setSpeed(2);
  t.key(b, ']');
  check('clamped at 2', t.st().speed === 2);
  t.engine.setSpeed(0.75);
  t.key(b, '[');
  check('clamped at 0.75', t.st().speed === 0.75);
  const paused = t.st().playing;
  ev = t.key(b, ' ', { repeat: true });
  check('a held Space does not flap', t.st().playing === paused);
  // A held key acts once: the first press, never its repeats.
  t.engine.setSpeed(1);
  const b1 = bookMs(t);
  t.key(b, 'ArrowRight');
  for (let i = 0; i < 90; i++) t.key(b, 'ArrowRight', { repeat: true });
  check('a held arrow skips once', bookMs(t) === b1 + 30000, bookMs(t) - b1);
  t.key(b, ']');
  for (let i = 0; i < 30; i++) t.key(b, ']', { repeat: true });
  check('a held ] steps once', t.st().speed === 1.05, t.st().speed);
  ev = t.key(b, '[', { repeat: true });
  check('a repeat is still kept from the page', ev.defaultPrevented && t.st().speed === 1.05);
  t.engine.close();
});

await run('keys that are not the player\'s', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  const b0 = bookMs(t);
  const targets = ['#field', '#area', '#sel', '#para', '#pageBtn', '#tabs', '#box'];
  for (const sel of targets) {
    const el = t.q(sel);
    const a = t.key(el, ' ');
    const r = t.key(el, 'ArrowRight');
    const s = t.key(el, ']');
    check(`ignored in ${sel}`, t.st().playing && bookMs(t) === b0 && t.st().speed === 1 && !a.defaultPrevented && !r.defaultPrevented && !s.defaultPrevented, sel);
  }
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
    const e = t.key(t.doc.body, 'ArrowRight', { [mod]: true });
    check(`ignored with ${mod}`, bookMs(t) === b0 && !e.defaultPrevented);
  }
  // Handled already by the page.
  const own = (e) => e.preventDefault();
  t.doc.body.addEventListener('keydown', own);
  t.key(t.doc.body, 'ArrowRight');
  check('ignored when the page handled it', bookMs(t) === b0);
  t.doc.body.removeEventListener('keydown', own);
  // A tour runs.
  const layer = t.doc.createElement('div');
  layer.id = 'tourLayer';
  t.doc.body.appendChild(layer);
  t.key(t.doc.body, ' ');
  check('ignored under a tour', t.st().playing);
  layer.classList.add('hidden');
  t.key(t.doc.body, 'ArrowRight');
  check('a finished tour does not count', bookMs(t) === b0 + 10000);
  layer.remove();
  // A WSUI dialog is up.
  t.env.dialog = true;
  t.key(t.doc.body, ' ');
  check('ignored under a dialog', t.st().playing);
  t.env.dialog = false;
  t.engine.close();
  const e = t.key(t.doc.body, ' ');
  check('no book: Space is the page\'s', !e.defaultPrevented);
});

await run('the reader keeps Space and the arrows', async () => {
  const t = await setup({ path: '/reader' });
  await t.openAt(MULTI.key, '502', 300000);
  const seen = [];
  t.doc.addEventListener('keydown', (e) => seen.push([e.key, e.defaultPrevented]));
  const b0 = bookMs(t);
  for (const k of [' ', 'ArrowRight', 'ArrowLeft', '[', ']']) t.key(t.doc.body, k);
  check('the player did nothing', t.st().playing && bookMs(t) === b0 && t.st().speed === 1);
  check('the reader heard every key, unhandled', seen.length === 5 && seen.every((s) => s[1] === false), seen);
  t.path = '/reader/';
  t.key(t.doc.body, ' ');
  check('under /reader/ too', t.st().playing);
  t.engine.close();
});

await run('keys inside the full player', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  t.ui.open();
  const heard = [];
  t.doc.addEventListener('keydown', (e) => heard.push(e.key));
  const sheet = t.q('.wsp-sheet');
  sheet.focus();
  t.key(sheet, ' ');
  check('Space on the sheet pauses', !t.st().playing);
  t.key(sheet, ' ');
  await t.clock.advance(100);
  check('and plays', t.st().playing);
  const b0 = bookMs(t);
  t.key(sheet, 'ArrowRight');
  check('right: forward once (no second handler)', bookMs(t) === b0 + 10000, bookMs(t) - b0);
  t.key(sheet, ']');
  check('] faster', t.st().speed === 1.05);
  const close = t.q('.wsp-top .wsp-icon-btn');
  const ev = t.key(close, ' ');
  check('Space on a button is the button\'s', t.st().playing && !ev.defaultPrevented);
  const range = t.q('.wsp-range');
  const b1 = bookMs(t);
  t.key(range, 'ArrowLeft');
  check('the scrubber\'s arrows skip once', bookMs(t) === b1 - 10000, bookMs(t) - b1);
  t.key(t.doc.body, ' ');
  check('a key aimed outside while open does nothing', t.st().playing);
  check('no page listener heard any of it', heard.length === 0, heard);
  t.engine.close();
});

await run('keys in a panel', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 300000);
  t.ui.open();
  t.q('.wsp-slot-speed button').click();
  const chip = t.q('[data-speed="1.5"]');
  chip.focus();
  const b0 = bookMs(t);
  t.key(chip, 'ArrowRight');
  check('arrows on a panel button skip', bookMs(t) === b0 + 10000);
  const ev = t.key(chip, ' ');
  check('Space there presses the button', !ev.defaultPrevented && t.st().playing);
  t.engine.close();
});

// ---------------------------------------------------------------------------
// Boot and markup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// History, handoff and up next
// ---------------------------------------------------------------------------

const ME = 'k3v9x0q2m7w1p4z8r6t5y2u0';        // this browser's id
const OTHER = 'q8w2e6r4t0y9u1i3o5p7a2s4';     // another device's
const ID = '3f9a0c1d2b7e4a6f';                // the identity key of the local copy
const entry = (t, agoMs, track, offset, device = 'Chrome on Android', id = OTHER, event = 'checkin') =>
  ({ track, offset_ms: offset, device, device_id: id, event, at: new Date(t.now() - agoMs).toISOString() });

await run('history sessions: a gap over 10 minutes splits, exactly 10 does not; another device splits', () => {
  const at = (min) => new Date(Date.UTC(2026, 8, 29, 20, 0) - min * 60000).toISOString();
  const e = (min, offset, device_id = OTHER, device = 'Chrome on Android') => ({ track: '501', offset_ms: offset, device, device_id, event: 'checkin', at: at(min) });
  // Newest first, as the server gives them.
  const entries = [
    e(0, 500000), e(5, 450000), e(15, 400000),      // one session: gaps of 5 and 10 minutes
    e(25.001, 300000),                                // over 10 minutes before: a new one
    e(26, 290000, ME, 'Chrome on Linux'),             // another device: a new one
    e(27, 280000, ME, 'Chrome on Linux')
  ];
  const place = (track, off) => (track === '501' ? off : null);
  const g = F.groupSessions(entries, place);
  check('three sessions', g.length === 3, g.map((x) => x.count));
  check('newest first, with the ends', g[0].end === Date.parse(at(0)) && g[0].start === Date.parse(at(15)) && g[0].count === 3, g[0]);
  check('ends where it ended', g[0].endMs === 500000 && g[0].endPlace.track === '501' && g[0].endPlace.offset_ms === 500000);
  check('covers the book time between', g[0].fromMs === 400000 && g[0].toMs === 500000);
  check('the device', g[0].device === 'Chrome on Android' && g[0].device_id === OTHER && g[2].device === 'Chrome on Linux');
  check('the split sessions', g[1].count === 1 && g[2].count === 2, g.map((x) => x.count));
  // Without ids, the labels tell devices apart.
  const noIds = entries.map((x) => Object.assign({}, x, { device_id: null }));
  check('labels when there are no ids', F.groupSessions(noIds, place).length === 3, F.groupSessions(noIds, place).length);
  // A place not in the book: the session is kept, with no end to go to.
  const lost = F.groupSessions([{ track: '999', offset_ms: 5, device: 'x', event: 'pause', at: at(0) }], place);
  check('no place in the book: no end', lost.length === 1 && lost[0].endMs === null && lost[0].fromMs === null);
  check('junk is skipped', F.groupSessions([null, { at: 'yesterday' }, 5], place).length === 0 && F.groupSessions(null).length === 0);
});

await run('history (spec 2.5): sessions split by copy; where one ended, as that copy saved it', () => {
  const at = (min) => new Date(Date.UTC(2026, 8, 29, 20, 0) - min * 60000).toISOString();
  const e = (min, track, more) => Object.assign({ track, offset_ms: 1000, device: 'Chrome on Android', device_id: OTHER, event: 'checkin', at: at(min) }, more);
  const place = (track, off) => (track === '501' ? off : null);
  const g = F.groupSessions([
    e(0, '501', { book_key: '500:1', book_ms: 1000, book_duration_ms: 3600000, chapter_label: 'One' }),
    e(1, '401', { book_key: '400:1', book_ms: 61000, book_duration_ms: 7200000, chapter_label: 'Uno', earlier_copy: true }),
    e(2, '401', { book_key: '400:1', book_ms: 60000, earlier_copy: true })
  ], place);
  check('two sessions: one per copy', g.length === 2 && g[0].count === 1 && g[1].count === 2, g.map((x) => x.count));
  check('the end entry\'s own fields', g[1].endBookMs === 61000 && g[1].endDurationMs === 7200000 && g[1].endLabel === 'Uno' && g[1].bookKey === '400:1' && g[1].earlier === true, g[1]);
  check('this copy\'s', g[0].earlier === false && g[0].bookKey === '500:1' && g[0].endMs === 1000);
  const none = F.groupSessions([e(0, '501')], place)[0];
  check('not saved: null', none.endBookMs === null && none.endDurationMs === null && none.endLabel === null && none.bookKey === null && none.earlier === false, none);
  check('chapter names', F.chapterName('3') === 'Chapter 3' && F.chapterName('XII') === 'Chapter XII' && F.chapterName('Chapter 3') === 'Chapter 3' &&
    F.chapterName('Part 2 of 17') === 'Part 2 of 17' && F.chapterName('The Letter') === 'The Letter' && F.chapterName('Mix') === 'Mix' && F.chapterName(null) === '');
  check('the saved place', F.sessionPlace(g[1], MULTI.chapters, 1800000) === 'Uno · 0:01:01 into the book · 0%', F.sessionPlace(g[1], MULTI.chapters, 1800000));
  check('no saved length: no percent', F.sessionPlace({ endBookMs: 3725000, endDurationMs: null, endLabel: '12', endMs: null }, [], 1800000) === 'Chapter 12 · 1:02:05 into the book');
  check('saved before: this copy', F.sessionPlace({ endBookMs: null, endMs: 1500000 }, MULTI.chapters, 1800000) === 'Part 3 of 3 · 0:25:00 into the book · 83%');
  check('an unnamed chapter of this copy', F.sessionPlace({ endBookMs: null, endMs: 700000 }, [{ start_ms: 0 }, { start_ms: 600000 }], 1800000) === 'Chapter 2 · 0:11:40 into the book · 38%');
  check('nothing known', F.sessionPlace({ endBookMs: null, endMs: null, endLabel: null }, MULTI.chapters, 1800000) === '');
  check('a label alone', F.sessionPlace({ endBookMs: null, endMs: null, endLabel: 'Prologue' }, [], 0) === 'Prologue');
});

await run('a session across a page boundary is one', () => {
  const at = (min) => new Date(Date.UTC(2026, 8, 29, 20, 0) - min * 60000).toISOString();
  const e = (min) => ({ track: '501', offset_ms: 1000 * (100 - min), device: 'Chrome on Android', device_id: OTHER, event: 'checkin', at: at(min) });
  const page1 = [e(0), e(3), e(6)];
  const page2 = [e(9), e(12), e(40)];
  const one = F.groupSessions(page1, () => 1);
  const both = F.groupSessions(page1.concat(page2), () => 1);
  check('the first page alone: one session', one.length === 1 && one[0].count === 3);
  check('with the older page: the first session grows, then a new one', both.length === 2 && both[0].count === 5 && both[1].count === 1, both.map((x) => x.count));
  check('it starts where the older page has it', both[0].start === Date.parse(at(12)) && both[0].end === Date.parse(at(0)));
});

await run('session lines: when, and the chapters covered', () => {
  const now = new Date(2026, 8, 29, 21, 30).getTime();
  const s = (d, h1, m1, h2, m2) => ({ start: new Date(2026, 8, d, h1, m1).getTime(), end: new Date(2026, 8, d, h2, m2).getTime() });
  const t1 = new Date(2026, 8, 29, 21, 0).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const t2 = new Date(2026, 8, 29, 21, 20).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  check('today', F.sessionWhen(s(29, 21, 0, 21, 20), now) === 'Today · ' + t1 + ' to ' + t2, F.sessionWhen(s(29, 21, 0, 21, 20), now));
  check('yesterday', F.sessionWhen(s(28, 21, 0, 21, 20), now).startsWith('Yesterday · '));
  check('this week: the weekday', F.sessionWhen(s(25, 21, 0, 21, 20), now).startsWith(new Date(2026, 8, 25).toLocaleDateString([], { weekday: 'short' }) + ' · '));
  check('older: the date', F.sessionWhen(s(2, 21, 0, 21, 20), now).startsWith(new Date(2026, 8, 2).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · '));
  check('one minute: one time', F.sessionWhen(s(29, 21, 0, 21, 0), now) === 'Today · ' + t1);
  const other = { start: new Date(2025, 11, 30, 9, 0).getTime(), end: new Date(2025, 11, 30, 9, 30).getTime() };
  check('another year: with the year', F.sessionWhen(other, now).indexOf('2025') !== -1, F.sessionWhen(other, now));
  check('one chapter: its label', F.sessionChapters({ fromMs: 610000, toMs: 900000 }, MULTI.chapters) === 'Part 2 of 3');
  check('several: their numbers', F.sessionChapters({ fromMs: 10000, toMs: 1600000 }, MULTI.chapters) === 'Chapters 1 to 3');
  check('none known: nothing', F.sessionChapters({ fromMs: null, toMs: null }, MULTI.chapters) === '' && F.sessionChapters({ fromMs: 1, toMs: 2 }, []) === '');
});

await run('T5F2: the range of a session counts places not in this copy by the chapter names they saved', () => {
  const at = (min) => new Date(Date.UTC(2026, 8, 29, 20, 0) - min * 60000).toISOString();
  const e = (min, track, offset, more) => Object.assign({ track, offset_ms: offset, device: 'Chrome on Android', device_id: OTHER, event: 'checkin', at: at(min) }, more);
  // 501 and 503 are here; 502's file is gone (a new part replaced it).
  const place = (track, off) => (track === '501' ? off : track === '503' ? 1500000 + off : null);
  const same = F.groupSessions([
    e(0, '502', 5000, { book_key: '500:1', chapter_label: 'Part 2 of 3' }),
    e(1, '501', 590000, { book_key: '500:1', chapter_label: 'Part 1 of 3' })
  ], place)[0];
  check('labels oldest first, and the gone ones apart', same.labels.join('|') === 'Part 1 of 3|Part 2 of 3' && same.goneLabels.join('|') === 'Part 2 of 3', same);
  check('a gone part: its saved chapter counts', F.sessionRange(same, MULTI.chapters) === 'Chapters 1 to 2', F.sessionRange(same, MULTI.chapters));
  check('sessionChapters alone did not see it', F.sessionChapters(same, MULTI.chapters) === 'Part 1 of 3');
  // An earlier copy's session: none of its places is here.
  const earlier = F.groupSessions([
    e(0, '403', 9000, { book_key: '400:1', chapter_label: 'Part 3 of 3', earlier_copy: true }),
    e(1, '402', 9000, { book_key: '400:1', chapter_label: 'Part 2 of 3', earlier_copy: true }),
    e(2, '401', 9000, { book_key: '400:1', chapter_label: 'Part 1 of 3', earlier_copy: true })
  ], place)[0];
  check('an earlier copy: by its names', F.sessionRange(earlier, MULTI.chapters) === 'Chapters 1 to 3', F.sessionRange(earlier, MULTI.chapters));
  // Names this copy doesn't have: as that copy named them, first to last.
  const named = F.groupSessions([
    e(0, '403', 9000, { book_key: '400:1', chapter_label: 'The Letter', earlier_copy: true }),
    e(1, '402', 9000, { book_key: '400:1', chapter_label: '4', earlier_copy: true }),
    e(2, '401', 9000, { book_key: '400:1', chapter_label: '3', earlier_copy: true })
  ], place)[0];
  check('names not in this copy: first to last', F.sessionRange(named, MULTI.chapters) === 'Chapter 3 to The Letter', F.sessionRange(named, MULTI.chapters));
  check('one name: no range', F.sessionRange({ fromMs: null, toMs: null, labels: ['The Letter', 'The Letter'], goneLabels: ['The Letter', 'The Letter'] }, MULTI.chapters) === '');
  // No saved names: those places are left out.
  const bare = F.groupSessions([e(0, '402', 1), e(1, '401', 2)], () => null)[0];
  check('no names: no range', bare.goneLabels.length === 0 && F.sessionRange(bare, MULTI.chapters) === '', bare);
  const mixedBare = F.groupSessions([e(0, '502', 1), e(1, '501', 590000, { chapter_label: 'Part 1 of 3' })], place)[0];
  check('a gone place without a name adds nothing', F.sessionRange(mixedBare, MULTI.chapters) === '', F.sessionRange(mixedBare, MULTI.chapters));
  // This copy's places alone: today's range.
  check('this copy alone: as before', F.sessionRange({ fromMs: 10000, toMs: 1600000, labels: [], goneLabels: [] }, MULTI.chapters) === 'Chapters 1 to 3' &&
    F.sessionRange({ fromMs: 610000, toMs: 900000, labels: [], goneLabels: [] }, MULTI.chapters) === '' &&
    F.sessionRange({ fromMs: null, toMs: null }, MULTI.chapters) === '' && F.sessionRange(null, MULTI.chapters) === '');
  check('blank names are no names', F.groupSessions([e(0, '402', 1, { chapter_label: '  ' })], place)[0].goneLabels.length === 0);
});

await run('T5F2: history rows show the range of a session whose places are not in this copy', async () => {
  const t = await setup({ wide: true });
  await t.openAt(MULTI.key, '501', 60000, { autoplay: false });
  const e = (agoMs, track, offset, more) => Object.assign(entry(t, agoMs, track, offset), more);
  t.history[''] = {
    entries: [
      e(MIN, '502', 300000, { book_key: '500:1', book_ms: 900000, book_duration_ms: 1800000, chapter_label: 'Part 2 of 3' }),
      e(30 * MIN, '403', 200000, { book_key: '400:1', book_ms: 1700000, book_duration_ms: 1800000, chapter_label: 'Part 3 of 3', earlier_copy: true }),
      e(31 * MIN, '401', 190000, { book_key: '400:1', book_ms: 190000, book_duration_ms: 1800000, chapter_label: 'Part 1 of 3', earlier_copy: true })
    ],
    next_before: null
  };
  t.ui.open();
  t.q('.wsp-slot-history .wsp-action').click();
  await t.clock.advance(50);
  const rows = t.qa('.wsp-hist-row');
  const devs = rows.map((r) => r.querySelector('.wsp-hist-device').textContent);
  check('the earlier copy\'s session shows the chapters it covered', rows.length === 2 && devs[1] === 'Chapters 1 to 3 · Chrome on Android', devs);
  check('in the spoken label', /, Chapters 1 to 3, Chrome on Android, earlier copy$/.test(rows[1].getAttribute('aria-label')), rows[1].getAttribute('aria-label'));
  t.engine.close();
});

await run('T5F3: a history row\'s place and chapters wrap, never cut (the percent ends the line on a phone)', () => {
  const css = readFileSync(process.env.THEME_CSS || join(here, '../../static/css/theme.css'), 'utf8');
  // The last rule naming each wins: it must let the text wrap and show it all.
  for (const cls of ['wsp-hist-what', 'wsp-hist-device']) {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => new RegExp('\\.' + cls + '(?![\\w-])').test(m[1]) && /white-space|overflow|text-overflow/.test(m[2]));
    const last = rules.length ? rules[rules.length - 1][2] : '';
    check(cls + ': wraps', /white-space:\s*normal/.test(last) && /overflow:\s*visible/.test(last) && !/text-overflow:\s*ellipsis/.test(last), last);
  }
});

await run('handoff: only another device, within 24 h, with a place of its own here over 30 s away', () => {
  const now = '2026-09-29T20:00:00.000Z';
  const ago = (ms) => new Date(Date.parse(now) - ms).toISOString();
  const base = () => ({
    book: '500:1',
    resumed: { source: 'web', track: '502', offset_ms: 300000, updated_at: ago(5 * MIN), device: 'Chrome on Android', device_id: OTHER, bookMs: 900000 },
    own: { track: '501', offset_ms: 100000, updated_at: ago(3600000), device: 'Chrome on Linux', own: true, acked: true, bookMs: 100000 },
    now,
    me: { device_id: ME, device: 'Chrome on Linux' }
  });
  const offer = F.handoffOffer(base());
  check('offered', offer && offer.other.bookMs === 900000 && offer.other.device === 'Chrome on Android' && offer.other.agoMs === 5 * MIN && offer.own.bookMs === 100000, offer);
  const with_ = (fn) => { const i = base(); fn(i); return F.handoffOffer(i); };
  check('this device: none', with_((i) => { i.resumed.device_id = ME; }) === null);
  check('the same id with another label is still this device', with_((i) => { i.resumed.device_id = ME; i.resumed.device = 'Firefox on Windows'; }) === null);
  check('another id with the same label is another device', with_((i) => { i.resumed.device = 'Chrome on Linux'; }) !== null);
  check('no ids: the labels decide (same)', with_((i) => { i.resumed.device_id = ''; i.resumed.device = 'Chrome on Linux'; }) === null);
  check('no ids: the labels decide (different)', with_((i) => { i.resumed.device_id = null; }) !== null);
  check('one side without an id: the labels', with_((i) => { i.me.device_id = ''; i.resumed.device = 'Chrome on Linux'; }) === null);
  check('no label and no id: none', with_((i) => { i.resumed.device_id = ''; i.resumed.device = ''; }) === null);
  check('exactly 24 h: offered', with_((i) => { i.resumed.updated_at = ago(86400000); }) !== null);
  check('over 24 h: none', with_((i) => { i.resumed.updated_at = ago(86400001); }) === null);
  check('no server time: none', with_((i) => { i.now = null; }) === null);
  check('a copy stamped ahead of the server counts as now', with_((i) => { i.resumed.updated_at = ago(-5000); }).other.agoMs === 0);
  check('exactly 30 s apart: none', with_((i) => { i.own.bookMs = 870000; }) === null);
  check('30.001 s apart: offered', with_((i) => { i.own.bookMs = 869999; }) !== null);
  check('ahead of it counts too', with_((i) => { i.own.bookMs = 1000000; }) !== null);
  check('no copy here: none', with_((i) => { i.own = null; }) === null);
  check('a copy never played or moved to here: none', with_((i) => { i.own.own = false; }) === null);
  check('resumed from the local copy or Plex: none', with_((i) => { i.resumed.source = 'local'; }) === null && with_((i) => { i.resumed.source = 'plex'; }) === null);
  // A place of this browser's that the server never took (played on offline,
  // after a refused save, or its last answer never came back): always asked,
  // whatever its age or stamp, opening at the web place.
  const webOf = (i) => Object.assign({}, i.resumed, { source: 'web', playable: true });
  const un = (fn) => with_((i) => { i.web = webOf(i); i.own.acked = false; if (fn) fn(i); });
  check('unacknowledged: asked, at the web place', un() && un().at === 'web' && un().other.canGo === true);
  check('unacknowledged and the web copy over 24 h old: still asked', un((i) => { i.resumed.updated_at = ago(25 * 3600000); i.web.updated_at = ago(25 * 3600000); }) !== null);
  check('unacknowledged and newer than the web copy (resumed from it): still asked', un((i) => { i.resumed = Object.assign({}, i.own, { source: 'local' }); }) !== null);
  // T9R7: the open holds at the newer copy by stamp; the question offers the other.
  const newer = un((i) => { i.own.updated_at = ago(2 * MIN); i.resumed = Object.assign({}, i.own, { source: 'local' }); });
  check('unacknowledged and stamped later than the web copy: held at this browser\'s place, Continue offers the web one',
    newer && newer.at === 'own' && newer.other.canGo === true && newer.other.bookMs === 900000 && newer.own.bookMs === 100000, newer);
  const tie = un((i) => { i.own.updated_at = i.web.updated_at; });
  check('stamped the same as the web copy (capped by a refused save): held at the web place', tie && tie.at === 'web', tie);
  const older = un((i) => { i.own.updated_at = new Date(Date.parse(i.web.updated_at) - 1).toISOString(); });
  check('a millisecond older: held at the web place', older && older.at === 'web', older);
  const later1 = un((i) => { i.own.updated_at = new Date(Date.parse(i.web.updated_at) + 1).toISOString(); });
  check('a millisecond newer: held at this browser\'s place', later1 && later1.at === 'own', later1);
  check('no stamp on this browser\'s copy: held at the web place', un((i) => { delete i.own.updated_at; }).at === 'web');
  check('unacknowledged, no server time: asked', un((i) => { i.now = null; }) !== null);
  check('unacknowledged but within 30 s: none', un((i) => { i.own.bookMs = 880000; }) === null);
  check('unacknowledged, the web copy this device\'s: none', un((i) => { i.web.device_id = ME; }) === null);
  check('acknowledged, over 24 h: none', with_((i) => { i.web = webOf(i); i.resumed.updated_at = ago(25 * 3600000); i.web.updated_at = ago(25 * 3600000); }) === null);
  const blocked = un((i) => { i.web.playable = false; });
  check('the web place can\'t play here: open at this browser\'s own, no Continue', blocked && blocked.at === 'own' && blocked.other.canGo === false, blocked);
  check('the question', F.handoffMessage(offer) === 'Continue from 15:00 (Chrome on Android, 5 min ago)?', F.handoffMessage(offer));
  const twin = with_((i) => { i.resumed.device = 'Chrome on Linux'; });
  check('another device with this one\'s label is "another <label>"', twin.other.sameLabel === true &&
    F.handoffMessage(twin) === 'Continue from 15:00 (another Chrome on Linux, 5 min ago)?', F.handoffMessage(twin));
  check('a different label is as it is', offer.other.sameLabel === false);
  check('an unnamed device', F.handoffMessage({ other: { bookMs: 3723000, device: '', agoMs: 30000 } }) === 'Continue from 1:02:03 (another device, just now)?');
  check('ago', F.formatAgo(59999) === 'just now' && F.formatAgo(60000) === '1 min ago' && F.formatAgo(3599999) === '59 min ago' &&
    F.formatAgo(3600000) === '1 h ago' && F.formatAgo(86400000) === '1 day ago' && F.formatAgo(3 * 86400000) === '3 days ago' && F.formatAgo(NaN) === 'just now');
});

// A page with a local copy of its own and an id: the handoff's surroundings.
async function handoffSetup(o = {}) {
  const storage = memoryStorage();
  const t = await setup(Object.assign({ storage, identity: ID, deviceId: ME }, o));
  t.storage = storage;
  t.setOwn = (track, offset, agoMs, own = true, book = MULTI.key, acked = true) => storage.setItem('ws-player:place:' + ID + ':' + book, JSON.stringify({
    track, offset_ms: offset, duration_ms: 900000, updated_at: new Date(t.serverNow() - agoMs).toISOString(), device: 'Test on Linux', own, acked
  }));
  t.other = (track, offset, agoMs, extra = {}) => Object.assign({ track, offset_ms: offset, duration_ms: 900000, updated_at: new Date(t.serverNow() - agoMs).toISOString(), device: 'Chrome on Android', device_id: OTHER, source: 'web' }, extra);
  t.button = (label) => t.qa('.wsp-notice-btn').find((b) => b.textContent === label) || null;
  t.prompts = () => t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
  t.open = async (key = MULTI.key) => {
    const p = t.engine.open(key);
    await t.clock.advance(300);
    await p;
  };
  return t;
}

await run('handoff at open: held at the other device\'s place, Continue plays from there', async () => {
  const t = await handoffSetup();
  t.setOwn('501', 100000, 3600000);
  t.places = { web: t.other('502', 300000, 5 * MIN) };
  await t.open();
  check('held, not playing', !t.st().playing && t.st().book === MULTI.key, t.st().playing);
  check('at the other device\'s place', bookMs(t) === 900000, bookMs(t));
  check('the question', t.prompts().join() === 'Continue from 15:00 (Chrome on Android, 5 min ago)?', t.prompts());
  check('its buttons', t.qa('.wsp-prompt .wsp-notice-btn').map((b) => b.textContent).join() === 'Continue,Start from here');
  check('nothing sent while it asks', t.posts.length === 0, t.posts);
  t.button('Continue').click();
  await t.clock.advance(1500);
  check('playing on from there', t.st().playing && bookMs(t) > 880000 && bookMs(t) < 902000, bookMs(t));
  check('the question is gone', t.prompts().length === 0);
  check('saved there, with this device\'s id', t.posts.length > 0 && t.posts.every((b) => b.track === '502' && b.offset_ms >= 300000 && b.device_id === ME), t.posts.map((b) => [b.event, b.track, b.offset_ms, b.device_id]));
  t.engine.close();
});

await run('handoff at open: Start from here moves to this device\'s place and saves it as the newest', async () => {
  const t = await handoffSetup();
  t.setOwn('501', 100000, 3600000);
  t.places = { web: t.other('502', 300000, 5 * MIN) };
  await t.open();
  t.button('Start from here').click();
  check('a move of the listener\'s own, saved at once', t.posts.length >= 1 && t.posts[0].track === '501' && t.posts[0].offset_ms === 100000 && t.posts[0].device_id === ME, t.posts.map((b) => [b.event, b.track, b.offset_ms]));
  await t.clock.advance(1500);
  check('playing from here, nothing rewound', t.st().playing && bookMs(t) >= 100000 && bookMs(t) < 102000, bookMs(t));
  check('every save from here on', t.posts.every((b) => b.track === '501' && b.offset_ms >= 100000), t.posts.map((b) => [b.event, b.track, b.offset_ms]));
  check('the question is gone', t.prompts().length === 0);
  check('Undo can take it back to the other device\'s place', !!t.undoBtn() && t.notices().indexOf('Jumped back 13 min.') !== -1, t.notices());
  t.engine.close();
});

await run('handoff at open: Play pressed instead plays from the other device\'s place', async () => {
  const t = await handoffSetup();
  t.setOwn('501', 100000, 3600000);
  t.places = { web: t.other('502', 300000, 2 * MIN) };
  await t.open();
  check('asked', t.prompts().length === 1);
  t.q('.wsp-play-sm').click();
  await t.clock.advance(1500);
  check('playing from the other device\'s place', t.st().playing && bookMs(t) > 880000, bookMs(t));
  check('the question is gone', t.prompts().length === 0);
  t.engine.close();
});

for (const [what, arrange] of [
  ['this device saved it', (t) => { t.setOwn('501', 100000, 3600000); t.places = { web: t.other('502', 300000, 5 * MIN, { device_id: ME }) }; }],
  ['it is over 24 h old', (t) => { t.setOwn('501', 100000, 2 * 86400000); t.places = { web: t.other('502', 300000, 86400000 + 1000) }; }],
  ['this device has no place of its own', (t) => { t.places = { web: t.other('502', 300000, 5 * MIN) }; }],
  ['this device only ever opened it', (t) => { t.setOwn('501', 100000, 3600000, false); t.places = { web: t.other('502', 300000, 5 * MIN) }; }],
  ['the places are 30 s apart', (t) => { t.setOwn('502', 270000, 3600000); t.places = { web: t.other('502', 300000, 5 * MIN) }; }],
  ['this device\'s place is the newest', (t) => { t.setOwn('501', 100000, 60000); t.places = { web: t.other('502', 300000, 5 * MIN) }; }],
  ['Plex has a newer place of its own', (t) => {
    t.setOwn('501', 100000, 3600000);
    t.places = { web: t.other('502', 300000, 5 * MIN), plex: { track: '502', offset_ms: 400000, duration_ms: 900000, updated_at: new Date(t.serverNow() - 60000).toISOString(), device: 'Plex', source: 'plex' } };
  }]
]) {
  await run(`no handoff when ${what}: it plays at once`, async () => {
    const t = await handoffSetup();
    arrange(t);
    await t.open();
    check('no question', t.prompts().length === 0, t.prompts());
    check('playing', t.st().playing);
    t.engine.close();
  });
}

// ---------------------------------------------------------------------------
// Two devices on one server (spec 11b: the server refuses a stale place)
// ---------------------------------------------------------------------------

const PHONE_ID = 'a'.repeat(20);
const DESK_ID = 'b'.repeat(20);
async function twoDevices(o = {}) {
  const clock = fakeClock();
  const server = casServer(clock);
  const page = async (psid, device, deviceId, storage, prefs) => {
    const store = storage || memoryStorage();
    const t = await setup({ clock, server, psid, device, deviceId, storage: store, identity: ID, prefs, wall: o.wall });
    t.storage = store;
    t.prompts = () => t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
    t.buttons = () => t.qa('.wsp-prompt .wsp-notice-btn').map((b) => b.textContent);
    t.button = (label) => t.qa('.wsp-notice-btn').find((b) => b.textContent === label) || null;
    t.open = async (key = MULTI.key, extra) => {
      const p = t.engine.open(key, extra);
      await clock.advance(300);
      await p;
    };
    return t;
  };
  const phone = await page('psid-phone', 'Chrome on Android', PHONE_ID, null, o.phonePrefs);
  const desk = await page('psid-desk', 'Chrome on Linux', DESK_ID);
  const row = (book = MULTI.key) => server.rows[book] || null;
  const since = (n) => server.log.slice(n).map((e) => [e.result, e.kind, e.event, e.track, e.offset_ms, e.device_id && e.device_id[0]]);
  return { clock, server, phone, desk, page, row, since };
}

for (const how of ['Play', 'Retry', 'lock-screen Play']) {
  for (const whilePlaying of [true, false]) {
    await run(`a phone back from an outage 10 h later (${how}, ${whilePlaying ? 'playing' : 'paused'} when it failed) is refused: the desktop's place survives`, async () => {
      const { clock, phone, desk, row, since } = await twoDevices();
      await phone.openAt(MULTI.key, '501', 100000);
      await clock.advance(20000);
      if (!whilePlaying) { phone.engine.pause(); await clock.advance(1500); }
      check('the phone\'s place is stored', row().device_id === PHONE_ID, row());
      // The phone loses the network: saves fail and the stream stops.
      phone.offline = true;
      phone.down = true;
      phone.audioEl.error = { code: 2 };
      phone.audioEl.fire('error');
      await clock.advance(30000);
      check('the phone is in its error state', !!phone.st().error, phone.st().error);
      await clock.advance(3 * MIN);
      // The desktop resumes the phone's place and listens on to 20:00, then pauses.
      await desk.open();
      desk.engine.seek(1200000);
      await clock.advance(5000);
      desk.engine.pause();
      await clock.advance(2000);
      const deskRow = Object.assign({}, row());
      check('the desktop\'s place is stored', deskRow.device_id === DESK_ID && deskRow.track === '502', deskRow);
      await clock.advance(10 * 3600000);
      phone.offline = false;
      phone.down = false;
      const n = desk.server.log.length;
      if (how === 'Play') phone.engine.play();
      else if (how === 'Retry') { const b = phone.qa('.wsp-notice-btn').find((x) => x.textContent === 'Retry'); check('a Retry button', !!b); if (b) b.click(); }
      else phone.ms.handlers.get('play')();
      await clock.advance(6000);
      check('the server refused the phone', since(n).some((e) => e[0] === 'conflict') && since(n).every((e) => e[0] !== 'stored'), since(n));
      check('the desktop\'s place survives', row().device_id === DESK_ID && row().offset_ms === deskRow.offset_ms && row().updated_at === deskRow.updated_at, row());
      check('the phone paused there', !phone.st().playing, phone.st().playing);
      check('and asks', /^Continue from 20:0\d \(Chrome on Linux, 10 h ago\)\?$/.test(phone.prompts().join()), phone.prompts());
      check('Continue or keep listening here', phone.buttons().join() === 'Continue,Keep listening here', phone.buttons());
      phone.engine.close();
      desk.engine.close();
    });
  }
}

async function questionLeftOpen() {
  const d = await twoDevices();
  const { clock, phone, desk } = d;
  // The phone listened at 1:40 of part 1 and paused.
  await phone.openAt(MULTI.key, '501', 100000);
  await clock.advance(3000);
  phone.engine.pause();
  await clock.advance(1500);
  phone.engine.close();
  await clock.advance(3600000);
  // The desktop went on to 15:00 (part 2), then paused.
  await desk.open();
  desk.engine.seek(900000);
  await clock.advance(2000);
  desk.engine.pause();
  await clock.advance(1500);
  await clock.advance(2 * MIN);
  return d;
}

await run('the open question: asked, and the phone\'s own place stays in its local copy until it answers', async () => {
  const { phone, row } = await questionLeftOpen();
  const own = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
  check('the phone\'s own copy', own.track === '501' && own.own === true, own);
  await phone.open();
  check('asked', /^Continue from 15:0\d \(Chrome on Linux, 2 min ago\)\?$/.test(phone.prompts().join()), phone.prompts());
  const kept = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
  check('the local copy is still the phone\'s own place', kept.track === '501' && kept.offset_ms === own.offset_ms && kept.own === true, kept);
  // The tab is killed while it asks: the next open asks again, Start from here still there.
  phone.engine.close();
  await phone.clock.advance(1000);
  await phone.open();
  check('asked again', phone.prompts().length === 1 && phone.buttons().join() === 'Continue,Start from here', [phone.prompts(), phone.buttons()]);
  phone.button('Start from here').click();
  await phone.clock.advance(1500);
  check('back at its own place, saved', row().device_id === PHONE_ID && row().track === '501', row());
  phone.engine.close();
});

for (const how of ['Continue', 'Play button', 'lock-screen Play']) {
  await run(`the open question left showing while the desktop goes on, then ${how}: refused, the newer place survives`, async () => {
    const { clock, phone, desk, row, since } = await questionLeftOpen();
    await phone.open();
    check('asked', phone.prompts().length === 1);
    // Half an hour with the question showing; the desktop goes on to 26:40.
    await clock.advance(30 * MIN);
    desk.engine.seek(1600000);
    await desk.engine.play();
    await clock.advance(2000);
    desk.engine.pause();
    await clock.advance(1500);
    const deskRow = Object.assign({}, row());
    const n = phone.server.log.length;
    if (how === 'Continue') phone.button('Continue').click();
    else if (how === 'Play button') phone.q('.wsp-play-sm').click();
    else phone.ms.handlers.get('play')();
    await clock.advance(3000);
    check('refused', since(n).some((e) => e[0] === 'conflict') && since(n).every((e) => e[0] !== 'stored'), since(n));
    check('the desktop\'s newer place survives', row().updated_at === deskRow.updated_at && row().device_id === DESK_ID, row());
    check('the phone pauses and asks about the newer place', !phone.st().playing && /^Continue from 26:4\d \(Chrome on Linux, just now\)\?$/.test(phone.prompts().join()), [phone.st().playing, phone.prompts()]);
    phone.engine.close();
    desk.engine.close();
  });
}

async function staleAfterPause() {
  const d = await twoDevices();
  const { clock, phone, desk } = d;
  await phone.openAt(MULTI.key, '502', 300000);
  await clock.advance(3000);
  phone.engine.pause();
  await clock.advance(1500);
  // The desktop picks it up and goes on to 26:40, then pauses.
  await desk.open();
  desk.engine.seek(1600000);
  await clock.advance(2000);
  desk.engine.pause();
  await clock.advance(1500);
  await clock.advance(6 * MIN);
  return d;
}

await run('a lock-screen Play on a stale page: refused and asked; a second one plays but saves nothing', async () => {
  const { clock, phone, row, since } = await staleAfterPause();
  const deskRow = Object.assign({}, row());
  const n = phone.server.log.length;
  phone.ms.handlers.get('play')();
  await clock.advance(1500);
  check('refused, paused, asked', since(n).map((e) => e[0]).join() === 'conflict' && !phone.st().playing && phone.prompts().length === 1, [since(n), phone.st().playing, phone.prompts()]);
  const local0 = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
  phone.ms.handlers.get('play')();
  await clock.advance(20000);
  check('the second plays', phone.st().playing);
  check('and nothing more goes to the server', phone.server.log.length === n + 1, since(n));
  const local1 = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
  check('the local copy follows the place', local1.offset_ms > local0.offset_ms, [local0.offset_ms, local1.offset_ms]);
  check('the question stays', phone.prompts().length === 1);
  check('the desktop\'s place survives', row().updated_at === deskRow.updated_at, row());
  phone.engine.close();
  check('closing sends nothing either', phone.server.log.length === n + 1, since(n));
});

for (const [label, prefs, gap] of [['smart rewind off, 6 min stale', { skip_s: 10, speed: 1, smart_rewind: false }, 6 * MIN], ['smart rewind on, 6 min stale', undefined, 6 * MIN], ['smart rewind on, just paused', undefined, 0]]) {
  await run(`a refused stale Play left unanswered (${label}): the next open asks, and the newer place survives`, async () => {
    const d = await twoDevices({ phonePrefs: prefs });
    const { clock, phone, desk, row, since, page, server } = d;
    await phone.openAt(MULTI.key, '502', 300000);
    await clock.advance(3000);
    phone.engine.pause();
    await clock.advance(1500);
    await desk.open();
    desk.engine.seek(1600000);
    await clock.advance(1500);
    desk.engine.pause();
    await clock.advance(1500);
    await clock.advance(gap);
    const deskRow = Object.assign({}, row());
    // A stray Play (a headset reconnecting); the answer takes 300 ms, and
    // playback moves the place meanwhile.
    phone.postDelay = 300;
    const n = server.log.length;
    phone.ms.handlers.get('play')();
    await clock.advance(1500);
    check('refused and asked', since(n).map((e) => e[0]).join() === 'conflict' && phone.prompts().length === 1, [since(n), phone.prompts()]);
    const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
    check('the local copy is stamped no later than the desktop\'s place', Date.parse(local.updated_at) <= Date.parse(deskRow.updated_at), [local.updated_at, deskRow.updated_at]);
    phone.engine.close();                  // never answered
    await clock.advance(10 * MIN);
    const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage, prefs);
    const m = server.log.length;
    await again.open();
    await clock.advance(2000);
    check('the next open resumes the desktop\'s place and asks', again.st().resumedFrom && again.st().resumedFrom.source === 'web' && !again.st().playing &&
      again.buttons().join() === 'Continue,Start from here', [again.st().resumedFrom, again.prompts(), again.buttons()]);
    check('nothing pushed', since(m).length === 0, since(m));
    check('the desktop\'s place survives', row().updated_at === deskRow.updated_at && row().device_id === DESK_ID, row());
    again.engine.close();
    desk.engine.close();
  });
}

// Fix round 3: a place the server never took is never overwritten or pushed without asking.
const OFF = { skip_s: 10, speed: 1, smart_rewind: false };
async function staleFor(prefs, gap) {
  const d = await twoDevices({ phonePrefs: prefs });
  const { clock, phone, desk } = d;
  await phone.openAt(MULTI.key, '502', 300000);
  await clock.advance(3000);
  phone.engine.pause();
  await clock.advance(1500);
  await desk.open();
  desk.engine.seek(1600000);
  await clock.advance(1500);
  desk.engine.pause();
  await clock.advance(1500);
  await clock.advance(gap);
  return d;
}
async function reopenAsks(d, prefs, what) {
  const { clock, phone, page, row, since, server } = d;
  await clock.advance(10 * MIN);
  phone.postDelay = 0; phone.hold = false; phone.offline = false;
  const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage, prefs);
  const m = server.log.length;
  await again.open();
  await clock.advance(2000);
  check(`${what}: the next open asks`, again.prompts().length === 1 && !again.st().playing && again.buttons().indexOf('Start from here') !== -1, [again.prompts(), again.buttons(), again.st().resumedFrom]);
  check(`${what}: nothing is pushed`, since(m).length === 0, since(m));
  again.asked = again.prompts();
  again.heldAt = again.st().position;
  again.engine.close();
  return again;
}

for (const [rtt, closeAt] of [[300, 260], [3000, 1500]]) {
  for (const how of ['close', 'open another book']) {
    for (const [plabel, prefs, gap] of [['rewind off, 6 min', OFF, 6 * MIN], ['rewind on, just paused', undefined, 0]]) {
      await run(`C1: the player ${how === 'close' ? 'closed' : 'on another book'} ${closeAt} ms into a ${rtt} ms round trip (${plabel}): the late 409 still caps; the next open asks`, async () => {
        const d = await staleFor(prefs, gap);
        const { clock, phone, row, since, server } = d;
        const deskRow = Object.assign({}, row());
        phone.postDelay = rtt;
        const n = server.log.length;
        phone.ms.handlers.get('play')();
        await clock.advance(closeAt);
        if (how === 'close') phone.engine.close();
        else { const p = phone.engine.open(SPAN.key, { at: { track: '511', offset_ms: 1000 }, autoplay: false }); await clock.advance(300); await p; }
        await clock.advance(rtt + 1000);
        check('refused', since(n).some((e) => e[0] === 'conflict') && since(n).every((e) => e[0] !== 'stored' || e[3] === '511'), since(n));
        const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
        check('the local copy: capped, not acknowledged', Date.parse(local.updated_at) <= Date.parse(deskRow.updated_at) && local.acked === false, [local, deskRow.updated_at]);
        phone.engine.close();
        const again = await reopenAsks(d, prefs, 'C1');
        // Capped, so never newer than the desktop's place (T9R7): held there.
        check('held at the desktop\'s place', again.heldAt && again.heldAt.track === deskRow.track && again.heldAt.offset_ms === deskRow.offset_ms, [again.heldAt, deskRow]);
        check('the desktop\'s place survives', row().updated_at === deskRow.updated_at && row().device_id === DESK_ID, row());
        d.desk.engine.close();
      });
    }
  }
}

for (const playMs of [250, 1500]) {
  await run(`C2: the page killed ${playMs} ms into the Play, unanswered (its beacon's answer never read): the next open asks`, async () => {
    const d = await staleFor(OFF, 6 * MIN);
    const { clock, phone, row, since, server } = d;
    const deskRow = Object.assign({}, row());
    phone.hold = true;
    const n = server.log.length;
    phone.ms.handlers.get('play')();
    await clock.advance(playMs);
    // The page goes: its pagehide beacon, whose answer no one reads.
    check('the beacon goes', phone.saver.flush('beacon', 'leave') === true);
    await clock.advance(100);
    check('both refused at the server', since(n).map((e) => e[0] + ':' + e[1]).join() === 'conflict:fetch,conflict:beacon', since(n));
    const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
    check('the local copy: newer, but not acknowledged', local.acked === false, local);
    await reopenAsks(d, OFF, 'C2');
    check('the desktop\'s place survives', row().updated_at === deskRow.updated_at, row());
    d.desk.engine.close();
  });
}

/* T9R6: a stray Play under the drift allowance on a stale page (the phone
   paused and saved 5:03; the desktop has since saved 26:41). The Play's
   answer never comes (the page dies), or the phone has no signal and the
   player is closed. The place a moment past the phone's old save is not the
   server's: the next open asks, and nothing overwrites the desktop's row. */
const DRIFT_CASES = [];
for (const playMs of [250, 1500]) {
  DRIFT_CASES.push([`D1 (${playMs} ms, pagehide beacon, killed)`, OFF, playMs, 'kill', { beacon: true }]);
  DRIFT_CASES.push([`D2 (${playMs} ms, no beacon, killed)`, OFF, playMs, 'kill', {}]);
  DRIFT_CASES.push([`D3 (${playMs} ms, Pause, 20 ms drift, beacon, killed)`, OFF, playMs, 'kill', { beacon: true, pause: true }]);
  DRIFT_CASES.push([`D5 (${playMs} ms offline, closed)`, OFF, playMs, 'offline', {}]);
  DRIFT_CASES.push([`D5b (${playMs} ms offline, Pause, 20 ms drift, closed)`, OFF, playMs, 'offline', { pause: true }]);
}
for (const playMs of [10250, 12000]) {
  DRIFT_CASES.push([`D6 (${playMs} ms offline, smart rewind on, closed)`, { skip_s: 10, speed: 1, smart_rewind: true }, playMs, 'offline', {}]);
}
for (const [label, prefs, playMs, how, o] of DRIFT_CASES) {
  await run(`a stray Play on a stale page, ${label}: the next open asks and the desktop's place survives`, async () => {
    const d = await staleFor(prefs, 6 * MIN);
    const { clock, phone, row, since, server } = d;
    const deskRow = Object.assign({}, row());
    const before = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
    check('the phone\'s saved pause is acknowledged', before.acked === true, before);
    const n = server.log.length;
    if (how === 'kill') phone.hold = true;  // the Play's answer is still to come when the page dies
    else phone.offline = true;              // no signal
    phone.ms.handlers.get('play')();        // a headset reconnects
    await clock.advance(playMs);
    if (o.pause) {
      phone.engine.pause();
      await clock.advance(50);
      phone.audioEl._t += 0.02;              // the element's late timeupdate
      phone.audioEl.fire('timeupdate');
      await clock.advance(200);
    }
    if (o.beacon) phone.saver.flush('beacon', 'leave');
    await clock.advance(10);
    if (how === 'kill') {
      phone.offline = true;
      phone.hold = false;
      phone.audioEl.gen += 1;
      phone.audioEl.ticking = false;
      phone.audioEl.paused = true;
    }
    phone.engine.close();
    await clock.advance(20000);
    check('nothing stored', since(n).every((e) => e[0] !== 'stored'), since(n));
    const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
    check('the local copy: not acknowledged', local.acked === false, local);
    const again = await reopenAsks(d, prefs, label);
    check('Continue offers the desktop\'s place', /^Continue from 26:4\d \(Chrome on Linux, \d+ min ago\)\?$/.test(again.asked.join()), again.asked);
    // Stamped after the desktop's save, but under 10 s of book time past its
    // last acked place (a stray Play's moment): held at the desktop's place.
    check('held at the desktop\'s place', again.heldAt && again.heldAt.track === deskRow.track && again.heldAt.offset_ms === deskRow.offset_ms, [again.heldAt, deskRow]);
    check('the desktop\'s place survives', row().updated_at === deskRow.updated_at && row().device_id === DESK_ID, row());
    // Then a plain Play at the next open (the lock screen or the bar) goes on
    // from the desktop's place: the stale place is never stored.
    for (const act of ['lock-screen Play', 'Play button']) {
      const next = await d.page('psid-phone-' + act.length, 'Chrome on Android', PHONE_ID, phone.storage, prefs);
      const m = server.log.length;
      await next.open();
      await clock.advance(1000);
      if (act === 'lock-screen Play') next.ms.handlers.get('play')();
      else next.q('.wsp-play-sm').click();
      await clock.advance(5000);
      next.engine.pause();
      await clock.advance(1500);
      check(`${act}: from the desktop's place, the stale place never stored`, since(m).length > 0 && since(m).every((e) => e[0] === 'stored' && e[3] === deskRow.track && e[4] >= deskRow.offset_ms - 30000) &&
        row().track === deskRow.track && row().offset_ms >= deskRow.offset_ms, [since(m), row(), deskRow]);
      next.engine.close();
      if (act === 'lock-screen Play') {
        // Put the desktop's row back as it was for the second act.
        server.rows[MULTI.key] = Object.assign({}, deskRow);
        phone.storage.setItem('ws-player:place:' + ID + ':' + MULTI.key, JSON.stringify(local));
      }
    }
    d.desk.engine.close();
  });
}

/* T9R8: a paused move on the stale page carries its own save, so the place
   it writes is never acknowledged before that save is stored, even within
   the drift allowance or exactly on the saved place. Offline, then closed:
   the next open asks and the desktop's place survives. */
for (const [label, move] of [
  ['a one-step scrubber nudge forward', (phone) => { const r = phone.q('.wsp-range'); r.value = String(Number(r.value) + 1); r.dispatchEvent(new phone.win.Event('change')); }],
  ['a one-step scrubber nudge back', (phone) => { const r = phone.q('.wsp-range'); r.value = String(Number(r.value) - 1); r.dispatchEvent(new phone.win.Event('change')); }],
  ['a lock-screen seekto 600 ms on', (phone, saved) => phone.ms.handlers.get('seekto')({ seekTime: (600000 + saved + 600) / 1000 })],
  ['a lock-screen seekto 1000 ms on', (phone, saved) => phone.ms.handlers.get('seekto')({ seekTime: (600000 + saved + 1000) / 1000 })],
  ['a lock-screen seekto onto the saved place itself', (phone, saved) => phone.ms.handlers.get('seekto')({ seekTime: (600000 + saved) / 1000 })]
]) {
  await run(`a paused move on a stale page (${label}), offline, closed: the next open asks and the desktop's place survives`, async () => {
    const d = await staleFor(OFF, 0);
    const { clock, phone, row, since, server } = d;
    const saved = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key)).offset_ms;
    phone.audioEl._t += 0.02;                // the element's late timeupdate after the pause
    phone.audioEl.fire('timeupdate');
    await clock.advance(200);
    const drifted = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
    check('the drift is still the saved place', drifted.acked === true && drifted.offset_ms === saved + 20, drifted);
    await clock.advance(6 * MIN);
    const deskRow = Object.assign({}, row());
    const n = server.log.length;
    phone.offline = true;
    move(phone, saved);
    await clock.advance(1000);
    const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
    check('the move is written, not acknowledged', local.acked === false && local.offset_ms !== saved + 20, local);
    phone.engine.close();
    await clock.advance(20000);
    check('nothing stored', since(n).every((e) => e[0] !== 'stored'), since(n));
    const again = await reopenAsks(d, OFF, label);
    check('held at the desktop\'s place', again.heldAt && again.heldAt.track === deskRow.track && again.heldAt.offset_ms === deskRow.offset_ms, [again.heldAt, deskRow]);
    check('the desktop\'s place survives', row().updated_at === deskRow.updated_at && row().device_id === DESK_ID, row());
    d.desk.engine.close();
  });
}

/* Real offline listening on a stale page (a Play, a move to 26:00 and 2 min
   on): far past its last acked place and newer by stamp, so the next open
   holds at it and a plain Play goes on from there. */
await run('offline listening on a stale page, well past its acked place: held at it, and a plain Play keeps it', async () => {
  const d = await staleFor(OFF, 6 * MIN);
  const { clock, phone, page, row, since, server } = d;
  phone.offline = true;
  phone.ms.handlers.get('play')();
  await clock.advance(3000);
  phone.engine.seek(1560000);
  await clock.advance(2 * MIN);
  phone.engine.pause();
  await clock.advance(1500);
  const reached = Object.assign({}, phone.st().position);
  phone.engine.close();
  await clock.advance(20000);
  phone.offline = false;
  await clock.advance(30 * MIN);
  const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage, OFF);
  const n = server.log.length;
  await again.open();
  await clock.advance(1000);
  check('held at the offline place, asked', !again.st().playing && again.st().position.track === reached.track && again.st().position.offset_ms === reached.offset_ms &&
    again.prompts().length === 1 && since(n).length === 0, [again.st().position, reached, again.prompts(), since(n)]);
  again.q('.wsp-play-sm').click();
  await clock.advance(5000);
  again.engine.pause();
  await clock.advance(1500);
  check('a plain Play stores it and goes on', since(n)[0] && since(n)[0][0] === 'stored' && since(n)[0][3] === reached.track && since(n)[0][4] === reached.offset_ms &&
    row().device_id === PHONE_ID && row().offset_ms >= reached.offset_ms + 4000, [since(n), row()]);
  again.engine.close();
});

/* T9R7: listening offline the server never heard of is newer by stamp than
   the desktop's place: the next open holds at it, a plain Play goes on from
   it, and the question offers the desktop's place. */
for (const how of ['Play button', 'lock-screen Play', 'Continue']) {
  await run(`offline listening newer than the other device's place: held at it, then ${how}`, async () => {
    const { clock, phone, desk, page, row, since, server } = await twoDevices({ phonePrefs: OFF });
    await desk.openAt(MULTI.key, '503', 100000);
    await clock.advance(2000);
    desk.engine.pause();
    await clock.advance(1500);
    desk.engine.close();
    const deskRow = Object.assign({}, row());
    await clock.advance(3600000);
    // The phone reads the book at home, then listens 2 min with no signal.
    phone.offline = true;
    await phone.open();
    await clock.advance(2 * MIN);
    phone.engine.pause();
    await clock.advance(1500);
    const reached = Object.assign({}, phone.st().position);
    phone.engine.close();
    await clock.advance(20000);
    check('nothing reached the server', row().updated_at === deskRow.updated_at, row());
    const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
    check('the local copy: the offline place, newer, not acknowledged', local.offset_ms === reached.offset_ms && local.acked === false &&
      Date.parse(local.updated_at) > Date.parse(deskRow.updated_at), [local, deskRow]);
    phone.offline = false;
    await clock.advance(2 * 3600000);
    const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage, OFF);
    const n = server.log.length;
    await again.open();
    await clock.advance(1000);
    check('held at the offline place, not playing', !again.st().playing && again.st().position.track === reached.track &&
      again.st().position.offset_ms === reached.offset_ms && again.st().resumedFrom.source === 'local', [again.st().position, again.st().resumedFrom]);
    check('the question offers the desktop\'s place', /^Continue from 26:4\d \(Chrome on Linux, 3 h ago\)\?$/.test(again.prompts().join()) &&
      again.buttons().join() === 'Continue,Start from here', [again.prompts(), again.buttons()]);
    check('nothing sent while it asks', since(n).length === 0, since(n));
    if (how === 'Play button') again.q('.wsp-play-sm').click();
    else if (how === 'lock-screen Play') again.ms.handlers.get('play')();
    else again.button('Continue').click();
    await clock.advance(5000);
    again.engine.pause();
    await clock.advance(1500);
    const first = since(n)[0];
    if (how === 'Continue') {
      check('Continue: at the desktop\'s place, saved as the phone\'s', first && first[0] === 'stored' && first[3] === '503' && first[4] >= 100000 && first[4] < 110000 &&
        row().device_id === PHONE_ID && row().track === '503', [since(n), row()]);
    } else {
      check('played on from the offline place, nothing lost', first && first[0] === 'stored' && first[3] === reached.track && first[4] === reached.offset_ms &&
        row().device_id === PHONE_ID && row().offset_ms >= reached.offset_ms + 4000, [since(n), row(), reached]);
      check('the question is gone', again.prompts().length === 0, again.prompts());
    }
    again.engine.close();
  });
}

await run('C3: a failed Play, then a close online: the last save\'s 409 is read and caps', async () => {
  const d = await staleFor(OFF, 6 * MIN);
  const { clock, phone, row, since, server } = d;
  const deskRow = Object.assign({}, row());
  phone.offline = true;
  const n = server.log.length;
  phone.ms.handlers.get('play')();
  await clock.advance(5000);
  phone.offline = false;
  phone.engine.close();
  await clock.advance(2000);
  check('the last save was refused', since(n).length === 1 && since(n)[0][0] === 'conflict' && since(n)[0][2] === 'leave', since(n));
  const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
  check('the local copy: capped, not acknowledged', Date.parse(local.updated_at) <= Date.parse(deskRow.updated_at) && local.acked === false, [local, deskRow.updated_at]);
  await reopenAsks(d, OFF, 'C3');
  check('the desktop\'s place survives', row().updated_at === deskRow.updated_at, row());
  d.desk.engine.close();
});

for (const how of ['UI Play', 'lock-screen Play']) {
  for (const hours of [5, 25]) {
    await run(`played on without answering (${how}), reopened ${hours} h later: asked, nothing lost`, async () => {
      const { clock, phone, desk, page, row, since, server } = await twoDevices();
      await phone.openAt(LONG.key, '531', 3600000);
      await clock.advance(3000);
      phone.engine.pause();
      await clock.advance(1500);
      await desk.open(LONG.key);
      await clock.advance(5 * MIN);
      desk.engine.pause();
      await clock.advance(1500);
      desk.engine.close();
      const deskRow = Object.assign({}, row(LONG.key));
      await clock.advance(2 * 3600000);
      phone.ms.handlers.get('play')();
      await clock.advance(1500);
      check('refused and asked', phone.prompts().length === 1 && !phone.st().playing);
      if (how === 'UI Play') phone.q('.wsp-play-sm').click(); else phone.ms.handlers.get('play')();
      await clock.advance(10 * MIN);
      phone.engine.pause();
      await clock.advance(1500);
      const reached = phone.st().position.offset_ms;
      phone.engine.close();
      await clock.advance(hours * 3600000 - 2 * 3600000 - 10 * MIN);
      const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage);
      const m = server.log.length;
      const q = again.engine.open(LONG.key, { autoplay: false });
      await clock.advance(300);
      await q;
      await clock.advance(2000);
      check('asked, with Start from here', again.prompts().length === 1 && again.buttons().join() === 'Continue,Start from here', [again.prompts(), again.buttons()]);
      const local = JSON.parse(again.storage.getItem('ws-player:place:' + ID + ':' + LONG.key));
      check('the played-on place is still in the local copy', local.offset_ms === reached, [local.offset_ms, reached]);
      check('nothing sent; the desktop\'s place survives', since(m).length === 0 && row(LONG.key).updated_at === deskRow.updated_at, [since(m), row(LONG.key)]);
      again.button('Start from here').click();
      await clock.advance(1500);
      check('Start from here takes it back', again.st().position.offset_ms >= reached && row(LONG.key).device_id === PHONE_ID && row(LONG.key).offset_ms >= reached, [again.st().position, row(LONG.key)]);
      again.engine.close();
    });
  }
}

await run('played on without answering where the other place can\'t play here: asked with Start from here and Not now, nothing lost', async () => {
  const { clock, server, phone, page, row, since } = await twoDevices({ phonePrefs: OFF });
  await phone.openAt(MIXED.key, '523', 100000);
  await clock.advance(3000);
  phone.engine.pause();
  await clock.advance(1500);
  server.rows[MIXED.key] = { track: '522', offset_ms: 10000, duration_ms: 20000, updated_at: server.at(), device: 'Safari on macOS', device_id: 'd'.repeat(20), psid: 'psid-mac', seq: 3 };
  await clock.advance(5000);
  await phone.engine.play();
  await clock.advance(1500);
  check('refused and asked', phone.buttons().join() === 'Keep listening here', phone.buttons());
  phone.q('.wsp-play-sm').click();
  await clock.advance(5 * MIN);
  phone.engine.pause();
  await clock.advance(1500);
  const reached = Object.assign({}, phone.st().position);
  phone.engine.close();
  await clock.advance(10 * MIN);
  const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage, OFF);
  const n = server.log.length;
  const p = again.engine.open(MIXED.key);
  await clock.advance(3000);
  await p;
  check('asked, at this phone\'s own place, no error', again.buttons().join() === 'Start from here,Not now' && !again.st().error && again.st().position.track === reached.track && again.st().position.offset_ms === reached.offset_ms, [again.buttons(), again.st().error, again.st().position, reached]);
  check('nothing sent, the other place survives', since(n).length === 0 && row(MIXED.key).device_id === 'd'.repeat(20), since(n));
  again.button('Not now').click();
  await clock.advance(1000);
  const local = JSON.parse(again.storage.getItem('ws-player:place:' + ID + ':' + MIXED.key));
  check('Not now: the question goes, nothing saved, the place kept', again.prompts().length === 0 && since(n).length === 0 && local.offset_ms === reached.offset_ms, [again.prompts(), since(n), local]);
  again.engine.close();
});

await run('an acknowledged place of this phone\'s, 25 h later with the desktop newer: no question, as before', async () => {
  const { clock, phone, desk, page, row, since, server } = await twoDevices();
  await phone.openAt(MULTI.key, '502', 300000);
  await clock.advance(3000);
  phone.engine.pause();
  await clock.advance(1500);
  phone.engine.close();
  const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
  check('the saved place is acknowledged in the local copy', local.acked === true, local);
  await desk.open();
  desk.engine.seek(1600000);
  await clock.advance(1500);
  desk.engine.pause();
  await clock.advance(1500);
  await clock.advance(25 * 3600000);
  const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage);
  await again.open();
  check('no question: resumed from the desktop\'s place and playing', again.prompts().length === 0 && again.st().playing && again.st().resumedFrom.source === 'web', [again.prompts(), again.st().resumedFrom]);
  again.engine.close();
  desk.engine.close();
});

await run('listening after a conflict is answered counts as newer again', async () => {
  const { clock, phone, row, since, page, server } = await staleAfterPause();
  phone.engine.play();
  await clock.advance(1500);
  phone.button('Keep listening here').click();
  await clock.advance(2000);
  check('answered: the row is the phone\'s', row().device_id === PHONE_ID);
  // The phone listens on offline: only its local copy has the new place.
  phone.offline = true;
  await clock.advance(30000);
  phone.engine.pause();
  await clock.advance(1500);
  const here = phone.st().position;
  phone.engine.close();
  phone.offline = false;
  const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage);
  const m = server.log.length;
  await again.open();
  await clock.advance(2000);
  check('the local copy wins the next open', again.st().resumedFrom && again.st().resumedFrom.source === 'local' && again.prompts().length === 0, [again.st().resumedFrom, again.prompts()]);
  check('and is pushed', since(m).length >= 1 && since(m)[0][0] === 'stored' && since(m)[0][3] === here.track && since(m)[0][4] >= here.offset_ms - 30000, [since(m), here]);
  again.engine.close();
});

await run('Continue at a conflict moves to the stored place and saves it as this device\'s', async () => {
  const { clock, phone, row, since } = await staleAfterPause();
  phone.engine.play();
  await clock.advance(1500);
  const n = phone.server.log.length;
  phone.button('Continue').click();
  await clock.advance(2500);
  check('at the desktop\'s place, playing', phone.st().playing && bookMs(phone) >= 1600000 && bookMs(phone) < 1605000, bookMs(phone));
  check('saved as the phone\'s own move, there', since(n)[0][0] === 'stored' && since(n)[0][3] === '503' && since(n)[0][4] >= 100000 && since(n)[0][4] < 105000, since(n));
  check('the row is the phone\'s now', row().device_id === PHONE_ID, row());
  check('the question is gone', phone.prompts().length === 0);
  phone.engine.close();
});

await run('Keep listening here at a conflict saves this place over the stored one', async () => {
  const { clock, phone, row, since } = await staleAfterPause();
  phone.engine.play();
  await clock.advance(1500);
  const here = bookMs(phone);
  const n = phone.server.log.length;
  phone.button('Keep listening here').click();
  await clock.advance(2500);
  check('playing on from here', phone.st().playing && bookMs(phone) >= here - 11000 && bookMs(phone) < here + 3000, [here, bookMs(phone)]);
  check('stored over the desktop\'s', since(n).length >= 1 && since(n).every((e) => e[0] === 'stored') && row().device_id === PHONE_ID && row().track === '502', [since(n), row()]);
  check('the question is gone', phone.prompts().length === 0);
  phone.engine.close();
});

await run('a conflict whose place is in a part this browser can\'t play offers only Keep listening here', async () => {
  const { clock, server, phone, row, since } = await twoDevices();
  await phone.openAt(MIXED.key, '523', 100000);
  await clock.advance(3000);
  phone.engine.pause();
  await clock.advance(1500);
  // Another device (Safari, which decodes it) saved a place in the E-AC3 part.
  server.rows[MIXED.key] = { track: '522', offset_ms: 10000, duration_ms: 20000, updated_at: server.at(), device: 'Safari on macOS', device_id: 'c'.repeat(20), psid: 'psid-mac', seq: 3 };
  await clock.advance(MIN);
  const n = server.log.length;
  await phone.engine.play();
  await clock.advance(1500);
  check('refused and asked, with no Continue', since(n)[0][0] === 'conflict' && phone.buttons().join() === 'Keep listening here', [since(n), phone.buttons()]);
  check('the other place survives', row(MIXED.key).device_id === 'c'.repeat(20));
  phone.engine.close();
});

// ---- Final review F1: an untouched open never takes the row ----

// The desk listens on offline; the phone opens the book twice without
// listening (it can't reach Plex). The phone's opens must not push the copy
// of the desk's old place they left (it would take the row, and the desk's
// real listening would get a false 409).
await run('F1: untouched opens on another device never take the row; the offline listener\'s save still lands', async () => {
  const { clock, phone, desk, row, since } = await twoDevices();
  await desk.openAt(MULTI.key, '502', 300000);
  await clock.advance(5000);
  desk.offline = true;                       // the desk's saves fail from here; it keeps playing
  await clock.advance(90000);
  desk.engine.pause();
  await clock.advance(2000);
  const heard = desk.st().position.offset_ms;
  check('the desk heard on offline', heard >= 390000, heard);
  phone.remote = [];
  let n = phone.server.log.length;
  await phone.open(MULTI.key); phone.engine.close(); await clock.advance(20000);
  await phone.open(MULTI.key); await clock.advance(2000); phone.engine.close();
  check('the phone sent nothing', since(n).length === 0, since(n));
  check('the row is still the desk\'s', row().device_id === DESK_ID, row());
  const local = JSON.parse(phone.storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
  check('the phone\'s copy of the opening place keeps the desk\'s stamp', local.own === false && local.updated_at === row().updated_at, [local, row()]);
  desk.offline = false;
  n = phone.server.log.length;
  await clock.advance(30000);                // the desk's retry goes out
  check('the desk\'s save is stored, no 409', since(n).length >= 1 && since(n).every((e) => e[0] === 'stored'), since(n));
  check('at the place the desk reached', row().device_id === DESK_ID && row().offset_ms === heard, [row(), heard]);
  check('no question on the desk', desk.prompts().length === 0, desk.prompts());
  desk.engine.close();
});

await run('F1: a device that only opened the book leaves the listener\'s next Play alone', async () => {
  const { clock, phone, desk, row, since } = await twoDevices();
  await desk.openAt(MULTI.key, '502', 300000);
  await clock.advance(20000);
  desk.engine.pause();
  await clock.advance(2000);
  await clock.advance(10 * MIN);
  phone.remote = [];
  let n = phone.server.log.length;
  await phone.open(MULTI.key);
  phone.engine.close();
  await clock.advance(MIN);
  await phone.open(MULTI.key);
  await clock.advance(3000);
  check('the second open resumes from the desk\'s row', phone.st().resumedFrom && phone.st().resumedFrom.source === 'web', phone.st().resumedFrom);
  check('and sends nothing', since(n).length === 0, since(n));
  phone.engine.close();
  await clock.advance(MIN);
  n = phone.server.log.length;
  desk.engine.play();
  await clock.advance(3000);
  check('the desk plays on and is stored', desk.st().playing && since(n).length >= 1 && since(n).every((e) => e[0] === 'stored'), since(n));
  check('no question', desk.prompts().length === 0, desk.prompts());
  desk.engine.close();
});

// ---- Final review F2 (client): a late Play reads the saved places first ----

// A tab of this browser left paused while a second tab listened on (probe_tab).
async function staleTab() {
  const d = await twoDevices({ wall: true });
  const { clock, phone, page, row } = d;
  await phone.openAt(MULTI.key, '502', 300000);
  await clock.advance(20000);
  phone.engine.pause();
  await clock.advance(2000);
  await clock.advance(30 * MIN);
  const tab2 = await page('psid-phone-tab2', 'Chrome on Android', PHONE_ID, phone.storage);
  await tab2.open(MULTI.key);
  await clock.advance(5 * MIN);
  tab2.engine.pause();
  await clock.advance(2000);
  d.newer = Object.assign({}, row());
  d.tab2 = tab2;
  await clock.advance(60 * MIN);
  return d;
}

await run('F2: a stale tab\'s late Play re-reads the saved places, sends nothing and asks', async () => {
  for (const how of ['Play', 'lock-screen Play', 'the play button']) {
    const d = await staleTab();
    const { clock, phone, row, since } = d;
    const reads = phone.positionCalls;
    const n = phone.server.log.length;
    if (how === 'Play') phone.engine.play();
    else if (how === 'lock-screen Play') phone.ms.handlers.get('play')();
    else phone.q('.wsp-bar .wsp-play, .wsp-play').click();
    await clock.advance(5000);
    check(how + ': read again', phone.positionCalls === reads + 1, phone.positionCalls - reads);
    check(how + ': nothing sent', since(n).length === 0, since(n));
    check(how + ': held, not playing', !phone.st().playing && !phone.st().checking);
    check(how + ': asked about the other tab\'s place', phone.prompts().length === 1 && /^Continue from 20:1\d \(another Chrome on Android, 1 h ago\)\?$/.test(phone.prompts()[0]) &&
      phone.buttons().join() === 'Continue,Keep listening here', [phone.prompts(), phone.buttons()]);
    check(how + ': the newer place stands', row().offset_ms === d.newer.offset_ms && row().psid === d.newer.psid, row());
    phone.engine.close();
    d.tab2.engine.close();
  }
});

await run('F2: the stale tab\'s answer: Continue moves there and saves; Keep listening here overrides', async () => {
  for (const which of ['Continue', 'Keep listening here']) {
    const d = await staleTab();
    const { clock, phone, row, since } = d;
    const here = phone.st().position.offset_ms;
    phone.engine.play();
    await clock.advance(5000);
    const n = phone.server.log.length;
    phone.button(which).click();
    await clock.advance(3000);
    check(which + ': playing', phone.st().playing);
    check(which + ': stored, no 409', since(n).length >= 1 && since(n).every((e) => e[0] === 'stored'), since(n));
    if (which === 'Continue') check('from the other tab\'s place', row().psid === 'psid-phone' && row().track === d.newer.track && row().offset_ms >= d.newer.offset_ms, [row(), d.newer]);
    else check('from here, over it', row().psid === 'psid-phone' && row().track === '502' && row().offset_ms < d.newer.offset_ms && row().offset_ms >= here - 31000, [row(), here]);
    phone.engine.close();
    d.tab2.engine.close();
  }
});

await run('F2: without the re-check the server still refuses the stale tab (psid, not device id)', async () => {
  // The engine on the real clock: a Play is never "late" here, so the save goes and the server decides.
  const d = await twoDevices();
  const { clock, phone, page, row, since } = d;
  await phone.openAt(MULTI.key, '502', 300000);
  await clock.advance(20000);
  phone.engine.pause();
  await clock.advance(2000);
  await clock.advance(30 * MIN);
  const tab2 = await page('psid-phone-tab2', 'Chrome on Android', PHONE_ID, phone.storage);
  await tab2.open(MULTI.key);
  await clock.advance(5 * MIN);
  tab2.engine.pause();
  await clock.advance(2000);
  const newer = Object.assign({}, row());
  await clock.advance(60 * MIN);
  const n = phone.server.log.length;
  phone.engine.play();
  await clock.advance(5000);
  check('refused', since(n).length === 1 && since(n)[0][0] === 'conflict', since(n));
  check('the newer place stands', row().offset_ms === newer.offset_ms && row().psid === 'psid-phone-tab2', row());
  check('asked', phone.prompts().length === 1 && !phone.st().playing, phone.prompts());
  phone.engine.close();
  tab2.engine.close();
});

// Listening in a Plex app while this page sat paused (probe_plex).
async function pausedThenPlex(o = {}) {
  const storage = memoryStorage();
  const t = await setup(Object.assign({ storage, identity: ID, deviceId: PHONE_ID, wall: true,
    places: { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(NOW0 - 60000).toISOString(), device: 'Test on Linux', device_id: PHONE_ID, psid: 'test-psid' }, plex: null } }, o));
  await t.engine.open(MULTI.key);
  await t.clock.advance(3000);
  t.engine.pause();
  await t.clock.advance(2000);
  t.readsBefore = t.positionCalls;
  // Two hours in Plexamp: Plex now holds part 3, 2:00, stamped after this page's last save.
  t.places = { web: t.places.web, plex: { track: '503', offset_ms: 120000, duration_ms: 300000, updated_at: new Date(t.now() + 7200000 - 60000).toISOString(), device: 'Plexamp', source: 'plex' } };
  await t.clock.advance(2 * 3600000);
  t.prompts = () => t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
  t.button = (label) => t.qa('.wsp-notice-btn').find((b) => b.textContent === label) || null;
  return t;
}

await run('F2: a late Play after listening in a Plex app asks before posting the old place', async () => {
  const t = await pausedThenPlex();
  const n = t.posts.length;
  t.engine.play();
  await t.clock.advance(3000);
  check('read again', t.positionCalls - t.readsBefore === 1, t.positionCalls - t.readsBefore);
  check('nothing posted', t.posts.length === n, t.posts.slice(n).map((b) => [b.event, b.track, b.offset_ms]));
  check('held and asked', !t.st().playing && /^Continue from 27:00 \(Plexamp, 1 min ago\)\?$/.test(t.prompts().join()), t.prompts());
  t.button('Continue').click();
  await t.clock.advance(3000);
  check('Continue: plays from the Plex place and saves it', t.st().playing && t.st().position.track === '503' &&
    t.posts.slice(n).length >= 1 && t.posts.slice(n).every((b) => b.track === '503' && b.offset_ms >= 120000), t.posts.slice(n).map((b) => [b.event, b.track, b.offset_ms]));
  t.engine.close();
  const u = await pausedThenPlex();
  const m = u.posts.length;
  u.engine.play();
  await u.clock.advance(3000);
  u.button('Keep listening here').click();
  await u.clock.advance(3000);
  check('Keep listening here: plays from here', u.st().playing && u.st().position.track === '502' &&
    u.posts.slice(m).length >= 1 && u.posts.slice(m).every((b) => b.track === '502'), u.posts.slice(m).map((b) => [b.event, b.track, b.offset_ms]));
  u.engine.close();
});

await run('F2: of two newer places, the one somewhere else is asked about', async () => {
  const t = await pausedThenPlex();
  const here = t.st().position;
  // Plex's newer copy is this very place (a stray echo); another tab's newer row is elsewhere.
  t.places = {
    web: { track: '501', offset_ms: 60000, duration_ms: 600000, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Chrome on Linux', device_id: DESK_ID, psid: 'psid-desk' },
    plex: { track: here.track, offset_ms: here.offset_ms + 300, duration_ms: 900000, updated_at: new Date(t.now()).toISOString(), device: 'Plexamp', source: 'plex' }
  };
  const n = t.posts.length;
  t.engine.play();
  await t.clock.advance(3000);
  check('asked about the other device\'s place, nothing posted', /^Continue from 1:00 \(Chrome on Linux, 1 min ago\)\?$/.test(t.prompts().join()) &&
    t.posts.length === n && !t.st().playing, [t.prompts(), t.posts.slice(n)]);
  t.engine.close();
});

// Final re-review FR1: the Plex question holds saves like a web row's. Every
// save is forwarded to Plex's timeline, which turns Plex's copy into an echo
// of it: a stale place saved once would lose the Plexamp place everywhere.
// stateful: each stored save becomes WebServarr's row and Plex's copy an echo.
async function plexElsewhere(o = {}) {
  const t = await pausedThenPlex(Object.assign({ stateful: true }, o));
  t.places.plex = Object.assign({}, t.places.plex, { updated_at: new Date(t.now() - MIN).toISOString() });
  t.plexPlace = () => t.places.plex;
  t.stored = (n) => t.posts.slice(n).map((b) => [b.event, b.track, b.offset_ms]);
  t.reopen = async () => {
    t.engine.close();
    await t.clock.advance(MIN);
    const p = t.engine.open(MULTI.key, { autoplay: false });
    await t.clock.advance(1000);
    await p;
    return t.st();
  };
  return t;
}

await run('FR1: two lock-screen Plays and an unanswered close: nothing saved, the Plexamp place survives', async () => {
  const t = await plexElsewhere();
  const n = t.posts.length;
  t.ms.handlers.get('play')();
  await t.clock.advance(3000);
  check('asked about the Plexamp place', /^Continue from 27:00 \(Plexamp, 1 min ago\)\?$/.test(t.prompts().join()), t.prompts());
  t.ms.handlers.get('play')();                // "nothing happened": again
  await t.clock.advance(60000);
  check('the second Play plays', t.st().playing);
  t.engine.pause();
  await t.clock.advance(2000);
  check('nothing saved (so nothing forwarded to Plex)', t.posts.length === n, t.stored(n));
  check('Plex still holds its place', t.plexPlace() && t.plexPlace().track === '503', t.plexPlace());
  const s = await t.reopen();
  check('the next open resumes the Plexamp place', s.resumedFrom.source === 'plex' && s.position.track === '503' && s.position.offset_ms === 120000, [s.resumedFrom, s.position]);
  check('and the local copy ranks below it', Date.parse(t.saver.readLocal(MULTI.key).updated_at) < Date.parse(t.plexPlace().updated_at) - 2000, t.saver.readLocal(MULTI.key));
  t.engine.close();
});

await run('FR1: every other way on while the Plex question shows saves nothing', async () => {
  for (const how of ['the bar button', 'a seek', 'a chapter jump', 'a lock-screen skip', 'a Play 6 min later']) {
    const t = await plexElsewhere();
    const n = t.posts.length;
    t.engine.play();
    await t.clock.advance(3000);
    check(how + ': asked', t.prompts().length === 1 && !t.st().playing, t.prompts());
    if (how === 'the bar button') t.q('.wsp-play').click();
    else if (how === 'a seek') t.engine.seek(100000);
    else if (how === 'a chapter jump') t.engine.jumpToChapter(0);
    else if (how === 'a lock-screen skip') t.ms.handlers.get('seekbackward')({});
    else { await t.clock.advance(6 * MIN); t.ms.handlers.get('play')(); }
    await t.clock.advance(15000);
    t.engine.pause();
    await t.clock.advance(2000);
    check(how + ': nothing saved', t.posts.length === n, t.stored(n));
    check(how + ': the question still shows', t.prompts().length === 1, t.prompts());
    const s = await t.reopen();
    check(how + ': the next open resumes the Plexamp place', s.resumedFrom.source === 'plex' && s.position.track === '503', [s.resumedFrom, s.position]);
    t.engine.close();
  }
});

await run('FR1: a paused move after 5 minutes re-reads first (a lock-screen skip before any Play)', async () => {
  for (const how of ['lock-screen skip back', 'lock-screen seekto', 'seek', 'chapter jump']) {
    const t = await plexElsewhere();
    const n = t.posts.length;
    const reads = t.positionCalls;
    if (how === 'lock-screen skip back') t.ms.handlers.get('seekbackward')({});
    else if (how === 'lock-screen seekto') t.ms.handlers.get('seekto')({ seekTime: 100 });
    else if (how === 'seek') t.engine.seek(100000);
    else t.engine.jumpToChapter(0);
    await t.clock.advance(3000);
    check(how + ': read again', t.positionCalls === reads + 1, t.positionCalls - reads);
    check(how + ': the move held, nothing saved', t.posts.length === n && t.st().position.track === '502', [t.stored(n), t.st().position]);
    check(how + ': asked', /Plexamp/.test(t.prompts().join()), t.prompts());
    t.engine.close();
  }
  // Nothing newer anywhere: the move goes on after the read, and is saved.
  const u = await plexElsewhere();
  u.places.plex = null;
  const n = u.posts.length;
  u.engine.seek(100000);
  await u.clock.advance(3000);
  check('nothing newer: moved and saved', u.st().position.track === '501' && u.st().position.offset_ms === 100000 &&
    u.stored(n).length === 1 && u.stored(n)[0][1] === '501', u.stored(n));
  u.engine.close();
});

await run('FR1: the answers. Continue saves the Plexamp place; Keep listening here plays and saves here', async () => {
  const t = await plexElsewhere();
  const n = t.posts.length;
  t.engine.play();
  await t.clock.advance(3000);
  t.button('Continue').click();
  await t.clock.advance(12000);
  check('Continue: playing from the Plexamp place, saved', t.st().playing && t.st().position.track === '503' &&
    t.stored(n).length >= 1 && t.stored(n).every((b) => b[1] === '503' && b[2] >= 120000), t.stored(n));
  const reads = t.positionCalls;
  t.engine.pause();
  await t.clock.advance(2000);
  t.engine.play();
  await t.clock.advance(2000);
  check('Continue: no second read or question', t.positionCalls === reads && t.prompts().length === 0 && t.st().playing);
  t.engine.close();
  const u = await plexElsewhere();
  const m = u.posts.length;
  const base = u.places.web.updated_at;
  u.engine.play();
  await u.clock.advance(3000);
  u.button('Keep listening here').click();
  await u.clock.advance(45000);                // past smart rewind's 30 s floor: check-ins again
  const sent = u.posts.slice(m);
  check('Keep listening here: plays and saves here', u.st().playing && sent.length >= 2 && sent.every((b) => b.track === '502'), u.stored(m));
  check('with the web base kept (there was no 409)', sent[0].base === base, [sent[0].base, base]);
  check('no question left, no second read', u.prompts().length === 0);
  u.engine.close();
});

await run('FR1 control: the web-row question still holds through a second lock-screen Play and a close', async () => {
  const d = await staleTab();
  const { clock, phone, row, since } = d;
  const n = phone.server.log.length;
  phone.ms.handlers.get('play')();
  await clock.advance(5000);
  check('asked, nothing sent', phone.prompts().length === 1 && since(n).length === 0 && !phone.st().playing, [phone.prompts(), since(n)]);
  phone.ms.handlers.get('play')();
  await clock.advance(20000);
  check('the second Play plays, nothing sent', phone.st().playing && since(n).length === 0, since(n));
  phone.engine.pause(); await clock.advance(2000); phone.engine.close(); await clock.advance(2000);
  check('nothing on close, the other tab\'s row stands', since(n).length === 0 && row().updated_at === d.newer.updated_at, [since(n), row()]);
  d.tab2.engine.close();
});

// Final re-review FR2: the lock-screen listener never sees the Plex question
// and plays on (held, unsaved) past the Plexamp place, then closes. At the
// reopen Plex's copy wins the merge over that unsaved listening: the open
// asks, exactly as for another device's WebServarr copy (s1_heldlost).
async function heldPastOther(kind) {
  const storage = memoryStorage();
  const t = await setup({ storage, identity: ID, deviceId: PHONE_ID, wall: true, stateful: true,
    places: { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(NOW0 - 60000).toISOString(), device: 'Test on Linux', device_id: PHONE_ID, psid: 'test-psid' }, plex: null } });
  t.prompts = () => t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
  t.buttons = () => t.qa('.wsp-prompt .wsp-notice-btn').map((b) => b.textContent);
  t.button = (label) => t.qa('.wsp-notice-btn').find((b) => b.textContent === label) || null;
  await t.engine.open(MULTI.key);
  await t.clock.advance(3000);
  t.engine.pause();
  await t.clock.advance(2000);
  await t.clock.advance(2 * 3600000);
  // The other place: 502 @ 7:00 (book 17:00), 1 min ago.
  const other = { track: '502', offset_ms: 420000, duration_ms: 900000, updated_at: new Date(t.now() - 60000).toISOString() };
  if (kind === 'plex') t.places = { web: t.places.web, plex: Object.assign({ device: 'Plexamp', source: 'plex' }, other) };
  else t.places = { web: Object.assign({ device: 'Chrome on Linux', device_id: DESK_ID, psid: 'desk-psid' }, other), plex: null };
  const n = t.posts.length;
  t.ms.handlers.get('play')();
  await t.clock.advance(3000);
  t.ms.handlers.get('play')();                // lock screen again: plays on, held
  await t.clock.advance(9 * MIN);
  t.engine.pause();
  await t.clock.advance(2000);
  t.reached = t.st().position;
  t.heldSent = t.posts.length - n;
  t.engine.close();
  await t.clock.advance(MIN);
  const p = t.engine.open(MULTI.key, { autoplay: false });
  await t.clock.advance(1000);
  await p;
  return t;
}

await run('FR2: at the reopen, a Plex app\'s place that beats this browser\'s unsaved listening asks', async () => {
  for (const kind of ['plex', 'web']) {
    const t = await heldPastOther(kind);
    const who = kind === 'plex' ? 'Plexamp' : 'Chrome on Linux';
    check(kind + ': nothing was saved while held', t.heldSent === 0, t.heldSent);
    check(kind + ': held at the other place, paused', !t.st().playing && t.st().position.track === '502' && t.st().position.offset_ms === 420000, t.st().position);
    check(kind + ': asked, Continue or Start from here', new RegExp('^Continue from 17:00 \\(' + who + ', 11 min ago\\)\\?$').test(t.prompts().join()) &&
      t.buttons().join() === 'Continue,Start from here', [t.prompts(), t.buttons()]);
    const n = t.posts.length;
    t.button('Start from here').click();
    await t.clock.advance(3000);
    const sent = t.posts.slice(n);
    check(kind + ': Start from here goes to this browser\'s place and saves it', t.st().playing && sent.length >= 1 &&
      sent.every((b) => b.track === t.reached.track && Math.abs(b.offset_ms - t.reached.offset_ms) < 5000), [t.reached, sent.map((b) => [b.event, b.track, b.offset_ms])]);
    t.engine.close();
  }
  const u = await heldPastOther('plex');
  const n = u.posts.length;
  u.button('Continue').click();
  await u.clock.advance(3000);
  check('plex: Continue goes to the Plex place and saves it', u.st().playing && u.posts.slice(n).length >= 1 &&
    u.posts.slice(n).every((b) => b.track === '502' && b.offset_ms >= 420000 && b.offset_ms < 430000), u.posts.slice(n).map((b) => [b.event, b.offset_ms]));
  u.engine.close();
});

await run('FR2: no Plex question when this browser\'s place was saved, or is the same place', async () => {
  // Saved (acked) and then Plexamp listening: Plex's newer place resumes, no question (as before).
  const storage = memoryStorage();
  const t = await setup({ storage, identity: ID, deviceId: PHONE_ID, stateful: true, places: { web: null, plex: null } });
  t.prompts = () => t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(3000);
  t.engine.pause();
  await t.clock.advance(2000);
  t.engine.close();
  await t.clock.advance(3600000);
  t.places = { web: t.places.web, plex: { track: '503', offset_ms: 120000, duration_ms: 300000, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Plexamp', source: 'plex' } };
  const p = t.engine.open(MULTI.key, { autoplay: false });
  await t.clock.advance(1000);
  await p;
  check('resumes the Plex place without a question', t.st().resumedFrom.source === 'plex' && t.st().position.track === '503' && t.prompts().length === 0, [t.st().resumedFrom, t.prompts()]);
  t.engine.close();
  // The pure rule: within 30 s, or acked, or Plex not the one resumed: no question.
  const base = { resumed: { source: 'plex' }, plex: { bookMs: 1000000, updated_at: new Date(NOW0).toISOString(), device: 'Plexamp', playable: true },
    own: { own: true, acked: false, bookMs: 1400000, updated_at: new Date(NOW0 - MIN).toISOString() }, now: new Date(NOW0).toISOString(), me: { device_id: PHONE_ID, device: 'Chrome on Android' } };
  check('asked: plex beats own unsaved, far apart', F.handoffOffer(base) && F.handoffOffer(base).at === 'plex');
  check('same place (30 s): no', F.handoffOffer(Object.assign({}, base, { own: Object.assign({}, base.own, { bookMs: 1029000 }) })) === null);
  check('own acked: no', F.handoffOffer(Object.assign({}, base, { own: Object.assign({}, base.own, { acked: true }) })) === null);
  check('the own copy won the merge: no', F.handoffOffer(Object.assign({}, base, { resumed: { source: 'local' } })) === null);
  check('Plex place unplayable here: holds at own', F.handoffOffer(Object.assign({}, base, { plex: Object.assign({}, base.plex, { playable: false }) })).at === 'own');
});

// Final re-review FR5: in a three-way split (another device's WebServarr
// row, this browser's unsaved listening, a Plex app's newer place) the open
// offers the newest other place: the Plex app's (a_fr2 A1, A2, and a desk row
// within 30 s of this browser's place, which asks nothing on its own).
const plexCopyAt = (track, offset, atMs, dur) => ({ track, offset_ms: offset, duration_ms: dur, updated_at: new Date(atMs).toISOString(), device: 'Plexamp', source: 'plex' });
const bookMsOf = (track, off) => { let s = 0; for (const x of MULTI.tracks) { if (x.key === track) return s + off; s += x.duration_ms; } return null; };
async function reopenAndPlay(d, phone) {
  const n = d.server.log.length;
  const p = phone.engine.open(MULTI.key, { autoplay: false });
  await d.clock.advance(1000);
  await p;
  const at = phone.st().position;
  const asked = { prompts: phone.prompts(), buttons: phone.buttons(), sent: d.since(n) };
  const n2 = d.server.log.length;
  phone.ms.handlers.get('play')();            // a lock-screen Play at the reopened place
  await d.clock.advance(5000);
  phone.engine.pause();
  await d.clock.advance(2000);
  return { at, asked, played: d.since(n2) };
}

await run('FR5: three-way split: the reopen offers the Plex app\'s newer place, and a Play never stores an older one', async () => {
  for (const variant of ['desk far', 'desk within 30 s']) {
    const d = await twoDevices({ wall: true });
    const { clock, server, phone, desk, row } = d;
    await desk.openAt(MULTI.key, '501', variant === 'desk far' ? 0 : 290000);
    await clock.advance(60000);                 // the desk saves 1:00 (or 5:50)
    desk.engine.pause(); await clock.advance(2000);
    desk.engine.close(); await clock.advance(10 * MIN);
    server.down = true;                         // the phone's saves fail from here
    await phone.open(MULTI.key);
    if (variant === 'desk within 30 s') { phone.engine.seek(bookMsOf('501', 330000)); await clock.advance(1000); }
    await clock.advance(5 * MIN);
    phone.engine.pause(); await clock.advance(2000);
    phone.engine.close(); await clock.advance(20000);
    server.down = false;
    await clock.advance(30 * MIN);
    phone.plexCopy = plexCopyAt('502', 300000, NOW0 + clock.now - 60000, 900000);   // Plexamp: 15:00, newest
    const r = await reopenAndPlay(d, phone);
    check(variant + ': held at the Plexamp place, asked about it', r.at.track === '502' && r.at.offset_ms === 300000 &&
      /^Continue from 15:00 \(Plexamp, 1 min ago\)\?$/.test(r.asked.prompts.join()) && r.asked.buttons.join() === 'Continue,Start from here' && r.asked.sent.length === 0,
    [r.at, r.asked]);
    check(variant + ': the Play stores no place before 15:00', r.played.length >= 1 && r.played.every((e) => e[0] === 'stored' && e[3] === '502' && e[4] >= 300000) &&
      bookMsOf(row().track, row().offset_ms) >= bookMsOf('502', 300000), [r.played, row()]);
    phone.engine.close(); desk.engine.close();
  }
});

await run('FR5: the FR1-held phone, then the desk, then Plexamp: the reopen offers Plexamp\'s newest place (A2)', async () => {
  const d = await twoDevices({ wall: true });
  const { clock, phone, desk, row } = d;
  await phone.openAt(MULTI.key, '502', 300000);
  await clock.advance(3000);
  phone.engine.pause(); await clock.advance(2000);
  await clock.advance(2 * 3600000);
  const plex1 = plexCopyAt('502', 420000, NOW0 + clock.now - 60000, 900000);
  phone.plexCopy = plex1; desk.plexCopy = plex1;
  phone.ms.handlers.get('play')(); await clock.advance(3000);
  check('the late Play asked (FR1)', /Plexamp/.test(phone.prompts().join()), phone.prompts());
  phone.ms.handlers.get('play')(); await clock.advance(9 * MIN);     // played on, held
  phone.engine.pause(); await clock.advance(2000);
  phone.engine.close(); await clock.advance(60000);
  await desk.open(MULTI.key);                    // the desk resumes 17:00, listens a minute
  await clock.advance(60000);
  desk.engine.pause(); await clock.advance(2000);
  desk.engine.close();
  phone.plexCopy = null; desk.plexCopy = null;   // Plex's copy is an echo of the desk's save now
  await clock.advance(30 * MIN);
  phone.plexCopy = plexCopyAt('503', 120000, NOW0 + clock.now - 60000, 300000);   // Plexamp: 27:00, newest
  const r = await reopenAndPlay(d, phone);
  check('held at 27:00 and asked about it, not the desk\'s 17:50', r.at.track === '503' && r.at.offset_ms === 120000 &&
    /^Continue from 27:00 \(Plexamp, 1 min ago\)\?$/.test(r.asked.prompts.join()), [r.at, r.asked]);
  check('the Play keeps 27:00', r.played.every((e) => e[3] === '503' && e[4] >= 120000) && row().track === '503', [r.played, row()]);
  phone.engine.close();
});

// Final re-review FR6: an answer to the open's question given after 5
// minutes, when the other place moved meanwhile, is not lost: the move
// happens (unsaved: the new question holds saves), "Keep listening here"
// saves the place the listener chose, and a close instead keeps it in the
// local copy for the next question (d_drop).
async function lateAnswer(kind) {
  const storage = memoryStorage();
  const ISO = (d) => new Date(NOW0 + d).toISOString();
  const places = kind === 'web'
    ? { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: ISO(-3600000), device: 'Chrome on Linux', device_id: DESK_ID, psid: 'desk-psid' }, plex: null }
    : { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: ISO(-3600000), device: 'Test on Linux', device_id: PHONE_ID, psid: 'old-psid' },
      plex: plexCopyAt('503', 100000, NOW0 - 60000, 300000) };
  const t = await setup({ storage, identity: ID, deviceId: PHONE_ID, wall: true, places });
  t.prompts = () => t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
  t.button = (label) => t.qa('.wsp-notice-btn').find((b) => b.textContent === label) || null;
  t.local = () => JSON.parse(storage.getItem('ws-player:place:' + ID + ':' + MULTI.key));
  storage.setItem('ws-player:place:' + ID + ':' + MULTI.key, JSON.stringify({ track: '502', offset_ms: 800000, duration_ms: 900000, device: 'Test on Linux', updated_at: ISO(-7200000), own: true, acked: false }));
  const p = t.engine.open(MULTI.key, { autoplay: false });
  await t.clock.advance(1000);
  await p;
  t.asked0 = t.prompts();
  await t.clock.advance(6 * MIN);
  // Meanwhile the other place moved on to 503 @ 3:20.
  if (kind === 'web') t.places = { web: Object.assign({}, places.web, { track: '503', offset_ms: 200000, duration_ms: 300000, updated_at: new Date(t.now() - 30000).toISOString() }), plex: null };
  else t.places = { web: places.web, plex: plexCopyAt('503', 200000, t.now() - 30000, 300000) };
  t.n = t.posts.length;
  t.button('Start from here').click();
  await t.clock.advance(3000);
  return t;
}

await run('FR6: a late answer to the open\'s question is kept when the other place moved meanwhile', async () => {
  for (const kind of ['web', 'plex']) {
    const t = await lateAnswer(kind);
    check(kind + ': asked at the open', t.asked0.length === 1, t.asked0);
    check(kind + ': asked again about the moved place, nothing sent', /^Continue from 28:20 /.test(t.prompts().join()) && t.posts.length === t.n, [t.prompts(), t.posts.slice(t.n)]);
    check(kind + ': the chosen place is where the player is, not playing', t.st().position.track === '502' && t.st().position.offset_ms === 800000 && !t.st().playing, t.st().position);
    check(kind + ': the local copy keeps it, unacked', t.local().track === '502' && t.local().offset_ms === 800000 && t.local().own === true && t.local().acked === false, t.local());
    t.button('Keep listening here').click();
    await t.clock.advance(3000);
    t.engine.pause();
    await t.clock.advance(2000);
    const sent = t.posts.slice(t.n);
    check(kind + ': Keep listening here saves the chosen place', sent.length >= 1 && sent.every((b) => b.track === '502' && b.offset_ms >= 800000), sent.map((b) => [b.event, b.track, b.offset_ms]));
    check(kind + ': and the local copy follows it', t.local().track === '502' && t.local().offset_ms >= 800000, t.local());
    t.engine.close();
  }
  // Closed instead of answering: the next open asks again, offering the chosen place.
  const u = await lateAnswer('plex');
  u.engine.close();
  await u.clock.advance(MIN);
  const p = u.engine.open(MULTI.key, { autoplay: false });
  await u.clock.advance(1000);
  await p;
  check('closed: the next open offers the chosen place again', /^Continue from 28:20 \(Plexamp/.test(u.prompts().join()) && u.local().offset_ms === 800000 &&
    u.qa('.wsp-notice-btn').some((b) => b.textContent === 'Start from here'), [u.prompts(), u.local()]);
  u.button('Start from here').click();
  await u.clock.advance(3000);
  check('and Start from here goes there', u.st().position.track === '502' && u.st().position.offset_ms >= 800000, u.st().position);
  u.engine.close();
});

// Final re-review FR3: skips queued behind one late read stay relative.
await run('FR3: three lock-screen skip-backs behind one late read go back three times', async () => {
  const t = await setup({ identity: ID, deviceId: PHONE_ID, wall: true, places: { web: null, plex: null } });
  await t.openAt(MULTI.key, '502', 300000);
  await t.clock.advance(3000);
  t.engine.pause();
  await t.clock.advance(2000);
  await t.clock.advance(2 * 3600000);
  t.positionDelay = 2000;
  const before = t.st().bookMs;
  for (let i = 0; i < 3; i++) {
    t.ms.handlers.get('seekbackward')({});
    await t.clock.advance(300);
  }
  await t.clock.advance(4000);
  check('moved back 30 s', t.st().bookMs === before - 30000, (t.st().bookMs - before) / 1000);
  t.engine.close();
});

// Final re-review FR4: a late move that changes nothing (refused into a part
// this browser can't play) still ends the read: the button is not left spinning.
await run('FR4: a late move refused into an undecodable part leaves no spinner', async () => {
  const t = await setup({ identity: ID, deviceId: PHONE_ID, wall: true, places: { web: null, plex: null } });
  await t.openAt(MIXED.key, '521', 500000);
  await t.clock.advance(3000);
  t.engine.pause();
  await t.clock.advance(2000);
  await t.clock.advance(2 * 3600000);
  t.engine.seek(600000 + 5000);                 // into the undecodable part 2
  await t.clock.advance(100);
  check('the refusal notice', t.notices().some((m) => /format can't play/.test(m)), t.notices());
  await t.clock.advance(5000);
  check('the read ended', t.st().checking === false);
  check('no spinner on any play button', t.qa('.wsp-spin').length === 0 && t.qa('.wsp-play').every((b) => b.getAttribute('aria-label') === 'Play'),
    t.qa('.wsp-play').map((b) => b.getAttribute('aria-label')));
  t.engine.close();
});

await run('F2: the late Play is measured on the wall clock, so time asleep counts', async () => {
  const t = await pausedThenPlex();
  t.engine.close();
  // A fresh page: paused, then the device sleeps 10 minutes (its timers stood still).
  const u = await setup({ identity: ID, deviceId: PHONE_ID, wall: true, places: { web: null, plex: null } });
  await u.engine.open(MULTI.key);
  await u.clock.advance(3000);
  u.engine.pause();
  await u.clock.advance(2000);
  const reads = u.positionCalls;
  u.wallExtra = 4 * MIN;
  u.engine.play();
  await u.clock.advance(1000);
  check('under 5 minutes: no read, plays at once', u.positionCalls === reads && u.st().playing, [u.positionCalls - reads, u.st().playing]);
  u.engine.pause();
  await u.clock.advance(1000);
  u.wallExtra += 10 * MIN;                   // asleep: only the wall clock moved
  u.engine.play();
  await u.clock.advance(1000);
  check('after a sleep: read again first', u.positionCalls === reads + 1, u.positionCalls - reads);
  check('then plays (nothing newer)', u.st().playing, u.st());
  u.engine.close();
});

await run('F2: a failed or slow read plays on; Pause during it cancels the Play', async () => {
  for (const mode of ['down', 'hang']) {
    const t = await pausedThenPlex();
    t.positionMode = mode;
    t.engine.play();
    if (mode === 'hang') {
      await t.clock.advance(100);
      check('hang: waiting meanwhile, shown as busy', !t.st().playing && t.st().checking && t.q('.wsp-spin') !== null, t.st().checking);
      await t.clock.advance(3800);
      check('hang: still waiting under 4 s', !t.st().playing);
    }
    await t.clock.advance(600);
    check(mode + ': plays on', t.st().playing && !t.st().checking);
    check(mode + ': no question', t.prompts().length === 0);
    t.engine.close();
  }
  const t = await pausedThenPlex();
  t.positionMode = 'hang';
  const n = t.posts.length;
  t.engine.play();
  await t.clock.advance(500);
  t.engine.toggle();                          // the listener taps again: no Play after all
  await t.clock.advance(5000);
  check('cancelled: not playing, nothing posted', !t.st().playing && !t.st().checking && t.posts.length === n, t.posts.slice(n));
  t.engine.close();
});

await run('F2: Retry after an error that came 5 minutes ago re-reads too', async () => {
  const t = await pausedThenPlex();
  // The stream fails while paused-then-played? Simplest: the error state now, the quiet time already over 5 minutes.
  t.engine.play();
  await t.clock.advance(3000);
  t.button('Keep listening here').click();
  await t.clock.advance(3000);
  check('playing', t.st().playing);
  t.down = true;
  t.audioEl.error = { code: 2 };
  t.audioEl.fire('error');
  await t.clock.advance(20000);
  check('in the error state', !!t.st().error, t.st().error);
  const reads = t.positionCalls;
  t.down = false;
  // Listening in Plexamp again meanwhile.
  t.places = { web: t.places.web, plex: { track: '501', offset_ms: 50000, duration_ms: 600000, updated_at: new Date(t.now() + 10 * MIN).toISOString(), device: 'Plexamp', source: 'plex' } };
  await t.clock.advance(11 * MIN);
  const n = t.posts.length;
  t.engine.retry();
  await t.clock.advance(3000);
  check('read again, nothing posted, asked', t.positionCalls === reads + 1 && t.posts.length === n && t.prompts().length === 1 && !t.st().playing,
    [t.positionCalls - reads, t.posts.slice(n), t.prompts()]);
  t.engine.close();
});

await run('F2: nothing newer elsewhere, this page\'s own newer save, or the same place: no question', async () => {
  // This page's own save stored after its last ack (the answer never came back): its psid.
  const t = await pausedThenPlex();
  t.places = { web: Object.assign({}, t.places.web, { updated_at: new Date(t.now()).toISOString(), psid: 'test-psid' }), plex: null };
  t.engine.play();
  await t.clock.advance(2000);
  check('own save: plays, no question', t.st().playing && t.prompts().length === 0, t.prompts());
  t.engine.close();
  // Another tab saved this very place (within 1 s): its time is taken as the base, and the Play is stored.
  const d = await twoDevices({ wall: true });
  const { clock, phone, server, row, since } = d;
  await phone.openAt(MULTI.key, '502', 300000);
  await clock.advance(20000);
  phone.engine.pause();
  await clock.advance(2000);
  const r = row();
  server.rows[MULTI.key] = Object.assign({}, r, { psid: 'psid-phone-tab2', offset_ms: r.offset_ms + 400, updated_at: server.at() });
  await clock.advance(20 * MIN);
  const n = server.log.length;
  phone.engine.play();
  await clock.advance(2000);
  check('same place: plays, no question', phone.st().playing && phone.prompts().length === 0, phone.prompts());
  check('and is stored (no 409)', since(n).length >= 1 && since(n).every((e) => e[0] === 'stored'), since(n));
  phone.engine.close();
});

await run('the same device reloaded carries on saving', async () => {
  const { clock, phone, page, row, since } = await twoDevices();
  await phone.openAt(MULTI.key, '502', 300000);
  await clock.advance(3000);
  phone.engine.pause();
  await clock.advance(1500);
  phone.engine.close();
  // A reload: a new page session, the same browser (id and local copy).
  const again = await page('psid-phone-2', 'Chrome on Android', PHONE_ID, phone.storage);
  const n = again.server.log.length;
  await again.open();
  check('no question', again.prompts().length === 0 && again.st().playing);
  await clock.advance(12000);
  check('every save stored', since(n).length >= 2 && since(n).every((e) => e[0] === 'stored'), since(n));
  again.engine.close();
});

// Final review F2 (server): "the same device" is the same page session
// (psid) or a matching base, not the device id. Two tabs of one browser are
// two page sessions: the one that has not seen the other's save is refused
// and asked, never silently written over it (this used to store both).
await run('two tabs of one browser: the one that has not seen the other\'s save is refused and asked', async () => {
  const { clock, phone, page, row, since } = await twoDevices();
  const tab2 = await page('psid-phone-tab2', 'Chrome on Android', PHONE_ID, phone.storage);
  await phone.openAt(MULTI.key, '501', 100000);
  await tab2.openAt(MULTI.key, '502', 300000);
  await clock.advance(25000);
  const log = since(0);
  const tab2Saves = phone.server.log.filter((e) => e.psid === 'psid-phone-tab2');
  check('tab 2 was refused', tab2Saves.length === 1 && tab2Saves[0].result === 'conflict', log);
  check('tab 1 saves on', phone.server.log.filter((e) => e.psid === 'psid-phone').every((e) => e.result === 'stored') &&
    row().track === '501' && row().psid === 'psid-phone', [log, row()]);
  check('tab 2 paused and asks', !tab2.st().playing && tab2.prompts().length === 1 && /another Chrome on Android/.test(tab2.prompts()[0]), tab2.prompts());
  phone.engine.close();
  tab2.engine.close();
});

await run('no row yet: the first save stores', async () => {
  const { clock, phone, row, since } = await twoDevices();
  await phone.open();
  await clock.advance(1000);
  check('stored with no base', since(0)[0][0] === 'stored' && phone.posts[0].base === null && row().device_id === PHONE_ID, [since(0), phone.posts[0]]);
  phone.engine.close();
});

await run('a refused beacon or last save is dropped quietly', async () => {
  const { clock, phone, row, since } = await staleAfterPause();
  const deskRow = Object.assign({}, row());
  // The phone moves while paused, with its save failing, then the page is hidden and closed.
  phone.offline = true;
  phone.engine.seek(200000);
  await clock.advance(1500);
  phone.offline = false;
  const n = phone.server.log.length;
  phone.saver && phone.saver.flush && phone.saver.flush('beacon');
  phone.win.dispatchEvent(new phone.win.Event('pagehide'));
  phone.engine.close();
  await clock.advance(20000);
  check('refused', since(n).length >= 1 && since(n).every((e) => e[0] === 'conflict'), since(n));
  check('the desktop\'s place survives', row().updated_at === deskRow.updated_at);
  check('no question for a closed player, and nothing logged', phone.prompts().length === 0);
});

await run('a move while the open question shows answers it; Continue there is a move to the other place', async () => {
  for (const which of ['move', 'Continue']) {
    const { clock, phone, row, since } = await questionLeftOpen();
    await phone.open();
    const n = phone.server.log.length;
    if (which === 'move') phone.engine.seek(1000000);
    else phone.button('Continue').click();
    await clock.advance(1500);
    check(`${which}: the question is gone`, phone.prompts().length === 0);
    const first = since(n)[0];
    if (which === 'move') check('the move is saved as the newest place', first && first[0] === 'stored' && first[3] === '502' && first[4] === 400000 && row().device_id === PHONE_ID, since(n));
    else check('Continue saves the other place as this device\'s', first && first[0] === 'stored' && first[2] === 'pause' && first[3] === '502' && row().device_id === PHONE_ID, since(n));
    phone.engine.close();
  }
});

await run('history: sessions from the log, and a tap goes to where one ended', async () => {
  const t = await setup({ wide: false });
  await t.openAt(MULTI.key, '501', 60000);
  t.engine.pause();
  t.history[''] = {
    entries: [
      entry(t, 60000, '501', 60000, 'Test on Linux', ME, 'pause'),
      entry(t, 3600000, '503', 100000, 'Chrome on Android', OTHER, 'pause'),
      entry(t, 3700000, '502', 800000),
      entry(t, 3900000, '502', 200000, 'Chrome on Android', OTHER, 'play')
    ],
    next_before: null
  };
  t.ui.open();
  const btn = t.q('.wsp-slot-history .wsp-action');
  check('the History button shows in its slot', !!btn && !t.q('.wsp-slot-history').hidden && btn.textContent.indexOf('History') !== -1);
  btn.click();
  await t.clock.advance(50);
  const rows = t.qa('.wsp-hist-row');
  check('two sessions, newest first', rows.length === 2, rows.length);
  const what = rows.map((r) => r.querySelector('.wsp-hist-what').textContent);
  // Saved before the book time was kept: this copy's chapter, time and length.
  check('where each ended: chapter, book time, percent', what[0] === 'Part 1 of 3 · 0:01:00 into the book · 3%' && what[1] === 'Part 3 of 3 · 0:26:40 into the book · 88%', what);
  const devs = rows.map((r) => r.querySelector('.wsp-hist-dev').textContent);
  // T3C1 (player spec 8): the chapters a session covered, when more than one.
  check('the chapters covered and the device', devs.join() === 'Test on Linux,Chapters 2 to 3 · Chrome on Android', devs);
  check('no earlier copy here', !t.q('.wsp-hist-tag'));
  check('when', rows[1].querySelector('.wsp-hist-when').textContent.startsWith('Today · '), rows[1].querySelector('.wsp-hist-when').textContent);
  check('a spoken label', /, Part 3 of 3 · 0:26:40 into the book · 88%, Chapters 2 to 3, Chrome on Android\. Go to where it ended$/.test(rows[1].getAttribute('aria-label')), rows[1].getAttribute('aria-label'));
  check('no older pages: no Show older', t.q('.wsp-hist-more').hidden);
  const posts = t.posts.length;
  rows[1].click();
  check('gone to where it ended', bookMs(t) === 1600000, bookMs(t));
  check('with Undo', !!t.undoBtn() && t.notices().indexOf('Jumped ahead 26 min.') !== -1, t.notices());
  await t.clock.advance(1100);
  check('saved as the listener\'s own move', t.posts.length === posts + 1 && t.posts[posts].track === '503' && t.posts[posts].offset_ms === 100000, t.posts.slice(posts));
  check('back to the player on a phone', t.q('.wsp-full').getAttribute('data-view') === null);
  t.engine.close();
});

await run('history (spec 2.5): that copy\'s chapter, book time and percent; an earlier copy says so; its part gone, no helper: disabled', async () => {
  const t = await setup({ wide: true });
  await t.openAt(MULTI.key, '501', 60000, { autoplay: false });
  const e = (agoMs, track, offset, more) => Object.assign(entry(t, agoMs, track, offset), more);
  t.history[''] = {
    entries: [
      e(MIN, '502', 300000, { book_key: '500:1', book_ms: 900000, book_duration_ms: 1800000, chapter_label: '7' }),
      // An earlier copy's entries: their own chapter names and length.
      e(30 * MIN, '401', 200000, { book_key: '400:1', book_ms: 3725000, book_duration_ms: 7200000, chapter_label: 'The Letter', earlier_copy: true }),
      e(31 * MIN, '401', 190000, { book_key: '400:1', book_ms: 3715000, book_duration_ms: 7200000, chapter_label: 'The Letter', earlier_copy: true }),
      // Saved before the book time was kept, its part gone: nothing to say where.
      e(90 * MIN, '399', 5000, { book_key: '400:1', earlier_copy: true })
    ],
    next_before: null
  };
  t.ui.open();
  t.q('.wsp-slot-history .wsp-action').click();
  await t.clock.advance(50);
  const rows = t.qa('.wsp-hist-row');
  check('another copy starts another session', rows.length === 3, rows.length);
  const what = rows.map((r) => { const w = r.querySelector('.wsp-hist-what'); return w ? w.textContent : null; });
  check('"Chapter <label> · <h:mm:ss> into the book · <n>%"', what[0] === 'Chapter 7 · 0:15:00 into the book · 50%', what[0]);
  check('the earlier copy\'s own chapter, time and length', what[1] === 'The Letter · 1:02:05 into the book · 51%', what[1]);
  check('nothing known: no line', what[2] === null, what[2]);
  const tags = rows.map((r) => { const g = r.querySelector('.wsp-hist-tag'); return g ? g.textContent : ''; });
  check('"Earlier copy" on the earlier copy\'s', tags.join() === ',Earlier copy,Earlier copy', tags);
  check('in the spoken label', /Chrome on Android, earlier copy$/.test(rows[1].getAttribute('aria-label')), rows[1].getAttribute('aria-label'));
  check('no helper: the gone ones are disabled', !rows[0].disabled && rows[1].disabled && rows[2].disabled);
  rows[1].click();
  await t.clock.advance(100);
  check('a tap there does nothing', bookMs(t) === 60000 && t.posts.length === 0, bookMs(t));
  rows[0].click();
  await t.clock.advance(100);
  check('one in the book still goes where it ended', bookMs(t) === 900000, bookMs(t));
  t.engine.close();
});

await run('history: Show older loads the next page, and a session across the pages is one', async () => {
  const t = await setup({ wide: true });
  await t.openAt(MULTI.key, '501', 60000, { autoplay: false });
  t.history[''] = { entries: [entry(t, 0, '502', 500000), entry(t, 4 * MIN, '502', 400000)], next_before: 'cur~1' };
  t.history['cur~1'] = { entries: [entry(t, 8 * MIN, '502', 300000), entry(t, 60 * MIN, '501', 10000)], next_before: null };
  t.ui.open();
  t.q('.wsp-slot-history .wsp-action').click();
  await t.clock.advance(50);
  check('one session on the first page', t.qa('.wsp-hist-row').length === 1);
  const more = t.q('.wsp-hist-more');
  check('Show older', !more.hidden && more.textContent === 'Show older');
  more.click();
  await t.clock.advance(50);
  const urls = t.fetches.filter((f) => f.url.startsWith('/api/player/history/')).map((f) => f.url);
  check('the next page by its cursor', urls[urls.length - 1] === '/api/player/history/500%3A1?before=cur~1', urls);
  const rows = t.qa('.wsp-hist-row');
  check('the session runs on into the older page, then an older one', rows.length === 2, rows.length);
  check('it still ends where the first page\'s newest place is', rows[0].querySelector('.wsp-hist-what').textContent === 'Part 2 of 3 · 0:18:20 into the book · 61%', rows[0].querySelector('.wsp-hist-what').textContent);
  check('no more pages', t.q('.wsp-hist-more').hidden);
  t.engine.close();
});

await run('history: empty, failing and another book', async () => {
  const t = await setup({ wide: true });
  await t.openAt(MULTI.key, '501', 60000, { autoplay: false });
  t.ui.open();
  t.q('.wsp-slot-history .wsp-action').click();
  await t.clock.advance(50);
  check('nothing yet', t.q('.wsp-hist-note').textContent === 'No listening history for this book yet.');
  t.history[''] = 'fail';
  t.q('.wsp-slot-history .wsp-action').click();
  await t.clock.advance(50);
  check('a failure says so', t.q('.wsp-hist-note').textContent === "Couldn't load your listening history." && t.q('.wsp-hist-more').textContent === 'Try again');
  t.history[''] = { entries: [entry(t, 0, '502', 500000)], next_before: null };
  t.q('.wsp-hist-more').click();
  await t.clock.advance(50);
  check('Try again loads it', t.qa('.wsp-hist-row').length === 1 && t.q('.wsp-hist-note').textContent === '');
  t.history[''] = { entries: [], next_before: null };
  await t.openAt(SPAN.key, '511', 1000, { autoplay: false });
  await t.clock.advance(50);
  const last = t.fetches.filter((f) => f.url.startsWith('/api/player/history/')).pop();
  check('another book: its own history, asked again while the panel shows', last.url === '/api/player/history/510%3A1' && t.qa('.wsp-hist-row').length === 0, [last.url, t.qa('.wsp-hist-row').length]);
  t.engine.close();
});

await run('up next at the end of the book: offered, never started; Play opens it where the listener left off', async () => {
  const t = await setup();
  t.nextBooks[MULTI.key] = { key: SPAN.key, title: 'Spanning', author: 'B. Writer', series: 'S', narrator: '', cover: '', duration_ms: 600000, shape: 'parts' };
  await t.openAt(MULTI.key, '503', 298000);
  await t.clock.advance(3000);
  check('the book ended', !t.st().playing && bookMs(t) === 1800000, bookMs(t));
  const asked = t.fetches.filter((f) => f.url === '/api/player/next/500%3A1');
  check('the next book was asked for once', asked.length === 1, asked.length);
  const prompts = t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
  check('Up next', prompts.join() === 'Up next: Spanning', prompts);
  check('Play and Not now', t.qa('.wsp-prompt .wsp-notice-btn').map((b) => b.textContent).join() === 'Play,Not now');
  const loads = t.loads.length;
  await t.clock.advance(120000);
  check('it never starts by itself', t.st().book === MULTI.key && !t.st().playing && t.loads.length === loads);
  check('still offered', t.qa('.wsp-prompt').length === 1);
  const before = t.fetches.length;
  t.qa('.wsp-notice-btn').find((b) => b.textContent === 'Play').click();
  await t.clock.advance(300);
  check('Play opens the next book, playing', t.st().book === SPAN.key && t.st().playing, [t.st().book, t.st().playing]);
  check('with the normal resume', t.fetches.slice(before).some((f) => f.url === '/api/player/position/510%3A1'));
  check('the offer is gone', t.qa('.wsp-prompt').length === 0);
  t.engine.close();
});

await run('up next: none for a standalone book, not at the end of a part, Not now and a replay remove it', async () => {
  const t = await setup();
  await t.openAt(MULTI.key, '502', 898000);
  await t.clock.advance(3000);
  check('the end of a part asks nothing', t.fetches.every((f) => !f.url.startsWith('/api/player/next/')) && t.st().playing);
  t.engine.seek(1798000);
  await t.clock.advance(3000);
  check('none for a standalone book', t.fetches.some((f) => f.url.startsWith('/api/player/next/')) && t.qa('.wsp-prompt').length === 0);
  t.nextBooks[MULTI.key] = { key: SPAN.key, title: 'Spanning' };
  await t.engine.play();
  await t.clock.advance(100);
  t.engine.seek(1798000);
  await t.clock.advance(3000);
  check('offered at the end', t.qa('.wsp-prompt').length === 1);
  t.qa('.wsp-notice-btn').find((b) => b.textContent === 'Not now').click();
  check('Not now removes it', t.qa('.wsp-prompt').length === 0);
  t.engine.seek(1798000);
  await t.engine.play();
  await t.clock.advance(3000);
  check('offered again at the next end', t.qa('.wsp-prompt').length === 1);
  await t.engine.play();
  await t.clock.advance(300);
  check('playing again (from the start) removes it', t.st().playing && t.qa('.wsp-prompt').length === 0);
  t.engine.close();
});

await run('boot sets WS.playerFeatures once, and only with the player', async () => {
  const t = await setup({ noFeatures: true });
  t.win.WS = { player: t.engine, playerUI: t.ui };
  const over = { fetch: t.fetch, setTimeout: t.clock.setTimeout, clearTimeout: t.clock.clearTimeout, now: t.now, mono: () => t.clock.now };
  const f = F.boot(t.win, over);
  check('booted', f && t.win.WS.playerFeatures === f && typeof f.sleep === 'function');
  check('once', F.boot(t.win, over) === f);
  await t.clock.advance(10);
  check('no GET at boot', t.fetches.filter((x) => x.url === '/api/player/prefs').length === 0);
  const p = t.engine.open(MULTI.key, { at: { track: '501', offset_ms: 1000 } });
  await t.clock.advance(200);
  await p;
  check('one GET, at the first book', t.fetches.filter((x) => x.url === '/api/player/prefs').length === 1);
  t.engine.close();
  const bare = new Window({ url: 'https://ws.test/' });
  bare.WS = {};
  check('no player, nothing', F.boot(bare, over) === null);
  await bare.happyDOM.close();
});

// Spec 2.5 fix round 5 (T2U1): placing a book whose files changed is no jump
// to undo. Undo would go back to the held start (0:00) and save it over the
// listener's place: none is offered for the confirm's moves, or for any move
// while the book is held.
async function heldFiles() {
  const storage = memoryStorage();
  const t = await setup({ storage, identity: ID, deviceId: ME, wall: true });
  t.places = { web: { track: '401', offset_ms: 120000, duration_ms: 900000, updated_at: new Date(t.serverNow() - 3600000).toISOString(),
    device: 'Chrome on Windows', device_id: OTHER, psid: 'other', book_ms: 720000, book_duration_ms: 1800000, chapter_label: 'Chapter 4',
    linked_from: '400:1', book_title: 'Three Parts (First Edition)' }, plex: null };
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(300);
  await p;
  t.keep = () => t.qa('.wsp-notice-btn').find((b) => b.textContent === 'Keep listening here') || null;
  return t;
}
await run('spec 2.5 (T2U1): no Undo for placing a book whose files changed, nor for a move while it is held', async () => {
  for (const plex of [false, true]) {
    const t = await heldFiles();
    check('held', t.engine.state().filesChanged !== null);
    const n = t.posts.length;
    if (plex) t.places.plex = { track: '502', offset_ms: 30000, duration_ms: 900000, updated_at: new Date(t.serverNow() - MIN).toISOString(), device: 'Plexamp' };
    t.positionDelay = 1000;
    t.engine.confirmPlace(650000);                     // 0:00 -> 10:50, still held while it reads
    await t.clock.advance(100);
    check((plex ? 'asked: ' : '') + 'no Undo at the confirm', !t.undoBtn() && t.notices().every((x) => x.indexOf('Jumped') === -1), t.notices());
    t.engine.jumpToChapter(2);                         // a move while held, over 2 minutes
    await t.clock.advance(100);
    check((plex ? 'asked: ' : '') + 'no Undo for a move while held', !t.undoBtn(), t.notices());
    t.engine.seek(650000);
    await t.clock.advance(1500);
    if (plex) {
      check('the question is up, still no Undo', !!t.keep() && !t.undoBtn(), t.notices());
      t.keep().click();
    }
    await t.clock.advance(1000);
    check((plex ? 'asked: ' : '') + 'landed at the spot, with no Undo after it', t.engine.state().filesChanged === null && bookMs(t) >= 650000 && !t.undoBtn(), [bookMs(t), t.notices()]);
    check((plex ? 'asked: ' : '') + 'saved there with the link, never 0:00', t.posts.length > n && t.posts.slice(n).every((b) => b.book_ms >= 650000 && b.linked_from === '400:1'),
      t.posts.slice(n).map((b) => [b.event, b.book_ms, b.linked_from]));
    // Not held any more: a big jump offers Undo as ever.
    t.engine.seek(1600000);
    await t.clock.advance(100);
    check((plex ? 'asked: ' : '') + 'after it, a big jump offers Undo as ever', !!t.undoBtn());
    t.engine.close();
  }
});

// Spec 2.5 section 7 (PR3): a Plex app's question left showing is read again
// before its answer. Nothing on the server guards a Plex app's place, so an
// answer given long after the question showed could act on a place the Plex
// app has since left. The q_stale scenario (scratchpad rr-fr3): this page
// saved 15:00 and paused; Plexamp then played to 17:00, and the late Play
// asked about it. The question then stays open while Plexamp moves on.
const PR3_ASKED = 'Continue from 17:00 (Plexamp, 1 min ago)?';
async function plexQuestion() {
  const t = await setup({ storage: memoryStorage(), identity: ID, deviceId: PHONE_ID, wall: true, stateful: true,
    places: { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(NOW0 - 3600000).toISOString(),
      device: 'Test on Linux', device_id: PHONE_ID, psid: 'old-psid' }, plex: null } });
  t.prompts = () => t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
  t.btns = () => t.qa('.wsp-prompt .wsp-notice-btn').map((b) => b.textContent);
  t.btn = (label) => t.qa('.wsp-prompt .wsp-notice-btn').find((b) => b.textContent === label) || null;
  // Its buttons there and all waiting (aria-disabled; never disabled, which would take the
  // focus off the one pressed) while the place is read again.
  t.waiting = () => t.btns().join() === 'Continue,Keep listening here' &&
    t.qa('.wsp-prompt .wsp-notice-btn').every((b) => !b.disabled && b.getAttribute('aria-disabled') === 'true');
  t.stored = (n) => t.posts.slice(n).map((b) => [b.event, b.track, b.offset_ms]);
  t.seeks = [];
  t.engine.on('change', (d) => { if (d.reason === 'seek') t.seeks.push(d.to); });
  const p = t.engine.open(MULTI.key, { autoplay: false });
  await t.clock.advance(1000);
  await p;
  t.engine.play();
  await t.clock.advance(3000);
  t.engine.pause();
  await t.clock.advance(2000);
  await t.clock.advance(6 * MIN);
  t.places = { web: t.places.web, plex: plexCopyAt('502', 420000, t.now() - MIN, 900000) };   // Plexamp: 17:00
  t.ms.handlers.get('play')();
  t.askedAt = t.now();                       // the read answers at once: the question shows now
  await t.clock.advance(3000);
  check('asked about Plexamp\'s 17:00', t.prompts().join() === PR3_ASKED && !t.st().playing, t.prompts());
  t.here = t.st().position;
  return t;
}

await run('PR3 (q_stale): 10 min later Plexamp has moved on: the answer reads again, the question shows the new place, nothing is saved', async () => {
  for (const answer of ['Continue', 'Keep listening here']) {
    const t = await plexQuestion();
    await t.clock.advance(10 * MIN);                                                       // the question left showing
    t.places = { web: t.places.web, plex: plexCopyAt('503', 120000, t.now() - 30000, 300000) };   // Plexamp: 27:00
    const reads = t.positionCalls;
    const n = t.posts.length;
    const seeks = t.seeks.length;
    t.btn(answer).click();
    await t.clock.advance(3000);
    check(answer + ': read again, once', t.positionCalls === reads + 1, t.positionCalls - reads);
    check(answer + ': the question shows Plexamp\'s new place', t.prompts().join() === 'Continue from 27:00 (Plexamp, just now)?' &&
      t.btns().join() === 'Continue,Keep listening here', [t.prompts(), t.btns()]);
    check(answer + ': nothing acted on: no move, nothing saved, not playing', t.posts.length === n && t.seeks.length === seeks &&
      !t.st().playing && t.st().position.track === t.here.track && t.st().position.offset_ms === t.here.offset_ms, [t.stored(n), t.seeks.slice(seeks), t.st().position]);
    // Answered at once now: no second read, and Continue goes to the new place.
    t.btn(answer).click();
    await t.clock.advance(12000);
    check(answer + ': answered again, no second read', t.positionCalls === reads + 1 && t.prompts().length === 0, [t.positionCalls - reads, t.prompts()]);
    if (answer === 'Continue') {
      check('Continue: plays from Plexamp\'s 27:00, saved there', t.st().playing && t.st().position.track === '503' &&
        t.stored(n).length >= 1 && t.stored(n).every((b) => b[1] === '503' && b[2] >= 120000), t.stored(n));
    } else {
      check('Keep listening here: plays and saves here', t.st().playing && t.stored(n).length >= 1 &&
        t.stored(n).every((b) => b[1] === '502' && b[2] < 420000), t.stored(n));
    }
    t.engine.close();
  }
  // The updated question left showing too: answered 3 min later it is read
  // again, and Plexamp still at 27:00 is no move (the place it now asks about).
  const w = await plexQuestion();
  await w.clock.advance(10 * MIN);
  w.places = { web: w.places.web, plex: plexCopyAt('503', 120000, w.now() - 30000, 300000) };
  const wr = w.positionCalls;
  const wn = w.posts.length;
  w.btn('Continue').click();
  await w.clock.advance(3000);
  await w.clock.advance(3 * MIN);
  w.btn('Continue').click();
  await w.clock.advance(12000);
  check('left again: read again, then Continue goes to 27:00', w.positionCalls === wr + 2 && w.prompts().length === 0 && w.st().playing &&
    w.stored(wn).length >= 1 && w.stored(wn).every((b) => b[1] === '503' && b[2] >= 120000), [w.positionCalls - wr, w.prompts(), w.stored(wn)]);
  w.engine.close();
  // Playing on (unsaved) under the question: the new place shows, and playback is left as it is.
  const u = await plexQuestion();
  u.engine.play();
  await u.clock.advance(2000);
  await u.clock.advance(10 * MIN);
  u.places = { web: u.places.web, plex: plexCopyAt('503', 120000, u.now() - 30000, 300000) };
  const n = u.posts.length;
  u.btn('Continue').click();
  await u.clock.advance(3000);
  check('playing on: the question shows 27:00, still playing, nothing saved', /^Continue from 27:00/.test(u.prompts().join()) &&
    u.st().playing && u.posts.length === n, [u.prompts(), u.st().playing, u.stored(n)]);
  u.engine.close();
});

await run('PR3: Plexamp has not moved: the answer reads again and goes on', async () => {
  for (const [answer, how] of [['Continue', ''], ['Keep listening here', ''], ['Continue', 're-stamped'], ['Continue', 'older']]) {
    const t = await plexQuestion();
    const askedAt = Date.parse(t.places.plex.updated_at);
    await t.clock.advance(10 * MIN);
    // re-stamped: Plexamp reported the same place again (within 1 s), later.
    // older: a place elsewhere stamped before the one asked about is no move on.
    if (how === 're-stamped') t.places = { web: t.places.web, plex: plexCopyAt('502', 420500, t.now() - 30000, 900000) };
    if (how === 'older') t.places = { web: t.places.web, plex: plexCopyAt('503', 120000, askedAt - 5 * MIN, 300000) };
    const what = answer + (how ? ' (' + how + ')' : '');
    const reads = t.positionCalls;
    const n = t.posts.length;
    t.btn(answer).click();
    await t.clock.advance(12000);
    check(what + ': read again, once', t.positionCalls === reads + 1, t.positionCalls - reads);
    check(what + ': no question left', t.prompts().length === 0, t.prompts());
    if (answer === 'Continue') {
      check(what + ': plays from Plexamp\'s 17:00, saved there', t.st().playing && t.stored(n).length >= 1 &&
        t.stored(n).every((b) => b[1] === '502' && b[2] >= 420000), t.stored(n));
    } else {
      check(what + ': plays and saves here', t.st().playing && t.stored(n).length >= 1 &&
        t.stored(n).every((b) => b[1] === '502' && b[2] < 420000), t.stored(n));
    }
    t.engine.close();
  }
});

await run('PR3: a read that fails or takes over 4 s keeps the question as it was, and saves nothing; it can be answered again', async () => {
  for (const mode of ['down', 'hang', 'slow']) {
    const t = await plexQuestion();
    await t.clock.advance(10 * MIN);
    t.places = { web: t.places.web, plex: plexCopyAt('503', 120000, t.now() - 30000, 300000) };   // moved, but unseen
    if (mode === 'slow') t.positionDelay = 6000;
    else t.positionMode = mode;
    const reads = t.positionCalls;
    const n = t.posts.length;
    const seeks = t.seeks.length;
    const local = JSON.stringify(t.saver.readLocal(MULTI.key));
    t.btn('Continue').click();
    check(mode + ': reading, its buttons wait', t.prompts().join() === 'Checking for a newer place…' && t.waiting(), [t.prompts(), t.btns()]);
    await t.clock.advance(4500);
    // T4F4: the question as it was, its age counted on (asked 1 min ago, 10 min 4.5 s since).
    check(mode + ': after 4 s the question is back, its age counted on', t.prompts().join() === 'Continue from 17:00 (Plexamp, 11 min ago)?' &&
      t.btns().join() === 'Continue,Keep listening here' && !t.waiting(), [t.prompts(), t.btns()]);
    await t.clock.advance(5000);              // a slow read's answer, come too late, changes nothing
    check(mode + ': still as it was', t.prompts().join() === 'Continue from 17:00 (Plexamp, 11 min ago)?', t.prompts());
    check(mode + ': nothing acted on, nothing saved', t.positionCalls === reads + 1 && t.posts.length === n && t.seeks.length === seeks &&
      !t.st().playing && t.st().position.offset_ms === t.here.offset_ms, [t.positionCalls - reads, t.stored(n), t.st().position]);
    check(mode + ': the local copy is as it was', JSON.stringify(t.saver.readLocal(MULTI.key)) === local, [local, t.saver.readLocal(MULTI.key)]);
    // Answered again once reads work: read again, and the new place shows.
    t.positionMode = 'ok';
    t.positionDelay = 0;
    t.btn('Continue').click();
    await t.clock.advance(3000);
    check(mode + ': answered again: read again, the new place shows', t.positionCalls === reads + 2 &&
      /^Continue from 27:00/.test(t.prompts().join()) && t.posts.length === n, [t.positionCalls - reads, t.prompts()]);
    t.engine.close();
  }
});

await run('PR3: the 2-minute line is the wall clock\'s: under it no read; over it, a device asleep included, a read', async () => {
  // Answered 1 min 58 s after it showed (3 s of it in plexQuestion): no read, the answer goes on at once.
  const t = await plexQuestion();
  await t.clock.advance(115000);
  const reads = t.positionCalls;
  const n = t.posts.length;
  t.btn('Continue').click();
  await t.clock.advance(12000);
  check('under 2 min: no read', t.positionCalls === reads, t.positionCalls - reads);
  check('under 2 min: plays from Plexamp\'s 17:00, saved', t.st().playing && t.stored(n).length >= 1 && t.stored(n).every((b) => b[1] === '502' && b[2] >= 420000), t.stored(n));
  t.engine.close();
  // 30 s on the clock, then the device asleep for 2 min (its timers stood still): read again.
  const u = await plexQuestion();
  await u.clock.advance(30000);
  u.asleepMs += 2 * MIN;
  u.wallExtra += 2 * MIN;
  const r2 = u.positionCalls;
  u.btn('Keep listening here').click();
  await u.clock.advance(3000);
  check('asleep past 2 min: read again', u.positionCalls === r2 + 1, u.positionCalls - r2);
  check('asleep: not moved, so the answer went on', u.prompts().length === 0 && u.st().playing, [u.prompts(), u.st().playing]);
  u.engine.close();
});

await run('PR3: a double tap while the place is read again acts once', async () => {
  for (const moved of [true, false]) {
    const t = await plexQuestion();
    await t.clock.advance(10 * MIN);
    if (moved) t.places = { web: t.places.web, plex: plexCopyAt('503', 120000, t.now() - 30000, 300000) };
    t.positionDelay = 1000;
    const reads = t.positionCalls;
    const n = t.posts.length;
    const keep = t.btn('Keep listening here');
    const cont = t.btn('Continue');
    keep.click();
    keep.click();                              // the second tap of a double tap, on the same button
    cont.click();                              // or on the other one
    await t.clock.advance(100);
    check((moved ? 'moved' : 'not moved') + ': one read; the buttons wait', t.positionCalls === reads + 1 && t.waiting(), [t.positionCalls - reads, t.btns()]);
    await t.clock.advance(12000);
    check((moved ? 'moved' : 'not moved') + ': still one read', t.positionCalls === reads + 1, t.positionCalls - reads);
    if (moved) {
      check('moved: one question, at the new place; nothing done', t.prompts().join() === 'Continue from 27:00 (Plexamp, just now)?' &&
        t.posts.length === n && !t.st().playing, [t.prompts(), t.stored(n)]);
    } else {
      check('not moved: the first tap\'s answer only (Keep listening here), never Continue\'s', t.prompts().length === 0 && t.st().playing &&
        t.stored(n).length >= 1 && t.stored(n).every((b) => b[1] === '502' && b[2] < 420000) && t.seeks.every((to) => to < 1020000), [t.stored(n), t.seeks]);
    }
    t.engine.close();
  }
});

// ---- Task 4 fix round 1 ----

await run('T4E1: the read refused. 401: the sign-in path, nothing acted on. 404: the answer goes on as before the read existed. 408, 429, 503: kept', async () => {
  // 408 and 429 pass like a 5xx: kept, never taken as the 404's "answer goes on".
  for (const status of [401, 404, 408, 429, 503]) {
    const t = await plexQuestion();
    await t.clock.advance(10 * MIN);
    t.positionStatus = status;
    const reads = t.positionCalls;
    const n = t.posts.length;
    const seeks = t.seeks.length;
    t.btn('Continue').click();
    await t.clock.advance(5000);
    check(status + ': read once', t.positionCalls === reads + 1, t.positionCalls - reads);
    if (status === 404) {
      // Answered: Continue goes to 17:00, and its check-in goes as ever.
      check('404: the answer goes on, through its check-in', t.prompts().length === 0 && t.seeks.slice(seeks).includes(1020000) && t.posts.length > n,
        [t.prompts(), t.seeks.slice(seeks), t.stored(n)]);
    } else {
      check(status + ': the question stays, nothing acted on or saved', /^Continue from 17:00/.test(t.prompts().join()) && !t.waiting() &&
        t.posts.length === n && t.seeks.length === seeks && !t.st().playing, [t.prompts(), t.stored(n), t.seeks.slice(seeks)]);
      check(status + (status === 401 ? ': sent to sign in' : ': not sent to sign in'), t.signedOut === (status === 401 ? 1 : 0), t.signedOut);
    }
    t.engine.close();
  }
});

await run('T4E2: the server could not read Plex (plex_error): the answer waits, nothing saved', async () => {
  for (const answer of ['Continue', 'Keep listening here']) {
    const t = await plexQuestion();
    await t.clock.advance(10 * MIN);
    t.places = { web: t.places.web, plex: plexCopyAt('503', 120000, t.now() - 30000, 300000) };   // moved, unseen
    t.plexError = true;
    const reads = t.positionCalls;
    const n = t.posts.length;
    const seeks = t.seeks.length;
    t.btn(answer).click();
    await t.clock.advance(5000);
    check(answer + ': read once; the question stays, nothing acted on or saved', t.positionCalls === reads + 1 && /^Continue from 17:00/.test(t.prompts().join()) &&
      t.posts.length === n && t.seeks.length === seeks && !t.st().playing, [t.prompts(), t.stored(n)]);
    // Plex readable again: the next answer reads again and finds the move.
    t.plexError = false;
    t.btn(answer).click();
    await t.clock.advance(3000);
    check(answer + ': read again, the new place shows', t.positionCalls === reads + 2 && /^Continue from 27:00/.test(t.prompts().join()) && t.posts.length === n, t.prompts());
    t.engine.close();
  }
});

await run('T4E3: the wall clock set back past when the question showed: read again all the same', async () => {
  const t = await plexQuestion();
  t.asleepMs = -3600000;                           // the clock stepped back an hour after it showed
  await t.clock.advance(10 * MIN);
  t.places = { web: t.places.web, plex: plexCopyAt('503', 120000, t.now() - 30000, 300000) };
  const reads = t.positionCalls;
  const n = t.posts.length;
  t.btn('Continue').click();
  await t.clock.advance(3000);
  check('read again, the new place shows, nothing saved', t.positionCalls === reads + 1 && /^Continue from 27:00/.test(t.prompts().join()) && t.posts.length === n,
    [t.positionCalls - reads, t.prompts(), t.stored(n)]);
  t.engine.close();
});

await run('T4F1: a Pause while the place is read again: the answer moves (and saves) but does not play', async () => {
  for (const answer of ['Continue', 'Keep listening here']) {
    for (const playingFirst of [false, true]) {
      const what = answer + (playingFirst ? ' (playing on first)' : '');
      const t = await plexQuestion();
      if (playingFirst) {
        t.engine.play();
        await t.clock.advance(2000);
      }
      await t.clock.advance(10 * MIN);
      t.positionDelay = 2000;
      const n = t.posts.length;
      const seeks = t.seeks.length;
      t.btn(answer).click();
      await t.clock.advance(500);
      t.ms.handlers.get('pause')();                // the lock screen's Pause, during the read
      await t.clock.advance(6000);
      check(what + ': answered, not playing', t.prompts().length === 0 && !t.st().playing, [t.prompts(), t.st().playing]);
      if (answer === 'Continue') {
        check(what + ': moved to 17:00 and saved there', t.seeks.slice(seeks).includes(1020000) && t.stored(n).some((b) => b[1] === '502' && b[2] === 420000), t.stored(n));
      }
      t.engine.close();
    }
  }
  // Paused, then played again during the read: it plays on, as answered.
  const u = await plexQuestion();
  await u.clock.advance(10 * MIN);
  u.positionDelay = 2000;
  u.btn('Keep listening here').click();
  await u.clock.advance(300);
  u.ms.handlers.get('pause')();
  await u.clock.advance(300);
  u.ms.handlers.get('play')();
  await u.clock.advance(6000);
  check('paused then played during the read: plays on', u.prompts().length === 0 && u.st().playing, [u.prompts(), u.st().playing]);
  u.engine.close();
});

await run('T4F2/F3: the pressed button keeps the focus while the place is read again; the question is the same element throughout', async () => {
  for (const mode of ['moved', 'failed']) {
    const t = await plexQuestion();
    t.ui.open();
    await t.clock.advance(50);
    await t.clock.advance(10 * MIN);
    if (mode === 'moved') t.places = { web: t.places.web, plex: plexCopyAt('503', 120000, t.now() - 30000, 300000) };
    else t.positionMode = 'down';
    t.positionDelay = mode === 'moved' ? 1000 : 0;
    const box = t.q('.wsp-prompt');
    const b = t.btn('Continue');
    b.focus();
    b.click();
    check(mode + ': during the read, the same question with its buttons, the focus on the one pressed', t.q('.wsp-prompt') === box && t.doc.activeElement === b && t.waiting() &&
      box.getAttribute('aria-busy') === 'true', [t.doc.activeElement && t.doc.activeElement.textContent, t.btns()]);
    await t.clock.advance(3000);
    check(mode + ': after it, still the same question and button, focused and ready', t.q('.wsp-prompt') === box && t.btn('Continue') === b && t.doc.activeElement === b &&
      b.getAttribute('aria-disabled') === 'false' && box.getAttribute('aria-busy') === 'false', [t.prompts(), t.doc.activeElement && t.doc.activeElement.textContent]);
    check(mode + ': its words', t.prompts().join() === (mode === 'moved' ? 'Continue from 27:00 (Plexamp, just now)?' : 'Continue from 17:00 (Plexamp, 11 min ago)?'), t.prompts());
    t.engine.close();
  }
});

await run('T4F5: "Keep listening here" after the book ended under the question: no restart from 0:00', async () => {
  const t = await plexQuestion();
  t.engine.play();                                 // plays on under the question (unsaved)
  await t.clock.advance(16 * MIN);                 // ... to the book's end
  const s0 = t.st();
  check('the book ended under the question', !s0.playing && s0.bookMs >= s0.bookDurationMs && t.prompts().length === 1, [s0.bookMs, s0.bookDurationMs, t.prompts()]);
  const n = t.posts.length;
  t.btn('Keep listening here').click();
  await t.clock.advance(6000);
  const s1 = t.st();
  check('not playing, still at the end, nothing saved at 0:00', !s1.playing && s1.bookMs >= s1.bookDurationMs && t.posts.slice(n).every((b) => b.track !== '501' || b.offset_ms > 0),
    [s1.playing, s1.position, t.stored(n)]);
  t.engine.close();
});

await run('T4M1: the 2-minute line exactly: no read at 120000 ms, a read at 120001', async () => {
  for (const extra of [0, 1]) {
    const t = await plexQuestion();
    await t.clock.advance(t.askedAt + 120000 + extra - t.now());
    const reads = t.positionCalls;
    t.btn('Keep listening here').click();
    await t.clock.advance(10);
    check((120000 + extra) + ' ms: ' + (extra ? 'read' : 'no read'), t.positionCalls === reads + extra, t.positionCalls - reads);
    t.engine.close();
  }
});

await run('T4M2/M3: one read at a time, each guard on its own; nothing answers the question meanwhile', async () => {
  // The features' guard: a second press while reading asks the engine nothing.
  const t = await plexQuestion();
  await t.clock.advance(10 * MIN);
  t.positionDelay = 2000;
  let asks = 0;
  const real = t.engine.recheckPlex;
  t.engine.recheckPlex = function () { asks += 1; return real.apply(t.engine, arguments); };
  const b = t.btn('Continue');
  b.click();
  b.removeAttribute('aria-disabled');              // forced through, past the waiting button
  b.click();
  t.btn('Keep listening here').removeAttribute('aria-disabled');
  t.btn('Keep listening here').click();
  await t.clock.advance(100);
  check('features: the engine asked once', asks === 1, asks);
  check('M3: resolveConflict() answers nothing during the read', t.engine.resolveConflict() === null && /^Checking/.test(t.prompts().join()));
  t.engine.close();
  // The engine's guard: two calls, one read, one promise.
  const u = await plexQuestion();
  await u.clock.advance(10 * MIN);
  u.positionDelay = 2000;
  const reads = u.positionCalls;
  const p1 = u.engine.recheckPlex();
  const p2 = u.engine.recheckPlex();
  await u.clock.advance(3000);
  check('engine: the same promise, one read', p1 === p2 && u.positionCalls === reads + 1, u.positionCalls - reads);
  u.engine.close();
});

await run('no markup from strings, no intervals, no inline handlers', () => {
  const src = readFileSync(FEATURES_PATH, 'utf8');
  check('no innerHTML', !/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  check('no intervals', src.indexOf('setInterval') === -1);
  check('no handler properties', !/\.on[a-z]+\s*=(?!=)/.test(src));
});

check('nothing logged', consoleErrors.length === 0, consoleErrors);

const summary = `${total - failed}/${total} player features cases pass`;
if (failed) {
  realError(summary.replace('pass', 'checked') + `, ${failed} failed`);
  process.exit(1);
}
console.log(summary);
process.exit(0);
