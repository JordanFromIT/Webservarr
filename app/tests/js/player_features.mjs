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

/* One page: the real engine, saves, view and features. o: { path, prefs
   (the GET's answer; a number is its status), places ({ web } for the
   resume), wide, noFeatures }. */
async function setup(o = {}) {
  const win = new Window({ url: 'https://ws.test' + (o.path || '/news') });
  const doc = win.document;
  doc.body.innerHTML = '<main><h1>News</h1><button id="pageBtn" type="button">Page</button>' +
    '<input id="field" type="text"><input id="box" type="checkbox"><textarea id="area"></textarea>' +
    '<select id="sel"><option>a</option></select><div id="editor" contenteditable="true"><p id="para">x</p></div>' +
    '<div id="tabs" role="tab" tabindex="0">Tab</div></main><div id="wsPlayer" hidden></div>';
  const clock = fakeClock();
  const t = { win, doc, clock, loads: [], posts: [], fetches: [], puts: [], path: o.path || '/news' };
  t.now = () => NOW0 + clock.now;
  t.prefsAnswer = o.prefs === undefined ? { skip_s: 10, speed: 1, smart_rewind: true } : o.prefs;
  t.places = o.places || { web: null, plex: null };
  async function fetchFn(url, init) {
    init = init || {};
    t.fetches.push({ url, method: init.method || 'GET', body: init.body, keepalive: !!init.keepalive });
    if (url === '/api/player/prefs') {
      if ((init.method || 'GET') === 'PUT') {
        t.puts.push(JSON.parse(init.body));
        return response(200, {});
      }
      if (typeof t.prefsAnswer === 'number') return response(t.prefsAnswer, { detail: 'no' });
      return response(200, t.prefsAnswer);
    }
    let m = /^\/api\/player\/book\/([^?]+)/.exec(url);
    if (m) {
      const b = BOOKS[decodeURIComponent(m[1])];
      if (!b) return response(404, { detail: 'Not in the audiobook library' });
      return response(200, { ...b, stream: { token: 'tok', uris: { local: [], remote: [REMOTE] } } });
    }
    m = /^\/api\/player\/position\/(.+)$/.exec(url);
    if (m) return response(200, { web: t.places.web, plex: t.places.plex || null, now: new Date(t.now()).toISOString() });
    return response(404, {});
  }
  t.fetch = fetchFn;
  const saver = S.createSaver({
    post: (body) => {
      t.posts.push(body);
      return Promise.resolve({ status: 200, data: { stored: true, updated_at: new Date(t.now()).toISOString() } });
    },
    now: t.now,
    mono: () => clock.now,
    storage: null,
    identity: '',
    device: 'Test on Linux',
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    psid: 'test-psid'
  });
  const ms = {
    metadata: null, playbackState: 'none', handlers: new Map(),
    setActionHandler(a, fn) { this.handlers.set(a, fn); }, setPositionState() {}
  };
  t.ms = ms;
  const host = doc.getElementById('wsPlayer');
  // The engine's element is the fake one, kept aside (it is no DOM node).
  t.engine = E.createEngine({
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
  if (!o.noFeatures) {
    t.features = F.createFeatures({
      player: t.engine, ui: t.ui, doc, win, fetch: fetchFn,
      now: t.now, mono: () => clock.now,
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
  t.prefsAnswer = { skip_s: 15, speed: 1, smart_rewind: true };
  await t.openAt(MULTI.key, '501', 1000);
  const gets = t.fetches.filter((f) => f.url === '/api/player/prefs' && f.method === 'GET');
  check('asked again', gets.length === 2, gets.length);
  check('and applied', t.engine.setSkip() === 15);
  check('no notice', t.notices().length === 0);
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
    await t.engine.play();
    check('went back', bookMs(t) === at - want, bookMs(t) - at);
    await t.clock.advance(1500);
    // A save carries the place as it is when it goes: the rewound place,
    // played on for the second saves are kept apart.
    const off = at - 600000 - want;
    if (want) check('the rewound place was saved', t.posts.some((b) => b.event === 'seek' && b.track === '502' && b.offset_ms >= off && b.offset_ms <= off + 1250), t.posts.slice(-3).map((b) => [b.event, b.offset_ms]));
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
  await t.clock.advance(500);
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

for (const [agoMs, want] of [[5000, 0], [45000, 3000], [2 * 3600000, 30000]]) {
  await run(`a book opened at a place saved ${agoMs} ms ago goes back ${want} ms`, async () => {
    const t = await setup();
    t.places = { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: new Date(NOW0 - agoMs).toISOString(), device: 'Phone' } };
    const p = t.engine.open(MULTI.key);
    await t.clock.advance(300);
    await p;
    check('opened there, less the rewind', bookMs(t) >= 900000 - want && bookMs(t) < 900000 - want + 1000, bookMs(t) - 900000);
    await t.clock.advance(1500);
    if (want) check('the rewound place was saved', t.posts.some((b) => b.track === '502' && b.offset_ms === 300000 - want), t.posts.map((b) => [b.event, b.offset_ms]));
    check('no undo offered', t.notices().length === 0);
    t.engine.close();
  });
}

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

await run('boot sets WS.playerFeatures once, and only with the player', async () => {
  const t = await setup({ noFeatures: true });
  t.win.WS = { player: t.engine, playerUI: t.ui };
  const over = { fetch: t.fetch, setTimeout: t.clock.setTimeout, clearTimeout: t.clock.clearTimeout, now: t.now, mono: () => t.clock.now };
  const f = F.boot(t.win, over);
  check('booted', f && t.win.WS.playerFeatures === f && typeof f.sleep === 'function');
  check('once', F.boot(t.win, over) === f);
  await t.clock.advance(10);
  check('one GET', t.fetches.filter((x) => x.url === '/api/player/prefs').length === 1);
  const bare = new Window({ url: 'https://ws.test/' });
  bare.WS = {};
  check('no player, nothing', F.boot(bare, over) === null);
  await bare.happyDOM.close();
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
