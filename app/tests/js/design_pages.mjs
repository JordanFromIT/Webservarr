// The audit's design items (v2 step 5, Task 3), run for real in happy-dom:
//
// Requests (pages/requests.js over requests.html): one search whose results
// take the place of everything else while there is a search; three shelves
// grouped by what people want (Trending, Coming soon, Books), each merged
// from several sources, a failed source leaving the rest and a shelf with
// every source down saying so; the Books card (a button, the 2:3 cover, two
// lines of title, one quiet line, where a title stands as a mark on its
// cover); the library summary as one quiet line; the recent requests as
// cards; a Request that turns into its status block; the detail dialog.
//
// Login (login.html with js/login.js): Review Focus 5, the form stays hidden
// until the sign-in methods are applied (.auth-ready), and the 2.5 s failsafe
// still shows it when /api/branding never answers; the restyled card (plain
// "Continue with Plex", no "via Authentik"); and the one-line status from the
// public status summary ("All services running", "<Service> is down", never
// "running" when unknown).
//
// REQUESTS_JS=<path> / LOGIN_JS=<path> run the cases against another copy.
// Run: node app/tests/js/design_pages.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const REQUESTS_PATH = process.env.REQUESTS_JS || join(STATIC, 'js/pages/requests.js');
const LOGIN_PATH = process.env.LOGIN_JS || join(STATIC, 'js/login.js');
const REQUESTS_HTML = readFileSync(join(STATIC, 'requests.html'), 'utf8');
const LOGIN_HTML = readFileSync(join(STATIC, 'login.html'), 'utf8');
const LOGIN_JS = readFileSync(LOGIN_PATH, 'utf8');

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ============================================================ Requests

const requestsModule = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(REQUESTS_PATH, 'utf8')));
const NAV = /<div id="wsPage"[\s\S]*<\/main>/;
const quietConsole = { error() {}, warn() {}, log() {}, info() {} };

// The shared vocabulary as shell.js has it (WS.mediaType / WS.requestStatus).
const MEDIA = {
  movie: { label: 'Movie', icon: 'movie', accent: 'media-movie' },
  tv: { label: 'TV Show', icon: 'tv', accent: 'media-tv' },
  book: { label: 'eBook', icon: 'menu_book', accent: 'media-book' },
  audiobook: { label: 'Audiobook', icon: 'headphones', accent: 'media-book' }
};
const STATES = {
  available: { label: 'Available', tone: 'ready' }, partially_available: { label: 'Partly Available', tone: 'go' },
  processing: { label: 'Requested', tone: 'go' }, approved: { label: 'Approved', tone: 'go' },
  pending: { label: 'Requested', tone: 'wait' }, declined: { label: 'Declined', tone: 'dead' }
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function requestsVisit(routes) {
  const url = 'https://ws.test/requests';
  const win = new Window({ url });
  const doc = win.document;
  doc.body.innerHTML = REQUESTS_HTML.match(NAV)[0].replace(/<\/main>$/, '');
  const clock = fakeClock();
  const net = network();
  routes(net);
  const ctl = new win.AbortController();
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const toasts = [];
  const dialogs = [];
  const WS = {
    dragScroll: Object.assign(() => {}, { stop() {} }), arrive: (k, f) => f(), data: {}, leaveTo() {},
    mediaType: (t) => MEDIA[t] || MEDIA.movie,
    requestStatus: (s) => STATES[String(s || '').toLowerCase()] || { label: 'Requested', tone: 'wait' },
    getJSON: (u, o) => net.fetch(u, o).then((r) => r.json()), setHTML() {}, swr: () => Promise.resolve(null), poll: () => () => {}
  };
  set('window', win);
  set('document', doc);
  set('WS', WS);
  win.WS = WS;
  set('fetch', (u, o) => net.fetch(u, o));
  set('checkAuth', async () => ({ username: 'sam', is_admin: false }));
  set('escapeHtml', escapeHtml);
  set('getTimeAgo', () => '2 days ago');
  set('requestAnimationFrame', (fn) => clock.setTimeout(fn, 16));
  set('cancelAnimationFrame', (id) => clock.clearTimeout(id));
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  set('WSUI', { toast(text, tone) { toasts.push([text, tone]); }, modal(el, opts) { dialogs.push(el.id); return { close() { opts.onClose(); } }; } });
  set('console', quietConsole);
  const ctx = {
    root: doc.getElementById('wsPage'), signal: ctl.signal, url: new URL(url), data: {},
    poll: () => () => {}, setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (id) => clock.clearTimeout(id),
    onNavigate() {}, beforeLeave() {}, setTitle() {}
  };
  const q = (sel) => doc.querySelector(sel);
  return {
    win, doc, net, clock, ctl, ctx, toasts, dialogs, q,
    hidden: (sel) => q(sel).classList.contains('hidden'),
    titles: (rowId) => Array.from(doc.querySelectorAll('#' + rowId + ' [data-action="open-media"]')).map((b) => (b.querySelector('.line-clamp-2') || b).textContent.trim()),
    async mount() { const m = requestsModule.mount(ctx); await clock.advance(1800); await m.catch(() => {}); await clock.advance(200); },
    async type(text) {
      const input = doc.getElementById('searchInput');
      input.value = text;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      await clock.advance(400);
    },
    release() { ctl.abort(); for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; } }
  };
}

const film = (id, title, extra) => Object.assign({ id, title, media_type: 'movie', poster_url: '/p/' + id + '.jpg', year: 2024 }, extra || {});
const show = (id, title, extra) => Object.assign({ id, title, media_type: 'tv', poster_url: '/p/' + id + '.jpg', year: 2020 }, extra || {});

function usual(over) {
  const o = over || {};
  return (net) => {
    const d = (name, body) => net.on('/api/integrations/seerr-discover/' + name, () => (o[name] !== undefined ? o[name] : { body }));
    d('trending', [film(1, 'Alpha', { media_status: 'AVAILABLE' }), show(2, 'Beta')]);
    d('popular-movies', [film(3, 'Gamma', { media_status: 'unknown' }), film(1, 'Alpha', { media_status: 'AVAILABLE' })]);
    d('popular-series', null);
    net.on('/api/integrations/seerr-discover/popular-series', () => o['popular-series'] || { status: 503, body: {} });
    d('upcoming-movies', [film(4, 'Delta', { media_status: 'PENDING' })]);
    d('upcoming-series', [show(5, 'Epsilon')]);
    net.on('/api/integrations/books-trending', () => o.books || { body: [
      { id: 'gr:1', title: 'Covered', media_type: 'book', poster_url: '/c/1.jpg', author: 'A. Writer' },
      { id: 'gr:2', title: 'Coverless', media_type: 'book', poster_url: '', author: 'B. Writer' }] });
    net.on('/api/integrations/audiobooks-trending', () => o.audiobooks || { status: 503, body: {} });
    net.on('/api/integrations/library-summary', () => o.summary || { body: { wait_minutes: { total: 11.4 } } });
    net.on('/api/integrations/request-counts', () => ({ body: { total: 1 } }));
    net.on('/api/integrations/recent-requests', () => ({ body: [{ media_title: 'Dune', media_type: 'movie', status: 'available', poster_url: '/p/d.jpg', requested_date: '2026-10-01T00:00:00Z' }] }));
    net.on('/api/request-status/', () => ({ body: { items: [], generated_at: new Date().toISOString() } }));
    net.on('/api/integrations/seerr-search', () => ({ body: { results: [film(9, 'Dune Part Two'), show(8, 'Dune: Prophecy', { media_status: 'AVAILABLE' })], totalPages: 1, totalResults: 2 } }));
    net.on('/api/integrations/chaptarr-search', () => ({ body: { results: [] } }));
    net.on('/api/integrations/seerr-request', () => ({ body: { ok: true } }));
  };
}

current = 'requests: three shelves, grouped by what people want';
{
  const r = await requestsVisit(usual());
  try {
    const heads = Array.from(r.doc.querySelectorAll('#discoverSection h2')).map((h) => h.textContent.trim());
    check('the shelves are Trending, Coming soon and Books, in that order', JSON.stringify(heads) === JSON.stringify(['Trending', 'Coming soon', 'Books']), heads);
    check('each holds its skeleton cards in the first paint', r.doc.querySelectorAll('#trendingRow .skel').length === 8);
    check('no shelf is named for a service', !/Popular movies|Upcoming TV|Trending audiobooks/.test(r.doc.getElementById('discoverSection').textContent));
    check('the library panel of number cards is gone', !r.q('#statsRow') && !r.q('#statSize'));
    await r.mount();
    check('Trending interleaves its sources and shows a title they share once', JSON.stringify(r.titles('trendingRow')) === JSON.stringify(['Alpha', 'Gamma', 'Beta']), r.titles('trendingRow'));
    check('a failed source leaves the others on the shelf (popular TV shows answered 503)', r.titles('trendingRow').length === 3);
    check('Coming soon takes movies and shows', JSON.stringify(r.titles('comingRow')) === JSON.stringify(['Delta', 'Epsilon']), r.titles('comingRow'));
    check('the Books shelf shows covers only, with its other source down', JSON.stringify(r.titles('booksRow')) === JSON.stringify(['Covered']), r.titles('booksRow'));
    check('every source was asked', ['trending', 'popular-movies', 'popular-series', 'upcoming-movies', 'upcoming-series'].every((n) => r.net.urls('/api/integrations/seerr-discover/' + n).length === 1));
    const wait = r.q('#requestWait').textContent;
    check('the summary is one quiet line: how long requests take', wait === 'Requests are handled automatically. Most arrive in about 11 minutes.', wait);
  } finally { r.release(); }
}

current = 'requests: a shelf whose every source is down says so';
{
  const r = await requestsVisit(usual({ 'upcoming-movies': { status: 503, body: {} }, 'upcoming-series': { status: 500, body: {} } }));
  try {
    await r.mount();
    check('one line, no cards', r.q('#comingRow').textContent.trim() === 'This shelf isn’t available right now.' && !r.q('#comingRow [data-action]'), r.q('#comingRow').textContent);
    check('the other shelves are untouched', r.titles('trendingRow').length === 3);
  } finally { r.release(); }
}

current = 'requests: the summary failing keeps the general line';
{
  const r = await requestsVisit(usual({ summary: { status: 503, body: {} } }));
  try {
    await r.mount();
    check('the general words stay', /most arrive within the hour/.test(r.q('#requestWait').textContent), r.q('#requestWait').textContent);
  } finally { r.release(); }
}

current = 'requests: the Books card';
{
  const r = await requestsVisit(usual());
  try {
    await r.mount();
    const cards = r.doc.querySelectorAll('#trendingRow [data-action="open-media"]');
    const alpha = cards[0];
    check('a card is a button, so it opens from the keyboard', alpha.tagName === 'BUTTON' && alpha.getAttribute('type') === 'button');
    check('the Books card width, cover and title room', /\bw-36\b/.test(alpha.className) && !!alpha.querySelector('.aspect-\\[2\\/3\\].rounded-xl') && /line-clamp-2/.test(alpha.querySelector('.line-clamp-2').className) && /min-h-\[2\.75em\]/.test(alpha.querySelector('.line-clamp-2').className));
    check('the title is not given a display that undoes the clamp', !/\bblock\b/.test(alpha.querySelector('.line-clamp-2').className));
    const mark = alpha.querySelector('[data-discover-status]');
    check('where it stands is a mark on the cover, in the accent once on the server', mark && mark.textContent === 'Available' && /\bbg-primary\b/.test(mark.className) && /\babsolute\b/.test(mark.className), mark && mark.outerHTML);
    check('a title nobody asked for (or Seerr\'s unknown) has no mark', !cards[1].querySelector('[data-discover-status]') && !cards[2].querySelector('[data-discover-status]'));
    const sub = cards[2].querySelector('.min-h-5');
    check('one quiet line: the type in sentence case and the year, with the type\'s dot', sub && sub.textContent === 'TV show, 2020' && !!sub.querySelector('.bg-media-tv'), sub && sub.textContent);
    const pending = r.q('#comingRow [data-action="open-media"] [data-discover-status]');
    check('a waiting request is a quiet mark', pending && pending.textContent === 'Requested' && /bg-background-dark\/80/.test(pending.className));
    const recent = r.q('#requestsGrid [data-status]');
    check('a recent request is a card with its state on the cover', recent && recent.querySelector('[data-discover-status]').textContent === 'Available' && recent.textContent.indexOf('Dune') !== -1 && recent.textContent.indexOf('Movie, 2 days ago') !== -1, recent && recent.textContent);
    check('no product or console words on the cards', !/TV Show|eBook|Unknown/.test(r.q('#browseArea').textContent));
  } finally { r.release(); }
}

current = 'requests: a search takes the place of the rest, and clearing it brings it back';
{
  const r = await requestsVisit(usual());
  try {
    await r.mount();
    check('no results area before a search', r.hidden('#searchResultsSection') && !r.hidden('#browseArea'));
    await r.type('dune');
    check('the results show', !r.hidden('#searchResultsSection'));
    check('and everything else steps aside', r.hidden('#browseArea'));
    check('the count says how many', r.q('#searchResultCount').textContent === '2 results');
    const btn = r.q('#searchResultsGrid [data-action="request-media"]');
    check('a result has a Request button that says what it asks for', btn && btn.textContent === 'Request movie: Dune Part Two' && btn.getAttribute('data-request-id') === '9', btn && btn.textContent);
    check('and its title for a screen reader only', btn && btn.querySelector('.sr-only').textContent === ': Dune Part Two');
    const block = r.q('#searchResultsGrid [data-action="request-media"]') && r.doc.querySelectorAll('#searchResultsGrid > div')[1];
    check('a title already here shows its state in the button\'s box', block && /\bh-10\b/.test(block.querySelector('.rounded-btn').className) && block.querySelector('.rounded-btn').textContent === 'Available');
    btn.click();
    await r.clock.advance(50);
    const sent = r.net.calls.filter((c) => c.url === '/api/integrations/seerr-request');
    check('Request sends it', sent.length === 1 && JSON.parse(sent[0].init.body).mediaId === '9', sent.map((c) => c.init.body));
    check('the toast names it', r.toasts.some((t) => t[0] === 'Requested Dune Part Two' && t[1] === 'ok'), r.toasts);
    const first = r.doc.querySelectorAll('#searchResultsGrid > div')[0].querySelector('.rounded-btn');
    check('the button becomes its status block, same box', first.tagName === 'DIV' && first.textContent === 'Requested' && /\bh-10\b/.test(first.className), first.outerHTML);
    await r.type('');
    check('cleared: the results go', r.hidden('#searchResultsSection'));
    check('and the shelves and requests are back', !r.hidden('#browseArea'));
  } finally { r.release(); }
}

current = 'requests: the detail dialog';
{
  const r = await requestsVisit(usual());
  try {
    await r.mount();
    r.doc.querySelectorAll('#trendingRow [data-action="open-media"]')[1].click();
    await r.clock.advance(10);
    check('a shelf card opens the dialog', r.dialogs[0] === 'mediaModal');
    check('it names the title', r.q('#modalTitle').textContent === 'Gamma');
    const b = r.q('#modalRequestBtn');
    check('and asks for it in plain words', b && b.textContent === 'Request movie', b && b.textContent);
    check('the type as the cards say it', r.q('#modalTypeBadge').textContent === 'Movie');
  } finally { r.release(); }
}

// ============================================================ Login

const LOGIN_HEAD = LOGIN_HTML.split('</head>')[0];
const LOGIN_BODY = LOGIN_HTML.split(/<body[^>]*>/)[1].split('</body>')[0].replace(/<script\b[^>]*><\/script>/g, '');

// The anti-flash rules (v1.4.2), exactly as they shipped (Review Focus 5).
const KEEP = [
  '#loginForm { visibility: hidden; }',
  '#loginForm.auth-ready { visibility: visible; }',
  'html:not([data-login-js]) #loginForm { animation: login-fallback-show 0s linear 2.5s forwards; }',
  '#loginLoadHint { visibility: hidden; height: 0; overflow: hidden; animation: login-fallback-hint 0s linear 2.5s forwards; }',
  '#loginForm.auth-ready ~ #loginLoadHint,\n    html[data-login-js] #loginLoadHint { display: none; }',
  '@keyframes login-fallback-show { to { visibility: visible; } }',
  '@keyframes login-fallback-hint { to { visibility: visible; height: auto; margin-top: 0.75rem; } }'
];

async function loginVisit({ theme, branding, summary } = {}) {
  const w = new Window({ url: 'https://ws.test/login' });
  const d = w.document;
  d.body.innerHTML = LOGIN_BODY;
  if (theme) w.WEBSERVARR_THEME = theme;
  const calls = [];
  w.fetch = (url) => {
    calls.push(url);
    if (url === '/api/integrations/status-summary') {
      if (summary === 'reject') return Promise.reject(new Error('offline'));
      const s = summary || { status: 200, body: { status: 'online', down_service: null } };
      return Promise.resolve({ ok: s.status === 200, status: s.status, json: () => Promise.resolve(s.body) });
    }
    if (url === '/api/branding') {
      if (branding === 'hang') return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(branding || theme || {}) });
    }
    if (url === '/auth/check-session') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: false }) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
  w.eval(LOGIN_JS);
  const form = d.getElementById('loginForm');
  return {
    w, d, calls, form,
    ready: () => form.classList.contains('auth-ready'),
    async loaded() { d.dispatchEvent(new w.Event('DOMContentLoaded')); await flush(); await wait(5); await flush(); },
    status: () => ({ state: d.getElementById('loginSystemStatus').getAttribute('data-state'), text: d.querySelector('#loginSystemStatus [data-status-text]').textContent }),
    async done() { await w.happyDOM.abort(); w.close(); }
  };
}

current = 'login: Review Focus 5, the reveal and the failsafe are as they were';
{
  for (const rule of KEEP) check('the page keeps: ' + rule.split('\n')[0], LOGIN_HEAD.indexOf(rule) !== -1);
  const t = await loginVisit({ theme: { auth_methods: { plex: true, simple: false, authentik: false } } });
  check('the script marks <html> first', t.d.documentElement.hasAttribute('data-login-js'));
  check('the form is not revealed before the methods are applied on load', !t.ready());
  check('the unconfigured simple form is out before it can paint', t.d.getElementById('username').closest('form > div').style.display === 'none');
  await t.loaded();
  check('revealed once the methods are applied', t.ready());
  check('the hint stays a sibling after the form, so the reveal hides it', t.form.parentElement.querySelector('#loginForm ~ #loginLoadHint') !== null);
  await t.done();
}

current = 'login: a branding fetch that never answers still shows the form after 2.5 s';
{
  const t = await loginVisit({ branding: 'hang' });
  await t.loaded();
  check('not yet at 2.3 s', (await wait(2300), !t.ready()));
  await wait(400);
  check('shown by 2.7 s', t.ready());
  await t.done();
}

current = 'login: the calmer card';
{
  const t = await loginVisit({ theme: { auth_methods: { plex: true, authentik: true, simple: true }, logo_url: '/l.png' } });
  await t.loaded();
  const plex = t.d.getElementById('plexLoginBtn');
  const ak = t.d.getElementById('authentikLoginBtn');
  check('Continue with Plex, in plain words', plex.textContent.trim() === 'Continue with Plex');
  check('the Authentik route says the same and nothing about Authentik', !ak.classList.contains('hidden') && ak.textContent.trim() === 'Continue with Plex');
  check('no faked wordmark, no caps', !/Arial Black|uppercase|PLEX/.test(t.d.body.innerHTML));
  const logo = t.d.getElementById('loginLogo');
  check('the logo is about 64px and shows', /\bh-16\b/.test(logo.className) && !logo.classList.contains('hidden') && logo.getAttribute('src') === '/l.png');
  check('the divider is one quiet word', t.d.querySelector('#ssoDivider span').textContent === 'or');
  check('the name is the heading', t.d.querySelectorAll('h1').length === 1 && t.d.querySelector('h1').id === 'loginAppName');
  await t.done();
}

current = 'login: the one-line status';
for (const [label, summary, want] of [
  ['all up', { status: 200, body: { status: 'online', down_service: null } }, { state: 'ok', text: 'All services running' }],
  ['one down, named', { status: 200, body: { status: 'issues', down_service: 'Plex' } }, { state: 'err', text: 'Plex is down' }],
  ['down, no name', { status: 200, body: { status: 'issues', down_service: null } }, { state: 'err', text: 'Something is down' }],
  ['slow', { status: 200, body: { status: 'degraded', down_service: null } }, { state: 'warn', text: 'Some services are slow' }],
  ['Uptime Kuma not answering', { status: 200, body: { status: 'unknown', down_service: null } }, { state: 'off', text: 'Status unavailable right now' }],
  ['the summary failing', { status: 503, body: {} }, { state: 'off', text: 'Status unavailable right now' }],
  ['the network failing', 'reject', { state: 'off', text: 'Status unavailable right now' }],
  ['a name with markup stays text', { status: 200, body: { status: 'issues', down_service: '<b>Mail</b>' } }, { state: 'err', text: '<b>Mail</b> is down' }]
]) {
  const t = await loginVisit({ theme: { auth_methods: { plex: true } }, summary });
  await t.loaded();
  const got = t.status();
  check(label, got.state === want.state && got.text === want.text, got);
  if (label === 'a name with markup stays text') check('no element made from it', !t.d.querySelector('#loginSystemStatus b'));
  check(label + ': the public summary is the only status read', t.calls.filter((u) => /status/.test(u)).every((u) => u === '/api/integrations/status-summary'));
  await t.done();
}

console.log(`design pages: ${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
