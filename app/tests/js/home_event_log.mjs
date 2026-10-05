// Home's event log (app/static/js/pages/home.js, createEventLog): the real
// Home page module run in happy-dom (a dev-only dependency) over the page's
// own markup (index.html), with a scripted /api/status/feed, a fake clock for
// the wheel's turns and a fake shell (WS.swr and WS.arrive written as shell.js
// does them). The other sections' reads answer nothing.
//
// Covers: the feed's states (ok, down, unavailable, off, empty, a failed
// read); events newest at the front (slot 0, last in the document), at most
// five lines; an outage as its two events; the tick colours by kind; relative
// times; only the front line readable and titled; a new event turning the
// wheel one notch (several, one notch each, in order) and announced once;
// never more than five settled lines; reduced motion crossfading at once;
// text written as text; a section the server rendered hidden coming back;
// library lines (grey tick, a grab's muted note); what the feed pins (an
// open outage, an important note) as rows above the wheel and never on it,
// announced when new, joining the history when resolved, held under a burst
// of library lines, and the server's rows (event_pinned_vectors.json) taken
// over without a change; turning back through the history by wheel, keys and
// drag, with the page scrolling at either end, no yank from new events,
// "Latest" and the 15 s return.
//
// HOME_JS=<path> runs the same cases against another copy of the module.
// Run: node app/tests/js/home_event_log.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const HOME_PATH = process.env.HOME_JS || join(STATIC, 'js/pages/home.js');
const HOME_HTML = readFileSync(join(STATIC, 'index.html'), 'utf8');
const THEME_CSS = readFileSync(join(STATIC, 'css/theme.css'), 'utf8');
const PINNED = JSON.parse(readFileSync(join(here, '../event_pinned_vectors.json'), 'utf8'));
const BOOKS_SRC = readFileSync(join(STATIC, 'js/pages/books.js'), 'utf8');

const report = console.error.bind(console);
let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    report(`FAIL ${current}: ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

function fakeClock() {
  let now = 0;
  let ids = 0;
  const due = new Map();
  return {
    pending() { return due.size; },
    setTimeout(fn, ms) { const id = ++ids; due.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { due.delete(id); },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const [id, t] of due) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        now = next[1].at;
        due.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

const BOOKS_URL = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(BOOKS_SRC);
const home = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(
  readFileSync(HOME_PATH, 'utf8').replace(/from\s+['"]\.\/books\.js(\?[^'"]*)?['"]/g, `from ${JSON.stringify(BOOKS_URL)}`)));

// ---- The feed, scripted: feed.answer is what the next read returns ----

function fakeShell(doc, clock, feed) {
  const store = new Map();
  const arr = { order: [], done: {}, queue: {}, gate: false };
  const WS = {
    arrived: [],
    reads: 0,
    arriveReset() {
      arr.order = Array.from(doc.querySelectorAll('[data-arrive]')).map((n) => n.getAttribute('data-arrive'));
      arr.done = {}; arr.queue = {}; arr.gate = false;
      clock.setTimeout(() => { arr.gate = true; flushArrive(); }, 300);
    },
    arrive(key, write) {
      if (arr.done[key] || arr.order.indexOf(key) === -1) { if (write) write(); return; }
      arr.queue[key] = write || (() => {});
      flushArrive();
    },
    // shell.js's swr: a kept copy renders first, a changed answer renders again,
    // onError only when nothing was shown. Only the feed is this test's business.
    swr(key, fetcher, render, opts) {
      if (key !== 'status:feed') return Promise.resolve(null);
      opts = opts || {};
      const cached = store.get(key);
      const cachedJSON = cached === undefined ? null : JSON.stringify(cached);
      if (cached !== undefined) render(cached, true);
      return fetcher().then((fresh) => {
        if (JSON.stringify(fresh) !== cachedJSON) render(fresh, false);
        store.set(key, fresh);
        return fresh;
      }, (err) => {
        if (cachedJSON === null && opts.onError) opts.onError(err);
        return cachedJSON === null ? null : cached;
      });
    },
    getJSON(url) {
      if (url.indexOf('/api/status/feed') !== 0) return Promise.reject(new Error('not scripted'));
      WS.reads += 1;
      const a = feed.answer;
      if (a && a.status) { const e = new Error('HTTP ' + a.status); e.status = a.status; return Promise.reject(e); }
      return Promise.resolve(JSON.parse(JSON.stringify(a)));
    },
    setHTML() {},
    serviceStatus() { return Promise.resolve([]); },
    dragScroll() {},
    cache: store
  };
  function flushArrive() {
    for (const k of arr.order) {
      if (arr.done[k]) continue;
      if (!(k in arr.queue)) { if (arr.gate) continue; return; }
      const write = arr.queue[k];
      delete arr.queue[k];
      arr.done[k] = true;
      WS.arrived.push(k);
      write();
    }
  }
  return WS;
}

const NAV = /<div id="wsPage"[\s\S]*<\/main>/;

function visit(o = {}) {
  const win = new Window({ url: 'https://ws.test/' });
  const doc = win.document;
  doc.body.innerHTML = HOME_HTML.match(NAV)[0].replace(/<\/main>$/, '');
  if (o.serverHidden) doc.getElementById('homeEventLog').hidden = true;
  if (o.pinnedHTML !== undefined) {
    // As the server writes them (app/home_event_log.py).
    const tpl = doc.createElement('template');
    tpl.innerHTML = o.pinnedHTML;
    doc.querySelector('[data-event-pinned]').replaceWith(tpl.content.firstElementChild);
  }
  const clock = fakeClock();
  const feed = { answer: o.answer };
  const ctl = new win.AbortController();
  const WS = fakeShell(doc, clock, feed);
  if (o.cached) WS.cache.set('status:feed', o.cached);
  const reduced = { on: !!o.reduced };
  win.matchMedia = (q) => ({ matches: q.indexOf('prefers-reduced-motion: reduce') !== -1 && reduced.on, media: q, addEventListener() {}, removeEventListener() {} });
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win);
  set('document', doc);
  set('localStorage', win.localStorage);
  set('WS', WS);
  win.WS = WS;
  set('fetch', () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }));
  set('checkAuth', async () => ({ username: 'sam', is_admin: false }));
  set('escapeHtml', (s) => String(s));
  set('console', { error() {}, warn() {}, log() {}, info() {} });
  const polls = [];
  const branding = { features: {}, sidebar_enabled: {}, home_sections: {} };
  const ctx = {
    root: doc.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL('https://ws.test/'),
    data: { branding, user: { username: 'sam' } },
    poll(fn, ms) { polls.push({ fn, ms }); return () => {}; },
    // The visit's timers, as the router's visitTimers: none after the
    // signal aborts, and the pending ones cleared with it.
    setTimeout: (fn, ms) => {
      if (ctl.signal.aborted) return 0;
      const id = clock.setTimeout(() => { mine.delete(id); fn(); }, ms);
      mine.add(id);
      return id;
    },
    clearTimeout: (id) => { if (mine.delete(id)) clock.clearTimeout(id); }
  };
  const mine = new Set();
  ctl.signal.addEventListener('abort', () => { mine.forEach((id) => clock.clearTimeout(id)); mine.clear(); });
  WS.arriveReset();
  const section = doc.getElementById('homeEventLog');
  const wheel = section.querySelector('[data-event-wheel]');
  const t = {
    win, doc, clock, ctl, WS, feed, reduced, section, wheel,
    pinnedList: () => section.querySelector('[data-event-pinned]'),
    pinned: () => Array.from(section.querySelector('[data-event-pinned]').children),
    pinnedTexts: () => t.pinned().map((el) => { const x = el.querySelector('.ws-pinned__text'); return x.textContent.slice(x.querySelector('.sr-only').textContent.length); }),
    // Lines on the wheel in the document's order (oldest first).
    all: () => Array.from(wheel.children),
    settled: () => Array.from(wheel.children).filter((el) => !el.classList.contains('is-leaving')),
    // The settled lines by slot: [front, ...].
    slots: () => t.settled().slice().sort((a, b) => slot(a) - slot(b)),
    texts: () => t.slots().map(lineText),
    announced: () => section.querySelector('[data-event-announce]').textContent,
    async open() {
      const m = home.mount(ctx);
      await clock.advance(1700);
      await m;
    },
    // The 30 s poll Home runs for its live sections.
    async poll(answer) {
      if (answer !== undefined) feed.answer = answer;
      const p = polls.find((x) => x.ms === 30000);
      p.fn();
      await flush();
    },
    release() {
      for (const k of Object.keys(saved)) {
        if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k];
      }
    }
  };
  return t;
}

function slot(el) { return Number(el.style.getPropertyValue('--i')); }
// What a line shows (without the screen-reader prefix).
function lineText(el) {
  const t = el.querySelector('.ws-wheel__text');
  if (!t) return '';
  const sr = t.querySelector('.sr-only');
  return t.textContent.slice(sr ? sr.textContent.length : 0);
}

async function run(name, fn) {
  current = name;
  const made = [];
  try {
    await fn((o) => { const t = visit(o); made.push(t); return t; });
  } catch (e) {
    failed += 1;
    total += 1;
    report(`FAIL ${name}: threw ${e && e.stack || e}`);
  } finally {
    while (made.length) { const t = made.pop(); t.ctl.abort(); t.release(); }
  }
}

// ---- What the API answers (GET /api/status/feed) ----

const MIN = 60000;
const iso = (minsAgo) => new Date(Date.now() - minsAgo * MIN).toISOString();
const note = (id, text, minsAgo, important = false) => ({ id, source: 'admin', text, service: null, important, resolved: false, started_at: null, ended_at: null, created_at: iso(minsAgo), at: iso(minsAgo) });
const outage = (id, service, minsAgo) => ({ id, source: 'auto', text: service + ' is down', service, important: false, resolved: false, started_at: iso(minsAgo), ended_at: null, created_at: iso(minsAgo), at: iso(minsAgo) });
const back = (id, service, beganAgo, endedAgo) => ({ id, source: 'auto', text: `${service} is back, down ${beganAgo - endedAgo} min`, service, important: false, resolved: true, started_at: iso(beganAgo), ended_at: iso(endedAgo), created_at: iso(beganAgo), at: iso(endedAgo) });
const lib = (id, text, minsAgo, note = '') => ({ id, source: 'library', text, note, service: null, important: false, resolved: true, started_at: null, ended_at: null, created_at: iso(minsAgo), at: iso(minsAgo) });
const answer = (state, open, items) => ({ state, open, items });

const QUIET_OK = answer('ok', [], [
  note(1, 'New shelves on Books', 300),
  back(2, 'Books', 200, 197),
  note(3, 'Downloads paused until 9pm', 35, true),
  note(4, 'Requests are slow tonight', 4)
]);

// ---------------------------------------------------------------------------

await run('the section sits right above News and Service Health, with Home\'s heading and a wheel that holds its room', async (make) => {
  const t = make({ answer: QUIET_OK });
  const order = t.doc.querySelectorAll('[data-arrive]');
  const keys = Array.from(order).map((n) => n.getAttribute('data-arrive'));
  check('in the document it comes just before News, then Service Health', keys.indexOf('feed') === keys.indexOf('news') - 1 && keys.indexOf('news') === keys.indexOf('services') - 1, keys);
  const grid = t.section.nextElementSibling;
  check('the next thing is the grid that holds them, News first', grid && grid.hasAttribute('data-home-pair') && grid.firstElementChild && grid.firstElementChild.getAttribute('data-arrive') === 'news' && grid.firstElementChild.nextElementSibling.getAttribute('data-arrive') === 'services');
  const h = t.section.querySelector('h3');
  check('the heading is "Event log", styled like the other sections, closer to its wheel', h && h.textContent === 'Event log' && h.className === 'text-xl font-bold text-frosted-blue' && h.parentNode.className === 'flex items-center gap-3 mb-2');
  check('a compact section: less room below it than between the other sections', t.section.classList.contains('-mb-3'));
  const icon = h.previousElementSibling;
  check('its icon follows the section icons setting', icon && icon.classList.contains('ws-section-icon') && icon.getAttribute('aria-hidden') === 'true');
  check('labelled by its heading', t.section.getAttribute('aria-labelledby') === h.id);
  check('a skeleton front line until the answer', t.wheel.querySelector('.skel') && t.wheel.children.length === 1);
  const live = t.section.querySelector('[data-event-announce]');
  check('one polite live region', live && live.getAttribute('aria-live') === 'polite' && live.classList.contains('sr-only'));
  check('no link (there is no feed page)', !t.section.querySelector('a'));
});

await run('ok: the newest five events, newest at the front, each with its tick and time', async (make) => {
  const t = make({ answer: answer('ok', [], QUIET_OK.items.concat([note(9, 'Oldest note', 600)])) });
  await t.open();
  check('it read the feed once', t.WS.reads === 1);
  check('the skeleton is gone and the section shown', !t.wheel.querySelector('.skel') && t.section.hidden === false);
  check('five lines, never more', t.all().length === 5, t.all().length);
  check('newest at the front (slot 0), the oldest shown at the back', JSON.stringify(t.texts()) === JSON.stringify(['Requests are slow tonight', 'Downloads paused until 9pm', 'Books is back, down 3 min', 'Books is down', 'New shelves on Books']), t.texts());
  check('in the document oldest first, so the newest is last', lineText(t.all()[4]) === 'Requests are slow tonight');
  const types = t.slots().map((el) => el.getAttribute('data-type'));
  check('ticks by kind: note, important, back, down, note', JSON.stringify(types) === JSON.stringify(['note', 'important', 'up', 'down', 'note']), types);
  check('every line has its 2px tick, hidden from screen readers', t.all().every((el) => el.firstElementChild.className === 'ws-wheel__mark' && el.firstElementChild.getAttribute('aria-hidden') === 'true'));
  const times = t.slots().map((el) => el.querySelector('time').textContent);
  check('relative times', JSON.stringify(times) === JSON.stringify(['4 min ago', '35 min ago', '3 h ago', '3 h ago', '5 h ago']), times);
  check('a machine-readable time too', t.slots()[0].querySelector('time').getAttribute('datetime') === QUIET_OK.items[3].created_at);
  const front = t.slots()[0];
  check('only the front line is readable', front.getAttribute('aria-hidden') === null && t.slots().slice(1).every((el) => el.getAttribute('aria-hidden') === 'true'));
  check('the full text is in the title (one line, ellipsis on a phone)', front.title === 'Requests are slow tonight');
  check('notes are named for screen readers, outages are not', front.querySelector('.sr-only').textContent === 'Note: ' && t.slots()[1].querySelector('.sr-only').textContent === 'Important: ' && !t.slots()[2].querySelector('.sr-only'));
  check('nothing is announced on the first answer', t.announced() === '');
  check('nothing turned in (no line entering)', !t.wheel.querySelector('.is-entering'));
  check('two polls: the live sections (30 s) carry the feed', !!t.WS && t.WS.reads === 1);
});

await run('down: an open outage is pinned above the wheel, never on it', async (make) => {
  const t = make({ answer: answer('down', [outage(7, 'Plex', 6)], [note(3, 'Movie night Friday', 90)]) });
  check('before the answer the list is empty and hidden', t.pinned().length === 0 && t.pinnedList().hidden === true);
  await t.open();
  const list = t.pinnedList();
  check('the list sits under the heading, above the wheel', list.previousElementSibling.querySelector('h3') && list.nextElementSibling === t.wheel);
  check('a list named for what it holds', list.tagName === 'UL' && list.getAttribute('role') === 'list' && list.getAttribute('aria-label') === 'Current problems' && list.hidden === false);
  const [row] = t.pinned();
  check('one row: the outage', t.pinned().length === 1 && row.tagName === 'LI' && row.getAttribute('data-type') === 'down' && row.getAttribute('data-key') === 'a7:down');
  const icon = row.firstElementChild;
  check('an exclamation icon first, hidden from screen readers', icon.classList.contains('ws-pinned__icon') && icon.classList.contains('material-symbols-outlined') && icon.textContent === 'error' && icon.getAttribute('aria-hidden') === 'true');
  check('a status icon, not a section icon (the section icons setting leaves it on)', !icon.classList.contains('ws-section-icon'));
  const words = row.querySelector('.ws-pinned__text');
  check('"Problem: " for screen readers, then the problem', words.querySelector('.sr-only').textContent === 'Problem: ' && JSON.stringify(t.pinnedTexts()) === JSON.stringify(['Plex is down']));
  check('its time last, as the wheel says times', row.lastElementChild.tagName === 'TIME' && row.lastElementChild.textContent === '6 min ago' && row.lastElementChild.getAttribute('datetime') === t.feed.answer.open[0].started_at);
  check('the full text in its title (ellipsis on a phone)', row.title === 'Plex is down');
  check('not on the wheel: the note is at the front', JSON.stringify(t.texts()) === JSON.stringify(['Movie night Friday']), t.texts());
  check('nothing announced on the first answer', t.announced() === '');
});

await run('only pinned: the wheel says there is nothing else', async (make) => {
  const t = make({ answer: answer('down', [outage(7, 'Plex', 6)], []) });
  await t.open();
  check('the outage is pinned', JSON.stringify(t.pinnedTexts()) === JSON.stringify(['Plex is down']));
  check('the wheel\'s quiet line does not say the month was clear', JSON.stringify(t.texts()) === JSON.stringify(['No other events this month']) && t.all()[0].getAttribute('data-type') === 'quiet', t.texts());
  check('nothing to turn back to', t.wheel.getAttribute('tabindex') === '0');
});

await run('an important note is pinned in amber; a plain note is not pinned', async (make) => {
  const t = make({ answer: answer('ok', [note(3, 'Downloads paused until 9pm', 35, true)], [note(4, 'Requests are slow tonight', 4)]) });
  await t.open();
  const [row] = t.pinned();
  check('one row: the note', t.pinned().length === 1 && row.getAttribute('data-type') === 'important' && row.getAttribute('data-key') === 'n3');
  check('its own icon, "Important: " for screen readers', row.querySelector('.ws-pinned__icon').textContent === 'warning' && row.querySelector('.sr-only').textContent === 'Important: ');
  check('the time it was posted', row.querySelector('time').textContent === '35 min ago');
  check('the plain note stays on the wheel, alone', JSON.stringify(t.texts()) === JSON.stringify(['Requests are slow tonight']), t.texts());
  const err = THEME_CSS.match(/\.ws-pinned__row\[data-type="down"\] \.ws-pinned__icon \{ color: ([^;]+); \}/);
  const warn = THEME_CSS.match(/\.ws-pinned__row\[data-type="important"\] \.ws-pinned__icon \{ color: ([^;]+); \}/);
  check('red for an outage, amber for a note, from the theme\'s status colours', err && err[1] === 'rgb(var(--ws-status-err))' && warn && warn[1] === 'rgb(var(--ws-status-warn))', [err && err[1], warn && warn[1]]);
});

await run('unavailable: one line, never a claim that everything is running', async (make) => {
  const t = make({ answer: answer('unavailable', [outage(7, 'Plex', 2)], [note(3, 'A note', 5)]) });
  await t.open();
  check('one line', t.all().length === 1);
  check('it says the status is unavailable', t.texts()[0] === 'Status unavailable right now');
  check('a quiet line: no tick colour, no time', t.all()[0].getAttribute('data-type') === 'quiet' && !t.all()[0].querySelector('time'));
  check('nothing says running', !/running|online|all good/i.test(t.section.textContent));
});

await run('a failed read reads as unavailable', async (make) => {
  const t = make({ answer: { status: 503 } });
  await t.open();
  check('the section arrived', t.WS.arrived.indexOf('feed') !== -1);
  check('one line: unavailable', t.all().length === 1 && t.texts()[0] === 'Status unavailable right now');
});

await run('empty: one calm line', async (make) => {
  const t = make({ answer: answer('ok', [], []) });
  await t.open();
  check('one line', t.all().length === 1);
  check('it says there is nothing to report', t.texts()[0] === 'No outages or notes this month');
  check('quiet, no time', t.all()[0].getAttribute('data-type') === 'quiet' && !t.all()[0].querySelector('time'));
});

await run('off: hidden with nothing to show; notes still show without Uptime Kuma', async (make) => {
  const t = make({ answer: answer('off', [], []) });
  await t.open();
  check('hidden', t.section.hidden === true);
  check('the arrival order is not held up', t.WS.arrived.indexOf('feed') !== -1);
  const s = make({ serverHidden: true, answer: answer('off', [], [note(5, 'Maintenance tonight', 10)]) });
  check('the server can render it hidden from the first paint', s.section.hidden === true);
  await s.open();
  check('a note brings it back', s.section.hidden === false && s.texts()[0] === 'Maintenance tonight');
  check('and nothing is announced for it', s.announced() === '');
  await s.poll(answer('off', [], []));
  check('the note gone: hidden again', s.section.hidden === true);
});

await run('a new event turns the wheel one notch and is announced', async (make) => {
  const t = make({ answer: QUIET_OK });
  await t.open();
  const oldFront = t.slots()[0];
  await t.poll(answer('ok', [], [note(8, 'Movie night moved to Saturday', 0)].concat(QUIET_OK.items)));
  const entering = t.all()[t.all().length - 1];
  check('the new line is last in the document, on the front notch', lineText(entering) === 'Movie night moved to Saturday' && slot(entering) === 0);
  check('the old front moved back one notch', slot(oldFront) === 1 && oldFront.getAttribute('aria-hidden') === 'true');
  check('the new front is readable and titled', entering.getAttribute('aria-hidden') === null && entering.title === 'Movie night moved to Saturday');
  check('the oldest line turns away over the top', t.all().filter((el) => el.classList.contains('is-leaving')).length === 1);
  check('announced once, as itself', t.announced() === 'Note: Movie night moved to Saturday');
  await t.clock.advance(800);
  check('after the turn: five settled lines', t.all().length === 5 && t.settled().length === 5, t.all().length);
  check('in order', JSON.stringify(t.texts()) === JSON.stringify(['Movie night moved to Saturday', 'Requests are slow tonight', 'Downloads paused until 9pm', 'Books is back, down 3 min', 'Books is down']), t.texts());
  await t.clock.advance(7000);
  check('the announcement clears later (no double reading in browse mode)', t.announced() === '');
  await t.poll();
  check('the same answer again changes nothing', t.all().length === 5 && t.announced() === '');
});

await run('a new outage is pinned above the wheel and announced; the wheel does not turn', async (make) => {
  const t = make({ answer: QUIET_OK });
  await t.open();
  const before = t.all();
  check('nothing pinned yet: the list is hidden', t.pinnedList().hidden === true);
  await t.poll(answer('down', [outage(8, 'Requests', 0)], QUIET_OK.items));
  check('a row for it', JSON.stringify(t.pinnedTexts()) === JSON.stringify(['Requests is down']) && t.pinnedList().hidden === false);
  check('announced once, as a problem', t.announced() === 'Problem: Requests is down', t.announced());
  check('the wheel kept its lines, nothing turned', t.all().length === 5 && t.all().every((el, i) => el === before[i]) && !t.wheel.querySelector('.is-entering, .is-leaving'));
  await t.clock.advance(7000);
  await t.poll();
  check('the same answer again announces nothing', t.announced() === '' && t.pinned().length === 1);
});

await run('the outage resolves: its row goes, and its start and return join the wheel', async (make) => {
  const t = make({ answer: answer('down', [outage(8, 'Requests', 3)], QUIET_OK.items) });
  await t.open();
  const row = t.pinned()[0];
  check('pinned, and not on the wheel', row && !t.texts().includes('Requests is down'));
  await t.poll(answer('ok', [], [back(8, 'Requests', 3, 0)].concat(QUIET_OK.items)));
  check('the row is gone and the list hidden', !row.parentNode && t.pinned().length === 0 && t.pinnedList().hidden === true);
  await t.clock.advance(800);
  check('back at the front, in the back-up colour', t.texts()[0] === 'Requests is back, down 3 min' && t.slots()[0].getAttribute('data-type') === 'up');
  check('its start one notch behind, in the outage colour', t.texts()[1] === 'Requests is down' && t.slots()[1].getAttribute('data-type') === 'down', t.texts());
  check('the return announced, once', t.announced() === 'Requests is back, down 3 min');
  check('five lines', t.all().length === 5);
});

await run('an important note resolved moves into the history, unannounced', async (make) => {
  const t = make({ answer: answer('ok', [note(30, 'Server move tonight', 2, true)], QUIET_OK.items) });
  await t.open();
  check('pinned', JSON.stringify(t.pinnedTexts()) === JSON.stringify(['Server move tonight']));
  check('the wheel without it', !t.texts().includes('Server move tonight'));
  const resolved = Object.assign(note(30, 'Server move tonight', 2, true), { resolved: true, at: iso(0) });
  await t.poll(answer('ok', [], [resolved].concat(QUIET_OK.items)));
  await t.clock.advance(800);
  check('the row is gone', t.pinned().length === 0 && t.pinnedList().hidden === true);
  check('on the wheel at its own time, the front', t.texts()[0] === 'Server move tonight' && t.slots()[0].getAttribute('data-type') === 'important', t.texts());
  check('not announced again', t.announced() === '');
});

await run('unavailable: nothing is pinned', async (make) => {
  const t = make({ answer: answer('down', [outage(7, 'Plex', 2)], QUIET_OK.items) });
  await t.open();
  check('pinned at first', t.pinned().length === 1);
  await t.poll(answer('unavailable', [outage(7, 'Plex', 2)], QUIET_OK.items));
  check('the row goes with the rest', t.pinned().length === 0 && t.pinnedList().hidden === true && t.texts()[0] === 'Status unavailable right now');
});

await run('a new outage and a new line in one answer: one message says both', async (make) => {
  const t = make({ answer: QUIET_OK });
  await t.open();
  await t.poll(answer('down', [outage(8, 'Plex', 1)], [note(9, 'Hello', 0)].concat(QUIET_OK.items)));
  check('the problem first, then the line', t.announced() === 'Problem: Plex is down. Note: Hello', t.announced());
  const r = make({ answer: QUIET_OK, reduced: true });
  await r.open();
  await r.poll(answer('down', [outage(8, 'Plex', 1)], [note(9, 'Hello', 0)].concat(QUIET_OK.items)));
  check('the same under reduced motion', r.announced() === 'Problem: Plex is down. Note: Hello', r.announced());
});

await run('reduced motion: a pinned row is simply there, nothing about it moves', async (make) => {
  const t = make({ answer: QUIET_OK, reduced: true });
  await t.open();
  await t.poll(answer('down', [outage(8, 'Requests', 0)], QUIET_OK.items));
  const row = t.pinned()[0];
  check('there at once, no entering state', row && row.className === 'ws-pinned__row');
  const block = THEME_CSS.slice(THEME_CSS.indexOf('.ws-pinned {'), THEME_CSS.indexOf('/* Reduced motion: lines crossfade'));
  check('the rows have no transition or animation at all', block.length > 0 && !/transition|animation/.test(block));
});

await run('several new events: one notch each, in order, then five lines', async (make) => {
  const t = make({ answer: QUIET_OK });
  await t.open();
  await t.poll(answer('ok', [], [lib(9, 'Movie Added: Dune (2021)', 0), lib(8, 'Episode Added: Severance S02E03', 1)].concat(QUIET_OK.items, [note(10, 'Hello', 2)])));
  check('first turn at once: the oldest new event at the front', t.texts()[0] === 'Hello', t.texts());
  check('never more than one line fading out', t.all().filter((el) => el.classList.contains('is-leaving')).length <= 1);
  check('no announcement mid-burst', t.announced() === '');
  await t.clock.advance(710);
  check('second turn', t.texts()[0] === 'Episode Added: Severance S02E03', t.texts());
  await t.clock.advance(710);
  check('third turn: the newest at the front', t.texts()[0] === 'Movie Added: Dune (2021)', t.texts());
  check('the newest is announced, once', t.announced() === 'Movie Added: Dune (2021)');
  for (let i = 0; i < 3; i++) {
    check('never more than five settled lines or six in the document', t.settled().length <= 5 && t.all().length <= 6, t.all().length);
    await t.clock.advance(300);
  }
  await t.clock.advance(800);
  check('settled: exactly five', t.all().length === 5 && t.settled().length === 5);
  check('newest five', JSON.stringify(t.texts()) === JSON.stringify(['Movie Added: Dune (2021)', 'Episode Added: Severance S02E03', 'Hello', 'Requests are slow tonight', 'Downloads paused until 9pm']), t.texts());
});

await run('a deleted note: the line goes, nothing is announced, nothing turns in', async (make) => {
  const t = make({ answer: answer('ok', [], QUIET_OK.items.concat([note(9, 'Oldest note', 600)])) });
  await t.open();
  await t.poll(answer('ok', [], QUIET_OK.items.slice(0, 3).concat([note(9, 'Oldest note', 600)])));
  await t.clock.advance(800);
  check('the deleted note is gone and the older one came into view', JSON.stringify(t.texts()) === JSON.stringify(['Downloads paused until 9pm', 'Books is back, down 3 min', 'Books is down', 'New shelves on Books', 'Oldest note']), t.texts());
  check('not announced', t.announced() === '');
  check('five lines', t.all().length === 5);
});

await run('reduced motion: the set crossfades at once, nothing turns', async (make) => {
  const t = make({ answer: QUIET_OK, reduced: true });
  await t.open();
  const before = t.all();
  await t.poll(answer('ok', [], [lib(9, 'Movie Added: Dune (2021)', 0), lib(8, 'Episode Added: Severance S02E03', 1)].concat(QUIET_OK.items)));
  check('every old line fades out where it is', before.every((el) => el.classList.contains('is-leaving') && el.getAttribute('aria-hidden') === 'true'));
  check('the final set is there at once, no steps', JSON.stringify(t.texts()) === JSON.stringify(['Movie Added: Dune (2021)', 'Episode Added: Severance S02E03', 'Requests are slow tonight', 'Downloads paused until 9pm', 'Books is back, down 3 min']), t.texts());
  check('every old line kept its notch (no move, only a fade)', before.every((el, i) => slot(el) === 4 - i));
  check('the newest announced', t.announced() === 'Movie Added: Dune (2021)');
  await t.clock.advance(800);
  check('five lines after the fade', t.all().length === 5 && t.settled().length === 5);
});

await run('text is written as text', async (make) => {
  const t = make({ answer: answer('ok', [], [note(1, '<img src=x onerror=alert(1)> & <b>bold</b>', 3)]) });
  await t.open();
  check('no element from the text', !t.wheel.querySelector('img') && !t.wheel.querySelector('b'));
  check('the text as written', t.texts()[0] === '<img src=x onerror=alert(1)> & <b>bold</b>');
});

await run('a kept copy paints at once; what happened since turns in', async (make) => {
  const t = make({ cached: QUIET_OK, answer: answer('down', [outage(8, 'Requests', 1)], [note(9, 'Hello', 0)].concat(QUIET_OK.items)) });
  await t.open();
  await t.clock.advance(800);
  check('the new event is at the front', t.texts()[0] === 'Hello');
  check('the outage pinned', JSON.stringify(t.pinnedTexts()) === JSON.stringify(['Requests is down']));
  check('and both announced', t.announced() === 'Problem: Requests is down. Note: Hello', t.announced());
  check('five lines', t.all().length === 5);
});

await run('leaving the page: no turn runs afterwards', async (make) => {
  const t = make({ answer: QUIET_OK });
  await t.open();
  await t.poll(answer('ok', [], [note(9, 'Books is slow', 0), note(8, 'Requests is slow', 1)].concat(QUIET_OK.items)));
  check('the first turn ran', t.texts()[0] === 'Requests is slow');
  t.ctl.abort();
  await t.clock.advance(5000);
  check('the second never does once the page is left', t.texts()[0] === 'Requests is slow' && t.announced() === '');
});

// ---- Library lines (Sonarr, Radarr, Chaptarr webhooks) ----

await run('an outage that ends "no longer monitored": the neutral tick, not the back-up green', async (make) => {
  const gone = Object.assign(back(30, 'Media', 50, 10), { text: 'Media is no longer monitored', unmonitored: true });
  const up = Object.assign(back(31, 'Books', 60, 20), { unmonitored: false });
  const t = make({ answer: answer('ok', [], [gone, up]) });
  await t.open();
  const types = t.slots().map((el) => el.getAttribute('data-type'));
  check('ended as no longer monitored, then its start; back up, then its start', JSON.stringify(types) === JSON.stringify(['unmonitored', 'up', 'down', 'down']), types);
  check('the line reads as the server wrote it', lineText(t.slots()[0]) === 'Media is no longer monitored' && !t.slots()[0].querySelector('.sr-only'));
  const grey = THEME_CSS.match(/\.ws-wheel__line\[data-type="unmonitored"\] \.ws-wheel__mark \{ background: ([^;]+); \}/);
  const lib = THEME_CSS.match(/\.ws-wheel__line\[data-type="library"\] \.ws-wheel__mark \{ background: ([^;]+); \}/);
  check('the same tick as a library line', grey && lib && grey[1] === lib[1], grey && grey[1]);
});



await run('a library line: a grey tick, and a grab\'s muted "not guaranteed" in its own span', async (make) => {
  const t = make({ answer: answer('ok', [], [lib(20, 'Movie Downloading: Dune (2021)', 2, 'not guaranteed'), lib(21, 'Episode Added: Severance S02E03', 5), note(3, 'A note', 30)]) });
  await t.open();
  const [grab, added] = t.slots();
  check('library lines are typed for their tick', grab.getAttribute('data-type') === 'library' && added.getAttribute('data-type') === 'library');
  const rule = THEME_CSS.match(/\.ws-wheel__line\[data-type="library"\] \.ws-wheel__mark \{ background: ([^;]+); \}/);
  check('the tick is the theme\'s secondary text colour, greyed', rule && /^rgb\(var\(--color-text-secondary\) \/ 0\.\d+\)$/.test(rule[1]), rule && rule[1]);
  const muted = grab.querySelector('.ws-wheel__text .ws-wheel__note');
  const title = muted && muted.previousElementSibling;
  check('the note is a span of its own after the title', muted && muted.textContent === ' · not guaranteed' && title && title.className === 'ws-wheel__title' && title.textContent === 'Movie Downloading: Dune (2021)' && !muted.nextSibling);
  const noteRule = THEME_CSS.match(/\.ws-wheel__note \{ flex: none; white-space: pre; color: ([^;]+); \}/);
  check('muted with a theme colour, and never cut: the title gives way to it', noteRule && /^rgb\(var\(--color-text\) \/ 0\.\d+\)$/.test(noteRule[1]) && /\.ws-wheel__text\[data-noted\] \{ display: flex; \}/.test(THEME_CSS) && /\.ws-wheel__title \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/.test(THEME_CSS), noteRule && noteRule[1]);
  check('the whole line reads as one in its title', grab.title === 'Movie Downloading: Dune (2021) · not guaranteed', grab.title);
  check('a line without a note is plain text', !added.querySelector('.ws-wheel__note') && !added.querySelector('.ws-wheel__title') && !added.querySelector('[data-noted]') && lineText(added) === 'Episode Added: Severance S02E03');
  check('no screen-reader prefix on library lines', !grab.querySelector('.sr-only'));
  await t.poll(answer('ok', [], [lib(22, 'Movie Downloading: <b>x</b>', 0, '<i>not</i> guaranteed')].concat(t.feed.answer.items)));
  await t.clock.advance(800);
  check('the note and the text are written as text', !t.wheel.querySelector('b') && !t.wheel.querySelector('i') && lineText(t.slots()[0]) === 'Movie Downloading: <b>x</b> · <i>not</i> guaranteed', lineText(t.slots()[0]));
  check('announced with its note', t.announced() === 'Movie Downloading: <b>x</b> · <i>not</i> guaranteed', t.announced());
});

await run('an open outage stays pinned under a burst of 10 library lines', async (make) => {
  const t = make({ answer: answer('down', [outage(7, 'Plex', 30)], [note(3, 'A note', 60)]) });
  await t.open();
  const row = t.pinned()[0];
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push(lib(100 + i, 'Episode Added: The Bear S03E0' + i, 10 - i));
  await t.poll(answer('down', [outage(7, 'Plex', 30)], burst.concat([note(3, 'A note', 60)])));
  let lost = 0;
  for (let k = 0; k < 12; k++) {
    if (t.pinned()[0] !== row || t.texts().includes('Plex is down')) lost += 1;
    check('never more than five settled lines', t.settled().length <= 5, t.settled().length);
    await t.clock.advance(710);
  }
  await t.clock.advance(800);
  check('the same row stayed pinned, off the wheel, all through the burst', lost === 0, lost);
  check('settled: the newest five library lines on the wheel', JSON.stringify(t.texts()) === JSON.stringify(['Episode Added: The Bear S03E09', 'Episode Added: The Bear S03E08', 'Episode Added: The Bear S03E07', 'Episode Added: The Bear S03E06', 'Episode Added: The Bear S03E05']), t.texts());
  await t.poll(answer('ok', [], [back(7, 'Plex', 30, 0)].concat(burst)));
  await t.clock.advance(800);
  check('resolved: the row goes and its return leads the wheel', t.pinned().length === 0 && t.texts()[0] === 'Plex is back, down 30 min' && !t.texts().includes('Plex is down'), t.texts());
});

// ---- The server's rows (app/home_event_log.py), taken over ----

await run('the script writes exactly the rows the server writes (event_pinned_vectors.json)', async (make) => {
  const realNow = Date.now;
  Date.now = () => PINNED.now_ms;
  try {
    for (const c of PINNED.cases) {
      const t = make({ answer: answer('down', c.open, []) });
      await t.open();
      const tpl = t.doc.createElement('template');
      tpl.innerHTML = c.html;
      const want = tpl.content.firstElementChild;
      check(c.why + ': the same list', t.pinnedList().isEqualNode(want), [t.pinnedList().outerHTML, c.html]);
    }
  } finally {
    Date.now = realNow;
  }
  check('the cases cover what can drift', PINNED.cases.length >= 10);
});

await run('taking the server\'s rows over changes nothing (no height change)', async (make) => {
  const realNow = Date.now;
  Date.now = () => PINNED.now_ms;
  try {
    for (const c of PINNED.cases) {
      const t = make({ answer: answer('down', c.open, [note(99, 'A note', 1)]), pinnedHTML: c.html });
      const list = t.pinnedList();
      const rows = t.pinned();
      const html = list.outerHTML;
      const flips = [];
      new t.win.MutationObserver((m) => flips.push(...m)).observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
      await t.open();
      check(c.why + ': the same list element', t.pinnedList() === list);
      check(c.why + ': the same rows, not rebuilt', t.pinned().length === rows.length && t.pinned().every((el, i) => el === rows[i]));
      check(c.why + ': not one change to them', flips.length === 0 && list.outerHTML === html, flips.length);
    }
  } finally {
    Date.now = realNow;
  }
});

await run('a resolved outage is not held: library lines push it off like any line', async (make) => {
  const items = [back(7, 'Plex', 90, 80)];
  for (let i = 0; i < 5; i++) items.unshift(lib(200 + i, 'Movie Added: Film ' + i, 50 - i));
  const t = make({ answer: answer('ok', [], items) });
  await t.open();
  check('the newest five only', t.all().length === 5 && t.texts().every((x) => x.indexOf('Movie Added') === 0), t.texts());
});

// Every real change to the section's hidden attribute after the first paint
// (writing the value it already has is not one). home.js writes it only
// through the `hidden` property; happy-dom's MutationObserver loses the old
// value of an empty attribute, so the property is watched instead.
function hiddenFlips(t) {
  let d = null;
  for (let p = Object.getPrototypeOf(t.section); p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, 'hidden');
  const flips = [];
  Object.defineProperty(t.section, 'hidden', {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) { if (!!v !== d.get.call(this)) flips.push(!!v); d.set.call(this, v); }
  });
  return () => flips;
}

await run('without Uptime Kuma, library lines alone show the log, never as an outage', async (make) => {
  // As the server renders it (status_feed.home_off): shown, so nothing moves.
  const t = make({ serverHidden: false, answer: answer('off', [], [lib(20, 'Movie Added: Dune (2021)', 2)]) });
  const flips = hiddenFlips(t);
  await t.open();
  check('shown', t.section.hidden === false && JSON.stringify(t.texts()) === JSON.stringify(['Movie Added: Dune (2021)']), t.texts());
  check('a library line, not an outage', t.slots()[0].getAttribute('data-type') === 'library');
  await t.poll(answer('off', [], [lib(20, 'Movie Added: Dune (2021)', 2), note(5, 'Maintenance tonight', 10)]));
  check('a note joins it', t.section.hidden === false && JSON.stringify(t.texts()) === JSON.stringify(['Movie Added: Dune (2021)', 'Maintenance tonight']), t.texts());
  check('the hidden attribute never changed (CLS 0)', flips().length === 0, flips().length);
});

await run('without Uptime Kuma and nothing to show, the server\'s hidden section stays put', async (make) => {
  const t = make({ serverHidden: true, answer: answer('off', [], []) });
  const flips = hiddenFlips(t);
  await t.open();
  check('hidden', t.section.hidden === true);
  check('the hidden attribute never changed (CLS 0)', flips().length === 0, flips().length);
  await t.poll(answer('off', [], [lib(20, 'Movie Added: Dune (2021)', 2)]));
  check('a library line arriving later brings it back', t.section.hidden === false && t.texts()[0] === 'Movie Added: Dune (2021)', t.texts());
});

// ---- Turning back through the history ----

const HISTORY = answer('ok', [], QUIET_OK.items.concat([note(11, 'Older 1', 400), note(12, 'Older 2', 500), note(13, 'Older 3', 600)]));
// Newest first, as the events: QUIET_OK's five, then the three older notes.
const ORDER = ['Requests are slow tonight', 'Downloads paused until 9pm', 'Books is back, down 3 min', 'Books is down', 'New shelves on Books', 'Older 1', 'Older 2', 'Older 3'];

function scroll(t, deltaY, deltaMode = 0) {
  const e = new t.win.WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true });
  t.wheel.dispatchEvent(e);
  return e.defaultPrevented;
}
function key(t, name) {
  const e = new t.win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  t.wheel.dispatchEvent(e);
  return e.defaultPrevented;
}
function touch(t, type, y) {
  const e = new t.win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
  t.wheel.dispatchEvent(e);
  return e.defaultPrevented;
}
const latestBtn = (t) => t.section.querySelector('[data-event-latest]');

await run('the wheel can be focused and named for the keys', async (make) => {
  const t = make({ answer: HISTORY });
  await t.open();
  check('focusable', t.wheel.getAttribute('tabindex') === '0');
  check('named, with the keys to use', t.wheel.getAttribute('aria-label') === 'Event log, use arrow keys to see older events' && t.wheel.getAttribute('role') === 'group');
  check('a visible focus ring from the theme', /\.ws-wheel:focus-visible \{ outline: 2px solid rgb\(var\(--color-accent\)\)/.test(THEME_CSS));
  check('"Latest" is there but hidden while following the newest', latestBtn(t) && latestBtn(t).hidden === true && latestBtn(t).textContent === 'Latest' && latestBtn(t).type === 'button');
  check('"Latest" moves nothing when it shows (absolute, in the gap below)', /\.ws-wheel-latest \{\s*position: absolute;/.test(THEME_CSS));
});

await run('the mouse wheel turns one notch per step, back and forward, and lets the page scroll at either end', async (make) => {
  const t = make({ answer: HISTORY });
  await t.open();
  check('following the newest, scrolling down the page is not taken', scroll(t, 100) === false && t.texts()[0] === ORDER[0]);
  const oldFront = t.slots()[0];
  check('scrolling up is taken', scroll(t, -100) === true);
  check('one notch back: the next older event is at the front', t.texts()[0] === ORDER[1], t.texts());
  check('the old front goes down under the front edge', oldFront.classList.contains('is-leaving') && oldFront.style.getPropertyValue('--i') === '-1');
  await t.clock.advance(800);
  check('five settled lines from there', JSON.stringify(t.texts()) === JSON.stringify(ORDER.slice(1, 6)), t.texts());
  check('the front line is the readable one, with its full text as its title', t.slots()[0].getAttribute('aria-hidden') === null && t.slots()[0].title === ORDER[1] && t.slots().slice(1).every((el) => el.getAttribute('aria-hidden') === 'true'));
  check('"Latest" shows', latestBtn(t).hidden === false);
  check('turning is not announced', t.announced() === '');
  check('scrolling down turns forward again', scroll(t, 100) === true && t.texts()[0] === ORDER[0]);
  check('"Latest" hides again at the newest', latestBtn(t).hidden === true);
  // A trackpad: small deltas add up to one notch.
  check('a small scroll is taken but turns nothing yet', scroll(t, -10) === true && scroll(t, -10) === true && scroll(t, -10) === true && t.texts()[0] === ORDER[0]);
  scroll(t, -10);
  check('enough of them turn one notch', t.texts()[0] === ORDER[1], t.texts());
  // Lines (deltaMode 1) count as a step each.
  scroll(t, -1, 1);
  check('a line-mode step turns a notch', t.texts()[0] === ORDER[2], t.texts());
  for (let i = 0; i < 10; i++) scroll(t, -100);
  check('at the oldest the oldest event is at the front', t.texts()[0] === ORDER[7], t.texts());
  check('and scrolling further up is the page\'s again', scroll(t, -100) === false);
  check('a pinch (ctrl + wheel) is never taken', (() => { const e = new t.win.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }); Object.defineProperty(e, 'ctrlKey', { value: true }); t.wheel.dispatchEvent(e); return !e.defaultPrevented; })());
});

await run('the keys turn it: arrows one notch, Home the newest, End the oldest', async (make) => {
  const t = make({ answer: HISTORY });
  await t.open();
  check('Down at the newest does nothing and leaves the key to the page', key(t, 'ArrowDown') === false && t.texts()[0] === ORDER[0]);
  check('Up turns back one notch', key(t, 'ArrowUp') === true && t.texts()[0] === ORDER[1]);
  check('Up again', key(t, 'ArrowUp') === true && t.texts()[0] === ORDER[2]);
  check('Down turns forward', key(t, 'ArrowDown') === true && t.texts()[0] === ORDER[1]);
  check('End: the oldest at the front', key(t, 'End') === true && t.texts()[0] === ORDER[7], t.texts());
  await t.clock.advance(800);
  check('only what is left behind it (nothing older)', JSON.stringify(t.texts()) === JSON.stringify(['Older 3']), t.texts());
  check('Up at the oldest leaves the key to the page', key(t, 'ArrowUp') === false);
  check('Home: the newest again', key(t, 'Home') === true && t.texts()[0] === ORDER[0]);
  await t.clock.advance(800);
  check('five lines again', t.settled().length === 5 && JSON.stringify(t.texts()) === JSON.stringify(ORDER.slice(0, 5)), t.texts());
  check('other keys are left alone', key(t, 'PageUp') === false && key(t, 'a') === false);
});

await run('a drag turns it, and passes to the page at either end', async (make) => {
  const t = make({ answer: HISTORY });
  await t.open();
  touch(t, 'touchstart', 100);
  check('dragging up at the newest is the page\'s scroll', touch(t, 'touchmove', 80) === false && t.texts()[0] === ORDER[0]);
  touch(t, 'touchend');
  touch(t, 'touchstart', 100);
  check('dragging down is taken from the first move', touch(t, 'touchmove', 110) === true && t.texts()[0] === ORDER[0]);
  touch(t, 'touchmove', 126);
  check('far enough turns one notch back', t.texts()[0] === ORDER[1], t.texts());
  touch(t, 'touchmove', 152);
  check('and another', t.texts()[0] === ORDER[2], t.texts());
  touch(t, 'touchmove', 120);
  check('dragging back up turns forward', t.texts()[0] === ORDER[1], t.texts());
  touch(t, 'touchend');
  check('a move with no touch begun does nothing', touch(t, 'touchmove', 400) === false && t.texts()[0] === ORDER[1]);
});

await run('turned back, a new event never moves the view; "Latest" brings it back', async (make) => {
  const t = make({ answer: HISTORY });
  await t.open();
  key(t, 'ArrowUp');
  key(t, 'ArrowUp');
  await t.clock.advance(800);
  const view = JSON.stringify(t.texts());
  await t.poll(answer('down', [outage(30, 'Plex', 0)], HISTORY.items.concat([note(31, 'Hello', 1)])));
  await t.clock.advance(800);
  check('the same lines stay in view', JSON.stringify(t.texts()) === view, t.texts());
  check('the outage is pinned above all the same', JSON.stringify(t.pinnedTexts()) === JSON.stringify(['Plex is down']));
  check('the new events are announced once all the same', t.announced() === 'Problem: Plex is down. Note: Hello', t.announced());
  check('"Latest" still shows', latestBtn(t).hidden === false);
  await t.clock.advance(7000);
  await t.poll();
  check('the same answer again announces nothing', t.announced() === '' && JSON.stringify(t.texts()) === view);
  latestBtn(t).click();
  await t.clock.advance(800);
  check('"Latest": the newest at the front, the outage still pinned and not on the wheel', JSON.stringify(t.texts()) === JSON.stringify(['Hello'].concat(ORDER.slice(0, 4))) && t.pinned().length === 1, t.texts());
  check('and it hides', latestBtn(t).hidden === true);
  check('nothing announced twice', t.announced() === '');
});

await run('turned back, it goes back to the newest after 15 s untouched', async (make) => {
  const t = make({ answer: HISTORY });
  await t.open();
  scroll(t, -100);
  await t.clock.advance(10000);
  scroll(t, -100);
  await t.clock.advance(10000);
  check('a turn starts the 15 s again', t.texts()[0] === ORDER[2], t.texts());
  await t.clock.advance(5500);
  check('then it is back at the newest', t.texts()[0] === ORDER[0] && latestBtn(t).hidden === true, t.texts());
  await t.clock.advance(800);
  check('five settled lines', t.settled().length === 5);
});

await run('fast turning never shows more than five settled lines', async (make) => {
  const t = make({ answer: HISTORY });
  await t.open();
  let worst = 0;
  let docWorst = 0;
  for (let i = 0; i < 6; i++) {
    scroll(t, -100);
    worst = Math.max(worst, t.settled().length);
    docWorst = Math.max(docWorst, t.all().length);
    await t.clock.advance(120);
  }
  for (let i = 0; i < 6; i++) { scroll(t, 100); worst = Math.max(worst, t.settled().length); docWorst = Math.max(docWorst, t.all().length); }
  check('at most five settled lines', worst <= 5, worst);
  check('at most six in the document (one fading)', docWorst <= 6, docWorst);
  await t.clock.advance(800);
  check('back at the newest, five lines', t.all().length === 5 && t.texts()[0] === ORDER[0]);
});

await run('reduced motion: each notch crossfades', async (make) => {
  const t = make({ answer: HISTORY, reduced: true });
  await t.open();
  const before = t.all();
  scroll(t, -100);
  check('the old set fades out in place', before.every((el) => el.classList.contains('is-leaving')) && before.every((el, i) => slot(el) === 4 - i));
  check('the new set is there at once', JSON.stringify(t.texts()) === JSON.stringify(ORDER.slice(1, 6)), t.texts());
});

await run('nothing to turn: the quiet line, and leaving the page', async (make) => {
  const t = make({ answer: answer('ok', [], []) });
  await t.open();
  check('the quiet line takes no scroll and no key', scroll(t, -100) === false && key(t, 'ArrowUp') === false);
  const u = make({ answer: HISTORY });
  await u.open();
  scroll(u, -100);
  u.ctl.abort();
  check('after leaving the page the wheel takes nothing', scroll(u, -100) === false && key(u, 'ArrowUp') === false);
  await u.clock.advance(20000);
  check('and no return runs', u.texts()[0] === ORDER[1]);
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
