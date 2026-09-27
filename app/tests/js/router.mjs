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

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../static/js/router.js'), 'utf8');
const { qualifies, decide } = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

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

if (vectors.qualifies.length < 30 || vectors.decide.length < 9) {
  console.error('FAIL the shared cases are missing');
  failed += 1;
}
console.log(`${total - failed}/${total} router cases pass`);
process.exit(failed ? 1 : 0);
