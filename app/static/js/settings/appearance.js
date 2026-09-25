/**
 * Settings > Appearance: colours (with a live preview), font, custom CSS.
 *
 * Colour and font edits restyle the page as you type; Discard, switching tab
 * or leaving reverts them because the kit repaints every control from its
 * saved value. "Reset this tab" only stages the registry defaults.
 *
 * The font preview loads the chosen Google Font beside the page's own and
 * points --font-display at it once it has loaded, so the page restyles once.
 * Back on the page's own font, the preview stylesheet is removed and
 * --font-display gets its first value back. Names are checked with the
 * registry's pattern, read from meta, before anything is fetched.
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
  // Choices offered in the list; any Google Font name can be typed instead.
  var FONTS = ['Spline Sans', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito',
    'Raleway', 'Source Sans 3', 'Ubuntu', 'Outfit', 'Space Grotesk', 'DM Sans', 'Manrope', 'Plus Jakarta Sans',
    'Sora', 'Lexend', 'Figtree', 'Work Sans', 'Jost', 'Albert Sans', 'Barlow', 'Red Hat Display', 'Rubik',
    'Nunito Sans', 'Cabin', 'Karla', 'Quicksand', 'Exo 2'];
  var KEYS = COLORS.map(function (c) { return c[0]; })
    .concat(MEDIA.map(function (m) { return m[0]; }), ['theme.font', 'theme.custom_css']);
  var OTHER = '__other__';
  var TYPING_DELAY = 300;       // ms after the last keystroke before a typed name is fetched

  // ---- Font preview ----

  var root = document.documentElement;
  var fontRe = null;            // the registry's pattern, anchored; null means no preview
  var pageFont = null;          // the font this page was served with
  var pageFontVar = '';         // --font-display as the page set it, before any preview
  var shownFont = null;         // the font the page shows now
  var fontTimer = null;
  var fontSeq = 0;              // bumped on every change, so a font still loading can't land late
  var onFontMissing = function () {};

  function fontGuard() {
    var m = WSSettings.metaFor('theme.font');
    if (!m || !m.pattern) return null;
    try { return new RegExp('^(?:' + m.pattern + ')$'); } catch (e) { return null; }
  }

  // The page's own font, at once: every preview stylesheet goes (the one
  // shown and any still loading) and --font-display is as the page set it.
  function revertFont() {
    clearTimeout(fontTimer);
    fontSeq += 1;
    document.querySelectorAll('link[data-ws-font-preview]').forEach(function (l) { l.remove(); });
    if (pageFontVar) root.style.setProperty('--font-display', pageFontVar);
    else root.style.removeProperty('--font-display');
    shownFont = pageFont;
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
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Preview');
    var head = el('div', 'flex items-center gap-2');
    head.appendChild(icon('palette', 'text-base text-steel-blue'));
    head.appendChild(el('p', 'text-[13px] font-semibold text-frosted-blue/70', 'Preview'));
    box.appendChild(head);
    box.appendChild(el('p', 'text-[20px] font-bold tracking-tight text-frosted-blue', 'Tonight’s picks'));
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
    return box;
  }

  WSSettings.registerTab('appearance', {
    mount: function (panel, api) {
      fontRe = fontGuard();
      if (pageFont === null) {
        pageFont = api.get('theme.font');
        pageFontVar = root.style.getPropertyValue('--font-display');
        shownFont = pageFont;
      }

      var layout = el('div', 'lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10');
      var form = el('div', 'min-w-0');
      var side = el('div', 'hidden lg:block');
      var sticky = el('div', 'sticky top-6');
      sticky.appendChild(previewCard());
      side.appendChild(sticky);

      var colours = WSSettings.card('Colours', 'Your site restyles as you change them. Nothing is saved until you press Save.');
      var grid = el('div', 'grid sm:grid-cols-2 gap-5');
      COLORS.forEach(function (c) { grid.appendChild(api.color({ key: c[0], label: c[1], cssVar: c[2], help: c[3] })); });
      colours.body.appendChild(grid);
      form.appendChild(colours.root);

      var media = WSSettings.card('Media colours', 'Badges and accents that tell movies, TV shows and books apart.');
      var mgrid = el('div', 'grid sm:grid-cols-3 gap-5');
      MEDIA.forEach(function (m) { mgrid.appendChild(api.color({ key: m[0], label: m[1], cssVar: m[2] })); });
      media.body.appendChild(mgrid);
      var phonePreview = el('div', 'lg:hidden');
      phonePreview.appendChild(previewCard());
      media.body.appendChild(phonePreview);
      form.appendChild(media.root);

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
    }
  });
})();
