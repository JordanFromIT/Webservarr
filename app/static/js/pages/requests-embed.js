/**
 * WebServarr — Requests, as the Seerr embed (page module)
 *
 * What /requests shows when the operator chose Seerr's own UI as the
 * Requests source (Settings > Pages): Seerr in an iframe, signed in through
 * WebServarr's Seerr SSO first where that is set up.
 *
 * A soft-navigation page (spec 4.2): everything runs from mount(ctx), and
 * both requests go on ctx.signal. The SSO handshake has side effects, so it
 * is made from mount and only once the page is on screen, never while it is
 * prerendered. The iframe is built inside #wsPage, so leaving the page takes
 * it, and the Seerr session it was showing, away with it.
 */

function isAbort(e) { return !!e && e.name === 'AbortError'; }

export async function mount(ctx) {
  var root = ctx.root;
  var signal = ctx.signal;
  var container = root.querySelector('#iframeContainer');

  var user = await checkAuth();
  if (!user || signal.aborted) return;

  // A prerendered page must not sign in on its own: wait until it is shown.
  await new Promise(function (resolve) { WS.whenActive(resolve); });
  if (signal.aborted) return;

  // Authenticate with Seerr SSO before loading the iframe. Optional: when it
  // fails, the iframe shows Seerr's own sign-in.
  try {
    await fetch('/api/integrations/seerr-auth', { method: 'POST', signal: signal });
  } catch (e) {
    if (signal.aborted || isAbort(e)) return;   // left the page: nothing to load
  }

  // The Seerr address from settings.
  var url = '';
  try {
    var resp = await fetch('/api/integrations/seerr-url', { signal: signal });
    if (resp.ok) url = ((await resp.json()) || {}).url || '';
  } catch (e) {
    if (signal.aborted || isAbort(e)) return;
    // Otherwise: not configured, said below.
  }
  if (signal.aborted || !container) return;

  if (url) {
    // Built with DOM APIs and .src assigned as a property, so a stray " in
    // the address can't break out and inject extra attributes.
    container.innerHTML = '';
    var iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.className = 'w-full h-full border-0';
    iframe.setAttribute('allow', 'fullscreen');
    container.appendChild(iframe);
  } else {
    container.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-center text-steel-blue p-8">' +
      '<span class="material-symbols-outlined text-6xl mb-4 opacity-50">download</span>' +
      '<p class="text-lg mb-2">The embedded requests page is not set up yet</p>' +
      '<p class="text-sm">Set the Seerr URL in Settings &gt; Integrations.</p></div>';
  }
}
