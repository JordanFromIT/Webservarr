// The audiobook player's saves (app/static/js/player/saves.js): the save
// loop, the local copy, the resume merge and the "not saved" warning, run
// against a scripted check-in server on fake timers. The last cases drive the
// real engine (engine.js) with the saver injected through createEngine(env),
// on a small fake <audio> element, and the browser glue in happy-dom.
//
// Imports both modules as they are, through data: URLs like
// player_engine.mjs (a module in a folder with no package.json "type"); that
// also proves neither touches the DOM at import time. SAVES_JS=<path> and
// ENGINE_JS=<path> run the same cases against other copies.
// Run: node app/tests/js/player_saves.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const load = (path) => import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(path, 'utf8')));
const S = await load(process.env.SAVES_JS || join(here, '../../static/js/player/saves.js'));
const E = await load(process.env.ENGINE_JS || join(here, '../../static/js/player/engine.js'));

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
const consoleSeen = [];
console.error = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('FAIL ')) return realError(...a);
  consoleSeen.push(a.map(String).join(' '));
};

// ---- Fake timers ----
// Time moves only when the test says. advance() fires every due timer in
// order and lets the promises each one starts run before the next. A timer
// set with the 'page' tag is the page's own (the saver's): while the clock is
// throttled, as a background tab's are, those do not fire at all.
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock() {
  let now = T0;
  let ids = 0;
  const due = new Map();
  const clock = {
    throttled: false,
    get now() { return now; },
    setTimeout(fn, ms, tag) { const id = ++ids; due.set(id, { at: now + (ms || 0), fn, tag }); return id; },
    clearTimeout(id) { due.delete(id); },
    pageTimers() { let n = 0; for (const t of due.values()) if (t.tag === 'page') n += 1; return n; },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const [id, t] of due) {
          if (t.at > end || (clock.throttled && t.tag === 'page')) continue;
          if (!next || t.at < next[1].at) next = [id, t];
        }
        if (!next) break;
        now = Math.max(now, next[1].at);
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

// ---- A scripted check-in server ----
// mode: 200 (stores by the real rule: a same-psid older seq is not stored,
// across psids the most recently received wins), a status (401, 429, 503),
// 'offline' (the fetch rejects) or 'hang' (never answers). skewMs: how far
// the server's clock is ahead of the page's.
function fakeServer(clock) {
  const s = {
    mode: 200, latency: 80, skewMs: 0, row: null, calls: [], inflight: 0, maxInflight: 0,
    fetches() { return s.calls.filter((c) => c.kind === 'fetch'); },
    beacons() { return s.calls.filter((c) => c.kind === 'beacon'); },
    store(b) {
      const at = new Date(clock.now + s.skewMs).toISOString();
      if (s.row && s.row.psid === b.psid && s.row.seq > b.seq) return { stored: false, updated_at: s.row.updated_at };
      s.row = Object.assign({}, b, { updated_at: at });
      return { stored: true, updated_at: at };
    },
    post(body, kind) {
      const b = JSON.parse(JSON.stringify(body));
      const call = { kind, body: b, at: clock.now, done: null, status: null };
      s.calls.push(call);
      if (kind === 'beacon') {
        if (s.mode === 200) s.store(b);
        return true;
      }
      s.inflight += 1;
      s.maxInflight = Math.max(s.maxInflight, s.inflight);
      const mode = s.mode;
      return new Promise((resolve, reject) => {
        if (mode === 'hang') return;
        clock.setTimeout(() => {
          s.inflight -= 1;
          call.done = clock.now;
          if (mode === 'offline') { call.status = 0; reject(new TypeError('Failed to fetch')); return; }
          call.status = mode;
          if (mode === 409) { resolve({ status: 409, data: { conflict: s.conflict, now: new Date(clock.now).toISOString() } }); return; }
          if (mode !== 200) { resolve({ status: mode, data: { detail: 'no' } }); return; }
          // s.extra: more fields on a 2xx answer (spec 2.5's "linked").
          resolve({ status: 200, data: Object.assign(s.store(b), s.extra || {}) });
        }, s.latency);
      });
    }
  };
  return s;
}

function fakeStorage(opts = {}) {
  const m = new Map();
  return {
    map: m,
    writes: 0,
    getItem(k) { if (opts.throws) throw new DOMException('denied', 'SecurityError'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (opts.throws) throw new DOMException('quota', 'QuotaExceededError'); this.writes += 1; m.set(k, String(v)); },
    removeItem(k) { if (opts.throws) throw new DOMException('denied', 'SecurityError'); m.delete(k); }
  };
}

// The page's identity key (WS.user.identity_key): an opaque HMAC, never the account id.
const IDENTITY = '3f9a0c1d2b7e4a6f8c5d1e0b';
function makeSaver(o = {}) {
  const clock = o.clock || fakeClock();
  const server = o.server || fakeServer(clock);
  const storage = o.storage === undefined ? fakeStorage() : o.storage;
  const signedOut = [];
  const warnings = [];
  const saver = S.createSaver({
    post: (body, kind) => server.post(body, kind),
    now: o.now || (() => clock.now),
    mono: () => clock.now,
    storage,
    identity: o.identity === undefined ? IDENTITY : o.identity,
    device: 'Chrome on Android',
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'),
    clearTimeout: (id) => clock.clearTimeout(id),
    onSignedOut: () => signedOut.push(clock.now),
    formatTime: (ms) => 'T+' + Math.round((ms - T0) / 1000) + 's'
  });
  saver.onWarning((w) => warnings.push(Object.assign({ at: clock.now }, w)));
  return { clock, server, storage, saver, signedOut, warnings };
}

// What the engine would report: a book, a place in it, playing or not.
// listen(ms) plays on in 250 ms steps, each a 'time' change, as the audio
// element's timeupdate drives them.
function listener(t, book = '500:1') {
  const p = { book, track: '501', offset: 0, duration: 3600000, playing: false };
  p.state = () => ({ book: p.book, playing: p.playing, position: { track: p.track, offset_ms: Math.round(p.offset), duration_ms: p.duration } });
  p.emit = (reason, extra) => t.saver.note(Object.assign({ reason, state: p.state() }, extra || {}));
  p.open = () => p.emit('open');
  p.play = () => { p.playing = true; p.emit('play'); };
  p.pause = () => { p.playing = false; p.emit('pause'); };
  p.seek = (to, reason = 'seek') => { const from = p.offset; p.offset = to; p.emit(reason, { from, to }); };
  p.listen = async (ms) => {
    for (let k = 0; k < ms; k += 250) {
      await t.clock.advance(250);
      if (p.playing) { p.offset += 250; p.emit('time'); }
    }
  };
  return p;
}
const localOf = (t, book = '500:1', identity = IDENTITY) => {
  const raw = t.storage.map.get('ws-player:place:' + identity + ':' + book);
  return raw ? JSON.parse(raw) : null;
};
const gaps = (list) => list.slice(1).map((c, i) => c.at - list[i].at);

// ---- 1. The numbers the spec gives ----
current = 'the spec\'s numbers';
check('a save every 10 s', S.SAVE_EVERY_MS === 10000);
check('warning after 30 s', S.WARN_AFTER_MS === 30000);
check('backoff 10, 20, 30 s', JSON.stringify(S.BACKOFF_MS) === '[10000,20000,30000]');
check('at least 1 s between saves', S.MIN_GAP_MS === 1000);
check('the warning text', S.NOT_SAVED === "Your place isn't being saved.");

// ---- 2. deviceLabel ----
current = 'deviceLabel';
{
  const cases = [
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', 'Chrome on iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1', 'Safari on iPad'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0', 'Firefox on Android'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Samsung Internet on Android'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'Chrome on ChromeOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0', 'Opera on Windows'],
    ['', 'Web browser'],
    [undefined, 'Web browser']
  ];
  for (const [ua, want] of cases) check(`${want}`, S.deviceLabel(ua) === want, S.deviceLabel(ua));
  check('never over 80 characters', S.deviceLabel('x'.repeat(500)).length <= 80);
}

// ---- 3. resolveResume ----
current = 'resolveResume picks the newest of web, Plex and the local copy';
{
  const iso = (s) => new Date(T0 + s * 1000).toISOString();
  const web = { track: '501', offset_ms: 1000, duration_ms: 9, updated_at: iso(-60), device: 'Chrome on Windows', source: 'web' };
  const plex = { track: '502', offset_ms: 2000, duration_ms: 9, updated_at: iso(-30), device: 'Plex', source: 'plex' };
  const local = { track: '503', offset_ms: 3000, duration_ms: 9, updated_at: iso(-10), device: 'Chrome on Android' };
  let r = S.resolveResume({ web, plex, local });
  check('local newest', r && r.source === 'local' && r.track === '503' && r.offset_ms === 3000, r);
  r = S.resolveResume({ web: Object.assign({}, web, { updated_at: iso(0) }), plex, local });
  check('web newest', r && r.source === 'web' && r.track === '501' && r.offset_ms === 1000, r);
  r = S.resolveResume({ web, plex: Object.assign({}, plex, { updated_at: iso(60) }), local });
  check('plex newest', r && r.source === 'plex' && r.track === '502', r);
  check('only one', S.resolveResume({ web: null, plex: null, local }).source === 'local');
  check('none: null', S.resolveResume({ web: null, plex: null, local: null }) === null);
  check('nothing given: null', S.resolveResume({}) === null && S.resolveResume() === null);
  r = S.resolveResume({ web, plex: { track: '', offset_ms: 1, updated_at: iso(90) }, local: { track: '503', offset_ms: 'x', updated_at: iso(90) } });
  check('unusable copies are passed over', r && r.source === 'web', r);
  r = S.resolveResume({ web, local: { track: '503', offset_ms: 5, updated_at: 'yesterday' } });
  check('a copy with no readable time is passed over', r && r.source === 'web', r);
  const order = S.resumeOrder({ web, plex, local });
  check('resumeOrder: newest first, all three', order.map((c) => c.source).join() === 'local,plex,web', order);
  check('carries device and updated_at', order[0].device === 'Chrome on Android' && order[0].updated_at === iso(-10));
  // Plex's own copy of a save WebServarr just forwarded is stamped a moment
  // later (its clock, whole seconds): that echo is not a newer place.
  const w2 = { track: '501', offset_ms: 5000, updated_at: new Date(T0 + 400).toISOString() };
  const p2 = { track: '501', offset_ms: 5000, updated_at: new Date(T0 + 1000).toISOString(), device: 'Plex' };
  check('Plex\'s echo of the same save does not win', S.resolveResume({ web: w2, plex: p2 }).source === 'web');
  check('equal times: web first', S.resolveResume({ web: { track: '1', offset_ms: 1, updated_at: iso(0) }, local: { track: '2', offset_ms: 2, updated_at: iso(0) } }).source === 'web');
}

// ---- 4. The save loop ----
current = 'a save every 10 s while playing';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  check('nothing saved on open', t.server.fetches().length === 0);
  p.play();
  await p.listen(60000);
  const f = t.server.fetches();
  check('the first save is the play', f.length && f[0].body.event === 'play', f.map((c) => c.body.event));
  check('then checkins', f.slice(1).every((c) => c.body.event === 'checkin'));
  check('7 saves in 60 s (at play, then every 10 s)', f.length === 7, f.length);
  check('10 s apart', gaps(f).every((g) => g >= 10000 && g <= 10250), gaps(f));
  check('each carries the place at the time', f.every((c) => c.body.offset_ms >= c.at - T0 - 250 && c.body.offset_ms <= c.at - T0), f.map((c) => [c.at - T0, c.body.offset_ms]));
  check('body fields', JSON.stringify(Object.keys(f[1].body).sort()) === JSON.stringify(['base', 'book', 'device', 'duration_ms', 'event', 'offset_ms', 'psid', 'seq', 'track']), Object.keys(f[1].body));
  check('book, track and duration', f[1].body.book === '500:1' && f[1].body.track === '501' && f[1].body.duration_ms === 3600000);
  check('the device label', f[1].body.device === 'Chrome on Android');
  const answeredOk = f.filter((c) => c.status === 200);
  check('lastSavedAt is the last success', t.saver.lastSavedAt === answeredOk[answeredOk.length - 1].done, t.saver.lastSavedAt);
  p.pause();
  await t.clock.advance(60000);
  const n = t.server.fetches().length;
  check('the pause is saved at once', n === 8 && t.server.fetches()[7].body.event === 'pause');
  await t.clock.advance(60000);
  check('nothing more while paused', t.server.fetches().length === n);
  t.saver.stop();
  check('no timers left', t.clock.pageTimers() === 0);
}

current = 'immediate saves on pause, skip, seek and chapter jump';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(3000);
  const want = [['seek', 'seek', 600000], ['skip', 'seek', 600030], ['jump', 'jump', 900000]];
  for (const [reason, event, to] of want) {
    const before = t.server.fetches().length;
    p.seek(to, reason);
    await t.clock.advance(1100);
    const f = t.server.fetches();
    const last = f[f.length - 1];
    check(`${reason}: saved within 1 s`, f.length === before + 1 && last.at - (t.clock.now - 1100) <= 1000, f.length - before);
    check(`${reason}: event ${event}`, last.body.event === event, last.body.event);
    check(`${reason}: the new place`, last.body.offset_ms === to, last.body.offset_ms);
  }
  await p.listen(2000);
  const before = t.server.fetches().length;
  p.pause();
  await t.clock.advance(1100);
  const f = t.server.fetches();
  check('pause: saved within 1 s', f.length === before + 1 && f[f.length - 1].body.event === 'pause');
  p.playing = true;
  p.seek(10000, 'seek');
  p.playing = false;
  p.offset = 12000;
  p.emit('ended');
  await t.clock.advance(1100);
  const g = t.server.fetches();
  check('the end is saved as end', g[g.length - 1].body.event === 'end', g.map((c) => c.body.event));
  t.saver.stop();
}

current = 'playback stopping on an error saves the place it holds, as a pause';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(7000);                          // saved at 0; 7 s since
  const n = t.server.fetches().length;
  p.playing = false;
  p.emit('error');
  await t.clock.advance(1100);
  const f = t.server.fetches();
  check('saved at once', f.length === n + 1 && f[n].body.event === 'pause' && f[n].body.offset_ms === p.offset, f.slice(n).map((c) => c.body));
  t.saver.stop();
}

current = 'rapid skips: one save in flight, 1 s apart, the last carrying the latest place';
{
  const t = makeSaver();
  t.server.latency = 400;
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(1000);
  const before = t.server.fetches().length;
  for (let i = 1; i <= 30; i++) {             // 30 presses, 5 a second, for 6 s
    p.seek(p.offset + 30000, 'skip');
    await t.clock.advance(200);
  }
  await t.clock.advance(3000);
  const f = t.server.fetches().slice(before);
  check('never more than one in flight', t.server.maxInflight === 1, t.server.maxInflight);
  check('at least 1 s between saves', gaps(f).every((g) => g >= 1000), gaps(f));
  check('far fewer saves than presses (under 10)', f.length > 0 && f.length <= 9, f.length);
  check('the last save is the last place', f[f.length - 1].body.offset_ms === p.offset, [f[f.length - 1].body.offset_ms, p.offset]);
  // A burst at this rate for a whole minute stays under the 60/min limit.
  t.server.latency = 20;
  const start = t.server.fetches().length;
  for (let i = 0; i < 300; i++) {
    p.seek(p.offset + 1000, 'skip');
    await t.clock.advance(200);
  }
  const perMinute = t.server.fetches().length - start;
  check('under 60 a minute at 5 presses a second', perMinute <= 61 && perMinute >= 50, perMinute);
  t.saver.stop();
}

current = 'seq strictly increases and the psid is stable for the page session';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(25000);
  p.seek(90000);
  t.saver.flush('beacon', 'leave');
  await p.listen(12000);
  t.saver.stop();
  t.saver.start('700:1');
  const q = listener(t, '700:1');
  q.open();
  q.play();
  await q.listen(12000);
  const seqs = t.server.calls.map((c) => c.body.seq);
  check('seq strictly increases across saves, beacons and books', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs);
  check('seq is a whole number', seqs.every((s) => Number.isInteger(s) && s >= 0));
  const psids = new Set(t.server.calls.map((c) => c.body.psid));
  check('one psid', psids.size === 1 && typeof t.saver.psid === 'string' && psids.has(t.saver.psid), [...psids]);
  check('the psid fits the server\'s 64', t.saver.psid.length >= 8 && t.saver.psid.length <= 64);
  const other = makeSaver();
  check('another page session has another psid', other.saver.psid !== t.saver.psid);
  t.saver.stop();
}

current = 'a change whose position is null is never saved';
{
  const t = makeSaver();
  t.saver.start('500:1');
  t.saver.note({ reason: 'play', state: { book: '500:1', playing: true, position: null } });
  t.saver.note({ reason: 'pause', state: { book: '500:1', playing: false, position: null } });
  t.saver.note({ reason: 'seek', state: { book: '500:1', playing: false, position: null }, from: 0, to: 5 });
  await t.clock.advance(60000);
  check('no save', t.server.calls.length === 0, t.server.calls.length);
  check('no local copy', localOf(t) === null);
  check('flush sends nothing', t.saver.flush('beacon', 'leave') === false && t.server.calls.length === 0);
  // Another book's changes are not this one's.
  t.saver.note({ reason: 'pause', state: { book: '999:1', playing: false, position: { track: '9', offset_ms: 5, duration_ms: 10 } } });
  await t.clock.advance(5000);
  check('another book\'s change is ignored', t.server.calls.length === 0);
  t.saver.stop();
}

// ---- 5. Hard exits use the beacon ----
current = 'pagehide, ws:before-hard-nav and a hidden page send a beacon';
{
  const win = new Window({ url: 'https://ws.test/news' });
  win.WS = { user: { username: 'sam', identity_key: IDENTITY } };
  const clock = fakeClock();
  const server = fakeServer(clock);
  const beacons = [];
  const fetches = [];
  const storage = fakeStorage();
  const saver = S.browserSaver(win, {
    sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; },
    fetch: async (url, init) => { fetches.push({ url, init }); return { status: 200, json: async () => server.store(JSON.parse(init.body)) }; },
    now: () => clock.now,
    storage,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'),
    clearTimeout: (id) => clock.clearTimeout(id)
  });
  saver.start('500:1');
  const st = (playing, offset) => ({ book: '500:1', playing, position: { track: '501', offset_ms: offset, duration_ms: 600000 } });
  saver.note({ reason: 'open', state: st(false, 5000) });
  saver.note({ reason: 'play', state: st(true, 5000) });
  await clock.advance(500);
  check('the fetch goes to the checkin route, JSON, same origin', fetches.length === 1 && fetches[0].url === '/api/player/checkin' &&
    fetches[0].init.method === 'POST' && fetches[0].init.credentials === 'same-origin' &&
    /application\/json/.test(fetches[0].init.headers['Content-Type']), fetches.map((f) => f.url));
  saver.note({ reason: 'time', state: st(true, 5500) });
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  check('hidden: one beacon', beacons.length === 1, beacons.length);
  const body0 = JSON.parse(await beacons[0].blob.text());
  check('to the checkin route, as a JSON Blob', beacons[0].url === '/api/player/checkin' && beacons[0].blob.type === 'application/json');
  check('hidden while playing: a checkin, not a leave (the audio plays on)', body0.event === 'checkin' && body0.offset_ms === 5500, body0);
  saver.note({ reason: 'time', state: st(true, 6000) });
  win.dispatchEvent(new win.CustomEvent('ws:before-hard-nav', { detail: { url: '/login', waitUntil() {} } }));
  check('ws:before-hard-nav: a beacon', beacons.length === 2);
  const body1 = JSON.parse(await beacons[1].blob.text());
  check('a leave at the latest place', body1.event === 'leave' && body1.offset_ms === 6000, body1);
  win.dispatchEvent(new win.Event('pagehide'));
  check('pagehide at the same place again sends nothing more', beacons.length === 2, beacons.length);
  saver.note({ reason: 'time', state: st(true, 6250) });
  win.dispatchEvent(new win.Event('pagehide'));
  check('pagehide: a beacon', beacons.length === 3);
  const body2 = JSON.parse(await beacons[2].blob.text());
  check('its seq is the newest', body2.seq > body1.seq && body1.seq > body0.seq && body2.event === 'leave');
  check('the local copy is keyed by the identity key', storage.map.has('ws-player:place:' + IDENTITY + ':500:1'), [...storage.map.keys()]);
  // Leaving, Chrome fires pagehide and then visibilitychange (seen on dev):
  // the leave stays the last word, not a checkin saying it still plays.
  saver.note({ reason: 'time', state: st(true, 6500) });
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  win.dispatchEvent(new win.Event('pagehide'));
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  const tail = await Promise.all(beacons.slice(3).map(async (b) => JSON.parse(await b.blob.text()).event));
  check('pagehide then hidden: one leave, no checkin after it', tail.join() === 'leave', tail);
  saver.note({ reason: 'time', state: st(true, 6750) });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  check('a page that stayed (the place moved on) sends hidden beacons again', beacons.length === 5, beacons.length);
  // A browser whose beacon queue refuses: the same save as a keepalive fetch.
  const win2 = new Window({ url: 'https://ws.test/news' });
  win2.WS = { user: { identity_key: IDENTITY } };
  const kept = [];
  const s2 = S.browserSaver(win2, {
    sendBeacon: () => false,
    fetch: async (url, init) => { kept.push(init); return { status: 200, json: async () => ({ stored: true, updated_at: new Date(clock.now).toISOString() }) }; },
    now: () => clock.now, storage: fakeStorage(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (id) => clock.clearTimeout(id)
  });
  s2.start('500:1');
  s2.note({ reason: 'open', state: st(false, 100) });
  s2.note({ reason: 'play', state: st(true, 100) });
  win2.dispatchEvent(new win2.Event('pagehide'));
  const keptAlive = kept.filter((k) => k.keepalive === true);
  check('a refused beacon falls back to a keepalive fetch', keptAlive.length === 1 && JSON.parse(keptAlive[0].body).event === 'leave', kept);
  // The device label comes from the browser's user agent.
  check('device from the user agent', typeof body0.device === 'string' && body0.device.length > 0 && body0.device.length <= 80, body0.device);
  saver.stop();
  s2.stop();
  await win.happyDOM.close();
  await win2.happyDOM.close();
}

current = 'the browser saver keys the local copy by WS.user.identity_key only';
{
  const st = { book: '500:1', playing: false, position: { track: '501', offset_ms: 100, duration_ms: 600000 } };
  const run = async (user) => {
    const w = new Window({ url: 'https://ws.test/news' });
    w.WS = { user };
    const clock = fakeClock();
    const storage = fakeStorage();
    const s = S.browserSaver(w, {
      sendBeacon: () => true,
      fetch: async () => ({ status: 200, json: async () => ({ stored: true, updated_at: new Date(clock.now).toISOString() }) }),
      now: () => clock.now, storage,
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (id) => clock.clearTimeout(id)
    });
    s.start('500:1');
    s.note({ reason: 'open', state: st });
    s.stop();
    await w.happyDOM.close();
    return [...storage.map.keys()].filter((k) => k.indexOf('ws-player:place:') === 0);
  };
  const keyed = await run({ username: 'sam', identity_key: IDENTITY });
  check('keyed by the hash', keyed.length === 1 && keyed[0] === 'ws-player:place:' + IDENTITY + ':500:1', keyed);
  const raw = await run({ username: 'sam', identity: 'plex:4242' });
  check('a raw identity on WS.user is never used as a key', raw.length === 0, raw);
  const bad = await run({ username: 'sam', identity_key: 'plex:4242' });
  check('a key that is not a hex hash is refused', bad.length === 0, bad);
  const none = await run(null);
  check('signed out: no local copy', none.length === 0, none);
}

current = 'back online: the retry goes at once';
{
  const win = new Window({ url: 'https://ws.test/news' });
  win.WS = { user: { identity_key: IDENTITY } };
  const clock = fakeClock();
  const server = fakeServer(clock);
  const saver = S.browserSaver(win, {
    sendBeacon: () => true,
    fetch: (url, init) => server.post(JSON.parse(init.body), 'fetch').then((r) => ({ status: r.status, json: async () => r.data })),
    now: () => clock.now, storage: fakeStorage(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (id) => clock.clearTimeout(id)
  });
  saver.start('500:1');
  let off = 0;
  const st = () => ({ book: '500:1', playing: true, position: { track: '501', offset_ms: off, duration_ms: 3600000 } });
  saver.note({ reason: 'play', state: st() });
  await clock.advance(1000);
  server.mode = 'offline';
  for (let i = 0; i < 160; i++) { await clock.advance(250); off += 250; saver.note({ reason: 'time', state: st() }); }
  check('warned while offline', saver.warning === true);
  server.mode = 200;
  const n = server.fetches().length;
  win.dispatchEvent(new win.Event('online'));
  await clock.advance(500);
  check('online: a save at once', server.fetches().length === n + 1 && server.fetches()[n].status === 200, server.fetches().length - n);
  check('and the warning clears', saver.warning === false);
  saver.stop();
  await win.happyDOM.close();
}

// ---- 6. The local copy ----
current = 'the local copy is written on every position change, per identity and book';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  check('written on open', localOf(t) && localOf(t).offset_ms === 0);
  p.play();
  const w0 = t.storage.writes;
  await p.listen(5000);
  const placeWrites = t.storage.writes - w0;
  check('written on every change (20 time changes)', placeWrites >= 20, placeWrites);
  const c = localOf(t);
  check('holds the latest place', c.track === '501' && c.offset_ms === 5000, c);
  check('with its time (ISO, server clock) and device', Math.abs(Date.parse(c.updated_at) - t.clock.now) <= 1000 && c.device === 'Chrome on Android', c);
  p.seek(700000);
  check('a seek is written at once', localOf(t).offset_ms === 700000);
  check('keyed by identity and book', t.storage.map.has('ws-player:place:' + IDENTITY + ':500:1'), [...t.storage.map.keys()]);
  check('readLocal reads it back', t.saver.readLocal('500:1').offset_ms === 700000);
  const u = makeSaver({ storage: t.storage, identity: 'a1b2c3d4e5f60718293a4b5c' });
  check('another listener on the same browser does not see it', u.saver.readLocal('500:1') === null);
  check('another book has none', t.saver.readLocal('700:1') === null);
  const anon = makeSaver({ identity: '' });
  const q = listener(anon);
  anon.saver.start(q.book);
  q.open();
  q.play();
  await q.listen(2000);
  const placeKeys = [...anon.storage.map.keys()].filter((k) => k.indexOf('ws-player:place:') === 0);
  check('no identity: no local copy, saves still go', placeKeys.length === 0 && anon.server.fetches().length >= 1, [...anon.storage.map.keys()]);
  t.storage.map.set('ws-player:place:' + IDENTITY + ':800:1', '{not json');
  check('a damaged copy reads as none', t.saver.readLocal('800:1') === null);
  t.saver.stop();
  anon.saver.stop();
}

current = 'storage that throws (a private window) never stops the saves';
{
  const t = makeSaver({ storage: fakeStorage({ throws: true }) });
  const p = listener(t);
  t.saver.start(p.book);
  let threw = null;
  try {
    p.open();
    p.play();
    await p.listen(12000);
    t.saver.readLocal(p.book);
    t.saver.resumeFrom(p.book, { web: null, plex: null });
  } catch (e) { threw = e; }
  check('nothing throws', threw === null, String(threw));
  check('saves still go', t.server.fetches().length >= 2, t.server.fetches().length);
  const none = makeSaver({ storage: null });
  const q = listener(none);
  none.saver.start(q.book);
  q.open();
  q.play();
  await q.listen(2000);
  check('no storage at all: saves still go', none.server.fetches().length >= 1);
  t.saver.stop();
  none.saver.stop();
}

current = 'a newer local copy is sent at once when the book opens';
{
  const t = makeSaver();
  const iso = (s) => new Date(T0 + s * 1000).toISOString();
  t.storage.map.set('ws-player:place:' + IDENTITY + ':500:1', JSON.stringify({ track: '502', offset_ms: 123000, duration_ms: 900000, updated_at: iso(-5), device: 'Chrome on Android' }));
  const web = { track: '501', offset_ms: 50000, duration_ms: 600000, updated_at: iso(-300), device: 'Chrome on Windows', source: 'web' };
  const order = t.saver.resumeFrom('500:1', { web, plex: null });
  check('the local copy is newest', order[0].source === 'local' && order[0].track === '502' && order[0].offset_ms === 123000, order);
  t.saver.start('500:1', { push: true });
  const p = listener(t);
  p.track = '502';
  p.offset = 123000;
  p.duration = 900000;
  p.open();                                     // loaded, not playing yet
  await t.clock.advance(200);
  const f = t.server.fetches();
  check('sent at once, before any play', f.length === 1 && f[0].body.track === '502' && f[0].body.offset_ms === 123000, f.map((c) => c.body));
  check('stored', t.server.row && t.server.row.offset_ms === 123000);
  t.saver.stop();
}

// ---- 7. The warning ----
current = 'warning after 30 s without a successful save while playing; backoff 10/20/30 s; clears on success';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(12000);                         // saves at 0 and 10 s succeed
  const okAt = t.saver.lastSavedAt;
  check('saved so far', okAt !== null && t.warnings.length === 0);
  const lastOk = t.server.fetches().length;
  t.server.mode = 'offline';
  const offAt = t.clock.now;
  await p.listen(160000);
  const fails = t.server.fetches().slice(lastOk);
  check('the saves failed', fails.length >= 4 && fails.every((c) => c.status === 0), fails.map((c) => c.status));
  const g = gaps(fails);
  check('backoff 10, 20, then 30 s capped (5 retries and more)', g.length >= 5 && Math.abs(g[0] - 10000) <= 300 && Math.abs(g[1] - 20000) <= 300 &&
    g.slice(2).every((x) => Math.abs(x - 30000) <= 300), g);
  const on = t.warnings.filter((w) => w.active);
  check('one warning', on.length === 1 && t.warnings.length === 1, t.warnings);
  const since = okAt;                            // the last success, at about 10 s
  check('within ~30 s of the last success', on[0].at - since >= 29000 && on[0].at - since <= 31000, on[0].at - since);
  check('not before 30 s had passed', on[0].at - offAt < 31000);
  check('the payload', on[0].kind === 'not-saved' && on[0].lastSavedAt === okAt &&
    on[0].message === "Your place isn't being saved. Last saved T+" + Math.round((okAt - T0) / 1000) + 's.', on[0]);
  check('saver.warning is true', t.saver.warning === true);
  check('every retry carried the place at its time, with a fresh seq', fails.every((c, i) =>
    c.body.offset_ms >= c.at - T0 - 250 && (i === 0 || c.body.seq > fails[i - 1].body.seq)), fails.map((c) => [c.at - T0, c.body.offset_ms, c.body.seq]));
  t.server.mode = 200;
  await p.listen(31000);
  const off = t.warnings.filter((w) => !w.active);
  check('cleared on the next success', off.length === 1 && t.saver.warning === false, t.warnings);
  const oks = t.server.fetches().slice(lastOk).filter((c) => c.status === 200);
  check('cleared when the first save after it answered', off[0].at === oks[0].done, [off[0].at, oks[0].done]);
  check('lastSavedAt moved', t.saver.lastSavedAt === oks[oks.length - 1].done);
  await p.listen(20000);
  const after = t.server.fetches().filter((c) => c.at > oks[0].at);
  check('back to every 10 s', gaps(after).every((x) => x >= 10000 && x <= 10250), gaps(after));
  t.saver.stop();
}

current = 'no success yet: the warning says so without a time';
{
  const t = makeSaver();
  t.server.mode = 503;
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(35000);
  const on = t.warnings.filter((w) => w.active);
  check('warned', on.length === 1, t.warnings);
  check('"Your place isn\'t being saved." alone', on[0] && on[0].message === "Your place isn't being saved." && on[0].lastSavedAt === null, on[0]);
  t.saver.stop();
}

current = 'start({savedAt}) is the "Last saved" time until this page saves';
{
  const t = makeSaver();
  t.server.mode = 503;
  const p = listener(t);
  t.saver.start(p.book, { savedAt: new Date(T0 - 3600000).toISOString() });
  p.open();
  p.play();
  await p.listen(35000);
  const on = t.warnings.filter((w) => w.active);
  check('the stored save\'s time', on[0] && on[0].lastSavedAt === T0 - 3600000 && /Last saved T\+-3600s\.$/.test(on[0].message), on[0]);
  t.saver.stop();
}

current = 'a 429 is a failure: backoff and the warning';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(1000);
  t.server.mode = 429;
  await p.listen(45000);
  const f = t.server.fetches().filter((c) => c.status === 429);
  check('backed off: 10 s then 20 s', f.length === 3 && Math.abs(gaps(f)[0] - 10000) <= 300 && Math.abs(gaps(f)[1] - 20000) <= 300, gaps(f));
  check('warned', t.saver.warning === true && t.warnings.length === 1);
  // Skips during the backoff wait for it: they are folded into the retry.
  const n = t.server.fetches().length;
  for (let i = 0; i < 10; i++) { p.seek(p.offset + 30000, 'skip'); await t.clock.advance(300); }
  check('no extra saves for skips while backing off', t.server.fetches().length === n, t.server.fetches().length - n);
  t.saver.stop();
}

current = 'paused: no warning, but the retries go on';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(2000);
  t.server.mode = 'offline';
  p.pause();
  await t.clock.advance(65000);                   // retries at 10, 30 and 60 s
  check('no warning while paused', t.warnings.length === 0, t.warnings);
  check('the pause kept being retried', t.server.fetches().filter((c) => c.status === 0).length >= 3);
  t.server.mode = 200;
  await t.clock.advance(31000);                   // the next, at 90 s: still under 2 minutes old
  const last = t.server.fetches().pop();
  check('the retry landed, still a pause at the paused place', last.status === 200 && last.body.event === 'pause' && last.body.offset_ms === p.offset, last.body);
  t.saver.stop();
}

current = 'a failed save is retried for what it was: the end stays an end';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(2000);
  t.server.mode = 'offline';
  p.playing = false;
  p.offset = p.duration;
  p.emit('ended');
  await t.clock.advance(15000);
  check('the end failed', t.server.fetches().some((c) => c.body.event === 'end' && c.status === 0));
  t.server.mode = 200;
  await t.clock.advance(25000);
  const last = t.server.fetches().pop();
  check('its retry is an end too', last.status === 200 && last.body.event === 'end' && last.body.offset_ms === p.duration, last.body);
  t.saver.stop();
}

current = 'a request that never answers counts as a failure';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(1000);
  t.server.mode = 'hang';
  await p.listen(60000);
  check('warned', t.saver.warning === true);
  const hung = t.server.fetches().filter((c) => c.done === null);
  check('retried after giving up on it', hung.length >= 2, hung.length);
  check('one given up on before the next', gaps(hung).every((g) => g >= S.POST_TIMEOUT_MS), gaps(hung));
  t.saver.stop();
}

// ---- 8. Review Focus 3: a background tab ----
current = 'background throttling still saves from timeupdate and does not warn';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(5000);
  t.clock.throttled = true;                      // the page's timers stop; timeupdate goes on
  const n = t.server.fetches().length;
  await p.listen(120000);
  const bg = t.server.fetches().slice(n);
  check('saves went on, about every 10 s', bg.length >= 11 && bg.length <= 13, bg.length);
  check('10 s apart', gaps(bg).every((g) => g >= 10000 && g <= 10250), gaps(bg));
  check('no warning while hidden with saves succeeding', t.warnings.length === 0, t.warnings);
  // Frozen outright (a phone screen off: no timeupdate either), then back:
  // the stale timer is not a failure, so still no warning.
  t.clock.throttled = true;
  await t.clock.advance(300000);
  t.clock.throttled = false;
  await p.listen(1000);
  check('back from a freeze: no warning, a save', t.warnings.length === 0 && t.server.fetches().pop().status === 200, t.warnings);
  // Hidden and failing: the warning still comes, driven by timeupdate alone.
  t.clock.throttled = true;
  t.server.mode = 503;
  await p.listen(45000);
  check('hidden but failing: warned', t.warnings.filter((w) => w.active).length === 1, t.warnings);
  t.clock.throttled = false;
  t.saver.stop();
}

// ---- 9. Review Focus 5: signed out mid-listen ----
current = 'a 401 keeps the local copy and it wins after sign-in';
{
  const clock = fakeClock();
  const server = fakeServer(clock);
  const storage = fakeStorage();
  const a = makeSaver({ clock, server, storage });
  const p = listener(a);
  a.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(21000);                          // saved at 0, 10 and 20 s
  const stored = JSON.parse(JSON.stringify(server.row));
  check('stored before the sign-out', stored.offset_ms >= 19000, stored);
  server.mode = 401;                              // a deploy restarted Redis
  await p.listen(75000);
  check('the sign-in path is followed once', a.signedOut.length === 1, a.signedOut);
  const after = server.fetches().filter((c) => c.status === 401);
  check('no retry loop after the 401', after.length === 1, after.length);
  check('the local copy keeps the place', localOf(a).offset_ms === p.offset && p.offset > stored.offset_ms, [localOf(a), p.offset]);
  check('no beacon either (it would only 401)', a.saver.flush('beacon', 'leave') === false);
  const lost = p.offset;
  a.saver.stop();
  // Signed in again: a new page session, the same browser.
  server.mode = 200;
  await clock.advance(20000);
  const b = makeSaver({ clock, server, storage });
  const web = { track: server.row.track, offset_ms: server.row.offset_ms, duration_ms: server.row.duration_ms, updated_at: server.row.updated_at, device: server.row.device, source: 'web' };
  const pick = S.resolveResume({ web, plex: null, local: b.saver.readLocal('500:1') });
  check('the local copy wins', pick.source === 'local' && pick.offset_ms === lost, pick);
  b.saver.start('500:1', { push: pick.source === 'local' });
  const q = listener(b);
  q.offset = pick.offset_ms;
  q.open();
  await clock.advance(500);
  check('and is posted at once', server.row.offset_ms === lost && server.row.psid === b.saver.psid, server.row);
  b.saver.stop();
}

current = 'the local copy\'s time is in the server\'s clock, so a fast or slow device compares fairly';
{
  const clock = fakeClock();
  const server = fakeServer(clock);
  server.skewMs = -120000;                        // this device runs two minutes fast
  const t = makeSaver({ clock, server });
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(12000);
  server.mode = 401;
  await p.listen(5000);
  const c = localOf(t);
  const serverNow = clock.now + server.skewMs;
  check('stamped in server time (within 1 s)', Math.abs(Date.parse(c.updated_at) - serverNow) <= 1000, [c.updated_at, new Date(serverNow).toISOString()]);
  const web = { track: server.row.track, offset_ms: server.row.offset_ms, updated_at: server.row.updated_at };
  check('newer than the last stored save, as it is', S.resolveResume({ web, local: c }).source === 'local');
  // Another device then saves (server time, 30 s later): that one wins.
  const other = { track: '501', offset_ms: 1, updated_at: new Date(serverNow + 30000).toISOString() };
  check('a later save elsewhere beats it', S.resolveResume({ web: other, local: c }).source === 'web');
  t.saver.stop();
  // A new page session on the same device uses the clock it learned.
  const u = makeSaver({ clock, server: fakeServer(clock), storage: t.storage });
  const q = listener(u, '700:1');
  u.saver.start('700:1');
  q.open();
  const c2 = localOf(u, '700:1');
  check('the next page session stamps in server time too', Math.abs(Date.parse(c2.updated_at) - (clock.now - 120000)) <= 1000, c2.updated_at);
  u.saver.stop();
}

// ---- 10. stop() ----
current = 'stop() saves the last place once and leaves no timers';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book);
  p.open();
  p.play();
  await p.listen(4000);
  const n = t.server.fetches().length;
  t.saver.stop();
  await t.clock.advance(200);
  const f = t.server.fetches();
  check('one final save', f.length === n + 1 && f[n].body.event === 'leave' && f[n].body.offset_ms === p.offset, f.slice(n).map((c) => c.body));
  check('no timers left', t.clock.pageTimers() === 0, t.clock.pageTimers());
  p.emit('time');
  await t.clock.advance(60000);
  check('nothing after stop', t.server.fetches().length === n + 1);
  check('warning state reset', t.saver.warning === false && t.saver.lastSavedAt === null);
  // Stopped while a save is in flight: the final one waits for it.
  const u = makeSaver();
  u.server.latency = 3000;
  const q = listener(u);
  u.saver.start(q.book);
  q.open();
  q.play();
  await q.listen(500);
  u.saver.stop();
  await u.clock.advance(100);
  check('one in flight at a time, even for the final save', u.server.maxInflight === 1 && u.server.fetches().length === 1);
  await u.clock.advance(6000);
  check('then the final save', u.server.fetches().length === 2 && u.server.fetches()[1].body.event === 'leave');
  check('no timers left after it', u.clock.pageTimers() === 0);
  // Paused and saved: nothing to send.
  const w = makeSaver();
  const r = listener(w);
  w.saver.start(r.book);
  r.open();
  r.play();
  await r.listen(2000);
  r.pause();
  await w.clock.advance(2000);
  const m = w.server.fetches().length;
  w.saver.stop();
  await w.clock.advance(1000);
  check('paused and saved: stop sends nothing', w.server.fetches().length === m);
}

// ---- 11. With the engine ----
// A small <audio>: a src loads its metadata after 50 ms; playing advances
// 250 ms per 250 ms with a timeupdate; the end of the media ends it.
const REMOTE = 'https://198-51-100-7.abcdef.plex.direct:32400';
const BOOK = {
  key: '500:1', title: 'Three Parts', author: 'A. Writer', narrator: '', series: '', cover: '', duration_ms: 1800000, shape: 'parts',
  tracks: [
    { key: '501', part_path: '/library/parts/901/1/file.mp3', duration_ms: 600000, index: 1 },
    { key: '502', part_path: '/library/parts/902/1/file.mp3', duration_ms: 900000, index: 2 },
    { key: '503', part_path: '/library/parts/903/1/file.mp3', duration_ms: 300000, index: 3 }
  ],
  chapters: [{ index: 1, label: 'One', start_ms: 0, end_ms: 1800000, track: '501', track_start_ms: 0, track_end_ms: 600000 }]
};
// A book this browser cannot decode (E-AC3): never loaded, never saved.
const LOUD = {
  key: '800:1', title: 'Loud Book', author: 'C. Writer', narrator: '', series: '', cover: '', duration_ms: 72000000, shape: 'single',
  tracks: [{ key: '801', part_path: '/library/parts/981/1/file.m4b', duration_ms: 72000000, index: 1,
    container: 'mp4', codec: 'eac3', profile: 'dolby digital plus + dolby atmos' }],
  chapters: [{ index: 1, label: 'One', start_ms: 0, end_ms: 72000000, track: '801', track_start_ms: 0, track_end_ms: 72000000 }]
};
const durations = new Map(BOOK.tracks.concat(LOUD.tracks).map((t) => [t.part_path, t.duration_ms]));
class MiniAudio {
  constructor(clock, net) {
    this.net = net || {};                         // net.failLoads: every load fails (the stream is down)
    this.clock = clock; this.ls = new Map(); this._src = ''; this._t = 0; this.gen = 0;
    this.paused = true; this.ended = false; this.error = null; this.readyState = 0; this.seeking = false;
    this.duration = NaN; this.playbackRate = 1; this.defaultPlaybackRate = 1; this.preload = 'auto'; this.ticking = false;
  }
  canPlayType(mime) { return mime === '' || mime.indexOf('ec-3') !== -1 ? '' : 'probably'; }
  addEventListener(t, fn) { if (!this.ls.has(t)) this.ls.set(t, []); this.ls.get(t).push(fn); }
  removeEventListener() {}
  fire(t) { for (const fn of (this.ls.get(t) || []).slice()) fn.call(this, { type: t }); const h = this['on' + t]; if (typeof h === 'function') h.call(this, { type: t }); }
  setAttribute() {}
  getAttribute(n) { return n === 'src' ? (this._src || null) : null; }
  removeAttribute(n) { if (n === 'src') this._src = ''; }
  get src() { return this._src; }
  set src(v) { this._src = String(v); this.select(); }
  load() { this.select(); }
  get currentTime() { return this._t; }
  set currentTime(v) { this._t = Number(v); if (this.readyState) this.clock.setTimeout(() => this.fire('timeupdate'), 10); }
  select() {
    const g = ++this.gen;
    this.paused = true; this.ended = false; this.readyState = 0; this._t = 0; this.ticking = false; this.duration = NaN;
    if (!this._src) return;
    const d = durations.get(new URL(this._src).pathname);
    this.error = null;
    this.clock.setTimeout(() => {
      if (g !== this.gen) return;
      if (this.net.failLoads) { this.error = { code: 4 }; this.fire('error'); return; }
      this.duration = d / 1000; this.readyState = 4;
      this.fire('loadedmetadata');
      if (!this.paused) this.begin();
    }, 50);
  }
  play() {
    if (this.paused) { this.paused = false; this.fire('play'); if (this.readyState >= 3) this.begin(); }
    return Promise.resolve();
  }
  pause() { if (this.paused) return; this.paused = true; this.ticking = false; this.fire('pause'); }
  begin() { if (this.ticking || this.paused) return; this.ticking = true; this.fire('playing'); this.tick(this.gen); }
  tick(g) {
    this.clock.setTimeout(() => {
      if (g !== this.gen || this.paused || !this.ticking) return;
      this._t = Math.min(this.duration, this._t + 0.25);
      this.fire('timeupdate');
      if (this._t >= this.duration) { this.ticking = false; this.paused = true; this.ended = true; this.fire('pause'); this.fire('ended'); return; }
      this.tick(g);
    }, 250);
  }
}

function withEngine(o = {}) {
  const clock = o.clock || fakeClock();
  const server = o.server || fakeServer(clock);
  const storage = o.storage || fakeStorage();
  const places = o.places || { web: null, plex: null };
  const got = [];
  const dismissals = [];
  const t = makeSaver({ clock, server, storage });
  const net = { failLoads: false };
  const audios = [];
  const engine = E.createEngine({
    host: { appendChild() {} },
    createAudio: () => { const a = new MiniAudio(clock, net); audios.push(a); return a; },
    fetch: async (url, init) => {
      got.push(url);
      const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });
      let m = /^\/api\/player\/book\/([^?]+)/.exec(url);
      if (m) return reply(200, Object.assign({}, o.book || BOOK, { stream: { token: 'tok', uris: { local: [], remote: o.noStream ? [] : [REMOTE] } } }));
      // The safety net (spec 2.6): o.orphans answers GET /api/player/orphans/<key>
      // (an array of places, or nothing: a 404); a POST to .../dismiss is kept in dismissals.
      if (/^\/api\/player\/orphans\//.test(url)) {
        if (init && init.method === 'POST') { dismissals.push(url); return reply(200, { dismissed: true }); }
        return o.orphans ? reply(200, { orphans: o.orphans, dismissed: false }) : reply(404, { detail: 'Not Found' });
      }
      m = /^\/api\/player\/position\/(.+)$/.exec(url);
      if (m && o.slowPosition && got.filter((u) => u.indexOf('/position/') !== -1).length > 1) {
        await new Promise((r) => clock.setTimeout(r, o.slowPosition));    // a late re-read that takes a while
      }
      if (m) return o.positionStatus ? reply(o.positionStatus, { detail: 'down' })
        : reply(200, Object.assign({ now: new Date(clock.now + server.skewMs).toISOString() }, places));
      return reply(404, { detail: 'Not Found' });
    },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    mediaSession: o.mediaSession || null,
    MediaMetadata: null,
    baseUrl: 'https://ws.test/',
    saver: t.saver,
    // o.wallClock: the engine's wall clock is the fake one (its late Play counts it).
    now: o.wallClock ? () => clock.now : undefined
  });
  const log = { change: [], warning: [], error: [], order: [] };
  engine.on('change', (d) => {
    log.change.push({ reason: d.reason, saveError: d.state.saveError, lastSavedAt: d.state.lastSavedAt });
    log.order.push(['change', d.reason, d.state.saveError]);
  });
  engine.on('warning', (w) => { log.warning.push(w); log.order.push(['warning', w.kind, w.active]); });
  engine.on('error', (e) => log.error.push(e));
  return Object.assign(t, { engine, got, log, places, net, audios, dismissals });
}
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const setLocal = (storage, place) => storage.map.set('ws-player:place:' + IDENTITY + ':500:1', JSON.stringify(place));

current = 'the engine resumes at the newest copy and sends a newer local copy at once';
{
  const storage = fakeStorage();
  setLocal(storage, { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-10), device: 'Chrome on Android' });
  const t = withEngine({ storage, places: {
    web: { track: '501', offset_ms: 100000, duration_ms: 600000, updated_at: iso(-600), device: 'Chrome on Windows', source: 'web' },
    plex: { track: '502', offset_ms: 50000, duration_ms: 900000, updated_at: iso(-300), device: 'Plex', source: 'plex' }
  } });
  const opened = t.engine.open('500:1');
  await t.clock.advance(1000);
  await opened;
  check('asked for the positions', t.got.includes('/api/player/position/500%3A1'), t.got);
  const s = t.engine.state();
  check('opened at the local copy', s.position && s.position.track === '502' && Math.abs(s.position.offset_ms - 300000) <= 1000, s.position);
  check('state says where it resumed from', s.resumedFrom && s.resumedFrom.source === 'local' && s.resumedFrom.device === 'Chrome on Android', s.resumedFrom);
  const f = t.server.fetches();
  check('the local copy was sent at once', f.length >= 1 && f[0].body.track === '502' && f[0].body.offset_ms === 300000, f.map((c) => c.body));
  check('and stored', t.server.row && t.server.row.track === '502');
  t.engine.close();
}

current = 'a newer local copy is sent at once even when the book only loads (autoplay off)';
{
  // This browser's own place (played here), never taken by the server.
  const storage = fakeStorage();
  setLocal(storage, { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-10), device: 'Chrome on Android', own: true, acked: false });
  const t = withEngine({ storage, places: { web: { track: '501', offset_ms: 100000, duration_ms: 600000, updated_at: iso(-600) }, plex: null } });
  const opened = t.engine.open('500:1', { autoplay: false });
  await t.clock.advance(1000);
  await opened;
  check('not playing', t.engine.state().playing === false);
  const f = t.server.fetches();
  check('sent at once', f.length === 1 && f[0].body.track === '502' && f[0].body.offset_ms === 300000, f.map((c) => c.body));
  check('as a pause (nothing plays)', f[0] && f[0].body.event === 'pause', f[0] && f[0].body.event);
  t.engine.close();
  const u = withEngine({ places: { web: { track: '501', offset_ms: 100000, duration_ms: 600000, updated_at: iso(-10) }, plex: null } });
  const opened2 = u.engine.open('500:1', { autoplay: false });
  await u.clock.advance(15000);
  await opened2;
  check('the server\'s own place, loaded only: nothing to send', u.server.calls.length === 0, u.server.calls.map((c) => c.body));
  u.engine.close();
  check('and nothing on close', u.server.calls.length === 0);
}

// Final review F1: only this browser's own place the server never took is
// newer listening to send. A copy of an opening place nobody listened from
// (own false), or one the server already has (acked), is not pushed: it
// would take the row from the device that saved it.
current = 'F1: a newer local copy that is not this browser\'s own unsent place is not pushed';
for (const [label, extra] of [['untouched (own false)', { own: false, acked: true }], ['an old copy with no own flag', {}],
  ['own but acknowledged', { own: true, acked: true }]]) {
  const storage = fakeStorage();
  setLocal(storage, Object.assign({ track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-10), device: 'Chrome on Android' }, extra));
  const t = withEngine({ storage, places: { web: { track: '501', offset_ms: 100000, duration_ms: 600000, updated_at: iso(-600) }, plex: null } });
  const opened = t.engine.open('500:1', { autoplay: false });
  await t.clock.advance(15000);
  await opened;
  check(label + ': nothing sent', t.server.calls.length === 0, t.server.calls.map((c) => c.body));
  t.engine.close();
  await t.clock.advance(1000);
  check(label + ': nothing on close either', t.server.calls.length === 0, t.server.calls.map((c) => c.body));
}

current = 'F1: an untouched open keeps the stamp of the copy it opened at';
{
  // Opened at the server's place, never played, closed: the local copy of
  // it is stamped as that copy was, not "now", so the next open does not
  // take it for newer listening.
  const web = { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-600), device: 'Chrome on Linux' };
  const storage = fakeStorage();
  const t = withEngine({ storage, places: { web, plex: null } });
  const opened = t.engine.open('500:1', { autoplay: false });
  await t.clock.advance(3000);
  await opened;
  const l = JSON.parse(storage.map.get('ws-player:place:' + IDENTITY + ':500:1'));
  check('the opening place, stamped as the web copy', l.track === '502' && l.offset_ms === 300000 && l.updated_at === web.updated_at && l.own === false, l);
  t.engine.close();
  await t.clock.advance(60000);
  // The next open: the web copy (equal stamp) is the one resumed from; nothing is pushed.
  const u = withEngine({ storage, places: { web, plex: null } });
  const opened2 = u.engine.open('500:1', { autoplay: false });
  await u.clock.advance(15000);
  await opened2;
  check('resumed from the web copy', u.engine.state().resumedFrom.source === 'web', u.engine.state().resumedFrom);
  check('nothing sent', u.server.calls.length === 0, u.server.calls.map((c) => c.body));
  u.engine.close();
  // Played here, it is this browser's own place, stamped when reached.
  const v = withEngine({ storage, places: { web, plex: null } });
  const opened3 = v.engine.open('500:1');
  await v.clock.advance(3000);
  await opened3;
  const l2 = JSON.parse(storage.map.get('ws-player:place:' + IDENTITY + ':500:1'));
  check('played: its own place, stamped now', l2.own === true && Date.parse(l2.updated_at) > Date.parse(web.updated_at), l2);
  v.engine.close();
}

current = 'the engine resumes at WebServarr\'s place when it is newest, and saves as it plays';
{
  const t = withEngine({ places: {
    web: { track: '502', offset_ms: 200000, duration_ms: 900000, updated_at: iso(-5), device: 'Chrome on Windows', source: 'web' },
    plex: { track: '501', offset_ms: 50000, duration_ms: 600000, updated_at: iso(-300), device: 'Plex', source: 'plex' }
  } });
  const opened = t.engine.open('500:1');
  await t.clock.advance(1000);
  await opened;
  const s = t.engine.state();
  check('opened at the web place', s.position.track === '502' && s.position.offset_ms >= 200000 && s.position.offset_ms <= 201000, s.position);
  check('resumedFrom web', s.resumedFrom.source === 'web');
  // Its age in the server's clock (its now on GET /position less updated_at),
  // for smart rewind (features.js).
  check('resumedFrom carries the place\'s age', typeof s.resumedFrom.age_ms === 'number' && Math.abs(s.resumedFrom.age_ms - 5000) < 1500, s.resumedFrom);
  await t.clock.advance(25000);
  const f = t.server.fetches();
  check('saves as it plays: play, then every 10 s', f.length === 3 && f[0].body.event === 'play' && f[1].body.event === 'checkin', f.map((c) => [c.at - T0, c.body.event, c.body.offset_ms]));
  check('from the web place on', f[0].body.track === '502' && f[0].body.offset_ms >= 200000);
  check('state().lastSavedAt is the last success', t.engine.state().lastSavedAt === f[f.length - 1].done, t.engine.state().lastSavedAt);
  check('state().saveError false', t.engine.state().saveError === false);
  const localNow = localOf(t);
  check('the local copy follows the place', localNow.track === '502' && localNow.offset_ms === t.engine.state().position.offset_ms);
  t.engine.pause();
  await t.clock.advance(1100);
  check('the engine\'s pause is saved at once', t.server.fetches().pop().body.event === 'pause');
  t.engine.close();
}

current = 'a seek refused because the part can\'t play: saving carries on';
{
  const mixed = JSON.parse(JSON.stringify(BOOK));
  Object.assign(mixed.tracks[1], { container: 'mp4', codec: 'eac3', profile: '' });
  const t = withEngine({ book: mixed, places: {
    web: { track: '501', offset_ms: 100000, duration_ms: 600000, updated_at: iso(-5), device: 'Chrome on Windows', source: 'web' },
    plex: null
  } });
  const opened = t.engine.open('500:1');
  await t.clock.advance(1500);
  await opened;
  t.engine.seek(700000);                    // into the undecodable part 2
  await t.clock.advance(60000);
  const f = t.server.fetches();
  check('refused with a notice, no error', t.log.warning.some((w) => w.kind === 'part-format') && t.log.error.length === 0 &&
    t.engine.state().playing, t.log.error);
  check('saves go on every 10 s from part 1', f.length >= 6 && f.every((c) => c.body.track === '501') &&
    f[f.length - 1].body.offset_ms > 155000, f.map((c) => [c.body.event, c.body.offset_ms]));
  t.engine.close();
}

current = 'an undecodable book saves nothing, not even a newer local copy';
{
  const storage = fakeStorage();
  const local = { track: '801', offset_ms: 5000000, duration_ms: 72000000, updated_at: iso(-10), device: 'Chrome on Android' };
  storage.map.set('ws-player:place:' + IDENTITY + ':800:1', JSON.stringify(local));
  const t = withEngine({ book: LOUD, storage, places: {
    web: { track: '801', offset_ms: 100000, duration_ms: 72000000, updated_at: iso(-600), device: 'Chrome on Windows', source: 'web' },
    plex: null
  } });
  const opened = t.engine.open('800:1');
  await t.clock.advance(1000);
  await opened;
  const s = t.engine.state();
  check('the format message at the newest place', s.error && s.error.code === 'format' && s.position.offset_ms === 5000000, [s.error, s.position]);
  await t.engine.play();
  await t.clock.advance(30000);
  t.engine.close();
  await t.clock.advance(20000);
  check('nothing sent: no push, no save, no final', t.server.calls.length === 0, t.server.calls.map((c) => c.body));
  check('nothing loaded', t.audios.every((a) => !a.src));
  const copy = localOf(t, '800:1');
  // (Opening any book writes its opening place to the local copy, as at
  // 1a54220; the place itself is unchanged.)
  check('the local copy keeps the place', copy && copy.track === '801' && copy.offset_ms === 5000000, copy);
}

// Spec 2.5 s4 (replaces T5E3's fallback: the next newest copy, else 0 with
// "Couldn't find your saved place in this book"): the newest copy names a
// part the book no longer has, so the files changed. The open holds at the
// start, nothing is saved and the local copy is left as it is, until the
// listener places it (confirmPlace, startOver). An older copy in a part the
// book has is never jumped to on its own.
current = 'a saved place in a part the book no longer has: files changed, held at the start, nothing saved';
{
  const storage = fakeStorage();
  setLocal(storage, { track: '999', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-10), device: 'Chrome on Android', own: true, acked: false,
    book_ms: 900000, book_duration_ms: 1800000, chapter_label: 'Chapter 7' });
  const kept = storage.map.get('ws-player:place:' + IDENTITY + ':500:1');
  const t = withEngine({ storage, places: {
    web: { track: '503', offset_ms: 12000, duration_ms: 300000, updated_at: iso(-600), device: 'Chrome on Windows', source: 'web' },
    plex: { track: '998', offset_ms: 50000, duration_ms: 900000, updated_at: iso(-300), device: 'Plex', source: 'plex' }
  } });
  let threw = null;
  const opened = t.engine.open('500:1').catch((e) => { threw = e; });
  await t.clock.advance(1000);
  await opened;
  check('open does not reject', threw === null, threw && threw.name);
  const s = t.engine.state();
  const old = s.filesChanged && s.filesChanged.old;
  check('files changed, from the newest copy (local)', old && old.source === 'local' && old.track === '999' && old.offset_ms === 300000 &&
    old.book_ms === 900000 && old.book_duration_ms === 1800000 && old.chapter_label === 'Chapter 7' && old.updated_at === iso(-10) &&
    old.linked_from === null, s.filesChanged);
  check('held at the start, not the older web place', s.position.track === '501' && s.position.offset_ms === 0 && !s.playing, s.position);
  check('a files-changed warning, no "couldn\'t find" notice', t.log.warning.length === 1 && t.log.warning[0].kind === 'files-changed', t.log.warning);
  check('resumedFrom null', s.resumedFrom === null);
  await t.clock.advance(60000);
  check('nothing sent', t.server.calls.length === 0, t.server.calls.map((c) => c.body));
  check('the local copy is as it was', storage.map.get('ws-player:place:' + IDENTITY + ':500:1') === kept);
  t.engine.close();
  await t.clock.advance(20000);
  check('nothing on close', t.server.calls.length === 0, t.server.calls.map((c) => c.body));
  check('the local copy is still as it was', storage.map.get('ws-player:place:' + IDENTITY + ':500:1') === kept);

  const u = withEngine({ places: { web: { track: '997', offset_ms: 1, duration_ms: 900000, updated_at: iso(-600), book_ms: 1200001 }, plex: null } });
  const opened2 = u.engine.open('500:1');
  await u.clock.advance(1000);
  await opened2;
  const old2 = u.engine.state().filesChanged && u.engine.state().filesChanged.old;
  check('a web copy in a missing part: files changed from it', old2 && old2.source === 'web' && old2.track === '997' && old2.book_ms === 1200001 &&
    old2.book_duration_ms === null && old2.chapter_label === null, old2);
  check('not playing, nothing sent, no local copy', !u.engine.state().playing && u.server.calls.length === 0 && localOf(u) === null);
  u.engine.close();

  const v = withEngine();
  const opened3 = v.engine.open('500:1');
  await v.clock.advance(1000);
  await opened3;
  check('no saved place at all: the start, no warning', v.engine.state().position.track === '501' && v.log.warning.length === 0 &&
    v.engine.state().filesChanged === null);
  v.engine.close();

  // The newest copy in a part the book has: resumed as ever, whatever an older one names.
  const w = withEngine({ places: { web: { track: '503', offset_ms: 12000, duration_ms: 300000, updated_at: iso(-5) },
    plex: { track: '998', offset_ms: 50000, duration_ms: 900000, updated_at: iso(-300) } } });
  const opened4 = w.engine.open('500:1');
  await w.clock.advance(1000);
  await opened4;
  check('an older copy in a missing part changes nothing', w.engine.state().filesChanged === null && w.engine.state().position.track === '503' &&
    w.log.warning.length === 0, w.engine.state().position);
  w.engine.close();
}

current = 'open() at a place the book does not have still rejects, with a saver too';
{
  const t = withEngine();
  let threw = null;
  const opened = t.engine.open('500:1', { at: { track: '999', offset_ms: 5 } }).catch((e) => { threw = e; });
  await t.clock.advance(500);
  await opened;
  check('UnknownTrack', threw && threw.name === 'UnknownTrack');
  check('nothing saved', t.server.calls.length === 0 && localOf(t) === null);
  const opened2 = t.engine.open('500:1', { at: { track: '502', offset_ms: 7000 } });
  await t.clock.advance(1000);
  await opened2;
  check('an explicit place is not merged', t.engine.state().position.track === '502' && !t.got.some((u) => u.indexOf('/position/') !== -1), t.got);
  t.engine.close();
}

current = 'the positions failing: the open fails with Retry, nothing is saved';
{
  const t = withEngine({ positionStatus: 503, places: { web: null, plex: null } });
  const opened = t.engine.open('500:1');
  await t.clock.advance(1000);
  await opened;
  check('an unreachable error with a retry', t.log.error.length === 1 && t.log.error[0].code === 'unreachable' && typeof t.log.error[0].retry === 'function', t.log.error);
  check('nothing loaded, nothing saved', t.engine.state().position === null && t.server.calls.length === 0 && localOf(t) === null);
  t.engine.close();
}

current = 'the engine\'s state and events for the warning';
{
  const t = withEngine({ places: { web: null, plex: null } });
  const opened = t.engine.open('500:1');
  await t.clock.advance(12000);
  await opened;
  t.server.mode = 'offline';
  t.clock.throttled = true;                       // a background tab: only timeupdate drives the saves
  await t.clock.advance(45000);
  t.clock.throttled = false;
  const w = t.log.warning.filter((x) => x.kind === 'not-saved');
  check('a not-saved warning event', w.length === 1 && w[0].active === true && /^Your place isn't being saved\. Last saved /.test(w[0].message), t.log.warning);
  check('state().saveError', t.engine.state().saveError === true);
  const flip = t.log.change.find((c) => c.reason === 'save');
  check('a change with reason save carrying it', flip && flip.saveError === true, t.log.change.slice(-3));
  const later = t.log.change.filter((c) => c.reason === 'time').pop();
  check('later changes carry it too', later && later.saveError === true);
  const from = t.log.order.findIndex((x) => x[0] === 'warning' && x[1] === 'not-saved' && x[2] === true);
  const stale = t.log.order.slice(from + 1).filter((x) => x[0] === 'change' && x[2] !== true);
  check('no change after the warning says otherwise (not even the one it came in)', from !== -1 && stale.length === 0, stale.slice(0, 3));
  t.server.mode = 200;
  await t.clock.advance(31000);
  const w2 = t.log.warning.filter((x) => x.kind === 'not-saved');
  check('cleared: an event and the state', w2.length === 2 && w2[1].active === false && t.engine.state().saveError === false, w2);
  t.engine.close();
  check('close() sends the last place', t.server.fetches().pop().body.event === 'leave');
}

current = 'the engine\'s end of the book is saved as end';
{
  const t = withEngine({ places: { web: { track: '503', offset_ms: 297000, duration_ms: 300000, updated_at: iso(-5) }, plex: null } });
  const opened = t.engine.open('500:1');
  await t.clock.advance(6000);
  await opened;
  const f = t.server.fetches();
  check('end sent at the end', f.some((c) => c.body.event === 'end' && c.body.track === '503' && c.body.offset_ms === 300000), f.map((c) => [c.body.event, c.body.offset_ms]));
  t.engine.close();
}

current = 'Review Focus 5 end to end: signed out mid-listen, back in, resumed from the local copy';
{
  const clock = fakeClock();
  const server = fakeServer(clock);
  const storage = fakeStorage();
  const a = withEngine({ clock, server, storage, places: { web: null, plex: null } });
  const opened = a.engine.open('500:1');
  await clock.advance(22000);
  await opened;
  const before = server.row.offset_ms;
  server.mode = 401;
  await clock.advance(15000);
  check('the sign-in path is followed', a.signedOut.length === 1);
  const place = a.engine.state().position.offset_ms;
  check('the local copy holds the latest place', localOf(a).offset_ms === place && place > before + 10000, [localOf(a), before]);
  a.engine.close();
  server.mode = 200;
  const web = { track: server.row.track, offset_ms: server.row.offset_ms, duration_ms: server.row.duration_ms, updated_at: server.row.updated_at, device: server.row.device, source: 'web' };
  const b = withEngine({ clock, server, storage, places: { web, plex: null } });
  const opened2 = b.engine.open('500:1');
  await clock.advance(400);
  await opened2;
  check('resumed from the local copy', b.engine.state().resumedFrom.source === 'local' &&
    Math.abs(b.engine.state().position.offset_ms - place) <= 500, [b.engine.state().position, place]);
  check('which the server now holds', server.row.offset_ms === place && server.row.psid === b.saver.psid, server.row);
  b.engine.close();
}

// ---- 12. Fix round 1 (the hunters' probes as regression cases) ----

current = 'T6E1: reopening mid-save, the old run\'s final never outranks the new place';
{
  const t = makeSaver();
  t.server.latency = 3000;                       // a cold first check-in (~3.9 s on dev)
  const a = listener(t);
  t.saver.start(a.book); a.open(); a.play();
  await a.listen(10100);                         // the 10 s save is in flight
  t.saver.stop();                                // the same book opened again, at another place
  t.saver.start('500:1');
  const b = listener(t);
  b.offset = 2400000; b.open(); b.playing = true; b.emit('play');
  await t.clock.advance(8000);                   // the old save answers, the old final follows
  const fin = t.server.calls.find((c) => c.body.event === 'leave');
  const newer = t.server.calls.filter((c) => c.body.offset_ms >= 2400000);
  check('the old final took its seq at stop, below the new run\'s', fin && newer.length && newer.every((c) => c.body.seq > fin.body.seq),
    t.server.calls.map((c) => [c.body.seq, c.body.event, c.body.offset_ms]));
  check('the server holds the new place', t.server.row.offset_ms >= 2400000, t.server.row);
  t.saver.stop();
}

for (const variant of ['at-then-pause', 'close-reopen-seek-pause']) {
  current = 'T6E1 with the engine: ' + variant + ' while a slow first save is in flight';
  const t = withEngine({ places: { web: { track: '503', offset_ms: 250000, duration_ms: 300000, updated_at: iso(-60), device: 'Chrome on Windows' }, plex: null } });
  let n = 0;
  const orig = t.server.post;
  t.server.post = (b, k) => { n += 1; t.server.latency = n === 1 ? 3900 : 120; return orig(b, k); };
  const pa = t.engine.open('500:1');
  await t.clock.advance(400); await pa;
  if (variant === 'at-then-pause') {
    const pb = t.engine.open('500:1', { at: { track: '501', offset_ms: 50000 } });
    await t.clock.advance(1500); await pb;
  } else {
    t.engine.close();
    const pb = t.engine.open('500:1');
    await t.clock.advance(600); await pb;
    t.engine.seek(100000); await t.clock.advance(1200);
  }
  t.engine.pause();
  const mine = t.engine.state().position;
  await t.clock.advance(30000);
  check('the server holds the engine\'s place', t.server.row.track === mine.track && t.server.row.offset_ms === mine.offset_ms,
    [mine, t.server.row, t.server.calls.map((c) => [c.body.seq, c.body.event, c.body.track, c.body.offset_ms])]);
  t.engine.close();
}

current = 'T6S1: a place unsaved for over 2 minutes is never sent later; the merge decides';
{
  const clock = fakeClock();
  const server = fakeServer(clock);
  let phoneOffline = false;
  const win = new Window({ url: 'https://ws.test/news' });
  win.WS = { user: { identity_key: IDENTITY } };
  const phoneStorage = fakeStorage();
  const phone = S.browserSaver(win, {
    sendBeacon: (url, blob) => { server.calls.push({ kind: 'beacon', body: {}, at: clock.now }); return true; },
    fetch: (url, init) => phoneOffline ? Promise.reject(new TypeError('Failed to fetch'))
      : server.post(JSON.parse(init.body), 'fetch').then((r) => ({ status: r.status, json: async () => r.data })),
    now: () => clock.now, storage: phoneStorage,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (id) => clock.clearTimeout(id)
  });
  phone.start('500:1');
  let off = 1000000, playing = false;
  const note = (reason) => phone.note({ reason, state: { book: '500:1', playing, position: { track: '501', offset_ms: off, duration_ms: 36000000 } } });
  note('open'); playing = true; note('play');
  for (let i = 0; i < 80; i++) { await clock.advance(250); off += 250; note('time'); }
  phoneOffline = true;                            // the subway
  for (let i = 0; i < 1200; i++) { await clock.advance(250); off += 250; note('time'); }
  playing = false; note('pause');
  const pausedAt = off;
  const pausedWall = clock.now;
  await clock.advance(30 * 60000);                // the desktop resumes from the server and plays on
  const desk = makeSaver({ clock, server });
  const d = listener(desk);
  d.offset = server.row.offset_ms;
  d.duration = 36000000;
  desk.saver.start('500:1', { held: { track: '501', offset_ms: d.offset } });
  d.open(); d.play();
  await d.listen(3600000);
  d.pause(); await clock.advance(2000); desk.saver.stop();
  const deskPlace = d.offset;
  check('the desktop\'s place is stored', server.row.offset_ms === deskPlace, server.row.offset_ms);
  await clock.advance(10 * 3600000);              // next morning the phone is back on a network
  const before = server.calls.length;
  phoneOffline = false;
  win.dispatchEvent(new win.Event('online'));
  await clock.advance(60000);
  win.dispatchEvent(new win.Event('pagehide'));
  check('the phone sends nothing: not a retry, not a beacon', server.calls.length === before, server.calls.slice(before).map((c) => [c.kind, c.body.offset_ms]));
  check('the desktop\'s place stands', server.row.offset_ms === deskPlace, server.row.offset_ms);
  const kept = JSON.parse(phoneStorage.map.get('ws-player:place:' + IDENTITY + ':500:1'));
  check('the phone\'s local copy keeps its place, stamped when it was reached', kept.offset_ms === pausedAt &&
    Math.abs(Date.parse(kept.updated_at) - pausedWall) <= 1000, kept);
  const pick = S.resolveResume({ web: { track: '501', offset_ms: server.row.offset_ms, updated_at: server.row.updated_at }, local: kept });
  check('the next open on the phone resumes at the desktop\'s place', pick.source === 'web' && pick.offset_ms === deskPlace, pick);
  // Pressing play on the stale tab makes its place current again: it is sent.
  playing = true; note('play');
  await clock.advance(1500);
  check('a place the listener acts on again is current: sent', server.row.offset_ms === pausedAt && server.row.psid === phone.psid, server.row.offset_ms);
  phone.stop();
  await win.happyDOM.close();
}

current = 'T6S1: a stale unsaved place gets no final save on stop';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book); p.open(); p.play();
  await p.listen(3000);
  t.server.mode = 'offline';
  p.pause();
  await t.clock.advance(180000);
  t.server.mode = 200;
  const n = t.server.calls.length;
  t.saver.stop();
  await t.clock.advance(1000);
  check('no final for a place 3 minutes old', t.server.calls.length === n, t.server.calls.slice(n).map((c) => c.body));
}

current = 'T6S1: an untouched opening place is never sent (only a newer local copy is)';
{
  for (const label of ['plex-resume', 'no-copies']) {
    const places = label === 'plex-resume'
      ? { web: null, plex: { track: '502', offset_ms: 50000, duration_ms: 900000, updated_at: iso(-60), device: 'Plex', source: 'plex' } }
      : { web: null, plex: null };
    const b = withEngine({ places });
    const opened = b.engine.open('500:1', { autoplay: false });
    await b.clock.advance(2000); await opened;
    await b.clock.advance(20 * 60000);
    const sent = b.saver.flush('beacon');
    b.engine.close();
    await b.clock.advance(1000);
    check(label + ': no beacon, no save, no final', sent === false && b.server.calls.length === 0, b.server.calls.map((c) => c.body));
  }
}

current = 'T6S2: any measured skew is kept (a device 8 days fast)';
{
  const clock = fakeClock();
  const server = fakeServer(clock);
  const fastBy = 8 * 86400000;
  server.skewMs = -fastBy;
  const t = makeSaver({ clock, server });
  const p = listener(t);
  t.saver.start(p.book); p.open(); p.play();
  await p.listen(25000);
  t.saver.stop();
  const stored = Number(t.storage.map.get('ws-player:clock'));
  check('stored', Math.abs(stored + fastBy) <= 1000, stored);
  const local = localOf(t);
  check('the local copy is in server time', Math.abs(Date.parse(local.updated_at) - (clock.now - fastBy)) <= 1000, local.updated_at);
  const web = { track: '501', offset_ms: local.offset_ms + 1200000, updated_at: new Date(clock.now - fastBy + 3600000).toISOString() };
  check('a later save elsewhere wins the merge', S.resolveResume({ web, local: t.saver.readLocal('500:1') }).source === 'web');
  const u = makeSaver({ clock, server, storage: t.storage });
  const q = listener(u, '700:1');
  u.saver.start('700:1'); q.open();
  check('the next page session stamps with it before any save', Math.abs(Date.parse(localOf(u, '700:1').updated_at) - (clock.now - fastBy)) <= 1000);
  u.saver.stop();
}

current = 'T6S2: a tab with no successful save measures its clock from GET /position before the merge';
{
  const clock = fakeClock();
  const server = fakeServer(clock);
  server.skewMs = 3 * 3600000;                    // this device is 3 h slow
  const storage = fakeStorage();
  const t = withEngine({ clock, server, storage, places: { web: null, plex: null } });
  server.mode = 503;                              // no check-in will succeed
  const opened = t.engine.open('500:1', { autoplay: false });
  await clock.advance(1000); await opened;
  const c = localOf(t);
  check('the local copy is in server time', c && Math.abs(Date.parse(c.updated_at) - (clock.now + server.skewMs)) <= 1000, c && c.updated_at);
  check('and the clock is kept', Math.abs(Number(storage.map.get('ws-player:clock')) - server.skewMs) <= 1000, storage.map.get('ws-player:clock'));
  t.engine.close();
  // Measured before the copies are weighed: a local copy the next open sends
  // was written in server time.
  const order = [];
  const probe = S.createSaver({ post: () => Promise.resolve({ status: 200 }), now: () => clock.now, mono: () => clock.now, storage: fakeStorage(), identity: IDENTITY,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (id) => clock.clearTimeout(id) });
  const wrapped = Object.assign({}, probe, {
    clockProbe() { const done = probe.clockProbe(); return (v) => { order.push('clock'); done(v); }; },
    resumeFrom(b, c) { order.push('merge'); return probe.resumeFrom(b, c); },
    onWarning: probe.onWarning, start: probe.start, stop: probe.stop, note: probe.note, flush: probe.flush,
    get lastSavedAt() { return probe.lastSavedAt; }, get warning() { return probe.warning; }
  });
  const eng = E.createEngine({
    host: { appendChild() {} }, createAudio: () => new MiniAudio(clock),
    fetch: async (url) => ({ ok: true, status: 200, json: async () => (/position/.test(url)
      ? { web: null, plex: null, now: new Date(clock.now).toISOString() }
      : Object.assign({}, BOOK, { stream: { token: 'tok', uris: { local: [], remote: [REMOTE] } } })) }),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (id) => clock.clearTimeout(id),
    mediaSession: null, MediaMetadata: null, baseUrl: 'https://ws.test/', saver: wrapped
  });
  const op = eng.open('500:1', { autoplay: false });
  await clock.advance(1000); await op;
  check('clock, then merge', order.join() === 'clock,merge', order);
  eng.close();
}

current = 'T6E2: closing or switching while the warning shows ends it for listeners';
{
  for (const how of ['switch', 'close']) {
    const t = withEngine({ places: { web: null, plex: null } });
    const opened = t.engine.open('500:1');
    await t.clock.advance(12000); await opened;
    t.server.mode = 'offline';
    await t.clock.advance(45000);
    check(how + ': warning on', t.engine.state().saveError === true);
    const w0 = t.log.warning.length;
    const c0 = t.log.change.length;
    if (how === 'switch') {
      t.server.mode = 200;
      const q = t.engine.open('500:1', { at: { track: '502', offset_ms: 1000 } });
      await t.clock.advance(2000); await q;
    } else {
      t.engine.close();
    }
    const w = t.log.warning.slice(w0).filter((x) => x.kind === 'not-saved');
    check(how + ': an active:false event', w.length === 1 && w[0].active === false, t.log.warning.slice(w0));
    const firstSave = t.log.change.slice(c0).find((c) => c.reason === 'save');
    check(how + ': a save change with saveError false', firstSave && firstSave.saveError === false, t.log.change.slice(c0, c0 + 3));
    check(how + ': every later change says false', t.log.change.slice(c0).every((c) => c.saveError === false));
    t.engine.close();
  }
}

current = 'T6S4: time frozen with a save in flight does not count against it';
{
  // Frozen while playing: no timers, no timeupdate; the answer comes after the thaw.
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book); p.open(); p.play();
  await p.listen(9750);
  t.server.latency = 5 * 60000 + 300;
  await p.listen(250);
  const pending = t.server.fetches().pop();
  t.clock.throttled = true;
  await t.clock.advance(5 * 60000);
  t.clock.throttled = false; t.server.latency = 80;
  p.offset += 250; p.emit('time');               // the first timeupdate after the thaw, before any timer
  await p.listen(1250);
  await p.listen(15000);
  check('the answer landed', pending.status === 200);
  check('no false warning after the thaw', t.warnings.length === 0, t.warnings);
  t.saver.stop();
  // Paused and frozen (no timeupdate to tell): the lifecycle's resume event restarts the 15 s.
  const win = new Window({ url: 'https://ws.test/news' });
  win.WS = { user: { identity_key: IDENTITY } };
  const clock = fakeClock();
  const server = fakeServer(clock);
  const warned = [];
  const s2 = S.browserSaver(win, {
    sendBeacon: () => true,
    fetch: (url, init) => server.post(JSON.parse(init.body), 'fetch').then((r) => ({ status: r.status, json: async () => r.data })),
    now: () => clock.now, storage: fakeStorage(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (id) => clock.clearTimeout(id)
  });
  s2.onWarning((w) => warned.push(w));
  s2.start('500:1');
  let off = 0;
  const st = (playing) => ({ book: '500:1', playing, position: { track: '501', offset_ms: off, duration_ms: 3600000 } });
  s2.note({ reason: 'play', state: st(true) });
  await clock.advance(500);
  server.latency = 3 * 60000;
  off = 5000;
  s2.note({ reason: 'pause', state: st(false) });
  await clock.advance(600);                       // the pause save goes; the page freezes
  const pauseCall = server.fetches().pop();
  check('the pause is in flight', pauseCall.body.event === 'pause' && pauseCall.done === null);
  clock.throttled = true;
  await clock.advance(3 * 60000 - 1000);
  clock.throttled = false;
  win.document.dispatchEvent(new win.Event('resume'));
  await clock.advance(15000);                     // past the backoff a false failure would start
  check('resume: the in-flight pause was not given up on (no retry, no warning)', pauseCall.status === 200 && server.fetches().length === 2 && warned.length === 0,
    server.fetches().map((c) => [c.body.event, c.status]));
  // A short freeze (12 s of a save's 15): the timer fires on time after it,
  // so only the lifecycle's resume event can say the page was frozen.
  server.latency = 20000;
  off = 9000;
  s2.note({ reason: 'seek', state: st(false) });
  await clock.advance(1100);
  const seekCall = server.fetches().pop();
  clock.throttled = true;
  await clock.advance(12000);
  clock.throttled = false;
  win.document.dispatchEvent(new win.Event('resume'));
  await clock.advance(20000);
  check('a short freeze: the save lands, nothing retried', seekCall.status === 200 && server.fetches().length === 3,
    server.fetches().map((c) => [c.body.event, c.body.offset_ms, c.status]));
  s2.stop();
  await win.happyDOM.close();
}

current = 'T6S4: a timer that fires minutes late (throttled, paused, no event) does not fail the save in flight';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book); p.open(); p.play();
  await p.listen(2000);
  t.server.latency = 3 * 60000;
  p.pause();
  await t.clock.advance(1100);
  const call = t.server.fetches().pop();
  t.clock.throttled = true;
  await t.clock.advance(3 * 60000 - 2000);
  t.clock.throttled = false;
  await t.clock.advance(20000);
  check('no retry: the late timer counted as frozen time', call.status === 200 && t.server.fetches().length === 2,
    t.server.fetches().map((c) => [c.body.event, c.status]));
  check('its answer was taken, not dropped as given up on', t.saver.lastSavedAt === call.done, [t.saver.lastSavedAt, call.done]);
  t.saver.stop();
}

current = 'T6S5: a system clock stepped back never holds a save';
{
  for (const stepMs of [60000, 600000]) {
    const clock = fakeClock();
    let jump = 0;
    const t = makeSaver({ clock, now: () => clock.now - jump });
    const p = listener(t);
    t.saver.start(p.book); p.open(); p.play();
    await p.listen(30000);
    const before = t.server.fetches().length;
    jump = stepMs;
    await p.listen(60000);
    const during = t.server.fetches().slice(before);
    check(`stepped back ${stepMs / 1000} s: still every 10 s`, during.length >= 6 && gaps(during).every((g) => g >= 10000 && g <= 10250), gaps(during));
    p.pause();
    await t.clock.advance(1100);
    check(`stepped back ${stepMs / 1000} s: the pause saved at once`, t.server.fetches().pop().body.event === 'pause');
    check(`stepped back ${stepMs / 1000} s: no warning`, t.warnings.length === 0);
    t.saver.stop();
  }
}

current = 'T6S6: a seek or jump while paused goes as a pause';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start(p.book); p.open(); p.play();
  await p.listen(2000);
  p.pause();
  await t.clock.advance(1100);
  p.seek(300000, 'seek'); await t.clock.advance(1100);
  p.seek(330000, 'skip'); await t.clock.advance(1100);
  p.seek(600000, 'jump'); await t.clock.advance(1100);
  const f = t.server.fetches().slice(-3);
  check('paused: all three as pause, at their places', f.map((c) => c.body.event).join() === 'pause,pause,pause' &&
    f.map((c) => c.body.offset_ms).join() === '300000,330000,600000', f.map((c) => [c.body.event, c.body.offset_ms]));
  p.playing = true;
  p.seek(700000, 'jump'); await t.clock.advance(1100);
  check('playing: a jump is a jump', t.server.fetches().pop().body.event === 'jump');
  t.saver.stop();
}

current = 'T6T2: a real track with no usable offset is never saved or written';
{
  for (const bad of [undefined, NaN, null, 'x', -5, Infinity]) {
    const t = makeSaver();
    t.saver.start('500:1');
    for (const reason of ['open', 'play', 'pause', 'seek', 'time']) {
      t.saver.note({ reason, state: { book: '500:1', playing: reason !== 'pause', position: { track: '501', offset_ms: bad, duration_ms: 600000 } } });
    }
    await t.clock.advance(30000);
    t.saver.flush('beacon', 'leave');
    t.saver.stop();
    await t.clock.advance(1000);
    check(`offset ${String(bad)}: nothing sent, nothing written`, t.server.calls.length === 0 && localOf(t) === null, t.server.calls.map((c) => c.body));
  }
}

// ---- 13. Fix round 2 ----

for (const variant of ['untouched-autoplay-off', 'played-then-paused', 'pagehide-only', 'control-from-web']) {
  current = 'T6S7: a pushed local copy obeys the 2-minute rule too (' + variant + ')';
  const storage = fakeStorage();
  const fromWeb = variant === 'control-from-web';
  if (!fromWeb) {
    setLocal(storage, { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-3600), device: 'Chrome on Android' });
  }
  const t = withEngine({ storage, places: { web: { track: fromWeb ? '502' : '501', offset_ms: fromWeb ? 300000 : 100000, duration_ms: 900000, updated_at: iso(fromWeb ? -60 : -7200), device: 'Chrome on Windows' }, plex: null } });
  t.server.mode = 'offline';                     // the push save fails: the network drops after /position
  const opened = t.engine.open('500:1', variant === 'played-then-paused' ? {} : { autoplay: false });
  await t.clock.advance(1000); await opened;
  check('opened where expected', t.engine.state().resumedFrom.source === (fromWeb ? 'web' : 'local'), t.engine.state().resumedFrom);
  if (variant === 'played-then-paused') {
    await t.clock.advance(60000);
    t.engine.pause();
    await t.clock.advance(1000);
  }
  await t.clock.advance(3600000);
  // The desktop listens on and saves a later place (another psid).
  t.server.row = { book: '500:1', track: '503', offset_ms: 200000, duration_ms: 300000, event: 'pause', device: 'Chrome on Windows',
    psid: 'desk-psid', seq: 50, updated_at: new Date(t.clock.now).toISOString() };
  await t.clock.advance(9 * 3600000);
  const n = t.server.calls.length;
  t.server.mode = 200;                           // the phone is back on a network
  if (variant === 'pagehide-only') t.saver.flush('beacon', 'leave');
  else { t.saver.flush('fetch'); await t.clock.advance(35000); }
  check('nothing sent 10 h later: no retry, flush or beacon', t.server.calls.length === n, t.server.calls.slice(n).map((c) => [c.kind, c.body.event, c.body.track, c.body.offset_ms]));
  check('the desktop\'s place stands', t.server.row.psid === 'desk-psid' && t.server.row.offset_ms === 200000, t.server.row);
  t.engine.close();
  await t.clock.advance(1000);
  check('no final on close either', t.server.calls.length === n, t.server.calls.slice(n).map((c) => [c.kind, c.body.event]));
}

current = 'T6S7: the push itself still goes at once, and is retried while it is under 2 minutes old';
{
  const storage = fakeStorage();
  setLocal(storage, { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-3600), device: 'Chrome on Android', own: true, acked: false });
  const t = withEngine({ storage, places: { web: { track: '501', offset_ms: 100000, duration_ms: 600000, updated_at: iso(-7200) }, plex: null } });
  t.server.mode = 'offline';
  const opened = t.engine.open('500:1', { autoplay: false });
  await t.clock.advance(500); await opened;
  check('sent at once', t.server.fetches().length === 1 && t.server.fetches()[0].body.offset_ms === 300000);
  t.server.mode = 200;
  await t.clock.advance(40000);                  // the retries at 10 and 30 s
  check('retried and stored within the 2 minutes', t.server.row && t.server.row.offset_ms === 300000 && t.server.row.psid === t.saver.psid, t.server.row);
  t.engine.close();
}

current = 'T6S8: an error on an untouched open is not a reach: nothing sent';
{
  // Saver level: opened at the server's place, never played, then playback stops on an error.
  const t = makeSaver();
  t.saver.start('500:1', { held: { track: '502', offset_ms: 300000 } });
  const st = { book: '500:1', playing: false, position: { track: '502', offset_ms: 300000, duration_ms: 900000 } };
  t.saver.note({ reason: 'open', state: st });
  t.saver.note({ reason: 'error', state: st });
  await t.clock.advance(60000);
  t.saver.flush('beacon', 'leave');
  t.saver.stop();
  await t.clock.advance(1000);
  check('saver: nothing sent', t.server.calls.length === 0, t.server.calls.map((c) => c.body));
  // Engine level: autoplay off, and no connection to stream from.
  const places = { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-3600), device: 'Chrome on Android' }, plex: null };
  const u = withEngine({ places, noStream: true });
  const op = u.engine.open('500:1', { autoplay: false });
  await u.clock.advance(20000); await op;
  check('engine: the open failed', u.engine.state().error && u.engine.state().error.code === 'unreachable', u.engine.state().error);
  u.engine.close();
  await u.clock.advance(1000);
  check('engine: nothing sent, so the server\'s stamp is untouched', u.server.calls.length === 0, u.server.calls.map((c) => [c.body.event, c.body.offset_ms]));
  // The place a playing listener was frozen at is still saved on an error (the T5E1 hold).
  const w = makeSaver();
  const p = listener(w);
  w.saver.start(p.book); p.open(); p.play();
  await p.listen(4000);
  p.playing = false; p.emit('error');
  await w.clock.advance(1100);
  check('played within 2 minutes: the error saves its place as a pause', w.server.fetches().pop().body.event === 'pause');
  w.saver.stop();
}

// ---- 14. Fix round 3 ----

current = 'T6S9: after an error that could not be saved, the first save once playback restarts is not a pause';
{
  const evs = (t, n) => t.server.fetches().slice(n).map((c) => c.body.event);
  // Saver level, as the engine reports it: an error, then Retry ('retry' while
  // playing), then the element playing ('play' while already playing).
  for (const how of ['untouched open', 'paused 5 min']) {
    const t = makeSaver();
    const st = (playing, offset) => ({ book: '500:1', playing, position: { track: '502', offset_ms: offset, duration_ms: 900000 } });
    t.saver.start('500:1', { held: { track: '502', offset_ms: 300000 } });
    t.saver.note({ reason: 'open', state: st(false, 300000) });
    if (how === 'paused 5 min') {
      t.saver.note({ reason: 'play', state: st(true, 300000) });
      await t.clock.advance(4000);
      t.saver.note({ reason: 'pause', state: st(false, 304000) });
      await t.clock.advance(300000);
    }
    const n = t.server.fetches().length;
    t.saver.note({ reason: 'error', state: st(false, how === 'paused 5 min' ? 304000 : 300000) });
    await t.clock.advance(30000);
    check(how + ': the error sent nothing', t.server.fetches().length === n, evs(t, n));
    const base = how === 'paused 5 min' ? 304000 : 300000;
    t.saver.note({ reason: 'retry', state: st(true, base) });
    t.saver.note({ reason: 'play', state: st(true, base) });
    for (let k = 1; k <= 48; k++) { await t.clock.advance(250); t.saver.note({ reason: 'time', state: st(true, base + k * 250) }); }
    const after = evs(t, n);
    check(how + ': the first save after Play is play, never pause', after.length >= 2 && after[0] === 'play' && !after.includes('pause'), after);
    t.saver.stop();
  }
  // Engine level: autoplay off, the stream down; it comes back and the listener taps Play.
  const u = withEngine({ places: { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-3600), device: 'Chrome on Windows' }, plex: null } });
  u.net.failLoads = true;
  const op = u.engine.open('500:1', { autoplay: false });
  await u.clock.advance(20000); await op;
  check('engine, untouched open: the stream failed', u.engine.state().error && u.engine.state().error.code === 'unreachable', u.engine.state().error);
  check('engine, untouched open: nothing sent', u.server.calls.length === 0, u.server.calls.map((c) => c.body.event));
  u.net.failLoads = false;
  await u.engine.play();
  await u.clock.advance(12000);
  check('engine, untouched open: Play saves play, then checkins', evs(u, 0)[0] === 'play' && !evs(u, 0).includes('pause'), evs(u, 0));
  u.engine.close();
  // Engine level: played, paused 5 minutes, the element errors while paused, then Play.
  const v = withEngine({ places: { web: { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-3600) }, plex: null } });
  const op2 = v.engine.open('500:1');
  await v.clock.advance(5000); await op2;
  v.engine.pause();
  await v.clock.advance(300000);
  const n = v.server.fetches().length;
  v.net.failLoads = true;
  const el = v.audios[0];
  el.error = { code: 2 }; el.fire('error');
  await v.clock.advance(30000);
  check('engine, paused 5 min: the error ended unreachable', v.engine.state().error && v.engine.state().error.code === 'unreachable', v.engine.state().error);
  check('engine, paused 5 min: nothing sent for the stale place', v.server.fetches().length === n, evs(v, n));
  v.net.failLoads = false;
  await v.engine.play();
  await v.clock.advance(12000);
  check('engine, paused 5 min: Play saves play, never pause', evs(v, n)[0] === 'play' && !evs(v, n).includes('pause'), evs(v, n));
  v.engine.close();
  // The T5E1 hold, reached by playback, is still saved as a pause.
  const w = withEngine({ places: { web: null, plex: null } });
  const op3 = w.engine.open('500:1');
  await w.clock.advance(5000); await op3;
  const m = w.server.fetches().length;
  w.net.failLoads = true;
  const el2 = w.audios[0];
  el2.error = { code: 2 }; el2.fire('error');
  await w.clock.advance(30000);
  check('the hold reached by playback: saved as a pause', evs(w, m).includes('pause'), evs(w, m));
  w.engine.close();
}

current = 'the saver never lets a failing listener or storage break the engine';
{
  check('no console errors from the saver', consoleSeen.length === 0, consoleSeen);
}

// Task 8 (fix round 3): smart rewind is a playback aid. A seek the engine marks
// { rewind: true } never moves the saved place back: until playback passes the
// place it went back from, saves (and the local copy) carry that place. A move
// of the listener's own ends it.
current = 'a smart rewind never moves the saved place back';
{
  const t = makeSaver();
  const p = listener(t);
  p.state = () => ({ book: p.book, playing: p.playing, bookMs: Math.round(p.offset),
    position: { track: p.track, offset_ms: Math.round(p.offset), duration_ms: p.duration } });
  const rewind = (to) => { const from = p.offset; p.offset = to; p.emit('seek', { from, to, rewind: true }); };
  const posts = (from) => t.server.calls.slice(from).map((c) => [c.body.event, c.body.offset_ms, c.kind]);
  p.offset = 60000;
  t.saver.start('500:1', {});
  p.open();
  p.play();
  await p.listen(5000);
  p.pause();
  await t.clock.advance(3000);
  const reached = p.offset;                     // 65000
  let n = t.server.calls.length;
  p.play();
  rewind(reached - 3000);
  await t.clock.advance(1500);
  check('the rewind itself sends nothing behind', t.server.calls.slice(n).every((c) => c.body.offset_ms >= reached), posts(n));
  check('the local copy keeps the place reached', localOf(t).offset_ms === reached, localOf(t));
  await p.listen(1000);                          // still short of it
  n = t.server.calls.length;
  p.pause();
  await t.clock.advance(1500);
  const paused = t.server.calls.slice(n).filter((c) => c.body.event === 'pause');
  check('a pause in the window saves the place reached', paused.length === 1 && paused[0].body.offset_ms === reached, posts(n));
  p.play();
  await p.listen(4000);                          // past it
  n = t.server.calls.length;
  p.pause();
  await t.clock.advance(1500);
  const past = t.server.calls.slice(n).filter((c) => c.body.event === 'pause');
  check('past the floor it saves as ever', past.length === 1 && past[0].body.offset_ms > reached, posts(n));
  // An explicit move inside the window is the listener's: saved, even backwards.
  const here = p.offset;
  p.play();
  rewind(here - 10000);
  await t.clock.advance(1200);
  p.seek(here - 20000, 'skip');
  await t.clock.advance(1200);
  n = t.server.calls.length;
  p.pause();
  await t.clock.advance(1500);
  const moved = t.server.calls.slice(n).filter((c) => c.body.event === 'pause');
  check('a skip back inside the window saves the new place', moved.length === 1 && moved[0].body.offset_ms === here - 20000, posts(n));
  check('and the local copy follows it', localOf(t).offset_ms === here - 20000, localOf(t));
  // Leave and beacon hold the floor.
  const top = p.offset;
  p.play();
  rewind(top - 10000);
  await t.clock.advance(1200);
  n = t.server.calls.length;
  t.saver.flush('beacon');
  t.saver.flush('beacon', 'leave');
  const beacons = t.server.calls.slice(n).filter((c) => c.kind === 'beacon');
  check('the beacons carry the place reached', beacons.length === 2 && beacons.every((c) => c.body.offset_ms === top), posts(n));
  n = t.server.calls.length;
  t.saver.stop();
  await t.clock.advance(1500);
  check('the last save on stop too', t.server.calls.slice(n).every((c) => c.body.offset_ms === top) && t.server.calls.length > n, posts(n));
  // A new book starts with no floor.
  t.saver.start('500:1', {});
  p.play();
  p.seek(top - 30000);
  await t.clock.advance(1500);
  check('another run has no floor', t.server.row.offset_ms === top - 30000, t.server.row);
}

// Final review (parked T8L1-L3): the floor follows the place to save.
// placeMs is the position's book time (the engine passes it: the position
// holds where a failed part stopped while the playhead runs on into the next
// part); a move forward short of the floor keeps it; only a move back ends
// it; and no other change ends it, nor does it outlive its run.
function floorRig() {
  const t = makeSaver();
  // One book of three 600 s parts: book ms = part start + offset.
  const starts = { '501': 0, '502': 600000, '503': 1200000 };
  const at = { track: '501', offset: 0, head: null, playing: false };
  const bm = (track, off) => starts[track] + off;
  const state = () => ({ book: '500:1', playing: at.playing, bookMs: at.head === null ? bm(at.track, at.offset) : at.head,
    position: { track: at.track, offset_ms: Math.round(at.offset), duration_ms: 600000 } });
  const note = (reason, extra) => t.saver.note(Object.assign({ reason, state: state(), placeMs: bm(at.track, at.offset) }, extra || {}));
  const saved = (n) => t.server.calls.slice(n).map((c) => [c.body.event, c.body.track, c.body.offset_ms, c.kind]);
  // Puts the place at a book ms.
  const go = (ms) => {
    const track = ms >= 1200000 ? '503' : ms >= 600000 ? '502' : '501';
    Object.assign(at, { track, offset: ms - starts[track] });
  };
  return { t, at, bm, note, saved, go };
}
async function floorAt(r, track, offset) {
  // Listened up to (track, offset), paused an hour, then Play rewinds 30 s.
  const { t, at, note } = r;
  t.saver.start('500:1', {});
  Object.assign(at, { track, offset: offset - 5000, playing: false });
  note('open');
  at.playing = true;
  note('play');
  for (let k = 0; k < 20; k++) { await t.clock.advance(250); at.offset += 250; note('time'); }
  at.playing = false;
  note('pause');
  await t.clock.advance(3600000);
  at.playing = true;
  note('play');
  const from = r.bm(at.track, at.offset);
  r.go(from - 30000);                                   // may cross back into the part before
  note('seek', { rewind: true, from, to: from - 30000 });
  await t.clock.advance(1500);
  return { track, offset };
}

current = 'T8L1: the floor is released by the place to save, not the playhead';
{
  const r = floorRig();
  const { t, at, note, saved } = r;
  const floor = await floorAt(r, '502', 595000);       // the floor: 502 @ 595000, the part ends at 600000
  // Part 502 fails twice at 570 s and is skipped: the playhead moves on to
  // part 503 (past the floor), the position holds 502 @ 570000.
  at.offset = 570000;
  at.head = r.bm('503', 0);
  note('part-skipped');
  // Part 503 fails too, before it has played: the error holds 502 @ 570000.
  let n = t.server.calls.length;
  at.playing = false;
  note('error');
  await t.clock.advance(1500);
  check('the error\'s save is the floor, not the hold behind it', saved(n).length === 1 && saved(n)[0][1] === '502' && saved(n)[0][2] === floor.offset, saved(n));
  n = t.server.calls.length;
  t.saver.stop();
  await t.clock.advance(1500);
  check('and so is anything after it', saved(n).every((c) => c[2] === floor.offset), saved(n));
  const l = localOf(t);
  check('the local copy keeps the floor', l.track === '502' && l.offset_ms === floor.offset, l);
}

current = 'T8L2: a move forward that lands short of the floor keeps it; past it, or back, the move is saved';
{
  for (const [label, delta, want] of [['forward, short of the floor', 10000, 'floor'], ['forward, past the floor', 45000, 'target'],
    ['back', -10000, 'target']]) {
    const r = floorRig();
    const { t, at, bm, note, saved } = r;
    const floor = await floorAt(r, '501', 300000);     // floor 501 @ 300000; now at 270000, playing
    const from = bm(at.track, at.offset);
    at.offset += delta;
    note('skip', { from, to: from + delta });
    await t.clock.advance(1500);
    let n = t.server.calls.length;
    at.playing = false;
    note('pause');
    await t.clock.advance(1500);
    const expect = want === 'floor' ? floor.offset : at.offset;
    check(label + ': the pause saves ' + want, saved(n).length === 1 && saved(n)[0][2] === expect, [saved(n), expect]);
    check(label + ': the local copy too', localOf(t).offset_ms === expect, localOf(t));
  }
}

current = 'T8L3: error, part, play, retry and connection changes never end the floor';
{
  for (const reason of ['error', 'part', 'play', 'retry', 'connection']) {
    const r = floorRig();
    const { t, at, note, saved } = r;
    const floor = await floorAt(r, '502', 20000);      // floor 502 @ 20000
    check(reason + ': the rewind crossed back into part 1', at.track === '501' && at.offset === 590000, at);
    if (reason === 'part') Object.assign(at, { track: '502', offset: 0 });
    if (reason === 'error' || reason === 'retry') at.playing = false;
    note(reason);
    if (reason === 'retry') { at.playing = true; note('play'); }
    await t.clock.advance(1500);
    const n = t.server.calls.length;
    at.playing = false;
    note('pause');
    await t.clock.advance(1500);
    const all = saved(n);
    check(reason + ': still the floor', localOf(t).track === '502' && localOf(t).offset_ms === floor.offset &&
      (all.length === 0 || all.every((c) => c[1] === '502' && c[2] === floor.offset)), [all, localOf(t)]);
  }
}

current = 'T8L3: a floor never outlives its run';
{
  for (const next of ['the same book again', 'another book']) {
    const r = floorRig();
    const { t, at, note, saved } = r;
    const floor = await floorAt(r, '501', 300000);
    t.saver.stop();
    await t.clock.advance(1500);
    // A new run, playing on from a place behind the old floor (no move of the listener's).
    const book = next === 'another book' ? '700:1' : '500:1';
    t.saver.start(book, {});
    const st = (off, playing) => ({ book, playing, bookMs: off, position: { track: '501', offset_ms: off, duration_ms: 600000 } });
    t.saver.note({ reason: 'open', state: st(250000, false), placeMs: 250000 });
    t.saver.note({ reason: 'play', state: st(250000, true), placeMs: 250000 });
    let off = 250000;
    for (let k = 0; k < 8; k++) { await t.clock.advance(250); off += 250; t.saver.note({ reason: 'time', state: st(off, true), placeMs: off }); }
    await t.clock.advance(1000);
    const n = t.server.calls.length;
    t.saver.note({ reason: 'pause', state: st(off, false), placeMs: off });
    await t.clock.advance(1500);
    check(next + ': the new run saves where it plays', saved(n).length === 1 && saved(n)[0][2] === off && off < floor.offset, saved(n));
    t.saver.stop();
  }
}

// ---- Device ids: one per browser, on every save ----
current = 'this browser\'s id: made once, kept, and carried on every save';
{
  const storage = fakeStorage();
  const id = S.deviceIdFrom(storage);
  check('32 lower-case letters and digits', /^[a-z0-9]{32}$/.test(id) && S.isDeviceId(id), id);
  check('stored', storage.map.get('ws-player:device') === id);
  check('the same one next time (a reload is still this device)', S.deviceIdFrom(storage) === id);
  const other = S.deviceIdFrom(fakeStorage());
  check('another browser gets another', other !== id && S.isDeviceId(other));
  storage.map.set('ws-player:device', 'NOT-AN-ID');
  const fresh = S.deviceIdFrom(storage);
  check('a bad stored one is replaced', S.isDeviceId(fresh) && fresh !== 'NOT-AN-ID' && storage.map.get('ws-player:device') === fresh);
  const locked = fakeStorage({ throws: true });
  const a = S.deviceIdFrom(locked);
  check('storage that throws: an id all the same (this page session only)', S.isDeviceId(a) && S.deviceIdFrom(locked) !== a);
  check('no storage at all: an id', S.isDeviceId(S.deviceIdFrom(null)));
  check('isDeviceId', !S.isDeviceId('short') && !S.isDeviceId('A'.repeat(20)) && !S.isDeviceId('a'.repeat(41)) && !S.isDeviceId(null) && S.isDeviceId('a'.repeat(16)));
  // On the saves.
  const clock = fakeClock();
  const server = fakeServer(clock);
  const saver = S.createSaver({
    post: (body, kind) => server.post(body, kind), now: () => clock.now, mono: () => clock.now, storage: fakeStorage(),
    identity: IDENTITY, device: 'Chrome on Android', deviceId: id,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (x) => clock.clearTimeout(x)
  });
  check('the saver says who it is', saver.deviceId === id && saver.device === 'Chrome on Android');
  saver.start('500:1');
  const st = (playing, offset) => ({ book: '500:1', playing, position: { track: '501', offset_ms: offset, duration_ms: 600000 } });
  saver.note({ reason: 'open', state: st(false, 5000) });
  saver.note({ reason: 'play', state: st(true, 5000) });
  await clock.advance(11000);
  saver.note({ reason: 'time', state: st(true, 16000) });
  await clock.advance(500);
  saver.flush('beacon', 'leave');
  saver.stop();
  await clock.advance(1500);
  check('every save carries it, the beacon too', server.calls.length >= 3 && server.calls.every((c) => c.body.device_id === id), server.calls.map((c) => [c.kind, c.body.event, c.body.device_id]));
  const bare = S.createSaver({
    post: (body, kind) => server.post(body, kind), now: () => clock.now, mono: () => clock.now, storage: null,
    identity: '', device: 'x', deviceId: 'Not An Id',
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (x) => clock.clearTimeout(x)
  });
  check('a bad id is none', bare.deviceId === '');
  const n = server.calls.length;
  bare.start('500:1');
  bare.note({ reason: 'open', state: st(false, 1000) });
  bare.note({ reason: 'play', state: st(true, 1000) });
  await clock.advance(500);
  check('and no device_id field is sent', server.calls.length > n && server.calls.slice(n).every((c) => !('device_id' in c.body)));
  bare.stop();
  // browserSaver makes and keeps it.
  const win = new Window({ url: 'https://ws.test/news' });
  win.WS = { user: { identity_key: IDENTITY } };
  const bs = fakeStorage();
  const b1 = S.browserSaver(win, { fetch: async () => ({ status: 200, json: async () => ({}) }), storage: bs, now: () => clock.now, setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (x) => clock.clearTimeout(x) });
  check('the page\'s saver has the stored id', S.isDeviceId(b1.deviceId) && bs.map.get('ws-player:device') === b1.deviceId);
  const win2 = new Window({ url: 'https://ws.test/news' });
  win2.WS = { user: { identity_key: IDENTITY } };
  const b2 = S.browserSaver(win2, { fetch: async () => ({ status: 200, json: async () => ({}) }), storage: bs, now: () => clock.now, setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (x) => clock.clearTimeout(x) });
  check('a reload keeps it', b2.deviceId === b1.deviceId);
  await win.happyDOM.close();
  await win2.happyDOM.close();
}

current = 'the local copy is this device\'s own once the listener played or moved to it';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start('500:1', { held: { track: '501', offset_ms: 0 } });
  p.offset = 300000;
  p.open();
  check('an untouched opening place is not its own', localOf(t) && localOf(t).own === false && t.saver.readLocal('500:1').own === false, localOf(t));
  p.seek(310000);
  check('a move while paused is', localOf(t).own === true && t.saver.readLocal('500:1').own === true, localOf(t));
  t.saver.stop();
  const t2 = makeSaver();
  const p2 = listener(t2);
  t2.saver.start('500:1');
  p2.offset = 1000;
  p2.open();
  p2.play();
  await p2.listen(1000);
  check('played to is', localOf(t2).own === true && localOf(t2).offset_ms > 1000, localOf(t2));
  t2.saver.stop();
  const t3 = makeSaver();
  const p3 = listener(t3);
  t3.storage.map.set('ws-player:place:' + IDENTITY + ':500:1', JSON.stringify({ track: '501', offset_ms: 5, updated_at: new Date(T0).toISOString() }));
  check('a copy from before the flag is not its own', t3.saver.readLocal('500:1').own === false);
  t3.saver.start('500:1', { push: true });
  p3.offset = 5;
  p3.open();
  check('a local copy the book opens at (pushed) is still its own', localOf(t3).own === true, localOf(t3));
  t3.saver.stop();
}

// ---- A paused, saved run never sends its drift over a newer place ----
current = 'two devices: the drift after a saved pause is not sent over the other device\'s newer place';
{
  const clock = fakeClock();
  const server = fakeServer(clock);
  const A = makeSaver({ clock, server });
  const B = makeSaver({ clock, server });
  const a = listener(A);
  a.offset = 100000;
  A.saver.start('500:1');
  a.open();
  a.play();
  await a.listen(12000);
  a.pause();
  await clock.advance(1500);
  const saved = server.row;
  check('A\'s pause is saved', saved && saved.psid === A.saver.psid && saved.event === 'pause' && saved.offset_ms === a.offset, saved);
  // The element's last timeupdate lands a moment past the pause.
  a.offset += 250;
  a.emit('time');
  check('the local copy follows the drift', localOf(A).offset_ms === a.offset, localOf(A));
  await clock.advance(3000);
  // B, another device, saves a newer place.
  const b = listener(B);
  b.offset = 900000;
  B.saver.start('500:1');
  b.open();
  b.play();
  await b.listen(2000);
  b.pause();
  await clock.advance(1500);
  check('B\'s place is stored', server.row.psid === B.saver.psid && server.row.offset_ms === b.offset, server.row);
  const n = server.calls.length;
  // A closes, within 2 minutes: a hidden page, pagehide, the router's hard exit, then stop().
  A.saver.flush('beacon');
  A.saver.flush('beacon', 'leave');
  A.saver.flush('fetch');
  A.saver.stop();
  await clock.advance(20000);
  check('A sends nothing', server.calls.length === n, server.calls.slice(n).map((c) => [c.kind, c.body.event, c.body.offset_ms]));
  check('the server keeps B\'s place', server.row.psid === B.saver.psid && server.row.offset_ms === b.offset, server.row);
  B.saver.stop();
}

current = 'a paused run that is really unsaved still sends its last save';
{
  // A skip while paused whose save has not been taken (it hangs): stop() sends it.
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  p.play();
  await p.listen(3000);
  p.pause();
  await t.clock.advance(1500);
  t.server.mode = 'hang';
  p.seek(p.offset + 30000, 'skip');
  await t.clock.advance(100);
  t.server.mode = 200;
  const n = t.server.calls.length;
  t.saver.stop();
  await t.clock.advance(20000);
  const finals = t.server.calls.slice(n);
  check('the final goes, at the skipped-to place', finals.length === 1 && finals[0].body.event === 'leave' && finals[0].body.offset_ms === p.offset, finals.map((c) => [c.body.event, c.body.offset_ms]));
  check('stored', t.server.row.offset_ms === p.offset && t.server.row.event === 'leave');
}

for (const [drift, sent] of [[1000, false], [1001, true], [-1000, false], [-1001, true]]) {
  current = `a paused drift of ${drift} ms ${sent ? 'is' : 'is not'} a new place`;
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  p.play();
  await p.listen(3000);
  p.pause();
  await t.clock.advance(1500);
  const at = p.offset;
  p.offset = at + drift;
  p.emit('time');
  const n = t.server.calls.length;
  t.saver.flush('beacon', 'leave');
  t.saver.stop();
  await t.clock.advance(20000);
  const after = t.server.calls.slice(n);
  if (sent) {
    check('its beacon leave carries it', after.length >= 1 && after[0].kind === 'beacon' && after[0].body.event === 'leave' && after[0].body.offset_ms === at + drift, after.map((c) => [c.kind, c.body.event, c.body.offset_ms]));
    check('and the server has it', t.server.row.offset_ms === at + drift);
  } else {
    check('nothing is sent', after.length === 0, after.map((c) => [c.kind, c.body.event, c.body.offset_ms]));
    check('the server keeps the pause', t.server.row.offset_ms === at && t.server.row.event === 'pause');
  }
}

current = 'playing again after the drift saves as ever';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  p.play();
  await p.listen(3000);
  p.pause();
  await t.clock.advance(1500);
  p.offset += 250;
  p.emit('time');
  const n = t.server.calls.length;
  p.play();
  await p.listen(1500);
  check('the play is saved at once', t.server.calls.length > n && t.server.calls[n].body.event === 'play', t.server.calls.slice(n).map((c) => c.body.event));
  const before = t.server.calls.length;
  t.saver.stop();
  await t.clock.advance(2000);
  check('and a close while playing sends its leave', t.server.calls.length === before + 1 && t.server.calls[before].body.event === 'leave');
}

// ---- Spec 11b: base, and a 409 from the server ----
current = 'every save carries the base: the place read at open, then each save the server took';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1', { savedAt: '2026-09-29T10:00:00.000Z' });
  p.open();
  p.play();
  await p.listen(1000);
  const f = t.server.fetches();
  check('the first save: the place read at open', f[0].body.base === '2026-09-29T10:00:00.000Z', f[0].body);
  const taken = t.server.row.updated_at;
  await p.listen(10000);
  const f2 = t.server.fetches();
  check('the next: the timestamp of the save taken before it', f2.length === 2 && f2[1].body.base === taken, f2.map((c) => c.body.base));
  const last = t.server.row.updated_at;
  await p.listen(500);
  t.saver.flush('beacon');
  const b = t.server.beacons();
  check('a beacon too', b.length === 1 && b[0].body.base === last, b.map((c) => c.body.base));
  t.saver.stop();
  const t2 = makeSaver();
  const p2 = listener(t2);
  t2.saver.start('500:1');
  p2.open();
  p2.play();
  await p2.listen(500);
  check('none read at open: null', t2.server.fetches()[0].body.base === null);
  t2.saver.stop();
}

current = 'a 409: one conflict warning, nothing more sent until the listener answers, no failure warning';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1', { savedAt: '2026-09-29T10:00:00.000Z' });
  p.open();
  t.server.mode = 409;
  t.server.conflict = { track: '503', offset_ms: 100000, device: 'Chrome on Linux', updated_at: '2026-09-29T11:00:00.000Z' };
  p.play();
  await p.listen(1000);
  const conflicts = t.warnings.filter((w) => w.kind === 'conflict');
  check('one conflict warning, with the stored place', conflicts.length === 1 && conflicts[0].book === '500:1' && conflicts[0].conflict.track === '503' &&
    conflicts[0].conflict.updated_at === '2026-09-29T11:00:00.000Z' && typeof conflicts[0].now === 'string', conflicts);
  const n = t.server.calls.length;
  p.pause();
  await p.listen(1000);
  p.play();
  await p.listen(60000);
  t.saver.flush('beacon');
  t.saver.flush('beacon', 'leave');
  t.saver.flush('fetch');
  check('nothing more is sent while it is unanswered', t.server.calls.length === n, t.server.calls.slice(n).map((c) => [c.kind, c.body.event]));
  check('no "not saved" warning for it', !t.warnings.some((w) => w.kind === 'not-saved' && w.active));
  check('the local copy follows the place', localOf(t).offset_ms === p.offset, [localOf(t).offset_ms, p.offset]);
  t.server.mode = 200;
  const c = t.saver.resolveConflict();
  check('resolveConflict returns it', c && c.updated_at === '2026-09-29T11:00:00.000Z');
  check('a second resolve is nothing', t.saver.resolveConflict() === null);
  await p.listen(1500);
  const after = t.server.calls.slice(n);
  check('then saves go again, with the stored timestamp as the base', after.length >= 1 && after[0].body.base === '2026-09-29T11:00:00.000Z', after.map((c) => [c.body.event, c.body.base]));
  t.saver.stop();
}

current = 'a 409 after failed saves ends the "not saved" warning: the server answered';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  p.play();
  await p.listen(1000);
  t.server.mode = 'offline';
  await p.listen(45000);
  check('the warning is on while saves fail', t.saver.warning === true);
  t.server.mode = 409;
  t.server.conflict = { track: '503', offset_ms: 1, device: 'x', updated_at: '2026-09-29T11:00:00.000Z' };
  await p.listen(35000);
  const kinds = t.warnings.map((w) => w.kind + ':' + w.active);
  check('refused: the question instead, and the warning ends', t.warnings.some((w) => w.kind === 'conflict') && t.saver.warning === false && kinds[kinds.length - 1] === 'not-saved:false', kinds);
  t.saver.stop();
}

current = 'a 409 on a closing page: its last save is dropped, and a paused, answered-nothing close sends nothing';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  p.play();
  await p.listen(3000);
  t.server.mode = 409;
  t.server.conflict = { track: '503', offset_ms: 1, device: 'x', updated_at: '2026-09-29T11:00:00.000Z' };
  t.server.latency = 3000;
  p.pause();
  await t.clock.advance(100);
  const n = t.server.calls.length;
  t.saver.stop();                  // the pause is in flight; it will be refused
  await t.clock.advance(20000);
  check('the last save is not sent after the refusal', t.server.calls.length === n, t.server.calls.slice(n).map((c) => c.body.event));
}

current = 'the 2-minute rule holds across a conflict';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  t.server.mode = 409;
  t.server.conflict = { track: '503', offset_ms: 1, device: 'x', updated_at: '2026-09-29T11:00:00.000Z' };
  p.play();
  await p.listen(1000);
  p.pause();
  await t.clock.advance(3 * 60000);
  t.server.mode = 200;
  const n = t.server.calls.length;
  t.saver.resolveConflict();
  await t.clock.advance(5000);
  check('a place reached over 2 minutes ago is not sent by the answer alone', t.server.calls.length === n, t.server.calls.slice(n).map((c) => c.body.event));
  p.play();
  await p.listen(1000);
  check('playing sends it, with the new base', t.server.calls.length > n && t.server.calls[n].body.base === '2026-09-29T11:00:00.000Z');
  t.saver.stop();
}

current = 'stop() with a pause in flight: a fallback leave of its place goes only if that save fails';
for (const outcome of ['fails', 'succeeds']) {
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1', { savedAt: '2026-09-29T10:00:00.000Z' });
  p.open();
  p.play();
  await p.listen(750);            // the play is taken; under 1 s of listening
  t.server.mode = outcome === 'fails' ? 'offline' : 200;
  t.server.latency = 3000;
  p.pause();
  const paused = p.offset;
  await t.clock.advance(400);      // the pause is sent, 1 s after the play (in flight)
  p.offset += 200;                 // the element's drift
  p.emit('time');
  const n = t.server.calls.length;
  t.saver.stop();
  t.server.mode = 200;
  t.server.latency = 80;
  await t.clock.advance(20000);
  const after = t.server.calls.slice(n);
  if (outcome === 'fails') {
    check('fails: one leave of the paused place', after.length === 1 && after[0].body.event === 'leave' && after[0].body.offset_ms === paused && typeof after[0].body.base === 'string', after.map((c) => [c.body.event, c.body.offset_ms]));
    check('fails: stored', t.server.row.offset_ms === paused && t.server.row.event === 'leave');
  } else {
    check('succeeds: nothing more', after.length === 0, after.map((c) => [c.body.event, c.body.offset_ms]));
    check('succeeds: the pause is stored', t.server.row.offset_ms === paused && t.server.row.event === 'pause');
  }
}

current = 'a 409 that lands after stop() or after another book starts still caps its own book\'s local copy';
for (const then of ['nothing', 'stop()', 'start(another book)']) {
  let wall = Date.UTC(2026, 8, 29, 18, 6, 0);
  let mono = 0;
  const storage = fakeStorage();
  let answer = null;
  const saver = S.createSaver({
    post: (b, kind) => (kind === 'beacon' ? true : new Promise((res) => { answer = res; })),
    now: () => wall, mono: () => mono, storage, identity: IDENTITY,
    setTimeout: () => 1, clearTimeout: () => {}, psid: 'p', device: 'Chrome on Android', deviceId: 'a'.repeat(20)
  });
  const st = (playing, off) => ({ book: '500:1', playing, position: { track: '502', offset_ms: off, duration_ms: 900000 }, bookMs: 600000 + off });
  saver.start('500:1', { savedAt: '2026-09-29T18:00:03.220Z', held: { track: '502', offset_ms: 303000 } });
  saver.note({ reason: 'play', state: st(true, 303000) });
  wall += 250; mono += 250;
  saver.note({ reason: 'time', state: st(true, 303250) });
  if (then === 'stop()') saver.stop();
  if (then === 'start(another book)') saver.start('510:1', {});
  answer({ status: 409, data: { conflict: { track: '503', offset_ms: 101250, device: 'Chrome on Linux', updated_at: '2026-09-29T18:00:06.220Z' }, now: new Date(wall).toISOString() } });
  await new Promise((r) => setTimeout(r, 10));
  const v = JSON.parse(storage.map.get('ws-player:place:' + IDENTITY + ':500:1'));
  check(`${then}: capped at the conflict, not acknowledged`, v.updated_at === '2026-09-29T18:00:06.220Z' && v.acked === false, v);
}

current = 'the local copy says whether the server has that very place';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1', { held: { track: '501', offset_ms: 100000, duration_ms: 3600000 } });
  p.open();
  check('opened at the server\'s place: acknowledged', localOf(t).acked === true && t.saver.readLocal('500:1').acked === true, localOf(t));
  p.play();
  await p.listen(3000);
  check('played on over 1 s, not yet saved: not acknowledged', localOf(t).acked === false, localOf(t));
  p.pause();
  await t.clock.advance(1500);
  check('the pause stored: acknowledged', localOf(t).acked === true && localOf(t).offset_ms === p.offset, localOf(t));
  p.offset += 250;                 // the element's drift after the pause
  p.emit('time');
  check('the drift after it is still that place', localOf(t).acked === true && localOf(t).offset_ms === p.offset, localOf(t));
  t.server.mode = 'offline';
  p.seek(p.offset + 60000);
  await t.clock.advance(1500);
  check('a move whose save failed: not acknowledged', localOf(t).acked === false, localOf(t));
  t.saver.stop();
  const t2 = makeSaver();
  t2.storage.map.set('ws-player:place:' + IDENTITY + ':500:1', JSON.stringify({ track: '501', offset_ms: 5, updated_at: new Date(T0).toISOString() }));
  check('a copy written before the flag: not acknowledged', t2.saver.readLocal('500:1').acked === false);
}

current = 'the drift allowance counts only while paused with nothing to send or in flight (T9R6)';
{
  // The live case: a stored pause, then the element's timeupdate 19 ms on.
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1', { held: { track: '501', offset_ms: 100000, duration_ms: 3600000 } });
  p.open();
  p.play();
  await p.listen(3000);
  p.pause();
  await t.clock.advance(1500);
  check('the pause stored: acknowledged', localOf(t).acked === true, localOf(t));
  p.offset += 19;
  p.emit('time');
  check('a 19 ms drift after it: still acknowledged', localOf(t).acked === true && localOf(t).offset_ms === p.offset, localOf(t));
  p.offset += 981;                 // 1000 ms from the stored pause in all
  p.emit('time');
  check('exactly 1000 ms: still acknowledged', localOf(t).acked === true, localOf(t));
  p.offset += 1;
  p.emit('time');
  check('1001 ms: not acknowledged', localOf(t).acked === false, localOf(t));
  t.saver.stop();
}
{
  // A stale page: the ack is the phone's old pause; a Play whose answer
  // never comes, a place a moment past that ack.
  for (const [what, ms] of [['250 ms', 250], ['750 ms', 750], ['1000 ms', 1000]]) {
    const t = makeSaver();
    const p = listener(t);
    p.offset = 303000;
    t.saver.start('500:1', { held: { track: '501', offset_ms: 303000, duration_ms: 3600000 }, savedAt: new Date(T0).toISOString() });
    p.open();
    check(`${what}: opened at the server's place: acknowledged`, localOf(t).acked === true);
    t.server.mode = 'hang';
    p.play();
    await p.listen(ms);
    check(`${what} played, the Play unanswered: not acknowledged`, localOf(t).acked === false && localOf(t).offset_ms === 303000 + ms, localOf(t));
    p.pause();
    await t.clock.advance(50);
    p.offset += 20;
    p.emit('time');
    check(`${what}, then Pause and a 20 ms drift, the Play still in flight: not acknowledged`, localOf(t).acked === false, localOf(t));
    t.saver.stop();
  }
  // Playing, with nothing in flight: a place a moment past the ack is not it.
  const t = makeSaver();
  const p = listener(t);
  p.offset = 303000;
  t.saver.start('500:1', { held: { track: '501', offset_ms: 303000, duration_ms: 3600000 } });
  p.open();
  t.server.mode = 'offline';
  p.play();
  await t.clock.advance(200);      // the Play's save failed: nothing in flight
  p.offset += 250;
  p.emit('time');
  check('playing 250 ms past the ack: not acknowledged', localOf(t).acked === false, localOf(t));
  p.pause();
  await t.clock.advance(200);
  p.offset += 20;
  p.emit('time');
  check('paused with the pause unsent: not acknowledged', localOf(t).acked === false, localOf(t));
  t.saver.stop();
  // A move back to the very place carries its own save: not acknowledged
  // until that save is stored (T9R8).
  const t2 = makeSaver();
  const p2 = listener(t2);
  p2.offset = 100000;
  t2.saver.start('500:1', { held: { track: '501', offset_ms: 100000, duration_ms: 3600000 } });
  p2.open();
  t2.server.mode = 'hang';
  p2.play();
  p2.offset = 100250;
  p2.emit('time');
  p2.offset = 100000;
  p2.emit('seek', { from: 100250, to: 100000 });
  check('back at the very place by a move, its save in flight: not acknowledged', localOf(t2).acked === false && localOf(t2).offset_ms === 100000, localOf(t2));
  t2.saver.stop();
}

current = 'a paused move carries its own save: never acknowledged before that save is stored (T9R8)';
for (const [what, to] of [['a one-step nudge (+1 s)', 101000], ['a nudge back (-1 s)', 99000], ['a seek of +600 ms', 100600], ['a seek onto the saved place itself', 100000], ['a seek of +1001 ms', 101001]]) {
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1', { held: { track: '501', offset_ms: 100000, duration_ms: 3600000 } });
  p.open();
  p.play();
  await p.listen(3000);
  p.pause();
  await t.clock.advance(1500);
  const at = p.offset;
  const target = at + (to - 100000);
  check(`${what}: the pause stored, acknowledged`, localOf(t).acked === true && localOf(t).offset_ms === at, localOf(t));
  p.offset += 20;                  // the element's drift after the pause
  p.emit('time');
  check(`${what}: the drift is still that place`, localOf(t).acked === true, localOf(t));
  t.server.mode = 'offline';
  p.seek(target);
  check(`${what}: the move written, not acknowledged`, localOf(t).acked === false && localOf(t).offset_ms === target, localOf(t));
  await t.clock.advance(1500);
  check(`${what}: its save failed, still not acknowledged`, localOf(t).acked === false, localOf(t));
  t.server.mode = 200;
  await t.clock.advance(12000);
  check(`${what}: its save stored on the retry, acknowledged`, localOf(t).acked === true && t.server.row && t.server.row.offset_ms === target, [localOf(t), t.server.row && t.server.row.offset_ms]);
  t.saver.stop();
}

current = 'a last save refused with 409 caps the local copy too';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1', { savedAt: '2026-09-29T10:00:00.000Z' });
  p.open();
  t.server.mode = 'offline';
  p.play();
  await p.listen(3000);
  t.server.mode = 409;
  t.server.conflict = { track: '503', offset_ms: 1, device: 'x', updated_at: new Date(T0 - 60000).toISOString() };
  const n = t.server.calls.length;
  t.saver.stop();
  await t.clock.advance(2000);
  check('the last save went and was refused', t.server.calls.length === n + 1 && t.server.calls[n].body.event === 'leave', t.server.calls.slice(n).map((c) => c.body.event));
  check('the local copy: capped, not acknowledged', localOf(t).updated_at === new Date(T0 - 60000).toISOString() && localOf(t).acked === false, localOf(t));
}

current = 'the stop() fallback obeys the 2-minute rule: a pause sent before a long suspend is not resent';
{
  let wall = 0;
  const t = makeSaver({ now: () => T0 + wall });
  const clock = t.clock;
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  p.play();
  await p.listen(750);
  wall = clock.now;
  t.server.mode = 'offline';
  t.server.latency = 3000;
  p.pause();
  await t.clock.advance(400);      // the pause is in flight
  wall = clock.now + 3 * 3600000;  // the laptop slept 3 h (the wall clock moved, the page's did not)
  const n = t.server.calls.length;
  t.saver.stop();
  t.server.mode = 200;
  await t.clock.advance(20000);
  check('no fallback: the place is 3 h old', t.server.calls.length === n, t.server.calls.slice(n).map((c) => [c.body.event, c.body.offset_ms]));
}

current = 'the page going while a pause is in flight: its place goes as the beacon';
{
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  p.play();
  await p.listen(750);
  t.server.mode = 'hang';
  p.pause();
  const paused = p.offset;
  await t.clock.advance(400);
  p.offset += 200;
  p.emit('time');
  const sent = t.saver.flush('beacon', 'leave');
  const b = t.server.beacons();
  check('a beacon leave of the paused place', sent && b.length === 1 && b[0].body.event === 'leave' && b[0].body.offset_ms === paused, b.map((c) => [c.body.event, c.body.offset_ms]));
  t.saver.stop();
}

current = 'playing, a place under 1 s past the last save is still a new place';
{
  // The drift allowance is for a paused player only: while playing, the
  // place moving on is listening, and a flush sends it.
  const t = makeSaver();
  const p = listener(t);
  p.offset = 100000;
  t.saver.start('500:1');
  p.open();
  p.play();
  await p.listen(3000);
  p.pause();
  await t.clock.advance(1500);
  p.play();                        // saved at once, at the paused place
  await t.clock.advance(1500);
  const played = t.server.row;
  check('the play is taken', played.event === 'play' && played.offset_ms === p.offset, played);
  const n = t.server.calls.length;
  p.offset += 500;                 // half a second of listening since
  p.emit('time');
  check('a flush sends it', t.saver.flush('fetch') === true);
  await t.clock.advance(1500);
  check('sent', t.server.calls.length === n + 1 && t.server.calls[n].body.offset_ms === p.offset, t.server.calls.slice(n).map((c) => [c.body.event, c.body.offset_ms]));
  const m = t.server.calls.length;
  p.offset += 400;
  p.emit('time');
  t.saver.stop();                  // a close while playing, 0.4 s past the last save
  await t.clock.advance(1500);
  check('and a close while playing sends its leave', t.server.calls.length === m + 1 && t.server.calls[m].body.event === 'leave' && t.server.calls[m].body.offset_ms === p.offset, t.server.calls.slice(m).map((c) => [c.body.event, c.body.offset_ms]));
}

current = 'keepLocal: the local copy is left as it was until the listener acts';
{
  const t = makeSaver();
  t.storage.map.set('ws-player:place:' + IDENTITY + ':500:1', JSON.stringify({ track: '501', offset_ms: 5000, duration_ms: 3600000, updated_at: new Date(T0).toISOString(), device: 'Chrome on Android', own: true }));
  const p = listener(t);
  p.offset = 900000;
  t.saver.start('500:1', { keepLocal: true });
  p.open();
  p.emit('ready');
  check('opening elsewhere leaves it', localOf(t).offset_ms === 5000 && localOf(t).own === true, localOf(t));
  p.seek(910000);
  check('a move of the listener\'s writes it', localOf(t).offset_ms === 910000, localOf(t));
  t.saver.stop();
}

// ---- Spec 2.5: the place in terms that survive a file change, and the held "files changed" ----
const CHAPTERED = Object.assign(JSON.parse(JSON.stringify(BOOK)), { chapters: [
  { index: 1, label: 'Opening', start_ms: 0, end_ms: 300000, track: '501', track_start_ms: 0, track_end_ms: 300000 },
  { index: 2, label: 'The Middle', start_ms: 300000, end_ms: 1200000, track: '501', track_start_ms: 300000, track_end_ms: 600000 },
  { index: 3, label: 'The End', start_ms: 1200000, end_ms: 1800000, track: '502', track_start_ms: 600000, track_end_ms: 900000 }
] });
const STARTS = { 501: 0, 502: 600000, 503: 1500000 };
const labelAt = (ms) => (ms >= 1200000 ? 'The End' : ms >= 300000 ? 'The Middle' : 'Opening');
const bodyOk = (b) => b.book_ms === STARTS[b.track] + b.offset_ms && b.chapter_label === labelAt(b.book_ms);
const beaconBodies = (t) => t.server.beacons().map((c) => c.body);
const LOCAL_KEY = 'ws-player:place:' + IDENTITY + ':500:1';
// The web copy of a place in a part this book no longer has, and one from an earlier copy of the book.
const GONE_WEB = { track: '599', offset_ms: 120000, duration_ms: 900000, updated_at: iso(-3600), device: 'Chrome on Windows', source: 'web',
  book_ms: 720000, book_duration_ms: 1800000, chapter_label: 'Chapter 4', narrator: 'N. Reader', book_title: 'Three Parts', psid: 'other' };
const LINKED_WEB = Object.assign({}, GONE_WEB, { track: '401', linked_from: '400:1', book_title: 'Three Parts (First Edition)' });
async function openBook(t, key = '500:1') {
  const p = t.engine.open(key);
  await t.clock.advance(1000);
  await p;
}

current = 'spec 2.5: every save, beacon and last save carries book_ms and chapter_label';
{
  const t = withEngine({ book: CHAPTERED, places: { web: { track: '502', offset_ms: 200000, duration_ms: 900000, updated_at: iso(-5) }, plex: null } });
  await openBook(t);
  await t.clock.advance(24000);
  const f = t.server.fetches();
  check('the play and the checkins', f.length >= 3 && f[0].body.event === 'play', f.map((c) => c.body.event));
  check('the play: the place\'s book time and chapter', f[0].body.book_ms === 600000 + f[0].body.offset_ms && f[0].body.offset_ms >= 200000 &&
    f[0].body.chapter_label === 'The Middle', f[0].body);
  check('every fetch: book_ms and chapter_label of its own place', f.every((c) => bodyOk(c.body)), f.map((c) => [c.body.track, c.body.offset_ms, c.body.book_ms, c.body.chapter_label]));
  t.engine.seek(1250000);                              // 502 at 650 s: The End
  await t.clock.advance(1100);
  const sk = t.server.fetches().pop().body;
  check('a move carries the new place\'s', sk.event === 'seek' && sk.book_ms === 1250000 && sk.chapter_label === 'The End', sk);
  await t.clock.advance(2000);
  t.saver.flush('beacon', 'leave');
  const bb = beaconBodies(t);
  check('a beacon carries them', bb.length === 1 && bodyOk(bb[0]) && bb[0].book_ms > 1250000, bb);
  await t.clock.advance(1000);
  t.engine.close();
  await t.clock.advance(1000);
  const fin = t.server.fetches().pop().body;
  check('the last save (close) carries them', fin.event === 'leave' && bodyOk(fin) && fin.book_ms > 1250000, fin);
  const l = localOf(t);
  check('the local copy keeps book time, length and chapter', l && l.book_ms === STARTS[l.track] + l.offset_ms && l.book_duration_ms === 1800000 &&
    l.chapter_label === labelAt(l.book_ms), l);
  check('readLocal gives them back', t.saver.readLocal('500:1').book_ms === l.book_ms && t.saver.readLocal('500:1').chapter_label === l.chapter_label &&
    t.saver.readLocal('500:1').book_duration_ms === 1800000);
  check('never a linked_from unasked', t.server.calls.every((c) => !('linked_from' in c.body)));
}

current = 'spec 2.5: the chapter label is at most 200 characters, well formed; book_ms only when known';
{
  const t = makeSaver();
  t.saver.start('500:1');
  const st = (off) => ({ book: '500:1', playing: false, position: { track: '501', offset_ms: off, duration_ms: 3600000 }, bookDurationMs: 3600000 });
  t.saver.note({ reason: 'open', state: st(0), placeMs: 0, placeLabel: 'Opening' });
  t.saver.note({ reason: 'seek', state: st(5000), from: 0, to: 5000, placeMs: 5000, placeLabel: '😀'.repeat(250) });
  await t.clock.advance(1500);
  const b1 = t.server.calls[0].body;
  check('cut at 200 characters, never inside one', /^(😀){200}$/.test(b1.chapter_label), b1.chapter_label && b1.chapter_label.length);
  t.saver.note({ reason: 'seek', state: st(6000), from: 5000, to: 6000, placeMs: 6000, placeLabel: 'Ch\uD800apter' });
  await t.clock.advance(1500);
  check('a lone surrogate is replaced', t.server.calls[1].body.chapter_label === 'Ch�apter', t.server.calls[1].body.chapter_label);
  t.saver.note({ reason: 'seek', state: st(7000), from: 6000, to: 7000, placeMs: 7000, placeLabel: '' });
  await t.clock.advance(1500);
  const b3 = t.server.calls[2].body;
  check('no label: no chapter_label', !('chapter_label' in b3) && b3.book_ms === 7000, b3);
  t.saver.note({ reason: 'seek', state: st(8000), from: 7000, to: 8000, placeMs: 1e9 + 1, placeLabel: 'Late' });
  await t.clock.advance(1500);
  const b4 = t.server.calls[3].body;
  check('a book time past the server\'s bound is left out', !('book_ms' in b4) && b4.chapter_label === 'Late', b4);
  t.saver.stop();
}

current = 'spec 2.5: a web copy from an earlier copy of the book (linked_from) enters "files changed"';
{
  const t = withEngine({ places: { web: LINKED_WEB, plex: null } });
  await openBook(t);
  const old = t.engine.state().filesChanged && t.engine.state().filesChanged.old;
  check('files changed from it, with its link and names', old && old.source === 'web' && old.track === '401' && old.linked_from === '400:1' &&
    old.book_ms === 720000 && old.book_duration_ms === 1800000 && old.chapter_label === 'Chapter 4' &&
    old.book_title === 'Three Parts (First Edition)' && old.narrator === 'N. Reader', old);
  check('one files-changed warning', t.log.warning.filter((w) => w.kind === 'files-changed').length === 1, t.log.warning);
  await t.clock.advance(60000);
  check('nothing sent, no local copy written', t.server.calls.length === 0 && !t.storage.map.has(LOCAL_KEY), t.server.calls.map((c) => c.body));
  t.engine.close();
  await t.clock.advance(20000);
  check('nothing on close', t.server.calls.length === 0);
}

current = 'spec 2.5: previewAt plays about 15 s with nothing saved';
{
  const storage = fakeStorage();
  setLocal(storage, { track: '599', offset_ms: 120000, duration_ms: 900000, updated_at: iso(-10), own: true, acked: false });
  const kept = storage.map.get(LOCAL_KEY);
  const t = withEngine({ storage, book: CHAPTERED, places: { web: GONE_WEB, plex: null } });
  await openBook(t);
  check('held', t.engine.state().filesChanged !== null && t.engine.state().filesChanged.old.source === 'local');
  check('previewAt', t.engine.previewAt(700000) === true);
  await t.clock.advance(5000);
  check('playing the preview', t.engine.state().playing === true);
  await t.clock.advance(15000);
  const s = t.engine.state();
  check('paused after about 15 s', !s.playing && s.bookMs >= 715000 && s.bookMs <= 715500, s.bookMs);
  check('0 check-ins, 0 beacons', t.server.calls.length === 0, t.server.calls.map((c) => c.body));
  check('the local copy is as it was', storage.map.get(LOCAL_KEY) === kept);
  check('still held', s.filesChanged !== null);
  t.engine.close();
}

current = 'spec 2.5: confirmPlace saves exactly once, as an explicit move, and saving goes on as ever';
{
  const storage = fakeStorage();
  const t = withEngine({ storage, book: CHAPTERED, places: { web: GONE_WEB, plex: null } });
  await openBook(t);
  t.engine.previewAt(700000);
  await t.clock.advance(8000);                         // mid-preview
  check('confirmPlace', t.engine.confirmPlace(650000) === true);
  await t.clock.advance(5000);
  const f = t.server.fetches();
  check('exactly one save', t.server.calls.length === 1, t.server.calls.map((c) => [c.kind, c.body.event, c.body.offset_ms]));
  const b = f[0] && f[0].body;
  check('at the spot, as a paused move', b && b.event === 'pause' && b.track === '502' && b.offset_ms === 50000 && b.book_ms === 650000 &&
    b.chapter_label === 'The Middle', b);
  check('with the base the open read (compare-and-swap applies)', b && b.base === GONE_WEB.updated_at, b && b.base);
  check('no linked_from (the place was not from an earlier copy)', b && !('linked_from' in b));
  check('held no more', t.engine.state().filesChanged === null && !t.engine.state().playing);
  const l = localOf(t);
  check('the local copy is the confirmed place, this browser\'s own', l && l.track === '502' && l.offset_ms === 50000 && l.own === true, l);
  await t.engine.play();
  await t.clock.advance(12000);
  const g = t.server.fetches().slice(1);
  check('Play then saves as ever', g.length >= 2 && g[0].body.event === 'play' && g[0].body.offset_ms === 50000 && g[1].body.event === 'checkin', g.map((c) => c.body.event));
  t.engine.close();
}

current = 'spec 2.5: after a confirm from an earlier copy, linked_from rides on the saves until the server says true or false';
{
  const t = withEngine({ book: CHAPTERED, places: { web: LINKED_WEB, plex: null } });
  await openBook(t);
  t.server.extra = { linked: null };                   // Plex can't say yet
  t.engine.confirmPlace(650000);
  await t.clock.advance(2000);
  check('the confirm carries it', t.server.calls.length === 1 && t.server.calls[0].body.linked_from === '400:1', t.server.calls.map((c) => c.body));
  await t.engine.play();
  await t.clock.advance(11000);
  const f = t.server.fetches();
  check('null: sent again', f.length >= 3 && f.every((c) => c.body.linked_from === '400:1'), f.map((c) => [c.body.event, c.body.linked_from]));
  t.saver.flush('beacon');
  check('a beacon meanwhile carries it too', beaconBodies(t).pop().linked_from === '400:1');
  t.server.extra = { linked: true };
  await t.clock.advance(10500);
  const n = t.server.fetches().length;
  await t.clock.advance(21000);
  const later = t.server.fetches().slice(n);
  check('true: no more', later.length >= 2 && later.every((c) => !('linked_from' in c.body)), later.map((c) => c.body.linked_from));
  t.engine.close();
  // false stops it too.
  const u = withEngine({ book: CHAPTERED, places: { web: LINKED_WEB, plex: null } });
  await openBook(u);
  u.server.extra = { linked: false };
  u.engine.confirmPlace(650000);
  await u.clock.advance(2000);
  await u.engine.play();
  await u.clock.advance(12000);
  const uf = u.server.fetches();
  check('false: only the confirm carried it', uf[0].body.linked_from === '400:1' && uf.slice(1).length >= 1 && uf.slice(1).every((c) => !('linked_from' in c.body)),
    uf.map((c) => c.body.linked_from));
  u.engine.close();
}

current = 'spec 2.5 ruling (c): startOver saves the start and never sends linked_from';
{
  const t = withEngine({ book: CHAPTERED, places: { web: LINKED_WEB, plex: null } });
  await openBook(t);
  t.server.extra = { linked: null };
  check('startOver', t.engine.startOver() === true);
  await t.clock.advance(2000);
  const b = t.server.calls.length === 1 && t.server.calls[0].body;
  check('one save at 0', b && b.track === '501' && b.offset_ms === 0 && b.book_ms === 0 && b.chapter_label === 'Opening', t.server.calls.map((c) => c.body));
  check('no linked_from', b && !('linked_from' in b));
  await t.engine.play();
  await t.clock.advance(12000);
  check('nor later', t.server.calls.every((c) => !('linked_from' in c.body)));
  t.engine.close();
  // Dismissing (closing) sends nothing, the link included.
  const u = withEngine({ book: CHAPTERED, places: { web: LINKED_WEB, plex: null } });
  await openBook(u);
  u.engine.previewAt(100000);
  await u.clock.advance(20000);
  u.engine.close();
  await u.clock.advance(20000);
  check('a dismissed helper: nothing sent', u.server.calls.length === 0, u.server.calls.map((c) => c.body));
}

current = 'spec 2.5: a confirm is compare-and-swap like any save (409: the conflict question)';
{
  const t = withEngine({ book: CHAPTERED, places: { web: GONE_WEB, plex: null } });
  await openBook(t);
  t.server.mode = 409;
  t.server.conflict = { track: '503', offset_ms: 1000, device: 'Chrome on Windows', updated_at: iso(0) };
  t.engine.confirmPlace(650000);
  await t.clock.advance(3000);
  const c = t.log.warning.filter((w) => w.kind === 'conflict');
  check('one conflict question', c.length === 1 && c[0].conflict.track === '503', t.log.warning);
  check('one attempt, nothing more', t.server.calls.length === 1);
  t.engine.close();
}

current = 'spec 2.5: releasing the hold ends a floor and drops whatever the preview left to send';
{
  const t = makeSaver();
  const em = (reason, playing, off, extra) => t.saver.note(Object.assign({ reason, placeMs: off,
    state: { book: '500:1', playing, position: { track: '501', offset_ms: off, duration_ms: 3600000 } } }, extra || {}));
  t.saver.start('500:1', { files: true });
  em('open', false, 0);
  em('preview', false, 100000);
  em('play', true, 100000);
  for (let off = 100250; off <= 115000; off += 250) { await t.clock.advance(250); em('time', true, off); }
  // A rewind reaching the saver while held (the engine ignores smart rewind
  // then): its floor must not outlive the hold.
  em('seek', true, 85000, { rewind: true, from: 115000, to: 85000 });
  em('pause', false, 85000);
  check('nothing sent while held', t.server.calls.length === 0 && localOf(t) === null);
  check('releaseFiles', typeof t.saver.releaseFiles === 'function' && t.saver.releaseFiles('500:1', null) === true);
  check('a flush right after sends nothing (the preview\'s pause is not a save)', t.saver.flush('fetch') === false);
  await t.clock.advance(5000);
  check('the release alone sends nothing', t.server.calls.length === 0, t.server.calls.map((c) => c.body));
  em('seek', false, 100000, { from: 85000, to: 100000 });   // forward, short of the would-be floor (115 s)
  await t.clock.advance(1500);
  check('one save, at the spot itself (no floor)', t.server.calls.length === 1 && t.server.calls[0].body.offset_ms === 100000 &&
    t.server.calls[0].body.event === 'pause', t.server.calls.map((c) => [c.body.event, c.body.offset_ms]));
  check('releasing twice does nothing', t.saver.releaseFiles('500:1', null) === false);
  t.saver.stop();
  // A release for another book, or with no hold, does nothing.
  const u = makeSaver();
  u.saver.start('500:1');
  check('no hold: false', u.saver.releaseFiles('500:1', '400:1') === false);
  u.saver.stop();
  const v = makeSaver();
  v.saver.start('500:1', { files: true });
  check('another book: false', v.saver.releaseFiles('700:1', null) === false);
  check('a malformed link is not kept', v.saver.releaseFiles('500:1', '../x') === true);
  const q = listener(v);
  q.open();
  q.seek(5000);
  await v.clock.advance(1500);
  check('so none is sent', v.server.calls.length === 1 && !('linked_from' in v.server.calls[0].body), v.server.calls.map((c) => c.body));
  v.saver.stop();
}

current = 'spec 2.5: while held, a 409 answer, a late re-read or a flush never lets a save out';
{
  const t = makeSaver();
  const p = listener(t);
  t.saver.start('500:1', { files: true, savedAt: iso(-60) });
  p.open();
  p.play();
  await p.listen(5000);
  check('resolveConflict leaves the hold', t.saver.resolveConflict() === null);
  // Fix round 3 (T2R4): the hold alone is no question, so a confirm's
  // re-read looks past it (lastSeen), and a newer place found then is asked
  // about inside the hold (otherSaved): still held, nothing sent.
  const seen = t.saver.lastSeen('500:1');
  check('lastSeen: held, no question yet', seen.files === true && seen.conflict === false, seen);
  check('otherSaved asks inside the hold', t.saver.otherSaved('500:1', { track: '501', offset_ms: 1, updated_at: iso(0) }, iso(0), false) === true);
  check('one conflict warning', t.warnings.length === 1 && t.warnings[0].kind === 'conflict' && t.warnings[0].conflict.offset_ms === 1, t.warnings);
  const seen2 = t.saver.lastSeen('500:1');
  check('lastSeen: held, with the question', seen2.files === true && seen2.conflict === true, seen2);
  check('adoptBase refused while it is asked', t.saver.adoptBase('500:1', iso(1)) === false);
  check('flush fetch: nothing', t.saver.flush('fetch') === false);
  check('flush beacon: nothing', t.saver.flush('beacon') === false && t.saver.flush('beacon', 'leave') === false);
  const answered = t.saver.resolveConflict();
  check('the answer clears the question, not the hold', answered && answered.updated_at === iso(0) && t.saver.lastSeen('500:1').files === true &&
    t.saver.lastSeen('500:1').conflict === false && t.saver.lastSeen('500:1').base === iso(0), [answered, t.saver.lastSeen('500:1')]);
  await p.listen(30000);
  p.pause();
  await t.clock.advance(30000);
  t.saver.stop();
  await t.clock.advance(20000);
  check('nothing at all', t.server.calls.length === 0 && localOf(t) === null, [t.server.calls.length]);
}

// Review Focus 3: a tab closed, killed or reloaded while the helper is open
// sends nothing (no beacon, no last save); the old place stays, and the next
// open is "files changed" again.
current = 'spec 2.5 Review Focus 3: close, pagehide, a killed page and a reload while held send nothing';
{
  const storage = fakeStorage();
  setLocal(storage, { track: '599', offset_ms: 120000, duration_ms: 900000, updated_at: iso(-10), own: true, acked: false, book_ms: 720000 });
  const kept = storage.map.get(LOCAL_KEY);
  const clock = fakeClock();
  const server = fakeServer(clock);
  server.row = { track: '503', offset_ms: 12000, updated_at: iso(-600), psid: 'other', seq: 9 };
  const rowBefore = JSON.stringify(server.row);
  const web = { track: '503', offset_ms: 12000, duration_ms: 300000, updated_at: iso(-600), device: 'Chrome on Windows' };
  const t = withEngine({ clock, server, storage, book: CHAPTERED, places: { web, plex: null } });
  await openBook(t);
  check('held from the local copy', t.engine.state().filesChanged && t.engine.state().filesChanged.old.track === '599');
  t.engine.previewAt(300000);
  await clock.advance(5000);
  // What pagehide, ws:before-hard-nav, a hidden page and "online" call.
  check('pagehide / hard nav: no beacon', t.saver.flush('beacon', 'leave') === false);
  check('hidden: no beacon', t.saver.flush('beacon') === false);
  check('online: no fetch', t.saver.flush('fetch') === false);
  // A killed page: its timers never fire; nothing was waiting on them either.
  await clock.advance(600000);
  check('10 minutes held: nothing sent', server.calls.length === 0, server.calls.map((c) => c.body));
  t.engine.close();
  await clock.advance(30000);
  check('close: nothing sent', server.calls.length === 0, server.calls.map((c) => c.body));
  check('the old place stays on the server', JSON.stringify(server.row) === rowBefore);
  check('and in the local copy', storage.map.get(LOCAL_KEY) === kept);
  // The reload: the next open is "files changed" again, from the same place.
  const u = withEngine({ clock, server, storage, book: CHAPTERED, places: { web, plex: null } });
  await openBook(u);
  const old = u.engine.state().filesChanged && u.engine.state().filesChanged.old;
  check('the next open: files changed again', old && old.track === '599' && old.offset_ms === 120000 && old.book_ms === 720000 && old.source === 'local', old);
  u.engine.close();
  await clock.advance(20000);
  check('still nothing sent', server.calls.length === 0);
}

current = 'spec 2.5 Review Focus 3: the page\'s own exits (browser saver) send nothing while held';
{
  const win = new Window({ url: 'https://ws.test/news' });
  win.WS = { user: { identity_key: IDENTITY } };
  const clock = fakeClock();
  const beacons = [];
  const fetches = [];
  const storage = fakeStorage();
  const saver = S.browserSaver(win, {
    sendBeacon: (url, blob) => { beacons.push(blob); return true; },
    fetch: async (url, init) => { fetches.push(init); return { status: 200, json: async () => ({ stored: true, updated_at: new Date(clock.now).toISOString() }) }; },
    now: () => clock.now, storage,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms, 'page'), clearTimeout: (id) => clock.clearTimeout(id)
  });
  saver.start('500:1', { files: true });
  const st = (playing, offset) => ({ book: '500:1', playing, position: { track: '501', offset_ms: offset, duration_ms: 600000 } });
  saver.note({ reason: 'open', state: st(false, 0), placeMs: 0 });
  saver.note({ reason: 'preview', state: st(false, 90000), placeMs: 90000 });
  saver.note({ reason: 'play', state: st(true, 90000), placeMs: 90000 });
  saver.note({ reason: 'time', state: st(true, 90250), placeMs: 90250 });
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  win.dispatchEvent(new win.CustomEvent('ws:before-hard-nav', { detail: { url: '/login', waitUntil() {} } }));
  win.dispatchEvent(new win.Event('pagehide'));
  win.dispatchEvent(new win.Event('online'));
  await clock.advance(30000);
  saver.stop();
  await clock.advance(20000);
  check('no beacon, no fetch, no local copy', beacons.length === 0 && fetches.length === 0 &&
    ![...storage.map.keys()].some((k) => k.indexOf('ws-player:place:') === 0), [beacons.length, fetches.length]);
  await win.happyDOM.close();
}

current = 'spec 2.5: lock-screen Play while held sends nothing';
{
  const ms = { metadata: null, playbackState: 'none', handlers: new Map(), setActionHandler(a, fn) { this.handlers.set(a, fn); }, setPositionState() {} };
  const t = withEngine({ mediaSession: ms, book: CHAPTERED, places: { web: GONE_WEB, plex: null } });
  await openBook(t);
  ms.handlers.get('play')();
  await t.clock.advance(20000);
  check('no preview: Play plays a bounded preview from the chosen spot (0)', !t.engine.state().playing &&
    t.engine.state().bookMs >= 15000 && t.engine.state().bookMs <= 15500, t.engine.state().bookMs);
  t.engine.previewAt(700000);
  await t.clock.advance(3000);
  ms.handlers.get('pause')();
  await t.clock.advance(2000);
  ms.handlers.get('play')();
  await t.clock.advance(1000);
  check('it resumes the preview', t.engine.state().playing);
  await t.clock.advance(20000);
  ms.handlers.get('play')();
  await t.clock.advance(500);
  ms.handlers.get('seekforward')({});
  const moved = t.engine.state().bookMs;
  await t.clock.advance(20000);
  check('a lock-screen move ends the preview: paused where it landed', !t.engine.state().playing && t.engine.state().bookMs === moved, [moved, t.engine.state().bookMs]);
  ms.handlers.get('play')();
  await t.clock.advance(60000);
  check('Play then: 15 s from there, no more', !t.engine.state().playing && t.engine.state().bookMs >= moved + 15000 &&
    t.engine.state().bookMs <= moved + 15500, [moved, t.engine.state().bookMs]);
  check('nothing sent, no local copy', t.server.calls.length === 0 && !t.storage.map.has(LOCAL_KEY), t.server.calls.map((c) => c.body));
  check('still held', t.engine.state().filesChanged !== null);
  t.engine.close();
  await t.clock.advance(20000);
  check('nothing on close', t.server.calls.length === 0);
}

// ---- Fix round 1 ----
// T2S2: releasing the hold forgets the held place, so a confirm where the
// playhead already is (a startOver at the held 0:00, a nudge then confirm)
// is a move: the local copy takes it even when its save fails.
current = 'T2S2: a confirm at the spot the playhead already holds writes the local copy';
for (const how of ['startOver at the held 0:00', 'a nudge, then confirm there']) {
  const storage = fakeStorage();
  setLocal(storage, { track: '599', offset_ms: 120000, duration_ms: 900000, updated_at: iso(-10), own: true, acked: false,
    book_ms: 720000, book_duration_ms: 1800000, chapter_label: 'Chapter 4' });
  const clock = fakeClock();
  const server = fakeServer(clock);
  const web = { track: '503', offset_ms: 12000, duration_ms: 300000, updated_at: iso(-600), device: 'Chrome on Windows', psid: 'other' };
  const t = withEngine({ clock, server, storage, book: CHAPTERED, places: { web, plex: null } });
  await openBook(t);
  server.mode = 503;                                   // the confirm's save fails
  const to = how === 'startOver at the held 0:00' ? 0 : 650000;
  if (to === 0) t.engine.startOver();
  else { t.engine.seek(650000); await clock.advance(500); t.engine.confirmPlace(650000); }
  await clock.advance(2000);
  const l = localOf(t);
  check(how + ': the local copy is the confirmed place, own and unacked', l && l.book_ms === to && l.own === true && l.acked === false, l);
  t.engine.close();
  await clock.advance(20000);
  server.mode = 200;
  const u = withEngine({ clock, server, storage, book: CHAPTERED, places: { web, plex: null } });
  await openBook(u);
  check(how + ': the reopen resumes there, not held again', u.engine.state().filesChanged === null && u.engine.state().bookMs >= to &&
    u.engine.state().bookMs < to + 2000, [u.engine.state().filesChanged, u.engine.state().bookMs]);
  u.engine.close();
  await clock.advance(20000);
}

// T2L1: a confirmed link Plex couldn't check before the book closed is
// kept with the local copy and sent again by the next open until the
// server says true or false.
current = 'T2L1: an unsettled link survives a close and is sent again until the server settles it';
{
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  const t = withEngine({ clock, server, storage, book: CHAPTERED, places: { web: LINKED_WEB, plex: null } });
  await openBook(t);
  server.extra = { linked: null };
  t.engine.confirmPlace(650000);
  await clock.advance(2000);
  await t.engine.play();
  await clock.advance(25000);
  check('every save of the run carried it', server.calls.length >= 3 && server.calls.every((c) => c.body.linked_from === '400:1'));
  t.engine.close();
  await clock.advance(20000);
  check('the local copy keeps it', localOf(t) && localOf(t).linked_from === '400:1', localOf(t));
  check('readLocal gives it', t.saver.readLocal('500:1').linked_from === '400:1');
  const row = server.row;
  const web2 = { track: row.track, offset_ms: row.offset_ms, duration_ms: row.duration_ms, updated_at: row.updated_at, device: row.device, psid: row.psid };
  server.extra = { linked: null };
  const n = server.calls.length;
  const u = withEngine({ clock, server, storage, book: CHAPTERED, places: { web: web2, plex: null } });
  await openBook(u);
  await clock.advance(12000);
  const second = server.calls.slice(n);
  check('the next open sends it again', second.length >= 1 && second.every((c) => c.body.linked_from === '400:1'), second.map((c) => c.body.linked_from));
  server.extra = { linked: true };
  u.engine.pause();                                    // settled by the pause's answer; nothing is written after it
  await clock.advance(2000);
  check('the pause carried it', server.calls[server.calls.length - 1].body.event === 'pause' && server.calls[server.calls.length - 1].body.linked_from === '400:1');
  check('settled: gone from the local copy at once', localOf(u) && !('linked_from' in localOf(u)), localOf(u));
  const m = server.calls.length;
  await u.engine.play();
  await clock.advance(21000);
  check('and from the saves', server.calls.slice(m).length >= 1 && server.calls.slice(m).every((c) => !('linked_from' in c.body)));
  u.engine.close();
  await clock.advance(20000);
  const v = withEngine({ clock, server, storage, book: CHAPTERED, places: { web: web2, plex: null } });
  await openBook(v);
  await clock.advance(12000);
  check('nor at the open after', server.calls.slice(m).every((c) => !('linked_from' in c.body)));
  v.engine.close();
  await clock.advance(20000);
}
{
  // A later startOver (the book held again) drops an unsettled link: ruling (c).
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  setLocal(storage, { track: '599', offset_ms: 120000, duration_ms: 900000, updated_at: iso(-10), own: true, acked: false,
    book_ms: 720000, linked_from: '400:1' });
  const t = withEngine({ clock, server, storage, book: CHAPTERED, places: { web: GONE_WEB, plex: null } });
  await openBook(t);
  check('held (the local copy names a part the book no longer has)', t.engine.state().filesChanged !== null);
  t.engine.startOver();
  await clock.advance(2000);
  check('startOver sends no link', server.calls.length === 1 && !('linked_from' in server.calls[0].body), server.calls.map((c) => c.body));
  check('and drops it from the local copy', localOf(t) && !('linked_from' in localOf(t)) && localOf(t).book_ms === 0, localOf(t));
  await t.engine.play();
  await clock.advance(12000);
  check('never sent after', server.calls.every((c) => !('linked_from' in c.body)));
  t.engine.close();
}

// T2T1: under a smart rewind's floor, a save carries the floor's place, and
// that place's own book time and chapter (not the playhead's).
current = 'T2T1: a floor\'s save carries the floor\'s own book_ms and chapter_label';
{
  const t = withEngine({ book: CHAPTERED, places: { web: { track: '501', offset_ms: 295000, duration_ms: 600000, updated_at: iso(-5) }, plex: null } });
  await openBook(t);
  await t.clock.advance(8000);                         // past 300 s: The Middle
  const before = t.engine.state().bookMs;
  const n = t.server.fetches().length;
  t.engine.rewind(before - 12000);                     // back into the Opening
  await t.clock.advance(9500);
  const f = t.server.fetches().slice(n).map((c) => c.body);
  const playhead = t.engine.state().bookMs;
  check('the floor is on (the playhead is behind it)', playhead < before, [playhead, before]);
  check('saves carry the floor\'s place with its own book time and chapter', f.length >= 1 &&
    f.every((b) => b.book_ms === STARTS[b.track] + b.offset_ms && b.book_ms >= before - 250 && b.chapter_label === 'The Middle'),
    f.map((b) => [b.offset_ms, b.book_ms, b.chapter_label]));
  t.saver.flush('beacon');
  const bb = beaconBodies(t).pop();
  check('the beacon too', bb && bb.book_ms === STARTS[bb.track] + bb.offset_ms && bb.chapter_label === 'The Middle', bb);
  const l = localOf(t);
  check('and the local copy', l && l.book_ms === STARTS[l.track] + l.offset_ms && l.chapter_label === 'The Middle', l);
  t.engine.close();
}

// ---- Fix round 2 ----
// T2R2: held again with a link still unsettled in the local copy, a confirm
// keeps sending it; only startOver drops it.
current = 'T2R2: held again with an unsettled link, confirmPlace keeps it and startOver drops it';
for (const act of ['confirmPlace', 'startOver']) {
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  setLocal(storage, { track: '599', offset_ms: 120000, duration_ms: 900000, updated_at: iso(-10), own: true, acked: false,
    book_ms: 720000, book_duration_ms: 1800000, linked_from: '400:1' });
  const t = withEngine({ clock, server, storage, book: CHAPTERED, places: { web: GONE_WEB, plex: null } });
  await openBook(t);
  check(act + ': held from the local copy', t.engine.state().filesChanged && t.engine.state().filesChanged.old.source === 'local');
  server.extra = { linked: null };
  if (act === 'confirmPlace') t.engine.confirmPlace(650000); else t.engine.startOver();
  await clock.advance(2000);
  await t.engine.play();
  await clock.advance(12000);
  const links = [...new Set(server.calls.map((c) => c.body.linked_from || '-'))];
  if (act === 'confirmPlace') {
    check('confirmPlace: every save carries the kept link', links.join() === '400:1' && server.calls.length >= 2, links);
    check('confirmPlace: the local copy keeps it', localOf(t).linked_from === '400:1', localOf(t));
  } else {
    check('startOver: none sent', links.join() === '-', links);
    check('startOver: gone from the local copy', !('linked_from' in localOf(t)), localOf(t));
  }
  t.engine.close();
}

// T2R3: a confirm made after 5 minutes or more at the helper is saved at
// once: its move never waits on the late re-read, so a Play and Pause
// during that read can't cancel it and leave the book unheld at 0:00.
current = 'T2R3: a confirm after 5+ minutes held is saved once the re-read lands; Play and Pause during the read never cancel it';
for (const variant of ['Play, then Pause during the read', 'Play only']) {
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  server.row = { track: '599', offset_ms: 120000, updated_at: GONE_WEB.updated_at, psid: 'other', seq: 9 };
  const t = withEngine({ clock, server, storage, book: CHAPTERED, places: { web: GONE_WEB, plex: null }, wallClock: true, slowPosition: 3000 });
  await openBook(t);
  await clock.advance(6 * 60000);                      // the helper up for 6 minutes
  check(variant + ': held', t.engine.state().filesChanged !== null && server.calls.length === 0);
  t.engine.confirmPlace(650000);
  await clock.advance(200);
  check(variant + ': held while the re-read is out, nothing sent', t.engine.state().filesChanged !== null && t.engine.state().checking === true &&
    server.calls.length === 0, server.calls.map((c) => c.body));
  t.engine.play();                                     // held: a preview, never a save
  await clock.advance(1000);
  if (variant.indexOf('Pause') !== -1) t.engine.pause();
  check(variant + ': still held during the read', t.engine.state().filesChanged !== null && server.calls.length === 0);
  await clock.advance(5000);
  // Fix round 5 (T2U3): a Play made during the read plays on from the
  // landing (saved as a move while playing); a Pause after it takes it back.
  const playOn = variant.indexOf('Pause') === -1;
  check(variant + ': the confirm landed after the read, saved once at the spot', t.engine.state().filesChanged === null && server.calls.length === 1 &&
    server.calls[0].body.book_ms === 650000 && server.calls[0].body.event === (playOn ? 'seek' : 'pause') && server.row.track === '502' && server.row.offset_ms === 50000,
    server.calls.map((c) => c.body));
  check(variant + (playOn ? ': the Play carried over: playing from it' : ': the Pause took the Play back: paused at it'),
    t.engine.state().playing === playOn && t.engine.state().bookMs >= 650000 && t.engine.state().bookMs < 655000, t.engine.state());
  await t.engine.play();
  await clock.advance(12000);
  const bad = server.calls.filter((c) => c.body.book_ms < 650000);
  check(variant + ': never a save before the confirmed spot (no 0:00)', bad.length === 0 && server.row.book_ms >= 650000, server.calls.map((c) => [c.body.event, c.body.book_ms]));
  check(variant + ': playing on from it', t.engine.state().playing && t.engine.state().bookMs > 650000 && t.engine.state().filesChanged === null, t.engine.state().bookMs);
  t.engine.close();
}

// ---- Fix round 3 ----
// The server's own rule (listening.save_checkin): another page session's
// row whose stamp is not `base` refuses with 409.
function casPost(server, clock) {
  return (body, kind) => {
    const b = JSON.parse(JSON.stringify(body));
    const call = { kind, body: b, at: clock.now, status: null };
    server.calls.push(call);
    if (kind === 'beacon') return true;
    return new Promise((resolve) => clock.setTimeout(() => {
      const row = server.row;
      if (row && row.psid !== b.psid && b.base !== row.updated_at) {
        call.status = 409;
        resolve({ status: 409, data: { conflict: { track: row.track, offset_ms: row.offset_ms, device: row.device, updated_at: row.updated_at }, now: new Date(clock.now).toISOString() } });
        return;
      }
      call.status = 200;
      server.row = Object.assign({}, b, { updated_at: new Date(clock.now).toISOString() });
      resolve({ status: 200, data: { stored: true, updated_at: server.row.updated_at } });
    }, 80));
  };
}

// T2R4: a confirm after 5+ minutes held reads the saved places again BEFORE
// the hold ends. A newer place saved meanwhile in a Plex app, or by another
// device, is asked about inside the hold: nothing is saved until the
// listener answers; Keep listening here confirms the spot, Continue the
// other place.
current = 'T2R4: a confirm after a long quiet asks about a newer Plex-app or other-device place first, saving nothing until answered';
for (const variant of ['a Plex app played meanwhile', 'another device saved meanwhile', 'control: nothing newer']) {
  for (const answer of variant.startsWith('control') ? ['none'] : ['Keep listening here', 'Continue']) {
    const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
    server.row = { psid: 'other', seq: 9, track: '599', offset_ms: 120000, updated_at: GONE_WEB.updated_at, device: 'Chrome on Windows' };
    server.post = casPost(server, clock);
    // An older, acknowledged local copy too: the question must leave it alone.
    setLocal(storage, { track: '598', offset_ms: 5000, duration_ms: 900000, updated_at: iso(-7200), own: true, acked: true, book_ms: 605000 });
    const keptLocal = storage.map.get(LOCAL_KEY);
    const places = { web: Object.assign({}, GONE_WEB), plex: null };
    const t = withEngine({ clock, server, storage, book: CHAPTERED, places, wallClock: true });
    await openBook(t);
    await clock.advance(6 * 60000);                    // the helper up for 6 minutes
    const at = new Date(clock.now - 60000).toISOString();
    if (variant.startsWith('a Plex')) places.plex = { track: '502', offset_ms: 30000, duration_ms: 900000, updated_at: at, device: 'Plexamp' };
    if (variant.startsWith('another')) {
      server.row = { psid: 'phone', seq: 3, track: '502', offset_ms: 30000, updated_at: at, device: 'Safari on iPhone' };
      places.web = Object.assign({}, GONE_WEB, { track: '502', offset_ms: 30000, book_ms: 630000, updated_at: at, psid: 'phone', device: 'Safari on iPhone' });
    }
    const label = variant + (answer === 'none' ? '' : ' / ' + answer);
    const rowBefore = JSON.stringify(server.row);
    t.engine.confirmPlace(650000);
    await clock.advance(6000);
    const asked = t.log.warning.filter((w) => w.kind === 'conflict');
    if (variant.startsWith('control')) {
      check(label + ': no question; the confirm lands after the read, saved once', asked.length === 0 && t.engine.state().filesChanged === null &&
        server.calls.length === 1 && server.calls[0].body.book_ms === 650000 && server.calls[0].status === 200, server.calls.map((c) => [c.body.book_ms, c.status]));
      t.engine.close();
      continue;
    }
    check(label + ': the question, about the newer place', asked.length === 1 && asked[0].conflict.track === '502' && asked[0].conflict.offset_ms === 30000, asked);
    check(label + ': still held, nothing saved, the server row untouched', t.engine.state().filesChanged !== null && server.calls.length === 0 &&
      JSON.stringify(server.row) === rowBefore, [server.calls.length, server.row]);
    check(label + ': the local copy left as it was', storage.map.get(LOCAL_KEY) === keptLocal, storage.map.get(LOCAL_KEY));
    await t.engine.play();                             // held: a bounded preview only
    await clock.advance(60000);
    check(label + ': Play meanwhile saves nothing', server.calls.length === 0 && t.engine.state().filesChanged !== null && !t.engine.state().playing);
    if (answer === 'Continue') t.engine.seek(630000);  // features.js: Continue moves to the other place, then answers
    t.engine.resolveConflict();
    await clock.advance(2000);
    const want = answer === 'Continue' ? 630000 : 650000;
    check(label + ': answered: the hold ends at the chosen place, saved once', t.engine.state().filesChanged === null && server.calls.length === 1 &&
      server.calls[0].body.book_ms === want && server.calls[0].status === 200 && server.row.book_ms === want, server.calls.map((c) => [c.body.book_ms, c.status]));
    t.engine.close();
  }
}

{
  // Held, a Play after the long quiet is only a preview: no late re-read,
  // no question (the real saver: its lastSeen looks past the hold).
  const t = withEngine({ book: CHAPTERED, places: { web: GONE_WEB, plex: null }, wallClock: true, slowPosition: 3000 });
  await openBook(t);
  await t.clock.advance(6 * 60000);
  const reads = t.got.filter((u) => u.indexOf('/position/') !== -1).length;
  await t.engine.play();
  await t.clock.advance(1000);
  check('T2R4: a held Play after a long quiet previews at once, no re-read', t.engine.state().playing && !t.engine.state().checking &&
    t.got.filter((u) => u.indexOf('/position/') !== -1).length === reads && t.engine.state().bookMs > 0, t.engine.state());
  t.engine.close();
}

// T2R5: pause() and toggle() during a late Play's read stop an element
// playing meanwhile from outside the engine, not only the read.
current = 'T2R5: pause() or toggle() during a late Play\'s read also stops the element';
for (const how of ['toggle()', 'pause()']) {
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  const web = { track: '502', offset_ms: 1000, duration_ms: 900000, updated_at: iso(-3600), device: 'Chrome on Windows', psid: 'other' };
  const t = withEngine({ clock, server, storage, places: { web, plex: null }, wallClock: true, slowPosition: 3500 });
  await openBook(t);
  await clock.advance(3000);
  t.engine.pause();
  await clock.advance(6 * 60000);                      // paused 6 minutes: the next Play is late
  t.engine.play();                                     // the read goes out (3.5 s)
  await clock.advance(200);
  const el = t.audios[0];
  el.play();                                           // from outside, during the read
  await clock.advance(200);
  check(how + ': the element plays during the read', !el.paused && t.engine.state().checking === true);
  if (how === 'toggle()') t.engine.toggle(); else t.engine.pause();
  await clock.advance(10000);
  check(how + ': it stops, and the read is cancelled', el.paused && !t.engine.state().playing && t.engine.state().checking === false, [el.paused, t.engine.state()]);
  t.engine.close();
}

// T2R6: a held preview is bounded by the wall clock too, so a seek from
// outside the engine back before its start can't stretch it.
current = 'T2R6: a held preview stops after 15 s of playing even when sought back from outside';
{
  const t = withEngine({ book: CHAPTERED, places: { web: GONE_WEB, plex: null }, wallClock: true });
  await openBook(t);
  t.engine.previewAt(700000);
  await t.clock.advance(3000);
  t.audios[0].currentTime = 10;                        // part 2 at 10 s: book 610 000, before the preview's start
  await t.clock.advance(150000);
  const s = t.engine.state();
  check('stopped about 15 s after it started playing', !s.playing && s.bookMs >= 610000 && s.bookMs <= 623000 && s.filesChanged !== null, s.bookMs);
  check('nothing saved', t.server.calls.length === 0);
  // Its wall time counts only while it plays: paused and resumed, it gets its full 15 s.
  t.engine.previewAt(1000000);
  await t.clock.advance(5000);
  t.engine.pause();
  await t.clock.advance(60000);
  await t.engine.play();
  await t.clock.advance(30000);
  check('a pause in the middle does not use it up', !t.engine.state().playing && t.engine.state().bookMs >= 1015000 && t.engine.state().bookMs <= 1015500, t.engine.state().bookMs);
  t.engine.close();
}

// ---- Fix round 4 ----
// A held rig after the helper has been up 6 minutes: a compare-and-swap
// server, and then a newer place saved meanwhile in a Plex app or by another
// device (variant).
async function heldAfterQuiet(variant, o = {}) {
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  server.row = { psid: 'other', seq: 9, track: '599', offset_ms: 120000, updated_at: GONE_WEB.updated_at, device: 'Chrome on Windows' };
  server.post = casPost(server, clock);
  const places = { web: Object.assign({}, GONE_WEB), plex: null };
  const t = withEngine({ clock, server, storage, book: CHAPTERED, places, wallClock: true, mediaSession: o.mediaSession });
  await openBook(t);
  await clock.advance(6 * 60000);
  const at = new Date(clock.now - 60000).toISOString();
  if (variant === 'Plexamp') places.plex = { track: '502', offset_ms: 30000, duration_ms: 900000, updated_at: at, device: 'Plexamp' };
  else {
    server.row = { psid: 'phone', seq: 3, track: '502', offset_ms: 30000, updated_at: at, device: 'Safari on iPhone' };
    places.web = Object.assign({}, GONE_WEB, { track: '502', offset_ms: 30000, book_ms: 630000, updated_at: at, psid: 'phone', device: 'Safari on iPhone' });
  }
  return Object.assign(t, { clock, server, storage, rowBefore: JSON.stringify(server.row) });
}

// T2R7: the helper's natural flow is Preview, then Use this spot. A preview
// is playing, so it shows nothing of a place saved elsewhere meanwhile: the
// confirm still reads the saved places first, and asks.
current = 'T2R7: Preview, then confirm: a newer Plex-app or other-device place is still asked about first, nothing saved until answered';
for (const variant of ['Plexamp', 'another device']) {
  for (const flow of ['a preview to its end', '3 s into a preview', '3 s into the bar Play\'s preview']) {
    const t = await heldAfterQuiet(variant);
    if (flow === 'a preview to its end') { t.engine.previewAt(650000); await t.clock.advance(16000); }
    else if (flow === '3 s into a preview') { t.engine.previewAt(650000); await t.clock.advance(3000); }
    else { t.engine.seek(650000); await t.engine.play(); await t.clock.advance(3000); }
    const label = variant + ', ' + flow;
    t.engine.confirmPlace(650000);
    await t.clock.advance(6000);
    const asked = t.log.warning.filter((w) => w.kind === 'conflict');
    check(label + ': asked about the newer place', asked.length === 1 && asked[0].conflict.track === '502' && asked[0].conflict.offset_ms === 30000, asked);
    check(label + ': still held, nothing saved, the server row untouched', t.engine.state().filesChanged !== null && t.server.calls.length === 0 &&
      JSON.stringify(t.server.row) === t.rowBefore, t.server.calls.map((c) => [c.body.book_ms, c.status]));
    t.engine.resolveConflict();                        // Keep listening here
    await t.clock.advance(2000);
    check(label + ': Keep listening here: saved once at the spot', t.engine.state().filesChanged === null && t.server.calls.length === 1 &&
      t.server.calls[0].body.book_ms === 650000 && t.server.calls[0].status === 200, t.server.calls.map((c) => [c.body.book_ms, c.status]));
    t.engine.close();
  }
}

// T2R8: during the confirm's question, the held playhead is at the confirmed
// spot, and every move goes from that spot: Keep listening here then saves
// where the listener moved to, never the held 0:00.
current = 'T2R8: a move during the confirm\'s question goes from the confirmed spot; Keep listening here saves there';
for (const how of ['skip(-10)', 'the lock screen\'s seek back', 'skip(+10)', 'the lock screen\'s seekto 700 s', 'no move']) {
  const ms = { metadata: null, playbackState: 'none', handlers: new Map(), setActionHandler(a, fn) { this.handlers.set(a, fn); }, setPositionState() {} };
  const t = await heldAfterQuiet('Plexamp', { mediaSession: ms });
  t.engine.confirmPlace(650000);
  await t.clock.advance(3000);
  const asked = t.engine.state();
  check(how + ': asked, held, the playhead at the confirmed spot', t.log.warning.some((w) => w.kind === 'conflict') && asked.filesChanged !== null &&
    asked.bookMs === 650000 && asked.filesChanged.spot === 650000, [asked.bookMs, asked.filesChanged]);
  if (how === 'skip(-10)') t.engine.skip(-10);
  if (how === 'the lock screen\'s seek back') ms.handlers.get('seekbackward')({});
  if (how === 'skip(+10)') t.engine.skip(10);
  if (how === 'the lock screen\'s seekto 700 s') ms.handlers.get('seekto')({ seekTime: 700 });
  await t.clock.advance(500);
  const want = { 'skip(-10)': 640000, 'the lock screen\'s seek back': 640000, 'skip(+10)': 660000, 'the lock screen\'s seekto 700 s': 700000, 'no move': 650000 }[how];
  check(how + ': still held, nothing saved', t.engine.state().filesChanged !== null && t.server.calls.length === 0);
  t.engine.resolveConflict();                          // Keep listening here
  await t.clock.advance(5000);
  check(how + ': Keep listening here saves once where the listener is', t.engine.state().filesChanged === null && t.server.calls.length === 1 &&
    t.server.calls[0].body.book_ms === want && t.server.row.book_ms === want && t.engine.state().bookMs === want, t.server.calls.map((c) => c.body.book_ms));
  check(how + ': never 0:00', !t.server.calls.some((c) => c.body.book_ms < 600000));
  t.engine.close();
}

// ---- Fix round 5 ----
// A held rig whose re-read answers `read` ms late, with a Media Session; the
// web copy is from an earlier copy of the book (linked_from 400:1).
async function heldSlowRead(read, o = {}) {
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  server.row = { psid: 'other', seq: 9, track: '401', offset_ms: 120000, updated_at: LINKED_WEB.updated_at, device: 'Chrome on Windows' };
  server.post = casPost(server, clock);
  const ms = { metadata: null, playbackState: 'none', handlers: new Map(), setActionHandler(a, fn) { this.handlers.set(a, fn); }, setPositionState() {} };
  const places = { web: Object.assign({}, LINKED_WEB), plex: o.plex || null };
  const t = withEngine({ clock, server, storage, book: CHAPTERED, places, wallClock: true, slowPosition: read, mediaSession: ms });
  await openBook(t);
  await clock.advance(20000);
  return Object.assign(t, { clock, server, storage, ms });
}

// T2U2: a move made while the confirm reads the saved places is the
// listener's: the confirm lands there, its link goes with it (never a
// startOver's), and the read compares the newer places with that spot.
current = 'T2U2: a move during the confirm\'s read is where it lands, with the link';
const DURING = [
  ['skip(-10)', (t) => t.engine.skip(-10), 640000],
  ['skip(+30)', (t) => t.engine.skip(30), 680000],
  ['seek(700000) (the scrubber, a history entry)', (t) => t.engine.seek(700000), 700000],
  ['the lock screen\'s seekto 400 s', (t) => t.ms.handlers.get('seekto')({ seekTime: 400 }), 400000],
  ['the lock screen\'s seek back', (t) => t.ms.handlers.get('seekbackward')({}), 640000]
];
for (const [what, move, want] of DURING) {
  const t = await heldSlowRead(2000);
  t.engine.confirmPlace(650000);
  await t.clock.advance(500);
  move(t);
  await t.clock.advance(100);
  check(what + ': still held, reading, at the moved spot', t.engine.state().filesChanged !== null && t.engine.state().checking === true &&
    t.engine.state().bookMs === want && t.server.calls.length === 0, t.engine.state().bookMs);
  await t.clock.advance(5000);
  check(what + ': landed there, saved once with the link', t.engine.state().filesChanged === null && t.engine.state().bookMs === want &&
    t.server.calls.length === 1 && t.server.calls[0].body.book_ms === want && t.server.calls[0].body.linked_from === '400:1',
    t.server.calls.map((c) => [c.body.book_ms, c.body.linked_from || null]));
  t.engine.close();
}
{
  const t = await heldSlowRead(2000);
  t.engine.startOver();
  await t.clock.advance(500);
  t.engine.skip(10);
  await t.clock.advance(5000);
  check('startOver, then skip(+10) during its read: lands at 10 s, never with the link', t.engine.state().filesChanged === null &&
    t.server.calls.length === 1 && t.server.calls[0].body.book_ms === 10000 && !t.server.calls[0].body.linked_from,
    t.server.calls.map((c) => [c.body.book_ms, c.body.linked_from || null]));
  t.engine.close();
}
{
  // A Plexamp place at 640 000, newer: the confirm said 650 000, then the
  // listener skipped back 10 s to it. The very spot: nothing to ask.
  const t = await heldSlowRead(2000);
  t.places.plex = { track: '502', offset_ms: 40000, duration_ms: 900000, updated_at: new Date(t.clock.now - 60000).toISOString(), device: 'Plexamp' };
  t.engine.confirmPlace(650000);
  await t.clock.advance(500);
  t.engine.skip(-10);
  await t.clock.advance(5000);
  check('the read compares with the moved spot: Plexamp there is no question', !t.log.warning.some((w) => w.kind === 'conflict') &&
    t.engine.state().filesChanged === null && t.server.calls.length === 1 && t.server.calls[0].body.book_ms === 640000,
    [t.log.warning.map((w) => w.kind), t.server.calls.map((c) => c.body.book_ms)]);
  t.engine.close();
}

// T2U3: a Play made while the confirm reads (the bar, the lock screen, or a
// helper that plays on confirm) plays on from where it lands; a Pause after
// it takes it back; a question asked by the read leaves it to the answer.
current = 'T2U3: a Play during the confirm\'s read plays on from the landing';
for (const read of [300, 2000]) {
  for (const how of ['play() at once', 'play() 100 ms later', 'the lock screen\'s Play 100 ms later', 'Play, then Pause', 'Play, then a question']) {
    const t = await heldSlowRead(read);
    if (how === 'Play, then a question') t.places.plex = { track: '502', offset_ms: 30000, duration_ms: 900000, updated_at: new Date(t.clock.now - 60000).toISOString(), device: 'Plexamp' };
    t.engine.confirmPlace(650000);
    if (how === 'play() at once') await t.engine.play();
    else {
      await t.clock.advance(100);
      if (how.startsWith('the lock')) t.ms.handlers.get('play')(); else await t.engine.play();
    }
    if (how === 'Play, then Pause') { await t.clock.advance(100); t.ms.handlers.get('pause')(); }
    await t.clock.advance(5000);
    const s = t.engine.state();
    const label = `read ${read} ms, ${how}`;
    if (how === 'Play, then a question') {
      await t.clock.advance(20000);
      check(label + ': asked, still held: the Play stays a bounded preview, nothing saved', t.engine.state().filesChanged !== null &&
        !t.engine.state().playing && t.server.calls.length === 0 && t.log.warning.some((w) => w.kind === 'conflict'), [t.engine.state().playing, t.server.calls.length]);
    } else if (how === 'Play, then Pause') {
      check(label + ': landed paused at the spot', s.filesChanged === null && !s.playing && s.bookMs === 650000 && t.server.calls.length === 1 &&
        t.server.calls[0].body.book_ms === 650000, [s.playing, s.bookMs]);
    } else {
      check(label + ': landed and playing on from the spot', s.filesChanged === null && s.playing && s.bookMs > 650000 && s.bookMs <= 655000, [s.playing, s.bookMs]);
      check(label + ': its first save is the spot, none before it', t.server.calls.length >= 1 && t.server.calls[0].body.book_ms === 650000 &&
        t.server.calls.every((c) => c.body.book_ms >= 650000), t.server.calls.map((c) => [c.body.event, c.body.book_ms]));
    }
    t.engine.close();
  }
}

// ---- Spec 2.6: the safety net, on the real saver ----
const ORPHANS = [{ key: '400:1', book_title: 'Three Parts (First Edition)', narrator: 'N. Reader', book_ms: 720000, book_duration_ms: 1800000,
  chapter_label: 'Chapter 4', updated_at: iso(-3600), author_match: true }];
const scorePosts = (t) => t.server.calls.length;

current = 'spec 2.6: while the question is open nothing is sent or written, whatever happens, and a reload asks again';
{
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  const t = withEngine({ clock, server, storage, book: CHAPTERED, orphans: ORPHANS });
  await openBook(t);
  check('the question is open', t.engine.state().safetyNet !== null && !t.engine.state().playing);
  await t.engine.play();
  t.engine.seek(250000);
  t.engine.skip(30);
  await clock.advance(6 * 60000);
  await t.engine.play();
  t.saver.flush('beacon');
  t.saver.flush();
  await clock.advance(20000);
  check('0 saves, 0 beacons', scorePosts(t) === 0, t.server.calls.map((c) => c.body));
  check('nothing in the local copy', localOf(t) === null && Array.from(storage.map.keys()).every((k) => k.indexOf(':500:1') === -1), Array.from(storage.map.keys()));
  t.engine.close();
  await clock.advance(5000);
  check('closing it (the last save) sends nothing either', scorePosts(t) === 0 && localOf(t) === null);
  // A reload: a new page session, the same storage and server. It asks again.
  const u = withEngine({ clock, server, storage, book: CHAPTERED, orphans: ORPHANS });
  await openBook(u);
  check('the reload reopens the question', u.engine.state().safetyNet !== null && u.engine.state().safetyNet.orphans.length === 1 && !u.engine.state().playing &&
    u.got.filter((x) => x.indexOf('/api/player/orphans/') === 0).length === 1);
  await u.engine.play();
  await clock.advance(30000);
  check('and again nothing was saved', scorePosts(u) === 0 && localOf(u) === null);
  u.engine.close();
}

current = 'spec 2.6: a pick, confirmed, sends linked_from with link_manual until the server says whether it linked';
{
  const clock = fakeClock(); const server = fakeServer(clock); const storage = fakeStorage();
  const t = withEngine({ clock, server, storage, book: CHAPTERED, orphans: ORPHANS });
  await openBook(t);
  server.extra = { linked: null };                       // Plex can't say yet
  t.engine.pickOrphan('400:1');
  await clock.advance(20000);
  check('picked, not confirmed: nothing sent', scorePosts(t) === 0 && localOf(t) === null);
  t.engine.confirmPlace(650000);
  await clock.advance(2000);
  check('the confirm carries the link and the flag, and the spot', scorePosts(t) === 1 && server.calls[0].body.linked_from === '400:1' &&
    server.calls[0].body.link_manual === true && server.calls[0].body.book_ms === 650000, server.calls.map((c) => c.body));
  await t.engine.play();
  await clock.advance(11000);
  const f = server.fetches();
  check('null: every save sends both again', f.length >= 3 && f.every((c) => c.body.linked_from === '400:1' && c.body.link_manual === true), f.map((c) => [c.body.event, c.body.link_manual]));
  t.saver.flush('beacon');
  check('a beacon meanwhile carries both', beaconBodies(t).pop().link_manual === true && beaconBodies(t).pop().linked_from === '400:1');
  check('the local copy keeps both', localOf(t).linked_from === '400:1' && localOf(t).link_manual === true && t.saver.readLocal('500:1').link_manual === true, localOf(t));
  t.engine.close();
  await clock.advance(20000);
  // Reopened before the server settled it: the next open sends both again.
  const row = server.row;
  const web2 = { track: row.track, offset_ms: row.offset_ms, duration_ms: row.duration_ms, updated_at: row.updated_at, device: row.device, psid: row.psid };
  const n = server.calls.length;
  const u = withEngine({ clock, server, storage, book: CHAPTERED, places: { web: web2, plex: null }, orphans: ORPHANS });
  await openBook(u);
  check('it does not ask: the listener has a place now', u.got.filter((x) => x.indexOf('/api/player/orphans/') === 0).length === 0 && u.engine.state().safetyNet === null);
  await clock.advance(12000);
  const second = server.calls.slice(n);
  check('the next open sends both again', second.length >= 1 && second.every((c) => c.body.linked_from === '400:1' && c.body.link_manual === true),
    second.map((c) => [c.body.linked_from, c.body.link_manual]));
  server.extra = { linked: true };
  u.engine.pause();
  await clock.advance(2000);
  check('settled: gone from the local copy', localOf(u) && !('linked_from' in localOf(u)) && !('link_manual' in localOf(u)), localOf(u));
  const m = server.calls.length;
  await u.engine.play();
  await clock.advance(21000);
  check('and from the saves', server.calls.slice(m).length >= 1 && server.calls.slice(m).every((c) => !('linked_from' in c.body) && !('link_manual' in c.body)));
  u.engine.close();
}
{
  // false settles it as well.
  const t = withEngine({ book: CHAPTERED, orphans: ORPHANS });
  await openBook(t);
  t.server.extra = { linked: false };
  t.engine.pickOrphan('400:1');
  t.engine.confirmPlace(650000);
  await t.clock.advance(2000);
  await t.engine.play();
  await t.clock.advance(12000);
  const uf = t.server.fetches();
  check('false: only the confirm carried it', uf[0].body.link_manual === true && uf.slice(1).length >= 1 && uf.slice(1).every((c) => !('link_manual' in c.body) && !('linked_from' in c.body)));
  t.engine.close();
  // An automatic link (the web copy came with linked_from) never carries the flag.
  const a = withEngine({ book: CHAPTERED, places: { web: LINKED_WEB, plex: null }, orphans: ORPHANS });
  await openBook(a);
  a.server.extra = { linked: null };
  a.engine.confirmPlace(650000);
  await a.clock.advance(2000);
  await a.engine.play();
  await a.clock.advance(12000);
  check('automatic: linked_from, never link_manual', a.server.calls.length >= 2 && a.server.calls.every((c) => c.body.linked_from === '400:1' && !('link_manual' in c.body)));
  check('nor in the local copy', localOf(a) && localOf(a).linked_from === '400:1' && !('link_manual' in localOf(a)), localOf(a));
  a.engine.close();
  // Start from the beginning after a pick sends no link at all.
  const s = withEngine({ book: CHAPTERED, orphans: ORPHANS });
  await openBook(s);
  s.server.extra = { linked: null };
  s.engine.pickOrphan('400:1');
  s.engine.startOver();
  await s.clock.advance(2000);
  await s.engine.play();
  await s.clock.advance(12000);
  check('startOver: no link, no flag', s.server.calls.length >= 2 && s.server.calls.every((c) => !('linked_from' in c.body) && !('link_manual' in c.body)));
  check('nor in the local copy', localOf(s) && !('linked_from' in localOf(s)) && !('link_manual' in localOf(s)), localOf(s));
  s.engine.close();
}

current = 'spec 2.6: "None of these" releases the hold; the book then saves as any new book does';
{
  const t = withEngine({ book: CHAPTERED, orphans: ORPHANS });
  await openBook(t);
  check('dismiss', t.engine.dismissOrphans() === true);
  await t.clock.advance(3000);
  check('the server was told, once', t.dismissals.length === 1 && t.dismissals[0] === '/api/player/orphans/500%3A1/dismiss', t.dismissals);
  check('it plays, and nothing was sent for the dismissal itself', t.engine.state().playing && scorePosts(t) <= 1, t.server.calls.map((c) => c.body));
  await t.clock.advance(25000);
  const f = t.server.fetches();
  check('saves as a new book: from the start, no link, no flag', f.length >= 2 && f[0].body.offset_ms < 5000 && f.every((c) => !('linked_from' in c.body) && !('link_manual' in c.body)),
    f.map((c) => [c.body.event, c.body.offset_ms]));
  t.engine.close();
}

if (failed) {
  realError(`${failed}/${total} player saves cases FAILED`);
  process.exit(1);
}
console.log(`${total}/${total} player saves cases pass`);
