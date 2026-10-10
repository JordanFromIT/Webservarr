// The service status panel (status-panel.js) with the real shell.js, run in
// happy-dom over both shell partials (the header's pill, the top bar's chip).
// Covers: the pill and chip words for every state; the pill's slot holding
// the room of its longest words from the first paint; hover opens after a pause
// and leaving closes it; a click pins it (Close shows, leaving does not
// close); Escape, a press outside and focus leaving close it and Escape
// gives focus back to the pill; the panel follows the pill in tab order;
// problems sort first and "slow" is a reply over 1 s and over 4x the usual;
// the uptime window switch changes the figures and is remembered per user;
// a badge that could not be read says "Not available"; Uptime Kuma not
// answering (503) is a grey "Status Unavailable" with the last names and
// "Try again", never "running"; and on a phone the chip opens the sheet,
// which closes on the browser's close request and gives focus back. Live
// while open: asked again every 15 s only while open and the tab is shown,
// new checks slide into the strips (or just show under reduced motion), the
// rows are updated in place, the words tick, Uptime Kuma going away and
// coming back while open swaps the state without closing, and a closed
// panel asks nothing. The account menu beside it (shell.js wireChrome): its
// button's aria-expanded follows it, and Escape closes it with focus back on
// the button.
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

async function boot({ width = 1440, answer = ALL_UP, stored = null, cached = null, reduce = false } = {}) {
  const w = new Window({ url: 'https://dev.example.test/', width, height: 900 });
  // The panel's two polls (15 s ask, 5 s words) are driven by hand; the
  // monotonic and wall clocks can be moved on (the 5 s answer reuse, "N min ago").
  const iv = new Map();
  let ivId = 1e6;
  const realSI = w.setInterval.bind(w), realCI = w.clearInterval.bind(w);
  w.setInterval = (fn, ms, ...a) => {
    if (ms !== 15000 && ms !== 5000) return realSI(fn, ms, ...a);
    iv.set(++ivId, { fn, ms });
    return ivId;
  };
  w.clearInterval = (id) => { if (iv.has(id)) iv.delete(id); else realCI(id); };
  const clock = { mono: 0, wall: 0, hidden: false };
  const realNow = w.performance.now.bind(w.performance);
  w.performance.now = () => realNow() + clock.mono;
  const realDateNow = w.Date.now;
  w.Date.now = () => realDateNow() + clock.wall;
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => clock.hidden });
  const realMM = w.matchMedia.bind(w);
  w.matchMedia = (q) => (/reduce/.test(q) ? { matches: reduce, media: q, addEventListener() {}, addListener() {} } : realMM(q));
  // Bars laid out 6px apart, 4px wide (happy-dom has no layout), so a slide has a pitch.
  const realRect = w.HTMLElement.prototype.getBoundingClientRect;
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const tr = this.parentNode;
    if (this.tagName === 'I' && tr && tr.classList && tr.classList.contains('ws-sp-track')) {
      const i = Array.prototype.indexOf.call(tr.children, this);
      return { left: i * 6, right: i * 6 + 4, width: 4, top: 0, bottom: 20, height: 20, x: i * 6, y: 0 };
    }
    return realRect.call(this);
  };
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
    w, d, calls, state, clock,
    polls: (ms) => Array.from(iv.values()).filter((x) => x.ms === ms).length,
    // One tick of the panel's polls; the 15 s one after the 5 s reuse has passed.
    async tick(ms) {
      if (ms === 15000) clock.mono += 15000;
      Array.from(iv.values()).filter((x) => x.ms === ms).forEach((x) => x.fn());
      await wait(5);
    },
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
  current = 'the pill holds the room of its longest words';
  // A first visit has no state yet for about the time the status takes: the
  // room the pill takes then is what it takes for every state, so neither the
  // status landing nor a turn to longer words moves the gauges beside it.
  const t = await boot();
  const said = (SHELL.match(/var PILL_LABEL = \{([\s\S]*?)\};/) || ['', ''])[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  const slot = t.pill.parentElement;
  const ghost = slot.querySelector(':scope > .ws-pill-ghost');
  const held = ghost ? Array.from(ghost.querySelectorAll('.ws-pill-words > span')).map(text) : [];
  check('the pill sits in a slot', slot.classList.contains('ws-pill-slot'));
  check('beside it, every word the pill can say', held.length === said.length && said.every((s) => held.indexOf(s) !== -1), { said, held });
  check('...hidden from screen readers, with no id or focus', !!ghost && ghost.getAttribute('aria-hidden') === 'true' &&
    !ghost.id && !ghost.querySelector('[id], button, a, [tabindex], [data-status-text]'));
  const classes = (el) => (el ? el.className.split(/\s+/) : []);
  check('...in the pill\'s own box', classes(t.pill).every((c) => classes(ghost).indexOf(c) !== -1), classes(ghost));
  const words = ghost && ghost.querySelector('.ws-pill-words');
  const label = t.pill.querySelector('[data-status-text]');
  check('...and its words\' type', classes(label).filter((c) => /^(text-xs|font-|uppercase|tracking-)/.test(c))
    .every((c) => classes(words).indexOf(c) !== -1), classes(words));
  const css = readFileSync(join(STATIC, 'css/theme.css'), 'utf8');
  check('the slot stacks the pill on the words it holds room for', /\.ws-pill-slot \{ display: grid;[^}]*\}/.test(css) &&
    /\.ws-pill-slot > \* \{ grid-area: 1 \/ 1; \}/.test(css));
  check('the held words share one cell and paint nothing', /\.ws-pill-words \{ display: grid; \}/.test(css) &&
    /\.ws-pill-words > span \{ grid-area: 1 \/ 1; \}/.test(css) && /\.ws-pill-ghost \{ visibility: hidden; \}/.test(css));
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
  const spoken = Array.from(t.pop().querySelectorAll('.material-symbols-outlined'))
    .filter((i) => !i.closest('[aria-hidden="true"]')).map((i) => text(i));
  check('no icon in the panel is read out', spoken.length === 0, spoken);
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

// ---- The account menu ----
{
  current = 'account menu';
  const t = await boot();
  const btn = t.d.getElementById('userMenuBtn');
  const menu = t.d.getElementById('userMenuDropdown');
  const isOpen = () => menu.classList.contains('is-open');
  check('closed, the button says so and names its menu', btn.getAttribute('aria-expanded') === 'false' &&
    btn.getAttribute('aria-controls') === 'userMenuDropdown' && !isOpen());
  btn.focus();
  btn.click();
  check('a press opens it and the button says expanded', isOpen() && btn.getAttribute('aria-expanded') === 'true');
  key(t, 'Escape');
  check('Escape closes it', !isOpen() && btn.getAttribute('aria-expanded') === 'false');
  check('focus is on the button', t.d.activeElement === btn);
  btn.click();
  const item = menu.querySelector('[data-logout]');
  item.focus();
  key(t, 'Escape');
  check('Escape from inside the menu closes it and gives focus back to the button',
    !isOpen() && btn.getAttribute('aria-expanded') === 'false' && t.d.activeElement === btn);
  btn.click();
  btn.click();
  check('a second press closes it and the button says so', !isOpen() && btn.getAttribute('aria-expanded') === 'false');
  btn.click();
  t.d.getElementById('elsewhere').click();
  check('a press outside closes it and the button says so', !isOpen() && btn.getAttribute('aria-expanded') === 'false');
  btn.click();
  t.d.dispatchEvent(new t.w.CustomEvent('ws:menu-open', { detail: null }));
  check('a page swap (closeChrome) closes it and the button says so', !isOpen() && btn.getAttribute('aria-expanded') === 'false');
  const other = t.d.getElementById('elsewhere');
  btn.click();
  other.focus();
  key(t, 'Escape');
  check('Escape with focus elsewhere on the page closes it and leaves the focus be', !isOpen() && t.d.activeElement === other);
  key(t, 'Escape');
  check('Escape with it closed changes nothing', btn.getAttribute('aria-expanded') === 'false' && t.d.activeElement === other);
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

  // Only a true 100 reads 100: near it the figure is cut at two places, never rounded up.
  const near = [100, 99.995, 99.9999, 99.97, 99.949].map((v, i) => svc(10 + i, 'Near ' + i, { uptime: { '24h': v, '30d': v, all: v } }));
  const t4 = await boot({ answer: near });
  t4.pill.click();
  await wait(10);
  const got = rows(t4.pop()).map((r) => text(r.querySelector('.ws-sp-pct'))).sort();
  check('100 is 100%, 99.995 and 99.9999 are 99.99%, 99.97 stays, 99.949 is 99.9%',
    got.join('|') === ['100%', '99.99%', '99.99%', '99.97%', '99.9%'].sort().join('|'), got);
  check('never 100.00%', !got.includes('100.00%') && !got.includes('100.0%'), got);
  await t4.done();
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
  check('on the shared frosted surface', sheet.querySelector('.ws-sheet-panel').classList.contains('ws-frost'));
  {
    const panel = sheet.querySelector('.ws-sheet-panel'), head = sheet.querySelector('.ws-sheet-head');
    const scrollTo = (y) => { panel.scrollTop = y; panel.dispatchEvent(new t.w.Event('scroll')); };
    check('the head is part of the pane at the top', !head.classList.contains('is-stuck'));
    scrollTo(40);
    check('and frosts once rows scroll under it', head.classList.contains('is-stuck'));
    scrollTo(0);
    check('and lets go back at the top', !head.classList.contains('is-stuck'));
  }
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

// ---- Live while open ----
// The next answer: every service two checks on (the oldest two drop off),
// the newest of them as given.
function onward(list, newest = {}) {
  return list.map((s) => {
    const b = s.beats.slice(2);
    const last = Date.parse(s.beats[s.beats.length - 1].time);
    b.push({ status: 'up', ping: 110, time: new Date(last + 20000).toISOString() });
    b.push(Object.assign({ status: 'up', ping: 120, time: new Date(last + 40000).toISOString() }, newest[s.id] || {}));
    return Object.assign({}, s, { beats: b });
  });
}
{
  current = 'live: asks only while open';
  const t = await boot();
  check('closed: no poll is running', t.polls(15000) === 0 && t.polls(5000) === 0);
  const before = t.calls.length;
  t.pill.click();
  await wait(10);
  check('open: asks every 15 s and keeps the words current every 5 s', t.polls(15000) === 1 && t.polls(5000) === 1);
  await t.tick(15000);
  check('a tick asks again', t.calls.length === before + 1, t.calls.length - before);
  t.clock.hidden = true;
  await t.tick(15000);
  check('a background tab asks nothing', t.calls.length === before + 1, t.calls.length - before);
  t.clock.hidden = false;
  t.clock.mono += 15000;
  t.d.dispatchEvent(new t.w.Event('visibilitychange'));
  await wait(5);
  check('and asks at once on coming back', t.calls.length === before + 2, t.calls.length - before);
  t.pill.click();
  check('closed again: the polls stop', t.polls(15000) === 0 && t.polls(5000) === 0);
  t.clock.mono += 60000;
  await wait(20);
  check('and nothing more is asked', t.calls.length === before + 2, t.calls.length - before);
  await t.done();
}
{
  current = 'live: new checks slide in';
  const t = await boot();
  t.pill.click();
  await wait(10);
  const row0 = rows(t.pop())[0];
  const track = row0.querySelector('.ws-sp-track');
  const firstBar = track.children[2];
  t.state.answer = onward(ALL_UP, { 3: { status: 'down', ping: null } });
  await t.tick(15000);
  const r = rows(t.pop());
  check('the rows are the same elements, updated in place', r.includes(row0));
  const down = r.find((x) => x.getAttribute('data-k') === 'down');
  check('a service that went down moves to the top', down === r[0] && text(r[0].querySelector('.ws-sp-name')) === 'Media Server', r.map((x) => text(x.querySelector('.ws-sp-name'))));
  check('the pill follows the same answer', t.pill.getAttribute('data-state') === 'err');
  const tr = r[0].querySelector('.ws-sp-track');
  check('while it slides the two new checks sit past the right edge', tr.children.length === 52 && tr.style.width === (52 * 6 - 2) + 'px', [tr.children.length, tr.style.width]);
  await wait(60);
  check('the strip is moving left', /^translateX\(-\d/.test(tr.style.transform) && tr.children.length === 52, tr.style.transform);
  check('the reply line is clipped to its box while it moves', r[0].querySelector('.ws-sp-spark').style.clipPath === 'inset(-4px 0)');
  await wait(420);
  check('after the slide: 50 bars again, at rest', tr.children.length === 50 && tr.style.transform === '' && tr.style.width === '', [tr.children.length, tr.style.transform]);
  check('the oldest two dropped off the left', tr.children[0] === firstBar);
  check('the newest bar is the down check', tr.lastElementChild.getAttribute('data-k') === 'down');
  check('the strip names the new check', /1 down/.test(r[0].querySelector('.ws-sp-strip').getAttribute('aria-label')));
  check('the reply line is unclipped at rest', r[0].querySelector('.ws-sp-spark').style.clipPath === '');
  check('the last reply says so', text(r[0].querySelector('.ws-sp-ms')) === 'No reply');
  check('the summary says so', text(t.pop().querySelector('.ws-sp-title')) === 'Media Server is down');
  check('checked just now', text(t.pop().querySelector('.ws-sp-checked')) === 'Checked just now');
  t.clock.wall += 2 * 60000 + 1000;
  await t.tick(5000);
  check('the words tick on without asking', text(t.pop().querySelector('.ws-sp-checked')) === 'Checked 2 min ago', text(t.pop().querySelector('.ws-sp-checked')));
  const n = t.calls.length;
  await t.tick(5000);
  check('a word tick never asks', t.calls.length === n);
  await t.done();
}
{
  current = 'live: no change, no movement';
  const t = await boot();
  t.pill.click();
  await wait(10);
  const tr = rows(t.pop())[0].querySelector('.ws-sp-track');
  const bars = Array.from(tr.children);
  await t.tick(15000);
  check('the same answer leaves the bars alone', tr.children.length === 50 && Array.from(tr.children).every((b, i) => b === bars[i]) && tr.style.transform === '');
  await t.done();
}
{
  current = 'live: a long catch-up just shows';
  const t = await boot();
  t.pill.click();
  await wait(10);
  let next = ALL_UP;
  for (let i = 0; i < 4; i++) next = onward(next);   // 8 new checks
  t.state.answer = next;
  await t.tick(15000);
  const tr = rows(t.pop())[0].querySelector('.ws-sp-track');
  check('more than six new checks do not slide', tr.children.length === 50 && tr.style.transform === '');
  await t.done();
}
{
  current = 'live: reduced motion';
  const t = await boot({ reduce: true });
  t.pill.click();
  await wait(10);
  t.state.answer = onward(ALL_UP, { 4: { status: 'down', ping: null } });
  await t.tick(15000);
  const r = rows(t.pop())[0];
  const tr = r.querySelector('.ws-sp-track');
  check('no slide: the new checks are simply there', tr.children.length === 50 && tr.style.transform === '' && tr.style.width === '' &&
    tr.lastElementChild.getAttribute('data-k') === 'down', [tr.children.length, tr.style.transform]);
  await t.done();
}
{
  current = 'live: Uptime Kuma goes away and comes back while open';
  const t = await boot();
  t.pill.click();
  await wait(10);
  t.pop().querySelector('.ws-sp-seg-input').focus();
  t.state.answer = 503;
  await t.tick(15000);
  check('still open', open(t));
  check('says unavailable, with the last names', text(t.pop().querySelector('.ws-sp-title')) === 'Status unavailable right now' &&
    rows(t.pop()).length === 3 && rows(t.pop()).every((x) => text(x.querySelector('.ws-sp-state')) === 'No answer'));
  check('the pill is grey', t.pill.getAttribute('data-state') === 'off');
  const retry = t.pop().querySelector('.ws-sp-retry');
  retry.focus();
  t.state.answer = onward(ALL_UP);
  await t.tick(15000);
  check('recovers by itself on the next ask', text(t.pop().querySelector('.ws-sp-title')) === 'Everything is running' &&
    t.pill.getAttribute('data-state') === 'ok' && rows(t.pop()).every((x) => x.querySelectorAll('.ws-sp-strip i').length === 50));
  check('focus moves from the gone Try again to Close', retry.hidden && t.d.activeElement === t.pop().querySelector('.ws-sp-close'));
  await t.done();
}
{
  current = 'live: Try again keeps focus while it checks';
  const t = await boot({ answer: 503, cached: { state: 'ok', down: 0, list: ALL_UP, t: NOW - 60000 } });
  t.pill.click();
  await wait(10);
  const retry = t.pop().querySelector('.ws-sp-retry');
  retry.focus();
  t.state.answer = 503;
  retry.click();
  check('busy, not disabled', retry.getAttribute('aria-disabled') === 'true' && !retry.disabled && t.d.activeElement === retry);
  await wait(10);
  check('and ready again', !retry.hasAttribute('aria-disabled') && text(retry) === 'refreshTry again', text(retry));
  await t.done();
}
{
  current = 'live: the phone sheet';
  const t = await boot({ width: 375 });
  t.chip.click();
  await wait(10);
  check('the sheet asks while open', t.polls(15000) === 1);
  t.state.answer = onward(ALL_UP);
  const before = t.calls.length;
  await t.tick(15000);
  check('and gets the new checks', t.calls.length === before + 1 &&
    rows(t.sheet()).every((x) => x.querySelector('.ws-sp-track').children.length === 52));
  t.sheet().dispatchEvent(new t.w.Event('cancel', { cancelable: true }));
  await wait(260);
  check('closed: the polls stop', t.polls(15000) === 0 && t.polls(5000) === 0);
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
  check('the popover is on the shared frosted surface, no variant', t.pop().classList.contains('ws-frost') && !t.pop().classList.contains('ws-frost-read'));
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
  const frost = rule('.ws-frost');
  check('the shared frost is the glass slab: the secondary mixed 30% toward the text colour at 25% over a 15px blur with its boost, a gradient ring',
    /--ws-frost-tint: rgb\(var\(--color-secondary\) \/ \.25\)/.test(css) &&
    /--ws-frost-tint: color-mix\(in srgb, rgb\(var\(--color-secondary\) \/ \.25\) 70%, rgb\(var\(--color-text\) \/ \.25\)\)/.test(css) &&
    /--ws-frost-blur: blur\(15px\)/.test(css) &&
    /--ws-frost-boost: saturate\(1\.5\) brightness\(1\.06\);/.test(css) &&
    /--ws-frost-edge: rgb\(var\(--color-text\) \/ \.12\)/.test(css) &&
    /--ws-frost-ring-layer: var\(--ws-frost-ring\) border-box border-area;/.test(css) &&
    /-webkit-backdrop-filter: var\(--ws-frost-blur\) var\(--ws-frost-boost\)/.test(frost) &&
    /\bbackdrop-filter: var\(--ws-frost-blur\) var\(--ws-frost-boost\)/.test(frost) &&
    /background: var\(--ws-frost-ring-layer\), /.test(frost) &&
    /rgb\(var\(--color-background\) \/ var\(--ws-frost-floor\)\)/.test(frost), frost);
  // No floor, by the owner's choice: over very bright art the panel's words
  // lose contrast; a sheet keeps only its scrim (app/tests/test_frost.py).
  check('every frosted surface has no floor', /--ws-frost-floor: 0;/.test(css));
  check('a frosted sheet adds no floor over its scrim', /--ws-frost-floor-on-scrim: 0;/.test(css) &&
    /:is\(\.ws-sheet-panel, \.ws-dialog-box, \[data-dialog-box\]\)\.ws-frost \{ --ws-frost-floor: var\(--ws-frost-floor-on-scrim\); \}/.test(css));
  check('popovers, menus, dialogs and sheets share one themed scrollbar',
    /:is\(\.ws-pop, \.ws-dialog-box, \[data-dialog-box\], \.ws-sheet-panel, \.ws-frost\) \* \{\s*scrollbar-width: thin;\s*scrollbar-color: rgb\(var\(--color-accent\) \/ \.5\) transparent;/.test(css) &&
    /\*::-webkit-scrollbar-thumb:hover \{ background-color: rgb\(var\(--color-accent\) \/ \.8\); \}/.test(css));
  const words = ['.ws-sp-sub', '.ws-sp-checked', '.ws-sp-range-label', '.ws-sp-state', '.ws-sp-na', '.ws-sp-window', '.ws-sp-ms', '.ws-sp-foot']
    .map((sel) => [sel, (rule(sel).match(/color: rgb\(var\(--color-text\) \/ (\.\d+)\)/) || [])[1]]);
  check('no word in the panel is fainter than .8 of the text colour', words.every(([, a]) => a && +a >= 0.8), words);
  // Every panel that drops from a bar is a .ws-pop on the frost: this one, the
  // account menu and the bell's (notifications.js). An ancestor's backdrop
  // filter would stop their blur at the bar, so the bar lets go of its own.
  check('the header and the phone top bar let go of their blur while a panel is open',
    /#appHeader:has\(\.ws-pop\.is-open\),\s*#mobileTopBar:has\(\.ws-pop\.is-open\) \{ -webkit-backdrop-filter: none; backdrop-filter: none; \}/.test(css));
  const NOTIFY = readFileSync(join(STATIC, 'js/notifications.js'), 'utf8');
  check('those panels are .ws-pop on the frost: the status panel, the account menu and the bell\'s',
    /'ws-pop ws-sp-pop ws-frost/.test(PANEL) && /id="userMenuDropdown" class="ws-pop [^"]*\bws-frost\b/.test(HEADER) &&
    /'ws-pop hidden absolute[^']*\bws-frost\b/.test(NOTIFY));
  check('and both bars blur what is under them', /id="appHeader" class="[^"]*\bbackdrop-blur-md\b/.test(HEADER) &&
    /id="mobileTopBar" class="[^"]*\bbackdrop-blur-md\b/.test(SIDEBAR));
  check('two services or more sit in two columns',
    /\.ws-sp-pop \.ws-sp-list:has\(\.ws-sp-row \+ \.ws-sp-row\) \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css));
  check('at most 760px wide and never past the room', /\.ws-sp-pop:has\(\.ws-sp-row \+ \.ws-sp-row\) \{ width: min\(760px, var\(--ws-sp-room/.test(css));
  check('the graphs sit in a well of the page colour', /background: rgb\(var\(--color-background\) \/ \.6\)/.test(rule('.ws-sp-graphs')), rule('.ws-sp-graphs'));
  check('the popover scrolls only past the window height', /max-height: calc\(100dvh - 96px\); overflow-y: auto/.test(rule('.ws-sp-pop')));
}

console.log(`${total - failed}/${total} status-panel cases pass`);
if (failed) process.exit(1);
