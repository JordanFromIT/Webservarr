/**
 * WebServarr: "Add to home screen" (ES module, document-lifetime)
 *
 * Spec: docs/superpowers/specs/2026-10-04-mobile-nav-and-home-screen-design.md,
 * Part 2. theme-loader.js (in <head>) catches Chromium's beforeinstallprompt
 * as window.WSInstallPrompt and decides Home's card (WSInstallOffer); this
 * module does what the card and the More sheet's row do with it.
 *
 * WS.install:
 *   wireCard(card, signal)  Home's #installCard, its mode (card.dataset.mode,
 *                           'prompt' or 'ios') already decided by the page.
 *                           Add asks the browser once; the card goes once the
 *                           app is installed or the prompt is spent. Not now
 *                           remembers on this device (localStorage, under the
 *                           card's data-dismiss-key; blocked storage just
 *                           hides it for now). A card shown because the
 *                           browser offered its prompt last time waits for it
 *                           (Add is aria-disabled meanwhile), and goes if it
 *                           has not come after waitMs. Everything ends with
 *                           the visit's signal.
 *   wireRow()               the More row (boot does this): hidden in an
 *                           installed app; the browser's prompt where there is
 *                           one (and More closes), else a disclosure with the
 *                           two iOS steps or the browser-menu steps.
 *
 * Pure-ish for tests: create(win, { waitMs }) returns the API without wiring
 * anything; boot(win) makes WS.install and wires the row.
 */

export const SEEN_KEY = 'ws-install-prompt-seen';
export const WAIT_MS = 8000;

export function create(win, opts) {
  const doc = win.document;
  const waitMs = opts && typeof opts.waitMs === 'number' ? opts.waitMs : WAIT_MS;
  const cards = new Set();       // cards on screen, for appinstalled
  let row = null;

  function storage(fn) {
    try { return fn(win.localStorage); } catch (e) { return null; }
  }
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

  function hide(card) {
    card.hidden = true;
    cards.delete(card);
  }

  function wireCard(card, signal) {
    if (!card) return;
    const on = signal ? { signal: signal } : undefined;
    const later = card.querySelector('[data-install-later]');
    const add = card.querySelector('[data-install-add]');
    let timer = 0;
    cards.add(card);

    if (later) {
      later.addEventListener('click', function () {
        const key = card.dataset.dismissKey;
        if (key) storage(function (s) { s.setItem(key, String(Date.now())); });
        hide(card);
      }, on);
    }

    if (card.dataset.mode === 'prompt' && add) {
      const ready = function () {
        clearTimeout(timer);
        add.setAttribute('aria-disabled', 'false');
      };
      if (pending()) {
        ready();
      } else {
        // Offered last time: it usually comes within a second or two of load.
        add.setAttribute('aria-disabled', 'true');
        win.addEventListener('ws:install-prompt', ready, on);
        timer = setTimeout(function () {
          if (pending()) return;
          storage(function (s) { s.removeItem(SEEN_KEY); });
          hide(card);
        }, waitMs);
      }
      let asking = false;
      add.addEventListener('click', function () {
        if (asking || add.getAttribute('aria-disabled') === 'true') return;
        asking = true;
        prompt().then(function (outcome) {
          asking = false;
          // Accepted: appinstalled follows. Turned down: the prompt is spent
          // until the next page load, so the card goes for now.
          if (outcome !== null) hide(card);
        });
      }, on);
    }

    if (signal) {
      signal.addEventListener('abort', function () {
        clearTimeout(timer);
        cards.delete(card);
      }, { once: true });
    }
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

  // Installed from anywhere (the card, the row, the browser's own menu).
  win.addEventListener('appinstalled', function () {
    win.WSInstallPrompt = null;
    storage(function (s) { s.removeItem(SEEN_KEY); });
    Array.from(cards).forEach(hide);
    if (row) row.hidden = true;
  });

  return { wireCard: wireCard, wireRow: wireRow, prompt: prompt };
}

export function boot(win) {
  const WS = win.WS || (win.WS = {});
  if (WS.install) return WS.install;
  WS.install = create(win);
  WS.install.wireRow();
  return WS.install;
}

if (typeof window !== 'undefined' && window.document) boot(window);
