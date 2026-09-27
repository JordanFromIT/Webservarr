// The soft-navigation debug tools (spec 7) where they need no browser:
// debug-flag parsing (router.js), stack attribution, leak bookkeeping, the
// soak's schedule and result, and the test tone file. Runs the files as they
// are, not copies; like router.mjs, each module is imported from its source as
// a data: URL, which also proves neither touches the DOM at import time.
// Run: node app/tests/js/debug_leaks.mjs (CI job js-checks; npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => import('data:text/javascript;charset=utf-8,' +
  encodeURIComponent(readFileSync(join(here, rel), 'utf8')));
const { debugFlags } = await load('../../static/js/router.js');
const dbg = await load('../../static/js/debug-leaks.js');

let failed = 0;
let total = 0;
function check(name, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error('FAIL ' + name + (info === undefined ? '' : ': ' + JSON.stringify(info)));
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise((r) => setImmediate(r));

// ---- debugFlags(search, stored) ----

for (const [search, stored, flags, store, why] of [
  ['', null, [], null, 'no flag anywhere'],
  ['?ws-debug=leaks', null, ['leaks'], 'leaks', 'the URL turns it on and it is stored'],
  ['?a=1&ws-debug=throw,leaks', null, ['leaks', 'throw'], 'leaks,throw', 'comma list, fixed order'],
  ['?ws-debug=%20Leaks%20', null, ['leaks'], 'leaks', 'case and spaces'],
  ['', 'leaks', ['leaks'], null, 'stored flags survive a soft navigation'],
  ['?ws-debug=throw', 'leaks', ['leaks', 'throw'], 'leaks,throw', 'the URL adds to what is stored'],
  ['?ws-debug=off', 'leaks,throw', [], '', '"off" clears the stored flags'],
  ['?ws-debug=bogus', null, [], null, 'unknown flags are ignored'],
  ['?ws-debug=', 'leaks', ['leaks'], null, 'an empty value changes nothing'],
  ['', 'leaks,nonsense', ['leaks'], null, 'unknown stored flags are ignored'],
]) {
  const got = debugFlags(search, stored);
  check('debugFlags, ' + why, eq(got, { flags, store }), got);
}

// ---- Stack attribution ----

const PAGE = 'https://host.example/static/js/pages/news.js?v=abc';
const OTHER = 'https://host.example/static/js/pages/wiki.js?v=abc';
const SHELL = 'https://host.example/static/js/shell.js?v=abc';
const ROUTER = 'https://host.example/static/js/router.js?v=abc';
const SELF = 'https://host.example/static/js/debug-leaks.js?v=abc';
const HELPER = 'https://host.example/static/js/news-editor.js?v=abc';
const stack = (...urls) => 'Error\n' + urls.map((u, i) => `    at f${i} (${u}:${i + 10}:5)`).join('\n');

check('pageNameOf', dbg.pageNameOf(PAGE) === 'news' && dbg.pageNameOf('/static/js/pages/_debug-throw.js') === '_debug-throw');
check('owner: page frame below shell frames', eq(dbg.ownerOf(stack(SELF, SHELL, PAGE, ROUTER)), { page: 'news', shell: false }));
check('owner: shell only', eq(dbg.ownerOf(stack(SELF, ROUTER, SHELL)), { page: null, shell: true }));
check('owner: the debug module itself is not shell', eq(dbg.ownerOf(stack(SELF)), { page: null, shell: false }));
check('owner: a page helper is not shell', eq(dbg.ownerOf(stack(SELF, HELPER, SHELL)), { page: null, shell: false }));
check('owner: Firefox frames', eq(dbg.ownerOf(`f@${SHELL}:1:2\nmount@${PAGE}:3:4`), { page: 'news', shell: false }));
check('owner: async frames', eq(dbg.ownerOf(`Error\n    at x (${SHELL}:1:1)\n    at async mount (${PAGE}:3:4)`),
  { page: 'news', shell: false }));

// ---- The tracker, against Node's own EventTarget, timers and a fake fetch ----

// The real EventTarget.prototype is wrapped (uninstall puts it back), so
// Node's AbortSignal is covered too.
class Target extends EventTarget {}
class Node2 extends EventTarget { constructor() { super(); this.isConnected = true; } }
const ORIG_ADD = EventTarget.prototype.addEventListener;
const ORIG_REMOVE = EventTarget.prototype.removeEventListener;
let fetchResolve = [];
const g = {
  EventTarget, AbortSignal,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: function (url) {
    return new Promise((resolve, reject) => fetchResolve.push({ url, resolve, reject }));
  }
};
let nowStack = stack(SELF, PAGE);
const tr = dbg.createTracker(g, { stack: () => nowStack });

// Behaviour is unchanged: same return values, same this, options honoured.
{
  const t = new Target();
  let calls = 0;
  let seenThis = null;
  const h = function () { calls += 1; seenThis = this; };
  check('addEventListener returns undefined', t.addEventListener('x', h) === undefined);
  t.addEventListener('x', h);                      // a duplicate is ignored by the DOM...
  t.dispatchEvent(new Event('x'));
  check('listener runs once, with this = the target', calls === 1 && seenThis === t, calls);
  t.removeEventListener('x', h);
  t.dispatchEvent(new Event('x'));
  check('removeEventListener still removes', calls === 1);
  const o = { n: 0, handleEvent() { this.n += 1; } };
  t.addEventListener('y', o, { once: true });
  t.dispatchEvent(new Event('y'));
  t.dispatchEvent(new Event('y'));
  check('handleEvent objects and once pass through', o.n === 1, o.n);
}

// Timers: same ids back, this and extra arguments passed through.
{
  const got = await new Promise((resolve) => {
    const id = g.setTimeout(function (a, b) { resolve({ a, b, id }); }, 0, 'x', 'y');
    check('setTimeout returns the real id', id && typeof id.hasRef === 'function');
  });
  check('setTimeout passes extra arguments', got.a === 'x' && got.b === 'y');
}

tr.stop();                                           // drop anything the checks above left

// A clean page: everything tied to its signal, timers cleared, fetch aborted.
{
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  const ctl = new AbortController();
  const win = new Target();
  win.addEventListener('resize', () => {}, { signal: ctl.signal });
  win.addEventListener('scroll', () => {}, { signal: ctl.signal, passive: true });
  const t1 = g.setTimeout(() => {}, 60000);
  g.clearTimeout(t1);
  const iv = g.setInterval(() => {}, 60000);
  g.clearInterval(iv);
  const fast = await new Promise((r) => g.setTimeout(() => r(1), 0));
  const f = g.fetch('/api/a', { signal: ctl.signal });
  f.catch(() => {});
  const done = win.addEventListener('ping', () => {}, { once: true });
  win.dispatchEvent(new Event('ping'));
  const removed = () => {};
  win.addEventListener('key', removed, true);
  win.removeEventListener('key', removed, true);
  ctl.abort();
  const out = tr.stop();
  check('clean page: nothing alive after leave', out.length === 0 && fast === 1 && done === undefined, out);
}

// A leaky page: one of each kind survives its signal.
{
  nowStack = stack(SELF, SHELL, PAGE);
  tr.start('news');
  const ctl = new AbortController();
  const doc = new Target();
  doc.addEventListener('click', () => {});                           // no signal
  doc.addEventListener('keydown', () => {}, { capture: true });      // no signal
  doc.addEventListener('keyup', () => {}, { signal: ctl.signal });   // released
  doc.addEventListener('keydown', () => {}, false);                  // different capture: a second one
  const t = g.setTimeout(() => {}, 60000);
  const iv = g.setInterval(() => {}, 60000);
  const pend = g.fetch('/api/slow');                                 // no signal, still in flight
  pend.catch(() => {});
  ctl.abort();
  const out = tr.stop();
  const kinds = out.map((i) => i.kind).sort();
  check('leaky page: each survivor reported', eq(kinds, ['fetch', 'interval', 'listener', 'listener', 'listener', 'timer']), kinds);
  check('leaky page: items name the page and carry a stack',
    out.every((i) => i.page === 'news' && /pages\/news\.js/.test(i.stack) && !/debug-leaks\.js/.test(i.stack)), out[0]);
  check('leaky page: a listener says what it is on', out.some((i) => i.kind === 'listener' && /^click on /.test(i.detail)), out);
  check('the report log keeps them', tr.reports.length >= 6);
  g.clearTimeout(t);
  g.clearInterval(iv);
}

// Shell code is never a page's, even while a page is mounted.
{
  tr.start('news');
  nowStack = stack(SELF, ROUTER, SHELL);
  const t = new Target();
  t.addEventListener('x', () => {});
  const id = g.setTimeout(() => {}, 60000);
  g.fetch('/prefetch').catch(() => {});
  nowStack = stack(SELF, PAGE);
  const out = tr.stop();
  check('shell-only stacks are not the page\'s', out.length === 0, out);
  g.clearTimeout(id);
}

// No stack frame at all names a page, but the page is mounted: it is the page's.
{
  tr.start('news');
  nowStack = stack(SELF, HELPER);
  const t = new Target();
  t.addEventListener('x', () => {});
  const out = tr.stop();
  check('a helper script\'s listener belongs to the mounted page', out.length === 1 && out[0].page === 'news', out);
}

// A page that goes on working after it was left: counted, and reported late.
{
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  tr.stop();
  nowStack = stack(SELF, OTHER);
  tr.start('wiki');
  const before = tr.requestsAfterLeave;
  nowStack = stack(SELF, SHELL, PAGE);                // news's poll tick, while wiki is mounted
  g.fetch('/api/news').catch(() => {});
  const lateT = g.setTimeout(() => {}, 60000);
  nowStack = stack(SELF, OTHER);
  const out = tr.stop();
  check('requestsAfterLeave counts a left page\'s fetch', tr.requestsAfterLeave === before + 1, tr.requestsAfterLeave - before);
  check('a left page\'s new items are leaks of that page', out.length === 2 && out.every((i) => i.page === 'news' && i.late), out);
  g.clearTimeout(lateT);
}

// A signal already aborted: the DOM adds nothing, so neither does the tracker.
{
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  const ctl = new AbortController();
  ctl.abort();
  new Target().addEventListener('x', () => {}, { signal: ctl.signal });
  check('already-aborted signal adds nothing', tr.stop().length === 0);
}

// A once listener that fired is gone; one on the page's signal is gone when it aborts.
{
  tr.start('news');
  const ctl = new AbortController();
  ctl.signal.addEventListener('abort', () => {}, { once: true });
  ctl.abort();
  check('once listener on the page signal is released by the abort', tr.stop().length === 0);
}

// Fetch settles: no longer alive. Rejections still reach the caller.
{
  tr.start('news');
  fetchResolve = [];
  const p1 = g.fetch('/ok');
  const p2 = g.fetch('/bad');
  fetchResolve[0].resolve('RESPONSE');
  fetchResolve[1].reject(new Error('boom'));
  const v = await p1;
  let err = null;
  try { await p2; } catch (e) { err = e; }
  check('fetch resolves to the same value', v === 'RESPONSE');
  check('fetch rejections still reach the caller', err && err.message === 'boom');
  check('settled fetches are not alive', tr.stop().length === 0);
}

// liveListeners: counts connected targets only, and drops what was released.
{
  tr.stop();
  const base = tr.liveListeners();
  const n = new Node2();
  n.addEventListener('a', () => {});
  n.addEventListener('a2', () => {});
  check('liveListeners counts new listeners', tr.liveListeners() === base + 2, tr.liveListeners() - base);
  // (Node's EventTarget also adds its own listener to the signal; a browser does not.)
  const ctl = new AbortController();
  n.addEventListener('b', () => {}, { signal: ctl.signal });
  check('liveListeners counts one with a signal', tr.liveListeners() > base + 2);
  ctl.abort();
  check('liveListeners drops aborted ones', tr.liveListeners() === base + 2, tr.liveListeners() - base);
  n.isConnected = false;
  check('liveListeners skips detached nodes', tr.liveListeners() === base);
}

tr.uninstall();
check('uninstall restores the originals', g.setTimeout === setTimeout && g.clearInterval === clearInterval &&
  EventTarget.prototype.addEventListener === ORIG_ADD && EventTarget.prototype.removeEventListener === ORIG_REMOVE);

// ---- The soak: schedule and result ----

function fakeRouter(opts) {
  opts = opts || {};
  const r = {
    url: '/news', mounts: [], navCalls: [], token: 0,
    navigate(u) {
      r.navCalls.push(u);
      const my = ++r.token;
      return Promise.resolve().then(() => {
        if (my !== r.token && !opts.bothMount) return;   // the newest navigation wins
        r.url = u;
        r.mounts.push(u);
      });
    }
  };
  return r;
}
function fakeDeps(router, extra) {
  let heap = 1000;
  return Object.assign({
    navigate: (u) => router.navigate(u),
    currentUrl: () => router.url,
    mounts: router.mounts,
    isConverted: async () => true,
    samePage: (a, b) => a === b,
    tracker: { reports: [], requestsAfterLeave: 0, liveListeners: () => 7 },
    heap: () => (heap += 10),
    interruptions: () => 0,
    sleep: () => tick()
  }, extra || {});
}

{
  const router = fakeRouter();
  const res = await dbg.runSoak(fakeDeps(router), ['/news', '/', '/wiki'], 10);
  // 8 plain rounds x 2 neighbours x 2 + 2 interleaved rounds x 2 neighbours x 3
  check('soak: navigation count', res.navigations === 8 * 4 + 2 * 6, res.navigations);
  check('soak: interleaved every fifth round', res.interleaved === 4, res.interleaved);
  check('soak: ends back on the page', router.url === '/news');
  check('soak: result shape', eq(Object.keys(res).sort(),
    ['failures', 'heapDelta', 'interleaved', 'interruptions', 'leaks', 'listenerDelta', 'navigations', 'requestsAfterLeave', 'tonePlaying'].sort()), Object.keys(res));
  check('soak: clean run', res.failures.length === 0 && res.leaks.length === 0 && res.listenerDelta === 0 &&
    res.requestsAfterLeave === 0 && res.interruptions === 0 && typeof res.heapDelta === 'number', res);
  // Round 5 on [/news, /, /wiki]: from /news, / then at once /wiki (and the reverse).
  const r5 = router.navCalls.slice(4 * 4, 4 * 4 + 6);
  check('soak: an interleaved round starts one navigation and at once another', eq(r5, ['/wiki', '/', '/news', '/', '/wiki', '/news']), r5);
}

{
  const router = fakeRouter();
  router.url = '/elsewhere';
  const res = await dbg.runSoak(fakeDeps(router), ['/news', '/'], 1);
  check('soak: first goes to the page (not counted)', router.navCalls[0] === '/news' && res.navigations === 2, res.navigations);
}

{
  const router = fakeRouter({ bothMount: true });
  const res = await dbg.runSoak(fakeDeps(router), ['/news', '/'], 5);
  check('soak: two mounts in an interleaved pair is a failure', res.failures.length === 1 && /interleaved/.test(res.failures[0].reason), res.failures);
}

{
  const router = fakeRouter();
  const deps = fakeDeps(router, { heap: () => null });
  let n = 0;
  deps.tracker = {
    reports: [{ kind: 'old' }], get requestsAfterLeave() { return n; },
    liveListeners: () => 7 + n
  };
  deps.interruptions = () => n;
  deps.navigate = (u) => router.navigate(u).then(() => {
    if (u === '/') { n += 1; deps.tracker.reports.push({ kind: 'listener', page: 'news' }); }
  });
  const res = await dbg.runSoak(deps, ['/news', '/'], 3);
  check('soak: counts only what happened during the soak', res.leaks.length === 3 && res.requestsAfterLeave === 3 &&
    res.listenerDelta === 3 && res.interruptions === 3 && res.heapDelta === null, res);
}

{
  const router = fakeRouter();
  let threw = null;
  try {
    await dbg.runSoak(fakeDeps(router, { isConverted: async (u) => u !== '/calendar' }), ['/news', '/calendar'], 1);
  } catch (e) { threw = e; }
  check('soak: refuses an unconverted page before navigating', threw && /\/calendar/.test(threw.message) && router.navCalls.length === 0);
  threw = null;
  try { await dbg.runSoak(fakeDeps(router), ['/news'], 1); } catch (e) { threw = e; }
  check('soak: needs at least one neighbour', !!threw);
}

{
  const router = fakeRouter();
  const deps = fakeDeps(router);
  deps.navigate = (u) => (u === '/' ? Promise.resolve() : router.navigate(u));   // a navigation that went nowhere
  const res = await dbg.runSoak(deps, ['/news', '/'], 1);
  check('soak: a navigation that did not mount its page is a failure', res.failures.length === 1, res.failures);
}

// ---- The test tone: 440 Hz, 8 kHz, 8-bit mono, one second, loops seamlessly ----

function toneWav() {
  const rate = 8000;
  const n = rate;                     // one second: exactly 440 whole cycles
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);           // fmt chunk size
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);         // byte rate
  buf.writeUInt16LE(1, 32);            // block align
  buf.writeUInt16LE(8, 34);            // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = Math.round(128 + 32 * Math.sin(2 * Math.PI * 440 * i / rate));
  return buf;
}
{
  const file = readFileSync(join(here, '../../static/media/debug-tone-440.wav'));
  check('tone: the file is the generated 440 Hz WAV', Buffer.compare(file, toneWav()) === 0, file.length);
  let rises = 0;
  for (let i = 45; i < file.length; i++) if (file[i - 1] < 128 && file[i] >= 128) rises += 1;
  check('tone: 440 cycles in one second', rises === 440 || rises === 439, rises);
}

console.log(`${total - failed}/${total} debug-tool cases pass`);
process.exit(failed ? 1 : 0);
