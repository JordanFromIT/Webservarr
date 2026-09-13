/**
 * WebServarr — Shared Auth Utilities
 * Session check, user display, and common helpers.
 */

/**
 * The signed-in user. Resolves at once from the data block the server stamps
 * into every page (see app/pages.py); the /auth/check-session round trip is
 * only a fallback for a page served some other way. Redirects to /login when
 * there is no session, or to / when an admin-only page is opened by a member.
 * @param {Object} [options]
 * @param {boolean} [options.requireAdmin] - Redirect non-admins to /
 * @returns {Promise<Object|null>}
 */
async function checkAuth(options) {
  options = options || {};
  var stamped = window.WS_DATA && window.WS_DATA.user;
  if (stamped) {
    if (options.requireAdmin && !stamped.is_admin) {
      window.location.href = '/';
      return null;
    }
    return stamped;
  }
  try {
    var resp = await fetch('/auth/check-session');
    var data = await resp.json();
    if (!data.authenticated) {
      window.location.href = '/login';
      return null;
    }
    if (options.requireAdmin && !data.user.is_admin) {
      window.location.href = '/';
      return null;
    }
    return data.user;
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
 * Escapes & < > " ' so the result is safe in both text and quoted-attribute
 * contexts (a textContent/innerHTML round-trip leaves " and ' unescaped).
 */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * Relative time string from a date.
 */
function getTimeAgo(date) {
  var seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) {
    var mins = Math.floor(seconds / 60);
    var secs = seconds % 60;
    return mins + 'm ' + secs + 's ago';
  }
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 172800) return 'yesterday';
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
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
