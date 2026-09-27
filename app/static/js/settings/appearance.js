/**
 * Settings > Appearance: colours (with a live preview), Home's gauge colours,
 * status colours, font, custom CSS.
 *
 * Contrast guard: as colours change, the pairs the site leans on (PAIRS) are
 * measured with WCAG 2's formula and any that fall short get a plain warning
 * under the field. Saving text that is very hard to read on the background
 * (under 3:1) asks first, and names the safe-colours address that shows
 * Settings in the original colours; it never refuses.
 *
 * Colour and font edits restyle the page as you type; Discard, switching tab
 * or leaving reverts them because the kit repaints every control from its
 * saved value. "Reset this tab" only stages the registry defaults.
 *
 * The font preview loads the chosen Google Font beside the page's own and
 * points --font-display at it once it has loaded, so the page restyles once.
 * Back on the saved font, the preview stylesheets are removed and
 * --font-display gets the saved font's value back. A saved font's stylesheet
 * stops being a preview and becomes the page's own. Names are checked with
 * the registry's pattern, read from meta, before anything is fetched.
 */
(function () {
  'use strict';

  var el = WSSettings.el, icon = WSSettings.icon, cls = WSSettings.cls;
  var COLORS = [
    ['theme.color_primary', 'Primary', 'primary', 'Buttons, the current page and highlights.'],
    ['theme.color_secondary', 'Secondary', 'secondary', 'Supporting surfaces.'],
    ['theme.color_accent', 'Accent', 'accent', 'Icons and quieter labels.'],
    ['theme.color_text', 'Text', 'text', 'Most of the words on the site.'],
    ['theme.color_text_secondary', 'Bright text', 'text-secondary', 'Text on buttons and strong highlights.'],
    ['theme.color_background', 'Background', 'background', 'Behind everything.']
  ];
  var MEDIA = [
    ['theme.color_media_movie', 'Movies', 'media-movie'],
    ['theme.color_media_tv', 'TV shows', 'media-tv'],
    ['theme.color_media_book', 'Books', 'media-book']
  ];
  var NEW_FLAG = ['theme.color_new_flag', 'New! flag', 'new-flag', 'Marks a page as new in the sidebar.'];
  // One colour per state drives the dot, the ring and (on warn and err only)
  // the words, everywhere a status shows.
  var STATUS = [
    ['theme.color_status_ok', 'Online', 'status-ok'],
    ['theme.color_status_warn', 'Degraded', 'status-warn'],
    ['theme.color_status_err', 'Offline', 'status-err']
  ];
  // Home's CPU, RAM and network gauges: the accent unless Colourful gauges is
  // on, then each its own colour. Rings, not words, so the contrast guard
  // (text, and the New! flag's lettering) doesn't measure them.
  var GAUGES_ON = 'theme.gauges_colourful';
  var GAUGES = [
    ['theme.color_gauge_cpu', 'CPU', 'gauge-cpu'],
    ['theme.color_gauge_ram', 'RAM', 'gauge-ram'],
    ['theme.color_gauge_net', 'Network', 'gauge-net']
  ];
  // Choices offered in the list; any Google Font name can be typed instead.
  var FONTS = ['Spline Sans', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito',
    'Raleway', 'Source Sans 3', 'Ubuntu', 'Outfit', 'Space Grotesk', 'DM Sans', 'Manrope', 'Plus Jakarta Sans',
    'Sora', 'Lexend', 'Figtree', 'Work Sans', 'Jost', 'Albert Sans', 'Barlow', 'Red Hat Display', 'Rubik',
    'Nunito Sans', 'Cabin', 'Karla', 'Quicksand', 'Exo 2'];
  var KEYS = COLORS.map(function (c) { return c[0]; })
    .concat(MEDIA.map(function (m) { return m[0]; }), [NEW_FLAG[0]], [GAUGES_ON],
      GAUGES.map(function (g) { return g[0]; }), STATUS.map(function (x) { return x[0]; }),
      ['theme.font', 'theme.custom_css']);
  var OTHER = '__other__';
  var TYPING_DELAY = 600;       // ms after the last keystroke before a typed name is fetched

  // ---- Contrast (WCAG 2) ----
  function channel(v) {
    v = v / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function luminance(hex) {
    return 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
      0.0722 * channel(parseInt(hex.slice(5, 7), 16));
  }
  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // fg laid over bg at alpha, as the browser paints rgb(fg / alpha): a badge's tint.
  function tint(fg, bg, alpha) {
    var out = '#';
    for (var i = 1; i < 7; i += 2) {
      var v = Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha));
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }
  // ---- end contrast ----

  // The pairs the site leans on. min is 4.5:1 for text, 3:1 for the New!
  // flag (large, heavy and outlined). badge: measured on the colour's own 20%
  // tint over the background, as the badges paint it, which is never easier
  // than the bare background. The warning shows under the field named by on.
  var ON_BG = 'Hard to read on the background';
  var PAIRS = [
    { fg: 'theme.color_text', bg: 'theme.color_background', min: 4.5, on: 'theme.color_text', say: ON_BG },
    { fg: 'theme.color_text_secondary', bg: 'theme.color_background', min: 4.5, on: 'theme.color_text_secondary', say: ON_BG },
    { fg: 'theme.color_text_secondary', bg: 'theme.color_primary', min: 4.5, on: 'theme.color_primary',
      say: 'Button text (Bright text) is hard to read on this colour' },
    { fg: 'theme.color_media_movie', bg: 'theme.color_background', badge: true, min: 4.5, on: 'theme.color_media_movie',
      say: 'Hard to read on its badge' },
    { fg: 'theme.color_media_tv', bg: 'theme.color_background', badge: true, min: 4.5, on: 'theme.color_media_tv',
      say: 'Hard to read on its badge' },
    { fg: 'theme.color_media_book', bg: 'theme.color_background', badge: true, min: 4.5, on: 'theme.color_media_book',
      say: 'Hard to read on its badge' },
    { fg: 'theme.color_new_flag', bg: 'theme.color_background', min: 3, on: 'theme.color_new_flag',
      say: 'Hard to see on the background' },
    { fg: 'theme.color_status_ok', bg: 'theme.color_background', min: 4.5, on: 'theme.color_status_ok', say: ON_BG },
    { fg: 'theme.color_status_warn', bg: 'theme.color_background', min: 4.5, on: 'theme.color_status_warn', say: ON_BG },
    { fg: 'theme.color_status_err', bg: 'theme.color_background', min: 4.5, on: 'theme.color_status_err', say: ON_BG }
  ];
  var warnings = {};            // colour key -> its warning line

  // The colour the site paints for a key: what is being edited, or for a value
  // that isn't a colour, the registry default (what safe_color serves).
  function inUse(api, key) { return api.colorInUse(key); }

  // Rounded down, so a pair just under the line never reads as meeting it.
  function ratioText(r) { return r >= 10 ? String(Math.floor(r)) : (Math.floor(r * 10) / 10).toFixed(1); }

  function checkContrast(api) {
    var says = {};
    PAIRS.forEach(function (p) {
      var fg = inUse(api, p.fg), bg = inUse(api, p.bg);
      if (!fg || !bg) return;
      var r = contrast(fg, p.badge ? tint(fg, bg, 0.2) : bg);
      if (r >= p.min) return;
      (says[p.on] = says[p.on] || []).push(p.say + ' (contrast ' + ratioText(r) + ':1; aim for ' + p.min + ':1 or more).');
    });
    Object.keys(warnings).forEach(function (key) {
      var w = warnings[key], text = (says[key] || []).join(' ');
      if (w.getAttribute('data-says') === text) return;
      w.setAttribute('data-says', text);
      w.textContent = '';
      if (text) {
        w.appendChild(icon('warning', 'text-base'));
        w.appendChild(document.createTextNode(text));
      }
      w.classList.toggle('hidden', !text);
    });
  }

  // A kit colour field with a contrast warning line under it.
  function colourField(api, o) {
    var field = api.color(o);
    var input = field.querySelector('input:not([type="color"])');
    var w = el('p', cls.error + ' hidden');
    w.id = input.id + '-contrast';
    field.appendChild(w);
    input.setAttribute('aria-describedby', ((input.getAttribute('aria-describedby') || '') + ' ' + w.id).trim());
    warnings[o.key] = w;
    return field;
  }

  // ---- Font preview ----

  var root = document.documentElement;
  var fontRe = null;            // the registry's pattern, anchored; null means no preview
  var pageFont = null;          // the saved font: served with the page, or saved since
  var baseFont = null;          // the font pageFontVar shows (pageFont, once it has loaded)
  var pageFontVar = '';         // --font-display for baseFont, as the page or promote() set it
  var baseLink = null;          // a saved font's stylesheet (none: the server's own #ws-font)
  var shownFont = null;         // the font the page shows now
  var fontTimer = null;
  var fontSeq = 0;              // bumped on every change, so a font still loading can't land late
  var onFontMissing = function () {};

  function fontGuard() {
    var m = WSSettings.metaFor('theme.font');
    if (!m || !m.pattern) return null;
    try { return new RegExp('^(?:' + m.pattern + ')$'); } catch (e) { return null; }
  }

  // The saved font, at once: every preview stylesheet goes (the one shown
  // and any still loading) and --font-display is as it was for that font. A
  // font saved while it was still loading isn't on screen yet: fetch it.
  function revertFont() {
    clearTimeout(fontTimer);
    fontSeq += 1;
    document.querySelectorAll('link[data-ws-font-preview]').forEach(function (l) { l.remove(); });
    if (pageFontVar) root.style.setProperty('--font-display', pageFontVar);
    else root.style.removeProperty('--font-display');
    shownFont = baseFont;
    if (baseFont !== pageFont) loadFont(pageFont);
  }

  // The saved font's stylesheet stops being a preview: it is the page's own
  // now (until a reload serves it as #ws-font), and a revert comes back to it.
  function promote(link) {
    if (baseLink && baseLink !== link) baseLink.remove();
    link.removeAttribute('data-ws-font-preview');
    link.id = 'ws-font-saved';
    baseLink = link;
    baseFont = pageFont;
    pageFontVar = root.style.getPropertyValue('--font-display');
  }

  function loadFont(name) {
    var mine = fontSeq;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('data-ws-font-preview', '');
    link.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name) +
      ':wght@300;400;500;600;700&display=swap';
    function show() {
      if (mine !== fontSeq) { link.remove(); return; }
      var old = document.getElementById('ws-font-preview');
      if (old) old.remove();
      link.id = 'ws-font-preview';
      root.style.setProperty('--font-display', '"' + name + '", sans-serif');
      shownFont = name;
      if (name === pageFont) promote(link);
    }
    link.onload = function () {
      if (mine !== fontSeq) { link.remove(); return; }
      // Wait for the font file too, so the page changes once instead of
      // passing through a fallback font.
      var ready = document.fonts && document.fonts.load ? document.fonts.load('400 1em "' + name + '"') : null;
      if (ready) ready.then(show, show); else show();
    };
    link.onerror = function () {
      link.remove();
      if (mine === fontSeq) onFontMissing(name);
    };
    document.head.appendChild(link);
  }

  // Follows the value being painted: the page's own font at once; another
  // valid name after the typing pause (at once when picked from the list);
  // a name the server would refuse changes nothing.
  function previewFont(name, delay) {
    clearTimeout(fontTimer);
    fontSeq += 1;
    if (name === pageFont) { revertFont(); return; }
    if (name === shownFont || !fontRe || !fontRe.test(name)) return;
    if (delay) fontTimer = setTimeout(function () { loadFont(name); }, delay);
    else loadFont(name);
  }

  function fontControl(api) {
    var meta = WSSettings.metaFor('theme.font') || {};
    var wrap = el('div', 'min-w-0');
    var sel = el('select', cls.input + ' pr-10');
    sel.id = 'ws-f-theme-font';
    var label = el('label', cls.label, 'Font');
    label.htmlFor = sel.id;
    FONTS.forEach(function (f) { var o = el('option', null, f); o.value = f; sel.appendChild(o); });
    var other = el('option', null, 'Another Google Font…');
    other.value = OTHER;
    sel.appendChild(other);
    var custom = el('input', cls.input + ' mt-2 hidden');
    custom.id = 'ws-f-theme-font-name';
    custom.type = 'text';
    custom.autocomplete = 'off';
    custom.spellcheck = false;
    custom.placeholder = 'Font name from fonts.google.com';
    if (meta.max_length) custom.maxLength = meta.max_length;
    custom.setAttribute('aria-label', 'Google Font name');
    var HELP = 'Used on every page. Any font from fonts.google.com works.';
    var help = el('p', cls.help, HELP);
    help.id = sel.id + '-help';
    var err = el('p', cls.error + ' hidden');
    err.id = sel.id + '-error';
    err.setAttribute('role', 'alert');
    sel.setAttribute('aria-describedby', help.id + ' ' + err.id);
    custom.setAttribute('aria-describedby', help.id + ' ' + err.id);
    help.setAttribute('aria-live', 'polite');
    wrap.appendChild(label);
    wrap.appendChild(sel);
    wrap.appendChild(custom);
    wrap.appendChild(help);
    wrap.appendChild(err);

    var otherMode = false;
    function showOther(on) {
      if (on === otherMode) return;
      otherMode = on;
      custom.classList.toggle('hidden', !on);
      // An error mark belongs to the box that was showing.
      [sel, custom].forEach(function (n) { n.classList.remove('ws-invalid'); n.removeAttribute('aria-invalid'); });
    }
    onFontMissing = function (name) {
      help.textContent = 'Couldn’t load “' + name + '” from Google Fonts. Check the name matches fonts.google.com exactly, capitals included.';
    };

    function paint(v) {
      var typing = document.activeElement === custom;
      if (typing) {
        sel.value = OTHER;                    // never fight the typist
      } else if (FONTS.indexOf(v) >= 0) {
        sel.value = v;
        showOther(false);
      } else {
        sel.value = OTHER;
        showOther(true);
        custom.value = v;
      }
      if (help.textContent !== HELP) help.textContent = HELP;
      previewFont(v, typing ? TYPING_DELAY : 0);
    }
    sel.addEventListener('change', function () {
      if (sel.value === OTHER) {
        showOther(true);
        if (!custom.value.trim()) custom.value = api.get('theme.font');
        custom.focus();
        custom.select();
        api.set('theme.font', custom.value.trim());
      } else {
        showOther(false);
        api.set('theme.font', sel.value);
      }
    });
    custom.addEventListener('input', function () { api.set('theme.font', custom.value.trim()); });
    api.track('theme.font', {
      get: function () { return otherMode ? custom.value.trim() : sel.value; },
      set: paint,
      // The kit marks and focuses this on a refused save: the box in use.
      get el() { return otherMode ? custom : sel; },
      errorEl: err
    });
    return wrap;
  }

  // ---- Preview card ----

  function previewCard() {
    var box = el('div', 'rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] p-5 space-y-4');
    // In safe colours the kit shows the colours being edited here only.
    box.setAttribute('data-ws-theme-preview', '');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Preview');
    var head = el('div', 'flex items-center gap-2');
    head.appendChild(icon('palette', 'text-base text-steel-blue'));
    head.appendChild(el('p', 'text-[13px] font-semibold text-frosted-blue/70', 'Preview'));
    box.appendChild(head);
    // The sidebar's New! flag, beside a heading as it sits beside a page's name.
    var title = el('p', 'text-[20px] font-bold tracking-tight text-frosted-blue', 'Tonight’s picks');
    title.appendChild(el('span', 'nav-new-badge', 'New!'));
    box.appendChild(title);
    box.appendChild(el('p', 'text-[15px] text-frosted-blue', 'This is how most text looks.'));
    box.appendChild(el('p', 'text-[13px] text-frosted-blue/70', 'Quieter text, like dates and descriptions.'));
    var surface = el('div', 'flex items-center gap-2 rounded-xl bg-cornflower-ocean/20 px-3 py-2.5');
    surface.appendChild(icon('event', 'text-base text-steel-blue'));
    surface.appendChild(el('span', 'text-[13px] text-frosted-blue/70', 'New episodes every Friday'));
    box.appendChild(surface);
    var buttons = el('div', 'flex flex-wrap items-center gap-2');
    buttons.appendChild(el('span', cls.btnPrimary, 'Request'));
    buttons.appendChild(el('span', cls.btnGhost, 'Maybe later'));
    box.appendChild(buttons);
    var badges = el('div', 'flex flex-wrap items-center gap-2');
    [['badge-media-movie', 'movie', 'Movie'], ['badge-media-tv', 'tv', 'TV Show'], ['badge-media-book', 'menu_book', 'eBook']]
      .forEach(function (b) {
        var s = el('span', b[0] + ' inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[13px] font-semibold');
        s.appendChild(icon(b[1], 'text-base'));
        s.appendChild(document.createTextNode(b[2]));
        badges.appendChild(s);
      });
    box.appendChild(badges);
    // The header's status pill, in each state: the dot always takes the
    // state's colour, the words only when something is wrong.
    var states = el('div', 'flex flex-wrap items-center gap-2');
    [['ok', 'Online'], ['warn', 'Degraded'], ['err', 'Offline']].forEach(function (x) {
      var pill = el('span', 'ws-pill inline-flex items-center gap-2 px-3 py-1 rounded-full border');
      pill.setAttribute('data-state', x[0]);
      var dot = el('span', 'ws-status-dot');
      dot.setAttribute('aria-hidden', 'true');
      pill.appendChild(dot);
      pill.appendChild(el('span', 'ws-pill-label text-[13px] font-semibold text-frosted-blue', x[1]));
      states.appendChild(pill);
    });
    box.appendChild(states);
    return box;
  }

  WSSettings.registerTab('appearance', {
    mount: function (panel, api) {
      fontRe = fontGuard();
      if (pageFont === null) {
        pageFont = api.get('theme.font');
        pageFontVar = root.style.getPropertyValue('--font-display');
        baseFont = shownFont = pageFont;
      }
      // A saved font is the one Discard comes back to from now on.
      api.onSaved(function (keys) {
        if (keys.indexOf('theme.font') < 0) return;
        pageFont = api.get('theme.font');
        if (pageFont === baseFont) return;
        var shown = document.getElementById('ws-font-preview');
        if (shownFont === pageFont && shown) promote(shown);     // else loadFont promotes it on arrival
      });

      var layout = el('div', 'lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10');
      var form = el('div', 'min-w-0');
      var side = el('div', 'hidden lg:block');
      var sticky = el('div', 'sticky top-6');
      sticky.appendChild(previewCard());
      side.appendChild(sticky);

      var colours = WSSettings.card('Colours', 'Your site restyles as you change them. Nothing is saved until you press Save.');
      var grid = el('div', 'grid sm:grid-cols-2 gap-5 ' + cls.fieldWidth);
      COLORS.forEach(function (c) { grid.appendChild(colourField(api, { key: c[0], label: c[1], cssVar: c[2], help: c[3] })); });
      colours.body.appendChild(grid);
      form.appendChild(colours.root);

      var media = WSSettings.card('Media colours', 'Badges and accents that tell movies, TV shows and books apart, and the flag on a new page.');
      var mgrid = el('div', 'grid sm:grid-cols-3 gap-5 ' + cls.fieldWidth);
      MEDIA.forEach(function (m) { mgrid.appendChild(colourField(api, { key: m[0], label: m[1], cssVar: m[2] })); });
      media.body.appendChild(mgrid);
      var fgrid = el('div', 'grid sm:grid-cols-2 gap-5 ' + cls.fieldWidth);
      fgrid.appendChild(colourField(api, { key: NEW_FLAG[0], label: NEW_FLAG[1], cssVar: NEW_FLAG[2], help: NEW_FLAG[3] }));
      media.body.appendChild(fgrid);
      form.appendChild(media.root);

      var gauges = WSSettings.card('Home gauges');
      gauges.body.appendChild(api.toggle({ key: GAUGES_ON, label: 'Colourful gauges',
        help: 'Give the CPU, RAM and network gauges their own colours instead of your theme colour.' }));
      var ggrid = el('div', 'grid sm:grid-cols-3 gap-5 ' + cls.fieldWidth);
      GAUGES.forEach(function (g) { ggrid.appendChild(api.color({ key: g[0], label: g[1], cssVar: g[2] })); });
      gauges.body.appendChild(ggrid);
      // The pickers show while the switch is on, and never hide while one
      // holds a change (a refused save lands there) or has focus.
      function syncGauges() {
        var dirty = api.dirtyKeys();
        var open = api.get(GAUGES_ON) === 'true' || ggrid.contains(document.activeElement) ||
          GAUGES.some(function (g) { return dirty.indexOf(g[0]) >= 0; });
        ggrid.classList.toggle('hidden', !open);
      }
      [GAUGES_ON].concat(GAUGES.map(function (g) { return g[0]; }))
        .forEach(function (k) { api.onChange(k, syncGauges); });
      syncGauges();
      form.appendChild(gauges.root);

      var status = WSSettings.card('Status colours', 'The dots and words that show whether your services are working. The words take the colour only when something is wrong.');
      var sgrid = el('div', 'grid sm:grid-cols-3 gap-5 ' + cls.fieldWidth);
      STATUS.forEach(function (x) { sgrid.appendChild(colourField(api, { key: x[0], label: x[1], cssVar: x[2] })); });
      status.body.appendChild(sgrid);
      // On a phone the preview follows the last colours, not the side column.
      var phonePreview = el('div', 'lg:hidden');
      phonePreview.appendChild(previewCard());
      status.body.appendChild(phonePreview);
      form.appendChild(status.root);

      var type = WSSettings.card('Font');
      type.body.appendChild(fontControl(api));
      form.appendChild(type.root);

      var adv = el('details', 'mb-12 group');
      if (api.get('theme.custom_css')) adv.open = true;       // CSS in use is never tucked away
      var summary = el('summary', 'cursor-pointer list-none [&::-webkit-details-marker]:hidden inline-flex ' +
        'items-center gap-2 rounded-[10px] text-[15px] font-semibold text-frosted-blue focus-visible:outline ' +
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary');
      summary.appendChild(icon('chevron_right', 'text-base transition-transform motion-reduce:transition-none group-open:rotate-90'));
      summary.appendChild(document.createTextNode('Custom CSS (advanced)'));
      adv.appendChild(summary);
      var advBody = el('div', 'mt-4');
      advBody.appendChild(api.textarea({ key: 'theme.custom_css', label: 'CSS added to every page', rows: 8, monospace: true,
        help: 'Applied after you save. It isn’t previewed here, so check your site after saving.' }));
      adv.appendChild(advBody);
      form.appendChild(adv);

      var reset = el('button', cls.btnQuiet);
      reset.type = 'button';
      reset.appendChild(icon('restart_alt', 'text-base'));
      reset.appendChild(document.createTextNode('Reset this tab to defaults'));
      reset.addEventListener('click', function () {
        WSSettings.confirm({
          title: 'Reset appearance?',
          body: 'Colours, font and custom CSS go back to the originals. You can review the changes; nothing is saved until you press Save.',
          confirmLabel: 'Reset', cancelLabel: 'Cancel'
        }).then(function (ok) { if (ok) api.stageDefaults(KEYS); });
      });
      form.appendChild(reset);

      layout.appendChild(form);
      layout.appendChild(side);
      panel.appendChild(layout);

      // Every colour a pair reads re-measures them all.
      var measured = {};
      PAIRS.forEach(function (p) { measured[p.fg] = measured[p.bg] = true; });
      Object.keys(measured).forEach(function (key) { api.onChange(key, function () { checkContrast(api); }); });
      checkContrast(api);

      // Text very hard to read on the background (under 3:1, the floor for even
      // large text) is saved only once the admin says so. Only a save that
      // changes one of the two asks: an older theme isn't asked about again.
      api.beforeSave(function (keys) {
        if (keys.indexOf('theme.color_text') < 0 && keys.indexOf('theme.color_background') < 0) return true;
        var fg = inUse(api, 'theme.color_text'), bg = inUse(api, 'theme.color_background');
        var ratio = fg && bg ? contrast(fg, bg) : 21;
        if (ratio >= 3) return true;
        return WSSettings.confirm({
          title: 'Save hard-to-read colours?',
          body: 'This makes text hard to read. Save anyway? If Settings becomes hard to read too, open ' +
            '/settings?theme=safe#appearance to see it in the original colours and fix it.',
          confirmLabel: 'Save anyway', cancelLabel: 'Keep editing', danger: true
        });
      });
    }
  });
})();
