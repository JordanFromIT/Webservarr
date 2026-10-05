// Home's news cards: renderNewsCard (pages/home.js) against the shared cases
// the server's copy (app/home_news.py) is tested with
// (app/tests/news_card_vectors.json), so the cards the server writes into
// the page are exactly the ones the script writes over them and the two
// can't drift. Runs the functions as they are in home.js, not a copy, over
// happy-dom (newsExcerpt reads text through a DOM node).
// Run: node app/tests/js/news_cards.mjs (CI job js-checks; npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const home = readFileSync(join(here, '../../static/js/pages/home.js'), 'utf8');
const auth = readFileSync(join(here, '../../static/js/auth.js'), 'utf8');

function slice(src, from, to, what) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(what + ' not found');
  return src.slice(a, b);
}
const newsSrc = slice(home, 'const NEWS_FRESH_MS', '\nfunction toggleNewsCard(', 'renderNewsCard and its helpers in home.js');
const escSrc = slice(auth, 'function escapeHtml(', '\n}\n', 'escapeHtml in auth.js') + '\n}\n';

const V = JSON.parse(readFileSync(join(here, '../news_card_vectors.json'), 'utf8'));

// The cases' clock, and the date past a week in en-US and UTC, the way the
// server writes it (a browser writes it in its own language and zone).
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(V.now_ms); }
  static now() { return V.now_ms; }
  toLocaleDateString(_locale, opts) { return super.toLocaleDateString('en-US', Object.assign({}, opts, { timeZone: 'UTC' })); }
}

const window = new Window();
const fns = new Function('document', 'Date', escSrc + newsSrc +
  '\nreturn { renderNewsCard: renderNewsCard, NEWS_EMPTY_HTML: NEWS_EMPTY_HTML };')(window.document, FixedDate);

let failed = 0;
let total = 0;
function check(why, got, want) {
  total += 1;
  if (got !== want) {
    failed += 1;
    let i = 0;
    while (i < got.length && got[i] === want[i]) i += 1;
    console.error(`FAIL ${why}: differs at ${i}\n  js:     ${JSON.stringify(got.slice(Math.max(0, i - 40), i + 60))}\n  server: ${JSON.stringify(want.slice(Math.max(0, i - 40), i + 60))}`);
  }
}

for (const c of V.cases) check(c.why, fns.renderNewsCard(c.post, false), c.html);
// renderNews: the first `count` posts as cards, or the empty state.
for (const l of V.lists) {
  const got = l.posts.length ? l.posts.slice(0, l.count).map((p) => fns.renderNewsCard(p, false)).join('') : fns.NEWS_EMPTY_HTML;
  check(l.why, got, l.html);
}
check('the empty state', fns.NEWS_EMPTY_HTML, V.empty_html);
if (V.cases.length < 15 || V.lists.length < 5) { console.error('FAIL the shared cases are missing'); failed += 1; }

await window.happyDOM.abort();
window.close();
console.log(`${total - failed}/${total} news card cases agree with the server`);
process.exit(failed ? 1 : 0);
