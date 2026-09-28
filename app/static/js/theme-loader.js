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
 * The shell's view-transition names, only while a transition runs.
 *
 * theme.css names the sidebar, header, mobile bar and <main> under
 * html.ws-vt. A named element is a stacking context, so the names cannot stay
 * on: every position:fixed page overlay would sit under the phone's top bar.
 *
 * hold() puts the class on and returns its release; the class comes off when
 * the last hold is released, so a soft swap that starts while a full
 * navigation's reveal is still running keeps its names. A full navigation
 * holds from pageswap (the old document, before its snapshot) and from
 * pagereveal (the new one, before its first frame) until the transition's
 * finished promise settles. This script is in <head>, so both listeners are
 * in place in time. Under reduced motion there is no cross-document
 * transition (theme.css), so neither event carries one.
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

  function holdFor(transition) {
    var release = hold();
    Promise.resolve(transition.finished).then(release, release);
  }

  window.WSViewTransition = { hold: hold };

  window.addEventListener('pageswap', function (e) {
    if (e.viewTransition) holdFor(e.viewTransition);
  });
  window.addEventListener('pagereveal', function (e) {
    if (e.viewTransition) { holdFor(e.viewTransition); return; }
    // A page back from the back/forward cache left in the middle of its
    // outgoing transition: nothing is running now.
    holds = 0;
    root.classList.remove('ws-vt');
  });
})();
