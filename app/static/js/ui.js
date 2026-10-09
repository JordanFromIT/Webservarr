/**
 * WebServarr — shared UI helpers (window.WSUI)
 *
 * One toast, one dialog and the shared class strings, so every page that
 * needs them (Settings, the news archive, the wiki) looks and behaves the
 * same, and nothing uses the browser's alert/confirm/prompt.
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

  // opts: {title, body: string|Node, confirmLabel, cancelLabel, danger, alert}.
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
      (opts.danger && !opts.alert ? cancel : ok).focus();
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

  window.WSUI = { el: el, icon: icon, toast: toast, confirm: confirm, modal: modal, cls: cls,
                  isDialogOpen: isDialogOpen, closeDialogs: closeDialogs };
})();
