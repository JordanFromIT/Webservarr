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
// FINDPLACE_JS=<path> / FEATURES_JS=<path> run the same cases against other
// copies of those files.
// Run: node app/tests/js/player_findplace.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(p, 'utf8')));
const FINDPLACE_PATH = process.env.FINDPLACE_JS || join(here, '../../static/js/player/findplace.js');
const FP = await load(FINDPLACE_PATH);
const F = await load(process.env.FEATURES_JS || join(here, '../../static/js/player/features.js'));
const E = await load(join(here, '../../static/js/player/engine.js'));
const S = await load(join(here, '../../static/js/player/saves.js'));
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
const BOOKS = { [MULTI.key]: MULTI, [MIXED.key]: MIXED };
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
    storage: memoryStorage(),
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
  await clock.advance(10);
  t.q = (sel) => doc.querySelector(sel);
  t.qa = (sel) => Array.from(doc.querySelectorAll(sel));
  t.st = () => t.engine.state();
  t.view = () => t.q('.wsp-full').getAttribute('data-view');
  t.panel = () => t.q('.wsp-panel[data-panel="findplace"]');
  t.shown = () => !!t.panel() && !t.panel().hidden && t.view() === 'findplace';
  t.cards = () => t.qa('.wsp-fp-cand').filter((c) => !c.hidden);
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
  for (const name of ['previewAt', 'confirmPlace', 'startOver', 'seek']) {
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
  check('the same time: clamped to this copy\'s end', c[0].kind === 'time' && c[0].bookMs === 10 * H, c[0]);
  check('the same point: 80% of this copy', c[1].kind === 'percent' && c[1].bookMs === 8 * H, c[1]);
  check('both inside the copy', c.every((x) => x.bookMs >= 0 && x.bookMs <= 10 * H));
  const end = FP.candidates({ book_ms: 20 * H, book_duration_ms: 20 * H }, 10 * H, [], null);
  check('the old end: one candidate, this copy\'s end', end.length === 1 && end[0].bookMs === 10 * H, end);
  const bad = FP.candidates({ book_ms: 30 * H, book_duration_ms: 20 * H }, 10 * H, [], null);
  check('a place past its own length still lands inside', bad.every((x) => x.bookMs <= 10 * H), bad);
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
  check('named, with the narrator', FP.copyLine({ book_title: 'Saga (Full Cast)', narrator: 'A. Reader' }) === 'From an earlier copy: Saga (Full Cast), read by A. Reader');
  check('no narrator: left out', FP.copyLine({ book_title: 'Saga', narrator: null }) === 'From an earlier copy: Saga');
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
  check('Show history and Start from the beginning', t.qa('.wsp-fp-row').map((b) => b.textContent.replace(/^\w+(?=[A-Z])/, '')).join() === 'Show history,Start from the beginning',
    t.qa('.wsp-fp-row').map((b) => b.textContent));
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
  check('startOver', t.calls.some((c) => c[0] === 'startOver'));
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
  const u = await held({ old: { book_ms: 2400000, book_duration_ms: 3000000 } });
  check('clamped to the end', u.card('time').querySelector('.wsp-fp-at').textContent.startsWith('0:30:00'), u.card('time').querySelector('.wsp-fp-at').textContent);
  check('says why', u.card('time').querySelector('.wsp-fp-note').textContent === 'This copy ends before then');
  u.engine.close();
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
  check('the entry, labelled', row.querySelector('.wsp-hist-what').textContent === 'Chapter 5 · 0:15:00 into the book · 50%' &&
    row.querySelector('.wsp-hist-tag').textContent === 'Earlier copy' && !row.disabled, row.textContent);
  row.click();
  await t.clock.advance(10);
  check('the helper, with that entry as the old place', t.shown() && t.txt('.wsp-fp-old-time') === '0:15:00 into the book · 50%' && t.txt('.wsp-fp-old-chapter') === 'Chapter 5',
    [t.view(), t.txt('.wsp-fp-old-time')]);
  check('an earlier copy\'s', t.txt('.wsp-fp-copy') === 'From an earlier copy');
  check('its candidates: one (the same length)', t.cards().length === 1 && t.cards()[0].querySelector('.wsp-fp-at').textContent === '0:15:00 · Part 2 of 3');
  check('the chosen spot moved to it, nothing saved', t.st().filesChanged.spot === 900000 && t.posts.length === 0);
  t.cards()[0].querySelector('.wsp-fp-use').click();
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
