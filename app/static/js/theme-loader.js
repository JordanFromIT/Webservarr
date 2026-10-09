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

    // Every frosted surface's blur (--ws-frost-blur), as the server's
    // #ws-theme writes it: a whole number of px from 0 to 32.
    var blur = data.frost_blur;
    if (typeof blur === 'number' && blur % 1 === 0 && blur >= 0 && blur <= 32) {
      root.style.setProperty('--ws-frost-blur', 'blur(' + blur + 'px)');
    }

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
 * Asking for things: turning on push and adding the site to the home screen.
 * One record, shared by Home's push banner (below) and Home's welcome tour
 * (js/welcome.js), so the two never ask in the same visit and one "Don't ask
 * me again" silences both.
 *
 * WSAsk.get(kind) / set(kind, value), kind 'push' or 'install', in
 * localStorage (ws-push-ask, ws-install-ask):
 *   ''       never asked by the tour (the banner may ask about push)
 *   'later'  "Not now", or the tour closed before it was answered: the tour's
 *            own small prompt asks again on the next visit (a full load or a
 *            sign-in, never a soft navigation)
 *   'never'  "Don't ask me again", confirmed: nothing asks again
 *   'done'   (install only) added, or the steps to add it were shown
 * WSAsk.welcomeSeen(): the welcome tour has been shown here (unreadable
 * storage counts as seen, so a browser that cannot remember is not toured on
 * every visit). WSAsk.asked() / markAsked(by): what has already asked during
 * this load of the document ('welcome' or 'banner'), at most one per visit.
 */
(function () {
  'use strict';
  var KEYS = { push: 'ws-push-ask', install: 'ws-install-ask' };
  var WELCOME_SEEN = 'webservarr_welcome_v2_seen';
  var askedBy = '';

  function get(kind) {
    try { return localStorage.getItem(KEYS[kind]) || ''; } catch (e) { return ''; }
  }
  function set(kind, value) {
    try {
      if (value) localStorage.setItem(KEYS[kind], value);
      else localStorage.removeItem(KEYS[kind]);
    } catch (e) { /* private mode: asked again next time */ }
  }
  function welcomeSeen() {
    try { return localStorage.getItem(WELCOME_SEEN) === '1'; } catch (e) { return true; }
  }

  window.WSAsk = {
    WELCOME_SEEN: WELCOME_SEEN,
    get: get,
    set: set,
    welcomeSeen: welcomeSeen,
    asked: function () { return askedBy; },
    markAsked: function (by) { if (!askedBy) askedBy = by || 'welcome'; }
  };
})();

/*
 * Home's offer to turn on push (#pushPrompt, index.html, a slim banner at
 * the top), decided before the first paint so it never pushes the page down
 * after load.
 *
 * WSPushOffer(key, days) is true for an account push can reach, on a browser
 * that supports it (an iPhone only in a home-screen app: Safari has no push in
 * a tab), that has never been asked, and that did not say "Not now" (the
 * banner's close button: localStorage[key], a time) within days. A full load
 * of Home decides here and marks <html data-push-offer>, which shows the
 * banner (theme.css); the page module (pages/home.js) then decides again for
 * every visit, soft ones included, sets the banner's hidden attribute and
 * takes the mark off. The key and days are the banner's data-dismiss-key and
 * data-dismiss-days.
 *
 * The welcome tour asks first (WSAsk above): no banner while the tour has not
 * been shown, while the tour's own prompt is waiting to ask again ('later'),
 * after "Don't ask me again" ('never'), or once the tour has asked this visit.
 */
(function () {
  'use strict';
  var DISMISS_KEY = 'ws-push-prompt-dismissed';
  var DISMISS_DAYS = 30;

  function welcomeAsks() {
    var ask = window.WSAsk;
    if (!ask) return false;
    var state = ask.get('push');
    return state === 'never' || state === 'later' || !ask.welcomeSeen() || ask.asked() === 'welcome';
  }

  function offer(key, days) {
    var user = (window.WS_DATA || {}).user || {};
    if (!user.has_email || !(window.WEBSERVARR_THEME || {}).vapid_public_key) return false;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
    if (Notification.permission !== 'default') return false;
    if (welcomeAsks()) return false;
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
 * "Add to home screen" (spec 2026-10-04-mobile-nav-and-home-screen-design.md,
 * Part 2): the More sheet's row (install.js).
 *
 * Chromium offers its own install prompt through beforeinstallprompt, which
 * can arrive at any time after load: it is caught here, in <head>, and kept as
 * window.WSInstallPrompt (install.js uses it once). Its default (Chrome's own
 * mini-infobar) is held back: the site offers it itself, in More. Home has no
 * install card (it took most of a phone's first screen).
 * WSInstalled() and WSInstallIOS() for install.js.
 */
(function () {
  'use strict';

  function matches(q) {
    try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch (e) { return false; }
  }
  // Running as a home-screen app: display-mode, or Safari's own flag on iOS.
  function installed() {
    return matches('(display-mode: standalone)') || window.navigator.standalone === true;
  }
  // An iPhone, or an iPad (which says Macintosh, but has a touch screen).
  function ios() {
    var nav = window.navigator || {};
    var ua = nav.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  }

  window.WSInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.WSInstallPrompt = e;
  });

  window.WSInstalled = installed;
  window.WSInstallIOS = ios;
})();

/*
 * The Books page's Continue row, reserved before the first paint.
 *
 * Continue is always shown, but whether it has cards is only known once its
 * answer is in, and cards that appear (or go) after the first paint push the
 * library below them down (or up). So a person who had books in progress last
 * visit gets a row of cards' room from the first paint: <html
 * data-books-continue> switches #continueHost's skeleton from its one empty
 * line to the row's own shape (books.html's page style). pages/books.js writes
 * the flag (localStorage webservarr_books_continue:<name>, "1" or "0") and
 * marks again on every soft visit; a full load of Books marks here. The router
 * takes the attribute off when the next page is swapped in.
 */
(function () {
  'use strict';
  var data = window.WS_DATA || {};
  if (data.page !== 'books') return;
  // Up next and My list (books 3b) are held the same way: webservarr_books_upnext:<name>
  // and webservarr_books_mylist:<name> show #upnextHost and #mylistHost.
  // The discovery shelves (books 3c) too: webservarr_books_recent:<name> and webservarr_books_popular:<name>.
  var rows = [['continue', 'data-books-continue'], ['upnext', 'data-books-upnext'], ['mylist', 'data-books-mylist'],
    ['recent', 'data-books-recent'], ['popular', 'data-books-popular']];
  var view = null;
  try {
    var name = (data.user || {}).username || '';
    for (var i = 0; i < rows.length; i++) {
      if (localStorage.getItem('webservarr_books_' + rows[i][0] + ':' + name) === '1') {
        document.documentElement.setAttribute(rows[i][1], '');
      }
    }
    // The person's remembered view: Group series off gives every card a third line.
    view = JSON.parse(localStorage.getItem('webservarr_books_view:' + name) || 'null');
  } catch (e) { /* private mode: no slot reserved, the row arrives when it arrives */ }
  // The toolbar's filters: an address that carries one gets the room of the
  // row of filters in use (pages/books.js keeps this in step on soft visits).
  if (/[?&](author|series|narrator)=[^&]/.test(window.location.search)) {
    document.documentElement.setAttribute('data-books-filtered', '');
  }
  // Every book its own card (Group series off, or a series filter): the grid's skeleton holds a third line.
  if ((view && view.group === false) || /[?&]series=[^&]/.test(window.location.search)) {
    document.documentElement.setAttribute('data-books-flat', '');
  }
})();

/*
 * The reader's sample banner (books 3b), shown before the first paint.
 *
 * /reader?...&sample=1 opens a sample: pages/reader.js shows #sampleBanner
 * above the book, but only once it runs, which on a full load is after the
 * first paint, so the banner would push the page down. <html
 * data-reader-sample> shows it from the first paint (reader.html's page
 * style). The same rule as the reader's: the first sample parameter, exactly 1.
 */
(function () {
  'use strict';
  var data = window.WS_DATA || {};
  if (data.page !== 'reader') return;
  var m = /[?&]sample=([^&#]*)/.exec(window.location.search || '');
  if (m && m[1] === '1') document.documentElement.setAttribute('data-reader-sample', '');
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
