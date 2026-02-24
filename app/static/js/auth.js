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
  if (seconds < 60) return 'JUST NOW';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' MIN AGO';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' HOURS AGO';
  if (seconds < 172800) return 'YESTERDAY';
  if (seconds < 604800) return Math.floor(seconds / 86400) + ' DAYS AGO';
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
 * Load app version from /health and display it.
 * @param {string} [elementId="appVersion"]
 */
async function loadAppVersion(elementId) {
  elementId = elementId || 'appVersion';
  try {
    var resp = await fetch('/health');
    var data = await resp.json();
    var el = document.getElementById(elementId);
    if (el && data.version) el.textContent = 'v' + data.version;
  } catch (e) {
    // silently fail
  }
}
