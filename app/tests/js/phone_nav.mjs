// The phone's More sheet (shell.js wireSheet), run for real in happy-dom over
// the shell partial's own markup (app/static/partials/shell-sidebar.html with
// its slots filled the way app/pages.py fills them). Covers: More opens the
// sheet as a modal dialog, says so (aria-expanded) and moves focus to the
// first row; it closes on the browser's close request (the dialog's cancel:
// Escape, Android's Back), Escape itself, a tap on the dim or on Close, a
// downward swipe, a row chosen, a page swap (WS.closeChrome) and the screen
// growing to the desktop layout; focus goes back to More; Tab stays inside;
// a short or upward swipe does not close it; and the bell's menu is told.
//
// SHELL_JS=<path> runs the same cases against another copy of shell.js.
// Run: node app/tests/js/phone_nav.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const SHELL = readFileSync(process.env.SHELL_JS || join(STATIC, 'js/shell.js'), 'utf8');
const PARTIAL = readFileSync(join(STATIC, 'partials/shell-sidebar.html'), 'utf8');

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

const TABS = [
  '<li><a class="ws-navtab" href="/" aria-current="page"><span class="ws-navtab-icon"><span class="material-symbols-outlined">home</span></span><span class="ws-navtab-label">Home</span></a></li>',
  '<li><a class="ws-navtab" href="/requests"><span class="ws-navtab-icon"><span class="material-symbols-outlined">movie</span></span><span class="ws-navtab-label">Requests</span></a></li>',
  '<li><button type="button" id="wsMoreBtn" class="ws-navtab" aria-haspopup="dialog" aria-expanded="false" aria-controls="wsMoreSheet"><span class="ws-navtab-icon"><span class="material-symbols-outlined">more_horiz</span></span><span class="ws-navtab-label">More</span></button></li>'
].join('\n');
const ROWS = [
  '<li><a class="ws-sheet-row" href="/wiki"><span class="ws-sheet-row-text"><span class="ws-sheet-row-label">Wiki</span></span></a></li>',
  '<li><a class="ws-sheet-row" href="/settings"><span class="ws-sheet-row-text"><span class="ws-sheet-row-label">Settings</span></span></a></li>'
].join('\n');

function markup() {
  const filled = PARTIAL
    .replace(/<script\b[^>]*><\/script>/g, '')
    .replace('{{{tab_links}}}', TABS)
    .replace('{{{more_links}}}', ROWS)
    .replace(/\{\{\{\w+\}\}\}/g, '')
    .replace(/\{\{admin_block\}\}/g, '')
    .replace(/\{\{\w+\}\}/g, 'x');
  return filled + '<main><div id="wsPage"><h1>Home</h1></div></main>';
}

async function boot({ width = 375, reduce = false } = {}) {
  const w = new Window({ url: 'https://dev.example.test/', width, height: 800 });
  if (reduce) {
    const real = w.matchMedia.bind(w);
    w.matchMedia = (q) => (q.indexOf('prefers-reduced-motion') !== -1 ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q));
  }
  w.document.body.innerHTML = markup();
  w.WS_DATA = { user: { username: 'sam', is_admin: false }, page: 'index' };
  const menus = [];
  w.document.addEventListener('ws:menu-open', (e) => menus.push(e.detail));
  w.eval(SHELL);
  await wait(0);
  const d = w.document;
  return {
    w, d, menus,
    sheet: d.getElementById('wsMoreSheet'),
    more: d.getElementById('wsMoreBtn'),
    panel: d.querySelector('[data-sheet-panel]'),
    close: async () => { await wait(260); },
    async done() { await w.happyDOM.close(); }
  };
}

function touch(el, type, y) {
  const ev = new el.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
  el.dispatchEvent(ev);
  return ev;
}

async function scenario(name, fn, opts) {
  current = name;
  const t = await boot(opts);
  try { await fn(t); } catch (e) { check('threw: ' + (e && e.stack || e), false); }
  await t.done();
}

await scenario('More opens the sheet', async ({ d, sheet, more, menus }) => {
  check('closed at first', !sheet.open);
  more.click();
  check('open', sheet.open);
  check('is-open', sheet.classList.contains('is-open'));
  check('aria-expanded', more.getAttribute('aria-expanded') === 'true');
  check('focus on the first row', d.activeElement && d.activeElement.getAttribute('href') === '/wiki',
        d.activeElement && d.activeElement.outerHTML.slice(0, 80));
  check('page scroll held', d.documentElement.classList.contains('ws-sheet-open'));
  check('the other menus were told', menus.indexOf(sheet) !== -1);
});

await scenario('the close request (Escape, Back) closes it and focus returns to More', async (t) => {
  t.more.click();
  const ev = new t.w.Event('cancel', { cancelable: true });
  t.sheet.dispatchEvent(ev);
  check('the native close is replaced by ours', ev.defaultPrevented);
  check('sliding away', !t.sheet.classList.contains('is-open'));
  await t.close();
  check('closed', !t.sheet.open);
  check('aria-expanded false', t.more.getAttribute('aria-expanded') === 'false');
  check('focus back on More', t.d.activeElement === t.more);
  check('page scroll released', !t.d.documentElement.classList.contains('ws-sheet-open'));
});

await scenario('Escape closes it', async (t) => {
  t.more.click();
  t.d.activeElement.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await t.close();
  check('closed', !t.sheet.open);
  check('focus back on More', t.d.activeElement === t.more);
});

await scenario('a tap on the dim, or Close, closes it', async (t) => {
  t.more.click();
  t.sheet.querySelector('.ws-sheet-scrim').click();
  await t.close();
  check('dim', !t.sheet.open);
  t.more.click();
  check('opens again', t.sheet.open && t.sheet.classList.contains('is-open'));
  t.sheet.querySelector('.ws-sheet-close').click();
  await t.close();
  check('Close', !t.sheet.open);
});

await scenario('reduced motion closes at once', async (t) => {
  t.more.click();
  t.sheet.querySelector('.ws-sheet-close').click();
  check('closed with no wait', !t.sheet.open);
}, { reduce: true });

await scenario('choosing a row closes it', async (t) => {
  t.more.click();
  const row = t.sheet.querySelector('a[href="/settings"]');
  row.addEventListener('click', (e) => e.preventDefault());   // no navigation in the test
  row.click();
  await t.close();
  check('closed', !t.sheet.open);
  check('focus is not pulled back to More (the new page takes it)', t.d.activeElement !== t.more);
});

await scenario('a page swap closes it at once', async (t) => {
  t.more.click();
  t.w.WS.closeChrome();
  check('closed', !t.sheet.open);
  check('aria-expanded false', t.more.getAttribute('aria-expanded') === 'false');
});

await scenario('Tab stays inside', async (t) => {
  t.more.click();
  const all = Array.from(t.sheet.querySelectorAll('a[href], button')).filter((el) => !el.closest('[hidden]') && !el.closest('.hidden'));
  const last = all[all.length - 1];
  last.focus();
  const fwd = new t.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  last.dispatchEvent(fwd);
  check('Tab on the last wraps', fwd.defaultPrevented && t.d.activeElement === all[0], t.d.activeElement && t.d.activeElement.outerHTML.slice(0, 60));
  const back = new t.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  all[0].dispatchEvent(back);
  check('Shift+Tab on the first wraps', back.defaultPrevented && t.d.activeElement === last);
});

await scenario('a downward swipe closes it; a short one springs back', async (t) => {
  t.more.click();
  touch(t.panel, 'touchstart', 300);
  const mv = touch(t.panel, 'touchmove', 320);
  check('the sheet follows the finger', /translateY\(20px\)/.test(t.panel.style.transform), t.panel.style.transform);
  check('the page does not scroll under it', mv.defaultPrevented);
  await wait(400);   // a slow, short drag
  touch(t.panel, 'touchmove', 330);
  touch(t.panel, 'touchend', 0);
  check('still open', t.sheet.open && t.sheet.classList.contains('is-open'));
  check('back in place', t.panel.style.transform === '');
  touch(t.panel, 'touchstart', 300);
  touch(t.panel, 'touchmove', 360);
  touch(t.panel, 'touchmove', 420);
  touch(t.panel, 'touchend', 0);
  await t.close();
  check('a long swipe closes it', !t.sheet.open);
  check('focus back on More', t.d.activeElement === t.more);
});

await scenario('an upward move is a scroll, not a swipe', async (t) => {
  t.more.click();
  touch(t.panel, 'touchstart', 300);
  const mv = touch(t.panel, 'touchmove', 250);
  check('not taken', !mv.defaultPrevented && t.panel.style.transform === '');
  touch(t.panel, 'touchmove', 400);
  touch(t.panel, 'touchend', 0);
  check('still open', t.sheet.open);
});

await scenario('growing to the desktop layout closes it', async (t) => {
  t.more.click();
  t.w.happyDOM.setViewport({ width: 1280, height: 800 });
  await wait(20);
  check('closed', !t.sheet.open);
});

await scenario('a More button replaced by a settings save still opens it', async (t) => {
  const li = t.more.closest('li');
  li.innerHTML = li.innerHTML;   // new nodes, as WS.applyShell writes them
  const fresh = t.d.getElementById('wsMoreBtn');
  check('a new node', fresh !== t.more);
  fresh.click();
  check('open', t.sheet.open);
  check('aria-expanded on the new node', fresh.getAttribute('aria-expanded') === 'true');
});

console.log(`phone_nav: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
