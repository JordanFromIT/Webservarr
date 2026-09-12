/**
 * WebServarr — Shared Auth Utilities
 * Session check, user display, and common helpers.
 */

/**
 * Paint a user's identity into the header/sidebar chrome. Runs once
 * synchronously from a cached (possibly stale) user object for an instant
 * first paint, and again once the server confirms it. Display-only: it
 * never decides whether the caller is allowed to be here -- checkAuth does
 * that, and only ever off the fresh server answer (see the comment there).
 * @param {Object} user
 */
function paintUser(user) {
  if (!user) return;

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

  // Admin-gated nav/menu entries. Display-only -- every admin API route
  // (and the requireAdmin check in checkAuth below) still enforces this
  // server-side, so a stale or tampered cache can change what's shown here
  // but never what's allowed to succeed.
  document.querySelectorAll('[data-admin-only]').forEach(function (el) {
    el.hidden = !user.is_admin;
  });

  // Mobile top bar mirrors the desktop header's identity block.
  var mobileUsername = document.getElementById('mobileUsername');
  var mobileRole = document.getElementById('mobileRole');
  if (mobileUsername) mobileUsername.textContent = user.display_name || user.username;
  if (mobileRole) mobileRole.textContent = user.is_admin ? 'Admin' : 'User';
}

/**
 * Check if user has an active session. Redirects to /login if not.
 * Returns the user object on success, or null if redirecting.
 *
 * Paints from the sessionStorage cache (window.wsCache, see shell-cache.js)
 * synchronously before the network call, so a warm tab never shows a blank
 * avatar/username/admin nav while check-session is in flight. Enforcement
 * (the redirect below, and requireAdmin) only ever acts on the fresh server
 * answer -- a stale cache can change what's painted, never what's allowed.
 * wsCache isn't loaded on every page that includes auth.js (e.g. the ebook
 * reader); that path skips the cache entirely rather than guard every line.
 *
 * The actual write to the `ws.user` cache happens inside the apply()
 * callback passed to wsCache.swr() -- not out here after the await -- so it
 * shares swr()'s generation guard: if a logout races this call and clears
 * the cache before the fetch resolves, that write (and the repaint) is
 * silently dropped instead of restoring a signed-out (or, on a shared tab,
 * another user's) identity into sessionStorage. `ws.session` is a second,
 * internal-only cache key that exists purely to give swr() something to
 * diff/expire on the endpoint's actual `{authenticated, user}` response
 * shape -- nothing outside this function ever reads it. `ws.user` itself
 * stays the flat user object every other consumer (paintUser, Task 5's
 * admin gating) expects.
 * @param {Object} [options]
 * @param {boolean} [options.requireAdmin] - Redirect non-admins to /
 * @returns {Promise<Object|null>}
 */
async function checkAuth(options) {
  options = options || {};

  if (!window.wsCache) {
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
      paintUser(data.user);
      return data.user;
    } catch (e) {
      window.location.href = '/login';
      return null;
    }
  }

  var cachedUser = wsCache.read('ws.user', null);
  if (cachedUser) paintUser(cachedUser);

  var redirectTo = null;

  try {
    await wsCache.swr('ws.session', '/auth/check-session', 60000, function (data, isStale) {
      // The unbounded ws.user read above already painted the equivalent of
      // this stale replay; nothing new to do with it here.
      if (isStale) return;

      if (!data || !data.authenticated) {
        wsCache.clear();
        redirectTo = '/login';
        return;
      }
      if (options.requireAdmin && !data.user.is_admin) {
        redirectTo = '/';
        return;
      }
      wsCache.write('ws.user', data.user);
      paintUser(data.user);
    });
  } catch (e) {
    // Either a genuine 401 (swr's own handling) or a network/parse failure
    // -- both redirect to /login, matching the historical behavior of this
    // function on any check-session failure.
    redirectTo = '/login';
  }

  if (redirectTo) {
    window.location.href = redirectTo;
    return null;
  }

  // apply() may not have run at all -- e.g. ws.session was young enough
  // that swr() skipped the network round trip -- or it may have run and
  // been dropped by the generation guard because a logout raced this call.
  // Either way ws.user is now the single source of truth: still valid in
  // the first case, wiped by clear() in the second.
  return wsCache.read('ws.user', null);
}

/**
 * Wire up logout button(s).
 * Finds elements with id="logoutBtn" or data-logout and navigates to /auth/logout.
 */
function wireLogout() {
  var btns = document.querySelectorAll('#logoutBtn, [data-logout]');
  btns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      // Every logout path clears the cache -- otherwise the next person to
      // sign in on this tab would paint from the previous user's identity/
      // status/notification cache for an instant before the fresh fetch
      // lands.
      if (window.wsCache) window.wsCache.clear();
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
