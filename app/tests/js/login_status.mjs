// The login page's one status line (login.js, under the card), run for real
// in happy-dom over login.html: every answer of the public
// /api/integrations/status-summary gets the header pill's words in sentence
// case and its data-state. "All systems online" only for "online"; a down
// service is named, else "System issues detected"; Uptime Kuma not answering,
// an error status or a failed request is "Status unavailable", never online.
// Run: node app/tests/js/login_status.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const LOGIN_JS = readFileSync(join(STATIC, 'js/login.js'), 'utf8');
const LOGIN_HTML = readFileSync(join(STATIC, 'login.html'), 'utf8');

let failed = 0;
let total = 0;
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* The page's body without its scripts, login.js run as the page runs it, and
   the summary request answered with `answer` (an object for a 200, a number
   for that status, 'throw' for a failed request). Everything else 404s. */
async function line(answer) {
  const w = new Window({ url: 'https://dev.example.test/login', width: 1440, height: 900 });
  const body = LOGIN_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script\b[^>]*><\/script>/g, '');
  w.document.body.innerHTML = body;
  w.fetch = (url) => {
    if (String(url).indexOf('/api/integrations/status-summary') === 0) {
      if (answer === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
      if (typeof answer === 'number') return Promise.resolve({ ok: false, status: answer, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
  w.eval(LOGIN_JS);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await wait(20);
  const badge = w.document.getElementById('loginSystemStatus');
  const out = { state: badge.getAttribute('data-state'), text: badge.querySelector('[data-status-text]').textContent };
  await w.happyDOM.abort();
  w.close();
  return out;
}

const CASES = [
  ['all up', { status: 'online', down_service: null }, 'ok', 'All systems online'],
  ['one down, named', { status: 'issues', down_service: 'Media Server' }, 'err', 'Media Server is down'],
  ['one down, blank name', { status: 'issues', down_service: '  ' }, 'err', 'System issues detected'],
  ['one down, no name', { status: 'issues', down_service: null }, 'err', 'System issues detected'],
  ['degraded', { status: 'degraded', down_service: null }, 'warn', 'Degraded performance'],
  ['Uptime Kuma not answering', { status: 'unknown', down_service: null }, 'off', 'Status unavailable'],
  ['an error status', 503, 'off', 'Status unavailable'],
  ['a failed request', 'throw', 'off', 'Status unavailable']
];

for (const [what, answer, state, text] of CASES) {
  const got = await line(answer);
  check(`${what}: reads "${text}"`, got.text === text && got.state === state, got);
}

// The badge holds the room of its longest words from the first paint (as the
// header pill's slot does): a hidden copy of its box stacks every fixed line
// login.js can say plus the first one, and the badge fills that slot.
{
  const w = new Window({ url: 'https://dev.example.test/login' });
  w.document.body.innerHTML = LOGIN_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script\b[^>]*><\/script>/g, '');
  const badge = w.document.getElementById('loginSystemStatus');
  const slot = badge.parentElement;
  const ghost = slot.querySelector('.ws-pill-ghost');
  check('the badge sits in a .ws-pill-slot over a hidden ghost', slot.classList.contains('ws-pill-slot') && !!ghost &&
    ghost.getAttribute('aria-hidden') === 'true' && ghost.nextElementSibling === badge);
  const held = ghost ? Array.from(ghost.querySelectorAll('.ws-pill-words > span')).map((s) => s.textContent).sort() : [];
  const said = [badge.querySelector('[data-status-text]').textContent]
    .concat(CASES.map((c) => c[3]).filter((t) => !/ is down$/.test(t)));
  const want = Array.from(new Set(said)).sort();
  check('the ghost holds exactly the first line and every fixed line', JSON.stringify(held) === JSON.stringify(want), { held, want });
  const type = (el) => (el ? el.className.split(/\s+/).filter((c) => /^(text-label|font-)/.test(c)).join(' ') : '');
  check('the ghost words are set in the badge\'s own size and weight',
    !!ghost && type(ghost.querySelector('.ws-pill-words')) === type(badge.querySelector('[data-status-text]')));
  const box = (el) => (el ? el.className.split(/\s+/).filter((c) => /^(px-|py-|gap-|border$|rounded-)/.test(c)).sort().join(' ') : '');
  check('the ghost has the badge\'s padding, gap and border', box(ghost) === box(badge), [box(ghost), box(badge)]);
  const THEME = readFileSync(join(STATIC, 'css/theme.css'), 'utf8');
  check('the badge fills its slot and centres its words',
    /#loginSystemStatus \{ justify-self: stretch; justify-content: center; \}/.test(THEME));
  await w.happyDOM.abort();
  w.close();
}

console.log(`${total - failed}/${total} login status cases pass`);
if (failed) process.exit(1);
