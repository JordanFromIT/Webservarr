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
  // Through the router when the shell has one (shell.js WS.leaveTo).
  function leave(url) {
    if (window.WS && typeof window.WS.leaveTo === 'function') window.WS.leaveTo(url);
    else window.location.href = url;
  }
  var stamped = window.WS_DATA && window.WS_DATA.user;
  if (stamped) {
    if (options.requireAdmin && !stamped.is_admin) {
      leave('/');
      return null;
    }
    return stamped;
  }
  try {
    var resp = await fetch('/auth/check-session');
    var data = await resp.json();
    if (!data.authenticated) {
      leave('/login');
      return null;
    }
    if (options.requireAdmin && !data.user.is_admin) {
      leave('/');
      return null;
    }
    return data.user;
  } catch (e) {
    leave('/login');
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
      var router = window.WS && window.WS.router;
      if (router && typeof router.hardNavigate === 'function') router.hardNavigate('/auth/logout');
      else window.location.href = '/auth/logout';
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
 * The site's one relative date: "just now", "5 minutes ago", "3 hours ago",
 * "yesterday", "4 days ago", then the date itself. Words, not "5m" or "4d",
 * in lower case so it reads inside a sentence ("Checked 5 minutes ago"); pass
 * sentence=true where it stands alone ("Yesterday"). Takes a Date or an ISO
 * string; nothing in, nothing out.
 */
function getTimeAgo(date, sentence) {
  if (!date) return '';
  if (!(date instanceof Date)) date = new Date(date);
  if (isNaN(date.getTime())) return '';
  var seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  function ago(count, unit) { return count + ' ' + unit + (count === 1 ? '' : 's') + ' ago'; }
  var text;
  if (seconds < 60) text = 'just now';
  else if (seconds < 3600) text = ago(Math.floor(seconds / 60), 'minute');
  else if (seconds < 86400) text = ago(Math.floor(seconds / 3600), 'hour');
  else if (seconds < 172800) text = 'yesterday';
  else if (seconds < 604800) text = ago(Math.floor(seconds / 86400), 'day');
  else text = date.toLocaleDateString();
  return sentence ? text.charAt(0).toUpperCase() + text.slice(1) : text;
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
