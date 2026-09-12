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
// precisely so this is the only thing that ever fills it in.
//
// Fully self-contained: this used to be a global loadSystemStatus() that
// every shell page's own inline script called both on load and from its
// own 30s setInterval, which meant every page had to know this existed and
// call it at the right time relative to header.js's own script tag having
// already run. header.js now owns its own refresh cadence instead, so no
// page needs to call anything -- still exposed as window.loadSystemStatus
// for manual/debug use (e.g. forcing a repaint from the console), but
// nothing in this codebase calls it by that name anymore.
(function () {
  var pill = document.getElementById('systemStatus');
  if (!pill) return;
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

  function refresh() {
    return wsCache.swr('ws.status', '/api/integrations/service-status', 30000, paint)
      .catch(function () { /* keep whatever was last painted; never show "Loading" */ });
  }

  window.loadSystemStatus = refresh;

  refresh(); // hydrate immediately -- no page script has to trigger this
  setInterval(refresh, 30000); // matches the cadence every page used to drive itself
})();
