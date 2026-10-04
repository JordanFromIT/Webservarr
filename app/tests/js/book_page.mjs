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
// A page module reaches books.js by a relative import; through a data: URL
// there is no "relative", so the specifier is pointed at books.js's own data URL.

const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
const booksSrc = readFileSync(BOOKS_PATH, 'utf8');
const BOOKS_URL = dataUrl(booksSrc);
async function loadPage(path) {
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
        if (!r.ok) throw new Error('HTTP ' + r.status);
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
  const clock = fakeClock();
  const net = network();
  const ctl = new win.AbortController();
  const WS = fakeShell(doc, clock, net);
  const kav = { init: 0, reconnect: [], retry: 0, blockNext: false };
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
  win.history.replaceState = function (state, title, to) { replaced.push(to); };
  if (o.kavita !== false) {
    win.WSKavita = {
      init() { kav.init += 1; },
      reconnect(cb) { kav.reconnect.push(cb); if (kav.blockNext) cb(); },
      retry() { kav.retry += 1; },
      arrivedFromFailedConnect() { return false; }
    };
  }
  // The player: which book it holds and whether it plays; change listeners as the engine has them.
  const player = {
    opened: [], toggled: 0, listeners: [], st: { book: null, playing: false, loading: false, error: null },
    open(key, opts) { this.opened.push([key, opts]); return Promise.resolve(); },
    toggle() { this.toggled += 1; },
    state() { return this.st; },
    on(name, fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((x) => x !== fn); }; },
    change(st) { this.st = Object.assign({}, this.st, st); this.listeners.slice().forEach((fn) => fn()); }
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
  check('first visit drew the book', t.qa('[data-action]').length === 2);
  // Same window, same store: mount again with a changed live answer.
  t.net.on('/api/books/', () => ({ body: detail({ formats: { ebook: Object.assign({}, EBOOK, { progress: Object.assign({}, EBOOK.progress, { label: 'Ch. 13 · 50%', percent: 50 }) }), audio: { available: true, editions: EDITIONS, preferred: '100:2' } } }) }));
  m = bookModule.mount(t.ctx);
  await t.clock.advance(1600);
  await m;
  check('the live place replaces the kept one', /Ch\. 13 · 50%/.test(t.q('[data-action="read"]').textContent), rr(t.q('[data-action="read"]').textContent));
  check('and the page holds one set of buttons', t.qa('[data-action="read"]').length === 1);
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

async function readerVisit(search) {
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
  win.WS = g.WS;
  const answers = (url) => {
    if (/\/series-detail\?seriesId=5$/.test(url)) return { specials: [], chapters: [], volumes: [{ id: 900, chapters: [{ id: 11, volumeId: 900 }] }], storylineChapters: [] };
    if (/\/Book\/77\/book-info$/.test(url)) return { pages: 30, libraryId: 1, volumeId: 905, bookTitle: 'Prisoner of Azkaban' };
    if (/\/Book\/11\/book-info$/.test(url)) return { pages: 10, libraryId: 1, volumeId: 900, bookTitle: 'Sorcerer\'s Stone' };
    if (/get-progress\?chapterId=(77|11)$/.test(url)) return '';
    return null;
  };
  const fetchFn = (url) => {
    calls.push(String(url));
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
  const mounted = reader.mount(ctx).catch((e) => { thrown = e; });
  await flush();
  await flush();
  ctl.abort();
  await mounted;
  for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; }
  return { calls, thrown };
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
  const bad = await readerVisit('?seriesId=5&chapterId=abc');
  check('a chapter that is not a number is ignored: the first chapter opens', bad.calls.some((u) => /\/Book\/11\/book-info/.test(u)) && !bad.calls.some((u) => /abc/.test(u)), bad.calls);
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
