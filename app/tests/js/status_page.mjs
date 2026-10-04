// The status feed page (app/static/js/pages/status.js, app/static/status.html)
// run in happy-dom over its own markup, with a scripted network, a fake clock
// and a fake shell (WS.swr and WS.arrive as shell.js does them).
//
// Covers: open outages and important notes pinned as cards, with times; the
// one-line state when nothing is open, and never "All services running"
// unless the feed says ok (Uptime Kuma silent, the feed unreachable); no line
// without Uptime Kuma; the last 30 days by day, newest first, with each
// update's time; the empty and error states; every answer written as text;
// admins: "Post a note" opens the form, an empty note is marked on the field
// (not a toast) and takes the focus, a note is posted with its importance and
// service and the feed is read again, resolve and delete (after asking);
// members get no tools and no form; the page module's contract (stamped tag,
// the route, the nav); leaving the page writes nothing.
//
// STATUS_JS=<path> runs the same cases against another copy of the module.
// Run: node app/tests/js/status_page.mjs (npm run test:js; CI js-checks).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const STATUS_PATH = process.env.STATUS_JS || join(STATIC, 'js/pages/status.js');
const HTML_PATH = join(STATIC, 'status.html');
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

if (!existsSync(STATUS_PATH) || !existsSync(HTML_PATH)) {
  check('the /status page module and its page exist', false, { STATUS_PATH, HTML_PATH });
  console.log(`${total - failed}/${total} checks passed, ${failed} FAILED`);
  process.exit(1);
}
const PAGE_HTML = readFileSync(HTML_PATH, 'utf8');

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

globalThis.getTimeAgo = new Function(AUTH_SRC.slice(AUTH_SRC.indexOf('function getTimeAgo')) + '\nreturn getTimeAgo;')();
// A data: URL, as the other page tests import their modules (no module-type warning).
const page = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(STATUS_PATH, 'utf8')));

function network() {
  const handlers = [];
  const calls = [];
  return {
    calls,
    on(prefix, fn) { handlers.unshift({ prefix, fn }); },
    urls(prefix) { return calls.filter((c) => c.url.indexOf(prefix) === 0).map((c) => c.url); },
    fetch(url, init) {
      calls.push({ url, init: init || {} });
      const h = handlers.find((x) => url.indexOf(x.prefix) === 0);
      if (!h) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve(h.fn(url, init || {})).then((r) => {
        const res = r || { body: {} };
        const status = res.status || 200;
        return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(res.body) };
      });
    }
  };
}

function fakeShell(doc, clock, net) {
  const store = new Map();
  const arr = { order: [], done: {}, queue: {}, gate: false };
  const WS = {
    arrived: [], dropped: [],
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
      return Promise.resolve().then(fetcher).then((fresh) => {
        if (JSON.stringify(fresh) !== cachedJSON) render(fresh, false);
        store.set(key, fresh);
        return fresh;
      }, (err) => {
        if (cachedJSON === null && opts.onError) opts.onError(err);
        return cachedJSON === null ? null : cached;
      });
    },
    dropCache(prefix) { WS.dropped.push(prefix); for (const k of Array.from(store.keys())) if (k.indexOf(prefix) === 0) store.delete(k); },
    getJSON(url, opts) {
      return net.fetch(url, opts && opts.signal ? { signal: opts.signal } : undefined).then((r) => {
        if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json();
      });
    }
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

const HOUR = 3600000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const OUTAGE = { id: 7, source: 'auto', text: 'Plex is down', service: 'Plex', important: false, resolved: false, started_at: iso(25 * 60000), created_at: iso(24 * 60000), at: iso(24 * 60000) };
const NOTE = { id: 8, source: 'admin', text: 'The server restarts at 9 PM.', service: null, important: true, resolved: false, created_at: iso(2 * HOUR), at: iso(2 * HOUR) };
const BACK = { id: 3, source: 'auto', text: 'Sonarr is back, down 12 min', service: 'Sonarr', important: false, resolved: true, at: iso(26 * HOUR), created_at: iso(27 * HOUR) };
const OLD_NOTE = { id: 4, source: 'admin', text: '<b>Bold?</b> No.', service: 'Plex', important: false, resolved: false, at: iso(5 * 24 * HOUR), created_at: iso(5 * 24 * HOUR) };
const TODAY = { id: 5, source: 'auto', text: 'Radarr is back, down 3 min', service: 'Radarr', important: false, resolved: true, at: iso(60000), created_at: iso(10 * 60000) };

const NAV = /<div id="wsPage"[\s\S]*<\/main>/;

function visit(o = {}) {
  const win = new Window({ url: 'https://ws.test/status' });
  const doc = win.document;
  doc.body.innerHTML = PAGE_HTML.match(NAV)[0].replace(/<\/main>$/, '');
  if (o.admin) doc.documentElement.setAttribute('data-admin', '');
  const clock = fakeClock();
  const net = network();
  const ctl = new win.AbortController();
  const WS = fakeShell(doc, clock, net);
  const toasts = [];
  const asked = [];
  win.WSUI = {
    toast(text, tone) { toasts.push([text, tone]); },
    confirm(opts) { asked.push(opts); return Promise.resolve(o.confirm !== false); }
  };
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win);
  set('document', doc);
  set('WS', WS);
  set('WSUI', win.WSUI);
  win.WS = WS;
  win.fetch = (u, i) => net.fetch(u, i);
  set('fetch', win.fetch);
  set('console', { error() {}, warn() {}, log() {}, info() {} });
  let feed = o.feed === undefined ? { state: 'ok', open: [], items: [TODAY, BACK, OLD_NOTE] } : o.feed;
  net.on('/api/status/feed', () => (typeof feed === 'function' ? feed() : { body: feed }));
  net.on('/api/status/notes', (url, init) => (o.write ? o.write(url, init) : { status: 201, body: {} }));
  const polls = [];
  const ctx = {
    root: doc.getElementById('wsPage'), signal: ctl.signal, url: new URL('https://ws.test/status'),
    data: { user: { username: 'sam' } },
    poll(fn, ms) { polls.push({ fn, ms }); return () => {}; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id)
  };
  WS.arriveReset();
  return {
    win, doc, clock, net, ctl, WS, ctx, toasts, asked, polls,
    setFeed(f) { feed = f; },
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    async open() { const m = page.mount(ctx); await clock.advance(1700); await m; },
    release() { for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; } }
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

// ---------------------------------------------------------------------------

await run('the page: a title, one plain line, the module stamped, the route and nav', async () => {
  check('a visible h1 "Status" and one line under it', /<h1[^>]*>Status<\/h1>/.test(PAGE_HTML) && /How the server has been doing over the last 30 days, newest first\./.test(PAGE_HTML));
  check('the page module is named with a stamp tag', PAGE_HTML.indexOf('data-ws-module="/static/js/pages/status.js?v=1"') !== -1);
  check('the title is the site\'s format', /<title>WebServarr - Status<\/title>/.test(PAGE_HTML));
  check('no inline script (CSP)', !/<script>/.test(PAGE_HTML) && !/\son[a-z]+=/i.test(PAGE_HTML));
  const main = readFileSync(join(STATIC, '..', 'main.py'), 'utf8');
  check('the server serves /status to signed-in people', /@app\.get\("\/status"[\s\S]{0,900}render_page\("status", request, user\)/.test(main));
  const pages = readFileSync(join(STATIC, '..', 'pages.py'), 'utf8');
  check('and Home is its nav item', /"status": "home"/.test(pages));
});

await run('nothing open, all running: the line, then the last 30 days by day', async (make) => {
  const t = make({});
  await t.open();
  const line = t.q('[data-state-line]');
  check('the one-line state', line && line.getAttribute('data-state-line') === 'ok' && /All services running/.test(line.textContent));
  const days = t.qa('#statusFeed h3').map((h) => h.textContent);
  check('grouped by day, newest first', days[0] === 'Today' && days[1] === 'Yesterday' && days.length === 3, days);
  const rows = t.qa('#statusFeed ol > li');
  check('each update with its time', rows.length === 3 && /Radarr is back, down 3 min/.test(rows[0].textContent) && /\d/.test(rows[0].querySelector('span').textContent));
  check('a note says it is from the admin, with its service', /Note from the admin, Plex/.test(rows[2].textContent), rows[2].textContent);
  check('markup in an update is only text', rows[2].querySelector('p').textContent === '<b>Bold?</b> No.' && !rows[2].querySelector('b'));
  check('the skeleton is gone and the feed done loading', !t.q('#statusFeed .skel') && t.q('#statusFeed').getAttribute('aria-busy') === 'false');
  check('the history is a list in order', rows.every((r) => r.parentElement.tagName === 'OL'));
  check('read for 30 days, and again every 30 s', t.net.urls('/api/status/feed')[0] === '/api/status/feed?days=30' && t.polls.some((p) => p.ms === 30000));
});

await run('open outages and important notes are pinned as cards', async (make) => {
  const t = make({ feed: { state: 'down', open: [OUTAGE, NOTE], items: [BACK] } });
  await t.open();
  const cards = t.qa('[data-open]');
  check('a heading, then a card each', /Happening now/.test(t.q('#statusFeed h2').textContent) && cards.length === 2);
  check('the outage: its words, since when and how long so far, the error tone', /Plex is down/.test(cards[0].textContent) && /Since .*Down 25 min so far\./.test(cards[0].textContent) && /bg-status-err\/10/.test(cards[0].className), cards[0].textContent);
  check('the note: when it was posted, the primary tone', /Posted 2 hours ago/.test(cards[1].textContent) && /bg-primary\/15/.test(cards[1].className));
  check('no state line over open items', !t.q('[data-state-line]'));
  check('the history still follows', /Last 30 days/.test(t.q('#statusFeed').textContent) && /Sonarr is back/.test(t.q('#statusFeed').textContent));
});

await run('never "All services running" unless the feed says ok', async (make) => {
  for (const [why, feed] of [['Uptime Kuma silent', { state: 'unavailable', open: [], items: [BACK] }], ['the feed down', () => ({ status: 503, body: {} })],
    ['an odd state', { state: 'down', open: [], items: [] }]]) {
    const t = make({ feed });
    await t.open();
    const text = t.q('#statusFeed').textContent;
    check(why + ': "Status unavailable right now"', /Status unavailable right now/.test(text), text.slice(0, 120));
    check(why + ': no claim', !/All services running/.test(text));
  }
  const u = make({ feed: () => ({ status: 503, body: {} }) });
  await u.open();
  check('failed: the history says it can\'t be shown, plainly', /The status history can.t be shown right now\. Try again in a minute\./.test(u.q('#statusFeed').textContent));
  const v = make({ feed: { state: 'off', open: [], items: [] } });
  await v.open();
  check('no Uptime Kuma: no line, and an empty month says so', !v.q('[data-state-line]') && /Nothing to report in the last 30 days\./.test(v.q('#statusFeed').textContent));
  check('stateLine as a rule', page.stateLine({ state: 'ok' }).text === 'All services running' && page.stateLine({ state: 'unavailable' }).text === 'Status unavailable right now' &&
    page.stateLine(null, true).text === 'Status unavailable right now' && page.stateLine({ state: 'off' }) === null);
});

await run('members: no form, no tools; admins see them', async (make) => {
  check('the opener is admin-only from the first paint, the form starts closed', /id="statusComposeOpen"[^>]*class="ws-admin-only/.test(PAGE_HTML) && /<form id="statusComposer" hidden/.test(PAGE_HTML));
  const t = make({ feed: { state: 'ok', open: [NOTE], items: [OLD_NOTE] } });
  await t.open();
  const tools = t.qa('[data-note-action]');
  check('the note tools are drawn inside ws-admin-only boxes only', tools.length > 0 && tools.every((b) => b.closest('.ws-admin-only')));
  t.q('[data-note-action="delete"]').click();
  await t.clock.advance(10);
  check('a member\'s click does nothing', t.asked.length === 0 && t.net.calls.every((c) => !c.init.method || c.init.method === 'GET'));
  t.q('#statusComposer').dispatchEvent(new t.win.Event('submit', { cancelable: true }));
  await t.clock.advance(10);
  check('and a member cannot post', t.net.urls('/api/status/notes').length === 0);
});

await run('admins post a note: an empty one is marked on the field, a real one is sent and the feed read again', async (make) => {
  const sent = [];
  const t = make({ admin: true, write: (url, init) => { sent.push([url, init.method, init.body]); return { status: 201, body: {} }; } });
  await t.open();
  const opener = t.q('#statusComposeOpen');
  const form = t.q('#statusComposer');
  opener.click();
  check('Post a note opens the form, focus in the note', !form.hidden && opener.getAttribute('aria-expanded') === 'true' && t.doc.activeElement === t.q('#statusNote'));
  form.dispatchEvent(new t.win.Event('submit', { cancelable: true }));
  await t.clock.advance(10);
  const note = t.q('#statusNote');
  check('empty: the field is marked, says why and takes the focus; nothing sent', note.classList.contains('ws-invalid') && note.getAttribute('aria-invalid') === 'true' &&
    !t.q('#statusNoteError').classList.contains('hidden') && t.doc.activeElement === note && sent.length === 0 && t.toasts.length === 0);
  note.value = 'Plex restarts at 9 PM';
  note.dispatchEvent(new t.win.Event('input'));
  check('typing clears the mark and counts', !note.classList.contains('ws-invalid') && t.q('#statusNoteCount').textContent === '21 of 280');
  check('the note is capped at 280 by the field too', note.getAttribute('maxlength') === '280');
  t.q('#statusNoteImportant').checked = true;
  t.q('#statusNoteService').value = ' Plex ';
  const before = t.net.urls('/api/status/feed').length;
  form.dispatchEvent(new t.win.Event('submit', { cancelable: true }));
  await t.clock.advance(50);
  check('posted once, with its importance and service', sent.length === 1 && sent[0][0] === '/api/status/notes' && sent[0][1] === 'POST' &&
    JSON.stringify(JSON.parse(sent[0][2])) === JSON.stringify({ text: 'Plex restarts at 9 PM', important: true, service: 'Plex' }), sent);
  check('the form clears and closes, says so, and the feed is read fresh', note.value === '' && form.hidden && t.toasts.some((x) => x[0] === 'Note posted') &&
    t.WS.dropped.indexOf('status:feed') !== -1 && t.net.urls('/api/status/feed').length > before);
  opener.click();
  t.q('#statusComposer').dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes it and focus goes back to the opener', form.hidden && t.doc.activeElement === opener);
});

await run('admins resolve and delete notes; delete asks first', async (make) => {
  const sent = [];
  const t = make({ admin: true, feed: { state: 'ok', open: [NOTE], items: [OLD_NOTE] }, write: (url, init) => { sent.push([url, init.method]); return { body: {} }; } });
  await t.open();
  const outageTools = t.qa('[data-open="outage"] [data-note-action]');
  check('an outage has no tools (it is Uptime Kuma\'s)', outageTools.length === 0);
  t.q('[data-open="note"] [data-note-action="resolve"]').click();
  await t.clock.advance(20);
  check('Mark resolved posts to the note', sent[0] && sent[0][0] === '/api/status/notes/8/resolve' && sent[0][1] === 'POST');
  t.q('[data-note-action="delete"][data-id="4"]').click();
  await t.clock.advance(20);
  check('Delete asks, as a danger dialog', t.asked.length === 1 && t.asked[0].danger === true && /Delete this note\?/.test(t.asked[0].title));
  check('then deletes that note', sent.some((s) => s[0] === '/api/status/notes/4' && s[1] === 'DELETE'));
  const u = make({ admin: true, confirm: false, feed: { state: 'ok', open: [], items: [OLD_NOTE] }, write: (url, init) => { sent.push([url, init.method]); return { body: {} }; } });
  await u.open();
  const n = sent.length;
  u.q('[data-note-action="delete"]').click();
  await u.clock.advance(20);
  check('Cancel deletes nothing', sent.length === n);
});

await run('leaving the page: nothing is written afterwards', async (make) => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const t = make({ feed: () => slow.then(() => ({ body: { state: 'down', open: [OUTAGE], items: [] } })) });
  const m = page.mount(t.ctx);
  await t.clock.advance(100);
  t.ctl.abort();
  release();
  await t.clock.advance(1700);
  await m.catch(() => {});
  check('the skeleton is still what is there', !!t.q('#statusFeed .skel') && !t.q('[data-open]'));
});

await run('the words: durations, days, no dashes, text only', async () => {
  check('durations', page.durationText(65 * 60000) === '1 h 5 min' && page.durationText(10000) === 'under a minute');
  const now = new Date(2026, 9, 4, 12);
  check('days', page.dayLabel(new Date(2026, 9, 4, 1), now) === 'Today' && page.dayLabel(new Date(2026, 9, 3, 23), now) === 'Yesterday' && /September/.test(page.dayLabel(new Date(2026, 8, 28, 9), now)));
  const src = readFileSync(STATUS_PATH, 'utf8');
  check('no markup written from an answer', !/\.innerHTML\s*=|insertAdjacentHTML|WS\.setHTML/.test(src));
  check('no dashes in the copy', !/[–—]/.test(src + PAGE_HTML));
  check('nothing under 13px, no tracked caps', !/text-\[(8|9|10|11|12)px\]|uppercase|tracking-wider/.test(src + PAGE_HTML));
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
