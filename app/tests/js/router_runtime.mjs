// The soft-navigation router run for real: router.js's start() in a DOM
// (happy-dom, a dev-only dependency) with a scripted server, history and
// location, driven through the sequences where its bugs have lived: link
// clicks during a fetch, prefetch reuse, leave guards and claims, Back and
// Forward held or refused, failed fetches and Retry, a module that throws,
// a deploy since the document loaded, the service worker's navigation, and
// the scroll restore. router.mjs covers the pure rules.
//
// Every scenario boots a fresh router (router.js imported again as a data:
// URL with a unique tail) in a fresh window. Page modules are data: URLs that
// hand mount(ctx) to the scenario (globalThis.__mount).
//
// ROUTER_JS=<path> runs the same cases against another copy of router.js
// (how the fixes were shown failing on the router before them).
// Run: node app/tests/js/router_runtime.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTER = process.env.ROUTER_JS || join(here, '../../static/js/router.js');
const routerSrc = readFileSync(ROUTER, 'utf8');
const ORIGIN = 'https://ws.test';

let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${current}: ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await wait(5);
  }
  return cond();
}

// ---- The site: pages as the server renders them ----

const PAGES = ['news', 'settings', 'calendar', 'wiki', 'reader', 'slow'];
const moduleUrl = (name) => 'data:text/javascript,' +
  encodeURIComponent(`export function mount(ctx) { return globalThis.__mount(${JSON.stringify(name)}, ctx); }`);

function pageHtml(name, o = {}) {
  const links = PAGES.map((p) => `<a href="/${p}">${p}</a>`).join('') +
    '<a href="/wiki/a">wiki a</a><a href="/wiki/b">wiki b</a>';
  const data = { version: o.version || '1.0', user: o.user || { username: 'sam', is_admin: false }, page: name };
  const extra = o.extra || '';
  const helper = o.helper ? `<script src="/static/js/tour.js?v=${o.helper}" data-ws-page-script></script>` : '';
  return `<!DOCTYPE html><html data-page="${name}"${name === 'reader' ? ' data-shell="hidden"' : ''}>
<head><title>Site - ${name}</title>
<link rel="stylesheet" href="/static/css/app.css?v=${o.css || 'A'}">
<script src="/static/js/shell.js?v=${o.shell || 'A'}"></script>
</head><body>
<nav id="desktopNav">${PAGES.map((p) => `<a href="/${p}" class="n">${p}</a>`).join('')}</nav>
<main><div id="wsPage" data-ws-module="${moduleUrl(name)}"><h1>${name}</h1>${links}${extra}</div></main>
${helper}
<script id="ws-data" type="application/json">${JSON.stringify(data)}</script>
<div id="wsPlayer" hidden></div><div id="wsLive"></div><div id="wsProgress" hidden aria-hidden="true"></div>
</body></html>`;
}

// ---- One window, one router ----

let routerCopy = 0;

// The joint session history. A top-level entry { url, state, key }; an
// iframe's step { frame: true, of: <the top-level entry it was made on> }
// shares that entry's address and state, and stepping onto or off it fires
// no popstate in the top-level window (as in a browser). keys are the
// Navigation API's; navigation (boot option) is a stand-in for it.
let entryKeys = 0;
class FakeHistory {
  constructor(env, url) {
    this.env = env;
    this.entries = [{ url, state: null, key: 'k' + (++entryKeys) }];
    this.index = 0;
    this.scrollRestoration = 'auto';
    this.steps = [];
  }
  top(j = this.index) { const e = this.entries[j]; return e.frame ? e.of : e; }
  get state() { return structuredClone(this.top().state); }
  get length() { return this.entries.length; }
  pushState(state, title, url) {
    const u = new URL(url, this.env.loc.href).href;
    const copy = structuredClone(state);
    this.entries.splice(this.index + 1);
    this.entries.push({ url: u, state: copy, key: 'k' + (++entryKeys) });
    this.index += 1;
    this.env.loc.set(u);
  }
  replaceState(state, title, url) {
    const u = url == null ? this.env.loc.href : new URL(url, this.env.loc.href).href;
    const t = this.top();
    t.url = u;
    t.state = structuredClone(state);
    this.env.loc.set(u);
  }
  // The embed's own navigation: a step in the joint history the top-level
  // window never hears about.
  frameStep() {
    const t = this.top();
    this.entries.splice(this.index + 1);
    this.entries.push({ frame: true, of: t });
    this.index += 1;
  }
  moveTo(i) {
    const was = this.top();
    this.index = i;
    const t = this.top();
    this.env.loc.set(t.url);
    if (t === was) return;
    const ev = new this.env.win.PopStateEvent('popstate', { state: structuredClone(t.state) });
    this.env.win.dispatchEvent(ev);
  }
  go(delta) {
    this.steps.push(delta);
    setTimeout(() => {
      const i = this.index + delta;
      if (!delta || i < 0 || i >= this.entries.length) return;
      this.moveTo(i);
    }, 0);
  }
  back() { this.go(-1); }
  forward() { this.go(1); }
  urls() { return this.entries.map((e) => new URL((e.frame ? e.of : e).url).pathname); }
  hrefs() { return this.entries.filter((e) => !e.frame).map((e) => e.url.slice(ORIGIN.length)); }
}

// window.navigation, as far as the router uses it: the current entry's key,
// and traverseTo(key), which goes to the step that entry was made on.
class FakeNavigation {
  constructor(h) { this.h = h; }
  get currentEntry() { return { key: this.h.top().key }; }
  traverseTo(key) {
    const h = this.h;
    h.steps.push('to ' + key);
    const j = h.entries.findIndex((e) => !e.frame && e.key === key);
    if (j === -1) {
      const no = Promise.reject(new DOMException('no such entry', 'InvalidStateError'));
      return { committed: no, finished: no };
    }
    const done = new Promise((r) => setTimeout(() => { if (j !== h.index) h.moveTo(j); r(); }, 0));
    return { committed: done, finished: done };
  }
}

class FakeLocation {
  constructor(env, url) { this.env = env; this.u = new URL(url); }
  set(url) { this.u = new URL(url, this.u); }
  get href() { return this.u.href; }
  get origin() { return this.u.origin; }
  get pathname() { return this.u.pathname; }
  get search() { return this.u.search; }
  get hash() { return this.u.hash; }
  assign(url) { this.env.hard.push(new URL(url, this.u).pathname); }
  replace(url) { this.env.hard.push(new URL(url, this.u).pathname); }
  reload() { this.env.hard.push('reload:' + this.u.pathname); }
}

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

async function boot(o = {}) {
  const path = o.path || '/news';
  const env = {
    hard: [], fetches: [], log: [], toasts: [], chromeClosed: 0, dialogsClosed: 0,
    routes: {}, pages: {}, mounts: [], storage: new Map(Object.entries(o.storage || {})),
    scrollWrites: [], maxScroll: 100000
  };
  const win = new Window({
    url: ORIGIN + path,
    settings: {
      disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true,
      navigation: { disableMainFrameNavigation: true }
    }
  });
  env.win = win;
  env.loc = new FakeLocation(env, ORIGIN + path + (o.search || ''));
  env.history = new FakeHistory(env, env.loc.href);
  if (o.navigation) win.navigation = new FakeNavigation(env.history);
  const doc = win.document;
  // A view transition that takes o.transition ms before the update runs.
  if (o.transition) {
    env.transitions = 0;
    doc.startViewTransition = function (update) {
      env.transitions += 1;
      const done = new Promise((r) => setTimeout(() => { update(); r(); }, o.transition));
      return { ready: done, finished: done, updateCallbackDone: done };
    };
  }
  const first = new win.DOMParser().parseFromString(pageHtml(path.slice(1), o.page), 'text/html');
  for (const a of first.documentElement.attributes) doc.documentElement.setAttribute(a.name, a.value);
  doc.head.innerHTML = first.head.innerHTML;
  doc.body.innerHTML = first.body.innerHTML;

  // The scroller (every computed overflow is '' here): the document's. Its
  // reach is env.maxScroll, as a page whose content is still growing.
  let top = 0;
  Object.defineProperty(doc.scrollingElement, 'scrollTop', {
    configurable: true,
    get() { return top; },
    set(v) { env.scrollWrites.push({ v, at: Date.now() }); top = Math.max(0, Math.min(v, env.maxScroll)); }
  });

  const data = JSON.parse(doc.getElementById('ws-data').textContent);
  win.WS_DATA = data;
  win.WS = {
    data, user: data.user, page: data.page,
    closeChrome() { env.chromeClosed += 1; env.log.push('closeChrome'); },
    applyShell() {},
    poll() { return function () {}; },
    arriveReset() {}
  };
  win.WSUI = {
    toast(msg, tone, opts) {
      const t = { msg, tone, action: opts && opts.action, removed: false };
      env.toasts.push(t);
      return { remove() { t.removed = true; } };
    },
    closeDialogs() { env.dialogsClosed += 1; env.log.push('closeDialogs'); }
  };
  win.scrollTo = function () {};

  const sw = new EventTarget();
  sw.startMessages = function () {};
  env.sw = sw;

  define('window', win);
  define('document', doc);
  define('location', env.loc);
  define('history', env.history);
  define('navigator', { serviceWorker: sw });
  define('sessionStorage', {
    getItem: (k) => (env.storage.has(k) ? env.storage.get(k) : null),
    setItem: (k, v) => env.storage.set(k, String(v)),
    removeItem: (k) => env.storage.delete(k)
  });
  define('DOMParser', win.DOMParser);
  define('CustomEvent', win.CustomEvent);
  define('getComputedStyle', win.getComputedStyle.bind(win));
  define('requestAnimationFrame', (cb) => setTimeout(cb, 16));
  define('fetch', (url, init) => serve(env, url, init));

  globalThis.__mount = function (name, ctx) {
    env.mounts.push({ name, ctx, url: ctx.url.pathname });
    env.log.push('mount ' + name);
    ctx.signal.addEventListener('abort', () => env.log.push('abort ' + name));
    const own = env.pages[name];
    const ret = own ? own(ctx) : undefined;
    if (ret && typeof ret.then === 'function') return ret;
    return typeof ret === 'function' ? ret : function () { env.log.push('cleanup ' + name); };
  };

  routerCopy += 1;
  try {
    await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(routerSrc + '\n// copy ' + routerCopy));
  } catch (e) {
    env.bootError = String(e);
  }
  env.router = win.WS.router;
  if (!o.noMount) await until(() => env.mounts.length > 0);
  return env;
}

// The server: a route per path, a page by default. { status, html, delay,
// finalUrl, contentType, page } (page: pageHtml options).
function serve(env, url, init) {
  const u = new URL(url, env.loc.href);
  const rec = { path: u.pathname + u.search, aborted: false };
  env.fetches.push(rec);
  const name = u.pathname.split('/')[1] || 'news';
  const r = Object.assign({ status: 200, delay: 20 }, env.routes[u.pathname] || {});
  const html = r.html !== undefined ? r.html : pageHtml(name, r.page);
  const signal = init && init.signal;
  return new Promise((resolve, reject) => {
    const abort = () => { rec.aborted = true; reject(new DOMException('aborted', 'AbortError')); };
    if (signal && signal.aborted) return abort();
    const t = setTimeout(() => {
      const final = r.finalUrl ? new URL(r.finalUrl, u).href : u.href;
      resolve({
        ok: r.status >= 200 && r.status < 300, status: r.status, url: final, redirected: !!r.finalUrl,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (r.contentType || 'text/html; charset=utf-8') : null) },
        text: async () => html,
        json: async () => JSON.parse(html)
      });
    }, r.delay);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); abort(); }, { once: true });
  });
}

const fetched = (env, path) => env.fetches.filter((f) => f.path === path);
const mounted = (env, name) => env.mounts.filter((m) => m.name === name);
function click(env, href) {
  const a = env.win.document.querySelector(`#wsPage a[href="${href}"]`);
  a.click();
}
const at = (env) => env.loc.pathname;
const live = (env) => env.toasts.filter((t) => !t.removed);

async function scenario(name, fn) {
  current = name;
  try {
    await fn();
  } catch (e) {
    check('ran without throwing', false, String(e && e.stack || e));
  }
}

// ---------------------------------------------------------------------------

await scenario('first load', async () => {
  const env = await boot();
  check('the router started', !!env.router, env.bootError);
  check('the page mounted once', mounted(env, 'news').length === 1);
  const st = env.history.state;
  check('the entry is marked with its place', st && st.ws === 1 && st.i === 0, st);
});

await scenario('a link swaps the page, in order', async () => {
  const env = await boot();
  click(env, '/calendar');
  await until(() => mounted(env, 'calendar').length === 1);
  check('the new page mounted', mounted(env, 'calendar').length === 1);
  check('one fetch', fetched(env, '/calendar').length === 1);
  check('the address moved', at(env) === '/calendar');
  check('a new entry, numbered', env.history.index === 1 && env.history.state.i === 1, env.history.entries);
  const order = ['closeDialogs', 'abort news', 'cleanup news', 'mount calendar'].map((s) => env.log.lastIndexOf(s));
  check('dialogs closed, then the old page left, then the new one mounted',
    order.every((x) => x >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], env.log);
  check('the title is the new page\'s', env.win.document.title === 'Site - calendar');
  check('the old module is not mounted again', mounted(env, 'news').length === 1);
});

await scenario('I1: the drawer closes at once, a progress bar after 150 ms', async () => {
  const env = await boot();
  env.routes['/slow'] = { delay: 400 };
  const bar = env.win.document.getElementById('wsProgress');
  const main = env.win.document.querySelector('main');
  click(env, '/slow');
  await wait(60);
  check('the drawer and menus closed before the page arrived', env.chromeClosed >= 1, env.chromeClosed);
  check('no bar for a quick load', bar.hidden === true);
  await wait(190);
  check('the bar shows while it still loads', bar.hidden === false);
  check('<main> is busy', main.getAttribute('aria-busy') === 'true');
  await until(() => mounted(env, 'slow').length === 1);
  check('the bar is gone once the page is in', bar.hidden === true && !main.hasAttribute('aria-busy'));
});

await scenario('I1: the bar ends when the navigation stays', async () => {
  const env = await boot();
  env.routes['/slow'] = { delay: 300, status: 500 };
  const bar = env.win.document.getElementById('wsProgress');
  click(env, '/slow');
  await wait(220);
  check('shown while loading', bar.hidden === false);
  await until(() => env.toasts.length === 1);
  check('hidden when it stays', bar.hidden === true);
});

await scenario('I1: a second tap on the link that is loading', async () => {
  const env = await boot();
  env.routes['/slow'] = { delay: 300 };
  click(env, '/slow');
  await wait(50);
  click(env, '/slow');
  await until(() => mounted(env, 'slow').length === 1);
  await wait(100);
  check('one fetch', fetched(env, '/slow').length === 1, env.fetches);
  check('none aborted', fetched(env, '/slow').every((f) => !f.aborted));
  check('one mount', mounted(env, 'slow').length === 1);
  check('one entry', env.history.length === 2, env.history.urls());
});

await scenario('I1: failed attempts replace their Retry toast', async () => {
  const env = await boot();
  env.routes['/calendar'] = { status: 500 };
  click(env, '/calendar');
  await until(() => env.toasts.length === 1);
  click(env, '/calendar');
  await until(() => env.toasts.length === 2);
  check('one Retry toast on screen', live(env).length === 1, env.toasts.map((t) => t.removed));
  check('it offers Retry', !!live(env)[0].action && live(env)[0].action.label === 'Retry');
  check('the page stayed', at(env) === '/news' && mounted(env, 'calendar').length === 0);
});

await scenario('a click during a fetch: the newest wins', async () => {
  const env = await boot();
  env.routes['/calendar'] = { delay: 200 };
  click(env, '/calendar');
  await wait(40);
  click(env, '/wiki');
  await until(() => mounted(env, 'wiki').length === 1);
  await wait(250);
  check('the first fetch was aborted', fetched(env, '/calendar')[0].aborted === true);
  check('only the second page mounted', mounted(env, 'calendar').length === 0 && mounted(env, 'wiki').length === 1);
  check('the address is the second', at(env) === '/wiki' && env.history.length === 2, env.history.urls());
});

await scenario('prefetch on hover is used once', async () => {
  const env = await boot();
  const a = env.win.document.querySelector('#wsPage a[href="/calendar"]');
  a.dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true }));
  await until(() => fetched(env, '/calendar').length === 1, 500);
  check('hovering fetched it', fetched(env, '/calendar').length === 1);
  a.click();
  await until(() => mounted(env, 'calendar').length === 1);
  check('the click used the prefetched page', fetched(env, '/calendar').length === 1, env.fetches);
});

await scenario('M2: a page\'s own addresses are never prefetched', async () => {
  const env = await boot({ path: '/wiki' });
  env.pages.wiki = (ctx) => {
    ctx.onNavigate((url) => url.pathname.startsWith('/wiki/'), (url) => url.pathname.startsWith('/wiki/'));
  };
  env.win.document.querySelector('#wsPage a[href="/news"]').click();
  await until(() => mounted(env, 'news').length === 1);
  // Back on a wiki page with its claim.
  env.win.document.querySelector('#wsPage a[href="/wiki"]').click();
  await until(() => mounted(env, 'wiki').length === 2);
  const before = env.fetches.length;
  const hover = (href) => env.win.document.querySelector(`#wsPage a[href="${href}"]`)
    .dispatchEvent(new env.win.MouseEvent('mouseover', { bubbles: true }));
  hover('/wiki/a');
  await wait(150);
  check('a claimed link is not fetched', fetched(env, '/wiki/a').length === 0, env.fetches.slice(before));
  hover('/calendar');
  await until(() => fetched(env, '/calendar').length === 1, 500);
  check('another link still is', fetched(env, '/calendar').length === 1);
});

await scenario('a claim records history; Back is offered to it', async () => {
  const env = await boot({ path: '/wiki' });
  // (The first mount has already run: re-mount with a claim.)
  const claims = [];
  env.pages.wiki = (ctx) => {
    ctx.onNavigate((url, how) => {
      if (!url.pathname.startsWith('/wiki')) return false;
      claims.push([url.pathname, !!how.pop]);
      return true;
    });
  };
  click(env, '/news');
  await until(() => mounted(env, 'news').length === 1);
  click(env, '/wiki');
  await until(() => mounted(env, 'wiki').length === 2);
  const n = env.fetches.length;
  let claimed = 0;
  env.win.addEventListener('ws:page-claimed', () => { claimed += 1; });
  click(env, '/wiki/a');
  await wait(50);
  check('no fetch', env.fetches.length === n);
  check('the page drew it', claims.length === 1 && claims[0][0] === '/wiki/a' && claims[0][1] === false, claims);
  check('a new entry for it', at(env) === '/wiki/a' && env.history.state.i === env.history.index, env.history.entries);
  check('announced as claimed', claimed === 1);
  env.history.back();
  await until(() => claims.length === 2);
  check('Back is the page\'s to draw', claims[1][0] === '/wiki' && claims[1][1] === true, claims);
  check('still no fetch', env.fetches.length === n);
});

function guarded(env) {
  env.asked = [];
  env.pages.settings = (ctx) => {
    ctx.beforeLeave((url, how) => new Promise((answer) => env.asked.push({ url: url.pathname, pop: how.pop, answer })));
  };
}

await scenario('a guard that says stay: no fetch', async () => {
  const env = await boot();
  guarded(env);
  click(env, '/settings');
  await until(() => mounted(env, 'settings').length === 1);
  click(env, '/calendar');
  await until(() => env.asked.length === 1);
  check('asked about the link', env.asked[0].url === '/calendar' && env.asked[0].pop === false);
  env.asked[0].answer(false);
  await wait(80);
  check('nothing fetched', fetched(env, '/calendar').length === 0);
  check('still here', at(env) === '/settings' && mounted(env, 'calendar').length === 0);
});

await scenario('a guard that lets go, then the fetch fails', async () => {
  const env = await boot();
  guarded(env);
  click(env, '/settings');
  await until(() => mounted(env, 'settings').length === 1);
  env.routes['/calendar'] = { status: 500 };
  let stayed = null;
  env.win.addEventListener('ws:nav-stayed', (e) => { stayed = e.detail; });
  click(env, '/calendar');
  await until(() => env.asked.length === 1);
  env.asked[0].answer(true);
  await until(() => env.toasts.length === 1);
  check('the page was told it stayed', stayed && stayed.reason === 'server', stayed);
  check('still on the page, not left', at(env) === '/settings' && !env.log.includes('abort settings'), env.log);
});

await scenario('a newer navigation wins over an older answer', async () => {
  const env = await boot();
  guarded(env);
  click(env, '/settings');
  await until(() => mounted(env, 'settings').length === 1);
  click(env, '/calendar');
  await until(() => env.asked.length === 1);
  click(env, '/wiki');
  await until(() => env.asked.length === 2);
  env.asked[0].answer(true);              // the older question, answered late
  await wait(80);
  check('the older navigation does nothing', fetched(env, '/calendar').length === 0 && at(env) === '/settings');
  env.asked[1].answer(true);
  await until(() => mounted(env, 'wiki').length === 1);
  check('the newer one goes on', at(env) === '/wiki' && mounted(env, 'calendar').length === 0);
});

await scenario('a guard that says hard', async () => {
  const env = await boot();
  guarded(env);
  click(env, '/settings');
  await until(() => mounted(env, 'settings').length === 1);
  click(env, '/calendar');
  await until(() => env.asked.length === 1);
  env.asked[0].answer('hard');
  await until(() => env.hard.length === 1);
  check('a full navigation to it', env.hard[0] === '/calendar', env.hard);
});

await scenario('M1: Back while a link\'s guard asks relabels nothing', async () => {
  const env = await boot();
  guarded(env);
  click(env, '/settings');
  await until(() => mounted(env, 'settings').length === 1);
  click(env, '/calendar');
  await until(() => env.asked.length === 1);
  env.history.back();                     // Android Back, to dismiss the dialog
  await wait(60);
  check('the address is back on the page asked about', at(env) === '/settings' && env.history.index === 1,
    [at(env), env.history.index]);
  check('the entries are as they were', env.history.urls().join() === '/news,/settings', env.history.urls());
  env.asked[0].answer(false);             // Keep editing
  await wait(60);
  check('no navigation', mounted(env, 'calendar').length === 0 && fetched(env, '/calendar').length === 0);
  env.history.back();                     // a real Back now
  await until(() => env.asked.length === 2);
  check('asked about Back', env.asked[1].url === '/news' && env.asked[1].pop === true, env.asked.map((a) => a.url));
  env.asked[1].answer(true);
  await until(() => mounted(env, 'news').length === 2);
  check('Back reached the first page', at(env) === '/news' && env.history.index === 0);
});

await scenario('M1: a refused Back steps back, entries unchanged', async () => {
  const env = await boot();
  guarded(env);
  click(env, '/settings');
  await until(() => mounted(env, 'settings').length === 1);
  env.history.back();
  await until(() => env.asked.length === 1);
  env.asked[0].answer(false);
  await wait(60);
  check('the address is the page\'s again', at(env) === '/settings' && env.history.index === 1, [at(env), env.history.index]);
  check('the entries are as they were', env.history.urls().join() === '/news,/settings', env.history.urls());
  check('by stepping, not relabelling', env.history.steps.join() === '-1,1', env.history.steps);
});

await scenario('M1: a failed Back keeps the entry; Retry takes the step again', async () => {
  const env = await boot();
  click(env, '/calendar');
  await until(() => mounted(env, 'calendar').length === 1);
  env.routes['/news'] = { status: 500 };
  env.history.back();
  await until(() => env.toasts.length === 1);
  await wait(40);
  check('the address is the page\'s again', at(env) === '/calendar' && env.history.index === 1, [at(env), env.history.index]);
  check('the entries are as they were', env.history.urls().join() === '/news,/calendar', env.history.urls());
  env.routes['/news'] = {};
  env.toasts[0].action.run();
  await until(() => mounted(env, 'news').length === 2);
  check('Retry went Back', at(env) === '/news' && env.history.index === 0 && env.history.length === 2,
    [at(env), env.history.index, env.history.urls()]);
});

await scenario('429: stays, busy words, Retry', async () => {
  const env = await boot();
  env.routes['/calendar'] = { status: 429, contentType: 'application/json', html: '{"detail":"slow down"}' };
  click(env, '/calendar');
  await until(() => env.toasts.length === 1);
  check('the busy words', /in a moment/.test(env.toasts[0].msg), env.toasts[0].msg);
  check('stayed', at(env) === '/news' && mounted(env, 'calendar').length === 0);
  env.routes['/calendar'] = {};
  env.toasts[0].action.run();
  await until(() => mounted(env, 'calendar').length === 1);
  check('Retry opened it', at(env) === '/calendar');
});

await scenario('a redirect to sign-in is a full navigation', async () => {
  const env = await boot();
  env.routes['/calendar'] = { finalUrl: '/login', html: '<html><body>login</body></html>' };
  click(env, '/calendar');
  await until(() => env.hard.length === 1);
  check('to /login', env.hard[0] === '/login', env.hard);
  check('nothing swapped in', mounted(env, 'calendar').length === 0);
});

await scenario('M4 and I2: a module that throws in the reader', async () => {
  const env = await boot();
  env.pages.reader = () => { throw new Error('broken on purpose'); };
  const quiet = console.error;
  console.error = () => {};
  click(env, '/reader');
  await until(() => !!env.win.document.querySelector('#wsPage [role="alert"]'));
  console.error = quiet;
  const doc = env.win.document;
  check('the error state shows', !!doc.querySelector('#wsPage [role="alert"] button'));
  const icon = doc.querySelector('#wsPage [role="alert"] .material-symbols-outlined');
  check('its icon is not read out', !!icon && icon.getAttribute('aria-hidden') === 'true');
  check('the shell is back: a way out', !doc.documentElement.hasAttribute('data-shell'),
    doc.documentElement.getAttribute('data-shell'));
  doc.querySelector('#wsPage [role="alert"] button').click();
  await until(() => env.hard.length === 1, 1500);
  check('Try again loads the page whole', env.hard[0] === 'reload:/reader' || env.hard[0] === '/reader', env.hard);
  check('and does not fetch it again softly', fetched(env, '/reader').length === 1, env.fetches);
});

await scenario('I2: a page from another release loads whole', async () => {
  const env = await boot();
  env.routes['/calendar'] = { page: { version: '2.0' } };
  click(env, '/calendar');
  await until(() => env.hard.length === 1);
  check('a new version: full navigation', env.hard[0] === '/calendar' && mounted(env, 'calendar').length === 0, env.hard);
});

await scenario('I2: a shared file at another stamp loads whole', async () => {
  const env = await boot();
  env.routes['/calendar'] = { page: { css: 'B' } };
  env.routes['/wiki'] = { page: { shell: 'B' } };
  click(env, '/calendar');
  await until(() => env.hard.length === 1);
  check('a new stylesheet: full navigation', env.hard[0] === '/calendar', env.hard);
  const env2 = await boot();
  env2.routes['/wiki'] = { page: { shell: 'B' } };
  click(env2, '/wiki');
  await until(() => env2.hard.length === 1);
  check('a new shell script: full navigation', env2.hard[0] === '/wiki' && mounted(env2, 'wiki').length === 0, env2.hard);
  const env3 = await boot({ page: { helper: 'A' } });
  env3.routes['/calendar'] = { page: { helper: 'B' } };
  click(env3, '/calendar');
  await until(() => env3.hard.length === 1);
  check('a page helper already loaded at another stamp: full navigation', env3.hard[0] === '/calendar', env3.hard);
  const env4 = await boot();
  click(env4, '/calendar');
  await until(() => mounted(env4, 'calendar').length === 1);
  check('the same release swaps', env4.hard.length === 0);
});

await scenario('I3: a push notification\'s click navigates softly', async () => {
  const env = await boot();
  const answers = [];
  const ask = (url) => {
    const ev = new Event('message');
    ev.data = { type: 'ws-navigate', url };
    ev.ports = [{ postMessage: (m) => answers.push(m) }];
    env.sw.dispatchEvent(ev);
  };
  ask(ORIGIN + '/calendar');
  await until(() => mounted(env, 'calendar').length === 1);
  check('answered, so the worker leaves the tab alone', answers.length === 1 && answers[0].ok === true, answers);
  check('a soft navigation', at(env) === '/calendar' && env.hard.length === 0);
  ask('https://elsewhere.test/calendar');
  ask(ORIGIN + '/api/notifications');
  await wait(60);
  check('another site or a non-page is not taken', answers.length === 1 && env.hard.length === 0, answers);
});

await scenario('M3: the scroll restore stops at the next navigation', async () => {
  const env = await boot();
  env.win.document.scrollingElement.scrollTop = 500;
  click(env, '/calendar');
  await until(() => mounted(env, 'calendar').length === 1);
  check('the position was saved on leaving', env.history.entries[0].state.scrollY === 500, env.history.entries[0].state);
  env.maxScroll = 0;                      // Back to a page still growing
  env.history.back();
  await until(() => mounted(env, 'news').length === 2);
  await wait(40);
  check('the restore is trying', env.scrollWrites.some((w) => w.v === 500));
  click(env, '/wiki');
  await until(() => mounted(env, 'wiki').length === 1);
  const mark = Date.now();
  env.maxScroll = 100000;
  await wait(300);
  const stale = env.scrollWrites.filter((w) => w.v === 500 && w.at >= mark);
  check('nothing writes the old offset into the next page', stale.length === 0, stale.length);
  check('the next page starts at the top', env.win.document.scrollingElement.scrollTop === 0);
});

await scenario('M5: a member\'s ?ws-debug is ignored and cleared', async () => {
  const env = await boot({ search: '?ws-debug=leaks,throw', storage: { 'ws.debug': 'leaks' } });
  check('the router started', !!env.router, env.bootError);
  check('the tab keeps no debug flags', !env.storage.has('ws.debug'), [...env.storage]);
  click(env, '/calendar');
  await until(() => mounted(env, 'calendar').length === 1);
  check('the next page mounts as itself', mounted(env, 'calendar').length === 1);
});

// ---- Carried from sub-project 1 (spec 2026-09-28 section 10) ----

// The real Settings kit (settings/kit.js) in this window, mounted by the
// Settings page as pages/settings.js does, with one tab ("pages") whose api
// the scenario can stage changes through. Its questions are env.confirms.
const KIT_SRC = readFileSync(join(here, '../../static/js/settings/kit.js'), 'utf8');
const SETTINGS_DOM = '<div id="settingsTabs"><a id="tab-general" data-tab="general" href="#general">General</a>' +
  '<a id="tab-pages" data-tab="pages" href="#pages">Pages</a></div>' +
  '<div data-settings-panel="general"></div><div data-settings-panel="pages"></div>' +
  '<div id="settingsSaveBar" hidden></div>';
function withKit(env) {
  env.confirms = [];
  const ui = env.win.WSUI;
  ui.el = function (tag, cls, text) {
    const n = env.win.document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  ui.icon = function (name) { return ui.el('span', 'material-symbols-outlined', name); };
  ui.cls = { btnGhost: 'ghost', btnPrimary: 'primary' };
  ui.isDialogOpen = function () { return false; };
  ui.confirm = function (opts) { return new Promise((answer) => env.confirms.push({ title: opts.title, answer })); };
  env.routes['/settings'] = { page: { extra: SETTINGS_DOM } };
  env.routes['/api/admin/settings'] = { contentType: 'application/json', html: '{"mask":"*","values":{},"meta":{}}' };
  new Function(KIT_SRC)();
  env.win.WSSettings.registerTab('pages', { mount(panel, api) { env.kitApi = api; } });
  env.pages.settings = (ctx) => {
    env.win.WSSettings.init(ctx);
    ctx.beforeLeave((url, how) => Promise.resolve(env.win.WSSettings.canLeave(how)).then((ok) => ok !== false));
  };
}

await scenario('N1 a Settings tab hash never lands on the previous entry during a held Back', async () => {
  const env = await boot();
  withKit(env);
  env.router.navigate('/settings#pages');
  await until(() => !!env.kitApi);
  check('Settings opened on its tab', at(env) === '/settings' && env.loc.hash === '#pages', env.loc.href);
  env.kitApi.set('site.name', 'edited');                // unsaved
  env.history.back();
  await until(() => env.confirms.length === 1);
  check('Back asks first', env.confirms[0].title === 'Leave without saving?', env.confirms.map((c) => c.title));
  env.confirms[0].answer(false);                     // Keep editing
  await wait(120);
  check('the previous entry\'s address is unchanged', env.history.hrefs()[0] === '/news', env.history.hrefs());
  check('the address is Settings on its tab again', at(env) === '/settings' && env.loc.hash === '#pages', env.loc.href);
  check('Settings is still shown', mounted(env, 'news').length === 1 && !env.log.includes('abort settings'), env.log);
});

await scenario('N2 a click during a Back crossfade does not get the old scroll', async () => {
  const env = await boot({ transition: 50 });
  env.win.document.scrollingElement.scrollTop = 500;
  click(env, '/calendar');
  await until(() => mounted(env, 'calendar').length === 1);
  check('the position was saved on leaving', env.history.entries[0].state.scrollY === 500, env.history.entries[0].state);
  env.maxScroll = 0;                      // Back to a page still growing
  const before = env.transitions;
  env.history.back();
  await until(() => env.transitions > before);  // the Back swap's crossfade has begun
  click(env, '/wiki');
  await until(() => mounted(env, 'wiki').length === 1);
  const mark = Date.now();
  env.maxScroll = 100000;
  await wait(600);
  const stale = env.scrollWrites.filter((w) => w.v === 500 && w.at >= mark);
  check('nothing writes the old offset into the next page', stale.length === 0, stale.length);
  check('the new page scrolls to 0', env.win.document.scrollingElement.scrollTop === 0,
    env.win.document.scrollingElement.scrollTop);
});

await scenario('N3 the entry counter stays right after a throwing pushState, an iframe step and a Settings tab push', async () => {
  for (const navigation of [true, false]) {
    const how = navigation ? ' (Navigation API)' : ' (history.go)';
    const env = await boot({ navigation });
    guarded(env);
    let threw = false;
    try {
      env.history.pushState({ keep() {} }, '', '/news?cannot-clone');
    } catch (e) {
      threw = true;
    }
    check('the push threw' + how, threw && env.history.length === 1);
    click(env, '/wiki');                    // stands in for the Seerr embed's page
    await until(() => mounted(env, 'wiki').length === 1);
    env.history.frameStep();                // the embed navigated inside itself
    click(env, '/settings');
    await until(() => mounted(env, 'settings').length === 1);
    env.history.pushState(env.history.state, '', '#pages');   // a tab push, as the kit's setHash does
    check('every entry numbered by its place' + how,
      env.history.entries.filter((e) => !e.frame).map((e) => e.state && e.state.i).join() === '0,1,2,3',
      env.history.entries.filter((e) => !e.frame).map((e) => e.state && e.state.i));
    // A jump of three joint steps (long-press Back) onto the embed's page, refused.
    env.history.go(-3);
    await until(() => env.asked.length === 1);
    check('asked about the embed\'s page' + how, env.asked[0].url === '/wiki' && env.asked[0].pop === true, env.asked.map((a) => a.url));
    env.asked[0].answer(false);
    await wait(120);
    check('back on the tab that is shown' + how, env.history.index === 4 && env.loc.hash === '#pages',
      [env.history.index, env.loc.href]);
    // Then Back twice: the tab's page, then the embed's page.
    env.history.back();
    await wait(60);
    check('Back: Settings without the tab' + how, at(env) === '/settings' && env.loc.hash === '' && env.asked.length === 1,
      [env.loc.href, env.asked.length]);
    env.history.back();
    await until(() => env.asked.length === 2);
    env.asked[1].answer(true);
    await until(() => mounted(env, 'wiki').length === 2);
    check('Back again: the embed\'s page' + how, at(env) === '/wiki' && env.history.index === 2, [at(env), env.history.index]);
  }
  // Refused, the step back from the embed's page's own entry: one step by
  // distance lands on the embed's step, which the top-level window never
  // hears about. By the entry's key it lands on the page's.
  const env = await boot({ navigation: true });
  guarded(env);
  click(env, '/wiki');
  await until(() => mounted(env, 'wiki').length === 1);
  env.history.frameStep();
  click(env, '/settings');
  await until(() => mounted(env, 'settings').length === 1);
  env.history.go(-2);
  await until(() => env.asked.length === 1);
  env.asked[0].answer(false);
  await wait(120);
  check('over the embed\'s step, back on the page\'s entry', env.history.index === 3 && at(env) === '/settings',
    [env.history.index, at(env)]);
});

await scenario('T1R1 a push while a step back is in flight supersedes it; Back then moves one entry at a time', async () => {
  for (const navigation of [true, false]) {
    const how = navigation ? ' (Navigation API)' : ' (history.go)';
    const env = await boot({ navigation });
    env.pages.wiki = (ctx) => { ctx.onNavigate((url) => url.pathname.startsWith('/wiki/')); };
    click(env, '/settings');
    await until(() => mounted(env, 'settings').length === 1);
    click(env, '/wiki');
    await until(() => mounted(env, 'wiki').length === 1);
    // Back to Settings fails: the router steps back to the wiki's entry, and
    // before that step lands the page takes a claimed link (a push).
    env.routes['/settings'] = { status: 500 };
    env.win.addEventListener('ws:nav-stayed', () => {
      env.routes['/settings'] = {};
      click(env, '/wiki/a');
    }, { once: true });
    env.history.back();
    await until(() => env.toasts.length === 1);
    await wait(80);
    check('on the claimed view' + how, at(env) === '/wiki/a' && env.history.index === 2,
      [at(env), env.history.index, env.history.urls()]);
    const steps = env.history.steps.length;
    env.history.back();
    await until(() => mounted(env, 'settings').length === 2);
    await wait(60);
    check('Back moves one entry: Settings' + how, at(env) === '/settings' && env.history.index === 1,
      [at(env), env.history.index, env.history.steps]);
    env.history.back();
    await until(() => mounted(env, 'news').length === 2);
    await wait(60);
    check('Back moves one entry again: News' + how, at(env) === '/news' && env.history.index === 0,
      [at(env), env.history.index, env.history.steps]);
    check('the router took no steps of its own' + how, env.history.steps.slice(steps).join() === '-1,-1',
      env.history.steps.slice(steps));
  }
});

await scenario('T1R2 a replace while a step back is in flight supersedes it; address, page and view agree', async () => {
  for (const navigation of [true, false]) {
    const how = navigation ? ' (Navigation API)' : ' (history.go)';
    const env = await boot({ navigation });
    env.views = [];
    const quiet = console.error;
    env.pages.wiki = (ctx) => {
      env.views.push(ctx.url.pathname);
      ctx.onNavigate((url) => {
        if (!url.pathname.startsWith('/wiki/')) return false;
        env.views.push(url.pathname);
        return true;
      });
    };
    env.pages.settings = (ctx) => { env.views.push(ctx.url.pathname); };
    env.pages.news = (ctx) => { env.views.push(ctx.url.pathname); };
    click(env, '/settings');
    await until(() => mounted(env, 'settings').length === 1);
    click(env, '/wiki');
    await until(() => mounted(env, 'wiki').length === 1);
    // Back to Settings fails: the router steps back to the wiki's entry, and
    // before that step lands the page draws another view in place (a replace).
    env.routes['/settings'] = { status: 500 };
    env.win.addEventListener('ws:nav-stayed', () => {
      env.routes['/settings'] = {};
      env.router.navigate('/wiki/a', { replace: true });
    }, { once: true });
    env.history.back();
    await until(() => env.toasts.length === 1);
    await wait(120);
    const agree = () => [at(env), new URL(env.router.current.url).pathname, env.views[env.views.length - 1]];
    const a = agree();
    check('once the step lands, the address, current and the view agree' + how, a[0] === a[1] && a[1] === a[2],
      [a, env.history.index, env.history.urls()]);
    const index = env.history.index;
    const steps = env.history.steps.length;
    env.history.back();
    await wait(150);
    const b = agree();
    check('Back moves one entry' + how, env.history.index === index - 1, [index, env.history.index]);
    check('and they still agree' + how, b[0] === b[1] && b[1] === b[2], b);
    check('the router took no step of its own' + how, env.history.steps.slice(steps).join() === '-1',
      env.history.steps.slice(steps));
    console.error = quiet;
  }
});

await scenario('N4 the progress bar clears when visit() throws after it started', async () => {
  const env = await boot();
  const bad = '<script src="https://[broken" data-ws-page-script></script>';
  env.routes['/calendar'] = { delay: 250, html: pageHtml('calendar').replace('</body>', bad + '</body>') };
  const bar = env.win.document.getElementById('wsProgress');
  const main = env.win.document.querySelector('main');
  let error = null;
  const quiet = console.error;
  console.error = () => {};
  const done = env.router.navigate('/calendar').catch((e) => { error = e; });
  await wait(200);
  check('the bar shows while it loads', bar.hidden === false);
  await done;
  await wait(20);
  console.error = quiet;
  check('the navigation threw', !!error, String(error));
  check('the bar is gone', bar.hidden === true, bar.hidden);
  check('<main> is not busy', !main.hasAttribute('aria-busy'));
});

console.log(`${total - failed}/${total} router runtime cases pass`);
process.exit(failed ? 1 : 0);
