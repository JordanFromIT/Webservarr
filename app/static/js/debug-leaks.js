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
 * How an item is tied to a page (the leak checker's one judgement), in order:
 *   0. made by shell code that keeps its own lifetimes (ui.js: a toast's
 *      dismiss timers, a dialog's listeners; shell.js's serviceStatus: the
 *      request the header pill shares) it is the shell's, even when a page
 *      asked;
 *      any callback in it still runs as the page's (see SELF_OWNED_FILES);
 *   1. a stack frame in /static/js/pages/<name>.js makes it that page's;
 *   2. else, inside a callback a page registered (a listener, a timer or
 *      interval callback, a requestAnimationFrame callback, a .then / .catch
 *      / .finally, which also covers Promise.all / allSettled / race / any),
 *      it is that page instance's, even when the callback fires after the
 *      page was left: ownership rides the callback, not the clock;
 *   3. else a stack made only of shell scripts, or with none of the site's
 *      frames (console, DevTools, an extension), is nobody's page;
 *   4. else no page can be named (a page helper after a native await, say):
 *      it is listed at once as page 'unattributed' with its stack, never
 *      charged to whichever page happens to be mounted. A soak fails on any
 *      that runs after a page has left. (Before the first page mounts, as on
 *      an unconverted page, nothing is listed.)
 * A page's item is alive after leave when: a listener not removed, not fired
 * (once), whose own signal is not aborted, and not on an aborted AbortSignal;
 * a timer that neither fired nor was cleared; an interval not cleared; a fetch
 * not settled whose signal is not aborted. Anything a page creates after it
 * was left is a leak too, and each such fetch counts in requestsAfterLeave.
 *
 * Wrapping changes no behaviour a page can see: same return values, same this
 * and arguments, options passed through. To carry ownership, a page's
 * listeners, timer, interval and frame callbacks are registered through a
 * wrapper (removeEventListener with the page's own function still removes it;
 * adding the same function twice still adds it once), Promise.prototype.then
 * wraps the callbacks it is given when a page registers them, and a page's
 * fetch returns a promise that settles as the real one does, one tick later.
 * The one known gap: a native await continuation does not go through .then,
 * so it is not carried (the soak result's note says so for testers). Not
 * tracked as leaks: requestAnimationFrame, observers, WebSocket/EventSource,
 * on* properties.
 *
 * Pure parts (importable by Node, no DOM at import time): pageNameOf,
 * ownerOf, createTracker (given a global-like object), runSoak (given deps).
 */

export const SHELL_FILES = ['router.js', 'shell.js', 'ui.js', 'notifications.js', 'auth.js', 'theme-loader.js'];
// Shell code whose timers and listeners live as long as the shell's own UI,
// not the page that called it: ui.js (a toast dismisses itself, a dialog stops
// listening when it closes) and shell.js's serviceStatus (the one
// service-status request, shared with the header's pill, that Home asks for
// but never aborts). 'file' is any of the file's functions,
// 'file#name' one function. When the call that creates an item comes from
// one of these, through shell frames only, the item is the shell's even
// though a page asked. Nothing else: WS.poll (shell.js) and ctx.setTimeout
// (router.js) run a page's own work, so what they create stays the page's.
export const SELF_OWNED_FILES = ['ui.js', 'shell.js#serviceStatus'];
const SELF_FILE = 'debug-leaks.js';
const PAGE_RE = /\/static\/js\/pages\/([^/]+)\.js$/;
const FRAME_RE = /([a-z][\w+.-]*:\/\/[^\s()]+?):\d+(?::\d+)?/i;
const SHELL_IDS = ['desktopSidebar', 'appHeader', 'mobileTopBar', 'wsPlayer'];
const INTERLEAVE_EVERY = 5;
const SOAK_NOTE = 'Ownership is carried through .then/.catch/.finally, Promise.all/allSettled/race/any, ' +
  'timers, intervals, listeners and requestAnimationFrame, but not through a native await: work after ' +
  'an await in a page helper script (a stack with no pages/*.js frame) shows as "unattributed".';

/* "news" for .../static/js/pages/news.js?v=1 */
export function pageNameOf(url) {
  const path = String(url).split(/[?#]/)[0];
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.js$/, '');
}

// The site's own frames: not ours (debug-leaks.js), and, when origin is
// given, not another origin's (a browser extension's content script).
function framesOf(stack, origin) {
  const out = [];
  String(stack || '').split('\n').forEach(function (line) {
    const m = FRAME_RE.exec(line);
    if (!m) return;
    if (origin && m[1].indexOf(origin + '/') !== 0) return;
    const path = m[1].replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
    // The function's name: "at Object.serviceStatus (url)" (Chrome), "serviceStatus@url"
    // (Firefox); '' when anonymous.
    const named = /^\s*at\s+(?:async\s+)?([^\s(]+)\s+\(/.exec(line) || /^([^@\s]*)@/.exec(line);
    const fn = named ? named[1].slice(named[1].lastIndexOf('.') + 1) : '';
    out.push({ line: line, path: path, file: path.slice(path.lastIndexOf('/') + 1), fn: fn });
  });
  return out.filter(function (f) { return f.file !== SELF_FILE; });
}

/* { page: name|null, shell } for a creation stack (rules in the header).
   shell is also true for a stack with none of the site's frames at all: code
   typed in the console, DevTools, an extension. That is nobody's page. */
export function ownerOf(stack, shellFiles, origin) {
  const shell = shellFiles || SHELL_FILES;
  const frames = framesOf(stack, origin);
  for (const f of frames) {
    const m = PAGE_RE.exec(f.path);
    if (m) return { page: m[1], shell: false };
  }
  return { page: null, shell: frames.every(function (f) { return shell.indexOf(f.file) !== -1; }) };
}

/* True when the call that is creating something was made by one of owned
   (default SELF_OWNED_FILES; 'file' or 'file#function'): walking out from
   the innermost of the site's frames through shell files only, one of them
   is it. */
export function madeBySelfOwned(stack, owned, origin, shellFiles) {
  owned = owned || SELF_OWNED_FILES;
  const shell = shellFiles || SHELL_FILES;
  for (const f of framesOf(stack, origin)) {
    if (owned.indexOf(f.file) !== -1 || (f.fn && owned.indexOf(f.file + '#' + f.fn) !== -1)) return true;
    if (shell.indexOf(f.file) === -1) return false;
  }
  return false;
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
const UNATTRIBUTED = { name: 'unattributed', session: null };

export function createTracker(g, opts) {
  opts = opts || {};
  const shellFiles = opts.shellFiles || SHELL_FILES;
  const selfOwnedFiles = opts.selfOwnedFiles || SELF_OWNED_FILES;
  const stackNow = opts.stack || function () { return new Error().stack || ''; };
  const origin = opts.origin || null;
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

  let session = null;               // { name, items: Set, closed } of the mounted page
  let ambient = null;               // the owner of the callback running now, if a page's
  let everStarted = false;          // a page has been mounted in this document
  const left = new Set();           // names of pages started and since left
  const outbox = [];                // leaks for the next stop()
  const reports = [];               // every leak so far
  let afterLeave = 0;
  const listeners = new Set();      // listener records since install (for liveListeners)
  const byTarget = new WeakMap();   // target -> [{ type, listener, capture, rec, wrapper, options }]
  const timers = new Map();         // id -> rec, page timers and intervals only

  function report(item) {
    reports.push(item);
    outbox.push(item);
  }

  /* Who owns what is being created now (rules 0-4 in the header). Returns
     null for the shell (and for anything before the first page mounts),
     { owner, stack, session } for the mounted page instance, { owner, stack,
     late: true } for a page instance that is not mounted, { owner, stack,
     selfOwned: true } for ui.js's own item made while a page is the owner
     (not tracked; its callbacks run as that page's), or { owner:
     UNATTRIBUTED, stack, unattributed: true } when no page can be named. */
  function attribute() {
    const stack = stackNow();
    const o = ownerOf(stack, shellFiles, origin);
    let owner = null;
    if (o.page) owner = session && session.name === o.page ? { name: o.page, session: session } : { name: o.page, session: null };
    else if (ambient) owner = ambient;
    if (madeBySelfOwned(stack, selfOwnedFiles, origin, shellFiles)) {
      return owner ? { owner: owner, stack: stack, selfOwned: true } : null;
    }
    if (!owner) {
      if (o.shell || !everStarted) return null;
      return { owner: UNATTRIBUTED, stack: stack, unattributed: true };
    }
    if (owner.session && owner.session === session) return { owner: owner, stack: stack, session: session };
    return { owner: owner, stack: stack, late: true };
  }

  // Work no page can be named for: listed at once, never charged to a page.
  function unattributedItem(kind, a, detail) {
    const item = {
      kind: kind, page: UNATTRIBUTED.name, stack: cleanStack(a.stack), unattributed: true,
      afterLeave: left.size > 0,
      detail: detail + ' (no page could be named for it: see the stack)'
    };
    report(item);
    return item;
  }

  // Runs fn with owner as the ambient owner, for whatever it creates.
  function bind(owner, fn) {
    return function () {
      const prev = ambient;
      ambient = owner;
      try { return fn.apply(this, arguments); } finally { ambient = prev; }
    };
  }

  function wasLeft(owner) {
    return owner.session ? owner.session.closed : left.has(owner.name);
  }

  function lateItem(kind, a, detail) {
    const item = {
      kind: kind, page: a.owner.name, stack: cleanStack(a.stack), late: true,
      detail: detail + (wasLeft(a.owner) ? ' (created after the page was left)' : ' (created outside mount)')
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
  //
  // A page's listener is registered through a wrapper that runs it with the
  // page as owner and marks a once listener spent. Everyone else's is passed
  // through untouched. The DOM ignores a second add of the same (type,
  // function, capture); with a wrapper in between it would not, so the
  // tracker does it instead.

  function captureOf(options) {
    return options !== null && typeof options === 'object' ? !!options.capture : !!options;
  }

  function liveEntry(list, type, listener, capture) {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!listenerLive(e.rec)) { list.splice(i, 1); continue; }
      if (e.type === type && e.listener === listener && e.capture === capture) return e;
    }
    return null;
  }

  function dropEntry(target, e) {
    e.rec.dead = true;
    listeners.delete(e.rec);
    const list = byTarget.get(target);
    const i = list ? list.indexOf(e) : -1;
    if (i !== -1) list.splice(i, 1);
  }

  proto.addEventListener = function addEventListener(type, listener, options) {
    const target = this == null ? g : this;
    let plan = null;
    try {
      if (listener != null && (typeof listener === 'function' || typeof listener === 'object')) {
        const obj = options !== null && typeof options === 'object';
        const signal = obj && options.signal ? options.signal : null;
        if (!(signal && signal.aborted)) {                         // else the DOM adds nothing
          const t = String(type);
          const capture = captureOf(options);
          const list = byTarget.get(target) || [];
          const dup = liveEntry(list, t, listener, capture);
          if (dup) {
            // Already there: the DOM would ignore this add. With a wrapper
            // registered it would not, so skip the call ourselves.
            if (dup.wrapper) return undefined;
          } else {
            plan = { list: list, t: t, capture: capture, signal: signal, once: obj && !!options.once, a: attribute() };
          }
        }
      }
    } catch (e) { plan = null; }
    if (!plan) return orig.add.apply(this, arguments);

    const a = plan.a && !plan.a.unattributed ? plan.a : null;
    const rec = { kind: 'listener', type: plan.t, signal: plan.signal, target: weak(target), dead: false };
    const entry = { type: plan.t, listener: listener, capture: plan.capture, rec: rec, wrapper: null, options: options };
    if (plan.a && plan.a.unattributed) unattributedItem('listener', plan.a, plan.t + ' on ' + describe(target, g));
    let ret;
    if (a) {
      const owner = a.owner;
      entry.wrapper = function (event) {
        if (plan.once) dropEntry(target, entry);                  // the DOM has dropped it
        const prev = ambient;
        ambient = owner;
        try {
          if (typeof listener === 'function') return listener.apply(this, arguments);
          return listener.handleEvent.apply(listener, arguments);
        } finally {
          ambient = prev;
        }
      };
      const args = Array.prototype.slice.call(arguments);
      args[1] = entry.wrapper;
      ret = orig.add.apply(this, args);
      rec.entry = entry;                                          // for uninstall
    } else {
      ret = orig.add.apply(this, arguments);
      // Not a page's: counted for liveListeners, except a once listener,
      // whose firing an unwrapped listener cannot report.
      if (plan.once) return ret;
    }
    if (!byTarget.has(target)) byTarget.set(target, plan.list);
    plan.list.push(entry);
    listeners.add(rec);
    // ui.js's own listener: wrapped only so its callback runs as the page's.
    if (a && !a.selfOwned) {
      const detail = plan.t + ' on ' + describe(target, g);
      if (a.late) lateItem('listener', a, detail);
      else track('listener', a, rec).detail = detail;
    }
    return ret;
  };

  proto.removeEventListener = function removeEventListener(type, listener, options) {
    const target = this == null ? g : this;
    let e = null;
    try {
      const list = byTarget.get(target);
      if (list) e = liveEntry(list, String(type), listener, captureOf(options));
    } catch (err) { e = null; }
    if (!e) return orig.remove.apply(this, arguments);
    let ret;
    if (e.wrapper) {
      const args = Array.prototype.slice.call(arguments);
      args[1] = e.wrapper;
      ret = orig.remove.apply(this, args);
    } else {
      ret = orig.remove.apply(this, arguments);
    }
    dropEntry(target, e);
    return ret;
  };

  // ---- Timers ----

  g.setTimeout = function setTimeout(fn, ms) {
    const a = typeof fn === 'function' ? attribute() : null;
    if (!a) return orig.setTimeout.apply(this, arguments);
    const args = Array.prototype.slice.call(arguments);
    const detail = 'setTimeout ' + (ms || 0) + ' ms';
    if (a.unattributed) {
      unattributedItem('timer', a, detail);
      return orig.setTimeout.apply(this, arguments);
    }
    if (a.selfOwned) {
      args[0] = bind(a.owner, fn);
      return orig.setTimeout.apply(this, args);
    }
    if (a.late) {
      lateItem('timer', a, detail);
      args[0] = bind(a.owner, fn);
      return orig.setTimeout.apply(this, args);
    }
    const rec = track('timer', a, { dead: false, detail: detail });
    const run = bind(a.owner, fn);
    args[0] = function () {
      rec.dead = true;
      timers.delete(rec.id);
      return run.apply(this, arguments);
    };
    rec.id = orig.setTimeout.apply(this, args);
    timers.set(rec.id, rec);
    return rec.id;
  };

  g.setInterval = function setInterval(fn, ms) {
    const a = typeof fn === 'function' ? attribute() : null;
    if (!a) return orig.setInterval.apply(this, arguments);
    const detail = 'setInterval ' + (ms || 0) + ' ms';
    if (a.unattributed) {
      unattributedItem('interval', a, detail);
      return orig.setInterval.apply(this, arguments);
    }
    const args = Array.prototype.slice.call(arguments);
    args[0] = bind(a.owner, fn);
    const id = orig.setInterval.apply(this, args);
    if (a.selfOwned) return id;
    if (a.late) { lateItem('interval', a, detail); return id; }
    timers.set(id, track('interval', a, { dead: false, detail: detail, id: id }));
    return id;
  };

  // Browsers share one id pool: either clear stops either kind.
  function noteClear(id) {
    const rec = timers.get(id);
    if (rec) { rec.dead = true; timers.delete(id); }
  }
  g.clearTimeout = function clearTimeout(id) { noteClear(id); return orig.clearTimeout.apply(this, arguments); };
  g.clearInterval = function clearInterval(id) { noteClear(id); return orig.clearInterval.apply(this, arguments); };

  // ---- Promises and frames ----
  //
  // Every .then (and so .catch, .finally, and the continuations of
  // Promise.all / allSettled / race / any, which register through .then)
  // runs its callbacks with the owner of the code that registered them, as
  // does a requestAnimationFrame callback. The one gap: a native await
  // continuation does not go through .then, so it is not carried.
  const PromiseCtor = g.Promise || Promise;
  const nativeThen = PromiseCtor.prototype.then;
  orig.then = nativeThen;
  orig.raf = g.requestAnimationFrame;

  function ownerNow() {
    if (ambient) return ambient;
    const a = attribute();
    return a && !a.unattributed ? a.owner : null;
  }

  PromiseCtor.prototype.then = function then(onOk, onErr) {
    const owner = (typeof onOk === 'function' || typeof onErr === 'function') ? ownerNow() : null;
    if (!owner) return nativeThen.apply(this, arguments);
    return nativeThen.call(this,
      typeof onOk === 'function' ? bind(owner, onOk) : onOk,
      typeof onErr === 'function' ? bind(owner, onErr) : onErr);
  };

  if (typeof orig.raf === 'function') {
    g.requestAnimationFrame = function requestAnimationFrame(fn) {
      const owner = typeof fn === 'function' ? ownerNow() : null;
      if (!owner) return orig.raf.apply(this, arguments);
      const args = Array.prototype.slice.call(arguments);
      args[0] = bind(owner, fn);
      return orig.raf.apply(this, args);
    };
  }

  // ---- fetch ----
  //
  // A page's fetch promise, and every promise its .then / .catch / .finally
  // make, run their callbacks with the fetching page as owner, even when the
  // .then is registered from code no page can be named for.
  function carry(p, owner) {
    Object.defineProperty(p, 'then', {
      configurable: true, writable: true, enumerable: false,
      value: function then(onOk, onErr) {
        return carry(nativeThen.call(this,
          typeof onOk === 'function' ? bind(owner, onOk) : onOk,
          typeof onErr === 'function' ? bind(owner, onErr) : onErr), owner);
      }
    });
    return p;
  }

  if (typeof orig.fetch === 'function') {
    g.fetch = function fetch(input, init) {
      const a = attribute();
      const p = orig.fetch.apply(this, arguments);
      if (!a) return p;
      const url = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
      if (a.unattributed) {
        unattributedItem('fetch', a, 'fetch ' + url);
        return p;
      }
      if (a.selfOwned) return carry(nativeThen.call(p, function (r) { return r; }), a.owner);
      if (a.late) {
        if (wasLeft(a.owner)) afterLeave += 1;
        lateItem('fetch', a, 'fetch ' + url);
        return carry(nativeThen.call(p, function (r) { return r; }), a.owner);
      }
      const signal = init && 'signal' in init ? init.signal : (input && typeof input === 'object' ? input.signal : null);
      const rec = track('fetch', a, { dead: false, signal: signal || null, detail: 'fetch ' + url });
      return carry(nativeThen.call(p,
        function (r) { rec.dead = true; return r; },
        function (e) { rec.dead = true; throw e; }), a.owner);
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
    s.closed = true;
    left.add(s.name);
    // Released listeners hold their page's closures: let them go.
    listeners.forEach(function (rec) { if (!rec.target.deref() || !listenerLive(rec)) listeners.delete(rec); });
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
      session = { name: name, items: new Set(), closed: false };
      everStarted = true;
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
    /* Puts the originals back (tests). A page listener still registered
       through its wrapper is re-registered as itself, so it keeps working and
       removeEventListener with its own function still finds it. */
    uninstall: function () {
      listeners.forEach(function (rec) {
        const e = rec.entry;
        const t = rec.target.deref();
        if (!e || !e.wrapper || !t || !listenerLive(rec)) return;
        orig.remove.call(t, e.type, e.wrapper, e.options);
        orig.add.call(t, e.type, e.listener, e.options);
      });
      listeners.clear();
      proto.addEventListener = orig.add;
      proto.removeEventListener = orig.remove;
      g.setTimeout = orig.setTimeout;
      g.clearTimeout = orig.clearTimeout;
      g.setInterval = orig.setInterval;
      g.clearInterval = orig.clearInterval;
      if (orig.fetch) g.fetch = orig.fetch;
      PromiseCtor.prototype.then = orig.then;
      if (orig.raf) g.requestAnimationFrame = orig.raf;
    }
  };
}

/* 50 round trips (by default) between urls[0] and each other url, through
   the router. Every fifth round each trip starts a navigation and at once
   another, and only the second may end mounted. Resolves
   { navigations, leaks, heapDelta, listenerDelta, requestsAfterLeave,
     interruptions, tonePlaying, interleaved, failures, note }.
   Work no page could be named for ('unattributed' in leaks) that ran after
   a page had left is also a failure: it is never silent.
   deps: navigate(url), currentUrl(), mounts (array the ws:page-mounted URLs
   are pushed to), claims (optional: the ws:page-claimed URLs, a page that
   drew the URL itself, the wiki's views), isConverted(url), samePage(a, b),
   tracker, heap(), interruptions(), tonePlaying(), sleep(ms).
   A claimed navigation ends at once, in place, so a claimed first half of an
   interleaved pair is not a second mount: only the mounts can collide.
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

  const claims = deps.claims || [];

  async function step(url) {
    const mark = deps.mounts.length;
    const took = claims.length;
    await deps.navigate(url);
    navigations += 1;
    if (!same(deps.currentUrl(), url) || (deps.mounts.length === mark && claims.length === took)) {
      failures.push({ round: round, url: url, reason: 'did not end mounted on ' + url });
    }
    await deps.sleep(dwell);
  }

  async function pair(url) {
    const current = deps.currentUrl();
    const first = urls.find(function (u) { return !same(u, url) && !same(u, current); }) || current;
    const mark = deps.mounts.length;
    const cmark = claims.length;
    const a = deps.navigate(first);
    const b = deps.navigate(url);
    navigations += 2;
    interleaved += 1;
    await Promise.allSettled([a, b]);
    const got = deps.mounts.slice(mark);
    const took = claims.slice(cmark);
    const ended = got.length === 1 ? same(got[0], url)
      : got.length === 0 && took.length > 0 && same(took[took.length - 1], url);
    if (!ended || !same(deps.currentUrl(), url)) {
      failures.push({ round: round, url: url, reason: 'interleaved ' + first + ' then ' + url + ': mounted ' + JSON.stringify(got) +
        (took.length ? ', claimed ' + JSON.stringify(took) : '') });
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
  const leaks = deps.tracker.reports.slice(base.reports);
  leaks.forEach(function (item) {
    if (item.unattributed && item.afterLeave) {
      failures.push({ round: null, url: null, reason: 'unattributed ' + item.kind + ' after a page left: ' + item.detail, stack: item.stack });
    }
  });
  return {
    navigations: navigations,
    leaks: leaks,
    heapDelta: heap === null || base.heap === null ? null : heap - base.heap,
    listenerDelta: deps.tracker.liveListeners() - base.listeners,
    requestsAfterLeave: deps.tracker.requestsAfterLeave - base.afterLeave,
    interruptions: deps.interruptions() - base.interruptions,
    tonePlaying: deps.tonePlaying ? deps.tonePlaying() : null,
    interleaved: interleaved,
    failures: failures,
    note: SOAK_NOTE
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
  const claims = [];
  win.addEventListener('ws:page-claimed', function (e) {
    claims.push(e.detail && e.detail.url);
    if (claims.length > 1000) claims.splice(0, 500);
  });

  let tracker = null;
  if (flags.indexOf('leaks') !== -1) {
    if (typeof Error.stackTraceLimit === 'number' && Error.stackTraceLimit < 50) Error.stackTraceLimit = 50;
    tracker = createTracker(win, { origin: win.location.origin });
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
          claims: {
            get length() { return claims.length; },
            slice: function (i) { return claims.slice(i); }
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
