/**
 * Settings > Pages: one row per page, in sidebar order. Icon, label,
 * sublabel, New! flag and a single on/off switch per page. Home and Requests
 * expand for their own settings; the login page sits below the divider.
 *
 * The order and the page addresses come from the server (the Settings view's
 * page_order, already normalised, and page_addresses); this file keeps no copy
 * of either. Desktop reorders by dragging a row's handle or with the arrow
 * keys on it; phones get up/down buttons. All three go through commit(),
 * which keeps the first page first and the last page last, as the server's
 * normalize_page_order does. The order is one setting, pages.order, saved
 * with the bar like everything else.
 */
(function () {
  'use strict';

  var el = WSSettings.el, icon = WSSettings.icon, cls = WSSettings.cls;
  var ORDER_KEY = 'pages.order';
  var LOCKED = { home: 'Home is where everyone lands, so it is always on.',
                 settings: 'Settings is always on so you can always get back here.' };
  var SECTIONS = [['services', 'Service Health'], ['news', 'News & Updates'], ['streams', 'Active Streams'],
                  ['releases', 'Upcoming Releases'], ['requests', 'Recent Requests']];
  // Plain words for the Requests page's sources. The sources themselves are
  // the setting's choices, from meta.
  var SOURCE_LABELS = { native: 'Built-in requests', seerr_embed: 'Your Seerr site, inside this one' };
  var MONITORS_URL = '/api/integrations/monitors';

  var MSG = {
    monitorsFailed: 'The service list couldn’t load. Try again in a moment.',
    monitorsEmpty: 'No services came back from the status page. Check its settings in Integrations.',
    monitorsNone: 'Connect Uptime Kuma to choose which services appear here.'
  };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // A key's saved value (the baseline), never a staged one.
  function saved(key) {
    var values = WSSettings.values;
    if (hasOwn(values, key)) return String(values[key]);
    var m = WSSettings.metaFor(key);
    return m ? String(m.default) : '';
  }

  // A page's name as it stands now, else the shipped one from meta.
  function labelOf(api, id) {
    var v = api.get('sidebar.label_' + id);
    if (v) return v;
    var m = WSSettings.metaFor('sidebar.label_' + id);
    return m && m.default ? String(m.default) : id;
  }

  function actionNote(text, actionLabel, onAction) {
    var p = el('div', 'flex flex-wrap items-center gap-2 text-[13px] text-frosted-blue/70');
    p.appendChild(el('span', 'ws-light ws-light-warn'));
    p.appendChild(el('span', '', text));
    if (actionLabel) {
      var b = el('button', cls.btnQuiet + ' px-2 py-1', actionLabel);
      b.type = 'button';
      b.addEventListener('click', onAction);
      p.appendChild(b);
    }
    return p;
  }

  // Task 6.3's cards on Integrations carry these ids. Until one exists, go()
  // just opens the tab.
  function openSetup(service) {
    WSSettings.go('integrations', 'integration-card-' + service);
  }

  // [message, service] when a page can't work yet, else null.
  function needsSetup(id, api) {
    if (id === 'library' && !saved('integration.kavita.url')) {
      return ['eBooks needs Kavita. It stays out of the sidebar until Kavita is set up.', 'kavita'];
    }
    if (id === 'requests') {
      var seerr = !!saved('integration.seerr.url'), chaptarr = !!saved('integration.chaptarr.url');
      if (api.get('requests.source') === 'seerr_embed' && !seerr) return ['The Seerr page needs the Seerr connection.', 'seerr'];
      if (!seerr && !chaptarr) return ['Requests needs Seerr for movies and TV, or Chaptarr for books.', 'seerr'];
    }
    if (id === 'calendar' && !saved('integration.sonarr.url') && !saved('integration.radarr.url')) {
      return ['Calendar needs Sonarr or Radarr.', 'sonarr'];
    }
    return null;
  }

  // ---- Service Health tiles (Uptime Kuma monitors) ----

  // {status, data}: data is the parsed JSON, or undefined when the body is
  // empty or isn't JSON (a proxy's error page, say). Status 0: no answer.
  function readJson(r) {
    return r.text().then(function (text) {
      var data;
      try { data = text ? JSON.parse(text) : undefined; } catch (e) { data = undefined; }
      return { status: r.status, data: data };
    }, function () { return { status: r.status, data: undefined }; });
  }

  // Fills `list` with one switch per monitor. Resolves true once the list
  // (or the "set it up" note) is shown, false when it couldn't load.
  function loadMonitors(api, list) {
    list.replaceChildren(el('div', 'skel skel-row'));
    list.setAttribute('aria-busy', 'true');
    return fetch(MONITORS_URL, { credentials: 'same-origin' })
      .then(readJson, function () { return { status: 0, data: undefined }; })
      .then(function (res) {
        list.removeAttribute('aria-busy');
        if (res.status === 401) { WSSettings.leave('/login'); return false; }
        if (res.status !== 200 || !Array.isArray(res.data)) {
          list.replaceChildren(actionNote(MSG.monitorsFailed, 'Try again', function () { loadMonitors(api, list); }));
          return false;
        }
        var seen = {}, monitors = res.data.filter(function (m) {
          var ok = m && typeof m === 'object' && /^\d{1,9}$/.test(String(m.id)) && !hasOwn(seen, String(m.id));
          if (ok) seen[String(m.id)] = true;
          return ok;
        });
        if (!monitors.length) {
          var configured = !!saved('integration.uptime_kuma.url');
          list.replaceChildren(actionNote(configured ? MSG.monitorsEmpty : MSG.monitorsNone,
            configured ? 'Open Integrations' : 'Set it up', function () { openSetup('uptime_kuma'); }));
          return true;
        }
        list.replaceChildren();
        monitors.forEach(function (m) {
          list.appendChild(api.toggle({ key: 'monitor.' + m.id + '.enabled',
                                        label: m.name ? String(m.name) : 'Monitor ' + m.id }));
        });
        return true;
      });
  }

  // ---- Expanders ----

  function homeExpander(api) {
    var body = el('div', 'space-y-8');

    var sec = el('div', 'space-y-4');
    sec.appendChild(el('p', 'text-[15px] font-semibold text-frosted-blue', 'Sections'));
    sec.appendChild(el('p', 'text-[13px] text-frosted-blue/45 -mt-3',
      'A section that is off is left out of the home page entirely.'));
    SECTIONS.forEach(function (s) {
      var row = el('div', 'flex items-center gap-3');
      row.appendChild(api.iconPicker({ key: 'icon.section_' + s[0], label: s[1] + ' icon', compact: true }));
      var t = el('div', 'flex-1 min-w-0');
      t.appendChild(api.toggle({ key: 'home.section_' + s[0], label: s[1] }));
      row.appendChild(t);
      sec.appendChild(row);
    });
    body.appendChild(sec);

    var news = el('div', 'space-y-4');
    news.appendChild(el('p', 'text-[15px] font-semibold text-frosted-blue', 'News on the home page'));
    var grid = el('div', 'grid sm:grid-cols-2 gap-5');
    grid.appendChild(api.text({ key: 'news.homepage_count', label: 'Posts to show', inputType: 'number' }));
    grid.appendChild(api.text({ key: 'news.homepage_max_age_days', label: 'Hide posts older than', inputType: 'number',
      suffix: 'days', help: '0 keeps posts on the home page until newer ones replace them. Pinned posts always show.' }));
    news.appendChild(grid);
    body.appendChild(news);

    var tiles = el('div', 'space-y-4');
    tiles.appendChild(el('p', 'text-[15px] font-semibold text-frosted-blue', 'Service Health tiles'));
    var list = el('div', 'space-y-3');
    tiles.appendChild(list);
    body.appendChild(tiles);

    // Fetched as the tab mounts, while the expander is still closed, so the
    // list is usually there before anyone opens it (nothing below it moves).
    // Opening it again after a failure tries again.
    var loaded = false;
    function load() {
      if (loaded) return;
      loaded = true;
      loadMonitors(api, list).then(function (ok) { if (!ok) loaded = false; });
    }
    load();
    return { body: body, onOpen: load };
  }

  function requestsExpander(api) {
    var body = el('div', 'space-y-5');
    var m = WSSettings.metaFor('requests.source');
    var choices = m && Array.isArray(m.choices) ? m.choices : [];
    body.appendChild(api.select({
      key: 'requests.source', label: 'What the Requests page shows',
      options: choices.map(function (c) {
        return { value: c, label: hasOwn(SOURCE_LABELS, c) ? SOURCE_LABELS[c] : c };
      }),
      help: 'Built-in covers movies, TV and books. The Seerr option shows your Seerr site in a frame instead.'
    }));
    return { body: body };
  }

  function loginExpander(api) {
    var body = el('div', 'space-y-5');
    body.appendChild(api.toggle({ key: 'features.login_backgrounds', label: 'Rotating artwork behind the sign-in form',
      help: 'Uses trending titles from Seerr.' }));
    return { body: body };
  }

  // The chevron button that opens a row's settings. Returns the button;
  // wire() connects it to the body it opens.
  function expandButton(label) {
    var b = el('button', cls.btnQuiet + ' px-2');
    b.type = 'button';
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', label);
    b.appendChild(icon('expand_more', 'text-[22px] transition-transform motion-reduce:transition-none'));
    return b;
  }

  function wireExpander(btn, bodyWrap, onOpen) {
    btn.setAttribute('aria-controls', bodyWrap.id);
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      bodyWrap.classList.toggle('hidden', !open);
      btn.firstChild.classList.toggle('rotate-180', open);
      if (open && onOpen) onOpen();
    });
  }

  // A kit text field whose label only screen readers hear: the column heads
  // name it on a wide screen, and the error line under it still shows.
  function nameField(api, key, label, placeholder) {
    var f = api.text({ key: key, label: label, placeholder: placeholder });
    var l = f.querySelector('label');
    if (l) l.classList.add('sr-only');
    return f;
  }

  // ---- The tab ----

  WSSettings.registerTab('pages', {
    mount: function (panel, api) {
      // Normalised by the server (Home first, Settings last, every page once).
      var start = WSSettings.view('page_order');
      var addresses = WSSettings.view('page_addresses');
      if (!Array.isArray(start) || start.length < 3 || !addresses || typeof addresses !== 'object') {
        throw new Error('The settings view has no page order');
      }
      // The server keeps these two where they are; so does commit().
      var FIRST = start[0], LAST = start[start.length - 1];
      var rows = {};

      var live = el('p', 'sr-only');
      live.setAttribute('aria-live', 'polite');
      var liveTimer = null;
      function say(text) {
        // Emptied first, so the same words twice are still read out.
        live.textContent = '';
        clearTimeout(liveTimer);
        liveTimer = setTimeout(function () { live.textContent = text; }, 60);
      }

      var card = WSSettings.card('Pages',
        'Rename pages and the line under each name, pick their icons, choose the order, and turn pages off. ' +
        'A page that is off disappears from the sidebar and only admins can open it.');
      var head = el('div', 'hidden lg:grid grid-cols-[88px_40px_minmax(0,1fr)_minmax(0,1fr)_96px_56px_56px] gap-3 ' +
        'px-[13px] pb-2 text-[13px] font-semibold text-frosted-blue/45');
      ['', 'Icon', 'Label', 'Sublabel', 'Address', 'New!', 'On'].forEach(function (h) { head.appendChild(el('span', '', h)); });
      card.body.appendChild(head);

      var list = el('ul', 'space-y-2');
      list.setAttribute('aria-label', 'Pages in sidebar order');
      var orderError = el('p', cls.error + ' hidden');
      orderError.setAttribute('role', 'alert');

      // pages.order text -> the order it stands for. The saved text may be
      // an old, un-normalised value; the server's normalised order is what it
      // shows. Every order staged here is added when it is made.
      var known = {};
      var savedOrder = start.slice();
      known[saved(ORDER_KEY)] = savedOrder;
      var shown = savedOrder.slice();

      function same(a, b) {
        return a.length === b.length && a.every(function (x, i) { return x === b[i]; });
      }

      // The one way the order changes: dragging, the arrow keys and the phone
      // buttons all end here. The first and last pages stay where they are,
      // as the server's normalize_page_order keeps them; every page stays once.
      function commit(next, moved) {
        var middle = [];
        next.forEach(function (id) {
          if (id !== FIRST && id !== LAST && hasOwn(rows, id) && middle.indexOf(id) < 0) middle.push(id);
        });
        var order = [FIRST].concat(middle, [LAST]);
        if (order.length !== shown.length) return;
        // Back to the saved order is the saved text itself: nothing to save.
        var raw = same(order, savedOrder) ? saved(ORDER_KEY) : JSON.stringify(order);
        known[raw] = order;
        api.set(ORDER_KEY, raw);
        if (moved) say(labelOf(api, moved) + ' moved to position ' + (order.indexOf(moved) + 1) +
                       ' of ' + order.length + '.');
      }

      function move(id, delta) {
        var order = shown.slice(), i = order.indexOf(id), j = i + delta;
        if (i < 1 || j < 1 || j > order.length - 2) {
          say(delta < 0 ? labelOf(api, id) + ' can’t go higher. ' + labelOf(api, FIRST) + ' stays first.'
                        : labelOf(api, id) + ' can’t go lower. ' + labelOf(api, LAST) + ' stays last.');
          return;
        }
        order.splice(i, 1);
        order.splice(j, 0, id);
        commit(order, id);
      }

      // Puts the rows in order. The row holding focus stays where it is in
      // the DOM and the others move around it: a moved node loses focus, and
      // the handle of a row moved by keyboard must keep it.
      function paint(v) {
        var order = hasOwn(known, v) ? known[v] : savedOrder;
        shown = order.slice();
        var anchor = order.filter(function (id) { return rows[id].contains(document.activeElement); })[0] || order[0];
        var at = order.indexOf(anchor);
        order.forEach(function (id, k) {
          if (k < at) list.insertBefore(rows[id], rows[anchor]);
          else if (k > at) list.appendChild(rows[id]);
        });
        var active = document.activeElement;
        order.forEach(function (id, k) {
          var li = rows[id];
          if (!li._up) return;
          li._up.disabled = k <= 1;
          li._down.disabled = k >= order.length - 2;
          if (active === li._up && li._up.disabled) li._down.focus();
          if (active === li._down && li._down.disabled) li._up.focus();
        });
      }

      function buildRow(id) {
        var pinned = id === FIRST || id === LAST;
        var name = labelOf(api, id);
        var li = el('li', 'relative rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] ' +
          'transition-opacity motion-reduce:transition-none');
        li.setAttribute('data-page', id);
        // The row is draggable only while the pointer is on its handle: the
        // browser picks the drag source as the button goes down, so it has
        // to be set by then (on hover), and off again elsewhere so text in
        // the row's fields can still be selected with the mouse.
        var pressed = false, handle = null;
        function release() {
          window.removeEventListener('pointerup', release);
          window.removeEventListener('pointercancel', release);
          pressed = false;
          li.draggable = !!handle && handle.matches(':hover');
        }
        var line = el('div', 'grid grid-cols-[40px_minmax(0,1fr)_auto] ' +
          'lg:grid-cols-[88px_40px_minmax(0,1fr)_minmax(0,1fr)_96px_56px_56px] items-center gap-3 p-3');
        line.setAttribute('role', 'group');
        line.setAttribute('aria-label', name);

        // Cells in reading order, placed by the grid: on a wide screen one
        // line of columns; on a phone the icon and names first, then the move
        // buttons and the switches on a second line.
        var moveBox = el('div', 'flex items-center gap-1 h-10 row-start-2 col-start-1 col-span-2 ' +
          'lg:col-start-1 lg:col-span-1 lg:row-start-1');
        if (!pinned) {
          // Not a <button>: some browsers won't start a drag from inside one.
          handle = el('span', 'hidden lg:inline-flex items-center justify-center size-10 rounded-[10px] ' +
            'text-frosted-blue/45 hover:text-frosted-blue hover:bg-frosted-blue/[0.06] cursor-grab ' +
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary');
          handle.tabIndex = 0;
          handle.setAttribute('role', 'button');
          handle.setAttribute('aria-roledescription', 'drag handle');
          handle.appendChild(icon('drag_indicator', 'text-[22px]'));
          handle.setAttribute('aria-label', 'Move ' + name + '. Drag, or use the up and down arrow keys.');
          handle.addEventListener('pointerenter', function () { li.draggable = true; });
          handle.addEventListener('pointerleave', function () { if (!pressed) li.draggable = false; });
          // A press that never becomes a drag lets go wherever it ends.
          handle.addEventListener('pointerdown', function () {
            pressed = true;
            li.draggable = true;
            window.addEventListener('pointerup', release);
            window.addEventListener('pointercancel', release);
          });
          handle.addEventListener('keydown', function (e) {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            move(id, e.key === 'ArrowUp' ? -1 : 1);
            if (document.activeElement !== handle) handle.focus({ preventScroll: true });
            handle.scrollIntoView({ block: 'nearest' });
          });
          var up = el('button', cls.btnQuiet + ' lg:hidden px-2 disabled:opacity-40 disabled:pointer-events-none');
          up.type = 'button';
          up.appendChild(icon('arrow_upward', 'text-[20px]'));
          up.setAttribute('aria-label', 'Move ' + name + ' up');
          up.addEventListener('click', function () { move(id, -1); up.scrollIntoView({ block: 'nearest' }); });
          var down = el('button', cls.btnQuiet + ' lg:hidden px-2 disabled:opacity-40 disabled:pointer-events-none');
          down.type = 'button';
          down.appendChild(icon('arrow_downward', 'text-[20px]'));
          down.setAttribute('aria-label', 'Move ' + name + ' down');
          down.addEventListener('click', function () { move(id, 1); down.scrollIntoView({ block: 'nearest' }); });
          moveBox.appendChild(handle);
          moveBox.appendChild(up);
          moveBox.appendChild(down);
          li._up = up;
          li._down = down;
        } else {
          var pin = el('span', 'inline-flex items-center justify-center size-10 text-frosted-blue/45');
          pin.title = id === FIRST ? name + ' is always first' : name + ' is always last';
          pin.appendChild(icon('push_pin', 'text-[18px]'));
          moveBox.appendChild(pin);
        }

        var exp = id === 'home' ? homeExpander(api) : id === 'requests' ? requestsExpander(api) : null;
        var toggleBtn = exp ? expandButton('More settings for ' + name) : null;
        if (toggleBtn) moveBox.appendChild(toggleBtn);
        line.appendChild(moveBox);

        var iconCell = el('div', 'self-start row-start-1 col-start-1 lg:self-center lg:col-start-2 lg:row-start-1');
        iconCell.appendChild(api.iconPicker({ key: 'icon.nav_' + id, label: 'Icon for ' + name, compact: true }));
        line.appendChild(iconCell);

        var names = el('div', 'grid gap-2 lg:gap-3 lg:grid-cols-2 min-w-0 row-start-1 col-start-2 col-span-2 ' +
          'lg:col-start-3 lg:col-span-2 lg:row-start-1');
        names.appendChild(nameField(api, 'sidebar.label_' + id, 'Label'));
        names.appendChild(nameField(api, 'sidebar.sublabel_' + id, 'Sublabel', 'No sublabel'));
        line.appendChild(names);

        line.appendChild(el('span', 'hidden lg:block lg:col-start-5 lg:row-start-1 font-mono text-[13px] ' +
          'text-frosted-blue/45 truncate', hasOwn(addresses, id) ? String(addresses[id]) : ''));


        var switches = el('div', 'flex items-center gap-4 row-start-2 col-start-3 lg:contents');
        var newBox = el('label', 'flex items-center gap-2 lg:col-start-6 lg:row-start-1');
        newBox.appendChild(el('span', 'lg:hidden text-[13px] text-frosted-blue/70', 'New!'));
        newBox.appendChild(api.toggle({ key: 'sidebar.new_' + id, label: 'Show New! on ' + name, compact: true }));
        var onBox = el('label', 'flex items-center gap-2 lg:col-start-7 lg:row-start-1');
        onBox.appendChild(el('span', 'lg:hidden text-[13px] text-frosted-blue/70', 'On'));
        if (pinned) {
          var lockedSwitch = el('button', 'ws-switch');
          lockedSwitch.type = 'button';
          lockedSwitch.disabled = true;
          lockedSwitch.setAttribute('role', 'switch');
          lockedSwitch.setAttribute('aria-checked', 'true');
          var why = hasOwn(LOCKED, id) ? LOCKED[id] : name + ' is always on.';
          lockedSwitch.setAttribute('aria-label', why);
          lockedSwitch.title = why;
          onBox.appendChild(lockedSwitch);
        } else {
          onBox.appendChild(api.toggle({ key: 'sidebar.enabled_' + id, label: name + ' is on', compact: true }));
        }
        switches.appendChild(newBox);
        switches.appendChild(onBox);
        line.appendChild(switches);
        li.appendChild(line);

        var warn = el('div', 'px-3 pb-3 empty:hidden');
        li.appendChild(warn);
        li._refreshWarn = function () {
          var n = needsSetup(id, api);
          warn.replaceChildren();
          if (n) warn.appendChild(actionNote(n[0], 'Set it up', function () { openSetup(n[1]); }));
        };
        li._refreshWarn();

        if (exp) {
          var bodyWrap = el('div', 'hidden border-t border-frosted-blue/10 p-5');
          bodyWrap.id = 'pages-expander-' + id;
          bodyWrap.appendChild(exp.body);
          li.appendChild(bodyWrap);
          wireExpander(toggleBtn, bodyWrap, exp.onOpen);
        }

        li.addEventListener('dragstart', function (e) {
          if (!li.draggable || e.target !== li) { e.preventDefault(); return; }
          dragId = id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
          li.classList.add('opacity-50');
        });
        li.addEventListener('dragend', function () {
          pressed = false;
          li.draggable = !!handle && handle.matches(':hover');
          li.classList.remove('opacity-50');
          dragId = null;
          clearMark();
        });
        return li;
      }

      // ---- Dragging ----
      // Nothing in the list moves while a row is dragged: the drop point is a
      // line drawn in the gap between rows (absolutely placed), and the rows
      // change places once, on drop.
      var dragId = null, mark = null;

      function clearMark() {
        if (!mark) return;
        mark.li.classList.remove('ws-drop-before', 'ws-drop-after');
        mark = null;
      }

      function dropTarget(e) {
        var li = e.target.closest && e.target.closest('li[data-page]');
        if (!li || !dragId || !list.contains(li)) return null;
        var id = li.getAttribute('data-page');
        if (id === dragId) return null;
        var rect = li.getBoundingClientRect();
        var after = (e.clientY - rect.top) > rect.height / 2;
        if (id === FIRST) after = true;       // nothing goes above the first page
        if (id === LAST) after = false;       // or below the last
        return { li: li, id: id, after: after };
      }

      list.addEventListener('dragover', function (e) {
        var t = dropTarget(e);
        if (!t) { clearMark(); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (mark && mark.li === t.li && mark.after === t.after) return;
        clearMark();
        t.li.classList.add(t.after ? 'ws-drop-after' : 'ws-drop-before');
        mark = t;
      });
      list.addEventListener('dragleave', function (e) {
        if (!e.relatedTarget || !list.contains(e.relatedTarget)) clearMark();
      });
      list.addEventListener('drop', function (e) {
        var t = dropTarget(e);
        clearMark();
        if (!t) return;
        e.preventDefault();
        var order = shown.filter(function (x) { return x !== dragId; });
        order.splice(order.indexOf(t.id) + (t.after ? 1 : 0), 0, dragId);
        commit(order, dragId);
      });

      start.forEach(function (id) { rows[id] = buildRow(id); list.appendChild(rows[id]); });
      api.track(ORDER_KEY, { get: function () { return api.get(ORDER_KEY); }, set: paint, el: list, errorEl: orderError });
      api.onSaved(function (keys) {
        if (keys.indexOf(ORDER_KEY) >= 0 && hasOwn(known, saved(ORDER_KEY))) savedOrder = known[saved(ORDER_KEY)];
      });
      function refreshWarnings() { start.forEach(function (id) { rows[id]._refreshWarn(); }); }
      api.onChange('requests.source', refreshWarnings);
      // Integrations may set a connection up while this tab stays mounted.
      document.addEventListener('ws-settings:saved', refreshWarnings);
      card.body.appendChild(list);
      card.body.appendChild(orderError);

      // Below the divider: pages that are not in the sidebar.
      var divider = el('div', 'flex items-center gap-3 pt-6');
      divider.appendChild(el('span', 'text-[13px] font-semibold text-frosted-blue/45', 'Not in the sidebar'));
      divider.appendChild(el('span', 'flex-1 h-px bg-frosted-blue/10'));
      card.body.appendChild(divider);
      var login = el('div', 'rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04]');
      var loginLine = el('div', 'flex items-center gap-3 p-3');
      var loginBtn = expandButton('More settings for the login page');
      loginLine.appendChild(loginBtn);
      loginLine.appendChild(el('span', 'flex-1 text-[15px] font-semibold text-frosted-blue', 'Login page'));
      loginLine.appendChild(el('span', 'font-mono text-[13px] text-frosted-blue/45', '/login'));
      login.appendChild(loginLine);
      var loginBody = el('div', 'hidden border-t border-frosted-blue/10 p-5');
      loginBody.id = 'pages-expander-login';
      loginBody.appendChild(loginExpander(api).body);
      login.appendChild(loginBody);
      wireExpander(loginBtn, loginBody, null);
      card.body.appendChild(login);

      panel.appendChild(card.root);
      panel.appendChild(live);
    }
  });
})();
