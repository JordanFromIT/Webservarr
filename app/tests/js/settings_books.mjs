// Settings for Books: the admin's Books tab (app/static/js/settings/books.js)
// and the Kavita and Chaptarr cards under Integrations (integrations.js, with
// the secret control in kit.js), run for real in happy-dom (a dev-only
// dependency) over Settings' own markup (settings.html) and the real kit,
// with a scripted server that keeps a small catalog.
//
// Covers: the Books tab (the status and counts, Rebuild now and what it
// does to the lists, the unpaired lists with their editions, picking one of
// each and pairing them, a pair showing as paired after a rebuild, keeping an
// edition apart, the choices and removing one, a change waiting for the next
// rebuild, a source's error, a failed load, a 403 for a non-admin, a 401, a
// stale pick, double presses, leaving the page); the Kavita API key (write
// only: it shows Saved, never the value, and goes with its address); the
// Chaptarr webhook (the address built from this page's own origin, a secret
// made here and shown once, copied, saved, then only Saved).
//
// Run: node app/tests/js/settings_books.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const SETTINGS_HTML = readFileSync(join(STATIC, 'settings.html'), 'utf8');
const SRC = {};
for (const f of ['ui.js', 'settings/kit.js', 'settings/signin-rule.js', 'settings/books.js', 'settings/integrations.js']) {
  SRC[f] = readFileSync(join(STATIC, 'js', f), 'utf8');
}
const BOOKS_TAB_SRC = process.env.BOOKS_TAB_JS ? readFileSync(process.env.BOOKS_TAB_JS, 'utf8') : SRC['settings/books.js'];

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

const flush = async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setImmediate(r)); };

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

// ---- A scripted server that keeps a small catalog ----

const MASK = '••••••••';
const T0 = Date.parse('2026-10-04T10:00:00.000Z');

function makeServer(over = {}) {
  let minute = 0;
  const stamp = () => new Date(T0 + (++minute) * 60000).toISOString();
  const s = {
    calls: [],
    // What the catalog holds: ebooks (Kavita chapters) and audiobook editions (Plex keys), and what pairs them.
    ebooks: [
      { id: 101, title: 'Dune', author: 'Frank Herbert', series: 'Dune' },
      { id: 105, title: 'Villette', author: 'Charlotte Brontë', series: '' },
      { id: 201, title: 'Emma', author: 'Jane Austen', series: '' },
      { id: 202, title: 'Persuasion', author: 'Jane Austen', series: '' }
    ],
    audio: [
      { key: '10:1', narrator: 'Scott Brick', title: 'Dune', author: 'Frank Herbert', series: 'Dune', ebook: 101 },
      { key: '11:1', narrator: 'Simon Vance', title: 'Dune', author: 'Frank Herbert', series: 'Dune', ebook: 101 },
      { key: '13:1', narrator: 'Nora Reed', title: 'Villette', author: 'Charlotte Brontë', series: '', ebook: 105 },
      { key: '31:1', narrator: 'Juliet Stevenson', title: 'Emma (Unabridged)', author: 'Jane Austen', series: '', ebook: null },
      { key: '32:1', narrator: 'Rob Inglis', title: 'The Hobbit', author: 'J. R. R. Tolkien', series: '', ebook: null }
    ],
    overrides: [],
    lastRebuild: stamp(),
    errors: { kavita: null, plex: null },
    running: false,
    as: 'admin',            // admin | member | signedout
    broken: new Set(),      // paths that answer 503
    failWrites: false,      // POST and DELETE on /overrides answer 503
    testAnswer: { success: false, state: 'warn', message: 'Connected, but the API key was refused' },
    slowRebuild: null,
    stamp
  };
  Object.assign(s, over);
  s.unpaired = () => ({
    ebooks: s.ebooks.filter((e) => !s.audio.some((a) => a.ebook === e.id)).map((e) => ({ book_id: e.id, kavita_chapter_id: e.id, title: e.title, author: e.author, series: e.series })),
    audiobooks: s.audio.filter((a) => a.ebook === null).map((a, i) => ({ book_id: 300 + i, plex_book_key: a.key, narrator: a.narrator, title: a.title, author: a.author, series: a.series }))
  });
  s.paired = () => {
    const books = [];
    for (const e of s.ebooks) {
      const eds = s.audio.filter((a) => a.ebook === e.id);
      if (eds.length) books.push({ book_id: e.id - 100, kavita_chapter_id: e.id, title: e.title, author: e.author, series: e.series, editions: eds.map((a) => ({ plex_book_key: a.key, narrator: a.narrator })) });
    }
    return { books };
  };
  s.shape = (o) => ({
    kavita_chapter_id: o.kavita_chapter_id, plex_book_key: o.plex_book_key, action: o.action, created_by: 'plex:1', created_at: o.created_at,
    ebook_title: (s.ebooks.find((e) => e.id === o.kavita_chapter_id) || {}).title || null,
    audio_title: (s.audio.find((a) => a.key === o.plex_book_key) || {}).title || null
  });
  s.rebuild = () => {
    // The admin's word wins over the titles: a pair joins them, an apart splits them.
    for (const a of s.audio) {
      const pair = s.overrides.find((o) => o.action === 'pair' && o.plex_book_key === a.key);
      const apart = s.overrides.some((o) => o.action === 'apart' && o.plex_book_key === a.key && o.kavita_chapter_id === a.ebook);
      const natural = s.ebooks.find((e) => e.title === a.title && e.author === a.author);
      if (pair) a.ebook = pair.kavita_chapter_id;
      else if (apart) a.ebook = null;
      else a.ebook = natural ? natural.id : null;
    }
    s.lastRebuild = stamp();
  };
  return s;
}

function installFetch(server, win) {
  return function fetchStub(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    server.calls.push({ method, url, init });
    const u = new URL(url, 'https://ws.test');
    const path = u.pathname;
    const reply = (status, body) => Promise.resolve({
      ok: status >= 200 && status < 300, status,
      json: () => Promise.resolve(body), text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body))
    });
    if (path === '/api/admin/settings' && u.search.indexOf('view=registry') !== -1) return reply(200, server.registry());
    if (path === '/api/admin/integrations/health') return reply(200, { integrations: {} });
    if (path === '/api/admin/test-connection' && method === 'POST') return reply(200, server.testAnswer);
    if (path === '/api/admin/chaptarr/options') return reply(503, { detail: 'Chaptarr did not answer' });
    if (path === '/api/admin/settings/bulk' && method === 'PUT') return server.bulk(JSON.parse(init.body), reply);
    if (path.indexOf('/api/admin/books') !== 0) return reply(404, {});
    if (server.as === 'signedout') return reply(401, { detail: 'Not authenticated' });
    if (server.as === 'member') return reply(403, { detail: 'Admin access required' });
    const sub = path.slice('/api/admin/books'.length);
    if (server.broken.has(sub)) return reply(503, { detail: 'The library is unavailable right now.' });
    if (sub === '/status' && method === 'GET') {
      return reply(200, { last_rebuild_at: server.lastRebuild, last_ok_at: server.lastRebuild, counts: { ebooks: server.ebooks.length, audiobooks: server.audio.length, books: server.ebooks.length + server.audio.filter((a) => a.ebook === null).length }, errors: server.errors, running: server.running });
    }
    if (sub === '/unpaired') return reply(200, server.unpaired());
    if (sub === '/paired') return reply(200, server.paired());
    if (sub === '/overrides' && method === 'GET') return reply(200, { overrides: server.overrides.map((o) => server.shape(o)) });
    if (server.failWrites && sub === '/overrides' && method !== 'GET') return reply(503, { detail: 'The override could not be saved right now' });
    if (sub === '/overrides' && method === 'POST') {
      const body = JSON.parse(init.body);
      if (!server.ebooks.some((e) => e.id === body.kavita_chapter_id) || !server.audio.some((a) => a.key === body.plex_book_key)) {
        return reply(404, { detail: 'That ebook or audiobook is not in the catalog' });
      }
      if (body.action === 'pair') server.overrides = server.overrides.filter((o) => !(o.action === 'pair' && o.plex_book_key === body.plex_book_key));
      server.overrides = server.overrides.filter((o) => !(o.kavita_chapter_id === body.kavita_chapter_id && o.plex_book_key === body.plex_book_key));
      const row = { kavita_chapter_id: body.kavita_chapter_id, plex_book_key: body.plex_book_key, action: body.action, created_at: server.stamp() };
      server.overrides.unshift(row);
      return reply(200, server.shape(row));
    }
    if (sub === '/overrides' && method === 'DELETE') {
      const id = Number(u.searchParams.get('kavita_chapter_id'));
      const key = u.searchParams.get('plex_book_key');
      const before = server.overrides.length;
      server.overrides = server.overrides.filter((o) => !(o.kavita_chapter_id === id && o.plex_book_key === key));
      return before === server.overrides.length ? reply(404, { detail: 'No such override' }) : reply(200, { removed: true });
    }
    if (sub === '/rebuild' && method === 'POST') {
      const done = () => {
        server.rebuild();
        return reply(200, { ok: true, ebooks: server.ebooks.length, audiobooks: server.audio.length, books: server.paired().books.length, errors: server.errors, skipped: false });
      };
      return server.slowRebuild ? server.slowRebuild.promise.then(done) : done();
    }
    return reply(404, {});
  };
}

// ---- One window, one visit to Settings ----

function registryFor(server, values, pairs) {
  server.registry = () => {
    const meta = {};
    for (const k of Object.keys(server.values)) meta[k] = { type: 'text', default: '', secret: /api_key|webhook_secret|token/.test(k), max_length: 500 };
    return { values: server.values, meta, mask: MASK, page_order: [], page_addresses: {}, address_credentials: pairs };
  };
}

async function visit(o = {}) {
  const url = o.url || 'https://ws.test/settings#books';
  const win = new Window({ url });
  const doc = win.document;
  doc.body.innerHTML = SETTINGS_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
  const clock = fakeClock();
  const ctl = new win.AbortController();
  const server = o.server || makeServer();
  server.values = Object.assign({
    'integration.kavita.url': 'http://192.168.1.20:5000', 'integration.kavita.api_key': MASK,
    'integration.chaptarr.url': 'http://192.168.1.30:8789', 'integration.chaptarr.api_key': MASK,
    'integration.chaptarr.webhook_secret': '', 'integration.plex.url': '', 'integration.plex.token': ''
  }, o.values || {});
  server.bulk = o.bulk || ((body, reply) => {
    const written = {};
    for (const it of body.settings) { server.values[it.key] = it.value === '' ? '' : (/api_key|webhook_secret|token/.test(it.key) ? MASK : it.value); written[it.key] = server.values[it.key]; }
    return reply(200, { values: written });
  });
  registryFor(server, null, o.pairs || { 'integration.kavita.url': 'integration.kavita.api_key', 'integration.chaptarr.url': 'integration.chaptarr.api_key' });
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const clipboard = [];
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText(text) { clipboard.push(text); return Promise.resolve(); } }, configurable: true });
  set('window', win);
  set('document', doc);
  set('location', win.location);
  set('localStorage', win.localStorage);
  set('fetch', installFetch(server, win));
  if (!process.env.DEBUG_TEST) set('console', { error() {}, warn() {}, log() {}, info() {}, debug() {} });
  set('ResizeObserver', class { observe() {} disconnect() {} });
  set('CustomEvent', win.CustomEvent);
  set('Event', win.Event);
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const run = (name, extra) => {
    const src = name === 'settings/books.js' ? BOOKS_TAB_SRC : SRC[name];
    new Function('window', 'document', 'localStorage', 'location', 'WSUI', 'WSSettings', 'fetch', src)(win, doc, win.localStorage, win.location, win.WSUI, win.WSSettings, globalThis.fetch);
  };
  run('ui.js');
  run('settings/kit.js');
  run('settings/signin-rule.js');
  run('settings/books.js');
  run('settings/integrations.js');
  const toasts = [];
  const realToast = win.WSUI.toast;
  win.WSUI.toast = (m, kind) => { toasts.push([m, kind]); return realToast(m, kind); };
  const polls = [];
  const ctx = {
    signal: ctl.signal,
    url: new URL(url),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    poll(fn, ms) { const p = { fn, ms }; polls.push(p); return () => {}; },
    beforeLeave() {}, onNavigate() {}
  };
  const left = [];
  const t = {
    win, doc, clock, ctl, server, toasts, polls, clipboard, left,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    text: (sel) => (doc.querySelector(sel) || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
    release() { for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; } },
    async open() {
      win.WSSettings.init(ctx);
      await clock.advance(50);
      await flush();
      return t;
    },
    async press(sel) {
      const n = typeof sel === 'string' ? doc.querySelector(sel) : sel;
      n.click();
      await clock.advance(20);
      await flush();
    },
    calls: (method, prefix) => server.calls.filter((c) => c.method === method && c.url.indexOf(prefix) === 0)
  };
  return t;
}

async function run(name, fn) {
  current = name;
  const made = [];
  try {
    await fn(async (o) => { const t = await visit(o); made.push(t); return t; });
  } catch (e) {
    failed += 1;
    total += 1;
    report(`FAIL ${name}: threw ${e && e.stack || e}`);
  } finally {
    while (made.length) { const t = made.pop(); t.ctl.abort(); t.release(); }
  }
}

const rows = (t, box) => t.qa(`${box} label`);
const names = (t, box) => rows(t, box).map((l) => (l.querySelector('span.block') || l).textContent.trim());
const panel = '[data-settings-panel="books"]';

// ---------------------------------------------------------------------------
// The Books tab
// ---------------------------------------------------------------------------

await run('the tab: a catalog status, counts, and the four cards', async (make) => {
  const t = await make();
  await t.open();
  check('it asked for the status and the three lists', t.calls('GET', '/api/admin/books/status').length >= 1 && t.calls('GET', '/api/admin/books/unpaired').length === 1 && t.calls('GET', '/api/admin/books/paired').length === 1 && t.calls('GET', '/api/admin/books/overrides').length === 1);
  const heads = t.qa(`${panel} h2`).map((h) => h.textContent);
  check('Catalog, Not matched, Matched books, Your choices, in that order', heads.join('|') === 'Catalog|Not matched|Matched books|Your choices', heads);
  check('built a while ago, and the counts in plain words', /Built \d+ \w+ ago\.|Built just now\./.test(t.text(`${panel} .min-h-6`)) && /6 books: 4 ebooks and 5 audiobook editions\./.test(t.text(panel)), t.text(`${panel} .min-h-6`));
  check('the skeleton is gone', !t.q(`${panel} [data-skel]`) && !t.q(`${panel} .skel`));
  check('the tab is in the strip, after Integrations', t.qa('#settingsTabs [data-tab]').map((a) => a.getAttribute('data-tab')).join() === 'general,pages,appearance,sign-in,integrations,books,notifications');
  check('and selected from the address', t.doc.documentElement.getAttribute('data-settings-tab') === 'books' && t.q('#tab-books').getAttribute('aria-selected') === 'true');
});

await run('the unpaired lists show every edition and its narrator', async (make) => {
  const t = await make();
  await t.open();
  check('ebooks without an audiobook: Persuasion and Emma', names(t, '#booksPickEbookBox, ' + panel + ' [role="radiogroup"][aria-label="Ebooks without an audiobook"]').sort().join() === 'Emma,Persuasion', names(t, panel + ' [role="radiogroup"]'));
  const audio = t.q(`${panel} [role="radiogroup"][aria-label="Audiobooks without an ebook"]`);
  const lines = Array.from(audio.querySelectorAll('label')).map((l) => l.textContent.replace(/\s+/g, ' ').trim());
  check('audiobooks without an ebook: each with its narrator', lines.length === 2 && lines.some((l) => /Emma \(Unabridged\).*Read by Juliet Stevenson/.test(l)) && lines.some((l) => /The Hobbit.*Read by Rob Inglis/.test(l)), lines);
  check('the lists are native radio groups (arrow keys work), each labelled', t.qa(`${panel} [role="radiogroup"] input[type="radio"]`).length === 4 && t.qa(`${panel} [role="radiogroup"][aria-label]`).length === 2);
  check('the Pair button starts out unable, with the reason beside it', t.q('#booksPair').getAttribute('aria-disabled') === 'true' && /Pick an ebook and an audiobook that are the same book\./.test(t.text(panel)));
});

await run('pairing: pick one of each, pair them, and after a rebuild they are one book', async (make) => {
  const t = await make();
  await t.open();
  const pick = async (group, value) => { const input = t.q(`${panel} input[name="${group}"][value="${value}"]`); input.checked = true; input.dispatchEvent(new t.win.Event('change', { bubbles: true })); await flush(); };
  await pick('booksPickEbook', '201');
  check('one pick is not enough', t.q('#booksPair').getAttribute('aria-disabled') === 'true');
  await t.press('#booksPair');
  check('pressing it then asks for the other, and sends nothing', t.calls('POST', '/api/admin/books/overrides').length === 0);
  await pick('booksPickAudio', '31:1');
  check('both picked: the button is ready and says what it will do', t.q('#booksPair').getAttribute('aria-disabled') === 'false' && /Pair “Emma” with “Emma \(Unabridged\)”, read by Juliet Stevenson\./.test(t.text(panel)), t.q('#booksPair').getAttribute('aria-disabled'));
  check('the chosen rows show it by their mark, not only a tint', t.q(`${panel} input[value="201"]`).parentNode.textContent.indexOf('radio_button_checked') !== -1 && t.q(`${panel} input[value="202"]`).parentNode.textContent.indexOf('radio_button_unchecked') !== -1);
  await t.press('#booksPair');
  const post = t.calls('POST', '/api/admin/books/overrides')[0];
  check('it sent the pair, as a pair', post && JSON.parse(post.init.body).kavita_chapter_id === 201 && JSON.parse(post.init.body).plex_book_key === '31:1' && JSON.parse(post.init.body).action === 'pair', post && post.init.body);
  check('with the page\'s own cookie, as JSON', post.init.credentials === 'same-origin' && post.init.headers['Content-Type'] === 'application/json');
  check('the choice is listed, and says it shows after the next rebuild', /Paired/.test(t.text('#booksChoices')) && /Emma with Emma \(Unabridged\), read by Juliet Stevenson/.test(t.text('#booksChoices')) && /Your changes show after the next rebuild\./.test(t.text(panel)), t.text('#booksChoices'));
  check('the pick was cleared', t.q(`${panel} input:checked`) === null);
  check('and the toast says the same', t.toasts.some((x) => /Paired\. It shows after the next rebuild\./.test(x[0]) && x[1] === 'ok'), t.toasts);
  check('the lists still show them apart until the rebuild', names(t, panel + ' [role="radiogroup"][aria-label="Ebooks without an audiobook"]').indexOf('Emma') !== -1);
  await t.press('#booksRebuild');
  check('Rebuild now posted', t.calls('POST', '/api/admin/books/rebuild').length === 1);
  check('after it, Emma is paired: gone from both unpaired lists', names(t, panel + ' [role="radiogroup"][aria-label="Ebooks without an audiobook"]').join() === 'Persuasion' && !t.q(`${panel} input[value="31:1"]`), names(t, panel));
  const matched = t.text('#booksMatched');
  check('and shown under Matched books with its narrator', /Emma/.test(matched) && /Read by Juliet Stevenson/.test(matched), matched);
  check('the change is no longer waiting', !/Your changes show after the next rebuild\./.test(t.text(panel)));
  check('the choice stays in the list, for good', /Emma with Emma \(Unabridged\)/.test(t.text('#booksChoices')));
  check('a toast said how many books', t.toasts.some((x) => /Rebuilt: \d+ books?\./.test(x[0])), t.toasts);
});

await run('unpairing: remove the choice, rebuild, and they are apart again', async (make) => {
  const t = await make();
  t.server.overrides = [{ kavita_chapter_id: 201, plex_book_key: '31:1', action: 'pair', created_at: t.server.stamp() }];
  t.server.rebuild();
  await t.open();
  check('they start out paired', t.text('#booksMatched').indexOf('Juliet Stevenson') !== -1);
  const remove = t.q('#booksChoices button');
  check('the Remove button says which choice it removes', /Remove this choice: pair Emma with Emma \(Unabridged\)/.test(remove.getAttribute('aria-label')), remove.getAttribute('aria-label'));
  await t.press(remove);
  const del = t.calls('DELETE', '/api/admin/books/overrides')[0];
  check('it sent the right pair, in the address', del && /kavita_chapter_id=201&plex_book_key=31%3A1$/.test(del.url), del && del.url);
  check('the choice is gone and nothing is set by hand', /Nothing set by hand yet\./.test(t.text('#booksChoices')));
  check('with a note that the rebuild has not run', /Your changes show after the next rebuild\./.test(t.text(panel)));
  check('focus did not fall to the page: it is on the list', t.doc.activeElement === t.q('#booksChoices'));
  await t.press('#booksRebuild');
  check('after the rebuild they are in the unpaired lists again', t.q(`${panel} input[value="31:1"]`) !== null && names(t, panel + ' [role="radiogroup"][aria-label="Ebooks without an audiobook"]').indexOf('Emma') !== -1);
  check('and gone from Matched books', t.text('#booksMatched').indexOf('Juliet Stevenson') === -1);
});

await run('keeping a pair apart: one edition, from the matched list', async (make) => {
  const t = await make();
  await t.open();
  const buttons = t.qa('#booksMatched button');
  check('every edition has its own button, named by its narrator and book, and the name starts with the button\'s own words (WCAG 2.5.3)', buttons.length === 3 && buttons.every((b) => b.getAttribute('aria-label').indexOf(b.textContent.trim()) === 0) && buttons.some((b) => /^Keep apart: the audiobook read by Simon Vance and the ebook of Dune$/.test(b.getAttribute('aria-label'))), buttons.map((b) => b.getAttribute('aria-label')));
  await t.press(buttons.find((b) => /Simon Vance/.test(b.getAttribute('aria-label'))));
  const post = t.calls('POST', '/api/admin/books/overrides')[0];
  const body = post && JSON.parse(post.init.body);
  check('it sent that edition and that ebook, as apart', body && body.kavita_chapter_id === 101 && body.plex_book_key === '11:1' && body.action === 'apart', body);
  check('the other edition of the same book was not touched', t.qa('#booksMatched button').length === 2);
  check('the edition says what will happen', /Kept apart at the next rebuild/.test(t.text('#booksMatched')));
  check('and the choice is listed', /Kept apart/.test(t.text('#booksChoices')) && /Dune and Dune, read by Simon Vance/.test(t.text('#booksChoices')), t.text('#booksChoices'));
  await t.press('#booksRebuild');
  check('after the rebuild that edition is an audiobook without an ebook', t.q(`${panel} input[value="11:1"]`) !== null);
  check('and Dune keeps its other narration', /Scott Brick/.test(t.text('#booksMatched')) && !/Simon Vance/.test(t.text('#booksMatched')));
});

await run('the matched list is searchable and says when it shows only some', async (make) => {
  const t = await make();
  await t.open();
  const find = t.q('#booksFind');
  find.value = 'villette';
  find.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('typing narrows it', /Villette/.test(t.text('#booksMatched')) && !/Dune/.test(t.text('#booksMatched')));
  find.value = 'zzz';
  find.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('nothing found says so', /Nothing matches that\./.test(t.text('#booksMatched')));
  check('the box is labelled', t.q('label[for="booksFind"]').textContent === 'Find a book');
});

await run('Rebuild now: busy while it runs, a second press does nothing, then the lists are fresh', async (make) => {
  const slow = { promise: null };
  let release;
  slow.promise = new Promise((r) => { release = r; });
  const t = await make({ server: makeServer({ slowRebuild: slow }) });
  await t.open();
  const btn = t.q('#booksRebuild');
  btn.click();
  await flush();
  check('it says what it is doing', /Rebuilding…/.test(btn.textContent) && btn.getAttribute('aria-disabled') === 'true');
  btn.click();
  btn.click();
  await flush();
  check('presses meanwhile start nothing more', t.calls('POST', '/api/admin/books/rebuild').length === 1);
  check('the spinner turns only for a person who has not asked for less motion', /motion-safe:animate-spin/.test(btn.querySelector('span').className) && !/(^| )animate-spin/.test(btn.querySelector('span').className));
  release();
  await t.clock.advance(50);
  check('done: the button is back', /Rebuild now/.test(btn.textContent) && btn.getAttribute('aria-disabled') === 'false');
});

await run('a rebuild that skipped, or that a source did not answer for, says so plainly', async (make) => {
  const t = await make({ server: makeServer({ errors: { kavita: 'Kavita did not answer', plex: null } }) });
  await t.open();
  check('the last answer\'s error is shown as a sentence, as a warning', /Kavita did not answer\./.test(t.text(panel)));
  await t.press('#booksRebuild');
  check('the toast says a source did not answer, and that nothing was lost', t.toasts.some((x) => /a source didn’t answer\. The books it had before are kept\./.test(x[0])), t.toasts);
});

await run('a person who is not an admin gets nothing: no lists, no buttons, and nothing is sent', async (make) => {
  const t = await make({ server: makeServer({ as: 'member' }) });
  await t.open();
  check('the tab says who can use it', /Only admins can change how books are matched\./.test(t.text(panel)));
  check('there is no Rebuild, no Pair and no list on the page', !t.q('#booksRebuild') && !t.q('#booksPair') && !t.q(`${panel} [role="radiogroup"]`) && !t.q(`${panel} button`));
  check('only reads were made, and none after the first refusal wrote anything', t.server.calls.filter((c) => c.method !== 'GET' && c.url.indexOf('/api/admin/books') === 0).length === 0);
});

await run('a signed-out session goes to sign-in', async (make) => {
  const t = await make({ server: makeServer({ as: 'signedout' }) });
  const moved = [];
  Object.defineProperty(t.win.location, 'href', { set(v) { moved.push(v); }, get() { return 'https://ws.test/settings#books'; }, configurable: true });
  await t.open();
  check('it leaves for /login', moved.indexOf('/login') !== -1, moved);
});

await run('lists that cannot load say so inside their boxes and the page still works', async (make) => {
  const server = makeServer();
  server.broken = new Set(['/unpaired', '/paired', '/overrides']);
  const t = await make({ server });
  await t.open();
  check('each box says it could not load', t.qa(`${panel} .h-72`).length === 3 && t.qa(`${panel} .h-72`).every((b) => /This couldn’t load\. Try again in a moment\./.test(b.textContent)), t.qa(`${panel} .h-72`).map((b) => b.textContent));
  check('the choices say so too', /This couldn’t load\. Try again in a moment\./.test(t.text('#booksChoices')));
  check('the status still shows', /books:/.test(t.text(panel)));
  server.broken = new Set();
  t.polls[0].fn();
  await t.clock.advance(50);
  server.rebuild();
  await t.press('#booksRebuild');
  check('Rebuild now reloads them', t.qa(`${panel} [role="radiogroup"] label`).length > 0 && /Dune/.test(t.text('#booksMatched')));
});

await run('a status that cannot load says so on its first line', async (make) => {
  const server = makeServer();
  server.broken = new Set(['/status']);
  const t = await make({ server });
  await t.open();
  check('the first line says it, with a neutral mark', /This couldn’t load\. Try again in a moment\./.test(t.text(`${panel} .min-h-6`)) && /ws-light-unconfigured/.test(t.q(`${panel} .ws-light`).className));
});

await run('a pick that was overtaken (the catalog moved on) is dropped, and the lists show what there is now', async (make) => {
  const t = await make();
  await t.open();
  const pick = async (group, value) => { const input = t.q(`${panel} input[name="${group}"][value="${value}"]`); input.checked = true; input.dispatchEvent(new t.win.Event('change', { bubbles: true })); await flush(); };
  await pick('booksPickEbook', '202');
  await pick('booksPickAudio', '32:1');
  // Someone rebuilt in between and the ebook is gone.
  t.server.ebooks = t.server.ebooks.filter((e) => e.id !== 202);
  await t.press('#booksPair');
  check('the answer was a 404, said in its own words', t.toasts.some((x) => /That ebook or audiobook is not in the catalog\./.test(x[0]) && x[1] === 'err'), t.toasts);
  check('the lists were read again and the stale ebook is gone', !t.q(`${panel} input[value="202"]`));
  check('the pick of it was dropped', t.q('#booksPair').getAttribute('aria-disabled') === 'true');
});

await run('presses that overlap send one request', async (make) => {
  const t = await make();
  await t.open();
  const input = (g, v) => { const i = t.q(`${panel} input[name="${g}"][value="${v}"]`); i.checked = true; i.dispatchEvent(new t.win.Event('change', { bubbles: true })); };
  input('booksPickEbook', '202');
  input('booksPickAudio', '32:1');
  await flush();
  const pair = t.q('#booksPair');
  pair.click();
  pair.click();
  pair.click();
  await t.clock.advance(50);
  check('one POST for three presses', t.calls('POST', '/api/admin/books/overrides').length === 1);
});

await run('a rebuild that finished somewhere else shows up on the poll', async (make) => {
  const t = await make();
  await t.open();
  check('the tab polls its status', t.polls.length === 1 && t.polls[0].ms === 15000);
  t.server.overrides = [{ kavita_chapter_id: 202, plex_book_key: '32:1', action: 'pair', created_at: t.server.stamp() }];
  t.server.rebuild();
  t.polls[0].fn();
  await t.clock.advance(50);
  check('the lists were read again and the pair is in Matched books', /Persuasion/.test(t.text('#booksMatched')) && /Rob Inglis/.test(t.text('#booksMatched')), t.text('#booksMatched'));
});

await run('leaving the page ends its requests and listeners', async (make) => {
  const t = await make();
  await t.open();
  const before = t.server.calls.length;
  t.ctl.abort();
  t.q('#booksRebuild') && t.q('#booksRebuild').click();
  await flush();
  check('nothing is sent after leaving', t.server.calls.length === before, t.server.calls.slice(before).map((c) => c.url));
  check('every request carried the visit\'s signal', t.server.calls.filter((c) => c.url.indexOf('/api/admin/books') === 0).every((c) => c.init.signal === t.ctl.signal));
});

await run('T5H1: a pair hint with a very long title wraps (it cannot push a phone wider)', async (make) => {
  const t = await make();
  t.server.ebooks[2].title = 'Averyveryverylongtitlewithnospacesatall'.repeat(2);
  await t.open();
  const hint = t.q('#booksPair').parentNode.querySelector('p');
  check('the hint may break inside a word and shrink', /\bbreak-words\b/.test(hint.className) && /\bmin-w-0\b/.test(hint.className), hint.className);
  const pick = (g, v) => { const i = t.q(`${panel} input[name="${g}"][value="${v}"]`); i.checked = true; i.dispatchEvent(new t.win.Event('change', { bubbles: true })); };
  pick('booksPickEbook', '201');
  pick('booksPickAudio', '31:1');
  await flush();
  check('with the long title in it', hint.textContent.indexOf('Averyvery') !== -1);
  check('the matched and choice rows break words too', /\bbreak-words\b/.test(t.q('#booksMatched div div').className));
});

await run('T5H4: a Keep apart or Remove that fails leaves a working button, not a disabled one', async (make) => {
  const t = await make();
  t.server.overrides = [{ kavita_chapter_id: 201, plex_book_key: '31:1', action: 'pair', created_at: t.server.stamp() }];
  t.server.rebuild();
  await t.open();
  t.server.failWrites = true;
  const keep = t.qa('#booksMatched button')[0];
  await t.press(keep);
  check('the failure was told', t.toasts.some((x) => x[1] === 'err'), t.toasts);
  const again = t.qa('#booksMatched button')[0];
  check('Keep apart is pressable again (aria-disabled is not true)', again.getAttribute('aria-disabled') !== 'true', again.getAttribute('aria-disabled'));
  const remove = t.q('#booksChoices button');
  await t.press(remove);
  check('Remove too', remove.getAttribute('aria-disabled') === 'false', remove.getAttribute('aria-disabled'));
  t.server.failWrites = false;
  const sent = t.calls('POST', '/api/admin/books/overrides').length + t.calls('DELETE', '/api/admin/books/overrides').length;
  await t.press(t.qa('#booksMatched button')[0]);
  check('and a second try goes out', t.calls('POST', '/api/admin/books/overrides').length + t.calls('DELETE', '/api/admin/books/overrides').length === sent + 1);
});

await run('the tab writes text only', async () => {
  const src = readFileSync(join(STATIC, 'js/settings/books.js'), 'utf8');
  check('no innerHTML, outerHTML or insertAdjacentHTML', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
  check('no native dialog', !/(?<![\w.])(?:confirm|alert|prompt)\(/.test(src.replace(/WSSettings\.confirm\(/g, '')));
});

// ---------------------------------------------------------------------------
// The Kavita API key and the Chaptarr webhook (Integrations)
// ---------------------------------------------------------------------------

await run('the Kavita card has a write-only API key that goes with its address', async (make) => {
  const t = await make({ url: 'https://ws.test/settings#integrations' });
  await t.open();
  const card = t.q('#integration-card-kavita');
  check('the card has its address and its key', !!card && !!card.querySelector('#ws-f-integration-kavita-url') && !!card.querySelector('#ws-f-integration-kavita-api-key'));
  const key = card.querySelector('#ws-f-integration-kavita-api-key');
  check('there is a key field', !!key);
  const chip = Array.from(card.querySelectorAll('span')).find((s) => s.textContent.trim() === 'lockSaved');
  check('a key that is saved says Saved and shows nothing of itself', !!chip && key.value === '' && card.textContent.indexOf(MASK) === -1);
  check('the words say what it is for, and that it only goes to the address', /Lets the Books page list your ebooks for everyone\./.test(card.textContent) && /It only goes to the address above\./.test(card.textContent));
  // The address and the key are one pair: editing the key clears the message the address got.
  const url = card.querySelector('#ws-f-integration-kavita-url');
  url.value = 'http://10.66.6.6:5000';
  url.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('changing the address stages it', t.text('#settingsSaveBar').indexOf('1 unsaved change') !== -1);
  t.server.bulk = (body, reply) => reply(422, { errors: { 'integration.kavita.url': 'Enter the key again for the new address' } });
  // The kit asks before a Kavita address moves.
  await t.press('#settingsSaveBar button:last-of-type');
  const yes = t.qa('button').find((b) => /Save the change/.test(b.textContent));
  check('it asks first, because everyone\'s ebook connection resets', !!yes);
  if (yes) { yes.click(); await t.clock.advance(50); await flush(); }
  const sent = t.calls('PUT', '/api/admin/settings/bulk')[0];
  check('the save sent the address alone, no key', sent && JSON.parse(sent.init.body).settings.length === 1 && JSON.parse(sent.init.body).settings[0].key === 'integration.kavita.url', sent && sent.init.body);
  check('and the refusal sits on the address', /Enter the key again for the new address/.test(card.textContent), card.textContent.slice(0, 200));
  // Entering the key again (Replace, then typing it) clears that message, as the pair map says.
  const replace = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Replace');
  replace.click();
  key.value = 'SYNTH-NEW-KAVITA-KEY';
  key.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('typing the key again clears the message on the address', !/Enter the key again for the new address/.test(card.textContent));
  check('and stages the key with the address', t.text('#settingsSaveBar').indexOf('2 unsaved changes') !== -1, t.text('#settingsSaveBar'));
  check('the typed key is in a password field, never shown', key.type === 'password');
});

await run('the Kavita card\'s Test sends the key on screen (or the saved one) and shows the answer, a wrong key included', async (make) => {
  const t = await make({ url: 'https://ws.test/settings#integrations' });
  await t.open();
  const card = t.q('#integration-card-kavita');
  const test = Array.from(card.querySelectorAll('button')).find((b) => b.textContent.indexOf('Test') !== -1);
  await t.press(test);
  const sent = t.calls('POST', '/api/admin/test-connection')[0];
  const body = sent && JSON.parse(sent.init.body);
  check('it asked for Kavita with its address and the saved key as the mask, never a value', body && body.service === 'kavita' && body.url === 'http://192.168.1.20:5000' && body.credentials === MASK, body);
  check('the answer is shown in the card, in the server\'s words', /Connected, but the API key was refused/.test(card.textContent), card.textContent.slice(-200));
});

await run('the Chaptarr webhook: this page\'s own address, never typed in', async (make) => {
  const t = await make({ url: 'https://ws.test/settings#integrations' });
  await t.open();
  const field = t.q('#chaptarrWebhookUrl');
  check('the address is shown, read-only, and is this site\'s own', field && field.readOnly === true && field.value === 'https://ws.test/api/webhooks/chaptarr', field && field.value);
  check('with a label for it', t.q('label[for="chaptarrWebhookUrl"]').textContent === 'Webhook address');
  await t.press(Array.from(t.qa('#integration-card-chaptarr button')).find((b) => b.textContent.indexOf('Copy') !== -1 && !b.classList.contains('hidden')));
  check('Copy puts the address on the clipboard', t.clipboard[0] === 'https://ws.test/api/webhooks/chaptarr', t.clipboard);
  const other = await make({ url: 'https://books.example.org:8443/settings#integrations' });
  await other.open();
  check('it follows the address the page was opened at (nothing is hard-coded)', other.q('#chaptarrWebhookUrl').value === 'https://books.example.org:8443/api/webhooks/chaptarr', other.q('#chaptarrWebhookUrl').value);
  const src = readFileSync(join(STATIC, 'js/settings/integrations.js'), 'utf8');
  check('no site name in the source', !/https?:\/\/[a-z0-9.-]+\.(tv|com|org|net)\/api\/webhooks/.test(src));
  check('the setup steps are in plain words', /In Chaptarr: Settings → Connect → \+ → Webhook\. Tick On Grab, On Release Import, On Upgrade, On Book Delete, On Book File Delete and On Author Delete\. Leave On Book File Delete For Upgrade unticked, or upgrades show as removed\. Method POST\. Any Username\. Password = the secret\./.test(t.q('#integration-card-chaptarr').textContent));
});

// Sonarr and Radarr call the same address with their own name (the event log).
await run('the Sonarr and Radarr webhooks: their own address, secret and boxes to tick', async (make) => {
  const t = await make({ url: 'https://ws.test/settings#integrations',
    values: { 'integration.sonarr.webhook_secret': '', 'integration.radarr.webhook_secret': MASK } });
  await t.open();
  const ticks = {
    sonarr: 'In Sonarr: Settings → Connect → + → Webhook. Tick On Grab, On File Import, On File Upgrade, On Import Complete, On Rename, On Series Add, On Series Delete and On Episode File Delete. Method POST. Any Username. Password = the secret.',
    radarr: 'In Radarr: Settings → Connect → + → Webhook. Tick On Grab, On File Import, On File Upgrade, On Movie Added, On Movie Delete and On Movie File Delete. Method POST. Any Username. Password = the secret.'
  };
  for (const app of ['sonarr', 'radarr']) {
    const card = t.q('#integration-card-' + app);
    const field = t.q('#' + app + 'WebhookUrl');
    check(app + ': its address is this site\'s own, read-only', field && field.readOnly === true && field.value === 'https://ws.test/api/webhooks/' + app, field && field.value);
    check(app + ': the heading names it', card.querySelector('h3') && card.querySelector('h3').textContent === 'Tell ' + (app === 'sonarr' ? 'Sonarr' : 'Radarr') + ' to ping this site');
    check(app + ': which boxes to tick', card.textContent.indexOf(ticks[app]) !== -1);
    check(app + ': its own secret field', !!card.querySelector('#ws-f-integration-' + app + '-webhook-secret'));
  }
  const sonarr = t.q('#integration-card-sonarr');
  check('an empty secret offers one to make', Array.from(sonarr.querySelectorAll('button')).some((b) => b.textContent === 'Generate secret'));
  const radarr = t.q('#integration-card-radarr');
  check('a saved one is never shown, only a new one offered', Array.from(radarr.querySelectorAll('button')).some((b) => b.textContent === 'Generate new secret') && radarr.querySelector('#ws-f-integration-radarr-webhook-secret').value === '');
  await t.press(Array.from(sonarr.querySelectorAll('button')).find((b) => b.textContent === 'Generate secret'));
  await t.press('#settingsSaveBar button:last-of-type');
  const sent = t.calls('PUT', '/api/admin/settings/bulk')[0];
  const body = sent && JSON.parse(sent.init.body);
  check('Save sends only Sonarr\'s secret', body && body.settings.length === 1 && body.settings[0].key === 'integration.sonarr.webhook_secret' && /^[A-Za-z0-9]{32}$/.test(body.settings[0].value), body);
});

await run('the webhook secret is made here, shown once, copied, saved, and then only "Saved"', async (make) => {
  const t = await make({ url: 'https://ws.test/settings#integrations' });
  await t.open();
  const card = t.q('#integration-card-chaptarr');
  const secret = card.querySelector('#ws-f-integration-chaptarr-webhook-secret');
  check('nothing is set yet: an empty field and a Generate button', secret && secret.value === '' && Array.from(card.querySelectorAll('button')).some((b) => b.textContent === 'Generate secret'));
  const gen = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Generate secret');
  await t.press(gen);
  const made = secret.value;
  check('a secret of 32 letters and digits was made and is shown, so it can be copied', /^[A-Za-z0-9]{32}$/.test(made) && secret.type === 'text', made && made.length);
  check('no look-alike characters (it gets typed into another program)', !/[0O1lI]/.test(made), made);
  check('it is staged, and the bar says so', t.text('#settingsSaveBar').indexOf('1 unsaved change') !== -1);
  check('a toast says to copy it now', t.toasts.some((x) => /Copy it now: after you save it, it can’t be shown again\./.test(x[0])), t.toasts);
  const copy = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Copy' && !b.classList.contains('hidden') && b.closest('.flex-wrap') && b.parentNode.contains(secret));
  check('a Copy button next to it is shown', !!copy);
  await t.press(copy);
  check('it copies exactly that secret', t.clipboard[t.clipboard.length - 1] === made);
  await t.press('#settingsSaveBar button:last-of-type');
  const sent = t.calls('PUT', '/api/admin/settings/bulk')[0];
  const body = sent && JSON.parse(sent.init.body);
  check('Save sent it as the setting\'s value', body && body.settings.length === 1 && body.settings[0].key === 'integration.chaptarr.webhook_secret' && body.settings[0].value === made, body);
  check('afterwards the field is empty and a password field again', secret.value === '' && secret.type === 'password');
  const saved = Array.from(card.querySelectorAll('span')).find((s) => s.textContent.trim() === 'lockSaved');
  check('and the card says Saved', !!saved && !saved.parentNode.classList.contains('hidden'));
  check('the secret is nowhere on the page', t.doc.body.textContent.indexOf(made) === -1 && t.doc.body.innerHTML.indexOf(made) === -1);
  const again = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Generate new secret');
  check('a saved secret offers a new one, by its own name', !!again);
  await t.press(again);
  check('a new one is a different secret', /^[A-Za-z0-9]{32}$/.test(secret.value) && secret.value !== made);
});

await run('Cancelling or discarding a made secret leaves nothing readable behind', async (make) => {
  const t = await make({ url: 'https://ws.test/settings#integrations', values: { 'integration.chaptarr.webhook_secret': MASK } });
  await t.open();
  const card = t.q('#integration-card-chaptarr');
  const secret = card.querySelector('#ws-f-integration-chaptarr-webhook-secret');
  await t.press(Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Generate new secret'));
  const made = secret.value;
  check('made and shown', /^[A-Za-z0-9]{32}$/.test(made) && secret.type === 'text');
  await t.press(Array.from(secret.parentNode.querySelectorAll('button')).find((b) => b.textContent === 'Cancel'));
  check('Cancel puts back "Saved", empties the field and hides it', secret.value === '' && secret.type === 'password' && t.doc.body.textContent.indexOf(made) === -1, [secret.value, secret.type, t.doc.body.textContent.indexOf(made)]);
  await t.press(Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Generate new secret'));
  const second = secret.value;
  await t.press('#settingsSaveBar button:first-of-type');
  check('Discard does too', secret.value === '' && secret.type === 'password' && t.doc.body.textContent.indexOf(second) === -1);
  check('and nothing was saved', t.calls('PUT', '/api/admin/settings/bulk').length === 0);
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
