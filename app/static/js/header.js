/**
 * WebServarr — Shared Header Component
 * Desktop only: system status, notification bell, user menu with dropdown.
 * Mobile uses the top bar from sidebar.js.
 *
 * Usage:
 *   <div id="header-root"></div>
 *   <script src="/static/js/header.js"></script>
 */

function _buildHeader() {
  var header = document.createElement('header');
  header.className = 'h-16 border-b border-steel-blue/20 hidden lg:flex items-center justify-between px-8 bg-black/40 backdrop-blur-md relative z-50';

  // Left: system status
  var left = document.createElement('div');
  left.className = 'flex items-center gap-6';
  var statusBadge = document.createElement('div');
  statusBadge.id = 'systemStatus';
  statusBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-steel-blue/10 border border-steel-blue/30';
  var dot = document.createElement('span');
  dot.className = 'flex size-2 rounded-full bg-steel-blue';
  var statusText = document.createElement('span');
  statusText.className = 'text-steel-blue text-xs font-bold uppercase tracking-widest';
  statusText.textContent = 'Loading...';
  statusBadge.appendChild(dot);
  statusBadge.appendChild(statusText);
  left.appendChild(statusBadge);

  // Right: notification bell + user menu
  var right = document.createElement('div');
  right.className = 'flex items-center gap-4';

  // Notification bell
  var bellBtn = document.createElement('button');
  bellBtn.className = 'relative p-2 text-steel-blue hover:text-frosted-blue transition-colors group';
  bellBtn.title = 'Notifications';
  var bellIcon = document.createElement('span');
  bellIcon.className = 'material-symbols-outlined';
  bellIcon.textContent = 'notifications';
  bellBtn.appendChild(bellIcon);
  right.appendChild(bellBtn);

  // User menu container
  var menuWrap = document.createElement('div');
  menuWrap.className = 'relative';

  // Menu button
  var menuBtn = document.createElement('button');
  menuBtn.id = 'userMenuBtn';
  menuBtn.className = 'flex items-center gap-3 pl-4 cursor-pointer hover:opacity-80 transition-opacity';

  var nameBlock = document.createElement('div');
  nameBlock.className = 'text-right';
  var username = document.createElement('p');
  username.id = 'headerUsername';
  username.className = 'text-sm font-bold text-frosted-blue leading-none';
  var role = document.createElement('p');
  role.id = 'headerRole';
  role.className = 'text-[10px] text-frosted-blue/60 mt-1';
  nameBlock.appendChild(username);
  nameBlock.appendChild(role);

  var avatar = document.createElement('div');
  avatar.id = 'headerAvatar';
  avatar.className = 'size-9 rounded-full bg-gradient-to-br from-baltic-blue to-cornflower-ocean border border-steel-blue/40';

  menuBtn.appendChild(nameBlock);
  menuBtn.appendChild(avatar);

  // Dropdown
  var dropdown = document.createElement('div');
  dropdown.id = 'userMenuDropdown';
  dropdown.className = 'hidden absolute right-0 top-full mt-2 w-48 bg-black/95 border border-steel-blue/30 rounded-xl shadow-xl py-2 z-50';

  // Account Settings link (admin-only)
  var settingsLink = document.createElement('a');
  settingsLink.href = '/settings';
  settingsLink.className = 'flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors';
  settingsLink.setAttribute('data-admin-only', 'true');
  settingsLink.style.display = 'none';
  var settingsIcon = document.createElement('span');
  settingsIcon.className = 'material-symbols-outlined text-steel-blue text-sm';
  settingsIcon.textContent = 'manage_accounts';
  settingsLink.appendChild(settingsIcon);
  settingsLink.appendChild(document.createTextNode('Account Settings'));

  // Sign Out button
  var logoutBtn = document.createElement('button');
  logoutBtn.className = 'w-full flex items-center gap-3 px-4 py-2.5 text-sm text-frosted-blue hover:bg-primary/20 transition-colors text-left';
  logoutBtn.setAttribute('data-logout', '');
  var logoutIcon = document.createElement('span');
  logoutIcon.className = 'material-symbols-outlined text-steel-blue text-sm';
  logoutIcon.textContent = 'logout';
  logoutBtn.appendChild(logoutIcon);
  logoutBtn.appendChild(document.createTextNode('Sign Out'));

  dropdown.appendChild(settingsLink);
  dropdown.appendChild(logoutBtn);

  menuWrap.appendChild(menuBtn);
  menuWrap.appendChild(dropdown);
  right.appendChild(menuWrap);

  header.appendChild(left);
  header.appendChild(right);

  return header;
}

function initHeader() {
  var root = document.getElementById('header-root');
  if (!root) return;

  var header = _buildHeader();
  root.appendChild(header);

  // Wire dropdown toggle
  var userMenuBtn = document.getElementById('userMenuBtn');
  var userMenuDropdown = document.getElementById('userMenuDropdown');
  if (userMenuBtn && userMenuDropdown) {
    userMenuBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      userMenuDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', function() {
      userMenuDropdown.classList.add('hidden');
    });
  }
}

initHeader();
