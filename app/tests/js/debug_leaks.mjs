// The soft-navigation debug tools (spec 7) where they need no browser:
// debug-flag parsing (router.js), stack attribution, leak bookkeeping, the
// soak's schedule and result, and the test tone file. Runs the files as they
// are, not copies; like router.mjs, each module is imported from its source as
// a data: URL, which also proves neither touches the DOM at import time.
// Run: node app/tests/js/debug_leaks.mjs (CI job js-checks; npm run test:js).
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => import('data:text/javascript;charset=utf-8,' +
  encodeURIComponent(readFileSync(join(here, rel), 'utf8')));
const { debugFlags, takeFlag } = await load('../../static/js/router.js');
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

// ---- debugFlags(search, stored, admin) ----

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
  const got = debugFlags(search, stored, true);
  check('debugFlags, ' + why, eq(got, { flags, store }), got);
}

// Only an admin's tab honours them (final review M5): a link with
// ?ws-debug= sent to anyone else does nothing, and anything this tab had
// stored is cleared. Not saying who is asking is not an admin.
for (const [search, stored, admin, store, why] of [
  ['?ws-debug=leaks', null, false, '', 'a member asking is ignored, and nothing is kept'],
  ['?ws-debug=throw,leaks', 'leaks', false, '', 'a member with stored flags: they are cleared'],
  ['', 'leaks', false, '', 'stored flags from an admin before a sign-out do not carry over'],
  ['', null, false, null, 'a member with nothing asked or stored: nothing written'],
  ['?ws-debug=leaks', null, undefined, '', 'no answer about the visitor is not an admin'],
  ['?ws-debug=leaks', null, 'true', '', 'only a real true is an admin'],
]) {
  const got = debugFlags(search, stored, admin);
  check('debugFlags, ' + why, eq(got, { flags: [], store }), got);
}

// ---- takeFlag: the "throw" gate ----

{
  const none = [];
  const leaksOnly = ['leaks'];
  check('takeFlag: no flags, never taken', takeFlag(none, 'throw') === null && none.length === 0);
  check('takeFlag: other flags only, never taken, nothing changes',
    takeFlag(leaksOnly, 'throw') === null && takeFlag(leaksOnly, 'throw') === null && eq(leaksOnly, ['leaks']), leaksOnly);
  const both = ['leaks', 'throw'];
  const first = takeFlag(both, 'throw');
  check('takeFlag: taken once, the rest stored', first === 'leaks' && eq(both, ['leaks']), [first, both]);
  check('takeFlag: and never again', takeFlag(both, 'throw') === null && eq(both, ['leaks']));
  const only = ['throw'];
  const store = takeFlag(only, 'throw');
  check('takeFlag: the last flag taken clears the stored key', store === '' && only.length === 0, store);
  check('takeFlag: a reload after it no longer throws', eq(debugFlags('', null, true), { flags: [], store: null }) &&
    eq(debugFlags('', 'leaks', true), { flags: ['leaks'], store: null }));
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
check('owner: no site frame at all (console, DevTools) is nobody\'s page', eq(dbg.ownerOf(stack(SELF)), { page: null, shell: true }));
check('owner: another origin\'s frames (an extension) are ignored',
  eq(dbg.ownerOf(stack('chrome-extension://abc/content.js', SHELL), null, 'https://host.example'), { page: null, shell: true }) &&
  eq(dbg.ownerOf(stack('chrome-extension://abc/content.js'), null, 'https://host.example'), { page: null, shell: true }) &&
  eq(dbg.ownerOf(stack(HELPER), null, 'https://host.example'), { page: null, shell: false }));
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
const ORIG_THEN = Promise.prototype.then;
const ORIG_REMOVE = EventTarget.prototype.removeEventListener;
let fetchResolve = [];
const g = {
  EventTarget, AbortSignal, Promise,
  requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 1),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: function (url) {
    return new Promise((resolve, reject) => fetchResolve.push({ url, resolve, reject }));
  }
};
let nowStack = stack(SELF, PAGE);
// nowStack REAL: the real stack, as a browser gives it, without this test
// file's own frames (in the browser the stack is taken inside debug-leaks.js,
// whose frames are dropped the same way).
const REAL = Symbol('real stack');
const tr = dbg.createTracker(g, {
  stack: () => (nowStack === REAL
    ? new Error().stack.split('\n').filter((l) => !l.includes('debug_leaks.mjs')).join('\n')
    : nowStack)
});

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

// A helper the page calls from mount has the page's frame below it: the page's.
{
  tr.start('news');
  nowStack = stack(SELF, HELPER, PAGE);
  const t = new Target();
  t.addEventListener('x', () => {});
  const out = tr.stop();
  check('a helper called by the page: its listener is the page\'s', out.length === 1 && out[0].page === 'news', out);
}

// ui.js's own lifetimes are the shell's, even when a page called it: a toast
// schedules its dismissal (and its fade) inside ui.js, a dialog listens on
// document until it closes. Leaving within seconds of a toast is not a leak.
const UI = 'https://host.example/static/js/ui.js?v=abc';
{
  tr.stop();
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  const ctl = new AbortController();
  const btn = new Target();
  let fired = null;
  btn.addEventListener('click', () => {
    // A helper, from inside the page's own listener, shows a toast.
    nowStack = stack(SELF, UI, HELPER);
    fired = g.setTimeout(() => {}, 60000);                          // its dismissal
    new Target().addEventListener('click', () => {});               // its action button
  }, { signal: ctl.signal });
  nowStack = stack(SELF, UI, PAGE);                                 // the page shows one itself
  const dismiss = g.setTimeout(() => {}, 60000);
  const doc = new Target();
  const onKey = () => {};
  doc.addEventListener('keydown', onKey, true);                     // a dialog, still open
  nowStack = stack(SELF, PAGE);
  btn.dispatchEvent(new Event('click'));
  ctl.abort();
  const out = tr.stop();
  check('a toast or dialog the page opened is not its leak', out.length === 0 && fired !== null, out);
  // After the page left, a helper's toast with no page to name (a native
  // await continuation) is the shell's too: not listed as unattributed.
  nowStack = stack(SELF, OTHER);
  tr.start('wiki');
  const before = tr.reports.length;
  nowStack = stack(SELF, UI, HELPER);
  const late = g.setTimeout(() => {}, 60000);
  nowStack = stack(SELF, OTHER);
  const wikiOut = tr.stop();
  check('a toast after a leave, from code no page can be named for, is nobody\'s',
    wikiOut.length === 0 && tr.reports.length === before, tr.reports.slice(before));
  [fired, dismiss, late].forEach((id) => g.clearTimeout(id));
  doc.removeEventListener('keydown', onKey, true);
}

// The same with the real ui.js: run under its site address, and a toast
// shown from a page module's frame, then the page left at once.
{
  tr.stop();
  const made = [];
  const node = (tag) => ({
    tagName: tag.toUpperCase(), style: {}, parentNode: null, className: '', textContent: '',
    setAttribute() {}, appendChild(c) { c.parentNode = this; made.push(c); return c; },
    removeChild(c) { c.parentNode = null; }
  });
  const sandbox = {
    document: { createElement: node, body: node('body') },
    matchMedia: () => ({ matches: true }),
    setTimeout: (...a) => g.setTimeout(...a), clearTimeout: (id) => g.clearTimeout(id)
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(here, '../../static/js/ui.js'), 'utf8'), sandbox,
    { filename: 'https://host.example/static/js/ui.js' });
  vm.runInContext('function saved() { WSUI.toast("Saved", "ok"); WSUI.toast("Again", "ok"); }', sandbox,
    { filename: 'https://host.example/static/js/pages/news.js' });
  nowStack = REAL;
  tr.start('news');
  sandbox.saved();                                   // the first appends after 50 ms; both dismiss in 4 s
  const out = tr.stop();
  nowStack = stack(SELF, PAGE);
  check('the real ui.js: a toast shown just before leaving is not the page\'s leak', out.length === 0, out);
  await new Promise((r) => setTimeout(r, 80));
  check('the real ui.js: the toast still appears', made.some((n) => n.textContent === 'Saved'));
}

// A 'file#name' entry is matched on the frame's function name, in both
// stack formats: Chrome's "at Object.name (url)" and Firefox's "name@url".
// shell.js#serviceStatus stands in (WS.serviceStatus, called from a page's
// helper); the item it makes is the shell's, not the page's.
{
  tr.stop();
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  const ctl = new AbortController();
  const src = new Target();
  const KIT = 'https://host.example/static/js/settings/kit.js?v=abc';
  src.addEventListener('saved', () => {
    nowStack = ['Error', `    at ${SHELL}:430:9`, `    at Array.forEach (<anonymous>)`,
      `    at Object.serviceStatus (${SHELL}:432:21)`, `    at refresh (${KIT}:774:30)`].join('\n');
    new Target().addEventListener('mouseenter', () => {});
    nowStack = `f@${SHELL}:430:9\nserviceStatus@${SHELL}:432:21\nrefresh@${KIT}:774:30`;   // Firefox
    new Target().addEventListener('focus', () => {});
  }, { signal: ctl.signal });
  nowStack = stack(SELF, PAGE);
  src.dispatchEvent(new Event('saved'));
  ctl.abort();
  const out = tr.stop();
  check('a named shell function called from a page is not the page\'s leak', out.length === 0, out);
  // A shell helper that is not serviceStatus, called the same way, is still the page's.
  tr.start('news');
  nowStack = ['Error', `    at Object.poll (${SHELL}:120:5)`, `    at mount (${KIT}:500:7)`, `    at mount (${PAGE}:40:3)`].join('\n');
  const iv = g.setInterval(() => {}, 60000);
  nowStack = ['Error', `    at serviceStatusLater (${SHELL}:1:1)`, `    at mount (${PAGE}:40:3)`].join('\n');
  const t2 = g.setTimeout(() => {}, 60000);
  nowStack = stack(SELF, PAGE);
  const out2 = tr.stop();
  check('...but WS.poll, or a name that only looks like it, is', out2.length === 2, out2);
  g.clearInterval(iv);
  g.clearTimeout(t2);
}

// The service-status request (WS.serviceStatus) is shared with the header's
// pill: Home asks for it, never aborts it, and may leave while it is on its
// way. It is the shell's, not Home's; Home's own reads still are Home's.
{
  const HOME = 'https://host.example/static/js/pages/home.js?v=abc';
  tr.start('home');
  fetchResolve = [];
  nowStack = ['Error', `    at serviceStatus (${SHELL}:426:21)`, `    at swr (${SHELL}:214:12)`,
    `    at loadServices (${HOME}:600:19)`, `    at mount (${HOME}:900:40)`].join('\n');
  const shared = g.fetch('/api/integrations/service-status');
  nowStack = ['Error', `    at loadSystemStats (${HOME}:700:34)`, `    at mount (${HOME}:900:40)`].join('\n');
  const own = g.fetch('/api/integrations/system-stats');   // no signal: Home's leak
  nowStack = stack(SELF, PAGE);
  const out = tr.stop();
  check('serviceStatus called from a page is the shell\'s; the page\'s own fetch is not',
    out.length === 1 && out[0].kind === 'fetch' && out[0].page === 'home' && /system-stats/.test(out[0].detail), out);
  fetchResolve.forEach((f) => f.resolve('R'));
  await shared;
  await own;
}

// ...but only ui.js's own calls. A page that polls, sets a timer or listens
// itself, directly or through a helper or a shell helper (WS.poll, the
// router's ctx.setTimeout), is still charged, as is a helper ui.js calls back.
{
  tr.stop();
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  const ctl = new AbortController();
  const btn = new Target();
  let viaRouter = null;
  btn.addEventListener('click', () => {
    nowStack = stack(SELF, ROUTER, HELPER);                         // ctx.setTimeout from a helper's callback
    viaRouter = g.setTimeout(() => {}, 60000);
  }, { signal: ctl.signal });
  nowStack = stack(SELF, SHELL, HELPER, PAGE);                      // WS.poll, from a helper mount called
  const poll = g.setInterval(() => {}, 60000);
  nowStack = stack(SELF, HELPER, UI, PAGE);                         // a helper a toast's action ran
  const back = g.setTimeout(() => {}, 60000);
  nowStack = stack(SELF, HELPER, PAGE);
  new Target().addEventListener('resize', () => {});               // a helper's own listener, no signal
  nowStack = stack(SELF, PAGE);
  btn.dispatchEvent(new Event('click'));
  ctl.abort();
  const out = tr.stop();
  const kinds = out.map((i) => i.kind).sort();
  check('a page\'s own timers, polls and listeners are still its leaks, through helpers and the shell',
    eq(kinds, ['interval', 'listener', 'timer', 'timer']) && out.every((i) => i.page === 'news'), out);
  g.clearInterval(poll);
  [viaRouter, back].forEach((id) => g.clearTimeout(id));
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

// L1: a page's once listener is one real listener, and removing it before
// it fires leaves none behind.
{
  tr.stop();                                          // drop the liveListeners block's own items
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  const t = new Target();
  const h = () => {};
  t.addEventListener('click', h, { once: true });
  check('once: exactly one real listener while registered', getEventListeners(t, 'click').length === 1,
    getEventListeners(t, 'click').length);
  t.removeEventListener('click', h);
  check('once removed before it fires: no listener left', getEventListeners(t, 'click').length === 0,
    getEventListeners(t, 'click').length);
  let n = 0;
  t.addEventListener('k', () => { n += 1; }, { once: true });
  t.dispatchEvent(new Event('k'));
  t.dispatchEvent(new Event('k'));
  check('once fired: ran once, nothing left', n === 1 && getEventListeners(t, 'k').length === 0);
  nowStack = stack(SELF, SHELL);
  const s = () => {};
  t.addEventListener('s', s, { once: true });
  const shellCount = getEventListeners(t, 's').length;
  t.removeEventListener('s', s);
  check('a shell once listener: one real listener, none after remove', shellCount === 1 && getEventListeners(t, 's').length === 0);
  nowStack = stack(SELF, PAGE);
  // A page's listener added twice is one listener, as without the tracker.
  let d = 0;
  const dh = () => { d += 1; };
  t.addEventListener('dup', dh);
  t.addEventListener('dup', dh);
  t.dispatchEvent(new Event('dup'));
  check('a page listener added twice runs once', d === 1 && getEventListeners(t, 'dup').length === 1);
  t.removeEventListener('dup', dh);
  check('and its own function removes it', getEventListeners(t, 'dup').length === 0);
  const l1 = tr.stop();
  check('L1 checks leave nothing alive', l1.length === 0, l1);
}

// L2: ownership rides callbacks. A page helper's work that runs after the
// page was left, from a stack that names no page, is still that page's.
{
  const later = [];
  nowStack = stack(SELF, HELPER, PAGE);               // news calls a helper
  tr.start('news');
  const before = tr.requestsAfterLeave;
  let fired;
  const ran = new Promise((r) => { fired = r; });
  g.setTimeout(() => {                                // the helper's debounced work
    g.fetch('/api/news-later').catch(() => {});
    later.push(g.setTimeout(() => {}, 60000));
    fired();
  }, 20);
  const doc = new Target();
  doc.addEventListener('ping', () => { g.fetch('/api/ping').catch(() => {}); });   // no signal
  fetchResolve = [];
  const chain = g.fetch('/api/first');
  chain.then((r) => r).then(() => { later.push(g.setTimeout(() => {}, 60000)); }).catch(() => {});
  chain.finally(() => { later.push(g.setTimeout(() => {}, 60000)); }).catch(() => {});
  const newsOut = tr.stop();                          // news left
  nowStack = stack(SELF, OTHER);
  tr.start('wiki');
  nowStack = stack(SELF, HELPER);                     // later callbacks' stacks name no page
  fetchResolve[0].resolve('R');
  await ran;
  doc.dispatchEvent(new Event('ping'));
  await tick();
  nowStack = stack(SELF, OTHER);
  const wikiOut = tr.stop();
  check('L2: news is charged with its pending timer, listener and fetch at leave',
    eq(newsOut.map((i) => i.kind).sort(), ['fetch', 'listener', 'timer']) && newsOut.every((i) => i.page === 'news'), newsOut);
  check('L2: nothing is blamed on wiki', wikiOut.every((i) => i.page === 'news' && i.late), wikiOut);
  check('L2: the late work is news\'s (2 fetches, 3 timers)',
    eq(wikiOut.map((i) => i.kind).sort(), ['fetch', 'fetch', 'timer', 'timer', 'timer']), wikiOut.map((i) => i.kind));
  check('L2: requestsAfterLeave counts both late fetches', tr.requestsAfterLeave === before + 2, tr.requestsAfterLeave - before);
  later.forEach((id) => g.clearTimeout(id));
}

// Round 2: Promise aggregates. news fetches twice and joins them from mount;
// the join's callback runs after news left, from a stack naming no page.
for (const agg of ['all', 'allSettled', 'race', 'any']) {
  tr.stop();
  nowStack = stack(SELF, HELPER, PAGE);
  tr.start('news');
  const before = tr.requestsAfterLeave;
  fetchResolve = [];
  const f1 = g.fetch('/api/a');
  const f2 = g.fetch('/api/b');
  let fired;
  const ran = new Promise((r) => { fired = r; });
  Promise[agg]([f1, f2]).then(() => {
    g.fetch('/api/after-' + agg).catch(() => {});
    fired();
  });
  tr.stop();                                          // news left (its two fetches are its leaks)
  nowStack = stack(SELF, OTHER);
  tr.start('wiki');
  nowStack = stack(SELF, HELPER);
  fetchResolve[0].resolve('A');
  fetchResolve[1].resolve('B');
  await ran;
  nowStack = stack(SELF, OTHER);
  const out = tr.stop();
  check('Promise.' + agg + ': the joined callback\'s fetch is news\'s, late',
    out.length === 1 && out[0].page === 'news' && out[0].late && out[0].kind === 'fetch', out);
  check('Promise.' + agg + ': counted in requestsAfterLeave', tr.requestsAfterLeave === before + 1, tr.requestsAfterLeave - before);
}

// Round 2: a plain promise chain and .catch / .finally registered by the page.
{
  tr.stop();
  nowStack = stack(SELF, HELPER, PAGE);
  tr.start('news');
  let go;
  const gate = new Promise((r) => { go = r; });
  let done;
  const ran = new Promise((r) => { done = r; });
  gate.then(() => { throw new Error('x'); }).catch(() => { g.fetch('/api/caught').catch(() => {}); })
    .finally(() => { g.fetch('/api/finally').catch(() => {}); done(); });
  tr.stop();
  nowStack = stack(SELF, OTHER);
  tr.start('wiki');
  nowStack = stack(SELF, HELPER);
  go();
  await ran;
  nowStack = stack(SELF, OTHER);
  const out = tr.stop();
  check('then/catch/finally carry the page', out.length === 2 && out.every((i) => i.page === 'news' && i.late), out);
}

// Round 2: requestAnimationFrame carries the page.
{
  tr.stop();
  nowStack = stack(SELF, HELPER, PAGE);
  tr.start('news');
  let done;
  const ran = new Promise((r) => { done = r; });
  const id = g.requestAnimationFrame(function (ts) {
    g.fetch('/api/frame').catch(() => {});
    done(typeof ts);
  });
  check('rAF returns the real id', typeof id === 'number' || (id && typeof id.hasRef === 'function'));
  tr.stop();
  nowStack = stack(SELF, OTHER);
  tr.start('wiki');
  nowStack = stack(SELF, HELPER);
  const tsType = await ran;
  nowStack = stack(SELF, OTHER);
  const out = tr.stop();
  check('rAF: the frame callback\'s fetch is news\'s, late', tsType === 'number' && out.length === 1 && out[0].page === 'news' && out[0].late, out);
}

// Round 2: work no page can be named for is 'unattributed', never another page's.
{
  tr.stop();
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  tr.stop();
  nowStack = stack(SELF, OTHER);
  tr.start('wiki');
  const before = tr.requestsAfterLeave;
  nowStack = stack(SELF, HELPER);                     // e.g. after a native await in a helper
  g.fetch('/api/who').catch(() => {});
  const t = g.setTimeout(() => {}, 60000);
  new Target().addEventListener('z', () => {});
  nowStack = stack(SELF, OTHER);
  const out = tr.stop();
  check('unknown owner: listed as unattributed, with its stack',
    out.length === 3 && out.every((i) => i.page === 'unattributed' && i.unattributed && i.afterLeave && /news-editor\.js/.test(i.stack)), out);
  check('unknown owner: never charged to wiki or news', out.every((i) => i.page !== 'wiki' && i.page !== 'news'));
  check('unknown owner: not a request after leave of any page', tr.requestsAfterLeave === before);
  g.clearTimeout(t);
}

// Before any page has mounted, nothing is unattributed (an unconverted page).
{
  const g3 = { EventTarget: class extends EventTarget {}, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => new Promise(() => {}) };
  const tr3 = dbg.createTracker(g3, { stack: () => stack(SELF, HELPER) });
  g3.fetch('/x');
  const id = g3.setTimeout(() => {}, 60000);
  check('no page mounted yet: inline and helper work is not listed', tr3.stop().length === 0);
  g3.clearTimeout(id);
  tr3.uninstall();
}

// A callback of the shell stays the shell's even while a page is mounted.
{
  nowStack = stack(SELF, SHELL);
  const t = new Target();
  const sh = () => { g.setTimeout(() => {}, 0); };
  t.addEventListener('tick', sh);
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  nowStack = stack(SELF, SHELL);
  t.dispatchEvent(new Event('tick'));
  nowStack = stack(SELF, PAGE);
  check('a shell listener firing during a page creates nothing of the page\'s', tr.stop().length === 0);
  t.removeEventListener('tick', sh);
}

// T1: a listener released only by its signal (the target is never told, as
// in a browser) is not alive.
{
  class FakeTarget { addEventListener() {} removeEventListener() {} }
  const g2 = { EventTarget: FakeTarget, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval };
  const tr2 = dbg.createTracker(g2, { stack: () => stack(SELF, PAGE) });
  tr2.start('news');
  const ctl = new AbortController();
  new FakeTarget().addEventListener('x', () => {}, { signal: ctl.signal });
  const kept = new FakeTarget();
  kept.addEventListener('y', () => {});
  ctl.abort();
  const out = tr2.stop();
  check('T1: the signal alone releases a listener', out.length === 1 && /^y on /.test(out[0].detail), out);
  tr2.uninstall();
}

// uninstall: a page listener registered through its wrapper keeps working as itself.
{
  nowStack = stack(SELF, PAGE);
  tr.start('news');
  const t = new Target();
  let n = 0;
  const h = () => { n += 1; };
  t.addEventListener('u', h);
  tr.stop();
  tr.uninstall();
  t.dispatchEvent(new Event('u'));
  const listed = getEventListeners(t, 'u');
  t.removeEventListener('u', h);
  check('uninstall re-registers a page listener as itself', n === 1 && listed.length === 1 && listed[0] === h &&
    getEventListeners(t, 'u').length === 0, listed.length);
}

tr.uninstall();
check('uninstall restores the originals', g.setTimeout === setTimeout && g.clearInterval === clearInterval &&
  Promise.prototype.then === ORIG_THEN &&
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
    ['failures', 'heapDelta', 'interleaved', 'interruptions', 'leaks', 'listenerDelta', 'navigations', 'note', 'requestsAfterLeave', 'tonePlaying'].sort()), Object.keys(res));
  check('soak: the note names the await gap for testers', /await/.test(res.note) && /unattributed/.test(res.note));
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
  const deps = fakeDeps(router);
  deps.navigate = (u) => router.navigate(u).then(() => {
    if (u === '/') deps.tracker.reports.push({ kind: 'fetch', page: 'unattributed', unattributed: true, afterLeave: true, detail: 'fetch /x', stack: 'at h (x.js:1:1)' });
  });
  const res = await dbg.runSoak(deps, ['/news', '/'], 2);
  check('soak: unattributed work after a leave is listed and fails the soak',
    res.leaks.filter((i) => i.page === 'unattributed').length === 2 &&
    res.failures.length === 2 && res.failures.every((f) => /unattributed/.test(f.reason) && f.stack), res.failures);
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

// A page that draws some URLs itself (the wiki): the router only records
// history, at once, and says so with ws:page-claimed instead of a mount.
function claimingRouter(owns) {
  const r = fakeRouter();
  r.claims = [];
  const mount = r.navigate;
  r.navigate = (u) => {
    if (owns(r.url) && owns(u)) {
      r.navCalls.push(u);
      r.token += 1;           // a claim wins over a navigation still in flight
      r.url = u;
      r.claims.push(u);
      return Promise.resolve();
    }
    return mount(u);
  };
  return r;
}

{
  const wiki = (u) => u === '/wiki' || u.startsWith('/wiki/');
  const router = claimingRouter(wiki);
  router.url = '/wiki';
  const res = await dbg.runSoak(fakeDeps(router, { claims: router.claims }), ['/wiki', '/wiki/a', '/news'], 10);
  check('soak: a claimed navigation ends where it was asked to', res.failures.length === 0, res.failures);
  check('soak: claims and mounts both happened', router.claims.length > 0 && router.mounts.length > 0,
    [router.claims.length, router.mounts.length]);
}

{
  // Claimed, but somewhere else: still a failure.
  const router = claimingRouter((u) => u.startsWith('/wiki'));
  const deps = fakeDeps(router, { claims: router.claims });
  deps.navigate = (u) => router.navigate(u === '/wiki/a' ? '/wiki/b' : u);
  router.url = '/wiki';
  const res = await dbg.runSoak(deps, ['/wiki', '/wiki/a'], 1);
  check('soak: a claim that ended on another URL is a failure', res.failures.length === 1, res.failures);
}

{
  // Without claims (no deps.claims), a navigation that only claimed did not mount.
  const router = claimingRouter((u) => u.startsWith('/wiki'));
  router.url = '/wiki';
  const res = await dbg.runSoak(fakeDeps(router), ['/wiki', '/wiki/a'], 1);
  check('soak: a claim is counted only when claims are given', res.failures.length === 2, res.failures);
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
