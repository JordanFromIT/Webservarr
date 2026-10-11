// The Books page (app/static/js/pages/books.js) run for real in happy-dom (a
// dev-only dependency) over the page's own markup (books.html), with a
// scripted network, a fake clock, a fake shell (WS.swr and WS.arrive written
// as shell.js does them) and a fake Kavita hand-off helper. Covers: the
// skeleton and the render, top-down arrival, the format chips and the sort
// (and remembering them), progressive loading, series cards, format badges,
// search (the debounce, stale answers, the request link), the Continue row
// (and its notes when Kavita is down; a book taken out staying out of a
// late live answer and the kept copy), the Kavita hand-off, the building
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
  const kav = { init: 0, reconnect: [], retry: 0, failed: false, blockNext: false, leaving: false };
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
  // What the page came with (the #ws-data block): books_notice, a user's identity_key.
  if (o.data) Object.assign(WS.data, o.data);
  win.WSUI = { toast(m, kind, opts) {
    const entry = opts ? [m, kind, opts] : [m, kind];
    toasts.push(entry);
    return { remove() { entry.removed = true; } };
  } };
  set('WSUI', win.WSUI);
  // Writes (sendBooks) go through window.fetch: the same scripted network.
  win.fetch = (u, init) => net.fetch(u, init);
  WS.navigated = [];
  WS.router = { navigate(u) { WS.navigated.push(u); } };
  if (o.kavita !== false) {
    win.WSKavita = {
      init() { kav.init += 1; },
      reconnect(cb) { kav.reconnect.push(cb); if (kav.blockNext) cb(); },
      retry() { kav.retry += 1; },
      arrivedFromFailedConnect() { return kav.failed; },
      isLeaving() { return kav.leaving; }
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
    // The discovery shelves (books 3c): empty, as on a server with nothing new or popular.
    net.on('/api/books/recent', over.recent || (() => ({ body: { items: [] } })));
    net.on('/api/books/popular', over.popular || (() => ({ body: { items: [] } })));
  };
}

const sortOptions = (t) => t.qa('#booksSortList [role="option"]');
// Each selector's element comes after the one before it in the page.
const inOrder = (t, ...sels) => sels.every((sel, i) => i === 0 || !!(t.q(sels[i - 1]).compareDocumentPosition(t.q(sel)) & 4));

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
  check('each skeleton is a cover, two lines and the room of a series line (shown with Group series off)',
    t.qa('#gridSkeleton > div').every((d) => d.children.length === 4 && d.children[3].getAttribute('data-skel') === 'series'));
  check('which is held only while every book is its own card', !t.doc.documentElement.hasAttribute('data-books-flat'));
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

  // One slow section does not hold the page for ever: after ROWS_WAIT_MS (4 s) the library shows.
  const never = deferred();
  const u = make({ routes: (net) => { usual()(net); net.on('/api/books/continue', () => never.promise); } });
  u.mount();
  await u.clock.advance(100);
  check('Continue still waiting: the grid waits', u.hidden('#libraryGrid'));
  await u.clock.advance(3800);
  check('a first ever visit holds the books for it (a row coming in after them would push them down)', u.hidden('#libraryGrid'));
  await u.clock.advance(200);
  check('but not for ever: the library shows without it', !u.hidden('#libraryGrid') && u.WS.arrived.join(',') === 'library', u.WS.arrived);

  // A repeat visit waits too: the memory says how much room to hold, not what the answer will be.
  const k = make({ storage: { 'webservarr_books_continue:sam': '0' }, routes: (net) => { usual()(net); net.on('/api/books/continue', () => never.promise); } });
  k.mount();
  await k.clock.advance(1600);
  check('a repeat visit holds the books for a slow Continue too', k.hidden('#libraryGrid'));
  await k.clock.advance(2500);
  check('and shows them once the wait is over', !k.hidden('#libraryGrid'));
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
  check('the choice is remembered for this person', t.win.localStorage.getItem('webservarr_books_view:sam') === '{"format":"audio","sort":"added","group":true}', t.win.localStorage.getItem('webservarr_books_view:sam'));

  // The next visit starts where this one left off.
  const u = make({ storage: { 'webservarr_books_view:sam': '{"format":"audio","sort":"title"}' }, routes: (net) => {
    usual()(net);
    net.on('/api/books?format=audio', () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: [] } }));
  } });
  await u.mount();
  check('it asks for the remembered view at once', u.net.urls('/api/books?')[0] === '/api/books?format=audio&sort=title&limit=36', u.net.urls('/api/books?'));
  check('and the controls show it', u.q('[data-format="audio"]').getAttribute('aria-pressed') === 'true' && u.text('#sortValue') === 'Title');
  // Rubbish in storage is ignored.
  const v = make({ storage: { 'webservarr_books_view:sam': '{"format":"pdf","sort":"nope","group":"no"}' }, routes: usual() });
  await v.mount();
  check('an unknown value falls back to the defaults', v.net.urls('/api/books?')[0] === '/api/books?format=all&sort=added&limit=36' && v.q('#groupSwitch').getAttribute('aria-checked') === 'true');
});

await run('the sort reloads the list and an older answer cannot overwrite a newer one', async (make) => {
  const first = deferred();
  const t = make({ routes: (net) => {
    usual()(net);
    net.on('/api/books?format=all&sort=title', () => ({ body: { items: [ebook(2, 'Emma', 'Jane Austen')], next_cursor: null, notes: [] } }));
    net.on('/api/books?format=all&sort=author', () => first.promise);
  } });
  pickerKit(t);
  await t.mount();
  t.click('#sortBtn');
  check('the sort offers Recently added, Title and Author', sortOptions(t).map((o) => o.textContent.replace('check', '')).join('|') === 'Recently added|Title|Author');
  sortOptions(t)[2].click();
  t.click('#sortBtn');
  sortOptions(t)[1].click();
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
  check('the results take the place of the rows and the library, under the search', t.hidden('#browseRows') && t.hidden('#libraryBody') && !t.hidden('#searchSection') && !t.hidden('#searchGrid') &&
    !t.hidden('#searchRow') && !t.hidden('#browseArea') && inOrder(t, '#searchRow', '#libraryBody', '#searchSection'));
  check('with the same cards', t.cards('searchGrid').length === 1 && t.cards('searchGrid')[0].getAttribute('href') === '/books/1');
  check('and a count a screen reader hears', t.text('#searchStatus') === '1 book found' && t.q('#searchStatus').getAttribute('role') === 'status');
  t.type('');
  check('clearing the box brings the library back at once', !t.hidden('#browseRows') && !t.hidden('#libraryBody') && t.hidden('#searchSection'));
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
  const cards = t.qa('#continueHost li [data-continue-open]');
  const plays = t.qa('#continueHost li [data-resume-audio], #continueHost li [data-resume-read]');
  check('one card per book, in order', cards.length === 3 && /Dune/.test(cards[0].textContent) && /Hobbit/.test(cards[1].textContent));
  check('the card itself opens the book\'s page, whatever its format', cards.map((c) => c.tagName + ' ' + c.getAttribute('href')).join('|') === 'A /books/1|A /books/3|A /books/6',
    cards.map((c) => c.getAttribute('href')));
  check('named Open <title>, with the place read after it', cards[1].getAttribute('aria-label') === 'Open The Hobbit' &&
    t.doc.getElementById(cards[1].getAttribute('aria-describedby')).textContent === '2h 10m left');
  check('one play button per card, beside the link and never inside it', plays.length === 3 && cards.every((c) => !c.querySelector('a, button')) &&
    plays.every((p, i) => p.closest('li') === cards[i].closest('li')));
  check('an ebook\'s goes into the reader through a real link', plays[0].tagName === 'A' && plays[0].getAttribute('href') === '/reader?seriesId=4&chapterId=9' &&
    plays[0].getAttribute('aria-label') === 'Continue reading Dune');
  check('an audiobook\'s is a button for the player', plays[1].tagName === 'BUTTON' && plays[1].getAttribute('type') === 'button' &&
    plays[1].getAttribute('data-resume-audio') === '14:1' && plays[1].getAttribute('aria-label') === 'Resume The Hobbit');
  check('it sits over the cover\'s own box, so it moves nothing', /\babsolute\b/.test(plays[1].parentNode.className) && /aspect-\[2\/3\]/.test(plays[1].parentNode.className) &&
    /pointer-events-none/.test(plays[1].parentNode.className) && /pointer-events-auto/.test(plays[1].className));
  check('hidden until hover or focus only where there is a mouse', /\[@media\(hover:hover\)_and_\(pointer:fine\)\]:opacity-0/.test(plays[1].className) &&
    /group-hover\/cont:opacity-100/.test(plays[1].className) && /group-focus-within\/cont:opacity-100/.test(plays[1].className) && !/(^| )opacity-0/.test(plays[1].className));
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
  const open = t.q('#continueHost [data-continue-open][href="/books/3"]');
  open.addEventListener('click', (e) => e.preventDefault());   // the router's part; here it stays put
  open.dispatchEvent(new t.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  check('the card around it does not start the player', t.win.WS.player.opened.length === 1);
});

await run('renderContinueRow: always a section; with nothing in progress, one quiet line', async (make) => {
  make({ html: '<div id="wsPage"></div>' });
  for (const empty of [[], null]) {
    const sec = books.renderContinueRow(empty, {});
    check('no items: still the section, headed Continue', sec && sec.hasAttribute('data-continue') && sec.getAttribute('aria-label') === 'Continue' && sec.querySelector('h2').textContent === 'Continue');
    check('and one quiet line instead of cards', !sec.querySelector('li') && sec.querySelector('[data-continue-empty]').textContent === 'Books you start will show up here.');
  }
  const failed = books.renderContinueRow([], { failed: true });
  check('a list that could not be read says so, not that there is nothing', failed.querySelector('[data-continue-empty]').textContent === 'Your books in progress didn’t load.');
  const row = books.renderContinueRow(CONT.slice(1), {});
  check('with books: the cards and no empty line', row.querySelectorAll('li').length === 2 && !row.querySelector('[data-continue-empty]'));
  check('the cards are Books\' size', row.querySelector('li > div').className.indexOf('w-36') !== -1);
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

await run('Continue failing leaves the library alone and says so in its own section', async (make) => {
  const t = make({ storage: { 'webservarr_books_continue:sam': '1' }, routes: (net) => { usual()(net); net.on('/api/books/continue', () => ({ status: 503, body: {} })); } });
  check('a person who had a row has its slot at once', t.doc.documentElement.hasAttribute('data-books-continue') === false);
  const mounted = t.mount();
  check('reserved before the first await', t.doc.documentElement.hasAttribute('data-books-continue'));
  await t.clock.advance(1600);
  await mounted;
  check('the row\'s room is given back', !t.doc.documentElement.hasAttribute('data-books-continue') && !t.q('#continueHost li'));
  check('the section stays, with its line', /didn’t load/.test(t.q('#continueHost [data-continue-empty]').textContent));
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

// ---- Taking a book out of Continue ----

// The cards' fade and slide run on the window's real clock (Element.animate).
const settle = async () => { await new Promise((r) => setTimeout(r, 450)); await flush(); };
const contIds = (t) => t.qa('#continueHost li[data-continue-item]').map((li) => li.getAttribute('data-continue-item'));
const key = (t, node, k, extra) => node.dispatchEvent(new t.win.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {})));

function hideRoutes(over = {}) {
  return (net) => {
    usual({ continue: { items: CONT, notes: [] } })(net);
    net.on('/api/books/1/continue-hidden', over.hide || (() => ({ body: { hidden: true } })));
    net.on('/api/books/3/continue-hidden', over.hide || (() => ({ body: { hidden: true } })));
    net.on('/api/books/6/continue-hidden', over.hide || (() => ({ body: { hidden: true } })));
  };
}

await run('Continue: each card has a More button beside its other controls, never inside them', async (make) => {
  const t = make({ routes: hideRoutes() });
  await t.mount();
  const mores = t.qa('#continueHost [data-continue-more]');
  check('one per card', mores.length === 3);
  check('a menu button, named for its book', mores[1].tagName === 'BUTTON' && mores[1].getAttribute('type') === 'button' &&
    mores[1].getAttribute('aria-haspopup') === 'menu' && mores[1].getAttribute('aria-expanded') === 'false' &&
    mores[1].getAttribute('aria-label') === 'More for The Hobbit');
  check('on the cover\'s top right corner, a sibling of the link and the play button', mores.every((m) => m.parentNode.matches('.group\\/cont') &&
    /\babsolute\b/.test(m.className) && /\bright-1\.5\b/.test(m.className) && /\btop-1\.5\b/.test(m.className)));
  check('the link still holds no control', t.qa('#continueHost [data-continue-open]').every((a) => !a.querySelector('a, button')));
  check('shown on hover or focus where there is a mouse, always on touch, and while its menu is open',
    /\[@media\(hover:hover\)_and_\(pointer:fine\)\]:opacity-0/.test(mores[0].className) && /group-hover\/cont:opacity-100/.test(mores[0].className) &&
    /group-focus-within\/cont:opacity-100/.test(mores[0].className) && /aria-expanded:opacity-100/.test(mores[0].className) && !/(^| )opacity-0/.test(mores[0].className));
  check('its icon is not read out', mores[0].querySelector('.material-symbols-outlined').getAttribute('aria-hidden') === 'true');
  check('in the order link, play, More', (() => {
    const kids = Array.from(t.q('#continueHost li .group\\/cont').querySelectorAll('a, button'));
    return kids.length === 3 && kids[0].hasAttribute('data-continue-open') && kids[1].hasAttribute('data-resume-read') && kids[2].hasAttribute('data-continue-more');
  })());
});

await run('Continue: the More menu opens, takes the focus, and Escape, Tab and a press outside close it', async (make) => {
  const t = make({ routes: hideRoutes() });
  await t.mount();
  const more = t.qa('#continueHost [data-continue-more]')[1];
  more.click();
  const menu = t.q('[data-continue-menu]');
  check('a menu opens', menu && menu.getAttribute('role') === 'menu');
  check('named by its button, which says it is open', menu.getAttribute('aria-labelledby') === more.id && more.getAttribute('aria-expanded') === 'true' &&
    more.getAttribute('aria-controls') === menu.id);
  const item = menu.querySelector('[role="menuitem"]');
  check('one item, Remove from Continue, with the focus', item && item.textContent.trim().endsWith('Remove from Continue') &&
    menu.querySelectorAll('[role="menuitem"]').length === 1 && t.doc.activeElement === item);
  check('outside the row (its scrolling would clip it)', !menu.closest('#continueHost'));
  key(t, item, 'ArrowDown');
  check('the arrows keep the one item', t.doc.activeElement === item && t.q('[data-continue-menu]'));
  key(t, item, 'Escape');
  await settle();
  check('Escape closes it', !t.q('[data-continue-menu]') && more.getAttribute('aria-expanded') === 'false' && !more.hasAttribute('aria-controls'));
  check('and the focus is back on the button', t.doc.activeElement === more);
  more.click();
  key(t, t.q('[data-continue-menu] [role="menuitem"]'), 'Tab');
  await settle();
  check('Tab closes it from the button', !t.q('[data-continue-menu]') && t.doc.activeElement === more);
  more.click();
  t.q('[data-continue-menu-layer]').dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
  await settle();
  check('a press outside closes it', !t.q('[data-continue-menu]') && more.getAttribute('aria-expanded') === 'false');
  more.click();
  more.click();
  await settle();
  check('its button again closes it too', !t.q('[data-continue-menu]'));
  check('nothing was sent', t.net.urls('/api/books/3/continue-hidden').length === 0);
  more.click();
  t.ctl.abort();
  await settle();
  check('leaving the page closes it', !t.q('[data-continue-menu]'));
});

await run('Continue: Remove takes the card out, the next card\'s More has the focus, and Undo puts it back', async (make) => {
  const t = make({ routes: hideRoutes() });
  await t.mount();
  t.WS.cache.set('books:continue', { items: CONT, notes: [] });
  t.qa('#continueHost [data-continue-more]')[1].click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  check('the menu closes at once', !t.q('[data-continue-menu]') || t.q('[data-continue-menu-layer]').inert);
  const sent = t.net.calls.filter((c) => c.url === '/api/books/3/continue-hidden');
  check('the server is told, with the time the card showed', sent.length === 1 && sent[0].init.method === 'PUT' &&
    JSON.parse(sent[0].init.body).updated_at === '2026-10-02T10:00:00Z', sent.map((c) => c.init));
  check('a toast says so, with Undo', t.toasts.length === 1 && t.toasts[0][0] === 'Removed from Continue.' && t.toasts[0][1] === 'ok' &&
    t.toasts[0][2].action.label === 'Undo', t.toasts);
  check('the card cannot be used while it goes', t.q('#continueHost li[data-continue-item="3"]').inert === true);
  await settle();
  check('the card is gone, the others stay in order', contIds(t).join() === '1,6', contIds(t));
  check('the next card\'s More button has the focus', t.doc.activeElement === t.q('#continueHost li[data-continue-item="6"] [data-continue-more]'));
  check('the kept copy is dropped', !t.WS.cache.has('books:continue'));
  check('the row is still remembered', t.win.localStorage.getItem('webservarr_books_continue:sam') === '1');
  t.toasts[0][2].action.run();
  await settle();
  check('Undo: the card is back where it was', contIds(t).join() === '1,3,6', contIds(t));
  check('with the focus on it', t.doc.activeElement === t.q('#continueHost li[data-continue-item="3"] [data-continue-open]'));
  const undone = t.net.calls.filter((c) => c.url === '/api/books/3/continue-hidden' && c.init.method === 'DELETE');
  check('and the server told', undone.length === 1);
  check('the card works again', t.q('#continueHost li[data-continue-item="3"]').inert !== true && t.q('#continueHost li[data-continue-item="3"] [data-continue-more]'));
});

await run('Continue: the last card gives way to the empty line, which takes the focus', async (make) => {
  const t = make({ routes: hideRoutes() });
  await t.mount();
  const focusAfter = [];
  for (const id of ['6', '1', '3']) {
    t.q(`#continueHost li[data-continue-item="${id}"] [data-continue-more]`).click();
    t.q('[data-continue-menu] [data-continue-remove]').click();
    await settle();
    const li = t.doc.activeElement && t.doc.activeElement.closest ? t.doc.activeElement.closest('li[data-continue-item]') : null;
    focusAfter.push(li ? li.getAttribute('data-continue-item') : t.doc.activeElement && t.doc.activeElement.tagName);
  }
  check('the card before took the focus when the row\'s last card went, then the next one', focusAfter.join() === '3,3,P', focusAfter);
  const line = t.q('#continueHost [data-continue-empty]');
  check('the row shows its empty line', !t.q('#continueHost li') && line && line.textContent === 'Books you start will show up here.');
  check('still the Continue section', t.q('#continueHost [data-continue] h2').textContent === 'Continue');
  check('the line has the focus', t.doc.activeElement === line);
  check('the next visit holds the line\'s room, not a row', t.win.localStorage.getItem('webservarr_books_continue:sam') === '0' &&
    !t.doc.documentElement.hasAttribute('data-books-continue'));
  t.toasts[2][2].action.run();
  await settle();
  check('Undo of the last one brings a row back with it', contIds(t).join() === '3' && !t.q('#continueHost [data-continue-empty]'));
  check('focused', t.doc.activeElement === t.q('#continueHost li[data-continue-item="3"] [data-continue-open]'));
  check('and remembered again', t.win.localStorage.getItem('webservarr_books_continue:sam') === '1' && t.doc.documentElement.hasAttribute('data-books-continue'));
  check('the restored row still drags', t.WS.drags.some((d) => d.el === t.q('#continueHost [data-continue-row]')));
  t.toasts[0][2].action.run();
  t.toasts[1][2].action.run();
  await settle();
  check('the others come back in their own order', contIds(t).join() === '1,3,6', contIds(t));
});

await run('Continue: Undo while the card is still fading keeps it', async (make) => {
  const t = make({ routes: hideRoutes() });
  await t.mount();
  t.qa('#continueHost [data-continue-more]')[0].click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  t.toasts[0][2].action.run();
  await settle();
  check('the card stays, once', contIds(t).join() === '1,3,6', contIds(t));
  check('usable again', t.q('#continueHost li[data-continue-item="1"]').inert !== true && !t.q('#continueHost li[data-continue-item="1"]').hasAttribute('data-leaving'));
});

await run('Continue: a refused Remove puts the card back and says so', async (make) => {
  const t = make({ routes: hideRoutes({ hide: () => ({ status: 503, body: {} }) }) });
  await t.mount();
  t.qa('#continueHost [data-continue-more]')[1].click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  await settle();
  check('the card is back', contIds(t).join() === '1,3,6', contIds(t));
  check('the Undo toast went, an error says so', t.toasts[0].removed === true && t.toasts.length === 2 &&
    t.toasts[1][1] === 'err' && /Couldn’t remove it from Continue/.test(t.toasts[1][0]), t.toasts);
});

await run('Continue: a refused Undo takes the card out again and says so', async (make) => {
  const t = make({ routes: (net) => {
    hideRoutes()(net);
    net.on('/api/books/3/continue-hidden', (u, init) => (init.method === 'DELETE' ? { status: 503, body: {} } : { body: { hidden: true } }));
  } });
  await t.mount();
  t.qa('#continueHost [data-continue-more]')[1].click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  await settle();
  t.toasts[0][2].action.run();
  await settle();
  check('it is out again, as the server has it', contIds(t).join() === '1,6', contIds(t));
  check('with an error', t.toasts.some((x) => x[1] === 'err' && /put it back/.test(x[0])), t.toasts);
});

await run('Continue: Undo after leaving the page still tells the server, and draws nothing', async (make) => {
  const t = make({ routes: hideRoutes() });
  await t.mount();
  t.qa('#continueHost [data-continue-more]')[1].click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  await settle();
  t.ctl.abort();
  t.toasts[0][2].action.run();
  await settle();
  check('the server is told', t.net.calls.some((c) => c.url === '/api/books/3/continue-hidden' && c.init.method === 'DELETE'));
  check('the left page is not drawn on', contIds(t).join() === '1,6');
});

// A visit that paints a kept copy of Continue while the live answer is held.
async function keptThenLive(make) {
  const live = deferred();
  const t = make({ routes: (net) => {
    hideRoutes()(net);
    net.on('/api/books/continue', () => live.promise);
  } });
  t.WS.cache.set('books:continue', { items: CONT, notes: [] });
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  // What the server built before it heard of any removal: every card still
  // in it, The Hobbit listened to since the copy was kept.
  const fresh = JSON.parse(JSON.stringify(CONT));
  fresh[1].updated_at = '2026-10-08T09:00:00Z'; fresh[1].progress_label = '1h 40m left'; fresh[1].percent = 70;
  t.live = async () => { live.resolve({ body: { items: fresh, notes: [] } }); await flush(); await t.clock.advance(50); };
  return t;
}
const hides = (t) => t.net.calls.filter((c) => c.url === '/api/books/3/continue-hidden' && c.init.method === 'PUT').map((c) => JSON.parse(c.init.body).updated_at);

await run('Continue: a book taken out stays out when a live answer built before it lands, and is not kept', async (make) => {
  const t = await keptThenLive(make);
  check('drawn from the kept copy', contIds(t).join() === '1,3,6', contIds(t));
  t.qa('#continueHost [data-continue-more]')[1].click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  await settle();
  check('taken out', contIds(t).join() === '1,6', contIds(t));
  await t.live();
  check('the live answer does not bring it back', contIds(t).join() === '1,6', contIds(t));
  const kept = t.WS.cache.get('books:continue');
  check('nor does the copy kept for the next visit', !!kept && kept.items.map((i) => i.book_id).join() === '1,6', kept);
  check('the server is sent the newer time the live answer has, so it stays out next visit too',
    JSON.stringify(hides(t)) === JSON.stringify(['2026-10-02T10:00:00Z', '2026-10-08T09:00:00Z']), hides(t));
  t.toasts[0][2].action.run();
  await settle();
  check('Undo on the replaced row still brings it back, in its place', contIds(t).join() === '1,3,6', contIds(t));
  check('and tells the server', t.net.calls.some((c) => c.url === '/api/books/3/continue-hidden' && c.init.method === 'DELETE'));
});

await run('Continue: a removal sends the newest time seen for the book, not the card\'s', async (make) => {
  const t = await keptThenLive(make);
  // The live answer lands with the menu closed; it redraws The Hobbit with the newer time.
  await t.live();
  check('redrawn from the live answer', contIds(t).join() === '1,3,6', contIds(t));
  t.qa('#continueHost [data-continue-more]')[1].click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  await settle();
  check('the PUT carries the live time, once', JSON.stringify(hides(t)) === JSON.stringify(['2026-10-08T09:00:00Z']), hides(t));
});

await run('Continue: a live answer landing while a card\'s menu is open closes it; Remove is never on a row off screen', async (make) => {
  const t = await keptThenLive(make);
  const more = t.qa('#continueHost [data-continue-more]')[1];
  more.click();
  check('the menu is open', !!t.q('[data-continue-menu]'));
  await t.live();
  await settle();
  check('the redraw closed it', !t.q('[data-continue-menu]'), !!t.q('[data-continue-menu]'));
  const again = t.q('#continueHost li[data-continue-item="3"] [data-continue-more]');
  check('the focus is on the same book\'s More button in the new row', !!again && again !== more && t.doc.activeElement === again);
  again.click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  await settle();
  check('Remove from the new row takes the card off the screen', contIds(t).join() === '1,6', contIds(t));
  check('with one PUT and one toast', hides(t).length === 1 && t.toasts.length === 1, [hides(t), t.toasts.length]);
});

await run('Continue: a refused Remove on a replaced row brings the card back', async (make) => {
  const live = deferred();
  const put = deferred();
  const t = make({ routes: (net) => {
    hideRoutes({ hide: () => put.promise })(net);
    net.on('/api/books/continue', () => live.promise);
  } });
  t.WS.cache.set('books:continue', { items: CONT, notes: [] });
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  t.qa('#continueHost [data-continue-more]')[1].click();
  t.q('[data-continue-menu] [data-continue-remove]').click();
  await settle();
  const fresh = JSON.parse(JSON.stringify(CONT));
  fresh[0].percent = 47;
  live.resolve({ body: { items: fresh, notes: [] } });
  await flush(); await t.clock.advance(50);
  check('out while the PUT is out', contIds(t).join() === '1,6', contIds(t));
  put.resolve({ status: 503, body: {} });
  await settle();
  check('refused: the card is back in the row on screen', contIds(t).join() === '1,3,6', contIds(t));
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
  check('no problem is shown while the hand-off is under way (its room is held, unseen)', t.q('#connectState').classList.contains('invisible'));
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
  // (Up next and My list, kept too: every row above the books has a kept answer.)
  t.WS.cache.set('books:me:queue', { items: [] });
  t.WS.cache.set('books:me:list', { items: [] });
  // (And the discovery shelves, books 3c.)
  t.WS.cache.set('books:recent', { items: [] });
  t.WS.cache.set('books:popular', { items: [] });
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
  check('when the books arrive they show, and the view is kept then', t.cards('libraryGrid').length === 1 && t.win.localStorage.getItem('webservarr_books_view:sam') === '{"format":"audio","sort":"added","group":true}');
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
  check('all of it, Continue included, sits above the books inside the library section (no element already shown has to move)', t.q('#librarySection').contains(t.q('#continueHost')) &&
    inOrder(t, '#continueHost', '#toolbar', '#connectState', '#notes', '#libraryGrid'));
  // A library that never answers does not keep the page a skeleton for ever.
  const never = deferred();
  const u = make({ routes: (net) => { usual()(net); net.on('/api/books?', () => never.promise); } });
  u.mount();
  await u.clock.advance(3900);
  check('4 s: still waiting', !u.hidden('#toolbarSkel'));
  await u.clock.advance(200);
  check('after 4 s the controls come in anyway (the skeleton is their exact size)', u.hidden('#toolbarSkel') && !u.hidden('#toolbar'));
  check('but Continue and the notes wait for the books: above the grid\'s skeleton they would move it', !!u.q('#continueHost .skel') && !u.q('#continueHost [data-continue]') && u.hidden('#notes') && !u.hidden('#gridSkeleton'));
  // The error path is a write of its own too.
  const v = make({ routes: usual({ library: () => ({ status: 503, body: {} }) }) });
  await v.mount();
  check('an error brings the toolbar in with its message', !v.hidden('#toolbar') && !v.hidden('#errorState'));
});

await run('T3H5: on a first visit a Continue row slower than the gate still comes in with the books', async (make) => {
  const cont = deferred();
  const t = make({ routes: (net) => { usual()(net); net.on('/api/books/continue', () => cont.promise.then(() => ({ body: { items: CONT, notes: [] } }))); } });
  const m = t.mount();
  await t.clock.advance(900);
  check('the books wait, not drawn without the row', t.hidden('#libraryGrid') && !t.q('#continueHost [data-continue]'));
  cont.resolve();
  await t.clock.advance(50);
  await m;
  check('then the row and the books come together', !t.hidden('#libraryGrid') && !!t.q('#continueHost [data-continue]') && t.hidden('#toolbarSkel'));
});

await run('T3H5: a kept "not connected" answer holds the connect message\'s room, so it comes in without moving the books', async (make) => {
  const lib = () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED, building: false } });
  const live = deferred();
  const t = make({ routes: (net) => { usual()(net); net.on('/api/books?', () => live.promise.then(lib)); } });
  t.kav.blockNext = true;
  t.WS.cache.set('books:list:all:added', lib().body);
  t.WS.cache.set('books:continue', { items: [], notes: [] });
  const m = t.mount();
  await flush();
  const box = t.q('#connectState');
  check('from the kept copy: its room is held (in the layout, unseen)', !box.classList.contains('hidden') && box.classList.contains('invisible'), box.className);
  check('and the books are already there', t.cards('libraryGrid').length === 1);
  live.resolve();
  await t.clock.advance(100);
  await m;
  check('the live answer shows it in the room already held', !box.classList.contains('hidden') && !box.classList.contains('invisible'));
  // No such note: no room held.
  const u = make({ routes: usual() });
  await u.mount();
  check('without the note nothing is held', u.hidden('#connectState'));
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

await run('FR2: while a source is not answering, an empty search offers no request and says why', async (make) => {
  const down = { source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' };
  const t = make({ routes: usual({ search: { items: [], request_url: null, notes: [down] } }) });
  await t.mount();
  t.type('emma');
  await t.clock.advance(350);
  check('no request link', t.q('#searchRequest').classList.contains('hidden'));
  check('the note is said instead', t.text('#searchEmptyTitle') === 'No matches right now' && /Ebooks are unavailable right now/.test(t.text('#searchEmptyText')), [t.text('#searchEmptyTitle'), t.text('#searchEmptyText')]);
  check('and it does not claim the book is not there', !/Not in the library|No books match/.test(t.text('#searchEmptyTitle')));
  const nc = { source: 'kavita', reason: 'not_connected', text: 'Connect to your ebook library to see ebooks' };
  const u = make({ routes: usual({ search: { items: [], request_url: null, notes: [nc] } }) });
  await u.mount();
  u.type('emma');
  await u.clock.advance(350);
  check('not connected: the note, with no "try again in a moment"', /Connect to your ebook library/.test(u.text('#searchEmptyText')) && !/moment/.test(u.text('#searchEmptyText')) && u.q('#searchRequest').classList.contains('hidden'));
  // The usual answer still has the link (above), and a null request_url is the server's word, not a guess.
  const v = make({ routes: usual({ search: { items: [], request_url: '/requests?q=emma', notes: [] } }) });
  await v.mount();
  v.type('emma');
  await v.clock.advance(350);
  check('with every source answering the link is there', !v.q('#searchRequest').classList.contains('hidden'));
});

await run('FR2: an empty library with a source down does not offer Request a book', async (make) => {
  const down = { source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' };
  const t = make({ routes: usual({ library: () => ({ body: { items: [], next_cursor: null, notes: [down], building: false } }) }) });
  await t.mount();
  check('no Request a book while a source is down', t.q('#emptyRequest').classList.contains('hidden') && /Check back/.test(t.text('#emptyText')), t.text('#emptyText'));
  const u = make({ routes: usual({ library: () => ({ body: { items: [], next_cursor: null, notes: [], building: false } }) }) });
  await u.mount();
  check('an empty library with every source answering still does', !u.q('#emptyRequest').classList.contains('hidden'));
});

// ---- Books 3b: Up next and My list ----

// The person's own data on a scripted server: the queue (book cards in order)
// and the list; every write recorded; moveStatus / removeStatus make the server refuse.
function mine(o = {}) {
  const srv = {
    queue: (o.queue || []).slice(), list: (o.list || []).slice(), writes: [], moveStatus: 200, removeStatus: 200,
    queueStatus: o.queueStatus || 200, listStatus: o.listStatus || 200, details: o.details || {}, holdQueue: o.holdQueue || null
  };
  const cards = () => srv.queue.map((c, i) => Object.assign({}, c, { position: i }));
  srv.routes = (net) => {
    net.on('/api/books/me/queue', () => {
      if (srv.queueStatus !== 200) return { status: srv.queueStatus, body: {} };
      const answer = { body: { items: cards() } };
      return srv.holdQueue ? srv.holdQueue.promise.then(() => answer) : answer;
    });
    net.on('/api/books/me/list', () => (srv.listStatus !== 200 ? { status: srv.listStatus, body: {} } : { body: { items: srv.list } }));
    net.on('/api/books/me/queue/move', (url, init) => {
      const body = JSON.parse(init.body);
      srv.writes.push({ method: init.method, url, body, credentials: init.credentials });
      if (srv.moveStatus !== 200) return { status: srv.moveStatus, body: {} };
      const at = srv.queue.findIndex((c) => c.id === body.book_id);
      const [card] = srv.queue.splice(at, 1);
      srv.queue.splice(Math.min(body.to, srv.queue.length), 0, card);
      return { body: { items: cards() } };
    });
    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      net.on('/api/books/' + id, (url) => ({ body: srv.details[id] || { book: { id }, formats: {} } }));
      net.on('/api/books/' + id + '/queue', (url, init) => {
        srv.writes.push({ method: init && init.method, url, credentials: init && init.credentials });
        if (srv.removeStatus !== 200) return { status: srv.removeStatus, body: {} };
        srv.queue = srv.queue.filter((c) => c.id !== id);
        return { body: { queue_position: null } };
      });
    }
  };
  return srv;
}
const withMine = (srv, over) => (net) => { usual(over)(net); srv.routes(net); };
const QUEUE = [both(1, 'Dune', 'Frank Herbert'), audio(3, 'The Hobbit', 'J. R. R. Tolkien'), ebook(2, 'Emma', 'Jane Austen')];
const queued = (t) => t.qa('#upnextHost [data-queued]').map((li) => li.getAttribute('data-queued'));
const places = (t) => t.qa('#upnextHost [data-place]').map((n) => n.textContent);
const upBtn = (t, id, kind) => t.q(`#upnextHost [data-queued="${id}"] [data-up="${kind}"]`);
const fancyPlayer = () => ({
  opened: [], listeners: [], st: { book: null, playing: false },
  open(key, opts) { this.opened.push([key, opts]); return Promise.resolve(); },
  state() { return this.st; },
  on(name, fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((x) => x !== fn); }; },
  change(st) { this.st = Object.assign({}, this.st, st); this.listeners.slice().forEach((fn) => fn({ reason: 'state', state: this.st })); }
});

await run('3b: Up next and My list rows: in order, with their controls, above the library', async (make) => {
  const srv = mine({ queue: QUEUE, list: [ebook(5, 'Villette', 'Charlotte Brontë'), both(1, 'Dune', 'Frank Herbert')] });
  const t = make({ routes: withMine(srv) });
  await t.mount();
  const up = t.q('#upnextHost [data-upnext]');
  check('Up next is a section with its heading', !!up && up.getAttribute('aria-label') === 'Up next' && up.querySelector('h2').textContent === 'Up next');
  check('an ordered list (a screen reader says the place)', up.querySelector('[data-upnext-list]').tagName === 'OL');
  check('the queue in order', queued(t).join() === '1,3,2', queued(t));
  check('each cover carries its place', places(t).join() === '1,2,3');
  check('the book is a link to its page', t.q('#upnextHost [data-queued="3"] a').getAttribute('href') === '/books/3');
  check('both formats: Play and Read; audio only: Play; ebook only: Read',
    t.qa('#upnextHost [data-queued="1"] [data-up="play"], #upnextHost [data-queued="1"] [data-up="read"]').length === 2 &&
    !!upBtn(t, 3, 'play') && !upBtn(t, 3, 'read') && !upBtn(t, 2, 'play') && !!upBtn(t, 2, 'read'));
  check('a lone Play or Read spans the card', /col-span-2/.test(upBtn(t, 3, 'play').className) && !/col-span-2/.test(upBtn(t, 1, 'play').className));
  check('Move earlier, Move later and Remove, named for the book', upBtn(t, 3, 'earlier').getAttribute('aria-label') === 'Move The Hobbit earlier' &&
    upBtn(t, 3, 'later').getAttribute('aria-label') === 'Move The Hobbit later' && upBtn(t, 3, 'remove').getAttribute('aria-label') === 'Remove The Hobbit from Up next');
  check('the first cannot go earlier, the last cannot go later', upBtn(t, 1, 'earlier').disabled && !upBtn(t, 1, 'later').disabled && upBtn(t, 2, 'later').disabled && !upBtn(t, 2, 'earlier').disabled);
  check('keyboard: every control is a real button with a focus ring, nothing nested in the link',
    t.qa('#upnextHost [data-up]').every((b) => b.tagName === 'BUTTON' && b.getAttribute('type') === 'button' && /focus-visible:outline-2/.test(b.className) && !b.closest('a')));
  const list = t.q('#mylistHost [data-mylist]');
  check('My list: newest first, as library cards with their format badges', !!list && list.querySelector('h2').textContent === 'My list' &&
    t.qa('#mylistHost li > a').map((a) => a.getAttribute('href')).join() === '/books/5,/books/1' && !!t.q('#mylistHost [data-format="audio"]'));
  check('both rows sit above the toolbar inside the library section, after Continue and Recently added', t.q('#librarySection').contains(t.q('#upnextHost')) &&
    inOrder(t, '#continueHost', '#recentHost', '#upnextHost', '#mylistHost', '#toolbar'));
  check('both shown, and remembered for the next first paint', t.doc.documentElement.hasAttribute('data-books-upnext') && t.doc.documentElement.hasAttribute('data-books-mylist') &&
    t.win.localStorage.getItem('webservarr_books_upnext:sam') === '1' && t.win.localStorage.getItem('webservarr_books_mylist:sam') === '1');
  check('no overflow at 320: the rows scroll sideways inside the page gutter, as Continue does', t.qa('#upnextHost ol.books-row.-mx-4.px-4, #mylistHost ul.books-row.-mx-4.px-4').length === 2);
  check('each row is handed to the shell\'s drag-to-scroll, with the visit\'s signal', t.WS.drags.length === 2 && t.WS.drags.every((d) => d.opts.signal === t.ctl.signal && d.el.classList.contains('books-row')));
});

await run('3b: empty rows are not shown, and the next visit does not hold their room', async (make) => {
  const t = make({ storage: { 'webservarr_books_upnext:sam': '1', 'webservarr_books_mylist:sam': '1' }, routes: withMine(mine()) });
  const m = t.mount();
  check('remembered rows are held before the first await', t.doc.documentElement.hasAttribute('data-books-upnext') && t.doc.documentElement.hasAttribute('data-books-mylist'));
  await t.clock.advance(1600);
  await m;
  check('empty: released', !t.doc.documentElement.hasAttribute('data-books-upnext') && !t.doc.documentElement.hasAttribute('data-books-mylist') && !t.q('#upnextHost [data-upnext]') && !t.q('#mylistHost [data-mylist]'));
  check('and remembered as none', t.win.localStorage.getItem('webservarr_books_upnext:sam') === '0' && t.win.localStorage.getItem('webservarr_books_mylist:sam') === '0');
  const srv = mine();
  srv.queueStatus = 503;
  srv.listStatus = 403;
  const u = make({ storage: { 'webservarr_books_upnext:sam': '1' }, routes: withMine(srv) });
  await u.mount();
  check('a failed read: no row, the library still shows', !u.q('#upnextHost [data-upnext]') && !u.hidden('#libraryGrid'));
  check('and it does not forget that they had one', u.win.localStorage.getItem('webservarr_books_upnext:sam') === '1');
  const v = make({ routes: withMine(mine({ queue: QUEUE, list: [ebook(5, 'Villette', 'Charlotte Brontë')] })) });
  const leave = await v.mount();
  check('shown', v.doc.documentElement.hasAttribute('data-books-upnext') && v.doc.documentElement.hasAttribute('data-books-mylist'));
  leave();
  check('leaving the page takes the flags off', !v.doc.documentElement.hasAttribute('data-books-upnext') && !v.doc.documentElement.hasAttribute('data-books-mylist') && !v.doc.documentElement.hasAttribute('data-books-continue'));
});

await run('3b: CLS: on a first visit the books wait for Up next and My list too, and all of it lands in one write', async (make) => {
  const hold = deferred();
  const srv = mine({ queue: QUEUE, holdQueue: hold });
  const t = make({ storage: { 'webservarr_books_continue:sam': '0', 'webservarr_books_mylist:sam': '0' }, routes: withMine(srv) });
  const m = t.mount();
  await t.clock.advance(900);
  check('Up next not answered yet (no memory of it): the books wait', t.hidden('#libraryGrid') && !t.hidden('#toolbarSkel'));
  hold.resolve();
  await t.clock.advance(50);
  await m;
  check('then the row and the books come together', !t.hidden('#libraryGrid') && !!t.q('#upnextHost [data-upnext]') && t.hidden('#toolbarSkel'));
  // Remembered: its room is held, and it comes in with the books.
  const hold2 = deferred();
  const lib = deferred();
  const u = make({ storage: { 'webservarr_books_continue:sam': '0', 'webservarr_books_upnext:sam': '1', 'webservarr_books_mylist:sam': '0' },
    routes: (net) => { withMine(mine({ queue: QUEUE }))(net); net.on('/api/books?', () => lib.promise); } });
  const m2 = u.mount();
  await u.clock.advance(100);
  check('the room is held by the skeleton, the row is not drawn before the books', u.doc.documentElement.hasAttribute('data-books-upnext') && !!u.q('#upnextHost .skel') && !u.q('#upnextHost [data-upnext]'));
  lib.resolve({ body: { items: SHELF, next_cursor: null, notes: [], building: false } });
  await u.clock.advance(100);
  await m2;
  check('the row lands with the books, in the room held for it', !!u.q('#upnextHost [data-upnext]') && !u.hidden('#libraryGrid') && !u.q('#upnextHost .skel'));
  check('the skeleton is the cards\' own shape (cover, two lines, Play/Read row, move row)', /w-40/.test(Array.from(new u.win.DOMParser().parseFromString(BOOKS_HTML, 'text/html').querySelectorAll('#upnextHost .books-row > div')).map((d) => d.className).join()) &&
    new u.win.DOMParser().parseFromString(BOOKS_HTML, 'text/html').querySelectorAll('#upnextHost .books-row > div:first-child > *').length === 5);
  void hold2;
});

await run('3b: Move later and Move earlier: the cards trade places at once, the server is told, the focus stays', async (make) => {
  const srv = mine({ queue: QUEUE });
  const t = make({ routes: withMine(srv) });
  await t.mount();
  t.WS.cache.set('books:me:queue', { items: [] });
  const later = upBtn(t, 1, 'later');
  later.focus();
  later.click();
  check('at once: Dune is second', queued(t).join() === '3,1,2' && places(t).join() === '1,2,3');
  check('the focus is still on the button pressed', t.doc.activeElement === later);
  check('said for a screen reader', t.text('#booksSaid') === 'Moved later, now number 2 in Up next');
  check('the kept copy is dropped', !t.WS.cache.has('books:me:queue'));
  await t.clock.advance(10);
  check('POST /api/books/me/queue/move {book_id: 1, to: 1}, same-origin', srv.writes.length === 1 && srv.writes[0].method === 'POST' && srv.writes[0].body.book_id === 1 && srv.writes[0].body.to === 1 && srv.writes[0].credentials === 'same-origin', srv.writes);
  later.click();
  check('again: Dune is last, Move later is now off', queued(t).join() === '3,2,1' && later.disabled);
  check('the focus moved to Move earlier on the same card (never lost)', t.doc.activeElement === upBtn(t, 1, 'earlier'));
  upBtn(t, 1, 'earlier').click();
  upBtn(t, 2, 'earlier').click();
  await t.clock.advance(10);
  check('quick moves are sent one after another, in order', srv.writes.map((w) => w.body.book_id + '>' + w.body.to).join() === '1>1,1>2,1>1,2>1', srv.writes.map((w) => w.body));
  check('the server agrees: the order on screen is its order', queued(t).join() === srv.queue.map((c) => c.id).join(), [queued(t), srv.queue.map((c) => c.id)]);
  check('no toast', t.toasts.length === 0);
});

await run('3b: a move the server refuses: a toast, and the queue as the server has it', async (make) => {
  const srv = mine({ queue: QUEUE });
  const t = make({ routes: withMine(srv) });
  await t.mount();
  srv.moveStatus = 503;
  upBtn(t, 1, 'later').click();
  check('moved at once', queued(t).join() === '3,1,2');
  await t.clock.advance(10);
  check('refused: a toast that says what to do', t.toasts.length === 1 && t.toasts[0][0] === 'Couldn’t move it in Up next. Try again.' && t.toasts[0][1] === 'err', t.toasts);
  check('the queue is read again and drawn as the server has it', queued(t).join() === '1,3,2', queued(t));
});

await run('3b: Remove: the card goes at once, the focus to its neighbour; the last one hides the row', async (make) => {
  const srv = mine({ queue: QUEUE.slice(0, 2) });
  const t = make({ routes: withMine(srv) });
  await t.mount();
  const rm = upBtn(t, 1, 'remove');
  rm.focus();
  rm.click();
  check('gone at once, the places renumbered', queued(t).join() === '3' && places(t).join() === '1');
  check('the focus is on the next card\'s Remove', t.doc.activeElement === upBtn(t, 3, 'remove'));
  check('the one left can go nowhere', upBtn(t, 3, 'earlier').disabled && upBtn(t, 3, 'later').disabled);
  await t.clock.advance(10);
  check('DELETE /api/books/1/queue', srv.writes[0].method === 'DELETE' && srv.writes[0].url === '/api/books/1/queue');
  check('said', t.text('#booksSaid') === 'Removed from Up next');
  upBtn(t, 3, 'remove').click();
  await t.clock.advance(10);
  check('the last one: the row hides and is remembered as none', !t.q('#upnextHost [data-upnext]') && !t.doc.documentElement.hasAttribute('data-books-upnext') && t.win.localStorage.getItem('webservarr_books_upnext:sam') === '0');
  check('the focus went on down the page (the search, right above the filters), not lost', t.doc.activeElement === t.q('#booksSearch'), t.doc.activeElement && t.doc.activeElement.outerHTML.slice(0, 60));
  const srv2 = mine({ queue: QUEUE });
  srv2.removeStatus = 503;
  const u = make({ routes: withMine(srv2) });
  await u.mount();
  upBtn(u, 3, 'remove').click();
  await u.clock.advance(10);
  check('refused: a toast, and the card is back where the server has it', u.toasts.length === 1 && queued(u).join() === '1,3,2', [u.toasts, queued(u)]);
});

await run('3b: Play opens the preferred edition in the player; the book leaves Up next once it really plays', async (make) => {
  const srv = mine({ queue: QUEUE, details: { 3: { book: { id: 3 }, formats: { ebook: null, audio: { editions: [{ plex_book_key: '14:1' }, { plex_book_key: '14:2' }], preferred: '14:2' } }, notes: [{ source: 'kavita', reason: 'not_connected', text: 'x' }] } } });
  const t = make({ player: false, routes: withMine(srv) });
  const p = fancyPlayer();
  t.win.WS.player = p;
  await t.mount();
  const play = upBtn(t, 3, 'play');
  play.click();
  check('it says Opening while it reads the book', play.textContent.indexOf('Opening…') !== -1 && play.getAttribute('aria-disabled') === 'true');
  play.click();
  await t.clock.advance(10);
  check('one read of the book, one open: the preferred edition, playing', t.net.urls('/api/books/3').length === 1 && JSON.stringify(p.opened) === JSON.stringify([['14:2', { autoplay: true }]]), [t.net.urls('/api/books/3'), p.opened]);
  check('a note in that answer starts no hand-off', t.kav.reconnect.length === 0);
  check('back to Play', play.textContent.indexOf('Play') !== -1 && play.getAttribute('aria-disabled') === 'false');
  check('it is still queued while it has not played', queued(t).indexOf('3') !== -1 && srv.writes.length === 0);
  p.change({ book: '14:2', playing: false, safetyNet: true });
  p.change({ book: '14:2', playing: true, safetyNet: true });
  check('a preview while the player holds it does not count', srv.writes.length === 0);
  p.change({ book: '14:2', playing: true, safetyNet: false });
  await t.clock.advance(10);
  check('really playing: DELETE /api/books/3/queue, once, and the card goes', srv.writes.length === 1 && srv.writes[0].url === '/api/books/3/queue' && queued(t).join() === '1,2', [srv.writes, queued(t)]);
  p.change({ book: '14:2', playing: false });
  p.change({ book: '14:2', playing: true });
  check('and only once', srv.writes.length === 1 && p.listeners.length === 0);
  // Another book first: nothing is removed.
  const srv2 = mine({ queue: QUEUE, details: { 3: { book: { id: 3 }, formats: { audio: { editions: [{ plex_book_key: '14:1' }], preferred: null } } } } });
  const u = make({ player: false, routes: withMine(srv2) });
  const q = fancyPlayer();
  u.win.WS.player = q;
  await u.mount();
  upBtn(u, 3, 'play').click();
  await u.clock.advance(10);
  check('no preferred: the first edition', q.opened[0][0] === '14:1');
  q.change({ book: '99:1', playing: true });
  q.change({ book: '14:1', playing: true });
  await u.clock.advance(10);
  check('another book played first: it stays in Up next', srv2.writes.length === 0 && queued(u).indexOf('3') !== -1);
  const v = make({ player: false, routes: withMine(mine({ queue: QUEUE })) });
  await v.mount();
  upBtn(v, 3, 'play').click();
  check('no player: a quiet toast', v.toasts.length === 1 && /player/.test(v.toasts[0][0]));
  const srv3 = mine({ queue: QUEUE, details: { 3: { book: { id: 3 }, formats: { audio: null } } } });
  const x = make({ player: false, routes: withMine(srv3) });
  x.win.WS.player = fancyPlayer();
  await x.mount();
  upBtn(x, 3, 'play').click();
  await x.clock.advance(10);
  check('no audiobook in the answer (gone, or its source down): it says so', x.toasts.length === 1 && x.toasts[0][0] === 'This audiobook is unavailable right now. Try again in a moment.' && x.win.WS.player.opened.length === 0);
});

await run('3b: Read opens the reader at the book through the router', async (make) => {
  const srv = mine({ queue: QUEUE, details: { 2: { book: { id: 2 }, formats: { ebook: { read_url: '/reader?seriesId=4&chapterId=9' } } }, 1: { book: { id: 1 }, formats: { ebook: { read_url: 'javascript:alert(1)' } } } } });
  const t = make({ routes: withMine(srv) });
  await t.mount();
  upBtn(t, 2, 'read').click();
  await t.clock.advance(10);
  check('soft navigation to the reader address the answer gave', JSON.stringify(t.WS.navigated) === '["/reader?seriesId=4&chapterId=9"]', t.WS.navigated);
  check('reading does not take it out of Up next', srv.writes.length === 0);
  upBtn(t, 1, 'read').click();
  await t.clock.advance(10);
  check('an address that is not the reader\'s is never followed', t.WS.navigated.length === 1 && t.toasts.length === 1 && t.toasts[0][0] === 'This ebook is unavailable right now. Try again in a moment.');
});

await run('3b: a page that was left draws nothing more and sends nothing it was not asked to', async (make) => {
  const srv = mine({ queue: QUEUE, details: { 3: { book: { id: 3 }, formats: { audio: { editions: [{ plex_book_key: '14:1' }], preferred: '14:1' } } } } });
  const t = make({ player: false, routes: withMine(srv) });
  const p = fancyPlayer();
  t.win.WS.player = p;
  await t.mount();
  upBtn(t, 3, 'play').click();
  await t.clock.advance(10);
  t.ctl.abort();
  p.change({ book: '14:1', playing: true });
  await t.clock.advance(10);
  check('left before it played: the player watch ended, nothing removed', p.listeners.length === 0 && srv.writes.length === 0);
});

// ---- Books 3c: Recently added, Popular on the server, Your stats ----

const RECENT = [Object.assign(both(1, 'Dune', 'Frank Herbert'), { is_new: true }), Object.assign(ebook(2, 'Emma', 'Jane Austen'), { is_new: false }),
  Object.assign(audio(3, 'The Hobbit', 'J. R. R. Tolkien'), { is_new: true })];
const POPULAR = [Object.assign(audio(3, 'The Hobbit', 'J. R. R. Tolkien'), { listeners_label: '5+ listeners' }),
  Object.assign(both(1, 'Dune', 'Frank Herbert'), { listeners_label: '3+ listeners' })];
const shelves = (recent, popular) => usual({ recent: () => ({ body: { items: recent } }), popular: () => ({ body: { items: popular } }) });

await run('3c: Recently added and Popular on the server: two shelves under My list, above the library', async (make) => {
  const t = make({ routes: shelves(RECENT, POPULAR) });
  await t.mount();
  const recent = t.q('#recentHost [data-recent]');
  const popular = t.q('#popularHost [data-popular]');
  check('Recently added is a section with its heading', !!recent && recent.getAttribute('aria-label') === 'Recently added' && recent.querySelector('h2').textContent === 'Recently added');
  check('Popular on the server too', !!popular && popular.getAttribute('aria-label') === 'Popular on the server' && popular.querySelector('h2').textContent === 'Popular on the server');
  check('the cards in the order sent, each a link to its book', t.qa('#recentHost li > a').map((a) => a.getAttribute('href')).join() === '/books/1,/books/2,/books/3' &&
    t.qa('#popularHost li > a').map((a) => a.getAttribute('href')).join() === '/books/3,/books/1');
  check('library cards: a cover with its format badges, the title and the author', /The Hobbit/.test(t.q('#popularHost li > a').textContent) && /Tolkien/.test(t.q('#popularHost li > a').textContent) && !!t.q('#recentHost [data-format="audio"]'));
  check('in order: Continue, Recently added, Up next, My list, Popular, the search, then the toolbar', inOrder(t, '#continueHost', '#recentHost', '#upnextHost', '#mylistHost', '#popularHost', '#searchRow', '#toolbar'));
  check('both shown, and remembered for the next first paint', t.doc.documentElement.hasAttribute('data-books-recent') && t.doc.documentElement.hasAttribute('data-books-popular') &&
    t.win.localStorage.getItem('webservarr_books_recent:sam') === '1' && t.win.localStorage.getItem('webservarr_books_popular:sam') === '1');
  check('asked once each, on the visit\'s signal', t.net.urls('/api/books/recent').length === 1 && t.net.urls('/api/books/popular').length === 1 &&
    t.net.calls.filter((c) => /\/api\/books\/(recent|popular)/.test(c.url)).every((c) => c.init && c.init.signal === t.ctl.signal));
  check('no overflow at 320: the shelves scroll sideways inside the page gutter, as Continue does', t.qa('#recentHost ul.books-row.-mx-4.px-4, #popularHost ul.books-row.-mx-4.px-4').length === 2);
  check('each shelf is handed to the shell\'s drag-to-scroll', t.WS.drags.filter((d) => d.el.closest('#recentHost, #popularHost')).length === 2);
  check('each card keeps the library card\'s width', t.qa('#recentHost li, #popularHost li').every((li) => /\bw-36\b/.test(li.className) && /\bshrink-0\b/.test(li.className)));
});

await run('3c: New marks only the books the server says are new since the last visit', async (make) => {
  const t = make({ routes: shelves(RECENT, []) });
  await t.mount();
  const marked = t.qa('#recentHost [data-new]').map((m) => m.closest('a').getAttribute('href'));
  check('New on books 1 and 3, not 2', marked.join() === '/books/1,/books/3', marked);
  const mark = t.q('#recentHost [data-new]');
  check('it says New, in the accent, on the cover\'s top left', mark.textContent === 'New' && /\bbg-primary\b/.test(mark.className) && /\btext-bright\b/.test(mark.className) &&
    /\babsolute\b/.test(mark.className) && /\bleft-2\b/.test(mark.className) && /\btop-2\b/.test(mark.className) && !!mark.closest('.aspect-\\[2\\/3\\]'));
  check('and it is part of the link\'s words (a screen reader hears it)', mark.getAttribute('aria-hidden') === null && !mark.closest('[aria-hidden]') && mark.closest('a').textContent.indexOf('New') !== -1);
  check('the mark takes no room of its own: the card is the library card\'s shape', t.q('#recentHost li > a').children.length === t.cards('libraryGrid')[0].children.length);
  // A first visit (the server marks none), and anything but true, mark nothing.
  const odd = RECENT.map((c, i) => Object.assign({}, c, { is_new: [false, 'true', 1][i] }));
  const u = make({ routes: shelves(odd, []) });
  await u.mount();
  check('a first visit: no New anywhere', u.qa('[data-new]').length === 0 && !!u.q('#recentHost [data-recent]'));
});

await run('3c: a quick revisit keeps the marks: the kept copy and the live answer both draw them', async (make) => {
  const t = make({ routes: shelves(RECENT, []) });
  t.WS.cache.set('books:recent', { items: RECENT });
  const m = t.mount();
  await t.clock.advance(10);
  check('marked from the kept copy', t.qa('#recentHost [data-new]').length === 2);
  await t.clock.advance(1600);
  await m;
  check('still marked after the live answer', t.qa('#recentHost [data-new]').length === 2);
});

await run('3c: Popular says only the server\'s rounded label, never a count of its own', async (make) => {
  const t = make({ routes: shelves([], POPULAR) });
  await t.mount();
  const labels = t.qa('#popularHost [data-listeners]').map((m) => m.lastElementChild.textContent);
  check('each card carries its label', JSON.stringify(labels) === JSON.stringify(['5+ listeners', '3+ listeners']), labels);
  check('quiet, with a headphones mark, not the accent', !/\bbg-primary\b/.test(t.q('#popularHost [data-listeners]').className) && t.q('#popularHost [data-listeners] .material-symbols-outlined').textContent === 'headphones');
  check('no New on Popular', t.qa('#popularHost [data-new]').length === 0);
  const raw = POPULAR.map((c) => Object.assign({}, c, { listeners_label: undefined, listeners: 7 }));
  const u = make({ routes: shelves([], raw) });
  await u.mount();
  check('an answer without a label shows no number at all', u.qa('#popularHost [data-listeners]').length === 0 && !/7/.test(u.q('#popularHost').textContent));
});

await run('3c: empty shelves are hidden (Popular while nothing qualifies), a failure keeps the memory', async (make) => {
  const t = make({ storage: { 'webservarr_books_recent:sam': '1', 'webservarr_books_popular:sam': '1' }, routes: shelves([], []) });
  const m = t.mount();
  check('remembered shelves are held before the first await', t.doc.documentElement.hasAttribute('data-books-recent') && t.doc.documentElement.hasAttribute('data-books-popular'));
  await t.clock.advance(1600);
  await m;
  check('empty: released, nothing drawn', !t.doc.documentElement.hasAttribute('data-books-recent') && !t.doc.documentElement.hasAttribute('data-books-popular') && !t.q('#recentHost section') && !t.q('#popularHost section'));
  check('and remembered as none', t.win.localStorage.getItem('webservarr_books_recent:sam') === '0' && t.win.localStorage.getItem('webservarr_books_popular:sam') === '0');
  const u = make({ storage: { 'webservarr_books_popular:sam': '1' }, routes: usual({ recent: () => ({ status: 403, body: {} }), popular: () => ({ status: 503, body: {} }) }) });
  await u.mount();
  check('failed reads: no shelves, the library still shows', !u.q('#recentHost section') && !u.q('#popularHost section') && !u.hidden('#libraryGrid'));
  check('and a failure does not forget that they had one', u.win.localStorage.getItem('webservarr_books_popular:sam') === '1' && u.win.localStorage.getItem('webservarr_books_recent:sam') === null);
  check('no toast for a shelf that could not load', u.toasts.length === 0);
  const v = make({ routes: shelves(RECENT, POPULAR) });
  const leave = await v.mount();
  leave();
  check('leaving the page takes the flags off', !v.doc.documentElement.hasAttribute('data-books-recent') && !v.doc.documentElement.hasAttribute('data-books-popular'));
});

await run('3c: CLS: on a first visit the books wait for the shelves, and a remembered shelf lands in its held room', async (make) => {
  const hold = deferred();
  const known = { 'webservarr_books_continue:sam': '0', 'webservarr_books_upnext:sam': '0', 'webservarr_books_mylist:sam': '0' };
  const t = make({ storage: Object.assign({ 'webservarr_books_popular:sam': '0' }, known),
    routes: usual({ recent: () => hold.promise.then(() => ({ body: { items: RECENT } })) }) });
  const m = t.mount();
  await t.clock.advance(900);
  check('Recently added not answered yet (no memory of it): the books wait', t.hidden('#libraryGrid') && !t.hidden('#toolbarSkel'));
  hold.resolve();
  await t.clock.advance(50);
  await m;
  check('then the shelf and the books come together', !t.hidden('#libraryGrid') && !!t.q('#recentHost [data-recent]') && t.hidden('#toolbarSkel'));
  const lib = deferred();
  const u = make({ storage: Object.assign({ 'webservarr_books_recent:sam': '1', 'webservarr_books_popular:sam': '1' }, known),
    routes: (net) => { shelves(RECENT, POPULAR)(net); net.on('/api/books?', () => lib.promise); } });
  const m2 = u.mount();
  await u.clock.advance(100);
  check('the room is held by a skeleton, the shelves wait for the books', u.doc.documentElement.hasAttribute('data-books-recent') && u.doc.documentElement.hasAttribute('data-books-popular') &&
    !!u.q('#recentHost .skel') && !!u.q('#popularHost .skel') && !u.q('#recentHost [data-recent]'));
  lib.resolve({ body: { items: SHELF, next_cursor: null, notes: [], building: false } });
  await u.clock.advance(100);
  await m2;
  check('both land with the books, in the room held for them', !!u.q('#recentHost [data-recent]') && !!u.q('#popularHost [data-popular]') && !u.hidden('#libraryGrid') && !u.q('#recentHost .skel') && !u.q('#popularHost .skel'));
  const doc = new u.win.DOMParser().parseFromString(BOOKS_HTML, 'text/html');
  for (const id of ['recentHost', 'popularHost']) {
    const cards = Array.from(doc.querySelectorAll(`#${id} .books-row > div`));
    check(`${id}: the skeleton is a heading and the cards' own shape (w-36: a cover and two lines)`, !!doc.querySelector(`#${id} h2`) &&
      cards.length >= 6 && cards.every((d) => /\bw-36\b/.test(d.className) && d.children.length === 3) && /-mx-4 px-4/.test(doc.querySelector(`#${id} .books-row`).className));
  }
});

await run('3c: Your stats is one link at the end of the search row, named even where its words are hidden', async (make) => {
  const t = make({ routes: usual() });
  await t.mount();
  const a = t.q('#statsLink');
  check('a real link to /books/stats', !!a && a.tagName === 'A' && a.getAttribute('href') === '/books/stats');
  check('its words are there for everyone (screen reader only on a phone)', /Your stats/.test(a.textContent) && /\bsr-only\b/.test(a.lastElementChild.className) && /\bsm:not-sr-only\b/.test(a.lastElementChild.className));
  check('a 48px target with a focus ring', /\bh-12\b/.test(a.className) && /\bmin-w-12\b/.test(a.className) && /focus-visible:outline-2/.test(a.className));
  check('it does not shrink, and the search keeps the room', /\bshrink-0\b/.test(a.className) && /\bmin-w-0\b/.test(a.previousElementSibling.className));
});

await run('3c: shelves write titles as text, never markup', async (make) => {
  const nasty = '<img src=x onerror=alert(1)>';
  const t = make({ routes: shelves([Object.assign(ebook(9, nasty, nasty), { is_new: true })], [Object.assign(audio(8, nasty, nasty), { listeners_label: nasty })]) });
  await t.mount();
  check('as typed', t.q('#recentHost li > a').textContent.indexOf(nasty) !== -1 && t.q('#popularHost [data-listeners]').lastElementChild.textContent === nasty);
  check('no element made from it', !t.q('#wsPage [onerror]'));
});

// ---- Filters: Author, Series, Narrator (the toolbar's pickers) ----

const AUTHORS = { facet: 'author', values: [{ name: 'Charlotte Brontë', count: 1 }, { name: 'Frank Herbert', count: 3 },
  { name: 'Jane Austen', count: 2 }], notes: [] };

// The picker's surroundings: a phone or a wider screen, reduced motion (so a
// closed picker leaves at once), and WSUI.modal as ui.js has it (focus in, close runs onClose).
function pickerKit(t, o = {}) {
  const wide = o.wide !== false;
  t.win.matchMedia = (q) => ({ matches: /reduce/.test(q) ? true : wide, addEventListener() {}, removeEventListener() {} });
  const modal = { opened: 0, opts: null };
  t.win.WSUI.modal = (overlay, opts) => {
    modal.opened += 1;
    modal.opts = opts;
    (opts.initial || opts.box).focus();
    return { close() { opts.onClose(); } };
  };
  return modal;
}

function filterRoutes(over = {}) {
  return (net) => {
    usual(over)(net);
    net.on('/api/books/facets', over.facets || ((url) => ({ body: /facet=author/.test(url) ? AUTHORS
      : { facet: 'series', values: [{ name: 'Dune', count: 3 }], notes: [] } })));
  };
}

// The pickers' own asks for names.
const pickerAsks = (t) => t.net.urls('/api/books/facets');
const pickerBox = (t) => t.q('[role="combobox"]');
const options = (t) => t.qa('[role="listbox"] [role="option"]');
function pickerKey(t, key) {
  pickerBox(t).dispatchEvent(new t.win.KeyboardEvent('keydown', { key, bubbles: true }));
}
function pickerType(t, value) {
  const box = pickerBox(t);
  box.value = value;
  box.dispatchEvent(new t.win.Event('input', { bubbles: true }));
}

await run('filters: the address and the buttons round-trip (filtersFrom, filterHref)', async () => {
  const f = books.filtersFrom(new URL('https://ws.test/books?author=%20Frank%20%20Herbert%20&series=&x=1&narrator=' + 'n'.repeat(300)));
  check('a name has its spacing collapsed', f.author === 'Frank Herbert', f);
  check('an empty one is no filter', f.series === '');
  check('a long one is cut to what the server takes', f.narrator.length === 200);
  check('the address keeps any other part of the query',
    books.filterHref({ author: 'A B', series: '', narrator: 'N' }, '/books?ws-debug=leaks&author=old') === '/books?ws-debug=leaks&author=A+B&narrator=N',
    books.filterHref({ author: 'A B', series: '', narrator: 'N' }, '/books?ws-debug=leaks&author=old'));
  check('no filters is the plain address', books.filterHref({ author: '', series: '', narrator: '' }, '/books?author=x') === '/books');
  check('and back again', JSON.stringify(books.filtersFrom(new URL('https://ws.test' + books.filterHref({ author: 'Brontë & Co / 100%', series: 'Dune', narrator: '' }))))
    === JSON.stringify({ author: 'Brontë & Co / 100%', series: 'Dune', narrator: '' }));
});

await run('filters: three closed buttons after the format chips; no filter changes nothing that was asked', async (make) => {
  const t = make({ routes: filterRoutes() });
  await t.mount();
  const buttons = t.qa('#filterButtons [data-filter]');
  check('Author, Series and Narrator', buttons.map((b) => b.textContent.replace('expand_more', '')).join('|') === 'Author|Series|Narrator',
    buttons.map((b) => b.textContent));
  check('each says it opens a picker and is closed', buttons.every((b) => b.getAttribute('aria-haspopup') === 'dialog' && b.getAttribute('aria-expanded') === 'false'));
  check('none is filled', buttons.every((b) => !/bg-primary/.test(b.className)));
  check('they sit in the toolbar after the format chips', t.q('#toolbar').children[1] === t.q('#filterButtons'));
  check('no row of filters in use', t.hidden('#activeFilters') && t.qa('#activeFilters button').length === 0);
  check('the library is asked for as before', t.net.urls('/api/books?')[0] === '/api/books?format=all&sort=added&limit=36');
  check('no names are asked for until a picker is opened', pickerAsks(t).length === 0);
  check('the skeleton holds no row for filters', !t.doc.documentElement.hasAttribute('data-books-filtered'));
});

await run('filters: an address with filters: the books, the buttons, the pills and their room', async (make) => {
  const slow = deferred();
  const t = make({ url: 'https://ws.test/books?author=Frank%20Herbert&series=Dune', routes: (net) => {
    filterRoutes()(net);
    net.on('/api/books?', () => slow.promise.then(() => ({ body: { items: [ebook(1, 'Dune', 'Frank Herbert')], next_cursor: null, notes: [] } })));
  } });
  const mounted = t.mount();
  await flush();
  check('before the books, the skeleton holds the pills\' row', t.doc.documentElement.hasAttribute('data-books-filtered'));
  slow.resolve();
  await t.clock.advance(1600);
  await mounted;
  check('the books are asked for with both', t.net.urls('/api/books?')[0] === '/api/books?format=all&sort=added&limit=36&author=Frank%20Herbert&series=Dune',
    t.net.urls('/api/books?'));
  const author = t.q('[data-filter="author"]');
  check('the buttons in use are filled and say what they hold', /bg-primary/.test(author.className) && author.getAttribute('aria-label') === 'Author, Frank Herbert'
    && /bg-primary/.test(t.q('[data-filter="series"]').className) && !/bg-primary/.test(t.q('[data-filter="narrator"]').className));
  check('the pills: one per filter, and Clear all', !t.hidden('#activeFilters') && t.qa('#activeFilters [data-remove]').length === 2 && t.qa('#activeFilters [data-clear-filters]').length === 1);
  const pill = t.q('#activeFilters [data-remove="author"]');
  check('each pill is named by its words, then what a press does', !pill.hasAttribute('aria-label')
    && pill.textContent.replace('close', '') === 'Author Frank Herbert, remove filter', pill.textContent);
  check('a filtered list is kept apart from the whole one', t.WS.cache.has('books:list:all:added:Frank%20Herbert|Dune|') && !t.WS.cache.has('books:list:all:added'),
    Array.from(t.WS.cache.keys()));
});

await run('filters: a picker lists the names with counts, finds by typing, picks with the keyboard', async (make) => {
  const t = make({ routes: filterRoutes() });
  const kit = pickerKit(t);
  await t.mount();
  const btn = t.q('[data-filter="author"]');
  btn.click();
  check('the button says it is open', btn.getAttribute('aria-expanded') === 'true');
  check('it is a dialog on the shared stack, the search box first', kit.opened === 1 && t.doc.activeElement === pickerBox(t));
  await t.clock.advance(50);
  check('the names are asked for in this format', pickerAsks(t)[0] === '/api/books/facets?facet=author&format=all', pickerAsks(t));
  const opts = options(t);
  check('"All authors" first, then each name with its count', opts.map((o) => o.textContent.replace('check', '')).join('|') === 'All authors|Charlotte Brontë1|Frank Herbert3|Jane Austen2',
    opts.map((o) => o.textContent));
  check('All authors is the pick in use, and highlighted', opts[0].getAttribute('aria-selected') === 'true' && pickerBox(t).getAttribute('aria-activedescendant') === opts[0].id);
  check('a name is read with its count', opts[2].getAttribute('aria-label') === 'Frank Herbert, 3 books' && opts[1].getAttribute('aria-label') === 'Charlotte Brontë, 1 book');
  check('the box drives the list', pickerBox(t).getAttribute('aria-controls') === t.q('[role="listbox"]').id && pickerBox(t).getAttribute('aria-expanded') === 'true');
  pickerType(t, 'BRONTE');
  check('typing narrows it, ignoring case and accents, and "All" steps aside', options(t).length === 1 && /Charlotte Brontë/.test(options(t)[0].textContent));
  pickerType(t, 'zz');
  check('nothing matching says so', options(t).length === 0 && /No authors match “zz”/.test(t.q('[role="listbox"]').parentNode.textContent));
  pickerType(t, '');
  pickerKey(t, 'ArrowDown');
  pickerKey(t, 'ArrowDown');
  check('the arrows move the highlight', pickerBox(t).getAttribute('aria-activedescendant') === options(t)[2].id);
  pickerKey(t, 'ArrowUp');
  pickerKey(t, 'Enter');
  await t.clock.advance(50);
  check('Enter picks it and the picker goes', !t.q('[role="listbox"]') && btn.getAttribute('aria-expanded') === 'false');
  check('the books are asked for by that author', t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36&author=Charlotte%20Bront%C3%AB',
    t.net.urls('/api/books?'));
  check('the address carries it', t.win.location.search === '?author=Charlotte+Bront%C3%AB', t.win.location.href);
  check('the button fills and the pill shows', /bg-primary/.test(btn.className) && t.qa('#activeFilters [data-remove="author"]').length === 1);
  check('a screen reader hears it', /filtered by author: Charlotte Brontë/.test(t.text('#booksSaid')));

  // Opened again: the pick in use is marked, and a click on "All authors" drops it.
  btn.click();
  await t.clock.advance(50);
  const again = options(t);
  check('the pick in use is marked', again[1].getAttribute('aria-selected') === 'true' && again[0].getAttribute('aria-selected') === 'false');
  again[0].click();
  await t.clock.advance(50);
  check('All authors drops the filter', t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36' && t.hidden('#activeFilters'));
});

await run('filters: a picker asks with the format and the other filters, never its own', async (make) => {
  const t = make({ url: 'https://ws.test/books?author=Frank%20Herbert&series=Dune', storage: { 'webservarr_books_view:sam': '{"format":"ebook","sort":"added"}' },
    routes: filterRoutes() });
  pickerKit(t);
  await t.mount();
  t.click('[data-filter="author"]');
  await t.clock.advance(50);
  check('author: the format and the series', pickerAsks(t).pop() === '/api/books/facets?facet=author&format=ebook&series=Dune', pickerAsks(t));
  check('the author in use starts highlighted', pickerBox(t).getAttribute('aria-activedescendant') === options(t).find((o) => o.getAttribute('aria-selected') === 'true').id);
});

await run('filters: removing a pill moves the focus on; Clear all clears every filter', async (make) => {
  const t = make({ url: 'https://ws.test/books?author=Frank%20Herbert&series=Dune&narrator=Simon%20Vance', routes: filterRoutes() });
  await t.mount();
  const author = t.q('#activeFilters [data-remove="author"]');
  author.focus();
  author.click();
  await t.clock.advance(50);
  check('the author filter goes', t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36&series=Dune&narrator=Simon%20Vance');
  check('the address follows', t.win.location.search === '?series=Dune&narrator=Simon+Vance', t.win.location.search);
  check('the focus goes to the next pill', t.doc.activeElement === t.q('#activeFilters [data-remove="series"]'));
  t.q('#activeFilters [data-remove="narrator"]').click();
  await t.clock.advance(50);
  check('the last pill hands the focus to the one before', t.doc.activeElement === t.q('#activeFilters [data-remove="series"]'));
  t.q('#activeFilters [data-remove="series"]').click();
  await t.clock.advance(50);
  check('with none left, the focus goes to its button and the row goes', t.doc.activeElement === t.q('[data-filter="series"]') && t.hidden('#activeFilters'));
  check('the address is plain again', t.win.location.search === '');
  check('and the skeleton no longer holds the pills\' row', !t.doc.documentElement.hasAttribute('data-books-filtered'));

  const u = make({ url: 'https://ws.test/books?author=Frank%20Herbert&series=Dune', routes: filterRoutes() });
  await u.mount();
  u.click('#activeFilters [data-clear-filters]');
  await u.clock.advance(50);
  check('Clear all asks for every book', u.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36');
  check('and puts the focus on the first filter button', u.doc.activeElement === u.q('[data-filter="author"]'));
  check('a screen reader hears it', u.text('#booksSaid') === 'Filters cleared');
});

await run('filters: nothing matching is one quiet line with Clear, not the empty library', async (make) => {
  const t = make({ url: 'https://ws.test/books?narrator=Nobody', routes: filterRoutes({ library: (url) => ({ body: { items: /narrator=/.test(url) ? [] : SHELF, next_cursor: null, notes: [] } }) }) });
  await t.mount();
  check('the line shows', !t.hidden('#filterEmpty') && /No books match these filters/.test(t.text('#filterEmpty')));
  check('the library\'s own empty state does not', t.hidden('#emptyState') && t.hidden('#libraryGrid'));
  t.click('#filterEmptyClear');
  await t.clock.advance(50);
  check('Clear shows every book again', t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36' && !t.hidden('#libraryGrid') && t.hidden('#filterEmpty'));
  check('and the focus lands on the first filter button', t.doc.activeElement === t.q('[data-filter="author"]'));
});

await run('filters: a search is narrowed by them and shows them', async (make) => {
  const t = make({ url: 'https://ws.test/books?author=Jane%20Austen', routes: filterRoutes({ search: { items: [], request_url: '/requests?q=dune', notes: [] } }) });
  await t.mount();
  t.type('dune');
  await t.clock.advance(400);
  check('the search carries the filter', t.net.urls('/api/books/search').pop() === '/api/books/search?q=dune&limit=60&author=Jane%20Austen', t.net.urls('/api/books/search'));
  check('the pills show above the results', !t.hidden('#searchFilters') && t.qa('#searchFilters [data-remove="author"]').length === 1);
  check('no match says the filters may be why', /with these filters/.test(t.text('#searchEmptyTitle')));
  check('and offers Clear filters, not a request', !t.hidden('#searchClear') && t.hidden('#searchRequest'));
  t.click('#searchClear');
  await t.clock.advance(50);
  check('Clear runs the search again on the whole library', t.net.urls('/api/books/search').pop() === '/api/books/search?q=dune&limit=60');
  check('the request link comes back for a search with no filters', !t.hidden('#searchRequest') && t.hidden('#searchClear') && t.hidden('#searchFilters'));
});

await run('filters: the router claims our own change and Back or Forward, nothing else', async (make) => {
  const t = make({ routes: filterRoutes() });
  pickerKit(t);
  let claim = null;
  let claims = null;
  t.ctx.onNavigate = (fn, which) => { claim = fn; claims = which; };
  const asked = [];
  t.WS.router.navigate = (u, o) => { asked.push([u, o]); return claim(new URL(u, 'https://ws.test'), { pop: false }) ? Promise.resolve() : Promise.reject(new Error('not claimed')); };
  await t.mount();
  check('the page claims addresses', typeof claim === 'function' && typeof claims === 'function');
  check('and none for the prefetch (links still warm)', claims(new URL('https://ws.test/books?author=x')) === false);
  t.click('[data-filter="series"]');
  await t.clock.advance(50);
  options(t)[1].click();
  await t.clock.advance(50);
  const fetched = t.net.urls('/api/books?').length;
  check('a pick asks the router to replace the address', asked.length === 1 && asked[0][0] === '/books?series=Dune' && asked[0][1].replace === true, asked);
  check('which it claims without asking for the books twice', t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36&series=Dune' && fetched === 2, t.net.urls('/api/books?'));
  check('Back to another Books address is drawn here', claim(new URL('https://ws.test/books?narrator=Rob%20Inglis'), { pop: true }) === true);
  await t.clock.advance(50);
  check('with that address\'s filters', t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36&narrator=Rob%20Inglis'
    && /bg-primary/.test(t.q('[data-filter="narrator"]').className) && !/bg-primary/.test(t.q('[data-filter="series"]').className));
  check('the sidebar\'s Books is a fresh visit, as before', claim(new URL('https://ws.test/books'), { pop: false }) === false);
  check('a book page is not this page\'s', claim(new URL('https://ws.test/books/12'), { pop: true }) === false);
});

await run('filters: on a phone the picker is a bottom sheet; wider, a popover under its button', async (make) => {
  const t = make({ routes: filterRoutes() });
  pickerKit(t, { wide: false });
  await t.mount();
  t.click('[data-filter="author"]');
  await t.clock.advance(50);
  const sheet = t.doc.body.querySelector('.ws-sheet');
  check('a sheet with the More sheet\'s pieces', !!sheet && sheet.classList.contains('is-open') && !!sheet.querySelector('.ws-sheet-panel .ws-sheet-grip') && !!sheet.querySelector('.ws-sheet-close'));
  check('titled by its heading', sheet.querySelector('.ws-sheet-panel').getAttribute('aria-labelledby') === sheet.querySelector('h2').id && sheet.querySelector('h2').textContent === 'Author');
  check('the keyboard waits for a tap in the search', t.doc.activeElement === sheet.querySelector('.ws-sheet-panel'));
  check('the sheet is on the shared frosted surface', sheet.querySelector('.ws-sheet-panel').classList.contains('ws-frost'));
  sheet.querySelector('.ws-sheet-scrim').click();
  check('a tap on the dim closes it', !t.doc.body.querySelector('.ws-sheet') && t.q('[data-filter="author"]').getAttribute('aria-expanded') === 'false');

  const u = make({ routes: filterRoutes() });
  pickerKit(u, { wide: true });
  await u.mount();
  u.click('[data-filter="author"]');
  const pop = u.doc.body.querySelector('[data-pop-layer] > .ws-pop');
  check('a popover placed by the button', !!pop && /px$/.test(pop.style.top || pop.style.bottom) && /px$/.test(pop.style.left));
  check('it opens as every popover does (.ws-pop drawn closed, then .is-open)', pop.classList.contains('is-open') && !pop.classList.contains('ws-dialog-box'));
  check('on the shared frosted surface, no variant', pop.classList.contains('ws-frost') && !pop.classList.contains('ws-frost-read') && !pop.classList.contains('bg-background-dark'));
  u.doc.body.querySelector('[aria-label="Close"]').click();
  await u.clock.advance(200);
  check('Close closes it', !u.doc.body.querySelector('[data-pop-layer]'));
});

await run('filters: the picker while its list loads, when it fails, and Try again', async (make) => {
  let fail = true;
  const slow = deferred();
  const t = make({ routes: filterRoutes({ facets: () => slow.promise.then(() => (fail ? { status: 503, body: {} } : { body: AUTHORS })) }) });
  pickerKit(t);
  await t.mount();
  t.click('[data-filter="author"]');
  await flush();
  check('a skeleton list while it loads', t.q('[role="listbox"]').getAttribute('aria-busy') === 'true' && t.qa('[role="listbox"] .skel').length === 5);
  slow.resolve();
  await t.clock.advance(50);
  check('a failure says so with Try again', /didn’t load/.test(t.q('[role="listbox"]').textContent) && !!t.q('[role="listbox"] button'));
  fail = false;
  t.q('[role="listbox"] button').click();
  await t.clock.advance(50);
  check('Try again asks again and shows the names', options(t).length === 4 && pickerAsks(t).length === 2);
  check('and the focus is back in the search', t.doc.activeElement === pickerBox(t));
});

await run('filters: an empty list says so; names are text, never markup', async (make) => {
  const t = make({ url: 'https://ws.test/books?series=%3Cimg%20src%3Dx%3E', routes: filterRoutes({ facets: (url) => ({ body: /narrator/.test(url) ? { values: [] }
    : { values: [{ name: '<b>Bold</b><img src=x onerror=alert(1)>', count: 2 }] } }) }) });
  pickerKit(t);
  await t.mount();
  t.click('[data-filter="narrator"]');
  await t.clock.advance(50);
  check('nothing to choose says so', options(t).length === 1 && /No narrators in the books shown/.test(t.q('[role="listbox"]').parentNode.textContent));
  t.q('[aria-label="Close"]').click();
  t.click('[data-filter="author"]');
  await t.clock.advance(50);
  check('a name is drawn as text', /<b>Bold<\/b>/.test(options(t)[1].textContent) && !t.doc.querySelector('[role="listbox"] img, [role="listbox"] b'));
  check('the pill too', /<img src=x>/.test(t.text('#activeFilters [data-remove="series"]')) && !t.doc.querySelector('#activeFilters img'));
});

await run('filters: leaving the page takes an open picker with it', async (make) => {
  const t = make({ routes: filterRoutes() });
  pickerKit(t);
  await t.mount();
  t.click('[data-filter="author"]');
  await t.clock.advance(50);
  check('it is open', !!t.q('[role="listbox"]'));
  t.ctl.abort();
  check('and gone with the page', !t.q('[role="listbox"]') && !t.doc.body.querySelector('[data-pop-layer]'));
});

await run('Group series: a switch beside the sort; off lists every book with its series and number, and is remembered', async (make) => {
  const FLAT = [ebook(1, 'Dune', 'Frank Herbert', { series: 'Dune', series_number: 1 }),
    ebook(2, 'Dune Messiah', 'Frank Herbert', { series: 'The Very Long Name of a Collected Saga Edition', series_number: 12.5 }),
    ebook(4, 'Emma', 'Jane Austen', { series: '', series_number: null })];
  const routes = (net) => {
    usual()(net);
    net.on('/api/books?format=all&sort=added&limit=36&group=false', () => ({ body: { items: FLAT, next_cursor: null, notes: [] } }));
  };
  const t = make({ routes });
  await t.mount();
  const sw = t.q('#groupSwitch');
  check('a switch, labelled by its own words, on, just before the sort', sw.getAttribute('role') === 'switch' && sw.textContent.trim() === 'Group series'
    && sw.getAttribute('aria-checked') === 'true' && sw.nextElementSibling.id === 'sortLabel');
  check('the format chips are still in the toolbar', t.qa('#formatChips [data-format]').length === 3 && t.qa('#filterButtons [data-filter]').length === 3);
  check('grouped to begin with: two lines a card', !t.q('#libraryGrid [data-series-line]') && t.qa('#libraryGrid a').some((a) => /Harry Potter/.test(a.textContent)));
  t.click('#groupSwitch');
  check('the switch says off at once', sw.getAttribute('aria-checked') === 'false');
  check('the skeleton holds the third line', t.doc.documentElement.hasAttribute('data-books-flat') && !t.hidden('#gridSkeleton'));
  await t.clock.advance(50);
  check('the books are asked for one by one', t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36&group=false', t.net.urls('/api/books?'));
  const lines = t.qa('#libraryGrid [data-series-line]');
  check('every card has the line', lines.length === 3);
  check('the series and its number', lines[0].children[0].textContent === 'Dune' && lines[0].children[1].textContent === '#1' && lines[1].children[1].textContent === '#12.5');
  check('the name gives way, the number never does', /truncate/.test(lines[1].children[0].className) && /shrink-0/.test(lines[1].children[1].className) && !/truncate/.test(lines[1].children[1].className));
  check('a book in no series keeps the room, empty', lines[2].children.length === 0 && /min-h-5/.test(lines[2].className));
  check('remembered for this person', JSON.parse(t.win.localStorage.getItem('webservarr_books_view:sam')).group === false);
  check('kept apart from the grouped list', t.WS.cache.has('books:list:all:added:flat'));

  const u = make({ storage: { 'webservarr_books_view:sam': '{"format":"all","sort":"added","group":false}' }, routes });
  await u.mount();
  check('the next visit asks for it at once, the switch off', u.net.urls('/api/books?')[0] === '/api/books?format=all&sort=added&limit=36&group=false' && u.q('#groupSwitch').getAttribute('aria-checked') === 'false');
  u.click('#groupSwitch');
  await u.clock.advance(50);
  check('on again: the series are one card each, the line and its room go', u.net.urls('/api/books?').pop() === '/api/books?format=all&sort=added&limit=36'
    && !u.doc.documentElement.hasAttribute('data-books-flat') && !u.q('#libraryGrid [data-series-line]'));
  check('and that is remembered too', JSON.parse(u.win.localStorage.getItem('webservarr_books_view:sam')).group === true);
  u.ctl.abort();
  check('leaving the page drops the flag', !u.doc.documentElement.hasAttribute('data-books-flat'));
});

// ---- The sort menu ----

function sortKey(t, key) {
  const target = t.doc.activeElement || t.q('#booksSortList');
  target.dispatchEvent(new t.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

await run('sort: a button that opens a listbox of the orders, with the one in use checked', async (make) => {
  const t = make({ routes: usual() });
  const kit = pickerKit(t);
  await t.mount();
  const btn = t.q('#sortBtn');
  check('a button, not a native select', btn.tagName === 'BUTTON' && btn.getAttribute('type') === 'button' && !t.q('#toolbar select'));
  check('it says it opens a listbox, and is closed', btn.getAttribute('aria-haspopup') === 'listbox' && btn.getAttribute('aria-expanded') === 'false');
  check('named Sort by and the order in use', btn.getAttribute('aria-labelledby') === 'sortLabel sortValue' && t.text('#sortLabel') === 'Sort by' && t.text('#sortValue') === 'Recently added');
  btn.click();
  const list = t.q('#booksSortList');
  check('open: the list, on the shared stack, takes the focus', !!list && list.getAttribute('role') === 'listbox' && kit.opened === 1 && t.doc.activeElement === list);
  check('the button points at it', btn.getAttribute('aria-expanded') === 'true' && btn.getAttribute('aria-controls') === 'booksSortList');
  check('the popover is the list itself, not a dialog around it', !list.parentNode.hasAttribute('role') && !list.parentNode.hasAttribute('aria-modal'));
  check('on the shared frosted surface, opening as every popover does', list.parentNode.classList.contains('ws-frost') &&
    list.parentNode.classList.contains('ws-pop') && list.parentNode.classList.contains('is-open'));
  const opts = sortOptions(t);
  check('the order in use is selected and highlighted', opts[0].getAttribute('aria-selected') === 'true' && list.getAttribute('aria-activedescendant') === opts[0].id &&
    !opts[0].querySelector('.invisible') && !!opts[1].querySelector('.invisible'));
  sortKey(t, 'ArrowDown');
  sortKey(t, 'ArrowDown');
  sortKey(t, 'ArrowDown');
  check('the arrows move the highlight and stop at the end', list.getAttribute('aria-activedescendant') === opts[2].id);
  sortKey(t, 'Home');
  check('Home goes to the first', list.getAttribute('aria-activedescendant') === opts[0].id);
  sortKey(t, 't');
  check('a letter jumps to the order it starts', list.getAttribute('aria-activedescendant') === opts[1].id);
  sortKey(t, 'Enter');
  await t.clock.advance(50);
  check('Enter picks it and the list goes', !t.q('#booksSortList') && btn.getAttribute('aria-expanded') === 'false' && !btn.hasAttribute('aria-controls'));
  check('the button says it', t.text('#sortValue') === 'Title');
  check('the books are asked for in that order', t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=title&limit=36');
  check('and it is remembered', t.win.localStorage.getItem('webservarr_books_view:sam') === '{"format":"all","sort":"title","group":true}');

  btn.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  check('the arrow keys open it from the button too, on the order in use', !!t.q('#booksSortList') && t.q('#booksSortList').getAttribute('aria-activedescendant') === sortOptions(t)[1].id &&
    sortOptions(t)[1].getAttribute('aria-selected') === 'true');
  const asked = t.net.urls('/api/books?').length;
  sortKey(t, ' ');
  check('Space on the order in use closes it and asks for nothing', !t.q('#booksSortList') && t.net.urls('/api/books?').length === asked);
  btn.click();
  sortKey(t, 'Tab');
  check('Tab closes it', !t.q('#booksSortList'));
  btn.click();
  t.doc.body.querySelector('[data-pop-layer]').click();
  check('a click outside closes it', !t.q('#booksSortList'));
});

await run('sort: Escape closes it and the focus goes back to the button (no shared stack)', async (make) => {
  const t = make({ routes: usual() });
  t.win.matchMedia = (q) => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  await t.mount();
  t.click('#sortBtn');
  check('open', !!t.q('#booksSortList') && t.doc.activeElement === t.q('#booksSortList'));
  sortKey(t, 'Escape');
  check('Escape closes it', !t.q('#booksSortList'));
  check('and the focus is back on the button', t.doc.activeElement === t.q('#sortBtn'));
});

await run('sort: on a phone the list is a bottom sheet titled Sort by; leaving the page takes it', async (make) => {
  const t = make({ routes: usual() });
  pickerKit(t, { wide: false });
  await t.mount();
  t.click('#sortBtn');
  const sheet = t.doc.body.querySelector('.ws-sheet');
  check('a sheet with the filter pickers\' pieces', !!sheet && sheet.classList.contains('is-open') && !!sheet.querySelector('.ws-sheet-grip') && !!sheet.querySelector('.ws-sheet-close'));
  check('titled Sort by', sheet.querySelector('.ws-sheet-panel').getAttribute('aria-labelledby') === sheet.querySelector('h2').id && sheet.querySelector('h2').textContent === 'Sort by');
  check('with the list in it, focused', !!sheet.querySelector('#booksSortList') && t.doc.activeElement === sheet.querySelector('#booksSortList'));
  sortOptions(t)[2].click();
  await t.clock.advance(50);
  check('a tap picks an order and closes it', !t.doc.body.querySelector('.ws-sheet') && t.text('#sortValue') === 'Author' &&
    t.net.urls('/api/books?').pop() === '/api/books?format=all&sort=author&limit=36');
  t.click('#sortBtn');
  t.doc.body.querySelector('.ws-sheet-close').click();
  check('Close closes it', !t.doc.body.querySelector('.ws-sheet'));
  t.click('#sortBtn');
  t.ctl.abort();
  check('and it goes with the page', !t.doc.body.querySelector('.ws-sheet'));
});

await run('sort: opening a filter picker closes the sort, and the sort closes a picker', async (make) => {
  const t = make({ routes: filterRoutes() });
  pickerKit(t);
  await t.mount();
  t.click('#sortBtn');
  t.click('[data-filter="author"]');
  check('one at a time', !t.q('#booksSortList') && !!pickerBox(t));
  t.click('#sortBtn');
  check('and the other way round', !!t.q('#booksSortList') && !pickerBox(t));
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
  t.click('#sortBtn');
  check('the sort no longer opens', !t.q('#booksSortList'));
  t.type('dune');
  await t.clock.advance(500);
  check('nothing is asked for after leaving', t.net.calls.length === before, t.net.calls.length - before);
  check('every request carried the visit\'s signal', t.net.calls.every((c) => c.init && c.init.signal === t.ctl.signal));
});

// ---- Task 5: the first-visit guide (tour.js, the reader's engine) ----

const TOUR_SRC = readFileSync(join(STATIC, 'js/tour.js'), 'utf8');

// The real engine, loaded into the visit's window as the router's page helper is.
function withTour(t) {
  new Function('window', 'document', 'localStorage', 'location', TOUR_SRC)(t.win, t.doc, t.win.localStorage, t.win.location);
  return t;
}

const GUIDE_FLAG = 'webservarr_books_guide_seen:sam';
const tourTitle = (t) => t.doc.getElementById('tourTitle').textContent;
const tourOn = (t) => !!t.doc.getElementById('tourLayer') && !t.doc.getElementById('tourLayer').classList.contains('hidden');

await run('the guide: a first visit shows it once the books are on screen, and never blocks them', async (make) => {
  const t = withTour(make({ routes: usual({ continue: { items: CONT, notes: [] } }) }));
  const mounted = t.mount();
  await t.clock.advance(400);
  check('the books are drawn and the guide waits a moment for the covers', !t.hidden('#libraryGrid') && !tourOn(t));
  check('the help button is there, named', t.q('#helpBtn').getAttribute('aria-label') === 'How Books works' && t.q('#helpBtn').getAttribute('type') === 'button');
  await t.clock.advance(1000);
  await mounted;
  check('then it starts', tourOn(t) && tourTitle(t) === 'Find a book', tourOn(t) && tourTitle(t));
  check('it is marked seen as soon as it is shown, for this person', t.win.localStorage.getItem(GUIDE_FLAG) === '1');
  check('the page under it is the page: nothing was held back or hidden', !t.hidden('#libraryGrid') && t.cards('libraryGrid').length === 5 && !t.hidden('#toolbar'));
  const spot = t.doc.getElementById('tourSpotlight');
  check('it lays nothing out: the spotlight is fixed and ignores the pointer', /\.tour-spotlight\s*\{[^}]*position: fixed;[^}]*pointer-events: none;/.test(readFileSync(join(STATIC, 'css/theme.css'), 'utf8')) && !!spot);
});

await run('the guide: four short steps, in the order a person meets them, each on something real', async (make) => {
  const t = withTour(make({ routes: usual({ continue: { items: CONT, notes: [] } }) }));
  const mounted = t.mount();
  await t.clock.advance(2600);
  await mounted;
  const titles = [];
  const asked = [];
  for (let i = 0; i < 4; i++) {
    titles.push(tourTitle(t));
    asked.push(t.doc.getElementById('tourBody').textContent);
    t.doc.getElementById('tourNext').click();
    await t.clock.advance(10);
  }
  check('search, Continue, the chips, then opening a book', titles.join('|') === 'Find a book|Pick up where you left off|Ebooks, audiobooks or both|Open a book', titles);
  check('the last step is where Read and Listen are named', /Read opens the ebook/.test(asked[3]) && /Listen plays the audiobook/.test(asked[3]), asked[3]);
  check('the search step says the page can ask for a missing book', /ask for it/.test(asked[0]));
  check('the last button finishes it', !tourOn(t));
  // Every step points at something on the page (the Continue one only when there is a row).
  for (const sel of ['#booksSearch', '#continueHost [data-continue]', '#formatChips', '#libraryGrid > li:first-child']) {
    check('step target ' + sel + ' is on the page', !!t.q(sel), sel);
  }
});

await run('the guide: Skip and Escape end it, and it stays seen', async (make) => {
  const t = withTour(make({ routes: usual() }));
  const mounted = t.mount();
  await t.clock.advance(2600);
  await mounted;
  check('running', tourOn(t));
  t.doc.getElementById('tourSkip').click();
  check('Skip ends it', !tourOn(t));
  t.help = t.q('#helpBtn');
  t.help.click();
  check('the help button runs it again', tourOn(t) && tourTitle(t) === 'Find a book');
  t.doc.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape ends it', !tourOn(t));
  check('and it is still marked seen once', t.win.localStorage.getItem(GUIDE_FLAG) === '1');
});

await run('the guide: a person who has had it is not shown it again, and a different person is', async (make) => {
  const t = withTour(make({ storage: { [GUIDE_FLAG]: '1' }, routes: usual() }));
  const mounted = t.mount();
  await t.clock.advance(2600);
  await mounted;
  check('seen: it does not start', !tourOn(t));
  t.q('#helpBtn').click();
  check('but the help button still runs it', tourOn(t));
  t.ctl.abort();
  const other = withTour(make({ storage: { [GUIDE_FLAG]: '1' }, routes: usual() }));
  other.WS.data = { user: { username: 'kim' } };
  other.ctx.data = other.WS.data;
  const m = other.mount();
  await other.clock.advance(2600);
  await m;
  check('the memory is per person: another person on this browser gets it', tourOn(other) && other.win.localStorage.getItem('webservarr_books_guide_seen:kim') === '1');
});

await run('the guide: leaving the page mid-way ends it, and it is not shown again next time', async (make) => {
  const t = withTour(make({ routes: usual() }));
  const mounted = t.mount();
  await t.clock.advance(2600);
  await mounted;
  check('running, and already marked', tourOn(t) && t.win.localStorage.getItem(GUIDE_FLAG) === '1');
  t.ctl.abort();
  check('the layer leaves the page with the visit', !t.doc.getElementById('tourLayer'));
  const again = withTour(make({ storage: { [GUIDE_FLAG]: '1' }, routes: usual() }));
  const m = again.mount();
  await again.clock.advance(2600);
  await m;
  check('the next visit does not start it', !tourOn(again));
});

await run('the guide: never over a page that could not load, a search or a failed sign-in', async (make) => {
  const failed = withTour(make({ routes: (net) => { usual()(net); net.on('/api/books?', () => ({ status: 503, body: {} })); } }));
  let m = failed.mount();
  await failed.clock.advance(2600);
  await m;
  check('an error page is not toured', !tourOn(failed) && failed.win.localStorage.getItem(GUIDE_FLAG) === null);
  const empty = withTour(make({ routes: usual({ library: () => ({ body: { items: [], next_cursor: null, notes: [], building: false } }) }) }));
  m = empty.mount();
  await empty.clock.advance(2600);
  await m;
  check('an empty library is not toured', !tourOn(empty));
  const building = withTour(make({ routes: usual({ library: () => ({ body: { items: [], next_cursor: null, notes: [], building: true } }) }) }));
  m = building.mount();
  await building.clock.advance(2600);
  await m;
  check('a library still being built is not toured', !tourOn(building));
  const searching = withTour(make({ routes: usual() }));
  m = searching.mount();
  await searching.clock.advance(400);
  searching.type('dune');
  await searching.clock.advance(400);
  await searching.clock.advance(2000);
  await m;
  check('a visit that has gone to a search is not toured', !tourOn(searching));
  const connect = withTour(make({ routes: usual({ continue: { items: [], notes: NOT_CONNECTED }, library: () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED } }) }) }));
  connect.kav.blockNext = true;
  m = connect.mount();
  await connect.clock.advance(2600);
  await m;
  check('a failed sign-in message is not toured over', !tourOn(connect));
});

await run('the guide: with nothing in progress the Continue step still points at the section', async (make) => {
  const t = withTour(make({ routes: usual() }));
  const mounted = t.mount();
  await t.clock.advance(2600);
  await mounted;
  const sec = t.q('#continueHost [data-continue]');
  check('Continue is there, empty', !!sec && /Books you start will show up here/.test(sec.textContent) && !sec.querySelector('li'));
  // A box with a size, so the step has something to point at (the test window lays nothing out).
  sec.getBoundingClientRect = () => ({ left: 0, top: 200, right: 600, bottom: 260, width: 600, height: 60, x: 0, y: 200 });
  sec.scrollIntoView = () => {};
  t.doc.getElementById('tourNext').click();
  await new Promise((r) => setTimeout(r, 450));   // the engine places the bubble after the scroll settles (a real timer)
  check('step two is the Continue step', tourTitle(t) === 'Pick up where you left off');
  check('so the spotlight is on the section, not the middle of the page', !t.doc.getElementById('tourSpotlight').classList.contains('tour-spotlight-empty'));
});

await run('the guide: reduced motion jumps to each step instead of gliding', async (make) => {
  const t = withTour(make({ routes: usual({ continue: { items: CONT, notes: [] } }) }));
  const behaviours = [];
  const search = t.q('#booksSearch');
  // A box with a size, so the step has something to scroll to (the test window lays nothing out).
  search.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 48, width: 300, height: 48 });
  search.scrollIntoView = (o) => behaviours.push(o.behavior);
  t.win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const mounted = t.mount();
  await t.clock.advance(400);
  await mounted;
  t.q('#helpBtn').click();
  check('with less motion asked for, the scroll to the first step is instant', behaviours.join() === 'auto', behaviours);
  t.doc.getElementById('tourSkip').click();
  t.win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.q('#helpBtn').click();
  check('with motion allowed it glides', behaviours.join() === 'auto,smooth', behaviours);
});

await run('T5H2: typing in the search box during the guide is the person\'s: the arrow keys move the caret and do not turn a step', async (make) => {
  const t = withTour(make({ routes: usual() }));
  const mounted = t.mount();
  await t.clock.advance(2600);
  await mounted;
  check('the guide is on its first step', tourOn(t) && tourTitle(t) === 'Find a book');
  const input = t.q('#booksSearch');
  input.focus();
  for (const key of ['ArrowRight', 'ArrowLeft']) {
    const e = new t.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    check(key + ' in the box is left to the box (not prevented)', e.defaultPrevented === false);
  }
  check('and the step did not move', tourTitle(t) === 'Find a book');
  const textarea = t.doc.createElement('textarea');
  t.doc.body.appendChild(textarea);
  const e2 = new t.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  textarea.dispatchEvent(e2);
  check('a textarea, a select and an editable box are left alone too', e2.defaultPrevented === false && tourTitle(t) === 'Find a book');
  const editable = t.doc.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  t.doc.body.appendChild(editable);
  const e3 = new t.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  editable.dispatchEvent(e3);
  check('an editable box too', e3.defaultPrevented === false && tourTitle(t) === 'Find a book');
  // Everywhere else the arrows still turn the guide (the reader's guide works the same).
  const e4 = new t.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  t.doc.body.dispatchEvent(e4);
  check('on the page the right arrow goes on a step and is taken', e4.defaultPrevented === true && tourTitle(t) === 'Pick up where you left off', tourTitle(t));
  const e5 = new t.win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
  t.doc.body.dispatchEvent(e5);
  check('and the left arrow goes back', tourTitle(t) === 'Find a book');
  input.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('Escape still ends it, from the box too', !tourOn(t));
});

await run('T5H3: the guide is not offered, or marked seen, while a Kavita hand-off is leaving the page', async (make) => {
  const t = withTour(make({ routes: usual() }));
  t.kav.leaving = true;
  const mounted = t.mount();
  await t.clock.advance(2600);
  await mounted;
  check('not shown', !tourOn(t));
  check('and not marked seen, so it comes when the person is back', t.win.localStorage.getItem(GUIDE_FLAG) === null);
  const back = withTour(make({ routes: usual() }));
  const m = back.mount();
  await back.clock.advance(2600);
  await m;
  check('back on the page (no hand-off) it is shown', tourOn(back) && back.win.localStorage.getItem(GUIDE_FLAG) === '1');
  const going = withTour(make({ routes: usual({ continue: { items: [], notes: NOT_CONNECTED }, library: () => ({ body: { items: [audio(3, 'The Hobbit', 'Tolkien')], next_cursor: null, notes: NOT_CONNECTED } }) }) }));
  const g = going.mount();
  await going.clock.advance(2600);
  await g;
  check('a hand-off the page itself just started is the same: no guide, not seen', going.kav.reconnect.length === 1 && !tourOn(going) && going.win.localStorage.getItem(GUIDE_FLAG) === null);
});

// ---- Layout shift: the held room and the one write (2026-10-07) ----
//
// Measured live at 320, 375, 768 and 1440 px: every skeleton above the books
// is exactly its drawn row's height, so the page can only shift when a row is
// drawn after the books (its answer slower than theirs) or its memory is
// wrong. These pin both halves: the sizes the skeletons copy, and the wait.

// The classes that decide a box's height (and, for the toolbar, its width).
const SIZE_RE = /^(?:aspect-|h-|min-h-|size-|leading-|text-\[\d|text-(?:xl|lg|sm)$|mt-|mb-|py-|line-clamp-)/;
const sizeOf = (el) => (el.getAttribute('class') || '').split(/\s+/).filter((c) => SIZE_RE.test(c) && !/^line-clamp-/.test(c))
  .map((c) => c.replace(/^size-/, 'h-')).sort().join(' ');
// A line of a card: its own sizes, or (a wrapper or a row of buttons) its first sized child's.
function lineSize(el) {
  const own = sizeOf(el);
  if (/(?:^| )(?:aspect-|h-|min-h-|leading-)/.test(own)) return own.split(' ').filter((c) => !/^text-/.test(c) || /leading-/.test(own)).join(' ');
  const kid = Array.from(el.children).find((c) => /(?:^| )(?:aspect-|h-|min-h-|leading-)/.test(sizeOf(c)));
  const spacing = own.split(' ').filter((c) => /^(?:mt-|mb-)/.test(c));
  return spacing.concat(kid ? lineSize(kid).split(' ').filter((c) => !/^(?:mt-|mb-)/.test(c)) : []).filter(Boolean).sort().join(' ');
}
const lines = (els) => els.map(lineSize);

await run('CLS: every skeleton copies the sizes of what it holds room for', async (make) => {
  const srv = mine({ queue: QUEUE, list: QUEUE });
  const t = make({ storage: { 'webservarr_books_view:sam': '{"format":"all","sort":"added","group":false}' },
    routes: (net) => { withMine(srv, { continue: { items: CONT, notes: [] }, recent: () => ({ body: { items: RECENT } }), popular: () => ({ body: { items: POPULAR } }) })(net); } });
  const skel = new t.win.DOMParser().parseFromString(BOOKS_HTML, 'text/html');
  await t.mount();
  // Continue: the row's card, and the one line an empty Continue shows.
  const contSkel = skel.querySelector('#continueHost [data-skel="row"] > div');
  const contCard = t.q('#continueHost li > div');
  check('Continue: the card\'s width', /\bw-36\b/.test(contSkel.className) && /\bw-36\b/.test(contCard.className));
  check('Continue: cover, title and progress lines are the card\'s', lines(Array.from(contSkel.children)).join(' | ') === lines(Array.from(contCard.querySelector('a').children)).join(' | '),
    [lines(Array.from(contSkel.children)), lines(Array.from(contCard.querySelector('a').children))]);
  check('Continue: the row\'s own box (gap, padding) and heading', sizeOf(skel.querySelector('#continueHost [data-skel="row"]')) === sizeOf(t.q('#continueHost ul')) &&
    sizeOf(skel.querySelector('#continueHost h2')) === sizeOf(t.q('#continueHost h2')));
  const empty = books.renderContinueRow([], {});
  check('Continue empty: its line is the held line', sizeOf(skel.querySelector('#continueHost [data-skel="empty"]')) === sizeOf(empty.querySelector('[data-continue-empty]')),
    [sizeOf(skel.querySelector('#continueHost [data-skel="empty"]')), sizeOf(empty.querySelector('[data-continue-empty]'))]);
  // Up next: the cover and two lines, then the Play/Read row and the move row.
  const upSkel = skel.querySelector('#upnextHost .books-row > div');
  const upCard = t.q('#upnextHost li[data-queued]');
  const upReal = Array.from(upCard.querySelector('a').children).concat(Array.from(upCard.children).slice(1));
  check('Up next: the card\'s width', /\bw-40\b/.test(upSkel.className) && /\bw-40\b/.test(upCard.className));
  check('Up next: every line of the card', lines(Array.from(upSkel.children)).join(' | ') === lines(upReal).join(' | '), [lines(Array.from(upSkel.children)), lines(upReal)]);
  // My list and the shelves: library cards in a row.
  for (const id of ['mylistHost', 'recentHost', 'popularHost']) {
    const s = skel.querySelector(`#${id} .books-row > div`);
    const li = t.q(`#${id} li`);
    check(`${id}: the card's width and lines`, /\bw-36\b/.test(s.className) && /\bw-36\b/.test(li.className) &&
      lines(Array.from(s.children)).join(' | ') === lines(Array.from(li.querySelector('a').children)).join(' | '), [lines(Array.from(s.children)), lines(Array.from(li.querySelector('a').children))]);
    check(`${id}: the row and heading`, sizeOf(skel.querySelector(`#${id} .books-row`)) === sizeOf(t.q(`#${id} ul, #${id} ol`)) && sizeOf(skel.querySelector(`#${id} h2`)) === sizeOf(t.q(`#${id} h2`)));
  }
  // The grid: a card with its series line (Group series off).
  const gridSkel = skel.querySelector('#gridSkeleton > div');
  const gridCard = t.q('#libraryGrid > li > a');
  check('grid: every line of a card, the series line included', lines(Array.from(gridSkel.children)).join(' | ') === lines(Array.from(gridCard.children)).join(' | '),
    [lines(Array.from(gridSkel.children)), lines(Array.from(gridCard.children))]);
  check('grid: the same columns and gaps', skel.querySelector('#gridSkeleton').className.replace(/\s+/g, ' ') === skel.querySelector('#libraryGrid').className.replace(/\bhidden\s+/, '').replace(/\s+/g, ' '));
});

await run('CLS: the toolbar\'s skeleton is its controls, word for word and size for size', async (make) => {
  const t = make({ routes: usual() });
  const skel = new t.win.DOMParser().parseFromString(BOOKS_HTML, 'text/html');
  // Each class that sets a size, at any breakpoint (lg:h-10 as much as h-11).
  const WIDTH_RE = /^(?:[a-z0-9-]+:)?(?:h-|w-|min-w-|px-|pl-|pr-|gap-|grow|text-\[\d|font-(?:semibold|medium|bold)$)/;
  const widthOf = (el) => (el.getAttribute('class') || '').split(/\s+/).filter((c) => WIDTH_RE.test(c)).sort().join(' ');
  const words = (el) => el.textContent.replace(/expand_more/g, '').replace(/\s+/g, ' ').trim();
  const skelControls = Array.from(skel.querySelectorAll('#toolbarSkel .skel'));
  const real = Array.from(skel.querySelectorAll('#formatChips [data-format], #filterButtons [data-filter], #groupSwitch, #sortBtn'));
  check('one skeleton per control, in order', skelControls.length === real.length, [skelControls.length, real.length]);
  real.forEach((b, i) => {
    const s = skelControls[i];
    if (!s) return;
    if (b.id === 'sortBtn') {
      // A fixed box whatever the order's words: its height and width.
      const box = (el) => widthOf(el).split(' ').filter((c) => /^[hw]-/.test(c)).join(' ');
      check('the sort: the same fixed box', box(s) === box(b) && /\bw-44\b/.test(b.className), [box(s), box(b)]);
      return;
    }
    check(`"${words(b)}": the same words, unseen`, words(s) === words(b), [words(s), words(b)]);
    check(`"${words(b)}": the same height, padding, type and width`, widthOf(s) === widthOf(b), [widthOf(s), widthOf(b)]);
  });
  check('the filter buttons\' arrows are 20px boxes, so the icon font arriving changes no width',
    Array.from(skel.querySelectorAll('#filterButtons [data-filter] .material-symbols-outlined')).every((i) => /\bw-5\b/.test(i.className) && /\boverflow-hidden\b/.test(i.className)) &&
    Array.from(skel.querySelectorAll('#toolbarSkel .invisible.size-5')).length === 3);
  check('the groups wrap the same way', ['#toolbarSkel', '#toolbar'].every((sel) => /\bflex-wrap\b/.test(skel.querySelector(sel).className) && /\bgap-3\b/.test(skel.querySelector(sel).className) && /\bmb-6\b/.test(skel.querySelector(sel).className)));
  // Group series and the sort are wider than a 320px phone side by side: under 360px the
  // sort takes its own line, in the skeleton too, so the held height stays exact.
  const pairSkel = skel.querySelector('#toolbarSkel .w-44').parentElement;
  const pairReal = skel.querySelector('#groupSwitch').parentElement;
  check('Group series and the sort: one row that wraps under 360px, the skeleton\'s the same',
    pairReal === skel.querySelector('#sortBtn').parentElement && /(?:^| )max-\[359px\]:flex-wrap(?: |$)/.test(pairReal.className) &&
    pairSkel.className === pairReal.className, [pairSkel.className, pairReal.className]);
  // A pill and Clear all are h-9 (pages/books.js ACTIVE_CHIP, CLEAR_ALL): one row of them.
  check('the row of filters in use: held at a pill\'s height, on a row of its own', /\bh-9\b/.test(skel.querySelector('#toolbarSkel [data-skel="filters"]').className) &&
    /\bbasis-full\b/.test(skel.querySelector('#toolbarSkel [data-skel="filters"]').className) && /\bbasis-full\b/.test(skel.querySelector('#activeFilters').className));
  const f = make({ url: 'https://ws.test/books?author=Jane%20Austen', routes: usual() });
  await f.mount();
  check('and a pill is that height', Array.from(f.qa('#activeFilters button')).every((b) => /\bh-9\b/.test(b.className)) && f.qa('#activeFilters button').length === 2);
});

await run('the toolbar on a phone: even rows of 44px controls, centred; from lg up the desktop row as before', async (make) => {
  const t = make({ routes: usual() });
  await t.mount();
  const cls = (sel) => t.q(sel).className.split(/\s+/);
  const has = (sel, list) => list.filter((c) => cls(sel).indexOf(c) === -1);
  const EVEN = 'grid-cols-[repeat(3,minmax(max-content,1fr))]';
  // Below lg: one row each, the three chips and the three filters in even columns across the width.
  check('the format chips: three even columns across the width, a 28rem block on a tablet', has('#formatChips', ['grid', 'w-full', EVEN, 'gap-2', 'sm:max-w-md']).length === 0, has('#formatChips', ['grid', 'w-full', EVEN, 'gap-2', 'sm:max-w-md']));
  check('the filters: the same columns and width (their focus-ring margin aside), scrolling sideways only if a phone is too narrow',
    has('#filterButtons', ['grid', 'w-[calc(100%+0.5rem)]', '-m-1', 'p-1', EVEN, 'gap-2', 'sm:max-w-[calc(28rem+0.5rem)]', 'overflow-x-auto']).length === 0);
  check('Group series and the sort: a full row, the sort taking what Group series leaves',
    has('#groupSwitch', ['h-11']).length === 0 && t.q('#groupSwitch').parentElement.classList.contains('w-full') && t.q('#groupSwitch').parentElement.classList.contains('sm:max-w-md') &&
    has('#sortBtn', ['h-11', 'w-44', 'grow']).length === 0);
  const controls = t.qa('#formatChips [data-format], #filterButtons [data-filter]');
  check('every chip and filter is 44px tall on a phone, its words centred', controls.length === 6 && controls.every((b) => /(?:^| )h-11(?: |$)/.test(b.className) && /\bjustify-center\b/.test(b.className)));
  // From lg up: what the desktop had.
  check('lg: the chips a wrapping flex row, auto width', has('#formatChips', ['lg:flex', 'lg:w-auto', 'lg:max-w-none', 'lg:flex-wrap', 'lg:items-center']).length === 0);
  check('lg: the filters a flex row within the toolbar', has('#filterButtons', ['lg:flex', 'lg:w-auto', 'lg:min-w-0', 'lg:max-w-full', 'lg:items-center']).length === 0);
  check('lg: the pair at the far end, the sort its fixed 11rem', t.q('#groupSwitch').parentElement.classList.contains('lg:ml-auto') && has('#sortBtn', ['lg:h-10', 'lg:grow-0']).length === 0 && has('#groupSwitch', ['lg:h-10']).length === 0);
  check('lg: chips and filters 40px with their old padding', controls.every((b) => /\blg:h-10\b/.test(b.className)) &&
    t.qa('#formatChips [data-format]').every((b) => /\blg:px-4\b/.test(b.className)) && t.qa('#filterButtons [data-filter]').every((b) => /\blg:pl-4\b/.test(b.className) && /\blg:pr-3\b/.test(b.className)));
  // The pressed chip keeps its look through a change, in the new shape.
  t.click('#formatChips [data-format="audio"]');
  await t.clock.advance(800);
  const audio = t.q('#formatChips [data-format="audio"]');
  const all = t.q('#formatChips [data-format="all"]');
  check('pressed: filled and marked, in the phone shape', audio.getAttribute('aria-pressed') === 'true' && /\bbg-primary\b/.test(audio.className) && /(?:^| )h-11(?: |$)/.test(audio.className) && /\blg:h-10\b/.test(audio.className));
  check('the others: quiet and unmarked, the same shape', all.getAttribute('aria-pressed') === 'false' && !/\bbg-primary\b/.test(all.className) && /(?:^| )h-11(?: |$)/.test(all.className));
  // The skeleton's groups are the toolbar's, so the swap moves nothing at any width.
  const skel = new t.win.DOMParser().parseFromString(BOOKS_HTML, 'text/html');
  const groups = skel.querySelectorAll('#toolbarSkel > div');
  check('the skeleton\'s chip row is the chips\' row', groups[0].className === skel.querySelector('#formatChips').className, [groups[0].className, skel.querySelector('#formatChips').className]);
  check('the skeleton\'s filter row is the filters\' row, unscrolled', groups[1].className === skel.querySelector('#filterButtons').className.replace('books-row ', '').replace('overflow-x-auto', 'overflow-hidden'),
    [groups[1].className, skel.querySelector('#filterButtons').className]);
});

await run('the search\'s placeholder: the shared marquee runs it for the visit (ui.js; its behaviour in marquee.mjs)', async (make) => {
  const t = make({ routes: usual() });
  const calls = [];
  t.win.WSUI.marqueePlaceholder = (input, overlay, signal) => { calls.push({ input, overlay, signal }); return {}; };
  await t.mount();
  const c = calls[0] || {};
  check('once, on the search and its overlay', calls.length === 1 && c.input === t.q('#booksSearch') && c.overlay === t.q('#booksSearchMarquee'));
  check('for the visit: the page\'s own signal, which a soft navigation ends', c.signal === t.ctx.signal && !c.signal.aborted);
  t.ctl.abort();
  check('ended with the visit', c.signal.aborted);
  check('the overlay is in the page beside the input, hidden from screen readers',
    t.q('#booksSearchMarquee').parentElement === t.q('#booksSearch').parentElement && t.q('#booksSearchMarquee').getAttribute('aria-hidden') === 'true');
  // Without the helper (an older cached ui.js), the page still mounts and searches.
  const u = make({ routes: usual() });
  await u.mount();
  u.type('dune');
  await u.clock.advance(1000);
  check('without it, the search still works', u.net.urls('/api/books/search').length === 1);
});

await run('CLS: a remembered row is waited for too, so a wrong memory never moves the books', async (make) => {
  // Remembered as having books in progress, but the last one was finished: the
  // answer is the empty line, and it comes slower than the books.
  const cont = deferred();
  const t = make({ storage: { 'webservarr_books_continue:sam': '1', 'webservarr_books_recent:sam': '1', 'webservarr_books_popular:sam': '0' },
    routes: (net) => { shelves(RECENT, POPULAR)(net); net.on('/api/books/continue', () => cont.promise.then(() => ({ body: { items: [], notes: [] } }))); } });
  const m = t.mount();
  check('the room of a row of cards is held from the first paint', t.doc.documentElement.hasAttribute('data-books-continue'));
  await t.clock.advance(2500);
  check('2.5 s: the books and the shelves have answered but wait for Continue', t.hidden('#libraryGrid') && !t.hidden('#gridSkeleton') && !t.hidden('#toolbarSkel') &&
    !!t.q('#recentHost .skel') && !t.q('#popularHost [data-popular]'));
  cont.resolve();
  await t.clock.advance(50);
  await m;
  check('then the empty line, the shelves (Popular newly filled), the toolbar and the books in one write',
    !!t.q('#continueHost [data-continue-empty]') && !t.doc.documentElement.hasAttribute('data-books-continue') && !!t.q('#recentHost [data-recent]') &&
    !!t.q('#popularHost [data-popular]') && t.hidden('#toolbarSkel') && !t.hidden('#toolbar') && !t.hidden('#libraryGrid') && t.hidden('#gridSkeleton'));
  check('and remembered for the next first paint', t.win.localStorage.getItem('webservarr_books_continue:sam') === '0' && t.win.localStorage.getItem('webservarr_books_popular:sam') === '1');
});

await run('CLS: a first visit with a slow Continue (2.5 s) draws the row and the books together', async (make) => {
  // What dev showed at 375 px: a 2.5 s Continue on a first visit came in after
  // the books and pushed Recently added and the toolbar down (CLS 0.19).
  const cont = deferred();
  const t = make({ routes: (net) => { shelves(RECENT, [])(net); net.on('/api/books/continue', () => cont.promise.then(() => ({ body: { items: CONT, notes: [] } }))); } });
  const m = t.mount();
  await t.clock.advance(2500);
  check('the books wait past the old 1.5 s gate', t.hidden('#libraryGrid') && !t.q('#recentHost [data-recent]'));
  cont.resolve();
  await t.clock.advance(50);
  await m;
  check('the row, the shelf and the books land together', !!t.q('#continueHost [data-continue] ul') && !!t.q('#recentHost [data-recent]') && !t.hidden('#libraryGrid'));
});

await run('CLS: a library slower than the wait brings in the toolbar alone, only at its skeleton\'s exact height', async (make) => {
  const lib = deferred();
  const t = make({ url: 'https://ws.test/books?author=Jane%20Austen&series=Emma%20and%20Friends', routes: (net) => { usual({ continue: { items: CONT, notes: [] } })(net); net.on('/api/books?', () => lib.promise); } });
  // Two filters in use can wrap to more rows than the skeleton's one: no layout
  // here, so the sizes are given.
  t.q('#toolbarSkel').getBoundingClientRect = () => ({ height: 192 });
  t.q('#toolbar').getBoundingClientRect = () => ({ height: 240 });
  const m = t.mount();
  await t.clock.advance(4100);
  check('taller than its skeleton: the skeleton stays until the books', !t.hidden('#toolbarSkel') && t.hidden('#toolbar'));
  check('and Continue waits with it', !t.q('#continueHost [data-continue]'));
  lib.resolve({ body: { items: SHELF, next_cursor: null, notes: [], building: false } });
  await t.clock.advance(50);
  await m;
  check('the books bring everything in one write', t.hidden('#toolbarSkel') && !t.hidden('#toolbar') && !!t.q('#continueHost [data-continue]') && !t.hidden('#libraryGrid'));
  const lib2 = deferred();
  const u = make({ routes: (net) => { usual()(net); net.on('/api/books?', () => lib2.promise); } });
  u.q('#toolbarSkel').getBoundingClientRect = () => ({ height: 144 });
  u.q('#toolbar').getBoundingClientRect = () => ({ height: 144 });
  u.mount();
  await u.clock.advance(4100);
  check('the same height: the toolbar comes in on its own, the grid\'s skeleton stays where it is', u.hidden('#toolbarSkel') && !u.hidden('#toolbar') && !u.hidden('#gridSkeleton') && !!u.q('#continueHost .skel'));
});

// ---- The audiobook notice: a window on every visit until Don't show again ----
//
// Everyone who opens Books gets a window over the whole page (the page's
// books_notice says "window" until the account has Don't show again, "off").
// Okay works after 15 seconds and closes it for this visit only; Don't show
// again works after 30 and turns it off for the account. Nothing closes it
// before Okay works. Run with the real ui.js (WSUI.modal and its hold).

const UI_SRC = readFileSync(join(STATIC, 'js/ui.js'), 'utf8');
const LOADER = readFileSync(join(STATIC, 'js/theme-loader.js'), 'utf8');
const NOTICE_URL = '/api/books/me/notice';
const SESSION_KEY = 'webservarr_books_notice_session:sam';
const LEAD = 'For the best audiobook experience, I highly recommend listening right here on ';
const SYNC = 'Audiobooks also show up in Plex and Plexamp, and your place should sync between them.';
// The window opens with the work behind the page, then the recommendation,
// then the Plex caveat and its list, then where to report a problem and a thank-you.
const NOTICE_ORDER = [
  'This Books page took many hours to build. Behind it is custom logic for the new ebook and audiobook library, a custom ebook reader, and n8n, Kavita and Plex connected behind the scenes so book requests just work. Much of that time went into one goal: you should never lose your place in a book. There are several failsafes, a saved listening history, and alerts if anything goes wrong.',
  LEAD,
  SYNC,
  'If something isn\'t right, please open a ticket on the Tickets page with as much detail as you can.',
  'Thanks for reading, and enjoy!',
];

// The real ui.js in the visit's window (its toast still recorded), this
// window's sessionStorage as the page's, and a motion setting.
function withNotice(t, o = {}) {
  t.win.matchMedia = (q) => ({ matches: /reduce/.test(q) ? !!o.reduced : true, addEventListener() {}, removeEventListener() {} });
  const toasts = t.toasts;
  new Function('window', 'document', UI_SRC)(t.win, t.doc);
  t.win.WSUI.toast = (m, kind) => { toasts.push([m, kind]); return { remove() {} }; };
  const g = globalThis;
  const saved = { sessionStorage: Object.getOwnPropertyDescriptor(g, 'sessionStorage'), WSUI: Object.getOwnPropertyDescriptor(g, 'WSUI') };
  if (o.session === 'blocked') Object.defineProperty(g, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  else Object.defineProperty(g, 'sessionStorage', { value: t.win.sessionStorage, configurable: true, writable: true });
  Object.defineProperty(g, 'WSUI', { value: t.win.WSUI, configurable: true, writable: true });
  for (const [k, v] of Object.entries(o.sessionStore || {})) t.win.sessionStorage.setItem(k, v);
  // Every visit is mounted to the end before the test lets go of the globals.
  const mount = t.mount;
  t.mount = () => (t.mounted = mount());
  const release = t.release;
  t.release = () => {
    for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; }
    release();
  };
  return t;
}

// Lets each visit's mount finish (its rows and library answered) before the
// test ends, so nothing of it runs after the globals are put back.
async function finish(...ts) {
  for (const t of ts) {
    await t.clock.advance(2000);
    await t.mounted;
  }
}

// The answers the server gives: { status } per call, in order (the last repeats).
function noticeRoutes(statuses = [200]) {
  return (net) => {
    usual()(net);
    let i = 0;
    net.on(NOTICE_URL, (url, init) => {
      const status = statuses[Math.min(i++, statuses.length - 1)];
      const state = JSON.parse(init.body).state;
      return { status, body: status === 200 ? { notice: state === 'off' ? 'off' : 'window' } : { detail: 'no' } };
    });
  };
}
const posts = (t) => t.net.calls.filter((c) => c.url === NOTICE_URL).map((c) => ({ method: c.init.method, body: JSON.parse(c.init.body) }));
const windowOn = (t) => !t.q('#booksNoticeWindow').hidden;
const okayBtn = (t) => t.q('#booksNoticeWindowOkay');
const offBtn = (t) => t.q('#booksNoticeWindowOff');
// Okay's own label (its nudge sits beside it, aria-hidden, shown by the CSS).
const okayText = (t) => t.q('#booksNoticeWindowOkay [data-books-notice-label]').textContent;
const NUDGE = 'Go back up and read the message!';
const escape = (t) => t.doc.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const visitWith = (make, o = {}) => withNotice(make({ data: Object.assign({ books_notice: o.notice || 'window' }, o.data || {}), routes: noticeRoutes(o.statuses), branding: o.branding }), o);

await run('the window: every visit opens it over the whole page, a modal named by its title, the words in it', async (make) => {
  const t = visitWith(make, { branding: { app_name: '  Riverbend ' } });
  const m = t.mount();
  check('open from the visit\'s first frame', windowOn(t));
  const box = t.q('#booksNoticeBox');
  check('a modal dialog named by its title', box.getAttribute('role') === 'dialog' && box.getAttribute('aria-modal') === 'true' &&
    box.getAttribute('aria-labelledby') === 'booksNoticeWindowTitle' && t.text('#booksNoticeWindowTitle') === 'Before you start listening');
  check('focus starts on the title, so the words are read from the top', t.doc.activeElement === t.q('#booksNoticeWindowTitle'));
  check('the page under it holds still', t.doc.documentElement.hasAttribute('data-books-notice-open'));
  check('no page scrollbar here, so no gutter is held for one', !t.doc.documentElement.hasAttribute('data-books-notice-gutter'));
  check('everything behind it is inert: the page under it', t.q('#wsPage > div').inert === true);
  check('the window itself is not', !t.q('#booksNoticeWindow').inert);
  const words = t.q('#booksNoticeWindowWords');
  const paras = Array.from(words.querySelectorAll('p')).map((p) => p.textContent);
  check('five paragraphs in the approved order, opening with the work behind the page', paras.length === NOTICE_ORDER.length &&
    NOTICE_ORDER.every((start, i) => paras[i].indexOf(start) === 0) && paras[4] === 'Thanks for reading, and enjoy!', paras);
  check('the lead (second) names the site, "highly" stressed', paras[1] === LEAD + 'Riverbend.' &&
    words.querySelectorAll('p')[1].classList.contains('bn-lead') && words.querySelector('p.bn-lead em').textContent === 'highly', paras[1]);
  check('the third paragraph starts with the approved words, the list right after it', paras[2].indexOf(SYNC) === 0 && !/Your audiobooks/.test(words.textContent) &&
    words.querySelectorAll('p')[2].nextElementSibling === words.querySelector('ul.bn-list'), paras[2]);
  check('the three problems as a list', words.querySelectorAll('ul.bn-list > li').length === 3);
  check('no line about what is seen here', !/So I can keep improving it/.test(words.textContent));
  check('the Tickets page is words here, not a link: the window has no way out but its buttons', !words.querySelector('a') && /on the Tickets page with/.test(words.textContent));
  const [off, okay] = t.qa('#booksNoticeBox .bn-window-foot button');
  check('two buttons side by side at its foot: Don\'t show again (quiet), then Okay (the one blue primary)', off === offBtn(t) && okay === okayBtn(t) &&
    off.type === 'button' && okay.type === 'button' && off.classList.contains('bn-count-quiet') && !okay.classList.contains('bn-count-quiet'));
  check('Okay is dimmed but focusable (aria-disabled, not disabled), the count unread', okay.getAttribute('aria-disabled') === 'true' &&
    !okay.disabled && okayText(t) === 'Okay\u00a0(30)' && okay.querySelector('[data-books-notice-count]').getAttribute('aria-hidden') === 'true');
  check('Don\'t show again too, with its own, longer count', off.getAttribute('aria-disabled') === 'true' &&
    !off.disabled && off.textContent === 'Don\'t show again\u00a0(45)' && off.querySelector('[data-books-notice-count]').getAttribute('aria-hidden') === 'true');
  check('both fills sweep', okay.classList.contains('is-running') && off.classList.contains('is-running'));
  check('nothing is kept on opening', posts(t).length === 0 && t.win.sessionStorage.getItem(SESSION_KEY) === null);
  await t.clock.advance(400);
  check('the counts are said once', t.text('#booksNoticeSay') === 'Okay will work in 30 seconds, and Don\u2019t show again in 45.', t.text('#booksNoticeSay'));
  await t.clock.advance(1600);
  await m;
  check('and the numbers count down', okayText(t) === 'Okay\u00a0(28)' && off.textContent === 'Don\'t show again\u00a0(43)', [okayText(t), off.textContent]);
  await finish(t);
});

await run('the window: nothing closes it for 30 seconds, then Okay closes it for this visit only', async (make) => {
  const t = visitWith(make);
  t.mount();
  await t.clock.advance(6000);
  check('six seconds in: "Okay\u00a0(24)"', okayText(t) === 'Okay\u00a0(24)', okayText(t));
  escape(t);
  check('Escape does nothing', windowOn(t));
  t.click('[data-books-notice-veil]');
  check('a click outside does nothing', windowOn(t));
  t.click('#booksNoticeWindowOkay');
  check('Okay does nothing', windowOn(t) && posts(t).length === 0);
  t.click('#booksNoticeWindowOff');
  check('Don\'t show again does nothing', windowOn(t) && posts(t).length === 0);
  // Tab stays inside: from Okay (the last) back to the first control.
  okayBtn(t).focus();
  t.doc.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  check('focus is trapped in the window', t.q('#booksNoticeBox').contains(t.doc.activeElement));
  await t.clock.advance(23000);
  check('29 seconds in, still nothing', okayText(t) === 'Okay\u00a0(1)' && okayBtn(t).getAttribute('aria-disabled') === 'true');
  escape(t);
  check('and Escape still does nothing', windowOn(t));
  await t.clock.advance(1000);
  check('after 30 seconds Okay works: no count, not dimmed, the fill done', !okayBtn(t).hasAttribute('aria-disabled') &&
    okayText(t) === 'Okay' && !okayBtn(t).classList.contains('is-running'));
  check('Don\'t show again still counts', offBtn(t).getAttribute('aria-disabled') === 'true' && offBtn(t).textContent === 'Don\'t show again\u00a0(15)', offBtn(t).textContent);
  t.click('#booksNoticeWindowOff');
  check('and still does nothing', windowOn(t) && posts(t).length === 0);
  t.click('#booksNoticeWindowOkay');
  await t.clock.advance(50);
  check('Okay closes it', !windowOn(t) && !t.doc.documentElement.hasAttribute('data-books-notice-open') && !t.doc.documentElement.hasAttribute('data-books-notice-gutter'));
  check('nothing is sent or kept: the window is back on the next visit', posts(t).length === 0 && t.win.sessionStorage.getItem(SESSION_KEY) === null);
  check('the page is usable again', !t.q('#wsPage > div').inert);
  check('focus goes to the page\'s heading', t.doc.activeElement === t.q('h1'));
  const again = visitWith(make);
  again.mount();
  check('the next visit (the server still says window): it is back', windowOn(again));
  await finish(t, again);
});

await run('the window: Escape or a click outside close it like Okay, once Okay works', async (make) => {
  const esc = visitWith(make);
  esc.mount();
  await esc.clock.advance(29000);
  escape(esc);
  check('not before the count is done', windowOn(esc));
  await esc.clock.advance(1000);
  escape(esc);
  await esc.clock.advance(50);
  check('Escape closes it once Okay works, and keeps nothing', !windowOn(esc) && posts(esc).length === 0 && esc.win.sessionStorage.getItem(SESSION_KEY) === null);
  const out = visitWith(make);
  out.mount();
  await out.clock.advance(30000);
  out.click('[data-books-notice-veil]');
  await out.clock.advance(50);
  check('a click outside closes it too, and keeps nothing', !windowOn(out) && posts(out).length === 0);
  await finish(esc, out);
});

await run('the window: Don\'t show again works after 45 seconds, closes it and turns it off for the account', async (make) => {
  const t = visitWith(make);
  const m = t.mount();
  await t.clock.advance(44000);
  check('44 seconds in: "Don\'t show again\u00a0(1)"', offBtn(t).textContent === 'Don\'t show again\u00a0(1)' && offBtn(t).getAttribute('aria-disabled') === 'true', offBtn(t).textContent);
  await t.clock.advance(1000);
  check('then it works: no count, not dimmed, its line gone', !offBtn(t).hasAttribute('aria-disabled') && offBtn(t).textContent === 'Don\'t show again' &&
    !offBtn(t).classList.contains('is-running'));
  await t.clock.advance(5000);
  check('the counting stops there', offBtn(t).textContent === 'Don\'t show again' && okayText(t) === 'Okay' && windowOn(t));
  t.click('#booksNoticeWindowOff');
  await t.clock.advance(50);
  await m;
  check('it closes, the page given back, the focus on the heading', !windowOn(t) && !t.q('#wsPage > div').inert && t.doc.activeElement === t.q('h1'));
  check('off is sent once, for the account', JSON.stringify(posts(t)) === JSON.stringify([{ method: 'POST', body: { state: 'off' } }]), posts(t));
  check('it is a same-origin write', t.net.calls.find((c) => c.url === NOTICE_URL).init.credentials === 'same-origin');
  check('and held for this session too (a page fetched before it still says window)', t.win.sessionStorage.getItem(SESSION_KEY) === 'off');
  check('no error shown', t.toasts.length === 0);
  const stale = visitWith(make, { sessionStore: { [SESSION_KEY]: 'off' } });
  stale.mount();
  check('a soft visit back in the same session, the page still saying window: not shown', !windowOn(stale));
  const next = visitWith(make, { notice: 'off' });
  next.mount();
  check('every later visit (the server says off): never shown', !windowOn(next));
  const other = visitWith(make, { data: { user: { username: 'sam', identity_key: 'k9' } }, sessionStore: { [SESSION_KEY]: 'off' } });
  other.mount();
  check('the session\'s record is per account (its identity key)', windowOn(other));
  await finish(t, stale, next, other);
});

await run('the window: Don\'t show again that fails (signed out, the server down) still closes it and says so', async (make) => {
  for (const status of [401, 503]) {
    const t = visitWith(make, { statuses: [status] });
    t.mount();
    await t.clock.advance(45000);
    t.click('#booksNoticeWindowOff');
    await t.clock.advance(50);
    check(`${status}: closed, and held for this session all the same`, !windowOn(t) && t.win.sessionStorage.getItem(SESSION_KEY) === 'off');
    check(`${status}: an error says it will be back`, t.toasts.length === 1 && t.toasts[0][1] === 'err' && /will be back on your next visit/.test(t.toasts[0][0]), t.toasts);
    await finish(t);
  }
});

await run('the window: session storage blocked still shows it, and both buttons still work', async (make) => {
  const t = visitWith(make, { session: 'blocked' });
  let err = null;
  try { t.mount(); } catch (e) { err = e; }
  check('shown, no error', !err && windowOn(t), err && String(err));
  await t.clock.advance(45000);
  t.click('#booksNoticeWindowOff');
  await t.clock.advance(50);
  check('Don\'t show again closes it and is sent', !windowOn(t) && posts(t).length === 1);
  await finish(t);
});

await run('the window: reduced motion has no sweep, and the numbers still count', async (make) => {
  const t = visitWith(make, { reduced: true });
  t.mount();
  check('no sweep on either', !okayBtn(t).classList.contains('is-running') && !offBtn(t).classList.contains('is-running'));
  await t.clock.advance(1000);
  check('the counts are text, so they still count', okayText(t) === 'Okay\u00a0(29)' && offBtn(t).textContent === 'Don\'t show again\u00a0(44)');
  await finish(t);
});

// The words' scroll box, sized by hand (no layout here): height of the words, of the box, and where it is.
function scrollBox(t, full, box) {
  const words = t.q('#booksNoticeWindowWords');
  let top = 0;
  Object.defineProperty(words, 'scrollHeight', { configurable: true, get: () => full });
  Object.defineProperty(words, 'clientHeight', { configurable: true, get: () => box });
  Object.defineProperty(words, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v; } });
  return (y) => { top = y; words.dispatchEvent(new t.win.Event('scroll')); };
}
const nudged = (t) => okayBtn(t).hasAttribute('data-books-notice-nudge');

await run('the window: scrolled to the end of the words while Okay waits, Okay says to go back up and read it', async (make) => {
  const t = visitWith(make);
  t.mount();
  const nudge = okayBtn(t).querySelector('.bn-nudge');
  check('the nudge sits in Okay, hidden from its name, which stays "Okay"', nudge.textContent === NUDGE && nudge.getAttribute('aria-hidden') === 'true' &&
    okayText(t) === 'Okay (30)' && !nudged(t));
  await t.clock.advance(1000);
  const scrollTo = scrollBox(t, 800, 600);
  scrollTo(100);
  check('part way down: still Okay', !nudged(t));
  scrollTo(195);
  check('at the end (the buttons right under the last line): the nudge, the count and the sweep still running behind it', nudged(t) &&
    okayText(t) === 'Okay (29)' && okayBtn(t).classList.contains('is-running') && okayBtn(t).getAttribute('aria-disabled') === 'true');
  check('and it is said, politely', t.text('#booksNoticeSay') === NUDGE && t.q('#booksNoticeSay').getAttribute('aria-live') === 'polite');
  scrollTo(50);
  check('back up: Okay again', !nudged(t));
  t.q('#booksNoticeSay').textContent = '';
  scrollTo(200);
  check('down again: the nudge, but said only the once', nudged(t) && t.text('#booksNoticeSay') === '');
  check('Okay still does nothing while it shows', (t.click('#booksNoticeWindowOkay'), windowOn(t)));
  await t.clock.advance(29000);
  check('once Okay works it says Okay, even at the end', !nudged(t) && okayText(t) === 'Okay' && !okayBtn(t).hasAttribute('aria-disabled'));
  scrollTo(0);
  scrollTo(200);
  check('and scrolling again does not bring the nudge back', !nudged(t));
  t.click('#booksNoticeWindowOkay');
  await t.clock.advance(50);
  check('Okay closes it as before', !windowOn(t));
  await finish(t);
});

await run('the window: words that fit never scroll, so never nudge', async (make) => {
  const t = visitWith(make);
  t.mount();
  const scrollTo = scrollBox(t, 520, 520);
  scrollTo(0);
  check('no nudge, nothing said about it', !nudged(t) && t.text('#booksNoticeSay') !== NUDGE);
  await t.clock.advance(1000);
  check('the counts are said as usual', /^Okay will work in 30 seconds/.test(t.text('#booksNoticeSay')));
  await finish(t);
});

await run('the window: keyboard focus on Okay while it waits says the nudge once; after, it does not', async (make) => {
  const t = visitWith(make);
  t.mount();
  await t.clock.advance(1000);
  okayBtn(t).focus();
  check('focused while it waits: said', t.text('#booksNoticeSay') === NUDGE);
  t.q('#booksNoticeWindowTitle').focus();
  t.q('#booksNoticeSay').textContent = '';
  okayBtn(t).focus();
  check('focused again: not said again', t.text('#booksNoticeSay') === '');
  await finish(t);
  const late = visitWith(make);
  late.mount();
  await late.clock.advance(30000);
  late.q('#booksNoticeSay').textContent = '';
  okayBtn(late).focus();
  check('focused once Okay works: nothing said', late.text('#booksNoticeSay') === '');
  await finish(late);
});

await run('the window and the first-visit guide never run at once: the guide waits for it', async (make) => {
  const t = withTour(visitWith(make));
  const m = t.mount();
  await t.clock.advance(3000);
  await m;
  check('the books are drawn, the guide holds back while the window is open', !t.hidden('#libraryGrid') && !tourOn(t) && windowOn(t));
  await t.clock.advance(27000);
  check('Okay works, the guide still waits for the window to close', !tourOn(t));
  t.click('#booksNoticeWindowOkay');
  await t.clock.advance(400);
  check('closed: then it starts', !windowOn(t) && tourOn(t));
  check('marked seen for this person', t.win.localStorage.getItem(GUIDE_FLAG) === '1');
  await finish(t);
  const off = withTour(visitWith(make));
  off.mount();
  await off.clock.advance(45000);
  off.click('#booksNoticeWindowOff');
  await off.clock.advance(400);
  check('closed by Don\'t show again: the guide runs too', !windowOn(off) && tourOn(off));
  await finish(off);
  const later = withTour(visitWith(make));
  later.win.localStorage.setItem(GUIDE_FLAG, '1');
  later.mount();
  await later.clock.advance(30000);
  later.click('#booksNoticeWindowOkay');
  await later.clock.advance(1000);
  check('a later visit: the window again, but the guide only ever the first time', !windowOn(later) && !tourOn(later));
  const left = withTour(visitWith(make));
  left.mount();
  await left.clock.advance(30000);
  left.ctl.abort();
  await left.clock.advance(400);
  check('a visit that ended starts nothing', !tourOn(left));
  await finish(later, left);
});

await run('the window: leaving the page during the count takes it away and keeps nothing', async (make) => {
  const t = visitWith(make);
  t.mount();
  await t.clock.advance(3000);
  // The router closes every dialog before a navigation, then the visit ends.
  t.win.WSUI.closeDialogs();
  t.ctl.abort();
  check('closed, the page given back', !windowOn(t) && !t.q('#wsPage > div').inert);
  check('nothing kept, so the next visit has it again', posts(t).length === 0 && t.win.sessionStorage.getItem(SESSION_KEY) === null);
  const ended = visitWith(make);
  ended.mount();
  await ended.clock.advance(3000);
  ended.ctl.abort();
  check('a visit that ends any other way takes it away too', !windowOn(ended) && !ended.q('#wsPage > div').inert && !ended.doc.documentElement.hasAttribute('data-books-notice-open'));
  await finish(t, ended);
});

await run('the window: not over a book\'s pop-up (a full load of its address)', async (make) => {
  const t = visitWith(make);
  t.doc.documentElement.setAttribute('data-book-open', '');
  t.mount();
  check('not opened, nothing kept', !windowOn(t) && posts(t).length === 0);
  await finish(t);
});

await run('the window: what the page says', async (make) => {
  for (const [notice, on] of [['window', true], ['inline', true], ['off', false], [undefined, false]]) {
    const t = withNotice(make({ data: notice === undefined ? {} : { books_notice: notice }, routes: noticeRoutes() }));
    t.mount();
    check(`${notice}: ${on ? 'shown' : 'not shown'}`, windowOn(t) === on);
    await finish(t);
  }
  const blank = visitWith(make, { branding: { app_name: '   ' } });
  blank.mount();
  check('a site with no name says "this site"', blank.q('#booksNoticeWindowWords p.bn-lead').textContent === LEAD + 'this site.', blank.q('#booksNoticeWindowWords p.bn-lead').textContent);
  await finish(blank);
});

await run('the shared modal\'s hold is opt-in: another dialog still closes on Escape', async (make) => {
  const t = withNotice(make({ routes: usual() }));
  const overlay = t.doc.createElement('div');
  const box = t.doc.createElement('div');
  box.appendChild(t.doc.createElement('button'));
  overlay.appendChild(box);
  t.doc.body.appendChild(overlay);
  let closed = 0;
  t.win.WSUI.modal(overlay, { box, onClose() { closed += 1; } });
  escape(t);
  check('Escape closes a dialog without the hold', closed === 1);
  const held = t.win.WSUI.modal(overlay, { box, hold: true, onClose() { closed += 1; } });
  escape(t);
  check('a held one stays', closed === 1);
  held.release();
  escape(t);
  check('until it is released', closed === 2);
  await finish(t);
});

current = 'the inline card is gone, and Recently added sits beside Continue';
{
  check('no inline card, its buttons or its first-paint hold', !/id="booksNotice"/.test(BOOKS_HTML) && !/booksNoticeOkay|booksNoticeOff"|booksNoticeWords|bn-card|bn-inline/.test(BOOKS_HTML) &&
    !/data-books-notice\]/.test(BOOKS_HTML) && !/books_notice|data-books-notice/.test(LOADER));
  check('the window is hidden until opened, and its own display rule gives way to hidden', /<div id="booksNoticeWindow" class="bn-overlay" hidden>/.test(BOOKS_HTML) &&
    /\.bn-overlay\[hidden\] \{ display: none; \}/.test(BOOKS_HTML));
  check('the nudge shows only while Okay waits: scrolled to the end, on keyboard focus, and under a pointer that can hover (none on touch)',
    /\.bn-okay\[aria-disabled="true"\]\[data-books-notice-nudge\] \.bn-nudge,\s*\.bn-okay\[aria-disabled="true"\]:focus-visible \.bn-nudge \{ opacity: 1; \}/.test(BOOKS_HTML) &&
    /@media \(hover: hover\) \{\s*\.bn-okay\[aria-disabled="true"\]:hover \.bn-okay-say \{ opacity: 0; \}\s*\.bn-okay\[aria-disabled="true"\]:hover \.bn-nudge \{ opacity: 1; \}\s*\}/.test(BOOKS_HTML) &&
    BOOKS_HTML.split(':hover .bn-nudge').length === 2);
  check('Okay\'s two labels share one cell, so its width never changes when they trade', /\.bn-okay \{ display: inline-grid; place-items: center; \}/.test(BOOKS_HTML) &&
    /\.bn-okay > span \{ grid-area: 1 \/ 1;/.test(BOOKS_HTML));
  check('Okay\'s sweep runs 30 seconds, and Don\'t show again\'s 45', /\.bn-overlay \{\s*--bn-veil: [^;]+;\s*--bn-wait: 30s;/.test(BOOKS_HTML) &&
    /\.bn-count\.bn-count-quiet \{\s*--bn-wait: 45s;/.test(BOOKS_HTML));
  check('wide, with books in both: Recently added in a column of its own beside Continue, held from the first paint by the rows\' own flags',
    /@container \(min-width: 912px\) \{\s*html\[data-books-continue\]\[data-books-recent\] \.books-top \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\) 26rem;/.test(BOOKS_HTML) &&
    /\.books-top-area \{ container-type: inline-size; \}/.test(BOOKS_HTML));
  const win = new Window({ url: 'https://ws.test/books' });
  win.document.write(BOOKS_HTML);
  const d = win.document;
  const top = d.getElementById('continueArea');
  check('Continue then Recently added, together in that area, the sized wrapper around it', top.classList.contains('books-top') &&
    Array.from(top.children).map((c) => c.id).join() === 'continueHost,recentHost' && top.parentElement.classList.contains('books-top-area'));
  check('the search row (with Your stats) sits right above the library\'s filters', d.getElementById('searchRow').nextElementSibling === d.getElementById('libraryBody') &&
    d.getElementById('libraryBody').querySelector('#toolbarSkel') === d.getElementById('libraryBody').firstElementChild &&
    d.getElementById('searchRow').contains(d.getElementById('statsLink')) && d.getElementById('searchRow').contains(d.getElementById('helpBtn')));
  check('after every row above the library', !!(d.getElementById('browseRows').compareDocumentPosition(d.getElementById('searchRow')) & 4) &&
    d.getElementById('browseRows').contains(d.getElementById('popularHost')));
  check('its look is unchanged: the same row of controls', /^mb-6 flex items-center gap-2$/.test(d.getElementById('searchRow').className));
  win.happyDOM.close();
}

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
