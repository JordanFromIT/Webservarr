// The audiobook player's "Find your place" helper
// (app/static/js/player/findplace.js, spec 2026-09-30 audiobook files changed,
// section 5): the pure candidate spots, then the panel run in happy-dom on top
// of the REAL engine (engine.js), its real saves (saves.js), its real view
// (ui.js) and the real features (features.js, the history it opens), against
// a scripted Plex as in player_features.mjs: a fake <audio> element that loads
// and plays in 250 ms ticks, fake /api/player endpoints and fake timers. A
// book is held for its changed files by a saved place in a part it does not
// have (track 401, an earlier copy's).
//
// Imports each module as it is, through a data: URL like player_engine.mjs
// (which also proves none touches the DOM at import time).
// The safety net (spec 2.6, js/player/safetynet.js: "Were you listening to
// one of these?") is run the same way, on the same page, further down.
// FINDPLACE_JS, SAFETYNET_JS, FEATURES_JS, UI_JS, ENGINE_JS and SAVES_JS (=<path>) run the
// same cases against other copies of those files.
// Run: node app/tests/js/player_findplace.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(p, 'utf8')));
const FINDPLACE_PATH = process.env.FINDPLACE_JS || join(here, '../../static/js/player/findplace.js');
const FP = await load(FINDPLACE_PATH);
const SAFETYNET_PATH = process.env.SAFETYNET_JS || join(here, '../../static/js/player/safetynet.js');
const SN = await load(SAFETYNET_PATH);
const F = await load(process.env.FEATURES_JS || join(here, '../../static/js/player/features.js'));
const E = await load(process.env.ENGINE_JS || join(here, '../../static/js/player/engine.js'));
const S = await load(process.env.SAVES_JS || join(here, '../../static/js/player/saves.js'));
const U = await load(process.env.UI_JS || join(here, '../../static/js/player/ui.js'));

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
// Chapters are the parts: chapter 1 ends where part 1 does. 30 minutes.
const MULTI = {
  key: '500:1', title: 'Three Parts', author: 'A. Writer', narrator: 'A. Reader', series: '', cover: '', shape: 'parts',
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
// The middle part is a format this browser can't decode (600000 to 620000).
const MIXED = {
  key: '520:1', title: 'Mixed', author: 'C. Writer', narrator: '', series: '', cover: '', shape: 'parts',
  tracks: [
    { key: '521', part_path: '/library/parts/921/1/file.mp3', duration_ms: 600000, index: 1, ...MP3 },
    { key: '522', part_path: '/library/parts/922/1/file.m4b', duration_ms: 20000, index: 2, ...EAC3 },
    { key: '523', part_path: '/library/parts/923/1/file.mp3', duration_ms: 300000, index: 3, ...MP3 }
  ],
  chapters: []
};
// The last 30 s fall in a part this browser can't decode: 0-600 s mp3,
// 600-620 s E-AC3, 620-640 s mp3 (the credits).
const TAIL = {
  key: '640:1', title: 'Tail', author: 'S. Writer', narrator: '', series: '', cover: '', shape: 'parts',
  tracks: [
    { key: '641', part_path: '/library/parts/1001/1/file.mp3', duration_ms: 600000, index: 1, ...MP3 },
    { key: '642', part_path: '/library/parts/1002/1/file.m4b', duration_ms: 20000, index: 2, ...EAC3 },
    { key: '643', part_path: '/library/parts/1003/1/file.mp3', duration_ms: 20000, index: 3, ...MP3 }
  ],
  chapters: [
    { index: 1, label: 'Story', start_ms: 0, end_ms: 600000 },
    { index: 2, label: 'Music', start_ms: 600000, end_ms: 620000 },
    { index: 3, label: 'Credits', start_ms: 620000, end_ms: 640000 }
  ]
};
const BOOKS = { [MULTI.key]: MULTI, [MIXED.key]: MIXED, [TAIL.key]: TAIL };
const trackByPath = new Map();
for (const b of Object.values(BOOKS)) for (const t of b.tracks) trackByPath.set(t.part_path, t);
const UNDECODABLE = new Set(['', 'audio/mp4; codecs="ec-3"']);

// A media element as far as the engine uses it (after player_features.mjs's).
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
  }
  canPlayType(mime) { return UNDECODABLE.has(mime) ? '' : 'probably'; }
  addEventListener(n, fn) { if (!this.ls.has(n)) this.ls.set(n, []); this.ls.get(n).push(fn); }
  removeEventListener(n, fn) { const a = this.ls.get(n); if (a && a.indexOf(fn) !== -1) a.splice(a.indexOf(fn), 1); }
  fire(n) { for (const fn of (this.ls.get(n) || []).slice()) fn.call(this, { type: n, target: this }); }
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
    const track = trackByPath.get(path);
    this.t.clock.setTimeout(() => {
      if (g !== this.gen) return;
      if (!track) { this.error = { code: 4 }; this.fire('error'); return; }
      this.duration = track.duration_ms / 1000;
      this.readyState = 1;
      this.fire('loadedmetadata');
      if (g !== this.gen) return;
      this.readyState = 4;
      this.fire('canplay');
      if (!this.paused) this.begin();
    }, 50);
  }
  play() {
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
const ME = 'k3v9x0q2m7w1p4z8r6t5y2u0';        // this browser's id
const OTHER = 'q8w2e6r4t0y9u1i3o5p7a2s4';     // another device's
const ID = '3f9a0c1d2b7e4a6f';                // the identity key of the local copy

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

// A CloseWatcher as far as ui.js uses it: close() fires its 'close'.
function closeWatchers() {
  const live = [];
  class CW {
    constructor() { this.ls = []; live.push(this); }
    addEventListener(n, fn) { if (n === 'close') this.ls.push(fn); }
    destroy() { const i = live.indexOf(this); if (i !== -1) live.splice(i, 1); }
    close() { this.destroy(); for (const fn of this.ls) fn({ type: 'close' }); }
  }
  return { CW, live };
}

/* One page: the real engine, saves, view, features and helper. o: { wide,
   web (WebServarr's copy at the open), noHelper, closeWatcher }. */
async function setup(o = {}) {
  const win = new Window({ url: 'https://ws.test/news' });
  const doc = win.document;
  doc.body.innerHTML = '<main><h1>News</h1><button id="pageBtn" type="button">Page</button></main><div id="wsPlayer" hidden></div>';
  const clock = fakeClock();
  const t = { win, doc, clock, posts: [], fetches: [] };
  t.now = () => NOW0 + clock.now;
  t.places = { web: o.web === undefined ? null : o.web, plex: null };
  t.orphans = o.orphans;
  t.dismissed = o.dismissed || new Set();     // the server's "None of these" (shared by a reload)
  t.dismissals = [];
  t.history = {};
  t.positionDelay = 0;
  async function fetchFn(url, init) {
    init = init || {};
    t.fetches.push({ url, method: init.method || 'GET' });
    if (url === '/api/player/prefs') {
      if ((init.method || 'GET') === 'PUT') return response(200, {});
      return response(200, { skip_s: 10, speed: 1, smart_rewind: true });
    }
    let m = /^\/api\/player\/book\/([^?]+)/.exec(url);
    if (m) {
      const b = BOOKS[decodeURIComponent(m[1])];
      if (!b) return response(404, { detail: 'Not in the audiobook library' });
      return response(200, { ...b, stream: { token: 'tok', uris: { local: [], remote: [REMOTE] } } });
    }
    m = /^\/api\/player\/history\/([^?]+)(?:\?before=(.+))?$/.exec(url);
    if (m) return response(200, t.history[m[2] ? decodeURIComponent(m[2]) : ''] || { entries: [], next_before: null });
    // The safety net: t.orphans (an array of places, a status number, or
    // undefined: none) answers GET /api/player/orphans/<key>; once the
    // listener has said "None of these" for a book, the server answers with
    // none and says it was dismissed.
    m = /^\/api\/player\/orphans\/([^/]+?)(\/dismiss)?$/.exec(url);
    if (m) {
      const key = decodeURIComponent(m[1]);
      if (m[2]) {
        t.dismissed.add(key);
        t.dismissals.push(key);
        return response(200, { dismissed: true });
      }
      if (t.orphansDelay) await new Promise((r) => clock.setTimeout(r, t.orphansDelay));
      if (typeof t.orphans === 'number') return response(t.orphans, { detail: 'no' });
      if (t.orphans === undefined) return response(200, { orphans: [], dismissed: false });
      return response(200, { orphans: t.dismissed.has(key) ? [] : t.orphans, dismissed: t.dismissed.has(key) });
    }
    m = /^\/api\/player\/position\/(.+)$/.exec(url);
    if (m) {
      if (t.positionDelay) await new Promise((r) => clock.setTimeout(r, t.positionDelay));
      return response(200, { web: t.places.web, plex: t.places.plex, now: new Date(t.now()).toISOString() });
    }
    if (url.startsWith('/api/player/next/')) return response(200, { next: null });
    return response(404, {});
  }
  t.fetch = fetchFn;
  const saver = S.createSaver({
    post: (body) => {
      t.posts.push(body);
      return Promise.resolve({ status: 200, data: { stored: true, updated_at: new Date(t.now()).toISOString(), linked: true } });
    },
    now: t.now,
    mono: () => clock.now,
    storage: (t.storage = o.storage || memoryStorage()),
    identity: ID,
    device: 'Test on Linux',
    deviceId: ME,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    psid: 'test-psid'
  });
  const ms = { metadata: null, playbackState: 'none', handlers: new Map(), setActionHandler(a, fn) { this.handlers.set(a, fn); }, setPositionState() {} };
  t.ms = ms;
  const host = doc.getElementById('wsPlayer');
  t.engine = E.createEngine({
    now: t.now,
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
  t.env = { wide: !!o.wide, activation: !o.noActivation };
  const matchMedia = (q) => ({
    get matches() { return q.indexOf('min-width') !== -1 ? t.env.wide : false; },
    addEventListener() {}
  });
  t.cw = o.closeWatcher ? closeWatchers() : null;
  t.ui = U.createUI({
    doc, host, player: t.engine, matchMedia,
    measure: () => 72,
    isVisible: (el) => !el.closest('[hidden]'),
    now: t.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ResizeObserver: null,
    isDialogOpen: () => false,
    leaveTo: () => {},
    win,
    CloseWatcher: t.cw ? t.cw.CW : null,
    hasActivation: () => t.env.activation
  });
  t.features = F.createFeatures({
    player: t.engine, ui: t.ui, doc, win, fetch: fetchFn,
    now: t.now, mono: () => clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    matchMedia,
    isDialogOpen: () => false,
    pathname: () => '/news',
    tourActive: () => false,
    findPlace: () => t.helper || null
  });
  if (!o.noHelper) {
    t.helper = FP.createFindPlace({ player: t.engine, ui: t.ui, doc, now: t.now, features: () => t.features });
  }
  if (!o.noSafetyNet) t.safety = SN.createSafetyNet({ player: t.engine, ui: t.ui, doc, now: t.now });
  await clock.advance(10);
  t.q = (sel) => doc.querySelector(sel);
  t.qa = (sel) => Array.from(doc.querySelectorAll(sel));
  t.st = () => t.engine.state();
  t.view = () => t.q('.wsp-full').getAttribute('data-view');
  t.panel = () => t.q('.wsp-panel[data-panel="findplace"]');
  t.shown = () => !!t.panel() && !t.panel().hidden && t.view() === 'findplace';
  t.cards = () => t.qa('.wsp-fp-cand').filter((c) => !c.hidden && !c.classList.contains('wsp-sn-item'));
  t.snPanel = () => t.q('.wsp-panel[data-panel="safetynet"]');
  t.snShown = () => !!t.snPanel() && !t.snPanel().hidden && t.view() === 'safetynet';
  t.snRows = () => t.qa('.wsp-sn-item');
  t.card = (kind) => t.q(`.wsp-fp-cand[data-kind="${kind}"]`);
  t.txt = (sel) => { const n = t.q(sel); return n && !n.hidden ? n.textContent : null; };
  t.key = (target, k, extra = {}) => {
    const ev = new win.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra));
    target.dispatchEvent(ev);
    return ev;
  };
  t.prompts = () => t.qa('.wsp-prompt .wsp-notice-text').map((n) => n.textContent);
  t.promptBtn = (label) => t.qa('.wsp-prompt .wsp-notice-btn').find((b) => b.textContent === label) || null;
  // Spies on the engine's helper calls (the helper reads them at each call).
  t.calls = [];
  for (const name of ['previewAt', 'confirmPlace', 'startOver', 'seek', 'pickOrphan', 'dismissOrphans']) {
    const real = t.engine[name];
    t.engine[name] = function () {
      t.calls.push([name].concat(Array.from(arguments)));
      return real.apply(t.engine, arguments);
    };
  }
  return t;
}

// The place saved before the files changed, in an earlier copy of the book
// (track 401 is not in the book): 12:00 of a 60-minute copy.
function earlier(t, extra = {}) {
  return Object.assign({
    track: '401', offset_ms: 120000, duration_ms: 900000, updated_at: new Date(t.now() - 3600000).toISOString(),
    device: 'Chrome on Windows', device_id: OTHER, psid: 'other', book_ms: 720000, book_duration_ms: 3600000,
    chapter_label: 'Chapter 4', linked_from: '400:1', book_title: 'Three Parts (First Edition)', narrator: 'A. Reader'
  }, extra);
}

// A book held for its changed files, opened from a page (a tap there).
async function held(o = {}) {
  const t = await setup(o);
  t.places.web = earlier(t, o.old || {});
  const p = t.engine.open(o.book || MULTI.key);
  await t.clock.advance(300);
  await p;
  return t;
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

const CH = MULTI.chapters;

await run('candidates: the same time and the same point in the book, each with this copy\'s chapter', () => {
  const c = FP.candidates({ book_ms: 720000, book_duration_ms: 3600000 }, 1800000, CH, null);
  check('two', c.length === 2, c);
  check('the same time', c[0].kind === 'time' && c[0].bookMs === 720000 && c[0].chapterLabel === 'Part 2 of 3' && c[0].unavailable === false, c[0]);
  check('the same point: 20% of this copy', c[1].kind === 'percent' && c[1].bookMs === 360000 && c[1].chapterLabel === 'Part 1 of 3' && c[1].unavailable === false, c[1]);
  check('rounded to a whole ms', FP.candidates({ book_ms: 1, book_duration_ms: 3 }, 1800000, [], null)[1].bookMs === 600000);
  check('a chapter start is that chapter\'s', FP.candidates({ book_ms: 600000 }, 1800000, CH, null)[0].chapterLabel === 'Part 2 of 3');
  check('no chapters: no label', FP.candidates({ book_ms: 600000 }, 1800000, [], null)[0].chapterLabel === '');
  const unnamed = FP.candidates({ book_ms: 700000 }, 1800000, [{ start_ms: 0 }, { start_ms: 600000 }], null)[0];
  check('an unnamed chapter is numbered', unnamed.chapterLabel === 'Chapter 2', unnamed);
});

await run('candidates: within 5 s only the same time is kept', () => {
  // 1 000 000 of 2 000 000 in a copy of 2 010 000: the point is 1 005 000.
  const at5 = FP.candidates({ book_ms: 1000000, book_duration_ms: 2000000 }, 2010000, [], null);
  check('exactly 5 s apart: one', at5.length === 1 && at5[0].kind === 'time' && at5[0].bookMs === 1000000, at5);
  const over = FP.candidates({ book_ms: 1000000, book_duration_ms: 2000000 }, 2010002, [], null);
  check('5.001 s apart: both', over.length === 2 && over[1].bookMs === 1005001, over);
  const same = FP.candidates({ book_ms: 720000, book_duration_ms: 1800000 }, 1800000, CH, null);
  check('the same length: one', same.length === 1 && same[0].kind === 'time', same);
  const back = FP.candidates({ book_ms: 1000000, book_duration_ms: 2000000 }, 1996000, [], null);
  check('within 5 s the other way: one', back.length === 1, back);
});

await run('Review Focus 2: a 20 h place in a 10 h copy is clamped, and the point in the book is sensible', () => {
  const H = 3600000;
  const c = FP.candidates({ book_ms: 20 * H, book_duration_ms: 25 * H }, 10 * H, [], null);
  check('two candidates', c.length === 2, c);
  // T3F2: never the very end (a Play there would start again from 0:00).
  check('the same time: clamped to 30 s before this copy\'s end', c[0].kind === 'time' && c[0].bookMs === 10 * H - 30000 && c[0].clamped === true, c[0]);
  check('the same point: 80% of this copy', c[1].kind === 'percent' && c[1].bookMs === 8 * H && c[1].clamped === false, c[1]);
  check('both inside the copy', c.every((x) => x.bookMs >= 0 && x.bookMs <= 10 * H - 30000));
  const end = FP.candidates({ book_ms: 20 * H, book_duration_ms: 20 * H }, 10 * H, [], null);
  check('the old end: one candidate, 30 s before this copy\'s end', end.length === 1 && end[0].bookMs === 10 * H - 30000 && end[0].clamped, end);
  const bad = FP.candidates({ book_ms: 30 * H, book_duration_ms: 20 * H }, 10 * H, [], null);
  check('a place past its own length still lands inside', bad.every((x) => x.bookMs <= 10 * H - 30000), bad);
  const inside = FP.candidates({ book_ms: 10 * H - 30000 }, 10 * H, [], null)[0];
  check('exactly at the margin: not clamped', inside.bookMs === 10 * H - 30000 && inside.clamped === false, inside);
  check('a copy under 30 s: its start', FP.candidates({ book_ms: 5000 }, 20000, [], null)[0].bookMs === 0);
});

await run('Review Focus 1: no book time, no candidates', () => {
  for (const v of [undefined, null, NaN, -5, '720000', Infinity]) {
    check(`book_ms ${String(v)}`, FP.candidates({ book_ms: v, book_duration_ms: 3600000 }, 1800000, CH, null).length === 0);
  }
  check('no old place', FP.candidates(null, 1800000, CH, null).length === 0);
  check('no length known for this copy', FP.candidates({ book_ms: 1000 }, 0, CH, null).length === 0);
  const noLen = FP.candidates({ book_ms: 720000 }, 1800000, CH, null);
  check('no old length: the same time only', noLen.length === 1 && noLen[0].kind === 'time', noLen);
  check('an old length of 0: the same time only', FP.candidates({ book_ms: 720000, book_duration_ms: 0 }, 1800000, CH, null).length === 1);
  check('a place at 0 is a place', FP.candidates({ book_ms: 0, book_duration_ms: 100 }, 1800000, CH, null)[0].bookMs === 0);
});

await run('Review Focus 5: a candidate in a part this browser can\'t decode is unavailable', () => {
  const parts = [
    { start_ms: 0, duration_ms: 600000, playable: true },
    { start_ms: 600000, duration_ms: 20000, playable: false },
    { start_ms: 620000, duration_ms: 300000, playable: true }
  ];
  const c = FP.candidates({ book_ms: 610000, book_duration_ms: 1840000 }, 920000, [], parts);
  check('the same time is in the blocked part', c[0].bookMs === 610000 && c[0].unavailable === true, c[0]);
  check('the same point is not', c[1].bookMs === 305000 && c[1].unavailable === false, c[1]);
  check('the start of the blocked part is blocked', FP.candidates({ book_ms: 600000 }, 920000, [], parts)[0].unavailable === true);
  check('the start of the part after is not', FP.candidates({ book_ms: 620000 }, 920000, [], parts)[0].unavailable === false);
  check('a function works too', FP.candidates({ book_ms: 5 }, 920000, [], (ms) => ms === 5)[0].unavailable === true);
  check('a throwing one is not blocked', FP.candidates({ book_ms: 5 }, 920000, [], () => { throw new Error('x'); })[0].unavailable === false);
});

await run('text: book time, percent, ago and the earlier copy\'s name', () => {
  check('always hours', FP.bookClock(725000) === '0:12:05' && FP.bookClock(11560000) === '3:12:40', [FP.bookClock(725000), FP.bookClock(11560000)]);
  check('percent: whole, down', FP.percentOf(640, 1000) === 64 && FP.percentOf(999, 1000) === 99 && FP.percentOf(1000, 1000) === 100);
  check('percent unknown', FP.percentOf(5, 0) === null && FP.percentOf(null, 10) === null);
  check('ago', FP.formatAgo(30000) === 'just now' && FP.formatAgo(3 * MIN) === '3 min ago' && FP.formatAgo(2 * 3600000) === '2 h ago' && FP.formatAgo(3 * 86400000) === '3 days ago');
  check('named, with the narrator', FP.copyLine({ linked_from: '400:1', book_title: 'Saga (Full Cast)', narrator: 'A. Reader' }) === 'From an earlier copy: Saga (Full Cast), read by A. Reader');
  check('no narrator: left out', FP.copyLine({ linked_from: '400:1', book_title: 'Saga', narrator: null }) === 'From an earlier copy: Saga');
  // T3F5: files changed within the same album are no earlier copy.
  check('no link: nothing, even with a title', FP.copyLine({ linked_from: null, book_title: 'Saga', narrator: 'A. Reader' }) === '' &&
    FP.copyLine({ book_title: 'Saga', earlier: true }) === '');
  check('a linked copy with no title', FP.copyLine({ linked_from: '400:1' }) === 'From an earlier copy');
  check('nothing to say', FP.copyLine({}) === '' && FP.copyLine(null) === '');
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

await run('the panel opens with the hold, in the full player, and shows the old place and the candidates', async () => {
  const t = await held();
  check('held', t.st().filesChanged !== null);
  check('the full player is open', t.ui.isOpen() && !t.q('.wsp-full').hidden);
  check('on the helper', t.shown() && t.q('#wspPanel-findplace').textContent === 'Find your place', t.view());
  check('focus inside the full player', t.q('.wsp-full').contains(t.doc.activeElement), t.doc.activeElement && t.doc.activeElement.outerHTML);
  check('the earlier copy is named', t.txt('.wsp-fp-copy') === 'From an earlier copy: Three Parts (First Edition), read by A. Reader', t.txt('.wsp-fp-copy'));
  check('the old book time and percent', t.txt('.wsp-fp-old-time') === '0:12:00 into the book · 20%', t.txt('.wsp-fp-old-time'));
  check('the old chapter', t.txt('.wsp-fp-old-chapter') === 'Chapter 4');
  check('when', t.txt('.wsp-fp-old-when') === 'Last listened 1 h ago', t.txt('.wsp-fp-old-when'));
  const cards = t.cards();
  check('two candidates', cards.length === 2 && cards[0].getAttribute('data-kind') === 'time' && cards[1].getAttribute('data-kind') === 'percent', cards.map((c) => c.getAttribute('data-kind')));
  check('their names', cards.map((c) => c.querySelector('.wsp-fp-kind').textContent).join() === 'Same time,Same point in the book');
  check('this copy\'s chapters', cards[0].querySelector('.wsp-fp-at').textContent === '0:12:00 · Part 2 of 3' && cards[1].querySelector('.wsp-fp-at').textContent === '0:06:00 · Part 1 of 3',
    cards.map((c) => c.querySelector('.wsp-fp-at').textContent));
  check('each with Preview (the primary) and Use this spot', cards.every((c) => {
    const b = Array.from(c.querySelectorAll('button')).filter((x) => !x.closest('.wsp-fp-nudge'));
    return b.length === 2 && b[0].classList.contains('is-primary') && b[0].textContent.indexOf('Preview') !== -1 && b[1].textContent === 'Use this spot' && !b[0].hidden;
  }));
  check('the first is chosen, with the nudge', cards[0].classList.contains('is-chosen') && !!cards[0].querySelector('.wsp-fp-nudge') && !cards[1].querySelector('.wsp-fp-nudge'));
  check('the chosen spot is the engine\'s, at it', t.st().filesChanged.spot === 720000 && t.st().bookMs === 720000, t.st().filesChanged.spot);
  check('Show history and Start from the beginning', t.qa('.wsp-fp-row').filter((b) => !b.closest('[hidden]')).map((b) => b.textContent.replace(/^\w+(?=[A-Z])/, '')).join() === 'Show history,Start from the beginning',
    t.qa('.wsp-fp-row').map((b) => b.textContent));
  check('"Not this book" is only for a pick from the safety net', t.qa('.wsp-fp-row').filter((b) => b.textContent.indexOf('Not this book') !== -1).every((b) => b.closest('[hidden]')));
  check('no "nothing to match" note', t.q('.wsp-fp-none').hidden);
  check('not playing, nothing saved', !t.st().playing && t.posts.length === 0, t.posts);
  await t.clock.advance(20000);
  check('still nothing saved after 20 s', t.posts.length === 0, t.posts.length);
  t.engine.close();
});

await run('Preview calls previewAt; it plays 15 s and saves nothing; Pause stops it', async () => {
  const t = await held();
  const [time, pct] = t.cards();
  const prev = (c) => c.querySelector('.wsp-fp-preview');
  prev(pct).click();
  check('previewAt the other candidate', JSON.stringify(t.calls.filter((c) => c[0] === 'previewAt')) === '[["previewAt",360000]]', t.calls);
  check('it is chosen now', pct.classList.contains('is-chosen') && !time.classList.contains('is-chosen') && !!pct.querySelector('.wsp-fp-nudge'));
  await t.clock.advance(1000);
  check('playing', t.st().playing && t.st().filesChanged !== null);
  check('the button pauses it while it plays', prev(pct).textContent.indexOf('Pause') !== -1, prev(pct).textContent);
  prev(pct).click();
  await t.clock.advance(100);
  check('paused', !t.st().playing);
  prev(time).click();
  await t.clock.advance(20000);
  check('a preview of the first: 15 s then stopped', !t.st().playing && t.st().bookMs >= 734000 && t.st().bookMs <= 736000, t.st().bookMs);
  check('nothing saved', t.posts.length === 0, t.posts);
  check('still held, the spot at the candidate', t.st().filesChanged && t.st().filesChanged.spot === 720000);
  t.engine.close();
});

await run('the nudge moves the chosen spot, and Use this spot confirms the nudged value', async () => {
  const t = await held();
  const time = t.card('time');
  const fwd = t.qa('.wsp-fp-step')[1];
  fwd.click();
  check('forward by the skip length', t.st().filesChanged.spot === 730000, t.st().filesChanged.spot);
  check('shown on the card', time.querySelector('.wsp-fp-at').textContent === '0:12:10 · Part 2 of 3 · +10 s', time.querySelector('.wsp-fp-at').textContent);
  const range = t.q('.wsp-fp-range');
  const k = t.key(range, 'ArrowLeft');
  check('an arrow nudges by a second, its own key', t.st().filesChanged.spot === 729000 && k.defaultPrevented, t.st().filesChanged.spot);
  range.value = String(Number(range.value) + 30);
  range.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('a drag only shows', t.st().filesChanged.spot === 729000);
  range.dispatchEvent(new t.win.Event('change', { bubbles: true }));
  check('let go: moved', t.st().filesChanged.spot === 759000, t.st().filesChanged.spot);
  check('nothing saved for any of it', t.posts.length === 0);
  // A preview from the chosen card plays from the nudged spot.
  time.querySelector('.wsp-fp-preview').click();
  check('the preview is from the nudged spot', t.calls.filter((c) => c[0] === 'previewAt').pop()[1] === 759000, t.calls);
  await t.clock.advance(500);
  t.positionDelay = 1000;               // the confirm's read of the saved places takes a second
  time.querySelector('.wsp-fp-use').click();
  check('confirmPlace with the nudged value', JSON.stringify(t.calls.filter((c) => c[0] === 'confirmPlace')) === '[["confirmPlace",759000]]', t.calls);
  await t.clock.advance(100);
  check('checking: said so, Preview waits', t.st().checking && t.txt('.wsp-fp-status') === 'Checking for a newer place…' &&
    t.qa('.wsp-fp-preview').every((b) => b.disabled), [t.st().checking, t.txt('.wsp-fp-status')]);
  await t.clock.advance(5000);
  check('placed: the hold is over', t.st().filesChanged === null);
  check('the helper has gone', !t.shown() && t.prompts().length === 0, [t.view(), t.prompts()]);
  check('saved there, with the earlier copy\'s key', t.posts.length >= 1 && t.posts.every((b) => b.book_ms >= 759000 && b.linked_from === '400:1'),
    t.posts.map((b) => [b.event, b.book_ms, b.linked_from]));
  check('no Undo for placing it', t.qa('.wsp-notice-btn').every((b) => b.textContent !== 'Undo'));
  t.engine.close();
});

await run('Use this spot on another candidate confirms that candidate', async () => {
  const t = await held();
  t.qa('.wsp-fp-step')[1].click();      // the first, nudged
  t.card('percent').querySelector('.wsp-fp-use').click();
  check('the other candidate\'s own spot', JSON.stringify(t.calls.filter((c) => c[0] === 'confirmPlace')) === '[["confirmPlace",360000]]', t.calls);
  await t.clock.advance(5000);
  check('saved there', t.st().filesChanged === null && t.posts.length >= 1 && t.posts[0].book_ms === 360000, t.posts.map((b) => b.book_ms));
  t.engine.close();
});

await run('Start from the beginning: startOver, never the link', async () => {
  const t = await held();
  const start = t.qa('.wsp-fp-row')[1];
  start.click();
  check('startOver, with nothing passed (so no link)', JSON.stringify(t.calls.filter((c) => c[0] === 'startOver')) === '[["startOver"]]', t.calls);
  await t.clock.advance(5000);
  check('placed at 0', t.st().filesChanged === null && t.st().bookMs === 0 && !t.shown());
  check('saved at 0, no link', t.posts.length >= 1 && t.posts.every((b) => b.book_ms === 0 && !b.linked_from), t.posts.map((b) => [b.book_ms, b.linked_from]));
  t.engine.close();
});

await run('closing is "decide later": nothing saved, still held, and a way back', async () => {
  for (const how of ['escape', 'back', 'close']) {
    const t = await held();
    t.qa('.wsp-fp-step')[1].click();     // a nudge first: kept
    if (how === 'escape') t.key(t.q('#wspPanel-findplace'), 'Escape');
    else if (how === 'back') t.q('.wsp-panel[data-panel="findplace"] .wsp-panel-back').click();
    else t.ui.close();
    await t.clock.advance(30000);
    check(how + ': the helper is put off', !t.shown(), t.view());
    check(how + ': nothing saved, still held', t.posts.length === 0 && t.st().filesChanged !== null && !t.st().playing, t.posts.length);
    check(how + ': a prompt to come back', JSON.stringify(t.prompts()) === '["This book has changed since you last listened."]', t.prompts());
    check(how + ': the player ' + (how === 'close' ? 'closed' : 'still open'), t.ui.isOpen() === (how !== 'close'));
    t.promptBtn('Find your place').click();
    await t.clock.advance(10);
    check(how + ': back on the helper, in the full player', t.shown() && t.ui.isOpen() && t.prompts().length === 0);
    check(how + ': the nudge kept', t.st().filesChanged.spot === 730000 && t.card('time').querySelector('.wsp-fp-at').textContent.endsWith('+10 s'), t.st().filesChanged.spot);
    check(how + ': still nothing saved', t.posts.length === 0);
    t.engine.close();
    await t.clock.advance(10);
    check(how + ': the prompt goes with the book', t.prompts().length === 0 && !t.shown());
  }
});

await run('a CloseWatcher: the phone\'s Back closes the helper alone, nothing saved', async () => {
  const t = await held({ closeWatcher: true, noActivation: true });
  // Opened by the open's warning (no tap: no watchers), put off by Escape,
  // then shown again from a tap.
  check('no watcher without a tap', t.cw.live.length === 0, t.cw.live.length);
  t.key(t.q('#wspPanel-findplace'), 'Escape');
  t.env.activation = true;
  t.promptBtn('Find your place').click();
  await t.clock.advance(10);
  check('shown again', t.shown());
  const watchers = t.cw.live.length;
  check('the panel has a watcher of its own', watchers >= 1, watchers);
  t.cw.live[t.cw.live.length - 1].close();
  await t.clock.advance(10);
  check('Back: the helper is put off, the player stays', !t.shown() && t.ui.isOpen());
  check('nothing saved, still held', t.posts.length === 0 && t.st().filesChanged !== null);
  t.engine.close();
});

await run('the bar\'s Play while held opens the full player on the helper, and plays nothing', async () => {
  const t = await held();
  t.ui.close();
  await t.clock.advance(500);
  t.q('.wsp-bar .wsp-play').click();
  await t.clock.advance(1000);
  check('the full player is open on the helper', t.ui.isOpen() && t.shown());
  check('nothing plays, nothing saved', !t.st().playing && t.calls.every((c) => c[0] !== 'previewAt') && t.posts.length === 0);
  // Not held: the bar's Play plays as ever.
  t.card('time').querySelector('.wsp-fp-use').click();
  await t.clock.advance(5000);
  t.ui.close();
  await t.clock.advance(500);
  t.q('.wsp-bar .wsp-play').click();
  await t.clock.advance(500);
  check('placed: the bar plays', t.st().playing && !t.ui.isOpen());
  t.engine.close();
});

await run('on a wide screen it sits beside the player; Escape closes the player and saves nothing', async () => {
  const t = await held({ wide: true });
  check('beside the player', t.shown() && t.q('.wsp-full').hasAttribute('data-side'));
  t.key(t.q('#wspPanel-findplace'), 'Escape');
  await t.clock.advance(1000);
  check('closed, still held, nothing saved', !t.ui.isOpen() && t.st().filesChanged !== null && t.posts.length === 0);
  check('the way back above the bar', t.prompts().length === 1);
  t.engine.close();
});

await run('Review Focus 1: no book time on the old place: only history and start over', async () => {
  const t = await held({ old: { book_ms: null, book_duration_ms: null, chapter_label: null, book_title: null, linked_from: null } });
  check('held, on the helper', t.st().filesChanged !== null && t.shown());
  check('no candidates, no nudge', t.cards().length === 0 && t.q('.wsp-fp-cands').hidden && !t.q('.wsp-fp-nudge'));
  check('says so', !t.q('.wsp-fp-none').hidden);
  check('history and the start', t.qa('.wsp-fp-row').filter((b) => !b.closest('[hidden]')).length === 2);
  check('no time, no copy line, the last listened', t.txt('.wsp-fp-old-time') === null && t.txt('.wsp-fp-copy') === null && t.txt('.wsp-fp-old-when') === 'Last listened 1 h ago');
  check('nothing moved, nothing saved', t.st().filesChanged.spot === 0 && t.posts.length === 0 && t.calls.length === 0, t.calls);
  t.qa('.wsp-fp-row')[1].click();
  await t.clock.advance(5000);
  check('start over saves 0', t.st().filesChanged === null && t.posts.length >= 1 && t.posts[0].book_ms === 0);
  t.engine.close();
});

await run('Review Focus 5: an unavailable candidate has its preview and confirm disabled', async () => {
  // 10:10 of a 30:40 copy, in this 15:20 copy: the same time is in the part
  // this browser can't decode; the same point (5:05) is not.
  const t = await held({ book: MIXED.key, old: { book_ms: 610000, book_duration_ms: 1840000, chapter_label: null } });
  const time = t.card('time');
  const pct = t.card('percent');
  check('both shown', !!time && !!pct);
  check('the blocked one says so', time.classList.contains('is-off') && time.querySelector('.wsp-fp-note').textContent === "Can't play in this browser" && !time.querySelector('.wsp-fp-note').hidden);
  check('its buttons are disabled', time.querySelector('.wsp-fp-preview').disabled && time.querySelector('.wsp-fp-use').disabled);
  check('the other is chosen, enabled', pct.classList.contains('is-chosen') && !pct.querySelector('.wsp-fp-preview').disabled && !pct.querySelector('.wsp-fp-use').disabled);
  check('the spot is the one that plays', t.st().filesChanged.spot === 305000, t.st().filesChanged.spot);
  time.querySelector('.wsp-fp-preview').click();
  time.querySelector('.wsp-fp-use').click();
  await t.clock.advance(100);
  check('nothing asked of the engine for it', t.calls.every((c) => c[0] === 'seek'), t.calls);
  check('still held, nothing saved', t.st().filesChanged !== null && t.posts.length === 0);
  t.engine.close();
});

await run('a clamped candidate says the copy is shorter', async () => {
  // 25:00 of a 50-minute copy in this 30-minute copy.
  const t = await held({ old: { book_ms: 1500000, book_duration_ms: 3000000 } });
  check('the same time', t.card('time').querySelector('.wsp-fp-at').textContent.startsWith('0:25:00'));
  check('not clamped: nothing to say', t.card('time').querySelector('.wsp-fp-note').hidden);
  t.engine.close();
  // 40:00 of a 50-minute copy in this 30-minute copy (T3F2).
  const u = await held({ old: { book_ms: 2400000, book_duration_ms: 3000000 } });
  check('clamped to 30 s before the end', u.card('time').querySelector('.wsp-fp-at').textContent.startsWith('0:29:30'), u.card('time').querySelector('.wsp-fp-at').textContent);
  check('says why', u.card('time').querySelector('.wsp-fp-note').textContent === 'This copy ends before then');
  check('the same point is chosen, not the clamped time', u.card('percent').classList.contains('is-chosen') && !u.card('time').classList.contains('is-chosen') &&
    u.st().filesChanged.spot === 1440000, u.st().filesChanged.spot);
  u.card('percent').querySelector('.wsp-fp-use').click();
  await u.clock.advance(5000);
  check('confirmed at the same point', u.st().filesChanged === null && u.posts[0].book_ms === 1440000, u.posts.map((b) => b.book_ms));
  u.q('.wsp-play-lg').click();
  await u.clock.advance(3000);
  check('a Play goes on from there, never from 0:00', u.st().playing && u.st().bookMs > 1440000 && u.st().bookMs < 1450000, u.st().bookMs);
  u.engine.close();
  // Only the clamped one (the old end, near this copy's end): none is chosen, and its confirm is short of the end.
  const v = await held({ old: { book_ms: 1800000, book_duration_ms: 1800000 } });
  check('none chosen, the spot left at the start', v.cards().length === 1 && v.qa('.wsp-fp-cand.is-chosen').length === 0 && v.st().filesChanged.spot === 0);
  v.card('time').querySelector('.wsp-fp-use').click();
  await v.clock.advance(5000);
  check('its confirm lands 30 s before the end', v.st().filesChanged === null && v.st().bookMs === 1770000, v.st().bookMs);
  v.engine.close();
});

await run('Show history opens the history; an entry whose part is gone opens the helper with it as the old place', async () => {
  const t = await held();
  t.history[''] = {
    entries: [
      { track: '401', offset_ms: 300000, device: 'Chrome on Android', device_id: OTHER, event: 'pause', at: new Date(t.now() - 2 * 3600000).toISOString(),
        book_key: '400:1', book_ms: 900000, book_duration_ms: 1800000, chapter_label: 'Chapter 5', earlier_copy: true }
    ],
    next_before: null
  };
  t.qa('.wsp-fp-row')[0].click();
  await t.clock.advance(50);
  check('the history', t.view() === 'history' && t.fetches.some((f) => f.url === '/api/player/history/500%3A1'), t.view());
  const row = t.q('.wsp-hist-row');
  check('the entry, labelled', row.querySelector('.wsp-hist-what').textContent === 'Chapter 5 · 0:15:00 into the book · 50%' &&
    row.querySelector('.wsp-hist-tag').textContent === 'Earlier copy' && !row.disabled, row.textContent);
  row.click();
  await t.clock.advance(10);
  check('the helper, with that entry as the old place', t.shown() && t.txt('.wsp-fp-old-time') === '0:15:00 into the book · 50%' && t.txt('.wsp-fp-old-chapter') === 'Chapter 5',
    [t.view(), t.txt('.wsp-fp-old-time')]);
  check('an earlier copy\'s', t.txt('.wsp-fp-copy') === 'From an earlier copy');
  const time = t.card('time');
  check('its candidate (the same length)', !time.hidden && t.card('percent') === null && time.querySelector('.wsp-fp-at').textContent === '0:15:00 · Part 2 of 3',
    time.querySelector('.wsp-fp-at').textContent);
  // T3F3: picked once per hold: the listener's spot stays, shown as itself.
  check('the chosen spot is kept, shown as itself', t.st().filesChanged.spot === 720000 && !t.card('spot').hidden &&
    t.card('spot').querySelector('.wsp-fp-at').textContent === '0:12:00 · Part 2 of 3' && !time.classList.contains('is-chosen'),
    [t.st().filesChanged.spot, t.card('spot').querySelector('.wsp-fp-at').textContent]);
  check('nothing moved, nothing saved', t.calls.filter((c) => c[0] === 'seek').length === 1 && t.posts.length === 0, t.calls);
  time.querySelector('.wsp-fp-use').click();
  await t.clock.advance(5000);
  check('confirmed there, held link kept', t.st().filesChanged === null && t.posts[0].book_ms === 900000 && t.posts[0].linked_from === '400:1', t.posts.map((b) => [b.book_ms, b.linked_from]));
  t.engine.close();
});

await run('while held, a history entry still in the book moves the chosen spot, and the helper shows it', async () => {
  const t = await held();
  t.history[''] = { entries: [{ track: '503', offset_ms: 100000, device: 'Test on Linux', device_id: ME, event: 'pause', at: new Date(t.now() - 60000).toISOString(), book_key: '500:1' }], next_before: null };
  t.qa('.wsp-fp-row')[0].click();
  await t.clock.advance(50);
  t.q('.wsp-hist-row').click();
  await t.clock.advance(10);
  check('the spot is the entry\'s, nothing saved', t.st().filesChanged.spot === 1600000 && t.posts.length === 0, t.st().filesChanged.spot);
  check('back on the helper', t.shown());
  const spot = t.card('spot');
  check('as its own card', !spot.hidden && spot.classList.contains('is-chosen') && spot.querySelector('.wsp-fp-kind').textContent === 'Your chosen spot' &&
    spot.querySelector('.wsp-fp-at').textContent === '0:26:40 · Part 3 of 3', spot.querySelector('.wsp-fp-at').textContent);
  check('the old place is still the held one', t.txt('.wsp-fp-old-time') === '0:12:00 into the book · 20%');
  spot.querySelector('.wsp-fp-use').click();
  check('confirmPlace there', t.calls.filter((c) => c[0] === 'confirmPlace').pop()[1] === 1600000);
  await t.clock.advance(5000);
  check('saved there', t.st().filesChanged === null && t.posts[0].book_ms === 1600000);
  t.engine.close();
});

await run('not held: a gone entry\'s helper has no preview, and Use this spot is an ordinary move', async () => {
  const t = await setup();
  const p = t.engine.open(MULTI.key, { at: { track: '501', offset_ms: 60000 }, autoplay: false });
  await t.clock.advance(300);
  await p;
  t.ui.open();
  t.history[''] = { entries: [{ track: '401', offset_ms: 300000, device: 'Chrome on Android', device_id: OTHER, event: 'pause', at: new Date(t.now() - 86400000).toISOString(),
    book_key: '400:1', book_ms: 900000, book_duration_ms: 3600000, chapter_label: 'The Storm', earlier_copy: true }], next_before: null };
  t.q('.wsp-slot-history .wsp-action').click();
  await t.clock.advance(50);
  t.q('.wsp-hist-row').click();
  await t.clock.advance(10);
  check('the helper', t.shown() && t.txt('.wsp-fp-old-chapter') === 'The Storm' && t.txt('.wsp-fp-old-when') === 'Last listened 1 day ago');
  check('two candidates, no Preview', t.cards().length === 2 && t.qa('.wsp-fp-preview').every((b) => b.hidden));
  check('nothing moved', t.calls.length === 0 && t.st().bookMs === 60000, t.calls);
  t.qa('.wsp-fp-step')[0].click();      // nudge back 10 s, the helper's own
  check('the nudge is the helper\'s own', t.calls.length === 0 && t.card('time').querySelector('.wsp-fp-at').textContent === '0:14:50 · Part 2 of 3 · −10 s',
    t.card('time').querySelector('.wsp-fp-at').textContent);
  const n = t.posts.length;
  t.card('time').querySelector('.wsp-fp-use').click();
  await t.clock.advance(1500);
  check('a seek there', JSON.stringify(t.calls) === '[["seek",890000]]', t.calls);
  check('saved as the listener\'s move', t.posts.length > n && t.posts[t.posts.length - 1].book_ms === 890000 && !t.posts[t.posts.length - 1].linked_from);
  check('with Undo, as any big jump', t.qa('.wsp-notice-btn').some((b) => b.textContent === 'Undo'));
  check('the helper has gone', !t.shown());
  t.engine.close();
});

await run('without the helper a gone entry is disabled, as before', async () => {
  const t = await setup({ noHelper: true });
  const p = t.engine.open(MULTI.key, { at: { track: '501', offset_ms: 60000 }, autoplay: false });
  await t.clock.advance(300);
  await p;
  t.ui.open();
  t.history[''] = { entries: [{ track: '401', offset_ms: 300000, device: 'Chrome on Android', device_id: OTHER, event: 'pause', at: new Date(t.now()).toISOString(), book_key: '400:1', earlier_copy: true }], next_before: null };
  t.q('.wsp-slot-history .wsp-action').click();
  await t.clock.advance(50);
  check('disabled', t.q('.wsp-hist-row').disabled);
  t.engine.close();
});

// ---------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------

await run('T3F1: a drag of the nudge moves the spot when it is let go, whatever comes first', async () => {
  const t = await held();
  const range = t.q('.wsp-fp-range');
  const PE = t.win.PointerEvent || t.win.MouseEvent;
  const drag = (by) => {
    range.dispatchEvent(new PE('pointerdown', { bubbles: true, pointerId: 1 }));
    range.value = String(Number(range.value) + by / 2);
    range.dispatchEvent(new t.win.Event('input', { bubbles: true }));
    range.value = String(Number(range.value) + by / 2);
    range.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };
  const seeks = () => t.calls.filter((c) => c[0] === 'seek').length;
  const n0 = seeks();
  drag(120);
  check('a drag only shows', t.st().filesChanged.spot === 720000 && t.card('time').querySelector('.wsp-fp-at').textContent.startsWith('0:14:00'),
    t.card('time').querySelector('.wsp-fp-at').textContent);
  range.dispatchEvent(new PE('pointerup', { bubbles: true, pointerId: 1 }));
  check('pointerup first (as a browser sends it): moved', t.st().filesChanged.spot === 840000, t.st().filesChanged.spot);
  range.dispatchEvent(new t.win.Event('change', { bubbles: true }));
  await t.clock.advance(10);
  check('the change after it moves nothing more', t.st().filesChanged.spot === 840000 && seeks() === n0 + 1, [t.st().filesChanged.spot, seeks() - n0]);
  drag(-60);
  range.dispatchEvent(new t.win.Event('change', { bubbles: true }));
  range.dispatchEvent(new PE('pointerup', { bubbles: true, pointerId: 1 }));
  check('change first: moved once', t.st().filesChanged.spot === 780000 && seeks() === n0 + 2, [t.st().filesChanged.spot, seeks() - n0]);
  drag(60);
  range.dispatchEvent(new PE('pointercancel', { bubbles: true, pointerId: 1 }));
  check('a cancelled drag goes back', t.st().filesChanged.spot === 780000 && t.card('time').querySelector('.wsp-fp-at').textContent.startsWith('0:13:00'),
    t.card('time').querySelector('.wsp-fp-at').textContent);
  check('nothing saved', t.posts.length === 0);
  t.engine.close();
});

await run('T3F3: picked once per hold; another place shown, Escape and the prompt, an in-book entry: the listener\'s spot stays', async () => {
  const t = await held();
  t.history[''] = {
    entries: [
      { track: '401', offset_ms: 300000, device: 'Chrome on Android', device_id: OTHER, event: 'pause', at: new Date(t.now() - 2 * 3600000).toISOString(),
        book_key: '400:1', book_ms: 900000, book_duration_ms: 1800000, chapter_label: 'Chapter 5', earlier_copy: true },
      { track: '503', offset_ms: 100000, device: 'Test on Linux', device_id: ME, event: 'pause', at: new Date(t.now() - 3 * 3600000).toISOString(), book_key: '500:1' }
    ],
    next_before: null
  };
  t.qa('.wsp-fp-step')[1].click();
  t.qa('.wsp-fp-step')[1].click();
  check('nudged', t.st().filesChanged.spot === 740000);
  t.qa('.wsp-fp-row')[0].click();
  await t.clock.advance(50);
  t.qa('.wsp-hist-row')[0].click();
  await t.clock.advance(10);
  check('another old place: the nudged spot is kept', t.st().filesChanged.spot === 740000 && t.txt('.wsp-fp-old-chapter') === 'Chapter 5', t.st().filesChanged.spot);
  check('as its own card, not the entry\'s candidate 3 min away', t.q('.wsp-fp-cand.is-chosen').getAttribute('data-kind') === 'spot');
  t.qa('.wsp-fp-step')[1].click();
  check('nudged there, it stays its own card', t.st().filesChanged.spot === 750000 && t.q('.wsp-fp-cand.is-chosen').getAttribute('data-kind') === 'spot' &&
    t.q('.wsp-fp-cand.is-chosen .wsp-fp-at').textContent === '0:12:30 · Part 2 of 3', t.q('.wsp-fp-cand.is-chosen .wsp-fp-at').textContent);
  t.key(t.q('#wspPanel-findplace'), 'Escape');
  await t.clock.advance(10);
  t.promptBtn('Find your place').click();
  await t.clock.advance(10);
  check('back from the prompt: still kept', t.shown() && t.st().filesChanged.spot === 750000, t.st().filesChanged.spot);
  t.qa('.wsp-fp-row')[0].click();
  await t.clock.advance(50);
  t.qa('.wsp-hist-row')[1].click();
  await t.clock.advance(10);
  check('an in-book entry: the spot is the entry\'s', t.shown() && t.st().filesChanged.spot === 1600000, t.st().filesChanged.spot);
  const seeks = t.calls.filter((c) => c[0] === 'seek').map((c) => c[1]);
  check('only the open\'s pick, the nudges and the entry moved it', JSON.stringify(seeks) === '[720000,730000,740000,750000,1600000]', seeks);
  const chosen = t.q('.wsp-fp-cand.is-chosen');
  check('shown as the chosen spot', chosen && chosen.getAttribute('data-kind') === 'spot' && chosen.querySelector('.wsp-fp-at').textContent === '0:26:40 · Part 3 of 3');
  chosen.querySelector('.wsp-fp-use').click();
  await t.clock.advance(5000);
  check('confirmed there', t.st().filesChanged === null && t.posts[0].book_ms === 1600000, t.posts.map((b) => b.book_ms));
  t.engine.close();
});

await run('T3F3: held for a same-album change, a gone entry then an in-book one: the in-book spot is the one used', async () => {
  const t = await held({ old: { track: '499', linked_from: null, book_title: null, narrator: null } });
  const base = { device: 'Chrome on Windows', device_id: OTHER, event: 'pause', book_key: '500:1', book_duration_ms: 3600000 };
  t.history[''] = { next_before: null, entries: [
    { ...base, track: '498', offset_ms: 30000, at: new Date(t.now() - 3 * 3600000).toISOString(), book_ms: 300000, chapter_label: 'Chapter 2' },
    { ...base, track: '502', offset_ms: 200000, at: new Date(t.now() - 2 * 86400000).toISOString(), book_ms: 800000, chapter_label: 'Part 2 of 3' }
  ] };
  t.qa('.wsp-fp-row')[0].click();
  await t.clock.advance(50);
  t.q('.wsp-hist-row[data-session="0"]').click();
  await t.clock.advance(10);
  check('the gone one: the spot is kept', t.st().filesChanged.spot === 720000, t.st().filesChanged.spot);
  t.qa('.wsp-fp-row')[0].click();
  await t.clock.advance(50);
  t.q('.wsp-hist-row[data-session="1"]').click();
  await t.clock.advance(10);
  check('the in-book one: there', t.st().filesChanged.spot === 800000, t.st().filesChanged.spot);
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(5000);
  check('confirmed there', t.st().filesChanged === null && t.posts[0].book_ms === 800000, t.posts.map((b) => b.book_ms));
  t.engine.close();
});

await run('T3F4: while a confirm waits on a question, Preview waits too and the panel says so', async () => {
  for (const answer of ['Keep listening here', 'Continue']) {
    const t = await held();
    t.places.plex = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(t.now()).toISOString(), device: 'Plexamp' };
    await t.clock.advance(5000);
    t.card('percent').querySelector('.wsp-fp-use').click();
    await t.clock.advance(200);
    check(answer + ': asked, still held, not checking', !!t.st().filesChanged && !t.st().checking && t.prompts().some((x) => x.indexOf('Continue from') === 0), t.prompts());
    check(answer + ': Preview waits', t.qa('.wsp-fp-cand').filter((c) => !c.hidden).every((c) => c.querySelector('.wsp-fp-preview').disabled));
    check(answer + ': the panel says so', t.txt('.wsp-fp-status') === 'Answer the question above to carry on.', t.txt('.wsp-fp-status'));
    t.card('time').querySelector('.wsp-fp-preview').click();
    check(answer + ': a press there does nothing', t.calls.every((c) => c[0] !== 'previewAt') && t.st().filesChanged.spot === 360000);
    t.qa('.wsp-prompt .wsp-notice-btn').find((b) => b.textContent === answer).click();
    await t.clock.advance(3000);
    check(answer + ': landed where the answer says', t.st().filesChanged === null && t.posts[0].book_ms === (answer === 'Continue' ? 900000 : 360000), t.posts.map((b) => b.book_ms));
    t.engine.close();
  }
});

// Spec 2.5 section 7 (PR3), on the held path: a confirm's Plex question left
// showing is read again before its answer, still held. Moved on: the question
// shows the new place and the helper still waits on it (a later Continue lands
// there); a read that fails or takes over 4 s keeps it all as it was.
await run('PR3 (held): a confirm\'s Plex question left 10 min: Plexamp moved, the question updates, the helper still waits', async () => {
  const reads = (t) => t.fetches.filter((f) => f.url.indexOf('/api/player/position/') === 0).length;
  for (const answer of ['Continue', 'Keep listening here']) {
    const t = await held();
    t.places.plex = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(t.now()).toISOString(), device: 'Plexamp' };
    await t.clock.advance(5000);
    t.card('percent').querySelector('.wsp-fp-use').click();
    await t.clock.advance(200);
    check(answer + ': asked about 15:00', t.prompts().join() === 'Continue from 15:00 (Plexamp, just now)?', t.prompts());
    await t.clock.advance(10 * MIN);
    t.places.plex = { track: '503', offset_ms: 120000, duration_ms: 300000, updated_at: new Date(t.now() - 30000).toISOString(), device: 'Plexamp' };
    const r0 = reads(t);
    t.promptBtn(answer).click();
    check(answer + ': reading, its buttons wait', t.prompts().join() === 'Checking for a newer place…' &&
      ['Continue', 'Keep listening here'].every((l) => t.promptBtn(l) && !t.promptBtn(l).disabled && t.promptBtn(l).getAttribute('aria-disabled') === 'true'), t.prompts());
    check(answer + ': nothing can answer it meanwhile', t.engine.resolveConflict() === null && !!t.st().filesChanged);
    await t.clock.advance(3000);
    check(answer + ': read again, once', reads(t) === r0 + 1, reads(t) - r0);
    check(answer + ': the question shows 27:00', t.prompts().join() === 'Continue from 27:00 (Plexamp, just now)?' && !!t.promptBtn('Continue') && !!t.promptBtn('Keep listening here'), t.prompts());
    check(answer + ': still held at the chosen spot, nothing saved', !!t.st().filesChanged && t.st().filesChanged.spot === 360000 && t.posts.length === 0, [t.st().filesChanged, t.posts.length]);
    check(answer + ': the helper still waits', t.txt('.wsp-fp-status') === 'Answer the question above to carry on.' &&
      t.cards().every((c) => c.querySelector('.wsp-fp-preview').disabled), t.txt('.wsp-fp-status'));
    // The updated question, answered now: no second read; Continue lands at the new place exactly.
    t.promptBtn(answer).click();
    await t.clock.advance(3000);
    check(answer + ': answered: no second read', reads(t) === r0 + 1, reads(t) - r0);
    check(answer + ': landed where the answer says', t.st().filesChanged === null && t.posts.length >= 1 &&
      t.posts[0].book_ms === (answer === 'Continue' ? 1620000 : 360000), t.posts.map((b) => b.book_ms));
    t.engine.close();
  }
  // The read takes over 4 s: the question as it was, still held and waiting, nothing saved.
  const t = await held();
  t.places.plex = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(t.now()).toISOString(), device: 'Plexamp' };
  await t.clock.advance(5000);
  t.card('percent').querySelector('.wsp-fp-use').click();
  await t.clock.advance(200);
  await t.clock.advance(10 * MIN);
  t.places.plex = { track: '503', offset_ms: 120000, duration_ms: 300000, updated_at: new Date(t.now() - 30000).toISOString(), device: 'Plexamp' };
  t.positionDelay = 6000;
  t.promptBtn('Continue').click();
  await t.clock.advance(10000);
  check('slow read: the question again, its age counted on', t.prompts().join() === 'Continue from 15:00 (Plexamp, 10 min ago)?' &&
    !!t.promptBtn('Continue') && t.promptBtn('Continue').getAttribute('aria-disabled') === 'false', t.prompts());
  check('slow read: still held at the chosen spot, nothing saved', !!t.st().filesChanged && t.st().filesChanged.spot === 360000 && t.posts.length === 0, [t.st().filesChanged, t.posts.length]);
  check('slow read: the helper still waits', t.txt('.wsp-fp-status') === 'Answer the question above to carry on.' &&
    t.cards().every((c) => c.querySelector('.wsp-fp-preview').disabled), t.txt('.wsp-fp-status'));
  t.engine.close();
});

await run('T4F1 (held): a Pause while the confirm\'s Plex question is read again: it lands as answered, and does not play', async () => {
  for (const how of ['pause', 'play then pause', 'pause then play', 'neither']) {
    const t = await held();
    t.places.plex = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(t.now()).toISOString(), device: 'Plexamp' };
    await t.clock.advance(5000);
    t.card('percent').querySelector('.wsp-fp-use').click();
    await t.clock.advance(200);
    await t.clock.advance(10 * MIN);
    t.positionDelay = 3000;
    t.promptBtn('Continue').click();
    await t.clock.advance(300);
    if (how === 'play then pause') {
      t.ms.handlers.get('play')();
      await t.clock.advance(1000);
    }
    if (how !== 'neither') t.ms.handlers.get('pause')();
    if (how === 'pause then play') {
      await t.clock.advance(300);
      t.ms.handlers.get('play')();               // played again before the read ends: it plays on
    }
    await t.clock.advance(8000);
    check(how + ': landed at Plexamp\'s 15:00 and saved there', t.st().filesChanged === null && t.posts.length >= 1 && t.posts[0].book_ms === 900000, t.posts.map((b) => b.book_ms));
    const plays = how === 'neither' || how === 'pause then play';
    check(how + (plays ? ': plays on, as answered' : ': not playing'), t.st().playing === plays, t.st().playing);
    t.engine.close();
  }
});

await run('T3F5: files changed within the same album name no earlier copy', async () => {
  const t = await held({ old: { linked_from: null, book_title: 'Three Parts', narrator: 'A. Reader' } });
  check('no copy line', t.txt('.wsp-fp-copy') === null);
  t.engine.close();
});

await run('T3F6: the status live region is there while empty', async () => {
  const t = await held();
  const st = t.q('.wsp-fp-status');
  check('empty, not hidden, a polite status', st.textContent === '' && !st.hidden && !st.closest('[hidden]') && st.getAttribute('role') === 'status');
  t.engine.close();
});

await run('T3U2: the bar\'s button during a held preview is the toggle: it pauses, as it says', async () => {
  const t = await held();
  t.card('time').querySelector('.wsp-fp-preview').click();
  await t.clock.advance(1000);
  t.ui.close();
  await t.clock.advance(400);
  const bar = t.q('.wsp-bar .wsp-play');
  check('it reads Pause', t.st().playing && bar.getAttribute('aria-label') === 'Pause', bar.getAttribute('aria-label'));
  bar.click();
  await t.clock.advance(1000);
  check('pressed: paused, the player still closed', !t.st().playing && !t.ui.isOpen() && bar.getAttribute('aria-label') === 'Play');
  bar.click();
  await t.clock.advance(400);
  check('paused, it reads Play and opens the helper', t.ui.isOpen() && t.shown() && !t.st().playing);
  check('nothing saved', t.posts.length === 0);
  t.engine.close();
});

await run('T3U3: the tap that opens the player makes one watcher; the panel shown with it makes none', async () => {
  const t = await held({ closeWatcher: true, noActivation: true });
  t.ui.close();
  await t.clock.advance(400);
  t.env.activation = true;
  t.q('.wsp-bar .wsp-play').click();
  await t.clock.advance(10);
  check('bar Play: the player and its helper, one watcher', t.ui.isOpen() && t.shown() && t.cw.live.length === 1, t.cw.live.length);
  t.key(t.q('#wspPanel-findplace'), 'Escape');
  check('Escape still closes the helper first', t.ui.isOpen() && !t.shown());
  t.cw.live[0].close();
  await t.clock.advance(400);
  check('Back closes the player, no watcher left', !t.ui.isOpen() && t.cw.live.length === 0);
  t.promptBtn('Find your place').click();
  await t.clock.advance(10);
  check('the prompt with the player closed: one watcher', t.ui.isOpen() && t.shown() && t.cw.live.length === 1, t.cw.live.length);
  t.key(t.q('#wspPanel-findplace'), 'Escape');
  t.promptBtn('Find your place').click();
  await t.clock.advance(10);
  check('the prompt with the player open: the panel\'s own watcher', t.shown() && t.cw.live.length === 2, t.cw.live.length);
  t.cw.live[1].close();
  await t.clock.advance(10);
  check('Back closes the helper alone', t.ui.isOpen() && !t.shown() && t.cw.live.length === 1);
  check('nothing saved', t.posts.length === 0 && t.st().filesChanged !== null);
  t.engine.close();
});

// ---------------------------------------------------------------------------
// Fix round 2 (T3R1, T2Z1): a confirm never lands at the very end of the book
// (the next Play would start it again from 0:00), whatever route took the
// chosen spot there.
// ---------------------------------------------------------------------------

const END = 1800000;
const LIMIT = END - 30000;
// No save at the book's start after the confirm, and playback goes on near the end.
const noRestart = (t) => t.posts.every((b) => b.book_ms >= LIMIT - 1000);

await run('T3R1: the nudge and Forward stop 30 s short of the end; the confirm lands there and plays on', async () => {
  const t = await held({ old: { book_ms: 1740000, book_duration_ms: END } });
  check('the candidate, chosen', t.st().filesChanged.spot === 1740000 && t.cards().length === 1);
  const fwd = () => t.qa('.wsp-fp-step')[1].click();
  fwd(); fwd(); fwd();
  check('Forward x3: 30 s short of the end', t.st().filesChanged.spot === LIMIT, t.st().filesChanged.spot);
  fwd();
  check('a fourth goes no further', t.st().filesChanged.spot === LIMIT, t.st().filesChanged.spot);
  t.key(t.q('.wsp-fp-range'), 'ArrowRight');
  check('nor an arrow', t.st().filesChanged.spot === LIMIT, t.st().filesChanged.spot);
  const range = t.q('.wsp-fp-range');
  check('the scrubber ends there', 1740000 - 300000 + Number(range.getAttribute('max')) * 1000 === LIMIT, range.getAttribute('max'));
  range.value = range.getAttribute('max');
  range.dispatchEvent(new t.win.Event('change', { bubbles: true }));
  check('dragged to its end: there', t.st().filesChanged.spot === LIMIT, t.st().filesChanged.spot);
  t.card('time').querySelector('.wsp-fp-use').click();
  check('confirmPlace there', t.calls.filter((c) => c[0] === 'confirmPlace').pop()[1] === LIMIT, t.calls);
  await t.clock.advance(5000);
  check('landed 30 s short, saved there', t.st().filesChanged === null && t.st().bookMs === LIMIT && t.posts[0].book_ms === LIMIT, t.posts.map((b) => b.book_ms));
  t.q('.wsp-play-lg').click();
  await t.clock.advance(5000);
  check('a Play goes on from there', t.st().playing && t.st().bookMs > LIMIT && noRestart(t), [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
  t.engine.close();
});

await run('T3R1: a history entry at the very end; the lock screen\'s seek to the end; a confirm asked for the end', async () => {
  for (const how of ['history', 'lock screen', 'engine']) {
    const t = await held();
    if (how === 'history') {
      t.history[''] = { entries: [{ track: '503', offset_ms: 300000, device: 'Test on Linux', device_id: ME, event: 'pause', at: new Date(t.now() - 60000).toISOString(), book_key: '500:1' }], next_before: null };
      t.qa('.wsp-fp-row')[0].click();
      await t.clock.advance(50);
      t.q('.wsp-hist-row').click();
      await t.clock.advance(10);
    } else if (how === 'lock screen') {
      t.ms.handlers.get('seekto')({ seekTime: END / 1000 });
      await t.clock.advance(10);
    }
    if (how === 'engine') {
      check(how + ': confirmPlace(end) is taken', t.engine.confirmPlace(END) === true);
    } else {
      check(how + ': the spot at the end, nothing saved', t.st().filesChanged.spot === END && t.posts.length === 0, t.st().filesChanged.spot);
      const chosen = t.q('.wsp-fp-cand.is-chosen');
      check(how + ': shown 30 s short', chosen.querySelector('.wsp-fp-at').textContent.startsWith('0:29:30'), chosen.querySelector('.wsp-fp-at').textContent);
      chosen.querySelector('.wsp-fp-use').click();
    }
    await t.clock.advance(5000);
    check(how + ': landed 30 s short', t.st().filesChanged === null && t.st().bookMs === LIMIT && t.posts[0].book_ms === LIMIT, [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
    await t.engine.play();
    await t.clock.advance(5000);
    check(how + ': a Play goes on from there', t.st().playing && t.st().bookMs > LIMIT && noRestart(t), [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
    t.engine.close();
  }
});

await run('T2Z1 (E1, E4): a Play carried through the confirm\'s read never meets the end, so never starts again', async () => {
  for (const [name, move] of [['none', null], ['skip(+30)', (t) => t.engine.skip(30)],
    ['lock screen seekforward', (t) => t.ms.handlers.get('seekforward')({ seekOffset: 30 })], ['seek(end)', (t) => t.engine.seek(END)]]) {
    const t = await held();
    t.positionDelay = 2000;
    t.engine.confirmPlace(END - 15000);
    await t.clock.advance(100);
    await t.engine.play();
    await t.clock.advance(200);
    if (move) move(t);
    await t.clock.advance(5000);
    check(name + ': landed short of the end, playing on', t.st().filesChanged === null && t.st().playing && t.st().bookMs >= LIMIT && t.st().bookMs < END, t.st());
    await t.clock.advance(10000);
    check(name + ': never back at the start', t.st().bookMs >= LIMIT && noRestart(t), [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
    t.engine.close();
  }
  // E4: a confirm of the very end, the element played from outside while its move loads.
  const t = await held();
  t.positionDelay = 2000;
  t.engine.confirmPlace(END);
  t.audioEl.play();
  await t.clock.advance(5000);
  check('E4: landed 30 s short', t.st().filesChanged === null && t.st().bookMs >= LIMIT && t.st().bookMs < END, t.st().bookMs);
  await t.clock.advance(10000);
  check('E4: never back at the start', t.st().bookMs >= LIMIT && noRestart(t), [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
  t.engine.close();
});

await run('T2Z1 (edge5): the question\'s answer plays on from a landing short of the end', async () => {
  const t = await held();
  t.places.plex = { track: '502', offset_ms: 30000, duration_ms: 900000, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Plexamp' };
  await t.clock.advance(5000);
  t.engine.confirmPlace(END - 15000);
  await t.clock.advance(500);
  check('asked', t.prompts().some((x) => x.indexOf('Continue from') === 0) && t.st().filesChanged !== null, t.prompts());
  t.engine.skip(30);
  await t.clock.advance(100);
  t.qa('.wsp-prompt .wsp-notice-btn').find((b) => b.textContent === 'Keep listening here').click();
  await t.clock.advance(5000);
  check('landed 30 s short, playing on', t.st().filesChanged === null && t.st().playing && t.st().bookMs >= LIMIT && t.st().bookMs < END, t.st());
  await t.clock.advance(10000);
  check('never back at the start', noRestart(t), t.posts.map((b) => b.book_ms));
  t.engine.close();
});

// ---------------------------------------------------------------------------
// Fix round 3 (T3R2, T3R3)
// ---------------------------------------------------------------------------

await run('landingFor: the end margin, and the last playable spot before a part that can\'t play', () => {
  const parts = [
    { start_ms: 0, duration_ms: 600000, playable: true },
    { start_ms: 600000, duration_ms: 20000, playable: false },
    { start_ms: 620000, duration_ms: 20000, playable: true }
  ];
  check('inside: as it is', FP.landingFor(300000, 640000, parts) === 300000);
  check('the end: pulled into the blocked part, so 30 s before the part before it', FP.landingFor(640000, 640000, parts) === 570000, FP.landingFor(640000, 640000, parts));
  check('just short of the blocked part: as it is', FP.landingFor(599000, 640000, parts) === 599000);
  check('plain book: 30 s short', FP.landingFor(1800000, 1800000, [{ start_ms: 0, duration_ms: 1800000, playable: true }]) === 1770000);
  check('a short part before: its start', FP.landingFor(40000, 40000, [{ start_ms: 0, duration_ms: 5000, playable: true }, { start_ms: 5000, duration_ms: 35000, playable: false }]) === 0);
  check('nothing playable before: as clamped', FP.landingFor(40000, 40000, [{ start_ms: 0, duration_ms: 20000, playable: false }, { start_ms: 20000, duration_ms: 20000, playable: true }]) === 10000);
});

const TAIL_END = 640000;
const TAIL_LAND = 570000;
async function heldTail() {
  const t = await held({ book: TAIL.key, old: { book_ms: 300000, book_duration_ms: TAIL_END } });
  t.warnings = [];
  t.engine.on('warning', (w) => t.warnings.push(w.kind));
  return t;
}
const tailOk = (t) => t.posts.length >= 1 && t.posts.every((b) => b.book_ms >= 300000);

await run('T3R2: the end margin in a part that can\'t play: the helper\'s spot lands at the last playable one, and saves there', async () => {
  for (const how of ['lock screen seekto end', 'the Credits chapter']) {
    const t = await heldTail();
    if (how === 'lock screen seekto end') t.ms.handlers.get('seekto')({ seekTime: TAIL_END / 1000 });
    else t.engine.jumpToChapter(2);
    await t.clock.advance(20);
    const c = t.q('.wsp-fp-cand.is-chosen');
    check(how + ': shown where it will land', c.querySelector('.wsp-fp-at').textContent.startsWith('0:09:30'), c.querySelector('.wsp-fp-at').textContent);
    c.querySelector('.wsp-fp-use').click();
    await t.clock.advance(5000);
    check(how + ': landed there, saved there, the helper gone', t.st().filesChanged === null && t.st().bookMs === TAIL_LAND && t.posts[0].book_ms === TAIL_LAND && !t.shown(),
      [t.st().bookMs, t.posts.map((b) => b.book_ms), t.shown()]);
    check(how + ': nothing refused', t.warnings.indexOf('part-format') === -1, t.warnings);
    await t.engine.play();
    await t.clock.advance(3000);
    check(how + ': a Play goes on from there, never 0:00', t.st().playing && t.st().bookMs > TAIL_LAND && tailOk(t), [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
    t.engine.close();
  }
});

await run('T3R2: a move to the end while the confirm reads, or while it asks: it lands at the last playable spot, never released without it', async () => {
  for (const play of [false, true]) {
    const t = await heldTail();
    t.positionDelay = 2000;
    t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
    await t.clock.advance(100);
    if (play) await t.engine.play();
    await t.clock.advance(100);
    t.ms.handlers.get('seekto')({ seekTime: TAIL_END / 1000 });
    await t.clock.advance(5000);
    check('read, Play ' + play + ': landed at the last playable spot', t.st().filesChanged === null && t.st().bookMs >= TAIL_LAND && t.st().bookMs < 600000 && t.posts[0].book_ms === TAIL_LAND,
      [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
    check('read, Play ' + play + ': the helper gone, ' + (play ? 'playing on' : 'paused'), !t.shown() && t.st().playing === play, [t.shown(), t.st().playing]);
    // The helper's buttons, gone with it, do nothing if pressed anyway.
    const n = t.posts.length;
    t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
    t.qa('.wsp-fp-row')[1].click();
    t.qa('.wsp-fp-step')[0].click();
    await t.clock.advance(100);
    check('read, Play ' + play + ': the gone helper\'s buttons do nothing', t.posts.length === n && t.st().bookMs >= TAIL_LAND && t.txt('.wsp-fp-status') === '',
      [t.posts.slice(n).map((b) => b.book_ms), t.st().bookMs, t.txt('.wsp-fp-status')]);
    await t.engine.play();
    await t.clock.advance(3000);
    check('read, Play ' + play + ': never 0:00', t.st().bookMs > TAIL_LAND && tailOk(t), [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
    t.engine.close();
  }
  const t = await heldTail();
  t.places.plex = { track: '641', offset_ms: 30000, duration_ms: 600000, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Plexamp' };
  await t.clock.advance(5000);
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(500);
  check('asked', t.prompts().some((x) => x.indexOf('Continue from') === 0), t.prompts());
  t.ms.handlers.get('seekto')({ seekTime: TAIL_END / 1000 });
  await t.clock.advance(50);
  t.qa('.wsp-prompt .wsp-notice-btn').find((b) => b.textContent === 'Keep listening here').click();
  await t.clock.advance(5000);
  check('the question: landed at the last playable spot, playing on', t.st().filesChanged === null && t.st().bookMs >= TAIL_LAND && t.st().bookMs < 600000 && t.st().playing &&
    t.posts[0].book_ms === TAIL_LAND, [t.st().bookMs, t.posts.map((b) => b.book_ms)]);
  check('the question: never 0:00', tailOk(t), t.posts.map((b) => b.book_ms));
  t.engine.close();
});

await run('T3R2: a spot the engine refuses keeps the book held, and the helper says why', async () => {
  // MIXED: 0-600 s mp3, 600-620 s E-AC3. A nudge into the part that can't play.
  const t = await held({ book: MIXED.key, old: { book_ms: 595000, book_duration_ms: 920000 } });
  check('the candidate at 9:55', t.st().filesChanged.spot === 595000);
  t.qa('.wsp-fp-step')[1].click();
  await t.clock.advance(10);
  check('refused: still held, the spot as it was', t.st().filesChanged !== null && t.st().filesChanged.spot === 595000);
  check('the helper says so', t.txt('.wsp-fp-status') === "That spot can't play in this browser. Pick another.", t.txt('.wsp-fp-status'));
  t.qa('.wsp-fp-step')[0].click();
  check('the next choice clears it', t.txt('.wsp-fp-status') === '' && t.st().filesChanged.spot === 585000, [t.txt('.wsp-fp-status'), t.st().filesChanged.spot]);
  check('nothing saved', t.posts.length === 0);
  t.engine.close();
});

await run('T3R3: Back and the left arrow step from the spot as shown, after a move to the end', async () => {
  for (const [how, start] of [['the end', END], ['5 s before it', END - 5000]]) {
    for (const press of ['Back', 'ArrowLeft']) {
      const t = await held();
      t.engine.seek(start);
      await t.clock.advance(20);
      const shown = () => t.q('.wsp-fp-cand.is-chosen .wsp-fp-at').textContent;
      check(how + ' ' + press + ': shown 30 s short', shown().startsWith('0:29:30'), shown());
      if (press === 'Back') t.qa('.wsp-fp-step')[0].click();
      else t.key(t.q('.wsp-fp-range'), 'ArrowLeft');
      await t.clock.advance(20);
      const want = press === 'Back' ? LIMIT - 10000 : LIMIT - 1000;
      check(how + ' ' + press + ': the first press moves from there', t.st().filesChanged.spot === want, t.st().filesChanged.spot);
      t.engine.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Fix round 4 (T3R4, T3R5, T3R6)
// ---------------------------------------------------------------------------

const HOUR = 3600000;
// A 9 h part, an hour this browser can't decode, a 20 s outro: the end
// margin falls an hour into the part that can't play.
const LONG = {
  key: '660:1', title: 'Long', author: 'L. Writer', narrator: '', series: '', cover: '', shape: 'parts',
  tracks: [
    { key: '661', part_path: '/library/parts/1101/1/file.mp3', duration_ms: 9 * HOUR, index: 1, ...MP3 },
    { key: '662', part_path: '/library/parts/1102/1/file.m4b', duration_ms: HOUR, index: 2, ...EAC3 },
    { key: '663', part_path: '/library/parts/1103/1/file.mp3', duration_ms: 20000, index: 3, ...MP3 }
  ],
  chapters: []
};
const LONG_END = 10 * HOUR + 20000;
const LONG_LAND = 9 * HOUR - 30000;     // the last playable spot before the margin's pull: 8:59:30
// A 20 s intro, 10 minutes this browser can't decode, a 10 s outro.
const GAP = {
  key: '670:1', title: 'Gap', author: 'G. Writer', narrator: '', series: '', cover: '', shape: 'parts',
  tracks: [
    { key: '671', part_path: '/library/parts/1201/1/file.mp3', duration_ms: 20000, index: 1, ...MP3 },
    { key: '672', part_path: '/library/parts/1202/1/file.m4b', duration_ms: 600000, index: 2, ...EAC3 },
    { key: '673', part_path: '/library/parts/1203/1/file.mp3', duration_ms: 10000, index: 3, ...MP3 }
  ],
  chapters: []
};
for (const b of [LONG, GAP]) {
  BOOKS[b.key] = b;
  for (const tr of b.tracks) trackByPath.set(tr.part_path, tr);
}
const FAR_STATUS = "That part can't play in this browser. The nearest spot it can play is 8:59:30.";
const REFUSED_STATUS = "That spot can't play in this browser. Pick another.";
async function heldLong() {
  const t = await held({ book: LONG.key, old: { book_ms: 5 * HOUR, book_duration_ms: LONG_END } });
  t.warnings = [];
  t.engine.on('warning', (w) => t.warnings.push(w));
  return t;
}
const answer = (t, label) => t.qa('.wsp-prompt .wsp-notice-btn').find((b) => b.textContent === label);
const chosenAt = (t) => t.q('.wsp-fp-cand.is-chosen .wsp-fp-at').textContent;

await run('landingFar: a walk back over 60 s from where the margin alone puts it', () => {
  const parts = LONG.tracks.map((tr, i) => ({ start_ms: i === 0 ? 0 : i === 1 ? 9 * HOUR : 10 * HOUR, duration_ms: tr.duration_ms, playable: i !== 1 }));
  check('the end: an hour back, far', FP.landingFar(LONG_END, LONG_END, parts) === true && FP.landingFor(LONG_END, LONG_END, parts) === LONG_LAND);
  check('in the story: not far', FP.landingFar(5 * HOUR, LONG_END, parts) === false);
  const tail = [{ start_ms: 0, duration_ms: 600000, playable: true }, { start_ms: 600000, duration_ms: 20000, playable: false }, { start_ms: 620000, duration_ms: 20000, playable: true }];
  check('the tail layout: 40 s back from the margin, not far', FP.landingFar(640000, 640000, tail) === false && FP.landingFar(620000, 640000, tail) === false);
  check('a plain book\'s margin alone: not far', FP.landingFar(1800000, 1800000, [{ start_ms: 0, duration_ms: 1800000, playable: true }]) === false);
  check('a refused landing is no walk', FP.landingFar(40000, 40000, [{ start_ms: 0, duration_ms: 20000, playable: false }, { start_ms: 20000, duration_ms: 20000, playable: true }]) === false);
  const edge = [{ start_ms: 0, duration_ms: 100000, playable: true }, { start_ms: 100000, duration_ms: 60000, playable: false }, { start_ms: 160000, duration_ms: 20000, playable: true }];
  // The margin puts 180 s at 150 s; the last playable spot is 70 s: 80 s back.
  check('just over 60 s: far', FP.landingFar(180000, 180000, edge) === true && FP.landingFor(180000, 180000, edge) === 70000);
  check('the engine\'s rule is the same number', E.PLACE_WALK_MS === FP.WALK_MS && FP.WALK_MS === 60000);
});

await run('T3R4: Continue lands at the other place exactly, with no end margin', async () => {
  // A Plex app 10 s before a plain book's end.
  let t = await held();
  t.places.plex = { track: '503', offset_ms: 290000, duration_ms: 300000, updated_at: new Date(t.now()).toISOString(), device: 'Plexamp' };
  await t.clock.advance(5000);
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(500);
  answer(t, 'Continue').click();
  await t.clock.advance(500);
  check('plain book: at the Plex app\'s place, saved there', t.st().filesChanged === null && t.posts[0].book_ms === 1790000, t.posts.map((b) => b.book_ms));
  t.engine.close();
  // A part that can't play between the end margin and the other place.
  t = await heldLong();
  t.places.plex = { track: '663', offset_ms: 10000, duration_ms: 20000, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Plexamp' };
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(500);
  check('asked about 10:00:10', t.prompts().some((x) => x.indexOf('Continue from 10:00:10') === 0), t.prompts());
  answer(t, 'Continue').click();
  await t.clock.advance(500);
  check('10:00:10, never 8:59:30', t.st().filesChanged === null && t.posts[0].book_ms === 10 * HOUR + 10000 && t.posts.every((b) => b.book_ms >= 10 * HOUR + 10000),
    t.posts.map((b) => b.book_ms));
  t.engine.close();
  // The confirmed spot is 0:00:12; the other place is 10:25, past 10 minutes that can't play.
  t = await held({ book: GAP.key, old: { book_ms: 12000, book_duration_ms: 630000 } });
  t.places.plex = { track: '673', offset_ms: 5000, duration_ms: 10000, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Plexamp' };
  check('the chosen spot 0:00:12', chosenAt(t).startsWith('0:00:12'), chosenAt(t));
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(500);
  answer(t, 'Continue').click();
  await t.clock.advance(3000);
  check('10:25, never 0:00', t.st().filesChanged === null && t.posts.length > 0 && t.posts.every((b) => b.book_ms >= 625000), t.posts.map((b) => b.book_ms));
  t.engine.close();
});

await run('T3R4: a landing that would walk back over 60 s keeps the book held, and the helper shows that spot and why', async () => {
  // The helper: a move to the end shows where it could land, and says why, before any Use.
  let t = await heldLong();
  t.ms.handlers.get('seekto')({ seekTime: (LONG_END - 10000) / 1000 });
  await t.clock.advance(20);
  check('lock screen: shown at 8:59:30 with the reason', chosenAt(t).startsWith('8:59:30') && t.txt('.wsp-fp-status') === FAR_STATUS, [chosenAt(t), t.txt('.wsp-fp-status')]);
  t.engine.close();
  // A move to the end while the confirm reads (with and without the helper showing, with and without a Play).
  for (const [hide, play] of [[false, false], [true, false], [false, true]]) {
    const how = (hide ? 'put off' : 'showing') + (play ? ', Play' : '');
    t = await heldLong();
    t.positionDelay = 2000;
    t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
    await t.clock.advance(100);
    if (play) await t.engine.play();
    if (hide) t.helper.hide();
    await t.clock.advance(50);
    t.ms.handlers.get('seekto')({ seekTime: LONG_END / 1000 });
    await t.clock.advance(5000);
    check(how + ': still held, nothing saved, nothing playing', t.st().filesChanged !== null && t.posts.length === 0 && !t.st().playing, [t.posts.map((b) => b.book_ms), t.st().playing]);
    check(how + ': the helper shows 8:59:30 and why', t.shown() && chosenAt(t).startsWith('8:59:30') && t.txt('.wsp-fp-status') === FAR_STATUS,
      [t.shown(), t.txt('.wsp-fp-status')]);
    check(how + ': marked as the landing', t.warnings.some((w) => w.kind === 'part-format' && w.landing === true));
    check(how + ': Preview open again', !t.q('.wsp-fp-cand.is-chosen .wsp-fp-preview').disabled);
    t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
    await t.clock.advance(5000);
    check(how + ': Use there lands there', t.st().filesChanged === null && t.posts[0].book_ms === LONG_LAND, t.posts.map((b) => b.book_ms));
    t.engine.close();
  }
  // A move to the end while the question waits, then Keep listening here.
  t = await heldLong();
  t.places.plex = { track: '661', offset_ms: 1000000, duration_ms: 9 * HOUR, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Plexamp' };
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(500);
  t.ms.handlers.get('seekto')({ seekTime: LONG_END / 1000 });
  await t.clock.advance(20);
  answer(t, 'Keep listening here').click();
  await t.clock.advance(3000);
  check('Keep listening here: still held, nothing saved, no preview playing', t.st().filesChanged !== null && t.posts.length === 0 && !t.st().playing,
    [t.posts.map((b) => b.book_ms), t.st().playing]);
  check('Keep listening here: the helper says why', t.shown() && t.txt('.wsp-fp-status') === FAR_STATUS, t.txt('.wsp-fp-status'));
  t.engine.close();
  // Asked of the engine directly: refused, the held spot moved there, nothing read or saved.
  t = await heldLong();
  const fetches = t.fetches.length;
  check('confirmPlace: false', t.engine.confirmPlace(LONG_END - 10000) === false);
  await t.clock.advance(5000);
  check('confirmPlace: held at the spot asked, the helper says why', t.st().filesChanged !== null && t.st().filesChanged.spot === LONG_END - 10000 &&
    t.posts.length === 0 && t.fetches.length === fetches && t.txt('.wsp-fp-status') === FAR_STATUS, [t.st().filesChanged && t.st().filesChanged.spot, t.txt('.wsp-fp-status')]);
  t.engine.close();
});

await run('T3R7: while a confirm waits, a far spot still says why, under the wait\'s line', async () => {
  // The question: a move to the end shows 8:59:30, and the reason with it.
  let t = await heldLong();
  t.places.plex = { track: '661', offset_ms: 1000000, duration_ms: 9 * HOUR, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Plexamp' };
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(500);
  check('asked', t.prompts().some((x) => x.indexOf('Continue from') === 0), t.prompts());
  t.ms.handlers.get('seekto')({ seekTime: LONG_END / 1000 });
  await t.clock.advance(20);
  check('the question: 8:59:30, with both lines', chosenAt(t).startsWith('8:59:30') &&
    t.txt('.wsp-fp-status') === 'Answer the question above to carry on.\n' + FAR_STATUS, t.txt('.wsp-fp-status'));
  answer(t, 'Keep listening here').click();
  await t.clock.advance(3000);
  check('Keep listening here: held, the reason alone', t.st().filesChanged !== null && t.posts.length === 0 && t.txt('.wsp-fp-status') === FAR_STATUS, t.txt('.wsp-fp-status'));
  t.engine.close();
  // The read: the same.
  t = await heldLong();
  t.positionDelay = 2000;
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(100);
  t.ms.handlers.get('seekto')({ seekTime: LONG_END / 1000 });
  await t.clock.advance(20);
  check('the read: both lines', t.st().checking && t.txt('.wsp-fp-status') === 'Checking for a newer place…\n' + FAR_STATUS, t.txt('.wsp-fp-status'));
  t.engine.close();
  // A spot that is not far shows the wait's line alone, as before.
  t = await held();
  t.places.plex = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(t.now()).toISOString(), device: 'Plexamp' };
  await t.clock.advance(5000);
  t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
  await t.clock.advance(500);
  check('not far: the wait\'s line alone', t.txt('.wsp-fp-status') === 'Answer the question above to carry on.', t.txt('.wsp-fp-status'));
  t.engine.close();
});

await run('T3R5: a move refused while the question waits leaves the confirm waiting', async () => {
  for (const press of [false, true]) {
    const t = await held({ book: MIXED.key });
    t.places.plex = { track: '521', offset_ms: 30000, duration_ms: 600000, updated_at: new Date(t.now() - MIN).toISOString(), device: 'Plexamp' };
    t.q('.wsp-fp-cand.is-chosen .wsp-fp-use').click();
    await t.clock.advance(500);
    t.ms.handlers.get('seekto')({ seekTime: 610 });
    await t.clock.advance(50);
    check(press + ': Preview still waits, and the panel says so', t.qa('.wsp-fp-cand').filter((c) => !c.hidden).every((c) => c.querySelector('.wsp-fp-preview').disabled) &&
      t.txt('.wsp-fp-status') === 'Answer the question above to carry on.', t.txt('.wsp-fp-status'));
    if (press) {
      t.qa('.wsp-fp-cand').filter((c) => !c.hidden).forEach((c) => c.querySelector('.wsp-fp-preview').click());
      await t.clock.advance(3000);
      check('a Preview press does nothing', t.calls.every((c) => c[0] !== 'previewAt') && t.st().filesChanged.spot === 720000 && !t.st().playing);
    }
    answer(t, 'Keep listening here').click();
    await t.clock.advance(3000);
    check(press + ': Keep listening here lands at the confirmed spot', t.st().filesChanged === null && t.posts[0].book_ms === 720000, t.posts.map((b) => b.book_ms));
    t.engine.close();
  }
});

await run('T3R6: "Pick another" goes once the spot moves, a Play, or the helper shows again', async () => {
  const ways = {
    'lock screen seekto': (t) => t.ms.handlers.get('seekto')({ seekTime: 300 }),
    'full player seek': (t) => t.engine.seek(300000),
    'skip back': (t) => t.engine.skip(-30),
    'put off and shown again': async (t) => { t.helper.hide(); await t.clock.advance(20); t.promptBtn('Find your place').click(); },
    'Play': (t) => t.engine.play()
  };
  for (const how of Object.keys(ways)) {
    const t = await held({ book: MIXED.key, old: { book_ms: 595000, book_duration_ms: 920000 } });
    t.qa('.wsp-fp-step')[1].click();
    await t.clock.advance(20);
    check(how + ': refused first', t.txt('.wsp-fp-status') === REFUSED_STATUS, t.txt('.wsp-fp-status'));
    await ways[how](t);
    await t.clock.advance(50);
    check(how + ': cleared', t.shown() && t.txt('.wsp-fp-status') === '', t.txt('.wsp-fp-status'));
    t.engine.close();
  }
  // A move elsewhere that is refused too keeps it.
  const t = await held({ book: MIXED.key, old: { book_ms: 595000, book_duration_ms: 920000 } });
  t.qa('.wsp-fp-step')[1].click();
  await t.clock.advance(20);
  t.ms.handlers.get('seekto')({ seekTime: 610 });
  await t.clock.advance(20);
  check('refused elsewhere too: kept', t.txt('.wsp-fp-status') === REFUSED_STATUS && t.st().filesChanged.spot === 595000, t.txt('.wsp-fp-status'));
  t.engine.close();
});

// ---------------------------------------------------------------------------
// The safety net: "Were you listening to one of these?" (spec 2.6)
// ---------------------------------------------------------------------------

const SN_TITLE = 'Were you listening to one of these?';
function orphansFor(t) {
  return [
    { key: '400:1', book_title: 'Three Parts (First Edition)', narrator: 'A. Reader', book_ms: 720000, book_duration_ms: 1800000,
      chapter_label: 'Chapter 4', updated_at: new Date(t.now() - 3 * 86400000).toISOString(), author_match: true },
    { key: '410:1', book_title: 'Two Old Parts <img src=x onerror=alert(1)>', narrator: null, book_ms: 60000, book_duration_ms: null,
      chapter_label: null, updated_at: new Date(t.now() - 3600000).toISOString(), author_match: false }
  ];
}

// A book opened with no place of the listener's, and places left on books that are gone.
async function asking(o = {}) {
  const t = await setup(o);
  t.orphans = o.orphans === undefined ? orphansFor(t) : o.orphans;
  const p = t.engine.open(o.book || MULTI.key);
  await t.clock.advance(300);
  await p;
  return t;
}
const asked = (t) => t.fetches.filter((f) => f.url.indexOf('/api/player/orphans/') === 0 && f.method === 'GET');

await run('spec 2.6: the panel opens with the book, in the full player, listing each place', async () => {
  const t = await asking();
  check('asked once', asked(t).length === 1, asked(t));
  check('the engine holds the question', t.st().safetyNet !== null && t.st().safetyNet.orphans.length === 2 && t.st().filesChanged === null);
  check('the full player is open on it', t.ui.isOpen() && t.snShown() && !t.shown());
  check('titled with the question', t.q('#wspPanel-safetynet') && t.snPanel().textContent.indexOf(SN_TITLE) !== -1, t.snPanel().textContent.slice(0, 120));
  const rows = t.snRows();
  check('a row for each place', rows.length === 2, rows.length);
  const first = rows[0].textContent;
  check('the first: title, narrator, book time with percent, chapter, when', first.indexOf('Three Parts (First Edition)') !== -1 &&
    first.indexOf('Read by A. Reader') !== -1 && first.indexOf('0:12:00 into the book · 40%') !== -1 && first.indexOf('Chapter 4') !== -1 &&
    first.indexOf('Last listened 3 days ago') !== -1, first);
  const second = rows[1].textContent;
  check('the second: no narrator, no percent, no chapter', second.indexOf('Read by') === -1 && second.indexOf('0:01:00 into the book') !== -1 &&
    second.indexOf('%') === -1 && second.indexOf('Last listened 1 h ago') !== -1, second);
  check('a title is text, never markup', rows[1].querySelector('img') === null && second.indexOf('<img src=x onerror=alert(1)>') !== -1);
  check('each row has its own button, named for the book', rows.every((r) => r.querySelector('.wsp-sn-pick')) &&
    rows[0].querySelector('.wsp-sn-pick').getAttribute('aria-label') === 'This is the one: Three Parts (First Edition)');
  check('and "None of these"', t.q('.wsp-sn-none') && t.q('.wsp-sn-none').textContent === 'None of these');
  check('the book is loaded and waiting: not playing, nothing saved', !t.st().playing && t.posts.length === 0 && t.audioEl.paused);
  t.engine.close();
  await t.clock.advance(10);
  check('closing the book takes the panel and the prompt with it', !t.snShown() && t.prompts().length === 0);
});

await run('spec 2.6: it shows only when ruled', async () => {
  const mid = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(NOW0 - 3600000).toISOString(), device: 'Chrome', device_id: OTHER, psid: 'o' };
  const cases = [
    ['a place of the listener\'s in the book', { web: mid }],
    ['files changed (a place in a part the book lacks)', null],
    ['a linked earlier copy', null],
    ['no places left on gone books', { orphans: [] }],
    ['the server says dismissed', { dismissed: new Set([MULTI.key]) }]
  ];
  for (const [name, o] of cases) {
    let t;
    if (name.startsWith('files changed')) { t = await held({}); t.orphans = orphansFor(t); }
    else if (name === 'a linked earlier copy') { t = await held({}); }
    else { t = await asking(o); }
    check(name + ': no question, no panel', t.st().safetyNet === null && !t.snShown() && t.snRows().length === 0, t.st().safetyNet);
    if (name.startsWith('files changed') || name === 'a linked earlier copy') check(name + ': the "Find your place" helper has it', t.st().filesChanged !== null && t.shown());
    else check(name + ': the book opened as it always did', t.st().playing || t.st().position !== null, t.st().playing);
    check(name + ': nothing offered to save either', t.prompts().length === 0 || t.st().filesChanged !== null);
    t.engine.close();
  }
  // Ruled in: nothing else has the book, so only the safety net asks.
  const ok = await asking();
  check('and when ruled in the helper is not open', ok.snShown() && !ok.shown() && ok.st().filesChanged === null);
  ok.engine.close();
});

await run('spec 2.6: while the question is open 0 saves and 0 plays, a lock-screen Play included', async () => {
  const t = await asking();
  await t.engine.play();
  t.ms.handlers.get('play')();
  await t.engine.toggle();
  await t.engine.retry();
  t.q('.wsp-play-lg').click();
  t.key(t.q('.wsp-full'), ' ');
  t.key(t.q('.wsp-full'), 'ArrowRight');
  await t.audioEl.play();                               // an element started from outside
  await t.clock.advance(6 * 60000);
  t.ms.handlers.get('play')();
  await t.clock.advance(20000);
  check('nothing plays: the element, the engine and the lock screen agree', !t.st().playing && t.audioEl.paused && t.ms.playbackState !== 'playing', t.ms.playbackState);
  check('0 saves', t.posts.length === 0, t.posts);
  check('0 beacons and no local copy', Array.from(t.storage.map.keys()).every((k) => k.indexOf(':500:1') === -1), Array.from(t.storage.map.keys()));
  check('still at the start and still asking', t.st().bookMs === 0 && t.st().safetyNet !== null && t.snShown());
  check('no preview was started', t.calls.every((c) => c[0] !== 'previewAt'));
  t.engine.close();
});

await run('spec 2.6: Escape puts it off with a way back; the bar\'s Play brings it back; the lock screen stays held', async () => {
  const t = await asking();
  t.key(t.q('#wspPanel-safetynet'), 'Escape');
  await t.clock.advance(50);
  check('put off: the player stays, the prompt names the question', !t.snShown() && t.ui.isOpen() && t.prompts().length === 1 && t.prompts()[0] === SN_TITLE, t.prompts());
  check('still held, nothing saved', t.st().safetyNet !== null && t.posts.length === 0);
  t.ms.handlers.get('play')();
  await t.clock.advance(3000);
  check('the lock screen\'s Play is held', !t.st().playing && t.audioEl.paused);
  t.promptBtn('Take a look').click();
  await t.clock.advance(50);
  check('the prompt brings it back, and goes', t.snShown() && t.prompts().length === 0);
  // Closed with the full player; the bar's Play asks the question and plays nothing.
  t.ui.close();
  await t.clock.advance(500);
  check('the full player closed, the way back stays above the bar', t.prompts().length === 1 && !t.snShown());
  t.q('.wsp-bar .wsp-play').click();
  await t.clock.advance(1000);
  check('the bar\'s Play opens the full player on the question', t.ui.isOpen() && t.snShown() && !t.st().playing && t.posts.length === 0);
  check('and the prompt is gone', t.prompts().length === 0);
  t.engine.close();
});

await run('spec 2.6: on a wide screen it sits beside the player; Escape closes the player and keeps the question', async () => {
  const t = await asking({ wide: true });
  check('beside the player', t.snShown() && t.q('.wsp-full').hasAttribute('data-side'));
  t.key(t.q('#wspPanel-safetynet'), 'Escape');
  await t.clock.advance(1000);
  check('closed, still held, nothing saved, the way back above the bar', !t.ui.isOpen() && t.st().safetyNet !== null && t.posts.length === 0 && t.prompts().length === 1);
  t.engine.close();
});

await run('spec 2.6: a reload reopens the question, since nothing was saved', async () => {
  const t = await asking();
  await t.engine.play();
  t.key(t.q('#wspPanel-safetynet'), 'Escape');
  await t.clock.advance(60000);
  const storage = t.storage;
  const orphans = t.orphans;
  t.engine.close();
  const u = await setup({ storage });
  u.orphans = orphans;
  const p = u.engine.open(MULTI.key);
  await u.clock.advance(300);
  await p;
  check('asked again, the panel is open again', u.st().safetyNet !== null && u.snShown() && u.snRows().length === 2);
  check('still nothing saved', u.posts.length === 0 && t.posts.length === 0);
  u.engine.close();
});

await run('spec 2.6: a pick enters the helper as the old place, and confirming sends linked_from with link_manual', async () => {
  const t = await asking();
  t.snRows()[0].querySelector('.wsp-sn-pick').click();
  await t.clock.advance(100);
  check('the engine was asked to pick that place', t.calls.some((c) => c[0] === 'pickOrphan' && c[1] === '400:1'), t.calls);
  check('the question is over, the helper is open', t.st().safetyNet === null && t.st().filesChanged !== null && t.shown() && !t.snShown());
  check('the old place is the one picked', t.st().filesChanged.old.linked_from === '400:1' && t.st().filesChanged.old.manual === true, t.st().filesChanged.old);
  const text = t.panel().textContent;
  check('the helper names the earlier copy and says what to do', text.indexOf('From an earlier copy: Three Parts (First Edition), read by A. Reader') !== -1 &&
    text.indexOf('earlier copy') !== -1 && text.indexOf('files have changed') === -1 && text.indexOf('0:12:00 into the book') !== -1, text.slice(0, 300));
  check('candidates: the same time and the same point in this book', t.cards().length === 1 || t.cards().length === 2, t.cards().length);
  check('still nothing saved or playing', t.posts.length === 0 && !t.st().playing);
  t.card('time').querySelector('.wsp-fp-use').click();
  await t.clock.advance(5000);
  check('confirmed: one save at the spot, carrying the link by hand', t.posts.length === 1 && t.posts[0].linked_from === '400:1' && t.posts[0].link_manual === true &&
    t.posts[0].book_ms === 720000, t.posts);
  check('the hold is over', t.st().filesChanged === null && t.st().safetyNet === null && !t.shown() && !t.snShown());
  t.engine.close();
  // A pick put off with Escape and shown again is still the helper's.
  const u = await asking();
  u.snRows()[1].querySelector('.wsp-sn-pick').click();
  await u.clock.advance(100);
  u.key(u.q('#wspPanel-findplace'), 'Escape');
  await u.clock.advance(50);
  check('put off: the helper\'s prompt, not the question\'s, and for an earlier copy', u.prompts().length === 1 && u.prompts()[0] === 'You picked an earlier copy of this book.', u.prompts());
  u.promptBtn('Find your place').click();
  await u.clock.advance(50);
  check('and back', u.shown() && u.st().filesChanged.old.linked_from === '410:1');
  u.engine.close();
});

await run('spec 2.6: "Start from the beginning" after a pick links nothing', async () => {
  const t = await asking();
  t.snRows()[0].querySelector('.wsp-sn-pick').click();
  await t.clock.advance(100);
  const start = t.qa('.wsp-fp-row').find((b) => b.textContent.indexOf('Start from the beginning') !== -1);
  start.click();
  await t.clock.advance(5000);
  check('saved at 0 with no link', t.posts.length === 1 && t.posts[0].book_ms === 0 && !('linked_from' in t.posts[0]) && !('link_manual' in t.posts[0]), t.posts);
  t.engine.close();
});

await run('spec 2.6: "None of these" sticks: stored, the book opens as new, and the question never returns', async () => {
  const t = await asking();
  t.q('.wsp-sn-none').click();
  await t.clock.advance(3000);
  check('the engine was asked to dismiss', t.calls.some((c) => c[0] === 'dismissOrphans'));
  check('stored on the server for this book, once', t.dismissals.length === 1 && t.dismissals[0] === MULTI.key, t.dismissals);
  check('the panel is gone, no prompt, the open was to play so it plays', !t.snShown() && t.prompts().length === 0 && t.st().safetyNet === null && t.st().playing);
  check('the first save is the new book at its start, no link', t.posts.length >= 1 && t.posts[0].offset_ms < 5000 && t.posts.every((b) => !('linked_from' in b) && !('link_manual' in b)),
    t.posts.map((b) => [b.event, b.offset_ms]));
  const orphans = t.orphans;
  const dismissed = t.dismissed;
  t.engine.close();
  await t.clock.advance(100);
  // Another page session, another device: the server remembers.
  const u = await setup({ dismissed });
  u.orphans = orphans;
  const p = u.engine.open(MULTI.key);
  await u.clock.advance(300);
  await p;
  check('reopened: asked, answered "dismissed", no question', asked(u).length === 1 && u.st().safetyNet === null && !u.snShown() && u.st().playing, u.st().safetyNet);
  u.engine.close();
  // Said of another book, not this one: this one still asks.
  const v = await setup({ dismissed: new Set(['999:9']) });
  v.orphans = orphans;
  const q = v.engine.open(MULTI.key);
  await v.clock.advance(300);
  await q;
  check('a book it was not said of asks as ever', v.st().safetyNet !== null);
  v.engine.close();
});

await run('spec 2.6: "None of these" with the open not to play leaves it ready; Play then plays', async () => {
  const t = await setup();
  t.orphans = orphansFor(t);
  const p = t.engine.open(MULTI.key, { autoplay: false });
  await t.clock.advance(300);
  await p;
  check('asks even when the open only loads', t.st().safetyNet !== null && t.snShown());
  t.q('.wsp-sn-none').click();
  await t.clock.advance(1000);
  check('released, ready, not playing', t.st().safetyNet === null && !t.st().playing && t.posts.length === 0);
  await t.engine.play();
  await t.clock.advance(2000);
  check('Play plays', t.st().playing);
  t.engine.close();
});

await run('T3H2: a failed or slow lookup holds the book and the panel says so', async () => {
  const cases = [['a 503', 503], ['a 404', 404], ['slow (over 5 s)', 'slow']];
  for (const [name, mode] of cases) {
    const t = await setup();
    t.orphans = mode === 'slow' ? orphansFor(t) : mode;
    if (mode === 'slow') t.orphansDelay = 9000;
    const p = t.engine.open(MULTI.key);
    await t.clock.advance(mode === 'slow' ? 6000 : 300);
    await p;
    check(name + ': held as failed, the panel is up with the words', t.st().safetyNet && t.st().safetyNet.failed === true && t.snShown() &&
      t.snPanel().textContent.indexOf("We couldn't check for an earlier place.") !== -1, t.snPanel() && t.snPanel().textContent.slice(0, 160));
    check(name + ': titled for it, no list, no None of these', t.q('#wspPanel-safetynet').textContent === "Couldn't check for an earlier place" && t.q('.wsp-sn-none').hidden &&
      t.snPanel().querySelector('.wsp-fp-cands').hidden && t.snRows().length === 0, [t.q('#wspPanel-safetynet').textContent, t.q('.wsp-sn-none').hidden]);
    const names = t.qa('.wsp-sn-failed button').map((b) => b.textContent);
    check(name + ': Try again and Start this book', names.join() === 'Try again,Start this book' && !t.q('.wsp-sn-failed').hidden, names);
    await t.engine.play();
    t.ms.handlers.get('play')();
    await t.clock.advance(20000);
    check(name + ': nothing plays, nothing saved', !t.st().playing && t.audioEl.paused && t.posts.length === 0);
    check(name + ': Escape puts it off with a prompt that says so', (t.key(t.q('#wspPanel-safetynet'), 'Escape'), t.prompts().length === 1 && t.prompts()[0] === "We couldn't check for an earlier place."), t.prompts());
    t.promptBtn('Take a look').click();
    await t.clock.advance(50);
    check(name + ': and brings it back', t.snShown());
    t.engine.close();
  }
});

await run('T3H2: Try again runs the lookup again; Start this book is the explicit choice', async () => {
  const t = await setup();
  t.orphans = 503;
  let p = t.engine.open(MULTI.key);
  await t.clock.advance(300);
  await p;
  const before = asked(t).length;
  t.qa('.wsp-sn-failed button')[0].click();
  await t.clock.advance(600);
  check('Try again asked again, and it still fails: the same panel', asked(t).length === before + 1 && t.snShown() && t.st().safetyNet.failed === true && !t.st().playing && t.posts.length === 0);
  t.orphans = orphansFor(t);
  t.qa('.wsp-sn-failed button')[0].click();
  await t.clock.advance(600);
  check('then it answers: the question, with the places', t.snShown() && t.st().safetyNet.failed === false && t.snRows().length === 2 && t.q('.wsp-sn-failed').hidden &&
    t.q('#wspPanel-safetynet').textContent === SN_TITLE && !t.q('.wsp-sn-none').hidden, t.q('#wspPanel-safetynet').textContent);
  t.engine.close();
  const u = await setup();
  u.orphans = 503;
  p = u.engine.open(MULTI.key);
  await u.clock.advance(300);
  await p;
  u.qa('.wsp-sn-failed button')[1].click();
  await u.clock.advance(3000);
  check('Start this book: the panel is gone, it plays from the start, nothing stored on the server', !u.snShown() && u.st().safetyNet === null && u.st().playing &&
    u.dismissals.length === 0 && u.posts.length >= 1 && u.posts[0].offset_ms < 5000, [u.st().playing, u.dismissals, u.posts.length]);
  u.engine.close();
});

await run('T3U1: "Not this book" goes back from the helper to the list; nothing is saved', async () => {
  const t = await asking();
  const row = () => t.qa('.wsp-fp-row').find((b) => b.textContent.indexOf('Not this book') !== -1);
  check('not there for the question itself', t.snShown() && (!row() || row().closest('[hidden]')));
  t.snRows()[0].querySelector('.wsp-sn-pick').click();
  await t.clock.advance(100);
  check('shown in the helper after a pick', t.shown() && row() && !row().closest('[hidden]') && !row().disabled);
  t.card('time').querySelector('.wsp-fp-preview').click();
  await t.clock.advance(3000);
  row().click();
  await t.clock.advance(200);
  check('the helper is gone, the question is back with the same places', !t.shown() && t.snShown() && t.snRows().length === 2 && t.st().safetyNet !== null && t.st().filesChanged === null);
  check('the book is back at its start, not playing, nothing saved', t.st().bookMs === 0 && !t.st().playing && t.posts.length === 0 && t.audioEl.paused);
  t.snRows()[1].querySelector('.wsp-sn-pick').click();
  await t.clock.advance(100);
  check('pick another: the helper has that one', t.shown() && t.st().filesChanged.old.linked_from === '410:1');
  // While a confirm waits it is not offered.
  t.card('time') && t.cards()[0].querySelector('.wsp-fp-use').click();
  await t.clock.advance(5000);
  check('confirmed: the hold is over, the row is not in the way', t.st().filesChanged === null && t.posts.length === 1 && t.posts[0].linked_from === '410:1');
  t.engine.close();
  // The automatic link (no pick) never shows it.
  const u = await held({});
  check('files changed or a linked copy: no "Not this book"', u.qa('.wsp-fp-row').filter((b) => b.textContent.indexOf('Not this book') !== -1).every((b) => b.closest('[hidden]')));
  u.engine.close();
});

await run('T3U2: while the question is open the Play buttons and Retry look disabled', async () => {
  const t = await asking();
  const big = t.q('.wsp-play-lg');
  const bar = t.q('.wsp-bar .wsp-play');
  check('the big Play and the bar Play are aria-disabled', big.getAttribute('aria-disabled') === 'true' && bar.getAttribute('aria-disabled') === 'true');
  big.click();
  await t.clock.advance(500);
  check('pressing it plays nothing', !t.st().playing && t.posts.length === 0);
  t.snRows()[0].querySelector('.wsp-sn-pick').click();
  await t.clock.advance(100);
  check('after a pick (the helper: a Play is a preview) they are enabled', big.getAttribute('aria-disabled') === null && bar.getAttribute('aria-disabled') === null);
  t.q('.wsp-fp-row') && t.qa('.wsp-fp-row').find((b) => b.textContent.indexOf('Not this book') !== -1).click();
  await t.clock.advance(100);
  check('back at the question: disabled again', big.getAttribute('aria-disabled') === 'true');
  t.q('.wsp-sn-none').click();
  await t.clock.advance(2000);
  check('answered: enabled', big.getAttribute('aria-disabled') === null && bar.getAttribute('aria-disabled') === null);
  t.engine.close();
  // The error's Retry, shown while the question is open, is disabled and comes back to life.
  const u = await asking();
  u.engine.close();
  const css = readFileSync(join(here, '../../static/css/theme.css'), 'utf8');
  check('a dimmed style from theme variables, still when reduced motion', /\.wsp-play\[aria-disabled="true"\][^{]*\{[^}]*opacity/.test(css) && !/\.wsp-play\[aria-disabled="true"\][^{]*\{[^}]*(#[0-9a-f]{3,6}|rgb\(\d)/i.test(css));
});

await run('spec 2.6: a page without the safety net module still works (the engine holds, nothing plays)', async () => {
  const t = await asking({ noSafetyNet: true });
  await t.engine.play();
  t.ms.handlers.get('play')();
  await t.clock.advance(5000);
  check('held with no panel: still nothing plays or saves', t.st().safetyNet !== null && !t.st().playing && t.posts.length === 0);
  t.engine.close();
});

await run('spec 2.6: boot sets WS.playerSafetyNet once, and only with the player', async () => {
  const t = await setup({ noSafetyNet: true });
  t.win.WS = { player: t.engine, playerUI: t.ui };
  const n = SN.boot(t.win, { now: t.now });
  check('booted', n && t.win.WS.playerSafetyNet === n && typeof n.open === 'function' && n.shown === false);
  check('once', SN.boot(t.win, { now: t.now }) === n);
  check('one panel', t.qa('.wsp-panel[data-panel="safetynet"]').length === 1);
  check('nothing to open without a question', n.open(null) === false);
  const bare = new Window({ url: 'https://ws.test/' });
  bare.WS = {};
  check('no player, nothing', SN.boot(bare, {}) === null);
  await bare.happyDOM.close();
});

await run('spec 2.6: the pure text is the helper\'s', () => {
  check('always hours', SN.bookClock(725000) === '0:12:05' && SN.bookClock(11560000) === '3:12:40');
  check('percent', SN.percentOf(720000, 1800000) === 40 && SN.percentOf(999, 1000) === 99 && SN.percentOf(5, 0) === null && SN.percentOf(null, 10) === null);
  check('ago', SN.formatAgo(30000) === 'just now' && SN.formatAgo(3 * MIN) === '3 min ago' && SN.formatAgo(2 * 3600000) === '2 h ago' && SN.formatAgo(86400000) === '1 day ago' &&
    SN.formatAgo(3 * 86400000) === '3 days ago');
  for (const f of ['bookClock', 'percentOf', 'formatAgo']) {
    const a = FP[f]; const b = SN[f];
    const same = [0, 1, 999, 59999, 60000, 3599999, 86400000, 5e9, -5, NaN, null, undefined].every((v) => a(v, 1000) === b(v, 1000));
    check(f + ' agrees with findplace.js', same);
  }
});

await run('spec 2.6: no markup from strings, no timers, no inline handlers, no requests of its own', () => {
  const src = readFileSync(SAFETYNET_PATH, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('no innerHTML', !/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  check('no timers', !/setTimeout|setInterval/.test(code));
  check('no handler properties', !/\.on[a-z]+\s*=(?!=)/.test(src));
  check('no lookbehind', !/\(\?<[=!]/.test(src));
  check('no requests, no storage: it only calls the engine', !/\bfetch\(|sendBeacon|localStorage|playerSaves/.test(code));
});

await run('boot sets WS.playerFindPlace once, and only with the player', async () => {
  const t = await setup({ noHelper: true });
  t.win.WS = { player: t.engine, playerUI: t.ui, playerFeatures: t.features };
  const h = FP.boot(t.win, { now: t.now });
  check('booted', h && t.win.WS.playerFindPlace === h && typeof h.open === 'function');
  check('once', FP.boot(t.win, { now: t.now }) === h);
  check('one panel', t.qa('.wsp-panel[data-panel="findplace"]').length === 1);
  const bare = new Window({ url: 'https://ws.test/' });
  bare.WS = {};
  check('no player, nothing', FP.boot(bare, {}) === null);
  await bare.happyDOM.close();
});

await run('no markup from strings, no timers, no inline handlers', () => {
  const src = readFileSync(FINDPLACE_PATH, 'utf8');
  check('no innerHTML', !/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  check('no timers', !/setTimeout|setInterval/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  check('no handler properties', !/\.on[a-z]+\s*=(?!=)/.test(src));
  check('no lookbehind', !/\(\?<[=!]/.test(src));
});

check('nothing logged', consoleErrors.length === 0, consoleErrors);

const summary = `${total - failed}/${total} player find-your-place cases pass`;
if (failed) {
  realError(summary.replace('pass', 'checked') + `, ${failed} failed`);
  process.exit(1);
}
console.log(summary);
process.exit(0);
