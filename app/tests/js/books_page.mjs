// The Books page (app/static/js/pages/books.js) run for real in happy-dom (a
// dev-only dependency) over the page's own markup (books.html), with a
// scripted network, a fake clock, a fake shell (WS.swr and WS.arrive written
// as shell.js does them) and a fake Kavita hand-off helper. Covers: the
// skeleton and the render, top-down arrival, the format chips and the sort
// (and remembering them), progressive loading, series cards, format badges,
// search (the debounce, stale answers, the request link), the Continue row
// (and its notes when Kavita is down), the Kavita hand-off, the building
// state, the empty and error states, and that nothing is written as markup.
// Also mounts the Requests page (requests.js) to show /requests?q= runs its
// search on arrival.
//
// BOOKS_JS=<path> / REQUESTS_JS=<path> run the same cases against another
// copy of the module (how the cases were shown failing on the code before).
// Run: node app/tests/js/books_page.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const BOOKS_PATH = process.env.BOOKS_JS || join(STATIC, 'js/pages/books.js');
const REQUESTS_PATH = process.env.REQUESTS_JS || join(STATIC, 'js/pages/requests.js');
const BOOKS_HTML = readFileSync(join(STATIC, 'books.html'), 'utf8');
const REQUESTS_HTML = readFileSync(join(STATIC, 'requests.html'), 'utf8');

const report = console.error.bind(console);   // the Requests visits below quiet the global console
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
    pending() { return due.size; },
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

// ---- The modules, imported as they are ----

async function load(path) {
  const src = readFileSync(path, 'utf8');
  return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}
const books = await load(BOOKS_PATH);
const requestsModule = await load(REQUESTS_PATH);

// ---- A scripted network ----

function network() {
  const handlers = [];
  const calls = [];
  const net = {
    calls,
    // on('/api/books/search', (url, init) => ({ status, body }) | Promise)
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
  return net;
}

// A promise settled by the test.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ---- The shell, as shell.js has it (swr and arrive are its own logic) ----

function fakeShell(win, doc, clock, net) {
  const store = new Map();
  const arr = { order: [], done: {}, queue: {}, gate: false };
  const WS = {
    arrived: [],
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
    getJSON(url, opts) {
      return net.fetch(url, opts && opts.signal ? { signal: opts.signal } : undefined).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    },
    leaveTo(url) { WS.left.push(url); },
    dropCache(prefix) { for (const k of Array.from(store.keys())) if (k.indexOf(prefix) === 0) store.delete(k); },
    drags: [],
    dragScroll(el, opts) { WS.drags.push({ el, opts }); },
    left: [],
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

const ebook = (id, title, author, extra) => Object.assign({
  kind: 'book', id, title, author, cover_url: `/api/books/${id}/cover?v=1`, formats: ['ebook']
}, extra || {});
const audio = (id, title, author) => ebook(id, title, author, { formats: ['audio'] });
const both = (id, title, author) => ebook(id, title, author, { formats: ['ebook', 'audio'] });
const series = (name, count, formats, author) => ({
  kind: 'series', series: name, count, cover_book_id: 1, cover_url: '/api/books/1/cover?v=1',
  author: author || '', formats: formats || ['ebook', 'audio']
});

const SHELF = [both(1, 'Dune', 'Frank Herbert'), ebook(2, 'Emma', 'Jane Austen'), audio(3, 'The Hobbit', 'J. R. R. Tolkien'),
  series('Harry Potter', 7), ebook(5, 'Villette', 'Charlotte Brontë')];

function visit(o = {}) {
  const win = new Window({ url: o.url || 'https://ws.test/books' });
  const doc = win.document;
  doc.body.innerHTML = o.html || BOOKS_HTML.match(NAV)[0].replace(/<\/main>$/, '');
  const clock = fakeClock();
  const net = network();
  const ctl = new win.AbortController();
  const WS = fakeShell(win, doc, clock, net);
  const kav = { init: 0, reconnect: [], retry: 0, failed: false, blockNext: false };
  const toasts = [];
  const polls = [];
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win);
  set('document', doc);
  set('localStorage', win.localStorage);
  set('IntersectionObserver', o.IntersectionObserver);
  set('WS', WS);
  win.WS = WS;
  if (o.branding) WS.data.branding = o.branding;
  win.WSUI = { toast(m, kind) { toasts.push([m, kind]); } };
  set('WSUI', win.WSUI);
  if (o.kavita !== false) {
    win.WSKavita = {
      init() { kav.init += 1; },
      reconnect(cb) { kav.reconnect.push(cb); if (kav.blockNext) cb(); },
      retry() { kav.retry += 1; },
      arrivedFromFailedConnect() { return kav.failed; }
    };
  }
  if (o.player !== false) {
    win.WS.player = { opened: [], open(key, opts) { this.opened.push([key, opts]); return Promise.resolve(); } };
  }
  for (const [k, v] of Object.entries(o.storage || {})) win.localStorage.setItem(k, v);
  if (o.routes) o.routes(net);
  const ctx = {
    root: doc.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL(o.url || 'https://ws.test/books'),
    data: WS.data,
    poll(fn, ms) { const p = { fn, ms, stopped: false }; polls.push(p); return () => { p.stopped = true; }; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id)
  };
  WS.arriveReset();
  const t = {
    win, doc, clock, net, ctl, WS, kav, toasts, polls, ctx,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    hidden: (sel) => doc.querySelector(sel).classList.contains('hidden'),
    text: (sel) => (doc.querySelector(sel) || { textContent: null }).textContent,
    mount: () => books.mount(ctx),
    cards: (grid) => Array.from(doc.querySelectorAll(`#${grid} > li > a`)),
    release() {
      for (const k of Object.keys(saved)) {
        if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k];
      }
    },
    type(value) {
      const input = doc.getElementById('booksSearch');
      input.value = value;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    },
    key(k) { doc.getElementById('booksSearch').dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true })); },
    click(sel) { doc.querySelector(sel).click(); },
    change(sel, value) {
      const n = doc.querySelector(sel);
      n.value = value;
      n.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  };
  return t;
}

// The usual network: the library, an empty Continue row.
function usual(over = {}) {
  return (net) => {
    net.on('/api/books/continue', () => ({ body: over.continue || { items: [], notes: [] } }));
    net.on('/api/books/search', () => ({ body: over.search || { items: [], request_url: '/requests?q=x', notes: [] } }));
    net.on('/api/books?', over.library || (() => ({ body: { items: SHELF, next_cursor: null, notes: [], building: false } })));
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
    // Newest first: each puts back what it found.
    while (made.length) made.pop().release();
  }
}

// ---------------------------------------------------------------------------

await run('the skeleton holds the grid, then the books replace it', async (make) => {
  const slow = deferred();
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books?', () => slow.promise.then(() => ({ body: { items: SHELF, next_cursor: null, notes: [] } })));
  } });
  const mounted = t.mount();
  await flush();
  check('the skeleton shows', !t.hidden('#gridSkeleton'));
  check('with the shape of twelve books', t.qa('#gridSkeleton > div').length === 12, t.qa('#gridSkeleton > div').length);
  check('each skeleton is a cover and two lines', t.qa('#gridSkeleton > div').every((d) => d.children.length === 3));
  check('the grid and every message are away', t.hidden('#libraryGrid') && t.hidden('#errorState') && t.hidden('#emptyState') && t.hidden('#buildingState'));
  slow.resolve();
  await t.clock.advance(1600);
  await mounted;
  check('the skeleton is gone', t.hidden('#gridSkeleton'));
  check('the grid shows one item per card', !t.hidden('#libraryGrid') && t.qa('#libraryGrid > li').length === 5);
  const a = t.cards('libraryGrid');
  check('a book links to its page', a[0].getAttribute('href') === '/books/1' && a[1].getAttribute('href') === '/books/2', a.map((x) => x.getAttribute('href')));
  check('with its title and author', /Dune/.test(a[0].textContent) && /Frank Herbert/.test(a[0].textContent));
  check('the more button is away with no further page', t.hidden('#moreWrap'));
  check('the title keeps two lines of room', a[0].querySelectorAll('span.min-h-\\[2\\.75em\\]').length === 1);
  check('Continue is no longer loading', t.q('#continueHost').getAttribute('aria-busy') === 'false');
  check('the visit started the Kavita helper', t.kav.init === 1);
  check('the first page asked for 36', t.net.urls('/api/books?')[0] === '/api/books?format=all&sort=added&limit=36', t.net.urls('/api/books?'));
});

await run('sections arrive top-down: the library waits for Continue', async (make) => {
  const cont = deferred();
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books/continue', () => cont.promise.then(() => ({ body: { items: [{ book_id: 1, format: 'ebook', title: 'Dune', author: 'F', cover_url: '/c', progress_label: 'Ch. 2 · 10%', percent: 10, updated_at: 't', resume: { read_url: '/reader?seriesId=1&chapterId=2' } }], notes: [] } })));
  } });
  const mounted = t.mount();
  await t.clock.advance(100);
  check('the library has answered but waits', t.hidden('#libraryGrid') && t.WS.arrived.length === 0, t.WS.arrived);
  check('Continue is still loading', t.q('#continueHost').getAttribute('aria-busy') === 'true');
  cont.resolve();
  await t.clock.advance(100);
  await mounted;
  check('Continue goes first, then the library', t.WS.arrived.join(',') === 'continue,library', t.WS.arrived);
  check('and then the grid shows', !t.hidden('#libraryGrid'));

  // One slow section does not hold the page for ever: after the short gate the library shows.
  const never = deferred();
  const u = make({ routes: (net) => { usual()(net); net.on('/api/books/continue', () => never.promise); } });
  u.mount();
  await u.clock.advance(100);
  check('Continue still waiting: the grid waits', u.hidden('#libraryGrid'));
  await u.clock.advance(300);
  check('after the gate the library shows without it', !u.hidden('#libraryGrid') && u.WS.arrived.join(',') === 'library', u.WS.arrived);
});

await run('the chips filter the library and are remembered', async (make) => {
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books?format=ebook', () => ({ body: { items: [ebook(2, 'Emma', 'Jane Austen')], next_cursor: null, notes: [] } }));
    net.on('/api/books?format=audio', () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: [] } }));
  } });
  await t.mount();
  const chips = t.qa('#formatChips button');
  check('three chips: All, Ebooks, Audiobooks', chips.map((c) => c.textContent).join('|') === 'All|Ebooks|Audiobooks');
  check('All is pressed to begin with', chips[0].getAttribute('aria-pressed') === 'true' && chips[1].getAttribute('aria-pressed') === 'false');
  t.click('[data-format="ebook"]');
  check('the skeleton shows while the new list loads', !t.hidden('#gridSkeleton'));
  await t.clock.advance(50);
  check('Ebooks asks for ebooks', t.net.urls('/api/books?').pop() === '/api/books?format=ebook&sort=added&limit=36', t.net.urls('/api/books?'));
  check('Ebooks is pressed and All is not', t.qa('#formatChips button').map((c) => c.getAttribute('aria-pressed')).join() === 'false,true,false');
  check('and the grid is the ebooks', t.cards('libraryGrid').length === 1 && /Emma/.test(t.cards('libraryGrid')[0].textContent));
  check('the pressed chip is a primary fill, the others are not', /bg-primary/.test(t.q('[data-format="ebook"]').className) && !/bg-primary/.test(t.q('[data-format="all"]').className));
  t.click('[data-format="audio"]');
  await t.clock.advance(50);
  check('Audiobooks asks for audio', t.net.urls('/api/books?').pop() === '/api/books?format=audio&sort=added&limit=36');
  check('the choice is remembered for this person', t.win.localStorage.getItem('webservarr_books_view:sam') === '{"format":"audio","sort":"added"}', t.win.localStorage.getItem('webservarr_books_view:sam'));

  // The next visit starts where this one left off.
  const u = make({ storage: { 'webservarr_books_view:sam': '{"format":"audio","sort":"title"}' }, routes: (net) => {
    usual()(net);
    net.on('/api/books?format=audio', () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: [] } }));
  } });
  await u.mount();
  check('it asks for the remembered view at once', u.net.urls('/api/books?')[0] === '/api/books?format=audio&sort=title&limit=36', u.net.urls('/api/books?'));
  check('and the controls show it', u.q('[data-format="audio"]').getAttribute('aria-pressed') === 'true' && u.q('#sortSelect').value === 'title');
  // Rubbish in storage is ignored.
  const v = make({ storage: { 'webservarr_books_view:sam': '{"format":"pdf","sort":"nope"}' }, routes: usual() });
  await v.mount();
  check('an unknown value falls back to the defaults', v.net.urls('/api/books?')[0] === '/api/books?format=all&sort=added&limit=36');
});

await run('the sort reloads the list and an older answer cannot overwrite a newer one', async (make) => {
  const first = deferred();
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books?format=all&sort=title', () => ({ body: { items: [ebook(2, 'Emma', 'Jane Austen')], next_cursor: null, notes: [] } }));
    net.on('/api/books?format=all&sort=author', () => first.promise);
  } });
  await t.mount();
  check('the sort offers Recently added, Title and Author', t.qa('#sortSelect option').map((o) => o.textContent).join('|') === 'Recently added|Title|Author');
  t.change('#sortSelect', 'author');
  t.change('#sortSelect', 'title');
  await t.clock.advance(50);
  check('Title shows', t.cards('libraryGrid').length === 1 && /Emma/.test(t.cards('libraryGrid')[0].textContent));
  first.resolve({ body: { items: [audio(9, 'Stale Answer', 'X')], next_cursor: null, notes: [] } });
  await t.clock.advance(50);
  check('the late Author answer is dropped', t.cards('libraryGrid').length === 1 && !/Stale/.test(t.q('#libraryGrid').textContent));
  check('Title was asked for with its own cursorless URL', t.net.urls('/api/books?').indexOf('/api/books?format=all&sort=title&limit=36') !== -1);
});

await run('the next page loads on request and appends', async (make) => {
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books?', (url) => url.indexOf('cursor=') === -1
      ? { body: { items: SHELF, next_cursor: 'abc+/=', notes: [] } }
      : { body: { items: [ebook(6, 'Persuasion', 'Jane Austen'), ebook(7, 'Sula', 'Toni Morrison')], next_cursor: null, notes: [] } });
  } });
  await t.mount();
  check('a further page shows the button', !t.hidden('#moreWrap') && t.text('#moreBtn') === 'Show more');
  t.click('#moreBtn');
  check('the button says it is loading and cannot be pressed twice', t.text('#moreBtn') === 'Loading…' && t.q('#moreBtn').disabled);
  t.click('#moreBtn');
  await t.clock.advance(50);
  const asked = t.net.urls('/api/books?').filter((u) => u.indexOf('cursor=') !== -1);
  check('the cursor goes out encoded, once', asked.length === 1 && asked[0].endsWith('&cursor=abc%2B%2F%3D'), asked);
  check('the new books follow the old', t.qa('#libraryGrid > li').length === 7 && /Sula/.test(t.cards('libraryGrid')[6].textContent));
  check('with no more, the button is gone', t.hidden('#moreWrap'));
});

await run('a failed next page leaves the button to try again', async (make) => {
  let fail = true;
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books?', (url) => url.indexOf('cursor=') === -1
      ? { body: { items: SHELF, next_cursor: 'c1', notes: [] } }
      : (fail ? { status: 503, body: {} } : { body: { items: [ebook(6, 'Persuasion', 'Jane Austen')], next_cursor: null, notes: [] } }));
  } });
  await t.mount();
  t.click('#moreBtn');
  await t.clock.advance(50);
  check('the books stay and the button offers another go', t.qa('#libraryGrid > li').length === 5 && t.text('#moreBtn') === 'Try again' && !t.q('#moreBtn').disabled && !t.hidden('#moreWrap'));
  fail = false;
  t.click('#moreBtn');
  await t.clock.advance(50);
  check('and it works the second time', t.qa('#libraryGrid > li').length === 6 && t.hidden('#moreWrap'));
});

await run('the next page loads as the button nears the screen, when the browser can tell', async (make) => {
  const observers = [];
  class FakeIO {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.watched = []; this.gone = false; observers.push(this); }
    observe(n) { this.watched.push(n); }
    unobserve() {}
    disconnect() { this.gone = true; }
  }
  const t = make({ IntersectionObserver: FakeIO, routes: (net) => {
    usual()(net);
    net.on('/api/books?', (url) => url.indexOf('cursor=') === -1
      ? { body: { items: SHELF, next_cursor: 'c1', notes: [] } }
      : { body: { items: [ebook(6, 'Persuasion', 'Jane Austen')], next_cursor: null, notes: [] } });
  } });
  await t.mount();
  const io = observers[0];
  check('it watches the button\'s box, a screen ahead', io && io.watched[0] === t.q('#moreWrap') && /600px/.test(io.opts.rootMargin));
  io.cb([{ isIntersecting: false }]);
  await t.clock.advance(20);
  check('out of reach: nothing', t.net.urls('/api/books?').length === 1);
  io.cb([{ isIntersecting: true }]);
  await t.clock.advance(20);
  check('in reach: the next page', t.qa('#libraryGrid > li').length === 6);
  t.ctl.abort();
  check('leaving the page disconnects it', io.gone);
});

await run('a series is one card, with a link that carries its name', async (make) => {
  const odd = ['Le Guin, Ursula K.', 'A/B & C', 'Brontë', 'J. R. R. Tolkien'];
  const t = make({ routes: usual({ library: () => ({ body: { items: [series('Harry Potter', 7), series('Hobbit', 1, ['audio']), ...odd.map((n) => series(n, 2))], next_cursor: null, notes: [] } }) }) });
  await t.mount();
  const a = t.cards('libraryGrid');
  check('it opens the series page', a[0].getAttribute('href') === '/books/series?name=Harry%20Potter', a[0].getAttribute('href'));
  check('with the name and how many books', /Harry Potter/.test(a[0].textContent) && /7 books/.test(a[0].textContent));
  check('one book reads "1 book"', /1 book(?!s)/.test(a[1].textContent));
  check('names round-trip through the address', odd.every((n, i) => decodeURIComponent(a[i + 2].getAttribute('href').split('name=')[1]) === n), a.map((x) => x.getAttribute('href')));
  check('a slash cannot leave the query', a[3].getAttribute('href') === '/books/series?name=A%2FB%20%26%20C', a[3].getAttribute('href'));
  check('a series looks like a stack: two pages behind the cover', a[0].querySelectorAll('[aria-hidden="true"].absolute.rounded-xl').length === 2);
  check('a single book has none', (() => { const b = books.renderBookCard(ebook(2, 'Emma', 'Jane')); return b.querySelectorAll('span.-top-2').length === 0; })());
});

await run('every cover says which formats the book has', async (make) => {
  const t = make({ routes: usual() });
  await t.mount();
  const badges = (a) => Array.from(a.querySelectorAll('[data-format]')).map((b) => b.getAttribute('data-format') + ':' + b.textContent.replace(/\s+/g, ''));
  const a = t.cards('libraryGrid');
  check('both: an ebook mark and an audiobook mark', badges(a[0]).join() === 'ebook:menu_bookEbook,audio:headphonesAudiobook', badges(a[0]));
  check('ebook only', badges(a[1]).join() === 'ebook:menu_bookEbook');
  check('audio only', badges(a[2]).join() === 'audio:headphonesAudiobook');
  check('the badge is read aloud as a word', a[2].querySelector('[data-format] .sr-only').textContent === 'Audiobook');
  check('the icons are hidden from a screen reader', Array.from(a[0].querySelectorAll('[data-format] .material-symbols-outlined')).every((s) => s.getAttribute('aria-hidden') === 'true'));
  check('the cover picture has no alt (the title is next to it)', a[1].querySelector('img').getAttribute('alt') === '' || a[1].querySelector('img').alt === '');
  check('an audiobook cover is shown whole', /object-contain/.test(a[2].querySelector('img').className) && /object-cover/.test(a[1].querySelector('img').className));
  const img = a[1].querySelector('img');
  img.dispatchEvent(new t.win.Event('error'));
  check('a cover that fails hides itself and leaves the icon', img.classList.contains('hidden'));
  check('a card with no cover still has its frame', (() => { const c = books.renderBookCard(ebook(9, 'No Art', 'X', { cover_url: '' })); return !c.querySelector('img') && !!c.querySelector('.aspect-\\[2\\/3\\]'); })());
});

// ---- Search ----

await run('search waits a moment after the last key, and the newest word wins', async (make) => {
  const t = make({ routes: usual({ search: { items: [ebook(1, 'Dune', 'Frank Herbert')], request_url: '/requests?q=dune', notes: [] } }) });
  await t.mount();
  t.type('d');
  await t.clock.advance(200);
  t.type('du');
  await t.clock.advance(200);
  t.type('dune');
  await t.clock.advance(299);
  check('nothing is sent while they are still typing', t.net.urls('/api/books/search').length === 0);
  await t.clock.advance(1);
  check('one search goes out after 300 ms', t.net.urls('/api/books/search').length === 1 && t.net.urls('/api/books/search')[0] === '/api/books/search?q=dune&limit=60', t.net.urls('/api/books/search'));
  await t.clock.advance(50);
  check('the results take the place of Continue and the library', t.hidden('#browseArea') && !t.hidden('#searchSection') && !t.hidden('#searchGrid'));
  check('with the same cards', t.cards('searchGrid').length === 1 && t.cards('searchGrid')[0].getAttribute('href') === '/books/1');
  check('and a count a screen reader hears', t.text('#searchStatus') === '1 book found' && t.q('#searchStatus').getAttribute('role') === 'status');
  t.type('');
  check('clearing the box brings the library back at once', !t.hidden('#browseArea') && t.hidden('#searchSection'));
  t.type('d u');
  t.type('');
  await t.clock.advance(400);
  check('a search cleared before its wait never goes out', t.net.urls('/api/books/search').length === 1);
});

await run('search: Enter goes straight away, and the query is encoded', async (make) => {
  const t = make({ routes: usual() });
  await t.mount();
  t.type('Brontë & sons?');
  t.key('Enter');
  await t.clock.advance(20);
  check('Enter searches without the wait', t.net.urls('/api/books/search')[0] === '/api/books/search?q=Bront%C3%AB%20%26%20sons%3F&limit=60', t.net.urls('/api/books/search'));
  await t.clock.advance(400);
  check('and the wait that was running does not search again', t.net.urls('/api/books/search').length === 1);
  t.type('Brontë & sons?');
  await t.clock.advance(400);
  check('the same text again is not searched again', t.net.urls('/api/books/search').length === 1);
});

await run('search: a late answer for an older word is dropped', async (make) => {
  const slow = deferred();
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books/search?q=du&', () => slow.promise);
    net.on('/api/books/search?q=dune&', () => ({ body: { items: [ebook(1, 'Dune', 'Frank Herbert')], request_url: '/requests?q=dune', notes: [] } }));
  } });
  await t.mount();
  t.type('du');
  await t.clock.advance(300);
  t.type('dune');
  await t.clock.advance(300);
  check('the newer word shows', t.cards('searchGrid').length === 1);
  slow.resolve({ body: { items: [audio(7, 'Duplicity', 'Z'), audio(8, 'Dubliners', 'Y')], request_url: '/requests?q=du', notes: [] } });
  await t.clock.advance(50);
  check('the older answer changes nothing', t.cards('searchGrid').length === 1 && t.text('#searchStatus') === '1 book found');
  // And an answer that lands after the box was cleared does not bring the results back.
  const slow2 = deferred();
  const u = make({ routes: (net) => { usual()(net); net.on('/api/books/search', () => slow2.promise); } });
  await u.mount();
  u.type('emma');
  await u.clock.advance(300);
  u.type('');
  slow2.resolve({ body: { items: [ebook(2, 'Emma', 'Jane Austen')], request_url: '/requests?q=emma', notes: [] } });
  await u.clock.advance(50);
  check('nothing comes back after the box was cleared', u.hidden('#searchSection') && !u.hidden('#browseArea'));
});

await run('search with no match offers "Can\'t find it? Request it"', async (make) => {
  const t = make({ routes: usual({ search: { items: [], request_url: '/requests?q=zzzz%20book', notes: [] } }) });
  await t.mount();
  t.type('zzzz book');
  await t.clock.advance(350);
  check('the empty message shows', !t.hidden('#searchEmpty') && t.hidden('#searchGrid') && t.hidden('#searchSkeleton'));
  const link = t.q('#searchRequest');
  check('the link says what it does', link.textContent === 'Can\'t find it? Request it', link.textContent);
  check('and goes to Requests with the search filled in', link.getAttribute('href') === '/requests?q=zzzz%20book', link.getAttribute('href'));
  check('the message names what was searched', t.text('#searchEmptyTitle') === 'No books match “zzzz book”');
  check('the status line says there were none, to a screen reader only (the message says it on screen)', t.text('#searchStatus') === 'No matches' && t.q('#searchStatus').classList.contains('sr-only'));
});

await run('search: only a Requests address from the server is used, and the words are text', async (make) => {
  const nasty = '<img src=x onerror=alert(1)>';
  const t = make({ routes: usual({ search: { items: [], request_url: 'https://evil.example/?q=x', notes: [] } }) });
  await t.mount();
  t.type(nasty);
  await t.clock.advance(350);
  const link = t.q('#searchRequest');
  check('another address is not followed: the link is built from the search', link.getAttribute('href') === '/requests?q=' + encodeURIComponent(nasty), link.getAttribute('href'));
  check('the words are text, not markup', t.text('#searchEmptyTitle').indexOf(nasty) !== -1 && t.q('#searchEmpty').querySelectorAll('img').length === 0);
});

await run('search: a failure says so and keeps the page', async (make) => {
  const t = make({ routes: (net) => { usual()(net); net.on('/api/books/search', () => ({ status: 503, body: {} })); } });
  await t.mount();
  t.type('dune');
  await t.clock.advance(350);
  check('the message shows', !t.hidden('#searchError') && t.hidden('#searchGrid') && t.hidden('#searchEmpty'));
  check('and typing again searches again', (() => { t.type('dunes'); return true; })());
  await t.clock.advance(350);
  check('a second search went out', t.net.urls('/api/books/search').length === 2);
});

// ---- Continue ----

const CONT = [
  { book_id: 1, format: 'ebook', title: 'Dune', author: 'Frank Herbert', cover_url: '/api/books/1/cover?v=1', progress_label: 'Ch. 12 · 43%', percent: 43, updated_at: '2026-10-03T10:00:00Z', resume: { read_url: '/reader?seriesId=4&chapterId=9' } },
  { book_id: 3, format: 'audio', title: 'The Hobbit', author: 'J. R. R. Tolkien', cover_url: '/api/books/3/cover?v=1', progress_label: '2h 10m left', percent: 60, updated_at: '2026-10-02T10:00:00Z', resume: { plex_book_key: '14:1' } },
  { book_id: 6, format: 'audio', title: 'Villette', author: 'Charlotte Brontë', cover_url: '/api/books/6/cover?v=1', progress_label: 'In progress', percent: null, updated_at: '2026-10-01T10:00:00Z', resume: { plex_book_key: '13:1' } }
];

await run('the Continue row: cover, format badge, progress, and a way back in', async (make) => {
  const t = make({ routes: usual({ continue: { items: CONT, notes: [] } }) });
  await t.mount();
  const row = t.q('#continueHost [data-continue]');
  check('it is a section with a heading', row && row.getAttribute('aria-label') === 'Continue' && row.querySelector('h2').textContent === 'Continue');
  const cards = t.qa('#continueHost li > a, #continueHost li > button');
  check('one card per book, in order', cards.length === 3 && /Dune/.test(cards[0].textContent) && /Hobbit/.test(cards[1].textContent));
  check('an ebook resumes in the reader through a real link', cards[0].tagName === 'A' && cards[0].getAttribute('href') === '/reader?seriesId=4&chapterId=9');
  check('an audiobook is a button', cards[1].tagName === 'BUTTON' && cards[1].getAttribute('type') === 'button' && cards[1].getAttribute('data-resume-audio') === '14:1');
  check('each shows its progress', /Ch\. 12 · 43%/.test(cards[0].textContent) && /2h 10m left/.test(cards[1].textContent));
  check('and its format', cards[0].querySelector('[data-format="ebook"]') && cards[1].querySelector('[data-format="audio"]') && !cards[1].querySelector('[data-format="ebook"]'));
  const fill = (c) => c.querySelector('.bg-frosted-blue.h-full');
  check('the bar is as full as the percent', fill(cards[0]).style.width === '43%' && fill(cards[1]).style.width === '60%', [fill(cards[0]).style.width, fill(cards[1]).style.width]);
  check('a place with no percent has no bar', !fill(cards[2]));
  check('the bar is not read out (the label is)', cards[0].querySelector('.h-1\\.5').getAttribute('aria-hidden') === 'true');
  check('the Continue skeleton is replaced', !t.q('#continueHost .skel'));
  check('the section is shown for the next first paint', t.doc.documentElement.hasAttribute('data-books-continue'));
  check('and remembered for this person', t.win.localStorage.getItem('webservarr_books_continue:sam') === '1');
});

await run('tapping an audiobook in Continue resumes it in the player', async (make) => {
  const t = make({ routes: usual({ continue: { items: CONT, notes: [] } }) });
  await t.mount();
  t.q('#continueHost [data-resume-audio="14:1"]').click();
  check('the player opens that book, playing, to resume where it was', JSON.stringify(t.win.WS.player.opened) === JSON.stringify([['14:1', { autoplay: true }]]), t.win.WS.player.opened);
  const u = make({ player: false, routes: usual({ continue: { items: CONT, notes: [] } }) });
  await u.mount();
  u.q('#continueHost [data-resume-audio="14:1"]').click();
  check('with no player it says so, quietly', u.toasts.length === 1 && /player/.test(u.toasts[0][0]) && u.toasts[0][1] === 'err', u.toasts);
  u.ctl.abort();
  u.q('#continueHost [data-resume-audio="13:1"]').click();
  check('a page that was left no longer answers taps', u.toasts.length === 1);
});

await run('renderContinueRow: empty is nothing, notes are quiet lines, compact is smaller', async (make) => {
  const t = make({ html: '<div id="wsPage"></div>' });
  check('no items: no row', books.renderContinueRow([], [], {}) === null && books.renderContinueRow(null, [], {}) === null);
  const row = books.renderContinueRow(CONT.slice(1), [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }, { source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }, { source: 'plex', reason: 'unavailable', text: '' }], {});
  const notes = Array.from(row.querySelectorAll(':scope > p'));
  check('Kavita down: the audiobooks stay and one quiet note follows them', row.querySelectorAll('li').length === 2 && notes.length === 1 && notes[0].textContent.indexOf('Ebooks are unavailable right now') !== -1, notes.map((n) => n.textContent));
  check('the note is under the row, not in it', row.lastElementChild === notes[0]);
  const small = books.renderContinueRow(CONT, [], { compact: true });
  check('compact cards are narrower', small.querySelector('li > a').className.indexOf('w-28') !== -1 && row.querySelector('li > button').className.indexOf('w-36') !== -1);
  check('and the heading is smaller', /text-\[17px\]/.test(small.querySelector('h2').className) && /text-xl/.test(row.querySelector('h2').className));
});

await run('Kavita down: Continue keeps the audiobooks, the page shows one quiet note and still loads', async (make) => {
  const down = [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }];
  const t = make({ routes: usual({
    continue: { items: CONT.slice(1), notes: down },
    library: () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: down } })
  }) });
  await t.mount();
  check('the audiobook cards are there', t.qa('#continueHost li').length === 2);
  const notes = t.qa('#notes p');
  check('one note, not two (Continue and the library both said it)', notes.length === 1 && /Ebooks are unavailable right now/.test(notes[0].textContent), notes.map((n) => n.textContent));
  check('the note is shown', !t.hidden('#notes'));
  check('the library is not blocked', t.cards('libraryGrid').length === 1);
  check('it is not mistaken for a missing sign-in', t.kav.reconnect.length === 0 && t.hidden('#connectState'));
});

await run('Continue failing leaves the library alone and hides the row', async (make) => {
  const t = make({ storage: { 'webservarr_books_continue:sam': '1' }, routes: (net) => { usual()(net); net.on('/api/books/continue', () => ({ status: 503, body: {} })); } });
  check('a person who had a row has its slot at once', t.doc.documentElement.hasAttribute('data-books-continue') === false);
  const mounted = t.mount();
  check('reserved before the first await', t.doc.documentElement.hasAttribute('data-books-continue'));
  await t.clock.advance(1600);
  await mounted;
  check('the row is dropped', !t.doc.documentElement.hasAttribute('data-books-continue') && !t.q('#continueHost [data-continue]'));
  check('the library shows', !t.hidden('#libraryGrid'));
  check('a failed read does not forget that they had a row', t.win.localStorage.getItem('webservarr_books_continue:sam') === '1');
});

await run('an empty Continue releases the slot and the next visit does not reserve it', async (make) => {
  const t = make({ storage: { 'webservarr_books_continue:sam': '1' }, routes: usual() });
  await t.mount();
  check('no row: the slot is released', !t.doc.documentElement.hasAttribute('data-books-continue'));
  check('and remembered', t.win.localStorage.getItem('webservarr_books_continue:sam') === '0');
  const u = make({ storage: { 'webservarr_books_continue:sam': '0' }, routes: usual() });
  const m = u.mount();
  check('a person without one has no slot', !u.doc.documentElement.hasAttribute('data-books-continue'));
  await m;
  u.ctl.abort();
});

// ---- The Kavita hand-off ----

const NOT_CONNECTED = [{ source: 'kavita', reason: 'not_connected', text: 'Connect to your ebook library to see ebooks' }];

await run('not connected: the hand-off runs once, from a fresh answer, and the page keeps going', async (make) => {
  const t = make({ routes: usual({
    continue: { items: CONT.slice(1), notes: NOT_CONNECTED },
    library: () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED } })
  }) });
  await t.mount();
  check('the existing Kavita hand-off was asked for, once', t.kav.reconnect.length === 1, t.kav.reconnect.length);
  check('the audiobooks are on screen meanwhile', t.cards('libraryGrid').length === 1 && t.qa('#continueHost li').length === 2);
  check('no problem is shown while the hand-off is under way', t.hidden('#connectState'));
  check('and the missing sign-in is not repeated as a note', t.hidden('#notes'));
  t.click('#formatChips [data-format="audio"]');
  await t.clock.advance(50);
  check('later answers do not start it again', t.kav.reconnect.length === 1);
});

await run('not connected, from the cache: the hand-off waits for a fresh answer', async (make) => {
  const t = make({ routes: usual({ library: () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED } }) }) });
  t.WS.cache.set('books:list:all:added', { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED });
  t.WS.cache.set('books:continue', { items: [], notes: NOT_CONNECTED });
  // The cached copy renders at once; the hand-off is for the live answer only.
  let during = null;
  const real = t.kav.reconnect;
  const m = t.mount();
  during = real.length;
  await m;
  check('after the live answer, once', real.length === 1, real.length);
  check('and not before it, from the cached copy', during === 0, during);
});

await run('not connected and the hand-off refuses (tried a minute ago): the message and Try again show', async (make) => {
  const t = make({ routes: usual({ library: () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED } }) }) });
  t.kav.blockNext = true;
  await t.mount();
  check('the connect message shows', !t.hidden('#connectState'));
  check('in words a reader can follow', /couldn't connect you to the eBook library/.test(t.text('#connectState')));
  check('the audiobooks are still there', t.cards('libraryGrid').length === 1);
  t.click('#connectRetry');
  check('Try again goes through the helper', t.kav.retry === 1);
});

await run('arriving after a failed sign-in does not loop', async (make) => {
  const t = make({ url: 'https://ws.test/books?kavita=error', routes: usual({ library: () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED } }) }) });
  t.kav.failed = true;
  t.kav.blockNext = true;   // the helper, having read the flag, refuses the automatic attempt
  await t.mount();
  check('the message shows', !t.hidden('#connectState'));
  check('nothing is loaded on the strength of the failure that it should not be', t.cards('libraryGrid').length === 1);
});

await run('without the helper script the page explains and stays put', async (make) => {
  const t = make({ kavita: false, routes: usual({ library: () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED } }) }) });
  await t.mount();
  check('the message shows instead of a redirect', !t.hidden('#connectState') && t.WS.left.length === 0);
  let reloaded = false;
  Object.defineProperty(t.win, 'location', { value: { reload() { reloaded = true; }, search: '', pathname: '/books' }, configurable: true });
  t.click('#connectRetry');
  check('Try again reloads the page', reloaded);
});

// ---- The other states ----

await run('the catalog is still being built: a building message, checked again on the visit\'s poll', async (make) => {
  let building = true;
  const t = make({ routes: usual({ library: () => ({ body: building ? { items: [], next_cursor: null, notes: [], building: true } : { items: SHELF, next_cursor: null, notes: [], building: false } }) }) });
  await t.mount();
  check('the building message shows, not an empty library', !t.hidden('#buildingState') && t.hidden('#emptyState') && t.hidden('#gridSkeleton'));
  check('it says what is happening', /putting the library together/.test(t.text('#buildingState')));
  check('and is a status for a screen reader', t.q('#buildingState').getAttribute('role') === 'status');
  check('one poll was started on the visit', t.polls.length === 1 && t.polls[0].ms === 10000 && !t.polls[0].stopped);
  t.polls[0].fn();
  await t.clock.advance(20);
  check('a check while still building keeps the message and starts no second poll', !t.hidden('#buildingState') && t.polls.length === 1);
  check('the checks leave the screen alone (no skeleton flash)', t.hidden('#gridSkeleton'));
  building = false;
  t.polls[0].fn();
  await t.clock.advance(20);
  check('the books replace it when they arrive', !t.hidden('#libraryGrid') && t.hidden('#buildingState') && t.cards('libraryGrid').length === 5);
  check('and the poll stops', t.polls[0].stopped);
});

await run('an empty library is "No books yet" with a way to ask', async (make) => {
  const t = make({ routes: usual({ library: () => ({ body: { items: [], next_cursor: null, notes: [], building: false } }) }) });
  await t.mount();
  check('the message shows', !t.hidden('#emptyState') && t.text('#emptyTitle') === 'No books yet');
  check('Request a book goes to Requests', !t.hidden('#emptyRequest') && t.q('#emptyRequest').getAttribute('href') === '/requests');
  check('there is no filter to clear', t.hidden('#emptyReset'));
  check('no poll was started', t.polls.length === 0);
});

await run('an empty filter says which, and one tap shows everything again', async (make) => {
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books?format=audio', () => ({ body: { items: [], next_cursor: null, notes: [], building: false } }));
  } });
  await t.mount();
  t.click('[data-format="audio"]');
  await t.clock.advance(50);
  check('the message names the filter', t.text('#emptyTitle') === 'No audiobooks to show');
  check('Show all books is offered, Request a book is not', !t.hidden('#emptyReset') && t.hidden('#emptyRequest'));
  t.click('#emptyReset');
  await t.clock.advance(50);
  check('All is chosen again and the books are back', t.q('[data-format="all"]').getAttribute('aria-pressed') === 'true' && t.cards('libraryGrid').length === 5);
});

await run('an empty library with a source down says to check back, not that there are no books', async (make) => {
  const t = make({ routes: usual({ library: () => ({ body: { items: [], next_cursor: null, notes: [{ source: 'plex', reason: 'unavailable', text: 'Audiobooks are unavailable right now' }], building: false } }) }) });
  await t.mount();
  check('the title and the note', t.text('#emptyTitle') === 'No books to show right now' && /Audiobooks are unavailable right now/.test(t.text('#notes')));
});

await run('a library that cannot be read shows an error with Try again', async (make) => {
  let down = true;
  const t = make({ routes: usual({ library: () => (down ? { status: 503, body: { detail: 'x' } } : { body: { items: SHELF, next_cursor: null, notes: [] } }) }) });
  await t.mount();
  check('the error shows, not a blank page', !t.hidden('#errorState') && t.hidden('#gridSkeleton') && t.hidden('#libraryGrid'));
  check('in plain words, with nothing technical', /couldn't load the library/.test(t.text('#errorState')) && !/503|HTTP|api/i.test(t.text('#errorState')));
  check('the search and the chips are still there', !!t.q('#booksSearch') && t.qa('#formatChips button').length === 3);
  down = false;
  t.click('#retryBtn');
  await t.clock.advance(50);
  check('Try again loads it', !t.hidden('#libraryGrid') && t.hidden('#errorState') && t.cards('libraryGrid').length === 5);
});

await run('a visit comes back from the cache at once and corrects itself', async (make) => {
  const t = make({ routes: usual({ library: () => ({ body: { items: [ebook(2, 'Emma', 'Jane Austen')], next_cursor: null, notes: [] } }) }) });
  t.WS.cache.set('books:list:all:added', { items: SHELF, next_cursor: null, notes: [] });
  t.WS.cache.set('books:continue', { items: [], notes: [] });
  const m = t.mount();
  check('the last list shows before the network answers', t.cards('libraryGrid').length === 5 && t.hidden('#gridSkeleton'));
  await m;
  await t.clock.advance(20);
  check('then the fresh one', t.cards('libraryGrid').length === 1);
});

// ---- Fix round 1 ----

await run('T3H2: the Continue row is dragged by a mouse and a wheel moves it sideways', async (make) => {
  const many = Array.from({ length: 12 }, (_, i) => Object.assign({}, CONT[1], { book_id: 100 + i, title: 'Book ' + i, resume: { plex_book_key: i + ':1' } }));
  const t = make({ routes: usual({ continue: { items: many, notes: [] } }) });
  await t.mount();
  const row = t.q('#continueHost ul');
  check('the row was handed to the shell\'s drag-to-scroll with the visit\'s signal', t.WS.drags.length === 1 && t.WS.drags[0].el === row && t.WS.drags[0].opts.signal === t.ctl.signal);
  Object.defineProperty(row, 'scrollWidth', { value: 2000, configurable: true });
  Object.defineProperty(row, 'clientWidth', { value: 1000, configurable: true });
  const wheel = (init) => { const e = new t.win.WheelEvent('wheel', Object.assign({ bubbles: true, cancelable: true }, init)); if (init.shiftKey) Object.defineProperty(e, 'shiftKey', { value: true }); row.dispatchEvent(e); return e; };
  row.scrollLeft = 0;
  let e = wheel({ deltaY: 300 });
  check('a vertical wheel moves it sideways and the page does not scroll', row.scrollLeft === 300 && e.defaultPrevented, row.scrollLeft);
  e = wheel({ deltaY: 5000 });
  check('as far as the end', row.scrollLeft === 1000 && e.defaultPrevented);
  e = wheel({ deltaY: 300 });
  check('at the end the wheel is the page\'s again', !e.defaultPrevented && row.scrollLeft === 1000);
  row.scrollLeft = 500;
  e = wheel({ deltaY: -9000 });
  check('and back to the start', row.scrollLeft === 0 && e.defaultPrevented);
  e = wheel({ deltaY: -300 });
  check('where it is the page\'s again', !e.defaultPrevented);
  e = wheel({ deltaX: 200, deltaY: 10 });
  check('a sideways swipe is left to the browser', !e.defaultPrevented);
  e = wheel({ deltaY: 100, shiftKey: true });
  check('so is shift + wheel', !e.defaultPrevented);
  Object.defineProperty(row, 'scrollWidth', { value: 900, configurable: true });
  e = wheel({ deltaY: 100 });
  check('a row that fits scrolls nothing and never takes the wheel', !e.defaultPrevented);
  t.ctl.abort();
  row.scrollLeft = 0;
  Object.defineProperty(row, 'scrollWidth', { value: 2000, configurable: true });
  e = wheel({ deltaY: 100 });
  check('leaving the page ends it', !e.defaultPrevented && row.scrollLeft === 0);
});

await run('T3H3: a fresh page 1 over the kept copy drops a next page asked for meanwhile', async (make) => {
  const B = (i) => ebook(i, 'Book ' + i, 'A');
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => B(a + k));
  for (const variant of ['io-only', 'io-then-click']) {
    const observers = [];
    // As a browser's: observing reports where the element is now.
    class FakeIO { constructor(cb) { this.cb = cb; observers.push(this); } observe() { Promise.resolve().then(() => this.cb([{ isIntersecting: true }])); } unobserve() {} disconnect() {} }
    const fresh = deferred(); const old = deferred(); const newer = deferred();
    const t = make({ IntersectionObserver: FakeIO, routes: (net) => {
      net.on('/api/books/continue', () => ({ body: { items: [], notes: [] } }));
      net.on('/api/books?', (url) => url.indexOf('cursor=c36') !== -1 ? old.promise : url.indexOf('cursor=c35') !== -1 ? newer.promise : fresh.promise);
    } });
    t.WS.cache.set('books:list:all:added', { items: range(1, 36), next_cursor: 'c36', notes: [], building: false });
    t.WS.cache.set('books:continue', { items: [], notes: [] });
    const m = t.mount();
    await flush();
    fresh.resolve({ body: { items: [ebook(99, 'New Book', 'A')].concat(range(1, 35)), next_cursor: 'c35', notes: [], building: false } });
    await t.clock.advance(400);
    if (variant === 'io-then-click') { t.click('#moreBtn'); await flush(); }
    old.resolve({ body: { items: range(37, 40), next_cursor: null, notes: [] } });
    newer.resolve({ body: { items: range(36, 40), next_cursor: null, notes: [] } });
    await t.clock.advance(2000);
    await m;
    const ids = t.cards('libraryGrid').map((a) => a.querySelector('span.line-clamp-2').textContent);
    const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
    const missing = range(1, 40).map((b) => b.title).filter((x) => ids.indexOf(x) === -1);
    check(variant + ': nothing twice, nothing missing', dupes.length === 0 && missing.length === 0 && ids.length === 41, { dupes, missing, n: ids.length });
  }
});

await run('T3H4: a chip tapped while the catalog is first built shows building and is not kept', async (make) => {
  let building = true;
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books?', () => ({ body: building ? { items: [], next_cursor: null, notes: [], building: true } : { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: [], building: false } }));
  } });
  await t.mount();
  check('All: building, polling', !t.hidden('#buildingState') && t.polls.filter((p) => !p.stopped).length === 1);
  check('nothing is saved as this person\'s view', t.win.localStorage.getItem('webservarr_books_view:sam') === null, t.win.localStorage.getItem('webservarr_books_view:sam'));
  t.click('#formatChips [data-format="audio"]');
  await t.clock.advance(50);
  check('Audiobooks: building too, not "no audiobooks"', !t.hidden('#buildingState') && t.hidden('#emptyState'));
  check('one poll again after the chip', t.polls.filter((p) => !p.stopped).length === 1);
  check('the empty answer is not kept for the next visit', !t.WS.cache.has('books:list:audio:added') && !t.WS.cache.has('books:list:all:added'), Array.from(t.WS.cache.keys()));
  check('still nothing saved', t.win.localStorage.getItem('webservarr_books_view:sam') === null);
  building = false;
  t.polls.filter((p) => !p.stopped)[0].fn();
  await t.clock.advance(50);
  check('when the books arrive they show, and the view is kept then', t.cards('libraryGrid').length === 1 && t.win.localStorage.getItem('webservarr_books_view:sam') === '{"format":"audio","sort":"added"}');
});

await run('T3H5: the toolbar, notes, connect message and Continue come in one write with the books', async (make) => {
  const lib = deferred();
  const down = [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }];
  const t = make({ routes: (net) => {
    usual({ continue: { items: CONT, notes: down } })(net);
    net.on('/api/books?', () => lib.promise);
  } });
  t.kav.blockNext = true;
  const m = t.mount();
  await t.clock.advance(100);
  check('before the books: the toolbar is its skeleton, the real one waits', !t.hidden('#toolbarSkel') && t.hidden('#toolbar'));
  check('Continue has not moved in (its slot, if any, is untouched)', !!t.q('#continueHost .skel') && !t.q('#continueHost [data-continue]') && !t.doc.documentElement.hasAttribute('data-books-continue'));
  check('and no notes or connect message have appeared', t.hidden('#notes') && t.hidden('#connectState'));
  lib.resolve({ body: { items: SHELF, next_cursor: null, notes: down.concat(NOT_CONNECTED), building: false } });
  await t.clock.advance(100);
  await m;
  check('with the books: toolbar, notes, connect message and Continue all there', t.hidden('#toolbarSkel') && !t.hidden('#toolbar') && !t.hidden('#notes') && !t.hidden('#connectState') && !!t.q('#continueHost [data-continue]') && t.doc.documentElement.hasAttribute('data-books-continue'));
  check('all of it, Continue included, sits above the books inside the library section (no element already shown has to move)', (() => { const sec = t.q('#librarySection'); const kids = Array.from(sec.children).map((c) => c.id); return kids.indexOf('continueHost') !== -1 && kids.indexOf('continueHost') < kids.indexOf('toolbar') && kids.indexOf('toolbar') < kids.indexOf('connectState') && kids.indexOf('connectState') < kids.indexOf('notes') && kids.indexOf('notes') < kids.indexOf('libraryGrid'); })());
  // A library that never answers does not keep the page a skeleton for ever.
  const never = deferred();
  const u = make({ routes: (net) => { usual()(net); net.on('/api/books?', () => never.promise); } });
  u.mount();
  await u.clock.advance(3900);
  check('4 s: still waiting', !u.hidden('#toolbarSkel'));
  await u.clock.advance(200);
  check('after 4 s the controls and Continue come in anyway', u.hidden('#toolbarSkel') && !u.hidden('#toolbar'));
  // The error path is a write of its own too.
  const v = make({ routes: usual({ library: () => ({ status: 503, body: {} }) }) });
  await v.mount();
  check('an error brings the toolbar in with its message', !v.hidden('#toolbar') && !v.hidden('#errorState'));
});

await run('T3H6: with the Seerr embed as the Requests source there is no request link', async (make) => {
  const t = make({ branding: { requests_source: 'seerr_embed' }, routes: usual() });
  await t.mount();
  t.type('zzzz');
  await t.clock.advance(350);
  check('the empty search says it is not in the library, with no link', t.text('#searchEmptyTitle') === 'Not in the library yet' && t.q('#searchRequest').classList.contains('hidden'), t.text('#searchEmptyTitle'));
  check('and the words name the search, without telling them to ask', /zzzz/.test(t.text('#searchEmptyText')) && !/ask/i.test(t.text('#searchEmptyText')));
  const u = make({ branding: { requests_source: 'seerr_embed' }, routes: usual({ library: () => ({ body: { items: [], next_cursor: null, notes: [], building: false } }) }) });
  await u.mount();
  check('an empty library has no Request a book either', u.q('#emptyRequest').classList.contains('hidden') && !/request/i.test(u.text('#emptyText')));
  // And the usual source still has them.
  const v = make({ branding: { requests_source: 'native' }, routes: usual() });
  await v.mount();
  v.type('zzzz');
  await v.clock.advance(350);
  check('native Requests keeps the link', !v.q('#searchRequest').classList.contains('hidden') && v.text('#searchEmptyTitle') === 'No books match “zzzz”');
});

// ---- Markup safety ----

await run('titles, authors and series are text, never markup', async (make) => {
  const nasty = '<img src=x onerror=alert(1)>';
  const t = make({ routes: usual({
    library: () => ({ body: { items: [ebook(1, nasty, nasty), series(nasty, 2)], next_cursor: null, notes: [] } }),
    continue: { items: [{ book_id: 1, format: 'audio', title: nasty, author: nasty, cover_url: '', progress_label: nasty, percent: 5, updated_at: 't', resume: { plex_book_key: '1:1' } }], notes: [{ source: 'plex', reason: 'unavailable', text: nasty }] }
  }) });
  await t.mount();
  check('the text shows as typed', t.cards('libraryGrid')[0].textContent.indexOf(nasty) !== -1);
  const page = t.q('#wsPage');
  check('and no element was made from it', page.querySelectorAll('img').length === 2 /* the two real covers */ && !page.querySelector('[onerror]'), page.querySelectorAll('img').length);
  const src = readFileSync(BOOKS_PATH, 'utf8');
  check('the module never writes markup', !/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  check('and holds no raw colour', !/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
});

await run('leaving the page ends its listeners, polls and requests', async (make) => {
  const t = make({ routes: usual() });
  await t.mount();
  const before = t.net.calls.length;
  t.ctl.abort();
  t.click('[data-format="ebook"]');
  t.change('#sortSelect', 'title');
  t.type('dune');
  await t.clock.advance(500);
  check('nothing is asked for after leaving', t.net.calls.length === before, t.net.calls.length - before);
  check('every request carried the visit\'s signal', t.net.calls.every((c) => c.init && c.init.signal === t.ctl.signal));
});

// ---- Requests: ?q= runs the search on arrival ----

// The Requests page logs what it could not load; the sparse network here
// answers 404 to most of it, so its console is kept quiet.
const quietConsole = { error() {}, warn() {}, log() {}, info() {} };

async function requestsVisit(url, routes) {
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
  const WS = { dragScroll: Object.assign(() => {}, { stop() {} }), arrive: (k, f) => f(), data: {}, leaveTo() {}, mediaType: () => ({ label: '', icon: '', accent: '' }), requestStatus: () => ({ label: '', tone: '' }), getJSON: (u, o) => net.fetch(u, o).then((r) => r.json()), setHTML() {}, swr: () => Promise.resolve(null), poll: () => () => {} };
  set('window', win);
  set('document', doc);
  set('localStorage', win.localStorage);
  set('sessionStorage', win.sessionStorage);
  set('WS', WS);
  win.WS = WS;
  set('fetch', (u, o) => net.fetch(u, o));
  set('checkAuth', async () => ({ username: 'sam', is_admin: false }));
  set('requestAnimationFrame', (fn) => clock.setTimeout(fn, 16));
  set('cancelAnimationFrame', (id) => clock.clearTimeout(id));
  set('matchMedia', () => ({ matches: true, addEventListener() {} }));
  win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  set('WSUI', { toast() {} });
  set('console', quietConsole);
  const ctx = {
    root: doc.getElementById('wsPage'), signal: ctl.signal, url: new URL(url), data: {},
    poll: () => () => {}, setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (id) => clock.clearTimeout(id),
    onNavigate() {}, beforeLeave() {}, setTitle() {}
  };
  return {
    win, doc, net, clock, ctl, ctx,
    release() { for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; } }
  };
}

const SEEDED = (net) => {
  net.on('/api/integrations/seerr-search', () => ({ body: { results: [], totalPages: 1, totalResults: 0 } }));
  net.on('/api/integrations/chaptarr-search', () => ({ body: { results: [] } }));
};

current = 'requests: /requests?q= runs that search on arrival';
{
  const r = await requestsVisit('https://ws.test/requests?q=The%20Name%20of%20the%20Wind', SEEDED);
  try {
    const m = requestsModule.mount(r.ctx);
    await r.clock.advance(1800);
    await m.catch(() => {});
    await r.clock.advance(400);
    const seerr = r.net.urls('/api/integrations/seerr-search');
    check('the film and TV search ran for that text', seerr.length === 1 && seerr[0].indexOf('query=The%20Name%20of%20the%20Wind') !== -1, seerr);
    const chap = r.net.urls('/api/integrations/chaptarr-search');
    check('and the book search too', chap.length === 1 && chap[0].indexOf('query=The%20Name%20of%20the%20Wind') !== -1, chap);
    check('the box shows what was searched', r.doc.getElementById('searchInput').value === 'The Name of the Wind');
    check('the results panel is open', !r.doc.getElementById('searchResultsSection').classList.contains('hidden'));
  } finally {
    r.ctl.abort();
    r.release();
  }
}

current = 'requests: no q means no search on arrival';
{
  const r = await requestsVisit('https://ws.test/requests', SEEDED);
  try {
    const m = requestsModule.mount(r.ctx);
    await r.clock.advance(1800);
    await m.catch(() => {});
    check('nothing is searched', r.net.urls('/api/integrations/seerr-search').length === 0 && r.doc.getElementById('searchInput').value === '');
  } finally {
    r.ctl.abort();
    r.release();
  }
}

current = 'requests: a blank or very long q';
{
  const r = await requestsVisit('https://ws.test/requests?q=%20%20', SEEDED);
  try {
    const m = requestsModule.mount(r.ctx);
    await r.clock.advance(1800);
    await m.catch(() => {});
    check('blank: nothing is searched', r.net.urls('/api/integrations/seerr-search').length === 0);
  } finally {
    r.ctl.abort();
    r.release();
  }
  const long = 'x'.repeat(500);
  const s = await requestsVisit('https://ws.test/requests?q=' + long, SEEDED);
  try {
    const m = requestsModule.mount(s.ctx);
    await s.clock.advance(1800);
    await m.catch(() => {});
    const asked = s.net.urls('/api/integrations/seerr-search')[0] || '';
    check('long: the search is cut to 200 characters', /query=x{200}&/.test(asked) && !/x{201}/.test(asked), asked.length);
  } finally {
    s.ctl.abort();
    s.release();
  }
}

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
