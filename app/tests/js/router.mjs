// The soft-navigation router's pure rules against the shared cases in
// app/tests/router_vectors.json: which link clicks it takes (qualifies) and
// what it does with a fetched page (decide). Runs router.js as it is, not a
// copy.
//
// router.js is an ES module in a folder with no package.json "type", so a
// Node without module-syntax detection would read it as CommonJS. Importing
// its source as a data: URL loads it as a module on any Node. Importing it
// also proves the module touches no DOM at import time: Node has none.
// Run: node app/tests/js/router.mjs (npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEventListeners } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../static/js/router.js'), 'utf8');
const { qualifies, decide, pageTitle, visitTimers } = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const vectors = JSON.parse(readFileSync(join(here, '../router_vectors.json'), 'utf8'));
const ATTRS = { target: null, download: false, hard: false, button: 0, meta: false, ctrl: false, shift: false, alt: false };

let failed = 0;
let total = 0;

for (const c of vectors.qualifies) {
  total += 1;
  const got = qualifies(c.href, c.base, { ...ATTRS, ...c.attrs });
  if (got !== c.expect) {
    failed += 1;
    console.error(`FAIL qualifies, ${c.why}: qualifies(${JSON.stringify(c.href)}, ${JSON.stringify(c.base)}, ` +
                  `${JSON.stringify(c.attrs)}) = ${JSON.stringify(got)}, expected ${c.expect}`);
  }
}

for (const c of vectors.decide) {
  total += 1;
  const got = decide(c.requested, c.response);
  if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
    failed += 1;
    console.error(`FAIL decide, ${c.why}: decide(${JSON.stringify(c.requested)}, ...) = ${JSON.stringify(got)}, ` +
                  `expected ${JSON.stringify(c.expect)}`);
  }
}

// A title for a view a page drew itself (a claimed navigation, the wiki's
// articles): the site's format, as pages.py page_title writes the server's.
for (const [name, site, expect, why] of [
  ['Nav test A', 'My Server', 'My Server - Nav test A', 'the site name, then the view'],
  ['Wiki', 'My Server', 'My Server - Wiki', 'the index reads as the page did'],
  ['Nav test A', '', 'Nav test A', 'no site name: the view alone, no dangling dash'],
  ['  Spaced  ', '  My Server ', 'My Server - Spaced', 'both trimmed'],
  ['', 'My Server', 'My Server', 'no view name: the site name alone'],
  [null, '', '', 'nothing at all']
]) {
  total += 1;
  const got = typeof pageTitle === 'function' ? pageTitle(name, site) : undefined;
  if (got !== expect) {
    failed += 1;
    console.error(`FAIL pageTitle, ${why}: pageTitle(${JSON.stringify(name)}, ${JSON.stringify(site)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`);
  }
}

// A page's one-off timers (ctx.setTimeout / ctx.clearTimeout): a debounce
// re-armed on every keystroke must leave nothing on the visit's signal, and
// every timer still pending ends with the visit.
function check(what, ok, detail) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL visitTimers, ${what}` + (detail === undefined ? '' : `: ${detail}`));
  }
}
if (typeof visitTimers !== 'function') {
  check('router.js exports visitTimers', false);
} else {
  const ctl = new AbortController();
  const t = visitTimers(ctl.signal);
  const aborts = () => getEventListeners(ctl.signal, 'abort').length;
  for (let i = 0; i < 1000; i++) t.clearTimeout(t.setTimeout(() => {}, 60000));
  check('1000 set and clear cycles leave no timer listener behind', aborts() <= 1, aborts());
  let fired = 0;
  t.setTimeout(() => { fired += 1; }, 5);
  await new Promise((r) => setTimeout(r, 30));
  check('a timer fires', fired === 1, fired);
  check('a fired timer leaves nothing behind', aborts() <= 1, aborts());
  let late = 0;
  t.setTimeout(() => { late += 1; }, 20);
  t.setTimeout(() => { late += 1; }, 20);
  ctl.abort();
  await new Promise((r) => setTimeout(r, 50));
  check('the visit ending clears every pending timer', late === 0, late);
  check('the signal holds nothing once aborted', aborts() === 0, aborts());
  check('an ended visit sets no timer', t.setTimeout(() => { late += 1; }, 1) === 0);
  // Cleared by the page: never fires.
  const c2 = new AbortController();
  const t2 = visitTimers(c2.signal);
  let cleared = 0;
  t2.clearTimeout(t2.setTimeout(() => { cleared += 1; }, 5));
  await new Promise((r) => setTimeout(r, 30));
  check('a cleared timer never fires', cleared === 0, cleared);
  c2.abort();
}

if (vectors.qualifies.length < 30 || vectors.decide.length < 9) {
  console.error('FAIL the shared cases are missing');
  failed += 1;
}
console.log(`${total - failed}/${total} router cases pass`);
process.exit(failed ? 1 : 0);
