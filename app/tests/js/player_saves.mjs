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
          if (mode !== 200) { resolve({ status: mode, data: { detail: 'no' } }); return; }
          resolve({ status: 200, data: s.store(b) });
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
  check('body fields', JSON.stringify(Object.keys(f[1].body).sort()) === JSON.stringify(['book', 'device', 'duration_ms', 'event', 'offset_ms', 'psid', 'seq', 'track']), Object.keys(f[1].body));
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
const durations = new Map(BOOK.tracks.map((t) => [t.part_path, t.duration_ms]));
class MiniAudio {
  constructor(clock, net) {
    this.net = net || {};                         // net.failLoads: every load fails (the stream is down)
    this.clock = clock; this.ls = new Map(); this._src = ''; this._t = 0; this.gen = 0;
    this.paused = true; this.ended = false; this.error = null; this.readyState = 0; this.seeking = false;
    this.duration = NaN; this.playbackRate = 1; this.defaultPlaybackRate = 1; this.preload = 'auto'; this.ticking = false;
  }
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
  const t = makeSaver({ clock, server, storage });
  const net = { failLoads: false };
  const audios = [];
  const engine = E.createEngine({
    host: { appendChild() {} },
    createAudio: () => { const a = new MiniAudio(clock, net); audios.push(a); return a; },
    fetch: async (url) => {
      got.push(url);
      const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });
      let m = /^\/api\/player\/book\/([^?]+)/.exec(url);
      if (m) return reply(200, Object.assign({}, BOOK, { stream: { token: 'tok', uris: { local: [], remote: o.noStream ? [] : [REMOTE] } } }));
      m = /^\/api\/player\/position\/(.+)$/.exec(url);
      if (m) return o.positionStatus ? reply(o.positionStatus, { detail: 'down' })
        : reply(200, Object.assign({ now: new Date(clock.now + server.skewMs).toISOString() }, places));
      return reply(404, { detail: 'Not Found' });
    },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    mediaSession: null,
    MediaMetadata: null,
    baseUrl: 'https://ws.test/',
    saver: t.saver
  });
  const log = { change: [], warning: [], error: [], order: [] };
  engine.on('change', (d) => {
    log.change.push({ reason: d.reason, saveError: d.state.saveError, lastSavedAt: d.state.lastSavedAt });
    log.order.push(['change', d.reason, d.state.saveError]);
  });
  engine.on('warning', (w) => { log.warning.push(w); log.order.push(['warning', w.kind, w.active]); });
  engine.on('error', (e) => log.error.push(e));
  return Object.assign(t, { engine, got, log, places, net, audios });
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
  const storage = fakeStorage();
  setLocal(storage, { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-10), device: 'Chrome on Android' });
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

current = 'a saved place in a part the book no longer has: the next newest, else the start with a notice';
{
  const storage = fakeStorage();
  setLocal(storage, { track: '999', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-10) });
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
  check('opened at the newest copy whose part exists (web)', s.position.track === '503' && s.position.offset_ms >= 12000 && s.position.offset_ms <= 13000, s.position);
  check('no notice', t.log.warning.length === 0, t.log.warning);
  check('no newer-local send (the local copy was unusable)', t.server.fetches().every((c) => c.body.track === '503'));
  t.engine.close();

  const storage2 = fakeStorage();
  setLocal(storage2, { track: '999', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-10) });
  const u = withEngine({ storage: storage2, places: { web: { track: '997', offset_ms: 1, updated_at: iso(-600) }, plex: null } });
  const opened2 = u.engine.open('500:1');
  await u.clock.advance(1000);
  await opened2;
  const s2 = u.engine.state();
  check('none usable: the start of the book', s2.position.track === '501' && s2.position.offset_ms < 1500, s2.position);
  check('with the notice', u.log.warning.length === 1 && u.log.warning[0].kind === 'resume-lost' &&
    u.log.warning[0].message === "Couldn't find your saved place in this book", u.log.warning);
  check('resumedFrom null', s2.resumedFrom === null);
  u.engine.close();

  const v = withEngine();
  const opened3 = v.engine.open('500:1');
  await v.clock.advance(1000);
  await opened3;
  check('no saved place at all: the start, no notice', v.engine.state().position.track === '501' && v.log.warning.length === 0);
  v.engine.close();
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
  setLocal(storage, { track: '502', offset_ms: 300000, duration_ms: 900000, updated_at: iso(-3600), device: 'Chrome on Android' });
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

if (failed) {
  realError(`${failed}/${total} player saves cases FAILED`);
  process.exit(1);
}
console.log(`${total}/${total} player saves cases pass`);
