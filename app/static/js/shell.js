/**
 * WebServarr — page shell (client side)
 *
 * The sidebar, header and mobile bar arrive in the HTML already rendered for
 * this user (see app/pages.py and app/static/partials/). This module only
 * decorates: menus, drawer, logout, notifications, the status pill, the
 * scroll hint, and the shared helpers pages use to load content in a designed
 * order. It never constructs navigation.
 *
 * Exposes window.WS:
 *   WS.data / WS.user / WS.page   the #ws-data block, parsed by theme-loader.js
 *   WS.ready(fn)                  after DOMContentLoaded (or now)
 *   WS.whenActive(fn)             now, or when a prerendered page is shown
 *   WS.poll(fn, ms) -> stop()     visibility-aware interval, starts when active
 *   WS.serviceStatus()            deduplicated /api/integrations/service-status
 *   WS.setHTML(el, html)          innerHTML only when the string changed
 *   WS.arrive(key, write)         reveal sections top-down, in document order
 *   WS.swr(key, fetcher, render)  stale-while-revalidate page data
 *
 * Usage:
 *   <script src="/static/js/auth.js"></script>
 *   <script src="/static/js/shell.js"></script>
 *   <script src="/static/js/notifications.js"></script>
 */
(function () {
  'use strict';

  var data = window.WS_DATA || null;
  var user = data && data.user ? data.user : null;
  var initAt = performance.now();

  // ---- sessionStorage, namespaced by user so a shared device never shows
  //      the previous person's cached data. Cleared on logout. ----
  var ns = 'ws:' + (user ? user.username : 'anon') + ':';

  function cacheGet(key) {
    try {
      var raw = sessionStorage.getItem(ns + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function cacheSet(key, value) {
    try { sessionStorage.setItem(ns + key, JSON.stringify(value)); } catch (e) { /* quota / private mode */ }
  }
  function clearCache() {
    try {
      var keys = [];
      for (var i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i));
      keys.forEach(function (k) { if (k && k.indexOf('ws:') === 0) sessionStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  // ---- Lifecycle helpers ----

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* A page fetched by the speculation rules is rendered before it is shown.
     Initial data loads may run then (that is what makes the click instant),
     but timers and side-effect requests wait until the page is on screen. */
  function whenActive(fn) {
    if (document.prerendering) document.addEventListener('prerenderingchange', fn, { once: true });
    else fn();
  }

  /* setInterval that starts only when the page is on screen, skips ticks in a
     background tab, refreshes when the tab comes back, and refreshes a page
     restored from the back/forward cache. Returns a stop() function. */
  function poll(fn, ms) {
    var timer = null;
    function tick() { if (!document.hidden) fn(); }
    whenActive(function () {
      // Prerendered a while ago: the data is stale the moment it is seen.
      if (performance.now() - initAt > 10000) fn();
      timer = setInterval(tick, ms);
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && timer) fn();
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted && timer) fn(); });
    return function stop() { if (timer) clearInterval(timer); timer = null; };
  }

  // ---- DOM helpers ----

  var lastHTML = (typeof WeakMap === 'function') ? new WeakMap() : null;

  /* Write only when the markup actually changed. Polls rebuild sections every
     30 s; when nothing moved, nothing should repaint, scroll or flicker. */
  function setHTML(el, html) {
    if (!el) return false;
    if (lastHTML && lastHTML.get(el) === html) return false;
    el.innerHTML = html;
    if (lastHTML) lastHTML.set(el, html);
    return true;
  }

  // ---- Arrival: sections reveal top-down, in document order ----
  //
  // Every fetch on a page fires at once; without this, sections appear in
  // whatever order the network answers. Sections are marked data-arrive="key"
  // in the HTML; a loader hands its first write to arrive(key, fn) and it runs
  // once every section above it has arrived (or once the gate lifts, so one
  // slow integration cannot hold the page). Later calls for a key that has
  // already arrived run at once with no animation - polls use the same path.
  var arr = { order: [], done: {}, queue: {}, gate: false, last: 0 };

  function arriveInit() {
    arr.order = Array.prototype.map.call(document.querySelectorAll('[data-arrive]'), function (el) {
      return el.getAttribute('data-arrive');
    });
    setTimeout(function () { arr.gate = true; arriveFlush(); }, 1200);
  }

  function arrive(key, write) {
    if (arr.done[key] || arr.order.indexOf(key) === -1) {
      if (write) write();
      return;
    }
    arr.queue[key] = write || function () {};
    arriveFlush();
  }

  function arriveFlush() {
    for (var i = 0; i < arr.order.length; i++) {
      var k = arr.order[i];
      if (arr.done[k]) continue;
      if (!(k in arr.queue)) {
        if (arr.gate) continue;   // gate open: later sections need not wait
        return;                   // gate closed: hold everything below this one
      }
      var write = arr.queue[k];
      delete arr.queue[k];
      arr.done[k] = true;
      try { write(); } catch (e) { if (window.console) console.error(e); }
      var el = document.querySelector('[data-arrive="' + k + '"]');
      if (el) {
        var now = performance.now();
        var delay = Math.max(0, arr.last + 60 - now);   // 60 ms stagger between sections
        arr.last = now + delay;
        el.style.animationDelay = delay + 'ms';
        el.classList.add('ws-in');
      }
    }
  }

  // ---- Stale-while-revalidate page data ----
  //
  // A revisit paints the last known data at once instead of a skeleton, then
  // fetches and re-renders only if the answer changed.
  function swr(key, fetcher, render, maxAge) {
    if (maxAge === undefined) maxAge = 15 * 60 * 1000;
    var cached = cacheGet('swr:' + key);
    var cachedJSON = null;
    if (cached && (Date.now() - cached.t) < maxAge) {
      cachedJSON = JSON.stringify(cached.d);
      try { render(cached.d, true); } catch (e) { if (window.console) console.error(e); }
    }
    return fetcher().then(function (fresh) {
      var freshJSON = JSON.stringify(fresh);
      if (freshJSON !== cachedJSON) {
        try { render(fresh, false); } catch (e) { if (window.console) console.error(e); }
      }
      cacheSet('swr:' + key, { t: Date.now(), d: fresh });
      return fresh;
    });
  }

  // ---- Status pill ----
  //
  // Painted from the last known state at once, revalidated in the background.
  // Unknown (first ever visit) reserves the space and says nothing.
  var PILL = {
    ok: {
      pill: 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/30',
      dot: 'flex size-2 rounded-full bg-green-500 animate-pulse',
      text: 'text-green-500 text-xs font-bold uppercase tracking-widest',
      label: 'All Systems Online'
    },
    warn: {
      pill: 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-yellow-500/10 border border-yellow-500/30',
      dot: 'flex size-2 rounded-full bg-yellow-500',
      text: 'text-yellow-500 text-xs font-bold uppercase tracking-widest',
      label: 'Degraded Performance'
    },
    err: {
      pill: 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/30',
      dot: 'flex size-2 rounded-full bg-red-500',
      text: 'text-red-500 text-xs font-bold uppercase tracking-widest',
      label: 'System Issues Detected'
    }
  };

  function paintStatus(state) {
    var pill = document.getElementById('systemStatus');
    if (!pill) return;
    var s = PILL[state];
    if (!s) { pill.setAttribute('data-state', 'unknown'); return; }
    if (pill.getAttribute('data-state') === state) return;
    pill.className = s.pill;
    pill.setAttribute('data-state', state);
    var dot = pill.querySelector('[data-status-dot]');
    var text = pill.querySelector('[data-status-text]');
    if (dot) dot.className = s.dot;
    if (text) { text.className = s.text; text.textContent = s.label; }
  }

  function summarise(services) {
    if (!Array.isArray(services) || services.length === 0) return null;
    var down = false, degraded = false;
    for (var i = 0; i < services.length; i++) {
      if (services[i].status === 'down') down = true;
      else if (services[i].status === 'degraded') degraded = true;
    }
    return down ? 'err' : (degraded ? 'warn' : 'ok');
  }

  var statusPromise = null;

  /* One request shared by the pill and any page that lists services (the
     dashboard tiles), cached for the next visit. */
  function serviceStatus() {
    if (statusPromise) return statusPromise;
    statusPromise = fetch('/api/integrations/service-status')
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (list) {
        var state = summarise(list);
        if (state) {
          paintStatus(state);
          cacheSet('status', { state: state, list: list, t: Date.now() });
        }
        setTimeout(function () { statusPromise = null; }, 5000);
        return list;
      });
    return statusPromise;
  }

  // ---- Chrome wiring: drawer, menus, logout ----

  function wireChrome() {
    var overlay = document.getElementById('drawerOverlay');
    var panel = document.getElementById('drawerPanel');
    var hamburger = document.getElementById('hamburgerBtn');
    var closeBtn = document.getElementById('drawerCloseBtn');

    function openDrawer() {
      overlay.classList.remove('hidden');
      void panel.offsetHeight;   // reflow before the transform transitions
      panel.classList.remove('-translate-x-full');
      panel.classList.add('translate-x-0');
    }
    function closeDrawer() {
      panel.classList.remove('translate-x-0');
      panel.classList.add('-translate-x-full');
      setTimeout(function () { overlay.classList.add('hidden'); }, 300);
    }
    if (overlay && panel) {
      if (hamburger) hamburger.addEventListener('click', openDrawer);
      if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDrawer(); });
    }

    [['userMenuBtn', 'userMenuDropdown'], ['mobileUserMenuBtn', 'mobileUserMenuDropdown']].forEach(function (pair) {
      var btn = document.getElementById(pair[0]);
      var menu = document.getElementById(pair[1]);
      if (!btn || !menu) return;
      btn.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('hidden'); });
      document.addEventListener('click', function () { menu.classList.add('hidden'); });
    });

    document.querySelectorAll('#logoutBtn, [data-logout]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        clearCache();
        window.location.href = '/auth/logout';
      });
    });
  }

  // ---- Scroll hint (mobile only) ----
  //
  // Shown only while there is content below the fold; fades at the bottom;
  // reappears when scrolled back up. Checked on load, resize and whenever the
  // page's height changes, not just on scroll.
  function wireScrollHint() {
    var hint = document.getElementById('scrollDownHint');
    if (!hint) return;
    function update() {
      var doc = document.documentElement;
      var canScroll = doc.scrollHeight > window.innerHeight + 24;
      var atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 20;
      hint.style.opacity = (canScroll && !atBottom) ? '1' : '0';
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(document.body);
    update();
  }

  // ---- Public API ----

  window.WS = {
    data: data,
    user: user,
    page: data ? data.page : null,
    ready: ready,
    whenActive: whenActive,
    poll: poll,
    setHTML: setHTML,
    arrive: arrive,
    swr: swr,
    serviceStatus: serviceStatus,
    clearCache: clearCache
  };

  ready(function () {
    if (!document.getElementById('desktopSidebar')) return;   // a page without the shell
    arriveInit();
    wireChrome();
    wireScrollHint();

    var cached = cacheGet('status');
    if (cached && cached.state) paintStatus(cached.state);

    whenActive(function () {
      serviceStatus();
      if (user && typeof window.initNotifications === 'function') window.initNotifications();
    });
  });
})();
