// The Plex hand-back page (plex-callback.js) for both flows: in a popup it
// tells the page that opened it which flow finished, on this origin only;
// as a redirect it goes back to the login page with the matching query. Only
// for=access exactly is the request flow; anything else is the sign-in.
// Run: node app/tests/js/plex_callback.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '../../static/js/plex-callback.js'), 'utf8');

let failed = 0;
let total = 0;
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}

function run(url, popup) {
  const u = new URL(url);
  const posted = [];
  let closed = false;
  const location = { origin: u.origin, search: u.search, href: url };
  const win = { location, opener: popup ? { postMessage: (m, o) => posted.push({ m, o }) } : null,
                close() { closed = true; } };
  new Function('window', 'URLSearchParams', SRC)(win, URLSearchParams);
  return { posted, closed, href: location.href };
}

const PAGE = 'https://ws.test/auth/plex-callback-page';
const SIGN_IN = [PAGE, PAGE + '?for=ACCESS', PAGE + '?for=access2', PAGE + '?for=access%20', PAGE + '?x=for%3Daccess'];
for (const url of SIGN_IN) {
  const p = run(url, true);
  check(`${url}: popup says plex-auth-complete`, p.posted.length === 1 && p.posted[0].m.type === 'plex-auth-complete' &&
    p.posted[0].o === 'https://ws.test' && p.closed, p);
  const r = run(url, false);
  check(`${url}: redirect to sign-in`, r.href === '/login?plex_auth=complete', r.href);
}
const ACCESS = [PAGE + '?for=access', PAGE + '?for=access&x=1'];
for (const url of ACCESS) {
  const p = run(url, true);
  check(`${url}: popup says plex-access-complete`, p.posted.length === 1 && p.posted[0].m.type === 'plex-access-complete' &&
    p.posted[0].o === 'https://ws.test' && p.closed, p);
  const r = run(url, false);
  check(`${url}: redirect to the request card`, r.href === '/login?access_request=complete', r.href);
}

console.log(`${total - failed}/${total} plex callback cases pass`);
if (failed) process.exit(1);
