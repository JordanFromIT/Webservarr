/**
 * WebServarr — Notification System
 * Bell icon + badge, dropdown panel, preferences modal, push subscription.
 *
 * Usage: call window.initNotifications() after checkAuth() resolves.
 * Requires: auth.js (escapeHtml, getTimeAgo), theme-loader.js (window.WEBSERVARR_THEME)
 *
 * CRITICAL: No innerHTML anywhere. All DOM built with createElement/textContent.
 */
(function() {
  'use strict';

  // ---- State ----
  var _lastCount = 0;
  var _pollTimer = null;
  var _dropdownOpen = false;
  var _modalOpen = false;

  // ---- Category config ----
  var CATEGORY_ICONS = {
    request: 'movie',
    issue: 'report_problem',
    service: 'health_metrics',
    news: 'newspaper',
    ticket: 'confirmation_number'
  };
  var CATEGORY_URLS = {
    request: '/requests',
    issue: '/issues',
    service: '/',
    news: '/',
    ticket: '/tickets'
  };
  var CATEGORY_LABELS = {
    request: 'Requests',
    issue: 'Issues',
    service: 'Service Status',
    news: 'Announcements',
    ticket: 'Tickets'
  };

  // ---- Helpers ----

  /**
   * Convenience wrapper for createElement with classes and optional text.
   */
  function createEl(tag, classes, text) {
    var el = document.createElement(tag);
    if (classes) el.className = classes;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  /**
   * Relative time: "2s ago", "5m ago", "3h ago", "2d ago".
   */
  function timeAgo(isoString) {
    if (!isoString) return '';
    var seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 0) seconds = 0;
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
    return new Date(isoString).toLocaleDateString();
  }

  /**
   * Convert VAPID base64 URL-safe string to Uint8Array for PushManager.subscribe().
   */
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // ---- Badge ----

  // Multiple bells may exist (desktop header + mobile top bar).
  // We wire all of them so the dropdown works regardless of viewport.
  var _bellButtons = [];
  var _badgeEls = [];
  var _primaryBell = null; // desktop bell used to anchor the dropdown

  /**
   * Find all bell buttons and wire them up with badges + click handlers.
   * Both header.js (desktop) and sidebar.js (mobile) create bell buttons.
   */
  function findOrCreateBell() {
    var existing = document.querySelectorAll('button[title*="Notification"]');
    if (existing.length > 0) {
      for (var i = 0; i < existing.length; i++) {
        var btn = existing[i];
        btn.title = 'Notifications';
        if (!btn.classList.contains('relative')) {
          btn.classList.add('relative');
        }
        _bellButtons.push(btn);
      }
    } else {
      // No bell found — create one and inject just before the user menu container
      var userMenuBtn = document.querySelector('#userMenuBtn');
      var userMenuContainer = userMenuBtn ? userMenuBtn.closest('.relative') : null;
      var flexParent = userMenuContainer ? userMenuContainer.parentElement : null;
      if (flexParent) {
        var btn = createEl('button', 'relative p-2 text-steel-blue hover:text-frosted-blue transition-colors group');
        btn.title = 'Notifications';
        var icon = createEl('span', 'material-symbols-outlined', 'notifications');
        btn.appendChild(icon);
        flexParent.insertBefore(btn, userMenuContainer);
        _bellButtons.push(btn);
      }
    }

    if (_bellButtons.length === 0) return;

    // Determine primary bell (desktop — inside the hidden lg:flex header)
    _primaryBell = _bellButtons[0];
    for (var i = 0; i < _bellButtons.length; i++) {
      var header = _bellButtons[i].closest('header');
      if (header && header.classList.contains('lg:flex')) {
        _primaryBell = _bellButtons[i];
        break;
      }
    }

    // Add badge + click handler to each bell
    for (var i = 0; i < _bellButtons.length; i++) {
      var badge = createEl('span',
        'absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center ' +
        'rounded-full bg-red-500 text-bright text-[10px] font-bold leading-none px-1 pointer-events-none'
      );
      badge.style.display = 'none';
      _bellButtons[i].appendChild(badge);
      _badgeEls.push(badge);

      _bellButtons[i].addEventListener('click', function(e) {
        e.stopPropagation();
        toggleDropdown();
      });
    }
  }

  /**
   * Update badge count on ALL bell buttons.
   */
  function updateBadge(count) {
    if (_badgeEls.length === 0) return;
    for (var i = 0; i < _badgeEls.length; i++) {
      var badge = _badgeEls[i];
      if (count <= 0) {
        badge.style.display = 'none';
        badge.textContent = '';
      } else {
        badge.style.display = '';
        badge.textContent = count > 99 ? '99+' : String(count);
        if (count > _lastCount && _lastCount >= 0) {
          badge.classList.remove('animate-pulse-once');
          void badge.offsetHeight;
          badge.classList.add('animate-pulse-once');
        }
      }
    }
    _lastCount = count;
  }

  // ---- Fetch Helpers ----

  function fetchUnreadCount() {
    return fetch('/api/notifications/unread-count')
      .then(function(r) { return r.ok ? r.json() : { count: 0 }; })
      .then(function(data) { return data.count || 0; })
      .catch(function() { return 0; });
  }

  function fetchNotifications() {
    return fetch('/api/notifications?limit=20')
      .then(function(r) { return r.ok ? r.json() : { notifications: [] }; })
      .then(function(data) { return data.notifications || []; })
      .catch(function() { return []; });
  }

  function markRead(id) {
    return fetch('/api/notifications/' + id + '/read', { method: 'PUT' })
      .catch(function() {});
  }

  function markAllRead() {
    return fetch('/api/notifications/read-all', { method: 'PUT' })
      .catch(function() {});
  }

  // ---- Dropdown Panel ----

  var _dropdown = null;
  var _notifList = null;

  function buildDropdown() {
    if (_dropdown) return;

    _dropdown = createEl('div',
      'absolute right-0 top-full mt-2 w-80 bg-black/95 border border-steel-blue/30 rounded-xl shadow-xl z-50 flex flex-col'
    );
    _dropdown.style.display = 'none';

    // Header
    var header = createEl('div', 'flex items-center justify-between px-4 py-3 border-b border-steel-blue/20');
    var title = createEl('span', 'text-sm font-bold text-frosted-blue', 'Notifications');
    var headerActions = createEl('div', 'flex items-center gap-3');
    var markAllBtn = createEl('button', 'text-[11px] text-steel-blue hover:text-primary transition-colors cursor-pointer', 'Mark all read');
    markAllBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      markAllRead().then(function() {
        updateBadge(0);
        loadDropdownItems();
      });
    });
    var clearAllBtn = createEl('button', 'text-[11px] text-steel-blue hover:text-red-400 transition-colors cursor-pointer', 'Clear all');
    clearAllBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      fetch('/api/notifications', { method: 'DELETE' })
        .then(function() {
          updateBadge(0);
          loadDropdownItems();
        })
        .catch(function() {});
    });
    headerActions.appendChild(markAllBtn);
    headerActions.appendChild(clearAllBtn);
    header.appendChild(title);
    header.appendChild(headerActions);
    _dropdown.appendChild(header);

    // List container
    _notifList = createEl('div', 'max-h-80 overflow-y-auto custom-scrollbar');
    _dropdown.appendChild(_notifList);

    // Footer
    var footer = createEl('div', 'px-4 py-3 border-t border-steel-blue/20');
    var prefsLink = createEl('button', 'text-[11px] text-steel-blue hover:text-primary transition-colors cursor-pointer w-full text-center', 'Notification settings');
    prefsLink.addEventListener('click', function(e) {
      e.stopPropagation();
      closeDropdown();
      openPreferencesModal();
    });
    footer.appendChild(prefsLink);
    _dropdown.appendChild(footer);

    // Attach to primary bell's parent (relative container)
    if (_primaryBell) {
      // Need a relative wrapper for proper positioning
      var wrapper = _primaryBell.parentElement;
      if (wrapper) {
        // Ensure parent has relative positioning for dropdown
        var pos = getComputedStyle(wrapper).position;
        if (pos === 'static') {
          wrapper.style.position = 'relative';
        }
      }
      _primaryBell.parentElement.appendChild(_dropdown);
    }
  }

  function loadDropdownItems() {
    if (!_notifList) return;

    fetchNotifications().then(function(notifications) {
      // Clear list
      while (_notifList.firstChild) _notifList.removeChild(_notifList.firstChild);

      if (notifications.length === 0) {
        var empty = createEl('div', 'flex flex-col items-center justify-center py-8 text-steel-blue');
        var emptyIcon = createEl('span', 'material-symbols-outlined text-3xl mb-2 opacity-50', 'notifications_none');
        var emptyText = createEl('p', 'text-xs', 'No notifications');
        empty.appendChild(emptyIcon);
        empty.appendChild(emptyText);
        _notifList.appendChild(empty);
        return;
      }

      notifications.forEach(function(n) {
        var item = buildNotificationItem(n);
        _notifList.appendChild(item);
      });
    });
  }

  function buildNotificationItem(n) {
    var item = createEl('div',
      'flex items-start gap-3 px-4 py-3 hover:bg-primary/10 transition-colors cursor-pointer border-b border-steel-blue/10 last:border-b-0'
    );

    // Category icon
    var iconName = CATEGORY_ICONS[n.category] || 'notifications';
    var iconEl = createEl('span', 'material-symbols-outlined text-steel-blue text-lg mt-0.5 shrink-0', iconName);
    item.appendChild(iconEl);

    // Content area
    var content = createEl('div', 'flex-1 min-w-0');

    // Title row
    var titleRow = createEl('div', 'flex items-center gap-2');
    var titleEl = createEl('span', 'text-xs font-bold text-frosted-blue truncate', n.title || 'Notification');
    var timeEl = createEl('span', 'text-[10px] text-steel-blue/60 shrink-0 ml-auto', timeAgo(n.created_at));
    titleRow.appendChild(titleEl);
    titleRow.appendChild(timeEl);
    content.appendChild(titleRow);

    // Body (truncated)
    if (n.body) {
      var bodyEl = createEl('p', 'text-[11px] text-frosted-blue/60 mt-0.5 line-clamp-2');
      bodyEl.textContent = n.body.length > 100 ? n.body.substring(0, 100) + '...' : n.body;
      content.appendChild(bodyEl);
    }

    item.appendChild(content);

    // Unread dot
    if (!n.read) {
      var dot = createEl('span', 'size-2 rounded-full bg-primary shrink-0 mt-2');
      item.appendChild(dot);
    }

    // Click handler — mark read + navigate
    item.addEventListener('click', function() {
      if (!n.read) {
        markRead(n.id);
        // Remove unread dot visually
        var dotEl = item.querySelector('.bg-primary.rounded-full.size-2');
        if (dotEl) dotEl.remove();
        n.read = true;
        // Decrement badge
        fetchUnreadCount().then(updateBadge);
      }
      closeDropdown();
      var targetUrl = CATEGORY_URLS[n.category] || '/';
      window.location.href = targetUrl;
    });

    return item;
  }

  function toggleDropdown() {
    if (_dropdownOpen) {
      closeDropdown();
    } else {
      openDropdown();
    }
  }

  function openDropdown() {
    buildDropdown();
    loadDropdownItems();
    if (_dropdown) _dropdown.style.display = '';
    _dropdownOpen = true;
  }

  function closeDropdown() {
    if (_dropdown) _dropdown.style.display = 'none';
    _dropdownOpen = false;
  }

  // ---- Preferences Modal ----

  var _modal = null;

  function openPreferencesModal() {
    if (_modal) {
      _modal.style.display = '';
      _modalOpen = true;
      loadPreferences();
      return;
    }

    // Build overlay
    _modal = createEl('div', 'fixed inset-0 z-[60] flex items-center justify-center');
    _modal.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
    _modal.style.backdropFilter = 'blur(4px)';

    // Close on backdrop click
    _modal.addEventListener('click', function(e) {
      if (e.target === _modal) closePreferencesModal();
    });

    // Modal card
    var card = createEl('div', 'bg-black/95 border border-steel-blue/30 rounded-2xl shadow-2xl w-full max-w-md mx-4');

    // Header
    var header = createEl('div', 'flex items-center justify-between px-6 py-4 border-b border-steel-blue/20');
    var headerTitle = createEl('h3', 'text-lg font-bold text-frosted-blue', 'Notification Preferences');
    var closeBtn = createEl('button', 'text-steel-blue hover:text-bright transition-colors cursor-pointer');
    var closeIcon = createEl('span', 'material-symbols-outlined', 'close');
    closeBtn.appendChild(closeIcon);
    closeBtn.addEventListener('click', closePreferencesModal);
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // Body
    var body = createEl('div', 'px-6 py-4 space-y-4');
    body.id = 'notifPrefsBody';

    // Category toggles
    var categories = ['request', 'issue', 'service', 'news'];
    categories.forEach(function(cat) {
      var row = createEl('div', 'flex items-center justify-between py-2');

      var labelArea = createEl('div', 'flex items-center gap-3');
      var catIcon = createEl('span', 'material-symbols-outlined text-steel-blue text-lg', CATEGORY_ICONS[cat] || 'notifications');
      var catLabel = createEl('span', 'text-sm text-frosted-blue', CATEGORY_LABELS[cat] || cat);
      labelArea.appendChild(catIcon);
      labelArea.appendChild(catLabel);
      row.appendChild(labelArea);

      // Toggle switch
      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = true; // default, will be updated by loadPreferences
      toggle.className = 'notif-toggle';
      toggle.dataset.category = cat;
      toggle.style.cssText = 'width:36px; height:20px; appearance:none; -webkit-appearance:none; ' +
        'background:rgb(var(--color-accent) / 0.3); border-radius:10px; position:relative; cursor:pointer; ' +
        'transition: background 0.2s;';
      applyToggleStyle(toggle, toggle.checked);

      toggle.addEventListener('change', function() {
        applyToggleStyle(this, this.checked);
        savePreference(this.dataset.category, this.checked);
      });

      row.appendChild(toggle);
      body.appendChild(row);
    });

    // Push notification toggle (conditional)
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      var divider = createEl('div', 'border-t border-steel-blue/20 pt-4 mt-2');
      var pushLabel = createEl('p', 'text-[11px] text-steel-blue/60 uppercase font-bold tracking-wider mb-3', 'Push Notifications');
      divider.appendChild(pushLabel);

      var pushRow = createEl('div', 'flex items-center justify-between py-2');
      var pushLabelArea = createEl('div', 'flex items-center gap-3');
      var pushIcon = createEl('span', 'material-symbols-outlined text-steel-blue text-lg', 'devices');
      var pushText = createEl('span', 'text-sm text-frosted-blue', 'Browser push notifications');
      pushLabelArea.appendChild(pushIcon);
      pushLabelArea.appendChild(pushText);
      pushRow.appendChild(pushLabelArea);

      var pushToggle = document.createElement('input');
      pushToggle.type = 'checkbox';
      pushToggle.id = 'pushToggle';
      pushToggle.style.cssText = 'width:36px; height:20px; appearance:none; -webkit-appearance:none; ' +
        'background:rgb(var(--color-accent) / 0.3); border-radius:10px; position:relative; cursor:pointer; ' +
        'transition: background 0.2s;';
      applyToggleStyle(pushToggle, false);

      // Check current push state
      checkPushState(pushToggle);

      pushToggle.addEventListener('change', function() {
        var enabled = this.checked;
        applyToggleStyle(this, enabled);
        if (enabled) {
          enablePush(this);
        } else {
          disablePush(this);
        }
      });

      pushRow.appendChild(pushToggle);
      divider.appendChild(pushRow);
      body.appendChild(divider);
    }

    card.appendChild(body);
    _modal.appendChild(card);
    document.body.appendChild(_modal);
    _modalOpen = true;

    loadPreferences();
  }

  /**
   * Style a toggle switch using pseudo-element-free approach with box-shadow as the knob.
   */
  function applyToggleStyle(toggle, checked) {
    if (checked) {
      toggle.style.background = 'rgb(var(--color-primary))';
      toggle.style.boxShadow = 'inset 16px 0 0 0 rgb(var(--color-text-secondary)), inset 0 0 0 1px rgb(var(--color-accent) / 0.5)';
    } else {
      toggle.style.background = 'rgb(var(--color-accent) / 0.3)';
      toggle.style.boxShadow = 'inset -16px 0 0 0 rgb(var(--color-text) / 0.6), inset 0 0 0 1px rgb(var(--color-accent) / 0.3)';
    }
  }

  function closePreferencesModal() {
    if (_modal) _modal.style.display = 'none';
    _modalOpen = false;
  }

  function loadPreferences() {
    fetch('/api/notifications/preferences')
      .then(function(r) { return r.ok ? r.json() : {}; })
      .then(function(prefs) {
        var toggles = document.querySelectorAll('.notif-toggle');
        toggles.forEach(function(t) {
          var cat = t.dataset.category;
          if (cat in prefs) {
            t.checked = prefs[cat];
            applyToggleStyle(t, t.checked);
          }
        });
      })
      .catch(function() {});
  }

  function savePreference(category, enabled) {
    var body = {};
    body[category] = enabled;
    fetch('/api/notifications/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(function() {});
  }

  // ---- Push Subscription ----

  function checkPushState(toggleEl) {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(function(reg) {
      reg.pushManager.getSubscription().then(function(sub) {
        var enabled = !!sub;
        toggleEl.checked = enabled;
        applyToggleStyle(toggleEl, enabled);
      });
    }).catch(function() {});
  }

  function enablePush(toggleEl) {
    var theme = window.WEBSERVARR_THEME || {};
    var vapidKey = theme.vapid_public_key;
    if (!vapidKey) {
      console.warn('VAPID public key not available. Push notifications cannot be enabled.');
      toggleEl.checked = false;
      applyToggleStyle(toggleEl, false);
      return;
    }

    Notification.requestPermission().then(function(permission) {
      if (permission !== 'granted') {
        toggleEl.checked = false;
        applyToggleStyle(toggleEl, false);
        return;
      }

      navigator.serviceWorker.ready.then(function(reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey)
        });
      }).then(function(subscription) {
        var subJSON = subscription.toJSON();
        return fetch('/api/notifications/push-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: subJSON.endpoint,
            keys: {
              p256dh: subJSON.keys.p256dh,
              auth: subJSON.keys.auth
            }
          })
        });
      }).then(function(resp) {
        if (!resp.ok) throw new Error('Subscribe failed');
      }).catch(function(err) {
        console.error('Push subscription error:', err);
        toggleEl.checked = false;
        applyToggleStyle(toggleEl, false);
      });
    });
  }

  function disablePush(toggleEl) {
    navigator.serviceWorker.ready.then(function(reg) {
      return reg.pushManager.getSubscription();
    }).then(function(subscription) {
      if (subscription) {
        return subscription.unsubscribe();
      }
    }).then(function() {
      return fetch('/api/notifications/push-subscribe', { method: 'DELETE' });
    }).catch(function(err) {
      console.error('Push unsubscribe error:', err);
    });
  }

  // ---- Close on outside click ----

  function handleOutsideClick(e) {
    if (!_dropdownOpen || !_dropdown || _dropdown.contains(e.target)) return;
    for (var i = 0; i < _bellButtons.length; i++) {
      if (_bellButtons[i].contains(e.target)) return;
    }
    closeDropdown();
  }

  // ---- Service Worker Registration ----

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/static/sw.js', { scope: '/' })
        .then(function() {
          // SW registered successfully
        })
        .catch(function(err) {
          console.error('Service worker registration failed:', err);
        });
    }
  }

  // ---- Init ----

  /**
   * Initialize the notification system. Call after authentication is confirmed.
   */
  function init() {
    // Find/create bell + badge
    findOrCreateBell();
    if (_bellButtons.length === 0) {
      // No bell button found and couldn't create one — skip init
      return;
    }

    // Register service worker
    registerServiceWorker();

    // Fetch initial count
    fetchUnreadCount().then(function(count) {
      _lastCount = -1; // Ensure first update doesn't pulse
      updateBadge(count);
    });

    // Poll every 30 seconds
    _pollTimer = setInterval(function() {
      fetchUnreadCount().then(updateBadge);
    }, 30000);

    // Close dropdown on outside click
    document.addEventListener('click', handleOutsideClick);
  }

  // Expose
  window.initNotifications = init;

})();
