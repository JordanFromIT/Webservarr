/**
 * WebServarr — Theme Loader
 * Loads branding/theme from /api/branding and applies CSS custom properties.
 * Include in <head> before Tailwind to prevent FOUC.
 */
(function () {
  'use strict';

  const CACHE_KEY = 'webservarr_branding';
  const CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes

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

    // Color CSS custom properties (RGB triplets for Tailwind alpha support)
    if (c.primary) root.style.setProperty('--color-primary', hexToRgb(c.primary));
    if (c.secondary) root.style.setProperty('--color-secondary', hexToRgb(c.secondary));
    if (c.accent) root.style.setProperty('--color-accent', hexToRgb(c.accent));
    if (c.text) root.style.setProperty('--color-text', hexToRgb(c.text));
    if (c.background) root.style.setProperty('--color-background', hexToRgb(c.background));

    // Raw hex values (for non-Tailwind use like scrollbar styling)
    if (c.primary) root.style.setProperty('--hex-primary', c.primary);
    if (c.secondary) root.style.setProperty('--hex-secondary', c.secondary);
    if (c.accent) root.style.setProperty('--hex-accent', c.accent);
    if (c.text) root.style.setProperty('--hex-text', c.text);
    if (c.background) root.style.setProperty('--hex-background', c.background);

    // Font
    if (data.font) {
      root.style.setProperty('--font-display', data.font + ', sans-serif');

      // Inject Google Fonts link if not already present
      var fontId = 'webservarr-google-font';
      if (!document.getElementById(fontId)) {
        var link = document.createElement('link');
        link.id = fontId;
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=' +
          encodeURIComponent(data.font) + ':wght@300;400;500;600;700&display=swap';
        document.head.appendChild(link);
      }
    }

    // Always dark mode
    root.classList.add('dark');
    root.classList.remove('light');

    // Custom CSS injection
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

    // Update page title with branding app_name, preserving page suffix
    if (data.app_name) {
      var currentTitle = document.title;
      var dashIndex = currentTitle.indexOf(' - ');
      var suffix = dashIndex !== -1 ? currentTitle.substring(dashIndex) : '';
      document.title = data.app_name + suffix;
    }
  }

  /**
   * Try to load cached branding from localStorage (instant, no FOUC).
   */
  function loadCached() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (Date.now() - cached._ts > CACHE_MAX_AGE) return null;
      return cached;
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch fresh branding from API and cache it.
   */
  function fetchAndApply() {
    fetch('/api/branding')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        data._ts = Date.now();
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {}
        applyTheme(data);
      })
      .catch(function () {
        // Network error — keep whatever we have (cached or defaults)
      });
  }

  // 1. Apply cached theme immediately (prevents FOUC)
  var cached = loadCached();
  if (cached) {
    applyTheme(cached);
  }

  // 2. Always fetch fresh in background
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fetchAndApply);
  } else {
    fetchAndApply();
  }
})();
