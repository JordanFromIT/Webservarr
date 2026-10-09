// The Material Symbols icons notifications.js builds are never read aloud,
// run for real in happy-dom: an icon is a font ligature whose text is its
// name, so a screen reader would say "notifications_active" before the words
// beside it. Covers the bell it makes when the page has none, the panel's
// rows and its empty state, and the settings dialog (its category rows, the
// push row and Close). Every icon is aria-hidden, itself or through an
// ancestor, and a button holding only an icon keeps a name (aria-label).
// The status panel and the router's error state are held to the same in
// status_panel.mjs and router_runtime.mjs; test_shell_icons.py scans every
// script's source.
// Run: node app/tests/js/script_icons.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const NOTIFY = readFileSync(join(here, '../../static/js/notifications.js'), 'utf8');

let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${current}: ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* The icons under root a screen reader would read, by their ligature. */
function spoken(root) {
  return Array.from(root.querySelectorAll('.material-symbols-outlined'))
    .filter((i) => !i.closest('[aria-hidden="true"]'))
    .map((i) => i.textContent);
}

/* Buttons and links that hold an icon and have no name without it. */
function nameless(root) {
  return Array.from(root.querySelectorAll('button, a')).filter((c) => {
    if (!c.querySelector('.material-symbols-outlined')) return false;
    if ((c.getAttribute('aria-label') || '').trim()) return false;
    const copy = c.cloneNode(true);
    copy.querySelectorAll('.material-symbols-outlined, [aria-hidden="true"]').forEach((n) => n.remove());
    return !copy.textContent.trim();
  }).map((c) => c.outerHTML.slice(0, 80));
}

const ITEMS = [
  { id: 1, category: 'request', title: 'Dune is ready', body: 'Your request is in the library.', read: false, created_at: '2026-10-07T10:00:00Z' },
  { id: 2, category: 'status', title: 'Media is back', body: '', read: true, created_at: '2026-10-07T09:00:00Z' },
  { id: 3, category: 'mystery', title: 'Something new', body: 'An unknown category.', read: false, created_at: '2026-10-07T08:00:00Z' }
];

/* A page with an account menu and no bell (notifications.js makes one),
   push available, and the notifications API answering `list`. */
async function boot(list) {
  const w = new Window({ url: 'https://dev.example.test/', width: 1440, height: 900 });
  w.document.body.innerHTML =
    '<header><div class="flex items-center"><div class="relative"><button id="userMenuBtn" type="button">Sam</button></div></div></header>';
  w.WS = {
    popOpen(el) { el.classList.remove('hidden'); el.classList.add('is-open'); },
    popClose(el) { el.classList.remove('is-open'); el.classList.add('hidden'); },
    // shell.js's visibility-aware interval: the unread count's 30 s poll.
    poll() { return function () {}; }
  };
  w.WS_DATA = { branding: { features: {} }, user: { username: 'sam' } };
  w.getTimeAgo = () => '5m ago';
  const reg = { pushManager: { getSubscription: () => Promise.resolve(null) } };
  Object.defineProperty(w.navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg), register: () => Promise.resolve(reg) }, configurable: true });
  w.PushManager = function PushManager() {};
  w.Notification = { permission: 'default', requestPermission: () => Promise.resolve('default') };
  w.fetch = (url) => {
    const u = String(url);
    let body = {};
    if (u.indexOf('/api/notifications/unread-count') === 0) body = { count: 2 };
    else if (u.indexOf('/api/notifications?') === 0) body = { notifications: list };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w.console.error = () => {};
  w.eval(NOTIFY);
  w.initNotifications();
  await wait(10);
  return w;
}

{
  current = 'the bell it makes';
  const w = await boot(ITEMS);
  const bell = w.document.querySelector('button[title="Notifications"]');
  check('a bell was made', !!bell);
  check('its icon is hidden', bell && spoken(bell).length === 0, bell && spoken(bell));
  check('and it is named', bell && bell.getAttribute('aria-label') === 'Notifications');

  current = 'the panel with notifications';
  bell.click();
  await wait(20);
  const rows = w.document.querySelectorAll('.cursor-pointer.border-b');
  check('the rows are there', rows.length === ITEMS.length, rows.length);
  check('no row icon is read out', spoken(w.document.body).length === 0, spoken(w.document.body));
  check('every control has a name', nameless(w.document.body).length === 0, nameless(w.document.body));

  current = 'the settings dialog';
  const prefs = Array.from(w.document.querySelectorAll('button')).find((b) => b.textContent === 'Notification settings');
  prefs.click();
  await wait(20);
  check('the push row is there', !!w.document.getElementById('pushToggle'));
  const icons = w.document.querySelectorAll('.material-symbols-outlined');
  check('category, push and Close icons were drawn', icons.length >= 8, icons.length);
  check('none is read out', spoken(w.document.body).length === 0, spoken(w.document.body));
  check('Close is named', nameless(w.document.body).length === 0, nameless(w.document.body));
  w.close();
}

{
  current = 'the empty panel';
  const w = await boot([]);
  w.document.querySelector('button[title="Notifications"]').click();
  await wait(20);
  check('the empty state shows', /No notifications/.test(w.document.body.textContent));
  check('its icon is hidden', spoken(w.document.body).length === 0, spoken(w.document.body));
  w.close();
}

console.log(`${total - failed}/${total} script icon cases pass`);
// notifications.js polls every 30 s; exit rather than wait on its timer.
process.exit(failed ? 1 : 0);
