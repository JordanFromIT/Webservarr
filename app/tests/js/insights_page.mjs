// Insights (app/static/js/pages/insights.js) run for real in happy-dom (a
// dev-only dependency) over the page's own markup (insights.html), with a
// scripted network, a fake clock and a fake shell (WS.arrive and WS.getJSON
// written as shell.js does them). Covers: the skeletons and each section's one
// write in top-down order, Right now and its 30 s refresh, People, a section
// that fails while the other draws (and its Try again), Plex unavailable, the
// empty states, text only, the person dialog (and a key that is no one's), a
// page that was left, and the sections in Plex's layout: Top users (cards,
// tinted rows, pictures, the arrows), the listening and reading history (the
// stacked bars, the axis, legend and totals, its three filters) and Top
// played (four columns, their banners, covers on this origin only).
//
// INSIGHTS_JS=<path> runs the same cases against another copy of the module.
// Run: node app/tests/js/insights_page.mjs (npm run test:js; CI js-checks).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const MODULE_PATH = process.env.INSIGHTS_JS || join(STATIC, 'js/pages/insights.js');
const HTML_PATH = join(STATIC, 'insights.html');

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

if (!existsSync(MODULE_PATH) || !existsSync(HTML_PATH)) {
  report('FAIL Insights: insights.js or insights.html does not exist');
  process.exit(1);
}
const HTML = readFileSync(HTML_PATH, 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

function fakeClock() {
  let now = 0;
  let ids = 0;
  const due = new Map();
  return {
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

const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
const pageModule = await import(dataUrl(readFileSync(MODULE_PATH, 'utf8')));

function network() {
  const handlers = [];
  const calls = [];
  return {
    calls,
    on(prefix, fn) { handlers.unshift({ prefix, fn }); },
    urls(prefix) { return calls.filter((c) => c.url.indexOf(prefix) === 0).map((c) => c.url); },
    fetch(url, init) {
      calls.push({ url, init });
      const h = handlers.find((x) => url.indexOf(x.prefix) === 0);
      if (!h) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve(h.fn(url, init)).then((r) => {
        const res = r || { body: {} };
        const status = res.status || 200;
        return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(res.body) };
      });
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fakeShell(doc, clock, net) {
  const arr = { order: [], done: {}, queue: {}, gate: false };
  const WS = {
    arrived: [],
    data: { user: { username: 'admin' } },
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
    getJSON(url, opts) {
      return net.fetch(url, opts && opts.signal ? { signal: opts.signal } : undefined).then((r) => {
        if (!r.ok) {
          return r.json().then((body) => { const e = new Error('HTTP ' + r.status); e.status = r.status; e.body = body; throw e; });
        }
        return r.json();
      });
    }
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

const PAGE = /<div id="wsPage"[\s\S]*<\/main>/;

function visit(o = {}) {
  const win = new Window({ url: 'https://ws.test/insights' });
  const doc = win.document;
  doc.body.innerHTML = HTML.match(PAGE)[0].replace(/<\/main>$/, '');
  const clock = fakeClock();
  const net = network();
  const ctl = new win.AbortController();
  const WS = fakeShell(doc, clock, net);
  const polls = [];
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win);
  set('document', doc);
  set('WS', WS);
  win.WS = WS;
  if (o.routes) o.routes(net);
  const ctx = {
    root: doc.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL('https://ws.test/insights'),
    data: WS.data,
    poll(fn, ms) { polls.push({ fn, ms }); return () => {}; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setTitle() {}
  };
  WS.arriveReset();
  return {
    win, doc, clock, net, ctl, WS, ctx, polls,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    text: (sel) => (doc.querySelector(sel) || { textContent: null }).textContent,
    mount: () => pageModule.mount(ctx),
    release() {
      for (const k of Object.keys(saved)) {
        if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k];
      }
    }
  };
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

// ---- What the API answers ----

const H = 3600000;
const M = 60000;
const SAM = 'a'.repeat(24);
const KIM = 'b'.repeat(24);
const ODD = 'c'.repeat(24);
const MARKUP = '<img src=x onerror=alert(1)>';
const hoursAgo = (h) => new Date(Date.now() - h * H).toISOString();
const NOW_ANSWER = {
  listening: [
    { key: SAM, name: 'Sam', book_id: 1, title: 'Dune', author: 'Frank Herbert', format: 'audio', where: 'web', state: 'playing', device: 'Chrome', percent: 42, updated_at: hoursAgo(0) },
    { key: KIM, name: 'Kim', book_id: 2, title: 'Emma', author: 'Jane Austen', format: 'audio', where: 'plex', state: 'paused', device: '', percent: null, updated_at: hoursAgo(0) }],
  reading: [], unavailable: [], checked_at: hoursAgo(0)
};
const TRACKING = { requests: '2026-10-11', reading: '2026-10-11', ebook_places: '2026-10-11', hours: '2026-09-28' };
const PEOPLE_ANSWER = {
  people: [
    { key: SAM, name: 'Sam', last_active: hoursAgo(3), last_what: 'listening', listened_ms_30d: 3 * H, plex_ms_30d: 30 * M,
      current: [{ book_id: 1, title: 'Dune', format: 'audio', where: 'web', percent: 42, updated_at: hoursAgo(3) }] },
    { key: ODD, name: MARKUP, last_active: null, last_what: null, listened_ms_30d: 0, plex_ms_30d: 0, current: [] }],
  unavailable: [], tracking: TRACKING
};
const MONDAYS = ['2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31',
  '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
const PERSON_ANSWER = {
  key: SAM, name: 'Sam', last_active: hoursAgo(3),
  totals: { listened_ms: 12 * H, plex_ms: 2 * H, finished: 1, pages_read: 420 },
  weekly: MONDAYS.map((week, i) => ({ week, web_ms: i * 10 * M, plex_ms: i % 3 ? 0 : 20 * M })),
  books: [{ book_id: 1, title: 'Dune', author: 'Frank Herbert', formats: ['audio'], percent: 42, finished: false, listened_ms: 3 * H, plex_ms: 30 * M, last_at: hoursAgo(3) }],
  requests: [{ key: SAM, name: 'Sam', title: 'Children of Dune', format: 'both', requested_at: '2026-10-01T09:00:00.000Z', book_id: null, started_at: null }],
  unavailable: [], tracking: TRACKING
};
const TRENDS_ANSWER = {
  period: '90d', bucket: 'week',
  buckets: MONDAYS.map((start, i) => ({ start, web_ms: (i + 1) * 10 * M, plex_ms: i % 2 ? 15 * M : 0, pages: i * 5 })),
  active: MONDAYS.map((week, i) => ({ week, people: i % 4 })),
  top_books: [{ book_id: 1, title: 'Dune', author: 'Frank Herbert', listened_ms: 5 * H, people: 2 }],
  top_authors: [{ name: 'Frank Herbert', listened_ms: 5 * H, people: 2 }],
  top_series: [],
  unavailable: [], tracking: TRACKING
};
const BOOKS_ANSWER = {
  abandoned: [{ key: KIM, name: 'Kim', book_id: 2, title: 'Emma', format: 'audio', percent: 12, chapter: 'Chapter 7', last_at: hoursAgo(24 * 40) }],
  never_opened: { count: 3, items: [{ book_id: 9, title: 'Walden', author: 'Henry David Thoreau', added_at: '2026-10-01T00:00:00.000Z' }] },
  finish: [{ book_id: 1, title: 'Dune', author: 'Frank Herbert', started: 3, finished: 1, rate: 33, drop_off: { chapter: 'Chapter 7', people: 2 } }],
  unavailable: [], tracking: TRACKING
};
const HEAT = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 4 && h === 21 ? 3 * H : (h === 8 ? 10 * M : 0))));
const HABITS_ANSWER = {
  split: { web_ms: 9 * H, plex_ms: 3 * H }, heatmap: HEAT,
  requested: { total: 2, read: 1, items: [
    { key: SAM, name: 'Sam', title: 'Dune', format: 'both', requested_at: '2026-10-01T09:00:00.000Z', book_id: 1, started_at: '2026-10-02T09:00:00.000Z' },
    { key: KIM, name: 'Kim', title: 'Not Here Yet', format: 'ebook', requested_at: '2026-10-02T09:00:00.000Z', book_id: null, started_at: null }] },
  unavailable: [], tracking: TRACKING
};
const TOP_USERS_ANSWER = {
  period: '7d',
  people: [
    { key: KIM, name: 'Kim', avatar: true, sessions: 12, total_ms: 39 * H, web_ms: 30 * H, plex_ms: 6 * H, ebook_ms: 3 * H },
    { key: SAM, name: 'sam', avatar: false, sessions: 1, total_ms: 45 * M, web_ms: 0, plex_ms: 45 * M, ebook_ms: 0 },
    { key: ODD, name: MARKUP, avatar: false, sessions: 2, total_ms: 2 * H, web_ms: 0, plex_ms: 0, ebook_ms: 2 * H }],
  unavailable: [], tracking: TRACKING
};
const WEEKS5 = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
const HISTORY_ANSWER = {
  period: '30d', bucket: 'week',
  buckets: WEEKS5.map((start, i) => ({ start, web_ms: (i + 1) * H, plex_ms: i === 4 ? 0 : 30 * M, ebook_ms: i === 2 ? 2 * H : 0 })),
  totals: { web_ms: 15 * H, plex_ms: 2 * H, ebook_ms: 2 * H }, reading: true,
  unavailable: [], tracking: TRACKING
};
const COVER = (id) => `/api/books/${id}/cover?v=1760000000`;
const PLAYED_ANSWER = {
  period: '30d',
  audiobooks: [
    { book_id: 1, title: 'Dune', author: 'Frank Herbert', cover_url: COVER(1), plays: 9, people: 3, listened_ms: 5 * H, plex_ms: 30 * M },
    { book_id: null, title: 'A book no longer in the library', author: '', cover_url: null, plays: 1, people: 1, listened_ms: 20 * M, plex_ms: 0 }],
  ebooks: [{ book_id: 4, title: 'Walden', author: 'Henry David Thoreau', cover_url: 'https://evil.test/x.png', reads: 2, finished: 1 }],
  authors: [{ name: 'Frank Herbert', plays: 9, reads: 1, people: 3, listened_ms: 5 * H, book_id: 1, cover_url: COVER(1) }],
  series: [],
  unavailable: [], tracking: TRACKING
};
const BOOK_ANSWER = {
  book_id: 1, title: 'Dune', author: 'Frank Herbert', series: 'Dune', formats: ['audio'],
  people: [{ key: SAM, name: 'Sam', formats: ['audio'], percent: 42, finished: false, listened_ms: 3 * H, plex_ms: 0, last_at: hoursAgo(3) }],
  totals: { started: 3, finished: 1, rate: 33, listened_ms: 5 * H, plex_ms: 30 * M },
  drop_off: { chapter: 'Chapter 7', people: 2 },
  requested_by: [{ key: KIM, name: 'Kim', requested_at: '2026-09-01T00:00:00.000Z' }],
  unavailable: []
};

function routes(over = {}) {
  return (net) => {
    net.on('/api/admin/insights/now', over.now || (() => ({ body: NOW_ANSWER })));
    net.on('/api/admin/insights/people', over.people || (() => ({ body: PEOPLE_ANSWER })));
    net.on('/api/admin/insights/person', over.person || (() => ({ body: PERSON_ANSWER })));
    net.on('/api/admin/insights/trends', over.trends || (() => ({ body: TRENDS_ANSWER })));
    net.on('/api/admin/insights/books', over.books || (() => ({ body: BOOKS_ANSWER })));
    net.on('/api/admin/insights/habits', over.habits || (() => ({ body: HABITS_ANSWER })));
    net.on('/api/admin/insights/book/', over.book || (() => ({ body: BOOK_ANSWER })));
    net.on('/api/admin/insights/top-users', over.topUsers || (() => ({ body: TOP_USERS_ANSWER })));
    net.on('/api/admin/insights/history', over.history || (() => ({ body: HISTORY_ANSWER })));
    net.on('/api/admin/insights/top-played', over.played || (() => ({ body: PLAYED_ANSWER })));
  };
}
const ALL = ['#insNow', '#insTopUsers', '#insHistory', '#insTopPlayed', '#insPeople', '#insTrends', '#insBooks', '#insHabits'];

async function mounted(make, over) {
  const t = make({ routes: routes(over) });
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  await flush();
  return t;
}
const rr = (n) => (n || '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------

await run('the skeletons hold the page, then each section arrives in one write, top down', async (make) => {
  const slow = deferred();
  const t = make({ routes: routes({ now: () => slow.promise.then(() => ({ body: NOW_ANSWER })) }) });
  const heading = t.q('#insPeople h2');
  const m = t.mount();
  await flush();
  check('both sections start busy, each with a skeleton', ALL.every((s) =>
    t.q(s).getAttribute('aria-busy') === 'true' && t.qa(s + ' [data-ins-body] .skel').length > 0));
  check('People waits for Right now above it', t.q('#insPeople').getAttribute('aria-busy') === 'true');
  slow.resolve();
  await flush();
  check('every section arrived, in order', t.WS.arrived.join(',') ===
    'ins-now,ins-top-users,ins-history,ins-top-played,ins-people,ins-trends,ins-books,ins-habits', t.WS.arrived);
  await t.clock.advance(1600);
  await m;
  check('not busy', ALL.every((s) => t.q(s).getAttribute('aria-busy') === 'false'));
  check('the headings are the same nodes (nothing above a body moved)', t.q('#insPeople h2') === heading);
  const now = t.qa('[data-ins-now]');
  check('Right now: who, what and how', now.length === 2 && rr(now[0].querySelector('div').textContent) === 'SamDunePlaying · in the web player · 42% through',
    now.map((n) => rr(n.textContent)));
  check('a Plex app listener', rr(now[1].textContent).includes('Paused · in a Plex app'));
  const sam = t.q(`[data-ins-person="${SAM}"]`);
  check('People: last active, what, time with its estimate, current books', rr(sam.textContent).includes('Last active 3 hr ago, listening') &&
    rr(sam.textContent).includes('3 hr 30 min listened in 30 days (30 min in Plex apps, an estimate)') && rr(sam.textContent).includes('Dune · 42%'),
    rr(sam.textContent));
  check('someone not active yet says so', rr(t.q(`[data-ins-person="${ODD}"]`).textContent).includes('Not active yet'));
});

await run('Right now is read again every 30 s and drawn again only when it changed', async (make) => {
  const answers = [NOW_ANSWER, NOW_ANSWER, Object.assign({}, NOW_ANSWER, { listening: [] })];
  let n = 0;
  const t = await mounted(make, { now: () => ({ body: answers[Math.min(n++, 2)] }) });
  check('one refresh, every 30 s', t.polls.length === 1 && t.polls[0].ms === 30000);
  const before = t.q('#insNow [data-ins-body]');
  t.polls[0].fn();
  await flush();
  check('the same answer leaves the section alone', t.q('#insNow [data-ins-body]') === before);
  t.polls[0].fn();
  await flush();
  check('a changed answer is drawn', rr(t.text('#insNow')).includes('No one is listening or reading right now.'));
  check('three reads of Right now', t.net.urls('/api/admin/insights/now').length === 3);
});

await run('one section failing leaves the other drawn, and Try again reloads it', async (make) => {
  let fail = true;
  const t = await mounted(make, { people: () => (fail ? { status: 500, body: {} } : { body: PEOPLE_ANSWER }) });
  check('Right now is drawn', t.qa('[data-ins-now]').length === 2);
  check('People says it could not load', rr(t.text('#insPeople [data-ins-failed]')).startsWith('This part couldn’t load.'));
  const again = t.q('#insPeople [data-ins-failed] button');
  check('its button is the neutral kind, never a blue primary', !!again && !/bg-primary/.test(again.className));
  fail = false;
  again.click();
  await flush();
  check('Try again draws People', t.qa('[data-ins-person]').length === 2);
});

await run('Plex unavailable is a line in place, and the empty states say what will show', async (make) => {
  const t = await mounted(make, {
    now: () => ({ body: { listening: [], reading: [], unavailable: [] } }),
    people: () => ({ body: { people: [], unavailable: ['plex'], tracking: {} } })
  });
  check('Right now is empty in words', rr(t.text('#insNow [data-ins-empty]')) === 'No one is listening or reading right now.');
  check('People: the Plex line', rr(t.text('#insPeople [data-ins-unavailable="plex"]')) === 'cloud_offPlex isn’t answering, so listening in Plex apps is missing here.');
  check('then its empty words', rr(t.text('#insPeople [data-ins-empty]')) === 'No one has listened or read yet.');
  check('nothing failed', !t.q('[data-ins-failed]'));
});

await run('a name with markup is text', async (make) => {
  const t = await mounted(make);
  check('the name is shown as written', rr(t.q(`[data-ins-person="${ODD}"]`).textContent).startsWith(MARKUP));
  check('no element came from it', t.qa('#wsPage img').every((img) => /^\/api\//.test(img.getAttribute('src'))) &&
    !t.q('#wsPage img[src="x"]'));
});

await run('a person opens in the dialog, with their history, and Close gives focus back', async (make) => {
  const t = await mounted(make);
  const row = t.q(`[data-ins-person="${SAM}"]`);
  row.focus();
  row.click();
  await flush();
  const dialog = t.q('#insDetail');
  check('the dialog is open', dialog.hasAttribute('open'));
  check('it asked for that person in this time zone', /^\/api\/admin\/insights\/person\?key=a{24}(&tz=.+)?$/.test(t.net.urls('/api/admin/insights/person')[0] || ''),
    t.net.urls('/api/admin/insights/person'));
  check('the title is the name', rr(t.text('#insDetailTitle')) === 'Sam');
  check('the totals, the Plex part an estimate', rr(t.text('[data-ins-totals]')).includes('In Plex apps (an estimate)') &&
    rr(t.text('[data-ins-totals]')).includes('Pages read, by Kavita’s count'));
  const weeks = t.qa('[data-ins-weekly] li');
  check('12 weeks, each said in words', weeks.length === 12 && weeks.every((li) => /^Week of /.test(li.querySelector('.sr-only').textContent)));
  check('the books', rr(t.text('[data-ins-book-row]')).includes('Frank Herbert · 42% through · 3 hr 30 min listened (the Plex part an estimate)'));
  check('requests, matched by title', rr(t.text('#insDetailBody')).includes('not in the library yet (matched by title)'));
  check('dates are day first, as the design writes them', rr(t.text('#insDetailBody')).includes('Asked 1 Oct 2026'), rr(t.text('#insDetailBody')));
  check('the Plex part of a bar is hatched, never a plain lighter fill', t.qa('[data-ins-weekly] .ins-bar.ins-est').length === 4 && t.qa('[data-ins-weekly] p .ins-est').length === 1 &&
    !/bg-frosted-blue\/35/.test(t.q('[data-ins-weekly]').innerHTML));
  check('the tallest week names its value', rr(t.text('[data-ins-weekly]')).includes('1 hr 50 min'));
  t.q('[data-ins-close]').click();
  await flush();
  check('Close closes it', !dialog.hasAttribute('open'));
  check('focus is back on the row', t.doc.activeElement === row);
  row.click();
  await flush();
  dialog.dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
  await flush();
  check('a click on the dim area closes it', !dialog.hasAttribute('open'));
  row.click();
  await flush();
  t.q('#insDetailBody').dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
  await flush();
  check('a click inside the box leaves it open', dialog.hasAttribute('open'));
});

await run('a key that is no one’s says so in the dialog', async (make) => {
  const t = await mounted(make, { person: () => ({ status: 404, body: { detail: 'gone' } }) });
  t.q(`[data-ins-person="${SAM}"]`).click();
  await flush();
  check('the words', rr(t.text('#insDetailBody')) === 'That person or book isn’t here any more.');
});

await run('a page that was left draws nothing', async (make) => {
  const slow = deferred();
  const t = make({ routes: routes({ now: () => slow.promise.then(() => ({ body: NOW_ANSWER })),
                                   people: () => slow.promise.then(() => ({ body: PEOPLE_ANSWER })) }) });
  const m = t.mount();
  await flush();
  t.ctl.abort();
  slow.resolve();
  await t.clock.advance(1600);
  await m;
  check('still the skeletons', ALL.every((s) => t.q(s).getAttribute('aria-busy') === 'true'));
});

await run('Trends, Books and Habits draw under the period picker, 90 days first', async (make) => {
  const t = await mounted(make);
  const pressed = t.qa('[data-period]').map((b) => b.getAttribute('data-period') + '=' + b.getAttribute('aria-pressed'));
  check('90 days is chosen', pressed.join(',') === '30d=false,90d=true,1y=false,all=false', pressed);
  check('each asked for 90 days, in this time zone where it matters',
    /^\/api\/admin\/insights\/trends\?period=90d(&tz=.+)?$/.test(t.net.urls('/api/admin/insights/trends')[0] || '') &&
    t.net.urls('/api/admin/insights/books')[0] === '/api/admin/insights/books?period=90d' &&
    /^\/api\/admin\/insights\/habits\?period=90d(&tz=.+)?$/.test(t.net.urls('/api/admin/insights/habits')[0] || ''));
  check('hours listened is the history now, not a second chart in Trends', !t.q('[data-ins-trend]'));
  check('pages read', t.qa('[data-ins-pages] li').length === 12);
  check('active people a week', t.qa('[data-ins-active] li').length === 12 &&
    /^Week of .*: 3 people$/.test(t.qa('[data-ins-active] li .sr-only')[3].textContent));
  check('the top lists are Top played now', !t.q('[data-ins-top]') && !!t.q('[data-ins-played="audiobooks"] [data-ins-book="1"]'));
  check('an empty column says so', rr(t.text('[data-ins-played="series"]')).includes('Nothing in this period.'));
  check('abandoned', rr(t.text('[data-ins-abandoned]')).includes('Emma') && rr(t.text('[data-ins-abandoned]')).includes('Kim · 12% · stopped in Chapter 7'));
  check('never opened', rr(t.text('[data-ins-never]')).includes('3 books no one has opened, as far as WebServarr can tell.'));
  check('finish rate and drop-off', rr(t.text('[data-ins-finish]')).includes('3 started · 1 finished · 33% · most who stopped, stopped in Chapter 7 (2 people)'));
  check('the split in words', rr(t.text('[data-ins-split]')).includes('Web player 9 hr · Plex apps 3 hr (an estimate)'));
  const table = t.q('[data-ins-heatmap] table');
  check('the heatmap is a table, 7 days by 24 hours', !!table && t.qa('[data-ins-heatmap] tbody tr').length === 7 &&
    t.qa('[data-ins-heatmap] tbody tr').every((tr) => tr.querySelectorAll('td').length === 24));
  check('the busiest hour named above it', rr(t.text('[data-ins-heatmap] [data-ins-busiest]')) === 'Busiest: Friday, 21:00');
  check('requested then read', rr(t.text('[data-ins-requested]')).includes('1 of 2 requested books were started by the person who asked (matched by title).'));
  check('no blue primary button anywhere', t.qa('#wsPage [class*="bg-primary"]').length === 0);
});

await run('the period picker reloads the three period sections and remembers the choice', async (make) => {
  const t = await mounted(make);
  t.q('[data-period="1y"]').click();
  await flush();
  check('1 year is chosen', t.q('[data-period="1y"]').getAttribute('aria-pressed') === 'true' && t.q('[data-period="90d"]').getAttribute('aria-pressed') === 'false');
  check('the three asked again for 1 year', ['trends', 'books', 'habits'].every((s) => t.net.urls('/api/admin/insights/' + s).length === 2 &&
    /period=1y/.test(t.net.urls('/api/admin/insights/' + s)[1])));
  check('Right now and People were not asked again', t.net.urls('/api/admin/insights/now').length === 1 && t.net.urls('/api/admin/insights/people').length === 1);
  check('remembered in this browser', t.win.localStorage.getItem('webservarr:insights:period') === '1y');
  const u = make({ routes: routes() });
  u.win.localStorage.setItem('webservarr:insights:period', 'all');
  const m = u.mount();
  await u.clock.advance(1600);
  await m;
  check('a visit starts from the remembered choice', /period=all/.test(u.net.urls('/api/admin/insights/trends')[0] || '') &&
    u.q('[data-period="all"]').getAttribute('aria-pressed') === 'true');
  const v = make({ routes: routes() });
  Object.defineProperty(v.win, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  const n = v.mount();
  await v.clock.advance(1600);
  await n;
  check('without storage the page still works, at 90 days', /period=90d/.test(v.net.urls('/api/admin/insights/trends')[0] || '') &&
    !v.q('[data-ins-failed]'));
});

await run('pages and requests not yet recorded say since when', async (make) => {
  const t = await mounted(make, {
    trends: () => ({ body: Object.assign({}, TRENDS_ANSWER, { buckets: TRENDS_ANSWER.buckets.map((b) => Object.assign({}, b, { pages: null })) }) }),
    habits: () => ({ body: Object.assign({}, HABITS_ANSWER, { requested: { total: 0, read: 0, items: [] } }) })
  });
  check('pages: since when', /Tracking started on .+2026\.$/.test(rr(t.text('[data-ins-pages] [data-ins-empty]'))));
  check('requests: none, and since when', rr(t.text('[data-ins-requested] [data-ins-empty]')).startsWith('No book requests in this period.Tracking started on'));
});

await run('a book opens from Top played and from a person, and Close gives focus back to what opened it', async (make) => {
  const t = await mounted(make);
  const top = t.q('[data-ins-played="audiobooks"] [data-ins-book="1"]');
  top.focus();
  top.click();
  await flush();
  check('the book is asked for', t.net.urls('/api/admin/insights/book/')[0] === '/api/admin/insights/book/1');
  check('its title, totals and drop-off', rr(t.text('#insDetailTitle')) === 'Dune' && rr(t.text('[data-ins-totals]')).includes('Finish rate33%') &&
    rr(t.text('#insDetailBody')).includes('Most who stopped, stopped in Chapter 7 (2 people).'));
  check('who asked for it', rr(t.text('#insDetailBody')).includes('Requested by') && rr(t.text('#insDetailBody')).includes('Kim'));
  t.q('[data-ins-close]').click();
  await flush();
  check('focus back on the top book', t.doc.activeElement === top);
  const row = t.q(`[data-ins-person="${SAM}"]`);
  row.focus();
  row.click();
  await flush();
  t.q('[data-ins-detail-book="1"]').click();
  await flush();
  check('a book from a person opens in the same dialog', t.q('#insDetail').hasAttribute('open') && rr(t.text('#insDetailTitle')) === 'Dune');
  t.q('[data-ins-close]').click();
  await flush();
  check('focus back on the person who led there', t.doc.activeElement === row);
});

await run('Plex unavailable in Trends and the history is a line, and their bars still draw', async (make) => {
  const t = await mounted(make, { trends: () => ({ body: Object.assign({}, TRENDS_ANSWER, { unavailable: ['plex'] }) }),
                                  history: () => ({ body: Object.assign({}, HISTORY_ANSWER, { unavailable: ['plex'] }) }) });
  check('the lines', !!t.q('#insTrends [data-ins-unavailable="plex"]') && !!t.q('#insHistory [data-ins-unavailable="plex"]'));
  check('the bars', t.qa('[data-ins-pages] li').length === 12 && t.qa('[data-ins-bars] li').length === 5);
});

await run('the approved design: hatched estimates, each chart names its tallest value, the heatmap key', async (make) => {
  const t = await mounted(make);
  check('the Plex part of a history bar is hatched, never a plain lighter fill', t.qa('[data-ins-bars] .ins-bar.ins-est').length === 4 &&
    !/bg-frosted-blue\/35/.test(t.q('#insHistory').innerHTML + t.q('#insHabits').innerHTML));
  check('the history legend names the estimate', rr(t.text('[data-ins-legend]')).includes('Audiobooks (Plex app), an estimate') &&
    t.qa('[data-ins-legend] .ins-est').length === 1);
  check('each Trends chart names its tallest value', rr(t.text('[data-ins-pages] [data-ins-peak]')) === '55 pages' &&
    rr(t.text('[data-ins-active] [data-ins-peak]')) === '3 people',
    [t.text('[data-ins-pages] [data-ins-peak]'), t.text('[data-ins-active] [data-ins-peak]')]);
  check('the split bar hatches the Plex part', t.qa('[data-ins-split] .ins-est').length === 1);
  check('the heatmap says where it is an estimate, in sight', rr(t.text('[data-ins-heatmap]')).includes('In your time zone. Plex app listening in it is an estimate.'));
  check('and has a Less to More key', /^Less\s*More$/.test(rr(t.text('[data-ins-heatmap] [data-ins-key]'))) && t.qa('[data-ins-heatmap] [data-ins-key] span.rounded-\\[3px\\]').length === 5);
  check('the busiest hour is the darkest cell', t.qa('[data-ins-heatmap] td.bg-frosted-blue').length === 1);
  check('an abandoned book says when it was last touched', /last touched \d{1,2} [A-Z][a-z]{2} \d{4}/.test(rr(t.text('[data-ins-abandoned]'))), rr(t.text('[data-ins-abandoned]')));
  check('never opened says how many of them are listed', rr(t.text('[data-ins-never]')).includes('The newest 1 are listed.'));
  check('a book with no library id is plain text, not a button', !t.q('[data-ins-requested] button[data-ins-book="null"]') &&
    t.qa('[data-ins-requested] button[data-ins-book]').length === 1);
});

await run('a history with nothing in it says so and draws no legend', async (make) => {
  const t = await mounted(make, { history: () => ({ body: Object.assign({}, HISTORY_ANSWER, {
    buckets: WEEKS5.map((start) => ({ start, web_ms: 0, plex_ms: 0, ebook_ms: 0 })), reading: false }) }),
  played: () => ({ body: Object.assign({}, PLAYED_ANSWER, { audiobooks: [] }) }) });
  check('nothing, in words', rr(t.text('[data-ins-history]')).startsWith('Nothing in the last 30 days.'), rr(t.text('[data-ins-history]')));
  check('and when ebook time will show', rr(t.text('#insHistory')).includes('Ebook time shows here once reading in Kavita is recorded.'));
  check('no legend, no bars', !t.q('[data-ins-legend]') && t.qa('#insHistory .ins-bar').length === 0);
  check('no note about times when no time is listed', !rr(t.text('#insTopPlayed')).includes('Times include listening in Plex apps'));
});

await run('a book opened from a person moves focus to Close, inside the dialog', async (make) => {
  const t = await mounted(make);
  t.q(`[data-ins-person="${SAM}"]`).click();
  await flush();
  const b = t.q('[data-ins-detail-book="1"]');
  b.focus();
  b.click();
  await flush();
  check('focus stays in the dialog', t.doc.activeElement === t.q('[data-ins-close]'));
});

await run('a start counted from Plex app time says it is an estimate', async (make) => {
  const t = await mounted(make, {
    books: () => ({ body: Object.assign({}, BOOKS_ANSWER, { finish: [Object.assign({}, BOOKS_ANSWER.finish[0], { started_plex: 1 })] }) }),
    book: () => ({ body: Object.assign({}, BOOK_ANSWER, { totals: Object.assign({}, BOOK_ANSWER.totals, { started_plex: 1 }) }) })
  });
  check('in the finish list', rr(t.text('[data-ins-finish]')).includes('3 started (1 from Plex app time, an estimate) · 1 finished · 33%'));
  t.q('[data-ins-finish] [data-ins-book="1"]').click();
  await flush();
  const totals = rr(t.text('[data-ins-totals]'));
  check('in the book', totals.includes('Started (1 from Plex app time, an estimate)3') && totals.includes('Finish rate (an estimate)33%'), totals);
});

await run('a book with no start from Plex app time keeps its plain labels', async (make) => {
  const t = await mounted(make);
  check('the finish list', !rr(t.text('[data-ins-finish]')).includes('Plex app time'));
  t.q('[data-ins-finish] [data-ins-book="1"]').click();
  await flush();
  const totals = rr(t.text('[data-ins-totals]'));
  check('the book', totals.includes('Started3Finished1Finish rate33%'), totals);
});

await run('Top users: a card a person, most time first, its rows tinted by their share', async (make) => {
  const t = await mounted(make);
  const cards = t.qa('#insTopUsers [data-ins-user]');
  check('the cards, in the answer’s order', cards.map((c) => c.getAttribute('data-ins-user')).join(',') === [KIM, SAM, ODD].join(','));
  const kim = cards[0];
  check('sessions and time as Plex says it', rr(kim.textContent).startsWith('K12 sessions1 day, 15 hrKim'), rr(kim.textContent));
  const rows = Array.from(kim.querySelectorAll('[data-ins-kind]'));
  check('three rows: site, Plex app, ebooks, with their times', rows.map((r) => rr(r.textContent)).join('|') ===
    'Audiobooks (site)30 hr|Audiobooks (Plex app), an estimate6 hr|Ebooks3 hr', rows.map((r) => rr(r.textContent)));
  check('each row tinted by its share of the most', rows.map((r) => r.style.getPropertyValue('--ins-a')).join(',') === '1.00,0.20,0.10',
    rows.map((r) => r.style.getPropertyValue('--ins-a')));
  check('each row in its kind’s tint and mark', rows[0].classList.contains('ins-tint-site') && !!rows[1].querySelector('.ins-est') &&
    !!rows[2].querySelector('.bg-media-book'));
  check('nothing in a kind is 0 min, untinted', rr(cards[1].querySelector('[data-ins-kind="web"]').textContent).endsWith('0 min') &&
    cards[1].querySelector('[data-ins-kind="web"]').style.getPropertyValue('--ins-a') === '0.00');
  const pic = kim.querySelector('img');
  check('a picture from this origin when plex.tv has one', !!pic && pic.getAttribute('src') === '/api/admin/insights/avatar?key=' + KIM &&
    pic.getAttribute('alt') === '' && pic.getAttribute('width') === '56');
  check('a letter circle under it, and alone without one', rr(kim.querySelector('.rounded-full').textContent) === 'K' &&
    !cards[1].querySelector('img') && rr(cards[1].querySelector('.rounded-full').textContent) === 'S');
  pic.dispatchEvent(new t.win.Event('error'));
  check('a picture that fails leaves the letter', !kim.querySelector('img') && rr(kim.querySelector('.rounded-full').textContent) === 'K');
  check('a name with markup is a letter, not markup', rr(cards[2].querySelector('.rounded-full').textContent) === '<');
  check('the estimate and the units in sight', rr(t.text('#insTopUsers')).includes('Plex app time is an estimate'));
  kim.focus();
  kim.click();
  await flush();
  check('a card opens the person', t.q('#insDetail').hasAttribute('open') && /key=b{24}/.test(t.net.urls('/api/admin/insights/person')[0] || ''));
  t.q('[data-ins-close]').click();
  await flush();
  check('and Close gives focus back to it', t.doc.activeElement === kim);
  const arrows = t.qa('[data-ins-page]');
  check('two arrows, quiet, never a blue primary', arrows.length === 2 && arrows.every((b) => !/bg-primary/.test(b.className)) &&
    arrows.every((b) => b.getAttribute('aria-label')));
  await t.clock.advance(10);
  check('the arrows say when there is nowhere to go (focus stays on them)', arrows.every((b) => b.getAttribute('aria-disabled') === 'true' && !b.disabled));
});

await run('Top users: its period asks again, and nobody in it says so', async (make) => {
  let answer = TOP_USERS_ANSWER;
  const t = await mounted(make, { topUsers: () => ({ body: answer }) });
  check('the last 7 days first, in this time zone', /^\/api\/admin\/insights\/top-users\?period=7d(&tz=.+)?$/.test(t.net.urls('/api/admin/insights/top-users')[0] || ''));
  answer = Object.assign({}, TOP_USERS_ANSWER, { people: [] });
  const select = t.q('#insTopUsersPeriod');
  select.value = '90d';
  select.dispatchEvent(new t.win.Event('change'));
  await flush();
  check('asked for 90 days', /period=90d/.test(t.net.urls('/api/admin/insights/top-users')[1] || ''));
  check('nobody, in words', rr(t.text('#insTopUsers [data-ins-empty]')) === 'No one listened or read in the last 90 days.');
  check('the other sections were not asked again', t.net.urls('/api/admin/insights/history').length === 1 && t.net.urls('/api/admin/insights/trends').length === 1);
});

await run('History: stacked bars on an axis of time, the legend and the totals', async (make) => {
  const t = await mounted(make);
  check('asked for 30 days, everyone, in this time zone', /^\/api\/admin\/insights\/history\?period=30d(&tz=.+)?$/.test(t.net.urls('/api/admin/insights/history')[0] || ''));
  const bars = t.qa('[data-ins-bars] li');
  check('a bar a week', bars.length === 5);
  const parts = Array.from(bars[2].querySelectorAll('.ins-bar'));
  check('ebooks on top, then Plex apps, then the site at the bottom', parts.map((b) => (b.className.match(/ins-site|ins-est|bg-media-book/) || [''])[0]).join(',') ===
    'bg-media-book,ins-est,ins-site', parts.map((b) => b.className));
  check('the top part has the round corners', /rounded-t-/.test(parts[0].className) && !/rounded-t-/.test(parts[2].className));
  check('heights against the top of the axis', parts.map((b) => b.style.height).join(',') === '33%,8%,50%', parts.map((b) => b.style.height));
  check('each bar said in words', /^Week of 21 Sept? 2026: 3 hr on the site, 30 min in Plex apps \(an estimate\), 2 hr of ebooks$/.test(
    rr(bars[2].querySelector('.sr-only').textContent)), rr(bars[2].querySelector('.sr-only').textContent));
  const ticks = t.qa('#insHistory .absolute.h-0 span:first-child').map((n) => n.textContent);
  check('the axis steps in whole hours', ticks.join(',') === '0,2 hr,4 hr,6 hr', ticks);
  check('each week named under its bar', /^7 Sept?$/.test(t.qa('#insHistory [aria-hidden="true"].ml-14 span').map((n) => n.textContent)[0] || ''));
  check('the legend', rr(t.text('[data-ins-legend]')) === 'Audiobooks (site)Audiobooks (Plex app), an estimateEbooks', rr(t.text('[data-ins-legend]')));
  check('the totals', rr(t.text('[data-ins-totals-line]')) === 'TotalsSite 15 hrPlex apps 2 hrEbooks 2 hr', rr(t.text('[data-ins-totals-line]')));
  check('what a bar is, and where the ebook time comes from', rr(t.text('[data-ins-history]')).includes('Each bar is a week, Monday first, in your time zone. Ebook time is the reading Kavita measured, by its day.'));
});

await run('History: media redraws what was read; whose and the period ask again', async (make) => {
  const t = await mounted(make);
  const media = t.q('#insHistoryMedia');
  media.value = 'ebook';
  media.dispatchEvent(new t.win.Event('change'));
  await flush();
  check('ebooks alone, nothing asked', t.net.urls('/api/admin/insights/history').length === 1 &&
    t.qa('[data-ins-bars] .ins-bar').length === 1 && t.qa('[data-ins-bars] .ins-bar.bg-media-book').length === 1);
  check('its legend and totals follow', rr(t.text('[data-ins-legend]')) === 'Ebooks' && rr(t.text('[data-ins-totals-line]')) === 'TotalsEbooks 2 hr');
  const whose = t.q('#insHistoryPerson');
  const names = Array.from(whose.options).map((o) => o.textContent);
  check('whose: everyone, then each person by name, from People', names.join('|') === `All users|${MARKUP}|Sam` && whose.value === '', names);
  whose.value = SAM;
  whose.dispatchEvent(new t.win.Event('change'));
  await flush();
  check('one person’s history is asked for by key', new RegExp(`^/api/admin/insights/history\\?period=30d&person=${SAM}(&tz=.+)?$`).test(t.net.urls('/api/admin/insights/history')[1] || ''),
    t.net.urls('/api/admin/insights/history'));
  check('and drawn still showing ebooks alone', t.qa('[data-ins-bars] .ins-bar.ins-site').length === 0);
  const period = t.q('#insHistoryPeriod');
  period.value = '7d';
  period.dispatchEvent(new t.win.Event('change'));
  await flush();
  check('the period asks again, for the same person', /period=7d&person=a{24}/.test(t.net.urls('/api/admin/insights/history')[2] || ''));
  const odd = t.q('#insTopPlayedPerson');
  check('Top played’s whose filter has everyone too, and kept everyone', odd.options.length === 3 && odd.value === '');
});

await run('Top played: four columns with banners, covers from this origin only, books open', async (make) => {
  const t = await mounted(make);
  const cols = t.qa('[data-ins-played]');
  check('audiobooks, ebooks, authors and series', cols.map((c) => c.getAttribute('data-ins-played')).join(',') === 'audiobooks,ebooks,authors,series');
  check('each named in its banner', cols.map((c) => c.querySelector('h3').textContent).join(',') === 'Audiobooks,Ebooks,Authors,Series');
  const banner = cols[0].querySelector('.ins-banner-art');
  check('the banner is the top book’s cover, hidden from readers', !!banner && banner.getAttribute('src') === COVER(1) &&
    banner.getAttribute('aria-hidden') === 'true' && banner.getAttribute('alt') === '');
  check('a cover from anywhere else is never loaded', !cols[1].querySelector('img') && !t.q('img[src^="https://"]'));
  const dune = cols[0].querySelector('[data-ins-book="1"]');
  check('a row: cover, title, plays and time, users', !!dune && rr(dune.textContent) === 'menu_bookDune9 plays, 5 hr3 users' &&
    dune.querySelector('img').getAttribute('src') === COVER(1), rr(dune && dune.textContent));
  check('a book gone from the library is plain text', cols[0].querySelectorAll('li').length === 2 && cols[0].querySelectorAll('button').length === 1);
  check('ebooks: reads and finished', rr(cols[1].querySelector('li').textContent).endsWith('Walden2 reads1 finished'));
  check('authors: plays and reads, users, a round stand-in, not a button', rr(cols[2].querySelector('li').textContent) === 'personFrank Herbert9 plays, 1 read3 users' &&
    !cols[2].querySelector('button') && !!cols[2].querySelector('.rounded-full'));
  check('times with a Plex part say they are an estimate', rr(t.text('#insTopPlayed')).includes('Times include listening in Plex apps, which is an estimate.'));
  dune.focus();
  dune.click();
  await flush();
  check('a book opens in the dialog', t.q('#insDetail').hasAttribute('open') && t.net.urls('/api/admin/insights/book/')[0] === '/api/admin/insights/book/1');
  t.q('[data-ins-close]').click();
  await flush();
  check('Close gives focus back to the row', t.doc.activeElement === dune);
  const whose = t.q('#insTopPlayedPerson');
  whose.value = SAM;
  whose.dispatchEvent(new t.win.Event('change'));
  await flush();
  check('one person’s Top played is asked for', new RegExp(`person=${SAM}`).test(t.net.urls('/api/admin/insights/top-played')[1] || ''));
  const period = t.q('#insTopPlayedPeriod');
  period.value = 'all';
  period.dispatchEvent(new t.win.Event('change'));
  await flush();
  check('the period asks again', /period=all&person=a{24}/.test(t.net.urls('/api/admin/insights/top-played')[2] || ''));
});

await run('the filters are quiet controls, each with a name, and a failing section offers Try again', async (make) => {
  const t = await mounted(make, { history: () => ({ status: 500, body: {} }) });
  const selects = t.qa('#wsPage select');
  check('six filters, each labelled', selects.length === 6 && selects.every((s) => !!t.q(`label[for="${s.id}"]`)));
  check('none is a blue primary', selects.every((s) => !/bg-primary/.test(s.className)));
  check('the history failed alone', !!t.q('#insHistory [data-ins-failed]') && t.qa('[data-ins-played]').length === 4 && t.qa('[data-ins-user]').length === 3);
  const media = t.q('#insHistoryMedia');
  media.value = 'web';
  media.dispatchEvent(new t.win.Event('change'));
  await flush();
  check('media with nothing read draws nothing and asks nothing', !!t.q('#insHistory [data-ins-failed]') && t.net.urls('/api/admin/insights/history').length === 1);
});

console.log(`insights page: ${total - failed}/${total} checks pass`);
process.exit(failed ? 1 : 0);
