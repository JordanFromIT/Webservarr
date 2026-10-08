// The Requests page (app/static/js/pages/requests.js) run for real in
// happy-dom over its own markup (requests.html), with a scripted network and
// a fake clock. Covers "Where requests stand" with book requests in it (the
// rows, their words, the Kind filter, Chaptarr down with the films still
// listed, the films down with the books still listed, the text-only
// rendering of a hostile title), the queue figures, the phone search row
// (its own reserved row above "Trending", which folds away once the bar has
// gone down to the results), the search results holding their size while a
// search is out, the bar's transform-only flight, and the detail's year and
// rating leaving no gap when empty.
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

// ---- Book search: real states, the book detail, and requests that report back ----

const BANE = (over) => Object.assign({
  id: 'gr:3341500', media_type: 'book', title: 'Rule of Two (Star Wars: Darth Bane, #2)', short_title: 'Rule of Two',
  series: 'Star Wars: Darth Bane', series_number: '2', author: 'Drew Karpyshyn', year: 2007, poster_url: '',
  overview: 'Darth Bane takes an apprentice.', media_status: null, states: { ebook: null, audiobook: null }, rating: 3.9
}, over || {});
const BOOK_RESULTS = [
  BANE({ id: 'gr:1330495', title: 'Path of Destruction (Star Wars: Darth Bane, #1)', short_title: 'Path of Destruction',
    series_number: '1', media_status: 'available', states: { ebook: 'available', audiobook: 'searching' } }),
  BANE(),
  BANE({ id: 'gr:6538485', title: 'Dynasty of Evil (Star Wars: Darth Bane, #3)', short_title: 'Dynasty of Evil',
    series_number: '3', media_status: 'processing', states: { ebook: 'downloading', audiobook: null } })
];

const bookRoutes = (requestAnswer) => (net) => {
  routes({ body: FILMS }, { body: BOOKS })(net);
  net.on('/api/integrations/seerr-search', () => ({ body: { results: [], totalResults: 0, totalPages: 1 } }));
  net.on('/api/integrations/chaptarr-search', () => ({ body: { results: BOOK_RESULTS.map((b) => JSON.parse(JSON.stringify(b))) } }));
  net.on('/api/integrations/chaptarr-request', requestAnswer);
  net.on('/api/integrations/book-in-library', () => ({ body: { book_id: 24, formats: ['ebook'] } }));
};

async function searchBooks(t) {
  await t.mount();
  const input = t.q('#searchInput');
  input.value = 'darth bane';
  input.dispatchEvent(new t.win.Event('input'));
  await t.clock.advance(400);
}

const cardFor = (t, i) => t.q('[data-action="open-search"][data-index="' + i + '"]').parentElement;

await run('book search: each card has one action, and says where the book stands', async () => {
  const t = visit(bookRoutes(() => ({ body: { ok: true, state: 'requested' } })));
  try {
    await searchBooks(t);
    check('three book cards, each with a detail opener', t.doc.querySelectorAll('[data-action="open-search"]').length === 3);
    const block = (i) => cardFor(t, i).querySelector('[data-book-state]');
    const state = (i) => { const el = block(i); return el ? el.getAttribute('data-book-state') + ':' + el.textContent.trim() : null; };
    check('ebook here, audiobook searching: the one still coming is named', state(0) === 'searching:Audiobook Searching', state(0));
    check('...and each format\'s word is in its title', block(0).getAttribute('title') === 'Ebook in library, audiobook searching', block(0).getAttribute('title'));
    check('...the format named by its icon on screen, by its name for a screen reader',
      !!block(0).querySelector('.material-symbols-outlined[aria-hidden="true"]') && block(0).querySelector('.sr-only').textContent === 'Audiobook ');
    check('not asked for: one Request button', !state(1) && cardFor(t, 1).querySelectorAll('[data-action="request-media"]').length === 1);
    check('it asks for the book, not a format', cardFor(t, 1).querySelector('[data-action="request-media"]').getAttribute('data-request-type') === 'book' &&
      /^Request\s+Book$/.test(cardFor(t, 1).querySelector('[data-action="request-media"]').textContent.trim()));
    check('only the ebook asked for: named', state(2) === 'downloading:Ebook Downloading' && !block(2).getAttribute('title'), state(2));
    check('never two actions on a card', [0, 1, 2].every((i) => cardFor(t, i).querySelectorAll('[data-book-state], [data-action="request-media"]').length === 1));
    check('the opener holds no control of its own', !t.q('[data-action="open-search"] button'));
  } finally { t.release(); }
});

await run('book detail: series, author, one Request for the book, request from it', async () => {
  const sent = [];
  const t = visit(bookRoutes((url, init) => {
    sent.push(JSON.parse(init.body));
    return { body: { ok: true, message: 'Book requested', state: 'requested', states: { ebook: 'requested', audiobook: 'requested' } } };
  }));
  const toasts = [];
  globalThis.WSUI.toast = (m, k) => toasts.push(k + ':' + m);
  try {
    await searchBooks(t);
    t.q('[data-action="open-search"][data-index="1"]').click();
    await flush();
    check('the detail is open', !t.q('#mediaModal').classList.contains('hidden'));
    check('title without the series', t.q('#modalTitle').textContent === 'Rule of Two', t.q('#modalTitle').textContent);
    check('the series and its number', t.q('#modalSeries').textContent === 'Star Wars: Darth Bane, book 2' && !t.q('#modalSeries').classList.contains('hidden'));
    check('the author', t.q('#modalByline').textContent === 'by Drew Karpyshyn');
    check('year and description', t.q('#modalYear').textContent === '2007' && t.q('#modalOverview').textContent === 'Darth Bane takes an apprentice.');
    check('no line for a book nobody asked for', t.q('#modalLibrary').classList.contains('hidden'));
    const buttons = Array.from(t.q('#modalActionArea').querySelectorAll('button'));
    check('ONE Request button, for the book', buttons.length === 1 && buttons[0].getAttribute('data-action') === 'request-from-modal' &&
      buttons[0].getAttribute('data-media-type') === 'book' && /^Request\s+Book$/.test(buttons[0].textContent.trim()), buttons.map((b) => b.textContent));
    buttons[0].click();
    await flush();
    check('the book is asked for in both formats, by its id', sent.length === 1 && sent[0].bookId === 'gr:3341500' && sent[0].format === 'both', sent);
    const block = t.q('#modalActionArea [data-book-state]');
    check('the detail now says Book Requested, in one block', !!block && block.getAttribute('data-book-state') === 'requested' &&
      block.textContent.trim() === 'Book Requested' && t.q('#modalActionArea').children.length === 1, block && block.textContent);
    check('no button left to press', !t.q('#modalActionArea button'));
    check('both formats alike: no format icon, the words say Book', !block.querySelector('.material-symbols-outlined'));
    check('both formats alike: no per-format line', t.q('#modalLibrary').classList.contains('hidden'));
    const cardState = cardFor(t, 1).querySelector('[data-book-state]');
    check('and so does its card', !!cardState && cardState.getAttribute('data-book-state') === 'requested' && cardState.textContent.trim() === 'Book Requested');
    check('a success toast naming it', toasts.indexOf('ok:Requested Rule of Two (Star Wars: Darth Bane, #2)') !== -1, toasts);
  } finally { t.release(); }
});

await run('a refused book request is an error, and the button comes back', async () => {
  const t = visit(bookRoutes(() => ({ status: 400, body: { detail: 'This book has already been added.' } })));
  const toasts = [];
  globalThis.WSUI.toast = (m, k) => toasts.push(k + ':' + m);
  try {
    await searchBooks(t);
    const btn = cardFor(t, 1).querySelector('[data-action="request-media"]');
    btn.click();
    await flush();
    check('Chaptarr’s reason is shown', toasts.indexOf('err:This book has already been added.') !== -1, toasts);
    const again = cardFor(t, 1).querySelector('[data-action="request-media"]');
    check('the Request button is back, enabled', !!again && !again.disabled && again.textContent.indexOf('Request') === 0);
    check('no status claimed', !cardFor(t, 1).querySelector('[data-book-state]'));
  } finally { t.release(); }
});

await run('a book with one format here links its Books entry, and says where each stands', async () => {
  const t = visit(bookRoutes(() => ({ body: {} })));
  try {
    await searchBooks(t);
    t.q('[data-action="open-search"][data-index="0"]').click();
    await flush();
    const line = t.q('#modalLibrary');
    check('the line says each format\'s word', !line.classList.contains('hidden') && line.textContent === 'Ebook in library, audiobook searching', line.textContent);
    const asked = t.net.urls('/api/integrations/book-in-library');
    check('asked by title and author', asked.length === 1 && asked[0].indexOf('title=Path%20of%20Destruction') !== -1 && asked[0].indexOf('author=Drew%20Karpyshyn') !== -1, asked);
    const a = line.querySelector('a');
    check('a link to the Books entry, same words', !!a && a.getAttribute('href') === '/books/24' && a.textContent === 'Ebook in library, audiobook searching');
    const blocks = Array.from(t.q('#modalActionArea').querySelectorAll('[data-book-state]'));
    check('one status block, naming the format still coming', blocks.length === 1 && blocks[0].textContent.trim() === 'Audiobook Searching', blocks.map((b) => b.textContent));
    t.q('[data-action="close-modal"]').click();
    await flush();
  } finally { t.release(); }
});

await run('the ebook here, the audiobook never asked for: Request asks for the rest', async () => {
  const results = [BANE({ states: { ebook: 'available', audiobook: null }, media_status: 'available' })];
  const sent = [];
  const t = visit((net) => {
    bookRoutes((url, init) => {
      sent.push(JSON.parse(init.body));
      return { body: { ok: true, message: 'Book requested', state: 'requested', states: { ebook: 'available', audiobook: 'requested' } } };
    })(net);
    net.on('/api/integrations/chaptarr-search', () => ({ body: { results } }));
  });
  try {
    await searchBooks(t);
    check('the card offers the request', !!cardFor(t, 0).querySelector('[data-action="request-media"]'));
    t.q('[data-action="open-search"][data-index="0"]').click();
    await flush();
    check('the line says the ebook is here', t.q('#modalLibrary').textContent === 'Ebook in library', t.q('#modalLibrary').textContent);
    t.q('#modalActionArea [data-action="request-from-modal"]').click();
    await flush();
    check('sent for the book', sent.length === 1 && sent[0].format === 'both');
    const block = t.q('#modalActionArea [data-book-state]');
    check('the block names the audiobook', !!block && block.textContent.trim() === 'Audiobook Requested', block && block.textContent);
    check('the line has both words', t.q('#modalLibrary').textContent === 'Ebook in library, audiobook requested', t.q('#modalLibrary').textContent);
  } finally { t.release(); }
});

// ---- Film and show search results open the same detail as the discover posters ----

const FILM_RESULTS = [
  { id: 438631, media_type: 'movie', title: 'Dune', year: 2021, poster_url: '', overview: 'A desert planet.', media_status: null, vote_average: 7.8 },
  { id: 1399, media_type: 'tv', title: 'Dune: Prophecy', year: 2024, poster_url: '', overview: 'The sisterhood.', media_status: 'AVAILABLE' },
  { id: 693134, media_type: 'movie', title: 'Dune: Part Two', year: 2024, poster_url: '', overview: 'Paul unites.', media_status: null, media_status_4k: 'AVAILABLE' }
];

const filmRoutes = (requestAnswer) => (net) => {
  routes({ body: FILMS }, { body: BOOKS })(net);
  net.on('/api/integrations/seerr-search', () => ({ body: { results: FILM_RESULTS.map((b) => Object.assign({}, b)), totalResults: 3, totalPages: 1 } }));
  net.on('/api/integrations/chaptarr-search', () => ({ body: { results: [] } }));
  net.on('/api/integrations/seerr-request', requestAnswer);
};

async function searchFilms(t) {
  await t.mount();
  const input = t.q('#searchInput');
  input.value = 'dune';
  input.dispatchEvent(new t.win.Event('input'));
  await t.clock.advance(400);
}

await run('film and show search results: each opens its detail', async () => {
  const t = visit(filmRoutes(() => ({ body: { id: 1 } })));
  try {
    await searchFilms(t);
    const openers = Array.from(t.doc.querySelectorAll('#searchResultsGrid [data-action="open-search"]'));
    check('every card has a detail opener', openers.length === 3, openers.length);
    check('each is a button named by its title', openers.every((b) => b.tagName === 'BUTTON' && b.getAttribute('type') === 'button') &&
      openers[0].textContent.indexOf('Dune') !== -1);
    check('the poster adds nothing to the name (empty alt or a glyph)', !t.q('#searchResultsGrid [data-action="open-search"] img[alt]:not([alt=""])'));
    check('the Request button is beside the opener, not inside it', !t.q('[data-action="open-search"] button') &&
      !!cardFor(t, 0).querySelector(':scope > div [data-action="request-media"]'));
    check('a title here in 4K only reads as here', !cardFor(t, 2).querySelector('[data-action="request-media"]'));
    openers[1].click();
    await flush();
    check('the show\'s detail is open', !t.q('#mediaModal').classList.contains('hidden') && t.q('#modalTitle').textContent === 'Dune: Prophecy');
    check('its description', t.q('#modalOverview').textContent === 'The sisterhood.');
    check('no Request for a show already here', !t.q('#modalActionArea button'));
    check('no book line on a show', t.q('#modalLibrary').classList.contains('hidden'));
  } finally { t.release(); }
});

await run('a film requested from its detail: the card under it says so, and focus finds the card again', async () => {
  const sent = [];
  const t = visit(filmRoutes((url, init) => { sent.push(JSON.parse(init.body)); return { body: { id: 1 } }; }));
  // WSUI.modal as ui.js has it: close runs onClose, then hands focus back to
  // the opener only if it is still in the page.
  let closeIt = null;
  globalThis.WSUI.modal = (overlay, opts) => {
    const previous = t.doc.activeElement;
    closeIt = () => { opts.onClose(); if (previous && t.doc.contains(previous)) previous.focus(); };
    return { close: () => closeIt() };
  };
  try {
    await searchFilms(t);
    const opener = t.q('[data-action="open-search"][data-index="0"]');
    opener.focus();
    opener.click();
    await flush();
    check('the film\'s detail is open', t.q('#modalTitle').textContent === 'Dune');
    const ask = t.q('#modalActionArea [data-action="request-from-modal"]');
    check('a Request button for the film', !!ask && ask.getAttribute('data-media-type') === 'movie');
    ask.click();
    await flush();
    check('asked of Seerr for that film', sent.length === 1 && sent[0].mediaType === 'movie' && String(sent[0].mediaId) === '438631', sent);
    check('the card under the detail no longer offers it', !cardFor(t, 0).querySelector('[data-action="request-media"]'));
    t.q('[data-action="close-modal"]').click();
    await flush();
    const again = t.q('[data-action="open-search"][data-index="0"]');
    check('closed', t.q('#mediaModal').classList.contains('hidden'));
    check('focus is on the redrawn card\'s opener', t.doc.activeElement === again && again !== opener);
    again.click();
    await flush();
    check('reopened, it says where the film stands rather than offering it again', !t.q('#modalActionArea [data-action="request-from-modal"]'));
  } finally { t.release(); }
});

// ---- Zero layout shift while searching: the results hold their size ----

// A search whose answer waits until the test lets it go.
function heldSearch() {
  const out = [];
  return {
    out,
    routes: (net) => {
      routes({ body: FILMS }, { body: BOOKS })(net);
      net.on('/api/integrations/chaptarr-search', () => ({ body: { results: [] } }));
      net.on('/api/integrations/seerr-search', (url) => new Promise((resolve) => out.push({ url, resolve })));
    },
    answer(i, results) { out[i].resolve({ body: { results, totalResults: results.length, totalPages: 1 } }); }
  };
}
const filmPage = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, media_type: 'movie', title: tag + ' ' + i, year: 2020, poster_url: '', media_status: null }));

async function typeQuery(t, text) {
  const input = t.q('#searchInput');
  input.value = text;
  input.dispatchEvent(new t.win.Event('input'));
  await t.clock.advance(400);
}

await run('the first search holds a page of skeleton cards, not a one-line "Searching"', async () => {
  const h = heldSearch();
  const t = visit(h.routes);
  try {
    await t.mount();
    await typeQuery(t, 'dune');
    const grid = t.q('#searchResultsGrid');
    check('nine skeleton cards, hidden from screen readers', grid.querySelectorAll(':scope > .skel[aria-hidden="true"]').length === 9, grid.children.length);
    check('no "Searching" line in the grid', grid.textContent.indexOf('Searching') === -1);
    check('busy and out of reach', grid.getAttribute('aria-busy') === 'true' && grid.inert === true);
    check('skeletons are not dimmed as stale', !grid.hasAttribute('data-stale'));
    check('the count says it is searching, as a live region',
      t.q('#searchResultCount').textContent === 'Searching…' && t.q('#searchResultCount').getAttribute('aria-live') === 'polite');
    h.answer(0, filmPage(9, 'Dune'));
    await t.clock.advance(50);
    check('the answer replaces them', grid.querySelectorAll('[data-action="open-search"]').length === 9 && !grid.querySelector('.skel'));
    check('no longer busy', !grid.hasAttribute('aria-busy') && grid.inert === false);
    check('the count', t.q('#searchResultCount').textContent === '9 results');
  } finally { t.release(); }
});

await run('a second search keeps the first one\'s cards, dimmed, until its answer is drawn', async () => {
  const h = heldSearch();
  const t = visit(h.routes);
  try {
    await t.mount();
    await typeQuery(t, 'dune');
    h.answer(0, filmPage(9, 'Dune'));
    await t.clock.advance(50);
    await typeQuery(t, 'star');
    const grid = t.q('#searchResultsGrid');
    const titles = () => Array.from(grid.querySelectorAll('[data-action="open-search"]')).map((b) => b.textContent.trim().replace(/\s+/g, ' '));
    check('the old cards stay while the answer is out', titles().length === 9 && titles()[0].indexOf('Dune 0') === 0, titles());
    check('...dimmed as stale, busy and inert', grid.hasAttribute('data-stale') && grid.getAttribute('aria-busy') === 'true' && grid.inert === true);
    h.answer(1, filmPage(9, 'Star'));
    await t.clock.advance(50);
    check('the new answer replaces them', titles()[0].indexOf('Star 0') === 0, titles());
    check('not dimmed any more', !grid.hasAttribute('data-stale') && !grid.hasAttribute('aria-busy') && grid.inert === false);
    check('the dimming is a style of the page, not a palette class', /#searchResultsGrid\[data-stale\] \{ opacity: [\d.]+;/.test(REQUESTS_HTML));
  } finally { t.release(); }
});

await run('a short page held while the next one is fetched is topped up to a full page', async () => {
  const h = heldSearch();
  const t = visit(h.routes);
  try {
    await t.mount();
    await typeQuery(t, 'dune');
    h.answer(0, filmPage(4, 'Dune'));
    await t.clock.advance(50);
    await typeQuery(t, 'dunes');
    const grid = t.q('#searchResultsGrid');
    check('four held cards and five skeletons', grid.querySelectorAll('[data-action="open-search"]').length === 4 &&
      grid.querySelectorAll(':scope > .skel').length === 5, grid.children.length);
    h.answer(1, []);
    await t.clock.advance(50);
    check('nothing found: said in words, skeletons gone', grid.textContent.indexOf('Nothing matches') !== -1 && !grid.querySelector('.skel'));
  } finally { t.release(); }
});

await run('the search bar flies with a transform: its box is in the results slot from the first keystroke', async () => {
  const h = heldSearch();
  const t = visit(h.routes);
  try {
    await t.mount();
    t.win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // Frames with a timestamp, as the browser gives them.
    let frameAt = 0;
    globalThis.requestAnimationFrame = (fn) => t.clock.setTimeout(() => { frameAt += 16; fn(frameAt); }, 16);
    const bar = t.q('#searchBar');
    const input = t.q('#searchInput');
    input.focus();
    input.value = 'd';
    input.dispatchEvent(new t.win.Event('input'));
    check('already in the dock', bar.parentElement === t.q('#searchDock'));
    check('focus kept', t.doc.activeElement === input);
    check('painted where it was by a transform', /^translate\(/.test(bar.style.transform));
    check('never moved by top, left or position:fixed', !bar.style.top && !bar.style.left && bar.style.position !== 'fixed');
    await t.clock.advance(1000);
    check('mid-flight: still only a transform', /^translate\(/.test(bar.style.transform) && !bar.style.top && bar.style.position !== 'fixed');
    await t.clock.advance(2500);
    check('landed: no flight styles left', bar.style.cssText === '', bar.style.cssText);
    check('the phone home row folded once landed', t.q('#searchHome').classList.contains('hidden'));
  } finally { t.release(); }
});

await run('the detail leaves no gap where an empty year or rating would be', async () => {
  const t = visit((net) => {
    routes({ body: FILMS }, { body: BOOKS })(net);
    net.on('/api/integrations/seerr-search', () => ({ body: { results: [
      { id: 1, media_type: 'movie', title: 'No Year', year: null, poster_url: '', overview: 'x', media_status: null },
      { id: 2, media_type: 'tv', title: 'With Year', year: 2024, poster_url: '', overview: 'y', media_status: null, vote_average: 7.1 }
    ], totalResults: 2, totalPages: 1 } }));
    net.on('/api/integrations/chaptarr-search', () => ({ body: { results: [BANE({ year: null, rating: 0 })] } }));
    net.on('/api/integrations/book-in-library', () => ({ body: {} }));
  });
  try {
    await t.mount();
    await typeQuery(t, 'x');
    const open = (title) => {
      const b = Array.from(t.doc.querySelectorAll('[data-action="open-search"]')).find((x) => x.textContent.indexOf(title) !== -1);
      b.click();
    };
    open('No Year');
    await flush();
    check('a film with no year: the year is out of the row', t.q('#modalYear').classList.contains('hidden') && t.q('#modalYear').textContent === '');
    check('...and so is the empty rating', t.q('#modalRating').classList.contains('hidden'));
    open('With Year');
    await flush();
    check('a show with a year shows it', !t.q('#modalYear').classList.contains('hidden') && t.q('#modalYear').textContent === '2024');
    check('...and its rating', !t.q('#modalRating').classList.contains('hidden') && t.q('#modalRating').textContent === 'Rated 7.1 of 10');
    open('Rule of Two');
    await flush();
    check('a book with no year: no gap before the Book badge', t.q('#modalYear').classList.contains('hidden') && t.q('#modalTypeBadge').textContent === 'Book');
  } finally { t.release(); }
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
