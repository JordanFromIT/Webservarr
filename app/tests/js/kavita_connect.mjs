// The Kavita hand-off helper (kavita-connect.js), run for real in happy-dom:
// one clock for the hand-off. A Books page's own address can send the browser
// to /kavita/connect from the server (connect_first), which never touches
// sessionStorage. When that trip fails the browser lands on ?kavita=error;
// that arrival must count as this minute's attempt, so a soft navigation to
// another Books page within the minute makes no second trip and shows the
// problem note instead. Outside the minute, or with no failure, one trip.
// Only the person's own click (Connect / Try again) makes an interactive trip
// (interactive=1: the identity provider may show its login page); the
// automatic one never does (the server adds prompt=none to it).
// Run: node app/tests/js/kavita_connect.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '../../static/js/kavita-connect.js'), 'utf8');
const KEY = 'ws:kavita-connect-at';

let failed = 0;
let total = 0;
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}

/* A document at `url` with the helper loaded once, trips recorded instead of
   taken. `stamp` presets the helper's sessionStorage clock. */
function load(url, stamp) {
  const w = new Window({ url });
  const trips = [];
  w.WS = { router: { hardNavigate: (u) => trips.push(u) } };
  if (stamp !== undefined) w.sessionStorage.setItem(KEY, String(stamp));
  w.eval(SRC);
  return { w, K: w.WSKavita, trips };
}

/* One page visit as the Books modules make it: mount (init, then read the
   failure flag), then the page's answer says not connected. */
function visit(K, problems) {
  K.init();
  K.arrivedFromFailedConnect();
  K.reconnect(() => problems.push(1));
}

// 1. The server started the trip (nothing in sessionStorage) and it failed.
{
  const { w, K, trips } = load('https://ws.test/books?kavita=error');
  const problems = [];
  visit(K, problems);
  check('failed arrival: no trip, the note shows', trips.length === 0 && problems.length === 1, { trips, problems });
  check('failed arrival: the flag leaves the address', w.location.search === '', w.location.search);
  const stamp = Number(w.sessionStorage.getItem(KEY));
  check('failed arrival: recorded as the last attempt', stamp > 0 && Math.abs(Date.now() - stamp) < 5000, stamp);

  // 10 s later: a soft navigation to another Books page, still not connected.
  w.history.replaceState(null, '', '/books/person?role=author&name=X');
  visit(K, problems);
  check('soft nav within the minute: no second trip', trips.length === 0, trips);
  check('soft nav within the minute: the note shows', problems.length === 2, problems);
  await w.happyDOM.close();
}

// 2. The script's own trip failed (its stamp is already set): the same answer.
{
  const { w, K, trips } = load('https://ws.test/books?kavita=error', Date.now() - 1000);
  const problems = [];
  visit(K, problems);
  w.history.replaceState(null, '', '/books/person?role=author&name=X');
  visit(K, problems);
  check('script trip failed: no trip on either visit', trips.length === 0 && problems.length === 2, { trips, problems });
  await w.happyDOM.close();
}

// 3. No failure and no recent attempt: one trip, back to this page.
{
  const { w, K, trips } = load('https://ws.test/books/7');
  const problems = [];
  visit(K, problems);
  check('first need: one trip to this page', trips.length === 1 &&
    trips[0] === '/kavita/connect?return=' + encodeURIComponent('/books/7') && problems.length === 0, { trips, problems });
  await w.happyDOM.close();
}

// 4. A failure over a minute ago: the next Books page may go again, once.
{
  const { w, K, trips } = load('https://ws.test/books/7', Date.now() - 61 * 1000);
  const problems = [];
  visit(K, problems);
  check('after the minute: one trip again', trips.length === 1 && problems.length === 0, { trips, problems });
  await w.happyDOM.close();
}

// 5. The click on Connect / Try again is interactive; the automatic trip is not.
{
  const { w, K, trips } = load('https://ws.test/books/7');
  K.init();
  K.retry();
  check('the button: one interactive trip to this page', trips.length === 1 &&
    trips[0] === '/kavita/connect?return=' + encodeURIComponent('/books/7') + '&interactive=1', trips);
  await w.happyDOM.close();
}
{
  const { w, K, trips } = load('https://ws.test/books/7');
  K.init();
  K.reconnect(() => {});
  check('the automatic trip is not interactive', trips.length === 1 && !/interactive/.test(trips[0]), trips);
  await w.happyDOM.close();
}

console.log(`${total - failed}/${total} kavita connect cases pass`);
if (failed) process.exit(1);
