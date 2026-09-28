// The shell's view-transition names are on only while the router's soft swap
// runs (theme-loader.js WSViewTransition, theme.css html.ws-vt). A named <main> is
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
  return { on: () => classes.has('ws-vt'), api: window.WSViewTransition, listeners };
}

// ---- nothing named at rest ----
{
  const t = load();
  check('the names are off after the script loads', !t.on());
  check('hold() is exposed for the router', typeof (t.api && t.api.hold) === 'function');
  // Full navigations have no cross-document transition to hold for.
  check('pageswap and pagereveal are not listened for',
    !(t.listeners.pageswap || []).length && !(t.listeners.pagereveal || []).length);
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

console.log(`${total - failed}/${total} view-transition cases pass`);
process.exit(failed ? 1 : 0);
