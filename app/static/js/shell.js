/**
 * WebServarr — page shell (client side)
 *
 * The sidebar, header and the phone's top bar, tab bar and More sheet arrive
 * in the HTML already rendered for this user (see app/pages.py and
 * app/static/partials/). This module only decorates: menus, the More sheet,
 * logout, notifications, the status pill, the
 * scroll hint, and the shared helpers pages use to load content in a designed
 * order. It never constructs navigation.
 *
 * Exposes window.WS:
 *   WS.data / WS.user / WS.page   the #ws-data block, parsed by theme-loader.js
 *   WS.ready(fn)                  after DOMContentLoaded (or now)
 *   WS.whenActive(fn)             now, or when a page the browser prerendered is shown
 *   WS.poll(fn, ms, signal) -> stop()
 *                                 visibility-aware interval, starts when active;
 *                                 an optional AbortSignal removes its listeners
 *   WS.serviceStatus(opts)        deduplicated /api/integrations/service-status ({ fresh: true } skips the 5 s reuse)
 *   WS.statusLast()               the last status answer { list, unavailable, at, known, lastGood }, or the kept copy
 *   WS.statusModel(service)       one service's state: { k, kinds, since, usual } (status-panel.js)
 *   WS.statusSummary(list)        { state: ok|warn|err, down } for a list, or null
 *   WS.setHTML(el, html)          innerHTML only when the string changed
 *   WS.applyShell(parts)          bring the branded shell and <head> up to date (see below)
 *   WS.clearPageCache()           drop the router's hover-prefetched pages (sign-out, a save)
 *   WS.dropCache(prefix)          forget this user's swr copies whose key starts with prefix
 *   WS.arrive(key, write)         reveal sections top-down, as they are laid out
 *   WS.arriveReset()              start the order again for a newly mounted page (router.js)
 *   WS.swr(key, fetcher, render)  stale-while-revalidate page data
 *   WS.getJSON(url, { signal })   fetch JSON; rejects on non-2xx (err.status, err.body); signal optional
 *   WS.dragScroll(el, { signal }) mouse drag-to-scroll for a sideways row; signal optional
 *   WS.dragScroll.stop(el)        end that row's momentum glide (before scrolling it)
 *   WS.popOpen(el) / WS.popClose(el) / WS.popIsOpen(el)
 *                                 soft open and close of a .ws-pop panel (theme.css)
 *   WS.mediaType(type)            { label, icon, accent } for movie/tv/book/audiobook
 *   WS.requestStatus(status)      { label, tone } for a Seerr-style request status
 *   WS.closeChrome()              close the More sheet and every open header menu (before a page swap)
 *   WS.leaveTo(url)               a full navigation the page starts, through the router
 *   WS.router                     the soft navigation router, once router.js has loaded
 *                                 (a module, from the sidebar partial); null before and
 *                                 on a page without the shell
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
  // Forget this user's swr copies whose key starts with prefix, after a write
  // that makes them wrong (a news post saved, pinned or deleted), so no page
  // paints the old answer before it revalidates.
  function dropCache(prefix) {
    try {
      var head = ns + 'swr:' + prefix;
      var keys = [];
      for (var i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i));
      keys.forEach(function (k) { if (k && k.indexOf(head) === 0) sessionStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  // ---- Lifecycle helpers ----

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* A page the browser prerendered (Chrome does, from the address bar) is
     rendered before it is shown. Initial data loads may run then, but timers
     and side-effect requests wait until the page is on screen. */
  function whenActive(fn) {
    if (document.prerendering) document.addEventListener('prerenderingchange', fn, { once: true });
    else fn();
  }

  /* setInterval that starts only when the page is on screen, skips ticks in a
     background tab, refreshes when the tab comes back, and refreshes a page
     restored from the back/forward cache. Returns a stop() function.
     signal (optional): a soft-navigated page's AbortSignal. Its abort stops
     the interval and removes the listeners, so nothing outlives the page. */
  function poll(fn, ms, signal) {
    var timer = null;
    var stopped = false;
    var opts = signal ? { signal: signal } : undefined;
    function tick() { if (!document.hidden) fn(); }
    function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; }
    if (signal && signal.aborted) return stop;
    var prerendered = !!document.prerendering;
    whenActive(function () {
      if (stopped) return;
      // Prerendered a while ago: the data is stale the moment it is seen.
      // A poll started on a page already on screen (a soft-navigated page's
      // mount, long after this document loaded) has just read its own data.
      if (prerendered && performance.now() - initAt > 10000) fn();
      timer = setInterval(tick, ms);
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && timer) fn();
    }, opts);
    window.addEventListener('pageshow', function (e) { if (e.persisted && timer) fn(); }, opts);
    if (signal) signal.addEventListener('abort', stop, { once: true });
    return stop;
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

  // ---- Arrival: sections reveal top-down, in the order they are laid out ----
  //
  // Every fetch on a page fires at once; without this, sections appear in
  // whatever order the network answers. Sections are marked data-arrive="key"
  // in the HTML; a loader hands its first write to arrive(key, fn) and it runs
  // once every section above it has arrived (or once the gate lifts, so one
  // slow integration cannot hold the page). Later calls for a key that has
  // already arrived run at once with no animation - polls use the same path.
  var arr = { order: [], done: {}, queue: {}, gate: false, last: 0, painted: false };

  // Top-down means as laid out: top to bottom, then left to right along a
  // row. That is document order except where a breakpoint places a section
  // out of it (Home's News is written before Service Health for the phone's
  // single column, and from lg sits beside Recent Requests under it). A
  // section that is not displayed keeps its place in document order.
  function arriveOrder() {
    var els = Array.prototype.slice.call(document.querySelectorAll('[data-arrive]'));
    var box = els.map(function (el) {
      if (typeof el.getClientRects !== 'function' || !el.getClientRects().length) return null;
      var r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left) };
    });
    var laid = [];
    for (var i = 0; i < els.length; i++) if (box[i]) laid.push(i);
    var sorted = laid.slice().sort(function (a, b) {
      return (box[a].top - box[b].top) || (box[a].left - box[b].left) || (a - b);
    });
    var next = 0;
    return els.map(function (el, i) {
      return els[box[i] ? sorted[next++] : i].getAttribute('data-arrive');
    });
  }

  // Also runs for each page the router mounts (WS.arriveReset): the new
  // page's sections start their order afresh, and a timer from the page
  // before is ignored (each run is a generation of its own).
  function arriveInit() {
    var run = arr = { order: [], done: {}, queue: {}, gate: false, last: 0, painted: false };
    run.order = arriveOrder();
    // A section the server wrote in full (data-arrived, Home's news) was there
    // at the first paint: it has arrived, and nothing below waits for it.
    Array.prototype.forEach.call(document.querySelectorAll('[data-arrive][data-arrived]'), function (el) {
      run.done[el.getAttribute('data-arrive')] = true;
    });
    // Ordering is only worth a short wait. Answers that land within this
    // window reveal top-down; anything slower reveals as it comes, so one
    // slow integration never holds the page.
    setTimeout(function () { if (arr !== run) return; run.gate = true; arriveFlush(); }, 300);
    // Content that is in place before the first frame (a revisit painting
    // from cache) must not fade in - it was never absent.
    requestAnimationFrame(function () { requestAnimationFrame(function () { run.painted = true; }); });
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
     loader wants from swr's fetcher. opts.signal (optional): a soft-navigated
     page's AbortSignal; leaving the page aborts the request, and the promise
     rejects with the fetch's own AbortError, which a page treats as silent. */
  /* A full navigation the page starts itself (a session that ended, a
     member sent home): through the router when it is there, so
     ws:before-hard-nav runs first (a player saving its position). */
  function leaveTo(url) {
    var WS = window.WS || {};
    if (WS.router && typeof WS.router.hardNavigate === 'function') WS.router.hardNavigate(url);
    else window.location.href = url;
  }

  function getJSON(url, opts) {
    var signal = opts && opts.signal ? opts.signal : undefined;
    return fetch(url, signal ? { signal: signal } : undefined).then(function (r) {
      // A page can outlive its session; the first API answer says so.
      if (r.status === 401) { leaveTo('/login'); throw new Error('HTTP 401'); }
      if (!r.ok) {
        // The error carries what the server said (err.status, err.body: its
        // JSON, or null), for a page that tells one refusal from another.
        return r.json().then(function (b) { return b; }, function () { return null; }).then(function (body) {
          var err = new Error('HTTP ' + r.status);
          err.status = r.status;
          err.body = body;
          throw err;
        });
      }
      return r.json();
    });
  }

  /* The parts of the page the branding decides and a soft navigation never
     replaces, brought up to date: after a Settings save (settings/kit.js,
     from GET /api/admin/settings/shell) and on every swap (router.js, from
     the page it fetched). parts, each optional:
       nav_html        the sidebar's nav (server-rendered links)
       brand_html      the logo and name in the sidebar
       tabs_html       the phone's tab bar (#wsTabList)
       more_html       the More sheet's pages (#wsMoreNav)
       bar_title       the phone top bar's words (#wsBarTitle)
       theme_color     the browser's colour (meta theme-color)
       touch_icon      the home-screen icon (link apple-touch-icon)
       branding        the payload: WS.data, and the colours, gauge rings and
                       font on <html> (theme-loader's WSTheme.apply)
       theme_css       #ws-theme's rule
       font_href       #ws-font's stylesheet
       custom_css      the operator's CSS, last in <head> ('' removes it)
       favicon         the tab icon
       title           document.title
       nav_icons       false hides the sidebar's page icons (<html
                       data-nav-icons-off>, theme.css); the router copies
                       <html>'s flags itself, so only Settings sends it
     Markup is the server's own (escaped there), written only when it
     changed; CSS goes in as text. */
  function applyShell(parts) {
    if (!parts) return;
    if (typeof parts.nav_html === 'string') setHTML(document.getElementById('desktopNav'), parts.nav_html);
    if (typeof parts.brand_html === 'string') {
      document.querySelectorAll('[data-ws-brand]').forEach(function (n) { setHTML(n, parts.brand_html); });
    }
    if (typeof parts.tabs_html === 'string') setHTML(document.getElementById('wsTabList'), parts.tabs_html);
    if (typeof parts.more_html === 'string') setHTML(document.getElementById('wsMoreNav'), parts.more_html);
    if (typeof parts.bar_title === 'string') {
      var barTitle = document.getElementById('wsBarTitle');
      if (barTitle && barTitle.textContent !== parts.bar_title) barTitle.textContent = parts.bar_title;
    }
    if (typeof parts.theme_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(parts.theme_color)) {
      var tc = document.querySelector('meta[name="theme-color"]');
      if (tc && tc.getAttribute('content') !== parts.theme_color) tc.setAttribute('content', parts.theme_color);
    }
    if (typeof parts.touch_icon === 'string' && parts.touch_icon) {
      var ti = document.querySelector('link[rel="apple-touch-icon"]');
      if (ti && ti.getAttribute('href') !== parts.touch_icon) ti.setAttribute('href', parts.touch_icon);
    }
    if (parts.branding && typeof parts.branding === 'object') {
      if (window.WS_DATA) window.WS_DATA.branding = parts.branding;
      if (window.WS && window.WS.data && window.WS.data !== window.WS_DATA) window.WS.data.branding = parts.branding;
      if (window.WSTheme) window.WSTheme.apply(parts.branding);
    }
    if (typeof parts.theme_css === 'string') {
      var theme = document.getElementById('ws-theme');
      if (theme && theme.textContent !== parts.theme_css) theme.textContent = parts.theme_css;
    }
    if (typeof parts.font_href === 'string') {
      var font = document.getElementById('ws-font');
      if (font && font.getAttribute('href') !== parts.font_href) font.setAttribute('href', parts.font_href);
    }
    if (typeof parts.custom_css === 'string') {
      var css = document.getElementById('webservarr-custom-css');
      if (parts.custom_css) {
        if (!css) {
          css = document.createElement('style');
          css.id = 'webservarr-custom-css';
        }
        if (css.textContent !== parts.custom_css) css.textContent = parts.custom_css;
        // Last in <head>, after every stylesheet, as the server writes it.
        if (css !== document.head.lastElementChild) document.head.appendChild(css);
      } else if (css) {
        css.remove();
      }
    }
    if (typeof parts.favicon === 'string' && parts.favicon) {
      var icon = document.querySelector('link[rel="icon"]');
      if (icon && icon.getAttribute('href') !== parts.favicon) icon.setAttribute('href', parts.favicon);
    }
    if (typeof parts.title === 'string' && parts.title && document.title !== parts.title) document.title = parts.title;
    if (typeof parts.nav_icons === 'boolean') {
      var root = document.documentElement;
      if (parts.nav_icons) root.removeAttribute('data-nav-icons-off');
      else if (!root.hasAttribute('data-nav-icons-off')) root.setAttribute('data-nav-icons-off', '');
    }
  }

  // A page the router prefetched on hover was fetched before whatever made it
  // stale (a save, a sign-out); drop it so the next click fetches again.
  function clearPageCache() {
    if (window.WS && WS.router && WS.router.clearPrefetch) WS.router.clearPrefetch();
  }

  // ---- Status pill (desktop) and status chip (phone top bar) ----
  //
  // Painted from the last known state at once, revalidated in the background.
  // Unknown (first ever visit, or no Uptime Kuma set up) reserves the space
  // and says nothing. Uptime Kuma set up but not answering is "off": a grey
  // "Status unavailable", never the last state it saw. The script owns the
  // state and the words only; every colour, and the one ring on a turn for
  // the worse, is theme.css keyed on data-state (status tokens, not palette
  // classes). The panel that opens from either (status-panel.js) reads the
  // same model through WS.statusModel and WS.statusLast.
  var PILL_LABEL = {
    ok: 'All Systems Online',
    warn: 'Degraded Performance',
    err: 'System Issues Detected',
    off: 'Status Unavailable'
  };
  var CHIP_WORD = { ok: 'Online', warn: 'Slow', off: 'Unknown' };
  var SUMMARY_TITLE = { ok: 'Everything is running', off: 'Status unavailable right now' };

  function median(nums) {
    var a = nums.slice().sort(function (x, y) { return x - y; });
    return a.length ? a[Math.floor(a.length / 2)] : 0;
  }

  // What one check was. "Slow" is ours, not Uptime Kuma's: an "up" check
  // whose reply took over a second and over four times the monitor's usual
  // (the median of its last 50). Kuma's "pending" is "trouble".
  function checkKind(beat, usual) {
    var st = beat && beat.status;
    if (st === 'down') return 'down';
    if (st === 'degraded') return 'trouble';
    if (st === 'maintenance') return 'maint';
    var ping = beat ? beat.ping : null;
    if (typeof ping === 'number' && ping > 1000 && ping > usual * 4) return 'slow';
    return 'up';
  }

  // One service as the pill, the chip and the panel see it: k (up, slow,
  // trouble, down, maint), since (ms, when the current run began, or null
  // when it fills the whole window), each check's kind, and the usual reply.
  function statusModel(service) {
    var beats = Array.isArray(service && service.beats) ? service.beats : [];
    var pings = [];
    beats.forEach(function (b) { if (typeof b.ping === 'number') pings.push(b.ping); });
    var usual = median(pings);
    var kinds = beats.map(function (b) { return checkKind(b, usual); });
    var k = kinds.length ? kinds[kinds.length - 1] : checkKind({ status: service && service.status }, usual);
    var since = null;
    for (var i = kinds.length - 1; i >= 0 && kinds[i] === k; i--) {
      since = i > 0 ? Date.parse(beats[i].time) || null : null;
    }
    return { service: service, k: k, kinds: kinds, usual: usual, since: since };
  }

  // The overall state of a list of services: ok, warn (something slow or
  // having trouble), err (something down); null for no services at all.
  function summarise(services) {
    if (!Array.isArray(services) || services.length === 0) return null;
    var down = 0, warn = false;
    services.forEach(function (s) {
      var k = statusModel(s).k;
      if (k === 'down') down += 1;
      else if (k === 'slow' || k === 'trouble') warn = true;
    });
    return { state: down ? 'err' : (warn ? 'warn' : 'ok'), down: down };
  }

  function paintStatus(state, down) {
    var label = PILL_LABEL[state];
    var pill = document.getElementById('systemStatus');
    if (pill) {
      if (!label) pill.setAttribute('data-state', 'unknown');
      else if (pill.getAttribute('data-state') !== state) {
        pill.setAttribute('data-state', state);
        var text = pill.querySelector('[data-status-text]');
        if (text) text.textContent = label;
      }
    }
    var chip = document.getElementById('wsStatusChip');
    if (chip) {
      var word = state === 'err' ? (down || 1) + ' down' : CHIP_WORD[state];
      chip.setAttribute('data-state', label ? state : 'unknown');
      var w = chip.querySelector('[data-status-word]');
      if (w && word && w.textContent !== word) w.textContent = word;
      chip.setAttribute('aria-label', 'Service status: ' + (label
        ? (state === 'err' ? word : (SUMMARY_TITLE[state] || label.toLowerCase()))
        : 'not known yet'));
    }
  }

  var statusPromise = null;
  var statusAt = 0;   // performance.now() when the last answer landed; 0 while one is on its way
  // The last answer: { list, unavailable, at (Date.now() it landed) }, or null.
  var statusLast = null;

  /* One request shared by the pill, the chip, the panel and any page that
     lists services (the dashboard tiles), cached for the next visit. A
     request on its way is shared, and its answer is reused for 5 s after it
     lands ({ fresh: true }, the panel's "Try again", skips the reuse). That is
     timed by the clock, not a timer: the request outlives the page that asked
     (it is the pill's too), and so must nothing it leaves behind. The
     monotonic clock, so a wall clock set back (a resync on wake) cannot
     stretch it. Resolves to the list ([] when there is none, or no answer);
     ws:status on document carries each answer to the panel. */
  function serviceStatus(opts) {
    var fresh = !!(opts && opts.fresh === true);
    if (statusPromise && (!statusAt || (!fresh && performance.now() - statusAt < 5000))) return statusPromise;
    statusAt = 0;
    statusPromise = fetch('/api/integrations/service-status')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (list) {
        var unavailable = !Array.isArray(list);
        var kept = cacheGet('status') || {};
        if (unavailable) {
          // Keep the last good names and time (the panel lists them), never its state.
          paintStatus('off');
          cacheSet('status', { state: 'off', list: kept.list || [], t: kept.t || 0 });
          list = [];
        } else {
          var sum = summarise(list);
          paintStatus(sum ? sum.state : null, sum ? sum.down : 0);
          if (sum) cacheSet('status', { state: sum.state, down: sum.down, list: list, t: Date.now() });
        }
        statusLast = { list: list, unavailable: unavailable, at: Date.now() };
        if (unavailable) { statusLast.known = kept.list || []; statusLast.lastGood = kept.t || 0; }
        statusAt = performance.now();
        document.dispatchEvent(new CustomEvent('ws:status', { detail: statusLast }));
        return list;
      });
    return statusPromise;
  }

  // The last answer, or the copy kept from an earlier visit (cached: true)
  // before the first answer lands. While Uptime Kuma is not answering, list
  // is empty and known / lastGood are the names and time of the last good one.
  function getStatusLast() {
    if (statusLast) return statusLast;
    var c = cacheGet('status');
    if (!c || !c.state) return null;
    if (c.state === 'off') return { list: [], unavailable: true, at: 0, cached: true, known: c.list || [], lastGood: c.t || 0 };
    return { list: c.list || [], unavailable: false, at: c.t || 0, cached: true };
  }

  // ---- Soft open and close of a .ws-pop panel (the account menus, the bell) ----
  //
  // theme.css writes the panel's closed state on .ws-pop itself and its open
  // state on .is-open; .hidden (display: none) takes it out of the page. Open
  // is two steps: take .hidden off and reflow, so the browser has drawn the
  // closed state, then add .is-open, and the transition runs from the closed
  // state on every open, not only the first. (Left to @starting-style, a
  // browser that keeps an element's last style across a display transition
  // animated the first open only.) Close drops .is-open and adds .hidden in
  // the same frame: the display transition holds the panel until the fade has
  // run, and pointer-events is off from the first closing frame. Closing a
  // closed panel changes nothing, so the document-wide click handlers that
  // call popClose on every click start no transition.
  function popOpen(el) {
    if (!el || popIsOpen(el)) return;
    el.classList.remove('hidden');
    void el.offsetWidth;   // reflow: the closed state is drawn before it changes
    el.classList.add('is-open');
  }
  function popClose(el) {
    if (!el) return;
    el.classList.remove('is-open');
    el.classList.add('hidden');
  }
  function popIsOpen(el) {
    return !!el && el.classList.contains('is-open');
  }

  // ---- Chrome wiring: the More sheet, menus, logout ----

  // Set by wireSheet: closes the More sheet at once if it is open.
  var sheetCloser = null;

  /* Before the router swaps a page: a full load used to close these by
     itself. The header menus (and the bell, notifications.js) each close on
     a ws:menu-open for any menu but their own; detail null is no menu. */
  function closeChrome() {
    if (sheetCloser) sheetCloser();
    document.dispatchEvent(new CustomEvent('ws:menu-open', { detail: null }));
  }

  // ---- The phone's More sheet ----
  //
  // #wsMoreSheet (the sidebar partial) is a native modal <dialog>, opened by
  // the tab bar's More button (#wsMoreBtn, found on each click: a settings
  // save or a changed tab set writes new tab nodes). While it is open the
  // page behind is inert and its scroll is held (html.ws-sheet-open), and
  // Tab stays inside it. The browser's close request (Escape, Android's Back
  // where the browser has close watchers) arrives as the dialog's cancel; it
  // closes it, as do Escape itself, a tap on the dim or on Close, a downward
  // swipe, a row chosen, a page swap (closeChrome) and the screen growing to
  // the desktop layout. Elsewhere Back navigates, and the swap closes it.
  // Focus goes to its first row on open and back to More when it closes,
  // except for a row chosen: the new page takes focus. It slides up over a
  // dim (theme.css .ws-sheet); with reduced motion it appears and goes.
  var SHEET_CLOSE_MS = 160;        // the 140ms slide away (theme.css .ws-sheet.is-closing), and a frame
  var SWIPE_CLOSE_PX = 80;         // a swipe down this far closes it...
  var SWIPE_FLING = 0.5;           // ...or one this fast at the release (px per ms)
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function wireSheet() {
    var sheet = document.getElementById('wsMoreSheet');
    if (!sheet) return;
    var panel = sheet.querySelector('[data-sheet-panel]') || sheet;
    var root = document.documentElement;
    var hideTimer = null;

    function moreBtn() { return document.getElementById('wsMoreBtn'); }
    function setExpanded(on) {
      var b = moreBtn();
      if (b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    function focusables() {
      return Array.prototype.filter.call(sheet.querySelectorAll(FOCUSABLE), function (el) {
        return !el.closest('[hidden], .hidden');
      });
    }
    function closing() { return sheet.classList.contains('is-closing'); }

    function finish(restore) {
      clearTimeout(hideTimer);
      hideTimer = null;
      sheet.classList.remove('is-open', 'is-closing');
      panel.style.transform = '';
      panel.style.transition = '';
      if (sheet.open) {
        if (typeof sheet.close === 'function') sheet.close();
        else sheet.removeAttribute('open');
      }
      root.classList.remove('ws-sheet-open');
      var b = moreBtn();
      if (restore && b) b.focus({ preventScroll: true });
    }

    function open() {
      if (sheet.open && !closing()) return;
      finish(false);
      // The bell's panel and any header menu close.
      document.dispatchEvent(new CustomEvent('ws:menu-open', { detail: sheet }));
      if (typeof sheet.showModal === 'function') sheet.showModal();
      else sheet.setAttribute('open', '');
      root.classList.add('ws-sheet-open');
      void panel.offsetHeight;   // reflow: the closed state is drawn before it changes
      sheet.classList.add('is-open');
      setExpanded(true);
      var first = focusables().filter(function (el) { return el.classList.contains('ws-sheet-row'); })[0] ||
        focusables()[0];
      if (first) first.focus({ preventScroll: true });
    }

    // restore: focus back on More. now: no slide (a page swap, a resize).
    function close(restore, now) {
      if (!sheet.open || (closing() && !now)) return;
      sheet.classList.remove('is-open');
      panel.style.transform = '';
      panel.style.transition = '';
      setExpanded(false);
      if (now || reducedMotion()) { finish(restore); return; }
      sheet.classList.add('is-closing');
      hideTimer = setTimeout(function () { finish(restore); }, SHEET_CLOSE_MS);
    }
    sheetCloser = function () { close(false, true); };

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest || !t.closest('#wsMoreBtn')) return;
      if (sheet.open && !closing()) close(true);
      else open();
    });

    sheet.addEventListener('cancel', function (e) {
      e.preventDefault();
      close(true);
    });
    // A dialog closed some other way (the browser's own) leaves nothing set.
    sheet.addEventListener('close', function () {
      if (sheet.classList.contains('is-open') || closing()) finish(false);
      root.classList.remove('ws-sheet-open');
      setExpanded(false);
    });
    sheet.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-sheet-close]')) { close(true); return; }
      // A row chosen: the router (or the browser, for a #fragment here) takes it.
      if (t.closest('a[href]')) close(false);
    });
    sheet.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0];
      var last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // Swipe down. Touch events, not pointer events: the browser cancels a
    // pointer the moment it starts to pan, and the sheet must follow the
    // finger. Only from the top of the sheet's own scroll, and only downward:
    // an upward move is a scroll.
    var drag = null;
    panel.addEventListener('touchstart', function (e) {
      drag = null;
      if (!sheet.open || closing() || e.touches.length !== 1 || panel.scrollTop > 0) return;
      drag = { y: e.touches[0].clientY, dy: 0, v: 0, t: performance.now(), moved: false };
    }, { passive: true });
    panel.addEventListener('touchmove', function (e) {
      if (!drag || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - drag.y;
      if (!drag.moved && dy <= 0) { drag = null; return; }
      drag.moved = true;
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, dy);
      var now = performance.now();
      drag.v = (dy - drag.dy) / Math.max(1, now - drag.t);
      drag.t = now;
      drag.dy = dy;
      panel.style.transition = 'none';
      panel.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: false });
    function release(cancelled) {
      var d = drag;
      drag = null;
      if (!d || !d.moved) return;
      if (!cancelled && (d.dy > SWIPE_CLOSE_PX || d.v > SWIPE_FLING)) { close(true); return; }
      panel.style.transition = '';
      panel.style.transform = '';
    }
    panel.addEventListener('touchend', function () { release(false); });
    panel.addEventListener('touchcancel', function () { release(true); });

    // The desktop layout has no More: a sheet open as the screen grows goes.
    if (window.matchMedia) {
      var wide = window.matchMedia('(min-width: 1024px)');
      var onWide = function (e) { if (e.matches) close(false, true); };
      if (wide.addEventListener) wide.addEventListener('change', onWide);
      else if (wide.addListener) wide.addListener(onWide);
    }
  }

  function wireChrome() {
    // Header menus are mutually exclusive. Each menu's button stops its click
    // from reaching document, so another menu's outside-click close never sees
    // it; instead a menu that opens announces itself with a ws:menu-open event
    // (detail: the menu element) and every other menu closes. notifications.js
    // does the same for the bell dropdown. The button's aria-expanded follows
    // the menu, and Escape closes it, focus back on the button when it was
    // in the menu (or on the button, or nowhere).
    [['userMenuBtn', 'userMenuDropdown']].forEach(function (pair) {
      var btn = document.getElementById(pair[0]);
      var menu = document.getElementById(pair[1]);
      if (!btn || !menu) return;
      function expanded(on) { btn.setAttribute('aria-expanded', on ? 'true' : 'false'); }
      expanded(popIsOpen(menu));
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (popIsOpen(menu)) { popClose(menu); expanded(false); return; }
        popOpen(menu);
        expanded(true);
        document.dispatchEvent(new CustomEvent('ws:menu-open', { detail: menu }));
      });
      document.addEventListener('click', function () { popClose(menu); expanded(false); });
      document.addEventListener('ws:menu-open', function (e) {
        if (e.detail !== menu) { popClose(menu); expanded(false); }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || e.isComposing || !popIsOpen(menu)) return;
        var a = document.activeElement;
        var inside = !a || a === document.body || a === btn || menu.contains(a);
        popClose(menu);
        expanded(false);
        if (inside) btn.focus();
      });
    });

    // Sign-out goes through the router when it is there, so ws:before-hard-nav
    // handlers (a player saving its position) run first.
    document.querySelectorAll('#logoutBtn, [data-logout]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        clearCache();
        clearPageCache();
        if (window.WS && WS.router && WS.router.hardNavigate) WS.router.hardNavigate('/auth/logout');
        else window.location.href = '/auth/logout';
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
  // handlers. opts.signal (optional): a soft-navigated page's AbortSignal;
  // the row's listeners end with the visit, as the page's own do.
  var DRAG_THRESHOLD = 5;          // px before a press becomes a drag
  var GLIDE_DECAY = 0.92;          // velocity kept per 16 ms frame
  var GLIDE_MIN = 0.02;            // px/ms below which the glide stops
  var GLIDE_MAX = 3;               // px/ms cap, so a wild flick stays sane

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function dragScroll(el, opts) {
    if (!el || el._wsDragScroll) return;
    el._wsDragScroll = true;
    var signal = opts && opts.signal ? opts.signal : undefined;
    // The listener options, with the visit's signal when one was given.
    function on(extra) {
      var o = {};
      for (var k in extra) o[k] = extra[k];
      if (signal) o.signal = signal;
      return o;
    }

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
    }, on({}));

    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse') return;
      endDrag(e, false);                            // finish any gesture left open
      stopGlide();                                  // a press catches a gliding row
      if (e.button !== 0 || !scrollable()) return;
      press = { id: e.pointerId, x: e.clientX, left: el.scrollLeft };
      velocity = 0;
      lastX = e.clientX;
      lastT = performance.now();
    }, on({}));

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
    }, on({}));

    el.addEventListener('pointerup', function (e) { endDrag(e, true); }, on({}));
    el.addEventListener('pointercancel', function (e) { endDrag(e, false); }, on({}));
    // Capture can be taken away without a pointerup ever reaching the row. On a
    // normal release this fires after pointerup has already finished the drag,
    // and does nothing.
    el.addEventListener('lostpointercapture', function (e) { endDrag(e, false); }, on({}));

    // Capture phase on the row runs before any card's own click handler.
    el.addEventListener('click', function (e) {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, on({ capture: true }));

    // No ghost image of a poster (or a link) following the cursor.
    el.addEventListener('dragstart', function (e) { e.preventDefault(); }, on({}));

    // The wheel (or trackpad) takes over from a glide immediately.
    el.addEventListener('wheel', stopGlide, on({ passive: true }));

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
    arriveReset: arriveInit,
    swr: swr,
    getJSON: getJSON,
    serviceStatus: serviceStatus,
    statusLast: getStatusLast,
    statusModel: statusModel,
    statusSummary: summarise,
    clearCache: clearCache,
    dropCache: dropCache,
    clearPageCache: clearPageCache,
    applyShell: applyShell,
    dragScroll: dragScroll,
    popOpen: popOpen,
    popClose: popClose,
    popIsOpen: popIsOpen,
    mediaType: mediaType,
    requestStatus: requestStatus,
    closeChrome: closeChrome,
    leaveTo: leaveTo,
    router: null
  };

  ready(function () {
    if (!document.getElementById('desktopSidebar')) return;   // a page without the shell
    arriveInit();
    wireChrome();
    wireSheet();
    wireScrollHint();

    var cached = cacheGet('status');
    if (cached && cached.state) paintStatus(cached.state, cached.down);

    whenActive(function () {
      serviceStatus();
      if (user && typeof window.initNotifications === 'function') window.initNotifications();
    });
  });
})();
