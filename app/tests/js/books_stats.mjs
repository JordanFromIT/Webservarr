// Your stats (app/static/js/pages/books-stats.js) run for real in happy-dom (a
// dev-only dependency) over the page's own markup (books-stats.html), with a
// scripted network, a fake clock and a fake shell (WS.swr and WS.arrive
// written as shell.js does them). Covers: the skeleton and the one write that
// replaces it, the figures (and their singulars), the weekly bars (sized from
// the data, said in words), the top authors (links to their pages), reading
// (shown, not linked yet, down, or no ebook library at all), nothing listened
// to yet, an account that keeps no books, the error and its retry, the time
// zone sent, text only, and a page that was left.
//
// BOOKS_STATS_JS=<path> runs the same cases against another copy of the module.
// Run: node app/tests/js/books_stats.mjs (npm run test:js; CI js-checks).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const STATS_PATH = process.env.BOOKS_STATS_JS || join(STATIC, 'js/pages/books-stats.js');
const BOOKS_PATH = join(STATIC, 'js/pages/books.js');
const HTML_PATH = join(STATIC, 'books-stats.html');

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

if (!existsSync(STATS_PATH) || !existsSync(HTML_PATH)) {
  report('FAIL the stats page: books-stats.js or books-stats.html does not exist');
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
const BOOKS_URL = dataUrl(readFileSync(BOOKS_PATH, 'utf8'));
const statsModule = await import(dataUrl(readFileSync(STATS_PATH, 'utf8')));

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

const NAV = /<div id="wsPage"[\s\S]*<\/main>/;

function visit(o = {}) {
  const win = new Window({ url: 'https://ws.test/books/stats' });
  const doc = win.document;
  doc.body.innerHTML = HTML.match(NAV)[0].replace(/<\/main>$/, '');
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
  set('WS', WS);
  win.WS = WS;
  if (o.routes) o.routes(net);
  const ctx = {
    root: doc.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL('https://ws.test/books/stats'),
    data: WS.data,
    poll() { return () => {}; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setTitle() {}
  };
  WS.arriveReset();
  return {
    win, doc, clock, net, ctl, WS, ctx,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    text: (sel) => (doc.querySelector(sel) || { textContent: null }).textContent,
    mount: () => statsModule.mount(ctx),
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
const MONDAYS = ['2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31',
  '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
const WEEKLY_MS = [0, 0, 1 * H, 2 * H, 0, 4 * H, 30 * M, 0, 3 * H, 2 * H + 10 * M, 1 * H, 45 * M];
function answer(over = {}) {
  return Object.assign({
    listened_ms_6mo: 12 * H + 30 * M,
    listened_ms_all: 48 * H + 5 * M,
    finished: 4,
    streak_days: 6,
    weekly: MONDAYS.map((week, i) => ({ week, ms: WEEKLY_MS[i] })),
    top_authors: [{ name: 'Matt Dinniman', ms: 6 * H }, { name: 'George R. R. Martin', ms: 3 * H }, { name: 'Le Guin, Ursula K.', ms: 45 * M }],
    reading: { pages: 1240, words: 300000, hours: 18.5 },
    notes: []
  }, over);
}
const statsRoute = (body) => (net) => net.on('/api/books/me/stats', () => (typeof body === 'function' ? body() : { body }));

async function open(make, body) {
  const t = make({ routes: statsRoute(body) });
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  return t;
}
const rr = (n) => (n || '').replace(/\s+/g, ' ').trim();
const figures = (t, sel) => t.qa(`${sel || '[data-figures]'} dl`).map((dl) => [rr(dl.querySelector('dd').textContent), rr(dl.querySelector('dt').textContent)]);

// ---------------------------------------------------------------------------

await run('the skeleton holds the page, then one write replaces what follows the heading', async (make) => {
  const slow = deferred();
  const t = make({ routes: statsRoute(() => slow.promise.then(() => ({ body: answer() }))) });
  const heading = t.q('#statsView h1');
  const line = t.q('#statsView h1 + p');
  const rest = t.q('#statsRest');
  const m = t.mount();
  await flush();
  check('the skeleton is shown and busy', t.q('#statsView').getAttribute('aria-busy') === 'true' && t.qa('#statsRest .skel').length > 4 && rest.getAttribute('aria-hidden') === 'true');
  check('the heading and its line are there from the first paint', rr(heading.textContent) === 'Your stats' && rr(line.textContent) === 'Only you can see these.');
  slow.resolve();
  await t.clock.advance(1600);
  await m;
  check('the heading and its line are the same nodes (nothing above the stats moved)', t.q('#statsView h1') === heading && t.q('#statsView h1 + p') === line);
  check('what follows them is new, and nothing comes after it', t.q('#statsRest') !== rest && !rest.isConnected && t.q('#statsRest').nextElementSibling === null);
  check('not busy', t.q('#statsView').getAttribute('aria-busy') === 'false' && t.q('#statsRest').getAttribute('aria-hidden') === null);
  check('the page arrived as one section', t.WS.arrived.join(',') === 'stats');
  check('one heading on the page', t.qa('#wsPage h1').length === 1);
});

await run('the browser\'s time zone is sent, so days and weeks are the person\'s', async (make) => {
  const t = await open(make, answer());
  const asked = new URL(t.net.urls('/api/books/me/stats')[0], 'https://ws.test');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  check('one read, of the person\'s own stats, with tz', t.net.urls('/api/books/me/stats').length === 1 && asked.pathname === '/api/books/me/stats' && asked.searchParams.get('tz') === zone, t.net.urls('/api/books/me/stats'));
  check('on the visit\'s signal', t.net.calls.every((c) => c.init && c.init.signal === t.ctl.signal));
});

await run('the figures: time listened leads, then books finished and the streak', async (make) => {
  const t = await open(make, answer());
  const f = figures(t);
  check('three figures, in that order', JSON.stringify(f) === JSON.stringify([
    ['12 hr 30 min', 'Listened in the last 6 months'], ['4', 'Books finished'], ['6 days', 'Listening streak']]), f);
  check('all time under the lead', /48 hr 5 min all time/.test(t.text('[data-figures]')));
  check('the lead is the big one, the rest a step down', /text-\[32px\]/.test(t.q('[data-figures] dd').className) && /sm:text-\[44px\]/.test(t.q('[data-figures] dd').className) &&
    t.qa('[data-figures] dd').slice(1).every((dd) => /text-\[24px\]/.test(dd.className)));
  check('numbers line up as they change', t.qa('[data-figures] dd').every((dd) => /tabular-nums/.test(dd.className)));
  check('the label is read before its number (a description list)', t.qa('[data-figures] dl').every((dl) => dl.firstElementChild.tagName === 'DT'));
  const u = await open(make, answer({ listened_ms_6mo: 45 * M, listened_ms_all: 45 * M, finished: 1, streak_days: 1 }));
  check('singulars, minutes only, and no all-time line when it says the same', JSON.stringify(figures(u)) === JSON.stringify([
    ['45 min', 'Listened in the last 6 months'], ['1', 'Book finished'], ['1 day', 'Listening streak']]) && !/all time/.test(u.text('[data-figures]')), figures(u));
  const v = await open(make, answer({ listened_ms_6mo: 3 * H, listened_ms_all: 3 * H, streak_days: 0, finished: 0 }));
  check('whole hours and a broken streak', JSON.stringify(figures(v)) === JSON.stringify([
    ['3 hr', 'Listened in the last 6 months'], ['0', 'Books finished'], ['0 days', 'Listening streak']]), figures(v));
});

await run('each week is a bar sized from the data, said in words', async (make) => {
  const t = await open(make, answer());
  const weeks = t.qa('[data-weekly] ol > li');
  check('an ordered list of 12 weeks, oldest first', t.q('[data-weekly] ol').tagName === 'OL' && weeks.length === 12 && weeks[0].getAttribute('data-week') === '2026-07-20' && weeks[11].getAttribute('data-week') === '2026-10-05');
  const heights = t.qa('[data-bar]').map((b) => b.style.height);
  check('the best week is the full height; the rest in proportion', heights[5] === '100%' && heights[3] === '50%' && heights[2] === '25%' && heights[10] === '25%', heights);
  check('a week with nothing keeps a sliver on the baseline', heights[0] === '2px' && heights[1] === '2px' && heights[4] === '2px', heights);
  check('a tiny week still shows', parseInt(heights[6], 10) >= 3, heights[6]);
  const words = weeks.map((li) => rr(li.querySelector('.sr-only').textContent));
  check('each bar says its week and time', /^Week of .+: 4 hr$/.test(words[5]) && words[11] === 'This week: 45 min' && /^Week of .+: 0 min$/.test(words[0]), words);
  check('and a pointer gets the same words', weeks.every((li, i) => li.title === words[i]));
  check('the bars are only a picture', t.qa('[data-bar]').every((b) => b.getAttribute('aria-hidden') === 'true'));
  check('this week at full strength, the rest muted, from the theme', /\bbg-frosted-blue\b/.test(t.qa('[data-bar]')[11].className) && t.qa('[data-bar]').slice(0, 11).every((b) => /bg-frosted-blue\/35/.test(b.className)));
  check('they grow once, and only as a transform (the page style holds the motion, reduced motion holds it still)', t.qa('[data-bar]').every((b) => /\bstats-bar\b/.test(b.className)) &&
    /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.stats-bar \{ animation: stats-grow/.test(HTML) && /@keyframes stats-grow \{ from \{ transform: scaleY\(0\); \} \}/.test(HTML));
  check('the best week is said above the bars', /Your best of the last 12 weeks: 4 hr\./.test(t.text('[data-weekly]')));
  check('the two ends are named', /This week$/.test(rr(t.text('[data-weekly] ol + div'))));
  check('no overflow at 320: twelve columns that may shrink', /\bgrid-cols-12\b/.test(t.q('[data-weekly] ol').className) && weeks.every((li) => /\bmin-w-0\b/.test(li.className)));
  const quiet = answer({ weekly: MONDAYS.map((week) => ({ week, ms: 0 })) });
  const u = await open(make, quiet);
  check('nothing in the last 12 weeks: said, every bar a sliver', /Nothing in the last 12 weeks yet\./.test(u.text('[data-weekly]')) && u.qa('[data-bar]').every((b) => b.style.height === '2px'));
});

await run('top authors: in order, links to their pages, each with a bar against the first', async (make) => {
  const t = await open(make, answer());
  const links = t.qa('[data-authors] ol > li > a');
  check('an ordered list under its heading', t.q('[data-authors] h2').textContent === 'Your top authors' && t.q('[data-authors] ol').tagName === 'OL' && links.length === 3);
  check('each name links to the author page, the name sent whole', links.map((a) => new URL(a.getAttribute('href'), 'https://ws.test').searchParams.get('name')).join('|') === 'Matt Dinniman|George R. R. Martin|Le Guin, Ursula K.' &&
    links.every((a) => a.getAttribute('href').indexOf('/books/person?role=author&name=') === 0));
  check('with the time', /6 hr/.test(links[0].textContent) && /45 min/.test(links[2].textContent));
  const widths = t.qa('[data-authors] li a > span:last-child > span').map((s) => s.style.width);
  check('bars against the first', JSON.stringify(widths) === JSON.stringify(['100%', '50%', '13%']), widths);
  check('a long name is cut, never widens the page', t.qa('[data-authors] li a > span:first-child > span:first-child').every((s) => /\btruncate\b/.test(s.className) && /\bmin-w-0\b/.test(s.className)));
  check('each link has a focus ring', links.every((a) => /focus-visible:outline-2/.test(a.className)));
  const u = await open(make, answer({ top_authors: [] }));
  check('none: no section', !u.q('[data-authors]'));
});

await run('reading: shown while the ebook library is linked, otherwise why not', async (make) => {
  const t = await open(make, answer());
  check('pages read and time reading', JSON.stringify(figures(t, '[data-reading]')) === JSON.stringify([['1,240', 'Pages read'], ['18 hr 30 min', 'Time reading']]), figures(t, '[data-reading]'));
  const nc = [{ source: 'kavita', reason: 'not_connected', text: 'Connect your ebook library to include reading' }];
  const u = await open(make, answer({ reading: null, notes: nc }));
  const note = u.q('[data-reading-note]');
  check('not linked: a quiet note that takes them to Books (which links it)', !!note && /Connect your ebook library to include reading/.test(note.textContent) && note.querySelector('a').getAttribute('href') === '/books');
  check('and no figures', !u.q('[data-reading] dl'));
  const down = [{ source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' }];
  const v = await open(make, answer({ reading: null, notes: down }));
  check('down: said quietly, not a link', /Ebooks are unavailable right now/.test(v.text('[data-reading-note]')) && !v.q('[data-reading-note] a'));
  const w = await open(make, answer({ reading: null, notes: [] }));
  check('no ebook library on this site: no reading section at all', !w.q('[data-reading]'));
  const z = await open(make, answer({ reading: { pages: 0, words: 0, hours: 0 } }));
  check('linked but nothing read: one line, not a row of zeros (audit L7)',
    !z.q('[data-reading] dl') && /Nothing read yet/.test(z.text('[data-reading-none]')) && !/\b0 /.test(z.text('[data-reading]')));
});

await run('nothing listened to yet: what the page will show, and the way to start', async (make) => {
  const zero = answer({ listened_ms_6mo: 0, listened_ms_all: 0, finished: 0, streak_days: 0, weekly: MONDAYS.map((week) => ({ week, ms: 0 })), top_authors: [] });
  const t = await open(make, zero);
  check('an invitation, not a row of zeros', !!t.q('[data-empty]') && !t.q('[data-figures]') && !t.q('[data-weekly]') && /No listening yet/.test(t.text('[data-empty]')));
  const go = t.q('[data-empty] a');
  check('one action: Find an audiobook, to Books', !!go && rr(go.textContent) === 'Find an audiobook' && go.getAttribute('href') === '/books' && /\bbg-primary\b/.test(go.className));
  check('reading still shows', !!t.q('[data-reading] dl'));
  const u = await open(make, answer({ listened_ms_6mo: 0, listened_ms_all: 0, finished: 2, streak_days: 0, top_authors: [] }));
  check('books finished long ago still count as listening', !!u.q('[data-figures]') && !u.q('[data-empty]'));
});

await run('an account that keeps no books: said plainly, with the way back', async (make) => {
  const t = await open(make, () => ({ status: 403, body: { detail: 'This account cannot keep books of its own' } }));
  check('its own message', !!t.q('[data-state="noaccount"]') && /Stats aren.t kept for this account/.test(t.text('#statsRest')) && t.q('[data-state="noaccount"] a').getAttribute('href') === '/books');
  check('no number shown', !t.q('[data-figures]') && !/\d/.test(t.text('#statsRest')));
});

await run('an error: what happened, and Try again that works', async (make) => {
  let down = true;
  const t = make({ routes: statsRoute(() => (down ? { status: 503, body: {} } : { body: answer() })) });
  const m = t.mount();
  await t.clock.advance(1600);
  await m;
  check('says what happened, without a code', !!t.q('[data-state="error"]') && /couldn.t load your stats/i.test(t.text('#statsRest')) && !/503|HTTP/.test(t.text('#statsView')));
  down = false;
  t.q('#retryBtn').click();
  check('the skeleton comes back while it asks', !!t.q('#statsRest .skel') && t.q('#statsView').getAttribute('aria-busy') === 'true');
  await t.clock.advance(1600);
  check('Try again loads the stats', !!t.q('[data-figures]') && t.net.urls('/api/books/me/stats').length === 2);
});

await run('a repeat visit paints from the kept copy and settles to the live one', async (make) => {
  const t = make({ routes: statsRoute(answer({ finished: 5 })) });
  t.WS.cache.set('books:stats', answer({ finished: 4 }));
  const m = t.mount();
  await t.clock.advance(400);
  await m;
  await t.clock.advance(50);
  check('the live answer is what stays', figures(t)[1][0] === '5', figures(t));
});

await run('names and notes are text, never markup; the module writes no markup and no raw colour', async (make) => {
  const nasty = '<img src=x onerror=alert(1)>';
  const t = await open(make, answer({ top_authors: [{ name: nasty, ms: H }], reading: null, notes: [{ source: 'kavita', reason: 'unavailable', text: nasty }] }));
  check('as typed', t.q('[data-authors] li a').textContent.indexOf(nasty) !== -1 && t.text('[data-reading-note]').indexOf(nasty) !== -1);
  check('no element made from it', !t.q('#wsPage img') && !t.q('[onerror]'));
  const src = readFileSync(STATS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('the module never writes markup', !/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write/.test(src));
  check('and holds no raw colour', !/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(src));
  check('and no chart library', !/chart|d3|plotly/i.test(src.replace(/no chart library/g, '')));
});

await run('leaving the page: a late answer changes nothing', async (make) => {
  const slow = deferred();
  const t = make({ routes: statsRoute(() => slow.promise.then(() => ({ body: answer() }))) });
  const rest = t.q('#statsRest');
  t.mount();
  await flush();
  t.ctl.abort();
  slow.resolve();
  await t.clock.advance(1600);
  check('the skeleton is still what is there', t.q('#statsRest') === rest);
});

if (failed) {
  report(`${total - failed}/${total} checks passed, ${failed} FAILED`);
  process.exit(1);
}
console.log(`${total}/${total} stats page checks pass`);
