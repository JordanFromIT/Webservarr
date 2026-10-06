/**
 * WebServarr: "Add to home screen" (ES module, document-lifetime)
 *
 * Spec: docs/superpowers/specs/2026-10-04-mobile-nav-and-home-screen-design.md,
 * Part 2. theme-loader.js (in <head>) catches Chromium's beforeinstallprompt
 * as window.WSInstallPrompt; this module does what the More sheet's row does
 * with it. (Home's card was removed on 2026-10-06: it took most of a phone's
 * first screen. More is the one place to install from.)
 *
 * WS.install:
 *   wireRow()               the More row (boot does this): hidden in an
 *                           installed app; the browser's prompt where there is
 *                           one (and More closes), else a disclosure with the
 *                           two iOS steps or the browser-menu steps.
 *   prompt()                the browser's own prompt, once per event.
 *
 * Pure-ish for tests: create(win) returns the API without wiring anything;
 * boot(win) makes WS.install and wires the row.
 */

export function create(win) {
  const doc = win.document;
  let row = null;

  function installed() { return typeof win.WSInstalled === 'function' && !!win.WSInstalled(); }
  function ios() { return typeof win.WSInstallIOS === 'function' && !!win.WSInstallIOS(); }
  function pending() { return win.WSInstallPrompt || null; }

  /* The browser's own prompt, from a tap (it needs one). Once per event: a
     used event cannot be shown again. Resolves 'accepted', 'dismissed' or
     null (nothing to show, or it failed). */
  function prompt() {
    const e = pending();
    if (!e || typeof e.prompt !== 'function') return Promise.resolve(null);
    win.WSInstallPrompt = null;
    let shown;
    try { shown = e.prompt(); } catch (err) { return Promise.resolve(null); }
    return Promise.resolve(shown)
      .then(function () { return e.userChoice; })
      .then(function (c) { return c && c.outcome ? c.outcome : null; }, function () { return null; });
  }

  function wireRow() {
    const li = doc.querySelector('[data-install-row]');
    if (!li) return;
    row = li;
    li.hidden = installed();
    const btn = li.querySelector('[data-install-action]');
    const help = doc.getElementById('wsInstallHelp');
    if (!btn || !help) return;
    const steps = {
      ios: help.querySelector('[data-install-steps="ios"]'),
      menu: help.querySelector('[data-install-steps="menu"]')
    };
    function expand(open) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      help.hidden = !open;
      if (!open) return;
      const kind = ios() ? 'ios' : 'menu';
      Object.keys(steps).forEach(function (k) { if (steps[k]) steps[k].hidden = k !== kind; });
    }
    btn.addEventListener('click', function () {
      if (pending()) {
        expand(false);
        prompt();
        if (win.WS && typeof win.WS.closeChrome === 'function') win.WS.closeChrome();
        return;
      }
      expand(btn.getAttribute('aria-expanded') !== 'true');
    });
  }

  // Installed from anywhere (the row, the browser's own menu).
  win.addEventListener('appinstalled', function () {
    win.WSInstallPrompt = null;
    if (row) row.hidden = true;
  });

  return { wireRow: wireRow, prompt: prompt };
}

export function boot(win) {
  const WS = win.WS || (win.WS = {});
  if (WS.install) return WS.install;
  WS.install = create(win);
  WS.install.wireRow();
  return WS.install;
}

if (typeof window !== 'undefined' && window.document) boot(window);
