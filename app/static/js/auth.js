/**
 * HMS Dashboard — Shared Auth Utilities
 * Session check, user display, and common helpers.
 */

/**
 * Check if user has an active session. Redirects to /login if not.
 * Returns the user object on success, or null if redirecting.
 * @param {Object} [options]
 * @param {boolean} [options.requireAdmin] - Redirect non-admins to /
 * @returns {Promise<Object|null>}
 */
async function checkAuth(options) {
  options = options || {};
  try {
    var resp = await fetch('/auth/check-session');
    var data = await resp.json();
    if (!data.authenticated) {
      window.location.href = '/login';
      return null;
    }
    var user = data.user;

    if (options.requireAdmin && !user.is_admin) {
      window.location.href = '/';
      return null;
    }

    // Populate header elements if they exist
    var usernameEl = document.getElementById('headerUsername');
    var roleEl = document.getElementById('headerRole');
    if (usernameEl) usernameEl.textContent = user.display_name || user.username;
    if (roleEl) roleEl.textContent = user.is_admin ? 'Admin' : 'User';

    // Populate avatar if available
    var avatarEl = document.getElementById('headerAvatar');
    if (avatarEl && user.avatar_url) {
      avatarEl.style.backgroundImage = 'url(' + user.avatar_url + ')';
      avatarEl.style.backgroundSize = 'cover';
      avatarEl.style.backgroundPosition = 'center';
    }

    // Wire user menu dropdown if present
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

    return user;
  } catch (e) {
    window.location.href = '/login';
    return null;
  }
}

/**
 * Wire up logout button(s).
 * Finds elements with id="logoutBtn" or data-logout and navigates to /auth/logout.
 */
function wireLogout() {
  var btns = document.querySelectorAll('#logoutBtn, [data-logout]');
  btns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      window.location.href = '/auth/logout';
    });
  });
}

/**
 * Escape HTML to prevent XSS when inserting user-provided text.
 */
function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Relative time string from a date.
 */
function getTimeAgo(date) {
  var seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 5) return 'JUST NOW';
  if (seconds < 60) return seconds + 'S AGO';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'M AGO';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'H AGO';
  if (seconds < 172800) return 'YESTERDAY';
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'D AGO';
  return date.toLocaleDateString();
}

/**
 * Format seconds into a human-readable uptime string.
 */
function formatUptime(seconds) {
  var days = Math.floor(seconds / 86400);
  var hours = Math.floor((seconds % 86400) / 3600);
  var mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return days + 'd ' + hours + 'h';
  if (hours > 0) return hours + 'h ' + mins + 'm';
  return mins + 'm';
}

/**
 * Load system status from Uptime Kuma and update the status banner.
 * Can be called from any page that has a #systemStatus element.
 */
async function loadSystemStatus() {
  var banner = document.getElementById('systemStatus');
  if (!banner) return;
  try {
    var resp = await fetch('/api/integrations/service-status');
    if (!resp.ok) return;
    var services = await resp.json();
    if (!Array.isArray(services) || services.length === 0) return;

    var hasDown = services.some(function(s) { return s.status === 'down'; });
    var hasDegraded = services.some(function(s) { return s.status === 'degraded'; });

    var dotColor, textColor, label, bgClass;
    if (hasDown) {
      dotColor = 'bg-red-500'; textColor = 'text-red-500';
      label = 'System Issues Detected';
      bgClass = 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/30';
    } else if (hasDegraded) {
      dotColor = 'bg-yellow-500'; textColor = 'text-yellow-500';
      label = 'Degraded Performance';
      bgClass = 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-yellow-500/10 border border-yellow-500/30';
    } else {
      dotColor = 'bg-green-500 animate-pulse'; textColor = 'text-green-500';
      label = 'All Systems Online';
      bgClass = 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/30';
    }

    // Build using DOM methods (no innerHTML with dynamic content)
    banner.className = bgClass;
    while (banner.firstChild) banner.removeChild(banner.firstChild);
    var dot = document.createElement('span');
    dot.className = 'flex size-2 rounded-full ' + dotColor;
    var text = document.createElement('span');
    text.className = textColor + ' text-xs font-bold uppercase tracking-widest';
    text.textContent = label;
    banner.appendChild(dot);
    banner.appendChild(text);
  } catch (e) {
    // silently fail — status stays at "Loading..."
  }
}

/**
 * Load app version from /health and display it.
 * @param {string} [elementId="appVersion"]
 */
async function loadAppVersion(elementId) {
  elementId = elementId || 'appVersion';
  try {
    var resp = await fetch('/health');
    var data = await resp.json();
    if (!data.version) return;
    var versionText = 'v' + data.version;
    var el = document.getElementById(elementId);
    if (el) el.textContent = versionText;
    // Also populate mobile version elements
    document.querySelectorAll('.appVersionMobile').forEach(function(m) {
      m.textContent = versionText;
    });
  } catch (e) {
    // silently fail
  }
}
