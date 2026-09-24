/**
 * WebServarr — shared UI helpers (window.WSUI)
 *
 * One toast, one dialog and the shared class strings, so every page that
 * needs them (Settings, the news archive, the wiki) looks and behaves the
 * same, and nothing uses the browser's alert/confirm/prompt.
 *
 * Class strings are literal so Tailwind compiles them (app/static/js is in
 * the content globs). Text colours are theme colours only; a toast's tone is
 * a status light beside the text, never the text itself.
 */
(function () {
  'use strict';

  var cls = {
    input: 'w-full rounded-[10px] bg-frosted-blue/[0.04] border border-frosted-blue/10 px-3.5 py-2.5 ' +
      'text-[15px] text-frosted-blue placeholder:text-frosted-blue/45 focus:outline-none focus:ring-2 ' +
      'focus:ring-primary focus:border-transparent transition-colors disabled:opacity-50',
    label: 'block text-[13px] font-semibold text-frosted-blue/70 mb-1.5',
    help: 'text-[13px] text-frosted-blue/45 mt-1.5',
    error: 'text-[13px] font-semibold text-frosted-blue mt-1.5 flex items-center gap-1.5',
    btnPrimary: 'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[10px] bg-primary text-bright ' +
      'text-sm font-semibold hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 ' +
      'focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors ' +
      'disabled:opacity-50 disabled:cursor-not-allowed',
    btnGhost: 'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[10px] bg-frosted-blue/[0.06] ' +
      'text-frosted-blue text-sm font-semibold hover:bg-frosted-blue/10 focus-visible:outline ' +
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors ' +
      'disabled:opacity-50 disabled:cursor-not-allowed',
    btnQuiet: 'inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[10px] text-frosted-blue/70 ' +
      'text-sm font-semibold hover:text-frosted-blue hover:bg-frosted-blue/[0.06] focus-visible:outline ' +
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors',
    btnDanger: 'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[10px] bg-frosted-blue/[0.06] ' +
      'text-frosted-blue text-sm font-semibold ring-1 ring-inset ring-[rgb(var(--ws-status-err))] ' +
      'hover:bg-frosted-blue/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
      'focus-visible:outline-primary transition-colors'
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
  var toastBox = null;

  function toast(message, tone) {
    tone = TONE_LIGHT[tone] ? tone : 'info';
    var fresh = !toastBox || !toastBox.parentNode;
    if (fresh) {
      // A polite live region; an error toast is itself an alert.
      toastBox = el('div', 'fixed z-[90] top-4 inset-x-4 sm:inset-x-auto sm:right-6 flex flex-col ' +
        'items-stretch sm:items-end gap-2 pointer-events-none');
      toastBox.id = 'wsToasts';
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }
    var t = el('div', 'pointer-events-auto flex items-center gap-3 max-w-md px-4 py-3 rounded-2xl border ' +
      'border-frosted-blue/10 bg-background-dark/90 backdrop-blur-md shadow-2xl text-sm font-semibold ' +
      'text-frosted-blue ws-panel-in');
    if (tone === 'err') t.setAttribute('role', 'alert');
    t.appendChild(el('span', 'ws-light ' + TONE_LIGHT[tone]));
    t.appendChild(el('span', 'min-w-0', message));
    var box = toastBox;
    // A live region created in the same moment as its content is often not
    // announced, so the first toast lands a beat after its region exists.
    if (fresh) setTimeout(function () { box.appendChild(t); }, 50);
    else box.appendChild(t);
    setTimeout(function () {
      if (reducedMotion()) { if (t.parentNode) t.parentNode.removeChild(t); return; }
      t.style.transition = 'opacity 200ms ease-out';
      t.style.opacity = '0';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }, tone === 'err' ? 6000 : 4000);
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
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); d.close(d.dismiss); return; }
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
      var overlay = el('div', 'fixed inset-0 z-[95] flex items-end sm:items-center justify-center p-4 ' +
        'bg-background-dark/70 backdrop-blur-sm');
      var box = el('div', 'w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-frosted-blue/10 ' +
        'bg-background-dark shadow-2xl p-6 ws-panel-in');
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
      function close(result) {
        if (done) return;
        done = true;
        var wasTop = topDialog() === entry;
        stack.splice(stack.indexOf(entry), 1);
        if (!stack.length) {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('focusin', onFocusIn, true);
        }
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
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
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(entry.dismiss); });
      cancel.addEventListener('click', function () { close(false); });
      ok.addEventListener('click', function () { close(true); });
      (opts.danger && !opts.alert ? cancel : ok).focus();
    });
  }

  function isDialogOpen() { return stack.length > 0; }

  window.WSUI = { el: el, icon: icon, toast: toast, confirm: confirm, cls: cls, isDialogOpen: isDialogOpen };
})();
