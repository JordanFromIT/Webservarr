/**
 * WebServarr — Settings: the first frame (window.WSSettingsFirstPaint)
 *
 * What Settings must know before it paints, so nothing shows and then moves:
 *   tab()       the tab named by the hash, on <html data-settings-tab>;
 *               theme.css shows that tab's panel (and skeleton) and styles
 *               its tab from the attribute. The kit keeps it in step after.
 *   strip()     the chosen tab marked for assistive tech (its look comes from
 *               CSS); on a phone the strip starts scrolled to it, with its
 *               edge hints, so it never paints at the start and then jumps.
 *               Both hints start hidden and show only when it overflows.
 *   skeleton()  the parts of each panel's skeleton that depend on the setup
 *               (Sign-in's Plex note, Authentik fields and account part; the
 *               Pages rows' order and set-up notes; the open Custom CSS; the
 *               gauge colours; the push status line, in the server's own
 *               words), picked from the page's data by the tabs' own rules.
 *               Change a tab's markup or words, change its skeleton.
 *   paint()     all three, each only where its markup is there.
 *
 * A page helper (spec 4.3), loaded once per document. The Settings page
 * module calls paint() from mount, on every visit. On a cold load the page
 * also carries this file three times, in <head>, after the tab strip and
 * after the panels, and each copy paints what is above it while the browser
 * is still reading the page (document.readyState 'loading'), as the inline
 * scripts it replaces did. Loaded by the router for a soft navigation, the
 * page has been read already, so loading it only defines these functions.
 */
var WSSettingsFirstPaint = (function () {
  'use strict';

  var TABS = ['general', 'pages', 'appearance', 'sign-in', 'integrations', 'notifications'];

  function tab() {
    var t = (location.hash || '').slice(1);
    if (TABS.indexOf(t) < 0) t = 'general';
    document.documentElement.setAttribute('data-settings-tab', t);
  }

  function strip() {
    var a = document.getElementById('tab-' + document.documentElement.getAttribute('data-settings-tab'));
    if (a) a.setAttribute('aria-selected', 'true');
    var sc = document.getElementById('settingsTabScroller');
    if (!a || !sc || sc.scrollWidth <= sc.clientWidth) return;
    var r = a.getBoundingClientRect(), s = sc.getBoundingClientRect();
    if (r.right > s.right - 48) sc.scrollLeft += r.right - s.right + 48;
    var max = sc.scrollWidth - sc.clientWidth;
    document.getElementById('settingsTabHintLeft').style.opacity = sc.scrollLeft > 4 ? '1' : '0';
    document.getElementById('settingsTabHintRight').style.opacity = sc.scrollLeft >= max - 4 ? '0' : '1';
  }

  function skeleton() {
    var rows = document.querySelector('[data-skel-rows]');
    if (!rows) return;
    var d = window.WS_DATA || {}, b = d.branding || {}, f = b.features || {}, m = b.auth_methods || {};
    var s = d.setup || {}, u = d.user || {};
    var akOpen = !!(f.show_authentik_auth || s.authentik_url);
    var on = {
      // signin.js: the hint shows until Plex is set up; the Authentik fields
      // while it is on or has an address; the account part while
      // username-and-password sign-in is on (the form only to an admin
      // signed in that way); the warning when no method is on and set up.
      'plex-hint': !s.plex,
      'ak-fields-saved': akOpen && !!s.authentik_secret,
      'ak-fields-input': akOpen && !s.authentik_secret,
      'account-full': !!f.show_simple_auth && u.auth_method === 'simple',
      'account-line': !!f.show_simple_auth && u.auth_method !== 'simple',
      'all-off': !(f.show_simple_auth || (f.show_plex_auth && s.plex) || m.authentik),
      // appearance.js: Custom CSS in use is never tucked away.
      'css-open': !!b.custom_css,
      // appearance.js: the gauge colours show while Colourful gauges is on.
      'gauges-on': !!b.gauges_colourful,
      // notifications.js: the status line says what the server will
      // (setup.push_reason: GET /api/admin/notifications/status's own rule).
      'push-ready': !s.push_reason,
      'push-reason': !!s.push_reason
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-skel-when]'), function (n) {
      n.hidden = !on[n.getAttribute('data-skel-when')];
    });
    if (s.push_reason) document.querySelector('[data-skel-when="push-reason"] .skel-text').textContent = s.push_reason;
    // pages.js: the rows in sidebar order, each with the note needsSetup() will show.
    (b.pages_order || []).forEach(function (id) {
      var r = rows.querySelector('[data-skel-page="' + id + '"]');
      if (r) rows.appendChild(r);
    });
    var warn = {
      library: s.kavita || s.audiobooks ? '' : 'kavita',
      requests: b.requests_source === 'seerr_embed' && !s.seerr ? 'seerr-embed' : (!s.seerr && !s.chaptarr ? 'requests' : ''),
      calendar: s.sonarr || s.radarr ? '' : 'arr'
    };
    Array.prototype.forEach.call(rows.querySelectorAll('[data-skel-warn]'), function (n) {
      var id = n.parentNode.getAttribute('data-skel-page');
      n.hidden = warn[id] !== n.getAttribute('data-skel-warn');
    });
  }

  function paint() {
    tab();
    if (document.getElementById('settingsTabs')) strip();
    skeleton();
  }

  // A cold load of /settings: this copy paints what the browser has read so
  // far. The router loads helpers only once a page has been read, never
  // while it is 'loading', so a soft navigation's load runs nothing here.
  if (document.readyState === 'loading') paint();

  return { tab: tab, strip: strip, skeleton: skeleton, paint: paint };
})();
