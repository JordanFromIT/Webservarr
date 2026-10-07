// The service status panel (status-panel.js) with the real shell.js, run in
// happy-dom over both shell partials (the header's pill, the top bar's chip).
// Covers: the pill and chip words for every state; hover opens after a pause
// and leaving closes it; a click pins it (Close shows, leaving does not
// close); Escape, a press outside and focus leaving close it and Escape
// gives focus back to the pill; the panel follows the pill in tab order;
// problems sort first and "slow" is a reply over 1 s and over 4x the usual;
// the uptime window switch changes the figures and is remembered per user;
// a badge that could not be read says "Not available"; Uptime Kuma not
// answering (503) is a grey "Status Unavailable" with the last names and
// "Try again", never "running"; and on a phone the chip opens the sheet,
// which closes on the browser's close request and gives focus back.
// Run: node app/tests/js/status_panel.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const SHELL = readFileSync(join(STATIC, 'js/shell.js'), 'utf8');
const PANEL = readFileSync(join(STATIC, 'js/status-panel.js'), 'utf8');
const HEADER = readFileSync(join(STATIC, 'partials/shell-header.html'), 'utf8');
const SIDEBAR = readFileSync(join(STATIC, 'partials/shell-sidebar.html'), 'utf8');

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

function fill(html) {
  return html
    .replace(/<script\b[^>]*><\/script>/g, '')
    .replace(/\{\{\{\w+\}\}\}/g, '')
    .replace(/\{\{admin_block\}\}/g, '')
    .replace(/\{\{\w+\}\}/g, 'x');
}

const NOW = Date.now();
function beats(n, { ping = 100, status = 'up', every = 20000, tail = [] } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ status, ping: status === 'down' ? null : ping, time: new Date(NOW - (n - 1 - i) * every).toISOString() });
  }
  tail.forEach((t, j) => { Object.assign(out[n - tail.length + j], t); });
  return out;
}
function svc(id, name, opts = {}) {
  return { id, name, status: opts.status || 'up', icon: '', beats: opts.beats || beats(50),
    uptime: opts.uptime || { '24h': 99.39, '30d': 99.72, all: 98.09 }, uptime_24h: 99.39 };
}
const ALL_UP = [svc(3, 'Media Server'), svc(4, 'Requests'), svc(5, 'Portal')];

async function boot({ width = 1440, answer = ALL_UP, stored = null, cached = null } = {}) {
  const w = new Window({ url: 'https://dev.example.test/', width, height: 900 });
  w.document.body.innerHTML = '<aside id="desktopSidebar"></aside>' + fill(HEADER) + fill(SIDEBAR) +
    '<main><div id="wsPage"><button id="elsewhere">Elsewhere</button></div></main>';
  w.WS_DATA = { user: { username: 'sam', is_admin: false }, page: 'index' };
  if (stored) w.localStorage.setItem('ws:sam:status-range', stored);
  if (cached) w.sessionStorage.setItem('ws:sam:status', JSON.stringify(cached));
  const calls = [];
  const state = { answer };
  w.fetch = (url) => {
    calls.push(url);
    const a = state.answer;
    if (a === 503) return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(a))) });
  };
  w.eval(SHELL);
  await wait(0);
  w.eval(PANEL);
  await wait(10);
  const d = w.document;
  return {
    w, d, calls, state,
    pill: d.getElementById('systemStatus'),
    chip: d.getElementById('wsStatusChip'),
    pop: () => d.getElementById('wsStatusPop'),
    sheet: () => d.getElementById('wsStatusSheet'),
    async done() { await w.happyDOM.close(); }
  };
}
function pointer(t, type, target) {
  target.dispatchEvent(new t.w.PointerEvent(type, { bubbles: type === 'pointerdown', pointerType: 'mouse' }));
}
function key(t, k) {
  t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
}
const open = (t) => t.pop().classList.contains('is-open');
const rows = (root) => Array.from(root.querySelectorAll('.ws-sp-row'));
const text = (n) => (n ? n.textContent : '');

// ---- Words for every state ----
{
  current = 'all up';
  const t = await boot();
  check('pill says all online', t.pill.getAttribute('data-state') === 'ok' && text(t.pill.querySelector('[data-status-text]')) === 'All Systems Online');
  check('chip says Online', t.chip.getAttribute('data-state') === 'ok' && text(t.chip.querySelector('[data-status-word]')) === 'Online');
  check('chip names it for screen readers', /Everything is running/.test(t.chip.getAttribute('aria-label')), t.chip.getAttribute('aria-label'));
  check('the pill is a button that controls the panel', t.pill.tagName === 'BUTTON' && t.pill.getAttribute('aria-controls') === 'wsStatusPop');
  await t.done();
}

{
  current = 'one down, one slow';
  const slow = svc(4, 'Requests', { beats: beats(50, { ping: 200, tail: [{ ping: 2400 }, { ping: 2600 }] }) });
  const down = svc(6, 'Remote', { status: 'down', beats: beats(50, { tail: [{ status: 'down', ping: null }, { status: 'down', ping: null }] }) });
  const t = await boot({ answer: [svc(3, 'Media Server'), slow, down] });
  check('pill is err', t.pill.getAttribute('data-state') === 'err');
  check('chip says 1 down', text(t.chip.querySelector('[data-status-word]')) === '1 down');
  t.pill.click();
  await wait(10);
  const r = rows(t.pop());
  check('problems first: down, then slow, then up', r.map((x) => x.getAttribute('data-k')).join() === 'down,slow,up', r.map((x) => x.getAttribute('data-k')));
  check('down row says how long', /^Down for \d+ min$/.test(text(r[0].querySelector('.ws-sp-state'))), text(r[0].querySelector('.ws-sp-state')));
  check('slow row says slow', /^Slow for \d+ min$/.test(text(r[1].querySelector('.ws-sp-state'))), text(r[1].querySelector('.ws-sp-state')));
  check('a down check has no reply', text(r[0].querySelector('.ws-sp-ms')) === 'No reply');
  check('50 bars per service', r[0].querySelectorAll('.ws-sp-strip i').length === 50);
  check('the reply line breaks at the down checks', r[0].querySelectorAll('.ws-sp-spark polyline').length === 1);
  check('summary names the down service', text(t.pop().querySelector('.ws-sp-title')) === 'Remote is down');
  check('and the slow one', /Requests is slow too\./.test(text(t.pop().querySelector('.ws-sp-sub'))));
  check('checked just now', text(t.pop().querySelector('.ws-sp-checked')) === 'Checked just now');
  await t.done();
}

{
  current = 'slow needs both rules';
  // 1.2 s against a usual 400 ms is not 4x: not slow. 900 ms against 100 is not over 1 s.
  const a = svc(1, 'A', { beats: beats(50, { ping: 400, tail: [{ ping: 1200 }] }) });
  const b = svc(2, 'B', { beats: beats(50, { ping: 100, tail: [{ ping: 900 }] }) });
  const c = svc(3, 'C', { beats: beats(50, { ping: 100, tail: [{ status: 'degraded', ping: 300 }] }) });
  const t = await boot({ answer: [a, b] });
  check('neither is slow', t.pill.getAttribute('data-state') === 'ok');
  t.state.answer = [a, b, c];
  await t.w.WS.serviceStatus({ fresh: true });
  check('pending is warn', t.pill.getAttribute('data-state') === 'warn' && text(t.chip.querySelector('[data-status-word]')) === 'Slow');
  t.pill.click();
  await wait(10);
  check('pending reads Having trouble', text(rows(t.pop())[0].querySelector('.ws-sp-state')) === 'Having trouble');
  await t.done();
}

// ---- Hover, pin, close ----
{
  current = 'hover';
  const t = await boot();
  pointer(t, 'pointerenter', t.pill);
  await wait(150);
  check('not before the pause', !open(t));
  await wait(120);
  check('opens after it', open(t) && t.pill.getAttribute('aria-expanded') === 'true');
  check('unpinned: no Close', t.pop().querySelector('.ws-sp-close').hidden === true);
  pointer(t, 'pointerleave', t.pill);
  pointer(t, 'pointerenter', t.pop());
  await wait(400);
  check('moving onto the panel keeps it', open(t));
  pointer(t, 'pointerleave', t.pop());
  await wait(400);
  check('leaving closes it', !open(t) && t.pill.getAttribute('aria-expanded') === 'false');
  pointer(t, 'pointerenter', t.pill);
  await wait(100);
  pointer(t, 'pointerleave', t.pill);
  await wait(300);
  check('a pass over the pill does not open it', !open(t));
  await t.done();
}

{
  current = 'click pins';
  const t = await boot();
  t.pill.focus();
  t.pill.click();          // Enter or Space on the button
  await wait(10);
  check('opens pinned', open(t) && t.pop().querySelector('.ws-sp-close').hidden === false);
  pointer(t, 'pointerleave', t.pill);
  await wait(400);
  check('leaving does not close a pinned panel', open(t));
  check('the panel follows the pill in tab order',
    !!(t.pill.compareDocumentPosition(t.pop()) & t.w.Node.DOCUMENT_POSITION_FOLLOWING));
  t.pop().querySelector('.ws-sp-seg-input').focus();
  key(t, 'Escape');
  check('Escape closes', !open(t));
  check('and gives focus back to the pill', t.d.activeElement === t.pill);
  t.pill.click();
  await wait(10);
  t.pill.click();
  check('a second click closes', !open(t));
  t.pill.click();
  await wait(10);
  t.pop().querySelector('.ws-sp-close').click();
  check('Close closes', !open(t) && t.d.activeElement === t.pill);
  t.pill.click();
  await wait(10);
  pointer(t, 'pointerdown', t.d.getElementById('elsewhere'));
  check('a press outside closes', !open(t));
  t.pill.click();
  await wait(10);
  t.d.getElementById('elsewhere').focus();
  check('focus leaving closes', !open(t));
  t.pill.click();
  await wait(10);
  t.d.dispatchEvent(new t.w.CustomEvent('ws:menu-open', { detail: null }));
  check('a page swap (closeChrome) closes', !open(t));
  await t.done();
}

// ---- The uptime window ----
{
  current = 'uptime window';
  const noBadge = svc(4, 'Requests', { uptime: { '24h': 99.46, '30d': null, all: null } });
  const t = await boot({ answer: [svc(3, 'Media Server'), noBadge] });
  t.pill.click();
  await wait(10);
  const pct = () => rows(t.pop()).map((r) => text(r.querySelector('.ws-sp-up')));
  check('24 hours by default', pct().join('|') === '99.4%past day|99.5%past day', pct());
  const r30 = t.pop().querySelector('input[value="30d"]');
  r30.checked = true;
  r30.dispatchEvent(new t.w.Event('change', { bubbles: true }));
  check('30 days', pct().join('|') === '99.7%past 30 days|Not availablepast 30 days', pct());
  check('remembered for this user', t.w.localStorage.getItem('ws:sam:status-range') === '30d');
  await t.done();

  const t2 = await boot({ stored: 'all', answer: [svc(3, 'Media Server')] });
  t2.pill.click();
  await wait(10);
  check('a later visit starts on the remembered window', t2.pop().querySelector('input[value="all"]').checked &&
    text(rows(t2.pop())[0].querySelector('.ws-sp-up')) === '98.1%all time');
  await t2.done();

  const t3 = await boot({ stored: 'junk' });
  t3.pill.click();
  await wait(10);
  check('a stored value it does not know is 24 hours', t3.pop().querySelector('input[value="24h"]').checked);
  await t3.done();
}

// ---- Uptime Kuma not answering ----
{
  current = 'unavailable';
  const t = await boot({ answer: 503, cached: { state: 'ok', down: 0, list: ALL_UP, t: NOW - 6 * 60000 } });
  check('pill is grey and says unavailable', t.pill.getAttribute('data-state') === 'off' &&
    text(t.pill.querySelector('[data-status-text]')) === 'Status Unavailable');
  check('chip says Unknown', text(t.chip.querySelector('[data-status-word]')) === 'Unknown');
  t.pill.click();
  await wait(10);
  const pop = t.pop();
  check('panel says unavailable', text(pop.querySelector('.ws-sp-title')) === 'Status unavailable right now');
  check('with the last answer time', /Last answer 6 min ago\./.test(text(pop.querySelector('.ws-sp-sub'))), text(pop.querySelector('.ws-sp-sub')));
  check('never says running', !/running/i.test(pop.textContent.replace('can’t say what is running', '')), pop.textContent);
  check('last names, no answer', rows(pop).length === 3 && rows(pop).every((r) => text(r.querySelector('.ws-sp-state')) === 'No answer'));
  check('no uptime window to pick', pop.querySelector('.ws-sp-range').hidden === true);
  const retry = pop.querySelector('.ws-sp-retry');
  check('Try again shows', retry.hidden === false);
  t.state.answer = ALL_UP;
  retry.click();
  await wait(20);
  check('Try again asks at once and recovers', t.calls.length === 2 && t.pill.getAttribute('data-state') === 'ok' &&
    text(pop.querySelector('.ws-sp-title')) === 'Everything is running');
  await t.done();

  current = 'unavailable on the next page';
  const t2 = await boot({ answer: 503 });
  const kept = JSON.parse(t2.w.sessionStorage.getItem('ws:sam:status'));
  check('kept as off, so the next page paints it grey at once', kept && kept.state === 'off');
  await t2.done();

  current = 'not set up';
  const t3 = await boot({ answer: [] });
  check('pill stays unknown (hidden)', t3.pill.getAttribute('data-state') === 'unknown');
  t3.pill.click();
  await wait(10);
  check('and opens nothing', !open(t3));
  await t3.done();
}

// ---- Phone sheet ----
{
  current = 'phone sheet';
  const t = await boot({ width: 375 });
  t.chip.focus();
  t.chip.click();
  await wait(10);
  const sheet = t.sheet();
  check('the chip opens the sheet', !!sheet && sheet.open && t.chip.getAttribute('aria-expanded') === 'true');
  check('as a dialog with a title', sheet.getAttribute('aria-labelledby') === 'wsStatusSheetHead');
  check('with the same rows', rows(sheet).length === 3);
  check('the popover stays closed', !open(t));
  sheet.dispatchEvent(new t.w.Event('cancel', { cancelable: true }));
  await wait(260);
  check('the close request closes it', !sheet.open && t.chip.getAttribute('aria-expanded') === 'false');
  check('focus back on the chip', t.d.activeElement === t.chip);
  t.chip.click();
  await wait(10);
  sheet.querySelector('.ws-sheet-scrim').click();
  await wait(260);
  check('a tap on the dim closes it', !sheet.open);
  await t.done();
}

// ---- Two columns, frosted, inside the window ----
{
  current = 'room to the right edge';
  const t = await boot();
  const at = { left: 600 };
  t.pill.getBoundingClientRect = () => ({ left: at.left, right: at.left + 200, top: 14, bottom: 50, width: 200, height: 36 });
  const cw = () => t.d.documentElement.clientWidth || t.w.innerWidth;
  const room = () => t.pop().style.getPropertyValue('--ws-sp-room');
  t.pill.click();
  await wait(10);
  check('opening measures the room from the pill to the edge, less a margin', room() === (cw() - 600 - 24) + 'px', { room: room(), cw: cw() });
  at.left = cw() - 100;
  t.w.dispatchEvent(new t.w.Event('resize'));
  check('a resize while open measures again, never under 320px', room() === '320px', room());
  t.pill.click();
  at.left = 300;
  t.w.dispatchEvent(new t.w.Event('resize'));
  check('a closed panel is left alone', room() === '320px', room());
  await t.done();
}

{
  current = 'panel styles';
  const css = readFileSync(join(STATIC, 'css/theme.css'), 'utf8');
  const rule = (sel) => {
    const at = css.indexOf('\n' + sel + ' {');
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };
  const frost = rule('.ws-sp-pop, .ws-sp-sheet .ws-sheet-panel');
  check('the popover and the sheet are frosted like the Books filters panel',
    /rgb\(var\(--color-secondary\) \/ \.25\)/.test(frost) && /rgb\(var\(--color-background\) \/ \.84\)/.test(frost) &&
    /\bbackdrop-filter: blur\(24px\) saturate\(1\.2\)/.test(frost) && /-webkit-backdrop-filter/.test(frost), frost);
  check('the header lets go of its own blur while the panel is open',
    /#appHeader:has\(\.ws-sp-pop\.is-open\) \{[^}]*backdrop-filter: none/.test(css));
  check('two services or more sit in two columns',
    /\.ws-sp-pop \.ws-sp-list:has\(\.ws-sp-row \+ \.ws-sp-row\) \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css));
  check('at most 760px wide and never past the room', /\.ws-sp-pop:has\(\.ws-sp-row \+ \.ws-sp-row\) \{ width: min\(760px, var\(--ws-sp-room/.test(css));
  check('the graphs sit in a well of the page colour', /background: rgb\(var\(--color-background\) \/ \.6\)/.test(rule('.ws-sp-graphs')), rule('.ws-sp-graphs'));
  check('the popover scrolls only past the window height', /max-height: calc\(100dvh - 96px\); overflow-y: auto/.test(rule('.ws-sp-pop')));
}

console.log(`${total - failed}/${total} status-panel cases pass`);
if (failed) process.exit(1);
