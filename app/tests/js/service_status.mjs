// WS.serviceStatus (shell.js): one service-status request shared by the
// header pill and Home's tiles, its answer reused for 5 s after it lands.
// That window is timed on the monotonic clock, so a wall clock that jumps
// back (an NTP resync on wake, a manual change) cannot keep a stale answer.
// Runs the real shell.js in a vm with a fake document, fetch and both clocks.
// Run: node app/tests/js/service_status.mjs (CI job js-checks; npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '../../static/js/shell.js'), 'utf8');

let failed = 0;
let total = 0;
function check(name, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error('FAIL ' + name + (info === undefined ? '' : ': ' + JSON.stringify(info)));
  }
}
const tick = () => new Promise((r) => setImmediate(r));

function boot() {
  const clock = { wall: Date.UTC(2026, 8, 28, 12), mono: 1000 };
  const calls = [];
  const FakeDate = function () { return new Date(clock.wall); };
  FakeDate.now = () => clock.wall;
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, WeakMap, Math,
    // Each answer is announced (ws:status, for the status panel).
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : null; } },
    Date: FakeDate,
    performance: { now: () => clock.mono },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
    document: {
      readyState: 'complete', prerendering: false,
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, dispatchEvent() {}
    },
    fetch: (url) => { calls.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve([{ status: 'up' }]) }); }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { WS: ctx.WS, clock, calls };
}

{
  const { WS, clock, calls } = boot();
  const first = WS.serviceStatus();
  check('one request while one is on its way', WS.serviceStatus() === first && calls.length === 1, calls);
  await first;
  await tick();
  clock.wall += 1000; clock.mono += 1000;
  WS.serviceStatus();
  check('the answer is reused within 5 s', calls.length === 1, calls);
  clock.wall += 5000; clock.mono += 5000;
  await WS.serviceStatus();
  check('and asked again after 5 s', calls.length === 2, calls);
}

{
  const { WS, clock, calls } = boot();
  await WS.serviceStatus();
  await tick();
  // The wall clock jumps back an hour; 6 s really pass.
  clock.wall -= 3600 * 1000; clock.mono += 6000;
  await WS.serviceStatus();
  check('a wall clock set back does not keep a stale answer', calls.length === 2, calls);
}

{
  const { WS, clock, calls } = boot();
  await WS.serviceStatus();
  await tick();
  // The wall clock jumps forward an hour; 1 s really passes.
  clock.wall += 3600 * 1000; clock.mono += 1000;
  WS.serviceStatus();
  check('a wall clock set forward does not drop a fresh answer', calls.length === 1, calls);
}

console.log(`${total - failed}/${total} service-status cases pass`);
if (failed) process.exit(1);
