/**
 * WebServarr — Theme Loader
 *
 * Runs in <head>, before the body parses. The server stamps the branding
 * payload into every page as a JSON block (#ws-data, see app/pages.py), so the
 * theme is applied synchronously from the document itself: no fetch, no cache,
 * no flash of the default colours or name on any navigation.
 *
 * Sets window.WS_DATA (the whole block) and window.WEBSERVARR_THEME (the
 * branding part, the name every page script already reads).
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
   */
  function applyTheme(data) {
    var root = document.documentElement;
    var c = data.colors || {};

    // Color CSS custom properties (RGB triplets for Tailwind alpha support).
    // The server already inlined these (#ws-theme); setting them again is
    // harmless and keeps the fallback path identical.
    if (c.primary) root.style.setProperty('--color-primary', hexToRgb(c.primary));
    if (c.secondary) root.style.setProperty('--color-secondary', hexToRgb(c.secondary));
    if (c.accent) root.style.setProperty('--color-accent', hexToRgb(c.accent));
    if (c.text) root.style.setProperty('--color-text', hexToRgb(c.text));
    if (c.text_secondary) root.style.setProperty('--color-text-secondary', hexToRgb(c.text_secondary));
    if (c.background) root.style.setProperty('--color-background', hexToRgb(c.background));

    // Media type accents. Consumed by the .text-media-* / .badge-media-*
    // classes in theme.css rather than by Tailwind, so they work on every page.
    if (c.media_movie) root.style.setProperty('--color-media-movie', hexToRgb(c.media_movie));
    if (c.media_tv) root.style.setProperty('--color-media-tv', hexToRgb(c.media_tv));
    if (c.media_book) root.style.setProperty('--color-media-book', hexToRgb(c.media_book));
    if (c.new_flag) root.style.setProperty('--color-new-flag', hexToRgb(c.new_flag));

    // Raw hex values (for non-Tailwind use like scrollbar styling)
    if (c.primary) root.style.setProperty('--hex-primary', c.primary);
    if (c.secondary) root.style.setProperty('--hex-secondary', c.secondary);
    if (c.accent) root.style.setProperty('--hex-accent', c.accent);
    if (c.text) root.style.setProperty('--hex-text', c.text);
    if (c.text_secondary) root.style.setProperty('--hex-text-secondary', c.text_secondary);
    if (c.background) root.style.setProperty('--hex-background', c.background);
    if (c.media_movie) root.style.setProperty('--hex-media-movie', c.media_movie);
    if (c.media_tv) root.style.setProperty('--hex-media-tv', c.media_tv);
    if (c.media_book) root.style.setProperty('--hex-media-book', c.media_book);

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

    // Custom CSS injection (textContent, never markup)
    if (data.custom_css) {
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

  var inline = readInline();
  if (inline) {
    window.WS_DATA = inline;
    applyTheme(inline.branding || {});
  } else {
    window.WS_DATA = null;
    var run = function () {
      fetch('/api/branding')
        .then(function (r) { return r.json(); })
        .then(applyTheme)
        .catch(function () { /* keep the defaults */ });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }
})();
