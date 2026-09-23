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
 *   WS.dragScroll(el)             mouse drag-to-scroll for a sideways row
 *   WS.dragScroll.stop(el)        end that row's momentum glide (before scrolling it)
 *   WS.mediaType(type)            { label, icon, accent } for movie/tv/book/audiobook
 *   WS.requestStatus(status)      { label, tone } for a Seerr-style request status
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
  var arr = { order: [], done: {}, queue: {}, gate: false, last: 0, painted: false };

  function arriveInit() {
    arr.order = Array.prototype.map.call(document.querySelectorAll('[data-arrive]'), function (el) {
      return el.getAttribute('data-arrive');
    });
    // Ordering is only worth a short wait. Answers that land within this
    // window reveal top-down; anything slower reveals as it comes, so one
    // slow integration never holds the page.
    setTimeout(function () { arr.gate = true; arriveFlush(); }, 300);
    // Content that is in place before the first frame (a revisit painting
    // from cache) must not fade in - it was never absent.
    requestAnimationFrame(function () { requestAnimationFrame(function () { arr.painted = true; }); });
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
      if (el && arr.painted) {
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
  // fetches and re-renders only if the answer changed. render(data, fromCache)
  // may therefore run twice. opts.onError(err) runs only when the fetch failed
  // AND nothing cached was shown - stale content beats an error block.
  function swr(key, fetcher, render, opts) {
    opts = opts || {};
    var maxAge = opts.maxAge === undefined ? 15 * 60 * 1000 : opts.maxAge;
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
    }, function (err) {
      if (cachedJSON === null && opts.onError) {
        try { opts.onError(err); } catch (e) { if (window.console) console.error(e); }
      }
      return cachedJSON === null ? null : cached.d;
    });
  }

  /* fetch() that rejects on a non-2xx status and parses JSON - the shape every
     loader wants from swr's fetcher. */
  function getJSON(url) {
    return fetch(url).then(function (r) {
      // A page can be served from the prefetch cache after the session has
      // ended; the first API answer says so.
      if (r.status === 401) { window.location.href = '/login'; throw new Error('HTTP 401'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---- Hover prefetch ----
  //
  // Speculation rules do the same thing natively, but not every browser
  // honours them. The service worker (sw.js) fetches the target document while
  // the pointer is still over the link and hands it to the navigation that
  // follows, so the click lands on a document already in hand.
  var PAGE_CACHE = 'ws-pages-v1';
  var prefetchedAt = {};

  function prefetch(href) {
    var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) return;
    var now = Date.now();
    if (prefetchedAt[href] && now - prefetchedAt[href] < 20000) return;
    prefetchedAt[href] = now;
    sw.postMessage({ type: 'prefetch', url: href });
  }

  function wirePrefetch() {
    if (!('serviceWorker' in navigator)) return;
    document.querySelectorAll('#desktopNav a, #drawerNav a').forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href || href === location.pathname) return;
      var go = function () { prefetch(href); };
      a.addEventListener('mouseenter', go);
      a.addEventListener('focus', go);
      a.addEventListener('touchstart', go, { passive: true });
    });
  }

  function clearPageCache() {
    try { if (window.caches) caches.delete(PAGE_CACHE); } catch (e) { /* ignore */ }
    try {
      var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ type: 'clear-pages' });
    } catch (e) { /* ignore */ }
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
        clearPageCache();
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

  // ---- Drag to scroll (mouse only) ----
  //
  // A sideways poster row scrolls under a finger on a phone; on a desktop the
  // same row should follow a mouse drag. Touch and pen are left entirely to
  // the browser: every handler below returns early unless pointerType is
  // 'mouse', so native touch scrolling and its momentum are untouched.
  //
  // Attach it to the scrolling element itself, once. Content can be replaced
  // inside it freely (the listeners live on the row, not the cards), and a
  // second call on the same element is a no-op, so re-renders never stack
  // handlers.
  var DRAG_THRESHOLD = 5;          // px before a press becomes a drag
  var GLIDE_DECAY = 0.92;          // velocity kept per 16 ms frame
  var GLIDE_MIN = 0.02;            // px/ms below which the glide stops
  var GLIDE_MAX = 3;               // px/ms cap, so a wild flick stays sane

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function dragScroll(el) {
    if (!el || el._wsDragScroll) return;
    el._wsDragScroll = true;

    var press = null;        // { id, x, left } while the button is held
    var dragging = false;
    var swallowClick = false;
    var velocity = 0, lastX = 0, lastT = 0;
    var glideFrame = 0;
    var saved = null;        // inline scroll-behavior / scroll-snap-type to restore

    function scrollable() { return el.scrollWidth - el.clientWidth > 1; }

    // scroll-behavior:smooth would turn every scrollLeft write into its own
    // little animation (the row lags the cursor), and scroll-snap would pull
    // the row back toward a snap point mid-drag. Both are switched off for the
    // drag and the glide, then put back exactly as they were.
    function hold() {
      if (saved) return;
      saved = { behavior: el.style.scrollBehavior, snap: el.style.scrollSnapType };
      el.style.scrollBehavior = 'auto';
      el.style.scrollSnapType = 'none';
    }
    function release() {
      if (!saved) return;
      el.style.scrollBehavior = saved.behavior;
      el.style.scrollSnapType = saved.snap;
      saved = null;
    }

    function stopGlide() {
      if (!glideFrame) return;
      cancelAnimationFrame(glideFrame);
      glideFrame = 0;
      release();
    }

    function glide() {
      var pos = el.scrollLeft;
      var max = el.scrollWidth - el.clientWidth;
      var prev = performance.now();
      function step(now) {
        var dt = Math.min(now - prev, 32);
        prev = now;
        pos = Math.max(0, Math.min(max, pos + velocity * dt));
        el.scrollLeft = pos;
        velocity *= Math.pow(GLIDE_DECAY, dt / 16);
        if (Math.abs(velocity) < GLIDE_MIN || pos <= 0 || pos >= max) {
          glideFrame = 0;
          release();
          return;
        }
        glideFrame = requestAnimationFrame(step);
      }
      glideFrame = requestAnimationFrame(step);
    }

    // Ends the gesture however it ended. withGlide is true only for a real
    // release over the row (pointerup): that release is followed by a click
    // to swallow and may coast. Every other ending - a cancel, lost capture
    // (window blur, alt-tab), a release we never heard about - just stops and
    // puts the row back, so no state can outlive the gesture: a stuck
    // `dragging` would leave the grabbing cursor and the scroll overrides on,
    // and swallow the next ordinary click on a card.
    function endDrag(e, withGlide) {
      press = null;
      if (!dragging) return;
      dragging = false;
      el.classList.remove('ws-dragging');
      try {
        if (e && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch (err) { /* already released */ }
      if (withGlide) {
        // The button came up over whatever card the drag ended on; the click
        // that follows must not open it. Cleared on the next task in case no
        // click arrives (released outside the row).
        swallowClick = true;
        setTimeout(function () { swallowClick = false; }, 0);
      }
      // A pause before letting go means the user stopped the row themselves.
      if (withGlide && !reducedMotion() && performance.now() - lastT < 80 &&
          Math.abs(velocity) > GLIDE_MIN) {
        glide();
      } else {
        release();
      }
    }

    el.addEventListener('pointerenter', function (e) {
      if (e.pointerType === 'mouse') el.classList.toggle('ws-drag-ready', scrollable());
    });

    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse') return;
      endDrag(e, false);                            // finish any gesture left open
      stopGlide();                                  // a press catches a gliding row
      if (e.button !== 0 || !scrollable()) return;
      press = { id: e.pointerId, x: e.clientX, left: el.scrollLeft };
      velocity = 0;
      lastX = e.clientX;
      lastT = performance.now();
    });

    el.addEventListener('pointermove', function (e) {
      if (!press || e.pointerId !== press.id) return;
      // The button was released somewhere we never heard about (outside the
      // row, before a drag began and captured the pointer).
      if (!(e.buttons & 1)) { endDrag(e, false); return; }
      var dx = e.clientX - press.x;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        dragging = true;
        hold();
        el.classList.add('ws-dragging');
        // Capture only once it is a drag: capturing on press would retarget
        // the click of an ordinary press to the row and the card would never
        // see it.
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        var sel = window.getSelection && window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      }
      el.scrollLeft = press.left - dx;
      var now = performance.now();
      var dt = now - lastT;
      if (dt > 0) {
        var v = (lastX - e.clientX) / dt;
        velocity = Math.max(-GLIDE_MAX, Math.min(GLIDE_MAX, 0.8 * v + 0.2 * velocity));
      }
      lastX = e.clientX;
      lastT = now;
    });

    el.addEventListener('pointerup', function (e) { endDrag(e, true); });
    el.addEventListener('pointercancel', function (e) { endDrag(e, false); });
    // Capture can be taken away without a pointerup ever reaching the row. On a
    // normal release this fires after pointerup has already finished the drag,
    // and does nothing.
    el.addEventListener('lostpointercapture', function (e) { endDrag(e, false); });

    // Capture phase on the row runs before any card's own click handler.
    el.addEventListener('click', function (e) {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // No ghost image of a poster (or a link) following the cursor.
    el.addEventListener('dragstart', function (e) { e.preventDefault(); });

    // The wheel (or trackpad) takes over from a glide immediately.
    el.addEventListener('wheel', stopGlide, { passive: true });

    // For controls outside the row that scroll it (the chevron buttons are
    // siblings, so the row never sees their press): see dragScroll.stop.
    el._wsStopGlide = stopGlide;
  }

  // Stop a row's glide before scrolling it some other way. Without this a
  // chevron's smooth scrollBy and the glide's per-frame scrollLeft writes
  // fight over the row. Also restores the row's own scroll-behavior first, so
  // a smooth scrollBy is smooth again. A no-op for a row that is not gliding
  // or was never wired.
  dragScroll.stop = function (el) {
    if (el && el._wsStopGlide) el._wsStopGlide();
  };

  // ---- Shared vocabulary ----
  //
  // The words for what a thing is and where its request stands, in one place
  // so the home page and the requests page can never describe the same item
  // two different ways.
  //
  // accent names a theme class family (text-media-*, badge-media-* in
  // theme.css), never a colour. There are three media hues, not four: an
  // audiobook is a book, so it shares the book colour and is told apart by its
  // label and icon.
  var MEDIA_TYPES = {
    movie:     { label: 'Movie',     icon: 'movie',      accent: 'media-movie' },
    tv:        { label: 'TV Show',   icon: 'tv',         accent: 'media-tv' },
    book:      { label: 'eBook',     icon: 'menu_book',  accent: 'media-book' },
    audiobook: { label: 'Audiobook', icon: 'headphones', accent: 'media-book' }
  };
  function mediaType(type) { return MEDIA_TYPES[type] || MEDIA_TYPES.movie; }

  // Seerr's request/media states (as app/integrations/seerr.py names them) in
  // plain words. Deliberately not "Downloading" for processing: Seerr only
  // knows the request was handed to Sonarr or Radarr, not that a download is
  // under way. tone is a coarse grouping each page styles with its own theme
  // classes: ready, go (moving), wait (not started), dead (will not happen).
  var REQUEST_STATUSES = {
    available:           { label: 'Available',        tone: 'ready' },
    completed:           { label: 'Available',        tone: 'ready' },
    partially_available: { label: 'Partly Available', tone: 'go' },
    processing:          { label: 'Requested',        tone: 'go' },
    downloading:         { label: 'Requested',        tone: 'go' },
    approved:            { label: 'Approved',         tone: 'go' },
    pending:             { label: 'Requested',        tone: 'wait' },
    declined:            { label: 'Declined',         tone: 'dead' }
  };
  function requestStatus(status) {
    return REQUEST_STATUSES[String(status || '').toLowerCase()] || { label: 'Requested', tone: 'wait' };
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
    getJSON: getJSON,
    serviceStatus: serviceStatus,
    clearCache: clearCache,
    dragScroll: dragScroll,
    mediaType: mediaType,
    requestStatus: requestStatus
  };

  ready(function () {
    if (!document.getElementById('desktopSidebar')) return;   // a page without the shell
    arriveInit();
    wireChrome();
    wireScrollHint();
    wirePrefetch();

    var cached = cacheGet('status');
    if (cached && cached.state) paintStatus(cached.state);

    whenActive(function () {
      serviceStatus();
      if (user && typeof window.initNotifications === 'function') window.initNotifications();
    });
  });
})();
