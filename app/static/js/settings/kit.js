/**
 * WebServarr — Settings kit (window.WSSettings)
 *
 * Shared by every Settings tab: controls bound to setting keys, change
 * tracking per tab, the floating save bar, the leave guard and hash routing.
 * Tabs never save on their own and never carry a default: baselines, defaults
 * and the saved-secret placeholder come from
 * GET /api/admin/settings?view=registry (values + meta + mask).
 *
 * Contract: G6 in docs/superpowers/plans/2026-09-22-settings-redesign.md.
 */
(function () {
  'use strict';

  var UI = window.WSUI;
  var el = UI.el, icon = UI.icon, cls = UI.cls;
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var TABS = ['general', 'pages', 'appearance', 'sign-in', 'integrations', 'notifications'];
  var TITLES = { general: 'General', pages: 'Pages', appearance: 'Appearance', 'sign-in': 'Sign-in',
                 integrations: 'Integrations', notifications: 'Notifications' };
  // Choices for the icon picker. Any Material Symbols name can also be typed.
  var ICONS = [
    'home', 'settings', 'movie', 'tv', 'play_circle', 'download', 'upload', 'monitor_heart', 'newspaper',
    'calendar_month', 'report_problem', 'dns', 'movie_filter', 'monitoring',
    'dashboard', 'analytics', 'bar_chart', 'trending_up', 'speed', 'memory', 'storage', 'cloud',
    'cloud_download', 'wifi', 'security', 'shield', 'lock', 'vpn_key', 'admin_panel_settings', 'person',
    'group', 'account_circle', 'manage_accounts', 'support_agent', 'notifications', 'email', 'chat', 'forum',
    'search', 'view_list', 'grid_view', 'favorite', 'star', 'bookmark', 'flag', 'label', 'check_circle',
    'error', 'warning', 'info', 'help', 'schedule', 'update', 'history', 'folder', 'description', 'article',
    'receipt', 'link', 'share', 'public', 'language', 'code', 'terminal', 'palette', 'tune', 'devices',
    'computer', 'phone_android', 'tablet', 'music_note', 'headphones', 'mic', 'videocam', 'image',
    'photo_library', 'theaters', 'live_tv', 'smart_display', 'menu_book', 'library_books', 'auto_stories',
    'book', 'local_library', 'rocket_launch', 'bolt', 'auto_awesome', 'lightbulb', 'extension', 'hub', 'sync',
    'refresh', 'build', 'construction', 'handyman', 'shopping_cart', 'redeem', 'celebration', 'sports_esports'
  ];

  // Plain-language save failures. The server's own words are used where it
  // gives them (per-field messages, the lockout rule, its 503 message).
  var MSG = {
    offline: 'Couldn’t reach the server. Check your connection and try again.',
    failed: 'Couldn’t save your changes. Nothing was changed; please try again.',
    unconfirmed: 'Couldn’t confirm your changes were saved. Please try again.',
    unreadable: 'Some of these changes couldn’t be read. Reload the page and try again.',
    busy: 'That was a lot of saves in a row. Wait a minute, then try again.',
    forbidden: 'Only admins can change settings.',
    fix: 'Some settings need fixing',
    invalid: 'That value isn’t allowed',
    maskText: 'That text can’t be used as a key.',
    notSaved: 'This change wasn’t saved. Please try again.',
    partial: 'Some changes weren’t saved. Check the marked fields.'
  };

  var S = { values: {}, meta: {}, mask: null, booted: false, loaded: false, loadFailed: false, current: null,
            tabs: {}, busy: false, saving: false, failed: false, asking: false, leaving: false,
            pendingFocus: null };
  var bar, barText, barDiscard, barSave;
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function tab(id) {
    if (!S.tabs[id]) {
      S.tabs[id] = { id: id, def: null, staged: {}, bindings: {}, listeners: {}, saved: [], discarded: [],
                     before: [], mounted: false, mounting: null, api: null };
    }
    return S.tabs[id];
  }

  function metaFor(key) {
    if (S.meta[key]) return S.meta[key];
    return S.meta[String(key).replace(/\.\d+\./, '.{id}.')] || null;
  }

  function baseline(key) {
    if (hasOwn(S.values, key)) return String(S.values[key]);
    var m = metaFor(key);
    return m ? String(m.default) : '';
  }

  function sameAsBaseline(key, value) {
    var m = metaFor(key);
    if (m && m.type === 'color') return value.toLowerCase() === baseline(key).toLowerCase();
    return value === baseline(key);
  }

  function current(t, key) { return hasOwn(t.staged, key) ? t.staged[key] : baseline(key); }

  function notify(t, key) {
    var value = current(t, key);
    (t.listeners[key] || []).forEach(function (fn) {
      try { fn(value); } catch (e) { if (window.console) console.error(e); }
    });
  }

  function dirtyCount(id) { return id && S.tabs[id] ? Object.keys(S.tabs[id].staged).length : 0; }
  function anyDirty() { return TABS.some(function (id) { return dirtyCount(id) > 0; }); }
  function changes(n) { return n + ' unsaved change' + (n === 1 ? '' : 's'); }
  function uid(key) { return 'ws-f-' + String(key).replace(/[^A-Za-z0-9]+/g, '-'); }

  function showError(b, message) {
    if (b.el) {
      b.el.classList.toggle('ws-invalid', !!message);
      if (message) b.el.setAttribute('aria-invalid', 'true'); else b.el.removeAttribute('aria-invalid');
    }
    if (b.errorEl) {
      b.errorEl.textContent = '';
      if (message) {
        b.errorEl.appendChild(icon('error', 'text-base'));
        b.errorEl.appendChild(document.createTextNode(message));
      }
      b.errorEl.classList.toggle('hidden', !message);
    }
  }

  // label + control (+ suffix) + help + error line, or just the control when compact.
  function fieldShell(o, control, row) {
    row = row || control;
    var root = el('div', 'min-w-0');
    if (o.compact) {
      control.setAttribute('aria-label', o.label || o.key);
    } else {
      var label = el('label', cls.label, o.label || '');
      label.htmlFor = control.id;
      root.appendChild(label);
    }
    if (o.suffix) {
      var wrap = el('div', 'flex items-center gap-2');
      wrap.appendChild(row);
      wrap.appendChild(el('span', 'text-[13px] text-frosted-blue/45 shrink-0', o.suffix));
      row = wrap;
    }
    root.appendChild(row);
    var described = [];
    if (o.help && !o.compact) {
      var help = el('p', cls.help, o.help);
      help.id = control.id + '-help';
      described.push(help.id);
      root.appendChild(help);
    }
    var err = el('p', cls.error + ' hidden');
    err.id = control.id + '-error';
    err.setAttribute('role', 'alert');
    if (!o.compact) described.push(err.id);
    if (described.length) control.setAttribute('aria-describedby', described.join(' '));
    root.appendChild(err);
    return { root: root, error: o.compact ? null : err };
  }

  function hexToRgb(h) {
    return parseInt(h.slice(1, 3), 16) + ' ' + parseInt(h.slice(3, 5), 16) + ' ' + parseInt(h.slice(5, 7), 16);
  }

  function openIconDialog(currentName, onPick) {
    var picked = currentName || '';
    var body = el('div');
    var search = el('input', cls.input);
    search.type = 'search';
    search.placeholder = 'Search, or type any Material Symbols name';
    search.setAttribute('aria-label', 'Search icons');
    var grid = el('div', 'mt-3 grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-[45vh] overflow-y-auto');
    function render() {
      var q = search.value.trim().toLowerCase();
      grid.replaceChildren();
      var names = ICONS.filter(function (n) { return !q || n.indexOf(q) !== -1; });
      if (q && /^[a-z0-9_]{1,64}$/.test(q) && names.indexOf(q) === -1) names.unshift(q);
      names.forEach(function (n) {
        var b = el('button', 'flex flex-col items-center gap-1 p-2 rounded-[10px] border transition-colors ' +
          (n === picked ? 'border-primary bg-primary/20' : 'border-transparent hover:bg-frosted-blue/[0.06]'));
        b.type = 'button';
        b.setAttribute('aria-pressed', n === picked ? 'true' : 'false');
        b.setAttribute('aria-label', n);
        b.appendChild(icon(n, 'text-[24px] text-frosted-blue'));
        b.appendChild(el('span', 'text-xs text-frosted-blue/45 truncate w-full text-center', n));
        b.addEventListener('click', function () { picked = n; render(); });
        grid.appendChild(b);
      });
    }
    search.addEventListener('input', render);
    body.appendChild(search);
    body.appendChild(grid);
    render();
    UI.confirm({ title: 'Choose an icon', body: body, confirmLabel: 'Use this icon' }).then(function (ok) {
      if (ok && picked) onPick(picked);
    });
    setTimeout(function () { search.focus(); }, 30);
  }

  function makeApi(t) {
    var api = {};

    function stage(key, value, fromControl) {
      value = value == null ? '' : String(value);
      if (sameAsBaseline(key, value)) delete t.staged[key]; else t.staged[key] = value;
      var b = t.bindings[key];
      if (b) { if (!fromControl) b.set(current(t, key)); showError(b, null); }
      S.failed = false;
      notify(t, key);
      refreshBar();
    }

    api.get = function (key) { return current(t, key); };
    api.set = function (key, value) { stage(key, value, false); };
    api.track = function (key, b) { t.bindings[key] = b; b.set(current(t, key)); };
    api.stageDefaults = function (keys) {
      keys.forEach(function (k) { var m = metaFor(k); if (m) stage(k, m.default, false); });
    };
    api.onChange = function (key, fn) { (t.listeners[key] = t.listeners[key] || []).push(fn); };
    api.onSaved = function (fn) { t.saved.push(fn); };
    api.onDiscard = function (fn) { t.discarded.push(fn); };
    api.beforeSave = function (fn) { t.before.push(fn); };
    api.fieldError = function (key, message) {
      var b = t.bindings[key];
      if (b) showError(b, message);
      return !!b;
    };
    api.dirtyKeys = function () { return Object.keys(t.staged); };
    api.save = function () { return save(t.id); };

    api.text = function (o) {
      var input = el('input', cls.input);
      input.id = uid(o.key);
      input.type = o.inputType || 'text';
      input.autocomplete = 'off';
      if (o.inputType === 'url') input.spellcheck = false;
      if (o.placeholder) input.placeholder = o.placeholder;
      var m = metaFor(o.key) || {};
      if (o.inputType === 'number') {
        input.inputMode = 'numeric';
        var lo = o.min != null ? o.min : m.min, hi = o.max != null ? o.max : m.max;
        if (lo != null) input.min = lo;
        if (hi != null) input.max = hi;
      } else if (m.max_length) {
        input.maxLength = m.max_length;
      }
      if (o.disabled) input.disabled = true;
      var shell = fieldShell(o, input);
      input.addEventListener('input', function () { stage(o.key, input.value, true); });
      api.track(o.key, { get: function () { return input.value; }, set: function (v) { input.value = v; },
                         el: input, errorEl: shell.error });
      return shell.root;
    };

    api.textarea = function (o) {
      var ta = el('textarea', cls.input + (o.monospace ? ' font-mono text-[13px]' : ''));
      ta.id = uid(o.key);
      ta.rows = o.rows || 6;
      ta.spellcheck = !o.monospace;
      var m = metaFor(o.key) || {};
      if (m.max_length) ta.maxLength = m.max_length;
      var shell = fieldShell(o, ta);
      ta.addEventListener('input', function () { stage(o.key, ta.value, true); });
      api.track(o.key, { get: function () { return ta.value; }, set: function (v) { ta.value = v; },
                         el: ta, errorEl: shell.error });
      return shell.root;
    };

    api.toggle = function (o) {
      var btn = el('button', 'ws-switch');
      btn.type = 'button';
      btn.id = uid(o.key);
      btn.setAttribute('role', 'switch');
      if (o.locked) btn.disabled = true;
      function paint(v) { btn.setAttribute('aria-checked', v === 'true' ? 'true' : 'false'); }
      function get() { return btn.getAttribute('aria-checked') === 'true' ? 'true' : 'false'; }
      btn.addEventListener('click', function () {
        if (!o.locked) stage(o.key, get() === 'true' ? 'false' : 'true', false);
      });
      if (o.compact) {
        btn.setAttribute('aria-label', o.label || o.key);
        if (o.locked && o.lockedReason) btn.title = o.lockedReason;
        api.track(o.key, { get: get, set: paint, el: btn, errorEl: null });
        return btn;
      }
      var root = el('div', 'flex items-start justify-between gap-4');
      var text = el('div', 'min-w-0');
      var label = el('label', 'block text-[15px] font-semibold text-frosted-blue', o.label || '');
      label.htmlFor = btn.id;
      text.appendChild(label);
      var described = [];
      var helpText = o.locked && o.lockedReason ? o.lockedReason : o.help;
      if (helpText) {
        var help = el('p', 'text-[13px] text-frosted-blue/45 mt-0.5', helpText);
        help.id = btn.id + '-help';
        described.push(help.id);
        text.appendChild(help);
      }
      var err = el('p', cls.error + ' hidden');
      err.id = btn.id + '-error';
      err.setAttribute('role', 'alert');
      described.push(err.id);
      btn.setAttribute('aria-describedby', described.join(' '));
      text.appendChild(err);
      root.appendChild(text);
      root.appendChild(btn);
      api.track(o.key, { get: get, set: paint, el: btn, errorEl: err });
      return root;
    };

    api.select = function (o) {
      var sel = el('select', cls.input + ' pr-10');
      sel.id = uid(o.key);
      (o.options || []).forEach(function (opt) {
        var op = el('option', null, opt.label);
        op.value = opt.value;
        sel.appendChild(op);
      });
      var shell = fieldShell(o, sel);
      // A stored value that isn't one of the options (an old or hand-edited
      // row) stays selected as itself, in a hidden option that can't be
      // picked, so the box never shows blank and nothing is staged until the
      // admin chooses.
      var stray = null;
      function paint(v) {
        var known = (o.options || []).some(function (opt) { return String(opt.value) === v; });
        if (!known) {
          if (!stray) {
            stray = el('option');
            stray.disabled = true;
            stray.hidden = true;
            sel.insertBefore(stray, sel.firstChild);
          }
          stray.value = v;
          stray.textContent = v === '' ? 'Not set' : v;
          stray.selected = true;
        } else {
          sel.value = v;
        }
      }
      sel.addEventListener('change', function () { stage(o.key, sel.value, true); });
      api.track(o.key, { get: function () { return sel.value; }, set: paint, el: sel, errorEl: shell.error });
      return shell.root;
    };

    api.color = function (o) {
      var hex = el('input', cls.input + ' font-mono uppercase');
      hex.id = uid(o.key);
      hex.maxLength = 7;
      hex.spellcheck = false;
      hex.autocomplete = 'off';
      var picker = el('input', 'h-11 w-12 shrink-0 cursor-pointer rounded-[10px] border border-frosted-blue/10 bg-transparent p-1');
      picker.type = 'color';
      picker.setAttribute('aria-label', (o.label || '') + ' picker');
      var row = el('div', 'flex items-center gap-3');
      row.appendChild(picker);
      row.appendChild(hex);
      var shell = fieldShell(o, hex, row);
      function preview(v) {
        if (!o.cssVar || !HEX.test(v)) return;
        var st = document.documentElement.style;
        st.setProperty('--color-' + o.cssVar, hexToRgb(v));
        st.setProperty('--hex-' + o.cssVar, v);
      }
      picker.addEventListener('input', function () {
        hex.value = picker.value.toUpperCase();
        preview(hex.value);
        stage(o.key, hex.value, true);
      });
      hex.addEventListener('input', function () {
        var v = hex.value.trim();
        if (HEX.test(v)) { picker.value = v.toLowerCase(); preview(v); }
        stage(o.key, v, true);
      });
      api.track(o.key, {
        get: function () { return hex.value; },
        set: function (v) { hex.value = v; if (HEX.test(v)) { picker.value = v.toLowerCase(); preview(v); } },
        el: hex, errorEl: shell.error
      });
      return shell.root;
    };

    api.iconPicker = function (o) {
      var btn = el('button', o.compact
        ? 'inline-flex items-center justify-center size-10 shrink-0 rounded-[10px] bg-frosted-blue/[0.04] ' +
          'border border-frosted-blue/10 hover:bg-frosted-blue/10 transition-colors focus-visible:outline ' +
          'focus-visible:outline-2 focus-visible:outline-primary'
        : cls.btnGhost + ' w-full justify-start');
      btn.type = 'button';
      btn.id = uid(o.key);
      var glyph = icon('', 'text-[22px] text-frosted-blue');
      var name = o.compact ? null : el('span', 'truncate font-mono text-[13px] text-frosted-blue/70');
      btn.appendChild(glyph);
      if (name) btn.appendChild(name);
      var value = '';
      function paint(v) {
        value = v || '';
        glyph.textContent = v || 'help';
        if (name) name.textContent = v;
        btn.setAttribute('aria-label', (o.label || 'Icon') + ': ' + (v || 'none') + '. Change icon');
      }
      btn.addEventListener('click', function () {
        openIconDialog(api.get(o.key), function (chosen) { stage(o.key, chosen, false); });
      });
      var binding = { get: function () { return value; }, set: paint, el: btn, errorEl: null };
      if (o.compact) {
        api.track(o.key, binding);
        return btn;
      }
      var shell = fieldShell(o, btn);
      binding.errorEl = shell.error;
      api.track(o.key, binding);
      return shell.root;
    };

    api.secret = function (o) {
      var root = el('div', 'min-w-0');
      var label = el('p', cls.label, o.label || '');
      label.id = uid(o.key) + '-label';
      root.appendChild(label);

      var savedRow = el('div', 'flex flex-wrap items-center gap-2');
      var chip = el('span', 'inline-flex items-center gap-1.5 px-3 py-2 rounded-[10px] bg-frosted-blue/[0.06] ' +
        'text-[13px] font-semibold text-frosted-blue');
      chip.appendChild(icon('lock', 'text-base'));
      chip.appendChild(document.createTextNode('Saved'));
      var replaceBtn = el('button', cls.btnQuiet, 'Replace');
      replaceBtn.type = 'button';
      var clearBtn = el('button', cls.btnQuiet, 'Clear');
      clearBtn.type = 'button';
      savedRow.appendChild(chip);
      savedRow.appendChild(replaceBtn);
      savedRow.appendChild(clearBtn);

      var clearedRow = el('div', 'hidden flex flex-wrap items-center gap-2');
      clearedRow.appendChild(el('span', 'text-[13px] text-frosted-blue/70', 'Will be removed when you save.'));
      var undo = el('button', cls.btnQuiet, 'Undo');
      undo.type = 'button';
      clearedRow.appendChild(undo);

      var inputRow = el('div', 'hidden flex items-center gap-2');
      var input = el('input', cls.input);
      input.type = 'password';
      input.id = uid(o.key);
      input.autocomplete = 'new-password';
      input.spellcheck = false;
      input.setAttribute('aria-labelledby', label.id);
      var cancel = el('button', cls.btnQuiet, 'Cancel');
      cancel.type = 'button';
      inputRow.appendChild(input);
      inputRow.appendChild(cancel);

      root.appendChild(savedRow);
      root.appendChild(clearedRow);
      root.appendChild(inputRow);
      var described = [];
      if (o.help) {
        var help = el('p', cls.help, o.help);
        help.id = input.id + '-help';
        described.push(help.id);
        root.appendChild(help);
      }
      var err = el('p', cls.error + ' hidden');
      err.id = input.id + '-error';
      err.setAttribute('role', 'alert');
      described.push(err.id);
      input.setAttribute('aria-describedby', described.join(' '));
      root.appendChild(err);

      function mode(m) {
        savedRow.classList.toggle('hidden', m !== 'saved');
        clearedRow.classList.toggle('hidden', m !== 'cleared');
        inputRow.classList.toggle('hidden', m !== 'input');
        cancel.classList.toggle('hidden', baseline(o.key) !== S.mask);
      }
      // Never writes a secret into the input: the browser only ever holds the mask.
      function paint(v) {
        if (v === S.mask) { input.value = ''; mode('saved'); }
        else if (v === '' && baseline(o.key) === S.mask) { input.value = ''; mode('cleared'); }
        else { if (v === '') input.value = ''; mode('input'); }
      }
      replaceBtn.addEventListener('click', function () { mode('input'); input.focus(); });
      clearBtn.addEventListener('click', function () { stage(o.key, '', false); });
      undo.addEventListener('click', function () { stage(o.key, S.mask, false); });
      cancel.addEventListener('click', function () { stage(o.key, S.mask, false); });
      var binding = { get: function () { return input.value; }, set: paint, el: input, errorEl: err };
      input.addEventListener('input', function () {
        if (input.value === S.mask) {
          // The placeholder itself would read as "unchanged" (or be skipped
          // by the server), so it can't be a key. Nothing is staged.
          stage(o.key, baseline(o.key), true);
          showError(binding, MSG.maskText);
          return;
        }
        stage(o.key, input.value === '' ? baseline(o.key) : input.value, true);
      });
      api.track(o.key, binding);
      return root;
    };

    return api;
  }

  // ---- Save bar ----

  function buildBar() {
    bar = document.getElementById('settingsSaveBar');
    bar.className = 'ws-savebar is-hidden fixed z-[60] inset-x-0 bottom-0 lg:inset-x-auto lg:right-8 lg:bottom-6 ' +
      'flex items-center gap-3 px-4 py-3 lg:pl-5 border-t lg:border border-frosted-blue/10 lg:rounded-2xl ' +
      'bg-background-dark/85 backdrop-blur-md shadow-2xl';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Unsaved changes');
    bar.inert = true;
    barText = el('p', 'flex-1 lg:flex-none lg:mr-4 text-sm font-semibold text-frosted-blue');
    barText.setAttribute('aria-live', 'polite');
    // While a save runs the buttons are aria-disabled rather than disabled, so
    // keyboard focus stays on Save instead of dropping to the page.
    var busyCls = ' aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';
    barDiscard = el('button', cls.btnGhost + busyCls, 'Discard');
    barDiscard.type = 'button';
    barSave = el('button', cls.btnPrimary + busyCls + ' min-w-[6.5rem]', 'Save');   // "Saving…" fits: the bar keeps its width
    barSave.type = 'button';
    bar.appendChild(barText);
    bar.appendChild(barDiscard);
    bar.appendChild(barSave);
    bar.removeAttribute('hidden');
    barDiscard.addEventListener('click', function () { if (!S.busy) discard(S.current); });
    barSave.addEventListener('click', function () { save(S.current); });
  }

  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  function refreshBar() {
    if (!bar) return;
    var n = dirtyCount(S.current);
    var show = n > 0 || S.saving;
    if (!show && bar.contains(document.activeElement)) {
      // The bar is leaving with focus inside it: focus goes to the tab's panel
      // (the next Tab reaches its first field), without scrolling the page.
      var host = panelHost(S.current);
      if (host) {
        host.tabIndex = -1;
        host.classList.add('focus:outline-none');
        host.focus({ preventScroll: true });
      }
    }
    bar.classList.toggle('is-hidden', !show);
    // Hidden, the bar is out of the tab order and the accessibility tree.
    bar.inert = !show;
    barDiscard.tabIndex = show ? 0 : -1;
    barSave.tabIndex = show ? 0 : -1;
    document.body.classList.toggle('ws-savebar-open', show);
    if (show) setText(barText, S.failed ? 'Couldn’t save — try again' : changes(n));
    barSave.setAttribute('aria-disabled', S.busy ? 'true' : 'false');
    barDiscard.setAttribute('aria-disabled', S.busy ? 'true' : 'false');
    setText(barSave, S.saving ? 'Saving…' : 'Save');
  }

  function save(id) {
    var t = S.tabs[id];
    if (!t || !Object.keys(t.staged).length) return Promise.resolve(true);
    if (S.busy) return Promise.resolve(false);
    S.busy = true;
    refreshBar();
    var keys = Object.keys(t.staged);
    return t.before.reduce(function (p, fn) {
      return p.then(function (ok) { return ok ? fn(keys.slice()) : false; });
    }, Promise.resolve(true)).then(function (ok) {
      // A hook may stage more keys, so the batch is read again after them.
      if (!ok) return false;
      var now = Object.keys(t.staged);
      return now.length ? send(t, now) : true;
    }).catch(function (e) {
      if (window.console) console.error(e);
      UI.toast(MSG.failed, 'err');
      return false;
    }).then(function (result) {
      S.busy = false;
      refreshBar();
      return result;
    });
  }

  function send(t, keys) {
    var sent = {};
    keys.forEach(function (k) { sent[k] = t.staged[k]; });
    S.saving = true;
    refreshBar();
    var payload = { settings: keys.map(function (k) { return { key: k, value: sent[k] }; }) };
    return fetch('/api/admin/settings/bulk', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      credentials: 'same-origin'
    }).then(function (r) {
      // Read the body as text: a proxy error page or an empty body must not
      // surface as a parser error.
      return r.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        return settle(t, sent, r.status, r.ok, data && typeof data === 'object' ? data : null);
      }, function () { return settle(t, sent, r.status, r.ok, null); });
    }, function () {
      return fail(MSG.offline);
    }).then(function (result) {
      S.saving = false;
      refreshBar();
      return result;
    });
  }

  function fail(message) {
    S.failed = true;
    UI.toast(message, 'err');
    return false;
  }

  function settle(t, sent, status, ok, data) {
    if (status === 401) {
      // The session has ended; nothing here can be saved. Sign in again.
      leave('/login');
      return false;
    }
    if (ok) {
      if (data && data.values && typeof data.values === 'object') return applySaved(t, sent, data.values);
      return fail(MSG.unconfirmed);
    }
    if (status === 422 || status === 403) S.failed = false;    // an answer, not a hiccup: retrying won't help
    if (status === 422) {
      var errors = data && data.errors;
      if (errors && typeof errors === 'object' && !Array.isArray(errors) && Object.keys(errors).length) {
        applyErrors(t, sent, errors);
        return false;
      }
      // FastAPI's own 422 (a malformed request) carries a list, not a message.
      UI.toast(data && typeof data.detail === 'string' && data.detail ? data.detail : MSG.unreadable, 'err');
      return false;
    }
    if (status === 403) { UI.toast(MSG.forbidden, 'err'); return false; }
    if (status === 429) return fail(MSG.busy);
    if (status === 503 && data && typeof data.detail === 'string' && data.detail) return fail(data.detail);
    return fail(MSG.failed);
  }

  function applySaved(t, sent, values) {
    // The server answers with every key it wrote. One it skipped (a secret
    // sent as the mask means "leave it as it is") was not saved, whatever the
    // status says: it stays staged and marked, and nobody is told "Saved".
    var keys = [], dropped = [];
    Object.keys(sent).forEach(function (k) { if (!hasOwn(values, k)) dropped.push(k); else keys.push(k); });
    keys.forEach(function (k) {
      if (values[k] != null) S.values[k] = String(values[k]);
      // Typing that landed while the save was in flight stays staged.
      if (t.staged[k] === sent[k] || (hasOwn(t.staged, k) && sameAsBaseline(k, t.staged[k]))) {
        delete t.staged[k];
        var b = t.bindings[k];
        if (b) { b.set(baseline(k)); showError(b, null); }
      }
      notify(t, k);
    });
    dropped.forEach(function (k) {
      var b = t.bindings[k], m = metaFor(k);
      if (b) showError(b, m && m.secret && sent[k] === S.mask ? MSG.maskText : MSG.notSaved);
    });
    S.failed = false;
    if (keys.length) {
      t.saved.forEach(function (fn) {
        try { fn(keys, values); } catch (e) { if (window.console) console.error(e); }
      });
      document.dispatchEvent(new CustomEvent('ws-settings:saved', { detail: { tab: t.id, keys: keys, values: values } }));
    }
    if (dropped.length) { UI.toast(MSG.partial, 'err'); return false; }
    UI.toast('Saved', 'ok');
    return true;
  }

  function applyErrors(t, sent, errors) {
    var first = null, unbound = null;
    Object.keys(sent).forEach(function (k) {
      if (!hasOwn(errors, k) && t.bindings[k]) showError(t.bindings[k], null);
    });
    Object.keys(errors).forEach(function (k) {
      var message = typeof errors[k] === 'string' && errors[k] ? errors[k] : MSG.invalid;
      var b = t.bindings[k];
      if (b && (b.errorEl || b.el)) { showError(b, message); if (!first && b.el) first = b.el; }
      else if (!unbound) unbound = message;
    });
    // A key with no control on this tab (the sign-in lockout, say) is told in the toast.
    UI.toast(unbound || MSG.fix, 'err');
    if (first && first.focus) first.focus();
  }

  function discard(id) {
    var t = S.tabs[id];
    if (!t) return;
    Object.keys(t.staged).forEach(function (k) {
      delete t.staged[k];
      var b = t.bindings[k];
      if (b) { b.set(baseline(k)); showError(b, null); }
      notify(t, k);
    });
    S.failed = false;
    t.discarded.forEach(function (fn) {
      try { fn(); } catch (e) { if (window.console) console.error(e); }
    });
    document.dispatchEvent(new CustomEvent('ws-settings:discarded', { detail: { tab: id } }));
    refreshBar();
  }

  // ---- Tabs ----

  function tabFromHash() {
    var h = (location.hash || '').slice(1);
    return TABS.indexOf(h) >= 0 ? h : 'general';
  }

  // Scroll the tab strip (never the page) so the tab sits clear of the edge fades.
  function revealTab(a, smooth) {
    var sc = document.getElementById('settingsTabScroller');
    if (!sc || !a || sc.scrollWidth <= sc.clientWidth) return;
    var r = a.getBoundingClientRect(), s = sc.getBoundingClientRect(), pad = 48, dx = 0;
    if (r.left < s.left + pad) dx = r.left - s.left - pad;
    else if (r.right > s.right - pad) dx = r.right - s.right + pad;
    if (!dx) return;
    if (smooth && !reducedMotion() && sc.scrollBy) sc.scrollBy({ left: dx, behavior: 'smooth' });
    else sc.scrollLeft += dx;
  }

  // The selected look is CSS on html[data-settings-tab] (set in <head> for the
  // first paint); aria-selected and the roving tabindex follow it here.
  function paintTab(id, smooth) {
    document.documentElement.setAttribute('data-settings-tab', id);
    document.querySelectorAll('#settingsTabs [data-tab]').forEach(function (a) {
      var on = a.getAttribute('data-tab') === id;
      a.setAttribute('aria-selected', on ? 'true' : 'false');
      a.tabIndex = on ? 0 : -1;
    });
    revealTab(document.getElementById('tab-' + id), smooth);
  }

  function setHash(id, how) {
    var h = location.hash.slice(1);
    if (h === id || (!h && id === 'general')) return;     // no hash already means General
    if (how === 'push') history.pushState(null, '', '#' + id);
    else history.replaceState(null, '', '#' + id);
  }

  function switchTo(id, how) {
    S.current = id;
    paintTab(id, true);
    // After back/forward the URL is already right (a no-op); after a history
    // step that was held by the dialog it may not be.
    setHash(id, how === 'push' ? 'push' : 'replace');
    refreshBar();
    return mount(id).then(function () { return true; });
  }

  // how: 'push' (a click or go()), 'replace' (arrow keys) or 'history' (the
  // URL already moved: back/forward or an edited hash).
  function show(id, how) {
    if (TABS.indexOf(id) < 0) id = 'general';
    var from = S.current;
    if (id === from) return mount(id).then(function () { return true; });
    if (S.asking) {
      // The open dialog decides; a Back pressed meanwhile is held, and the
      // address bar goes back to the tab still shown.
      if (how === 'history') setHash(from, 'replace');
      return Promise.resolve(false);
    }
    if (UI.isDialogOpen()) {
      // Another dialog (the icon picker, say) belongs to this tab: finish or
      // cancel it first, so its answer can't land on a tab that has gone.
      if (how === 'history') setHash(from, 'replace');
      return Promise.resolve(false);
    }
    if (S.busy) {
      if (how === 'history') setHash(from, 'replace');
      return Promise.resolve(false);
    }
    var n = dirtyCount(from);
    if (!n) return switchTo(id, how);
    S.asking = true;
    return UI.confirm({
      title: 'Discard unsaved changes?',
      body: 'You have ' + changes(n) + ' on ' + TITLES[from] + '. Switching tabs throws ' +
        (n === 1 ? 'it' : 'them') + ' away.',
      confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', danger: true
    }).catch(function (e) {
      if (window.console) console.error(e);
      return false;                     // a dialog that failed counts as Keep editing
    }).then(function (ok) {
      S.asking = false;
      if (!ok) { setHash(from, 'replace'); return false; }
      discard(from);
      return switchTo(id, how);
    });
  }

  function loadModule(id) {
    if (tab(id).def) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var tpl = document.getElementById('settingsModules');
      var src = tpl && tpl.content.querySelector('script[data-tab="' + id + '"]');
      if (!src) { reject(new Error('No module for ' + id)); return; }
      var s = document.createElement('script');
      s.src = src.getAttribute('src');
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + s.src)); };
      document.body.appendChild(s);
    });
  }

  function panelHost(id) { return document.querySelector('[data-settings-panel="' + id + '"]'); }

  function showPanelError(id, message, retry) {
    var host = panelHost(id);
    if (!host) return;
    var box = el('div', 'py-16 text-center');
    box.appendChild(icon('cloud_off', 'text-[40px] text-frosted-blue/45'));
    box.appendChild(el('p', 'mt-3 text-[15px] font-semibold text-frosted-blue', message));
    var btn = el('button', cls.btnGhost + ' mt-4', 'Try again');
    btn.type = 'button';
    btn.addEventListener('click', retry);
    box.appendChild(btn);
    host.replaceChildren(box);
  }

  function afterShow(id) {
    document.dispatchEvent(new CustomEvent('ws-settings:tab', { detail: { tab: id } }));
    if (S.pendingFocus && S.pendingFocus.tab === id) {
      var target = document.getElementById(S.pendingFocus.id);
      S.pendingFocus = null;
      if (target) {
        target.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
        if (target.focus) target.focus({ preventScroll: true });
      }
    }
  }

  var LOAD_ERROR = 'Settings couldn’t load. Check your connection and try again.';

  function mount(id) {
    var t = tab(id);
    if (t.mounted) { afterShow(id); return Promise.resolve(); }
    if (t.mounting) return t.mounting;
    if (!S.loaded) {
      if (S.loadFailed) showPanelError(id, LOAD_ERROR, load);
      return Promise.resolve();
    }
    t.mounting = loadModule(id).then(function () {
      if (!t.def) throw new Error('Tab module did not register: ' + id);
      t.api = t.api || makeApi(t);
      var panel = el('div');
      return Promise.resolve(t.def.mount(panel, t.api)).then(function () {
        // One swap: the skeleton goes and the finished panel arrives together.
        var host = panelHost(id);
        host.replaceChildren(panel);
        host.classList.remove('ws-panel-in');
        void host.offsetWidth;
        host.classList.add('ws-panel-in');
        t.mounted = true;
        t.mounting = null;
        if (S.current === id) afterShow(id);
      });
    }).catch(function (e) {
      if (window.console) console.error(e);
      t.mounting = null;
      t.api = null;
      t.bindings = {};
      t.listeners = {};
      t.saved = []; t.discarded = []; t.before = [];
      showPanelError(id, 'This section couldn’t load.', function () { mount(id); });
    });
    return t.mounting;
  }

  function registerTab(id, def) { tab(id).def = def; }

  function go(tabId, focusId) {
    S.pendingFocus = focusId ? { tab: tabId, id: focusId } : null;
    return show(tabId, 'push');
  }

  function wireTabs() {
    var list = document.getElementById('settingsTabs');
    list.addEventListener('click', function (e) {
      var a = e.target.closest('[data-tab]');
      if (!a) return;
      e.preventDefault();
      show(a.getAttribute('data-tab'), 'push');
    });
    list.addEventListener('keydown', function (e) {
      var keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (keys.indexOf(e.key) < 0) return;
      e.preventDefault();
      var i = TABS.indexOf(S.current);
      var next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1
        : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      show(TABS[next], 'replace').then(function () {
        var a = document.getElementById('tab-' + S.current);
        if (a) a.focus();
      });
    });
    // Back/forward fires popstate and, when only the hash differs, hashchange
    // too; an edited hash fires hashchange. The second of a pair is a no-op.
    function fromHistory() {
      var id = tabFromHash();
      if (id !== S.current) show(id, 'history');
    }
    window.addEventListener('popstate', fromHistory);
    window.addEventListener('hashchange', fromHistory);

    var scroller = document.getElementById('settingsTabScroller');
    var left = document.getElementById('settingsTabHintLeft');
    var right = document.getElementById('settingsTabHintRight');
    function hints() {
      var atStart = scroller.scrollLeft <= 4;
      var atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4;
      if (left) left.style.opacity = atStart ? '0' : '1';
      if (right) right.style.opacity = atEnd ? '0' : '1';
    }
    if (scroller) {
      scroller.addEventListener('scroll', hints, { passive: true });
      window.addEventListener('resize', hints);
      if ('ResizeObserver' in window) new ResizeObserver(hints).observe(scroller);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(hints);
      hints();
    }
  }

  // ---- Leave guard ----

  // Leave the page on purpose (a sign-in redirect, a reload after an import):
  // the beforeunload guard stands down, so the browser doesn't ask as well.
  // No url reloads the page.
  function leave(url) {
    S.leaving = true;
    if (url) window.location.href = url;
    else window.location.reload();
  }
  //
  // Links inside the app ask with the kit's dialog. Anything else that leaves
  // (reload, closing the tab, a typed address, the browser's own back to
  // another page) can only be asked by the browser, via beforeunload.
  function wireLeaveGuard() {
    window.addEventListener('beforeunload', function (e) {
      if (!S.leaving && anyDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
      var url;
      try { url = new URL(a.href, location.href); } catch (err) { return; }
      if (!/^https?:$/.test(url.protocol)) return;
      if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
      if (!anyDirty() || S.leaving) return;
      e.preventDefault();
      var n = TABS.reduce(function (sum, id) { return sum + dirtyCount(id); }, 0);
      UI.confirm({
        title: 'Leave without saving?',
        body: 'You have ' + changes(n) + ' in Settings. Leaving this page throws ' +
          (n === 1 ? 'it' : 'them') + ' away.',
        confirmLabel: 'Leave page', cancelLabel: 'Keep editing', danger: true
      }).then(function (ok) {
        if (ok) leave(url.href);
      });
    });
  }

  function load() {
    S.loadFailed = false;
    return fetch('/api/admin/settings?view=registry', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { leave('/login'); throw new Error('HTTP 401'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      if (!data || typeof data.mask !== 'string' || !data.values || !data.meta) throw new Error('Unexpected settings view');
      S.values = data.values;
      S.meta = data.meta;
      S.mask = data.mask;
      S.loaded = true;
      return mount(S.current);
    }).catch(function (e) {
      if (window.console) console.error(e);
      S.loadFailed = true;
      showPanelError(S.current, LOAD_ERROR, load);
    });
  }

  function boot() {
    if (S.booted) return;
    S.booted = true;
    buildBar();
    wireTabs();
    wireLeaveGuard();
    S.current = tabFromHash();
    // An unknown hash reads as General; the URL says so too.
    if (location.hash && location.hash.slice(1) !== S.current) setHash(S.current, 'replace');
    paintTab(S.current, false);
    load();
  }

  function card(title, description) {
    var root = el('section', 'mb-12 last:mb-0');
    var head = el('div', 'mb-5');
    head.appendChild(el('h2', 'text-[20px] font-bold tracking-tight text-frosted-blue', title));
    if (description) head.appendChild(el('p', 'text-[15px] text-frosted-blue/70 mt-1 max-w-2xl', description));
    root.appendChild(head);
    var body = el('div', 'space-y-6');
    root.appendChild(body);
    return { root: root, body: body };
  }

  var WSSettings = {
    boot: boot, registerTab: registerTab, go: go, metaFor: metaFor, card: card, leave: leave,
    toast: UI.toast, confirm: UI.confirm, el: el, icon: icon, cls: cls
  };
  Object.defineProperty(WSSettings, 'values', { get: function () { return S.values; } });
  Object.defineProperty(WSSettings, 'meta', { get: function () { return S.meta; } });
  // What a saved secret reads as in `values`, from the server (null until loaded).
  Object.defineProperty(WSSettings, 'MASK', { get: function () { return S.mask; } });
  window.WSSettings = WSSettings;
})();
