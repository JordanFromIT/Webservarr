// The Integrations tab's sameAddress() against the shared cases the server's
// same_address() is tested with (app/tests/same_address_vectors.json), so the
// two can't drift. Runs the function as it is in integrations.js, not a copy.
// Run: node app/tests/js/same_address.mjs (CI job js-checks; npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../static/js/settings/integrations.js'), 'utf8');
const start = src.indexOf('  // Python\'s str.strip() whitespace');
const fn = src.indexOf('  function sameAddress(');
const end = src.indexOf('\n  }\n', fn);
if (start < 0 || fn < 0 || end < 0) throw new Error('sameAddress() not found in integrations.js');
const sameAddress = new Function(src.slice(start, end + 4) + '\nreturn sameAddress;')();

const { cases } = JSON.parse(readFileSync(join(here, '../same_address_vectors.json'), 'utf8'));
let failed = 0;
for (const c of cases) {
  const got = sameAddress(c.a, c.b);
  const flipped = sameAddress(c.b, c.a);
  if (got !== c.same || flipped !== c.same) {
    failed += 1;
    console.error(`FAIL ${c.why}: sameAddress(${JSON.stringify(c.a)}, ${JSON.stringify(c.b)}) = ${got}` +
                  ` (flipped ${flipped}), the server says ${c.same}`);
  }
}
if (cases.length < 30) { console.error('FAIL the shared cases are missing'); failed += 1; }
console.log(`${cases.length - failed}/${cases.length} same_address cases agree with the server`);
process.exit(failed ? 1 : 0);
