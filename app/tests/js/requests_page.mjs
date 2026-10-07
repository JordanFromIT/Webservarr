// The Requests page (app/static/js/pages/requests.js) run for real in
// happy-dom over its own markup (requests.html), with a scripted network and
// a fake clock. Covers "Where requests stand" with book requests in it (the
// rows, their words, the Kind filter, Chaptarr down with the films still
// listed, the films down with the books still listed, the text-only
// rendering of a hostile title), the queue figures, and the phone search
// row (its own reserved row above "Trending", which folds away once the bar
// has gone down to the results).
//
// REQUESTS_JS=<path> runs the same cases against another copy of the module.
// Run: node app/tests/js/requests_page.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const REQUESTS_PATH = process.env.REQUESTS_JS || join(STATIC, 'js/pages/requests.js');
const REQUESTS_HTML = readFileSync(join(STATIC, 'requests.html'), 'utf8');
const AUTH_JS = readFileSync(join(STATIC, 'js/auth.js'), 'utf8');

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

function network() {
  const handlers = [];
  const calls = [];
  return {
    calls,
    on(prefix, fn) { handlers.unshift({ prefix, fn }); },
    urls(prefix) { return calls.filter((c) => c.url.indexOf(prefix) === 0).map((c) => c.url); },
    fetch(url, init) {
      calls.push({ url, init });
      // Exact match first for the two status addresses (one is a prefix of the other).
      const h = handlers.find((x) => url === x.prefix) || handlers.find((x) => !x.exact && url.indexOf(x.prefix) === 0);
      if (!h) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve(h.fn(url, init)).then((r) => {
        const res = r || { body: {} };
        const status = res.status || 200;
        return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(res.body) };
      });
    }
  };
}

const src = readFileSync(REQUESTS_PATH, 'utf8');
const requestsModule = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

// escapeHtml and getTimeAgo are auth.js globals on the real page.
const authGlobals = new Function(AUTH_JS + '\nreturn { escapeHtml, getTimeAgo };')();

const NAV = /<div id="wsPage"[\s\S]*<\/main>/;
const quietConsole = { error() {}, warn() {}, log() {}, info() {} };
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

function visit(routes) {
  const win = new Window({ url: 'https://ws.test/requests', width: 412, height: 850 });
  const doc = win.document;
  doc.body.innerHTML = REQUESTS_HTML.match(NAV)[0].replace(/<\/main>$/, '');
  const clock = fakeClock();
  const net = network();
  routes(net);
  const ctl = new win.AbortController();
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const WS = { dragScroll: Object.assign(() => {}, { stop() {} }), arrive: (k, f) => f(), data: {}, leaveTo() {},
    mediaType: () => ({ label: '', icon: '', accent: '' }), requestStatus: () => ({ label: '', tone: '' }),
    getJSON: (u, o) => net.fetch(u, o).then((r) => r.json()), setHTML() {}, swr: () => Promise.resolve(null), poll: () => () => {} };
  set('window', win);
  set('document', doc);
  set('localStorage', win.localStorage);
  set('sessionStorage', win.sessionStorage);
  set('WS', WS);
  win.WS = WS;
  set('fetch', (u, o) => net.fetch(u, o));
  set('checkAuth', async () => ({ username: 'sam', is_admin: false }));
  set('escapeHtml', authGlobals.escapeHtml);
  set('getTimeAgo', authGlobals.getTimeAgo);
  set('requestAnimationFrame', (fn) => clock.setTimeout(fn, 16));
  set('cancelAnimationFrame', (id) => clock.clearTimeout(id));
  // Reduced motion: the search bar settles at once.
  win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  set('WSUI', { toast() {}, modal() { return { close() {} }; } });
  set('console', quietConsole);
  const ctx = {
    root: doc.getElementById('wsPage'), signal: ctl.signal, url: new URL('https://ws.test/requests'), data: {},
    poll: () => () => {}, setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (id) => clock.clearTimeout(id),
    onNavigate() {}, beforeLeave() {}, setTitle() {}
  };
  const q = (sel) => doc.querySelector(sel);
  return {
    win, doc, net, clock, ctl, ctx, q,
    rows() { return Array.from(doc.querySelectorAll('#rsBody tr.rs-row')); },
    // The title cell leads with the phone's expand icon (a ligature): left out.
    cells(tr) { return Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.replace(/^\s*expand_(more|less)/, '').replace(/\s+/g, ' ').trim()); },
    async mount() {
      const m = requestsModule.mount(ctx);
      await clock.advance(1800);
      await m.catch(() => {});
      await clock.advance(50);
    },
    pick(value) { const s = q('#rsFilterType'); s.value = value; s.dispatchEvent(new win.Event('change')); },
    release() { ctl.abort(); for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; } }
  };
}

const FILMS = {
  generated_at: new Date().toISOString(), counts: {}, total: 2,
  items: [
    { request_id: 11, media_type: 'movie', title: 'A Film', year: 2026, requested_at: iso(40), reason_code: 'NO_RELEASE_FOUND' },
    { request_id: 12, media_type: 'tv', title: 'A Show', year: 2025, requested_at: iso(10), reason_code: 'NOT_RELEASED_YET' }
  ]
};
const BOOKS = {
  generated_at: new Date().toISOString(), configured: true, total: 4,
  summary: { in_progress: 3, unreleased: 1, added_recently: 4 },
  items: [
    { request_id: 'book-6984', media_type: 'ebook', title: 'Marius’ Mules I', author: 'S.J.A. Turney', requested_at: iso(38), reason_code: 'DOWNLOAD_STALLED', percent: 0 },
    { request_id: 'book-7362', media_type: 'audiobook', title: 'The Adventures of Huckleberry Finn', author: 'Mark Twain', requested_at: iso(1), reason_code: 'NO_RELEASE_FOUND' },
    { request_id: 'book-7400', media_type: 'audiobook', title: 'Halfway', author: 'Someone', requested_at: iso(2), reason_code: 'DOWNLOADING', percent: 42 },
    { request_id: 'book-7401', media_type: 'ebook', title: 'Next Year', author: 'Someone Else', requested_at: iso(0), reason_code: 'NOT_RELEASED_YET' }
  ]
};
const SUMMARY = { movies: 1, shows: 1, episodes: 1, ebooks: 21, audiobooks: 36, bytes: 1, added_recently: 85, in_progress: 167, unreleased: 29 };

const routes = (films, books) => (net) => {
  net.on('/api/request-status/', () => films);
  net.on('/api/request-status/books', () => books);
  net.on('/api/integrations/library-summary', () => ({ body: SUMMARY }));
};

async function run(name, fn) {
  current = name;
  try { await fn(); } catch (e) { check('threw: ' + (e && e.stack || e), false); }
}

await run('book rows sit among the film rows, in the same words', async () => {
  const t = visit(routes({ body: FILMS }, { body: BOOKS }));
  try {
    await t.mount();
    check('both status addresses asked', t.net.urls('/api/request-status/books').length === 1 &&
      t.net.calls.some((c) => c.url === '/api/request-status/'));
    check('six rows', t.rows().length === 6, t.rows().length);
    check('the count says six', t.q('#rsCount').textContent === '6', t.q('#rsCount').textContent);
    const byTitle = {};
    for (const tr of t.rows()) { const c = t.cells(tr); byTitle[c[0]] = c; }
    const huck = byTitle[Object.keys(byTitle).find((k) => k.indexOf('The Adventures of Huckleberry') === 0)];
    check('an audiobook row: author under the title', !!huck && huck[0].indexOf('Mark Twain') !== -1, Object.keys(byTitle));
    check('...Searching, still checking, waiting a day, type Audiobook',
      !!huck && huck[1] === 'Searching' && huck[2] === 'No copy online yet, still checking' && huck[3] === '1 day' && huck[4] === 'Audiobook', huck);
    const marius = Object.keys(byTitle).find((k) => k.indexOf('Marius') === 0);
    check('a stalled ebook download is Retrying, type Ebook', byTitle[marius][1] === 'Retrying' && byTitle[marius][4] === 'Ebook', byTitle[marius]);
    const half = Object.keys(byTitle).find((k) => k.indexOf('Halfway') === 0);
    check('a running download says how far', byTitle[half][1] === 'Downloading' && byTitle[half][2] === 'Downloading, 42% done', byTitle[half]);
    const next = Object.keys(byTitle).find((k) => k.indexOf('Next Year') === 0);
    check('an unreleased book is Not out yet', byTitle[next][1] === 'Not out yet' && byTitle[next][2] === 'Not released yet', byTitle[next]);
    check('no note while Chaptarr answers', t.q('#rsNote').classList.contains('hidden'));
    check('the queue figures are the summary’s (books included server side)',
      t.q('#statInProgress').textContent === '167' && t.q('#statUnreleased').textContent === '29' && t.q('#statAdded').textContent === '85');
    check('the library figures are unchanged', t.q('#statEbooks').textContent === '21' && t.q('#statAudiobooks').textContent === '36');
  } finally { t.release(); }
});

await run('the Kind filter', async () => {
  const t = visit(routes({ body: FILMS }, { body: BOOKS }));
  try {
    await t.mount();
    const opts = Array.from(t.q('#rsFilterType').options).map((o) => o.value + '=' + o.textContent);
    check('the options', JSON.stringify(opts) === JSON.stringify(
      ['=All kinds', 'video=Movies & shows', 'movie=Movies', 'tv=Shows', 'book=Books', 'ebook=Ebooks', 'audiobook=Audiobooks']), opts);
    const types = () => t.rows().map((tr) => t.cells(tr)[4]).sort().join(',');
    t.pick('book');
    check('Books: ebooks and audiobooks', types() === 'Audiobook,Audiobook,Ebook,Ebook', types());
    t.pick('ebook');
    check('Ebooks', types() === 'Ebook,Ebook', types());
    t.pick('audiobook');
    check('Audiobooks', types() === 'Audiobook,Audiobook', types());
    t.pick('video');
    check('Movies & shows', types() === 'Movie,Show', types());
    t.pick('tv');
    check('Shows', types() === 'Show', types());
    t.pick('');
    check('All kinds', t.rows().length === 6);
    t.q('#rsSearch').value = 'twain';
    t.q('#rsSearch').dispatchEvent(new t.win.Event('input'));
    check('the find box matches an author', t.rows().length === 1 && t.cells(t.rows()[0])[0].indexOf('The Adventures of Huckleberry') === 0);
  } finally { t.release(); }
});

await run('Chaptarr down: the films and shows still list, and a line says why', async () => {
  const t = visit(routes({ body: FILMS }, { status: 503, body: { detail: 'Book requests can’t be checked right now.' } }));
  try {
    await t.mount();
    check('the section is shown', !t.q('#rsSection').classList.contains('hidden'));
    check('two film/show rows', t.rows().length === 2 && t.rows().every((tr) => /^(Movie|Show)$/.test(t.cells(tr)[4])));
    check('the note is shown, in words', !t.q('#rsNote').classList.contains('hidden') &&
      t.q('#rsNote').textContent === 'Book requests can’t be checked right now, so only movies and shows are listed.', t.q('#rsNote').textContent);
  } finally { t.release(); }
});

await run('the films down: the books still list', async () => {
  const t = visit(routes({ status: 429, body: {} }, { body: BOOKS }));
  try {
    await t.mount();
    check('four book rows', t.rows().length === 4, t.rows().length);
    check('no Chaptarr note', t.q('#rsNote').classList.contains('hidden'));
  } finally { t.release(); }
});

await run('nothing waiting anywhere: the section stays collapsed', async () => {
  const t = visit(routes({ body: { items: [] } }, { body: { items: [], configured: false } }));
  try {
    t.doc.documentElement.setAttribute('data-rs-empty', '');
    await t.mount();
    check('hidden', t.q('#rsSection').classList.contains('hidden'));
    check('the server mark stays', t.doc.documentElement.hasAttribute('data-rs-empty'));
  } finally { t.release(); }
});

await run('a book title is text, never markup', async () => {
  const nasty = '<img src=x onerror="window.__pwned=1">';
  const books = Object.assign({}, BOOKS, { items: [Object.assign({}, BOOKS.items[0], { title: nasty, author: '<b>bold</b>' })] });
  const t = visit(routes({ body: { items: [] } }, { body: books }));
  try {
    await t.mount();
    check('no element made from the title', !t.q('#rsBody img') && !t.q('#rsBody b'));
    check('the title reads as typed', t.cells(t.rows()[0])[0].indexOf(nasty) === 0, t.cells(t.rows()[0])[0]);
  } finally { t.release(); }
});

await run('phone search row: its own reserved row, folded once the bar moves down', async () => {
  const t = visit(routes({ body: FILMS }, { body: BOOKS }));
  try {
    const home = t.q('#searchHome');
    const cls = home.className.split(/\s+/);
    check('below lg (where the phone/tablet top bar is) the home row is in the flow: no unprefixed sticky, h-0 or absolute',
      cls.indexOf('sticky') === -1 && cls.indexOf('h-0') === -1 && cls.indexOf('lg:sticky') !== -1 && cls.indexOf('lg:h-0') !== -1, cls);
    const slot = t.q('#searchHomeSlot').className.split(/\s+/);
    check('the slot reserves the field’s height below lg, left-aligned, and floats centred from lg',
      slot.indexOf('min-h-[var(--search-bar-h)]') !== -1 && slot.indexOf('absolute') === -1 && slot.indexOf('lg:absolute') !== -1 &&
      slot.indexOf('mx-auto') === -1 && slot.indexOf('lg:mx-auto') !== -1, slot);
    const style = REQUESTS_HTML.split('</head>')[0];
    check('one height for the field and the reserved row',
      /#wsPage \{ --search-bar-h: [\d.]+rem; \}/.test(style) && style.indexOf('#searchInput { height: var(--search-bar-h); }') !== -1);
    check('the row comes before "Trending"', home.compareDocumentPosition(t.q('#trendingTitle')) & 4);
    await t.mount();
    check('on arrival the bar is in the home row', t.q('#searchBar').parentElement === t.q('#searchHomeSlot'));
    check('the home row is open', !home.classList.contains('hidden'));
    const input = t.q('#searchInput');
    input.value = 'dune';
    input.dispatchEvent(new t.win.Event('input'));
    await t.clock.advance(50);
    check('typing moves the bar to the results', t.q('#searchBar').parentElement === t.q('#searchDock'));
    check('and the empty home row folds away', home.classList.contains('hidden'));
  } finally { t.release(); }
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
