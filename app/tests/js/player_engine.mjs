// The audiobook playback engine (app/static/js/player/engine.js) run against
// a scripted Plex: a fake <audio> element whose loads succeed, fail, hang or
// drop mid-stream by connection, part and token, a fake /api/player/book,
// fake timers and a fake Media Session. The boot case runs in happy-dom with
// its real <audio> element and #wsPlayer.
//
// Imports engine.js as it is, through a data: URL like reader_progress.mjs
// (a module in a folder with no package.json "type"); that also proves the
// module touches no DOM at import time.
// ENGINE_JS=<path> runs the same cases against another copy of engine.js.
// Run: node app/tests/js/player_engine.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.ENGINE_JS || join(here, '../../static/js/player/engine.js');
const src = readFileSync(ENGINE, 'utf8');
const E = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

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

// Everything the engine writes to the console, for the token checks. The
// test's own FAIL lines go through the saved console.error.
const consoleSeen = [];
const realError = console.error;
for (const k of ['log', 'info', 'warn', 'debug']) {
  console[k] = (...a) => { consoleSeen.push(a.map(String).join(' ')); };
}
console.error = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('FAIL ')) return realError(...a);
  consoleSeen.push(a.map(String).join(' '));
};

// ---- Fake timers ----
// A clock whose time moves only when the test says. advance() fires every
// timer due by then, in order, and lets the promises each one starts run
// before the next.
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock() {
  let now = 0;
  let ids = 0;
  const due = new Map();
  const clock = {
    get now() { return now; },
    setTimeout(fn, ms) { const id = ++ids; due.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { due.delete(id); },
    async advance(ms) {
      const end = now + ms;
      await flush();              // work already started may set timers first
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
  return clock;
}

// ---- The library ----

const LOCAL = 'https://10-0-0-5.abcdef.plex.direct:32400';
const REMOTE = 'https://198-51-100-7.abcdef.plex.direct:32400';
const TOKEN = 'SeCrEt-server-token-0001';

const MULTI = {
  key: '500:1', title: 'Three Parts', author: 'A. Writer', narrator: 'N. Reader', series: 'Saga',
  cover: '/api/player/cover/500:1?v=77', duration_ms: 1800000, shape: 'parts',
  tracks: [
    { key: '501', part_path: '/library/parts/901/1/file.mp3', duration_ms: 600000, index: 1 },
    { key: '502', part_path: '/library/parts/902/1/file.mp3', duration_ms: 900000, index: 2 },
    { key: '503', part_path: '/library/parts/903/1/file.mp3', duration_ms: 300000, index: 3 }
  ],
  chapters: [
    { index: 1, label: 'Part 1 of 3', start_ms: 0, end_ms: 600000, track: '501', track_start_ms: 0, track_end_ms: 600000 },
    { index: 2, label: 'Part 2 of 3', start_ms: 600000, end_ms: 1500000, track: '502', track_start_ms: 0, track_end_ms: 900000 },
    { index: 3, label: 'Part 3 of 3', start_ms: 1500000, end_ms: 1800000, track: '503', track_start_ms: 0, track_end_ms: 300000 }
  ]
};
// Seventeen hours in one file (Review Focus 4).
const LONG = 17 * 3600 * 1000;
const SINGLE = {
  key: '600:1', title: 'One Long File', author: 'B. Writer', narrator: '', series: '',
  cover: '/api/player/cover/600:1?v=5', duration_ms: LONG, shape: 'single',
  tracks: [{ key: '601', part_path: '/library/parts/961/1/file.m4b', duration_ms: LONG, index: 1 }],
  chapters: [
    { index: 1, label: 'Opening', start_ms: 0, end_ms: 1000000, track: '601', track_start_ms: 0, track_end_ms: 1000000 },
    { index: 2, label: 'Chapter 2 of 3', start_ms: 1000000, end_ms: 30000000, track: '601', track_start_ms: 1000000, track_end_ms: 30000000 },
    { index: 3, label: 'Chapter 3 of 3', start_ms: 30000000, end_ms: LONG, track: '601', track_start_ms: 30000000, track_end_ms: LONG }
  ]
};
const OTHER = JSON.parse(JSON.stringify(MULTI));
Object.assign(OTHER, { key: '700:1', title: 'Another', cover: '' });
OTHER.tracks.forEach((t, i) => { t.key = String(701 + i); t.part_path = `/library/parts/97${i}/1/file.mp3`; });
OTHER.chapters.forEach((c, i) => { c.track = String(701 + i); });
// Spec 11a: a format this browser cannot decode (E-AC3 in an .m4b), 20 h in
// one file; a book whose middle part is one, between an mp3 and an AAC part;
// and four parts where the second is missing and the third undecodable.
const EAC3 = { container: 'mp4', codec: 'eac3', profile: 'dolby digital plus + dolby atmos' };
const ATMOS_MS = 20 * 3600 * 1000;
const ATMOS = {
  key: '800:1', title: 'Loud Book', author: 'C. Writer', narrator: '', series: '', cover: '', duration_ms: ATMOS_MS, shape: 'single',
  tracks: [{ key: '801', part_path: '/library/parts/981/1/file.m4b', duration_ms: ATMOS_MS, index: 1, ...EAC3 }],
  chapters: [
    { index: 1, label: 'Chapter 1 of 2', start_ms: 0, end_ms: 36000000, track: '801', track_start_ms: 0, track_end_ms: 36000000 },
    { index: 2, label: 'Chapter 2 of 2', start_ms: 36000000, end_ms: ATMOS_MS, track: '801', track_start_ms: 36000000, track_end_ms: ATMOS_MS }
  ]
};
const MIXED = {
  key: '900:1', title: 'Mixed Parts', author: 'D. Writer', narrator: '', series: '', cover: '', duration_ms: 1800000, shape: 'parts',
  tracks: [
    { key: '901', part_path: '/library/parts/991/1/file.mp3', duration_ms: 600000, index: 1, container: 'mp3', codec: 'mp3', profile: '' },
    { key: '902', part_path: '/library/parts/992/1/file.m4b', duration_ms: 900000, index: 2, ...EAC3 },
    { key: '903', part_path: '/library/parts/993/1/file.m4a', duration_ms: 300000, index: 3, container: 'mp4', codec: 'aac', profile: 'lc' }
  ],
  chapters: [
    { index: 1, label: 'Part 1 of 3', start_ms: 0, end_ms: 600000, track: '901', track_start_ms: 0, track_end_ms: 600000 },
    { index: 2, label: 'Part 2 of 3', start_ms: 600000, end_ms: 1500000, track: '902', track_start_ms: 0, track_end_ms: 900000 },
    { index: 3, label: 'Part 3 of 3', start_ms: 1500000, end_ms: 1800000, track: '903', track_start_ms: 0, track_end_ms: 300000 }
  ]
};
const FOUR = {
  key: '910:1', title: 'Four Parts', author: 'E. Writer', narrator: '', series: '', cover: '', duration_ms: 1200000, shape: 'parts',
  tracks: [
    { key: '911', part_path: '/library/parts/911/1/file.mp3', duration_ms: 300000, index: 1, container: 'mp3', codec: 'mp3', profile: '' },
    { key: '912', part_path: '/library/parts/912/1/file.mp3', duration_ms: 300000, index: 2, container: 'mp3', codec: 'mp3', profile: '' },
    { key: '913', part_path: '/library/parts/913/1/file.m4b', duration_ms: 300000, index: 3, ...EAC3 },
    { key: '914', part_path: '/library/parts/914/1/file.mp3', duration_ms: 300000, index: 4, container: 'mp3', codec: 'mp3', profile: '' }
  ],
  chapters: []
};
// The first part undecodable, the rest mp3.
const FIRSTBAD = {
  key: '920:1', title: 'Bad Start', author: 'F. Writer', narrator: '', series: '', cover: '', duration_ms: 900000, shape: 'parts',
  tracks: [
    { key: '921', part_path: '/library/parts/921/1/file.m4b', duration_ms: 300000, index: 1, ...EAC3 },
    { key: '922', part_path: '/library/parts/922/1/file.mp3', duration_ms: 300000, index: 2, container: 'mp3', codec: 'mp3', profile: '' },
    { key: '923', part_path: '/library/parts/923/1/file.mp3', duration_ms: 300000, index: 3, container: 'mp3', codec: 'mp3', profile: '' }
  ],
  chapters: [
    { index: 1, label: 'Part 1 of 3', start_ms: 0, end_ms: 300000, track: '921', track_start_ms: 0, track_end_ms: 300000 },
    { index: 2, label: 'Part 2 of 3', start_ms: 300000, end_ms: 600000, track: '922', track_start_ms: 0, track_end_ms: 300000 },
    { index: 3, label: 'Part 3 of 3', start_ms: 600000, end_ms: 900000, track: '923', track_start_ms: 0, track_end_ms: 300000 }
  ]
};
const BOOKS = { [MULTI.key]: MULTI, [SINGLE.key]: SINGLE, [OTHER.key]: OTHER, [ATMOS.key]: ATMOS, [MIXED.key]: MIXED, [FOUR.key]: FOUR, [FIRSTBAD.key]: FIRSTBAD };
const trackByPath = new Map();
for (const b of Object.values(BOOKS)) for (const t of b.tracks) trackByPath.set(t.part_path, t);
// What a browser like Chrome answers canPlayType: '' for E-AC3 and AC-3,
// and '' for an empty type (as every browser does).
const UNDECODABLE = new Set(['', 'audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="ac-3"']);

// ---- A scripted Plex: which connection, part and token answers how ----

function makeNet() {
  return {
    token: TOKEN,       // the token the server accepts (a rotation changes it)
    down: new Set(),    // sides refusing (a load fails; a playing stream errors, code 2)
    hang: new Set(),    // sides that never answer (a load hangs; a playing stream stalls)
    missing: new Set(), // part paths that 404
    decodeAt: new Map(),// part path -> second at which decoding fails (code 3)
    latency: 50,
    blockAutoplay: false,
    safari: false,      // playbackRate throws before metadata
    fetchDelay: {},     // book key -> ms before /api/player/book answers
    mediaCache: false,  // a URL that loaded before still loads its metadata while its side is down
    cached: new Set(),  // (with mediaCache) every URL that has loaded
    glitchOnce: new Map(), // part path -> second at which decoding fails once
    statusFor: {},      // book key -> the status /api/player/book answers
    noLocal: false,
    noRemote: false,    // no remote connection (Plex's remote access off)
    bookStatus: 200,
    bookDetail: '',
    canPlayAsked: [],   // every type canPlayType was asked about
    loads: [],          // every load an element started: { side, part, probe }
    fetches: []         // every URL the engine fetched
  };
}
const sideOf = (url) => url.startsWith(LOCAL + '/') ? 'local' : url.startsWith(REMOTE + '/') ? 'remote' : '?';

function answer(net, url) {
  const u = new URL(url);
  const side = sideOf(url);
  const part = u.pathname;
  if (net.mediaCache && net.cached.has(url) && trackByPath.get(part) &&
      (net.hang.has(side) || net.down.has(side))) {
    return { kind: 'ok', side, part, durationMs: trackByPath.get(part).duration_ms };   // the browser's media cache
  }
  if (net.hang.has(side)) return { kind: 'hang', side, part };
  if (net.down.has(side) || u.searchParams.get('X-Plex-Token') !== net.token || net.missing.has(part)) {
    return { kind: 'fail', side, part };
  }
  const t = trackByPath.get(part);
  if (!t) return { kind: 'fail', side, part };
  return { kind: 'ok', side, part, durationMs: t.duration_ms };
}

// A media element as far as the engine uses it, following the HTML load
// algorithm where it matters: a new src resets the time, the error and the
// rate (to defaultPlaybackRate) and pauses without a pause event; the end of
// the media fires timeupdate, pause, ended; a failed load is error code 4, a
// stream dropped while playing code 2, bad data code 3.
let audioIds = 0;
class FakeAudio {
  constructor(env) {
    this.env = env;
    this.id = ++audioIds;
    this.ls = new Map();
    this.attrs = new Map();
    this._src = '';
    this._t = 0;
    this.paused = true;
    this.ended = false;
    this.duration = NaN;
    this.error = null;
    this._rate = 1;
    this.defaultPlaybackRate = 1;
    this.readyState = 0;
    this.seeking = false;
    this.preload = 'auto';
    this.muted = false;
    this.gen = 0;
    this.loads = 0;
    this.side = null;
    this.part = null;
    this.ticking = false;
    this.onloadedmetadata = null;
    this.onerror = null;
    env.audios.push(this);
  }
  canPlayType(mime) { this.env.net.canPlayAsked.push(mime); return UNDECODABLE.has(mime) ? '' : 'probably'; }
  addEventListener(t, fn) { if (!this.ls.has(t)) this.ls.set(t, []); this.ls.get(t).push(fn); }
  removeEventListener(t, fn) { const a = this.ls.get(t); if (a && a.indexOf(fn) !== -1) a.splice(a.indexOf(fn), 1); }
  listenerCount() { let n = 0; for (const a of this.ls.values()) n += a.length; return n; }
  fire(t) {
    for (const fn of (this.ls.get(t) || []).slice()) fn.call(this, { type: t, target: this });
    const h = this['on' + t];
    if (typeof h === 'function') h.call(this, { type: t, target: this });
  }
  setAttribute(n, v) { if (n === 'src') this.src = v; else this.attrs.set(n, String(v)); }
  getAttribute(n) { return n === 'src' ? (this._src || null) : (this.attrs.has(n) ? this.attrs.get(n) : null); }
  hasAttribute(n) { return this.getAttribute(n) !== null; }
  removeAttribute(n) { if (n === 'src') this._src = ''; else this.attrs.delete(n); }
  get playbackRate() { return this._rate; }
  set playbackRate(v) {
    // Safari refuses a rate before the media's metadata is known.
    if (this.env.net.safari && this.readyState < 1) throw new DOMException('The operation is not supported.', 'NotSupportedError');
    this._rate = Number(v);
  }
  get src() { return this._src; }
  set src(v) { this._src = String(v); this.select(); }
  load() { this.loads += 1; this.select(); }
  get currentTime() { return this._t; }
  set currentTime(v) {
    const d = isFinite(this.duration) ? this.duration : Infinity;
    this._t = Math.max(0, Math.min(Number(v), d));
    this.ended = false;
    if (this.readyState < 1) return;
    this.seeking = true;
    this.fire('seeking');
    const g = this.gen;
    this.env.clock.setTimeout(() => {
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
    this._rate = 1;               // a new src plays at 1.0 until told otherwise (Chrome)
    this.paused = true;
    const moved = this._t !== 0;
    this._t = 0;
    this.fire('emptied');
    if (moved) this.fire('timeupdate');
    if (!this._src) return;
    const a = answer(this.env.net, this._src);
    this.side = a.side;
    this.part = a.part;
    this.env.net.loads.push({ side: a.side, part: a.part, probe: this.preload === 'metadata', url: this._src });
    if (a.kind === 'hang') return;
    this.env.clock.setTimeout(() => {
      if (g !== this.gen) return;
      if (a.kind === 'fail') { this.error = { code: 4 }; this.fire('error'); return; }
      this.env.net.cached.add(this._src);
      this.duration = a.durationMs / 1000;
      this.readyState = 1;
      this.fire('loadedmetadata');
      if (g !== this.gen) return;
      this.readyState = 4;
      this.fire('canplay');
      if (!this.paused) this.begin();
    }, this.env.net.latency);
  }
  play() {
    if (this.env.net.blockAutoplay) {
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
    this.env.clock.setTimeout(() => {
      if (g !== this.gen || this.paused || !this.ticking) return;
      const net = this.env.net;
      if (net.down.has(this.side)) { this.ticking = false; this.error = { code: 2 }; this.fire('error'); return; }
      if (net.hang.has(this.side)) { this.ticking = false; this.fire('waiting'); return; }
      const bad = net.decodeAt.get(this.part);
      if (bad !== undefined && this._t >= bad) { this.ticking = false; this.error = { code: 3 }; this.fire('error'); return; }
      const once = net.glitchOnce.get(this.part);
      if (once !== undefined && this._t >= once) {
        net.glitchOnce.delete(this.part);
        this.ticking = false; this.error = { code: 3 }; this.fire('error'); return;
      }
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

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(JSON.stringify(body))
  };
}

function makeFetch(net, clock) {
  return async function (url, init) {
    net.fetches.push(url);
    // The safety net (spec 2.6): net.orphans, an array of places (none by
    // default) or a status number, answers GET /api/player/orphans/<key>; net.orphansDelay (ms)
    // holds the answer back; a POST to .../dismiss is recorded in net.dismissals.
    if (/^\/api\/player\/orphans\//.test(url)) {
      if (init && init.method === 'POST') {
        (net.dismissals = net.dismissals || []).push(url);
        return response(net.dismissStatus || 200, { dismissed: true });
      }
      if (net.orphansDelay && clock) await new Promise((r) => clock.setTimeout(r, net.orphansDelay));
      if (net.orphans === 'throw') throw new TypeError('Failed to fetch');
      if (typeof net.orphans === 'number') return response(net.orphans, { detail: 'no' });
      return response(200, { orphans: net.orphans === undefined ? [] : net.orphans, dismissed: false });
    }
    // The saved places (net.positions { web, plex }), for engines given a saver.
    if (net.positions && /^\/api\/player\/position\//.test(url)) {
      return response(200, Object.assign({ now: '2026-09-30T12:00:00.000Z' }, net.positions));
    }
    const m = /^\/api\/player\/book\/([^?]+)(\?refresh=1)?$/.exec(url);
    if (!m) return response(404, { detail: 'Not Found' });
    const wait = net.fetchDelay[decodeURIComponent(m[1])];
    if (wait && clock) await new Promise((r) => clock.setTimeout(r, wait));
    const own = net.statusFor[decodeURIComponent(m[1])];
    if (own) return response(own, { detail: 'down' });
    if (net.bookStatus !== 200) return response(net.bookStatus, { detail: net.bookDetail });
    const book = BOOKS[decodeURIComponent(m[1])];
    if (!book) return response(404, { detail: 'Not in the audiobook library' });
    return response(200, { ...book, stream: { token: net.token, uris: { local: net.noLocal ? [] : [LOCAL], remote: net.noRemote ? [] : [REMOTE] } } });
  };
}

function fakeMediaSession() {
  return {
    metadata: null,
    playbackState: 'none',
    handlers: new Map(),
    positions: [],
    setActionHandler(action, fn) { this.handlers.set(action, fn); },
    setPositionState(s) { this.positions.push(s); }
  };
}
class FakeMetadata { constructor(init) { Object.assign(this, init); } }

// Payloads as JSON (functions shown as "[fn]"): what a listener could keep.
const asJson = (v) => JSON.stringify(v, (k, x) => (typeof x === 'function' ? '[fn]' : x));

function setup(o = {}) {
  const clock = fakeClock();
  const net = Object.assign(makeNet(), o.net || {});
  const env = { clock, net, audios: [] };
  const ms = fakeMediaSession();
  const host = { children: [], appendChild(el) { this.children.push(el); return el; } };
  // The engine's own timers, counted so a closed engine can be shown to hold none.
  const live = new Set();
  const engine = E.createEngine({
    host,
    createAudio: () => new (o.Audio || FakeAudio)(env),
    fetch: makeFetch(net, clock),
    setTimeout(fn, t) { const id = clock.setTimeout(() => { live.delete(id); fn(); }, t); live.add(id); return id; },
    clearTimeout(id) { live.delete(id); clock.clearTimeout(id); },
    mediaSession: ms,
    MediaMetadata: FakeMetadata,
    permissions: o.permissions,
    baseUrl: 'https://ws.test/news',
    saver: o.saver,
    now: o.wall ? () => clock.now : undefined
  });
  const log = { change: [], ended: [], error: [], warning: [], raw: [] };
  // Every place a change reported, with what the element was doing then:
  // the part it had loaded, how far into it it was, and whether it played.
  const positions = [];
  const seen = [];
  const main = host.children[0];
  for (const k of ['change', 'ended', 'error', 'warning']) {
    engine.on(k, (d) => {
      log[k].push(JSON.parse(asJson(d)));
      log.raw.push([k, d]);
      if (k === 'change') {
        positions.push(engine.state().position);
        seen.push({ pos: engine.state().position, part: partOf(main), t: main.currentTime, playing: !main.paused, reason: d.reason });
      }
    });
  }
  const probes = () => env.audios.filter((a) => a !== main);
  return { clock, net, env, engine, ms, host, main, log, positions, seen, live, probes };
}

const partOf = (a) => (a && a.src ? new URL(a.src).pathname : '');
const reasons = (t) => t.log.change.map((c) => c.reason);
const at = (track, offset) => ({ track, offset_ms: offset });

// Opens a book and lets it get playing on the local connection.
async function openPlaying(t, key, opts) {
  const p = t.engine.open(key, opts);
  await t.clock.advance(400);
  await p;
  return p;
}

// ---- 1. Book time <-> (track, offset) at part boundaries ----
current = 'mapping';
{
  const T = MULTI.tracks;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cases = [
    [0, { index: 0, track: '501', offset_ms: 0 }],
    [599999, { index: 0, track: '501', offset_ms: 599999 }],
    [600000, { index: 1, track: '502', offset_ms: 0 }],        // a part's first instant is that part's
    [600001, { index: 1, track: '502', offset_ms: 1 }],
    [1499999, { index: 1, track: '502', offset_ms: 899999 }],
    [1500000, { index: 2, track: '503', offset_ms: 0 }],
    [1800000, { index: 2, track: '503', offset_ms: 300000 }],  // the end of the book: the last part's end
    [9e9, { index: 2, track: '503', offset_ms: 300000 }],
    [-5, { index: 0, track: '501', offset_ms: 0 }],
    [NaN, { index: 0, track: '501', offset_ms: 0 }]
  ];
  for (const [ms, want] of cases) {
    const got = E.toTrackOffset(T, ms);
    check(`toTrackOffset(${ms})`, same(got, want), got);
  }
  check('toTrackOffset with no tracks is null', E.toTrackOffset([], 5) === null);
  check('toBookMs part 2 at 0 is the end of part 1', E.toBookMs(T, '502', 0) === 600000);
  check('toBookMs part 1 at its end is the same instant', E.toBookMs(T, '501', 600000) === 600000);
  check('toBookMs part 3 at its end is the book duration', E.toBookMs(T, '503', 300000) === 1800000);
  check('toBookMs clamps an offset past the part', E.toBookMs(T, '501', 700000) === 600000);
  check('toBookMs clamps a negative offset', E.toBookMs(T, '502', -3) === 600000);
  check('toBookMs of an unknown track is null', E.toBookMs(T, '999', 5) === null);
  let roundTrips = true;
  for (const ms of [0, 1, 599999, 600000, 1234567, 1499999, 1500000, 1799999, 1800000]) {
    const p = E.toTrackOffset(T, ms);
    if (E.toBookMs(T, p.track, p.offset_ms) !== ms) roundTrips = false;
  }
  check('book time -> (track, offset) -> book time is exact', roundTrips);
}

// ---- 2. Chapter lookup at exact boundaries (Review Focus 4) ----
current = 'chapter lookup at exact boundaries';
{
  const C = SINGLE.chapters;
  check('the book start is chapter 1', E.chapterAt(C, 0) === 0);
  check('the instant before chapter 2 is chapter 1', E.chapterAt(C, 999999) === 0);
  check('an offset exactly on chapter 2 start belongs to chapter 2', E.chapterAt(C, 1000000) === 1);
  check('an offset exactly on chapter 3 start belongs to chapter 3', E.chapterAt(C, 30000000) === 2);
  check('the last chapter ends at the duration', C[C.length - 1].end_ms === SINGLE.duration_ms);
  check('the final end (the duration) is the last chapter', E.chapterAt(C, LONG) === 2);
  check('past the end is the last chapter', E.chapterAt(C, LONG + 5) === 2);
  check('before the start is chapter 1', E.chapterAt(C, -1) === 0);
  check('no chapters is -1', E.chapterAt([], 5) === -1);
  check('a part boundary is the next part', E.chapterAt(MULTI.chapters, 600000) === 1);
}
current = 'seeking far in a 17 h single file';
{
  const t = setup();
  await openPlaying(t, SINGLE.key);
  const src = t.main.src;
  const loads = t.main.loads;
  t.engine.seek(16 * 3600 * 1000);
  await t.clock.advance(20);
  check('the same file is kept (a Range seek, no reload)', t.main.src === src && t.main.loads === loads);
  check('the element seeks to 16 h', t.main.currentTime === 57600, t.main.currentTime);
  check('book time is 16 h', t.engine.state().bookMs === 57600000, t.engine.state().bookMs);
  check('16 h is in the last chapter', t.engine.state().chapterIndex === 2);
  t.engine.seek(LONG);
  await t.clock.advance(20);
  check('a seek to the very end is the last chapter', t.engine.state().chapterIndex === 2);
  t.engine.close();
}

// ---- 3. Opening: the local probe, 1.5 s, then remote; the choice is kept ----
current = 'open probes local with a 1.5 s timeout then falls back to remote';
{
  const t = setup({ net: { hang: new Set(['local']) } });
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(1499);
  const probes = t.probes();
  check('one probe element', probes.length === 1, probes.length);
  check('the probe loads metadata only', probes[0] && probes[0].preload === 'metadata');
  check('the probe is on the local connection', t.net.loads[0] && t.net.loads[0].side === 'local' && t.net.loads[0].probe);
  check('the probe is not in the player', !t.host.children.includes(probes[0]));
  check('nothing plays while the probe waits', t.main.src === '');
  check('the state says loading while probing', t.engine.state().loading === true);
  await t.clock.advance(1);
  check('after 1.5 s the remote connection is used', sideOf(t.main.src) === 'remote', t.main.src && sideOf(t.main.src));
  check('the state names the connection', t.engine.state().connection === 'remote');
  check('the probe is torn down (src removed and reloaded)', probes[0].src === '' && probes[0].loads >= 1);
  check('the probe keeps no handlers', !probes[0].onloadedmetadata && !probes[0].onerror && probes[0].listenerCount() === 0);
  await t.clock.advance(400);
  await p;
  check('it plays', t.engine.state().playing === true && !t.main.paused && t.main.currentTime > 0);
  // The choice is kept for the page session: the next book is not probed.
  const probed = t.net.loads.filter((l) => l.probe).length;
  const q = t.engine.open(OTHER.key);
  await t.clock.advance(400);
  await q;
  check('the next book is not probed', t.net.loads.filter((l) => l.probe).length === probed);
  check('the next book uses the kept connection', sideOf(t.main.src) === 'remote');
  t.engine.close();
}
current = 'open uses the local connection when the probe answers';
{
  const t = setup();
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(60);
  const probe = t.probes()[0];
  check('the probe answered and was torn down at once', probe && probe.src === '' && probe.loads >= 1);
  await t.clock.advance(400);
  await p;
  check('local is used', sideOf(t.main.src) === 'local' && t.engine.state().connection === 'local');
  check('the first part plays from 0', partOf(t.main) === MULTI.tracks[0].part_path && t.engine.state().playing);
  t.engine.close();
}
// ---- 3b. The Local Network Access gate: local only when already granted ----
// A permissions API answering one state; asked records every name queried.
function fakePermissions(answer) {
  const p = { asked: [] };
  p.query = (desc) => {
    p.asked.push(desc && desc.name);
    if (answer === 'throw') return Promise.reject(new TypeError("'local-network-access' is not a valid permission name"));
    return Promise.resolve({ state: answer });
  };
  return p;
}
for (const state of ['granted', 'prompt', 'denied', 'throw']) {
  current = `local network permission: ${state}`;
  const perms = fakePermissions(state);
  const t = setup({ permissions: perms });
  await openPlaying(t, MULTI.key);
  const localLoads = t.net.loads.filter((l) => l.side === 'local');
  check('the permission was asked by its name', perms.asked[0] === 'local-network-access', perms.asked);
  if (state === 'granted' || state === 'throw') {
    check('local is probed', t.probes().length === 1 && localLoads.some((l) => l.probe));
    check('and used', t.engine.state().connection === 'local' && t.engine.state().playing);
  } else {
    check('no probe element is created', t.probes().length === 0, t.probes().length);
    check('nothing is loaded from the local connection', localLoads.length === 0, localLoads);
    check('remote is chosen and plays', t.engine.state().connection === 'remote' && t.engine.state().playing && !t.main.paused);
    // The failure ladder never falls back to local either.
    t.net.down.add('remote');
    await t.clock.advance(20000);
    check('a remote failure never loads local', t.net.loads.every((l) => l.side !== 'local'));
    check('it ends in the error instead', t.log.error.length === 1 && t.log.error[0].code === 'unreachable');
    // The answer is kept for the page session: asked once.
    t.net.down.clear();
    t.engine.close();
    const q = t.engine.open(OTHER.key);
    await t.clock.advance(400);
    await q;
    check('asked once per page session', perms.asked.length === 1, perms.asked.length);
    check('the next book is remote too, no local load', t.engine.state().connection === 'remote' && t.net.loads.every((l) => l.side !== 'local'));
  }
  t.engine.close();
}
current = 'a local connection that appears only after a refresh is never loaded unasked';
{
  const perms = fakePermissions('prompt');
  const t = setup({ permissions: perms, net: { noLocal: true } });
  await openPlaying(t, MULTI.key);
  check('remote at first', t.engine.state().connection === 'remote');
  t.net.noLocal = false;                       // the refreshed answer lists a local connection
  t.net.down.add('remote');
  await t.clock.advance(20000);
  check('refreshed', t.net.fetches.some((u) => u.endsWith('?refresh=1')));
  check('local was never loaded', t.net.loads.every((l) => l.side !== 'local'), t.net.loads.filter((l) => l.side === 'local'));
  t.engine.close();
}
current = 'a permission query that never answers counts as no';
{
  const perms = { asked: 0, query() { this.asked += 1; return new Promise(() => {}); } };
  const t = setup({ permissions: perms });
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(E.PROBE_MS + 400);
  await p;
  check('remote, no local load', t.engine.state().connection === 'remote' && t.net.loads.every((l) => l.side !== 'local'));
  t.engine.close();
}
current = 'no local connection: remote without a probe';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MULTI.key);
  check('no probe', t.probes().length === 0);
  check('remote', t.engine.state().connection === 'remote' && t.engine.state().playing);
  t.engine.close();
}
current = 'open at a saved place';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('502', 300000) });
  check('the saved part is loaded', partOf(t.main) === MULTI.tracks[1].part_path);
  check('the element starts at the saved offset', t.main.currentTime >= 300 && t.main.currentTime < 301, t.main.currentTime);
  const s = t.engine.state();
  check('state: book time', s.bookMs >= 900000 && s.bookMs < 901000, s.bookMs);
  check('state: chapter', s.chapterIndex === 1);
  check('state: book fields', s.book === MULTI.key && s.title === MULTI.title && s.author === MULTI.author &&
    s.cover === MULTI.cover && s.bookDurationMs === 1800000 && s.chapters.length === 3);
  check('state: save fields exist for the save loop', s.lastSavedAt === null && s.saveError === false);
  check('state: the saved position', s.position.track === '502' && s.position.duration_ms === 900000 && s.position.offset_ms >= 300000);
  check('opening fetched /api/player/book once', t.net.fetches.length === 1 && t.net.fetches[0] === '/api/player/book/500%3A1');
  t.engine.close();
}

// ---- 4. A network switch (Review Focus 1) ----
current = 'a network switch resumes on the other connection at the same offset';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('502', 300000) });
  await t.clock.advance(10000);
  const before = t.engine.state().position;
  check('playing on local', t.engine.state().connection === 'local' && before.offset_ms >= 309000, before);
  const dropAt = t.clock.now;
  t.net.down.add('local');                    // the phone leaves the home Wi-Fi
  let resumedAt = null;
  let atSwitch = null;
  for (let i = 0; i < 40 && resumedAt === null; i++) {
    await t.clock.advance(100);
    if (sideOf(t.main.src) === 'remote' && atSwitch === null && t.main.readyState >= 1) atSwitch = t.main.currentTime * 1000;
    if (sideOf(t.main.src) === 'remote' && !t.main.paused && t.main.currentTime * 1000 > before.offset_ms) resumedAt = t.clock.now;
  }
  check('it switched to the remote connection', t.engine.state().connection === 'remote');
  check('the same part', partOf(t.main) === MULTI.tracks[1].part_path);
  check('at the same offset', atSwitch !== null && Math.abs(atSwitch - before.offset_ms) <= 250, [atSwitch, before.offset_ms]);
  check('playing again within a few seconds', resumedAt !== null && resumedAt - dropAt <= 3000, resumedAt && resumedAt - dropAt);
  let monotonic = true;
  for (let i = 1; i < t.positions.length; i++) {
    const a = t.positions[i - 1];
    const b = t.positions[i];
    if (a && b && E.toBookMs(MULTI.tracks, b.track, b.offset_ms) < E.toBookMs(MULTI.tracks, a.track, a.offset_ms)) monotonic = false;
  }
  check('the position never went back', monotonic);
  check('no error was shown', t.log.error.length === 0);
  check('a connection change was reported', reasons(t).includes('connection'));
  t.engine.close();
}
current = 'a stalled stream (no error) also switches, at the same offset';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 60000) });
  await t.clock.advance(5000);
  const before = t.engine.state().position;
  t.net.hang.add('local');                     // packets just stop
  await t.clock.advance(E.STALL_MS - 500);
  check('it waits for the stall watchdog', t.engine.state().connection === 'local');
  await t.clock.advance(1000);
  check('then switches to remote', sideOf(t.main.src) === 'remote');
  await t.clock.advance(400);
  check('at the same offset, playing', Math.abs(t.main.currentTime * 1000 - before.offset_ms) <= 600 && !t.main.paused,
    [t.main.currentTime, before.offset_ms]);
  check('the stall did not move the position', t.positions.every((p) => !p || p.track !== '501' || p.offset_ms >= 60000));
  t.engine.close();
}

// ---- 5. Both connections failing ----
current = 'both connections failing: one refresh, then "Can\'t reach the media server" with retry';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 60000) });
  await t.clock.advance(4000);
  const before = t.engine.state().position;
  const mark = t.positions.length;
  t.net.down.add('local');
  t.net.down.add('remote');
  await t.clock.advance(20000);
  const errs = t.log.error;
  check('one error', errs.length === 1, errs.length);
  check('the message', errs[0] && errs[0].message === "Can't reach the media server", errs[0]);
  check('with a retry', errs[0] && errs[0].retry === '[fn]');
  check('exactly one token refresh', t.net.fetches.filter((u) => u.endsWith('?refresh=1')).length === 1, t.net.fetches);
  check('both connections were tried', t.net.loads.some((l) => l.side === 'remote' && !l.probe));
  const s = t.engine.state();
  check('the position is unchanged', s.position.track === before.track && s.position.offset_ms === before.offset_ms, [s.position, before]);
  check('the position never moved while failing', t.positions.slice(mark).every((p) => p.track === before.track && p.offset_ms === before.offset_ms));
  check('not playing', s.playing === false && t.main.paused);
  check('the state holds the error', s.error && s.error.code === 'unreachable' && s.error.message === "Can't reach the media server");
  check('nothing is retried on its own', t.net.loads.length === (await (async () => { const n = t.net.loads.length; await t.clock.advance(30000); return n; })()));
  // The network comes back; Retry resumes at the same place.
  t.net.down.clear();
  t.log.raw.filter(([k]) => k === 'error')[0][1].retry();
  await t.clock.advance(500);
  check('retry plays again', t.engine.state().playing && !t.main.paused && t.engine.state().error === null);
  check('from the same offset', t.main.currentTime * 1000 >= before.offset_ms && t.main.currentTime * 1000 < before.offset_ms + 1000,
    [t.main.currentTime, before.offset_ms]);
  t.engine.close();
}
current = 'a seek while a failure is being handled is where playback resumes';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 60000) });
  t.net.down.add('local');
  t.net.down.add('remote');
  await t.clock.advance(270);                  // the local stream errored; remote is being tried
  t.engine.seek(1000000);                      // part 2 at 400 s
  t.net.down.clear();
  await t.clock.advance(3000);
  const s = t.engine.state();
  check('playing', s.playing && !t.main.paused && t.log.error.length === 0);
  check('at the place sought', s.position.track === '502' && s.position.offset_ms >= 400000 && s.position.offset_ms < 404000, s.position);
  t.engine.close();
}
current = 'a seek while a failed part is being checked is the place kept';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 60000) });
  t.net.missing.add(MULTI.tracks[1].part_path);
  t.net.latency = 1000;                        // a slow server: the check takes a while
  t.engine.seek(700000);                       // part 2 at 100 s; it 404s after 1 s
  await t.clock.advance(1300);                 // its failure is being checked
  t.engine.seek(800000);                       // part 2 at 200 s
  for (let i = 0; i < 1000 && partOf(t.main) !== MULTI.tracks[2].part_path; i++) await t.clock.advance(10);
  const s = t.engine.state();
  check('part 2 is skipped', partOf(t.main) === MULTI.tracks[2].part_path && t.log.warning.length >= 1);
  check('the place kept is the later seek', s.position.track === '502' && s.position.offset_ms === 200000, s.position);
  t.engine.close();
}
current = 'a rotated server token is refreshed once and playback goes on';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 60000) });
  await t.clock.advance(2000);
  const before = t.engine.state().position;
  t.net.token = 'SeCrEt-server-token-0002';    // the old one is refused now
  t.net.down.add('local');                     // and the stream breaks
  await t.clock.advance(300);
  t.net.down.delete('local');
  await t.clock.advance(3000);
  check('refreshed once', t.net.fetches.filter((u) => u.endsWith('?refresh=1')).length === 1);
  check('no error', t.log.error.length === 0);
  check('playing at the same place', t.engine.state().playing && !t.main.paused &&
    t.engine.state().position.offset_ms >= before.offset_ms && t.engine.state().position.offset_ms < before.offset_ms + 4000);
  t.engine.close();
}

// ---- 6. A part that 404s or fails to decode ----
current = 'a part that 404s is skipped with a notice; the place stays until the next part plays';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 595000) });
  t.net.missing.add(MULTI.tracks[1].part_path);
  const mark = t.seen.length;
  await t.clock.advance(6000);                 // part 1 ends; part 2 404s; part 3 starts
  const w = t.log.warning;
  check('a notice', w.length === 1 && w[0].kind === 'part-skipped' && /Part 2 of 3/.test(w[0].message), w);
  check('part 3 is loaded next', partOf(t.main) === MULTI.tracks[2].part_path);
  check('no error for a skipped part', t.log.error.length === 0);
  await t.clock.advance(3000);
  const after = t.seen.slice(mark);
  const P3 = MULTI.tracks[2].part_path;
  // Every change: a place in part 3 only once part 3 has played a second.
  const early = after.filter((r) => r.pos && r.pos.track === '503' && !(r.part === P3 && r.t >= 1));
  check('no place in part 3 before part 3 played', early.length === 0, early.slice(0, 2));
  const held = after.filter((r) => r.part === P3 && r.t < 1);
  check('while part 3 starts, the place is the start of part 2', held.length > 0 &&
    held.every((r) => r.pos.track === '502' && r.pos.offset_ms === 0), held.slice(0, 2));
  check('the playhead shows part 3 meanwhile', t.log.change.some((c) => c.reason === 'part-skipped' && c.state.trackIndex === 2));
  check('once part 3 plays, it is the place', t.engine.state().position.track === '503' && t.engine.state().position.offset_ms >= 1000);
  t.engine.close();
}
// Final review (parked T8L1): the saves are told the place's own book time
// (placeMs), which is the held place's while the playhead runs ahead into
// the part after a skipped one; the moves carry where they went from and to.
current = 'the saves get the place\'s own book time and a move\'s from and to';
{
  const notes = [];
  const saver = { note(c) { notes.push(JSON.parse(JSON.stringify(c))); }, start() {}, stop() {}, onWarning() { return () => {}; }, lastSavedAt: null, warning: false };
  const t = setup({ saver });
  await openPlaying(t, MULTI.key, { at: at('501', 595000) });
  t.net.missing.add(MULTI.tracks[1].part_path);
  await t.clock.advance(6000);                 // part 2 404s and is skipped; part 3 starts
  const skipped = notes.find((c) => c.reason === 'part-skipped');
  check('while part 3 starts: the place is part 2\'s start, its book time too', skipped && skipped.state.position.track === '502' &&
    skipped.placeMs === 600000 && skipped.state.bookMs === 1500000, skipped && [skipped.placeMs, skipped.state.bookMs]);
  await t.clock.advance(3000);
  const last = notes[notes.length - 1];
  check('once part 3 plays: the same as the playhead', last.placeMs === last.state.bookMs && last.state.position.track === '503', last);
  t.engine.skip(-20);
  const sk = notes[notes.length - 1];
  check('a skip carries from and to', sk.reason === 'skip' && sk.to === sk.from - 20000 && sk.placeMs === sk.to, sk);
  t.engine.close();
}

current = 'two failing parts in a row never move the place past the first';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 598000) });
  t.net.missing.add(MULTI.tracks[1].part_path);
  t.net.missing.add(MULTI.tracks[2].part_path);
  await t.clock.advance(15000);
  const s = t.engine.state();
  check('two notices', t.log.warning.length === 2, t.log.warning);
  check('the place stays at the start of part 2', s.position.track === '502' && s.position.offset_ms === 0, s.position);
  check('no change ever reported part 3', t.positions.every((p) => !p || p.track !== '503'));
  check('the last part failing stops with an error and a retry', t.log.error.length === 1 &&
    t.log.error[0].code === 'part' && t.log.error[0].retry === '[fn]');
  check('not ended', t.log.ended.length === 0 && !s.playing);
  t.engine.close();
}
current = 'a part that fails to decode is skipped from where it failed';
{
  const t = setup();
  t.net.decodeAt.set(MULTI.tracks[0].part_path, 30);
  await openPlaying(t, MULTI.key, { at: at('501', 20000) });
  for (let i = 0; i < 1500 && partOf(t.main) !== MULTI.tracks[1].part_path; i++) await t.clock.advance(10);
  const s = t.engine.state();
  check('a notice', t.log.warning.length === 1 && /Part 1 of 3/.test(t.log.warning[0].message));
  check('part 2 loaded', partOf(t.main) === MULTI.tracks[1].part_path);
  check('the place is held where part 1 failed', s.position.track === '501' && Math.abs(s.position.offset_ms - 30000) <= 300, s.position);
  await t.clock.advance(3000);
  const P2 = MULTI.tracks[1].part_path;
  const early = t.seen.filter((r) => r.pos && r.pos.track === '502' && !(r.part === P2 && r.t >= 1));
  check('no place in part 2 before part 2 played', early.length === 0, early.slice(0, 2));
  check('then part 2 is the place', t.engine.state().position.track === '502');
  t.engine.close();
}
current = 'a missing first part on a fresh open is found to be the part, not the server';
{
  // Nothing has loaded yet, so no connection is shown to work: the ladder
  // runs (both connections, a refresh), then another part answers.
  const t = setup();
  t.net.missing.add(MULTI.tracks[0].part_path);
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(6000);
  await p;
  check('a notice for part 1', t.log.warning.length === 1 && /Part 1 of 3/.test(t.log.warning[0].message), t.log.warning);
  check('no error', t.log.error.length === 0, t.log.error);
  check('part 2 plays', partOf(t.main) === MULTI.tracks[1].part_path && !t.main.paused);
  const P2 = MULTI.tracks[1].part_path;
  check('no place in part 2 before it played', t.seen.every((r) => !r.pos || r.pos.track !== '502' || (r.part === P2 && r.t >= 1)));
  t.engine.close();
}
current = 'a single file that fails to decode stops with an error, place kept';
{
  const t = setup();
  t.net.decodeAt.set(SINGLE.tracks[0].part_path, 100);
  await openPlaying(t, SINGLE.key, { at: at('601', 95000) });
  await t.clock.advance(10000);
  const s = t.engine.state();
  check('an error with retry', t.log.error.length === 1 && t.log.error[0].code === 'part' && t.log.error[0].retry === '[fn]', t.log.error);
  check('the place is where it failed', s.position.track === '601' && Math.abs(s.position.offset_ms - 100000) <= 300, s.position);
  check('not ended', t.log.ended.length === 0);
  t.engine.close();
}

// ---- 7. Part advance and the end ----
current = 'end of a part advances to the next part at 0';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 597000) });
  for (let i = 0; i < 400 && partOf(t.main) !== MULTI.tracks[1].part_path; i++) await t.clock.advance(10);
  check('the next part is loaded', partOf(t.main) === MULTI.tracks[1].part_path);
  check('at 0', t.engine.state().position.track === '502' && t.engine.state().position.offset_ms === 0);
  check('reported as a part change', reasons(t).includes('part'));
  check('the element\'s pause at the end is not a pause', !reasons(t).includes('pause') && t.engine.state().playing);
  await t.clock.advance(1500);
  check('the next part plays on', !t.main.paused && t.engine.state().position.offset_ms > 0 && t.engine.state().trackIndex === 1);
  check('book time is continuous', t.engine.state().bookMs > 600000 && t.engine.state().bookMs < 602000);
  t.engine.close();
}
current = 'end of the last part emits ended';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('503', 298000) });
  await t.clock.advance(3000);
  check('ended once', t.log.ended.length === 1);
  const s = t.engine.state();
  check('not playing', !s.playing);
  check('at the end of the book', s.bookMs === 1800000 && s.position.track === '503' && s.position.offset_ms === 300000, s);
  check('the last chapter', s.chapterIndex === 2);
  check('no error', t.log.error.length === 0);
  await t.clock.advance(3000);
  check('ended only once', t.log.ended.length === 1);
  t.engine.close();
}

// ---- 8. Seek, skip, chapter jump, play and pause ----
current = 'seek, skip and chapter jump';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('502', 10000) });
  t.engine.skip(-30);
  await t.clock.advance(400);
  check('skip back across a part boundary loads the previous part', partOf(t.main) === MULTI.tracks[0].part_path);
  check('at 20 s before its end', t.main.currentTime >= 580 && t.main.currentTime < 581, t.main.currentTime);
  const sk = t.log.change.filter((c) => c.reason === 'skip')[0];
  check('reported as a skip with from and to', sk && sk.from >= 610000 && sk.from < 611000 && sk.to === sk.from - 30000, sk);
  t.engine.jumpToChapter(2);
  await t.clock.advance(400);
  const j = t.log.change.filter((c) => c.reason === 'jump')[0];
  check('a chapter jump', j && j.to === 1500000 && partOf(t.main) === MULTI.tracks[2].part_path, j);
  check('the chapter is current', t.engine.state().chapterIndex === 2);
  t.engine.jumpToChapter(9);
  check('an unknown chapter does nothing', t.log.change.filter((c) => c.reason === 'jump').length === 1);
  t.engine.seek(1600000);
  await t.clock.advance(40);
  const sk2 = t.log.change.filter((c) => c.reason === 'seek').pop();
  check('a seek in the same part keeps the file', sk2 && sk2.to === 1600000 && t.main.currentTime === 100);
  check('still playing after moves', t.engine.state().playing && !t.main.paused);
  t.engine.pause();
  check('pause', !t.engine.state().playing && t.main.paused && reasons(t).includes('pause'));
  const n = t.log.change.length;
  t.engine.pause();
  check('a second pause reports nothing', t.log.change.length === n);
  t.engine.toggle();
  await t.clock.advance(300);
  check('toggle plays', t.engine.state().playing && !t.main.paused && reasons(t).includes('play'));
  t.main.pause();                              // the browser or OS paused it
  check('an outside pause is reported', !t.engine.state().playing && reasons(t).filter((r) => r === 'pause').length === 2);
  t.engine.close();
}
current = 'autoplay blocked: open still loads, play() later starts';
{
  const t = setup({ net: { blockAutoplay: true } });
  await openPlaying(t, MULTI.key, { at: at('501', 42000) });
  check('not playing, no error', !t.engine.state().playing && t.log.error.length === 0);
  check('metadata loaded at the place', t.main.currentTime === 42 && t.engine.state().loading === false);
  t.net.blockAutoplay = false;
  t.engine.play();
  await t.clock.advance(600);
  check('plays from the place', !t.main.paused && t.main.currentTime > 42 && t.main.currentTime < 43);
  t.engine.close();
}

// ---- 9. Speed ----
current = 'setSpeed sets playbackRate and clamps';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 596000) });
  const cases = [[1.5, 1.5], [0.5, 0.75], [3, 2], [1.23, 1.25], [0.76, 0.75], [1.975, 2], ['1.1', 1.1]];
  for (const [x, want] of cases) {
    t.engine.setSpeed(x);
    check(`setSpeed(${x})`, t.engine.state().speed === want && t.main.playbackRate === want && t.main.defaultPlaybackRate === want,
      [t.engine.state().speed, t.main.playbackRate]);
  }
  t.engine.setSpeed(NaN);
  check('NaN is ignored', t.engine.state().speed === 1.1);
  t.engine.setSpeed(1.5);
  await t.clock.advance(4000);
  check('the rate survives the next part', partOf(t.main) === MULTI.tracks[1].part_path && t.main.playbackRate === 1.5);
  check('a speed change is reported', reasons(t).includes('speed'));
  t.engine.close();
}

// ---- 10. Media Session ----
current = 'Media Session metadata and action handlers';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('502', 100000) });
  const md = t.ms.metadata;
  check('title, author, series', md && md.title === MULTI.title && md.artist === MULTI.author && md.album === MULTI.series, md);
  check('artwork is the cover, absolute', md && md.artwork && md.artwork[0] && md.artwork[0].src === 'https://ws.test/api/player/cover/500:1?v=77', md && md.artwork);
  for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']) {
    check(`handler ${a}`, typeof t.ms.handlers.get(a) === 'function');
  }
  for (const a of ['previoustrack', 'nexttrack']) {
    check(`no ${a} (chapters are not skip buttons)`, t.ms.handlers.has(a) && t.ms.handlers.get(a) === null);
  }
  check('playing state', t.ms.playbackState === 'playing');
  const pos = t.ms.positions[t.ms.positions.length - 1];
  check('position state in book seconds', pos && pos.duration === 1800 && pos.playbackRate === 1 && pos.position >= 700 && pos.position < 702, pos);
  const b0 = t.engine.state().bookMs;
  t.ms.handlers.get('seekbackward')({ action: 'seekbackward' });
  check('seek back by the skip length (10 s)', t.engine.state().bookMs === b0 - 10000, [b0, t.engine.state().bookMs]);
  t.ms.handlers.get('seekforward')({ action: 'seekforward', seekOffset: 30 });
  check('seek forward by the offset given', t.engine.state().bookMs === b0 + 20000);
  t.ms.handlers.get('seekto')({ action: 'seekto', seekTime: 1000 });
  await t.clock.advance(400);
  check('seek to book time', t.engine.state().bookMs >= 1000000 && t.engine.state().bookMs < 1001000 && partOf(t.main) === MULTI.tracks[1].part_path);
  t.ms.handlers.get('pause')({ action: 'pause' });
  check('pause', !t.engine.state().playing && t.ms.playbackState === 'paused');
  t.ms.handlers.get('play')({ action: 'play' });
  check('play', t.engine.state().playing && t.ms.playbackState === 'playing');
  t.engine.close();
  check('closing clears the metadata', t.ms.metadata === null);
}

// ---- 11. Opening errors ----
current = 'opening errors';
{
  const t = setup({ net: { bookStatus: 403, bookDetail: "Your account doesn't have access to the audiobook library" } });
  await t.engine.open(MULTI.key);
  await t.clock.advance(100);
  check('403: the server\'s plain message', t.log.error[0] && t.log.error[0].code === 'forbidden' &&
    t.log.error[0].message === "Your account doesn't have access to the audiobook library" && t.log.error[0].retry === null, t.log.error);
  check('403: the state holds it', t.engine.state().error && t.engine.state().error.code === 'forbidden' && t.engine.state().book === null);
  t.net.bookStatus = 503;
  await t.engine.open(MULTI.key);
  const e = t.log.raw.filter(([k]) => k === 'error').pop()[1];
  check('503: can\'t reach, with retry', e.code === 'unreachable' && e.message === "Can't reach the media server" && typeof e.retry === 'function');
  t.net.bookStatus = 200;
  e.retry();
  await t.clock.advance(500);
  check('retry opens the book', t.engine.state().book === MULTI.key && t.engine.state().playing && t.engine.state().error === null);
  t.net.bookStatus = 404;
  await t.engine.open('999:1');
  check('404: not available, no retry', t.log.error.pop().code === 'not-found');
  t.engine.close();
}

// ---- 12. The token stays in memory ----
current = 'the server token never leaves the engine';
{
  const t = setup();
  t.net.hang.add('local');                     // exercise a probe that times out
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(2000);
  await p;
  t.net.hang.clear();
  t.net.down.add('remote');
  t.net.down.add('local');
  await t.clock.advance(20000);                // the whole failure ladder and its error
  const everything = [asJson(t.engine.state()), ...t.log.raw.map(([k, d]) => asJson(d))].join('\n');
  check('not in state() or any event', everything.indexOf(TOKEN) === -1);
  check('not in any console output of any case so far', consoleSeen.every((l) => l.indexOf(TOKEN) === -1 && l.indexOf('SeCrEt') === -1), consoleSeen.length);
  check('probes hold no URL', t.probes().every((a) => a.src === ''));
  check('only the player element was put in the page', t.host.children.length === 1);
  t.engine.close();
  check('closing removes the src', t.main.src === '' && t.engine.state().book === null);
}

// ---- 13. The engine owns its timers ----
current = 'close() leaves no timer or probe behind';
{
  const t = setup({ net: { hang: new Set(['local']) } });
  t.engine.open(MULTI.key);
  await t.clock.advance(500);                  // mid-probe
  check('a probe is running', t.probes().length === 1 && t.probes()[0].src !== '');
  t.engine.close();
  check('no engine timer is left', t.live.size === 0, t.live.size);
  check('the probe is torn down', t.probes()[0].src === '');
  await t.clock.advance(5000);
  check('nothing loads after close', t.main.src === '' && t.engine.state().book === null);
  const u = t.engine.on('change', () => {});
  check('on() returns an unsubscribe', typeof u === 'function');
  u();
}

// ---- 15. Fix round 1 ----

// T5E1: in the error state the place is frozen; Retry resumes exactly there.
// Remote only (Chrome's default behind the local-network gate).
for (const [name, key, place] of [['single file at 10:02', SINGLE.key, at('601', 602000)],
                                  ['part 2 at 5:09', MULTI.key, at('502', 309000)]]) {
  current = `the error state holds the place, and Retry resumes there (${name})`;
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, key, { at: place });
  await t.clock.advance(3000);
  const held = t.engine.state().position;
  const mark = t.seen.length;
  t.net.down.add('remote');                    // the stream drops
  t.net.bookStatus = 503;                      // and the refresh fails
  await t.clock.advance(15000);
  check('the error state', t.engine.state().error && t.engine.state().error.code === 'unreachable');
  const after = t.seen.slice(mark);
  const moved = after.filter((r) => !r.pos || r.pos.track !== held.track || r.pos.offset_ms !== held.offset_ms);
  check('no change carries another place', moved.length === 0, moved.slice(0, 3).map((r) => [r.reason, r.pos]));
  const inError = after.filter((r) => r.reason === 'error' || t.engine.state().error);
  check('the error change itself carries the place', inError.length > 0 && inError.every((r) => r.pos.offset_ms === held.offset_ms));
  check('the place is unchanged', JSON.stringify(t.engine.state().position) === JSON.stringify(held), [t.engine.state().position, held]);
  t.net.down.clear();
  t.net.bookStatus = 200;
  t.engine.retry();
  let landed = null;
  for (let i = 0; i < 100 && landed === null; i++) {
    await t.clock.advance(10);
    if (t.main.readyState >= 1 && !t.main.seeking) landed = Math.round(t.main.currentTime * 1000);
  }
  check('Retry lands on the exact held offset', landed === held.offset_ms, [landed, held.offset_ms]);
  await t.clock.advance(1000);
  check('and plays on from there', t.engine.state().playing && !t.main.paused &&
    t.engine.state().position.track === held.track && t.engine.state().position.offset_ms > held.offset_ms);
  t.engine.close();
}

// T5E2: a dropped connection never skips a part (the Chrome case).
current = 'a stalled stream whose refresh fails holds the place; it never skips';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MULTI.key, { at: at('502', 309000) });
  await t.clock.advance(2000);
  const before = t.engine.state().position;
  t.net.hang.add('remote');                    // the connection dies mid-stream
  t.net.bookStatus = 503;                      // the refresh gets a 503
  await t.clock.advance(2000);
  t.net.hang.delete('remote');                 // new requests are answered again; the old one stays dead
  await t.clock.advance(15000);
  check('no part is skipped', t.log.warning.length === 0, t.log.warning);
  check('the error state with a retry', t.log.error.length === 1 && t.log.error[0].code === 'unreachable' && t.log.error[0].retry === '[fn]');
  const s = t.engine.state();
  check('the place is held in part 2', s.position.track === '502' && Math.abs(s.position.offset_ms - before.offset_ms) <= 2500, [s.position, before]);
  check('never a place in part 3', t.seen.every((r) => !r.pos || r.pos.track !== '503'));
  check('part 3 was never loaded to play', t.net.loads.every((l) => l.probe || l.part !== MULTI.tracks[2].part_path));
  t.engine.close();
}
current = 'a genuinely broken part is still skipped (remote only)';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MULTI.key, { at: at('501', 597000) });
  t.net.missing.add(MULTI.tracks[1].part_path);
  await t.clock.advance(8000);
  check('skipped with a notice', t.log.warning.length === 1 && /Part 2 of 3/.test(t.log.warning[0].message));
  check('part 2 was tried twice before the skip', t.net.loads.filter((l) => !l.probe && l.part === MULTI.tracks[1].part_path).length >= 2);
  check('part 3 plays', partOf(t.main) === MULTI.tracks[2].part_path && !t.main.paused && t.log.error.length === 0);
  t.engine.close();
}
current = 'a part that fails once and then plays is not skipped';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 597000) });
  t.net.missing.add(MULTI.tracks[1].part_path);
  // Part 2 fails once; while the connection is being checked, it comes back.
  const P2 = MULTI.tracks[1].part_path;
  for (let i = 0; i < 600; i++) {
    await t.clock.advance(10);
    const k = t.net.loads.findIndex((l) => !l.probe && l.part === P2);
    if (k !== -1 && t.net.loads.slice(k + 1).some((l) => l.probe)) break;
  }
  t.net.missing.clear();
  await t.clock.advance(3000);
  check('no notice', t.log.warning.length === 0, t.log.warning);
  check('part 2 plays', partOf(t.main) === MULTI.tracks[1].part_path && !t.main.paused && t.engine.state().position.track === '502');
  t.engine.close();
}

// T5E3: a place in a part the book does not have.
current = 'open() at an unknown track rejects with UnknownTrack and loads nothing';
{
  const t = setup();
  check('UnknownTrack is exported', typeof E.UnknownTrack === 'function');
  let err = null;
  const p = t.engine.open(MULTI.key, { at: at('999', 5000) }).catch((e) => { err = e; });
  await t.clock.advance(2000);
  await p;
  check('it rejects with UnknownTrack', typeof E.UnknownTrack === 'function' && err instanceof E.UnknownTrack && err.name === 'UnknownTrack' && err.track === '999', err && err.name);
  check('nothing was loaded or probed', t.net.loads.length === 0 && t.main.src === '' && t.probes().length === 0);
  check('no place was ever reported', t.seen.every((r) => r.pos === null));
  check('no open, play or error event', !reasons(t).some((r) => r === 'open' || r === 'play' || r === 'ready') && t.log.error.length === 0, reasons(t));
  check('the state has no book', t.engine.state().book === null && t.engine.state().position === null && !t.engine.state().loading);
  check('the message carries no token', String(err && err.message).indexOf(TOKEN) === -1);
  t.engine.close();
}

// T5E4: the Media Session seek length.
current = 'setSkip sets the Media Session seek length, 5 to 60 s';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('502', 300000) });
  if (typeof t.engine.setSkip !== 'function') t.engine.setSkip = () => NaN;   // (an engine without it fails, not crashes)
  check('setSkip(30)', t.engine.setSkip(30) === 30);
  const b0 = t.engine.state().bookMs;
  t.ms.handlers.get('seekbackward')({ action: 'seekbackward' });
  check('seek back uses it', t.engine.state().bookMs === b0 - 30000, t.engine.state().bookMs - b0);
  t.ms.handlers.get('seekforward')({ action: 'seekforward' });
  check('seek forward uses it', t.engine.state().bookMs === b0);
  check('clamped to 5', t.engine.setSkip(2) === 5);
  check('clamped to 60', t.engine.setSkip(100) === 60);
  check('rounded', t.engine.setSkip(14.6) === 15);
  check('NaN ignored', t.engine.setSkip(NaN) === 15 && t.engine.setSkip('x') === 15);
  t.ms.handlers.get('seekforward')({ action: 'seekforward' });
  check('the handler reads the current value', t.engine.state().bookMs === b0 + 15000);
  t.engine.close();
}

// Task 8: the listener's settings reach the engine with one 'prefs' change
// (so the view follows while paused); the fade's volume; the parts in book
// time with what can play.
current = 'prefs changes, applyPrefs, setVolume and parts()';
{
  const t = setup();
  await openPlaying(t, MIXED.key, { at: at('901', 1000) });
  t.engine.pause();
  const n = t.log.change.length;
  t.engine.setSkip(25);
  check('a new skip length is one prefs change', t.log.change.length === n + 1 && t.log.change[n].reason === 'prefs' &&
    t.log.change[n].state.playing === false, t.log.change.slice(n).map((c) => c.reason));
  t.engine.setSkip(25);
  t.engine.setSkip();
  t.engine.setSkip('40');
  check('the same, a read or a string: none', t.log.change.length === n + 1);
  const got = t.engine.applyPrefs({ skip: 45, speed: 1.35 });
  check('applyPrefs sets both', got.skip === 45 && got.speed === 1.35 && t.engine.setSkip() === 45 && t.engine.state().speed === 1.35);
  check('then one prefs change', t.log.change.length === n + 2 && t.log.change[n + 1].reason === 'prefs');
  check('the element plays at it', t.main.playbackRate === 1.35 && t.main.defaultPlaybackRate === 1.35);
  t.engine.applyPrefs({ skip: null, speed: null });
  t.engine.applyPrefs({ speed: '2' });
  check('only numbers change them', t.engine.setSkip() === 45 && t.engine.state().speed === 1.35, [t.engine.setSkip(), t.engine.state().speed]);
  check('setVolume clamps', t.engine.setVolume(0.4) === 0.4 && t.main.volume === 0.4 && t.engine.setVolume(-1) === 0 && t.engine.setVolume(3) === 1);
  check('setVolume() only reads', t.engine.setVolume() === 1 && t.engine.setVolume(NaN) === 1);
  const parts = t.engine.parts();
  check('parts() in book time', JSON.stringify(parts) === JSON.stringify([
    { start_ms: 0, duration_ms: 600000, playable: true },
    { start_ms: 600000, duration_ms: 900000, playable: false },
    { start_ms: 1500000, duration_ms: 300000, playable: true }
  ]), parts);
  t.engine.close();
  check('no book, no parts', t.engine.parts().length === 0);
}

// T5E5: a failed open clears the lock screen.
current = 'a failed open of another book clears the Media Session';
{
  const t = setup();
  await openPlaying(t, MULTI.key);
  check('A shows', t.ms.metadata && t.ms.metadata.title === MULTI.title && t.ms.playbackState === 'playing');
  t.net.bookStatus = 503;
  await t.engine.open(OTHER.key);
  await t.clock.advance(100);
  check('metadata cleared', t.ms.metadata === null);
  check('playbackState none', t.ms.playbackState === 'none');
  check('A stopped', t.main.paused && t.main.src === '');
  t.engine.close();
}

// T5T1: the rate after a part advance and after a connection switch, in
// Chrome (the rate resets to 1.0 with a new src) and in Safari (setting it
// before metadata throws).
for (const safari of [false, true]) {
  current = `the speed holds across a part advance and a connection switch (${safari ? 'Safari' : 'Chrome'})`;
  const t = setup({ net: { safari } });
  await openPlaying(t, MULTI.key, { at: at('501', 597000) });
  t.engine.setSpeed(1.5);
  check('set', t.main.playbackRate === 1.5);
  let atSwitch = null;
  const off = t.engine.on('change', (d) => { if (d.reason === 'part') atSwitch = t.main.playbackRate; });
  for (let i = 0; i < 400 && partOf(t.main) !== MULTI.tracks[1].part_path; i++) await t.clock.advance(10);
  off();
  if (!safari) check('the new part is at 1.5 the moment its src is set', atSwitch === 1.5, atSwitch);
  await t.clock.advance(200);
  check('the next part plays at 1.5', partOf(t.main) === MULTI.tracks[1].part_path && t.main.readyState >= 1 && t.main.playbackRate === 1.5, t.main.playbackRate);
  t.net.down.add('local');
  for (let i = 0; i < 300 && sideOf(t.main.src) !== 'remote'; i++) await t.clock.advance(10);
  await t.clock.advance(200);
  check('after switching to remote it plays at 1.5', sideOf(t.main.src) === 'remote' && !t.main.paused && t.main.playbackRate === 1.5, t.main.playbackRate);
  check('no error from the rate', t.log.error.length === 0);
  t.engine.close();
}

// T5T2: two opens at once; the later one wins.
current = 'a slow open(A) then a fast open(B): B wins';
{
  const t = setup();
  t.net.fetchDelay[MULTI.key] = 1000;
  const pa = t.engine.open(MULTI.key);
  await t.clock.advance(100);
  const pb = t.engine.open(OTHER.key);
  await t.clock.advance(2000);
  await pa;
  await pb;
  const s = t.engine.state();
  check('B is the book', s.book === OTHER.key && s.title === OTHER.title);
  check('B plays', partOf(t.main) === OTHER.tracks[0].part_path && !t.main.paused);
  check('nothing of A was ever loaded', t.net.loads.every((l) => !MULTI.tracks.some((tr) => tr.part_path === l.part)));
  check('no open event for A', t.log.change.filter((c) => c.reason === 'open').every((c) => c.state.book === OTHER.key));
  t.engine.close();
}
current = 'a slow open(A) that fails after a fast open(B) leaves B alone';
{
  const t = setup();
  t.net.fetchDelay[MULTI.key] = 1000;
  t.net.statusFor[MULTI.key] = 503;
  const pa = t.engine.open(MULTI.key);
  await t.clock.advance(100);
  const pb = t.engine.open(OTHER.key);
  await t.clock.advance(2000);
  await pa;
  await pb;
  const s = t.engine.state();
  check('no error from A', t.log.error.length === 0 && s.error === null, t.log.error);
  check('B plays', s.book === OTHER.key && s.playing && !t.main.paused);
  t.engine.close();
}

// ---- 16. Fix round 2 ----

// T5E6: an outage just as a part ends. The next part fails like a media
// error; a check of the finished part must ask the server, not the cache.
current = 'an outage at the end of a part ends unreachable, holding the place, skipping nothing';
{
  const t = setup({ net: { mediaCache: true, noLocal: true } });
  await openPlaying(t, MULTI.key, { at: at('501', 598000) });
  // Plex (and the refresh) go away just as part 1 ends: its last data is in.
  t.main.addEventListener('pause', () => {
    if (!t.main.ended) return;
    t.net.down.add('remote');
    t.net.bookStatus = 503;
  });
  await t.clock.advance(20000);
  check('nothing skipped', t.log.warning.length === 0, t.log.warning);
  check('unreachable, with a retry', t.log.error.length === 1 && t.log.error[0].code === 'unreachable' && t.log.error[0].retry === '[fn]');
  const s = t.engine.state();
  check('the place is the start of part 2', s.position.track === '502' && s.position.offset_ms === 0, s.position);
  check('never a place in part 3', t.seen.every((r) => !r.pos || r.pos.track !== '503'));
  const probeUrls = t.env.audios.filter((a) => a !== t.main).length;
  check('the checks ran', probeUrls >= 1, probeUrls);
  t.net.down.clear();
  t.net.bookStatus = 200;
  t.engine.retry();
  await t.clock.advance(1500);
  check('Retry plays part 2 from 0', partOf(t.main) === MULTI.tracks[1].part_path && !t.main.paused &&
    t.engine.state().position.track === '502' && t.engine.state().position.offset_ms < 2000, t.engine.state().position);
  t.engine.close();
}
current = 'every probe asks with a URL of its own';
{
  const t = setup({ net: { mediaCache: true } });
  await openPlaying(t, MULTI.key, { at: at('501', 590000) });
  t.net.missing.add(MULTI.tracks[1].part_path); // part 2 fails twice: probes of part 1 on the way
  await t.clock.advance(15000);
  const probes = t.net.loads.filter((l) => l.probe).map((l) => l.url);
  const mains = new Set(t.net.loads.filter((l) => !l.probe).map((l) => l.url));
  check('probes ran', probes.length >= 2, probes.length);
  check('no two probes share a URL', new Set(probes).size === probes.length);
  check('no probe reuses a URL the player loaded', probes.every((u) => !mains.has(u)));
  check('probe URLs carry the part and the token', probes.every((u) => u.indexOf('/library/parts/') !== -1 && u.indexOf(TOKEN) !== -1));
  t.engine.close();
}

// T5E7: Retry after the last part failed resumes at the held place.
current = 'Retry after two skipped parts resumes at the held place';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 598000) });
  t.net.missing.add(MULTI.tracks[1].part_path);
  t.net.missing.add(MULTI.tracks[2].part_path);
  await t.clock.advance(15000);
  check('two parts skipped, then the part error', t.log.warning.length === 2 && t.log.error.length === 1 && t.log.error[0].code === 'part');
  const held = t.engine.state().position;
  check('held at the start of part 2', held.track === '502' && held.offset_ms === 0, held);
  t.net.missing.clear();
  t.engine.retry();
  await t.clock.advance(300);
  check('Retry loads part 2', partOf(t.main) === MULTI.tracks[1].part_path, partOf(t.main));
  check('at its start', t.main.currentTime < 0.5 && t.engine.state().position.track === '502', [t.main.currentTime, t.engine.state().position]);
  t.engine.close();
}

// T5E8: Retry after a failed first fetch, into a place the book lacks.
current = 'Retry of a failed open at an unknown track rejects like open() and ends idle';
{
  const t = setup({ net: { bookStatus: 503 } });
  await t.engine.open(MULTI.key, { at: at('999', 5000) });
  const e = t.log.raw.filter(([k]) => k === 'error').pop();
  check('the fetch failed with a retry', e && e[1].code === 'unreachable' && typeof e[1].retry === 'function');
  t.net.bookStatus = 200;
  const mark = t.log.change.length;
  let err = null;
  await e[1].retry().catch((x) => { err = x; });
  check('error.retry() rejects with UnknownTrack', typeof E.UnknownTrack === 'function' && err instanceof E.UnknownTrack, err && err.name);
  let s = t.engine.state();
  check('not loading, no book, no place', s.loading === false && s.book === null && s.position === null, s);
  const after = t.log.change.slice(mark).map((c) => c.reason);
  check('loading, then its end', JSON.stringify(after) === '["loading","close"]', after);
  const last = t.log.change[t.log.change.length - 1];
  check('the last change says not loading, no book, no place', last && last.state.loading === false &&
    last.state.book === null && last.state.position === null, last && last.state);
  check('nothing loaded', t.net.loads.length === 0);
  // The same through retry() itself.
  t.net.bookStatus = 503;
  await t.engine.open(MULTI.key, { at: at('999', 5000) });
  t.net.bookStatus = 200;
  let err2 = null;
  await t.engine.retry().catch((x) => { err2 = x; });
  s = t.engine.state();
  check('retry() rejects with UnknownTrack', typeof E.UnknownTrack === 'function' && err2 instanceof E.UnknownTrack);
  check('and ends idle', s.loading === false && s.book === null && s.error === null, s);
  const last2 = t.log.change[t.log.change.length - 1];
  check('listeners see it end', last2 && last2.reason === 'close' && last2.state.loading === false);
  t.engine.close();
}

// T5E9: setSkip takes finite numbers only.
current = 'setSkip ignores anything that is not a finite number';
{
  const t = setup();
  await openPlaying(t, MULTI.key);
  if (typeof t.engine.setSkip !== 'function') t.engine.setSkip = () => NaN;
  t.engine.setSkip(20);
  for (const bad of [null, '', false, true, '30', undefined, Infinity, -Infinity, NaN, {}, []]) {
    check(`setSkip(${JSON.stringify(bad)}) keeps 20`, t.engine.setSkip(bad) === 20);
  }
  check('a number still sets it', t.engine.setSkip(7) === 7 && t.engine.setSkip(-3) === 5 && t.engine.setSkip(99) === 60);
  t.engine.close();
}

// T5T3: a part that recovered and played on is not held against it.
current = 'a one-off glitch 60 s after a good retry does not skip the part';
{
  const t = setup();
  await openPlaying(t, MULTI.key, { at: at('501', 597000) });
  const P2 = MULTI.tracks[1].part_path;
  t.net.missing.add(P2);
  for (let i = 0; i < 600; i++) {               // part 2 fails once, and comes back for its retry
    await t.clock.advance(10);
    const k = t.net.loads.findIndex((l) => !l.probe && l.part === P2);
    if (k !== -1 && t.net.loads.slice(k + 1).some((l) => l.probe)) break;
  }
  t.net.missing.clear();
  await t.clock.advance(3000);
  check('part 2 plays after its retry', partOf(t.main) === P2 && !t.main.paused && t.log.warning.length === 0);
  const now = t.main.currentTime;
  t.net.glitchOnce.set(P2, now + 60);           // one bad frame a minute later
  await t.clock.advance(65000);
  check('no skip for the one-off glitch', t.log.warning.length === 0, t.log.warning);
  check('part 2 plays on past it', partOf(t.main) === P2 && !t.main.paused && t.main.currentTime > now + 60, t.main.currentTime);
  t.engine.close();
}

// ---- 17. Formats the browser cannot decode (spec 11a): direct play only ----

const ATMOS_PATH = ATMOS.tracks[0].part_path;
const loadsOf = (t, path) => t.net.loads.filter((l) => l.part === path);

current = 'the MIME type for canPlayType';
{
  const cases = [
    [['mp3', 'mp3', ''], 'audio/mpeg'],
    [['mp4', 'aac', 'lc'], 'audio/mp4; codecs="mp4a.40.2"'],
    [['m4b', 'aac', ''], 'audio/mp4; codecs="mp4a.40.2"'],
    [['mp4', 'aac', 'he-aac'], 'audio/mp4; codecs="mp4a.40.5"'],
    [['mp4', 'eac3', 'dolby digital plus + dolby atmos'], 'audio/mp4; codecs="ec-3"'],
    [['mp4', 'ac3', ''], 'audio/mp4; codecs="ac-3"'],
    [['flac', 'flac', ''], 'audio/flac'],
    [['ogg', 'opus', ''], 'audio/ogg; codecs="opus"'],
    [['mp4', 'dts', ''], ''],          // an unknown codec: played direct
    [['mp4', '', ''], ''],             // Plex said nothing
    [['', '', ''], ''],
    [[undefined, null, undefined], '']
  ];
  check('mimeFor is exported', typeof E.mimeFor === 'function');
  for (const [args, want] of cases) {
    const got = typeof E.mimeFor === 'function' ? E.mimeFor(...args) : null;
    check(`mimeFor(${JSON.stringify(args)})`, got === want, got);
  }
}

current = 'mp3, aac/lc, and an unknown or empty codec play direct';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key);                      // part 1: mp3
  check('mp3 plays its file', partOf(t.main) === MIXED.tracks[0].part_path && !t.main.paused && t.log.error.length === 0);
  check('the browser was asked about every part', ['audio/mpeg', 'audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="mp4a.40.2"']
    .every((m) => t.net.canPlayAsked.includes(m)), t.net.canPlayAsked);
  t.engine.close();
  const u = setup({ net: { noLocal: true } });
  await openPlaying(u, MIXED.key, { at: at('903', 1000) }); // part 3: aac/lc
  check('aac/lc plays its file', partOf(u.main) === MIXED.tracks[2].part_path && !u.main.paused);
  u.engine.close();
  for (const fmt of [{ container: 'mp4', codec: 'dts', profile: '' }, { container: 'mp4', codec: '', profile: '' },
    { container: '', codec: '', profile: '' }]) {
    const v = setup({ net: { noLocal: true } });
    const odd = JSON.parse(JSON.stringify(SINGLE));
    Object.assign(odd.tracks[0], fmt);
    BOOKS['650:1'] = Object.assign(odd, { key: '650:1' });
    await openPlaying(v, '650:1');
    check(`${JSON.stringify(fmt)} plays direct`, partOf(v.main) === SINGLE.tracks[0].part_path && !v.main.paused &&
      v.log.error.length === 0, partOf(v.main));
    v.engine.close();
    delete BOOKS['650:1'];
  }
}

current = 'an undecodable book: the format message, nothing loaded or probed, the place untouched';
{
  for (const perm of [undefined, { query: async () => ({ state: 'granted' }) }]) {
    const t = setup({ permissions: perm });
    await openPlaying(t, ATMOS.key, { at: at('801', 36000000) });
    await t.clock.advance(5000);
    const s = t.engine.state();
    check('the format message, code format', s.error && s.error.code === 'format' && s.error.message === E.FORMAT_UNSUPPORTED &&
      E.FORMAT_UNSUPPORTED === "This book's audio format can't play in this browser", s.error);
    check('no Retry (trying again cannot help)', t.log.error.length === 1 && t.log.raw.find((r) => r[0] === 'error')[1].retry === null);
    check('never the network message', !t.log.error.some((e) => e.code === 'unreachable'));
    check('nothing loaded and nothing probed', t.net.loads.length === 0 && t.probes().length === 0, t.net.loads);
    check('the place is where it was', s.position && s.position.track === '801' && s.position.offset_ms === 36000000 &&
      t.positions.every((p) => !p || p.offset_ms === 36000000), s.position);
    check('not playing, not loading', !s.playing && !s.loading);
    check('the only fetch is the book', t.net.fetches.length === 1, t.net.fetches);
    // Play (and retry) again: still nothing loaded.
    await t.engine.play();
    await t.engine.retry();
    await t.clock.advance(3000);
    check('play and retry load nothing', t.net.loads.length === 0 && t.engine.state().error.code === 'format');
    t.engine.close();
    check('close leaves no timer', t.live.size === 0, t.live.size);
  }
}

current = 'a mixed book stops where an undecodable part begins, and never passes over it';
{
  // Played up to the end of part 1: stop at the end of part 1.
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key, { at: at('901', 598000) });
  await t.clock.advance(5000);
  const s = t.engine.state();
  check('the format message at the end of part 1', s.error && s.error.code === 'format' &&
    s.position.track === '901' && s.position.offset_ms === 600000, [s.error, s.position]);
  check('part 2 never loaded or probed, part 3 never loaded', loadsOf(t, MIXED.tracks[1].part_path).length === 0 &&
    loadsOf(t, MIXED.tracks[2].part_path).length === 0, t.net.loads.map((l) => l.part));
  check('no skip notice, no advance', t.log.warning.length === 0 && !reasons(t).includes('part') && !reasons(t).includes('part-skipped'));
  check('never a place in part 2 or 3', t.positions.every((p) => !p || p.track === '901'));
  await t.engine.play();                               // pressing play again
  await t.clock.advance(3000);
  check('play again: still stopped there, part 2 never loaded', t.engine.state().error && t.engine.state().error.code === 'format' &&
    loadsOf(t, MIXED.tracks[1].part_path).length === 0 && t.engine.state().position.track === '901');
  // The listener can choose to go on to part 3 themselves.
  t.engine.seek(1500000 + 1000);
  await t.engine.play();
  await t.clock.advance(1000);
  check('an explicit move to part 3 plays it', partOf(t.main) === MIXED.tracks[2].part_path && !t.main.paused &&
    t.engine.state().error === null, partOf(t.main));
  t.engine.close();
}

current = 'a seek or chapter jump into an undecodable part is refused; playback goes on';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key, { at: at('901', 100000) });
  await t.clock.advance(2000);
  const before = t.engine.state().position.offset_ms;
  t.engine.seek(700000);                              // into part 2
  let s = t.engine.state();
  const w = t.log.warning[t.log.warning.length - 1];
  check('seek: a passing notice, no error', w && w.kind === 'part-format' && w.message === E.PART_FORMAT &&
    E.PART_FORMAT === "This part's format can't play in this browser" && s.error === null && t.log.error.length === 0, [w, s.error]);
  check('still playing part 1 from where it was', s.playing && !t.main.paused && partOf(t.main) === MIXED.tracks[0].part_path &&
    s.position.track === '901' && Math.abs(s.position.offset_ms - before) <= 250, s.position);
  check('no seek change reported', !reasons(t).includes('seek'));
  t.engine.jumpToChapter(1);                          // Part 2 of 3
  s = t.engine.state();
  check('jump: refused the same way', t.log.warning.filter((x) => x.kind === 'part-format').length === 2 && s.error === null &&
    s.playing && !reasons(t).includes('jump'));
  await t.clock.advance(5000);
  check('playback carries on in part 1', t.engine.state().position.track === '901' && t.engine.state().position.offset_ms > before + 4000);
  check('part 2 never loaded or probed', loadsOf(t, MIXED.tracks[1].part_path).length === 0);
  t.engine.close();
}

current = 'a chapter tap into an undecodable part during the opening probe is refused; part 1 plays';
{
  const t = setup({ permissions: { query: async () => ({ state: 'granted' }) }, net: { hang: new Set(['local']) } });
  const p = t.engine.open(MIXED.key, { at: at('901', 100000) });
  await t.clock.advance(500);                          // the local probe is in flight
  t.engine.jumpToChapter(1);
  await t.clock.advance(3000);
  await p;
  const s = t.engine.state();
  check('refused with the notice, no error', t.log.warning.some((w) => w.kind === 'part-format') && s.error === null, s.error);
  check('part 1 plays on the remote side', s.playing && !t.main.paused && partOf(t.main) === MIXED.tracks[0].part_path &&
    s.connection === 'remote' && s.position.offset_ms > 100000, s.position);
  t.engine.close();
}

current = 'a chapter tap into an undecodable part during the failure ladder is refused; the ladder recovers';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key, { at: at('901', 100000) });
  await t.clock.advance(2000);
  const held = t.engine.state().position.offset_ms;
  t.net.fetchDelay[MIXED.key] = 3000;                  // the refresh takes a while
  t.net.down.add('remote');
  await t.clock.advance(400);                          // the stream drops; the ladder waits on the refresh
  t.net.down.delete('remote');
  t.engine.jumpToChapter(1);
  await t.clock.advance(6000);
  const s = t.engine.state();
  check('refused, and the ladder brought part 1 back', t.log.warning.some((w) => w.kind === 'part-format') && s.error === null &&
    s.playing && !t.main.paused && partOf(t.main) === MIXED.tracks[0].part_path, [s.error, partOf(t.main)]);
  check('from the held place, never part 2', s.position.track === '901' && s.position.offset_ms >= held &&
    loadsOf(t, MIXED.tracks[1].part_path).length === 0, s.position);
  delete t.net.fetchDelay[MIXED.key];
  t.engine.close();
}

current = 'reaching an undecodable part while ladder steps are pending: nothing loads after';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key, { at: at('901', 597000) });
  t.net.fetchDelay[MIXED.key] = 5000;
  t.net.hang.add('remote');                            // the stream stalls: the ladder starts, waiting on the refresh
  await t.clock.advance(E.STALL_MS + 500);
  const loadsBefore = t.net.loads.length;
  // Part 1's audio ends meanwhile, and part 2 is undecodable.
  t.main.ended = true;
  t.main.fire('ended');
  const s = t.engine.state();
  check('the format message at the end of part 1', s.error && s.error.code === 'format' && s.position.track === '901' &&
    s.position.offset_ms === 600000, [s.error, s.position]);
  t.net.hang.delete('remote');
  await t.clock.advance(15000);
  check('the pending refresh loads nothing afterwards', t.net.loads.length === loadsBefore && !t.main.src &&
    t.engine.state().error && t.engine.state().error.code === 'format', t.net.loads.slice(loadsBefore));
  check('nothing plays under the message', t.main.paused && !t.engine.state().playing);
  delete t.net.fetchDelay[MIXED.key];
  t.engine.close();
}

current = 'play at the end of a book whose first part is undecodable: the format message, part 1 never loaded';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, FIRSTBAD.key, { at: at('923', 297000) });
  await t.clock.advance(5000);
  check('the book ended', t.log.ended.length === 1);
  await t.engine.play();
  await t.clock.advance(3000);
  const s = t.engine.state();
  check('the format message, no skip notice', s.error && s.error.code === 'format' && t.log.warning.length === 0, [s.error, t.log.warning]);
  check('part 1 never loaded, part 2 not played', loadsOf(t, FIRSTBAD.tracks[0].part_path).length === 0 &&
    partOf(t.main) !== FIRSTBAD.tracks[1].part_path, partOf(t.main));
  check('the place stays at the end', s.position.track === '923' && s.position.offset_ms === 300000, s.position);
  t.engine.close();
}

current = 'play and retry check the format first (no connection is not the message)';
{
  const t = setup({ net: { noLocal: true, noRemote: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 36000000) });
  await t.engine.play();
  await t.engine.retry();
  await t.clock.advance(2000);
  check('still the format message, never unreachable', t.engine.state().error.code === 'format' &&
    !t.log.error.some((e) => e.code === 'unreachable'), t.log.error.map((e) => e.code));
  t.engine.close();
}

current = 'opened into an undecodable part, back to a playable one: play chooses the connection first';
{
  const t = setup({ permissions: { query: async () => ({ state: 'granted' }) } });
  await openPlaying(t, MIXED.key, { at: at('902', 450000) });
  check('opened: the format message, nothing probed', t.engine.state().error.code === 'format' && t.net.loads.length === 0);
  t.engine.seek(300000);                               // back into part 1
  const played = t.engine.play();
  await t.clock.advance(3000);
  await played;
  const s = t.engine.state();
  check('the local connection was probed and used', t.net.loads.some((l) => l.probe && l.side === 'local') &&
    s.connection === 'local' && s.playing && !t.main.paused && partOf(t.main) === MIXED.tracks[0].part_path, [s.connection, t.net.loads]);
  check('from the place it was moved to', s.position.track === '901' && s.position.offset_ms >= 300000 && s.error === null, s.position);
  t.engine.close();
  // Without the permission: straight to remote, no probe, no prompt.
  const u = setup({ permissions: { query: async () => ({ state: 'prompt' }) } });
  await openPlaying(u, MIXED.key, { at: at('902', 450000) });
  u.engine.seek(300000);
  const played2 = u.engine.play();
  await u.clock.advance(3000);
  await played2;
  check('prompt: remote, no local load', u.engine.state().connection === 'remote' && !u.net.loads.some((l) => l.side === 'local') &&
    u.engine.state().playing, u.net.loads);
  u.engine.close();
}

current = 'opening at a saved place at the very end of the part before an undecodable one keeps it';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key, { at: at('901', 600000) });
  const s = t.engine.state();
  check('the format message, the place exactly as saved', s.error && s.error.code === 'format' &&
    s.position.track === '901' && s.position.offset_ms === 600000, s.position);
  check('nothing loaded', t.net.loads.length === 0, t.net.loads);
  t.engine.close();
  // Saved inside the undecodable part: the same, at that place.
  const u = setup({ net: { noLocal: true } });
  await openPlaying(u, MIXED.key, { at: at('902', 450000) });
  check('in part 2: the format message at that place, nothing loaded', u.engine.state().error.code === 'format' &&
    u.engine.state().position.track === '902' && u.engine.state().position.offset_ms === 450000 && u.net.loads.length === 0);
  u.engine.close();
}

current = 'a failed part before an undecodable one: never skipped into it';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, FOUR.key, { at: at('911', 298000) });
  t.net.missing.add(FOUR.tracks[1].part_path);         // part 2 is gone
  await t.clock.advance(20000);
  const s = t.engine.state();
  check('stops (no skip into part 3), holding part 2', s.error && s.error.code === 'part' && s.position.track === '912',
    [s.error, s.position]);
  check('parts 3 and 4 never loaded or probed', loadsOf(t, FOUR.tracks[2].part_path).length === 0 &&
    loadsOf(t, FOUR.tracks[3].part_path).length === 0, t.net.loads.map((l) => l.part));
  check('never the network message', !t.log.error.some((e) => e.code === 'unreachable'));
  // Final review (parked copy LOW): nothing was skipped, so no "skipped" notice.
  check('no "was skipped" notice: nothing was skipped', !t.log.warning.some((w) => w.kind === 'part-skipped'), t.log.warning);
  t.engine.close();
}

// Final review (parked T5b3L2): Play (Retry) at a format stop held at the
// end of a part whose next part can't play here, or at the end of a book
// whose first part can't, stays at the format message: it loads nothing,
// never ends the book again and never says the server is unreachable.
current = 'Play at a format stop at the end of a part loads nothing and stays the format message';
{
  for (const down of [false, true]) {
    const t = setup({ net: { noLocal: true } });
    await openPlaying(t, MIXED.key, { at: at('901', 598000) });
    await t.clock.advance(5000);
    check('stopped at the end of part 1', t.engine.state().error.code === 'format' && t.engine.state().position.offset_ms === 600000);
    if (down) t.net.down.add('remote');
    const loads = t.net.loads.length;
    const ends = t.log.ended.length;
    for (let i = 0; i < 3; i++) {
      await t.engine.play();
      await t.clock.advance(3000);
    }
    const s = t.engine.state();
    check((down ? 'server down: ' : '') + 'still the format message, the place kept', s.error && s.error.code === 'format' &&
      s.position.track === '901' && s.position.offset_ms === 600000, [s.error, s.position]);
    check((down ? 'server down: ' : '') + 'nothing loaded, no end, never unreachable', t.net.loads.length === loads &&
      t.log.ended.length === ends && !reasons(t).slice(-6).includes('ended') && !t.log.error.some((e) => e.code === 'unreachable'),
    [t.net.loads.slice(loads), t.log.error.map((e) => e.code)]);
    t.engine.close();
  }
  // At the end of the book, with part 1 undecodable: the same.
  const u = setup({ net: { noLocal: true } });
  await openPlaying(u, FIRSTBAD.key, { at: at('923', 297000) });
  await u.clock.advance(5000);
  await u.engine.play();
  await u.clock.advance(3000);
  check('book end: the format message', u.engine.state().error && u.engine.state().error.code === 'format');
  const loads = u.net.loads.length;
  const ends = u.log.ended.length;
  await u.engine.play();
  await u.clock.advance(3000);
  await u.engine.retry();
  await u.clock.advance(3000);
  check('book end: Play and Retry again load nothing and end nothing', u.net.loads.length === loads && u.log.ended.length === ends &&
    u.engine.state().error.code === 'format' && u.engine.state().position.offset_ms === 300000, [u.net.loads.slice(loads), u.log.ended.length]);
  u.engine.close();
}

// Final review (parked T5b3L1): a Retry in a book that opened into an
// undecodable part chooses the connection first; a move or a pause made
// while it chooses is what it loads, and a pause means no 'play'.
current = 'Retry that chooses the connection loads where the place is then, playing only if still wanted';
{
  for (const act of ['seek', 'pause']) {
    const t = setup({ permissions: { query: async () => ({ state: 'granted' }) }, net: { hang: new Set(['local']) } });
    await openPlaying(t, MIXED.key, { at: at('902', 450000) });
    check(act + ': opened into part 2: the format message', t.engine.state().error.code === 'format');
    t.engine.seek(300000);                            // back into part 1
    const n = t.log.change.length;
    const played = t.engine.play();                   // the local probe hangs: 1.5 s to choose
    await t.clock.advance(500);
    if (act === 'seek') t.engine.seek(200000);
    else t.engine.pause();
    await t.clock.advance(3000);
    await played;
    const s = t.engine.state();
    const after = t.log.change.slice(n).map((c) => c.reason);
    if (act === 'seek') {
      check('seek: loaded and playing from the place moved to', s.playing && !t.main.paused && partOf(t.main) === MIXED.tracks[0].part_path &&
        s.position.track === '901' && s.position.offset_ms >= 200000 && s.position.offset_ms < 205000, s.position);
    } else {
      check('pause: not playing, loaded at the place, paused', !s.playing && t.main.paused && partOf(t.main) === MIXED.tracks[0].part_path &&
        s.position.offset_ms === 300000, [s.playing, s.position]);
      check('pause: no \'play\' after the pause', after.lastIndexOf('play') < after.indexOf('pause') && after.includes('ready'), after);
    }
    t.engine.close();
  }
}

current = 'probes never test the connection with an undecodable part';
{
  // Part 3 of MIXED (aac) fails once as media: the check-probe must use
  // part 1, never the undecodable part 2 next to it.
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key, { at: at('903', 1000) });
  t.net.glitchOnce.set(MIXED.tracks[2].part_path, 3);
  await t.clock.advance(10000);
  const probes = t.net.loads.filter((l) => l.probe);
  check('a probe ran, never on part 2', probes.length >= 1 && probes.every((l) => l.part !== MIXED.tracks[1].part_path),
    probes.map((l) => l.part));
  check('part 3 plays on', partOf(t.main) === MIXED.tracks[2].part_path && !t.main.paused && t.log.error.length === 0);
  t.engine.close();
}

// ---- 13b. Spec 2.5: the book's files changed ----
// A saver as the engine uses it (saves.js has its own cases): it records
// what the engine hands it, orders the copies newest first, and holds.
function heldSaver() {
  const s = {
    starts: [], notes: [], released: [], releasedOpts: [], stops: 0, lastSavedAt: null, warning: false,
    note(c) { s.notes.push({ reason: c.reason, playing: c.state.playing, placeMs: c.placeMs, placeLabel: c.placeLabel, place: !!c.place, from: c.from, to: c.to, released: s.released.length }); },
    start(book, o) { s.starts.push({ book, o: JSON.parse(JSON.stringify(o || {})) }); },
    stop() { s.stops += 1; },
    onWarning() { return () => {}; },
    clockProbe() { return () => {}; },
    readLocal() { return null; },
    resumeFrom(key, p) {
      return ['web', 'plex'].filter((k) => p[k]).map((k) => Object.assign({ source: k }, p[k]))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    },
    releaseFiles(book, link, o) { s.released.push({ book, link }); s.releasedOpts.push(o || null); return true; },
    lastSeen() { return null; }
  };
  return s;
}
// The web copy of a place in a part this book no longer has.
const GONE = { track: '599', offset_ms: 120000, duration_ms: 900000, updated_at: '2026-09-30T10:00:00.000Z', device: 'Chrome on Windows',
  book_ms: 720000, book_duration_ms: 1800000, chapter_label: 'Part 2 of 3', narrator: 'N. Reader', book_title: 'Three Parts', psid: 'x' };
async function openHeld(key, positions, o = {}) {
  const saver = heldSaver();
  const t = setup(Object.assign({ saver, net: Object.assign({ noLocal: true, positions }, o.net || {}) }, o.setup || {}));
  const p = t.engine.open(key, o.opts);
  await t.clock.advance(1000);
  await p;
  return Object.assign(t, { saver });
}
const bookMsOf = (t) => t.engine.state().bookMs;

current = 'spec 2.5: a saved place in a part the book no longer has holds the open at its start as "files changed"';
{
  const t = await openHeld(MULTI.key, { web: GONE, plex: null });
  const s = t.engine.state();
  const old = s.filesChanged && s.filesChanged.old;
  check('state().filesChanged.old is the saved place', !!old && old.track === '599' && old.offset_ms === 120000 && old.book_ms === 720000 &&
    old.book_duration_ms === 1800000 && old.chapter_label === 'Part 2 of 3' && old.updated_at === GONE.updated_at &&
    old.source === 'web' && old.linked_from === null, s.filesChanged);
  check('it names the copy (title, narrator) for the helper', old && old.book_title === 'Three Parts' && old.narrator === 'N. Reader', old);
  check('held at the start of the book, loaded, not playing', s.position && s.position.track === '501' && s.position.offset_ms === 0 &&
    !s.playing && !s.error && partOf(t.main) === MULTI.tracks[0].part_path && t.main.paused, [s.position, s.playing, s.error]);
  check('no resume was made from it', s.resumedFrom === null, s.resumedFrom);
  const w = t.log.warning.filter((x) => x.kind === 'files-changed');
  check('one files-changed warning, after the open, carrying the old place', w.length === 1 && w[0].old && w[0].old.track === '599' &&
    w[0].book === MULTI.key && t.log.raw.findIndex((x) => x[0] === 'warning') > t.log.raw.findIndex((x) => x[0] === 'change' && x[1].reason === 'open'), t.log.warning);
  check('no "couldn\'t find your saved place" notice', !t.log.warning.some((x) => x.kind === 'resume-lost'), t.log.warning);
  check('the saves were started held', t.saver.starts.length === 1 && t.saver.starts[0].o.files === true && !t.saver.starts[0].o.push, t.saver.starts);
  check('state() with no book: filesChanged null', (() => { t.engine.close(); return t.engine.state().filesChanged === null; })());
  // A book with nothing saved, or saved in a part it has: no files changed.
  const u = await openHeld(MULTI.key, { web: null, plex: null });
  check('nothing saved: no files changed', u.engine.state().filesChanged === null && u.saver.starts[0].o.files !== true);
  u.engine.close();
  const v = await openHeld(MULTI.key, { web: Object.assign({}, GONE, { track: '502' }), plex: null });
  check('a saved place in a part it has: resumed as ever', v.engine.state().filesChanged === null &&
    v.engine.state().position.track === '502' && v.engine.state().resumedFrom.source === 'web', v.engine.state().position);
  v.engine.close();
}

current = 'spec 2.5: the helper comes first: the open\'s handoff gate is not asked while the files changed';
{
  const saver = heldSaver();
  const t = setup({ saver, net: { noLocal: true, positions: { web: Object.assign({}, GONE, { linked_from: '400:1', track: '502' }), plex: null } } });
  let asked = 0;
  t.engine.setOpenGate(() => { asked += 1; return { at: 'web' }; });
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(1000);
  await p;
  check('the gate was not asked; held at the start', asked === 0 && t.engine.state().filesChanged !== null && bookMsOf(t) === 0, [asked, bookMsOf(t)]);
  t.engine.close();
}

current = 'spec 2.5: the newest copy decides; an older copy in a part the book has is never jumped to';
{
  const older = { track: '503', offset_ms: 1000, duration_ms: 300000, updated_at: '2026-09-29T10:00:00.000Z', device: 'Plex' };
  const t = await openHeld(MULTI.key, { web: GONE, plex: older });
  check('files changed, held at 0 (not the older Plex place)', t.engine.state().filesChanged && t.engine.state().position.track === '501' &&
    t.engine.state().position.offset_ms === 0, t.engine.state().position);
  t.engine.close();
  const newer = Object.assign({}, older, { updated_at: '2026-09-30T11:00:00.000Z' });
  const u = await openHeld(MULTI.key, { web: GONE, plex: newer });
  check('a newer copy in a part it has resumes as ever', u.engine.state().filesChanged === null && u.engine.state().position.track === '503', u.engine.state().position);
  u.engine.close();
  const plexGone = Object.assign({}, newer, { track: '598', book_ms: 50000, book_duration_ms: 1700000 });
  const w = await openHeld(MULTI.key, { web: null, plex: plexGone });
  const old = w.engine.state().filesChanged && w.engine.state().filesChanged.old;
  check('a Plex copy in a missing part: files changed from it', old && old.source === 'plex' && old.track === '598' && old.book_ms === 50000 &&
    old.book_duration_ms === 1700000 && old.chapter_label === null, old);
  w.engine.close();
}

current = 'spec 2.5: an earlier copy of the book (linked_from) is always "files changed"';
{
  // Even when its part key happens to be one this book has.
  const linked = Object.assign({}, GONE, { track: '501', offset_ms: 5000, linked_from: '400:1', book_title: 'Three Parts (Old)' });
  const t = await openHeld(MULTI.key, { web: linked, plex: null });
  const old = t.engine.state().filesChanged && t.engine.state().filesChanged.old;
  check('files changed, with linked_from', old && old.linked_from === '400:1' && old.book_title === 'Three Parts (Old)' && old.source === 'web', old);
  check('held at the start', t.engine.state().position.offset_ms === 0 && !t.engine.state().playing);
  t.engine.close();
}

current = 'spec 2.5: previewAt plays 15 s from a spot, then pauses; a second call replaces the first';
{
  const t = await openHeld(MULTI.key, { web: GONE, plex: null });
  check('previewAt is a function', typeof t.engine.previewAt === 'function');
  check('previewAt returns true', t.engine.previewAt(700000) === true);
  await t.clock.advance(3000);
  check('playing from the spot', t.engine.state().playing && bookMsOf(t) > 700000 && bookMsOf(t) < 704000, bookMsOf(t));
  check('the move is a preview, not a seek', reasons(t).includes('preview') && !t.saver.notes.some((n) => n.reason === 'seek'), reasons(t).slice(-6));
  await t.clock.advance(20000);
  const s = t.engine.state();
  check('paused after 15 s', !s.playing && t.main.paused && bookMsOf(t) >= 715000 && bookMsOf(t) <= 715500, bookMsOf(t));
  check('still held', s.filesChanged !== null);
  // A second call replaces the first.
  t.engine.previewAt(100000);
  await t.clock.advance(5000);
  t.engine.previewAt(1300000);
  await t.clock.advance(20000);
  check('the second preview replaced the first', !t.engine.state().playing && bookMsOf(t) >= 1315000 && bookMsOf(t) <= 1315500, bookMsOf(t));
  // At the very end of the book: the 15 s before it, stopping short of the end.
  t.engine.previewAt(1800000);
  await t.clock.advance(20000);
  check('a preview of the end plays up to it, never ending the book', !t.engine.state().playing && t.log.ended.length === 0 &&
    bookMsOf(t) >= 1790000 && bookMsOf(t) < 1800000, bookMsOf(t));
  check('not a number: refused', t.engine.previewAt('x') === false && t.engine.previewAt(NaN) === false);
  t.engine.close();
  // Only while the files changed are held.
  const u = setup({ net: { noLocal: true } });
  await openPlaying(u, MULTI.key, { at: at('501', 1000), autoplay: false });
  check('not held: previewAt refused', u.engine.previewAt(700000) === false && !u.engine.state().playing);
  check('not held: confirmPlace and startOver refused', u.engine.confirmPlace(700000) === false && u.engine.startOver() === false);
  u.engine.close();
}

// Fix round 1 (T2E1): playback while held is only ever a bounded preview.
// Play with no live preview starts a fresh one at the helper's chosen spot
// (0 at the open, then the last preview's start or move's landing); a move
// ends the preview, pauses and only moves that spot.
const PREVIEW_END = (t, from) => !t.engine.state().playing && bookMsOf(t) >= from + 15000 && bookMsOf(t) <= from + 15500;
current = 'spec 2.5: while held, Play (bar, lock screen, the element\'s own) only ever plays a bounded preview';
{
  const t = await openHeld(MULTI.key, { web: GONE, plex: null });
  check('the chosen spot starts at the held start', t.engine.state().filesChanged.spot === 0, t.engine.state().filesChanged);
  await t.engine.play();
  await t.clock.advance(3000);
  check('Play: a preview from the chosen spot', t.engine.state().playing && bookMsOf(t) > 0 && bookMsOf(t) < 4000, bookMsOf(t));
  await t.clock.advance(20000);
  check('which stops after 15 s', PREVIEW_END(t, 0), bookMsOf(t));
  t.ms.handlers.get('play')();
  await t.clock.advance(20000);
  check('lock-screen Play after it: the same 15 s again', PREVIEW_END(t, 0) && t.log.change.filter((c) => c.reason === 'preview').length === 2, bookMsOf(t));
  t.main.play();                                   // the browser's own control
  await t.clock.advance(1000);
  check('the element started from outside: a preview too', t.engine.state().playing && bookMsOf(t) < 2000, bookMsOf(t));
  await t.clock.advance(20000);
  check('bounded', PREVIEW_END(t, 0), bookMsOf(t));
  t.engine.previewAt(700000);
  await t.clock.advance(3000);
  t.ms.handlers.get('pause')();
  const paused = bookMsOf(t);
  await t.clock.advance(3000);
  check('lock-screen Pause pauses the preview', !t.engine.state().playing && bookMsOf(t) === paused);
  t.ms.handlers.get('play')();
  await t.clock.advance(3000);
  check('lock-screen Play resumes it', t.engine.state().playing && bookMsOf(t) > paused, bookMsOf(t));
  await t.clock.advance(20000);
  check('to its end, and no further', PREVIEW_END(t, 700000), bookMsOf(t));
  t.engine.toggle();
  await t.clock.advance(20000);
  check('toggle after it: the 15 s from its start again', PREVIEW_END(t, 700000) && t.engine.state().filesChanged.spot === 700000, bookMsOf(t));
  check('still held', t.engine.state().filesChanged !== null);
  t.engine.close();
}

current = 'spec 2.5 T2E1: a move while a preview is paused, then Play, stays a bounded preview (bar, lock screen, Retry)';
for (const how of ['bar', 'lock screen', 'toggle']) {
  const t = await openHeld(MULTI.key, { web: GONE, plex: null });
  t.engine.previewAt(700000);
  await t.clock.advance(3000);
  t.engine.pause();
  if (how === 'lock screen') t.ms.handlers.get('seekto')({ seekTime: 100 });
  else t.engine.jumpToChapter(2);                  // Part 3 of 3: 1 500 000
  const to = how === 'lock screen' ? 100000 : 1500000;
  await t.clock.advance(500);
  check(how + ': the move is the chosen spot', t.engine.state().filesChanged.spot === to && bookMsOf(t) === to, t.engine.state().filesChanged);
  if (how === 'bar') await t.engine.play();
  else if (how === 'lock screen') t.ms.handlers.get('play')();
  else t.engine.toggle();
  await t.clock.advance(60000);
  check(how + ': Play previews 15 s from the moved-to spot, no more', PREVIEW_END(t, to), [to, bookMsOf(t)]);
  check(how + ': still held', t.engine.state().filesChanged !== null);
  t.engine.close();
}
{
  // The same through the error state: an outage mid-preview, a move back, Retry.
  const t = await openHeld(MULTI.key, { web: GONE, plex: null });
  t.engine.previewAt(700000);
  await t.clock.advance(3000);
  t.net.down.add('remote');
  await t.clock.advance(15000);
  check('an outage mid-preview stops it', !t.engine.state().playing && t.engine.state().error !== null);
  t.engine.seek(0);
  t.net.down.clear();
  await t.engine.retry();
  await t.clock.advance(120000);
  check('Retry after the move: 15 s from 0, no more (not 120 s)', PREVIEW_END(t, 0), bookMsOf(t));
  t.engine.close();
}

current = 'spec 2.5 T2E1: a move while a preview plays ends it: paused, at the new spot';
for (const how of ['seek', 'skip', 'chapter', 'seekforward']) {
  const t = await openHeld(MULTI.key, { web: GONE, plex: null });
  t.engine.previewAt(700000);
  await t.clock.advance(5000);
  if (how === 'seek') t.engine.seek(1000000);
  else if (how === 'skip') t.engine.skip(30);
  else if (how === 'chapter') t.engine.jumpToChapter(0);
  else t.ms.handlers.get('seekforward')({});
  const at = bookMsOf(t);
  await t.clock.advance(20000);
  check(how + ': paused where it landed', !t.engine.state().playing && bookMsOf(t) === at && t.engine.state().filesChanged.spot === at, [at, bookMsOf(t)]);
  t.engine.close();
}

// Fix round 2 (T2R1): an element whose 'play', 'pause' and 'timeupdate'
// events are queued (a media element task, 1 ms later), as the HTML spec
// has them, never fired inside play()/pause(); its time runs on whenever it
// is not paused (one ticker). Played from outside the engine after a
// preview (a lock screen or headset where there is no Media Session), the
// held engine must start one bounded preview, not answer its own queued
// events for ever; and Pause must always stop it.
class QueuedAudio extends FakeAudio {
  constructor(env) { super(env); this.started = false; }
  later(types) {
    const env = this.env;
    env.fired = (env.fired || 0) + types.length;
    if (env.fired > 200000) { env.capped = true; return; }
    env.clock.setTimeout(() => { for (const ty of types) this.fire(ty); }, 1);
  }
  ticker() {
    if (this.started) return;
    this.started = true;
    const step = () => {
      this.env.clock.setTimeout(() => {
        if (!this.paused && this.readyState >= 3 && !this.ended) {
          this._t = Math.min(this.duration, this._t + 0.25 * this.playbackRate);
          if (this._t >= this.duration) { this.paused = true; this.ended = true; this.later(['timeupdate', 'pause', 'ended']); }
          else this.later(['timeupdate']);
        }
        if (!this.env.stopTicker) step();
      }, 250);
    };
    step();
  }
  play() {
    if (this.paused) {
      if (this.ended) { this._t = 0; this.ended = false; }
      this.paused = false;
      this.ticker();
      this.later(['play']);
      if (this.readyState >= 3) this.later(['playing']);
    }
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.later(['timeupdate', 'pause']);
  }
  begin() { if (this.paused) return; this.ticker(); this.later(['playing']); }
  tick() {}
}
current = 'fix round 2 (T2R1): the element played from outside while held: one bounded preview, no event loop, Pause stops it';
for (const how of ['after a finished preview', 'after a move']) {
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { Audio: QueuedAudio } });
  t.engine.previewAt(700000);
  await t.clock.advance(20000);
  if (how === 'after a move') { t.engine.seek(1000000); await t.clock.advance(1000); }
  const to = how === 'after a move' ? 1000000 : 700000;
  check(how + ': the preview ended, held', !t.engine.state().playing && t.main.paused && t.engine.state().filesChanged.spot === to, [bookMsOf(t), t.engine.state().filesChanged]);
  const f0 = t.env.fired || 0;
  const c0 = t.log.change.length;
  t.main.play();                                   // the element itself, from outside the engine
  await t.clock.advance(2000);
  const changes = t.log.change.slice(c0).filter((c) => c.reason !== 'time').map((c) => c.reason);
  check(how + ': a handful of events, not a loop', !t.env.capped && (t.env.fired || 0) - f0 < 30 && changes.length <= 3, [(t.env.fired || 0) - f0, changes]);
  check(how + ': a preview from the chosen spot', t.engine.state().playing && !t.main.paused && bookMsOf(t) > to && bookMsOf(t) < to + 3000, bookMsOf(t));
  await t.clock.advance(58000);
  check(how + ': bounded, then stopped', !t.engine.state().playing && t.main.paused && bookMsOf(t) >= to + 15000 && bookMsOf(t) <= to + 15500 && !t.env.capped, bookMsOf(t));
  // Pause always stops it: the bar's toggle while a preview plays, and the
  // engine's pause() even when the element plays without the engine knowing.
  t.main.play();
  await t.clock.advance(3000);
  t.engine.toggle();
  await t.clock.advance(3000);
  const a = bookMsOf(t);
  await t.clock.advance(5000);
  check(how + ': toggle stops the preview', !t.engine.state().playing && t.main.paused && bookMsOf(t) === a, [t.main.paused, a, bookMsOf(t)]);
  t.main.paused = false;                           // the element playing with no event at all
  t.main.ticker();
  await t.clock.advance(1000);
  t.engine.pause();
  await t.clock.advance(5000);
  check(how + ': engine.pause() stops an element playing on its own', t.main.paused && !t.engine.state().playing);
  t.main.paused = false;
  await t.clock.advance(1000);
  t.engine.toggle();
  await t.clock.advance(5000);
  check(how + ': and so does the toggle', t.main.paused && !t.engine.state().playing);
  check(how + ': still held', t.engine.state().filesChanged !== null && !t.env.capped);
  t.env.stopTicker = true;
  t.engine.close();
  await t.clock.advance(1000);
}

// Fix round 3 (T2R4): after 5+ minutes quiet, a confirm re-reads the saved
// places first, still held; closing meanwhile leaves no timer.
current = 'fix round 3 (T2R4): a confirm after a long quiet stays held through its re-read; a close meanwhile leaves nothing';
{
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true } });
  await t.clock.advance(6 * 60000);
  const reads = t.net.fetches.filter((u) => u.indexOf('/position/') !== -1).length;
  check('confirmPlace', t.engine.confirmPlace(650000) === true);
  check('still held, checking, the read sent', t.engine.state().filesChanged !== null && t.engine.state().checking === true &&
    t.saver.released.length === 0 && t.net.fetches.filter((u) => u.indexOf('/position/') !== -1).length === reads + 1);
  await t.clock.advance(1000);
  check('then it lands: released once, one place move after the release', t.engine.state().filesChanged === null && t.engine.state().checking === false &&
    t.saver.released.length === 1 && t.saver.notes.filter((n) => n.place && n.released === 1).length === 1 && bookMsOf(t) === 650000, [t.saver.released, bookMsOf(t)]);
  t.engine.close();
  const u = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true }, net: { fetchDelay: {} } });
  await u.clock.advance(6 * 60000);
  u.net.positions = null;                            // the re-read now never answers usefully (404)
  u.engine.confirmPlace(650000);
  u.engine.close();
  check('closed during the read: no timer left, nothing released', u.live.size === 0 && u.saver.released.length === 0, u.live.size);
  await u.clock.advance(10000);
  check('and nothing lands later', u.saver.released.length === 0 && u.engine.state().book === null);
  // Held, a Play after the long quiet is a preview: no late re-read for it.
  const w = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true } });
  await w.clock.advance(6 * 60000);
  const r1 = w.net.fetches.filter((x) => x.indexOf('/position/') !== -1).length;
  await w.engine.play();
  await w.clock.advance(1000);
  check('a held Play after a long quiet: a preview at once, no re-read', w.engine.state().playing && !w.engine.state().checking &&
    w.net.fetches.filter((x) => x.indexOf('/position/') !== -1).length === r1);
  w.engine.close();
  // Fix round 4 (T2R7): without the long quiet too, the confirm re-reads
  // first, still held, then lands.
  const v = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true } });
  const r0 = v.net.fetches.filter((x) => x.indexOf('/position/') !== -1).length;
  v.engine.confirmPlace(650000);
  check('a confirm soon after the open re-reads too, still held', v.engine.state().filesChanged !== null && v.engine.state().checking === true &&
    v.net.fetches.filter((x) => x.indexOf('/position/') !== -1).length === r0 + 1 && v.saver.released.length === 0);
  await v.clock.advance(1000);
  check('then lands', v.engine.state().filesChanged === null && v.saver.released.length === 1 && bookMsOf(v) === 650000, bookMsOf(v));
  v.engine.close();
}

// T2R6: the preview's wall-clock bound scales with a slower speed, so at
// 0.75x it still plays its 15 s of the book.
current = 'fix round 3 (T2R6): at 0.75x a preview still plays 15 s of the book (the wall bound allows for it)';
{
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true } });
  t.engine.setSpeed(0.75);
  t.engine.previewAt(700000);
  await t.clock.advance(40000);
  check('15 s of the book at 0.75x', !t.engine.state().playing && bookMsOf(t) >= 714500 && bookMsOf(t) <= 715500, bookMsOf(t));
  t.engine.setSpeed(2);
  t.engine.previewAt(1000000);
  await t.clock.advance(40000);
  check('and at 2x (about 7.5 s of wall time)', !t.engine.state().playing && bookMsOf(t) >= 1015000 && bookMsOf(t) <= 1015600, bookMsOf(t));
  t.engine.close();
}

// Fix round 4 (T2R7): a preview is playing, so it says nothing about places
// saved elsewhere meanwhile: a confirm right after one still re-reads first.
current = 'fix round 4 (T2R7): a confirm right after a preview still re-reads the saved places first, held meanwhile';
for (const how of ['a preview to its end', 'confirmed 3 s into a preview', 'confirmed 3 s into the bar Play\'s preview']) {
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true } });
  await t.clock.advance(6 * 60000);
  if (how === 'a preview to its end') { t.engine.previewAt(650000); await t.clock.advance(16000); }
  else if (how === 'confirmed 3 s into a preview') { t.engine.previewAt(650000); await t.clock.advance(3000); }
  else { t.engine.seek(650000); await t.engine.play(); await t.clock.advance(3000); }
  const reads = t.net.fetches.filter((u) => u.indexOf('/position/') !== -1).length;
  t.engine.confirmPlace(650000);
  check(how + ': the read goes out, still held', t.engine.state().filesChanged !== null && t.engine.state().checking === true &&
    t.net.fetches.filter((u) => u.indexOf('/position/') !== -1).length === reads + 1 && t.saver.released.length === 0, t.saver.released);
  await t.clock.advance(1000);
  check(how + ': then it lands at the spot', t.engine.state().filesChanged === null && t.saver.released.length === 1 && bookMsOf(t) === 650000 &&
    !t.engine.state().playing, bookMsOf(t));
  t.engine.close();
}

// Fix round 4 (T2R8): while held, the helper's chosen spot is where the
// listener is: a relative move (skip, the lock screen's seek back and
// forward) goes from it, not from a preview's playhead, and a confirm
// waiting on its read has the held playhead at its spot.
current = 'fix round 4 (T2R8): while held, every move is relative to the chosen spot; a waiting confirm moves the held playhead there';
{
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true } });
  const spot = () => t.engine.state().filesChanged.spot;
  t.engine.previewAt(700000);
  await t.clock.advance(5000);
  check('a preview plays past its start', t.engine.state().playing && bookMsOf(t) > 704000, bookMsOf(t));
  t.engine.skip(-10);
  await t.clock.advance(500);
  check('skip back during it: 10 s before the spot, paused there', spot() === 690000 && bookMsOf(t) === 690000 && !t.engine.state().playing, [spot(), bookMsOf(t)]);
  t.engine.previewAt(700000);
  await t.clock.advance(5000);
  t.ms.handlers.get('seekforward')({});
  await t.clock.advance(500);
  check('the lock screen\'s seek forward: from the spot', spot() === 710000 && bookMsOf(t) === 710000, [spot(), bookMsOf(t)]);
  t.engine.previewAt(700000);
  await t.clock.advance(5000);
  t.ms.handlers.get('seekbackward')({ seekOffset: 30 });
  await t.clock.advance(500);
  check('the lock screen\'s seek back by 30 s: from the spot', spot() === 670000 && bookMsOf(t) === 670000, [spot(), bookMsOf(t)]);
  t.engine.previewAt(700000);
  await t.clock.advance(20000);
  check('a finished preview leaves the playhead past the spot', !t.engine.state().playing && bookMsOf(t) >= 714500 && spot() === 700000, [spot(), bookMsOf(t)]);
  t.engine.skip(10);
  await t.clock.advance(500);
  check('skip forward after it: from the spot', spot() === 710000 && bookMsOf(t) === 710000, [spot(), bookMsOf(t)]);
  t.engine.previewAt(700000);
  await t.clock.advance(5000);
  t.ms.handlers.get('seekto')({ seekTime: 800 });
  await t.clock.advance(500);
  check('seekto and a chapter jump land where they say', spot() === 800000 && bookMsOf(t) === 800000 &&
    (t.engine.jumpToChapter(2), spot() === 1500000 && bookMsOf(t) === 1500000), [spot(), bookMsOf(t)]);
  check('still held throughout', t.engine.state().filesChanged !== null && t.saver.released.length === 0);
  t.engine.close();
  // A confirm waiting on its read: the held playhead is at its spot.
  const u = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true } });
  await u.clock.advance(6 * 60000);
  u.engine.confirmPlace(650000);
  const s = u.engine.state();
  check('a confirm waiting on its read: held, the playhead at its spot', s.filesChanged !== null && s.checking === true &&
    s.bookMs === 650000 && s.filesChanged.spot === 650000 && s.position.track === '502' && s.position.offset_ms === 50000, [s.bookMs, s.position]);
  u.engine.skip(-10);
  check('a skip meanwhile goes from there', u.engine.state().filesChanged.spot === 640000 && bookMsOf(u) === 640000, bookMsOf(u));
  u.engine.close();
}

// Fix round 4 (T2R9): the stream buffering mid-preview (no timeupdate
// meanwhile) is not playing: it does not shorten the preview.
class StallAudio extends FakeAudio {
  tick(g) {
    this.env.clock.setTimeout(() => {
      if (g !== this.gen || this.paused || !this.ticking) return;
      const env = this.env;
      const now = env.clock.now;
      // env.stalls: [[from, ms], ...] (clock ms); or one, env.stallFrom and env.stallMs.
      const stalls = env.stalls || (env.stallFrom !== undefined ? [[env.stallFrom, env.stallMs]] : []);
      if (stalls.some(([f, ms]) => now >= f && now < f + ms)) {
        if (!this.stalled) { this.stalled = true; this.fire('waiting'); }
        this.tick(g);
        return;
      }
      if (this.stalled) { this.stalled = false; this.fire('playing'); }
      this._t = Math.min(this.duration, this._t + 0.25 * this.playbackRate);
      this.fire('timeupdate');
      this.tick(g);
    }, 250);
  }
}
current = 'fix round 4 (T2R9): buffering mid-preview does not shorten it';
for (const stall of [0, 3000, 6000]) {
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true, Audio: StallAudio } });
  t.engine.previewAt(700000);
  if (stall) { t.env.stallFrom = t.clock.now + 3000; t.env.stallMs = stall; }
  await t.clock.advance(40000);
  check(stall + ' ms buffering 3 s in: about 15 s of the book still heard', !t.engine.state().playing && t.engine.state().filesChanged !== null &&
    bookMsOf(t) >= 714000 && bookMsOf(t) <= 715500 && t.log.error.length === 0, bookMsOf(t));
  t.engine.close();
}

// Fix round 5 (T2U4): every stall is free, not only the first: a 'waiting'
// restarts the preview's wall count.
current = 'fix round 5 (T2U4): several stalls mid-preview cost it nothing';
for (const [name, stalls] of [['two 2 s stalls', [[3000, 2000], [8000, 2000]]], ['five 1.2 s stalls every 3 s', [[2000, 1200], [5000, 1200], [8000, 1200], [11000, 1200], [14000, 1200]]]]) {
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true, Audio: StallAudio } });
  const t0 = t.clock.now;
  t.env.stalls = stalls.map(([f, ms]) => [t0 + f, ms]);
  t.engine.previewAt(700000);
  await t.clock.advance(60000);
  check(name + ': the whole 15 s of the book heard', !t.engine.state().playing && t.engine.state().filesChanged !== null &&
    bookMsOf(t) >= 714750 && bookMsOf(t) <= 715500 && t.log.error.length === 0, bookMsOf(t));
  t.engine.close();
}

current = 'spec 2.5: while held, Retry after an outage only ever plays a bounded preview';
{
  // The held open can't load its start: "Can't reach the media server".
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { net: { down: new Set(['remote']) } });
  const err = t.log.raw.filter((x) => x[0] === 'error').pop();
  check('unreachable, with a retry', err && err[1].code === 'unreachable' && typeof err[1].retry === 'function', t.log.error);
  t.net.down.clear();
  await err[1].retry();
  await t.clock.advance(60000);
  check('the error\'s Retry: a preview from the chosen spot (0), bounded', PREVIEW_END(t, 0) && t.engine.state().error === null, [bookMsOf(t), t.engine.state().error]);
  check('a preview plays', t.engine.previewAt(700000) === true);
  await t.clock.advance(3000);
  check('it plays', t.engine.state().playing && bookMsOf(t) > 700000, bookMsOf(t));
  t.net.down.add('remote');
  await t.clock.advance(15000);
  check('an outage mid-preview stops it', !t.engine.state().playing && t.engine.state().error !== null);
  t.net.down.clear();
  const at = bookMsOf(t);
  await t.engine.retry();
  await t.clock.advance(20000);
  check('Retry resumes the unfinished preview, to its end only', PREVIEW_END(t, 700000) && bookMsOf(t) > at, [at, bookMsOf(t)]);
  check('still held', t.engine.state().filesChanged !== null);
  t.engine.close();
}

current = 'spec 2.5: while held, smart rewind does nothing';
{
  const t = await openHeld(MULTI.key, { web: GONE, plex: null });
  t.engine.previewAt(700000);
  await t.clock.advance(5000);
  const here = bookMsOf(t);
  t.engine.rewind(here - 30000);
  await t.clock.advance(500);
  check('rewind ignored', bookMsOf(t) >= here && t.engine.state().playing && !t.saver.notes.some((n) => n.reason === 'seek'), bookMsOf(t));
  t.engine.close();
}

current = 'spec 2.5 T2E3: a preview stops short of a part this browser can\'t decode';
{
  // MIXED: part 2 (600 000 to 1 500 000) is E-AC3.
  const t = await openHeld(MIXED.key, { web: Object.assign({}, GONE, { track: '999' }), plex: null });
  check('previewAt 5 s before the undecodable part', t.engine.previewAt(595000) === true);
  await t.clock.advance(30000);
  let s = t.engine.state();
  check('it stops 1 s short of it: no format error', !s.playing && !s.error && t.log.error.length === 0 &&
    bookMsOf(t) >= 599000 && bookMsOf(t) < 600000 && s.filesChanged.spot === 595000, [bookMsOf(t), s.error, s.filesChanged.spot]);
  t.engine.previewAt(599800);
  await t.clock.advance(30000);
  s = t.engine.state();
  check('a spot within 1 s of it: the 15 s before it', !s.playing && !s.error && s.filesChanged.spot === 585000 &&
    bookMsOf(t) >= 599000 && bookMsOf(t) < 600000, [bookMsOf(t), s.filesChanged.spot]);
  t.engine.previewAt(580000);
  await t.clock.advance(30000);
  s = t.engine.state();
  check('from further back: up to the same place', !s.playing && !s.error && bookMsOf(t) >= 594000 && bookMsOf(t) < 600000, bookMsOf(t));
  check('still held, part 2 never loaded', s.filesChanged !== null && !t.net.loads.some((l) => l.part === MIXED.tracks[1].part_path));
  t.engine.close();
}

current = 'spec 2.5 T2E2: a confirm or startOver during the open\'s connection choice does not autoplay';
for (const how of ['confirmPlace', 'startOver']) {
  const saver = heldSaver();
  const t = setup({ saver, net: { positions: { web: GONE, plex: null }, hang: new Set(['local']) } });
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(300);                      // the local probe is still waiting
  check(how + ' during the choice', how === 'confirmPlace' ? t.engine.confirmPlace(650000) === true : t.engine.startOver() === true);
  await t.clock.advance(3000);
  await p;
  await t.clock.advance(5000);
  const s = t.engine.state();
  check(how + ': loaded, not playing, at the spot', !s.playing && t.main.paused && bookMsOf(t) === (how === 'confirmPlace' ? 650000 : 0) &&
    s.filesChanged === null, [s.playing, bookMsOf(t)]);
  t.engine.close();
}

current = 'spec 2.5 Review Focus 5: previewAt and confirmPlace refuse a spot this browser can\'t decode';
{
  const t = await openHeld(MIXED.key, { web: Object.assign({}, GONE, { track: '999' }), plex: null });
  check('held', t.engine.state().filesChanged !== null);
  const loads = t.net.loads.length;
  check('previewAt into part 2 (E-AC3) refused', t.engine.previewAt(700000) === false);
  await t.clock.advance(3000);
  check('nothing played or loaded', !t.engine.state().playing && t.net.loads.length === loads && bookMsOf(t) === 0, bookMsOf(t));
  check('confirmPlace into it refused', t.engine.confirmPlace(700000) === false);
  check('still held, nothing released', t.engine.state().filesChanged !== null && t.saver.released.length === 0);
  check('each refusal says the part can\'t play', t.log.warning.filter((w) => w.kind === 'part-format').length === 2, t.log.warning);
  check('a playable spot previews', t.engine.previewAt(1600000) === true);
  t.engine.close();
}

current = 'spec 2.5: confirmPlace is an explicit move that ends the hold; startOver is confirmPlace(0) without the link';
{
  const linked = Object.assign({}, GONE, { linked_from: '400:1' });
  const t = await openHeld(MULTI.key, { web: linked, plex: null });
  t.engine.previewAt(700000);
  await t.clock.advance(5000);
  check('confirmPlace returns true', t.engine.confirmPlace(650000) === true);
  await t.clock.advance(1000);
  const s = t.engine.state();
  check('no longer held', s.filesChanged === null);
  check('paused at the spot', !s.playing && bookMsOf(t) === 650000 && s.position.track === '502' && s.position.offset_ms === 50000, [s.playing, bookMsOf(t)]);
  check('the saves were released, with the earlier copy\'s link', t.saver.released.length === 1 && t.saver.released[0].link === '400:1', t.saver.released);
  const mv = t.saver.notes.filter((n) => n.reason === 'seek');
  // Fix round 4 (T2R8): the held playhead goes to the spot first (still
  // held, marked place too), then the confirm lands after its re-read.
  check('the held playhead moved to the spot first (a seek marked place, still held)', mv.length === 2 && mv[0].to === 650000 && mv[0].place === true &&
    mv[0].released === 0, mv);
  check('then one explicit move (a seek marked place)', mv.length === 2 && mv[1].to === 650000 && mv[1].place === true && mv[1].placeMs === 650000, mv);
  check('the release came before that move', mv[1] && mv[1].released === 1, mv);
  check('the preview stopped while still held', t.saver.notes.some((n) => n.reason === 'pause' && n.released === 0));
  check('not held: previewAt refused now', t.engine.previewAt(100000) === false);
  await t.engine.play();
  await t.clock.advance(2000);
  check('Play plays as ever after it', t.engine.state().playing && bookMsOf(t) > 650000);
  t.engine.close();
  const u = await openHeld(MULTI.key, { web: linked, plex: null });
  check('startOver returns true', typeof u.engine.startOver === 'function' && u.engine.startOver() === true);
  await u.clock.advance(1000);
  check('at the start, released without the link', u.engine.state().filesChanged === null && bookMsOf(u) === 0 &&
    u.saver.released.length === 1 && u.saver.released[0].link === null, u.saver.released);
  check('startOver is a move too', u.saver.notes.some((n) => n.reason === 'seek' && n.place === true));
  u.engine.close();
  // A place with no link: none passed.
  const v = await openHeld(MULTI.key, { web: GONE, plex: null });
  v.engine.confirmPlace(100000);
  await v.clock.advance(1000);
  check('no link to pass', v.saver.released.length === 1 && v.saver.released[0].link === null, v.saver.released);
  v.engine.close();
}

current = 'spec 2.5: the saves get the place\'s chapter label with its book time';
{
  const t = await openHeld(MULTI.key, { web: null, plex: null });
  t.engine.seek(1550000);
  const last = t.saver.notes[t.saver.notes.length - 1];
  check('the label of the chapter the place is in', last.placeMs === 1550000 && last.placeLabel === 'Part 3 of 3', last);
  t.engine.close();
}

// ---- 14. Boot in the page (happy-dom) ----
current = 'boot mounts one audio element in #wsPlayer and sets WS.player';
{
  const win = new Window({ url: 'https://ws.test/news' });
  win.document.write('<!DOCTYPE html><html><body><main></main><div id="wsPlayer" hidden></div></body></html>');
  win.WS = {};
  const clock = fakeClock();
  const net = makeNet();
  // The engine's own cases run without saves (saver: null given); boot with
  // no saves at all refuses to open (the next case).
  const overrides = {
    fetch: makeFetch(net),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    mediaSession: null,
    MediaMetadata: null,
    saver: null
  };
  check('boot is exported', typeof E.boot === 'function');
  const engine = E.boot(win, overrides);
  check('WS.player is the engine', win.WS.player === engine && typeof engine.open === 'function');
  check('booting twice keeps one engine', E.boot(win, overrides) === engine);
  const player = win.document.getElementById('wsPlayer');
  check('one audio element in #wsPlayer', player.querySelectorAll('audio').length === 1);
  check('#wsPlayer stays hidden (no UI yet)', player.hidden === true);
  const p = engine.open(MULTI.key);
  await clock.advance(1600);                   // happy-dom's audio never loads: the probe times out
  await p;
  const html = win.document.documentElement.outerHTML;
  const hits = html.split(TOKEN).length - 1;
  check('the token is in the document once', hits === 1, hits);
  check('and only in the audio element\'s src', (player.querySelector('audio').getAttribute('src') || '').indexOf(TOKEN) !== -1);
  check('a page without #wsPlayer boots nothing', E.boot(Object.assign(new Window({ url: 'https://ws.test/' }), { WS: {} }), overrides) === null);
  engine.close();
  await win.happyDOM.close();
}

// Fix round 1 (T2S1): saves.js that fails to load or run (a syntax an old
// Safari can't parse) leaves no WS.playerSaves. The engine must never then
// open a book at 0:00 with nothing saved: it refuses, with a clear message.
current = 'boot without the saves refuses to open any book: "The player couldn\'t start. Please update your browser."';
for (const how of ['no WS.playerSaves', 'browserSaver throws']) {
  const win = new Window({ url: 'https://ws.test/news' });
  win.document.write('<!DOCTYPE html><html><body><main></main><div id="wsPlayer" hidden></div></body></html>');
  win.WS = how === 'no WS.playerSaves' ? {} : { playerSaves: { browserSaver() { throw new SyntaxError('bad'); } } };
  const clock = fakeClock();
  const net = makeNet();
  net.positions = { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: '2026-09-30T11:00:00.000Z' }, plex: null };
  const engine = E.boot(win, { fetch: makeFetch(net), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, mediaSession: null, MediaMetadata: null });
  const errors = [];
  engine.on('error', (e) => errors.push(e));
  const p = engine.open(MULTI.key);
  await clock.advance(3000);
  await p;
  const s = engine.state();
  check(how + ': the message', errors.length === 1 && errors[0].code === 'unsupported' && errors[0].retry === null &&
    errors[0].message === "The player couldn't start. Please update your browser." && s.error && s.error.code === 'unsupported', errors);
  check(how + ': nothing fetched, loaded or played', net.fetches.length === 0 && !win.document.querySelector('audio').getAttribute('src') &&
    s.book === null && s.position === null && !s.playing, net.fetches);
  await engine.play();
  await engine.retry();
  await clock.advance(3000);
  check(how + ': Play and Retry do nothing', net.fetches.length === 0 && !engine.state().playing);
  engine.close();
  await win.happyDOM.close();
}

current = 'fix round 1 (T2S1): the player\'s code parses on Safari before 16.4 (no lookbehind, no newer syntax)';
{
  const dir = join(here, '../../static/js/player');
  const paths = { 'engine.js': ENGINE, 'saves.js': process.env.SAVES_JS || join(dir, 'saves.js'),
    'features.js': process.env.FEATURES_JS || join(dir, 'features.js'), 'ui.js': process.env.UI_JS || join(dir, 'ui.js') };
  for (const f of Object.keys(paths)) {
    const code = readFileSync(paths[f], 'utf8');
    const hits = code.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) =>
      /\(\?<[=!]|\(\?<[A-Za-z]|\.at\(|\.findLast|Object\.hasOwn|structuredClone|toWellFormed|\?\?=|\|\|=|&&=|static \{/.test(l));
    check(f + ': none', hits.length === 0, hits.map(([n]) => n));
  }
}

// ---- Spec 2.6: the preview ceiling ----
// A preview stops after PREVIEW_CEILING_MS (60 s) of wall clock spent
// playing, whatever the element reports. Every timeupdate here comes after a
// stall: with a 'waiting' before it (the 15 s budget never counts a stall),
// or with none reported (each step then counts 1 s at most).
class StallEvery extends FakeAudio {
  tick(g) {
    this.env.clock.setTimeout(() => {
      if (g !== this.gen || this.paused || !this.ticking) return;
      if (this.env.waitingFirst) this.fire('waiting');
      this._t = Math.min(this.duration, this._t + 0.25 * this.playbackRate);
      this.fire('timeupdate');
      this.tick(g);
    }, this.env.stallEvery);
  }
}

current = 'spec 2.6: a preview stops at 60 s of wall clock under a stall before every timeupdate';
check('the ceiling is 60 s', E.PREVIEW_CEILING_MS === 60000);
for (const [name, waiting, every] of [['a stall and a waiting before every timeupdate', true, 2500], ['a stall the element never reports', false, 5000]]) {
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true, Audio: StallEvery } });
  t.env.stallEvery = every;
  t.env.waitingFirst = waiting;
  t.engine.previewAt(700000);
  await t.clock.advance(55000);
  check(name + ': still playing at 55 s', t.engine.state().playing && !t.main.paused, bookMsOf(t));
  await t.clock.advance(5000);
  const s = t.engine.state();
  check(name + ': stopped at 60 s, still held, nothing saved', !s.playing && t.main.paused && s.filesChanged !== null && t.saver.released.length === 0 &&
    t.saver.notes.every((n) => !n.place), [s.playing, t.main.paused]);
  check(name + ': it heard well under the 15 s of the book', bookMsOf(t) - 700000 < 12000, bookMsOf(t));
  await t.clock.advance(60000);
  check(name + ': and stays stopped', !t.engine.state().playing && t.log.error.length === 0);
  t.engine.close();
}

current = 'spec 2.6: a paused preview does not spend the ceiling, and a replaced one starts it again';
{
  const t = await openHeld(MULTI.key, { web: GONE, plex: null }, { setup: { wall: true, Audio: StallEvery } });
  t.env.stallEvery = 2500;
  t.env.waitingFirst = true;
  t.engine.previewAt(700000);
  await t.clock.advance(30000);
  t.engine.pause();
  await t.clock.advance(10 * 60000);
  check('paused for ten minutes: not playing, the preview still waits', !t.engine.state().playing && t.engine.state().filesChanged !== null);
  await t.engine.play();
  await t.clock.advance(25000);
  check('resumed: 55 s used, still playing', t.engine.state().playing, bookMsOf(t));
  await t.clock.advance(6000);
  check('61 s used: stopped', !t.engine.state().playing && t.main.paused, bookMsOf(t));
  // A new preview (the listener presses Preview on another spot) is a fresh 60 s.
  t.engine.previewAt(800000);
  await t.clock.advance(55000);
  check('a fresh preview: playing at 55 s', t.engine.state().playing);
  t.engine.previewAt(900000);
  await t.clock.advance(55000);
  check('replaced while playing: its own 60 s, playing at 55 s of the second', t.engine.state().playing);
  await t.clock.advance(6000);
  check('and stopped after', !t.engine.state().playing);
  t.engine.close();
}

// ---- Spec 2.6: the safety net ----
const ORPHAN_A = { key: '400:1', book_title: 'Three Parts (First Edition)', narrator: 'N. Reader', book_ms: 720000, book_duration_ms: 3600000,
  chapter_label: 'Chapter 4', updated_at: '2026-09-30T10:00:00.000Z', author_match: true };
const ORPHAN_B = { key: '410:1', book_title: 'Another Old One', narrator: null, book_ms: 60000, book_duration_ms: null,
  chapter_label: null, updated_at: '2026-09-20T10:00:00.000Z', author_match: false };
const ORPHAN_URL = '/api/player/orphans/' + encodeURIComponent(MULTI.key);
const asked = (t) => t.net.fetches.filter((u) => u.indexOf('/api/player/orphans/') === 0);
async function openNet(o = {}) {
  return openHeld(MULTI.key, { web: null, plex: null }, Object.assign({ net: { orphans: [ORPHAN_A, ORPHAN_B] } }, o));
}

current = 'spec 2.6: a book with no place of the listener\'s asks, and holds while the question is open';
{
  const t = await openNet();
  const s = t.engine.state();
  check('asked exactly once', asked(t).length === 1 && asked(t)[0] === ORPHAN_URL, asked(t));
  check('state().safetyNet lists the places', s.safetyNet && s.safetyNet.orphans.length === 2 && s.safetyNet.orphans[0].key === '400:1' &&
    s.safetyNet.orphans[0].book_title === 'Three Parts (First Edition)' && s.safetyNet.orphans[0].book_ms === 720000 &&
    s.safetyNet.orphans[1].narrator === null && s.safetyNet.orphans[1].book_duration_ms === null, s.safetyNet);
  check('it is not the files-changed hold', s.filesChanged === null);
  const w = t.log.warning.filter((x) => x.kind === 'safety-net');
  check('one safety-net warning, after the open, for this book', w.length === 1 && w[0].book === MULTI.key && w[0].orphans.length === 2 &&
    t.log.raw.findIndex((x) => x[0] === 'warning') > t.log.raw.findIndex((x) => x[0] === 'change' && x[1].reason === 'open'), t.log.warning);
  check('loaded at the start, paused, even though the open was to play', !s.playing && t.main.paused && s.position.track === '501' && s.position.offset_ms === 0 &&
    partOf(t.main) === MULTI.tracks[0].part_path, [s.playing, s.position]);
  check('the saves were started held, and the local copy kept', t.saver.starts.length === 1 && t.saver.starts[0].o.files === true &&
    t.saver.starts[0].o.keepLocal === true && !t.saver.starts[0].o.push, t.saver.starts[0].o);
  t.engine.close();
  check('closed: no question, nothing released, no timer left', t.engine.state().safetyNet === null && t.saver.released.length === 0 && t.live.size === 0, t.live.size);
}

current = 'spec 2.6: it asks only for a book with no place at all, never for a read that failed or a given place';
{
  const mid = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: '2026-09-30T11:00:00.000Z', device: 'Chrome on Windows' };
  const cases = [
    ['a WebServarr place in a part the book has', { web: mid, plex: null }, undefined],
    ['a Plex place alone', { web: null, plex: Object.assign({}, mid, { device: 'Plex' }) }, undefined],
    ['a place in a part the book no longer has (files changed)', { web: GONE, plex: null }, undefined],
    ['a place from a linked earlier copy', { web: Object.assign({}, GONE, { linked_from: '400:1' }), plex: null }, undefined],
    ['the place is given (opts.at)', { web: null, plex: null }, { at: { track: '502', offset_ms: 1000 }, autoplay: false }],
    ['resume turned off', { web: null, plex: null }, { resume: false }]
  ];
  for (const [name, positions, opts] of cases) {
    const t = await openHeld(MULTI.key, positions, { net: { orphans: [ORPHAN_A] }, opts });
    check(name + ': not asked, no question', asked(t).length === 0 && t.engine.state().safetyNet === null, asked(t));
    t.engine.close();
  }
  const own = await openHeld(MULTI.key, { web: mid, plex: null }, { net: { orphans: [ORPHAN_A] } });
  check('a place in the book is resumed as ever, not held', own.engine.state().filesChanged === null && own.engine.state().playing &&
    own.engine.state().position.track === '502', own.engine.state().position);
  own.engine.close();
  // No saver (the engine's own test mode): there is nothing to ask for.
  const bare = setup({ net: { orphans: [ORPHAN_A] } });
  const p = bare.engine.open(MULTI.key);
  await bare.clock.advance(1000);
  await p;
  check('no saver: not asked', asked(bare).length === 0 && bare.engine.state().safetyNet === null);
  bare.engine.close();
}

current = 'spec 2.6: an opening place this browser kept is no place of the listener\'s; one they played here is';
for (const [name, own, asks] of [['kept only as the book\'s opening place', false, true], ['played here', true, false]]) {
  const saver = heldSaver();
  const local = { track: '502', offset_ms: 100000, duration_ms: 900000, updated_at: '2026-09-30T10:00:00.000Z', device: 'Chrome', own, acked: false, ackedAt: null };
  saver.readLocal = () => local;
  const base = saver.resumeFrom;
  saver.resumeFrom = (key, p) => base(key, p).concat([Object.assign({ source: 'local' }, local)]);
  const t = setup({ saver, net: { noLocal: true, positions: { web: null, plex: null }, orphans: [ORPHAN_A] } });
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(1000);
  await p;
  const s = t.engine.state();
  if (asks) {
    check(name + ': the question is asked, from the start, resuming nothing', asked(t).length === 1 && s.safetyNet !== null && s.resumedFrom === null && s.bookMs === 0 && !s.playing, [asked(t), s.resumedFrom, s.bookMs]);
  } else {
    check(name + ': not asked, resumed from it', asked(t).length === 0 && s.safetyNet === null && s.resumedFrom && s.resumedFrom.source === 'local' && s.bookMs >= 600000, [asked(t), s.resumedFrom]);
  }
  t.engine.close();
}

current = 'spec 2.6: a lookup that is empty or malformed opens the book as it always did';
{
  const none = [['no places', []], ['only malformed places', [{ key: '../x', book_title: 'x' }, { key: 5 }, null, 'x', { book_title: 'no key' }]]];
  for (const [name, orphans] of none) {
    const t = await openNet({ net: { orphans } });
    const s = t.engine.state();
    check(name + ': no question, playing from the start', s.safetyNet === null && s.filesChanged === null && s.playing && s.position.track === '501' &&
      t.saver.starts[0].o.files !== true, [s.safetyNet, s.playing]);
    check(name + ': the book played on without a warning', t.log.warning.every((x) => x.kind !== 'safety-net'));
    t.engine.close();
  }
}

// T3H2: a lookup that FAILED is not "none". The book never plays or saves on
// its own: it stays held, and the listener tries again or starts it as new.
current = 'T3H2: a failed lookup holds the book with nothing saved, and says so';
{
  const bad = [['a 503', 503], ['a 500', 500], ['a 404', 404], ['a network error', 'throw'], ['not a list', { x: 1 }]];
  for (const [name, orphans] of bad) {
    const t = await openNet({ net: { orphans } });
    const s = t.engine.state();
    check(name + ': held, failed, no places', s.safetyNet !== null && s.safetyNet.failed === true && s.safetyNet.orphans.length === 0 && s.filesChanged === null, s.safetyNet);
    check(name + ': not playing, at the start, saves held', !s.playing && t.main.paused && s.bookMs === 0 && t.saver.starts[0].o.files === true && t.saver.starts[0].o.keepLocal === true, [s.playing, t.saver.starts[0].o]);
    const w = t.log.warning.filter((x) => x.kind === 'safety-net');
    check(name + ': a safety-net warning that says failed', w.length === 1 && w[0].failed === true && w[0].orphans.length === 0, t.log.warning);
    await t.engine.play();
    t.ms.handlers.get('play')();
    await t.clock.advance(6 * 60000);
    await t.engine.toggle();
    check(name + ': nothing plays or saves, however long it waits', !t.engine.state().playing && t.main.paused && t.saver.notes.every((n) => !n.playing) && t.saver.released.length === 0);
    check(name + ': a pick and a dismiss have nothing to act on', t.engine.pickOrphan('400:1') === false && t.engine.dismissOrphans() === false && (t.net.dismissals || []).length === 0);
    t.engine.close();
  }
  // Slow: given up on after 5 s, held as failed.
  const saver = heldSaver();
  const t = setup({ saver, net: { noLocal: true, positions: { web: null, plex: null }, orphans: [ORPHAN_A], orphansDelay: 9000 } });
  const p = t.engine.open(MULTI.key);
  await t.clock.advance(4500);
  check('waiting at 4.5 s: not open yet', t.engine.state().book === null && t.engine.state().loading === true, t.engine.state().loading);
  await t.clock.advance(1500);
  await p;
  check('given up at 5 s: the book is held as failed, not playing', t.engine.state().book === MULTI.key && !t.engine.state().playing &&
    t.engine.state().safetyNet !== null && t.engine.state().safetyNet.failed === true, [t.engine.state().book, t.engine.state().playing]);
  await t.clock.advance(10000);
  check('and the late answer changes nothing', t.engine.state().safetyNet.failed === true && !t.engine.state().playing && saver.released.length === 0);
  t.engine.close();
  check('the wait leaves no timer', t.live.size === 0, t.live.size);
  // Plex could not be read (and no other copy): a place may be unseen, so it is held as failed too.
  const x = await openHeld(MULTI.key, { web: null, plex: null, plex_error: true }, { net: { orphans: [ORPHAN_A] } });
  check('plex_error with no copy: held as failed, no lookup made', x.engine.state().safetyNet && x.engine.state().safetyNet.failed === true && !x.engine.state().playing && asked(x).length === 0, [x.engine.state().safetyNet, asked(x)]);
  x.engine.close();
  // ... but a copy the listener does have still resumes, as ever.
  const mid = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: '2026-09-30T11:00:00.000Z', device: 'Chrome on Windows' };
  const y = await openHeld(MULTI.key, { web: mid, plex: null, plex_error: true }, { net: { orphans: 503 } });
  check('plex_error with a web copy: resumes as ever', y.engine.state().safetyNet === null && y.engine.state().playing && y.engine.state().position.track === '502');
  y.engine.close();
  // Closed during the wait: nothing opens.
  const u = setup({ saver: heldSaver(), net: { noLocal: true, positions: { web: null, plex: null }, orphans: [ORPHAN_A], orphansDelay: 3000 } });
  const q = u.engine.open(MULTI.key);
  await u.clock.advance(500);
  u.engine.close();
  await u.clock.advance(6000);
  await q;
  check('closed during the wait: no book, no question', u.engine.state().book === null && u.engine.state().safetyNet === null && u.main.paused);
}

current = 'T3H2: "Try again" runs the lookup again, and what it finds decides';
{
  // Still failing: the same hold again, nothing played or saved.
  const t = await openNet({ net: { orphans: 503 } });
  const reads = t.net.fetches.filter((u) => u.indexOf('/position/') !== -1).length;
  check('try again', t.engine.retryOrphans() === true);
  await t.clock.advance(1000);
  check('read again and asked again', asked(t).length === 2 && t.net.fetches.filter((u) => u.indexOf('/position/') !== -1).length === reads + 1, asked(t));
  check('still held as failed, nothing played or saved', t.engine.state().safetyNet && t.engine.state().safetyNet.failed === true && !t.engine.state().playing && t.saver.released.length === 0);
  // Now it answers with places: the question.
  t.net.orphans = [ORPHAN_A, ORPHAN_B];
  check('try again', t.engine.retryOrphans() === true);
  await t.clock.advance(1000);
  const s = t.engine.state();
  check('the question, with the places', s.safetyNet && s.safetyNet.failed === false && s.safetyNet.orphans.length === 2 && !s.playing, s.safetyNet);
  check('a pick works from it', t.engine.pickOrphan('400:1') === true);
  t.engine.close();
  // Now it answers "none": the book opens as new and plays (the open was to play).
  const u = await openNet({ net: { orphans: 503 } });
  u.net.orphans = [];
  u.engine.retryOrphans();
  await u.clock.advance(1500);
  check('none: no question, playing from the start', u.engine.state().safetyNet === null && u.engine.state().playing && u.engine.state().position.track === '501');
  u.engine.close();
  // Not a failed lookup: nothing to try again.
  const v = await openNet();
  check('a question is not a failure: nothing to try again', v.engine.retryOrphans() === false);
  v.engine.close();
  // Plex readable now and a place there: the book resumes at it.
  const plexHeld = await openHeld(MULTI.key, { web: null, plex: null, plex_error: true }, {});
  plexHeld.net.positions = { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: '2026-09-30T11:00:00.000Z', device: 'Plex' }, plex: null };
  plexHeld.engine.retryOrphans();
  await plexHeld.clock.advance(1500);
  check('a place found by the second try is resumed', plexHeld.engine.state().safetyNet === null && plexHeld.engine.state().position.track === '502', plexHeld.engine.state());
  plexHeld.engine.close();
}

current = 'T3H2: "Start this book" is an explicit choice: a new book, stored nowhere, playing if the open was to play';
{
  const t = await openNet({ net: { orphans: 503 } });
  check('start', t.engine.startAsNew() === true);
  await t.clock.advance(1000);
  const s = t.engine.state();
  check('released as a new book, nothing placed, nothing stored on the server', t.saver.released.length === 1 && t.saver.released[0].link === null &&
    t.saver.releasedOpts[0].startOver === true && t.saver.notes.every((n) => !n.place) && (t.net.dismissals || []).length === 0, [t.saver.released, t.net.dismissals]);
  check('the hold is over and it plays from the start', s.safetyNet === null && s.playing && s.position.track === '501');
  check('a second start has nothing to do', t.engine.startAsNew() === false);
  t.engine.close();
  const u = await openNet({ net: { orphans: 503 }, opts: { autoplay: false } });
  u.engine.startAsNew();
  await u.clock.advance(1000);
  check('autoplay off: released, ready, not playing', u.engine.state().safetyNet === null && !u.engine.state().playing && u.saver.released.length === 1);
  u.engine.close();
  // Not for a question with places: that is "None of these".
  const v = await openNet();
  check('with places it is refused (None of these is the answer)', v.engine.startAsNew() === false && v.engine.state().safetyNet !== null);
  v.engine.close();
}

current = 'T3H1: "None of these" after a long wait reads the saved places first, and never saves 0:00 over a newer one';
{
  const t = await openNet({ setup: { wall: true } });
  const asks = [];
  t.saver.lastSeen = () => ({ base: null, psid: 'me', conflict: null });     // what the real saver says of a running book
  t.saver.otherSaved = (book, conflict) => { asks.push(conflict); return true; };
  await t.clock.advance(5 * 60000 + 1000);
  // A Plex app saved a place meanwhile.
  t.net.positions = { web: null, plex: { track: '503', offset_ms: 100000, duration_ms: 300000, updated_at: '2026-09-30T12:00:01.000Z', device: 'Plexamp' } };
  const reads = t.net.fetches.filter((u) => u.indexOf('/position/') !== -1).length;
  t.engine.dismissOrphans();
  await t.clock.advance(5000);
  check('the saved places were read again before anything played', t.net.fetches.filter((u) => u.indexOf('/position/') !== -1).length === reads + 1, t.net.fetches);
  check('the listener is asked about the Plex app\'s place', asks.length === 1 && asks[0].track === '503' && asks[0].device === 'Plexamp', asks);
  check('nothing played, nothing was offered to the saves as played at 0:00', !t.engine.state().playing && t.saver.notes.every((n) => !n.playing), t.saver.notes.map((n) => [n.reason, n.playing, n.placeMs]));
  t.engine.close();
  // Within five minutes it plays at once, as any new book.
  const u = await openNet({ setup: { wall: true } });
  await u.clock.advance(60000);
  u.engine.dismissOrphans();
  await u.clock.advance(2000);
  check('a short wait: plays at once, no re-read', u.engine.state().playing && u.net.fetches.filter((x) => x.indexOf('/position/') !== -1).length === 1, u.net.fetches);
  u.engine.close();
}

current = 'T3U1: "Not this book" goes back from a pick to the list, saving nothing';
{
  const t = await openNet();
  t.engine.pickOrphan('400:1');
  await t.engine.play();                                // a preview in the helper
  await t.clock.advance(3000);
  t.engine.skip(30);
  check('the helper is up, the spot moved', t.engine.state().filesChanged !== null && t.engine.state().bookMs > 0);
  check('back', t.engine.unpickOrphan() === true);
  const s = t.engine.state();
  check('the list again, the same places, not failed', s.safetyNet && s.safetyNet.failed === false && s.safetyNet.orphans.length === 2 && s.filesChanged === null, s);
  check('back at the start, paused, nothing saved or released', s.bookMs === 0 && !s.playing && t.main.paused && t.saver.released.length === 0 && t.saver.notes.every((n) => !n.place), [s.bookMs, s.playing]);
  const w = t.log.warning.filter((x) => x.kind === 'safety-net');
  check('a safety-net warning again, for the panel', w.length === 2 && w[1].orphans.length === 2 && w[1].failed === false, t.log.warning.map((x) => x.kind));
  await t.engine.play();
  await t.clock.advance(3000);
  check('held as ever: nothing plays', !t.engine.state().playing && t.main.paused);
  check('and it can be picked again, or dismissed', t.engine.pickOrphan('410:1') === true && t.engine.state().filesChanged.old.linked_from === '410:1');
  t.engine.close();
  // Not after a confirm has started, nor for an automatic link, nor without a pick.
  const u = await openNet();
  u.engine.pickOrphan('400:1');
  u.engine.confirmPlace(650000);
  check('a confirm waiting: refused', u.engine.unpickOrphan() === false && u.engine.state().filesChanged !== null);
  await u.clock.advance(6000);
  check('placed: nothing to go back to', u.engine.unpickOrphan() === false);
  u.engine.close();
  const v = await openNet();
  check('a question with no pick: refused', v.engine.unpickOrphan() === false && v.engine.state().safetyNet !== null);
  v.engine.close();
  const w2 = await openHeld(MULTI.key, { web: GONE, plex: null }, {});
  check('files changed (no pick): refused', w2.engine.unpickOrphan() === false && w2.engine.state().filesChanged !== null);
  w2.engine.close();
}

current = 'spec 2.6: the open gate (the handoff question) is not asked while the safety net asks';
{
  const g = setup({ saver: heldSaver(), net: { noLocal: true, positions: { web: null, plex: null }, orphans: [ORPHAN_A] } });
  let asks = 0;
  g.engine.setOpenGate(() => { asks += 1; return null; });
  const gp = g.engine.open(MULTI.key);
  await g.clock.advance(1000);
  await gp;
  check('not asked, and the question is open', asks === 0 && g.engine.state().safetyNet !== null, asks);
  g.engine.close();
}

current = 'spec 2.6: while the question is open nothing plays and nothing is saved, the lock screen included';
{
  const t = await openNet();
  const reads = t.net.fetches.filter((x) => x.indexOf('/position/') !== -1).length;
  await t.engine.play();
  await t.engine.toggle();
  await t.engine.retry();
  const h = t.ms.handlers;
  h.get('play')();
  h.get('seekto')({ seekTime: 300 });
  h.get('seekforward')({});
  h.get('seekbackward')({});
  t.engine.skip(30);
  t.engine.seek(300000);
  t.engine.rewind(300000);
  t.engine.jumpToChapter(1);
  await t.main.play();                                  // the element started from outside the engine
  await t.clock.advance(6 * 60000);
  await t.engine.play();                                // after a long quiet: no late read either
  h.get('play')();
  await t.clock.advance(10000);
  const s = t.engine.state();
  check('not playing, the element paused, at the start', !s.playing && t.main.paused && s.bookMs === 0 && s.safetyNet !== null, [s.playing, t.main.paused, s.bookMs]);
  check('no place was ever offered to the saves as played or moved', t.saver.notes.every((n) => !n.playing && n.reason !== 'play' && n.reason !== 'seek' &&
    n.reason !== 'skip' && n.reason !== 'jump' && n.reason !== 'preview'), t.saver.notes.map((n) => n.reason));
  check('nothing released, nothing re-read', t.saver.released.length === 0 &&
    t.net.fetches.filter((x) => x.indexOf('/position/') !== -1).length === reads, t.net.fetches);
  check('a preview is refused too', t.engine.previewAt(0) === false && t.engine.confirmPlace(0) === false && t.engine.startOver() === false);
  // Opening the same book again does not play it either.
  await t.engine.open(MULTI.key);
  check('the same book opened again: still held', !t.engine.state().playing && t.engine.state().safetyNet !== null);
  t.engine.close();
}

current = 'spec 2.6: the error\'s Retry is held too while the question is open';
{
  // The question's book can't reach its media server: the open's error has a Retry.
  const t = await openNet({ net: { orphans: [ORPHAN_A], down: new Set(['remote']) } });
  const err = t.log.raw.filter((x) => x[0] === 'error').pop();
  check('unreachable, with a retry, and the question open', err && typeof err[1].retry === 'function' && t.engine.state().safetyNet !== null, t.log.error);
  t.net.down.clear();
  await err[1].retry();
  await t.engine.retry();
  await t.clock.advance(5000);
  check('Retry plays nothing and saves nothing', !t.engine.state().playing && t.main.paused && t.saver.released.length === 0 &&
    t.saver.notes.every((n) => !n.playing), [t.engine.state().playing, t.saver.notes.map((n) => n.reason)]);
  t.engine.close();
}

current = 'spec 2.6: a pick goes through the "files changed" helper as a manually linked earlier copy';
{
  const t = await openNet();
  check('a key that was not offered is refused', t.engine.pickOrphan('999:9') === false && t.engine.state().safetyNet !== null);
  check('so is a key that is not a key', t.engine.pickOrphan(undefined) === false && t.engine.pickOrphan('') === false);
  check('the pick', t.engine.pickOrphan('400:1') === true);
  const s = t.engine.state();
  const old = s.filesChanged && s.filesChanged.old;
  check('the question is over; filesChanged is the picked place', s.safetyNet === null && !!old, s);
  check('it is an earlier copy, by hand, with its names and times', old.linked_from === '400:1' && old.manual === true && old.source === 'orphan' &&
    old.book_ms === 720000 && old.book_duration_ms === 3600000 && old.chapter_label === 'Chapter 4' && old.book_title === 'Three Parts (First Edition)' &&
    old.narrator === 'N. Reader' && old.updated_at === ORPHAN_A.updated_at, old);
  const w = t.log.warning.filter((x) => x.kind === 'files-changed');
  check('one files-changed warning with it, for the helper', w.length === 1 && w[0].book === MULTI.key && w[0].old.linked_from === '400:1' && w[0].old.manual === true, t.log.warning);
  check('still held and unsaved', t.saver.released.length === 0 && !s.playing && s.bookMs === 0 && s.filesChanged.spot === 0);
  check('a second pick has nothing to pick', t.engine.pickOrphan('410:1') === false);
  // Play is now a bounded preview, as in the 2.5 hold.
  await t.engine.play();
  await t.clock.advance(20000);
  check('a Play is only a preview now', !t.engine.state().playing && t.engine.state().filesChanged !== null && t.saver.released.length === 0 &&
    bookMsOf(t) >= 14000 && bookMsOf(t) <= 16000, bookMsOf(t));
  check('the confirm', t.engine.confirmPlace(650000) === true);
  await t.clock.advance(6000);
  check('released once with the link, by hand', t.saver.released.length === 1 && t.saver.released[0].link === '400:1' &&
    t.saver.releasedOpts[0].manual === true && t.saver.releasedOpts[0].startOver === false && t.engine.state().filesChanged === null && bookMsOf(t) === 650000,
    [t.saver.released, t.saver.releasedOpts, bookMsOf(t)]);
  t.engine.close();
  // Start from the beginning sends no link.
  const u = await openNet();
  u.engine.pickOrphan('410:1');
  check('startOver', u.engine.startOver() === true);
  await u.clock.advance(6000);
  check('released with no link', u.saver.released.length === 1 && u.saver.released[0].link === null && u.saver.releasedOpts[0].startOver === true, u.saver.released);
  u.engine.close();
}

current = 'spec 2.6: "None of these" is stored, ends the hold, and the book is a new book';
{
  const t = await openNet();
  check('dismiss', t.engine.dismissOrphans() === true);
  await t.clock.advance(1000);
  const s = t.engine.state();
  check('stored on the server, once, for this book', t.net.dismissals && t.net.dismissals.length === 1 && t.net.dismissals[0] === ORPHAN_URL + '/dismiss', t.net.dismissals);
  check('the question is over, nothing else is held', s.safetyNet === null && s.filesChanged === null);
  check('the saves were released as a new book: no link, nothing placed', t.saver.released.length === 1 && t.saver.released[0].link === null &&
    t.saver.releasedOpts[0].startOver === true && t.saver.notes.every((n) => !n.place), [t.saver.released, t.saver.releasedOpts]);
  check('the open was to play, so it plays from the start', s.playing && s.bookMs < 5000 && s.position.track === '501', [s.playing, s.bookMs]);
  check('a second dismiss has nothing to do', t.engine.dismissOrphans() === false && t.net.dismissals.length === 1);
  check('and a pick has nothing to pick', t.engine.pickOrphan('400:1') === false);
  t.engine.close();
  // An open that was only to load stays paused.
  const u = await openNet({ opts: { autoplay: false } });
  u.engine.dismissOrphans();
  await u.clock.advance(2000);
  check('autoplay off: released, not playing', u.engine.state().safetyNet === null && !u.engine.state().playing && u.saver.released.length === 1);
  await u.engine.play();
  await u.clock.advance(2000);
  check('then Play plays', u.engine.state().playing);
  u.engine.close();
  // The server could not store it: the listener's answer still stands for this open.
  const v = await openNet({ net: { orphans: [ORPHAN_A], dismissStatus: 503 } });
  const before = consoleSeen.length;
  v.engine.dismissOrphans();
  await v.clock.advance(2000);
  check('a failed store: still released, and logged', v.engine.state().safetyNet === null && v.saver.released.length === 1 &&
    consoleSeen.slice(before).some((l) => l.indexOf('None of these') !== -1), consoleSeen.slice(before));
  v.engine.close();
}

if (failed) {
  realError(`${failed}/${total} player engine cases FAILED`);
  process.exit(1);
}
console.log = (...a) => process.stdout.write(a.join(' ') + '\n');
console.log(`${total}/${total} player engine cases pass`);
