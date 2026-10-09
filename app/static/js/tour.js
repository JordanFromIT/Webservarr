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
 *     signal: ctx.signal,      // the page's visit: the tour ends with it
 *     onFinish: function (how) {}   // 'done' (the last step) or 'skip'
 *   });
 *   tour.start();              // or call it yourself once the page is ready
 *
 * A step names its target by selector. `fallback` is used when the primary
 * element is absent or hidden, so a tour never breaks on an empty page.
 *
 * More a step can carry (the welcome tour, js/welcome.js, uses them):
 *   list      short numbered instructions under the body: each a string, or
 *             [before, icon, after] to picture a browser button in the words
 *   actions   buttons of its own in place of Continue:
 *             { label, kind: 'primary' | 'quiet' | 'link', run(ctl),
 *               busyLabel, focus }. run gets the step's controls (below); a
 *             promise it returns keeps the buttons disabled until it settles.
 *   view(ctl) a function returning any of the fields above, read each time
 *             the step is drawn, so a step can depend on what was answered
 * The controls, live only while that step is on screen:
 *   ctl.next(), ctl.back(), ctl.finish()
 *   ctl.update(fields)  redraw this step in place with fields laid over it
 *                       (a confirmation), or update(null) to put it back
 * The steps option may itself be a function, called each time the tour starts.
 *
 * quiet: true is a single prompt rather than a tour: no fog, no Skip, no dots,
 * no Back. Escape still closes it.
 *
 * The bubble is a dialog: focus moves into it when it shows, stays in it
 * while a tour runs (Tab wraps), and goes back where it was when it ends. A
 * tour never starts over an open dialog or sheet: it waits for it to close.
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

  /* A key aimed at a place where people type (the arrow keys belong to the caret there). */
  function inField(t) {
    if (!t || t.nodeType !== 1) return false;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable ||
      (t.getAttribute && t.getAttribute('contenteditable') !== null && t.getAttribute('contenteditable') !== 'false');
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
      '<div id="tourBubble" class="tour-bubble" role="dialog" aria-labelledby="tourTitle" aria-describedby="tourBody" tabindex="-1">' +
        '<div id="tourArrow" class="tour-arrow" data-side="top"></div>' +
        '<div class="p-4">' +
          '<div class="flex items-start gap-2">' +
            '<span id="tourIcon" class="material-symbols-outlined text-[20px] text-bright shrink-0" aria-hidden="true">auto_stories</span>' +
            '<h3 id="tourTitle" class="flex-1 font-bold text-bright text-sm leading-snug"></h3>' +
            '<button id="tourSkip" type="button" class="text-label text-bright/80 hover:text-bright shrink-0">Skip</button>' +
          '</div>' +
          '<p id="tourBody" class="mt-2 text-[13px] text-bright/90 leading-relaxed"></p>' +
          '<ol id="tourList" class="tour-list" hidden></ol>' +
          '<div id="tourActions" class="tour-actions" hidden></div>' +
          '<div id="tourFoot" class="mt-3 flex items-center gap-3">' +
            '<div id="tourDots" class="flex items-center gap-1.5"></div>' +
            '<div class="ml-auto flex items-center gap-2">' +
              '<button id="tourBack" type="button" class="px-2.5 py-1 rounded-lg text-label text-bright/80 hover:text-bright hover:bg-bright/10">Back</button>' +
              '<button id="tourNext" type="button" class="px-3 py-1.5 rounded-lg bg-bright text-primary text-label font-bold hover:bg-bright/90">Continue</button>' +
            '</div>' +
          '</div>' +
          '<p id="tourSay" class="sr-only" aria-live="polite"></p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(layer);
    return layer;
  }

  function q(id) { return document.getElementById(id); }

  // A step's own buttons, by kind. Literal class lists, so Tailwind compiles them.
  var ACTION_CLASS = {
    primary: 'px-3 py-1.5 rounded-lg bg-bright text-primary text-label font-bold hover:bg-bright/90 disabled:opacity-60',
    quiet: 'px-2.5 py-1.5 rounded-lg text-label text-bright/80 hover:text-bright hover:bg-bright/10 disabled:opacity-60',
    link: 'tour-link disabled:opacity-60'
  };

  /* An open dialog or sheet (a native <dialog>, or a box marked aria-modal)
     that is not the tour's own bubble. */
  function modalOpen() {
    var layer = q('tourLayer');
    var list = document.querySelectorAll('dialog[open], [aria-modal="true"]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (layer && layer.contains(el)) continue;
      if (el.tagName !== 'DIALOG' && (el.hidden || el.closest('[hidden], .hidden'))) continue;
      return true;
    }
    return false;
  }

  function focusables(root) {
    var all = root.querySelectorAll('button, a[href]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.disabled || el.hidden || el.closest('[hidden]')) continue;
      if (el.style.display === 'none' || el.style.visibility === 'hidden') continue;
      out.push(el);
    }
    return out;
  }

  function create(opts) {
    var STEPS = [];
    var SEEN_KEY = opts.seenKey;
    var QUIET = !!opts.quiet;
    var signal = opts.signal || null;
    var step = 0;
    var active = false;
    var placeTimer = 0;      // render's wait for the scroll to settle
    var startTimer = 0;      // autoStart's delay, and the wait for a dialog to close
    // False until this run's first placement: the layer stays invisible and
    // untransitioned until then, so the bubble never shows at a stale spot
    // and slides from it.
    var placed = false;
    var override = null;     // ctl.update()'s fields over the current step
    var drawn = 0;           // which drawing of a step a ctl belongs to
    var focusAfter = null;   // the button to focus once the bubble is placed
    var returnTo = null;     // what had focus before the run

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
      else if (active) landFocus();
    }

    // The first placement of a run lands with no transition, then shows.
    function reveal() {
      placed = true;
      var layer = q('tourLayer');
      void layer.offsetWidth;   // commit the first position before transitions return
      layer.classList.remove('tour-placing');
      layer.style.visibility = '';
      landFocus();
    }

    /* Focus goes into the bubble once it can be seen (a hidden element takes
       no focus): to the button the step asked for, else the bubble itself,
       which reads out its title and words. */
    function landFocus() {
      if (!focusAfter) return;
      var el = focusAfter;
      focusAfter = null;
      if (!el.isConnected) el = q('tourBubble');
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
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

    /* The step as it is drawn now: its own fields, what view() says, and
       anything ctl.update() laid over them. */
    function current() {
      var s = STEPS[step];
      var v = s;
      if (typeof s.view === 'function') {
        try { v = Object.assign({}, s, s.view() || {}); } catch (e) { v = s; }
      }
      if (override) v = Object.assign({}, v, override);
      return v;
    }

    function fillList(items) {
      var ol = q('tourList');
      ol.innerHTML = '';
      ol.hidden = !(items && items.length);
      (items || []).forEach(function (item) {
        var li = document.createElement('li');
        var parts = Array.isArray(item) ? item : [item];
        li.appendChild(document.createTextNode(parts[0] || ''));
        if (parts[1]) {
          var glyph = document.createElement('span');
          glyph.className = 'material-symbols-outlined tour-glyph';
          glyph.setAttribute('aria-hidden', 'true');
          glyph.textContent = parts[1];
          li.appendChild(glyph);
        }
        if (parts[2]) li.appendChild(document.createTextNode(parts[2]));
        ol.appendChild(li);
      });
    }

    /* The controls a step's buttons act through. Each drawing of a step gets
       its own set, and a set from a step that has since moved on does
       nothing: a slow answer never turns a page someone already turned. */
    function controls() {
      var mine = drawn;
      function live(fn) {
        return function () {
          if (!active || mine !== drawn) return;
          return fn.apply(null, arguments);
        };
      }
      return {
        next: live(next),
        back: live(back),
        finish: live(function () { finish('skip'); }),
        update: live(function (fields) { override = fields || null; paint(true); place(); })
      };
    }

    function fillActions(actions) {
      var box = q('tourActions');
      box.innerHTML = '';
      box.hidden = !(actions && actions.length);
      if (box.hidden) return null;
      var ctl = controls();
      var row = document.createElement('div');
      row.className = 'tour-actions-row';
      var wanted = null;
      var buttons = [];
      actions.forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = ACTION_CLASS[a.kind] || ACTION_CLASS.quiet;
        b.textContent = a.label;
        b.addEventListener('click', function () {
          if (b.disabled) return;
          var out;
          try { out = a.run(ctl); } catch (e) { out = null; }
          if (!out || typeof out.then !== 'function') return;
          var mine = drawn;
          buttons.forEach(function (x) { x.disabled = true; });
          box.setAttribute('aria-busy', 'true');
          if (a.busyLabel) b.textContent = a.busyLabel;
          var settle = function () {
            if (mine !== drawn) return;
            buttons.forEach(function (x) { x.disabled = false; });
            box.removeAttribute('aria-busy');
            b.textContent = a.label;
          };
          out.then(settle, settle);
        });
        buttons.push(b);
        // The small link sits on a line of its own under the buttons.
        if (a.kind === 'link') box.appendChild(b);
        else row.appendChild(b);
        if (a.focus && !wanted) wanted = b;
      });
      box.insertBefore(row, box.firstChild);
      return wanted;
    }

    /* Writes the step into the bubble. inPlace: an update of the step on
       screen (a confirmation), said aloud since the words changed under the
       person's focus. */
    function paint(inPlace) {
      var s = current();
      drawn += 1;
      q('tourIcon').textContent = s.icon;
      q('tourTitle').textContent = s.title;
      // Plain text by design. Emphasis inside a step body fights the bold
      // title above it and makes a short blurb look busy.
      q('tourBody').textContent = s.body;
      fillList(s.list);
      var wanted = fillActions(s.actions);

      var dots = q('tourDots');
      dots.innerHTML = '';
      if (!QUIET) {
        STEPS.forEach(function (_, i) {
          var d = document.createElement('span');
          d.className = 'size-1.5 rounded-full ' + (i === step ? 'bg-bright' : 'bg-bright/30');
          dots.appendChild(d);
        });
      }

      var own = !!(s.actions && s.actions.length);
      q('tourBack').style.visibility = step === 0 ? 'hidden' : 'visible';
      q('tourNext').textContent = step === STEPS.length - 1 ? 'Got it' : 'Continue';
      q('tourNext').style.display = own ? 'none' : '';
      q('tourFoot').style.display = QUIET ? 'none' : '';
      q('tourSkip').hidden = QUIET;

      // Where focus goes once the bubble is placed: the step's chosen button,
      // else its first, else Continue. The first step lands on the bubble
      // itself, which a screen reader reads out as the dialog it is.
      if (!placed) focusAfter = q('tourBubble');
      else focusAfter = wanted || (own ? q('tourActions').querySelector('button') : q('tourNext'));

      var say = q('tourSay');
      say.textContent = placed ? (inPlace ? '' : s.title + '. ') + s.body : '';
    }

    function render() {
      override = null;
      paint(false);
      var s = STEPS[step];

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

    // The desktop player's drop-down (WS.playerUI.isWindow) hangs over the
    // page, part of it rather than a dialog: the fog would dim it and a step
    // could point under it. It collapses to its pill first, the book playing
    // on; one moved to a window of its own (Pop out) is not over the page.
    function collapsePlayer() {
      var ui = window.WS && window.WS.playerUI;
      if (!ui || typeof ui.isWindow !== 'function' || !ui.isWindow()) return;
      if (typeof ui.popped === 'function' && ui.popped() === 'docked') return;
      try { ui.close(); } catch (e) { /* never let the player stop the tour */ }
    }

    function start() {
      clearTimeout(startTimer);
      if (active || (signal && signal.aborted)) return;
      if (playerOpen()) { afterPlayer(); return; }
      // An open dialog or sheet (the More sheet, a book, a confirm): wait for
      // it to close rather than fog over it.
      if (modalOpen()) { startTimer = setTimeout(start, 600); return; }
      STEPS = (typeof opts.steps === 'function' ? opts.steps() : opts.steps) || [];
      if (!STEPS.length) return;
      collapsePlayer();
      // The buttons are shared by every tour on the page: this run claims them.
      q('tourNext').onclick = next;
      q('tourBack').onclick = back;
      q('tourSkip').onclick = finish;
      active = true;
      step = 0;
      placed = false;
      var ae = document.activeElement;
      returnTo = ae && ae !== document.body ? ae : null;
      var layer = q('tourLayer');
      layer.classList.toggle('tour-quiet', QUIET);
      // A tour holds the page (Tab stays in the bubble); a quiet prompt
      // leaves it usable around it.
      if (QUIET) q('tourBubble').removeAttribute('aria-modal');
      else q('tourBubble').setAttribute('aria-modal', 'true');
      layer.classList.add('tour-placing');
      layer.style.visibility = 'hidden';
      layer.classList.remove('hidden');
      render();
      window.addEventListener('resize', place, signal ? { signal: signal } : undefined);
      window.addEventListener('scroll', place, signal ? { capture: true, signal: signal } : true);
    }

    // Stops a run: the layer hides, the listeners and the pending placement go.
    function stop() {
      var was = active;
      active = false;
      clearTimeout(placeTimer);
      clearTimeout(startTimer);
      focusAfter = null;
      var layer = q('tourLayer');
      var inLayer = !!(layer && layer.contains(document.activeElement));
      if (layer) layer.classList.add('hidden');
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      // Focus goes back where it was, unless the person has moved it on.
      if (was && (inLayer || document.activeElement === document.body) && returnTo && returnTo.isConnected) {
        try { returnTo.focus({ preventScroll: true }); } catch (e) { /* gone */ }
      }
      returnTo = null;
    }

    // how: 'done' from the last step's button, anything else is a skip
    // (Skip, Escape, a Not now on a quiet prompt).
    function finish(how) {
      if (!active) return;
      stop();
      if (typeof opts.onFinish === 'function') {
        try { opts.onFinish(how === 'done' ? 'done' : 'skip'); } catch (e) { /* cleanup is best effort */ }
      }
      if (!devAlways() && SEEN_KEY) {
        try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode */ }
      }
    }

    function next() {
      if (step < STEPS.length - 1) { step++; render(); } else { finish('done'); }
    }
    function back() {
      if (step > 0) { step--; render(); }
    }

    function seen() {
      try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
    }

    // Tab and Shift+Tab go round the bubble's buttons while a tour runs.
    function trapTab(e) {
      var bubble = q('tourBubble');
      var list = focusables(bubble);
      if (!list.length) { e.preventDefault(); bubble.focus(); return; }
      var first = list[0];
      var last = list[list.length - 1];
      var at = document.activeElement;
      if (!bubble.contains(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (at === first || at === bubble)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    }

    // capture: the reader turns pages on the arrow keys too
    document.addEventListener('keydown', function (e) {
      if (!active || playerOpen()) return;
      if (e.key === 'Tab' && !QUIET) { trapTab(e); return; }
      // Typing is the person's: the arrow keys move the caret in a field, they do not turn a step.
      if (inField(e.target)) { if (e.key === 'Escape') finish('skip'); return; }
      if (e.key === 'Escape') { finish('skip'); }
      else if (QUIET) { return; }
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
