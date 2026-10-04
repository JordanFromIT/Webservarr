// The book page, and the author, narrator and series pages (app/static/js/
// pages/book.js and books-list.js), run for real in happy-dom (a dev-only
// dependency) over the pages' own markup (book.html, books-person.html,
// books-series.html), with a scripted network, a fake clock, a fake shell
// (WS.swr and WS.arrive written as shell.js does them), a fake player and a
// fake Kavita hand-off helper. Covers: the skeleton and the one write that
// replaces it, both formats and each one missing, Kavita down and Plex down
// (disabled, with the reason), a person not yet connected to Kavita, the
// request links, Read's hand-off to the reader at the book's own chapter,
// Listen and the narrator picker (the preferred edition preselected, another
// one played when picked), the merged id's redirect, the not-found and error
// states, the person page and the series page in order (numbers first, none
// last), and names with punctuation and unicode going round through the
// links. Also the reader: it opens the chapter it is given.
//
// BOOK_JS=<path> / BOOKS_LIST_JS=<path> / READER_JS=<path> run the same cases
// against another copy of a module (how the cases were shown failing on the
// code before).
// Run: node app/tests/js/book_page.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const BOOK_PATH = process.env.BOOK_JS || join(STATIC, 'js/pages/book.js');
const LIST_PATH = process.env.BOOKS_LIST_JS || join(STATIC, 'js/pages/books-list.js');
const BOOKS_PATH = join(STATIC, 'js/pages/books.js');
const READER_PATH = process.env.READER_JS || join(STATIC, 'js/pages/reader.js');
const HTML = {
  book: readFileSync(join(STATIC, 'book.html'), 'utf8'),
  person: readFileSync(join(STATIC, 'books-person.html'), 'utf8'),
  series: readFileSync(join(STATIC, 'books-series.html'), 'utf8')
};
const READER_HTML = readFileSync(join(STATIC, 'reader.html'), 'utf8');

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
// A page module loads books.js from the address its page names in data-ws-dep
// (the server stamps it); here that address is books.js's own data: URL.

const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
const booksSrc = readFileSync(BOOKS_PATH, 'utf8');
const BOOKS_URL = dataUrl(booksSrc);
async function loadPage(path) {
  // (A copy of a module from before it named its dependency in the page, run with
  // BOOK_JS / BOOKS_LIST_JS, still has the import statement: pointed at the same data: URL.)
  const src = readFileSync(path, 'utf8').replace(/from\s+['"]\.\/books\.js(\?[^'"]*)?['"]/g, `from ${JSON.stringify(BOOKS_URL)}`);
  return import(dataUrl(src));
}
const bookModule = await loadPage(BOOK_PATH);
const listModule = await loadPage(LIST_PATH);

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
      if (!h) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      return Promise.resolve(h.fn(url, init)).then((r) => {
        const res = r || { body: {} };
        const status = res.status || 200;
        return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(res.body), text: () => Promise.resolve(typeof res.body === 'string' ? res.body : JSON.stringify(res.body)) };
      });
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ---- The shell, as shell.js has it ----

function fakeShell(doc, clock, net) {
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
        if (!r.ok) {
          return r.json().then((body) => { const e = new Error('HTTP ' + r.status); e.status = r.status; e.body = body; throw e; });
        }
        return r.json();
      });
    },
    leaveTo(url) { WS.left.push(url); },
    dropCache(prefix) { for (const k of Array.from(store.keys())) if (k.indexOf(prefix) === 0) store.delete(k); },
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

function visit(kind, o = {}) {
  const url = o.url || (kind === 'book' ? 'https://ws.test/books/2' : kind === 'person' ? 'https://ws.test/books/person?role=author&name=J.K.%20Rowling' : 'https://ws.test/books/series?name=Harry%20Potter');
  const win = new Window({ url });
  const doc = win.document;
  doc.body.innerHTML = HTML[kind].match(NAV)[0].replace(/<\/main>$/, '');
  doc.getElementById('wsPage').setAttribute('data-ws-dep', BOOKS_URL);
  const clock = fakeClock();
  const net = network();
  const ctl = new win.AbortController();
  const WS = fakeShell(doc, clock, net);
  const kav = { init: 0, failedChecks: 0, reconnect: [], retry: 0, blockNext: false };
  const toasts = [];
  const titles = [];
  const replaced = [];
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win);
  set('document', doc);
  set('localStorage', win.localStorage);
  set('WS', WS);
  win.WS = WS;
  if (o.branding) WS.data.branding = o.branding;
  win.WSUI = { toast(m, k) { toasts.push([m, k]); } };
  set('WSUI', win.WSUI);
  // Writes (books.js sendBooks) go through window.fetch: the same scripted network.
  win.fetch = (u, init) => net.fetch(u, init);
  win.history.replaceState = function (state, title, to) { replaced.push(to); };
  if (o.kavita !== false) {
    win.WSKavita = {
      init() { kav.init += 1; },
      reconnect(cb) { kav.reconnect.push(cb); if (kav.blockNext) cb(); },
      retry() { kav.retry += 1; },
      arrivedFromFailedConnect() { kav.failedChecks += 1; return false; }
    };
  }
  // The player: which book it holds and whether it plays; change listeners as the engine has them.
  // Samples as engine.js boot has them: sample(key), stopSample(), sampleState()
  // and 'sample-change' events (sampleChange() sends one).
  const player = {
    opened: [], toggled: 0, listeners: [], st: { book: null, playing: false, loading: false, error: null },
    sampled: [], stops: 0, sampleListeners: [], ss: null, sampleAnswer: true,
    open(key, opts) { this.opened.push([key, opts]); return Promise.resolve(); },
    toggle() { this.toggled += 1; },
    state() { return this.st; },
    on(name, fn) {
      if (name === 'sample-change') {
        this.sampleListeners.push(fn);
        return () => { this.sampleListeners = this.sampleListeners.filter((x) => x !== fn); };
      }
      this.listeners.push(fn);
      return () => { this.listeners = this.listeners.filter((x) => x !== fn); };
    },
    change(st) { this.st = Object.assign({}, this.st, st); this.listeners.slice().forEach((fn) => fn()); },
    sample(key) {
      this.sampled.push(key);
      this.sampleChange('start', { book: key, title: '', playing: false, loading: true, bookMs: 0, leftMs: 300000 });
      return Promise.resolve(this.sampleAnswer);
    },
    stopSample() { this.stops += 1; const had = !!this.ss; if (had) this.sampleChange('stop', null); return had; },
    sampleState() { return this.ss; },
    sampleChange(reason, ss, error) {
      this.ss = ss;
      this.sampleListeners.slice().forEach((fn) => fn({ reason, sample: ss, error: error || null }));
    }
  };
  if (o.player !== false) win.WS.player = player;
  if (o.routes) o.routes(net);
  const ctx = {
    root: doc.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL(url),
    data: WS.data,
    poll() { return () => {}; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setTitle(t) { titles.push(t); }
  };
  WS.arriveReset();
  return {
    win, doc, clock, net, ctl, WS, kav, toasts, titles, replaced, player, ctx,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    text: (sel) => (doc.querySelector(sel) || { textContent: null }).textContent,
    mount: () => (kind === 'book' ? bookModule : listModule).mount(ctx),
    release() {
      for (const k of Object.keys(saved)) {
        if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k];
      }
    },
    click(sel) { doc.querySelector(sel).click(); },
    change(sel, value) {
      const n = doc.querySelector(sel);
      n.value = value;
      n.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  };
}

async function run(name, fn) {
  current = name;
  const made = [];
  try {
    await fn((kind, o) => { const t = visit(kind, o); made.push(t); return t; });
  } catch (e) {
    failed += 1;
    total += 1;
    report(`FAIL ${name}: threw ${e && e.stack || e}`);
  } finally {
    while (made.length) { const t = made.pop(); t.ctl.abort(); t.release(); }
  }
}

// ---- What the API answers ----

const EDITIONS = [
  { plex_book_key: '100:1', narrator: 'Jim Dale', progress: null, in_progress: false },
  { plex_book_key: '100:2', narrator: 'Full Cast', progress: { percent: 25, label: '9h left', updated_at: '2026-10-01T10:00:00Z', finished: false }, in_progress: true },
  { plex_book_key: '100:3', narrator: 'Stephen Fry', progress: { percent: 100, label: 'Finished', updated_at: '2026-09-01T10:00:00Z', finished: true }, in_progress: false }
];
const EBOOK = { available: true, progress: { percent: 43, label: 'Ch. 12 · 43%', updated_at: '2026-09-20T10:00:00Z', finished: false }, read_url: '/reader?seriesId=5&chapterId=77' };

function detail(over = {}) {
  const base = {
    book: {
      id: 2, title: 'Harry Potter and the Prisoner of Azkaban', author: 'J.K. Rowling', series: 'Harry Potter', series_number: 3.0,
      description: 'Sirius Black has escaped.\n\nA third year at Hogwarts begins.', narrators: ['Jim Dale', 'Full Cast', 'Stephen Fry'],
      cover_url: '/api/books/2/cover?v=1', added_at: '2026-09-01T00:00:00Z'
    },
    formats: { ebook: EBOOK, audio: { available: true, editions: EDITIONS, preferred: '100:2' } },
    request_links: { ebook: null, audio: null },
    notes: []
  };
  const out = Object.assign({}, base, over);
  if (over.book) out.book = Object.assign({}, base.book, over.book);
  if (over.formats) out.formats = Object.assign({}, base.formats, over.formats);
  return out;
}

const bookRoutes = (answer) => (net) => net.on('/api/books/', () => (typeof answer === 'function' ? answer() : { body: answer }));

async function open(make, answer, o = {}) {
  const t = make('book', Object.assign({ routes: bookRoutes(answer) }, o));
  const mounted = t.mount();
  await t.clock.advance(1600);
  await mounted;
  return t;
}

const ONLY_AUDIO_ONE = [EDITIONS[0]];
const rr = (n) => (n || '').replace(/\s+/g, ' ').trim();
// A control's own words: its verb and the line under it (the icon's name is not one of them).
const label = (t, action) => rr(t.text(`[data-action="${action}"] [data-label]`));
const sub = (t, action) => rr(t.text(`[data-action="${action}"] [data-sub]`));

// ---------------------------------------------------------------------------
// The book page
// ---------------------------------------------------------------------------

await run('the skeleton holds the page, then one write replaces what follows the title', async (make) => {
  const slow = deferred();
  const t = make('book', { routes: (net) => net.on('/api/books/', () => slow.promise.then(() => ({ body: detail() }))) });
  const rest = t.q('#bookRest');
  const mounted = t.mount();
  await flush();
  check('the skeleton is on screen and hidden from a screen reader', t.q('#bookRest') === rest && rest.getAttribute('aria-hidden') === 'true');
  check('the section is still busy', t.q('#bookView').getAttribute('aria-busy') === 'true');
  check('the skeleton has the two buttons\' shape', t.qa('#bookRest .skel.h-14').length === 2);
  check('it asked for this book, by the address\'s id', t.net.urls('/api/books/')[0] === '/api/books/2', t.net.urls('/api/books/'));
  check('the visit started the Kavita helper', t.kav.init === 1);
  slow.resolve();
  await t.clock.advance(1600);
  await mounted;
  check('the title is in the h1 (the heading stays)', t.text('#bookTitle') === 'Harry Potter and the Prisoner of Azkaban' && t.qa('#bookTitle').length === 1);
  check('and no skeleton text is left in it', t.qa('#bookTitle .skel-text').length === 0);
  check('what follows the title is a new element, not the skeleton moved', t.q('#bookRest') !== rest && !rest.isConnected);
  check('the new part is for everyone to read', t.q('#bookRest').getAttribute('aria-hidden') === null);
  check('the section is no longer busy', t.q('#bookView').getAttribute('aria-busy') === 'false');
  check('the tab is titled with the book', t.titles.indexOf('Harry Potter and the Prisoner of Azkaban') !== -1, t.titles);
  check('the cover is the book\'s own', !!t.q('#bookCover img') && t.q('#bookCover img').getAttribute('src') === '/api/books/2/cover?v=1');
  check('the cover holds a 2:3 box', /aspect-\[2\/3\]/.test(t.q('#bookCover').innerHTML));
  check('the cover is what the page waits for: loaded at once, not lazily', t.q('#bookCover img').getAttribute('loading') === 'eager' && t.q('#bookCover img').getAttribute('fetchpriority') === 'high');
  check('the cover has no format badges (the buttons say it)', t.qa('#bookCover [data-format]').length === 0);
  check('the page arrived as one section', t.WS.arrived.join(',') === 'book', t.WS.arrived);
});

await run('both formats: Read and Listen with the person\'s progress', async (make) => {
  const t = await open(make, detail());
  const read = t.q('[data-action="read"]');
  const listen = t.q('[data-action="listen"]');
  check('Read is a link to the reader at the book\'s chapter', !!read && read.tagName === 'A' && read.getAttribute('href') === '/reader?seriesId=5&chapterId=77', read && read.getAttribute('href'));
  check('Read says Read and where they are', label(t, 'read') === 'Read' && sub(t, 'read') === 'Ch. 12 · 43%', [label(t, 'read'), sub(t, 'read')]);
  check('Listen is a button', !!listen && listen.tagName === 'BUTTON' && listen.getAttribute('type') === 'button');
  check('Listen says Listen and where they are (the preferred edition\'s place)', label(t, 'listen') === 'Listen' && sub(t, 'listen') === '9h left', [label(t, 'listen'), sub(t, 'listen')]);
  check('no request link when both exist', t.qa('[data-request]').length === 0);
  check('both are in their own slots, ebook first', t.qa('[data-slot]').map((n) => n.getAttribute('data-slot')).join() === 'ebook,audio');
  check('a progress bar shows a started format', t.qa('[data-action="read"] [data-bar]').length === 1 && t.q('[data-action="read"] [data-bar] > span').style.width === '43%');
  check('one of the two is the main action, the other quiet', /bg-primary/.test(listen.className) !== /bg-primary/.test(read.className));
  check('the one used last (the audio place is newer) is the main one', /bg-primary/.test(listen.className));
  check('a button is at least 44 px tall', /min-h-14/.test(read.className) && /min-h-14/.test(listen.className));
});

await run('the main action is the Read button when the ebook place is the newer one, and by default', async (make) => {
  const newer = detail({ formats: { ebook: Object.assign({}, EBOOK, { progress: Object.assign({}, EBOOK.progress, { updated_at: '2026-10-03T10:00:00Z' }) }), audio: { available: true, editions: EDITIONS, preferred: '100:2' } } });
  const t = await open(make, newer);
  check('the newer place leads', /bg-primary/.test(t.q('[data-action="read"]').className) && !/bg-primary/.test(t.q('[data-action="listen"]').className));
  const none = detail({ formats: { ebook: Object.assign({}, EBOOK, { progress: null }), audio: { available: true, editions: [EDITIONS[0]], preferred: '100:1' } } });
  const u = await open(make, none);
  check('nothing started: Read leads', /bg-primary/.test(u.q('[data-action="read"]').className));
  check('and says it has not been started', /Not started/.test(u.q('[data-action="read"]').textContent) && /Not started/.test(u.q('[data-action="listen"]').textContent));
  check('no progress bar without a place', u.qa('[data-bar]').length === 0);
});

await run('Read leaves a finished book readable again', async (make) => {
  const done = detail({ formats: { ebook: Object.assign({}, EBOOK, { progress: { percent: 100, label: 'Finished', updated_at: 't', finished: true } }), audio: null }, request_links: { ebook: null, audio: '/requests?q=x' } });
  const t = await open(make, done);
  check('it says Finished', /Finished/.test(t.q('[data-action="read"]').textContent));
  check('and is still a link to the reader', t.q('[data-action="read"]').getAttribute('href') === '/reader?seriesId=5&chapterId=77');
});

await run('ebook only: Listen is a request link', async (make) => {
  const t = await open(make, detail({ formats: { ebook: EBOOK, audio: null }, request_links: { ebook: null, audio: '/requests?q=Harry%20Potter%20and%20the%20Prisoner%20of%20Azkaban%20J.K.%20Rowling' } }));
  const ask = t.q('[data-request="audio"]');
  check('there is no Listen button', !t.q('[data-action="listen"]'));
  check('a link asks for the audiobook, in the audio slot', !!ask && ask.tagName === 'A' && ask.closest('[data-slot]').getAttribute('data-slot') === 'audio');
  check('it says Request the audiobook', /Request the audiobook/.test(ask.textContent), rr(ask.textContent));
  check('it goes to Requests with the title and author', ask.getAttribute('href') === '/requests?q=Harry%20Potter%20and%20the%20Prisoner%20of%20Azkaban%20J.K.%20Rowling', ask.getAttribute('href'));
  check('and says there is none yet', /No audiobook in the library yet/.test(ask.textContent));
  check('Read still works', t.q('[data-action="read"]').getAttribute('href') === '/reader?seriesId=5&chapterId=77');
  check('no narrator picker', !t.q('#narratorSelect'));
});

await run('audio only: Read is a request link', async (make) => {
  const t = await open(make, detail({ formats: { ebook: null, audio: { available: true, editions: [EDITIONS[0]], preferred: '100:1' } }, request_links: { ebook: '/requests?q=x%20y', audio: null }, book: { narrators: ['Jim Dale'] } }));
  const ask = t.q('[data-request="ebook"]');
  check('there is no Read button', !t.q('[data-action="read"]'));
  check('the link asks for the ebook', !!ask && /Request the ebook/.test(ask.textContent) && ask.getAttribute('href') === '/requests?q=x%20y');
  check('Listen still plays', !!t.q('[data-action="listen"]'));
});

await run('no request link when the site sends requests to the Seerr embed, or the link is not Requests\'s', async (make) => {
  const t = await open(make, detail({ formats: { ebook: EBOOK, audio: null }, request_links: { ebook: null, audio: '/requests?q=x' } }), { branding: { requests_source: 'seerr_embed' } });
  check('embed: no request link (Requests there is Seerr\'s own page)', t.qa('[data-request]').length === 0 && !t.q('[data-action="listen"]'));
  const u = await open(make, detail({ formats: { ebook: EBOOK, audio: null }, request_links: { ebook: null, audio: 'https://elsewhere.example/?q=x' } }));
  check('a link that is not /requests?q= is never used', u.qa('[data-request]').length === 0);
  const w = await open(make, detail({ formats: { ebook: EBOOK, audio: null }, request_links: { ebook: null, audio: 'javascript:alert(1)' } }));
  check('nor a script address', w.qa('[data-request]').length === 0 && w.qa('a[href^="javascript"]').length === 0);
});

await run('a format hidden from this person is not shown at all, and not offered for request', async (make) => {
  const t = await open(make, detail({ formats: { ebook: EBOOK, audio: null }, request_links: { ebook: null, audio: null }, notes: [] }));
  check('no Listen, no request, no disabled stand-in', !t.q('[data-action="listen"]') && t.qa('[data-request]').length === 0 && t.qa('[data-slot="audio"]').length === 0);
});

await run('Kavita down: Read is disabled and says why; Listen works', async (make) => {
  const t = await open(make, detail({ formats: { ebook: null, audio: { available: true, editions: EDITIONS, preferred: '100:2' } },
    notes: [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }] }));
  const read = t.q('[data-action="read"]');
  check('Read is there and disabled', !!read && read.disabled === true, read && read.outerHTML.slice(0, 80));
  check('it says Ebooks are unavailable right now', /Ebooks are unavailable right now/.test(read.textContent), rr(read.textContent));
  check('it is not a link', read.tagName === 'BUTTON' && !read.getAttribute('href'));
  check('Listen is enabled', t.q('[data-action="listen"]').disabled === false);
  check('no request link for a format that exists', t.qa('[data-request]').length === 0);
  check('no hand-off for a Kavita that is down', t.kav.reconnect.length === 0);
  check('no progress bar on a disabled button', t.qa('[data-action="read"] [data-bar]').length === 0);
});

await run('Plex down: Listen is disabled and says why; Read works', async (make) => {
  const t = await open(make, detail({ formats: { ebook: EBOOK, audio: null },
    notes: [{ source: 'plex', reason: 'unavailable', text: 'Audiobooks are unavailable right now' }] }));
  const listen = t.q('[data-action="listen"]');
  check('Listen is there and disabled', !!listen && listen.disabled === true);
  check('it says Audiobooks are unavailable right now', /Audiobooks are unavailable right now/.test(listen.textContent), rr(listen.textContent));
  check('Read is a link', t.q('[data-action="read"]').tagName === 'A');
  t.click('[data-action="listen"]');
  await flush();
  check('pressing it opens nothing', t.player.opened.length === 0);
});

await run('Kavita up but the ebook place could not be read: Read works and says so', async (make) => {
  const t = await open(make, detail({ formats: { ebook: Object.assign({}, EBOOK, { progress: null }), audio: null }, request_links: { ebook: null, audio: null },
    notes: [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }] }));
  check('Read is a link and enabled', t.q('[data-action="read"]').tagName === 'A');
  check('it does not claim the book is not started', !/Not started/.test(t.q('[data-action="read"]').textContent) && /Progress unavailable/.test(t.q('[data-action="read"]').textContent), rr(t.q('[data-action="read"]').textContent));
});

await run('not yet connected to Kavita: one hand-off, and Read is the way to try again', async (make) => {
  const note = [{ source: 'kavita', reason: 'not_connected', text: 'Connect to your ebook library to see ebooks' }];
  const t = await open(make, detail({ formats: { ebook: null, audio: { available: true, editions: EDITIONS, preferred: '100:2' } }, notes: note }));
  check('the hand-off was started once', t.kav.reconnect.length === 1, t.kav.reconnect.length);
  const read = t.q('[data-action="read"]');
  check('Read is a button that says how to connect', !!read && read.tagName === 'BUTTON' && !read.disabled && /Connect your ebook library/.test(read.textContent), rr(read && read.textContent));
  t.click('[data-action="read"]');
  check('pressing it tries again through the helper', t.kav.retry === 1);
  // Refused (tried a minute ago, or the last sign-in failed): the page says so, once.
  const u = await open(make, detail({ formats: { ebook: null, audio: { available: true, editions: EDITIONS, preferred: '100:2' } }, notes: note }), {});
  check('the hand-off ran once here too, not again on a redraw', u.kav.reconnect.length === 1);
  const v = make('book', { routes: bookRoutes(detail({ formats: { ebook: null, audio: { available: true, editions: EDITIONS, preferred: '100:2' } }, notes: note })) });
  v.kav.blockNext = true;
  const m = v.mount();
  await v.clock.advance(1600);
  await m;
  check('a refused hand-off says the sign-in did not work', /couldn.t connect/i.test(v.q('[data-action="read"]').textContent), rr(v.q('[data-action="read"]').textContent));
  check('Listen is untouched', !!v.q('[data-action="listen"]') && !v.q('[data-action="listen"]').disabled);
});

await run('Listen opens the player at the preferred edition and plays', async (make) => {
  const t = await open(make, detail());
  check('the picker is there, with the preferred edition selected', !!t.q('#narratorSelect') && t.q('#narratorSelect').value === '100:2', t.q('#narratorSelect') && t.q('#narratorSelect').value);
  check('it lists every narrator once', t.qa('#narratorSelect option').map((o) => o.value).join() === '100:1,100:2,100:3');
  check('with their places beside them', /Full Cast/.test(t.qa('#narratorSelect option')[1].textContent) && /9h left/.test(t.qa('#narratorSelect option')[1].textContent) && /Finished/.test(t.qa('#narratorSelect option')[2].textContent), t.qa('#narratorSelect option').map((o) => o.textContent));
  check('a narrator with no place is just the name', rr(t.qa('#narratorSelect option')[0].textContent) === 'Jim Dale', t.qa('#narratorSelect option')[0].textContent);
  check('the picker has a label', !!t.q('label[for="narratorSelect"]'));
  t.click('[data-action="listen"]');
  await flush();
  check('the player was opened with the preferred edition, playing', t.player.opened.length === 1 && t.player.opened[0][0] === '100:2' && t.player.opened[0][1].autoplay === true, t.player.opened);
  check('and a Continue row is now told to Books and Home for the next visit (Task 5)', t.win.localStorage.getItem('webservarr_books_continue:sam') === '1');
});

await run('Listen that cannot open the book tells no Continue row', async (make) => {
  const t = await open(make, detail());
  t.player.open = () => Promise.reject(new Error('the saved place is not in the book'));
  const warn = console.warn;
  console.warn = () => {};          // the page logs the refusal; this test is about what it remembers
  t.click('[data-action="listen"]');
  await flush();
  console.warn = warn;
  check('a refused open leaves the memory alone', t.win.localStorage.getItem('webservarr_books_continue:sam') === null);
});

await run('picking another narrator plays that edition', async (make) => {
  const t = await open(make, detail());
  t.change('#narratorSelect', '100:3');
  await flush();
  check('the button now shows that edition\'s place', /Finished/.test(t.q('[data-action="listen"]').textContent) && !/9h left/.test(t.q('[data-action="listen"]').textContent), rr(t.q('[data-action="listen"]').textContent));
  check('picking alone plays nothing', t.player.opened.length === 0);
  t.click('[data-action="listen"]');
  await flush();
  check('Listen opens the picked edition', t.player.opened.length === 1 && t.player.opened[0][0] === '100:3', t.player.opened);
  t.change('#narratorSelect', '100:1');
  await flush();
  check('an edition with no place says Not started', /Not started/.test(t.q('[data-action="listen"]').textContent));
  t.click('[data-action="listen"]');
  await flush();
  check('and plays that one', t.player.opened.length === 2 && t.player.opened[1][0] === '100:1');
  check('the picker keeps the choice', t.q('#narratorSelect').value === '100:1');
  t.change('#narratorSelect', 'not-an-edition');
  await flush();
  check('a value that is not an edition changes nothing', t.q('#narratorSelect').value === '100:1' || /Not started/.test(t.q('[data-action="listen"]').textContent));
});

await run('one edition: no picker, the narrator is named', async (make) => {
  const t = await open(make, detail({ formats: { ebook: EBOOK, audio: { available: true, editions: ONLY_AUDIO_ONE, preferred: '100:1' } }, book: { narrators: ['Jim Dale'] } }));
  check('no picker for one narrator', !t.q('#narratorSelect'));
  t.click('[data-action="listen"]');
  await flush();
  check('Listen plays the one edition', t.player.opened[0][0] === '100:1');
  check('the narrator is in the byline', /Narrated by/.test(t.text('#bookRest')) && /Jim Dale/.test(t.text('#bookRest')));
});

await run('Listen follows the player: Pause while this edition plays, toggles instead of opening again', async (make) => {
  const t = await open(make, detail());
  t.player.change({ book: '100:2', playing: true });
  await flush();
  check('it says Pause while this edition plays', label(t, 'listen') === 'Pause', label(t, 'listen'));
  t.click('[data-action="listen"]');
  await flush();
  check('pressing it toggles the player and opens nothing', t.player.toggled === 1 && t.player.opened.length === 0);
  t.player.change({ playing: false });
  await flush();
  check('paused: it says Listen again', label(t, 'listen') === 'Listen', label(t, 'listen'));
  t.change('#narratorSelect', '100:1');
  await flush();
  t.player.change({ book: '100:2', playing: true });
  await flush();
  t.change('#narratorSelect', '100:1');
  await flush();
  t.player.change({ book: '100:1', playing: true, loading: false, bookMs: 4000 });
  await flush();
  check('an edition with no saved place says In progress once it plays', sub(t, 'listen') === 'In progress', sub(t, 'listen'));
  t.player.change({ book: '100:2', playing: false, bookMs: 0 });
  await flush();
  t.change('#narratorSelect', '100:2');
  await flush();
  t.change('#narratorSelect', '100:1');
  await flush();
  t.player.change({ book: '100:2', playing: true });
  await flush();
  check('another edition picked while this one plays: it still says Listen (it would switch)', label(t, 'listen') === 'Listen', label(t, 'listen'));
  t.player.change({ book: '100:1', playing: false, loading: true });
  await flush();
  check('opening is shown, and the button waits', /Opening/.test(t.q('[data-action="listen"]').textContent) && t.q('[data-action="listen"]').disabled === true);
  t.ctl.abort();
  const before = t.player.listeners.length;
  check('leaving the page stops watching the player', before === 0, before);
});

await run('no player yet: Listen says so and does not throw', async (make) => {
  const t = await open(make, detail(), { player: false });
  t.click('[data-action="listen"]');
  await flush();
  check('a toast says the player is not ready', t.toasts.length === 1 && /player/i.test(t.toasts[0][0]) && t.toasts[0][1] === 'err', t.toasts);
});

await run('a player that refuses the book is the player\'s to show', async (make) => {
  const t = await open(make, detail());
  t.player.open = () => Promise.reject(new Error('no'));
  const warn = console.warn;
  console.warn = () => {};
  try { t.click('[data-action="listen"]'); await flush(); } finally { console.warn = warn; }
  check('the page stays up and enabled', t.q('[data-action="listen"]').disabled === false);
});

await run('author, narrators and series are links, and names survive the trip', async (make) => {
  const names = ['J. R. R. Tolkien', 'Le Guin, Ursula K.', 'AC/DC & Co', 'Brontë', 'Zoë "Z" O\'Neil #1', '100% 50/50', '日本語 作者', 'a+b=c?d'];
  for (const name of names) {
    const t = await open(make, detail({ book: { author: name, series: name + ' Saga', narrators: [name + ' II', 'Full Cast'] },
      formats: { ebook: EBOOK, audio: { available: true, editions: [{ plex_book_key: '1:1', narrator: name + ' II', progress: null, in_progress: false }, { plex_book_key: '1:2', narrator: 'Full Cast', progress: null, in_progress: false }], preferred: '1:1' } } }));
    const a = t.q('a[data-person="author"]');
    const author = new URL(a.getAttribute('href'), 'https://ws.test');
    check(`${name}: the author link goes to the person page`, author.pathname === '/books/person' && author.searchParams.get('role') === 'author' && author.searchParams.get('name') === name, a.getAttribute('href'));
    check(`${name}: the author link\'s text is the name`, a.textContent === name);
    const n = t.qa('a[data-person="narrator"]').map((x) => { const u = new URL(x.getAttribute('href'), 'https://ws.test'); return [u.pathname, u.searchParams.get('role'), u.searchParams.get('name'), x.textContent]; });
    check(`${name}: each narrator links with its own name`, JSON.stringify(n) === JSON.stringify([['/books/person', 'narrator', name + ' II', name + ' II'], ['/books/person', 'narrator', 'Full Cast', 'Full Cast']]), n);
    const s = t.q('a[data-series-link]');
    const series = new URL(s.getAttribute('href'), 'https://ws.test');
    check(`${name}: the series link goes to the series page`, series.pathname === '/books/series' && series.searchParams.get('name') === name + ' Saga' && [...series.searchParams.keys()].join() === 'name', s.getAttribute('href'));
    check(`${name}: the address carries no raw name`, a.getAttribute('href').indexOf(name) === -1 || /^[\w .]+$/.test(name));
  }
});

await run('the series line says which book it is', async (make) => {
  const t = await open(make, detail());
  check('Book 3 of Harry Potter (the number prints whole)', /Book 3 of/.test(t.text('#bookRest')) && !/3\.0/.test(t.text('#bookRest')), rr(t.text('#bookRest')));
  const u = await open(make, detail({ book: { series_number: 2.5 } }));
  check('a part number keeps its fraction', /Book 2\.5 of/.test(u.text('#bookRest')));
  const v = await open(make, detail({ book: { series_number: null } }));
  check('no number: just the series', /Harry Potter/.test(v.text('#bookRest')) && !/Book null|Book 0|Book of/.test(v.text('#bookRest')) && !!v.q('a[data-series-link]'));
  const w = await open(make, detail({ book: { series: '', series_number: null } }));
  check('no series: no series line', !w.q('a[data-series-link]'));
  const x = await open(make, detail({ book: { author: '', narrators: [] }, formats: { ebook: EBOOK, audio: null }, request_links: { ebook: null, audio: '/requests?q=x' } }));
  check('no author and no narrator: no byline, no empty links', !x.q('a[data-person]') && !/\bBy\b|Narrated by/.test(x.text('#bookRest')));
});

await run('the description is read as text, in paragraphs, and long ones fold', async (make) => {
  const t = await open(make, detail({ book: { title: '<img src=x onerror=alert(1)> & <b>bold</b>', description: '<script>alert(1)</script>First.\n\nSecond <i>line</i>.' } }));
  check('markup in a title is shown as text', t.text('#bookTitle') === '<img src=x onerror=alert(1)> & <b>bold</b>' && !t.q('#bookTitle img') && !t.q('#bookTitle b'));
  check('markup in a description is shown as text', !t.q('#bookAbout script') && !t.q('#bookAbout i') && /<script>alert\(1\)<\/script>First\./.test(t.text('#bookAbout')));
  check('paragraphs split on blank lines', t.qa('#bookAbout p').length === 2, t.qa('#bookAbout p').length);
  check('a short description does not fold', !t.q('#aboutToggle'));
  const long = Array.from({ length: 12 }, (_, i) => 'Sentence number ' + i + ' of a long description that goes on.').join(' ');
  const u = await open(make, detail({ book: { description: long } }));
  const toggle = u.q('#aboutToggle');
  check('a long one folds behind a button', !!toggle && toggle.getAttribute('aria-expanded') === 'false' && /Show more/.test(toggle.textContent));
  check('folded text is clamped', /line-clamp-4/.test(u.q('#bookAbout').innerHTML));
  u.click('#aboutToggle');
  check('it opens', u.q('#aboutToggle').getAttribute('aria-expanded') === 'true' && /Show less/.test(u.q('#aboutToggle').textContent) && !/line-clamp-4/.test(u.q('#bookAbout').innerHTML));
  u.click('#aboutToggle');
  check('and folds again', u.q('#aboutToggle').getAttribute('aria-expanded') === 'false');
  const v = await open(make, detail({ book: { description: '' } }));
  check('no description, no empty block', !v.q('#bookAbout') || v.q('#bookAbout').textContent === '');
});

await run('Read\'s link must be the reader\'s', async (make) => {
  const t = await open(make, detail({ formats: { ebook: Object.assign({}, EBOOK, { read_url: 'https://elsewhere.example/reader?x=1' }), audio: null }, request_links: { ebook: null, audio: '/requests?q=x' } }));
  check('an address that is not /reader? is never linked', !t.q('a[data-action="read"]') && !!t.q('[data-action="read"]') && t.q('[data-action="read"]').disabled === true);
  const u = await open(make, detail({ formats: { ebook: Object.assign({}, EBOOK, { read_url: 'javascript:alert(1)' }), audio: null }, request_links: { ebook: null, audio: '/requests?q=x' } }));
  check('nor a script address', u.qa('a[href^="javascript"]').length === 0);
});

await run('a merged id: the answer\'s book is the page, and the address follows it', async (make) => {
  const t = await open(make, detail({ book: { id: 4, title: 'The Survivor' } }), { url: 'https://ws.test/books/9' });
  check('the old id was asked for', t.net.urls('/api/books/')[0] === '/api/books/9');
  check('the page shows the surviving book', t.text('#bookTitle') === 'The Survivor');
  check('the address is replaced (no new history entry) with the surviving id', t.replaced.length === 1 && t.replaced[0] === '/books/4', t.replaced);
  const u = await open(make, detail({ book: { id: 2 } }), { url: 'https://ws.test/books/2' });
  check('the same id leaves the address alone', u.replaced.length === 0);
  const v = await open(make, detail({ book: { id: 2 } }), { url: 'https://ws.test/books/2?from=search' });
  check('a query on the address is kept when it is left alone', v.replaced.length === 0);
  const w = await open(make, detail({ book: { id: 4 } }), { url: 'https://ws.test/books/9?from=search#x' });
  check('and when it is replaced', w.replaced[0] === '/books/4?from=search#x', w.replaced);
});

await run('not found: a plain message and the way back', async (make) => {
  const t = await open(make, () => ({ status: 404, body: { detail: 'No such book' } }));
  const box = t.q('[data-state="notfound"]');
  check('the not-found message shows, under a heading that says it', !!box && /couldn.t find that book/i.test(t.text('#bookTitle')) && /removed from the library/.test(box.textContent), [t.text('#bookTitle'), box && box.textContent]);
  check('it offers Books', !!box.querySelector('a[href="/books"]'));
  check('nothing says "404", "undefined" or a vendor', !/404|undefined|Kavita|Plex/.test(t.text('#bookView')));
  check('the cover is the placeholder', !t.q('#bookCover img'));
  check('no skeleton is left', t.qa('#bookView .skel').length === 0);
  check('no retry for a book that is not there', !t.q('#retryBtn'));
  check('the section is not busy', t.q('#bookView').getAttribute('aria-busy') === 'false');
  const u = make('book', { url: 'https://ws.test/books/abc', routes: bookRoutes(detail()) });
  const m = u.mount();
  await u.clock.advance(1600);
  await m;
  check('an id that is not a number is not asked for', u.net.urls('/api/books/').length === 0 && !!u.q('[data-state="notfound"]'));
  const v = make('book', { url: 'https://ws.test/books/99999999999', routes: bookRoutes(detail()) });
  const m2 = v.mount();
  await v.clock.advance(1600);
  await m2;
  check('nor one too big to be an id', v.net.urls('/api/books/').length === 0 && !!v.q('[data-state="notfound"]'));
});

await run('an error: what happened, and Try again that works', async (make) => {
  let down = true;
  const t = make('book', { routes: bookRoutes(() => (down ? { status: 503, body: { detail: 'x' } } : { body: detail() })) });
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  const box = t.q('[data-state="error"]');
  check('the error shows under a heading that says what happened, with no code in it', !!box && /couldn.t load this book/i.test(t.text('#bookTitle')) && /Try again in a moment/.test(box.textContent) && !/503|HTTP|undefined/.test(t.text('#bookView')), [t.text('#bookTitle'), box && box.textContent]);
  check('with Try again', !!t.q('#retryBtn'));
  check('the section is not busy', t.q('#bookView').getAttribute('aria-busy') === 'false');
  down = false;
  t.click('#retryBtn');
  await t.clock.advance(1600);
  check('Try again loads the book', t.text('#bookTitle') === 'Harry Potter and the Prisoner of Azkaban' && !t.q('[data-state="error"]'));
  check('it asked again', t.net.urls('/api/books/').length === 2);
});

await run('leaving the page: a late answer changes nothing', async (make) => {
  const slow = deferred();
  const t = make('book', { routes: (net) => net.on('/api/books/', () => slow.promise.then(() => ({ body: detail() }))) });
  const m = t.mount();
  await flush();
  t.ctl.abort();
  slow.resolve();
  await t.clock.advance(1600);
  await m.catch(() => {});
  check('the skeleton is as it was', t.qa('#bookRest .skel').length > 0 && t.qa('[data-action]').length === 0);
  check('no title was set', t.titles.length === 0);
  check('the request was on the visit\'s signal', !!t.net.calls[0].init && t.net.calls[0].init.signal === t.ctl.signal);
});

await run('a repeat visit paints at once from the kept copy and then settles to the live one', async (make) => {
  const first = detail();
  const t = make('book', { routes: bookRoutes(first) });
  let m = t.mount();
  await t.clock.advance(1600);
  await m;
  check('first visit drew the book', t.qa('[data-action="read"], [data-action="listen"]').length === 2);
  // Same window, same store: mount again with a changed live answer.
  t.net.on('/api/books/', () => ({ body: detail({ formats: { ebook: Object.assign({}, EBOOK, { progress: Object.assign({}, EBOOK.progress, { label: 'Ch. 13 · 50%', percent: 50 }) }), audio: { available: true, editions: EDITIONS, preferred: '100:2' } } }) }));
  m = bookModule.mount(t.ctx);
  await t.clock.advance(1600);
  await m;
  check('the live place replaces the kept one', /Ch\. 13 · 50%/.test(t.q('[data-action="read"]').textContent), rr(t.q('[data-action="read"]').textContent));
  check('and the page holds one set of buttons', t.qa('[data-action="read"]').length === 1);
});

await run('a double press on Listen opens the player once: the engine holds no book while it fetches one', async (make) => {
  const t = await open(make, detail());
  // As the real engine: open() is slow, and state().book stays null until the book is in.
  const slow = deferred();
  t.player.open = function (key, opts) { this.opened.push([key, opts]); return slow.promise; };
  t.click('[data-action="listen"]');
  t.click('[data-action="listen"]');
  await flush();
  check('the second press opened nothing more', t.player.opened.length === 1, t.player.opened);
  check('the player still holds no book', t.player.state().book === null);
  check('the button says Opening and waits', label(t, 'listen') === 'Opening…' && t.q('[data-action="listen"]').disabled === true, label(t, 'listen'));
  t.player.change({ book: '100:2', playing: false, loading: true });
  await flush();
  check('still Opening while the player loads it', label(t, 'listen') === 'Opening…');
  t.player.change({ book: '100:2', playing: true, loading: false });
  await flush();
  slow.resolve();
  await flush();
  check('once the player shows the book it says Pause, enabled', label(t, 'listen') === 'Pause' && t.q('[data-action="listen"]').disabled === false, label(t, 'listen'));
  t.click('[data-action="listen"]');
  await flush();
  check('and then a press is the player\'s toggle', t.player.toggled === 1 && t.player.opened.length === 1);
});

await run('Opening ends on an error, on a refusal and when the open settles', async (make) => {
  const t = await open(make, detail());
  const slow = deferred();
  t.player.open = function (key, opts) { this.opened.push([key, opts]); return slow.promise; };
  t.click('[data-action="listen"]');
  await flush();
  check('opening', label(t, 'listen') === 'Opening…');
  t.player.change({ error: { message: 'no' }, loading: false });
  await flush();
  check('a player error ends it: Listen again, enabled', label(t, 'listen') === 'Listen' && t.q('[data-action="listen"]').disabled === false, label(t, 'listen'));
  t.player.change({ error: null });
  const u = await open(make, detail());
  u.player.open = function (key, opts) { this.opened.push([key, opts]); return Promise.reject(new Error('unknown track')); };
  const warn = console.warn;
  console.warn = () => {};
  try { u.click('[data-action="listen"]'); await flush(); } finally { console.warn = warn; }
  check('a refused open ends it', label(u, 'listen') === 'Listen' && u.q('[data-action="listen"]').disabled === false);
  const v = await open(make, detail());
  v.click('[data-action="listen"]');
  await flush();
  check('an open that settled with the player showing nothing yet is not stuck on Opening', label(v, 'listen') === 'Listen' && v.q('[data-action="listen"]').disabled === false);
});

await run('long words in a description and a byline wrap instead of widening the page', async (make) => {
  const url = 'https://example.com/' + 'a'.repeat(200);
  const t = await open(make, detail({ book: { description: 'See ' + url, author: 'A'.repeat(120), narrators: ['N'.repeat(120)], series: 'S'.repeat(120) } }));
  check('the description breaks anywhere', /\bbreak-words\b/.test(t.q('#bookAbout').className), t.q('#bookAbout').className);
  check('and so does the byline', /\bbreak-words\b/.test(t.q('#bookRest .mt-4').className), t.q('#bookRest .mt-4').className);
  check('the one-column page may shrink below its widest word (minmax(0,1fr))', /grid-cols-\[minmax\(0,1fr\)\]/.test(HTML.book));
});

await run('a not-connected person opening an ebook-only book: the hand-off runs once and comes back to this page', async (make) => {
  const answer = { status: 404, body: { detail: 'Connect to your ebook library to see ebooks', reason: 'not_connected', notes: [{ source: 'kavita', reason: 'not_connected', text: 'Connect to your ebook library to see ebooks' }] } };
  const t = await open(make, () => answer);
  check('the hand-off was started once', t.kav.reconnect.length === 1, t.kav.reconnect.length);
  const box = t.q('[data-state="connect"]');
  check('the page says it is connecting, not that the book is missing', !!box && /Connecting you now/.test(box.textContent) && /Connect your ebook library/.test(t.text('#bookTitle')) && !t.q('[data-state="notfound"]'), [t.text('#bookTitle'), box && box.textContent]);
  check('no button while it is under way', !t.q('#connectBtn'));
  check('a failed sign-in coming back here is read first', t.kav.failedChecks === 1);
  // Refused (tried a minute ago, or the last sign-in failed): said, with Try again that tries once more.
  const u = make('book', { routes: bookRoutes(() => answer) });
  u.kav.blockNext = true;
  const m = u.mount();
  await u.clock.advance(1600);
  await m;
  check('a refused hand-off says so and offers Connect', /couldn.t connect/i.test(u.text('[data-state="connect"]')) && !!u.q('#connectBtn'), u.text('[data-state="connect"]'));
  u.click('#connectBtn');
  check('Connect tries once more through the helper', u.kav.retry === 1);
  check('it asked for the book once and did not loop', u.net.urls('/api/books/').length === 1 && u.kav.reconnect.length === 1);
  // A plain 404, and a 404 about something else, stay "couldn't find".
  const v = await open(make, () => ({ status: 404, body: { detail: 'No such book' } }));
  check('a plain 404 is still not found, with no hand-off', !!v.q('[data-state="notfound"]') && v.kav.reconnect.length === 0);
  const w = await open(make, () => ({ status: 404, body: { reason: 'something_else' } }));
  check('another reason is not a hand-off', !!w.q('[data-state="notfound"]') && w.kav.reconnect.length === 0);
});

// ---------------------------------------------------------------------------
// Author, narrator and series pages
// ---------------------------------------------------------------------------

const card = (id, title, author, formats) => ({ kind: 'book', id, title, author: author || 'J.K. Rowling', cover_url: `/api/books/${id}/cover?v=1`, formats: formats || ['ebook', 'audio'] });
const personAnswer = (over = {}) => Object.assign({ name: 'J.K. Rowling', role: 'author', items: [card(7, "Sorcerer's Stone"), card(3, 'Chamber of Secrets'), card(2, 'Prisoner of Azkaban', 'J.K. Rowling', ['audio'])], notes: [] }, over);
const seriesAnswer = (over = {}) => Object.assign({
  name: 'Harry Potter',
  items: [
    Object.assign(card(7, "Sorcerer's Stone"), { series_number: 1.0, progress: { ebook: { percent: 100, label: 'Finished', updated_at: 't', finished: true }, audio: null } }),
    Object.assign(card(3, 'Chamber of Secrets'), { series_number: 2.0, progress: { ebook: null, audio: { percent: 25, label: '9h left', updated_at: 't', finished: false } } }),
    Object.assign(card(2, 'Prisoner of Azkaban', 'J.K. Rowling', ['audio']), { series_number: 10.0, progress: { ebook: null, audio: null } }),
    Object.assign(card(20, 'Quidditch Through the Ages', 'Kennilworthy Whisp', ['ebook']), { series_number: null, progress: { ebook: { percent: 43, label: 'Ch. 2 · 43%', updated_at: 't', finished: false }, audio: null } }),
    Object.assign(card(21, 'The Tales of Beedle the Bard', 'J.K. Rowling', ['audio']), { series_number: null, progress: { ebook: null, audio: null } })
  ],
  notes: []
}, over);

async function openList(make, kind, answer, o = {}) {
  const t = make(kind, Object.assign({ routes: (net) => net.on('/api/books/', () => (typeof answer === 'function' ? answer() : { body: answer })) }, o));
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  return t;
}

await run('the person page: skeleton, then the books as cards', async (make) => {
  const slow = deferred();
  const t = make('person', { routes: (net) => net.on('/api/books/', () => slow.promise.then(() => ({ body: personAnswer() }))) });
  const rest = t.q('#listRest');
  const m = t.mount();
  await flush();
  check('the skeleton is the grid\'s own shape: twelve covers', t.qa('#listRest .skel.aspect-\\[2\\/3\\]').length === 12);
  check('it asked for the author, by role and name', t.net.urls('/api/books/')[0] === '/api/books/person?role=author&name=J.K.%20Rowling', t.net.urls('/api/books/'));
  slow.resolve();
  await t.clock.advance(1600);
  await m;
  check('the heading is the name', t.text('#listTitle') === 'J.K. Rowling' && t.qa('#listTitle .skel-text').length === 0);
  check('what follows it is new', t.q('#listRest') !== rest && !rest.isConnected);
  check('the descriptor counts the books', /3 books by this author/.test(t.text('#listRest')), rr(t.text('#listRest')));
  const cards = t.qa('#listGrid > li > a');
  check('one card per book, in the order sent', cards.map((a) => a.getAttribute('href')).join() === '/books/7,/books/3,/books/2', cards.map((a) => a.getAttribute('href')));
  check('each card has its title and format badges', /Chamber of Secrets/.test(cards[1].textContent) && cards[0].querySelectorAll('[data-format]').length === 2 && cards[2].querySelectorAll('[data-format]').length === 1);
  check('the tab is titled with the name', t.titles.indexOf('J.K. Rowling') !== -1, t.titles);
  check('the section is not busy', t.q('#listView').getAttribute('aria-busy') === 'false');
  check('the page arrived as one section', t.WS.arrived.join(',') === 'list');
});

await run('a narrator\'s page says what a narrator does', async (make) => {
  const t = await openList(make, 'person', personAnswer({ name: 'Jim Dale', role: 'narrator', items: [card(7, 'One'), card(3, 'Two')] }), { url: 'https://ws.test/books/person?role=narrator&name=Jim%20Dale' });
  check('the request names the role', t.net.urls('/api/books/')[0] === '/api/books/person?role=narrator&name=Jim%20Dale', t.net.urls('/api/books/'));
  check('2 books read by this narrator', /2 books read by this narrator/.test(t.text('#listRest')), rr(t.text('#listRest')));
  const u = await openList(make, 'person', personAnswer({ items: [card(7, 'One')] }));
  check('one book: singular', /^\s*1 book by this author/.test(rr(u.text('#listRest'))) || /1 book by this author/.test(u.text('#listRest')));
});

await run('a name with punctuation and unicode reaches the API whole', async (make) => {
  const names = ['J. R. R. Tolkien', 'Le Guin, Ursula K.', 'AC/DC & Co', 'Brontë', 'Zoë "Z" O\'Neil #1', '100% 50/50', '日本語 作者', 'a+b=c?d', '  spaced  out  '];
  for (const name of names) {
    const href = '/books/person?role=narrator&name=' + encodeURIComponent(name);
    const t = await openList(make, 'person', personAnswer({ name: name, role: 'narrator' }), { url: 'https://ws.test' + href });
    const asked = new URL(t.net.urls('/api/books/')[0], 'https://ws.test');
    check(`${name}: the API was asked for exactly that name and role`, asked.pathname === '/api/books/person' && asked.searchParams.get('name') === name && asked.searchParams.get('role') === 'narrator' && [...asked.searchParams.keys()].join() === 'role,name', t.net.urls('/api/books/')[0]);
    check(`${name}: the heading shows it`, t.text('#listTitle') === name);
    const s = await openList(make, 'series', seriesAnswer({ name: name }), { url: 'https://ws.test/books/series?name=' + encodeURIComponent(name) });
    const askedS = new URL(s.net.urls('/api/books/')[0], 'https://ws.test');
    check(`${name}: the series was asked for by that name`, askedS.pathname === '/api/books/series' && askedS.searchParams.get('name') === name && [...askedS.searchParams.keys()].join() === 'name', s.net.urls('/api/books/')[0]);
  }
});

await run('a person page without a valid role or name asks nothing', async (make) => {
  for (const url of ['https://ws.test/books/person', 'https://ws.test/books/person?name=X', 'https://ws.test/books/person?role=editor&name=X', 'https://ws.test/books/person?role=author', 'https://ws.test/books/person?role=author&name=' + 'x'.repeat(201)]) {
    const t = await openList(make, 'person', personAnswer(), { url });
    check(`${url.slice(0, 70)}: not found, nothing asked`, t.net.calls.length === 0 && !!t.q('[data-state="notfound"]'), t.net.calls.length);
  }
  const s = await openList(make, 'series', seriesAnswer(), { url: 'https://ws.test/books/series' });
  check('a series page with no name: not found, nothing asked', s.net.calls.length === 0 && !!s.q('[data-state="notfound"]'));
});

await run('person page: not found, error and retry', async (make) => {
  const t = await openList(make, 'person', () => ({ status: 404, body: { detail: 'Nobody' } }));
  check('not found says so and offers Books', /couldn.t find/i.test(t.text('#listTitle')) && !!t.q('[data-state="notfound"] a[href="/books"]'));
  let down = true;
  const u = make('person', { routes: (net) => net.on('/api/books/', () => (down ? { status: 503, body: {} } : { body: personAnswer() })) });
  const m = u.mount();
  await u.clock.advance(1600);
  await m;
  check('an error says what happened', !!u.q('[data-state="error"]') && /couldn.t load/i.test(u.text('[data-state="error"]')) && !/503|HTTP/.test(u.text('#listView')));
  down = false;
  u.click('#retryBtn');
  await u.clock.advance(1600);
  check('Try again loads the page', u.text('#listTitle') === 'J.K. Rowling' && u.qa('#listGrid > li').length === 3);
});

await run('the series page lists the books in reading order with the person\'s place in each', async (make) => {
  const t = await openList(make, 'series', seriesAnswer());
  const rows = t.qa('#seriesList > li > a');
  check('it is an ordered list', t.q('#seriesList').tagName === 'OL');
  check('one row per book, in the order sent: numbered first, unnumbered last', rows.map((a) => a.getAttribute('href')).join() === '/books/7,/books/3,/books/2,/books/20,/books/21', rows.map((a) => a.getAttribute('href')));
  const nums = t.qa('#seriesList [data-number]').map((n) => n.textContent);
  check('the numbers print whole, in order, and are blank for the unnumbered', JSON.stringify(nums) === JSON.stringify(['1', '2', '10', '', '']), nums);
  check('the heading and descriptor', t.text('#listTitle') === 'Harry Potter' && /5 books, in reading order/.test(t.text('#listRest')), rr(t.text('#listRest')));
  check('a row has its title and author', /Sorcerer.s Stone/.test(rows[0].textContent) && /J\.K\. Rowling/.test(rows[0].textContent));
  check('a format is named in words, not only an icon', /Ebook/.test(rows[2].textContent) === false && /Audiobook/.test(rows[2].textContent) && /Ebook/.test(rows[3].textContent) === true, [rr(rows[2].textContent), rr(rows[3].textContent)]);
  check('a finished ebook says Finished', /Finished/.test(rows[0].textContent), rr(rows[0].textContent));
  check('an audiobook in progress shows the time left', /9h left/.test(rows[1].textContent), rr(rows[1].textContent));
  check('a format with no place is named, not blank', /Audiobook/.test(rows[2].textContent) && !/Ebook/.test(rows[2].textContent), rr(rows[2].textContent));
  check('an ebook in progress shows the chapter and percent', /Ch\. 2 · 43%/.test(rows[3].textContent), rr(rows[3].textContent));
  check('every format of a book is shown with its icon', rows[0].querySelectorAll('[data-format]').length === 2 && rows[2].querySelectorAll('[data-format]').length === 1);
  check('each row has the cover', rows.every((a) => !!a.querySelector('img')));
  check('the covers keep their 2:3 box', rows.every((a) => /aspect-\[2\/3\]/.test(a.innerHTML)));
  check('the list is not a grid of cards', !t.q('#listGrid'));
});

await run('the series page: a series of one, notes and the Kavita hand-off', async (make) => {
  const one = seriesAnswer({ items: [seriesAnswer().items[0]] });
  const t = await openList(make, 'series', one);
  check('one book: singular, no order claim', rr(t.q('#listRest p').textContent) === '1 book', rr(t.q('#listRest p').textContent));
  const note = [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }];
  const u = await openList(make, 'series', seriesAnswer({ notes: note }));
  check('a source that is down is said once, quietly', u.qa('#listRest p').filter((p) => /Ebooks are unavailable right now/.test(p.textContent)).length === 1 && t.qa('#listRest p').filter((p) => /unavailable/.test(p.textContent)).length === 0);
  check('no hand-off for a Kavita that is down', u.kav.reconnect.length === 0);
  const nc = [{ source: 'kavita', reason: 'not_connected', text: 'Connect to your ebook library to see ebooks' }];
  const v = await openList(make, 'series', seriesAnswer({ notes: nc }));
  check('not connected: one hand-off', v.kav.reconnect.length === 1);
  const w = make('person', { routes: (net) => net.on('/api/books/', () => ({ body: personAnswer({ notes: nc }) })) });
  w.kav.blockNext = true;
  const m = w.mount();
  await w.clock.advance(1600);
  await m;
  check('a refused hand-off is said, with the reason', /couldn.t connect/i.test(w.text('#listRest')), rr(w.text('#listRest')));
});

await run('the series page: not found and error', async (make) => {
  const t = await openList(make, 'series', () => ({ status: 404, body: {} }));
  check('not found', !!t.q('[data-state="notfound"]') && /couldn.t find that series/i.test(t.text('[data-state="notfound"]') + t.text('#listTitle')), t.text('#listTitle'));
  const u = await openList(make, 'series', () => ({ status: 503, body: {} }));
  check('error with Try again', !!u.q('[data-state="error"]') && !!u.q('#retryBtn'));
});

// ---- Books 3c: Follow on a series page ----

// The series answer, and a follow endpoint that records every write; status makes it refuse.
function followServer(o = {}) {
  const srv = { following: !!o.following, writes: [], status: o.status || 200, hold: o.hold || null };
  srv.routes = (net) => {
    net.on('/api/books/', () => ({ body: seriesAnswer({ following: srv.following }) }));
    net.on('/api/books/series/follow', (url, init) => {
      srv.writes.push({ method: init && init.method, body: init && init.body ? JSON.parse(init.body) : null, credentials: init && init.credentials, type: init && init.headers && init.headers['Content-Type'] });
      const answer = () => {
        if (srv.status !== 200) return { status: srv.status, body: { detail: 'no' } };
        srv.following = init.method === 'PUT';
        return { body: { following: srv.following } };
      };
      return srv.hold ? srv.hold.promise.then(answer) : answer();
    });
  };
  return srv;
}
async function openSeries(make, srv, o = {}) {
  const t = make('series', Object.assign({ routes: srv.routes }, o));
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  return t;
}
const followBtn = (t) => t.q('[data-follow]');
const followWords = (t) => rr(t.text('[data-follow] [data-label]'));

await run('3c: a series page has Follow under its descriptor, and says what it is for', async (make) => {
  const t = await openSeries(make, followServer());
  const b = followBtn(t);
  check('a real button', !!b && b.tagName === 'BUTTON' && b.getAttribute('type') === 'button');
  check('not following: Follow series', followWords(t) === 'Follow series' && t.text('[data-follow] [data-icon]') === 'add', followWords(t));
  check('right after the descriptor, before the books', (() => {
    const kids = Array.from(t.q('#listRest').children);
    const block = t.q('[data-follow-block]');
    return kids.indexOf(block) === 1 && kids.indexOf(block) < kids.indexOf(t.q('#seriesList'));
  })());
  check('one line says what following does', /notification when a new book in this series arrives/.test(t.text('[data-follow-block]')));
  check('a 44px target with a focus ring', /\bh-11\b/.test(b.className) && /focus-visible:outline-2/.test(b.className));
  const u = await openSeries(make, followServer({ following: true }));
  check('following already (from My list, listening, reading or a Follow): Following, with a check', followWords(u) === 'Following' && u.text('[data-follow] [data-icon]') === 'check' && /bg-frosted-blue\/\[0\.15\]/.test(followBtn(u).className));
  const v = await openList(make, 'person', personAnswer());
  check('a person page has no Follow', !v.q('[data-follow]'));
  check('the series skeleton holds the button\'s room', (() => {
    const doc = new v.win.DOMParser().parseFromString(HTML.series, 'text/html');
    return !!doc.querySelector('#listRest .skel.h-11') && !new v.win.DOMParser().parseFromString(HTML.person, 'text/html').querySelector('#listRest .skel.h-11');
  })());
});

await run('3c: Follow and Unfollow: the button changes at once, the server is told, a screen reader hears it', async (make) => {
  const srv = followServer();
  const t = await openSeries(make, srv);
  t.WS.cache.set('books:series:Harry Potter', { name: 'Harry Potter', items: [], following: false, notes: [] });
  const b = followBtn(t);
  b.focus();
  b.click();
  check('at once: Following', followWords(t) === 'Following');
  check('said', t.text('#followSaid') === 'Following Harry Potter');
  check('the kept copy of the page is dropped', !t.WS.cache.has('books:series:Harry Potter'));
  await t.clock.advance(10);
  check('PUT /api/books/series/follow {series}, same-origin JSON', srv.writes.length === 1 && srv.writes[0].method === 'PUT' && srv.writes[0].body.series === 'Harry Potter' &&
    srv.writes[0].credentials === 'same-origin' && srv.writes[0].type === 'application/json', srv.writes);
  check('the focus stays on the button', t.doc.activeElement === followBtn(t));
  followBtn(t).click();
  await t.clock.advance(10);
  check('again: DELETE, and back to Follow series', srv.writes.length === 2 && srv.writes[1].method === 'DELETE' && srv.writes[1].body.series === 'Harry Potter' && followWords(t) === 'Follow series');
  check('said', t.text('#followSaid') === 'Stopped following Harry Potter');
  check('no toast', t.toasts.length === 0);
});

await run('3c: a refused Follow goes back, with a toast that says what to do; one press at a time', async (make) => {
  const hold = deferred();
  const srv = followServer({ status: 503, hold });
  const t = await openSeries(make, srv);
  followBtn(t).click();
  followBtn(t).click();
  check('a second press while the first is sent does nothing', followWords(t) === 'Following' && srv.writes.length <= 1);
  hold.resolve();
  await t.clock.advance(10);
  check('refused: back to Follow series', followWords(t) === 'Follow series' && srv.writes.length === 1);
  check('a toast', t.toasts.length === 1 && t.toasts[0][0] === 'Couldn’t follow this series. Try again.' && t.toasts[0][1] === 'err', t.toasts);
  const u = await openSeries(make, followServer({ following: true, status: 503 }));
  followBtn(u).click();
  await u.clock.advance(10);
  check('a refused Unfollow: back to Following, with its own toast', followWords(u) === 'Following' && u.toasts[0][0] === 'Couldn’t stop following this series. Try again.');
  const v = await openSeries(make, followServer({ status: 403 }));
  followBtn(v).click();
  await v.clock.advance(10);
  check('an account that keeps no books of its own is told so', followWords(v) === 'Follow series' && v.toasts[0][0] === 'This account can’t follow series.');
});

await run('3c: a series name with punctuation is sent whole, as the page shows it', async (make) => {
  const name = 'Fae & Alchemy: "Book" 1/2';
  const srv = followServer();
  srv.routes = ((inner) => (net) => { inner(net); net.on('/api/books/series?', () => ({ body: seriesAnswer({ name, following: false }) })); })(srv.routes);
  const t = await openSeries(make, srv, { url: 'https://ws.test/books/series?name=' + encodeURIComponent(name) });
  followBtn(t).click();
  await t.clock.advance(10);
  check('the body carries exactly the name', srv.writes.length === 1 && srv.writes[0].body.series === name, srv.writes);
});

await run('3c: leaving the page: a late refusal changes nothing', async (make) => {
  const hold = deferred();
  const srv = followServer({ status: 503, hold });
  const t = await openSeries(make, srv);
  followBtn(t).click();
  t.ctl.abort();
  hold.resolve();
  await t.clock.advance(10);
  check('no toast after leaving', t.toasts.length === 0);
});

await run('FR1: a person or series page of ebooks for someone not connected runs the hand-off once and comes back to it', async (make) => {
  const nc = { status: 404, body: { detail: 'Connect to your ebook library to see ebooks', reason: 'not_connected', notes: [{ source: 'kavita', reason: 'not_connected', text: 'Connect to your ebook library to see ebooks' }] } };
  for (const [kind, url] of [['series', 'https://ws.test/books/series?name=Fae%20%26%20Alchemy'], ['person', 'https://ws.test/books/person?role=author&name=Callie%20Hart']]) {
    const t = await openList(make, kind, () => nc, { url });
    check(`${kind}: the hand-off was started once`, t.kav.reconnect.length === 1, t.kav.reconnect.length);
    const box = t.q('[data-state="connect"]');
    check(`${kind}: it says it is connecting, not that nothing was found`, !!box && /Connecting you now/.test(box.textContent) && /Connect your ebook library/.test(t.text('#listTitle')) && !t.q('[data-state="notfound"]'), t.text('#listTitle'));
    check(`${kind}: no button while it is under way`, !t.q('#connectBtn'));
    check(`${kind}: a failed sign-in coming back here is read first`, t.kav.failedChecks === 1);
    const u = make(kind, { url, routes: (net) => net.on('/api/books/', () => nc) });
    u.kav.blockNext = true;
    const m = u.mount();
    await u.clock.advance(1600);
    await m;
    check(`${kind}: a refused hand-off says so and offers Connect`, /couldn.t connect/i.test(u.text('[data-state="connect"]')) && !!u.q('#connectBtn'));
    u.click('#connectBtn');
    check(`${kind}: Connect tries once more through the helper, and nothing loops`, u.kav.retry === 1 && u.net.urls('/api/books/').length === 1 && u.kav.reconnect.length === 1);
  }
});

await run('FR2: a list page with a source not answering says unavailable, never not found', async (make) => {
  for (const [kind, url, source, text] of [['series', 'https://ws.test/books/series?name=Fae', 'kavita', 'Ebooks are unavailable right now'], ['person', 'https://ws.test/books/person?role=narrator&name=Jim%20Dale', 'plex', 'Audiobooks are unavailable right now']]) {
    const body = { detail: text, reason: 'unavailable', notes: [{ source, reason: 'unavailable', text }] };
    const t = await openList(make, kind, () => ({ status: 404, body }), { url });
    const box = t.q('[data-state="unavailable"]');
    check(`${kind}: the page says the source is unavailable`, !!box && box.textContent.indexOf(text) !== -1, box && box.textContent);
    check(`${kind}: never not found, and no hand-off`, !t.q('[data-state="notfound"]') && !/couldn.t find/i.test(t.text('#listView')) && t.kav.reconnect.length === 0);
    check(`${kind}: it can try again`, !!t.q('#retryBtn'));
  }
});

await run('the list pages leave nothing behind and write only text', async (make) => {
  const t = await openList(make, 'person', personAnswer({ name: '<img src=x onerror=alert(1)>', items: [card(7, '<b>bold</b>', '<i>i</i>')] }), { url: 'https://ws.test/books/person?role=author&name=x' });
  check('a name with markup is shown as text', t.text('#listTitle') === '<img src=x onerror=alert(1)>' && !t.q('#listTitle img'));
  check('and so is a card\'s', !t.q('#listGrid b') && !t.q('#listGrid i'));
  const u = make('series', { routes: (net) => net.on('/api/books/', () => ({ body: seriesAnswer() })) });
  u.ctl.abort();
  const m = u.mount();
  await u.clock.advance(1600);
  await m.catch(() => {});
  check('a visit that was left before it began draws nothing', u.qa('#seriesList').length === 0);
});

await run('FR2: a source that is not answering is "unavailable", never "removed from the library"', async (make) => {
  const kav = { status: 404, body: { detail: 'Ebooks are unavailable right now', reason: 'unavailable', notes: [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }] } };
  const t = await open(make, () => kav);
  const box = t.q('[data-state="unavailable"]');
  check('the heading is the note', t.text('#bookTitle') === 'Ebooks are unavailable right now', t.text('#bookTitle'));
  check('the book is said to be there', !!box && /still has this book/.test(box.textContent));
  check('never "removed" or "couldn\'t find"', !/removed|couldn.t find/i.test(t.text('#bookView')), t.text('#bookView'));
  check('no hand-off for a source that is down', t.kav.reconnect.length === 0);
  check('no not-found state', !t.q('[data-state="notfound"]'));
  let up = false;
  const u = make('book', { routes: bookRoutes(() => (up ? { body: detail() } : kav)) });
  const m = u.mount();
  await u.clock.advance(1600);
  await m;
  up = true;
  u.click('#retryBtn');
  await u.clock.advance(1600);
  check('Try again loads the book once the source is back', u.text('#bookTitle') === 'Harry Potter and the Prisoner of Azkaban' && !u.q('[data-state="unavailable"]'));
  const plex = { status: 404, body: { detail: 'Audiobooks are unavailable right now', reason: 'unavailable', notes: [{ source: 'plex', reason: 'unavailable', text: 'Audiobooks are unavailable right now' }] } };
  const v = await open(make, () => plex);
  check('Plex down says so the same way', v.text('#bookTitle') === 'Audiobooks are unavailable right now' && !!v.q('[data-state="unavailable"]'));
});

await run('the page reads a failed sign-in on arrival, on every Books page', async (make) => {
  const t = await open(make, detail());
  check('book page', t.kav.failedChecks === 1);
  const u = await openList(make, 'person', personAnswer());
  check('person page', u.kav.failedChecks === 1);
  const v = await openList(make, 'series', seriesAnswer());
  check('series page', v.kav.failedChecks === 1);
});

// ---------------------------------------------------------------------------
// The person's own (books 3b): My list, Up next, the stars, and the samples
// ---------------------------------------------------------------------------

const MINE = { my_list: false, queue_position: null, my_rating: null };
const mine = (over = {}) => detail(Object.assign({}, MINE, over));

// The writes: each one recorded; `answers` (by "METHOD path") says what the server does.
function mineRoutes(answers = {}) {
  const writes = [];
  const hold = {};
  return {
    writes,
    hold,
    install(net) {
      net.on('/api/books/2/', (url, init) => {
        const method = (init && init.method) || 'GET';
        const path = url.replace('/api/books/2/', '');
        const body = init && init.body ? JSON.parse(init.body) : undefined;
        writes.push({ method, path, body, credentials: init && init.credentials, type: init && init.headers && init.headers['Content-Type'] });
        const key = method + ' ' + path;
        const answer = answers[key] || (path === 'list' ? { body: { my_list: method === 'PUT' } }
          : path === 'queue' ? { body: { queue_position: method === 'PUT' ? 2 : null } }
          : { body: { my_rating: method === 'PUT' ? body.stars : null } });
        return hold[key] ? hold[key].promise.then(() => answer) : answer;
      });
    }
  };
}

async function openMine(make, answer, w, o = {}) {
  return open(make, answer, Object.assign({ routes: (net) => { bookRoutes(answer)(net); w.install(net); } }, o));
}

const mineText = (t, kind) => rr(t.text(`[data-mine="${kind}"] [data-label]`));
const said = (t) => t.text('#bookSaid');
const pressed = (t) => t.qa('[data-star]').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-star'));
const filled = (t) => t.qa('[data-star] [data-icon]').filter((g) => /FILL/.test(g.className)).length;

await run('3b: the book page has My list, Up next and the stars, from the answer, under the format buttons', async (make) => {
  const w = mineRoutes();
  const t = await openMine(make, mine(), w);
  const block = t.q('[data-mine-block]');
  check('the block is there, after the buttons and before the description', !!block && block.previousElementSibling.querySelector('[data-slot]') && block.nextElementSibling === t.q('#bookAbout').parentNode);
  check('Add to My list', mineText(t, 'list') === 'Add to My list');
  check('Add to Up next, and no Remove', mineText(t, 'queue') === 'Add to Up next' && t.q('[data-mine="unqueue"]').classList.contains('hidden'));
  check('five stars, none chosen, Clear\'s room held but unseen', t.qa('[data-star]').length === 5 && pressed(t).length === 0 && filled(t) === 0 && t.q('[data-mine="clear"]').classList.contains('invisible'));
  check('the stars are a labelled group', t.q('[role="group"]').getAttribute('aria-labelledby') === 'ratingLabel' && t.text('#ratingLabel') === 'Your rating');
  check('each star says what it gives', t.qa('[data-star]').map((b) => b.getAttribute('aria-label')).join('|') === '1 star|2 stars|3 stars|4 stars|5 stars');
  check('keyboard: every control is a real button, reachable (no tabindex -1, not disabled) with a visible focus ring',
    t.qa('[data-mine-block] button').every((b) => b.tagName === 'BUTTON' && b.getAttribute('type') === 'button' && b.getAttribute('tabindex') !== '-1' && !b.disabled && /focus-visible:outline-2/.test(b.className)));
  check('a status line for a screen reader', t.q('#bookSaid').getAttribute('role') === 'status' && t.q('#bookSaid').classList.contains('sr-only'));
  check('nothing was written just by looking', w.writes.length === 0);
  const u = await openMine(make, mine({ my_list: true, queue_position: 0, my_rating: 3 }), mineRoutes());
  check('on the list: On My list', mineText(u, 'list') === 'On My list');
  check('first in the queue: 1st in Up next, with Remove', mineText(u, 'queue') === '1st in Up next' && !u.q('[data-mine="unqueue"]').classList.contains('hidden'));
  check('rated 3: the third star is the one chosen, three filled, Clear shows', pressed(u).join() === '3' && filled(u) === 3 && !u.q('[data-mine="clear"]').classList.contains('invisible'));
  const v = await openMine(make, mine({ queue_position: 11 }), mineRoutes());
  check('12th, not 12nd', mineText(v, 'queue') === '12th in Up next', mineText(v, 'queue'));
  const x = await open(make, detail());
  check('an answer without them (an older server) has no block at all', !x.q('[data-mine-block]'));
});

await run('3b: My list toggles at once, is sent, and remembers the Books row', async (make) => {
  const w = mineRoutes();
  const t = await openMine(make, mine(), w);
  t.WS.cache.set('book:2', { stale: true });
  t.WS.cache.set('books:me:list', { items: [] });
  t.click('[data-mine="list"]');
  check('On My list at once', mineText(t, 'list') === 'On My list');
  check('a screen reader hears it', said(t) === 'Added to My list');
  await flush();
  check('PUT /api/books/2/list, same-origin credentials', w.writes.length === 1 && w.writes[0].method === 'PUT' && w.writes[0].path === 'list' && w.writes[0].credentials === 'same-origin', w.writes);
  check('the Books page will hold My list\'s room next time', t.win.localStorage.getItem('webservarr_books_mylist:sam') === '1');
  check('the kept copies of this book and the rows are dropped', !t.WS.cache.has('book:2') && !t.WS.cache.has('books:me:list'));
  t.click('[data-mine="list"]');
  await flush();
  check('again: DELETE, and Add to My list', w.writes[1].method === 'DELETE' && w.writes[1].path === 'list' && mineText(t, 'list') === 'Add to My list' && said(t) === 'Removed from My list');
  check('no toast', t.toasts.length === 0);
});

await run('3b: a change the server refuses is put back, with a toast; one press at a time', async (make) => {
  const w = mineRoutes({ 'PUT list': { status: 503, body: {} }, 'PUT queue': { status: 409, body: {} } });
  w.hold['PUT list'] = deferred();
  const t = await openMine(make, mine(), w);
  t.click('[data-mine="list"]');
  t.click('[data-mine="list"]');
  await flush();
  check('a second press while the first is on its way sends nothing', w.writes.length === 1);
  check('shown at once', mineText(t, 'list') === 'On My list');
  w.hold['PUT list'].resolve();
  await flush();
  check('refused: back to Add to My list', mineText(t, 'list') === 'Add to My list');
  check('with a toast that says what to do', t.toasts.length === 1 && t.toasts[0][0] === 'Couldn’t update My list. Try again.' && t.toasts[0][1] === 'err', t.toasts);
  t.click('[data-mine="queue"]');
  await flush();
  check('Up next full (409): put back, and told why', mineText(t, 'queue') === 'Add to Up next' && t.toasts[1][0] === 'Up next is full. Remove a book to add this one.', t.toasts);
});

await run('3b: Up next: added at the end, its place shown, Remove takes it out (the focus moves to Add)', async (make) => {
  const w = mineRoutes();
  w.hold['PUT queue'] = deferred();
  const t = await openMine(make, mine(), w);
  t.click('[data-mine="queue"]');
  check('In Up next at once', mineText(t, 'queue') === 'In Up next' && !t.q('[data-mine="unqueue"]').classList.contains('hidden'));
  check('queued, the button is a statement now (aria-disabled), Remove is the action', t.q('[data-mine="queue"]').getAttribute('aria-disabled') === 'true');
  w.hold['PUT queue'].resolve();
  await flush();
  check('the server\'s place: 3rd in Up next', mineText(t, 'queue') === '3rd in Up next', mineText(t, 'queue'));
  check('PUT /api/books/2/queue', w.writes[0].method === 'PUT' && w.writes[0].path === 'queue');
  check('Books will hold Up next\'s room', t.win.localStorage.getItem('webservarr_books_upnext:sam') === '1');
  t.click('[data-mine="queue"]');
  await flush();
  check('pressing the statement does nothing', w.writes.length === 1);
  const remove = t.q('[data-mine="unqueue"]');
  remove.focus();
  remove.click();
  await flush();
  check('Remove: DELETE, Add to Up next again, Remove hidden', w.writes[1].method === 'DELETE' && w.writes[1].path === 'queue' && mineText(t, 'queue') === 'Add to Up next' && remove.classList.contains('hidden'));
  check('the focus is not lost with the hidden button: it is on Add to Up next', t.doc.activeElement === t.q('[data-mine="queue"]'));
  check('said', said(t) === 'Removed from Up next');
});

await run('3b: the stars: one press rates, Clear clears, the pointer previews', async (make) => {
  const w = mineRoutes();
  const t = await openMine(make, mine(), w);
  t.click('[data-star="4"]');
  check('4 at once: the fourth is chosen, four filled', pressed(t).join() === '4' && filled(t) === 4);
  await flush();
  check('PUT /rating with {stars: 4} as JSON', w.writes[0].method === 'PUT' && w.writes[0].path === 'rating' && w.writes[0].body.stars === 4 && w.writes[0].type === 'application/json', w.writes);
  check('said', said(t) === 'Rated 4 stars');
  check('Clear shows', !t.q('[data-mine="clear"]').classList.contains('invisible'));
  t.click('[data-star="4"]');
  await flush();
  check('the same star again sends nothing', w.writes.length === 1);
  t.click('[data-star="1"]');
  await flush();
  check('1 star', w.writes[1].body.stars === 1 && said(t) === 'Rated 1 star' && filled(t) === 1);
  t.q('[data-star="5"]').dispatchEvent(new t.win.MouseEvent('mouseenter'));
  check('the pointer over the fifth previews five (a lighter fill)', filled(t) === 5 && /text-frosted-blue\/70/.test(t.q('[data-star="5"] [data-icon]').className));
  t.q('[role="group"]').dispatchEvent(new t.win.MouseEvent('mouseleave'));
  check('and leaving shows the rating again', filled(t) === 1);
  t.q('[data-mine="clear"]').focus();
  t.click('[data-mine="clear"]');
  await flush();
  check('the focus is not lost with the hidden Clear: it is on the first star', t.doc.activeElement === t.q('[data-star="1"]'));
  check('Clear: DELETE /rating, nothing chosen, Clear unseen again', w.writes[2].method === 'DELETE' && w.writes[2].path === 'rating' && pressed(t).length === 0 && filled(t) === 0 && t.q('[data-mine="clear"]').classList.contains('invisible'));
  check('said', said(t) === 'Rating cleared');
  const f = mineRoutes({ 'PUT rating': { status: 503, body: {} } });
  const u = await openMine(make, mine({ my_rating: 2 }), f);
  u.click('[data-star="5"]');
  await flush();
  check('refused: the rating it had is back', pressed(u).join() === '2' && filled(u) === 2);
  check('with a toast', u.toasts.length === 1 && u.toasts[0][0] === 'Couldn’t save your rating. Try again.');
});

await run('3b: Read a sample opens the reader\'s sample mode; only for a format the person can open', async (make) => {
  const t = await open(make, detail());
  const a = t.q('[data-action="read-sample"]');
  check('a link under Read, in the ebook slot', !!a && a.tagName === 'A' && a.closest('[data-slot]').getAttribute('data-slot') === 'ebook');
  check('to the book\'s own chapter, in sample mode', a.getAttribute('href') === '/reader?seriesId=5&chapterId=77&sample=1', a.getAttribute('href'));
  check('it says so', rr(a.textContent).indexOf('Read a sample') !== -1);
  const u = await open(make, detail({ formats: { ebook: null, audio: { available: true, editions: EDITIONS, preferred: '100:2' } }, request_links: { ebook: '/requests?q=x', audio: null } }));
  check('no ebook: no Read a sample', !u.q('[data-action="read-sample"]'));
  const v = await open(make, detail({ formats: { ebook: null, audio: { available: true, editions: EDITIONS, preferred: '100:2' } },
    notes: [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }] }));
  check('Kavita down: the disabled Read says why, and no sample is offered', !v.q('[data-action="read-sample"]') && v.q('[data-action="read"]').disabled);
  const x = await open(make, detail({ formats: { ebook: Object.assign({}, EBOOK, { read_url: 'https://elsewhere.example/' }), audio: null } }));
  check('a read address that is not the reader\'s: no sample link either', !x.q('[data-action="read-sample"]'));
});

await run('3b: Try a sample plays the picked narrator\'s first minutes; Stop sample with the time left while it plays', async (make) => {
  const t = await open(make, detail());
  const b = t.q('[data-action="sample"]');
  check('a button under Listen, in the audio slot (after the narrator picker)', !!b && b.tagName === 'BUTTON' && b.closest('[data-slot]').getAttribute('data-slot') === 'audio' && b.previousElementSibling.querySelector('#narratorSelect'));
  check('Try a sample', rr(t.text('[data-action="sample"] [data-label]')) === 'Try a sample' && t.q('[data-action="sample"] [data-left]').classList.contains('hidden'));
  t.click('[data-action="sample"]');
  await flush();
  check('the preferred narrator\'s edition, preselected', JSON.stringify(t.player.sampled) === '["100:2"]', t.player.sampled);
  check('the main player was not opened', t.player.opened.length === 0);
  check('while it starts: Stop sample, Starting…', rr(t.text('[data-action="sample"] [data-label]')) === 'Stop sample' && t.text('[data-action="sample"] [data-left]') === 'Starting…');
  t.player.sampleChange('time', { book: '100:2', title: 'X', playing: true, loading: false, bookMs: 28000, leftMs: 272000 });
  check('playing: Stop sample and 4:32 left', rr(t.text('[data-action="sample"] [data-label]')) === 'Stop sample' && t.text('[data-action="sample"] [data-left]') === '4:32 left' && !t.q('[data-action="sample"] [data-left]').classList.contains('hidden'));
  check('the time is in tabular figures (it ticks)', /tabular-nums/.test(t.q('[data-action="sample"] [data-left]').className));
  check('the icon says stop', t.text('[data-action="sample"] [data-icon]') === 'stop_circle');
  t.click('[data-action="sample"]');
  check('pressed again: stopSample', t.player.stops === 1);
  check('and it is Try a sample again', rr(t.text('[data-action="sample"] [data-label]')) === 'Try a sample' && t.text('[data-action="sample"] [data-left]') === '');
  t.change('#narratorSelect', '100:1');
  t.click('[data-action="sample"]');
  await flush();
  check('another narrator picked: that one is sampled', t.player.sampled[1] === '100:1', t.player.sampled);
  t.player.sampleChange('start', { book: '999:1', title: 'Other', playing: true, loading: false, bookMs: 1000, leftMs: 299000 });
  check('a sample of another book (started elsewhere) is not this page\'s: Try a sample', rr(t.text('[data-action="sample"] [data-label]')) === 'Try a sample');
  t.ctl.abort();
  t.player.sampleChange('stop', null);
  check('a page that was left stops listening', t.player.sampleListeners.length === 0 && t.player.listeners.length === 0);
});

await run('3b: a sample that cannot play says it is unavailable right now, and can be tried again', async (make) => {
  const t = await open(make, detail());
  t.player.sample = function (key) {
    this.sampled.push(key);
    this.sampleChange('start', { book: key, title: '', playing: false, loading: true, bookMs: 0, leftMs: 300000 });
    this.sampleChange('error', null, { code: 'unreachable', message: "Can't reach the media server" });
    return Promise.resolve(false);
  };
  t.click('[data-action="sample"]');
  await flush();
  check('Sample unavailable right now', rr(t.text('[data-action="sample"] [data-label]')) === 'Sample unavailable right now', rr(t.text('[data-action="sample"] [data-label]')));
  check('the button still works', !t.q('[data-action="sample"]').disabled);
  t.player.sample = function (key) { this.sampled.push(key); this.sampleChange('start', { book: key, title: '', playing: true, loading: false, bookMs: 500, leftMs: 299500 }); return Promise.resolve(true); };
  t.click('[data-action="sample"]');
  await flush();
  check('tried again, it plays', t.player.sampled.length === 2 && rr(t.text('[data-action="sample"] [data-label]')) === 'Stop sample');
  const u = await open(make, detail(), { player: false });
  u.click('[data-action="sample"]');
  check('no player yet: a quiet toast, nothing breaks', u.toasts.length === 1 && /player/.test(u.toasts[0][0]));
  const v = await open(make, detail({ formats: { ebook: EBOOK, audio: null }, request_links: { ebook: null, audio: '/requests?q=x' } }));
  check('no audiobook: no Try a sample', !v.q('[data-action="sample"]'));
});

await run('3b: CLS: the skeleton has the shape of the new rows; nothing on screen moves when the answer lands', async (make) => {
  const slow = deferred();
  const t = make('book', { routes: (net) => net.on('/api/books/', () => slow.promise.then(() => ({ body: mine() }))) });
  const m = t.mount();
  await flush();
  check('the skeleton holds a sample row under each format button', t.qa('#bookRest .skel.h-14').length === 2 && t.qa('#bookRest .skel.h-14 + .mt-2.h-10').length === 2);
  check('My list and Up next, in the two columns', t.qa('#bookRest .grid.sm\\:grid-cols-2 .skel.h-11').length === 2);
  check('and the stars\' row', t.qa('#bookRest .skel.h-10').length === 1);
  const title = t.q('#bookTitle');
  const cover = t.q('#bookCover');
  slow.resolve();
  await t.clock.advance(1600);
  await m;
  check('the heading stays the same element (nothing above the new part is touched)', t.q('#bookTitle') === title);
  check('the new part replaced the skeleton in one write', !!t.q('[data-mine-block]') && !t.q('#bookRest .skel'));
  check('the cover was replaced once, in the same commit', t.q('#bookCover') !== cover);
  check('no overflow at 320: labels truncate and the columns may shrink', t.qa('[data-mine] [data-label]').every((s) => /truncate/.test(s.className)) && /min-w-0/.test(t.q('[data-mine="queue"]').parentNode.className) && /max-w-full/.test(t.q('[data-action="sample"]').className));
});

// ---------------------------------------------------------------------------
// The reader opens the chapter it is given
// ---------------------------------------------------------------------------

const readerSrc = readFileSync(READER_PATH, 'utf8');
const reader = await import(dataUrl(readerSrc));

await run('the reader\'s target: a chapter is read from the address', async () => {
  const target = reader.readerTarget;
  check('the reader exports how it reads its address', typeof target === 'function');
  if (typeof target !== 'function') return;
  const q = (s) => new URLSearchParams(s);
  check('series and chapter', JSON.stringify(target(q('seriesId=5&chapterId=77'))) === JSON.stringify({ seriesId: 5, chapterId: 77 }), target(q('seriesId=5&chapterId=77')));
  check('a series alone has no chapter (the first one is used)', JSON.stringify(target(q('seriesId=5'))) === JSON.stringify({ seriesId: 5, chapterId: null }));
  check('no series is nothing to open', target(q('chapterId=77')).seriesId === null);
  check('a chapter that is not a number is none', target(q('seriesId=5&chapterId=abc')).chapterId === null && target(q('seriesId=5&chapterId=-3')).chapterId === null && target(q('seriesId=5&chapterId=0')).chapterId === null);
  check('a series that is not a number is none', target(q('seriesId=x&chapterId=7')).seriesId === null);
});

// turn: true turns a page; a function is run instead (doc, win), and what it
// returns comes back as `seen`.
async function readerVisit(search, turn) {
  const win = new Window({ url: 'https://ws.test/reader' + search });
  const doc = win.document;
  doc.body.innerHTML = READER_HTML.match(/<div id="wsPage"[\s\S]*<\/main>/)[0].replace(/<\/main>$/, '');
  const ctl = new win.AbortController();
  const calls = [];
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win); set('document', doc); set('localStorage', win.localStorage);
  set('getComputedStyle', win.getComputedStyle.bind(win));
  set('checkAuth', () => Promise.resolve());
  set('WS', { player: null, data: { user: { username: 'sam' } } });
  const beacons = [];
  set('navigator', { sendBeacon(url) { beacons.push(String(url)); return true; } });
  win.WS = g.WS;
  const answers = (url) => {
    if (/\/series-detail\?seriesId=5$/.test(url)) return { specials: [], chapters: [], volumes: [{ id: 900, chapters: [{ id: 11, volumeId: 900 }] }], storylineChapters: [] };
    if (/\/Book\/77\/book-info$/.test(url)) return { pages: 30, libraryId: 1, volumeId: 905, seriesId: 104, bookTitle: 'Prisoner of Azkaban' };
    if (/\/Book\/(77|11)\/book-page\?page=\d+$/.test(url)) return '<p>A page.</p>';
    if (/\/Book\/11\/book-info$/.test(url)) return { pages: 10, libraryId: 1, volumeId: 900, bookTitle: 'Sorcerer\'s Stone' };
    if (/get-progress\?chapterId=(77|11)$/.test(url)) return '';
    return null;
  };
  const posts = [];
  const fetchFn = (url, init) => {
    calls.push(String(url));
    if (init && init.method === 'POST') posts.push({ url: String(url), body: JSON.parse(init.body) });
    const a = answers(String(url));
    const ok = a !== null;
    return Promise.resolve({
      ok, status: ok ? 200 : 404,
      json: () => Promise.resolve(a), text: () => Promise.resolve(typeof a === 'string' ? a : JSON.stringify(a))
    });
  };
  set('fetch', fetchFn);
  win.fetch = fetchFn;
  const ctx = {
    root: doc.getElementById('wsPage'), signal: ctl.signal, url: new URL('https://ws.test/reader' + search),
    data: g.WS.data, poll() { return () => {}; },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
    setTitle() {}, beforeLeave() {}
  };
  let thrown = null;
  let leave = null;
  const mounted = reader.mount(ctx).then((fn) => { leave = fn; }, (e) => { thrown = e; });
  await flush();
  await flush();
  let seen;
  if (typeof turn === 'function') {
    seen = await turn(doc, win);
  } else if (turn) {
    // Turn a page, then leave as a soft navigation does: the writer saves the place.
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    await flush();
  }
  ctl.abort();
  await mounted;
  if (typeof leave === 'function') leave();
  await flush();
  for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; }
  return { calls, thrown, posts, beacons, seen };
}

await run('the reader opens the chapter in its address, not the series\' first', async () => {
  const given = await readerVisit('?seriesId=5&chapterId=77');
  check('it did not throw', given.thrown === null, given.thrown && String(given.thrown));
  check('it never looked for the series\' first chapter', !given.calls.some((u) => /series-detail/.test(u)), given.calls);
  check('it read the given chapter\'s own info (where the volume comes from)', given.calls.some((u) => /\/Book\/77\/book-info/.test(u)), given.calls);
  check('and asked for that chapter\'s place', given.calls.some((u) => /get-progress\?chapterId=77/.test(u)), given.calls);
  check('never the first chapter\'s', !given.calls.some((u) => /\/Book\/11\//.test(u) || /chapterId=11\b/.test(u)), given.calls);
  const series = await readerVisit('?seriesId=5');
  check('a series alone still opens its first chapter', series.calls.some((u) => /series-detail\?seriesId=5/.test(u)) && series.calls.some((u) => /\/Book\/11\/book-info/.test(u)), series.calls);
  const none = await readerVisit('');
  check('no address, no request', none.calls.length === 0, none.calls);
  // T4H3: the place is saved under the chapter's own series (book-info's), not the address's.
  const turned = await readerVisit('?seriesId=5&chapterId=77', true);
  const saved = turned.posts.filter((x) => /Reader\/progress$/.test(x.url));
  check('a turned page is saved', saved.length >= 1, turned.posts);
  check('under the series Kavita names for the chapter (104), not the address\'s (5)', saved.length >= 1 && saved.every((x) => x.body.seriesId === 104 && x.body.chapterId === 77 && x.body.volumeId === 905), saved.map((x) => x.body));
  const bad = await readerVisit('?seriesId=5&chapterId=abc');
  check('a chapter that is not a number is ignored: the first chapter opens', bad.calls.some((u) => /\/Book\/11\/book-info/.test(u)) && !bad.calls.some((u) => /abc/.test(u)), bad.calls);
});

await run('the reader\'s sample mode: the first page, no place read or saved, no bookmarks, and a Sample banner', async () => {
  const v = await readerVisit('?seriesId=5&chapterId=77&sample=1', async (doc, win) => {
    const key = (k) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
    const banner = doc.getElementById('sampleBanner');
    const seen = {
      banner: !!banner && !banner.hidden,
      text: banner ? banner.textContent.replace(/\s+/g, ' ').trim() : '',
      start: doc.getElementById('sampleStart') ? doc.getElementById('sampleStart').getAttribute('href') : null,
      bookmarkHidden: doc.getElementById('bookmarkBtn').hidden === true,
      page: doc.getElementById('pageInfo').textContent
    };
    key('ArrowRight'); await flush(); await flush();
    key('ArrowRight'); await flush(); await flush();
    seen.turned = doc.getElementById('pageInfo').textContent;
    doc.getElementById('bookmarkBtn').click();
    await flush();
    Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
    doc.dispatchEvent(new win.Event('visibilitychange'));
    win.dispatchEvent(new win.Event('pagehide'));
    await flush();
    let backs = 0;
    // Opened from another page of the site: there is somewhere to go back to.
    win.history.pushState({}, '', win.location.href);
    win.history.back = () => { backs += 1; };
    const close = doc.getElementById('sampleClose');
    if (close) close.click();
    seen.backs = backs;
    return seen;
  });
  check('it did not throw', v.thrown === null, v.thrown && String(v.thrown));
  check('it never asked where the reader was', !v.calls.some((u) => /get-progress/.test(u)), v.calls);
  check('it opened the first page', v.calls.some((u) => /\/Book\/77\/book-page\?page=0$/.test(u)) && v.seen.page === '1 / 30', [v.seen.page, v.calls]);
  check('pages turn', v.seen.turned === '3 / 30', v.seen.turned);
  check('no progress POST, no bookmark, no write of any kind', v.posts.length === 0, v.posts);
  check('no beacon on hiding or leaving', v.beacons.length === 0, v.beacons);
  check('bookmarks are off', v.seen.bookmarkHidden);
  check('a Sample banner shows', v.seen.banner && /^Sample\b/.test(v.seen.text) && /Start reading/.test(v.seen.text) && /Close/.test(v.seen.text), v.seen.text);
  check('Start reading opens the book normally, at the same chapter', v.seen.start === '/reader?seriesId=5&chapterId=77', v.seen.start);
  check('Close goes back', v.seen.backs === 1, v.seen.backs);
  const normal = await readerVisit('?seriesId=5&chapterId=77', async (doc) => {
    const banner = doc.getElementById('sampleBanner');
    return { banner: !!banner && !banner.hidden, bookmarkHidden: doc.getElementById('bookmarkBtn').hidden === true };
  });
  check('without sample=1: no banner, bookmarks on, the place is asked for', !normal.seen.banner && !normal.seen.bookmarkHidden && normal.calls.some((u) => /get-progress\?chapterId=77/.test(u)), [normal.seen, normal.calls]);
  const other = await readerVisit('?seriesId=5&chapterId=77&sample=yes');
  check('only sample=1 is a sample', other.calls.some((u) => /get-progress\?chapterId=77/.test(u)), other.calls);
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
