/**
 * WebServarr — soft navigation router (ES module)
 *
 * Moving between converted pages swaps only #wsPage. The sidebar, header,
 * mobile bar and #wsPlayer are never torn down, so whatever lives in them
 * (audio, later) keeps going. Design: docs/superpowers/specs/
 * 2026-09-27-soft-navigation-design.md, sections 4 and 5.
 *
 * Loaded once, from the sidebar partial, on every shell page. A page is
 * converted when the server rendered #wsPage[data-ws-module]. On a page that
 * is not, the router mounts nothing, writes no history and prefetches
 * nothing, and every link it takes goes straight to a full navigation (after
 * ws:before-hard-nav), without fetching it first. From a converted page, an
 * unconverted target also ends in a full navigation: decide() says "hard".
 *
 * Pure rules (importable by Node, no DOM at import time):
 *   qualifies(href, baseHref, attrs)  does the router take this link click (5.1)
 *   decide(requestedUrl, response)    swap, full navigation, or stay (5.2, 5.5)
 *   debugFlags(search, stored)        which debug tools this tab asked for (7)
 *
 * Debug mode (spec 7): ?ws-debug=leaks,throw in the address, kept for the tab
 * in sessionStorage 'ws.debug' (?ws-debug=off clears it), loads debug-leaks.js
 * before any page module: the leak checker, the soak, the shell identity check
 * and a test tone in #wsPlayer. "throw" mounts pages/_debug-throw.js instead
 * of the next soft navigation's page, once. Without the flag neither loads.
 *
 * In the browser, window.WS.router:
 *   navigate(url, { replace })  soft navigation; resolves once the page is mounted
 *   current                     { url, module, controller } of the mounted page
 *   hardNavigate(url)           ws:before-hard-nav, then a full navigation (sign-out)
 *   clearPrefetch()             forget hover-prefetched pages (WS.clearPageCache)
 * A page module's ctx (spec 4.2) adds ctx.beforeLeave(guard): every
 * navigation away from the page (a link, navigate(), Back or Forward) first
 * awaits guard(url, { pop }): false stays (Back's address is put back),
 * 'hard' leaves by full navigation, anything else goes on. Settings asks
 * about unsaved changes this way. While it is asked, a further Back or
 * Forward waits (the address stays on the entry asked about). A navigation
 * the guard let go that then stays (a failed fetch) dispatches
 * ws:nav-stayed, so the page keeps what it holds.
 * Events on window:
 *   ws:before-hard-nav  detail { url, waitUntil(promise) }; awaited, 500 ms cap
 *   ws:page-mounted     detail { url, page } after each mount
 *   ws:nav-stayed       detail { url, reason } a navigation stayed on this page
 */

const EXCLUDED_PREFIXES = ['/auth/', '/api/', '/kavita/', '/static/', '/uploads/'];
const EXCLUDED_PATHS = ['/login', '/setup'];
const PREFETCH_KEEP_MS = 30000;      // a prefetched page is used once, within 30 s
const HOVER_INTENT_MS = 65;          // a pointer passing over a link fetches nothing
const HARD_NAV_WAIT_MS = 500;        // cap on ws:before-hard-nav handlers
const SCROLL_SAVE_MS = 150;          // scroll position written to history after scrolling stops

// "/news/" and "/news" are one page; "/" stays "/".
function normPath(path) {
  const p = String(path || '/').replace(/\/+$/, '');
  return p || '/';
}

/* True when a click on a link with this href should be a soft navigation
   (spec 5.1). attrs: { target, download, hard (data-ws-hard), button, meta,
   ctrl, shift, alt }. target "_self" is the same as no target. */
export function qualifies(href, baseHref, attrs) {
  const a = attrs || {};
  if (typeof href !== 'string' || !href.trim()) return false;
  if ((a.target && a.target !== '_self') || a.download || a.hard) return false;
  if ((a.button || 0) !== 0 || a.meta || a.ctrl || a.shift || a.alt) return false;
  let base, url;
  try {
    base = new URL(baseHref);
    url = new URL(href, base);
  } catch (e) {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin !== base.origin) return false;
  const path = normPath(url.pathname);
  if (EXCLUDED_PATHS.indexOf(path) !== -1) return false;
  for (const prefix of EXCLUDED_PREFIXES) {
    if (path === prefix.slice(0, -1) || path.indexOf(prefix) === 0) return false;
  }
  // A fragment on this very page (even an empty "#") is the browser's to scroll to.
  if (url.href.indexOf('#') !== -1 && url.pathname === base.pathname && url.search === base.search) return false;
  return true;
}

/* What to do with a fetched page (spec 5.2 steps 2 and 3, 5.5).
   response: { ok, status, finalUrl, redirected, contentType, hasModule },
   or null for a network error. Returns { action: 'swap' },
   { action: 'hard', url } or { action: 'stay', reason: 'network'|'server'|'busy' }.
   A 429 (rate limited) is as passing as a 5xx: stay, never load the limit's
   JSON answer as a page.
   A redirect is judged by where the fetch ended, not by the redirected flag:
   one that lands on the same path and query (a trailing slash dropped) is
   not a redirect. A link's #fragment is carried over, as the browser does. */
export function decide(requestedUrl, response) {
  if (!response) return { action: 'stay', reason: 'network' };
  if (response.status >= 500) return { action: 'stay', reason: 'server' };
  if (response.status === 429) return { action: 'stay', reason: 'busy' };
  const req = new URL(requestedUrl);
  const fin = response.finalUrl ? new URL(response.finalUrl, req) : new URL(req.href);
  if (fin.origin !== req.origin || normPath(fin.pathname) !== normPath(req.pathname) || fin.search !== req.search) {
    if (!fin.hash && req.hash) fin.hash = req.hash;
    return { action: 'hard', url: fin.href };
  }
  const html = /^\s*text\/html\b/i.test(response.contentType || '');
  if (!html || !response.hasModule) return { action: 'hard', url: req.href };
  return { action: 'swap' };
}

const DEBUG_FLAGS = ['leaks', 'throw'];

function parseFlags(raw) {
  const asked = String(raw || '').toLowerCase().split(',').map(function (s) { return s.trim(); });
  return DEBUG_FLAGS.filter(function (f) { return asked.indexOf(f) !== -1; });
}

/* The debug flags for this document. search: location.search; stored: this
   tab's sessionStorage 'ws.debug' (or null). The address adds to what is
   stored; "off" clears it; unknown words are ignored. store: the value to
   write back, '' to remove it, null to leave it alone. */
export function debugFlags(search, stored) {
  const kept = parseFlags(stored);
  const param = new URLSearchParams(search || '').get('ws-debug');
  if (param === null || !param.trim()) return { flags: kept, store: null };
  if (param.trim().toLowerCase() === 'off') return { flags: [], store: '' };
  const asked = parseFlags(param);
  if (!asked.length) return { flags: kept, store: null };
  const both = DEBUG_FLAGS.filter(function (f) { return kept.indexOf(f) !== -1 || asked.indexOf(f) !== -1; });
  return { flags: both, store: both.join(',') };
}

/* A one-shot flag ("throw"): when flags holds it, removes it and returns the
   value to store for the tab ('' to remove the key); otherwise null, and
   nothing changes. */
export function takeFlag(flags, name) {
  const i = flags.indexOf(name);
  if (i === -1) return null;
  flags.splice(i, 1);
  return flags.join(',');
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined' && typeof document !== 'undefined') start();

function start() {
  const WS = window.WS || (window.WS = {});
  if (WS.router) return;

  let navToken = 0;            // bumped by every navigation; the newest wins
  let fetchCtl = null;         // the in-flight navigation's own fetch
  let committing = null;       // a promise while a swap is writing the DOM
  let current = null;          // the mounted page: { url, module, controller, cleanup, claim, left }
  let swaps = 0;               // swaps committed; the first load mounts only while this is 0
  let scrollTimer = 0;
  let hoverTimer = 0;
  let hoverLink = null;
  // While a page's leave guard is being asked: { url } of the address the
  // question is about (Back's destination, or the page itself for a link).
  let asking = null;
  const prefetched = new Map();    // URL without hash -> { promise, timer }
  const scripts = new Map();       // page-helper path (no query) -> load promise

  const api = {
    navigate: function (url, opts) {
      return go(url, { replace: !!(opts && opts.replace) });
    },
    current: null,
    hardNavigate: function (url) { return hardNavigate(url); },
    clearPrefetch: clearPrefetch
  };
  WS.router = api;

  // ---- Debug mode (spec 7) ----

  const DEBUG_KEY = 'ws.debug';

  // A debug file next to this one. Not with this file's ?v= stamp: that is
  // router.js's own content hash, cached for a year, so a change to the debug
  // file alone would never arrive. One fresh query per document instead
  // (debug mode only, so the extra download costs nobody else).
  const debugLoad = '?t=' + Date.now().toString(36);
  function sibling(path) {
    const u = new URL(path, import.meta.url);
    u.search = debugLoad;
    return u.href;
  }

  function storeDebug(value) {
    try {
      if (value) sessionStorage.setItem(DEBUG_KEY, value);
      else sessionStorage.removeItem(DEBUG_KEY);
    } catch (e) { /* private mode: this document only */ }
  }

  let storedDebug = null;
  try { storedDebug = sessionStorage.getItem(DEBUG_KEY); } catch (e) { /* none */ }
  const debugState = debugFlags(location.search, storedDebug);
  if (debugState.store !== null) storeDebug(debugState.store);

  let debug = null;            // the debug tools' hooks, once loaded
  let debugReady = null;       // settles when they are (never rejects)
  if (debugState.flags.length) {
    debugReady = import(sibling('debug-leaks.js')).then(function (m) {
      debug = m.install(window, { flags: debugState.flags.slice(), samePage: samePage });
    }, function (e) {
      console.error('[router] the debug tools did not load', e);
    });
  }

  // "throw": the next soft navigation mounts a module that throws, once.
  // Called only where go() is about to swap, never on a full navigation.
  function takeThrow() {
    const store = takeFlag(debugState.flags, 'throw');
    if (store === null) return false;
    storeDebug(store);
    return true;
  }

  // ---- Fetching ----

  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function isAbort(e) { return !!e && e.name === 'AbortError'; }
  function samePage(a, b) {
    const x = new URL(a, location.href);
    const y = new URL(b, location.href);
    return x.origin === y.origin && normPath(x.pathname) === normPath(y.pathname) && x.search === y.search;
  }
  function withoutHash(u) {
    const x = new URL(u, location.href);
    x.hash = '';
    return x.href;
  }

  /* The page as decide() and the swap need it. Resolves null on a network
     error; rejects only when aborted. The body is read only for HTML below
     500 and not 429: nothing else is ever shown. */
  async function fetchPage(url, signal) {
    let r;
    try {
      r = await fetch(url, { credentials: 'same-origin', headers: { 'X-WS-Nav': '1' }, signal: signal || undefined });
    } catch (e) {
      if (isAbort(e)) throw e;
      return null;
    }
    const contentType = r.headers.get('content-type') || '';
    let text = null;
    if (r.status < 500 && r.status !== 429 && /^\s*text\/html\b/i.test(contentType)) {
      try {
        text = await r.text();
      } catch (e) {
        if (isAbort(e)) throw e;
        return null;
      }
    }
    return { ok: r.ok, status: r.status, finalUrl: r.url, redirected: r.redirected, contentType: contentType, text: text };
  }

  // ---- Prefetch (spec 5.4): hover, focus or touch; kept 30 s; used once ----

  function clearPrefetch() {
    prefetched.forEach(function (p) { clearTimeout(p.timer); });
    prefetched.clear();
  }

  function takePrefetch(url) {
    const key = withoutHash(url);
    const p = prefetched.get(key);
    if (!p) return null;
    prefetched.delete(key);
    clearTimeout(p.timer);
    return p.promise;
  }

  function attrsOf(a, e) {
    return {
      target: a.getAttribute('target'),
      download: a.hasAttribute('download'),
      hard: a.hasAttribute('data-ws-hard'),
      button: e && typeof e.button === 'number' ? e.button : 0,
      meta: !!(e && e.metaKey),
      ctrl: !!(e && e.ctrlKey),
      shift: !!(e && e.shiftKey),
      alt: !!(e && e.altKey)
    };
  }

  function linkFrom(e) {
    const t = e.target;
    return t && t.closest ? t.closest('a[href]') : null;
  }

  function prefetch(a) {
    // From an unconverted page every click is a full navigation (see go()),
    // so a prefetched copy would never be used.
    if (!current) return;
    const conn = navigator.connection;
    if (conn && conn.saveData) return;
    const href = a.getAttribute('href');
    if (!qualifies(href, location.href, attrsOf(a))) return;
    const url = new URL(href, location.href);
    if (samePage(url.href, location.href)) return;
    const key = withoutHash(url.href);
    if (prefetched.has(key)) return;
    const entry = {
      promise: fetchPage(url.href, null).catch(function () { return null; }),
      timer: setTimeout(function () {
        if (prefetched.get(key) === entry) prefetched.delete(key);
      }, PREFETCH_KEEP_MS)
    };
    prefetched.set(key, entry);
  }

  document.addEventListener('mouseover', function (e) {
    const a = linkFrom(e);
    if (a === hoverLink) return;
    clearTimeout(hoverTimer);
    hoverLink = a;
    if (a) hoverTimer = setTimeout(function () { prefetch(a); }, HOVER_INTENT_MS);
  }, { passive: true });
  document.addEventListener('mouseout', function (e) {
    if (!hoverLink) return;
    const to = e.relatedTarget;
    if (to && hoverLink.contains(to)) return;
    clearTimeout(hoverTimer);
    hoverLink = null;
  }, { passive: true });
  document.addEventListener('focusin', function (e) {
    const a = linkFrom(e);
    if (a) prefetch(a);
  });
  document.addEventListener('touchstart', function (e) {
    const a = linkFrom(e);
    if (a) prefetch(a);
  }, { passive: true });

  // ---- Page-helper scripts (spec 4.3): classic scripts, each loaded once ----

  function loadScript(src) {
    const url = new URL(src, location.href);
    const key = url.pathname;
    if (scripts.has(key)) return scripts.get(key);
    const p = new Promise(function (resolve, reject) {
      const el = document.createElement('script');
      el.src = url.href;
      el.async = false;
      el.setAttribute('data-ws-page-script', '');
      el.addEventListener('load', function () { resolve(); }, { once: true });
      el.addEventListener('error', function () {
        scripts.delete(key);     // a later navigation may try again
        el.remove();
        reject(new Error('could not load ' + url.href));
      }, { once: true });
      document.body.appendChild(el);
    });
    scripts.set(key, p);
    return p;
  }

  async function loadPageScripts(doc) {
    const list = doc.querySelectorAll('script[data-ws-page-script][src]');
    for (const s of Array.prototype.slice.call(list)) await loadScript(s.getAttribute('src'));
  }

  // ---- Full navigations (spec 5.6) ----

  /* ws:before-hard-nav first; handlers hand promises to detail.waitUntil and
     are waited for, at most 500 ms. token: the navigation this belongs to; if
     a newer one started meanwhile, this one is dropped. */
  async function hardNavigate(url, token) {
    const waits = [];
    const detail = {
      url: url,
      waitUntil: function (p) { waits.push(Promise.resolve(p)); }
    };
    try {
      window.dispatchEvent(new CustomEvent('ws:before-hard-nav', { detail: detail }));
    } catch (e) {
      console.error(e);
    }
    if (waits.length) {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise(function (r) { setTimeout(r, HARD_NAV_WAIT_MS); })
      ]);
    }
    if (token !== undefined && token !== navToken) return;
    location.assign(url);
  }

  // ---- Failure (spec 5.5) ----

  // The toast is ui.js (window.WSUI), which the shell partial loads on every
  // shell page before this module runs.
  const RETRY_WORDS = {
    network: 'Couldn’t open that page. Check your connection.',
    busy: 'Couldn’t open that page just now. Try again in a moment.',
    server: 'Couldn’t open that page. The server had a problem.'
  };

  function showRetry(href, reason, pop) {
    const msg = RETRY_WORDS[reason] || RETRY_WORDS.server;
    const ui = window.WSUI;
    if (!ui) { console.error('[router] ' + msg); return; }
    ui.toast(msg, 'err', {
      action: { label: 'Retry', run: function () { go(href, { replace: pop }); } }
    });
  }

  /* Before the page under them changes: the drawer and the header menus
     (shell.js), and any open dialog, answered as its Cancel or Escape would
     be, so no page is left waiting on it (ui.js). */
  function closeOverlays() {
    if (typeof WS.closeChrome === 'function') WS.closeChrome();
    if (window.WSUI && typeof window.WSUI.closeDialogs === 'function') window.WSUI.closeDialogs();
  }

  function mountError(root, entry) {
    const box = document.createElement('div');
    box.className = 'flex-1 flex flex-col items-center justify-center text-center px-4 py-16 text-frosted-blue/70';
    box.setAttribute('role', 'alert');
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-4xl mb-2 opacity-50';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'error';
    const text = document.createElement('p');
    text.className = 'text-[15px] font-semibold text-frosted-blue';
    text.textContent = 'This page didn’t load properly.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-lift mt-4 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[10px] ' +
      'bg-frosted-blue/[0.06] text-frosted-blue text-sm font-semibold hover:bg-frosted-blue/10 ' +
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors';
    btn.textContent = 'Try again';
    btn.addEventListener('click', function () { go(entry.url, { replace: true }); }, { signal: entry.controller.signal });
    box.appendChild(icon);
    box.appendChild(text);
    box.appendChild(btn);
    root.replaceChildren(box);
  }

  // ---- Scroll ----
  //
  // Phones scroll the document. From lg the page scrolls inside <main> or
  // inside the page's own content column, whichever has overflow set.
  function scroller() {
    const page = document.getElementById('wsPage');
    const main = page ? page.closest('main') : null;
    const list = [main, page].concat(page ? Array.prototype.slice.call(page.children) : []);
    for (const el of list) {
      if (!el) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
    }
    return document.scrollingElement || document.documentElement;
  }

  function saveScroll() {
    clearTimeout(scrollTimer);
    const st = history.state;
    if (!current || !st || st.ws !== 1 || !samePage(location.href, current.url)) return;
    const y = Math.round(scroller().scrollTop);
    if (st.scrollY === y) return;
    history.replaceState(Object.assign({}, st, { scrollY: y }), '', location.href);
  }

  function scrollToStart() {
    window.scrollTo(0, 0);
    const el = scroller();
    if (el) el.scrollTop = 0;
  }

  // Content may still be growing just after mount; try for a few frames.
  function restoreScroll(y) {
    y = y || 0;
    let frames = 0;
    (function step() {
      const el = scroller();
      el.scrollTop = y;
      if (Math.abs(el.scrollTop - y) > 1 && ++frames < 30) requestAnimationFrame(step);
    })();
  }

  function scrollToHash(url) {
    if (!url.hash || url.hash.length < 2) return;
    let id = url.hash.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* keep it raw */ }
    const el = document.getElementById(id);
    if (el) el.scrollIntoView();
  }

  document.addEventListener('scroll', function () {
    if (!current) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveScroll, SCROLL_SAVE_MS);
  }, { capture: true, passive: true });

  // ---- The swap (spec 5.2 step 6) ----

  function syncHtmlFlags(fresh) {
    const root = document.documentElement;
    Array.prototype.slice.call(root.attributes).forEach(function (a) {
      if (a.name.indexOf('data-') === 0 && !fresh.hasAttribute(a.name)) root.removeAttribute(a.name);
    });
    Array.prototype.slice.call(fresh.attributes).forEach(function (a) {
      if (a.name.indexOf('data-') === 0 && root.getAttribute(a.name) !== a.value) root.setAttribute(a.name, a.value);
    });
  }

  function syncData(doc) {
    const fresh = doc.getElementById('ws-data');
    if (!fresh) return;
    const live = document.getElementById('ws-data');
    if (live) live.textContent = fresh.textContent;
    let data = null;
    try { data = JSON.parse(fresh.textContent); } catch (e) { data = null; }
    window.WS_DATA = data;
    WS.data = data;
    WS.user = data && data.user ? data.user : null;
    WS.page = data ? data.page : null;
  }

  // The page's own <head> styles go where the server put them: before the
  // operator's custom CSS, which must keep winning.
  function syncStyles(doc) {
    document.querySelectorAll('style[data-ws-page-style]').forEach(function (s) { s.remove(); });
    const anchor = document.getElementById('webservarr-custom-css');
    doc.querySelectorAll('head style[data-ws-page-style]').forEach(function (s) {
      const copy = document.importNode(s, true);
      if (anchor && anchor.parentNode === document.head) document.head.insertBefore(copy, anchor);
      else document.head.appendChild(copy);
    });
  }

  /* The active link: the nav links stay the same nodes (the shell's listeners
     live on them), and take the new page's classes and aria-current. A badge
     is left alone; notifications.js owns it. A nav whose links changed (a
     settings save) is replaced whole and wired again. */
  function syncNav(doc) {
    ['desktopNav', 'drawerNav'].forEach(function (id) {
      const live = document.getElementById(id);
      const fresh = doc.getElementById(id);
      if (!live || !fresh) return;
      const liveLinks = live.querySelectorAll('a[href]');
      const freshLinks = fresh.querySelectorAll('a[href]');
      const hrefs = function (list) {
        return Array.prototype.map.call(list, function (a) { return a.getAttribute('href'); }).join('\n');
      };
      if (hrefs(liveLinks) !== hrefs(freshLinks)) {
        live.innerHTML = fresh.innerHTML;
        if (typeof WS.wireNav === 'function') WS.wireNav();
        return;
      }
      for (let i = 0; i < liveLinks.length; i++) {
        const a = liveLinks[i];
        const b = freshLinks[i];
        a.setAttribute('class', b.getAttribute('class') || '');
        if (b.hasAttribute('aria-current')) a.setAttribute('aria-current', b.getAttribute('aria-current'));
        else a.removeAttribute('aria-current');
        const x = a.querySelectorAll('*');
        const y = b.querySelectorAll('*');
        if (x.length !== y.length) continue;
        for (let j = 0; j < x.length; j++) {
          if (x[j].hasAttribute('data-badge') || x[j].tagName !== y[j].tagName) continue;
          x[j].setAttribute('class', y[j].getAttribute('class') || '');
        }
      }
    });
  }

  /* The branded shell and <head> as the fetched page has them: the logo and
     name, the phone bar's, the theme (and so the colours, gauge rings and
     font on <html>), the font stylesheet, the custom CSS and the favicon. A
     settings save (by this admin, or another) shows on the next page without
     a reload. Only what differs is written (shell.js WS.applyShell). */
  function syncShell(doc) {
    if (typeof WS.applyShell !== 'function') return;
    const parts = {};
    const inner = function (root, sel) {
      const n = root.querySelector(sel);
      return n ? n.innerHTML.trim() : null;
    };
    const brand = inner(doc, '[data-ws-brand]');
    if (brand !== null && brand !== inner(document, '[data-ws-brand]')) parts.brand_html = brand;
    const bar = inner(doc, '[data-ws-bar-brand]');
    if (bar !== null && bar !== inner(document, '[data-ws-bar-brand]')) parts.bar_brand_html = bar;
    const theme = doc.getElementById('ws-theme');
    const liveTheme = document.getElementById('ws-theme');
    if (theme && liveTheme && theme.textContent !== liveTheme.textContent) {
      parts.theme_css = theme.textContent;
      if (WS.data && WS.data.branding) parts.branding = WS.data.branding;
    }
    const font = doc.getElementById('ws-font');
    if (font) parts.font_href = font.getAttribute('href');
    const css = doc.getElementById('webservarr-custom-css');
    parts.custom_css = css ? css.textContent : '';
    // The favicon is the logo (theme-loader), or the page's own icon without one.
    const logo = WS.data && WS.data.branding && WS.data.branding.logo_url;
    const icon = doc.querySelector('link[rel="icon"]');
    const fav = typeof logo === 'string' && logo ? logo : (icon ? icon.getAttribute('href') : '');
    if (fav) parts.favicon = fav;
    WS.applyShell(parts);
  }

  function swapDom(doc, page) {
    const old = document.getElementById('wsPage');
    old.replaceWith(document.importNode(page, true));
    syncStyles(doc);
    document.title = doc.title;
    syncHtmlFlags(doc.documentElement);
    syncData(doc);
    syncNav(doc);
    syncShell(doc);
  }

  async function inTransition(update) {
    if (typeof document.startViewTransition !== 'function' || reduceMotion() || document.hidden) {
      update();
      return;
    }
    let t;
    try {
      t = document.startViewTransition(update);
    } catch (e) {
      update();
      return;
    }
    t.ready.catch(function () { /* skipped: the update still ran */ });
    t.finished.catch(function () { /* as above */ });
    await t.updateCallbackDone;
  }

  function focusHeading(root) {
    const h1 = root && root.querySelector('h1');
    if (!h1) return;
    if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
  }

  function announce(title) {
    const live = document.getElementById('wsLive');
    if (!live) return;
    if (live.textContent !== title) { live.textContent = title; return; }
    // The same words again are not re-read unless the region changes first.
    live.textContent = '';
    setTimeout(function () { live.textContent = title; }, 50);
  }

  // ---- Leave and mount ----

  function runCleanup(fn) {
    try { fn(); } catch (e) { console.error('[router] page cleanup failed', e); }
  }

  function leave() {
    const was = current;
    if (!was) return;
    was.left = true;
    was.claim = null;          // a left page claims nothing, even mid-swap
    was.guard = null;          // ...and asks nothing
    was.controller.abort();
    if (was.cleanup) {
      const fn = was.cleanup;
      was.cleanup = null;
      runCleanup(fn);
    }
  }

  /* mount(ctx) for the page in #wsPage. mod is null when its import failed
     (first load only: a soft navigation falls back to a full one instead). */
  async function mountPage(mod, moduleUrl, url) {
    const root = document.getElementById('wsPage');
    const entry = {
      url: url.href, module: moduleUrl, controller: new AbortController(),
      cleanup: null, claim: null, guard: null, left: false
    };
    current = entry;
    api.current = { url: entry.url, module: moduleUrl, controller: entry.controller };
    if (debug) debug.pageStart(moduleUrl);
    const signal = entry.controller.signal;
    if (typeof WS.arriveReset === 'function') WS.arriveReset();

    const ctx = {
      root: root,
      signal: signal,
      url: new URL(url.href),
      data: WS.data,
      poll: function (fn, ms) {
        if (signal.aborted) return function () {};
        const stop = WS.poll(fn, ms, signal);
        signal.addEventListener('abort', stop, { once: true });
        return stop;
      },
      setTimeout: function (fn, ms) {
        if (signal.aborted) return 0;
        const onAbort = function () { clearTimeout(id); };
        const id = setTimeout(function () {
          signal.removeEventListener('abort', onAbort);
          fn();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
        return id;
      },
      onNavigate: function (handler) {
        if (!entry.left) entry.claim = typeof handler === 'function' ? handler : null;
      },
      beforeLeave: function (guard) {
        if (!entry.left) entry.guard = typeof guard === 'function' ? guard : null;
      }
    };

    try {
      if (!mod || typeof mod.mount !== 'function') throw new Error(moduleUrl + ' has no mount()');
      const ret = await mod.mount(ctx);
      if (typeof ret === 'function') {
        if (entry.left) runCleanup(ret);
        else entry.cleanup = ret;
      }
    } catch (e) {
      // Left before mount finished: an aborted fetch (or anything else the
      // abort set off) is the page going away, not a failure.
      if (entry.left || signal.aborted) return;
      console.error('[router] ' + moduleUrl + ': mount failed', e);
      // Stop whatever the half-mounted page started; the error state gets a
      // signal of its own.
      entry.controller.abort();
      entry.claim = null;
      entry.guard = null;
      entry.controller = new AbortController();
      api.current = { url: entry.url, module: moduleUrl, controller: entry.controller };
      if (entry.cleanup) { runCleanup(entry.cleanup); entry.cleanup = null; }
      mountError(root, entry);
    }
    if (!entry.left) {
      window.dispatchEvent(new CustomEvent('ws:page-mounted', {
        detail: { url: entry.url, page: document.documentElement.getAttribute('data-page') }
      }));
    }
  }

  // ---- Navigation (spec 5.2) ----

  async function go(href, opts) {
    opts = opts || {};
    const token = ++navToken;
    clearTimeout(scrollTimer);
    if (fetchCtl) fetchCtl.abort();
    const ctl = fetchCtl = new AbortController();
    const target = new URL(href, location.href);

    // Soft navigation starts only from a converted page (one the router has
    // mounted). Leaving an unconverted page must unload it: its inline
    // scripts' timers and listeners would otherwise outlive it. No fetch.
    if (!current) {
      fetchCtl = null;
      await hardNavigate(target.href, token);
      return;
    }

    // A mounted page may claim an in-page URL (the wiki, spec section 6):
    // the router then only records history.
    if (!current.left && current.claim) {
      let claimed = false;
      try { claimed = current.claim(new URL(target.href)) === true; } catch (e) { console.error(e); }
      if (claimed) {
        fetchCtl = null;
        closeOverlays();
        if (!opts.pop) {
          saveScroll();
          const st = { ws: 1, scrollY: 0 };
          if (opts.replace) history.replaceState(st, '', target.href);
          else history.pushState(st, '', target.href);
        }
        current.url = target.href;
        api.current = { url: current.url, module: current.module, controller: current.controller };
        return;
      }
    }

    // A page may hold its visitor (Settings with unsaved changes): its guard
    // answers false to stay, 'hard' for a full navigation, anything else to
    // go on. On Back or Forward the address bar has already moved, so a stay
    // puts it back, as a failed fetch does below.
    if (!current.left && current.guard) {
      let verdict;
      const ask = asking = { url: opts.pop ? target.href : location.href };
      try {
        verdict = await current.guard(new URL(target.href), { pop: !!opts.pop });
      } catch (e) {
        console.error('[router] leave guard failed', e);
        verdict = false;
      } finally {
        if (asking === ask) asking = null;
      }
      if (token !== navToken) return;
      if (verdict === false) {
        fetchCtl = null;
        if (opts.pop) history.replaceState({ ws: 1, scrollY: Math.round(scroller().scrollTop) }, '', current.url);
        return;
      }
      if (verdict === 'hard') {
        fetchCtl = null;
        await hardNavigate(target.href, token);
        return;
      }
    }

    // 1. The prefetched copy, else a fetch of our own.
    let res = null;
    try {
      const pre = takePrefetch(target.href);
      res = pre ? await pre : null;
      if (!res || res.status >= 500 || res.status === 429) res = await fetchPage(target.href, ctl.signal);
    } catch (e) {
      if (isAbort(e)) return;
      res = null;
    }
    if (token !== navToken) return;
    fetchCtl = null;

    // 2 and 3. Redirected, not HTML, or an unconverted page: full navigation.
    let doc = null;
    let page = null;
    if (res && res.text !== null) {
      doc = new DOMParser().parseFromString(res.text, 'text/html');
      page = doc.getElementById('wsPage');
    }
    const moduleSrc = page ? page.getAttribute('data-ws-module') : null;
    let d = decide(target.href, res && {
      ok: res.ok, status: res.status, finalUrl: res.finalUrl, redirected: res.redirected,
      contentType: res.contentType, hasModule: !!moduleSrc
    });
    // Nothing on this page to swap into: this page is not converted.
    if (d.action === 'swap' && !document.getElementById('wsPage')) d = { action: 'hard', url: target.href };

    if (d.action === 'stay') {
      if (opts.pop && current) {
        // Back or Forward already moved the address bar; put it back.
        history.replaceState({ ws: 1, scrollY: Math.round(scroller().scrollTop) }, '', current.url);
      }
      // The page is still here: one whose guard let this navigation go
      // (Settings, after "Leave without saving") keeps what it holds.
      window.dispatchEvent(new CustomEvent('ws:nav-stayed', { detail: { url: target.href, reason: d.reason } }));
      showRetry(target.href, d.reason, !!opts.pop);
      return;
    }
    if (d.action === 'hard') {
      await hardNavigate(d.url, token);
      return;
    }

    const dest = new URL(res.finalUrl || target.href);
    if (!dest.hash && target.hash) dest.hash = target.hash;
    let moduleUrl = new URL(moduleSrc, dest).href;
    if (debugReady) await debugReady;
    if (token !== navToken) return;
    if (takeThrow()) moduleUrl = sibling('pages/_debug-throw.js');

    // 4. The module (and its page helpers) before the DOM is touched, so a
    //    broken module never leaves a blank page.
    let mod;
    try {
      await loadPageScripts(doc);
      mod = await import(moduleUrl);
      if (typeof mod.mount !== 'function') throw new Error(moduleUrl + ' has no mount()');
    } catch (e) {
      if (token !== navToken) return;
      console.error('[router] could not load ' + moduleUrl, e);
      await hardNavigate(target.href, token);
      return;
    }

    // One swap at a time: wait for one already writing the DOM.
    while (committing) await committing;
    if (token !== navToken) return;
    let release;
    committing = new Promise(function (r) { release = r; });
    let done;
    try {
      done = await commit(doc, page, dest, mod, moduleUrl, opts);
    } catch (e) {
      console.error('[router] swap failed', e);
      await hardNavigate(dest.href, token);
      return;
    } finally {
      committing = null;
      release();
    }
    await done.mounted;
  }

  // Steps 5 to 10. Hands back the mount promise inside an object, so the
  // caller's await ends when the DOM is written, not when the page has
  // mounted, and the next navigation can start its own swap meanwhile.
  async function commit(doc, page, dest, mod, moduleUrl, opts) {
    swaps += 1;
    closeOverlays();
    if (!opts.pop) saveScroll();

    // 5. Leave the old page.
    leave();
    if (debug) debug.pageLeft();

    // 6. Replace the page, its styles, title, <html> flags, data and nav.
    await inTransition(function () { swapDom(doc, page); });

    // 7. History. The same URL again replaces, as a link to it would.
    if (!opts.pop) {
      const st = { ws: 1, scrollY: 0 };
      if (opts.replace || dest.href === location.href) history.replaceState(st, '', dest.href);
      else history.pushState(st, '', dest.href);
    }

    // 8. Every page starts at the top, so none shows the last page's offset
    //    (on phones the document itself scrolls); Back and Forward then
    //    restore the saved position, 0 included, after mount.
    scrollToStart();

    // 9. Focus and the announcement.
    const root = document.getElementById('wsPage');
    focusHeading(root);
    announce(document.title);

    // 10. Mount.
    const mounted = mountPage(mod, moduleUrl, dest).then(function () {
      if (opts.pop) restoreScroll(opts.scrollY);
      else scrollToHash(dest);
    });
    return { mounted: mounted };
  }

  // On window, not document: window hears a click last, after every page
  // handler on document, whenever it was added. A page that takes the click
  // itself (the wiki's in-page links, Settings' unsaved-changes guard) calls
  // preventDefault first, and the router leaves it alone.
  window.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    const a = linkFrom(e);
    if (!a) return;
    const href = a.getAttribute('href');
    if (!qualifies(href, location.href, attrsOf(a, e))) return;
    e.preventDefault();
    go(new URL(href, location.href).href, {});
  });

  // Back and Forward, for the entries this router made. A page's own entries
  // and the browser's fragment entries carry no ws mark and are left alone.
  window.addEventListener('popstate', function (e) {
    const st = e.state;
    if (!current) return;
    // A page is being asked whether it may be left: Back or Forward pressed
    // again waits for that answer, on the address the question is about.
    // (The answer then keeps or restores the page's own address.)
    if (asking) {
      history.replaceState({ ws: 1, scrollY: 0 }, '', asking.url);
      return;
    }
    if (!st || st.ws !== 1) return;
    clearTimeout(scrollTimer);
    if (samePage(location.href, current.url)) {
      current.url = location.href;
      return;
    }
    go(location.href, { pop: true, scrollY: st.scrollY || 0 });
  });

  // A fragment link the browser followed (Settings' tabs from the account
  // menu, say) made an entry with no state. It is this page's: mark it, so
  // Back to it from another page swaps this page back in.
  window.addEventListener('hashchange', function () {
    if (!current || !samePage(location.href, current.url)) return;
    current.url = location.href;
    if (history.state === null) history.replaceState({ ws: 1, scrollY: Math.round(scroller().scrollTop) }, '', location.href);
  });

  // ---- First load (spec 5.3) ----

  document.querySelectorAll('script[data-ws-page-script][src]').forEach(function (s) {
    scripts.set(new URL(s.getAttribute('src'), location.href).pathname, Promise.resolve());
  });

  const firstPage = document.getElementById('wsPage');
  const firstSrc = firstPage ? firstPage.getAttribute('data-ws-module') : null;
  if (firstSrc) {
    const st = history.state && typeof history.state === 'object' ? history.state : {};
    const y = st.ws === 1 ? (st.scrollY || 0) : 0;
    try { history.scrollRestoration = 'manual'; } catch (e) { /* ignore */ }
    history.replaceState(Object.assign({}, st, { ws: 1, scrollY: y }), '', location.href);
    const moduleUrl = new URL(firstSrc, location.href).href;
    // In debug mode the tools wrap listeners, timers and fetch first.
    (debugReady || Promise.resolve()).then(function () {
      return import(moduleUrl);
    }).then(function (mod) { return mod; }, function (e) {
      console.error('[router] could not load ' + moduleUrl, e);
      return null;
    }).then(function (mod) {
      if (swaps) return null;   // a soft navigation already replaced this page
      return mountPage(mod, moduleUrl, new URL(location.href)).then(function () { restoreScroll(y); });
    });
  }
}
