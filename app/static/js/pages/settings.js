/**
 * WebServarr — Settings (page module)
 *
 * Admins only: the server sends anyone else to / before this runs, and a
 * soft navigation that meets that redirect leaves by full navigation.
 *
 * A soft-navigation page (spec 4.2). Everything Settings does lives in its
 * page helpers (spec 4.3, each loaded once): first-paint.js paints the tab
 * and skeleton the hash and the page's data call for, and the kit
 * (settings/kit.js, window.WSSettings) runs the tabs, the save bar and the
 * leave guard. mount starts both for this visit with ctx; every listener,
 * timer and request they start ends with ctx.signal.
 *
 * Leaving with unsaved changes asks first. A link click asks through the
 * kit's own document listener, which runs before the router's (on window);
 * Back, Forward and WS.router.navigate() ask through ctx.beforeLeave, which
 * the router awaits before it leaves; a reload, a typed address or closing
 * the tab ask through the kit's beforeunload.
 *
 * Settings in safe colours (/settings?theme=safe) is a document of its own:
 * its <head> carries the shipped colours, which a swap would not replace.
 * So it is only ever entered and left by full navigation.
 */

// This document was served as Settings in safe colours. Read once, when the
// module first runs: on a cold load that is this page's own <html>; on a
// soft navigation it is the page being left, which is never safe.
const SAFE_DOCUMENT = document.documentElement.hasAttribute('data-safe-theme');

export async function mount(ctx) {
  // Before anything can paint: the tab from the hash, its skeleton.
  window.WSSettingsFirstPaint.paint();

  const safe = ctx.url.searchParams.get('theme') === 'safe';
  if (safe !== SAFE_DOCUMENT) {
    // Into safe colours by a swap: this document's colours are the saved ones.
    WS.router.hardNavigate(ctx.url.href);
    return;
  }

  const user = await checkAuth({ requireAdmin: true });
  if (!user || ctx.signal.aborted) return;

  window.WSSettings.init(ctx);
  ctx.beforeLeave(function (url, how) {
    return Promise.resolve(window.WSSettings.canLeave(how)).then(function (ok) {
      if (ok === false) return false;
      return SAFE_DOCUMENT ? 'hard' : true;
    });
  });
}
