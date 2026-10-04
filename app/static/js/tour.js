/**
 * WebServarr — Guided tour (coach marks)
 *
 * Spotlights each part of a page in turn: a fog dims everything, a hole is cut
 * around the element being described, and a bubble points at it.
 *
 * Shared by every page that wants a tour. A page supplies its own steps and a
 * storage key; the markup, positioning, keyboard handling and "seen" bookkeeping
 * live here, so a fix lands everywhere at once.
 *
 *   var tour = WebServarrTour.init({
 *     seenKey: 'webservarr_reader_guide_seen',
 *     steps: [ { target: '#foo', icon: 'search', title: '…', body: '…' } ],
 *     helpBtn: 'helpBtn',      // optional: re-runs the tour on click
 *     autoStart: true,         // first visit only
 *     startDelay: 1200,        // let the page render before measuring
 *     signal: ctx.signal       // the page's visit: the tour ends with it
 *   });
 *   tour.start();              // or call it yourself once the page is ready
 *
 * A step names its target by selector. `fallback` is used when the primary
 * element is absent or hidden, so a tour never breaks on an empty page.
 *
 * Soft navigation: this is a page helper (data-ws-page-script), loaded once
 * per document; init() is called from the page module's mount with the
 * visit's signal. When the signal aborts (the page is left) the tour is torn
 * down whole: its listeners go, its pending timers are cleared, a running
 * tour ends without being recorded as seen, and the layer leaves <body>.
 *
 * DEVELOPMENT: set localStorage.webservarr_tour_always = '1' (or append
 * ?tour=1) and every tour runs on each visit and never records itself as seen.
 */
(function () {
  'use strict';

  function devAlways() {
    try {
      if (localStorage.getItem('webservarr_tour_always') === '1') return true;
    } catch (e) { /* private mode */ }
    return /[?&]tour=1\b/.test(location.search);
  }

  /* A person who asked for less motion gets a jump, not a glide, to each step. */
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* One layer serves every tour on the page; it is built once, on first init. */
  function ensureLayer() {
    var existing = document.getElementById('tourLayer');
    if (existing) return existing;

    var layer = document.createElement('div');
    layer.id = 'tourLayer';
    layer.className = 'hidden';
    layer.innerHTML =
      '<div id="tourSpotlight" class="tour-spotlight"></div>' +
      '<div id="tourBubble" class="tour-bubble">' +
        '<div id="tourArrow" class="tour-arrow" data-side="top"></div>' +
        '<div class="p-4">' +
          '<div class="flex items-start gap-2">' +
            '<span id="tourIcon" class="material-symbols-outlined text-[20px] text-bright shrink-0">auto_stories</span>' +
            '<h3 id="tourTitle" class="flex-1 font-bold text-bright text-sm leading-snug"></h3>' +
            '<button id="tourSkip" type="button" class="text-[11px] text-bright/80 hover:text-bright shrink-0">Skip</button>' +
          '</div>' +
          '<p id="tourBody" class="mt-2 text-[13px] text-bright/90 leading-relaxed"></p>' +
          '<div class="mt-3 flex items-center gap-3">' +
            '<div id="tourDots" class="flex items-center gap-1.5"></div>' +
            '<div class="ml-auto flex items-center gap-2">' +
              '<button id="tourBack" type="button" class="px-2.5 py-1 rounded-lg text-[12px] text-bright/80 hover:text-bright hover:bg-bright/10">Back</button>' +
              '<button id="tourNext" type="button" class="px-3 py-1.5 rounded-lg bg-bright text-primary text-[12px] font-bold hover:bg-bright/90">Continue</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(layer);
    return layer;
  }

  function q(id) { return document.getElementById(id); }

  function create(opts) {
    var STEPS = opts.steps || [];
    var SEEN_KEY = opts.seenKey;
    var signal = opts.signal || null;
    var step = 0;
    var active = false;
    var placeTimer = 0;      // render's wait for the scroll to settle
    var startTimer = 0;      // autoStart's delay
    // False until this run's first placement: the layer stays invisible and
    // untransitioned until then, so the bubble never shows at a stale spot
    // and slides from it.
    var placed = false;

    /* Measured rather than asked, because offsetParent is null for any
       position:fixed element - which silently rejected the reader's page-turn
       zones and its settings panel and fell through to their fallbacks. A real
       box with real dimensions is the thing a spotlight actually needs. */
    function visible(el) {
      if (!el) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function targetFor(s) {
      var el = s.target ? document.querySelector(s.target) : null;
      if (visible(el)) return el;
      var fb = s.fallback ? document.querySelector(s.fallback) : null;
      return visible(fb) ? fb : null;
    }

    /* Positions are transforms, never top/left. Moving a fixed box by its
       offsets is a layout shift on every frame of the glide between steps
       (the spotlight is as big as the screen, so the page scored 0.6);
       a transform moves it without laying anything out. */
    function moveTo(node, x, y) {
      node.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
    }

    function place() {
      position();
      if (active && !placed) reveal();
    }

    // The first placement of a run lands with no transition, then shows.
    function reveal() {
      placed = true;
      var layer = q('tourLayer');
      void layer.offsetWidth;   // commit the first position before transitions return
      layer.classList.remove('tour-placing');
      layer.style.visibility = '';
    }

    function position() {
      var s = STEPS[step];
      if (!s) return;
      var el = targetFor(s);
      var spot = q('tourSpotlight');
      var bubble = q('tourBubble');
      var arrow = q('tourArrow');

      var bw = bubble.offsetWidth || 336;
      var bh = bubble.offsetHeight || 160;
      var gap = 16;
      var margin = 12;

      /* A step with nothing to point at - an opening welcome, or a target that
         is not on the page this time - dims the whole screen and sits the
         bubble dead centre. The spotlight stays at full opacity because the fog
         IS its box-shadow; collapsing it to nothing keeps the dimming and cuts
         no hole. The ring and the arrow are hidden, since neither has anything
         to mark. */
      if (!el) {
        moveTo(spot, window.innerWidth / 2, window.innerHeight / 2);
        spot.style.width = '0px';
        spot.style.height = '0px';
        spot.style.opacity = '1';
        spot.classList.add('tour-spotlight-empty');
        arrow.style.display = 'none';
        moveTo(bubble, Math.max(margin, (window.innerWidth - bw) / 2), Math.max(margin, (window.innerHeight - bh) / 2));
        return;
      }

      spot.classList.remove('tour-spotlight-empty');
      arrow.style.display = '';

      var pad = 8;
      var r = el.getBoundingClientRect();

      moveTo(spot, r.left - pad, r.top - pad);
      spot.style.width = (r.width + pad * 2) + 'px';
      spot.style.height = (r.height + pad * 2) + 'px';
      spot.style.opacity = '1';

      var side, top, left;

      if (r.bottom + gap + bh < window.innerHeight - margin) {
        side = 'bottom';                       // bubble sits below, arrow on top
        top = r.bottom + gap;
        left = r.left + r.width / 2 - bw / 2;
      } else if (r.top - gap - bh > margin) {
        side = 'top';
        top = r.top - gap - bh;
        left = r.left + r.width / 2 - bw / 2;
      } else if (r.right + gap + bw < window.innerWidth - margin) {
        side = 'right';
        top = r.top + r.height / 2 - bh / 2;
        left = r.right + gap;
      } else {
        side = 'left';
        top = r.top + r.height / 2 - bh / 2;
        left = Math.max(margin, r.left - gap - bw);
      }

      left = Math.max(margin, Math.min(left, window.innerWidth - bw - margin));
      top = Math.max(margin, Math.min(top, window.innerHeight - bh - margin));
      moveTo(bubble, left, top);

      arrow.setAttribute('data-side', side);
      arrow.style.left = arrow.style.top = '';
      if (side === 'top' || side === 'bottom') {
        var ax = r.left + r.width / 2 - left - 7;
        arrow.style.left = Math.max(14, Math.min(ax, bw - 28)) + 'px';
      } else {
        var ay = r.top + r.height / 2 - top - 7;
        arrow.style.top = Math.max(14, Math.min(ay, bh - 28)) + 'px';
      }
    }

    function render() {
      var s = STEPS[step];
      q('tourIcon').textContent = s.icon;
      q('tourTitle').textContent = s.title;
      // Plain text by design. Emphasis inside a step body fights the bold
      // title above it and makes a short blurb look busy.
      q('tourBody').textContent = s.body;

      var dots = q('tourDots');
      dots.innerHTML = '';
      STEPS.forEach(function (_, i) {
        var d = document.createElement('span');
        d.className = 'size-1.5 rounded-full ' + (i === step ? 'bg-bright' : 'bg-bright/30');
        dots.appendChild(d);
      });

      q('tourBack').style.visibility = step === 0 ? 'hidden' : 'visible';
      q('tourNext').textContent = step === STEPS.length - 1 ? 'Got it' : 'Continue';

      // A step may need the page put into a particular state first - a panel
      // opened, a menu expanded - or its target does not exist to point at.
      if (typeof s.before === 'function') {
        try { s.before(); } catch (e) { /* never let a step break the tour */ }
      }

      var el = targetFor(s);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      // Let the scroll settle before measuring, or the bubble lands where the
      // target used to be.
      clearTimeout(placeTimer);
      placeTimer = setTimeout(place, 380);
    }

    // The full-screen audiobook player covers the page (<html
    // data-player-full>, js/player/ui.js): a tour never starts under it nor
    // takes its keys. One asked for meanwhile starts once the player has
    // closed.
    var playerWait = null;
    function playerOpen() {
      return document.documentElement.hasAttribute('data-player-full');
    }
    function stopWaiting() {
      if (playerWait) { playerWait.disconnect(); playerWait = null; }
    }
    function afterPlayer() {
      if (playerWait || typeof window.MutationObserver !== 'function') return;
      playerWait = new window.MutationObserver(function () {
        if (playerOpen()) return;
        stopWaiting();
        start();
      });
      playerWait.observe(document.documentElement, { attributes: true, attributeFilter: ['data-player-full'] });
    }

    function start() {
      if (active || !STEPS.length || (signal && signal.aborted)) return;
      if (playerOpen()) { afterPlayer(); return; }
      active = true;
      step = 0;
      placed = false;
      var layer = q('tourLayer');
      layer.classList.add('tour-placing');
      layer.style.visibility = 'hidden';
      layer.classList.remove('hidden');
      render();
      window.addEventListener('resize', place, signal ? { signal: signal } : undefined);
      window.addEventListener('scroll', place, signal ? { capture: true, signal: signal } : true);
    }

    // Stops a run: the layer hides, the listeners and the pending placement go.
    function stop() {
      active = false;
      clearTimeout(placeTimer);
      var layer = q('tourLayer');
      if (layer) layer.classList.add('hidden');
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    }

    function finish() {
      if (!active) return;
      stop();
      if (typeof opts.onFinish === 'function') {
        try { opts.onFinish(); } catch (e) { /* cleanup is best effort */ }
      }
      if (!devAlways() && SEEN_KEY) {
        try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode */ }
      }
    }

    function next() {
      if (step < STEPS.length - 1) { step++; render(); } else { finish(); }
    }
    function back() {
      if (step > 0) { step--; render(); }
    }

    function seen() {
      try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
    }

    /* Buttons are shared across tours on a page, so each tour claims them when
       it starts rather than binding once at init. In practice a page has one
       tour; this keeps that from being an assumption. */
    q('tourNext').onclick = next;
    q('tourBack').onclick = back;
    q('tourSkip').onclick = finish;

    // capture: the reader turns pages on the arrow keys too
    document.addEventListener('keydown', function (e) {
      if (!active || playerOpen()) return;
      if (e.key === 'Escape') { finish(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
    }, signal ? { capture: true, signal: signal } : true);

    var help = typeof opts.helpBtn === 'string' ? q(opts.helpBtn) : opts.helpBtn;
    if (help) help.addEventListener('click', start, signal ? { signal: signal } : undefined);

    var api = {
      start: start,
      finish: finish,
      isActive: function () { return active; },
      hasBeenSeen: seen,
      /** Runs the tour only if this visitor has not already had it. */
      maybeStart: function () {
        if (!seen() || devAlways()) start();
      }
    };

    if (opts.autoStart) {
      startTimer = setTimeout(api.maybeStart, opts.startDelay || 1200);
    }

    // The page is left: end the run (not recorded as seen, it was not
    // finished), cancel the timers, drop the buttons' handlers and the layer.
    if (signal) {
      signal.addEventListener('abort', function () {
        clearTimeout(startTimer);
        stopWaiting();
        stop();
        var layer = q('tourLayer');
        if (layer) {
          if (q('tourNext').onclick === next) {
            q('tourNext').onclick = null;
            q('tourBack').onclick = null;
            q('tourSkip').onclick = null;
          }
          layer.remove();
        }
      }, { once: true });
    }
    return api;
  }

  window.WebServarrTour = {
    init: function (opts) {
      opts = opts || {};
      if (opts.signal && opts.signal.aborted) {
        return { start: function () {}, finish: function () {}, isActive: function () { return false; },
                 hasBeenSeen: function () { return true; }, maybeStart: function () {} };
      }
      ensureLayer();
      return create(opts);
    }
  };
})();
