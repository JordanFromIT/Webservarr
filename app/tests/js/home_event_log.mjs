// Home's event log (app/static/js/pages/home.js, createEventLog): the real
// Home page module run in happy-dom (a dev-only dependency) over the page's
// own markup (index.html), with a scripted /api/status/feed, a fake clock for
// the wheel's turns and a fake shell (WS.swr and WS.arrive written as shell.js
// does them). The other sections' reads answer nothing.
//
// Covers: the feed's states (ok, down, unavailable, off, empty, a failed
// read); events newest at the front (slot 0, last in the document), at most
// four lines; an outage as its two events; the tick colours by kind; relative
// times; only the front line readable and titled; a new event turning the
// wheel one notch (several, one notch each, in order) and announced once;
// never more than four settled lines; reduced motion crossfading at once;
// text written as text; a section the server rendered hidden coming back;
// library lines (grey tick, a grab's muted note) and an open outage staying
// on the wheel under a burst of them.
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
const answer = (state, open, items) => ({ state, open, items });

const QUIET_OK = answer('ok', [], [
  note(1, 'New shelves on Books', 300),
  back(2, 'Books', 200, 197),
  note(3, 'Downloads paused until 9pm', 35, true),
  note(4, 'Requests are slow tonight', 4)
]);

// ---------------------------------------------------------------------------

await run('the section sits right above Service Health, with Home\'s heading and a wheel that holds its room', async (make) => {
  const t = make({ answer: QUIET_OK });
  const order = t.doc.querySelectorAll('[data-arrive]');
  const keys = Array.from(order).map((n) => n.getAttribute('data-arrive'));
  check('it arrives just before Service Health', keys.indexOf('feed') === keys.indexOf('services') - 1, keys);
  check('the next section is Service Health', t.section.nextElementSibling && t.section.nextElementSibling.getAttribute('data-arrive') === 'services');
  const h = t.section.querySelector('h3');
  check('the heading is "Event log", styled like the other sections, closer to its wheel', h && h.textContent === 'Event log' && h.className === 'text-xl font-bold text-frosted-blue' && h.parentNode.className === 'flex items-center gap-3 mb-2');
  check('a compact section: less room below it than between the other sections', t.section.className === '-mb-3');
  const icon = h.previousElementSibling;
  check('its icon follows the section icons setting', icon && icon.classList.contains('ws-section-icon') && icon.getAttribute('aria-hidden') === 'true');
  check('labelled by its heading', t.section.getAttribute('aria-labelledby') === h.id);
  check('a skeleton front line until the answer', t.wheel.querySelector('.skel') && t.wheel.children.length === 1);
  const live = t.section.querySelector('[data-event-announce]');
  check('one polite live region', live && live.getAttribute('aria-live') === 'polite' && live.classList.contains('sr-only'));
  check('no link (there is no feed page)', !t.section.querySelector('a'));
});

await run('ok: the newest four events, newest at the front, each with its tick and time', async (make) => {
  const t = make({ answer: answer('ok', [], QUIET_OK.items.concat([note(9, 'Oldest note', 600)])) });
  await t.open();
  check('it read the feed once', t.WS.reads === 1);
  check('the skeleton is gone and the section shown', !t.wheel.querySelector('.skel') && t.section.hidden === false);
  check('four lines, never more', t.all().length === 4, t.all().length);
  check('newest at the front (slot 0), the oldest shown at the back', JSON.stringify(t.texts()) === JSON.stringify(['Requests are slow tonight', 'Downloads paused until 9pm', 'Books is back, down 3 min', 'Books is down']), t.texts());
  check('in the document oldest first, so the newest is last', lineText(t.all()[3]) === 'Requests are slow tonight');
  const types = t.slots().map((el) => el.getAttribute('data-type'));
  check('ticks by kind: note, important, back, down', JSON.stringify(types) === JSON.stringify(['note', 'important', 'up', 'down']), types);
  check('every line has its 2px tick, hidden from screen readers', t.all().every((el) => el.firstElementChild.className === 'ws-wheel__mark' && el.firstElementChild.getAttribute('aria-hidden') === 'true'));
  const times = t.slots().map((el) => el.querySelector('time').textContent);
  check('relative times', JSON.stringify(times) === JSON.stringify(['4 min ago', '35 min ago', '3 h ago', '3 h ago']), times);
  check('a machine-readable time too', t.slots()[0].querySelector('time').getAttribute('datetime') === QUIET_OK.items[3].created_at);
  const front = t.slots()[0];
  check('only the front line is readable', front.getAttribute('aria-hidden') === null && t.slots().slice(1).every((el) => el.getAttribute('aria-hidden') === 'true'));
  check('the full text is in the title (one line, ellipsis on a phone)', front.title === 'Requests are slow tonight');
  check('notes are named for screen readers, outages are not', front.querySelector('.sr-only').textContent === 'Note: ' && t.slots()[1].querySelector('.sr-only').textContent === 'Important: ' && !t.slots()[2].querySelector('.sr-only'));
  check('nothing is announced on the first answer', t.announced() === '');
  check('nothing turned in (no line entering)', !t.wheel.querySelector('.is-entering'));
  check('two polls: the live sections (30 s) carry the feed', !!t.WS && t.WS.reads === 1);
});

await run('down: an open outage leads, in the outage colour', async (make) => {
  const t = make({ answer: answer('down', [outage(7, 'Plex', 2)], [note(3, 'Movie night Friday', 90)]) });
  await t.open();
  const front = t.slots()[0];
  check('the outage is at the front', lineText(front) === 'Plex is down' && front.getAttribute('data-type') === 'down');
  check('just now / minutes', front.querySelector('time').textContent === '2 min ago');
  check('the note behind it', lineText(t.slots()[1]) === 'Movie night Friday');
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
  await t.poll(answer('down', [outage(8, 'Requests', 0)], QUIET_OK.items));
  const entering = t.all()[t.all().length - 1];
  check('the new line is last in the document, on the front notch', lineText(entering) === 'Requests is down' && slot(entering) === 0);
  check('the old front moved back one notch', slot(oldFront) === 1 && oldFront.getAttribute('aria-hidden') === 'true');
  check('the new front is readable and titled', entering.getAttribute('aria-hidden') === null && entering.title === 'Requests is down');
  check('the oldest line turns away over the top', t.all().filter((el) => el.classList.contains('is-leaving')).length === 1);
  check('announced once, as itself', t.announced() === 'Requests is down');
  await t.clock.advance(800);
  check('after the turn: four settled lines', t.all().length === 4 && t.settled().length === 4, t.all().length);
  check('in order', JSON.stringify(t.texts()) === JSON.stringify(['Requests is down', 'Requests are slow tonight', 'Downloads paused until 9pm', 'Books is back, down 3 min']), t.texts());
  await t.clock.advance(7000);
  check('the announcement clears later (no double reading in browse mode)', t.announced() === '');
  await t.poll();
  check('the same answer again changes nothing', t.all().length === 4 && t.announced() === '');
});

await run('the outage resolves: its return turns in, its start moves back', async (make) => {
  const t = make({ answer: answer('down', [outage(8, 'Requests', 3)], QUIET_OK.items) });
  await t.open();
  const down = t.slots()[0];
  check('the outage is at the front', t.slots()[0] === down && lineText(down) === 'Requests is down');
  await t.poll(answer('ok', [], [back(8, 'Requests', 3, 0)].concat(QUIET_OK.items)));
  await t.clock.advance(800);
  check('back at the front, in the back-up colour', t.texts()[0] === 'Requests is back, down 3 min' && t.slots()[0].getAttribute('data-type') === 'up');
  check('the same "is down" line, one notch back (not rebuilt)', t.slots()[1] === down && lineText(down) === 'Requests is down');
  check('announced', t.announced() === 'Requests is back, down 3 min');
  check('four lines', t.all().length === 4);
});

await run('several new events: one notch each, in order, then four lines', async (make) => {
  const t = make({ answer: QUIET_OK });
  await t.open();
  await t.poll(answer('down', [outage(8, 'Requests', 1), outage(9, 'Books', 0)], QUIET_OK.items.concat([note(10, 'Hello', 2)])));
  check('first turn at once: the oldest new event at the front', t.texts()[0] === 'Hello', t.texts());
  check('never more than one line fading out', t.all().filter((el) => el.classList.contains('is-leaving')).length <= 1);
  check('no announcement mid-burst', t.announced() === '');
  await t.clock.advance(710);
  check('second turn', t.texts()[0] === 'Requests is down', t.texts());
  await t.clock.advance(710);
  check('third turn: the newest at the front', t.texts()[0] === 'Books is down', t.texts());
  check('the newest is announced, once', t.announced() === 'Books is down');
  for (let i = 0; i < 3; i++) {
    check('never more than four settled lines or five in the document', t.settled().length <= 4 && t.all().length <= 5, t.all().length);
    await t.clock.advance(300);
  }
  await t.clock.advance(800);
  check('settled: exactly four', t.all().length === 4 && t.settled().length === 4);
  check('newest four', JSON.stringify(t.texts()) === JSON.stringify(['Books is down', 'Requests is down', 'Hello', 'Requests are slow tonight']), t.texts());
});

await run('a deleted note: the line goes, nothing is announced, nothing turns in', async (make) => {
  const t = make({ answer: answer('ok', [], QUIET_OK.items.concat([note(9, 'Oldest note', 600)])) });
  await t.open();
  await t.poll(answer('ok', [], QUIET_OK.items.slice(0, 3).concat([note(9, 'Oldest note', 600)])));
  await t.clock.advance(800);
  check('the deleted note is gone and the older one came into view', JSON.stringify(t.texts()) === JSON.stringify(['Downloads paused until 9pm', 'Books is back, down 3 min', 'Books is down', 'New shelves on Books']), t.texts());
  check('not announced', t.announced() === '');
  check('four lines', t.all().length === 4);
});

await run('reduced motion: the set crossfades at once, nothing turns', async (make) => {
  const t = make({ answer: QUIET_OK, reduced: true });
  await t.open();
  const before = t.all();
  await t.poll(answer('down', [outage(8, 'Requests', 1), outage(9, 'Books', 0)], QUIET_OK.items));
  check('every old line fades out where it is', before.every((el) => el.classList.contains('is-leaving') && el.getAttribute('aria-hidden') === 'true'));
  check('the final set is there at once, no steps', JSON.stringify(t.texts()) === JSON.stringify(['Books is down', 'Requests is down', 'Requests are slow tonight', 'Downloads paused until 9pm']), t.texts());
  check('every old line kept its notch (no move, only a fade)', before.every((el, i) => slot(el) === 3 - i));
  check('the newest announced', t.announced() === 'Books is down');
  await t.clock.advance(800);
  check('four lines after the fade', t.all().length === 4 && t.settled().length === 4);
});

await run('text is written as text', async (make) => {
  const t = make({ answer: answer('ok', [], [note(1, '<img src=x onerror=alert(1)> & <b>bold</b>', 3)]) });
  await t.open();
  check('no element from the text', !t.wheel.querySelector('img') && !t.wheel.querySelector('b'));
  check('the text as written', t.texts()[0] === '<img src=x onerror=alert(1)> & <b>bold</b>');
});

await run('a kept copy paints at once; what happened since turns in', async (make) => {
  const t = make({ cached: QUIET_OK, answer: answer('down', [outage(8, 'Requests', 0)], QUIET_OK.items) });
  await t.open();
  await t.clock.advance(800);
  check('the new event is at the front', t.texts()[0] === 'Requests is down');
  check('and announced', t.announced() === 'Requests is down');
  check('four lines', t.all().length === 4);
});

await run('leaving the page: no turn runs afterwards', async (make) => {
  const t = make({ answer: QUIET_OK });
  await t.open();
  await t.poll(answer('down', [outage(8, 'Requests', 1), outage(9, 'Books', 0)], QUIET_OK.items));
  check('the first turn ran', t.texts()[0] === 'Requests is down');
  t.ctl.abort();
  await t.clock.advance(5000);
  check('the second never does once the page is left', t.texts()[0] === 'Requests is down' && t.announced() === '');
});

// ---- Library lines (Sonarr, Radarr, Chaptarr webhooks) ----

const lib = (id, text, minsAgo, note = '') => ({ id, source: 'library', text, note, service: null, important: false, resolved: true, started_at: null, ended_at: null, created_at: iso(minsAgo), at: iso(minsAgo) });
const THEME_CSS = readFileSync(join(STATIC, 'css/theme.css'), 'utf8');

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

await run('an open outage stays on the wheel under a burst of 10 library lines', async (make) => {
  const t = make({ answer: answer('down', [outage(7, 'Plex', 30)], [note(3, 'A note', 60)]) });
  await t.open();
  const burst = [];
  for (let i = 0; i < 10; i++) burst.push(lib(100 + i, 'Episode Added: The Bear S03E0' + i, 10 - i));
  await t.poll(answer('down', [outage(7, 'Plex', 30)], burst.concat([note(3, 'A note', 60)])));
  let lost = 0;
  for (let k = 0; k < 12; k++) {
    if (!t.texts().includes('Plex is down')) lost += 1;
    check('never more than four settled lines', t.settled().length <= 4, t.settled().length);
    await t.clock.advance(710);
  }
  await t.clock.advance(800);
  check('the outage never left the wheel during the burst', lost === 0, lost);
  check('settled: the newest three library lines and the outage, four in all', JSON.stringify(t.texts()) === JSON.stringify(['Episode Added: The Bear S03E09', 'Episode Added: The Bear S03E08', 'Episode Added: The Bear S03E07', 'Plex is down']), t.texts());
  check('the outage is still in its colour', t.slots()[3].getAttribute('data-type') === 'down');
  await t.poll(answer('ok', [], [back(7, 'Plex', 30, 0)].concat(burst)));
  await t.clock.advance(800);
  check('resolved, it is no longer held: its return leads and the start goes', t.texts()[0] === 'Plex is back, down 30 min' && !t.texts().includes('Plex is down'), t.texts());
});

await run('a resolved outage is not held: library lines push it off like any line', async (make) => {
  const items = [back(7, 'Plex', 90, 80)];
  for (let i = 0; i < 5; i++) items.unshift(lib(200 + i, 'Movie Added: Film ' + i, 50 - i));
  const t = make({ answer: answer('ok', [], items) });
  await t.open();
  check('the newest four only', t.all().length === 4 && t.texts().every((x) => x.indexOf('Movie Added') === 0), t.texts());
});

await run('without Uptime Kuma, library lines alone leave the log hidden', async (make) => {
  const t = make({ serverHidden: true, answer: answer('off', [], [lib(20, 'Movie Added: Dune (2021)', 2)]) });
  await t.open();
  check('hidden, as the server rendered it', t.section.hidden === true);
  await t.poll(answer('off', [], [lib(20, 'Movie Added: Dune (2021)', 2), note(5, 'Maintenance tonight', 10)]));
  check('a note brings it back, library lines with it', t.section.hidden === false && JSON.stringify(t.texts()) === JSON.stringify(['Movie Added: Dune (2021)', 'Maintenance tonight']), t.texts());
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
