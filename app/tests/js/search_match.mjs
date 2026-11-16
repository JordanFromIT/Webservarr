// The browser's search matcher (app/static/js/search-match.js, the Requests
// page's "Find a title" filter) held to the shared cases in
// search_match_vectors.json, which test_search_match.py holds the server's
// matcher (app/services/search_match.py, Books and wiki search) to.
// Run: node app/tests/js/search_match.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '../../static/js/search-match.js'), 'utf8');
const VECTORS = JSON.parse(readFileSync(join(here, '../search_match_vectors.json'), 'utf8'));

const win = {};
new Function('window', SRC)(win);
const { matches } = win.WSSearch;

let failed = 0;
let total = 0;
for (const c of VECTORS.cases) {
  total += 1;
  const got = matches(c.query, c.text);
  if (got !== c.match) {
    failed += 1;
    console.error(`FAIL ${JSON.stringify(c.query)} against ${JSON.stringify(c.text)}: got ${got}, want ${c.match}`);
  }
}
if (failed) {
  console.error(`${failed} of ${total} checks failed`);
  process.exit(1);
}
console.log(`${total}/${total} checks passed`);
