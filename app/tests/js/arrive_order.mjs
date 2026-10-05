// WS.arrive (shell.js): sections reveal top-down as they are laid out, which
// is document order except where a breakpoint places a section out of it.
// Home writes News before Service Health for the phone's single column, and
// from lg the grid puts Service Health first with Recent Requests and News
// side by side under it. A section that is not displayed keeps its place.
// Runs the real shell.js in a vm with a fake document whose sections report
// the boxes a browser would lay out.
// Run: node app/tests/js/arrive_order.mjs (CI job js-checks; npm run test:js).
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

// One section: its key and its box, or null when it is not displayed.
function section(key, box, arrived) {
  return {
    arrived: !!arrived,
    getAttribute: (name) => (name === 'data-arrive' ? key : null),
    getClientRects: () => (box ? [box] : []),
    getBoundingClientRect: () => box || { top: 0, left: 0 }
  };
}

// The order the writes run in when the sections answer in `calls` order
// (default: all at once, last first).
function arrivalOrder(sections, calls) {
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, WeakMap, Math, Date,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
    document: {
      readyState: 'complete', prerendering: false,
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: (sel) => (sel === '[data-arrive]' ? sections
        : sel === '[data-arrive][data-arrived]' ? sections.filter((s) => s.arrived) : []),
      addEventListener() {}, dispatchEvent() {}
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.WS.arriveReset();
  const ran = [];
  const keys = calls || sections.map((s) => s.getAttribute('data-arrive')).reverse();
  keys.forEach((k) => ctx.WS.arrive(k, () => ran.push(k)));
  return ran;
}

// Home on a phone: one column, in document order.
{
  const ran = arrivalOrder([
    section('continue', null),
    section('feed', { top: 73, left: 16 }),
    section('news', { top: 237, left: 16 }),
    section('services', { top: 477, left: 16 }),
    section('requests', { top: 695, left: 16 }),
    section('streams', { top: 1494, left: 16 }),
    section('releases', { top: 1849, left: 16 })
  ]);
  check('a phone: News, then Service Health, then Recent Requests',
    ran.join() === 'continue,feed,news,services,requests,streams,releases', ran);
}

// Home from lg: the same document, Service Health first, then the row.
{
  const ran = arrivalOrder([
    section('continue', null),
    section('feed', { top: 96, left: 288 }),
    section('news', { top: 401, left: 861 }),
    section('services', { top: 260, left: 288 }),
    section('requests', { top: 401, left: 288 }),
    section('streams', { top: 1044, left: 288 }),
    section('releases', { top: 1436, left: 288 })
  ]);
  check('from lg: Service Health, then Recent Requests and News left to right',
    ran.join() === 'continue,feed,services,requests,news,streams,releases', ran);
}

// A rounding difference of under half a pixel is the same row.
{
  const ran = arrivalOrder([
    section('news', { top: 401.4, left: 861 }),
    section('requests', { top: 400.6, left: 288 })
  ]);
  check('sections on one row go left to right', ran.join() === 'requests,news', ran);
}

// A section that is not displayed keeps its document place among the others.
{
  const ran = arrivalOrder([
    section('feed', { top: 96, left: 288 }),
    section('news', { top: 401, left: 861 }),
    section('services', null),
    section('requests', { top: 260, left: 288 })
  ]);
  check('an undisplayed section keeps its place', ran.join() === 'feed,requests,services,news', ran);
}

// A section the server wrote in full (data-arrived) was there at the first
// paint: nothing below waits for it, and its own write runs when it comes.
{
  const ran = arrivalOrder([
    section('feed', { top: 73, left: 16 }),
    section('news', { top: 237, left: 16 }, true),
    section('services', { top: 477, left: 16 })
  ], ['services', 'feed', 'news']);
  check('Service Health does not wait for News the server wrote', ran.join() === 'feed,services,news', ran);
}

// With no layout at all (a document not yet laid out), document order.
{
  const ran = arrivalOrder([section('a', null), section('b', null), section('c', null)]);
  check('no layout: document order', ran.join() === 'a,b,c', ran);
}

if (failed) {
  console.error(failed + ' of ' + total + ' checks failed');
  process.exit(1);
}
console.log('arrive_order: ' + total + ' checks passed');
