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
 *     startDelay: 1200         // let the page render before measuring
 *   });
 *   tour.start();              // or call it yourself once the page is ready
 *
 * A step names its target by selector. `fallback` is used when the primary
 * element is absent or hidden, so a tour never breaks on an empty page.
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
            '<span id="tourIcon" class="material-symbols-outlined text-[20px] text-frosted-blue shrink-0">auto_stories</span>' +
            '<h3 id="tourTitle" class="flex-1 font-bold text-frosted-blue text-sm leading-snug"></h3>' +
            '<button id="tourSkip" type="button" class="text-[11px] text-frosted-blue/60 hover:text-frosted-blue shrink-0">Skip</button>' +
          '</div>' +
          '<p id="tourBody" class="mt-2 text-[13px] text-frosted-blue/85 leading-relaxed"></p>' +
          '<div class="mt-3 flex items-center gap-3">' +
            '<div id="tourDots" class="flex items-center gap-1.5"></div>' +
            '<div class="ml-auto flex items-center gap-2">' +
              '<button id="tourBack" type="button" class="px-2.5 py-1 rounded-lg text-[12px] text-frosted-blue/80 hover:text-frosted-blue hover:bg-frosted-blue/10">Back</button>' +
              '<button id="tourNext" type="button" class="px-3 py-1.5 rounded-lg bg-frosted-blue text-background-dark text-[12px] font-bold hover:bg-frosted-blue/90">Continue</button>' +
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
    var step = 0;
    var active = false;

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

    function place() {
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
        spot.style.top = (window.innerHeight / 2) + 'px';
        spot.style.left = (window.innerWidth / 2) + 'px';
        spot.style.width = '0px';
        spot.style.height = '0px';
        spot.style.opacity = '1';
        spot.classList.add('tour-spotlight-empty');
        arrow.style.display = 'none';
        bubble.style.top = Math.max(margin, (window.innerHeight - bh) / 2) + 'px';
        bubble.style.left = Math.max(margin, (window.innerWidth - bw) / 2) + 'px';
        return;
      }

      spot.classList.remove('tour-spotlight-empty');
      arrow.style.display = '';

      var pad = 8;
      var r = el.getBoundingClientRect();

      spot.style.top = (r.top - pad) + 'px';
      spot.style.left = (r.left - pad) + 'px';
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
      bubble.style.top = top + 'px';
      bubble.style.left = left + 'px';

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
        d.className = 'size-1.5 rounded-full ' + (i === step ? 'bg-frosted-blue' : 'bg-frosted-blue/30');
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
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Let the scroll settle before measuring, or the bubble lands where the
      // target used to be.
      setTimeout(place, 380);
    }

    function start() {
      if (active || !STEPS.length) return;
      active = true;
      step = 0;
      q('tourLayer').classList.remove('hidden');
      render();
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
    }

    function finish() {
      if (!active) return;
      active = false;
      q('tourLayer').classList.add('hidden');
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
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

    document.addEventListener('keydown', function (e) {
      if (!active) return;
      if (e.key === 'Escape') { finish(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
    }, true);   // capture: the reader turns pages on the arrow keys too

    var help = typeof opts.helpBtn === 'string' ? q(opts.helpBtn) : opts.helpBtn;
    if (help) help.addEventListener('click', start);

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
      setTimeout(api.maybeStart, opts.startDelay || 1200);
    }
    return api;
  }

  window.WebServarrTour = {
    init: function (opts) {
      ensureLayer();
      return create(opts || {});
    }
  };
})();
