// The bell's unread count (notifications.js), run for real in happy-dom with
// the real shell.js under it:
//  * it is asked once at start, then every 30 s through the shared WS.poll,
//    never a bare setInterval of its own;
//  * a hidden (background) tab asks nothing; coming back asks at once;
//  * a second initNotifications() (the shell is not run again on a soft
//    navigation, but nothing else stops a caller) starts no second poll and
//    wires the bell once.
//
// Run: node app/tests/js/notifications_poll.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const SHELL = readFileSync(join(STATIC, 'js/shell.js'), 'utf8');
const NOTIFY = readFileSync(join(STATIC, 'js/notifications.js'), 'utf8');

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

const w = new Window({ url: 'https://dev.example.test/', width: 1440, height: 900 });
const d = w.document;
// One bell, no shell markup: shell.js then runs no chrome of its own and
// leaves initNotifications to the test.
d.body.innerHTML = '<button title="Notifications" aria-label="Notifications"></button>';
const intervals = [];
w.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
w.clearInterval = () => {};
let hidden = false;
Object.defineProperty(d, 'hidden', { configurable: true, get: () => hidden });
const asked = [];
w.fetch = (url) => {
  asked.push(String(url));
  const body = String(url).indexOf('/api/notifications/unread-count') === 0 ? { count: 2 } : [];
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};
w.WS_DATA = { user: { username: 'sam', is_admin: false }, page: 'index' };
w.eval(SHELL);
w.eval(NOTIFY);
const counts = () => asked.filter((u) => u.indexOf('/api/notifications/unread-count') === 0).length;

w.initNotifications();
await wait(20);
check('the count is asked once at start', counts() === 1, counts());
const polls = intervals.filter((i) => i.ms === 30000);
check('one 30 s poll', polls.length === 1, intervals.map((i) => i.ms));
check('no bare setInterval in notifications.js', !/\bsetInterval\(/.test(NOTIFY.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')));
check('it goes through WS.poll', /_pollStop = WS\.poll\(/.test(NOTIFY));

polls[0].fn();
await wait(10);
check('a tick on screen asks again', counts() === 2, counts());

hidden = true;
polls[0].fn();
polls[0].fn();
await wait(10);
check('a hidden tab asks nothing', counts() === 2, counts());

hidden = false;
d.dispatchEvent(new w.Event('visibilitychange'));
await wait(10);
check('coming back asks at once', counts() === 3, counts());

w.initNotifications();
await wait(20);
check('a second init starts no second poll', intervals.filter((i) => i.ms === 30000).length === 1, intervals.map((i) => i.ms));
check('and asks nothing more', counts() === 3, counts());
check('the bell carries one badge', d.querySelector('button[title="Notifications"]').querySelectorAll('span.absolute').length === 1);

await w.happyDOM.abort();
w.close();
console.log(`${total - failed}/${total} notification poll checks pass`);
if (failed) process.exit(1);
