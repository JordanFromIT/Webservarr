/**
 * WebServarr — soft navigation debug tools (ES module, debug mode only)
 *
 * The measuring tools every page conversion must pass (spec section 7).
 * router.js imports this only when the address had ?ws-debug= (leaks, throw)
 * or this tab stored it (sessionStorage 'ws.debug'); ?ws-debug=off clears it.
 * Nothing here runs for anyone else.
 *
 * In the browser, after install():
 *   WS.debug.leaks.start(page) / stop()   the router calls these on every mount
 *                                         and leave; stop() returns what the
 *                                         page left alive: [{ kind, page, stack, detail }]
 *   WS.debug.leaks.reports                every leak reported so far
 *   WS.debug.soak(urls, rounds, opts)     round trips between urls[0] and the
 *                                         others; see runSoak()
 *   WS.debug.shellIdentity()              sidebar, header, mobile bar and
 *                                         #wsPlayer are the nodes of first load
 *   WS.debug.tone                         the 440 Hz test tone in #wsPlayer
 *
 * How an item is tied to a page (the leak checker's one judgement):
 *   - a stack frame in /static/js/pages/<name>.js makes it that page's;
 *   - otherwise a stack made only of shell scripts makes it the shell's, never
 *     a page's (the router's own prefetch, WS.poll set up by the shell...);
 *   - otherwise it belongs to whichever page is mounted (page helper scripts).
 * A page's item is alive after leave when: a listener not removed, not fired
 * (once), whose own signal is not aborted, and not on an aborted AbortSignal;
 * a timer that neither fired nor was cleared; an interval not cleared; a fetch
 * not settled whose signal is not aborted. Anything a page creates after it
 * was left (by its stack) is a leak too, and each such fetch counts in
 * requestsAfterLeave.
 *
 * Wrapping changes no behaviour: the originals run first with the same this
 * and arguments, and their return values come back. Two differences only:
 * a setTimeout callback runs inside a wrapper (same this and arguments), and
 * fetch returns a promise that settles as the real one does, one tick later.
 * Not tracked: requestAnimationFrame, observers, WebSocket/EventSource, on*
 * properties.
 *
 * Pure parts (importable by Node, no DOM at import time): pageNameOf,
 * ownerOf, createTracker (given a global-like object), runSoak (given deps).
 */

export const SHELL_FILES = ['router.js', 'shell.js', 'ui.js', 'notifications.js', 'auth.js', 'theme-loader.js'];
const SELF_FILE = 'debug-leaks.js';
const PAGE_RE = /\/static\/js\/pages\/([^/]+)\.js$/;
const FRAME_RE = /([a-z][\w+.-]*:\/\/[^\s()]+?):\d+(?::\d+)?/i;
const SHELL_IDS = ['desktopSidebar', 'appHeader', 'mobileTopBar', 'wsPlayer'];
const INTERLEAVE_EVERY = 5;

/* "news" for .../static/js/pages/news.js?v=1 */
export function pageNameOf(url) {
  const path = String(url).split(/[?#]/)[0];
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.js$/, '');
}

function framesOf(stack) {
  const out = [];
  String(stack || '').split('\n').forEach(function (line) {
    const m = FRAME_RE.exec(line);
    if (!m) return;
    const path = m[1].replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
    out.push({ line: line, path: path, file: path.slice(path.lastIndexOf('/') + 1) });
  });
  return out.filter(function (f) { return f.file !== SELF_FILE; });
}

/* { page: name|null, shell } for a creation stack (rules in the header). */
export function ownerOf(stack, shellFiles) {
  const shell = shellFiles || SHELL_FILES;
  const frames = framesOf(stack);
  for (const f of frames) {
    const m = PAGE_RE.exec(f.path);
    if (m) return { page: m[1], shell: false };
  }
  return { page: null, shell: frames.length > 0 && frames.every(function (f) { return shell.indexOf(f.file) !== -1; }) };
}

// The stack as it reads in a report: no "Error" line, none of our own frames.
function cleanStack(stack) {
  return String(stack || '').split('\n').filter(function (line) {
    return FRAME_RE.test(line) && line.indexOf(SELF_FILE) === -1;
  }).map(function (l) { return l.trim(); }).join('\n');
}

function describe(t, g) {
  if (!t) return '?';
  if (t === g || (g.window && t === g.window)) return 'window';
  if (g.document && t === g.document) return 'document';
  if (typeof t.tagName === 'string') {
    let s = t.tagName.toLowerCase();
    if (t.id) s += '#' + t.id;
    else if (typeof t.className === 'string' && t.className.trim()) s += '.' + t.className.trim().split(/\s+/)[0];
    return s;
  }
  return (t.constructor && t.constructor.name) || 'EventTarget';
}

/* Wraps g.EventTarget.prototype.add/removeEventListener, g.setTimeout,
   g.setInterval, their clears, and g.fetch. opts.stack() returns the creation
   stack (tests pass a fake). Returns the tracker; uninstall() puts the
   originals back. */
export function createTracker(g, opts) {
  opts = opts || {};
  const shellFiles = opts.shellFiles || SHELL_FILES;
  const stackNow = opts.stack || function () { return new Error().stack || ''; };
  const proto = g.EventTarget.prototype;
  const orig = {
    add: proto.addEventListener, remove: proto.removeEventListener,
    setTimeout: g.setTimeout, clearTimeout: g.clearTimeout,
    setInterval: g.setInterval, clearInterval: g.clearInterval,
    fetch: g.fetch
  };
  const weak = typeof WeakRef === 'function'
    ? function (t) { return new WeakRef(t); }
    : function (t) { return { deref: function () { return t; } }; };

  let session = null;               // { name, items: Set } of the mounted page
  const left = new Set();           // pages started and since left
  const outbox = [];                // leaks for the next stop()
  const reports = [];               // every leak so far
  let afterLeave = 0;
  const listeners = new Set();      // every listener added since install (for liveListeners)
  const byTarget = new WeakMap();   // target -> [{ type, listener, capture, rec }]
  const timers = new Map();         // id -> rec, page timers and intervals only

  function report(item) {
    reports.push(item);
    outbox.push(item);
  }

  /* Who owns what is being created now: { session, stack }, { late, page,
     stack } for a page not mounted, or null for the shell and for anything
     while no page is mounted. */
  function attribute() {
    const stack = stackNow();
    const o = ownerOf(stack, shellFiles);
    if (o.page) {
      if (session && session.name === o.page) return { session: session, stack: stack };
      return { late: true, page: o.page, stack: stack };
    }
    if (o.shell || !session) return null;
    return { session: session, stack: stack };
  }

  function lateItem(kind, a, detail) {
    const item = {
      kind: kind, page: a.page, stack: cleanStack(a.stack), late: true,
      detail: detail + (left.has(a.page) ? ' (created after the page was left)' : ' (created outside mount)')
    };
    report(item);
    return item;
  }

  function track(kind, a, rec) {
    rec.kind = kind;
    rec.page = a.session.name;
    rec.stack = a.stack;
    a.session.items.add(rec);
    return rec;
  }

  function isAbortedSignal(t) {
    return !!(t && g.AbortSignal && t instanceof g.AbortSignal && t.aborted);
  }

  function listenerLive(rec) {
    if (rec.dead || (rec.signal && rec.signal.aborted)) return false;
    const t = rec.target.deref();
    return !(t && isAbortedSignal(t));
  }

  function alive(rec) {
    if (rec.kind === 'listener') return listenerLive(rec);
    if (rec.kind === 'fetch') return !rec.dead && !(rec.signal && rec.signal.aborted);
    return !rec.dead;
  }

  // ---- Listeners ----

  function noteAdd(target, type, listener, options) {
    if (listener == null) return;
    type = String(type);
    const obj = options !== null && typeof options === 'object';
    const capture = obj ? !!options.capture : !!options;
    const signal = obj && options.signal ? options.signal : null;
    if (signal && signal.aborted) return;             // the DOM added nothing
    let list = byTarget.get(target);
    if (list) {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (!listenerLive(e.rec)) { list.splice(i, 1); continue; }
        if (e.type === type && e.listener === listener && e.capture === capture) return;   // a duplicate: ignored
      }
    } else {
      list = [];
      byTarget.set(target, list);
    }
    const rec = { kind: 'listener', type: type, signal: signal, target: weak(target), dead: false };
    list.push({ type: type, listener: listener, capture: capture, rec: rec });
    listeners.add(rec);
    if (obj && options.once) {
      // Fires just after the listener, when the DOM has dropped it.
      orig.add.call(target, type, function () { rec.dead = true; listeners.delete(rec); },
        { capture: capture, once: true, signal: signal || undefined });
    }
    const a = attribute();
    if (!a) return;
    const detail = type + ' on ' + describe(target, g);
    if (a.late) { lateItem('listener', a, detail); return; }
    track('listener', a, rec).detail = detail;
  }

  function noteRemove(target, type, listener, options) {
    const list = byTarget.get(target);
    if (!list) return;
    type = String(type);
    const capture = options !== null && typeof options === 'object' ? !!options.capture : !!options;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.type === type && e.listener === listener && e.capture === capture) {
        e.rec.dead = true;
        listeners.delete(e.rec);
        list.splice(i, 1);
        return;
      }
    }
  }

  proto.addEventListener = function addEventListener(type, listener, options) {
    const ret = orig.add.apply(this, arguments);
    try { noteAdd(this == null ? g : this, type, listener, options); } catch (e) { /* bookkeeping only */ }
    return ret;
  };
  proto.removeEventListener = function removeEventListener(type, listener, options) {
    const ret = orig.remove.apply(this, arguments);
    try { noteRemove(this == null ? g : this, type, listener, options); } catch (e) { /* bookkeeping only */ }
    return ret;
  };

  // ---- Timers ----

  g.setTimeout = function setTimeout(fn, ms) {
    const a = typeof fn === 'function' ? attribute() : null;
    if (!a) return orig.setTimeout.apply(this, arguments);
    if (a.late) {
      lateItem('timer', a, 'setTimeout ' + (ms || 0) + ' ms');
      return orig.setTimeout.apply(this, arguments);
    }
    const rec = track('timer', a, { dead: false, detail: 'setTimeout ' + (ms || 0) + ' ms' });
    const args = Array.prototype.slice.call(arguments);
    args[0] = function () {
      rec.dead = true;
      timers.delete(rec.id);
      return fn.apply(this, arguments);
    };
    rec.id = orig.setTimeout.apply(this, args);
    timers.set(rec.id, rec);
    return rec.id;
  };

  g.setInterval = function setInterval(fn, ms) {
    const id = orig.setInterval.apply(this, arguments);
    const a = typeof fn === 'function' ? attribute() : null;
    if (!a) return id;
    const detail = 'setInterval ' + (ms || 0) + ' ms';
    if (a.late) { lateItem('interval', a, detail); return id; }
    const rec = track('interval', a, { dead: false, detail: detail, id: id });
    timers.set(id, rec);
    return id;
  };

  // Browsers share one id pool: either clear stops either kind.
  function noteClear(id) {
    const rec = timers.get(id);
    if (rec) { rec.dead = true; timers.delete(id); }
  }
  g.clearTimeout = function clearTimeout(id) { noteClear(id); return orig.clearTimeout.apply(this, arguments); };
  g.clearInterval = function clearInterval(id) { noteClear(id); return orig.clearInterval.apply(this, arguments); };

  // ---- fetch ----

  if (typeof orig.fetch === 'function') {
    g.fetch = function fetch(input, init) {
      const a = attribute();
      const p = orig.fetch.apply(this, arguments);
      if (!a) return p;
      const url = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
      if (a.late) {
        if (left.has(a.page)) afterLeave += 1;
        lateItem('fetch', a, 'fetch ' + url);
        return p;
      }
      const signal = init && 'signal' in init ? init.signal : (input && typeof input === 'object' ? input.signal : null);
      const rec = track('fetch', a, { dead: false, signal: signal || null, detail: 'fetch ' + url });
      return p.then(function (r) { rec.dead = true; return r; }, function (e) { rec.dead = true; throw e; });
    };
  }

  // ---- Sessions ----

  function close(s) {
    s.items.forEach(function (rec) {
      if (!alive(rec)) return;
      const item = { kind: rec.kind, page: rec.page, stack: cleanStack(rec.stack), detail: rec.detail };
      if (rec.kind === 'listener') {
        const t = rec.target.deref();
        if (t && typeof t.isConnected === 'boolean' && !t.isConnected) item.detail += ' (detached)';
      }
      report(item);
    });
    s.items.clear();
    left.add(s.name);
  }

  return {
    orig: orig,
    reports: reports,
    get requestsAfterLeave() { return afterLeave; },
    get page() { return session ? session.name : null; },
    start: function (name) {
      if (session) close(session);
      name = String(name);
      left.delete(name);
      session = { name: name, items: new Set() };
    },
    stop: function () {
      if (session) close(session);
      session = null;
      return outbox.splice(0);
    },
    /* Listeners alive now on window, document, connected nodes and other
       targets (not detached nodes, not aborted signals). */
    liveListeners: function () {
      let n = 0;
      listeners.forEach(function (rec) {
        const t = rec.target.deref();
        if (!t || !listenerLive(rec)) { listeners.delete(rec); return; }
        if (typeof t.isConnected === 'boolean' && !t.isConnected) return;
        n += 1;
      });
      return n;
    },
    uninstall: function () {
      proto.addEventListener = orig.add;
      proto.removeEventListener = orig.remove;
      g.setTimeout = orig.setTimeout;
      g.clearTimeout = orig.clearTimeout;
      g.setInterval = orig.setInterval;
      g.clearInterval = orig.clearInterval;
      if (orig.fetch) g.fetch = orig.fetch;
    }
  };
}

/* 50 round trips (by default) between urls[0] and each other url, through
   the router. Every fifth round each trip starts a navigation and at once
   another, and only the second may end mounted. Resolves
   { navigations, leaks, heapDelta, listenerDelta, requestsAfterLeave,
     interruptions, tonePlaying, interleaved, failures }.
   deps: navigate(url), currentUrl(), mounts (array the ws:page-mounted URLs
   are pushed to), isConverted(url), samePage(a, b), tracker, heap(),
   interruptions(), tonePlaying(), sleep(ms).
   opts: dwell (ms on each page, default 100), settle (ms before each
   measurement, default 1000). */
export async function runSoak(deps, urls, rounds, opts) {
  opts = opts || {};
  if (!Array.isArray(urls) || urls.length < 2) throw new Error('soak: give the page and at least one neighbour');
  rounds = Math.max(1, Math.floor(Number(rounds) || 50));
  const dwell = opts.dwell === undefined ? 100 : opts.dwell;
  const settle = opts.settle === undefined ? 1000 : opts.settle;
  const same = deps.samePage;
  const home = urls[0];
  const neighbours = urls.slice(1);
  for (const u of urls) {
    if (!(await deps.isConverted(u))) throw new Error('soak: ' + u + ' is not a converted page; it would leave by full navigation');
  }

  const failures = [];
  let navigations = 0;
  let interleaved = 0;
  let round = 0;

  async function step(url) {
    const mark = deps.mounts.length;
    await deps.navigate(url);
    navigations += 1;
    if (!same(deps.currentUrl(), url) || deps.mounts.length === mark) {
      failures.push({ round: round, url: url, reason: 'did not end mounted on ' + url });
    }
    await deps.sleep(dwell);
  }

  async function pair(url) {
    const current = deps.currentUrl();
    const first = urls.find(function (u) { return !same(u, url) && !same(u, current); }) || current;
    const mark = deps.mounts.length;
    const a = deps.navigate(first);
    const b = deps.navigate(url);
    navigations += 2;
    interleaved += 1;
    await Promise.allSettled([a, b]);
    const got = deps.mounts.slice(mark);
    if (got.length !== 1 || !same(got[0], url) || !same(deps.currentUrl(), url)) {
      failures.push({ round: round, url: url, reason: 'interleaved ' + first + ' then ' + url + ': mounted ' + JSON.stringify(got) });
    }
    await deps.sleep(dwell);
  }

  if (!same(deps.currentUrl(), home)) await deps.navigate(home);
  await deps.sleep(settle);
  const base = {
    reports: deps.tracker.reports.length,
    afterLeave: deps.tracker.requestsAfterLeave,
    listeners: deps.tracker.liveListeners(),
    heap: deps.heap(),
    interruptions: deps.interruptions()
  };

  for (round = 1; round <= rounds; round++) {
    for (const n of neighbours) {
      if (round % INTERLEAVE_EVERY === 0) await pair(n);
      else await step(n);
      await step(home);
    }
  }

  await deps.sleep(settle);
  const heap = deps.heap();
  return {
    navigations: navigations,
    leaks: deps.tracker.reports.slice(base.reports),
    heapDelta: heap === null || base.heap === null ? null : heap - base.heap,
    listenerDelta: deps.tracker.liveListeners() - base.listeners,
    requestsAfterLeave: deps.tracker.requestsAfterLeave - base.afterLeave,
    interruptions: deps.interruptions() - base.interruptions,
    tonePlaying: deps.tonePlaying ? deps.tonePlaying() : null,
    interleaved: interleaved,
    failures: failures
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/* The 440 Hz test tone, looping in #wsPlayer. A static file, not a data: URI:
   the site's CSP has no media-src, so default-src 'self' blocks data: audio.
   Counts pause, emptied and abort once it has started playing. */
function installTone(win, player) {
  const doc = win.document;
  const state = { el: null, interruptions: 0, started: false };
  if (!player) return state;
  const audio = doc.createElement('audio');
  audio.loop = true;
  audio.controls = true;
  audio.preload = 'auto';
  audio.volume = 0.2;
  audio.setAttribute('data-ws-debug-tone', '');
  audio.src = new URL('../media/debug-tone-440.wav', import.meta.url).href;
  audio.addEventListener('playing', function () { state.started = true; });
  ['pause', 'emptied', 'abort'].forEach(function (type) {
    audio.addEventListener(type, function () { if (state.started) state.interruptions += 1; });
  });
  const wrap = doc.createElement('div');
  wrap.className = 'flex justify-end px-3 py-2';
  wrap.appendChild(audio);
  player.appendChild(wrap);
  player.hidden = false;
  const setHeight = function () {
    doc.documentElement.style.setProperty('--ws-player-h', player.offsetHeight + 'px');
  };
  setHeight();
  audio.addEventListener('loadedmetadata', setHeight);
  // Autoplay needs the tab to have had a click or key press first (a fresh
  // load often has none): then the tone starts on the first one.
  function onGesture() {
    doc.removeEventListener('pointerdown', onGesture, true);
    doc.removeEventListener('keydown', onGesture, true);
    audio.play().catch(function (e) { console.warn('[ws-debug] the test tone could not start', e); });
  }
  const p = audio.play();
  if (p && p.catch) {
    p.catch(function () {
      console.info('[ws-debug] the test tone starts on the first click or key press');
      doc.addEventListener('pointerdown', onGesture, true);
      doc.addEventListener('keydown', onGesture, true);
    });
  }
  state.el = audio;
  return state;
}

/* Called by router.js once, before any page module is imported. Returns the
   router's hooks: pageStart(moduleUrl) before each mount, pageLeft() after
   each leave. */
export function install(win, opts) {
  opts = opts || {};
  const flags = opts.flags || [];
  const doc = win.document;
  const WS = win.WS || (win.WS = {});
  const debug = WS.debug || (WS.debug = {});
  debug.flags = flags.slice();

  const shell = SHELL_IDS.map(function (id) { return doc.getElementById(id); });
  debug.shellIdentity = function () {
    let ok = true;
    SHELL_IDS.forEach(function (id, i) {
      const now = doc.getElementById(id);
      if (!shell[i] || now !== shell[i]) {
        ok = false;
        console.warn('[ws-debug] shell element #' + id + (shell[i] ? ' is not the node of first load' : ' was missing at first load'));
      }
    });
    return ok;
  };

  const tone = installTone(win, doc.getElementById('wsPlayer'));
  debug.tone = {
    el: tone.el,
    get interruptions() { return tone.interruptions; },
    get playing() { return !!(tone.el && !tone.el.paused); }
  };

  // Added before the wrappers, so it never counts as anyone's listener.
  const mounts = [];
  win.addEventListener('ws:page-mounted', function (e) {
    mounts.push(e.detail && e.detail.url);
    if (mounts.length > 1000) mounts.splice(0, 500);
  });

  let tracker = null;
  if (flags.indexOf('leaks') !== -1) {
    if (typeof Error.stackTraceLimit === 'number' && Error.stackTraceLimit < 50) Error.stackTraceLimit = 50;
    tracker = createTracker(win, {});
    const origFetch = tracker.orig.fetch;
    debug.leaks = {
      start: function (page) { tracker.start(page); },
      stop: function () { return tracker.stop(); },
      get reports() { return tracker.reports; },
      get requestsAfterLeave() { return tracker.requestsAfterLeave; },
      liveListeners: function () { return tracker.liveListeners(); }
    };
    let soaking = false;
    debug.soak = async function (urls, rounds, soakOpts) {
      if (soaking) throw new Error('soak: one is already running');
      if (!WS.router) throw new Error('soak: no router on this page');
      soaking = true;
      const abs = function (u) { return new URL(u, win.location.href).href; };
      try {
        return await runSoak({
          navigate: function (u) { return WS.router.navigate(abs(u)); },
          currentUrl: function () { return WS.router.current ? WS.router.current.url : null; },
          mounts: {
            get length() { return mounts.length; },
            slice: function (i) { return mounts.slice(i); }
          },
          isConverted: async function (u) {
            const r = await origFetch.call(win, abs(u), { credentials: 'same-origin', headers: { 'X-WS-Nav': '1' } });
            const text = await r.text();
            return opts.samePage(r.url, abs(u)) && /<div\b[^>]*\bid="wsPage"[^>]*\bdata-ws-module=/.test(text);
          },
          samePage: function (a, b) { return !!a && !!b && opts.samePage(abs(a), abs(b)); },
          tracker: tracker,
          heap: function () {
            if (typeof win.gc === 'function') win.gc();
            const m = win.performance && win.performance.memory;
            return m ? m.usedJSHeapSize : null;
          },
          interruptions: function () { return tone.interruptions; },
          tonePlaying: function () { return debug.tone.playing; },
          sleep: function (ms) { return new Promise(function (r) { tracker.orig.setTimeout.call(win, r, ms); }); }
        }, urls, rounds, soakOpts);
      } finally {
        soaking = false;
      }
    };
  }

  let mountedPage = null;
  return {
    pageStart: function (moduleUrl) {
      mountedPage = pageNameOf(moduleUrl);
      if (tracker) tracker.start(mountedPage);
    },
    pageLeft: function () {
      if (!tracker) return;
      const out = tracker.stop();
      if (out.length) console.warn('[ws-debug] ' + out.length + ' item(s) still alive after leaving ' + mountedPage, out);
    }
  };
}
