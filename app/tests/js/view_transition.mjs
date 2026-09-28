// The shell's view-transition names are on only while a transition runs
// (theme-loader.js WSViewTransition, theme.css html.ws-vt). A named <main> is
// a stacking context, so a name left on would put every fixed page overlay
// under the phone's top bar. Runs theme-loader.js as it is, in a bare context
// with just enough of a window and document for it to load.
// Run: node app/tests/js/view_transition.mjs (npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../static/js/theme-loader.js'), 'utf8');

let failed = 0;
let total = 0;
function check(name, ok) {
  total += 1;
  if (!ok) { failed += 1; console.error('FAIL ' + name); }
}
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function load() {
  const classes = new Set();
  const listeners = {};
  const documentElement = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    style: { setProperty() {} },
  };
  const document = {
    documentElement,
    readyState: 'loading',
    title: '',
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {},
  };
  const window = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const ctx = { window, document, Promise, Math, JSON, fetch: () => new Promise(() => {}) };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const fire = (type, e) => (listeners[type] || []).forEach((fn) => fn(e));
  return { on: () => classes.has('ws-vt'), fire, api: window.WSViewTransition, listeners };
}

// ---- nothing named at rest ----
{
  const t = load();
  check('the names are off after the script loads', !t.on());
  check('hold() is exposed for the router', typeof (t.api && t.api.hold) === 'function');
  check('pageswap and pagereveal are both listened for',
    (t.listeners.pageswap || []).length === 1 && (t.listeners.pagereveal || []).length === 1);
}

// ---- a soft swap: hold, release ----
{
  const t = load();
  const release = t.api.hold();
  check('hold() turns the names on', t.on());
  release();
  check('release() turns them off', !t.on());
  const again = t.api.hold();
  release();
  check('a second release of the same hold changes nothing', t.on());
  again();
  check('...and the other hold still ends it', !t.on());
}

// ---- overlapping holds: the last release ends it ----
{
  const t = load();
  const a = t.api.hold();
  const b = t.api.hold();
  a();
  check('one of two holds released: still on', t.on());
  b();
  check('both released: off', !t.on());
}

// ---- a full navigation: the new document ----
{
  const t = load();
  const finished = deferred();
  t.fire('pagereveal', { viewTransition: { finished: finished.promise } });
  check('pagereveal with a transition turns the names on', t.on());
  finished.resolve();
  await tick();
  check('...and its finish turns them off', !t.on());
}

// ---- a full navigation that is skipped or fails still clears ----
{
  const t = load();
  const finished = deferred();
  t.fire('pagereveal', { viewTransition: { finished: finished.promise } });
  finished.reject(new Error('aborted'));
  await tick();
  check('a rejected finish turns them off too', !t.on());
}

// ---- the old document ----
{
  const t = load();
  const finished = deferred();
  t.fire('pageswap', { viewTransition: { finished: finished.promise } });
  check('pageswap with a transition turns the names on before the snapshot', t.on());
  finished.resolve();
  await tick();
  check('...and its finish turns them off (a page kept in the back/forward cache)', !t.on());
}

// ---- no transition, no names ----
{
  const t = load();
  t.fire('pageswap', { viewTransition: null });
  t.fire('pagereveal', { viewTransition: null });
  check('no transition (reduced motion, Firefox, first load): the names stay off', !t.on());
}

// ---- a page restored mid-transition from the back/forward cache ----
{
  const t = load();
  t.fire('pageswap', { viewTransition: { finished: new Promise(() => {}) } });
  check('left mid-transition: on', t.on());
  t.fire('pagereveal', { viewTransition: null });
  check('restored with no transition running: off', !t.on());
}

// ---- a soft swap that starts while a full navigation's reveal is running ----
{
  const t = load();
  const reveal = deferred();
  t.fire('pagereveal', { viewTransition: { finished: reveal.promise } });
  const release = t.api.hold();
  reveal.resolve();   // startViewTransition skips the running one
  await tick();
  check('the reveal ending does not take the soft swap\'s names', t.on());
  release();
  check('the soft swap ending does', !t.on());
}

console.log(`${total - failed}/${total} view-transition cases pass`);
process.exit(failed ? 1 : 0);
