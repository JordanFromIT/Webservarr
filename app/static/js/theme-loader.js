/**
 * WebServarr — Theme Loader
 *
 * Runs in <head>, before the body parses. The server stamps the branding
 * payload into every page as a JSON block (#ws-data, see app/pages.py), so the
 * theme is applied synchronously from the document itself: no fetch, no cache,
 * no flash of the default colours or name on any navigation.
 *
 * Sets window.WS_DATA (the whole block) and window.WEBSERVARR_THEME (the
 * branding part, the name every page script already reads), and
 * window.WSTheme.apply(branding) to apply a newer payload later.
 *
 * A page served some other way has no block; it falls back to one fetch of
 * /api/branding.
 */
(function () {
  'use strict';

  /**
   * Convert hex color to space-separated RGB triplet for Tailwind opacity support.
   * e.g. "#125793" → "18 87 147"
   */
  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    var r = parseInt(hex.substring(0, 2), 16);
    var g = parseInt(hex.substring(2, 4), 16);
    var b = parseInt(hex.substring(4, 6), 16);
    return r + ' ' + g + ' ' + b;
  }

  /**
   * Apply branding data to the document via CSS custom properties.
   * fromPage: the data came from the page's own #ws-data block, whose server
   * render already carries the custom CSS (last in <head>).
   */
  function applyTheme(data, fromPage) {
    var root = document.documentElement;
    var c = data.colors || {};

    // Every colour the server sends (app/settings_registry.COLOR_KEYS): the
    // palette, the media accents, the status colours. Each becomes an RGB
    // triplet (--color-media-tv, for Tailwind's alpha syntax) and its raw hex
    // (--hex-media-tv). The server already inlined these (#ws-theme); setting
    // them again is harmless and keeps the fallback path identical. The
    // payload is already safe; the checks keep a stray value off the page.
    Object.keys(c).forEach(function (key) {
      var hex = c[key];
      if (!/^[a-z_]+$/.test(key) || typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
      var name = key.replace(/_/g, '-');
      root.style.setProperty('--color-' + name, hexToRgb(hex));
      root.style.setProperty('--hex-' + name, hex);
    });

    // Home's gauge rings (--ws-gauge-*): the accent, or with colourful gauges
    // on their own colours, as the server's #ws-theme picks them.
    ['cpu', 'ram', 'net'].forEach(function (g) {
      root.style.setProperty('--ws-gauge-' + g,
        data.gauges_colourful === true ? 'var(--color-gauge-' + g + ')' : 'var(--color-accent)');
    });

    // Favicon follows the configured logo, so a rebranded install is branded
    // in the browser tab too. The pages ship a static icon link as well.
    if (data.logo_url) {
      var icon = document.querySelector('link[rel="icon"]');
      if (!icon) {
        icon = document.createElement('link');
        icon.rel = 'icon';
        document.head.appendChild(icon);
      }
      icon.href = data.logo_url;
    }

    // Font. The server emits the stylesheet link statically (#ws-font); only
    // the fallback path has to inject one. The name is quoted, as the server
    // quotes it: unquoted, a family like "Exo 2" is not a valid font-family.
    if (data.font) {
      root.style.setProperty('--font-display', '"' + data.font + '", sans-serif');
      var fontId = 'webservarr-google-font';
      if (!document.getElementById('ws-font') && !document.getElementById(fontId)) {
        var link = document.createElement('link');
        link.id = fontId;
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=' +
          encodeURIComponent(data.font) + ':wght@300;400;500;600;700&display=optional';
        document.head.appendChild(link);
      }
    }

    // Always dark mode
    root.classList.add('dark');
    root.classList.remove('light');

    // Custom CSS, on the fallback path only: the server writes it into every
    // page it renders, as the last thing in <head> so it wins the cascade.
    // Here it arrives after the fetch and is appended to the end of <head>,
    // after every stylesheet, so it wins too (textContent, never markup).
    if (data.custom_css && !fromPage) {
      var styleId = 'webservarr-custom-css';
      var el = document.getElementById(styleId);
      if (!el) {
        el = document.createElement('style');
        el.id = styleId;
        document.head.appendChild(el);
      }
      el.textContent = data.custom_css;
    }

    // Store on window for other scripts to use
    window.WEBSERVARR_THEME = data;

    // Update page title with branding app_name, preserving page suffix.
    // A blank name (the logo stands alone) leaves the server's title as is:
    // it already reads just the page name, with no dangling " - ".
    var siteName = typeof data.app_name === 'string' ? data.app_name.trim() : '';
    if (siteName) {
      var currentTitle = document.title;
      var dashIndex = currentTitle.indexOf(' - ');
      var suffix = dashIndex !== -1 ? currentTitle.substring(dashIndex) : '';
      document.title = siteName + suffix;
    }
  }

  function readInline() {
    var el = document.getElementById('ws-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  // Settings applies a saved theme to the page already on screen with this
  // (settings/kit.js): <html> and the favicon outlive a soft navigation.
  window.WSTheme = { apply: function (data) { applyTheme(data || {}, true); } };

  var inline = readInline();
  if (inline) {
    window.WS_DATA = inline;
    applyTheme(inline.branding || {}, true);
  } else {
    window.WS_DATA = null;
    var run = function () {
      fetch('/api/branding')
        .then(function (r) { return r.json(); })
        .then(function (data) { applyTheme(data, false); })
        .catch(function () { /* keep the defaults */ });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }
})();

/*
 * Home's offer to turn on push (#pushPrompt, index.html), decided before the
 * first paint so the card never pushes the page down after load.
 *
 * WSPushOffer(key, days) is true for an account push can reach, on a browser
 * that supports it, that has never been asked, and that did not say "Not now"
 * (localStorage[key], a time) within days. A full load of Home decides here
 * and marks <html data-push-offer>, which shows the card (theme.css); the page
 * module (pages/home.js) then decides again for every visit, soft ones
 * included, sets the card's hidden attribute and takes the mark off. The key
 * and days are the card's data-dismiss-key and data-dismiss-days.
 */
(function () {
  'use strict';
  var DISMISS_KEY = 'ws-push-prompt-dismissed';
  var DISMISS_DAYS = 30;

  function offer(key, days) {
    var user = (window.WS_DATA || {}).user || {};
    if (!user.has_email || !(window.WEBSERVARR_THEME || {}).vapid_public_key) return false;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
    if (Notification.permission !== 'default') return false;
    try {
      var at = parseInt(localStorage.getItem(key) || '', 10);
      if (at && Date.now() - at < days * 86400000) return false;
    } catch (e) {}
    return true;
  }

  window.WSPushOffer = offer;

  if ((window.WS_DATA || {}).page === 'index' && offer(DISMISS_KEY, DISMISS_DAYS)) {
    document.documentElement.setAttribute('data-push-offer', '');
  }
})();

/*
 * The eBooks shelves' reserved space (#shelves, library.html), decided before
 * the first paint so the grid below never moves when the shelves arrive.
 *
 * WSShelfPlan(username, search) is [[shelf id, covers], ...]: the shelves
 * this person had last visit (localStorage webservarr_library_shelves:<name>,
 * which pages/library.js writes), Recently Added with eight on a first visit,
 * and none after a failed Kavita sign-in (?kavita=error: the page shows that
 * message and loads no shelves). WSShelfMark(plan) writes it on <html> as
 * data-shelf-<id>="<covers>", which shows that shelf's slot with that many
 * covers (library.html's page style), and clears any shelf not in it. A full
 * load of eBooks marks here; the page module marks again on every visit (the
 * router takes the marks off when the next page is swapped in).
 */
(function () {
  'use strict';
  var SHELVES = ['bookshelf', 'recent', 'toprated'];

  function plan(username, search) {
    if (/[?&]kavita=error(&|$)/.test(search || '')) return [];
    var out = [['recent', 8]];
    try {
      var saved = JSON.parse(localStorage.getItem('webservarr_library_shelves:' + (username || '')) || 'null');
      if (Array.isArray(saved)) {
        out = saved.filter(function (s) {
          return Array.isArray(s) && SHELVES.indexOf(s[0]) !== -1 && s[1] >= 1 && s[1] <= 8;
        });
      }
    } catch (e) { /* private mode or an old value: the first-visit shape */ }
    return out;
  }

  function mark(p) {
    var root = document.documentElement;
    SHELVES.forEach(function (id) { root.removeAttribute('data-shelf-' + id); });
    (p || []).forEach(function (s) { root.setAttribute('data-shelf-' + s[0], String(Math.round(s[1]))); });
  }

  window.WSShelfPlan = plan;
  window.WSShelfMark = mark;

  var data = window.WS_DATA || {};
  if (data.page === 'library') mark(plan((data.user || {}).username, location.search));
})();

/*
 * The shell's view-transition names, only while a transition runs.
 *
 * theme.css names the sidebar, header, mobile bar and <main> under
 * html.ws-vt. A named element is a stacking context, so the names cannot stay
 * on: every position:fixed page overlay would sit under the phone's top bar.
 *
 * router.js holds the class around a soft swap's document.startViewTransition:
 * hold() puts it on and returns its release, and the class comes off when the
 * last hold is released. Full navigations have no transition (no page opts
 * into a cross-document one), so nothing else holds it.
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var holds = 0;

  function hold() {
    var released = false;
    holds += 1;
    root.classList.add('ws-vt');
    return function release() {
      if (released) return;
      released = true;
      holds = Math.max(0, holds - 1);
      if (!holds) root.classList.remove('ws-vt');
    };
  }

  window.WSViewTransition = { hold: hold };
})();
