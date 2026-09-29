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
// one file, and a book whose middle part is one, between two mp3 parts.
const ATMOS_MS = 20 * 3600 * 1000;
const EAC3 = { container: 'mp4', codec: 'eac3', profile: 'dolby digital plus + dolby atmos' };
const ATMOS = {
  key: '800:1', title: 'Loud Book', author: 'C. Writer', narrator: '', series: '',
  cover: '', duration_ms: ATMOS_MS, shape: 'single',
  tracks: [{ key: '801', part_path: '/library/parts/981/1/file.m4b', duration_ms: ATMOS_MS, index: 1, ...EAC3 }],
  chapters: [
    { index: 1, label: 'Chapter 1 of 2', start_ms: 0, end_ms: 36000000, track: '801', track_start_ms: 0, track_end_ms: 36000000 },
    { index: 2, label: 'Chapter 2 of 2', start_ms: 36000000, end_ms: ATMOS_MS, track: '801', track_start_ms: 36000000, track_end_ms: ATMOS_MS }
  ]
};
const MIXED = {
  key: '900:1', title: 'Mixed Parts', author: 'D. Writer', narrator: '', series: '',
  cover: '', duration_ms: 1800000, shape: 'parts',
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
// Two transcoded parts in a row.
const TWIN = {
  key: '950:1', title: 'Twin Parts', author: 'E. Writer', narrator: '', series: '',
  cover: '', duration_ms: 1200000, shape: 'parts',
  tracks: [
    { key: '951', part_path: '/library/parts/951/1/file.m4b', duration_ms: 600000, index: 1, ...EAC3 },
    { key: '952', part_path: '/library/parts/952/1/file.m4b', duration_ms: 600000, index: 2, ...EAC3 }
  ],
  chapters: [
    { index: 1, label: 'Part 1 of 2', start_ms: 0, end_ms: 600000, track: '951', track_start_ms: 0, track_end_ms: 600000 },
    { index: 2, label: 'Part 2 of 2', start_ms: 600000, end_ms: 1200000, track: '952', track_start_ms: 0, track_end_ms: 600000 }
  ]
};
const BOOKS = { [MULTI.key]: MULTI, [SINGLE.key]: SINGLE, [OTHER.key]: OTHER, [ATMOS.key]: ATMOS, [MIXED.key]: MIXED, [TWIN.key]: TWIN };
const trackByPath = new Map();
const trackByKey = new Map();
for (const b of Object.values(BOOKS)) for (const t of b.tracks) { trackByPath.set(t.part_path, t); trackByKey.set(t.key, t); }
const TRANSCODE_PATH = '/music/:/transcode/universal/start.mp3';
// What a browser like Chrome answers canPlayType: '' for E-AC3, and '' for
// an empty type (as every browser does).
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
    bookStatus: 200,
    bookDetail: '',
    loads: [],          // every load an element started: { side, part, probe }
    fetches: [],        // every URL the engine fetched
    bodies: [],         // every request body the engine sent
    // Plex's transcoder, as the server's /api/player/transcode answers it:
    transcodeStatus: 200,   // what asking for a session answers
    askDelay: 0,            // ms before it answers
    asks: [],               // { key, track, client }
    decided: new Map(),     // session -> track key (Plex starts only these)
    noConvert: new Set(),   // track keys whose transcoded stream never loads (code 4)
    cutAt: new Map(),       // session -> element second where Plex ends the stream early, cleanly
    stops: [],              // sessions the engine ended
    events: [],             // asks and stops in order: ['ask', track] | ['stop', session]
    realDelta: new Map(),   // track key -> the real audio's length minus Plex's (ms)
    dropAtStart: false,     // every transcoded stream starts, then drops at once (code 2)
    pastEnd: 'fail',        // a start past the real audio: what Plex gives ('fail', as a
                            // real server does: a header and no audio; or 'empty')
    pagehide: []            // the engine's pagehide handlers
  };
}
const sideOf = (url) => url.startsWith(LOCAL + '/') ? 'local' : url.startsWith(REMOTE + '/') ? 'remote' : '?';

function answer(net, url) {
  const u = new URL(url);
  const side = sideOf(url);
  const part = u.pathname;
  if (part === TRANSCODE_PATH) {
    const sid = u.searchParams.get('session');
    const rk = (u.searchParams.get('path') || '').split('/').pop();
    const t = trackByKey.get(rk);
    const off = Number(u.searchParams.get('offset'));
    if (net.hang.has(side)) return { kind: 'hang', side, part: 'tc:' + rk };
    if (net.down.has(side) || u.searchParams.get('X-Plex-Token') !== net.token || !t ||
        net.decided.get(sid) !== rk || net.noConvert.has(rk) || !isFinite(off)) {
      return { kind: 'fail', side, part: 'tc:' + rk };
    }
    const real = t.duration_ms + (net.realDelta.get(rk) || 0);
    if (off * 1000 >= real && net.pastEnd === 'fail') return { kind: 'fail', side, part: 'tc:' + rk };
    return { kind: 'ok', side, part: 'tc:' + rk, transcode: true, sid, offset: off,
      durationMs: Math.max(0, real - off * 1000) };
  }
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
  canPlayType(mime) { return UNDECODABLE.has(mime) ? '' : 'probably'; }
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
    this._end = null;
    this.sid = null;
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
    this.sid = a.sid || null;
    this.env.net.loads.push({ side: a.side, part: a.part, probe: this.preload === 'metadata', url: this._src,
      sid: a.sid || null, offset: a.transcode ? a.offset : null });
    if (a.kind === 'hang') return;
    this.env.clock.setTimeout(() => {
      if (g !== this.gen) return;
      if (a.kind === 'fail') { this.error = { code: 4 }; this.fire('error'); return; }
      this.env.net.cached.add(this._src);
      // A transcoded stream is progressive: no length the element knows.
      this.duration = a.transcode ? Infinity : a.durationMs / 1000;
      this._end = a.transcode ? a.durationMs / 1000 : null;
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
      if (net.down.has(this.side) || (net.dropAtStart && this.sid !== null)) {
        this.ticking = false; this.error = { code: 2 }; this.fire('error'); return;
      }
      if (net.hang.has(this.side)) { this.ticking = false; this.fire('waiting'); return; }
      const bad = net.decodeAt.get(this.part);
      if (bad !== undefined && this._t >= bad) { this.ticking = false; this.error = { code: 3 }; this.fire('error'); return; }
      const once = net.glitchOnce.get(this.part);
      if (once !== undefined && this._t >= once) {
        net.glitchOnce.delete(this.part);
        this.ticking = false; this.error = { code: 3 }; this.fire('error'); return;
      }
      if (this.seeking) { this.tick(g); return; }
      const cut = this.sid !== null ? net.cutAt.get(this.sid) : undefined;
      const end = cut !== undefined ? cut : this._end !== null ? this._end : this.duration;
      this._t = Math.min(end, this._t + 0.25 * this.playbackRate);
      this.fire('timeupdate');
      if (this._t >= end) {
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

let sessionIds = 0;
function makeFetch(net, clock) {
  return async function (url, opts) {
    net.fetches.push(url);
    if (opts && opts.body !== undefined) net.bodies.push(String(opts.body));
    const tm = /^\/api\/player\/transcode\/([^?]+)$/.exec(url);
    if (tm) {
      const body = JSON.parse(opts.body);
      net.asks.push({ key: decodeURIComponent(tm[1]), track: body.track, client: body.client });
      net.events.push(['ask', body.track]);
      if (net.askDelay && clock) await new Promise((r) => clock.setTimeout(r, net.askDelay));
      if (net.transcodeStatus !== 200) return response(net.transcodeStatus, { detail: 'no' });
      const sid = 'ws' + String(++sessionIds).padStart(32, '0');
      net.decided.set(sid, body.track);
      return response(200, { session: sid, start: TRANSCODE_PATH + '?path=%2Flibrary%2Fmetadata%2F' + body.track +
        '&session=' + sid + '&X-Plex-Client-Identifier=webservarr-web-' + body.client });
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
    return response(200, { ...book, stream: { token: net.token, uris: { local: net.noLocal ? [] : [LOCAL], remote: [REMOTE] } } });
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
    createAudio: () => new FakeAudio(env),
    fetch: makeFetch(net, clock),
    setTimeout(fn, t) { const id = clock.setTimeout(() => { live.delete(id); fn(); }, t); live.add(id); return id; },
    clearTimeout(id) { live.delete(id); clock.clearTimeout(id); },
    mediaSession: ms,
    MediaMetadata: FakeMetadata,
    permissions: o.permissions,
    baseUrl: 'https://ws.test/news',
    clientId: 'testclient01',
    stopTranscode: (sid) => { net.stops.push(sid); net.events.push(['stop', sid]); },
    onPageHide: (fn) => { net.pagehide.push(fn); }
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

// ---- 17. Formats the browser cannot decode: Plex transcodes them (spec 11a) ----

const tcLoads = (t) => t.net.loads.filter((l) => !l.probe && l.part.startsWith('tc:'));
const rawLoads = (t, path) => t.net.loads.filter((l) => l.part === path);
const srcParams = (t) => (t.main.src ? new URL(t.main.src).searchParams : new URLSearchParams());
const ATMOS_PATH = ATMOS.tracks[0].part_path;

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

current = 'a format the browser plays streams direct, exactly as before';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key);          // part 1 is mp3
  check('the file itself', partOf(t.main) === MIXED.tracks[0].part_path && !t.main.paused);
  check('no transcode session asked for', t.net.asks.length === 0 && tcLoads(t).length === 0);
  t.engine.close();
  // An unknown codec is played direct too, and its failure follows the ladder as before.
  const u = setup({ net: { noLocal: true } });
  const odd = JSON.parse(JSON.stringify(SINGLE));
  odd.tracks[0].codec = 'dts';
  odd.tracks[0].container = 'mp4';
  BOOKS['650:1'] = Object.assign(odd, { key: '650:1' });
  await openPlaying(u, '650:1');
  check('an unknown codec plays direct', partOf(u.main) === SINGLE.tracks[0].part_path && u.net.asks.length === 0);
  u.engine.close();
  delete BOOKS['650:1'];
  // Plex giving no codec (or nothing at all) plays direct too.
  for (const fmt of [{ container: 'mp4', codec: '', profile: '' }, { container: '', codec: '', profile: '' }]) {
    const v = setup({ net: { noLocal: true } });
    const bare = JSON.parse(JSON.stringify(SINGLE));
    Object.assign(bare.tracks[0], fmt);
    BOOKS['651:1'] = Object.assign(bare, { key: '651:1' });
    await openPlaying(v, '651:1');
    check(`an empty codec plays direct (${JSON.stringify(fmt)})`, partOf(v.main) === SINGLE.tracks[0].part_path &&
      v.net.asks.length === 0, partOf(v.main));
    v.engine.close();
    delete BOOKS['651:1'];
  }
}

current = 'a format the browser cannot decode streams from Plex\'s transcoder';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key);
  check('a session was asked for, for the book\'s track, with this browser\'s id',
    t.net.asks.length === 1 && t.net.asks[0].key === ATMOS.key && t.net.asks[0].track === '801' &&
    t.net.asks[0].client === 'testclient01', t.net.asks);
  check('the element streams from the transcoder on the same connection', sideOf(t.main.src) === 'remote' &&
    new URL(t.main.src).pathname === TRANSCODE_PATH, partOf(t.main));
  check('from the start of the part', srcParams(t).get('offset') === '0.000');
  check('with its session and the token', t.net.decided.has(srcParams(t).get('session')) &&
    srcParams(t).get('X-Plex-Token') === TOKEN);
  check('the undecodable file itself is never loaded, not even by a probe', rawLoads(t, ATMOS_PATH).length === 0);
  check('it plays', !t.main.paused && t.engine.state().playing && t.engine.state().error === null);
  t.engine.close();
}

current = 'the decision comes before any probe: the local probe asks the transcoder too';
{
  const t = setup({ permissions: { query: async () => ({ state: 'granted' }) } });
  await openPlaying(t, ATMOS.key);
  const probes = t.net.loads.filter((l) => l.probe);
  check('a local probe ran', probes.length >= 1 && probes[0].side === 'local', probes);
  check('through the transcoder, with a session of its own', probes.every((l) => l.part === 'tc:801' && l.sid) &&
    new Set(probes.map((l) => l.sid)).size === probes.length);
  check('its session was ended after', probes.every((l) => t.net.stops.includes(l.sid)), t.net.stops);
  check('the file itself never loaded', rawLoads(t, ATMOS_PATH).length === 0);
  check('local plays, from a session other than the probe\'s', t.engine.state().connection === 'local' &&
    !probes.some((l) => l.sid === srcParams(t).get('session')));
  t.engine.close();
}

current = 'position in transcode mode is the offset base plus the element time';
{
  // At the start.
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key);
  await t.clock.advance(5000);
  let pos = t.engine.state().position;
  check('start: the track and the element time', pos.track === '801' && Math.abs(pos.offset_ms - Math.round(t.main.currentTime * 1000)) <= 1 &&
    pos.offset_ms > 4000 && pos.duration_ms === ATMOS_MS, pos);
  t.engine.close();
  // Mid-track (10 h in), resumed at a saved place.
  const m = setup({ net: { noLocal: true } });
  await openPlaying(m, ATMOS.key, { at: at('801', 36000000) });
  check('resume: the stream starts at the saved offset', srcParams(m).get('offset') === '36000.000', srcParams(m).get('offset'));
  check('resume: the element counts from 0', m.main.currentTime < 1);
  await m.clock.advance(5000);
  pos = m.engine.state().position;
  check('mid-track: base plus element time', pos.offset_ms === 36000000 + Math.round(m.main.currentTime * 1000) &&
    pos.offset_ms > 36004000 && pos.offset_ms < 36006000, pos);
  check('book time and chapter follow', m.engine.state().bookMs === pos.offset_ms && m.engine.state().chapterIndex === 1);
  check('the element\'s length is never taken (it has none)', m.main.duration === Infinity && m.engine.state().bookDurationMs === ATMOS_MS);
  check('every place reported was at or after the saved one', m.positions.every((p) => !p || p.offset_ms >= 36000000), m.positions);
  m.engine.close();
  // Near the end: plays out, ends at the part's length.
  const n = setup({ net: { noLocal: true } });
  await openPlaying(n, ATMOS.key, { at: at('801', ATMOS_MS - 8000) });
  const nsid = srcParams(n).get('session');
  await n.clock.advance(10000);
  check('near the end: ended once, at the part\'s length', n.log.ended.length === 1 &&
    n.engine.state().position.offset_ms === ATMOS_MS && n.log.error.length === 0, n.engine.state().position);
  check('its session is ended', n.net.stops.length === 1 && n.net.stops[0] === nsid, n.net.stops);
  check('one session in all', n.net.asks.length === 1);
  n.engine.close();
}

current = 'a seek restarts the transcode at the new offset, once it settles';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 1000000) });
  await t.clock.advance(2000);
  const sid = srcParams(t).get('session');
  const before = tcLoads(t).length;
  const mark = t.positions.length;
  const from = t.engine.state().position.offset_ms;
  // A burst: a seek and five skips 100 ms apart, as a listener scrubbing.
  t.engine.seek(50000000);
  for (let i = 0; i < 5; i++) { await t.clock.advance(100); t.engine.skip(30); }
  check('nothing restarted while moving', tcLoads(t).length === before);
  check('the old stream is let go at once (nothing plays from the old place)', !t.main.src);
  await t.clock.advance(399);
  check('not before it settles', tcLoads(t).length === before);
  await t.clock.advance(300);
  const loads = tcLoads(t).slice(before);
  check('one restart for the whole burst', loads.length === 1, loads.length);
  check('at the settled place', loads[0] && loads[0].offset === 50150, loads[0] && loads[0].offset);
  check('on the same session (Plex restarts it, no new decision)', loads[0] && loads[0].sid === sid && t.net.asks.length === 1);
  await t.clock.advance(3000);
  const after = t.positions.slice(mark).filter(Boolean);
  check('the place never went back toward the old one during the restart', after.every((p) => p.offset_ms >= 50000000) &&
    after.length > 0 && from < 50000000, after.map((p) => p.offset_ms));
  const p = t.engine.state().position.offset_ms;
  check('it plays on from the new place', !t.main.paused && p > 50150000 && p < 50154000, p);
  check('the seek events carry from and to', t.log.change.some((c) => c.reason === 'skip' && c.to === 50150000));
  t.engine.close();
}

current = 'a session answered after a seek never plays the old place';
{
  const t = setup({ net: { noLocal: true, askDelay: 300 } });
  const p = t.engine.open(ATMOS.key, { at: at('801', 1000000) });
  await t.clock.advance(100);                  // the first session is still being asked for
  await p;
  const mark = t.positions.length;
  t.engine.seek(5000000);
  await t.clock.advance(2000);
  const after = t.positions.slice(mark).filter(Boolean);
  check('never back at the old place', after.every((q) => q.offset_ms >= 5000000), after.map((q) => q.offset_ms));
  check('no stream ever started from the old place', tcLoads(t).every((l) => l.offset === 5000), tcLoads(t).map((l) => l.offset));
  check('it plays from the new place', !t.main.paused && srcParams(t).get('offset') === '5000.000');
  check('the stale session was ended', t.net.stops.length === 1 && t.net.stops[0] !== srcParams(t).get('session'), t.net.stops);
  t.engine.close();
}

current = 'play pressed while a seek settles does not play the old stream';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 1000000) });
  await t.clock.advance(1000);
  t.engine.pause();
  t.engine.seek(2000000);
  await t.engine.play();
  check('nothing plays yet', t.main.paused && !t.main.src);
  await t.clock.advance(1000);
  check('then the new stream plays, from the new place', !t.main.paused && srcParams(t).get('offset') === '2000.000');
  check('the place is the new one', t.engine.state().position.offset_ms >= 2000000);
  t.engine.close();
}

current = 'a paused seek restarts too, and play goes on from there';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 1000000) });
  t.engine.pause();
  t.engine.seek(3000000);
  await t.clock.advance(1000);
  check('loaded at the new place, not playing', t.main.paused && srcParams(t).get('offset') === '3000.000' &&
    t.engine.state().position.offset_ms === 3000000 && !t.engine.state().playing);
  await t.engine.play();
  await t.clock.advance(2000);
  const p = t.engine.state().position.offset_ms;
  check('play goes on from it', !t.main.paused && p > 3000000 && p < 3003000, p);
  t.engine.close();
}

current = 'part advance from a direct part to a transcoded one and back';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key, { at: at('901', 598000) });
  check('part 1 direct', partOf(t.main) === MIXED.tracks[0].part_path);
  await t.clock.advance(3000);
  check('part 2 from the transcoder at 0', new URL(t.main.src).pathname === TRANSCODE_PATH &&
    srcParams(t).get('offset') === '0.000' && t.net.asks.length === 1 && t.net.asks[0].track === '902', t.main.src && partOf(t.main));
  check('the place is part 2 once it plays', t.engine.state().position.track === '902');
  const sid = srcParams(t).get('session');
  t.engine.seek(1500000 - 2000);          // 2 s before part 2 ends
  await t.clock.advance(1000);
  await t.clock.advance(3000);
  check('part 3 direct again', partOf(t.main) === MIXED.tracks[2].part_path && !t.main.paused);
  check('part 2\'s session was ended on leaving it', t.net.stops.includes(sid), t.net.stops);
  check('no warnings or errors', t.log.warning.length === 0 && t.log.error.length === 0);
  const reasons2 = reasons(t);
  check('two natural advances', reasons2.filter((r) => r === 'part').length === 2, reasons2);
  t.engine.close();
}

current = 'a dropped transcoded stream takes the ladder and holds the place';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 7000000) });
  await t.clock.advance(4000);
  const held = t.engine.state().position.offset_ms;
  const mark = t.positions.length;
  t.net.down.add('remote');
  t.net.bookStatus = 503;
  await t.clock.advance(3000);
  const s = t.engine.state();
  check('"Can\'t reach the media server"', s.error && s.error.code === 'unreachable' && s.error.message === E.UNREACHABLE, s.error);
  check('never the format message, never a skip', t.log.warning.length === 0 && !t.log.error.some((e) => e.code === 'format'));
  check('the place is held', s.position.offset_ms === held && t.positions.slice(mark).every((p) => p && p.offset_ms === held),
    t.positions.slice(mark).map((p) => p && p.offset_ms));
  check('the undecodable file itself was never probed', rawLoads(t, ATMOS_PATH).length === 0);
  check('every probe asked the transcoder with a session of its own',
    t.net.loads.filter((l) => l.probe).every((l) => l.part === 'tc:801' && l.sid));
  t.net.down.clear();
  t.net.bookStatus = 200;
  const asks = t.net.asks.length;
  t.log.error[t.log.error.length - 1].retry && await t.engine.retry();
  await t.clock.advance(1000);
  check('Retry resumes exactly there on a new session', !t.main.paused && t.net.asks.length === asks + 1 &&
    srcParams(t).get('offset') === (held / 1000).toFixed(3), srcParams(t).get('offset'));
  t.engine.close();
}

current = 'a dropped stream switches to the other connection at the same offset';
{
  const t = setup({ permissions: { query: async () => ({ state: 'granted' }) } });
  await openPlaying(t, ATMOS.key, { at: at('801', 7000000) });
  await t.clock.advance(2000);
  const held = t.engine.state().position.offset_ms;
  t.net.down.add('local');
  await t.clock.advance(1000);
  check('remote, at the same offset', t.engine.state().connection === 'remote' && !t.main.paused &&
    Math.abs(Number(srcParams(t).get('offset')) * 1000 - held) <= 250, [held, srcParams(t).get('offset')]);
  check('no error, no warning', t.log.error.length === 0 && t.log.warning.length === 0);
  t.engine.close();
}

current = 'Plex ending the stream early is a dropped stream, not the end of the book';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 1000000) });
  t.net.cutAt.set(srcParams(t).get('session'), 5);   // Plex stops it 5 s in (idle, or stopped)
  await t.clock.advance(6000);
  check('no ended, no advance', t.log.ended.length === 0 && !reasons(t).includes('ended'), reasons(t));
  check('streaming again on a new session from where it was cut',
    !t.main.paused && t.net.asks.length === 2 && Math.abs(Number(srcParams(t).get('offset')) - 1005) <= 0.25, srcParams(t).get('offset'));
  check('the place never jumped to the end', t.positions.every((p) => !p || p.offset_ms < 1010000));
  t.engine.close();
}

// ---- 18. Fix round 1: the end of a transcoded part ----

current = 'a transcoded part whose real audio is 30 s short ends and advances, with few asks';
{
  // Plex answers a start past the real audio with nothing playable (as a real server does).
  const t = setup({ net: { noLocal: true, realDelta: new Map([['902', -30000]]) } });
  await openPlaying(t, MIXED.key, { at: at('902', 900000 - 60000) });
  await t.clock.advance(90000);
  check('part 3 plays', partOf(t.main) === MIXED.tracks[2].part_path && !t.main.paused, partOf(t.main));
  check('no error, no warning', t.log.error.length === 0 && t.log.warning.length === 0, [t.log.error, t.log.warning]);
  check('a bounded number of asks and refreshes', t.net.asks.length <= 3 &&
    t.net.fetches.filter((f) => f.endsWith('?refresh=1')).length <= 1, t.net.asks.length);
  check('one advance', reasons(t).filter((r) => r === 'part').length === 1);
  t.engine.close();
  // The last part, where Plex gives an empty stream past the real audio: the book ends.
  const u = setup({ net: { noLocal: true, realDelta: new Map([['801', -30000]]), pastEnd: 'empty' } });
  await openPlaying(u, ATMOS.key, { at: at('801', ATMOS_MS - 60000) });
  await u.clock.advance(90000);
  check('the book ends once', u.log.ended.length === 1 && u.log.error.length === 0, [u.log.ended.length, u.log.error]);
  check('asks stay bounded', u.net.asks.length <= 2, u.net.asks.length);
  check('the place is the end', u.engine.state().position.offset_ms === ATMOS_MS);
  u.engine.close();
}

current = 'a real Plex kill mid-part still reconnects at the held place, and again later';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 1000000) });
  t.net.cutAt.set(srcParams(t).get('session'), 5);
  await t.clock.advance(8000);
  check('reconnected at the held place', !t.main.paused && t.net.asks.length === 2 &&
    Math.abs(Number(srcParams(t).get('offset')) - 1005) <= 0.25 && t.log.error.length === 0, srcParams(t).get('offset'));
  const second = srcParams(t).get('session');
  await t.clock.advance(10000);
  t.net.cutAt.set(second, 20);                  // a second kill, after real playback
  await t.clock.advance(15000);
  check('a later kill reconnects too (real playback gave the ladder back)', !t.main.paused &&
    t.net.asks.length === 3 && t.log.error.length === 0 && t.log.ended.length === 0, [t.net.asks.length, t.log.error]);
  check('never ended, never jumped', t.positions.every((p) => !p || p.offset_ms < 1100000));
  t.engine.close();
}

current = 'a stream that starts and at once ends, or drops, does not loop';
{
  // Every start of the part gives a stream that ends at once, cleanly.
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 1000000) });
  const orig = t.net.cutAt;
  t.net.cutAt = { get: () => 0, set: () => {} };
  const n = t.net.asks.length;
  t.engine.seek(2000000);
  await t.clock.advance(60000);
  t.net.cutAt = orig;
  check('ends at once: a bounded number of asks', t.net.asks.length - n <= 3, t.net.asks.length - n);
  check('ends at once: it stops, not a loop', t.log.ended.length + t.log.error.length === 1, [t.log.ended.length, t.log.error]);
  t.engine.close();
  // Every stream starts playing and drops at once: 'playing' alone never
  // gives the ladder back, so it runs out and holds the place.
  const u = setup({ net: { noLocal: true } });
  await openPlaying(u, ATMOS.key, { at: at('801', 1000000) });
  await u.clock.advance(3000);
  const held = u.engine.state().position.offset_ms;
  const m = u.net.asks.length;
  u.net.dropAtStart = true;
  await u.clock.advance(60000);
  check('drops at once: a bounded number of asks and one refresh', u.net.asks.length - m <= 3 &&
    u.net.fetches.filter((f) => f.endsWith('?refresh=1')).length === 1, [u.net.asks.length - m, u.net.fetches.length]);
  check('drops at once: unreachable, place held', u.engine.state().error && u.engine.state().error.code === 'unreachable' &&
    Math.abs(u.engine.state().position.offset_ms - held) <= 250, [u.engine.state().error, u.engine.state().position]);
  u.engine.close();
}

current = 'Plex killing a stream and then going away is never taken for the end of the part';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 1000000) });
  const sid = srcParams(t).get('session');
  await t.clock.advance(3000);
  // Plex ends the stream cleanly (a restart), and is down when the player comes back.
  t.net.cutAt.set(sid, 5);
  t.main.addEventListener('ended', () => { t.net.down.add('remote'); });
  await t.clock.advance(20000);
  const s = t.engine.state();
  check('no end, no advance', t.log.ended.length === 0 && !reasons(t).includes('ended'), reasons(t).slice(-6));
  check('"Can\'t reach the media server", the place held', s.error && s.error.code === 'unreachable' &&
    s.position.offset_ms >= 1004000 && s.position.offset_ms <= 1005000, [s.error, s.position]);
  t.engine.close();
}

current = 'skipping past the end of a transcoded book ends it without asking Plex';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', ATMOS_MS - 10000) });
  await t.clock.advance(2000);
  t.engine.skip(30);
  await t.clock.advance(3000);
  check('ended once, no error', t.log.ended.length === 1 && t.log.error.length === 0, t.log.error);
  check('no new session asked for', t.net.asks.length === 1, t.net.asks.length);
  check('the place is the end', t.engine.state().position.offset_ms === ATMOS_MS && !t.engine.state().playing);
  check('the old session was ended', t.net.stops.length === 1);
  t.engine.close();
  // A middle part: a skip into its last seconds moves on to the next part.
  const u = setup({ net: { noLocal: true } });
  await openPlaying(u, MIXED.key, { at: at('902', 900000 - 20000) });
  u.engine.skip(17);                             // 3 s before part 2's end
  await u.clock.advance(3000);
  check('the next part plays, direct', partOf(u.main) === MIXED.tracks[2].part_path && !u.main.paused &&
    u.net.asks.length === 1 && u.log.error.length === 0, partOf(u.main));
  u.engine.close();
}

current = 'reopening a finished transcoded book ends at once, and play starts it over';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', ATMOS_MS) });
  check('ended, no error, nothing asked', t.log.ended.length === 1 && t.log.error.length === 0 && t.net.asks.length === 0,
    [t.log.ended.length, t.log.error, t.net.asks.length]);
  check('not playing, at the end', !t.engine.state().playing && t.engine.state().position.offset_ms === ATMOS_MS);
  await t.engine.play();
  await t.clock.advance(2000);
  check('play starts it from the beginning', !t.main.paused && srcParams(t).get('offset') === '0.000' && t.net.asks.length === 1);
  t.engine.close();
}

current = 'a transcoded stream longer than Plex\'s length never reports a place past it';
{
  const t = setup({ net: { noLocal: true, realDelta: new Map([['801', 10000]]) } });
  await openPlaying(t, ATMOS.key, { at: at('801', ATMOS_MS - 20000) });
  await t.clock.advance(12000);
  check('the element has no length (Infinity)', t.main.duration === Infinity);
  await t.clock.advance(30000);
  check('no place past the part\'s length', t.positions.every((p) => !p || p.offset_ms <= ATMOS_MS) &&
    t.log.change.every((c) => c.state.bookMs <= ATMOS_MS), Math.max(...t.positions.filter(Boolean).map((p) => p.offset_ms)));
  check('it ends once, at the part\'s length', t.log.ended.length === 1 && t.engine.state().position.offset_ms === ATMOS_MS);
  t.engine.close();
}

current = 'an early end within 5 s of the part\'s end is its end; further out it reconnects';
{
  // Plex cuts the stream 4 s before the end: that is the end (one session in all).
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', ATMOS_MS - 20000) });
  t.net.cutAt.set(srcParams(t).get('session'), 16);
  await t.clock.advance(20000);
  check('4 s short: ended, one session', t.log.ended.length === 1 && t.net.asks.length === 1 && t.log.error.length === 0,
    [t.log.ended.length, t.net.asks.length]);
  t.engine.close();
  // Cut 6 s before the end: a dropped stream, so it reconnects and plays those 6 s.
  const u = setup({ net: { noLocal: true } });
  await openPlaying(u, ATMOS.key, { at: at('801', ATMOS_MS - 20000) });
  u.net.cutAt.set(srcParams(u).get('session'), 14);
  await u.clock.advance(15000);
  check('6 s short: a second session from where it was cut', u.net.asks.length === 2 &&
    Math.abs(Number(srcParams(u).get('offset')) * 1000 - (ATMOS_MS - 6000)) <= 250, srcParams(u).get('offset'));
  await u.clock.advance(10000);
  check('and it plays out to the end', u.log.ended.length === 1 && u.log.error.length === 0);
  u.engine.close();
}

current = 'between two transcoded parts, the first session ends before the second is asked for';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, TWIN.key, { at: at('951', 600000 - 8000) });
  const first = srcParams(t).get('session');
  await t.clock.advance(12000);
  check('part 2 streams from the transcoder', new URL(t.main.src).pathname === TRANSCODE_PATH &&
    new URL(t.main.src).searchParams.get('path').endsWith('/952') && !t.main.paused);
  const stopAt = t.net.events.findIndex((e) => e[0] === 'stop' && e[1] === first);
  const askAt = t.net.events.findIndex((e) => e[0] === 'ask' && e[1] === '952');
  check('stopped first, then asked', stopAt !== -1 && askAt !== -1 && stopAt < askAt, t.net.events);
  t.engine.close();
}

current = 'Plex refusing to convert shows the format message and holds the place';
{
  const t = setup({ net: { noLocal: true, transcodeStatus: 415 } });
  await openPlaying(t, ATMOS.key, { at: at('801', 5000000) });
  const s = t.engine.state();
  check('the format message', s.error && s.error.code === 'format' && s.error.message === E.FORMAT_UNSUPPORTED &&
    E.FORMAT_UNSUPPORTED === "This book's audio format can't play in this browser", s.error);
  check('never the network message', !t.log.error.some((e) => e.code === 'unreachable'));
  check('the place is held', s.position && s.position.offset_ms === 5000000);
  check('nothing loaded at all', t.net.loads.length === 0, t.net.loads);
  check('with a retry', typeof t.log.raw.find((r) => r[0] === 'error')[1].retry === 'function');
  t.engine.close();
}

current = 'a transcoded stream that never plays on a working connection is the format message, not a skip';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, MIXED.key, { at: at('901', 598000) });
  t.net.noConvert.add('902');
  await t.clock.advance(8000);
  const s = t.engine.state();
  check('the format message', s.error && s.error.code === 'format', s.error);
  check('part 2 was not skipped: no warning, part 3 never loaded', t.log.warning.length === 0 &&
    rawLoads(t, MIXED.tracks[2].part_path).length === 0, t.log.warning);
  check('the place is where part 2 starts', s.position.track === '902' && s.position.offset_ms === 0, s.position);
  check('never "Can\'t reach the media server"', !t.log.error.some((e) => e.code === 'unreachable'));
  t.engine.close();
}

current = 'no answer when asking for a session is a network failure, up the ladder';
{
  const t = setup({ net: { noLocal: true, transcodeStatus: 503 } });
  await openPlaying(t, ATMOS.key, { at: at('801', 5000000) });
  await t.clock.advance(1000);
  const s = t.engine.state();
  check('unreachable, not format', s.error && s.error.code === 'unreachable', s.error);
  check('one refresh on the way', t.net.fetches.filter((f) => f.endsWith('?refresh=1')).length === 1);
  check('the place is held', s.position.offset_ms === 5000000);
  t.engine.close();
  // An ask that never answers gives up after ASK_MS.
  const u = setup({ net: { noLocal: true, askDelay: 60000 } });
  const p = u.engine.open(ATMOS.key, { at: at('801', 5000000) });
  await u.clock.advance(400);
  await p;
  await u.clock.advance(E.ASK_MS * 3 + 1000);
  check('a hung ask ends unreachable, place held', u.engine.state().error && u.engine.state().error.code === 'unreachable' &&
    u.engine.state().position.offset_ms === 5000000, u.engine.state().error);
  u.engine.close();
  check('close leaves no timer behind', u.live.size === 0, u.live.size);
}

current = 'sessions are ended on a track change, a book change, close and pagehide';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key);
  const a = srcParams(t).get('session');
  await openPlaying(t, MULTI.key);               // another book
  check('a book change ends it', t.net.stops.includes(a), t.net.stops);
  await openPlaying(t, ATMOS.key);
  const b = srcParams(t).get('session');
  t.engine.close();
  check('close ends it', t.net.stops.includes(b));
  await openPlaying(t, ATMOS.key);
  const c = srcParams(t).get('session');
  check('the engine listens for pagehide', t.net.pagehide.length === 1);
  t.net.pagehide.forEach((fn) => fn({ persisted: false }));
  check('pagehide ends it', t.net.stops.includes(c));
  const n = t.net.stops.length;
  t.engine.close();
  check('each once', t.net.stops.length === n && new Set(t.net.stops).size === t.net.stops.length, t.net.stops);
  // An error ends it too; a retry asks for a new one.
  const u = setup({ net: { noLocal: true } });
  await openPlaying(u, ATMOS.key);
  const d = srcParams(u).get('session');
  u.net.down.add('remote');
  u.net.bookStatus = 503;
  await u.clock.advance(3000);
  check('the error state ends it', u.net.stops.includes(d) && u.engine.state().error);
  u.engine.close();
}

current = 'a session answered after the part was left is ended at once';
{
  const t = setup({ net: { noLocal: true, askDelay: 2000 } });
  const p = t.engine.open(ATMOS.key);
  await t.clock.advance(400);
  await p;
  t.engine.close();
  await t.clock.advance(3000);
  check('its session was ended, nothing loaded', t.net.asks.length === 1 && t.net.stops.length === 1 &&
    tcLoads(t).length === 0, [t.net.stops, tcLoads(t)]);
}

current = 'transcode mode keeps the token in the element\'s src only';
{
  const t = setup({ net: { noLocal: true } });
  await openPlaying(t, ATMOS.key, { at: at('801', 1000000) });
  await t.clock.advance(2000);
  t.engine.seek(5000000);
  await t.clock.advance(1000);
  t.net.down.add('remote');
  t.net.bookStatus = 503;
  await t.clock.advance(3000);
  check('state() has no token', asJson(t.engine.state()).indexOf(TOKEN) === -1);
  check('no event carries it', asJson(t.log).indexOf(TOKEN) === -1);
  check('no request body carries it', t.net.bodies.every((b) => b.indexOf(TOKEN) === -1) && t.net.bodies.length >= 1, t.net.bodies);
  check('no stop carries it', t.net.stops.every((sid) => /^ws[0-9a-f]{32}$/.test(sid)));
  check('the console never saw it', consoleSeen.every((l) => l.indexOf(TOKEN) === -1));
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
  const overrides = {
    fetch: makeFetch(net),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    mediaSession: null,
    MediaMetadata: null
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

if (failed) {
  realError(`${failed}/${total} player engine cases FAILED`);
  process.exit(1);
}
console.log = (...a) => process.stdout.write(a.join(' ') + '\n');
console.log(`${total}/${total} player engine cases pass`);
