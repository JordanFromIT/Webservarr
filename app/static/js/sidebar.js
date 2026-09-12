/**
 * WebServarr — Shared Sidebar Decorator
 * Desktop: persistent 256px sidebar. Mobile (<1024px): sticky top bar with
 * hamburger + slide-out drawer.
 *
 * The sidebar/topbar/drawer markup ships from the server (see
 * app/static/partials/shell.html) -- this file only wires interactivity
 * (drawer, mobile user menu, logout) and re-applies an operator's own
 * branding (Settings > Customization) on top of the shipped generic
 * defaults. It used to build the whole sidebar at runtime (see git history
 * for _buildSidebarHTML()/NAV_ITEMS); that's dead now that the static shell
 * partial ships it already rendered.
 */

// ---- Branding overrides ----
//
// Patches the static markup in place rather than rebuilding it: hides items
// disabled via sidebar_enabled or a false feature flag (both ship VISIBLE
// by default in the static partial, so a slow or missing branding fetch
// never blanks the nav -- this only ever hides), swaps label/sublabel/icon
// text, applies "New!" flags, and sets the app name/logo.
//
// Reads window.WEBSERVARR_THEME, which theme-loader.js populates
// synchronously from its own localStorage cache before this script runs
// (script order: theme-loader -> shell-cache -> auth -> header -> sidebar),
// so a warm branding cache patches in before first paint. Re-runs on
// theme-loader's 'webservarr:theme' event once a fresh /api/branding
// answer lands, so a cold cache (or a changed setting) still reaches every
// page without a reload.

/**
 * Add or remove the "New!" flag on a nav item's label span, without
 * touching whatever text is already there.
 */
function _applyNavNewBadge(labelEl, isNew) {
  var badge = labelEl.querySelector('.nav-new-badge');
  if (isNew && !badge) {
    badge = document.createElement('span');
    badge.className = 'nav-new-badge';
    badge.textContent = 'New!';
    labelEl.appendChild(badge);
  } else if (!isNew && badge) {
    badge.remove();
  }
}

/**
 * Overwrite a nav item's label text, preserving its "New!" badge (if any)
 * rather than clobbering it with a plain textContent assignment.
 */
function _setNavLabelText(labelEl, text) {
  var badge = labelEl.querySelector('.nav-new-badge');
  if (badge) badge.remove();
  labelEl.textContent = text;
  if (badge) labelEl.appendChild(badge);
}

function _applySidebarBranding() {
  var theme = window.WEBSERVARR_THEME;
  if (!theme) return;

  if (theme.app_name) {
    document.querySelectorAll('#appSidebar h1, #drawerPanel h1').forEach(function (h1) {
      h1.textContent = theme.app_name;
    });
    var topbarName = document.querySelector('#appTopbar > span.font-bold');
    if (topbarName) topbarName.textContent = theme.app_name;
  }
  if (theme.logo_url) {
    document.querySelectorAll('#appSidebar img[alt="Logo"], #drawerPanel img[alt="Logo"]').forEach(function (img) {
      img.src = theme.logo_url;
    });
  }

  var features = theme.features || {};
  var enabled = theme.sidebar_enabled || {};
  var labels = theme.sidebar_labels || {};
  var sublabels = theme.sidebar_sublabels || {};
  var icons = theme.icons || {};
  var news = theme.sidebar_new || {};

  // Every nav item exists twice (desktop nav + mobile drawer copy); both
  // carry the same data-nav-id, so one pass over the whole document patches
  // both.
  document.querySelectorAll('[data-nav-id]').forEach(function (link) {
    var id = link.dataset.navId;

    // Settings has no sidebar_enabled key (hiding it would lock the admin
    // out of the only page that could turn it back on) -- see branding.py.
    var hide = id !== 'settings' && enabled[id] === false;
    if (!hide && link.dataset.feature && features[link.dataset.feature] === false) hide = true;
    link.hidden = hide;

    var iconEl = link.querySelector('.material-symbols-outlined');
    if (iconEl && icons['nav_' + id]) iconEl.textContent = icons['nav_' + id];

    // The sublabel span also carries a `.truncate` class, so exclude it
    // explicitly rather than relying on document order to pick the label.
    var labelEl = link.querySelector('.truncate:not(.nav-sublabel)');
    if (labelEl) {
      if (labels[id] !== undefined) _setNavLabelText(labelEl, labels[id]);
      _applyNavNewBadge(labelEl, !!news[id]);
    }

    var subEl = link.querySelector('.nav-sublabel');
    if (subEl && sublabels[id] !== undefined) {
      // An empty sublabel is a real choice (hide the line), not "no
      // override yet" -- that's why this checks `!== undefined` rather
      // than truthiness.
      subEl.hidden = sublabels[id] === '';
      if (sublabels[id] !== '') subEl.textContent = sublabels[id];
    }
  });
}

_applySidebarBranding();
document.addEventListener('webservarr:theme', _applySidebarBranding);

// ---- Drawer, mobile user menu, logout ----

function _wireSidebarChrome() {
  var overlay = document.getElementById('drawerOverlay');
  var panel = document.getElementById('drawerPanel');
  var hamburger = document.getElementById('hamburgerBtn');
  var closeBtn = document.getElementById('drawerCloseBtn');

  function openDrawer() {
    overlay.classList.remove('hidden');
    // Force reflow before adding transform
    void panel.offsetHeight;
    panel.classList.remove('-translate-x-full');
    panel.classList.add('translate-x-0');
  }

  function closeDrawer() {
    panel.classList.remove('translate-x-0');
    panel.classList.add('-translate-x-full');
    setTimeout(function () { overlay.classList.add('hidden'); }, 300);
  }

  if (hamburger) hamburger.addEventListener('click', openDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  if (overlay) overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeDrawer();
  });

  // Wire mobile user menu dropdown
  var mobileUserBtn = document.getElementById('mobileUserMenuBtn');
  var mobileUserDropdown = document.getElementById('mobileUserMenuDropdown');
  if (mobileUserBtn && mobileUserDropdown) {
    mobileUserBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      mobileUserDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', function () {
      mobileUserDropdown.classList.add('hidden');
    });
  }

  // Wire logout buttons
  wireLogout();

  // Load version
  loadAppVersion();
}

if (document.getElementById('appSidebar') || document.getElementById('appTopbar')) {
  _wireSidebarChrome();
}

/**
 * Show/hide admin-only nav items based on user role.
 *
 * Kept for backward compatibility: every shell page still calls
 * showAdminNav(user.is_admin) right after checkAuth() resolves. auth.js's
 * paintUser() already reveals/hides every [data-admin-only] element (from
 * cache for an instant paint, then again from the server's answer) and
 * mirrors the mobile username/role onto the top bar -- this just re-applies
 * the same idempotent result, so those call sites keep working with
 * nothing left for this to actually change.
 * @param {boolean} isAdmin
 */
function showAdminNav(isAdmin) {
  document.querySelectorAll('[data-admin-only]').forEach(function (el) {
    el.hidden = !isAdmin;
  });

  var mobileUsername = document.getElementById('mobileUsername');
  var mobileRole = document.getElementById('mobileRole');
  var headerUsername = document.getElementById('headerUsername');
  var headerRole = document.getElementById('headerRole');
  if (mobileUsername && headerUsername) mobileUsername.textContent = headerUsername.textContent;
  if (mobileRole && headerRole) mobileRole.textContent = headerRole.textContent;
}
