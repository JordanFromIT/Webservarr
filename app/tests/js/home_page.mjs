// Home (app/static/js/pages/home.js) run in happy-dom (a dev-only dependency)
// over the page's own markup (index.html), with a scripted network, a fake
// clock and a fake shell (WS.swr and WS.arrive written as shell.js does them).
//
// Covers spec section 2 and Review Focus 2 and 4 (the parts a DOM without
// layout can check; the live widths are the devkit's):
//   the status strip: all running (with and without a last update), Uptime
//   Kuma silent and the feed unreachable (never "All services running"), no
//   Uptime Kuma (a note, or no strip), an outage card (the outage before a
//   note, how many more), an important note's card, the shape mark kept in
//   step with what is drawn, the first-paint CSS for each shape;
//   requests: the way in, everyone's requests as poster cards with plain
//   status words, the admins' waiting count (and none for members), the
//   empty and error lines in a card's room;
//   news: at most two cards, collapsed, Read more opens and closes in place,
//   the reserved count from the server mark, the empty and error lines;
//   streams: one sideways row, never a name, quality words, Why?, the empty
//   and error lines; coming soon: this week only, one card per title per
//   day, small TMDB posters; services: problems first, healthy is quiet, the
//   empty line; the order of the sections and of their arrival; every answer
//   written as text, never markup; rows that scroll instead of widening the
//   page; leaving the page writes nothing.
//
// HOME_JS=<path> runs the same cases against another copy of the module (how
// the cases were shown failing on the code before).
// Run: node app/tests/js/home_page.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const HOME_PATH = process.env.HOME_JS || join(STATIC, 'js/pages/home.js');
const HOME_HTML = readFileSync(process.env.HOME_HTML_PATH || join(STATIC, 'index.html'), 'utf8');
const BOOKS_SRC = readFileSync(join(STATIC, 'js/pages/books.js'), 'utf8');
const AUTH_SRC = readFileSync(join(STATIC, 'js/auth.js'), 'utf8');

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

// The site's one relative date, as auth.js has it.
const getTimeAgo = new Function(AUTH_SRC.slice(AUTH_SRC.indexOf('function getTimeAgo')) + '\nreturn getTimeAgo;')();
globalThis.getTimeAgo = getTimeAgo;

const BOOKS_URL = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(BOOKS_SRC);
// A data: URL, as the other page tests import their modules (no module-type warning).
const home = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(HOME_PATH, 'utf8')));

// ---- A scripted network ----

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

// ---- The shell, as shell.js has it (swr and arrive are its own logic) ----

function fakeShell(doc, clock, net) {
  const store = new Map();
  const arr = { order: [], done: {}, queue: {}, gate: false };
  const WS = {
    arrived: [],
    swrKeys: [],
    data: { user: { username: 'sam' } },
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
    swr(key, fetcher, render, opts) {
      WS.swrKeys.push(key);
      opts = opts || {};
      const cached = store.get(key);
      const cachedJSON = cached === undefined ? null : JSON.stringify(cached);
      if (cached !== undefined) render(cached, true);
      return Promise.resolve().then(fetcher).then((fresh) => {
        if (JSON.stringify(fresh) !== cachedJSON) render(fresh, false);
        store.set(key, fresh);
        return fresh;
      }, (err) => {
        if (cachedJSON === null && opts.onError) opts.onError(err);
        return cachedJSON === null ? null : cached;
      });
    },
    getJSON(url, opts) {
      return net.fetch(url, opts && opts.signal ? { signal: opts.signal } : undefined).then((r) => {
        if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json();
      });
    },
    serviceStatus() { return net.fetch('/api/integrations/service-status').then((r) => (r.ok ? r.json() : [])).catch(() => []); },
    setHTML(el, h) { el.innerHTML = h; },
    dragScroll() {},
    requestStatus(status) {
      const m = { available: ['Available', 'ready'], partially_available: ['Partly Available', 'go'], processing: ['Requested', 'go'],
        approved: ['Approved', 'go'], pending: ['Requested', 'wait'], declined: ['Declined', 'dead'] }[String(status || '').toLowerCase()];
      return m ? { label: m[0], tone: m[1] } : { label: 'Requested', tone: 'wait' };
    },
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

// ---- One window, one visit ----

const NAV = /<div id="wsPage"[\s\S]*<\/main>/;
const BRANDING = { features: { books_configured: false }, sidebar_enabled: {}, home_sections: {}, news: { homepage_count: 3, homepage_max_age_days: 30 } };
const HOUR = 3600000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const FEED_OK = { state: 'ok', open: [], items: [{ id: 3, source: 'auto', text: 'Plex is back, down 12 min', service: 'Plex', important: false, resolved: true, at: iso(26 * HOUR), created_at: iso(27 * HOUR) }] };
const OUTAGE = { id: 7, source: 'auto', text: 'Plex is down', service: 'Plex', important: false, resolved: false, started_at: iso(25 * 60000), created_at: iso(24 * 60000), at: iso(24 * 60000) };
const NOTE = { id: 8, source: 'admin', text: 'The server restarts at 9 PM for an update.', service: null, important: true, resolved: false, created_at: iso(2 * HOUR), at: iso(2 * HOUR) };
const REQUESTS = [
  { id: 1, media_title: 'Dune', media_type: 'movie', poster_url: 'https://image.tmdb.org/t/p/w200/dune.jpg', status: 'available', requested_date: iso(HOUR) },
  { id: 2, media_title: 'Severance', media_type: 'tv', poster_url: '', status: 'partially_available', requested_date: iso(2 * HOUR) },
  { id: 3, media_title: '<img src=x onerror=alert(1)>', media_type: 'book', poster_url: '', status: 'pending', requested_date: iso(3 * HOUR) }
];
const POSTS = [
  { id: 1, title: 'New movies this week', content_html: '<p>Three new films landed.</p><p>' + 'More words. '.repeat(30) + '</p>', created_at: iso(HOUR), pinned: false, published: true },
  { id: 2, title: 'Maintenance', content_html: '<p>Short.</p>', created_at: iso(200 * HOUR), pinned: true, published: true },
  { id: 3, title: 'Third', content_html: '<p>Never shown.</p>', created_at: iso(300 * HOUR), pinned: false, published: true }
];
const STREAMS = [
  { session_id: 's1', title: 'The Muppet Show', episode_info: 'S1 E3', user: 'Kim Private', decision: 'Direct Play', progress: 40, thumb_url: '/api/integrations/plex/thumb?path=%2Fa' },
  { session_id: 's2', title: 'Arrival', year: 2016, user: 'Sam Private', decision: 'Transcode', progress: 70, source_height: 2160, stream_height: 1080, thumb_url: '' }
];
const day = (n, h) => { const d = new Date(); d.setHours(h || 20, 0, 0, 0); d.setDate(d.getDate() + n); return d.toISOString(); };
const RELEASES = [
  { title: 'Old Movie', air_date: '2002-04-08T00:00:00Z', media_type: 'movie', poster_url: 'https://image.tmdb.org/t/p/original/old.jpg' },
  { title: 'Show A', air_date: day(1, 20), media_type: 'tv', episode_code: 'S02E01', poster_url: 'https://artworks.example/a.jpg' },
  { title: 'Show A', air_date: day(1, 21), media_type: 'tv', episode_code: 'S02E02', poster_url: 'https://artworks.example/a.jpg' },
  { title: 'Big Film', air_date: day(0, 23), media_type: 'movie', poster_url: 'https://image.tmdb.org/t/p/original/big.jpg' },
  { title: 'Far Film', air_date: day(9, 12), media_type: 'movie', poster_url: '' }
];
const SERVICES = [
  { name: 'Plex', status: 'up', last_check: '2026-10-04T10:00:00' },
  { name: 'Sonarr', status: 'down', last_check: '2026-10-04T10:00:00' },
  { name: 'Radarr', status: 'degraded', last_check: '2026-10-04T10:00:00' }
];

function allRoutes(o = {}) {
  return (net) => {
    net.on('/api/status/feed', () => (o.feed === undefined ? { body: FEED_OK } : (typeof o.feed === 'function' ? o.feed() : { body: o.feed })));
    net.on('/api/integrations/recent-requests', () => (o.requests || { body: REQUESTS }));
    net.on('/api/news/', () => (o.news || { body: POSTS.slice(0, 2) }));
    net.on('/api/integrations/active-streams', () => (o.streams || { body: STREAMS }));
    net.on('/api/integrations/upcoming-releases', () => (o.releases || { body: RELEASES }));
    net.on('/api/integrations/service-status', () => (o.services || { body: SERVICES }));
    net.on('/api/integrations/request-counts', () => ({ body: { pending: o.pending === undefined ? 4 : o.pending } }));
    net.on('/api/integrations/system-stats', () => ({ body: { configured: false } }));
  };
}

function visit(o = {}) {
  const win = new Window({ url: 'https://ws.test/' });
  const doc = win.document;
  doc.body.innerHTML = HOME_HTML.match(NAV)[0].replace(/<\/main>$/, '');
  doc.getElementById('wsPage').setAttribute('data-ws-dep', BOOKS_URL);
  const html = doc.documentElement;
  html.setAttribute('data-home-status', o.shape || 'line');
  html.setAttribute('data-home-news', String(o.newsMark === undefined ? 2 : o.newsMark));
  if (o.admin) html.setAttribute('data-admin', '');
  const clock = fakeClock();
  const net = network();
  const ctl = new win.AbortController();
  const WS = fakeShell(doc, clock, net);
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win);
  set('document', doc);
  set('localStorage', win.localStorage);
  set('DOMParser', win.DOMParser);
  set('getComputedStyle', win.getComputedStyle.bind(win));
  set('WS', WS);
  win.WS = WS;
  set('fetch', (u, i) => net.fetch(u, i));
  set('checkAuth', async () => ({ username: 'sam', is_admin: !!o.admin }));
  set('escapeHtml', (s) => String(s));
  const quiet = { error() {}, warn() {}, log() {}, info() {} };
  set('console', quiet);
  (o.routes || allRoutes(o))(net);
  const branding = o.branding || BRANDING;
  WS.data.branding = branding;
  const polls = [];
  const ctx = {
    root: doc.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL('https://ws.test/' + (o.query || '')),
    data: { branding, user: { username: 'sam' } },
    poll(fn, ms) { polls.push({ fn, ms }); return () => {}; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id)
  };
  WS.arriveReset();
  return {
    win, doc, html, clock, net, ctl, WS, ctx, polls,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    async open() {
      const m = home.mount(ctx);
      await clock.advance(1700);
      await m;
    },
    async poll30() { for (const p of polls) if (p.ms === 30000) p.fn(); await clock.advance(10); },
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
    report(`FAIL ${name}: threw ${String(e && e.stack || e).replace(/data:[^\s)]+/g, 'data:...')}`);
  } finally {
    while (made.length) { const t = made.pop(); t.ctl.abort(); t.release(); }
  }
}

// ---------------------------------------------------------------------------
// The strip's words, as a pure rule (statusModel)

await run('statusModel: every state, and never "running" without the feed saying ok', async () => {
  const m = home.statusModel;
  const ok = m(FEED_OK, false);
  check('ok: the slim line, all running, with the last update', ok.shape === 'line' && ok.tone === 'ok' && ok.text === 'All services running' && ok.meta === 'Last update yesterday', ok);
  const quietOk = m({ state: 'ok', open: [], items: [] }, false);
  check('ok with nothing in 30 days: says so', quietOk.text === 'All services running' && quietOk.meta === 'Nothing new in 30 days', quietOk);
  for (const [why, model] of [['Uptime Kuma silent', m({ state: 'unavailable', open: [], items: FEED_OK.items }, false)],
    ['the feed unreachable', m(null, true)], ['an answer that is not a feed', m('nope', false)],
    ['an unknown state', m({ state: 'whatever', open: [], items: [] }, false)], ['"down" with nothing open', m({ state: 'down', open: [], items: [] }, false)]]) {
    check(why + ': "Status unavailable right now", never all running', model.shape === 'line' && model.text === 'Status unavailable right now' && !/running/i.test(model.text + model.meta), model);
  }
  const off = m({ state: 'off', open: [], items: [] }, false);
  check('no Uptime Kuma and nothing posted: no strip', off.shape === 'none', off);
  const offNote = m({ state: 'off', open: [], items: [Object.assign({}, NOTE, { important: false, resolved: true })] }, false);
  check('no Uptime Kuma, a note: the note in the line, no claim', offNote.shape === 'line' && offNote.tone === 'note' && offNote.text === NOTE.text, offNote);
  const down = m({ state: 'down', open: [NOTE, OUTAGE], items: [] }, false);
  check('an outage: a card with the outage first, even under a newer note', down.shape === 'card' && down.tone === 'down' && down.text === 'Plex is down', down);
  check('with when it started and how long so far', /^Since .+, 25 min so far$/.test(down.meta), down.meta);
  check('and how many more there are', down.more === 1);
  const note = m({ state: 'ok', open: [NOTE], items: [] }, false);
  check('an important note: a card of its own tone', note.shape === 'card' && note.tone === 'note' && note.text === NOTE.text && note.meta === 'Posted 2 hours ago', note);
  const unavailableOpen = m({ state: 'unavailable', open: [OUTAGE], items: [] }, false);
  check('Uptime Kuma silent with an outage open: the outage, not a claim', unavailableOpen.shape === 'card');
  check('the older contract\'s words are read too', m({ state: 'ok', open: [{ id: 1, source: 'admin', message: 'Old shape', important: true, created_at: iso(HOUR) }], items: [] }, false).text === 'Old shape');
});

await run('durationText and posterSize', async () => {
  check('minutes, hours, days', home.durationText(30000) === 'under a minute' && home.durationText(12 * 60000) === '12 min' &&
    home.durationText(65 * 60000) === '1 h 5 min' && home.durationText(51 * HOUR) === '2 days 3 h');
  check('a TMDB original becomes a card-sized poster', home.posterSize('https://image.tmdb.org/t/p/original/a.jpg') === 'https://image.tmdb.org/t/p/w342/a.jpg');
  check('anything else is left as it is', home.posterSize('https://artworks.example/original/a.jpg') === 'https://artworks.example/original/a.jpg' && home.posterSize(null) === '');
});

// ---------------------------------------------------------------------------
// The page

await run('the sections, in the spec\'s order, arrive top-down', async (make) => {
  const t = make({});
  const order = t.qa('[data-arrive]').map((n) => n.getAttribute('data-arrive'));
  check('status, services, requests, news, continue, streams, releases', JSON.stringify(order) === JSON.stringify(['status', 'services', 'requests', 'news', 'continue', 'streams', 'releases']), order);
  const page = HOME_HTML.slice(HOME_HTML.indexOf('<div id="wsPage"'));
  check('the two offers come last: the home-screen card, then push', page.indexOf('id="installCard"') > page.indexOf('data-arrive="releases"') && page.indexOf('id="pushPrompt"') > page.indexOf('id="installCard"'));
  check('no greeting', !/Good (morning|afternoon|evening)/.test(HOME_HTML + readFileSync(HOME_PATH, 'utf8')));
  await t.open();
  check('they arrived in that order', JSON.stringify(t.WS.arrived) === JSON.stringify(['status', 'services', 'requests', 'news', 'continue', 'streams', 'releases']), t.WS.arrived);
  check('no skeleton is left in a section that answered', t.qa('#homeStatus .skel, #servicesContainer .skel, #requestsRow .skel, #newsContainer .skel, #streamsContainer .skel, #releasesContainer .skel').length === 0);
  check('the feed was asked for, for 30 days', t.net.urls('/api/status/feed').indexOf('/api/status/feed?days=30') !== -1);
  const before = t.net.urls('/api/status/feed').length;
  await t.poll30();
  check('the strip is read again with the 30 s poll', t.net.urls('/api/status/feed').length > before);
  check('section headings are the Books heading, with no glyph before them', t.qa('#wsPage section > div > h2, #wsPage section > h2').every((h) => /font-bold leading-snug text-xl/.test(h.className) && !(h.previousElementSibling && /material-symbols/.test(h.previousElementSibling.className))));
});

await run('all running: one slim line that links to the feed', async (make) => {
  const t = make({});
  await t.open();
  const a = t.q('#homeStatus a');
  check('a link to /status', a && a.getAttribute('href') === '/status');
  check('the line shape, as tall as its skeleton', a.getAttribute('data-status-shape') === 'line' && /\bh-16\b/.test(a.className) && /\bsm:h-12\b/.test(a.className));
  check('the words and the time of the last update', /All services running/.test(a.textContent) && /Last update yesterday/.test(a.textContent), a.textContent);
  check('the mark stays "line"', t.html.getAttribute('data-home-status') === 'line');
  check('no status colour while all is well', !/status-(ok|err|warn)/.test(a.innerHTML));
  check('done loading', t.q('#homeStatus').getAttribute('aria-busy') === 'false');
});

await run('Uptime Kuma silent, or the feed down: "Status unavailable right now"', async (make) => {
  for (const [why, feed] of [['unavailable', { state: 'unavailable', open: [], items: [] }], ['a 503', () => ({ status: 503, body: {} })]]) {
    const t = make({ feed });
    await t.open();
    const text = t.q('#homeStatus').textContent;
    check(why + ': says it', /Status unavailable right now/.test(text), text);
    check(why + ': never all running', !/All services running/.test(text));
  }
});

await run('an outage: the strip grows into a card with the newest outage, its time and the feed link', async (make) => {
  const t = make({ shape: 'card', feed: { state: 'down', open: [OUTAGE, NOTE], items: FEED_OK.items } });
  await t.open();
  const a = t.q('#homeStatus a');
  check('a card that links to /status', a && a.getAttribute('data-status-shape') === 'card' && a.getAttribute('href') === '/status');
  check('the outage, in its words', /Plex is down/.test(a.textContent));
  check('since when, and for how long', /Since .*25 min so far/.test(a.textContent), a.textContent);
  check('all the updates are a tap away', /See all 2 updates/.test(a.textContent), a.textContent);
  check('the error tone only on the problem', /bg-status-err\/10/.test(a.className) && !!a.querySelector('.ws-light-error'));
  check('the card keeps two title lines\' room (its skeleton\'s: 48 + 4 + 20 + 12 + 24 px)', /line-clamp-2/.test(a.querySelector('p').className) && /min-h-\[6\.75rem\]/.test(a.querySelector('p').parentElement.className) && /mt-auto pt-3/.test(a.querySelectorAll('p')[2].className));
  check('the mark says card', t.html.getAttribute('data-home-status') === 'card');
});

await run('an important note: a card of its own, without the error tone', async (make) => {
  const t = make({ shape: 'card', feed: { state: 'ok', open: [NOTE], items: [] } });
  await t.open();
  const a = t.q('#homeStatus a');
  check('the note and when it was posted', /restarts at 9 PM/.test(a.textContent) && /Posted 2 hours ago/.test(a.textContent), a.textContent);
  check('one update: "See all status updates"', /See all status updates/.test(a.textContent));
  check('the primary tone, not the error one', /bg-primary\/15/.test(a.className) && !/status-err/.test(a.className));
});

await run('the shape changes live, and the mark follows; no Uptime Kuma and nothing posted: no strip', async (make) => {
  let feed = FEED_OK;
  const t = make({ feed: () => ({ body: feed }) });
  await t.open();
  check('a line first', t.q('#homeStatus a').getAttribute('data-status-shape') === 'line');
  feed = { state: 'down', open: [OUTAGE], items: [] };
  t.WS.cache.clear();
  await t.poll30();
  check('then a card', t.q('#homeStatus a') && t.q('#homeStatus a').getAttribute('data-status-shape') === 'card' && t.html.getAttribute('data-home-status') === 'card');
  const u = make({ shape: 'none', feed: { state: 'off', open: [], items: [] } });
  await u.open();
  check('off and empty: the mark hides the section and nothing is drawn', u.html.getAttribute('data-home-status') === 'none' && !u.q('#homeStatus a'));
});

await run('the first paint: the server\'s mark picks the skeleton, so the answer lands on it', async (make) => {
  const css = HOME_HTML.slice(HOME_HTML.indexOf('<style>'), HOME_HTML.indexOf('</style>'));
  check('the card skeleton is hidden by default', /#homeStatus \[data-status-skel="card"\],\s*html\[data-home-status="card"\] #homeStatus \[data-status-skel="line"\] \{ display: none; \}/.test(css));
  check('and shown for a card', /html\[data-home-status="card"\] #homeStatus \[data-status-skel="card"\] \{ display: block; \}/.test(css));
  check('"none" hides the section', /html\[data-home-status="none"\] #homeStatus \{ display: none; \}/.test(css));
  check('the news count picks its skeleton too', /html\[data-home-news="0"\] #newsContainer \[data-news-empty-skel\] \{ display: block; \}/.test(css) &&
    /html\[data-home-news="1"\] #newsContainer \[data-news-skel\] \+ \[data-news-skel\] \{ display: none; \}/.test(css));
  const t = make({});
  const line = t.q('[data-status-skel="line"] .skel');
  check('the line skeleton is the line\'s box', /\bh-16 sm:h-12\b/.test(line.className) && /rounded-card/.test(line.className));
  const cardSkel = t.q('[data-status-skel="card"] .skel');
  check('the card skeleton holds the card\'s lines', cardSkel.querySelector('.min-h-12') && /text-label leading-5/.test(cardSkel.innerHTML) && /text-body leading-6 font-semibold mt-3/.test(cardSkel.innerHTML));
});

await run('requests: the way in, then everyone\'s requests as poster cards', async (make) => {
  const t = make({});
  await t.open();
  const way = t.qa('[data-arrive="requests"] a[href="/requests"]').find((a) => /Request a movie, show or book/.test(a.textContent));
  check('a clear "Request a movie, show or book" that opens Requests', !!way && /bg-primary/.test(way.className));
  const cards = t.qa('#requestsRow > li');
  check('one card per request', cards.length === 3, cards.length);
  check('a poster (small, sized; the first three asked for at once) or the kind\'s glyph', cards[0].querySelector('img').getAttribute('loading') === 'eager' && cards[0].querySelector('img').getAttribute('width') === '112' && !cards[1].querySelector('img') && /tv/.test(cards[1].textContent));
  check('plain status words, sentence case', /Available/.test(cards[0].textContent) && /Partly available/.test(cards[1].textContent) && /Requested/.test(cards[2].textContent));
  check('a title that looks like markup is only text', cards[2].querySelector('p').textContent === '<img src=x onerror=alert(1)>' && !cards[2].querySelector('img[src="x"]'));
  check('no names: the row is everyone\'s', !/requested_by|Kim|Sam Private/.test(t.q('#requestsRow').textContent));
  check('the row scrolls sideways (it never widens the page)', /\bbooks-row\b/.test(t.q('#requestsRow').className) && /\bflex\b/.test(t.q('#requestsRow').className));
  check('a member sees no waiting count, and it was not asked for on their behalf', t.q('#requestsWaiting').classList.contains('invisible') && t.q('#requestsWaiting').textContent === '');
});

await run('admins: "N waiting for approval", holding its room until the count is in', async (make) => {
  const t = make({ admin: true, pending: 4 });
  const link = t.q('#requestsWaiting');
  check('admin-only, unseen until the count, from the first paint', /\bws-admin-only\b/.test(link.className) && /\binvisible\b/.test(link.className));
  await t.open();
  check('the count, as a link to Requests', link.textContent === '4 waiting for approval' && link.getAttribute('href') === '/requests' && !link.classList.contains('invisible'));
  const u = make({ admin: true, pending: 0 });
  await u.open();
  check('none waiting: nothing shown', u.q('#requestsWaiting').classList.contains('invisible'));
});

await run('requests: the empty and error lines keep a card\'s room', async (make) => {
  const t = make({ requests: { body: [] } });
  await t.open();
  const li = t.q('#requestsRow [data-row-message]');
  check('empty: one plain line', li && /Nothing has been requested yet\./.test(li.textContent));
  check('over an unseen card of the real size', li.querySelector('.invisible.w-28 .aspect-\\[2\\/3\\]') !== null && li.querySelector('.min-h-\\[2\\.75em\\]') !== null);
  const u = make({ requests: { status: 503, body: {} } });
  await u.open();
  const err = u.q('#requestsRow [data-row-message]');
  check('failed: says so plainly, no product names', err && /can.t be shown right now/.test(err.textContent) && !/Seerr|Overseerr|Jellyseerr|configured/i.test(err.textContent));
});

await run('news: the latest two posts as collapsed cards; Read more opens in place', async (make) => {
  const t = make({});
  await t.open();
  const url = t.net.urls('/api/news/')[0];
  check('asks for two, inside the age window', url === '/api/news/?limit=2&max_age_days=30', url);
  const cards = t.qa('#newsContainer > article');
  check('two cards', cards.length === 2);
  check('chips say New and Pinned', /New/.test(cards[0].textContent) && /Pinned/.test(cards[1].textContent));
  const ex = cards[0].querySelector('[data-news-excerpt]');
  check('a three-line excerpt held at three lines (its skeleton\'s)', /line-clamp-3 min-h-\[4\.5rem\]/.test(ex.className));
  check('the post\'s words as text, from its HTML', /Three new films landed\./.test(ex.textContent) && !cards[0].querySelector('[data-news-body] p p'));
  const btn = cards[0].querySelector('[data-news-toggle]');
  btn.click();
  check('Read more opens the whole post', !cards[0].querySelector('[data-news-body]').classList.contains('hidden') && ex.classList.contains('hidden') && btn.getAttribute('aria-expanded') === 'true' && /Show less/.test(btn.textContent));
  btn.click();
  check('and Show less closes it', cards[0].querySelector('[data-news-body]').classList.contains('hidden') && btn.getAttribute('aria-expanded') === 'false');
  check('a short post keeps the button\'s room, unseen', cards[1].querySelector('[data-news-toggle]').classList.contains('invisible'));
  check('All news links to the archive', t.q('#newsViewAll').getAttribute('href') === '/news');
});

await run('news: an image in a post never loads on Home; nothing posted holds the reserved room', async (make) => {
  const t = make({ news: { body: [{ id: 9, title: 'Pic', content_html: '<p>Hi</p><img src="https://tracker.example/x.png">', created_at: iso(HOUR), pinned: false }] }, newsMark: 1 });
  await t.open();
  check('no img in the card', !t.q('#newsContainer img'));
  const u = make({ news: { body: [] }, newsMark: 0 });
  await u.open();
  const line = u.q('#newsContainer [data-news-message]');
  check('nothing posted, none reserved: one line the empty skeleton\'s height', line && /Nothing posted yet\./.test(line.textContent) && /\bh-12\b/.test(line.className));
  const v = make({ news: { status: 503, body: {} }, newsMark: 2 });
  await v.open();
  check('failed with two reserved: two empty cards, the line over them', v.qa('#newsContainer > div[aria-hidden]').length === 2 && /News can.t be shown right now\./.test(v.q('#newsContainer [data-news-message]').textContent));
});

await run('streams: one sideways row, never who is watching', async (make) => {
  const t = make({});
  await t.open();
  const row = t.q('#streamsContainer');
  const cards = t.qa('#streamsContainer > article');
  check('one card per stream, in a row that scrolls', cards.length === 2 && /\bbooks-row\b/.test(row.className) && cards.every((c) => /shrink-0/.test(c.className)));
  check('no names', !/Kim Private|Sam Private/.test(row.textContent));
  check('the title with its episode or year', /The Muppet Show, S1 E3/.test(cards[0].textContent) && /Arrival \(2016\)/.test(cards[1].textContent));
  check('full quality in the pure ok colour (owner request)', /text-status-ok/.test(cards[0].innerHTML) && /Full quality/.test(cards[0].textContent));
  const why = cards[1].querySelector('[data-action="stream-info"]');
  check('a lower-quality stream says so, with a Why? button', /Not playing at full quality/.test(cards[1].textContent) && why && why.getAttribute('aria-expanded') === 'false');
  why.click();
  const reason = cards[1].querySelector('[data-stream-reason]');
  check('Why? opens the reason, in plain words', !reason.classList.contains('hidden') && /2160p/.test(reason.textContent) && /Original/.test(reason.textContent) && why.getAttribute('aria-expanded') === 'true');
  check('progress as a labelled bar', cards[0].querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === '40');
  check('the artwork is an image with a size, lazy', cards[0].querySelector('img').getAttribute('loading') === 'lazy' && cards[0].querySelector('img').getAttribute('height') === '162');
  await t.poll30();
  check('a poll with nothing changed leaves the open reason open', !t.q('#streamsContainer [data-stream-reason]').classList.contains('hidden'));
});

await run('streams: nothing playing, and Plex unreachable, in a card\'s room', async (make) => {
  const t = make({ streams: { body: [] } });
  await t.open();
  check('nothing playing', /Nothing is playing right now\./.test(t.q('#streamsContainer [data-row-message]').textContent));
  const u = make({ streams: { status: 503, body: {} } });
  await u.open();
  const text = u.q('#streamsContainer [data-row-message]').textContent;
  check('unreachable: plain words, no product name', /Can.t show what.s playing right now\./.test(text) && !/Plex/.test(text));
  check('over an unseen card of the real size', !!u.q('#streamsContainer [data-row-message] .invisible .aspect-video'));
});

await run('admins\' sample streams (?preview=streams) go through the same card; a member\'s flag does nothing', async (make) => {
  const t = make({ admin: true, query: '?preview=streams' });
  await t.open();
  check('three samples, marked', t.qa('#streamsContainer > article').length === 3 && /Sample/.test(t.q('#streamsContainer').textContent));
  check('no streams read', t.net.urls('/api/integrations/active-streams').length === 0);
  const u = make({ query: '?preview=streams' });
  await u.open();
  check('a member gets the real streams', u.net.urls('/api/integrations/active-streams').length === 1 && !/Sample/.test(u.q('#streamsContainer').textContent));
});

await run('coming soon: this week only, one card per title per day', async (make) => {
  const t = make({});
  await t.open();
  const cards = t.qa('#releasesContainer > li');
  const titles = cards.map((c) => c.querySelector('p').textContent);
  check('old and far dates left out', titles.indexOf('Old Movie') === -1 && titles.indexOf('Far Film') === -1, titles);
  check('in date order, a show\'s two episodes on one card', JSON.stringify(titles) === JSON.stringify(['Big Film', 'Show A']), titles);
  check('when, in words', /Today, Movie/.test(cards[0].textContent) && /Tomorrow, 2 new episodes/.test(cards[1].textContent), cards.map((c) => c.textContent));
  check('a TMDB poster at card size', cards[0].querySelector('img').getAttribute('src') === 'https://image.tmdb.org/t/p/w342/big.jpg');
  check('the calendar is one link away', !!t.q('[data-arrive="releases"] a[href="/calendar"]'));
  const u = make({ releases: { body: [RELEASES[0]] } });
  await u.open();
  check('nothing this week: says so', /Nothing new is due in the next week\./.test(u.q('#releasesContainer').textContent));
  const v = make({ releases: { status: 503, body: {} } });
  await v.open();
  const text = v.q('#releasesContainer').textContent;
  check('failed: plain words, no product names', /isn.t available right now/.test(text) && !/Sonarr|Radarr|configured/.test(text));
});

await run('services: problems first, healthy is quiet, an empty answer says so', async (make) => {
  const t = make({});
  await t.open();
  const tiles = t.qa('#servicesContainer > li');
  check('down, then slow, then the rest', tiles.map((li) => li.getAttribute('data-service-state')).join() === 'down,degraded,up', tiles.map((li) => li.getAttribute('data-service-state')));
  check('a problem in words and its colour', /Down/.test(tiles[0].textContent) && /status-err-text/.test(tiles[0].innerHTML) && /Slow/.test(tiles[1].textContent));
  check('a healthy service: "Running", no colour, no light', /Running/.test(tiles[2].textContent) && !/status-|ws-light/.test(tiles[2].innerHTML));
  check('no caps, nothing under 13px', !/uppercase|tracking-wider|text-\[(9|10|11|12)px\]/.test(t.q('[data-arrive="services"]').innerHTML));
  check('one row that scrolls', /\bbooks-row\b/.test(t.q('#servicesContainer').className));
  const u = make({ services: { body: [] } });
  await u.open();
  check('nothing to list: one plain line in a tile\'s room', /Service details aren.t available right now\./.test(u.q('#servicesContainer [data-row-message]').textContent) && !/configured/.test(u.q('#servicesContainer').textContent));
});

await run('a poll that brings nothing new rebuilds nothing; after a failure the next answer is drawn', async (make) => {
  let fail = false;
  const t = make({ requests: undefined });
  t.net.on('/api/integrations/recent-requests', () => (fail ? { status: 503, body: {} } : { body: REQUESTS }));
  await t.open();
  const first = t.q('#requestsRow > li img');
  const news = t.q('#newsContainer > article');
  t.WS.cache.clear();
  await t.poll30();
  check('the same requests: the very same nodes (no poster drawn twice)', t.q('#requestsRow > li img') === first);
  check('the same news: the same cards', t.q('#newsContainer > article') === news);
  fail = true;
  t.WS.cache.clear();
  await t.poll30();
  check('a failure with nothing kept says so', /can.t be shown/.test(t.q('#requestsRow').textContent));
  fail = false;
  t.WS.cache.clear();
  await t.poll30();
  check('the same answer as before the failure is drawn again', t.qa('#requestsRow > li').length === 3 && !t.q('#requestsRow [data-row-message]'));
});

await run('sections switched off are never read, and the strip is not one of them', async (make) => {
  const t = make({ branding: Object.assign({}, BRANDING, { home_sections: { services: false, news: false, streams: false, releases: false, requests: false } }) });
  await t.open();
  check('nothing but the strip and the count read', t.net.urls('/api/news').length === 0 && t.net.urls('/api/integrations/active-streams').length === 0 &&
    t.net.urls('/api/integrations/recent-requests').length === 0 && t.net.urls('/api/integrations/upcoming-releases').length === 0 && t.net.urls('/api/integrations/service-status').length === 0);
  check('the strip still drew', !!t.q('#homeStatus a'));
});

await run('Review Focus 4 by markup: rows scroll, fixed widths fit 320, nothing below the type floor', async (make) => {
  const page = HOME_HTML.slice(HOME_HTML.indexOf('<div id="wsPage"'), HOME_HTML.indexOf('</main>'));
  const src = readFileSync(HOME_PATH, 'utf8');
  const widths = (page + src).match(/(?<![\w:-])w-\[(\d+)rem\]|(?<![\w:-])w-(\d+)\b/g) || [];
  const px = (w) => { let m = w.match(/w-\[(\d+)rem\]/); if (m) return +m[1] * 16; m = w.match(/w-(\d+)$/); return m ? +m[1] * 4 : 0; };
  const wide = widths.filter((w) => px(w) > 288);
  check('no fixed width over 288px (320 less the gutters) below sm', wide.length === 0, wide);
  check('every sideways list is a scrolling row', ['servicesContainer', 'requestsRow', 'streamsContainer', 'releasesContainer'].every((id) => new RegExp('id="' + id + '" class="books-row ').test(page)));
  check('the rows\' CSS hides the bar and scrolls', /\.books-row \{ scrollbar-width: none; -ms-overflow-style: none; overflow-y: hidden; \}/.test(HOME_HTML));
  check('no text under 13px, no tracked caps', !/text-\[(8|9|10|11|12)px\]|uppercase|tracking-wider/.test(page + src));
  check('no glass on flat content, no hover zoom', !/glass-card|group-hover:scale|hover:scale/.test(page + src));
  check('no markup from an answer: no innerHTML writes in the module', !/\.innerHTML\s*=|insertAdjacentHTML|WS\.setHTML/.test(src.replace(/\/\/.*$/gm, '')));
  check('no dashes in the copy', !/[–—]/.test(page + src));
  const t = make({});
  await t.open();
  check('every image Home draws has its size', t.qa('#wsPage img').every((i) => i.getAttribute('width') && i.getAttribute('height')), t.qa('#wsPage img').filter((i) => !i.getAttribute('width')).map((i) => i.outerHTML.slice(0, 80)));
});

await run('leaving the page: nothing is written afterwards', async (make) => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const t = make({ feed: () => slow.then(() => ({ body: { state: 'down', open: [OUTAGE], items: [] } })) });
  const m = home.mount(t.ctx);
  await t.clock.advance(400);
  t.ctl.abort();
  release();
  await t.clock.advance(1700);
  await m.catch(() => {});
  check('the strip was not drawn after the visit ended', !t.q('#homeStatus a') && t.html.getAttribute('data-home-status') === 'line');
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
