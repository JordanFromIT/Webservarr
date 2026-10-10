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
  var _pollStop = null;     // the unread count's poll (WS.poll); set once per document
  var _dropdownOpen = false;
  var _modalOpen = false;

  // ---- Category config ----
  // "service" is no longer sent (the status feed's "status" replaced it) but
  // keeps its icon and link for the notifications filed before.
  var CATEGORY_ICONS = {
    request: 'movie',
    issue: 'report_problem',
    service: 'health_metrics',
    status: 'health_metrics',
    news: 'newspaper',
    ticket: 'confirmation_number',
    books: 'menu_book'
  };
  var CATEGORY_URLS = {
    request: '/requests',
    issue: '/issues',
    service: '/',
    status: '/status',
    news: '/',
    ticket: '/tickets',
    books: '/books'
  };
  var CATEGORY_LABELS = {
    request: 'Requests',
    issue: 'Issues',
    status: 'Server status',
    news: 'Announcements',
    ticket: 'Ticket replies and updates',
    books: 'New books in your series'
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
   * A Material Symbols icon, hidden from screen readers: its text is the
   * icon's name (a font ligature), which would otherwise be read aloud.
   */
  function createIcon(classes, name) {
    var icon = createEl('span', classes, name);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
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
  // We wire all of them so the dropdown works regardless of viewport. Only one
  // is ever visible: the other sits inside a display:none bar, so the dropdown
  // is anchored to whichever bell was tapped, never to a fixed one.
  var _bellButtons = [];
  var _badgeEls = [];

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
        btn.setAttribute('aria-label', 'Notifications');
        var icon = createIcon('material-symbols-outlined', 'notifications');
        btn.appendChild(icon);
        flexParent.insertBefore(btn, userMenuContainer);
        _bellButtons.push(btn);
      }
    }

    if (_bellButtons.length === 0) return;

    // Add badge + click handler to each bell
    for (var i = 0; i < _bellButtons.length; i++) {
      var badge = createEl('span',
        'absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center ' +
        'rounded-full bg-primary text-bright text-xs font-bold leading-none px-1 pointer-events-none'
      );
      badge.style.display = 'none';
      _bellButtons[i].appendChild(badge);
      _badgeEls.push(badge);

      _bellButtons[i].addEventListener('click', function(e) {
        e.stopPropagation();
        toggleDropdown(this);
      });
    }
  }

  /**
   * The server's unread count, shown on ALL bell buttons with the ask
   * notice's one (see "The ask notice") added while it is unread.
   */
  var _serverCount = 0;
  function updateBadge(count) {
    _serverCount = count;
    drawBadge();
  }

  function drawBadge() {
    var count = _serverCount + (_noticeUnread && noticeKind() ? 1 : 0);
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

  // A 401 means the session ended while the page stayed open: go to sign-in
  // rather than showing an empty list. Any other failure stays silent.
  function signIn() {
    if (window.WS && typeof WS.leaveTo === 'function') WS.leaveTo('/login');
    else window.location.href = '/login';
  }

  function fetchUnreadCount() {
    return fetch('/api/notifications/unread-count')
      .then(function(r) {
        if (r.status === 401) { signIn(); return { count: 0 }; }
        return r.ok ? r.json() : { count: 0 };
      })
      .then(function(data) { return data.count || 0; })
      .catch(function() { return 0; });
  }

  /** Resolves to the list, or null when the user is being sent to sign in. */
  function fetchNotifications() {
    return fetch('/api/notifications?limit=20')
      .then(function(r) {
        if (r.status === 401) { signIn(); return null; }
        return r.ok ? r.json() : { notifications: [] };
      })
      .then(function(data) { return data ? (data.notifications || []) : null; })
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
  var _notifList = null;   // the scrolling list: _noticeSlot, then _itemsBox
  var _itemsBox = null;

  function buildDropdown() {
    if (_dropdown) return;

    // ws-pop: theme.css fades it open (.is-open) and closed (.hidden); WS.popOpen
    // and WS.popClose in shell.js switch the classes in the right order. The
    // service status panel's open and close, on the site's one frosted
    // surface (ws-frost).
    _dropdown = createEl('div',
      'ws-pop hidden absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] ws-frost border rounded-xl z-50 flex flex-col'
    );

    // Header
    var header = createEl('div', 'flex items-center justify-between px-4 py-3 border-b border-steel-blue/20');
    var title = createEl('span', 'text-sm font-bold text-frosted-blue', 'Notifications');
    var headerActions = createEl('div', 'flex items-center gap-3');
    var markAllBtn = createEl('button', 'text-label text-frosted-blue/80 hover:text-frosted-blue transition-colors cursor-pointer', 'Mark all read');
    markAllBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      markAllRead().then(function() {
        updateBadge(0);
        loadDropdownItems();
      });
    });
    var clearAllBtn = createEl('button', 'text-label text-frosted-blue/80 hover:text-frosted-blue transition-colors cursor-pointer', 'Clear all');
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

    // List container: the ask notice pinned at the top, then the items.
    _notifList = createEl('div', 'max-h-80 overflow-y-auto custom-scrollbar');
    _noticeSlot = createEl('div');
    _noticeSlot.hidden = true;
    _itemsBox = createEl('div');
    _notifList.appendChild(_noticeSlot);
    _notifList.appendChild(_itemsBox);
    _dropdown.appendChild(_notifList);
    renderNotice();

    // Footer
    var footer = createEl('div', 'px-4 py-3 border-t border-steel-blue/20');
    var prefsLink = createEl('button', 'text-label text-frosted-blue/80 hover:text-frosted-blue transition-colors cursor-pointer w-full text-center', 'Notification settings');
    prefsLink.addEventListener('click', function(e) {
      e.stopPropagation();
      closeDropdown();
      openPreferencesModal();
    });
    footer.appendChild(prefsLink);
    _dropdown.appendChild(footer);
  }

  /**
   * Move the dropdown next to the given bell. The bell's parent is the
   * positioning container, so the panel drops from the bell that was tapped.
   */
  function anchorDropdown(bell) {
    var wrapper = bell && bell.parentElement;
    if (!wrapper || _dropdown.parentElement === wrapper) return;
    if (getComputedStyle(wrapper).position === 'static') {
      wrapper.style.position = 'relative';
    }
    wrapper.appendChild(_dropdown);
  }

  // The last list read, kept so the panel opens already full: it unfolds at
  // its real height every time, as the status panel does, rather than
  // opening short and growing when the list arrives. What the list says
  // (not its "5m ago" words) decides whether a fresh read redraws it.
  var _items = null;
  var _itemsSig = '';

  function itemsSig(notifications) {
    return JSON.stringify(notifications.map(function(n) {
      return [n.id, n.read, n.title, n.body, n.category, n.created_at];
    }));
  }

  function renderItems(notifications) {
    _itemsSig = itemsSig(notifications);
    while (_itemsBox.firstChild) _itemsBox.removeChild(_itemsBox.firstChild);

    if (notifications.length === 0) {
      var empty = createEl('div', 'flex flex-col items-center justify-center py-8 text-frosted-blue/80');
      var emptyIcon = createIcon('material-symbols-outlined text-3xl mb-2 opacity-50', 'notifications_none');
      var emptyText = createEl('p', 'text-xs', 'No notifications');
      empty.appendChild(emptyIcon);
      empty.appendChild(emptyText);
      _itemsBox.appendChild(empty);
      return;
    }

    notifications.forEach(function(n) {
      _itemsBox.appendChild(buildNotificationItem(n));
    });
  }

  function loadDropdownItems() {
    if (!_notifList) return;

    fetchNotifications().then(function(notifications) {
      if (notifications === null) return;   // leaving for /login
      _items = notifications;
      // Unchanged: leave the list drawn, so an open panel never jumps.
      if (_itemsBox.firstChild && itemsSig(notifications) === _itemsSig) return;
      renderItems(notifications);
    });
  }

  function buildNotificationItem(n) {
    var item = createEl('div',
      'flex items-start gap-3 px-4 py-3 hover:bg-primary/10 transition-colors cursor-pointer border-b border-steel-blue/10 last:border-b-0'
    );

    // Category icon
    var iconName = CATEGORY_ICONS[n.category] || 'notifications';
    var iconEl = createIcon('material-symbols-outlined text-steel-blue text-lg mt-0.5 shrink-0', iconName);
    item.appendChild(iconEl);

    // Content area
    var content = createEl('div', 'flex-1 min-w-0');

    // Title row
    var titleRow = createEl('div', 'flex items-center gap-2');
    var titleEl = createEl('span', 'text-xs font-bold text-frosted-blue truncate', n.title || 'Notification');
    var timeEl = createEl('span', 'text-label text-frosted-blue/80 shrink-0 ml-auto', getTimeAgo(n.created_at, true));
    titleRow.appendChild(titleEl);
    titleRow.appendChild(timeEl);
    content.appendChild(titleRow);

    // Body (truncated)
    if (n.body) {
      var bodyEl = createEl('p', 'text-label text-frosted-blue/80 mt-0.5 line-clamp-2');
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
      // Like any link: a soft navigation, so what plays in #wsPlayer plays on.
      if (window.WS && WS.router && typeof WS.router.navigate === 'function') WS.router.navigate(targetUrl);
      else window.location.href = targetUrl;
    });

    return item;
  }

  function toggleDropdown(bell) {
    // Open under a different bell (the window crossed the desktop breakpoint)
    // moves the panel to the bell that was tapped rather than closing it.
    if (_dropdownOpen && _dropdown.parentElement === bell.parentElement) {
      closeDropdown();
    } else {
      openDropdown(bell);
    }
  }

  function openDropdown(bell) {
    buildDropdown();
    anchorDropdown(bell);
    // The list read before is drawn now (its times fresh), then read again.
    if (_items) renderItems(_items);
    loadDropdownItems();
    // The notice is drawn as things stand now, and opening the list is
    // reading it: it leaves the badge (it stays in the list until answered).
    renderNotice();
    _noticeUnread = false;
    drawBadge();
    // Two steps with a reflow between (see WS.popOpen), so every open fades in.
    if (_dropdown) WS.popOpen(_dropdown);
    _dropdownOpen = true;
    // Close the account menu (see the ws:menu-open note in shell.js).
    document.dispatchEvent(new CustomEvent('ws:menu-open', { detail: _dropdown }));
  }

  function handleOtherMenuOpen(e) {
    if (_dropdownOpen && e.detail !== _dropdown) closeDropdown();
  }

  function closeDropdown() {
    if (_dropdown) WS.popClose(_dropdown);
    _dropdownOpen = false;
  }

  // ---- The ask notice ----
  //
  // A later visit's ask, as the first entry in the list rather than a bubble
  // over the page: turning on notifications when push is not set up on this
  // device, or, on a phone, adding the site to the home screen. Whether it
  // may ask is theme-loader.js WSAsk, shared with the welcome tour and Home's
  // banner, so one "Don't ask me again" silences all three:
  //   Turn on / Add       the browser's own question, from the tap
  //                       (WSPush.subscribe, the same path as the tour)
  //   Not now             WSAsk 'later': gone until the next visit (a full
  //                       load or a sign-in), as the tour's Not now
  //   Don't ask me again  "Stop asking?" first, then WSAsk 'never'
  // Nothing while the welcome tour has not been shown here (it asks first),
  // nor in a visit where the tour or the banner has already asked. At most
  // one notice per visit: notifications first, except on an iPhone or iPad
  // in a browser tab, where the home screen comes first (push needs it), as
  // in the tour. The home screen never on a wide screen or from inside it.
  //
  // It lives only here: never in the server's list, never marked read there.
  // It counts as one unread in the badge until the list is opened or the
  // notice is answered.

  var _noticeSlot = null;
  var _noticeKind = '';       // this visit's one notice, once one has qualified
  var _noticeEnded = false;   // answered in this visit
  var _noticeUnread = true;   // counted in the badge until the list is opened
  var _noticeView = '';       // '' | 'confirm' | 'menu' | 'error'
  var _noticeError = '';
  var _noticeBusy = false;

  // Literal class lists, so Tailwind compiles them.
  var NOTICE_BTN = {
    primary: 'px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-bright text-xs font-bold transition-colors disabled:opacity-60',
    quiet: 'px-2.5 py-1.5 rounded-lg text-xs font-semibold text-frosted-blue/80 hover:text-frosted-blue hover:bg-frosted-blue/5 transition-colors disabled:opacity-60',
    link: 'mt-1 min-h-6 inline-flex items-center text-label text-frosted-blue/80 hover:text-frosted-blue underline underline-offset-2 disabled:opacity-60'
  };

  function asker() { return window.WSAsk; }

  function noticeAllowed(kind) {
    var a = asker();
    if (!a || !a.welcomeSeen() || a.asked() || a.snoozed(kind)) return false;
    var state = a.get(kind);
    if (state === 'never') return false;
    if (kind === 'install') return state !== 'done' && a.homeOffered();
    var push = a.pushKind();
    return push !== 'granted' && push !== 'unsupported';
  }

  /** The notice to show now: 'push', 'install' or ''. */
  function noticeKind() {
    if (_noticeEnded) return '';
    if (!_noticeKind) {
      var a = asker();
      var order = a && a.pushKind() === 'ios' ? ['install', 'push'] : ['push', 'install'];
      for (var i = 0; i < order.length && !_noticeKind; i++) {
        if (noticeAllowed(order[i])) _noticeKind = order[i];
      }
    }
    return _noticeKind && noticeAllowed(_noticeKind) ? _noticeKind : '';
  }

  function words() { return (asker() && asker().words) || {}; }
  function onIOS() { return typeof window.WSInstallIOS === 'function' && !!window.WSInstallIOS(); }

  /* What the notice says now: its words, steps and buttons. */
  function noticeContent(kind) {
    var w = words();
    var stop = { label: 'Don’t ask me again', kind: 'link', run: function () { setNoticeView('confirm'); } };
    var later = { label: 'Not now', kind: 'quiet', run: function () { noticeAnswer('later'); } };
    if (_noticeView === 'confirm') {
      return { icon: kind === 'push' ? 'notifications' : 'add_to_home_screen', title: 'Stop asking?', body: kind === 'push' ? w.PUSH_STOP : w.HOME_STOP, say: true,
               actions: [{ label: 'Stop asking', kind: 'primary', run: function () { noticeAnswer('never'); } },
                         { label: 'Cancel', kind: 'quiet', focus: true, run: function () { setNoticeView('', 'link'); } }] };
    }
    if (kind === 'install') {
      var base = { icon: 'add_to_home_screen', title: w.HOME_TITLE };
      var done = { label: 'Done', kind: 'primary', run: function () { noticeAnswer('done'); } };
      if (_noticeView === 'menu') {
        return Object.assign(base, { body: w.HOME_MENU, list: w.MENU_STEPS, say: true, actions: [Object.assign({ focus: true }, done), later] });
      }
      if (onIOS()) {
        return Object.assign(base, { body: w.homeBody() + ' On an iPhone or iPad it’s also how you get notifications.', list: w.IOS_STEPS,
                                     actions: [done, later, stop] });
      }
      return Object.assign(base, { body: w.homeBody(),
                                   actions: [{ label: w.HOME_TITLE, kind: 'primary', run: addToHomeScreen }, later, stop] });
    }
    var push = asker().pushKind();
    if (push === 'blocked') {
      return { icon: 'notifications', title: 'Notifications are blocked', body: w.PUSH_BLOCKED, actions: [later, stop] };
    }
    if (push === 'ios') {
      return { icon: 'notifications', title: 'Turn on notifications', body: w.PUSH_IOS, list: w.IOS_STEPS, actions: [later, stop] };
    }
    return { icon: 'notifications_active', title: 'Turn on notifications',
             body: _noticeView === 'error' ? _noticeError : w.PUSH_OFFER, say: _noticeView === 'error',
             actions: [{ label: 'Turn on', kind: 'primary', busyLabel: 'Turning on…', run: turnOnPush }, later, stop] };
  }

  function noticeSteps(items) {
    var ol = createEl('ol', 'mt-1.5 ps-4 list-decimal space-y-0.5 text-label text-frosted-blue/80');
    items.forEach(function (item) {
      var parts = Array.isArray(item) ? item : [item];
      var li = createEl('li', null, parts[0] || '');
      if (parts[1]) li.appendChild(createIcon('material-symbols-outlined tour-glyph', parts[1]));
      if (parts[2]) li.appendChild(document.createTextNode(parts[2]));
      ol.appendChild(li);
    });
    return ol;
  }

  /** Draws the notice into the top of the list, or empties the slot. focusOn:
   *  'link' (Don't ask me again), or a button asked for with focus: true. */
  function renderNotice(focusOn) {
    if (!_noticeSlot) return;
    var kind = noticeKind();
    var hadFocus = _noticeSlot.contains(document.activeElement);
    while (_noticeSlot.firstChild) _noticeSlot.removeChild(_noticeSlot.firstChild);
    _noticeSlot.hidden = !kind;
    if (!kind) {
      _noticeView = '';
      // Answered from the keyboard: focus goes back to the bell.
      if (hadFocus) focusOpenBell();
      return;
    }
    var c = noticeContent(kind);
    var box = createEl('div', 'flex items-start gap-3 px-4 py-3 bg-primary/10 border-b border-steel-blue/10');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-labelledby', 'wsNoticeTitle');
    box.setAttribute('data-ws-notice', kind);
    box.appendChild(createIcon('material-symbols-outlined text-steel-blue text-lg mt-0.5 shrink-0', c.icon));
    var content = createEl('div', 'flex-1 min-w-0');
    var title = createEl('p', 'text-xs font-bold text-frosted-blue', c.title);
    title.id = 'wsNoticeTitle';
    content.appendChild(title);
    content.appendChild(createEl('p', 'text-label text-frosted-blue/80 mt-0.5', c.body));
    if (c.list && c.list.length) content.appendChild(noticeSteps(c.list));

    var row = createEl('div', 'mt-2 flex flex-wrap items-center gap-2');
    var buttons = [];
    var wanted = null;
    var link = null;
    c.actions.forEach(function (a) {
      var b = createEl('button', NOTICE_BTN[a.kind], a.label);
      b.type = 'button';
      b.addEventListener('click', function (e) {
        // The click must not reach the page's "outside the list" close: the
        // button may be gone from the list by then.
        e.stopPropagation();
        if (_noticeBusy) return;
        a.run(b, a);
      });
      buttons.push(b);
      if (a.kind === 'link') { link = b; return; }
      row.appendChild(b);
      if (a.focus && !wanted) wanted = b;
    });
    content.appendChild(row);
    // The small link on a line of its own under the buttons, as in the tour.
    if (link) content.appendChild(link);
    var say = createEl('p', 'sr-only');
    say.setAttribute('aria-live', 'polite');
    content.appendChild(say);
    box.appendChild(content);
    _noticeSlot.appendChild(box);

    if (c.say) say.textContent = c.title + '. ' + c.body;
    var to = focusOn === 'link' ? link : (focusOn ? wanted || buttons[0] : null);
    if (to) { try { to.focus({ preventScroll: true }); } catch (e) { to.focus(); } }
  }

  function setNoticeView(view, focusOn) {
    _noticeView = view;
    renderNotice(focusOn || true);
  }

  /** The notice is answered: remembered in WSAsk (whose ws:ask event redraws
   *  the list and the badge) and gone for the rest of this visit. */
  function noticeAnswer(value) {
    var kind = _noticeKind;
    _noticeEnded = true;
    _noticeUnread = false;
    _noticeBusy = false;
    if (asker() && kind) asker().set(kind, value);
    renderNotice();
    drawBadge();
  }

  function focusOpenBell() {
    var wrapper = _dropdown && _dropdown.parentElement;
    var bell = wrapper && wrapper.querySelector('button[title="Notifications"]');
    if (bell) { try { bell.focus({ preventScroll: true }); } catch (e) { bell.focus(); } }
  }

  function noticeToast(text) {
    if (window.WSUI && typeof window.WSUI.toast === 'function') window.WSUI.toast(text, 'err');
  }

  /* Turn on: the shared subscribe path, straight from the tap (the browser
     only asks in answer to one). The notice goes the moment the browser says
     yes; the subscribe and the save finish behind it. */
  function turnOnPush(btn, action) {
    var push = window.WSPush;
    if (!push || typeof push.subscribe !== 'function') return;
    var gone = false;
    _noticeBusy = true;
    var all = _noticeSlot.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) all[i].disabled = true;
    btn.textContent = action.busyLabel;
    var result;
    try {
      result = push.subscribe(function () { gone = true; noticeAnswer(''); });
    } catch (e) {
      result = Promise.reject(e);
    }
    return Promise.resolve(result).then(function () {
      if (!gone) noticeAnswer('');
    }, function (err) {
      var kind = push.failureKind(err);
      // The browser's own question, answered no (the permission says so from
      // now on) or closed (a Not now).
      if (kind === 'blocked' || kind === 'dismissed') {
        if (!gone) noticeAnswer(kind === 'dismissed' ? 'later' : '');
        return;
      }
      var text = (push.messages && (push.messages[kind] || push.messages.failed)) || '';
      if (gone) { noticeToast(text); return; }
      _noticeBusy = false;
      _noticeError = text;
      setNoticeView('error');
    });
  }

  /* Add to home screen: the browser's own prompt where it has given us one
     (Chrome on Android), else the steps to take in its menu. */
  function addToHomeScreen() {
    var inst = window.WS && window.WS.install;
    if (window.WSInstallPrompt && inst && typeof inst.prompt === 'function') {
      Promise.resolve(inst.prompt()).then(function (outcome) {
        if (outcome === 'accepted') noticeAnswer('done');
        else if (outcome === 'dismissed') noticeAnswer('later');
        else setNoticeView('menu');      // nothing was shown after all
      }, function () { setNoticeView('menu'); });
      return;
    }
    setNoticeView('menu');
  }

  /* WSAsk changed (the tour's answer, the banner taking this visit's ask):
     the notice and the badge follow. */
  function handleAskChange() {
    renderNotice();
    drawBadge();
  }

  // ---- Preferences Modal ----

  var _modal = null;

  function openPreferencesModal() {
    if (_modal) {
      clearTimeout(_modalHideTimer);
      _modal.classList.remove('is-closing');
      _modal.style.display = '';
      _modalOpen = true;
      loadPreferences();
      var existingToggle = document.getElementById('pushToggle');
      if (existingToggle) {
        showPushMessage('');
        checkPushState(existingToggle);
      }
      return;
    }

    // Build overlay. ws-dialog / ws-dialog-box (theme.css): the box rises in
    // as every dialog's does, each time it is shown, on the frosted surface.
    _modal = createEl('div', 'ws-dialog fixed inset-0 z-[60] flex items-center justify-center ws-scrim');
    _modal.style.backdropFilter = 'blur(4px)';

    // Close on backdrop click
    _modal.addEventListener('click', function(e) {
      if (e.target === _modal) closePreferencesModal();
    });

    // Modal card
    var card = createEl('div', 'ws-dialog-box ws-frost border rounded-2xl w-full max-w-md mx-4');

    // Header
    var header = createEl('div', 'flex items-center justify-between px-6 py-4 border-b border-steel-blue/20');
    var headerTitle = createEl('h3', 'text-lg font-bold text-frosted-blue', 'Notification Preferences');
    var closeBtn = createEl('button', 'text-frosted-blue/80 hover:text-frosted-blue transition-colors cursor-pointer');
    closeBtn.setAttribute('aria-label', 'Close');
    var closeIcon = createIcon('material-symbols-outlined', 'close');
    closeBtn.appendChild(closeIcon);
    closeBtn.addEventListener('click', closePreferencesModal);
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // Body
    var body = createEl('div', 'px-6 py-4 space-y-4');
    body.id = 'notifPrefsBody';

    // Category toggles: every category the server sends (NOTIFICATION_CATEGORIES)
    var categories = ['request', 'issue', 'status', 'news', 'ticket', 'books'];
    // Books only on a site that has books (features.books_configured).
    var features = (((window.WS_DATA || {}).branding || {}).features) || {};
    categories.forEach(function(cat) {
      if (cat === 'books' && features.books_configured === false) return;
      var row = createEl('div', 'flex items-center justify-between py-2');

      var labelArea = createEl('div', 'flex items-center gap-3');
      var catIcon = createIcon('material-symbols-outlined text-steel-blue text-lg', CATEGORY_ICONS[cat] || 'notifications');
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
      toggle.style.cssText = 'width:36px; height:20px; appearance:none; -webkit-appearance:none; border-color:transparent; ' +
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
      var pushLabel = createEl('p', 'text-label text-frosted-blue/80 font-semibold mb-3', 'Push notifications');
      divider.appendChild(pushLabel);

      var pushRow = createEl('div', 'flex items-center justify-between py-2');
      var pushLabelArea = createEl('div', 'flex items-center gap-3');
      var pushIcon = createIcon('material-symbols-outlined text-steel-blue text-lg', 'devices');
      var pushText = createEl('span', 'text-sm text-frosted-blue', 'Browser push notifications');
      pushLabelArea.appendChild(pushIcon);
      pushLabelArea.appendChild(pushText);
      pushRow.appendChild(pushLabelArea);

      var pushToggle = document.createElement('input');
      pushToggle.type = 'checkbox';
      pushToggle.id = 'pushToggle';
      pushToggle.style.cssText = 'width:36px; height:20px; appearance:none; -webkit-appearance:none; border-color:transparent; ' +
        'background:rgb(var(--color-accent) / 0.3); border-radius:10px; position:relative; cursor:pointer; ' +
        'transition: background 0.2s;';
      applyToggleStyle(pushToggle, false);

      // Check current push state
      checkPushState(pushToggle);

      pushToggle.addEventListener('change', function() {
        var enabled = this.checked;
        applyToggleStyle(this, enabled);
        showPushMessage('');
        if (enabled) {
          enablePush(this);
        } else {
          disablePush(this);
        }
      });

      pushRow.appendChild(pushToggle);
      divider.appendChild(pushRow);

      // Plain-language reason when push could not be turned on or off.
      _pushMsg = createEl('p', 'text-sm text-frosted-blue/80 leading-relaxed mt-1');
      _pushMsg.setAttribute('role', 'status');
      _pushMsg.setAttribute('aria-live', 'polite');
      _pushMsg.style.display = 'none';
      divider.appendChild(_pushMsg);

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

  // It fades out as a dialog does (theme.css .ws-dialog.is-closing), then
  // hides; reduced motion hides it at once.
  var _modalHideTimer = 0;
  function closePreferencesModal() {
    _modalOpen = false;
    if (!_modal || _modal.style.display === 'none') return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { _modal.style.display = 'none'; return; }
    _modal.classList.add('is-closing');
    clearTimeout(_modalHideTimer);
    _modalHideTimer = setTimeout(function() {
      _modal.style.display = 'none';
      _modal.classList.remove('is-closing');
    }, 160);
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
  //
  // Pushes only arrive when the browser holds a subscription AND the server
  // has stored it, so the toggle shows "on" only when both are true. A browser
  // subscription the server never received (a failed save, a wiped database)
  // is re-sent once per browser session so existing users repair themselves.
  //
  // Push is on by default: a browser that already allowed notifications but
  // holds no subscription is subscribed quietly, unless the user turned push
  // off on this device (PUSH_OFF_KEY, kept in localStorage across sessions).

  var SW_READY_TIMEOUT_MS = 8000;
  var PUSH_SYNC_KEY = 'ws-push-synced';
  var PUSH_OFF_KEY = 'ws-push-off';
  var _pushMsg = null;

  var PUSH_MESSAGES = {
    unconfigured: "Push notifications aren't set up on this server yet.",
    blocked: "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
    dismissed: "Notifications weren't allowed. Turn this on again and choose Allow when your browser asks.",
    timeout: "Your browser didn't finish getting ready. Reload the page and try again.",
    noEmail: "This account doesn't have an email address, so notifications can't be sent to it.",
    failed: "We couldn't turn on notifications for this device. Please try again in a moment.",
    offFailed: "We couldn't turn off notifications for this device. Please try again in a moment."
  };

  /** Which PUSH_MESSAGES entry explains a failed subscribePush(). */
  function pushFailureKind(err) {
    if (err && err.permission) return err.permission === 'denied' ? 'blocked' : 'dismissed';
    if (err && err.message === 'sw-timeout') return 'timeout';
    if (err && err.reason) return err.reason;      // 'unconfigured' | 'noEmail'
    return 'failed';
  }

  function setPushOff(off) {
    try {
      if (off) localStorage.setItem(PUSH_OFF_KEY, '1');
      else localStorage.removeItem(PUSH_OFF_KEY);
    } catch (e) {}
  }

  /** True when the user turned push off here, or when we can't tell (no
   *  storage): never quietly turn it back on against their choice. */
  function pushTurnedOff() {
    try { return localStorage.getItem(PUSH_OFF_KEY) === '1'; } catch (e) { return true; }
  }

  function showPushMessage(text) {
    if (!_pushMsg) return;
    _pushMsg.textContent = text || '';
    _pushMsg.style.display = text ? '' : 'none';
  }

  function setPushToggle(toggleEl, on) {
    toggleEl.checked = on;
    applyToggleStyle(toggleEl, on);
  }

  /** A browser push-service subscribe and the save that follows it can hang
   *  as well as fail. The Home card has already gone by then (it leaves on
   *  the grant), so a hang must end in a rejection the failure path can show,
   *  or the card would never come back. */
  var SUBSCRIBE_TIMEOUT_MS = 15000;
  var SAVE_TIMEOUT_MS = 10000;
  // A save that timed out may still have landed (a slow write, not a lost
  // one), so the server is asked once before calling it a failure.
  var SAVE_RECHECK_TIMEOUT_MS = 5000;

  /** promise, or a rejection with `reason` after ms. A result that arrives
   *  after the deadline is dropped quietly: the next page's re-sync saves a
   *  late subscription, and a retry reuses it. onTimeout, if given, runs at
   *  the deadline (after the rejection), to cancel the work being waited on. */
  function withTimeout(promise, ms, reason, onTimeout) {
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        reject(new Error(reason));
        if (onTimeout) onTimeout();
      }, ms);
      Promise.resolve(promise).then(function(value) {
        clearTimeout(timer);
        resolve(value);
      }, function(err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** serviceWorker.ready never rejects; if the worker never activates it just
   *  never resolves, so give up after a while with a reason the UI can show. */
  function swReady() {
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() { reject(new Error('sw-timeout')); }, SW_READY_TIMEOUT_MS);
      navigator.serviceWorker.ready.then(function(reg) {
        clearTimeout(timer);
        resolve(reg);
      }, function(err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // The page-load re-sync and a click on the toggle can both save the same
  // subscription at once; they share one request instead of racing.
  var _postInFlight = null;   // { endpoint, promise }

  function postSubscription(subscription) {
    var subJSON = subscription.toJSON();
    if (_postInFlight && _postInFlight.endpoint === subJSON.endpoint) {
      return _postInFlight.promise;
    }
    var entry = { endpoint: subJSON.endpoint, promise: null };
    entry.promise = sendSubscription(subJSON).then(function(v) {
      if (_postInFlight === entry) _postInFlight = null;
      return v;
    }, function(err) {
      if (_postInFlight === entry) _postInFlight = null;
      throw err;
    });
    _postInFlight = entry;
    return entry.promise;
  }

  function sendSubscription(subJSON) {
    // Aborted at the deadline, so a save given up on is cancelled wherever
    // the browser still can, rather than landing later for a subscription
    // the failure path may have just thrown away.
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    return withTimeout(fetch('/api/notifications/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subJSON.endpoint,
        keys: {
          p256dh: subJSON.keys.p256dh,
          auth: subJSON.keys.auth
        }
      }),
      signal: controller ? controller.signal : undefined
    }), SAVE_TIMEOUT_MS, 'save-timeout', function() {
      if (controller) controller.abort();
    }).then(function(resp) {
      if (resp.ok) return;
      return resp.json().catch(function() { return {}; }).then(function(body) {
        var err = new Error('subscribe-failed');
        // The server refuses accounts it has no email for ("Push
        // notifications need an account email.").
        if (resp.status === 400 && /email/i.test((body && body.detail) || '')) err.reason = 'noEmail';
        throw err;
      });
    });
  }

  function serverHasSubscription(subscription) {
    return fetch('/api/notifications/push-subscribe/status?endpoint=' +
                 encodeURIComponent(subscription.endpoint))
      .then(function(r) { return r.ok ? r.json() : { subscribed: false }; })
      .then(function(data) { return !!data.subscribed; });
  }

  /** False when the subscription was made with a different server key (the
   *  keys were regenerated): pushes to it can never be delivered. */
  function subscriptionKeyMatches(subscription, vapidKey) {
    var key = subscription.options && subscription.options.applicationServerKey;
    if (!key || !vapidKey) return true;   // can't tell; keep it
    var have = new Uint8Array(key);
    var want = urlBase64ToUint8Array(vapidKey);
    if (have.length !== want.length) return false;
    for (var i = 0; i < have.length; i++) {
      if (have[i] !== want[i]) return false;
    }
    return true;
  }

  /** The browser's subscription for this server key, creating one if needed.
   *  Resolves to { subscription, created }: created is true only when this
   *  call made it, so a failure path never throws away one that was working. */
  function currentSubscription(reg, vapidKey) {
    return reg.pushManager.getSubscription().then(function(existing) {
      if (existing && subscriptionKeyMatches(existing, vapidKey)) {
        return { subscription: existing, created: false };
      }
      var stale = existing ? existing.unsubscribe() : Promise.resolve();
      return stale.then(function() {
        return withTimeout(reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey)
        }), SUBSCRIBE_TIMEOUT_MS, 'subscribe-timeout');
      }).then(function(subscription) {
        return { subscription: subscription, created: true };
      });
    });
  }

  function markPushSynced() {
    try { sessionStorage.setItem(PUSH_SYNC_KEY, '1'); } catch (e) {}
  }

  function pushSyncedThisSession() {
    try { return !!sessionStorage.getItem(PUSH_SYNC_KEY); } catch (e) { return false; }
  }

  /** Re-send an existing browser subscription the server may have lost, or,
   *  where notifications are already allowed but nothing is subscribed,
   *  subscribe quietly (push is on by default). */
  function syncPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission !== 'granted' || pushSyncedThisSession()) return;
    var vapidKey = (window.WEBSERVARR_THEME || {}).vapid_public_key;
    if (!vapidKey) return;
    var user = (window.WS_DATA || {}).user || {};

    swReady().then(function(reg) {
      return reg.pushManager.getSubscription().then(function(sub) {
        // Decided here, after the wait (swReady can take seconds), from fresh
        // state: the user may have turned push off in the meantime.
        if (_pushDisabling) return;
        if (!sub && (!user.has_email || pushTurnedOff())) return;   // off here, and staying off
        return currentSubscription(reg, vapidKey).then(function(result) {
          return postSubscription(result.subscription);
        });
      });
    }).then(markPushSynced, function(err) {
      markPushSynced();     // once per session, even when it failed
      console.warn('Push subscription re-sync failed:', err);
    });
  }

  function checkPushState(toggleEl) {
    if (!('serviceWorker' in navigator)) return Promise.resolve();
    return swReady().then(function(reg) {
      return reg.pushManager.getSubscription();
    }).then(function(sub) {
      return sub ? serverHasSubscription(sub) : false;
    }).then(function(on) {
      setPushToggle(toggleEl, on);
    }).catch(function() {
      setPushToggle(toggleEl, false);
    });
  }

  /**
   * Ask for permission and subscribe this browser. Shared by the settings
   * toggle and the Home prompt. Call it straight from a click: the browser
   * only shows its permission prompt in response to a user gesture.
   * Rejects with an error pushFailureKind() can explain.
   *
   * onGranted, if given, runs the moment permission is granted, before the
   * subscribe and the save: those are a push-service round trip and a POST,
   * which can take seconds, and the Home prompt should not wait on them.
   */
  function subscribePush(onGranted) {
    var vapidKey = (window.WEBSERVARR_THEME || {}).vapid_public_key;
    if (!vapidKey) {
      var unconfigured = new Error('unconfigured');
      unconfigured.reason = 'unconfigured';
      return Promise.reject(unconfigured);
    }
    var created = null;   // a browser subscription THIS attempt made, if any

    return Promise.resolve(Notification.requestPermission()).then(function(permission) {
      if (permission !== 'granted') {
        var err = new Error('permission');
        err.permission = permission;
        throw err;
      }
      if (onGranted) {
        try { onGranted(); } catch (e) { console.error(e); }
      }
      return swReady();
    }).then(function(reg) {
      return currentSubscription(reg, vapidKey);
    }).then(function(result) {
      if (result.created) created = result.subscription;
      return postSubscription(result.subscription).catch(function(err) {
        return savedAfterAll(result.subscription, err);
      });
    }).then(function() {
      markPushSynced();
      setPushOff(false);
    }, function(err) {
      // Undo a subscription this attempt made, so the toggle can't read "on"
      // next time while nothing can arrive. One that already existed is kept:
      // a transient save failure must not destroy it, and the next page's
      // re-sync can only repair a subscription the browser still holds.
      if (created) created.unsubscribe().catch(function() {});
      throw err;
    });
  }

  /** After a save timed out: did it land anyway? One status check, itself
   *  bounded. Resolves when the server has this endpoint (so the attempt is a
   *  success and nothing is undone); otherwise rethrows the original error,
   *  including when the check fails or times out. Any other error is
   *  rethrown untouched. */
  function savedAfterAll(subscription, err) {
    if (!err || err.message !== 'save-timeout') return Promise.reject(err);
    return withTimeout(serverHasSubscription(subscription), SAVE_RECHECK_TIMEOUT_MS, 'recheck-timeout')
      .then(function(saved) {
        if (!saved) throw err;
      }, function() {
        throw err;
      });
  }

  function enablePush(toggleEl) {
    toggleEl.disabled = true;
    subscribePush().then(function() {
      setPushToggle(toggleEl, true);
    }, function(err) {
      console.error('Push subscription error:', err);
      setPushToggle(toggleEl, false);
      showPushMessage(PUSH_MESSAGES[pushFailureKind(err)]);
    }).then(function() {
      toggleEl.disabled = false;
    });
  }

  // True while disablePush runs, so the page-load re-sync can't subscribe
  // again in the gap between the browser unsubscribing and PUSH_OFF_KEY.
  var _pushDisabling = false;

  function disablePush(toggleEl) {
    toggleEl.disabled = true;
    _pushDisabling = true;
    swReady().then(function(reg) {
      return reg.pushManager.getSubscription();
    }).then(function(subscription) {
      if (!subscription) return;
      var endpoint = subscription.endpoint;
      // Browser first: once it has unsubscribed nothing can arrive here, and
      // a server row left behind is removed on the next send (HTTP 410). The
      // other order could leave a browser subscription the next page's
      // re-sync would quietly turn back on.
      return subscription.unsubscribe().then(function(ok) {
        if (ok === false) throw new Error('unsubscribe-failed');
        return fetch('/api/notifications/push-subscribe?endpoint=' + encodeURIComponent(endpoint),
                     { method: 'DELETE' }).catch(function() {});
      });
    }).then(function() {
      setPushOff(true);   // stay off: no quiet re-subscribe on later visits
      setPushToggle(toggleEl, false);
    }).catch(function(err) {
      console.error('Push unsubscribe error:', err);
      showPushMessage(PUSH_MESSAGES.offFailed);
      return checkPushState(toggleEl);   // re-enable only once it is corrected
    }).then(function() {
      _pushDisabling = false;
      toggleEl.disabled = false;
    });
  }

  // ---- Home push prompt ----
  //
  // Whether Home shows #pushPrompt is decided before the page is drawn (so it
  // never moves content after load): theme-loader.js WSPushOffer, called from
  // <head> on a full load and by pages/home.js on every visit, which then
  // calls initPushPrompt to wire the card's buttons. "Not now" and a
  // closed browser prompt are remembered for data-dismiss-days under
  // data-dismiss-key. A denied prompt needs nothing stored: the page only
  // offers push while the permission is still "default".

  function rememberPromptDismissed(card) {
    try { localStorage.setItem(card.dataset.dismissKey, String(Date.now())); } catch (e) {}
  }

  /** Collapse the card. It follows the user's own tap, so the content moving
   *  up is expected; it still eases rather than snaps. */
  function hidePushPrompt(card) {
    if (card.hidden || card._pushPromptState === 'hiding') return;
    clearTimeout(card._pushPromptTimer);
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { card.removeAttribute('style'); card._pushPromptState = null; card.hidden = true; return; }
    card._pushPromptState = 'hiding';
    card.style.overflow = 'hidden';
    card.style.height = card.offsetHeight + 'px';
    void card.offsetHeight;
    card.style.transition = 'height 200ms ease-out, opacity 200ms ease-out, margin-bottom 200ms ease-out';
    card.style.height = '0px';
    card.style.opacity = '0';
    // Cancels the next section's space-y gap, which goes with the card.
    card.style.marginBottom = '-' + getComputedStyle(card.nextElementSibling || card).marginTop;
    card._pushPromptTimer = setTimeout(function() {
      card._pushPromptState = null;
      card.hidden = true;
      card.removeAttribute('style');
    }, 200);
  }

  /** Bring a collapsed card back: hidePushPrompt run backwards, from wherever
   *  the collapse had got to. Only after a failure the user needs to see. */
  function showPushPrompt(card) {
    var from = card.hidden ? 0 : card.getBoundingClientRect().height;
    var fromOpacity = card.hidden ? '0' : getComputedStyle(card).opacity;
    clearTimeout(card._pushPromptTimer);
    card._pushPromptState = null;
    card.removeAttribute('style');
    card.hidden = false;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    var to = card.offsetHeight;
    // The next section's space-y gap returns with the card, so it is held off
    // at the start and eased in alongside the height.
    var gap = getComputedStyle(card.nextElementSibling || card).marginTop;
    var gapPx = parseFloat(gap) || 0;
    card._pushPromptState = 'showing';
    card.style.overflow = 'hidden';
    card.style.height = from + 'px';
    card.style.opacity = fromOpacity;
    card.style.marginBottom = '-' + (to ? gapPx * (1 - from / to) : gapPx) + 'px';
    void card.offsetHeight;
    card.style.transition = 'height 200ms ease-out, opacity 200ms ease-out, margin-bottom 200ms ease-out';
    card.style.height = to + 'px';
    card.style.opacity = '1';
    card.style.marginBottom = '0px';
    card._pushPromptTimer = setTimeout(function() {
      card._pushPromptState = null;
      card.removeAttribute('style');
    }, 200);
  }

  /** "Turning on..." while the browser asks. Both labels are always laid out
   *  (one invisible) so the button keeps the wider one's width and nothing
   *  in the card moves when the words change. */
  function setPromptBusy(btn, busy) {
    btn.disabled = busy;
    var idle = btn.querySelector('[data-push-label-idle]');
    var working = btn.querySelector('[data-push-label-busy]');
    if (idle) idle.classList.toggle('invisible', busy);
    if (working) working.classList.toggle('invisible', !busy);
  }

  /** A failure reported after the card has gone: the site's toast, or, on a
   *  page without ui.js, the card's own message line. Returns false in that
   *  second case, when the caller must bring the card back for it to be seen. */
  function promptFailure(msg, text) {
    if (window.WSUI && typeof window.WSUI.toast === 'function') {
      WSUI.toast(text, 'err');
      return true;
    }
    msg.textContent = text;
    return false;
  }

  /** Wire the card on this visit of Home. Called by the page module
   *  (pages/home.js) once it has shown the card, with the visit's signal: a
   *  soft navigation brings a new card each time, and the old one's listeners
   *  end with the page. */
  function initPushPrompt(card, signal) {
    if (!card || card.hidden) return;
    var msg = card.querySelector('[data-push-prompt-msg]');
    var actions = card.querySelector('[data-push-prompt-actions]');
    var enableBtn = card.querySelector('[data-push-prompt-enable]');
    var laterBtn = card.querySelector('[data-push-prompt-later]');
    if (!msg || !actions || !enableBtn || !laterBtn) return;

    laterBtn.addEventListener('click', function() {
      rememberPromptDismissed(card);
      hidePushPrompt(card);
    }, { signal: signal });

    enableBtn.addEventListener('click', function() {
      setPromptBusy(enableBtn, true);
      laterBtn.disabled = true;
      msg.textContent = '';
      var gone = false;   // hidden on the grant, before the subscribe settled
      subscribePush(function() {
        // "Allow" is the answer this card asked for, so it goes now. The
        // subscribe and the save finish behind it; with permission granted
        // the card is not offered again on a later visit.
        gone = true;
        hidePushPrompt(card);
      }).then(null, function(err) {
        var kind = pushFailureKind(err);
        if (kind === 'blocked') { hidePushPrompt(card); return; }
        if (kind === 'dismissed' || kind === 'noEmail' || kind === 'unconfigured') {
          rememberPromptDismissed(card);
          hidePushPrompt(card);
          // It left looking like a yes, so say why. With no toast to say it
          // in, the card comes back to carry the message, buttons usable.
          if (gone && !promptFailure(msg, PUSH_MESSAGES[kind])) {
            setPromptBusy(enableBtn, false);
            laterBtn.disabled = false;
            showPushPrompt(card);
          }
          return;
        }
        console.error('Push subscription error:', err);
        setPromptBusy(enableBtn, false);
        laterBtn.disabled = false;
        if (gone) {
          // The card left on the grant, so the failure is said where it can
          // be seen and the card returns with its button, ready to retry.
          promptFailure(msg, PUSH_MESSAGES[kind]);
          showPushPrompt(card);
        } else {
          msg.textContent = PUSH_MESSAGES[kind];
        }
      });
    }, { signal: signal });
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
    // Once per document: a second call (the shell is not run again on a soft
    // navigation, but nothing else stops a caller) would wire the bells and
    // start the poll twice.
    if (_pollStop) return;
    // Find/create bell + badge
    findOrCreateBell();
    if (_bellButtons.length === 0) {
      // No bell button found and couldn't create one — skip init
      return;
    }

    // Register service worker, then repair a push subscription the server lost
    registerServiceWorker();
    syncPushSubscription();

    // Fetch initial count, then the list itself, so the first open of the
    // panel is already full (see _items).
    fetchUnreadCount().then(function(count) {
      _lastCount = -1; // Ensure first update doesn't pulse
      updateBadge(count);
      buildDropdown();
      loadDropdownItems();
    });

    // Every 30 seconds while the tab is on screen (WS.poll skips a hidden
    // tab's ticks and asks again when it comes back), for the document's life.
    _pollStop = WS.poll(function() {
      fetchUnreadCount().then(updateBadge);
    }, 30000);

    // Close dropdown on outside click
    document.addEventListener('click', handleOutsideClick);
    // ...and when the account menu opens
    document.addEventListener('ws:menu-open', handleOtherMenuOpen);
    // The ask notice follows WSAsk (theme-loader.js) for the document's life.
    document.addEventListener('ws:ask', handleAskChange);
  }

  // Expose
  window.initNotifications = init;
  window.initPushPrompt = initPushPrompt;
  // The same subscribe path for Home's welcome tour (js/welcome.js), which
  // asks from its own bubble: subscribe(onGranted) straight from the tap,
  // failureKind(err) and messages[kind] to explain a failure.
  window.WSPush = { subscribe: subscribePush, failureKind: pushFailureKind, messages: PUSH_MESSAGES };

})();
