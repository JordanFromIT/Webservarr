/**
 * WebServarr — Shared Header Decorator
 * Desktop only: system status pill, user menu dropdown. The notification
 * bell itself is wired by notifications.js; mobile uses the top bar wired
 * by sidebar.js.
 *
 * The <header> markup ships from the server (see
 * app/static/partials/shell.html) -- this file only wires interactivity and
 * hydrates the status pill on top of it. It used to build the whole header
 * at runtime (see git history for _buildHeader()); that's dead now that the
 * static shell partial ships it already rendered.
 */

// ---- User menu dropdown ----
(function () {
  var userMenuBtn = document.getElementById('userMenuBtn');
  var userMenuDropdown = document.getElementById('userMenuDropdown');
  if (!userMenuBtn || !userMenuDropdown) return;

  userMenuBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    userMenuDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', function () {
    userMenuDropdown.classList.add('hidden');
  });
})();

// ---- Status pill ----
//
// Hydrated from the sessionStorage cache (see shell-cache.js) so a warm tab
// never sits on the neutral placeholder while the request is in flight --
// the static shell ships #systemStatus with a blank (&nbsp;) label
// precisely so this is the only thing that ever fills it in. Exposed as the
// global loadSystemStatus() because every shell page's own inline script
// already calls that by name, both on first load and on its own 30s
// refresh interval -- this just changes what runs underneath that call.
(function () {
  var pill = document.getElementById('systemStatus');
  if (!pill) {
    window.loadSystemStatus = function () {};
    return;
  }
  var textEl = pill.querySelector('span:last-child');

  function paint(services) {
    // /api/integrations/service-status returns a bare array of the
    // admin's enabled Uptime Kuma monitors, each with a `status` of
    // "up"/"down"/"degraded"/"maintenance" (see
    // app/integrations/uptime_kuma.py). An empty or malformed response
    // leaves the pill exactly as it was rather than claiming a state we
    // don't actually know.
    if (!Array.isArray(services) || services.length === 0) return;

    var hasDown = services.some(function (s) { return s.status === 'down'; });
    var hasDegraded = services.some(function (s) { return s.status === 'degraded'; });

    var state, label;
    if (hasDown) {
      state = 'issues';
      label = 'System Issues Detected';
    } else if (hasDegraded) {
      state = 'degraded';
      label = 'Degraded Performance';
    } else {
      state = 'online';
      label = 'All Systems Online';
    }

    textEl.textContent = label;
    pill.dataset.state = state; // drives dot/text/background color, theme.css
  }

  window.loadSystemStatus = function () {
    return wsCache.swr('ws.status', '/api/integrations/service-status', 30000, paint)
      .catch(function () { /* keep whatever was last painted; never show "Loading" */ });
  };

  // Hydrate immediately -- don't wait for the page's own script to call
  // loadSystemStatus(), which runs only after checkAuth()'s network round
  // trip resolves.
  window.loadSystemStatus();
})();
