// Insights (app/static/js/pages/insights.js) run for real in happy-dom (a
// dev-only dependency) over the page's own markup (insights.html), with a
// scripted network, a fake clock and a fake shell (WS.arrive and WS.getJSON
// written as shell.js does them). Covers: the skeletons and each section's one
// write in top-down order, Right now and its 30 s refresh, People, a section
// that fails while the other draws (and its Try again), Plex unavailable, the
// empty states, text only, the person dialog (and a key that is no one's), and
// a page that was left.
//
// INSIGHTS_JS=<path> runs the same cases against another copy of the module.
// Run: node app/tests/js/insights_page.mjs (npm run test:js; CI js-checks).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const MODULE_PATH = process.env.INSIGHTS_JS || join(STATIC, 'js/pages/insights.js');
const HTML_PATH = join(STATIC, 'insights.html');

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

if (!existsSync(MODULE_PATH) || !existsSync(HTML_PATH)) {
  report('FAIL Insights: insights.js or insights.html does not exist');
  process.exit(1);
}
const HTML = readFileSync(HTML_PATH, 'utf8');
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

const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
const pageModule = await import(dataUrl(readFileSync(MODULE_PATH, 'utf8')));

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

function fakeShell(doc, clock, net) {
  const arr = { order: [], done: {}, queue: {}, gate: false };
  const WS = {
    arrived: [],
    data: { user: { username: 'admin' } },
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
    getJSON(url, opts) {
      return net.fetch(url, opts && opts.signal ? { signal: opts.signal } : undefined).then((r) => {
        if (!r.ok) {
          return r.json().then((body) => { const e = new Error('HTTP ' + r.status); e.status = r.status; e.body = body; throw e; });
        }
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

const PAGE = /<div id="wsPage"[\s\S]*<\/main>/;

function visit(o = {}) {
  const win = new Window({ url: 'https://ws.test/insights' });
  const doc = win.document;
  doc.body.innerHTML = HTML.match(PAGE)[0].replace(/<\/main>$/, '');
  const clock = fakeClock();
  const net = network();
  const ctl = new win.AbortController();
  const WS = fakeShell(doc, clock, net);
  const polls = [];
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win);
  set('document', doc);
  set('WS', WS);
  win.WS = WS;
  if (o.routes) o.routes(net);
  const ctx = {
    root: doc.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL('https://ws.test/insights'),
    data: WS.data,
    poll(fn, ms) { polls.push({ fn, ms }); return () => {}; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setTitle() {}
  };
  WS.arriveReset();
  return {
    win, doc, clock, net, ctl, WS, ctx, polls,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    text: (sel) => (doc.querySelector(sel) || { textContent: null }).textContent,
    mount: () => pageModule.mount(ctx),
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

const H = 3600000;
const M = 60000;
const SAM = 'a'.repeat(24);
const KIM = 'b'.repeat(24);
const ODD = 'c'.repeat(24);
const MARKUP = '<img src=x onerror=alert(1)>';
const hoursAgo = (h) => new Date(Date.now() - h * H).toISOString();
const NOW_ANSWER = {
  listening: [
    { key: SAM, name: 'Sam', book_id: 1, title: 'Dune', author: 'Frank Herbert', format: 'audio', where: 'web', state: 'playing', device: 'Chrome', percent: 42, updated_at: hoursAgo(0) },
    { key: KIM, name: 'Kim', book_id: 2, title: 'Emma', author: 'Jane Austen', format: 'audio', where: 'plex', state: 'paused', device: '', percent: null, updated_at: hoursAgo(0) }],
  reading: [], unavailable: [], checked_at: hoursAgo(0)
};
const TRACKING = { requests: '2026-10-11', reading: '2026-10-11', ebook_places: '2026-10-11', hours: '2026-09-28' };
const PEOPLE_ANSWER = {
  people: [
    { key: SAM, name: 'Sam', last_active: hoursAgo(3), last_what: 'listening', listened_ms_30d: 3 * H, plex_ms_30d: 30 * M,
      current: [{ book_id: 1, title: 'Dune', format: 'audio', where: 'web', percent: 42, updated_at: hoursAgo(3) }] },
    { key: ODD, name: MARKUP, last_active: null, last_what: null, listened_ms_30d: 0, plex_ms_30d: 0, current: [] }],
  unavailable: [], tracking: TRACKING
};
const MONDAYS = ['2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31',
  '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
const PERSON_ANSWER = {
  key: SAM, name: 'Sam', last_active: hoursAgo(3),
  totals: { listened_ms: 12 * H, plex_ms: 2 * H, finished: 1, pages_read: 420 },
  weekly: MONDAYS.map((week, i) => ({ week, web_ms: i * 10 * M, plex_ms: i % 3 ? 0 : 20 * M })),
  books: [{ book_id: 1, title: 'Dune', author: 'Frank Herbert', formats: ['audio'], percent: 42, finished: false, listened_ms: 3 * H, plex_ms: 30 * M, last_at: hoursAgo(3) }],
  requests: [{ key: SAM, name: 'Sam', title: 'Children of Dune', format: 'both', requested_at: '2026-10-01T09:00:00.000Z', book_id: null, started_at: null }],
  unavailable: [], tracking: TRACKING
};

function routes(over = {}) {
  return (net) => {
    net.on('/api/admin/insights/now', over.now || (() => ({ body: NOW_ANSWER })));
    net.on('/api/admin/insights/people', over.people || (() => ({ body: PEOPLE_ANSWER })));
    net.on('/api/admin/insights/person', over.person || (() => ({ body: PERSON_ANSWER })));
  };
}

async function mounted(make, over) {
  const t = make({ routes: routes(over) });
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  await flush();
  return t;
}
const rr = (n) => (n || '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------

await run('the skeletons hold the page, then each section arrives in one write, top down', async (make) => {
  const slow = deferred();
  const t = make({ routes: routes({ now: () => slow.promise.then(() => ({ body: NOW_ANSWER })) }) });
  const heading = t.q('#insPeople h2');
  const m = t.mount();
  await flush();
  check('both sections start busy, each with a skeleton', ['#insNow', '#insPeople'].every((s) =>
    t.q(s).getAttribute('aria-busy') === 'true' && t.qa(s + ' [data-ins-body] .skel').length > 0));
  check('People waits for Right now above it', t.q('#insPeople').getAttribute('aria-busy') === 'true');
  slow.resolve();
  await flush();
  check('both arrived, in order', t.WS.arrived.join(',') === 'ins-now,ins-people', t.WS.arrived);
  await t.clock.advance(1600);
  await m;
  check('not busy', ['#insNow', '#insPeople'].every((s) => t.q(s).getAttribute('aria-busy') === 'false'));
  check('the headings are the same nodes (nothing above a body moved)', t.q('#insPeople h2') === heading);
  const now = t.qa('[data-ins-now]');
  check('Right now: who, what and how', now.length === 2 && rr(now[0].querySelector('div').textContent) === 'SamDunePlaying · in the web player · 42% through',
    now.map((n) => rr(n.textContent)));
  check('a Plex app listener', rr(now[1].textContent).includes('Paused · in a Plex app'));
  const sam = t.q(`[data-ins-person="${SAM}"]`);
  check('People: last active, what, time with its estimate, current books', rr(sam.textContent).includes('Last active 3 hr ago, listening') &&
    rr(sam.textContent).includes('3 hr 30 min listened in 30 days (30 min in Plex apps, an estimate)') && rr(sam.textContent).includes('Dune · 42%'),
    rr(sam.textContent));
  check('someone not active yet says so', rr(t.q(`[data-ins-person="${ODD}"]`).textContent).includes('Not active yet'));
});

await run('Right now is read again every 30 s and drawn again only when it changed', async (make) => {
  const answers = [NOW_ANSWER, NOW_ANSWER, Object.assign({}, NOW_ANSWER, { listening: [] })];
  let n = 0;
  const t = await mounted(make, { now: () => ({ body: answers[Math.min(n++, 2)] }) });
  check('one refresh, every 30 s', t.polls.length === 1 && t.polls[0].ms === 30000);
  const before = t.q('#insNow [data-ins-body]');
  t.polls[0].fn();
  await flush();
  check('the same answer leaves the section alone', t.q('#insNow [data-ins-body]') === before);
  t.polls[0].fn();
  await flush();
  check('a changed answer is drawn', rr(t.text('#insNow')).includes('No one is listening or reading right now.'));
  check('three reads of Right now', t.net.urls('/api/admin/insights/now').length === 3);
});

await run('one section failing leaves the other drawn, and Try again reloads it', async (make) => {
  let fail = true;
  const t = await mounted(make, { people: () => (fail ? { status: 500, body: {} } : { body: PEOPLE_ANSWER }) });
  check('Right now is drawn', t.qa('[data-ins-now]').length === 2);
  check('People says it could not load', rr(t.text('#insPeople [data-ins-failed]')).startsWith('This part couldn’t load.'));
  const again = t.q('#insPeople [data-ins-failed] button');
  check('its button is the neutral kind, never a blue primary', !!again && !/bg-primary/.test(again.className));
  fail = false;
  again.click();
  await flush();
  check('Try again draws People', t.qa('[data-ins-person]').length === 2);
});

await run('Plex unavailable is a line in place, and the empty states say what will show', async (make) => {
  const t = await mounted(make, {
    now: () => ({ body: { listening: [], reading: [], unavailable: [] } }),
    people: () => ({ body: { people: [], unavailable: ['plex'], tracking: {} } })
  });
  check('Right now is empty in words', rr(t.text('#insNow [data-ins-empty]')) === 'No one is listening or reading right now.');
  check('People: the Plex line', rr(t.text('#insPeople [data-ins-unavailable="plex"]')) === 'cloud_offPlex isn’t answering, so listening in Plex apps is missing here.');
  check('then its empty words', rr(t.text('#insPeople [data-ins-empty]')) === 'No one has listened or read yet.');
  check('nothing failed', !t.q('[data-ins-failed]'));
});

await run('a name with markup is text', async (make) => {
  const t = await mounted(make);
  check('the name is shown as written', rr(t.q(`[data-ins-person="${ODD}"]`).textContent).startsWith(MARKUP));
  check('no element came from it', t.qa('#wsPage img').length === 0);
});

await run('a person opens in the dialog, with their history, and Close gives focus back', async (make) => {
  const t = await mounted(make);
  const row = t.q(`[data-ins-person="${SAM}"]`);
  row.focus();
  row.click();
  await flush();
  const dialog = t.q('#insDetail');
  check('the dialog is open', dialog.hasAttribute('open'));
  check('it asked for that person in this time zone', /^\/api\/admin\/insights\/person\?key=a{24}(&tz=.+)?$/.test(t.net.urls('/api/admin/insights/person')[0] || ''),
    t.net.urls('/api/admin/insights/person'));
  check('the title is the name', rr(t.text('#insDetailTitle')) === 'Sam');
  check('the totals, the Plex part an estimate', rr(t.text('[data-ins-totals]')).includes('In Plex apps (an estimate)') &&
    rr(t.text('[data-ins-totals]')).includes('Pages read, by Kavita’s count'));
  const weeks = t.qa('[data-ins-weekly] li');
  check('12 weeks, each said in words', weeks.length === 12 && weeks.every((li) => /^Week of /.test(li.querySelector('.sr-only').textContent)));
  check('the books', rr(t.text('[data-ins-book-row]')).includes('Frank Herbert · 42% through · 3 hr 30 min listened (the Plex part an estimate)'));
  check('requests, matched by title', rr(t.text('#insDetailBody')).includes('not in the library yet (matched by title)'));
  check('dates are day first, as the design writes them', rr(t.text('#insDetailBody')).includes('Asked 1 Oct 2026'), rr(t.text('#insDetailBody')));
  check('the Plex part of a bar is hatched, never a plain lighter fill', t.qa('[data-ins-weekly] .ins-bar.ins-est').length === 4 && t.qa('[data-ins-weekly] p .ins-est').length === 1 &&
    !/bg-frosted-blue\/35/.test(t.q('[data-ins-weekly]').innerHTML));
  check('the tallest week names its value', rr(t.text('[data-ins-weekly]')).includes('1 hr 50 min'));
  t.q('[data-ins-close]').click();
  await flush();
  check('Close closes it', !dialog.hasAttribute('open'));
  check('focus is back on the row', t.doc.activeElement === row);
  row.click();
  await flush();
  dialog.dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
  await flush();
  check('a click on the dim area closes it', !dialog.hasAttribute('open'));
  row.click();
  await flush();
  t.q('#insDetailBody').dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
  await flush();
  check('a click inside the box leaves it open', dialog.hasAttribute('open'));
});

await run('a key that is no one’s says so in the dialog', async (make) => {
  const t = await mounted(make, { person: () => ({ status: 404, body: { detail: 'gone' } }) });
  t.q(`[data-ins-person="${SAM}"]`).click();
  await flush();
  check('the words', rr(t.text('#insDetailBody')) === 'That person or book isn’t here any more.');
});

await run('a page that was left draws nothing', async (make) => {
  const slow = deferred();
  const t = make({ routes: routes({ now: () => slow.promise.then(() => ({ body: NOW_ANSWER })),
                                   people: () => slow.promise.then(() => ({ body: PEOPLE_ANSWER })) }) });
  const m = t.mount();
  await flush();
  t.ctl.abort();
  slow.resolve();
  await t.clock.advance(1600);
  await m;
  check('still the skeletons', ['#insNow', '#insPeople'].every((s) => t.q(s).getAttribute('aria-busy') === 'true'));
});

console.log(`insights page: ${total - failed}/${total} checks pass`);
process.exit(failed ? 1 : 0);
