/**
 * WebServarr — Shared Sidebar Component
 * Desktop: persistent 256px sidebar.
 * Mobile (<1024px): sticky top bar with hamburger + slide-out drawer.
 *
 * Usage:
 *   <div id="sidebar-root"></div>
 *   <script src="/static/js/sidebar.js"></script>
 *   <script>initSidebar('home');</script>
 */

var NAV_ITEMS = [
  { id: 'home',     label: 'Home',        icon: 'home',                   href: '/' },
  { id: 'requests', label: 'Requests',    icon: 'movie',                 href: '/requests' },
  { id: 'requests-embed', label: 'Requests (Embed)', icon: 'download',  href: '/requests-embed', badgeId: 'requestsBadge', feature: 'show_requests' },
  { id: 'issues',    label: 'Issues',     icon: 'report_problem',        href: '/issues' },
  { id: 'calendar',  label: 'Calendar',    icon: 'calendar_month',        href: '/calendar' },
  { id: 'tickets',  label: 'Tickets',    icon: 'confirmation_number',   href: '/tickets', feature: 'show_tickets' },
  { id: 'settings', label: 'Settings',    icon: 'settings',              href: '/settings', adminOnly: true },
];

/**
 * Build the sidebar HTML.
 * @param {string} currentPage - id of the active nav item
 * @returns {string} HTML string
 */
function _buildSidebarHTML(currentPage) {
  var theme = window.WEBSERVARR_THEME || {};
  var appName = theme.app_name || 'WEBSERVARR';
  var features = theme.features || {};
  var labels = theme.sidebar_labels || {};
  var icons = theme.icons || {};
  var logoIcon = icons.sidebar_logo || 'settings_input_component';
  var logoUrl = theme.logo_url || '';

  // Filter by feature flags and apply label/icon overrides
  var visibleItems = NAV_ITEMS.filter(function (item) {
    if (item.feature && !features[item.feature]) return false;
    return true;
  }).map(function (item) {
    var overrides = {};
    var customLabel = labels[item.id];
    if (customLabel) overrides.label = customLabel;
    var customIcon = icons['nav_' + item.id];
    if (customIcon) overrides.icon = customIcon;
    if (Object.keys(overrides).length > 0) {
      return Object.assign({}, item, overrides);
    }
    return item;
  });

  // Nav links
  var navLinks = visibleItems.map(function (item) {
    var isActive = item.id === currentPage;
    var adminAttr = item.adminOnly ? ' data-admin-only="true" style="display:none"' : '';
    var badge = item.badgeId
      ? '<span id="' + item.badgeId + '" class="ml-auto bg-primary/20 text-[10px] px-1.5 py-0.5 rounded font-bold hidden"></span>'
      : '';

    if (isActive) {
      return '<a class="flex items-center gap-3 px-4 py-3 rounded-lg bg-primary text-background-dark font-bold transition-all shadow-baltic-blue/20" href="' + item.href + '"' + adminAttr + '>' +
        '<span class="material-symbols-outlined fill-1">' + item.icon + '</span>' +
        '<span>' + item.label + '</span>' + badge + '</a>';
    }
    return '<a class="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-frosted-blue/5 text-frosted-blue transition-all group" href="' + item.href + '"' + adminAttr + '>' +
      '<span class="material-symbols-outlined text-steel-blue group-hover:text-primary transition-colors">' + item.icon + '</span>' +
      '<span>' + item.label + '</span>' + badge + '</a>';
  }).join('\n');

  // Logo: image if logo_url set, otherwise icon
  var logoHtml = logoUrl
    ? '<img src="' + escapeHtml(logoUrl) + '" alt="Logo" class="w-full h-auto rounded-lg object-contain mb-3">'
    : '<div class="size-14 bg-primary rounded-lg flex items-center justify-center shadow-lg shadow-baltic-blue/20 mb-3">' +
        '<span class="material-symbols-outlined text-background-dark font-bold text-3xl">' + escapeHtml(logoIcon) + '</span>' +
      '</div>';

  // Desktop sidebar
  var desktopSidebar = '' +
    '<aside id="desktopSidebar" class="hidden lg:flex w-64 bg-baltic-blue/20 border-r border-steel-blue/30 flex-col h-screen shrink-0">' +
      '<div class="p-6 flex flex-col items-center">' +
        logoHtml +
        '<h1 class="text-frosted-blue font-bold text-lg leading-none text-center">' + escapeHtml(appName) + '</h1>' +
      '</div>' +
      '<nav class="flex-1 px-4 py-6 space-y-2 opacity-0 transition-opacity duration-200" id="desktopNav">' + navLinks + '</nav>' +
      '<div class="p-4 border-t border-steel-blue/20">' +
        '<p id="appVersion" class="text-steel-blue text-[10px] text-center" data-admin-only="true" style="display:none"></p>' +
      '</div>' +
    '</aside>';

  // Mobile top bar + drawer
  var mobileTopBar = '' +
    '<div id="mobileTopBar" class="lg:hidden sticky top-0 z-40 h-14 bg-black/80 backdrop-blur-md border-b border-steel-blue/20 flex items-center justify-between px-4">' +
      '<button id="hamburgerBtn" class="p-2 text-steel-blue hover:text-bright transition-colors">' +
        '<span class="material-symbols-outlined">menu</span>' +
      '</button>' +
      '<span class="text-frosted-blue font-bold text-sm truncate max-w-[40%]">' + escapeHtml(appName) + '</span>' +
      '<div class="relative flex items-center gap-1 sm:gap-2 min-w-0">' +
        '<button class="relative p-1.5 sm:p-2 text-steel-blue hover:text-frosted-blue transition-colors shrink-0" title="Notifications">' +
          '<span class="material-symbols-outlined">notifications</span>' +
        '</button>' +
        '<button id="mobileUserMenuBtn" class="flex items-center gap-1.5 sm:gap-2 cursor-pointer hover:opacity-80 transition-opacity min-w-0">' +
          '<div class="text-right min-w-0">' +
            '<p id="mobileUsername" class="text-xs font-bold text-frosted-blue leading-none truncate max-w-[80px] sm:max-w-[120px]"></p>' +
            '<p id="mobileRole" class="text-[10px] text-steel-blue hidden sm:block"></p>' +
          '</div>' +
        '</button>' +
        '<div id="mobileUserMenuDropdown" class="hidden absolute right-0 top-full mt-2 w-48 bg-black/95 border border-steel-blue/30 rounded-xl shadow-xl py-2 z-50">' +
          '<a href="/settings" class="flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors" data-admin-only="true" style="display:none">' +
            '<span class="material-symbols-outlined text-steel-blue text-sm">manage_accounts</span>' +
            'Account Settings' +
          '</a>' +
          '<button data-logout class="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors text-left">' +
            '<span class="material-symbols-outlined text-steel-blue text-sm">logout</span>' +
            'Sign Out' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Mobile drawer overlay
  var mobileDrawer = '' +
    '<div id="drawerOverlay" class="lg:hidden fixed inset-0 z-50 bg-black/60 hidden" style="backdrop-filter:blur(2px)">' +
      '<aside id="drawerPanel" class="w-72 bg-background-dark border-r border-steel-blue/30 h-full flex flex-col transform -translate-x-full transition-transform duration-300">' +
        '<div class="p-6">' +
          '<div class="flex items-center justify-between mb-3">' +
            '<div class="flex-1"></div>' +
            '<button id="drawerCloseBtn" class="p-1 text-steel-blue hover:text-bright transition-colors">' +
              '<span class="material-symbols-outlined">close</span>' +
            '</button>' +
          '</div>' +
          '<div class="flex flex-col items-center">' +
            logoHtml +
            '<h1 class="text-frosted-blue font-bold text-lg leading-none text-center">' + escapeHtml(appName) + '</h1>' +
          '</div>' +
        '</div>' +
        '<nav class="flex-1 px-4 py-4 space-y-2 opacity-0 transition-opacity duration-200" id="drawerNav">' + navLinks + '</nav>' +
        '<div class="p-4 border-t border-steel-blue/20">' +
          '<button data-logout class="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium text-steel-blue hover:text-bright transition-colors">' +
            '<span class="material-symbols-outlined text-sm">logout</span> Sign Out' +
          '</button>' +
          '<p class="appVersionMobile text-steel-blue text-[10px] text-center mt-2" data-admin-only="true" style="display:none"></p>' +
        '</div>' +
      '</aside>' +
    '</div>';

  return desktopSidebar + mobileTopBar + mobileDrawer;
}

/**
 * Initialize the sidebar component.
 * @param {string} currentPage - id of the active nav item (e.g. 'home', 'activity')
 */
function initSidebar(currentPage) {
  var root = document.getElementById('sidebar-root');
  if (!root) return;

  root.innerHTML = _buildSidebarHTML(currentPage);

  // Wire hamburger / drawer
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
    mobileUserBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      mobileUserDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', function() {
      mobileUserDropdown.classList.add('hidden');
    });
  }

  // Wire logout buttons
  wireLogout();

  // Load version
  loadAppVersion();
}

/**
 * Show/hide admin-only nav items based on user role.
 * Call after checkAuth() returns the user.
 * @param {boolean} isAdmin
 */
function showAdminNav(isAdmin) {
  if (isAdmin) {
    var items = document.querySelectorAll('[data-admin-only]');
    items.forEach(function (el) {
      el.style.display = '';
    });
  }

  // Fade in nav sections (prevents flicker of admin items popping in)
  var desktopNav = document.getElementById('desktopNav');
  var drawerNav = document.getElementById('drawerNav');
  if (desktopNav) desktopNav.classList.replace('opacity-0', 'opacity-100');
  if (drawerNav) drawerNav.classList.replace('opacity-0', 'opacity-100');

  // Also populate mobile user info
  var mobileUsername = document.getElementById('mobileUsername');
  var mobileRole = document.getElementById('mobileRole');
  var headerUsername = document.getElementById('headerUsername');
  var headerRole = document.getElementById('headerRole');
  if (mobileUsername && headerUsername) mobileUsername.textContent = headerUsername.textContent;
  if (mobileRole && headerRole) mobileRole.textContent = headerRole.textContent;
}
