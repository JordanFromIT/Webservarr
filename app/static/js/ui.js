/**
 * WebServarr — shared UI helpers (window.WSUI)
 *
 * One toast, one dialog and the shared class strings, so every page that
 * needs them (Settings, the news archive, the wiki) looks and behaves the
 * same, and nothing uses the browser's alert/confirm/prompt. Also the one
 * marquee for words cut off with an ellipsis (the event log, Books' search).
 *
 * Loaded once by the shell (partials/shell-sidebar.html) on every shell page,
 * before any page script and before router.js, so no page loads it itself.
 * It reads nothing from the page at load.
 *
 * Class strings are literal so Tailwind compiles them (app/static/js is in
 * the content globs). Text colours are theme colours only. A toast's tone is
 * the status light beside the text; an error's words also take the derived
 * status-text colour (R140), while ok and info stay quiet. The primary, ghost
 * and danger buttons carry ws-lift (theme.css): a pixel of lift on hover and
 * a dip on press; the quiet text button does not.
 */
(function () {
  'use strict';

  var cls = {
    input: 'w-full rounded-[10px] bg-frosted-blue/[0.04] border border-frosted-blue/10 px-3.5 py-2.5 ' +
      'text-[15px] text-frosted-blue placeholder:text-frosted-blue/70 focus:outline-none focus:ring-2 ' +
      'focus:ring-focus focus:border-transparent transition-colors disabled:opacity-50',
    label: 'block text-[13px] font-semibold text-frosted-blue/70 mb-1.5',
    help: 'text-[13px] text-frosted-blue/60 mt-1.5',
    error: 'text-[13px] font-semibold text-frosted-blue mt-1.5 flex items-center gap-1.5',
    // The widest a field, or a grid of fields, runs: a card description's width.
    fieldWidth: 'max-w-2xl',
    btnPrimary: 'ws-lift inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[10px] bg-primary text-bright ' +
      'text-sm font-semibold hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 ' +
      'focus-visible:outline-offset-2 focus-visible:outline-focus transition-colors ' +
      'disabled:opacity-50 disabled:cursor-not-allowed',
    btnGhost: 'ws-lift inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[10px] bg-frosted-blue/[0.06] ' +
      'text-frosted-blue text-sm font-semibold hover:bg-frosted-blue/10 focus-visible:outline ' +
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus transition-colors ' +
      'disabled:opacity-50 disabled:cursor-not-allowed',
    btnQuiet: 'inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[10px] text-frosted-blue/70 ' +
      'text-sm font-semibold hover:text-frosted-blue hover:bg-frosted-blue/[0.06] focus-visible:outline ' +
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus transition-colors',
    btnDanger: 'ws-lift inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[10px] bg-frosted-blue/[0.06] ' +
      'text-frosted-blue text-sm font-semibold ring-1 ring-inset ring-[rgb(var(--ws-status-err))] ' +
      'hover:bg-frosted-blue/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
      'focus-visible:outline-focus transition-colors'
  };

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function icon(name, className) {
    var s = el('span', 'material-symbols-outlined ' + (className || ''), name || '');
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ---- Toast ----

  var TONE_LIGHT = { ok: 'ws-light-ok', err: 'ws-light-error', info: 'ws-light-unconfigured' };
  // Status colour only on deviation: an error's words, never a success's.
  var TONE_TEXT = { ok: 'text-frosted-blue', err: 'text-status-err-text', info: 'text-frosted-blue' };
  var toastBox = null;
  // Its focus ring is the site's one ring (outline-focus, theme.css
  // --ws-focus): the primary blue on the frost is under 3:1.
  var ACTION_BTN = 'shrink-0 -my-1 ml-1 px-3 py-1.5 rounded-lg bg-frosted-blue/[0.08] text-frosted-blue text-xs ' +
    'font-bold hover:bg-frosted-blue/15 focus-visible:outline focus-visible:outline-2 ' +
    'focus-visible:outline-offset-2 focus-visible:outline-focus transition-colors';

  // The toasts on screen, oldest first. Past TOAST_MAX the oldest leaves, so
  // a burst never runs the stack down the screen.
  var shown = [];
  var TOAST_MAX = 3;
  // How long .ws-toast.is-leaving runs (theme.css, Toasts).
  var TOAST_OUT_MS = 200;
  // How long the toasts below one that went take to slide up into its room.
  var TOAST_CLOSE_MS = 200;

  // Takes t out of the stack. The toasts below it would jump up into its room
  // at once; instead each is drawn where it was and slides up to its new
  // place (a transform, added to any arrival still running, so the layout
  // moves once). With reduced motion they simply take their new places.
  function takeOut(t) {
    var box = t.parentNode;
    if (!box) return;
    var below = [];
    for (var n = t.nextElementSibling; n; n = n.nextElementSibling) below.push(n);
    var was = below.map(function (n) { return n.getBoundingClientRect().top; });
    box.removeChild(t);
    if (reducedMotion()) return;
    below.forEach(function (n, i) {
      var dy = was[i] - n.getBoundingClientRect().top;
      if (!dy || typeof n.animate !== 'function') return;
      n.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'translateY(0)' }],
        { duration: TOAST_CLOSE_MS, easing: 'cubic-bezier(.2, 0, 0, 1)', composite: 'add' });
    });
  }

  // A notification in the top right, under the account name in the header
  // (under the top bar on a phone): it slides in, stays a few seconds and
  // slides out again; theme.css .ws-toasts and .ws-toast place and move it.
  // Under the pointer or holding the focus it stays, and leaves 2 s after.
  // opts.action: { label, run } adds one button (Retry after a page failed to
  // open, router.js). Pressing it closes the toast, then runs run(). A toast
  // with a button stays 4 s longer, so there is time to reach it. Returns
  // { remove() }, which takes it down at once.
  function toast(message, tone, opts) {
    tone = TONE_LIGHT[tone] ? tone : 'info';
    var fresh = !toastBox || !toastBox.parentNode;
    if (fresh) {
      // A polite live region; an error toast is itself an alert.
      toastBox = el('div', 'ws-toasts');
      toastBox.id = 'wsToasts';
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
      shown = [];
    }
    // On the site's one frosted surface (theme.css .ws-frost).
    var t = el('div', 'ws-toast pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl border ' +
      'ws-frost text-sm font-semibold ' + TONE_TEXT[tone]);
    if (tone === 'err') t.setAttribute('role', 'alert');
    t.appendChild(el('span', 'ws-light ' + TONE_LIGHT[tone]));
    t.appendChild(el('span', 'min-w-0 flex-1', message));
    var action = opts && opts.action && opts.action.label ? opts.action : null;
    var gone = false;
    var timer = null;
    function unlist() {
      gone = true;
      clearTimeout(timer);
      var i = shown.indexOf(entry);
      if (i !== -1) shown.splice(i, 1);
    }
    function remove() {
      unlist();
      takeOut(t);
    }
    // Slides (or, with reduced motion, fades) out, then goes.
    function leave() {
      if (gone) return;
      unlist();
      t.classList.add('is-leaving');
      setTimeout(remove, TOAST_OUT_MS);
    }
    function arm(ms) {
      clearTimeout(timer);
      if (!gone) timer = setTimeout(leave, ms);
    }
    var entry = { leave: leave };
    if (action) {
      var btn = el('button', ACTION_BTN, action.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        remove();
        if (typeof action.run === 'function') action.run();
      });
      t.appendChild(btn);
    }
    t.addEventListener('mouseenter', function () { clearTimeout(timer); });
    t.addEventListener('mouseleave', function () { arm(2000); });
    t.addEventListener('focusin', function () { clearTimeout(timer); });
    t.addEventListener('focusout', function (e) { if (!t.contains(e.relatedTarget)) arm(2000); });
    var box = toastBox;
    function show() {
      if (gone) return;
      box.appendChild(t);
      shown.push(entry);
      if (shown.length > TOAST_MAX) shown[0].leave();
    }
    // A live region created in the same moment as its content is often not
    // announced, so the first toast lands a beat after its region exists.
    if (fresh) setTimeout(show, 50);
    else show();
    arm((tone === 'err' ? 6000 : 4000) + (action ? 4000 : 0));
    // The caller may take it down early (the router replaces its Retry
    // toast rather than stacking one per failed attempt).
    return { remove: remove };
  }

  // ---- Dialog ----

  var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var dialogCount = 0;
  // Open dialogs, topmost last. A dialog can open over another (a leave
  // guard over the icon picker), so one keydown and one focusin handler serve
  // them all, and they act for the topmost dialog only.
  var stack = [];

  function topDialog() { return stack.length ? stack[stack.length - 1] : null; }

  function focusables(box) { return Array.prototype.slice.call(box.querySelectorAll(FOCUSABLE)); }

  function onKey(e) {
    var d = topDialog();
    if (!d) return;
    // Mid-composition, Escape belongs to the input method, not the dialog.
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); d.close(d.dismiss); return; }
    if (e.key !== 'Tab') return;
    var f = focusables(d.box);
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1];
    if (!d.box.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // Focus that escapes anyway (a click on the page behind, assistive tech)
  // is brought back inside the topmost dialog. Focusing inside it fires
  // focusin again, which then has nothing to do.
  function onFocusIn(e) {
    var d = topDialog();
    if (!d || d.box.contains(e.target)) return;
    var f = focusables(d.box);
    if (f.length) f[0].focus();
  }

  // opts: {title, body: string|Node, confirmLabel, cancelLabel, danger, alert,
  // initial}. initial (opt-in) is where focus starts instead of the default
  // button: a control inside body, or 'title' for the heading. A dialog whose
  // OK acts at once (shares, sends) starts on its first choice, so one Enter
  // straight after opening does nothing.
  // Resolves true for OK, false for Cancel/Escape/backdrop; with alert (a
  // one-button notice) every way out resolves true.
  function confirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var previous = document.activeElement;
      // ws-dialog / ws-dialog-box: theme.css fades the dim in and lifts the
      // box 6px with it, and fades both out again on close. The box is the
      // site's one frosted surface (ws-frost), floored for its scrim.
      var overlay = el('div', 'ws-dialog fixed inset-0 z-[95] flex items-end sm:items-center justify-center p-4 ' +
        'ws-scrim backdrop-blur-sm');
      var box = el('div', 'ws-dialog-box ws-frost w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border p-6');
      box.setAttribute('role', opts.danger || opts.alert ? 'alertdialog' : 'dialog');
      box.setAttribute('aria-modal', 'true');
      dialogCount += 1;
      var title = el('h2', 'text-[20px] font-bold tracking-tight text-frosted-blue', opts.title || 'Are you sure?');
      title.id = 'wsDialogTitle' + dialogCount;
      box.setAttribute('aria-labelledby', title.id);
      box.appendChild(title);
      if (opts.body) {
        var body = el('div', 'mt-2 text-[15px] text-frosted-blue/70');
        if (typeof opts.body === 'string') body.textContent = opts.body;
        else body.appendChild(opts.body);
        body.id = 'wsDialogBody' + dialogCount;
        if (typeof opts.body === 'string') box.setAttribute('aria-describedby', body.id);
        box.appendChild(body);
      }
      var row = el('div', 'mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2');
      var cancel = el('button', cls.btnGhost, opts.cancelLabel || 'Cancel');
      cancel.type = 'button';
      var ok = el('button', opts.danger ? cls.btnDanger : cls.btnPrimary, opts.confirmLabel || 'Confirm');
      ok.type = 'button';
      // alert: a notice with one button (OK); Escape and the backdrop answer the same.
      if (!opts.alert) row.appendChild(cancel);
      row.appendChild(ok);
      box.appendChild(row);
      overlay.appendChild(box);

      // What Escape and a backdrop click answer: Cancel, or OK for a one-button notice.
      var entry = { box: box, close: close, dismiss: !!opts.alert };
      var done = false;
      // The dialog's own listeners end when it closes, not when its nodes are
      // collected: a page's leak check (soft navigation) sees them gone.
      var ends = new AbortController();
      function close(result) {
        if (done) return;
        done = true;
        ends.abort();
        var wasTop = topDialog() === entry;
        stack.splice(stack.indexOf(entry), 1);
        if (!stack.length) {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('focusin', onFocusIn, true);
        }
        // The overlay fades before it leaves the DOM; inert meanwhile, so
        // nothing in it can be clicked or take focus. Reduced motion removes
        // it at once.
        function remove() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
        if (reducedMotion()) remove();
        else {
          overlay.inert = true;
          overlay.classList.add('is-closing');
          setTimeout(remove, 160);
        }
        // Only the dialog on top owns focus. Hand it back to what opened this
        // one, unless that is gone or sits outside the dialog now on top.
        if (wasTop) {
          var under = topDialog();
          var back = previous && previous.focus && document.contains(previous) &&
            (!under || under.box.contains(previous)) ? previous : null;
          if (!back && under) back = focusables(under.box)[0] || null;
          if (back) back.focus({ preventScroll: true });
        }
        resolve(result);
      }

      if (!stack.length) {
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('focusin', onFocusIn, true);
      }
      stack.push(entry);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(entry.dismiss); }, { signal: ends.signal });
      cancel.addEventListener('click', function () { close(false); }, { signal: ends.signal });
      ok.addEventListener('click', function () { close(true); }, { signal: ends.signal });
      var start = opts.danger && !opts.alert ? cancel : ok;
      if (opts.initial === 'title') {
        title.tabIndex = -1;
        start = title;
      } else if (opts.initial && opts.initial.focus && box.contains(opts.initial)) {
        start = opts.initial;
      }
      start.focus();
    });
  }

  // A page's own overlay (static markup it shows by dropping `hidden`) run as
  // a dialog, on the same stack as confirm(): its box gets the dialog role,
  // focus moves in, Tab stays inside, Escape closes it (the topmost only), and
  // focus goes back to what opened it. The page keeps drawing and hiding it.
  // opts: { box: the dialog box (default the overlay's [data-dialog-box]),
  //         initial: what takes focus first (default the first control),
  //         onClose: hides the overlay; runs on Escape, on close(), and when
  //         the router closes every dialog before a soft navigation }.
  // Returns { close() }; closing twice does nothing.
  function modal(overlay, opts) {
    opts = opts || {};
    var box = opts.box || overlay.querySelector('[data-dialog-box]') || overlay;
    var previous = document.activeElement;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
    var entry = { box: box, close: close, dismiss: false };
    var done = false;
    function close() {
      if (done) return;
      done = true;
      var wasTop = topDialog() === entry;
      stack.splice(stack.indexOf(entry), 1);
      if (!stack.length) {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('focusin', onFocusIn, true);
      }
      if (typeof opts.onClose === 'function') opts.onClose();
      if (wasTop) {
        var under = topDialog();
        var back = previous && previous.focus && document.contains(previous) &&
          (!under || under.box.contains(previous)) ? previous : null;
        if (!back && under) back = focusables(under.box)[0] || null;
        if (back) back.focus({ preventScroll: true });
      }
    }
    if (!stack.length) {
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('focusin', onFocusIn, true);
    }
    stack.push(entry);
    var first = opts.initial || focusables(box)[0] || box;
    first.focus({ preventScroll: true });
    return { close: close };
  }

  function isDialogOpen() { return stack.length > 0; }

  // Every open dialog, topmost first, answered as Escape would answer it
  // (Cancel; OK for a one-button notice). The router calls this before a
  // soft navigation swaps the page out from under them.
  function closeDialogs() {
    while (stack.length) {
      var d = topDialog();
      d.close(d.dismiss);
    }
  }

  // ---- Marquee ----
  //
  // Words cut off with an ellipsis slide slowly to their end and back,
  // resting at each end, so all of them can be read: the event log's lines
  // (event-log.js) and the Books search's placeholder (marqueePlaceholder).
  // Only words that really are cut off move. Under reduced motion nothing
  // moves and the ellipsis stays. The motion is CSS (theme.css, Marquee):
  // this measures how far the words run past their box and writes that
  // distance and the timing as custom properties on the box. It holds still
  // while the box is off screen or the tab is hidden, and goes on from there.
  //
  // marquee(box, opts): box clips its words (overflow hidden, an ellipsis).
  // Its contents are moved into one span.ws-marquee__track, the part that
  // slides: the same nodes, so a screen reader hears the words once.
  // opts.onChange(moving) hears it start and stop. Returns
  // { refresh(), enable(on), destroy() }: refresh after the words change
  // (new words start from the beginning), enable(false) holds it still with
  // the ellipsis back, destroy when the box is done with.
  //
  // opts.group (a name): the marquees of one group keep one beat, so rows
  // read as one block. They all set off at the same moment at the same
  // speed; a box with less to show gets to its end sooner and waits there.
  // Once the one that runs furthest is at its end, all rest, then all set
  // off back together at the same speed, and the shorter ones are home
  // first and wait. So no two boxes ever move different ways or at
  // different speeds. The beat's length comes from the furthest one
  // (rounded up to half a second, so a pixel or two does not retime them
  // all) and is the page's clock (each slide's start time is the document
  // timeline's zero), so a box that joins later, or gets new words, falls
  // in step at once instead of starting over.

  var MARQUEE_PX_S = 32;      // the slide's speed, px a second
  var MARQUEE_REST_S = 1.75;  // the rest at each end, seconds
  var MARQUEE_FIT_PX = 0.02;  // words this close to the box's width fit (sub-pixel noise)
  var MARQUEE_STEP_S = 0.5;   // a group's slide time is rounded up to this
  var marquees = [];
  var marqueeRO = null;
  var marqueeIO = null;
  var marqueeMotion = null;

  function marqueeOf(node) {
    for (var i = 0; i < marquees.length; i++) if (marquees[i].box === node) return marquees[i];
    return null;
  }

  function marqueeAll() { marquees.slice().forEach(marqueeApply); }
  function marqueeShowAll() { marquees.slice().forEach(marqueePaint); }

  // One of each for every marquee on the page, made with the first and
  // ended with the last.
  function marqueeWatch() {
    if (typeof ResizeObserver === 'function') {
      marqueeRO = new ResizeObserver(function (rows) {
        rows.forEach(function (r) { var m = marqueeOf(r.target); if (m) marqueeApply(m); });
      });
    }
    if (typeof IntersectionObserver === 'function') {
      marqueeIO = new IntersectionObserver(function (rows) {
        rows.forEach(function (r) {
          var m = marqueeOf(r.target);
          if (m) { m.inView = r.isIntersecting; marqueePaint(m); }
        });
      });
    }
    document.addEventListener('visibilitychange', marqueeShowAll);
    marqueeMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (marqueeMotion && marqueeMotion.addEventListener) marqueeMotion.addEventListener('change', marqueeAll);
    // The web font arriving changes how wide the words are.
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', marqueeAll);
    document.addEventListener('animationstart', marqueeRestarted);
  }

  // A slide the browser started again on its own (its box moved in the page,
  // or was hidden and shown) goes back on its group's beat.
  function marqueeRestarted(e) {
    if (e.animationName !== 'ws-marquee' || !e.target) return;
    var m = marqueeOf(e.target.parentNode);
    if (m && m.box.getAttribute('data-marquee') === 'run') marqueeBeat(m);
  }

  function marqueeUnwatch() {
    if (marqueeRO) marqueeRO.disconnect();
    if (marqueeIO) marqueeIO.disconnect();
    marqueeRO = marqueeIO = null;
    document.removeEventListener('visibilitychange', marqueeShowAll);
    if (marqueeMotion && marqueeMotion.removeEventListener) marqueeMotion.removeEventListener('change', marqueeAll);
    marqueeMotion = null;
    if (document.fonts && document.fonts.removeEventListener) document.fonts.removeEventListener('loadingdone', marqueeAll);
    document.removeEventListener('animationstart', marqueeRestarted);
  }

  // The box's contents as its one track. New contents get a new track, so
  // their slide starts from the beginning. True when the track is new.
  function marqueeTrack(m) {
    var box = m.box;
    if (m.track && box.childNodes.length === 1 && box.firstChild === m.track) return false;
    var track = el('span', 'ws-marquee__track');
    while (box.firstChild) track.appendChild(box.firstChild);
    box.appendChild(track);
    m.track = track;
    return true;
  }

  // Moving, or held (off screen, the tab hidden), or still.
  function marqueePaint(m) {
    var want = !m.dist ? null : m.inView && document.visibilityState !== 'hidden' ? 'run' : 'held';
    if (want === null) m.box.removeAttribute('data-marquee');
    else if (m.box.getAttribute('data-marquee') !== want) m.box.setAttribute('data-marquee', want);
    if (want === 'run') marqueeBeat(m);
  }

  // A group's slide, moving, starts at the page's zero, so every box in it
  // is at the same point of the same beat. Only while it runs: a held slide
  // is paused by theme.css, and giving it a start time would play it. Back
  // from held, it is put on the beat again here.
  function marqueeBeat(m) {
    if (!m.group || !m.track || typeof m.track.getAnimations !== 'function') return;
    m.track.getAnimations().forEach(function (a) {
      if (a.animationName === 'ws-marquee' && a.startTime !== 0) a.startTime = 0;
    });
  }

  function marqueeStill(m) {
    var was = m.dist > 0;
    m.dist = 0;
    ['--marquee-shift', '--marquee-time', '--marquee-delay', '--marquee-ease', '--marquee-dir'].forEach(function (p) { m.box.style.removeProperty(p); });
    marqueePaint(m);
    if (was && m.onChange) m.onChange(false);
  }

  // The timing of a slide that takes travel seconds one way: a rest at
  // each end around it. Written only when it changes.
  function marqueeTime(m, travel) {
    var half = travel + MARQUEE_REST_S;             // one way, with a rest at both ends
    var rest = (MARQUEE_REST_S / 2) / half * 100;   // each end's half of a rest, in %
    var set = {
      '--marquee-time': half.toFixed(3) + 's',
      // The first rest is a whole one: half before the slide starts, half in it.
      '--marquee-delay': (MARQUEE_REST_S / 2).toFixed(3) + 's',
      '--marquee-ease': 'linear(0, 0 ' + rest.toFixed(2) + '%, 1 ' + (100 - rest).toFixed(2) + '%, 1)'
    };
    Object.keys(set).forEach(function (p) {
      if (m.box.style.getPropertyValue(p) !== set[p]) m.box.style.setProperty(p, set[p]);
    });
  }

  // A group's beat, from the box that runs furthest, given to every box of
  // it that moves. One beat is a whole cycle, played forwards (not
  // alternating), so each box can keep the same speed both ways: out over
  // its own distance and hold, then, half a beat in, back and hold. The
  // ease is the box's position over the beat (0 home, 1 at its end).
  function marqueeGroupTime(group) {
    if (!group) return;
    var moving = marquees.filter(function (x) { return x.group === group && x.dist > 0; });
    if (!moving.length) return;
    var far = Math.max.apply(null, moving.map(function (x) { return x.dist; }));
    var travel = Math.ceil(far / MARQUEE_PX_S / MARQUEE_STEP_S) * MARQUEE_STEP_S;
    var beat = 2 * (travel + MARQUEE_REST_S);
    moving.forEach(function (x) {
      var there = x.dist / MARQUEE_PX_S / beat * 100;   // its slide, in % of the beat
      var set = {
        '--marquee-time': beat.toFixed(3) + 's',
        '--marquee-dir': 'normal',
        // A whole rest before the first slide out.
        '--marquee-delay': MARQUEE_REST_S.toFixed(3) + 's',
        '--marquee-ease': 'linear(0, 1 ' + there.toFixed(3) + '%, 1 50%, 0 ' + (50 + there).toFixed(3) + '%, 0)'
      };
      Object.keys(set).forEach(function (p) {
        if (x.box.style.getPropertyValue(p) !== set[p]) x.box.style.setProperty(p, set[p]);
      });
    });
  }

  // How far the words run past the box, in px: from the layout's own
  // fractional widths where it gives them (untouched by any transform on
  // the way up), so words cut off by a pixel or less still count. The
  // track is an inline box at rest, which has no width of its own to read;
  // it is made an inline-block for the one reading and put back in the
  // same task, so nothing is drawn in between. Without fractional widths,
  // whole pixels: the track's (a slide under way does not change it) or,
  // at rest, the box's scroll width.
  function marqueeOverflow(m) {
    var box = m.box;
    var whole = Math.max(box.scrollWidth, m.track.offsetWidth) - box.clientWidth;
    if (!window.getComputedStyle) return whole;
    var bs = window.getComputedStyle(box);
    var inline = m.track.style.display;
    m.track.style.display = 'inline-block';
    var words = parseFloat(window.getComputedStyle(m.track).width);
    m.track.style.display = inline;
    var room = parseFloat(bs.width);
    if (bs.boxSizing === 'border-box') {
      ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].forEach(function (k) { room -= parseFloat(bs[k]) || 0; });
    }
    return isFinite(words) && isFinite(room) && room > 0 ? words - room : whole;
  }

  // How far the words run past the box, and the slide that shows them.
  function marqueeApply(m) {
    var fresh = marqueeTrack(m);
    if (!m.on || !m.box.isConnected || reducedMotion()) { marqueeStill(m); marqueeGroupTime(m.group); return; }
    // Any real overflow slides, by whole pixels so the last letter is shown
    // whole; words that fit (to sub-pixel noise) stay still.
    var over = marqueeOverflow(m);
    if (!(over > MARQUEE_FIT_PX)) { marqueeStill(m); marqueeGroupTime(m.group); return; }
    var d = Math.ceil(over - MARQUEE_FIT_PX);
    if (fresh || Math.abs(d - m.dist) >= 1) {
      var was = m.dist > 0;
      var rtl = window.getComputedStyle && window.getComputedStyle(m.box).direction === 'rtl';
      m.dist = d;
      m.box.style.setProperty('--marquee-shift', (rtl ? d : -d) + 'px');
      if (!m.group) marqueeTime(m, d / MARQUEE_PX_S);
      if (!was && m.onChange) m.onChange(true);
    }
    marqueeGroupTime(m.group);
    marqueePaint(m);
  }

  function marquee(box, opts) {
    var m = marqueeOf(box);
    if (m) { marqueeApply(m); return m.handle; }
    if (!marquees.length) marqueeWatch();
    m = { box: box, track: null, on: true, inView: true, dist: 0, onChange: opts && opts.onChange, group: opts && opts.group || null };
    marquees.push(m);
    m.handle = {
      refresh: function () { if (marquees.indexOf(m) !== -1) marqueeApply(m); },
      enable: function (on) {
        m.on = !!on;
        if (marquees.indexOf(m) !== -1) marqueeApply(m);
      },
      destroy: function () {
        var i = marquees.indexOf(m);
        if (i === -1) return;
        marquees.splice(i, 1);
        if (marqueeRO) marqueeRO.unobserve(box);
        if (marqueeIO) marqueeIO.unobserve(box);
        marqueeStill(m);
        marqueeGroupTime(m.group);
        if (!marquees.length) marqueeUnwatch();
      }
    };
    if (marqueeRO) marqueeRO.observe(box);
    if (marqueeIO) marqueeIO.observe(box);
    marqueeApply(m);
    return m.handle;
  }

  // An input's placeholder, cut off: its words slide in `overlay` (an
  // aria-hidden box over the input's text, the page's markup) while the
  // input's own placeholder turns transparent, so it is read once and seen
  // once. It stops, and the input's own placeholder is back, as soon as the
  // input has the focus or any text, and starts again when it has neither.
  // Ends with `signal`.
  function marqueePlaceholder(input, overlay, signal) {
    overlay.textContent = input.placeholder || '';
    var m = marquee(overlay, {
      onChange: function (moving) {
        if (moving) input.setAttribute('data-marquee-ph', '');
        else input.removeAttribute('data-marquee-ph');
      }
    });
    function sync() { m.enable(!input.value && document.activeElement !== input); }
    ['focus', 'blur', 'input', 'change'].forEach(function (type) {
      input.addEventListener(type, sync, signal ? { signal: signal } : undefined);
    });
    if (signal) {
      signal.addEventListener('abort', function () {
        m.destroy();
        input.removeAttribute('data-marquee-ph');
      }, { once: true });
    }
    sync();
    return m;
  }

  window.WSUI = { el: el, icon: icon, toast: toast, confirm: confirm, modal: modal, cls: cls,
                  isDialogOpen: isDialogOpen, closeDialogs: closeDialogs,
                  marquee: marquee, marqueePlaceholder: marqueePlaceholder };
})();
