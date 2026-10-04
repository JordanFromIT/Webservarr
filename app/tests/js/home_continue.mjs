// Home's Continue row (app/static/js/pages/home.js, with renderContinueRow from
// books.js): the real Home page module run in happy-dom (a dev-only
// dependency) over the page's own markup (index.html), with a scripted
// network, a fake clock and a fake shell (WS.swr and WS.arrive written as
// shell.js does them). The sections below Continue are left to their own
// tests: here their reads answer nothing.
//
// Covers: the compact row in place of its skeleton; hidden when nothing is in
// progress, also when the only thing to say is a note; the notes (Kavita down,
// not connected, which links to Books and never runs the hand-off); the room a
// row had last time held from the first frame (hidden decided before anything
// is awaited, the first-paint flag taken off), so nothing below it moves; the
// row left alone and never asked for while the Books page is off; a failed
// answer hides it quietly; a kept copy then the fresh answer; a tap on an
// audiobook card resumes it in the player; the page's stamped books.js; leaving
// the page.
//
// HOME_JS=<path> runs the same cases against another copy of the module (how
// the cases were shown failing on the code before).
// Run: node app/tests/js/home_continue.mjs (npm run test:js; CI js-checks).
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

// ---- The modules, imported as they are ----
// Home loads books.js from the address its page names in data-ws-dep (the
// server stamps it); here that address is books.js's own data: URL, and a
// counter on it says how often the page asked for it.

const BOOKS_URL = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(BOOKS_SRC);
async function loadHome() {
  const src = readFileSync(HOME_PATH, 'utf8').replace(/from\s+['"]\.\/books\.js(\?[^'"]*)?['"]/g, `from ${JSON.stringify(BOOKS_URL)}`);
  return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
}
const home = await loadHome();

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

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
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
    // Only Continue is Home's business here: the other sections' reads answer nothing.
    swr(key, fetcher, render, opts) {
      WS.swrKeys.push(key);
      if (key !== 'books:continue') return Promise.resolve(null);
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

// ---- One window, one visit ----

const NAV = /<div id="wsPage"[\s\S]*<\/main>/;
const BRANDING_ON = { features: { books_configured: true }, sidebar_enabled: { library: true }, home_sections: {} };

function visit(o = {}) {
  const win = new Window({ url: 'https://ws.test/' });
  const doc = win.document;
  doc.body.innerHTML = HOME_HTML.match(NAV)[0].replace(/<\/main>$/, '');
  doc.getElementById('wsPage').setAttribute('data-ws-dep', BOOKS_URL);
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
  set('WS', WS);
  win.WS = WS;
  set('fetch', (u, i) => net.fetch(u, i));
  set('checkAuth', async () => ({ username: 'sam', is_admin: false }));
  set('escapeHtml', (s) => String(s));
  const quiet = { error() {}, warn() {}, log() {}, info() {} };
  set('console', quiet);
  const hand = { reconnect: 0 };
  win.WSKavita = { reconnect() { hand.reconnect += 1; }, retry() {}, init() {} };
  win.WS.player = { opened: [], open(key, opts) { this.opened.push([key, opts]); return Promise.resolve(); } };
  for (const [k, v] of Object.entries(o.storage || {})) win.localStorage.setItem(k, v);
  if (o.flag !== undefined) doc.documentElement.setAttribute('data-home-continue', o.flag);
  if (o.routes) o.routes(net);
  const branding = o.branding || BRANDING_ON;
  WS.data.branding = branding;
  const ctx = {
    root: doc.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL('https://ws.test/'),
    data: { branding, user: { username: 'sam' } },
    poll() { return () => {}; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id)
  };
  WS.arriveReset();
  return {
    win, doc, clock, net, ctl, WS, hand, ctx,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    host: () => doc.getElementById('homeContinue'),
    mount: () => home.mount(ctx),
    async open() {
      const m = home.mount(ctx);
      await clock.advance(1700);
      await m;
    },
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

const CONT = [
  { book_id: 1, format: 'ebook', title: 'Dune', author: 'Frank Herbert', cover_url: '/api/books/1/cover?v=1', progress_label: 'Ch. 12 · 43%', percent: 43, updated_at: '2026-10-03T10:00:00Z', resume: { read_url: '/reader?seriesId=4&chapterId=9' } },
  { book_id: 3, format: 'audio', title: 'The Hobbit', author: 'J. R. R. Tolkien', cover_url: '/api/books/3/cover?v=1', progress_label: '2h 10m left', percent: 60, updated_at: '2026-10-02T10:00:00Z', resume: { plex_book_key: '14:1' } }
];
const DOWN = [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }];
const NOT_CONNECTED = [{ source: 'kavita', reason: 'not_connected', text: 'Connect to your ebook library to see ebooks' }];
const routes = (answer) => (net) => net.on('/api/books/continue', () => (typeof answer === 'function' ? answer() : { body: answer }));

const KEY = 'webservarr_books_continue:sam';
const NOTE_KEY = 'webservarr_home_continue_note:sam';

// ---------------------------------------------------------------------------

await run('the section is the first to arrive, hidden until a visit says otherwise, with a row-shaped skeleton', async (make) => {
  const t = make({ routes: routes({ items: [], notes: [] }) });
  const host = t.host();
  check('it is the first section in the arrival order', t.qa('[data-arrive]')[0] === host && host.getAttribute('data-arrive') === 'continue');
  check('it is hidden in the markup (the stack\'s gap skips it)', host.hidden === true);
  const skel = host.querySelector('[aria-hidden="true"]');
  check('its skeleton is the row\'s shape: a heading, six compact cards, a room for a note', skel.querySelector('h2') && skel.querySelectorAll('.w-28').length === 6 && skel.querySelector('[data-note-slot]'));
  check('a card is a cover and two lines', Array.from(skel.querySelectorAll('.w-28')).every((c) => c.children.length === 3));
});

await run('a row in progress: the compact row replaces the skeleton and is shown', async (make) => {
  const t = make({ routes: routes({ items: CONT, notes: [] }) });
  await t.open();
  const host = t.host();
  const row = host.querySelector('[data-continue]');
  check('the row is there', !!row && row.getAttribute('aria-label') === 'Continue');
  check('compact: narrow cards and a small heading', row.querySelectorAll('li > a.w-28, li > button.w-28').length === 2 && /text-\[17px\]/.test(row.querySelector('h2').className));
  check('the skeleton is gone and the section is shown', !host.querySelector('.skel') && host.hidden === false && host.getAttribute('aria-busy') === 'false');
  check('an ebook resumes in the reader', row.querySelector('li > a').getAttribute('href') === '/reader?seriesId=4&chapterId=9');
  check('it asked for the person\'s Continue, once, on the page\'s signal', t.net.urls('/api/books/continue').length === 1 && t.net.calls.find((c) => c.url === '/api/books/continue').init.signal === t.ctl.signal);
  check('Continue arrives before every other section', t.WS.arrived[0] === 'continue', t.WS.arrived);
  check('it shares Books\' kept copy', t.WS.swrKeys.indexOf('books:continue') !== -1);
  check('it is remembered for the next first frame', t.win.localStorage.getItem(KEY) === '1' && t.win.localStorage.getItem(NOTE_KEY) === '0');
  check('no hand-off to Kavita from Home', t.hand.reconnect === 0);
});

await run('nothing in progress: the row is hidden, and remembered as hidden', async (make) => {
  const t = make({ storage: { [KEY]: '1' }, routes: routes({ items: [], notes: [] }) });
  const m = t.mount();
  check('a person who had a row has its room until the answer says no', t.host().hidden === false);
  await t.clock.advance(1700);
  await m;
  check('the section is hidden again', t.host().hidden === true && !t.host().querySelector('[data-continue]'));
  check('and the skeleton does not linger in it', !t.host().querySelector('.skel'));
  check('the next visit reserves nothing', t.win.localStorage.getItem(KEY) === '0');
  const u = make({ storage: { [KEY]: '0' }, routes: routes({ items: [], notes: [] }) });
  const um = u.mount();
  check('a person without one starts hidden', u.host().hidden === true);
  await u.clock.advance(1700);
  await um;
  check('and stays hidden', u.host().hidden === true);
});

await run('a note with nothing to show is not a reason to show a row', async (make) => {
  const t = make({ routes: routes({ items: [], notes: DOWN }) });
  await t.open();
  check('Kavita down, nothing else in progress: hidden, no note on Home', t.host().hidden === true && !t.host().textContent.includes('unavailable'));
  const u = make({ routes: routes({ items: [], notes: NOT_CONNECTED }) });
  await u.open();
  check('not connected, nothing in progress: hidden', u.host().hidden === true);
});

await run('Kavita down: the audiobooks stay and one quiet note follows them', async (make) => {
  const t = make({ routes: routes({ items: CONT.slice(1), notes: DOWN.concat(DOWN) }) });
  await t.open();
  const row = t.host().querySelector('[data-continue]');
  const notes = Array.from(row.querySelectorAll('[data-continue-note]'));
  check('the audiobook is there', row.querySelectorAll('li').length === 1 && /The Hobbit/.test(row.textContent));
  check('one note, said once, under the row', notes.length === 1 && /Ebooks are unavailable right now/.test(notes[0].textContent) && row.lastElementChild === notes[0], notes.map((n) => n.textContent));
  check('as plain text, not a link', !notes[0].querySelector('a'));
  check('the note is remembered, so its room is there next time', t.win.localStorage.getItem(NOTE_KEY) === '1');
});

await run('not connected: the note says so and links to Books, which runs the hand-off; Home never does', async (make) => {
  const t = make({ routes: routes({ items: CONT.slice(1), notes: NOT_CONNECTED }) });
  await t.open();
  const note = t.host().querySelector('[data-continue-note]');
  check('the note is there with its words', note && /Connect to your ebook library to see ebooks/.test(note.textContent));
  const link = note && note.querySelector('a');
  check('and is a link to Books', link && link.getAttribute('href') === '/books');
  check('Home made no hand-off', t.hand.reconnect === 0);
});

await run('the room a row had last time is held from the first frame, so nothing below it moves', async (make) => {
  const t = make({ storage: { [KEY]: '1', [NOTE_KEY]: '1' }, flag: 'note', routes: routes({ items: CONT.slice(1), notes: DOWN }) });
  const html = t.doc.documentElement;
  check('a full load\'s first-paint flag is on <html>', html.getAttribute('data-home-continue') === 'note');
  const m = t.mount();
  // Synchronously: before anything is awaited, so before the first paint of a soft visit.
  check('the section\'s hidden attribute already says shown', t.host().hidden === false);
  check('with the room for a note', t.host().querySelector('[data-note-slot]').hidden === false);
  check('the flag is taken off: hidden is the one truth from here', !html.hasAttribute('data-home-continue'));
  check('the skeleton is what is on screen until the answer', !!t.host().querySelector('.skel'));
  await t.clock.advance(1700);
  await m;
  check('the answer replaces it in the same place', !t.host().querySelector('.skel') && !!t.host().querySelector('[data-continue-note]') && t.host().hidden === false);
  const u = make({ storage: { [KEY]: '1', [NOTE_KEY]: '0' }, routes: routes({ items: CONT, notes: [] }) });
  const um = u.mount();
  check('no note last time: no room for one', u.host().querySelector('[data-note-slot]').hidden === true);
  await u.clock.advance(1700);
  await um;
});

await run('the first-paint rules: the room is held only while the section is hidden by its attribute', async (make) => {
  const css = HOME_HTML.slice(HOME_HTML.indexOf('<style>'), HOME_HTML.indexOf('</style>'));
  check('shown by the flag, with the stack\'s gap given by its own margin', /html\[data-home-continue\] #homeContinue\[hidden\] \{ display: block; margin-bottom: 2rem; \}/.test(css));
  check('and no margin where a flex gap spaces the stack', /html\[data-home-hide\]\[data-home-continue\] #homeContinue\[hidden\] \{ margin-bottom: 0; \}/.test(css));
  check('the note\'s room only for a row that had a note', /html\[data-home-continue="note"\] #homeContinue \[data-note-slot\]\[hidden\] \{ display: block; \}/.test(css));
  const loader = readFileSync(join(STATIC, 'js/theme-loader.js'), 'utf8');
  // The loader's own rule, run: the same memory, only on Home, only while Books is on.
  const run1 = (data, store) => {
    const win = new Window({ url: 'https://ws.test/' });
    for (const [k, v] of Object.entries(store)) win.localStorage.setItem(k, v);
    const src = loader.slice(loader.indexOf("(function () {\n  'use strict';\n  var data = window.WS_DATA || {};\n  if (data.page !== 'index')"));
    const end = src.indexOf('})();') + 5;
    win.WS_DATA = data;
    new Function('window', 'document', 'localStorage', src.slice(0, end))(win, win.document, win.localStorage);
    return win.document.documentElement.getAttribute('data-home-continue');
  };
  const on = { page: 'index', user: { username: 'sam' }, branding: BRANDING_ON };
  check('had a row: flagged', run1(on, { [KEY]: '1' }) === '');
  check('had a row and a note: flagged with the note', run1(on, { [KEY]: '1', [NOTE_KEY]: '1' }) === 'note');
  check('had none: not flagged', run1(on, { [KEY]: '0' }) === null);
  check('never visited: not flagged', run1(on, {}) === null);
  check('another page: not flagged', run1(Object.assign({}, on, { page: 'books' }), { [KEY]: '1' }) === null);
  check('Books not set up: not flagged', run1(Object.assign({}, on, { branding: { features: { books_configured: false }, sidebar_enabled: {} } }), { [KEY]: '1' }) === null);
  check('Books switched off: not flagged', run1(Object.assign({}, on, { branding: { features: { books_configured: true }, sidebar_enabled: { library: false } } }), { [KEY]: '1' }) === null);
  check('someone else\'s memory is not used', run1(Object.assign({}, on, { user: { username: 'kim' } }), { [KEY]: '1' }) === null);
});

await run('Books switched off, or not set up: nothing is asked for, nothing is shown, the order is not held', async (make) => {
  for (const [name, branding] of [['off', { features: { books_configured: true }, sidebar_enabled: { library: false } }],
    ['not set up', { features: { books_configured: false }, sidebar_enabled: { library: true } }]]) {
    const t = make({ storage: { [KEY]: '1' }, branding, routes: routes({ items: CONT, notes: [] }) });
    await t.open();
    check(name + ': no request for Continue', t.net.urls('/api/books').length === 0);
    check(name + ': hidden, even for a person who had a row', t.host().hidden === true && !t.host().querySelector('[data-continue]'));
    check(name + ': Continue is marked arrived, so the sections below are not held', t.WS.arrived.indexOf('continue') !== -1, t.WS.arrived);
    check(name + ': nothing was kept or read for it', !t.WS.swrKeys.includes('books:continue'));
  }
});

await run('the answer fails: the row stays away and says nothing', async (make) => {
  const t = make({ storage: { [KEY]: '1' }, routes: routes(() => ({ status: 503, body: {} })) });
  await t.open();
  check('hidden', t.host().hidden === true);
  check('nothing about it on the page', t.host().textContent.trim() === '' || !/error|couldn/i.test(t.host().textContent), t.host().textContent);
  check('a failed read does not forget that they had a row', t.win.localStorage.getItem(KEY) === '1');
  const u = make({ routes: routes(() => ({ status: 401, body: {} })) });
  await u.open();
  check('signed out (401): hidden too', u.host().hidden === true);
});

await run('a kept copy shows at once, then the fresh answer corrects it without drawing twice', async (make) => {
  const t = make({ routes: routes({ items: CONT.slice(0, 1), notes: [] }) });
  t.WS.cache.set('books:continue', { items: CONT, notes: [] });
  await t.open();
  const cards = t.host().querySelectorAll('[data-continue] li');
  check('the fresh answer is what is there: one card, not three', cards.length === 1 && /Dune/.test(cards[0].textContent), cards.length);
  check('it was remembered from the fresh answer', t.win.localStorage.getItem(KEY) === '1');
  const u = make({ storage: { [KEY]: '1' }, routes: routes({ items: CONT, notes: [] }) });
  u.WS.cache.set('books:continue', { items: CONT, notes: [] });
  await u.open();
  check('a copy the same as the answer is drawn once', u.host().querySelectorAll('[data-continue] li').length === 2);
});

await run('a tap on an audiobook card resumes it in the player', async (make) => {
  const t = make({ routes: routes({ items: CONT, notes: [] }) });
  await t.open();
  t.q('#homeContinue [data-resume-audio="14:1"]').click();
  check('the player opens that book, playing', JSON.stringify(t.win.WS.player.opened) === JSON.stringify([['14:1', { autoplay: true }]]), t.win.WS.player.opened);
});

await run('the page names books.js and Home asks for that address only', async (make) => {
  const t = make({ routes: routes({ items: CONT, notes: [] }) });
  check('#wsPage carries the shared file\'s address', t.q('#wsPage').getAttribute('data-ws-dep') === BOOKS_URL);
  await t.open();
  check('and the row was drawn by it', !!t.q('#homeContinue [data-continue]'));
  const src = readFileSync(HOME_PATH, 'utf8');
  check('no import statement in the module (a bare path would not be stamped)', !/^\s*import\b[^(]/m.test(src));
  const bad = make({ routes: routes({ items: CONT, notes: [] }) });
  bad.q('#wsPage').setAttribute('data-ws-dep', 'data:text/javascript,throw new Error("gone")');
  await bad.open();
  check('a file that cannot load hides the row and breaks nothing else', bad.host().hidden === true && bad.WS.arrived.indexOf('continue') !== -1);
});

await run('leaving the page: nothing is written afterwards', async (make) => {
  const slow = deferred();
  const t = make({ routes: (net) => net.on('/api/books/continue', () => slow.promise.then(() => ({ body: { items: CONT, notes: [] } }))) });
  const m = t.mount();
  await t.clock.advance(400);
  t.ctl.abort();
  slow.resolve();
  await t.clock.advance(1700);
  await m.catch(() => {});
  check('no row after the visit ended', !t.host().querySelector('[data-continue]'));
  check('and nothing remembered from it', t.win.localStorage.getItem(KEY) === null);
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
