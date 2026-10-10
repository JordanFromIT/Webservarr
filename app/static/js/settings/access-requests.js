/**
 * Settings > Access requests: who asked for access from the sign-in page,
 * and the admin's answer (docs/superpowers/specs/2026-10-10-request-access-design.md,
 * section 9). The switch and the default libraries are settings (the save
 * bar saves them); Approve, Deny and Unblock are actions with their own
 * buttons. Everything a requester typed, and everything from Plex, is set
 * as text.
 *
 * The tab waits (briefly) for its list and the server's libraries. Approve
 * opens only once Plex has listed the libraries: a dialog with nothing to
 * tick would share nothing.
 */
(function () {
  'use strict';

  var el = WSSettings.el, cls = WSSettings.cls;
  var TAB = 'access-requests';
  var BASE = '/api/admin/access-requests';
  var KEY_ON = 'access_requests.enabled';
  var KEY_LIBS = 'access_requests.default_libraries';
  var LOAD_WAIT = 3000;
  var CHECK = 'h-5 w-5 shrink-0 rounded border-frosted-blue/30 bg-transparent text-primary focus:ring-focus';
  var CHECK_ROW = 'flex items-center gap-3 min-h-11 text-[15px] text-frosted-blue cursor-pointer';
  var CARD = 'rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] p-4 sm:p-5 min-w-0';

  var MSG = {
    needsPlex: 'This needs Plex. Connect it under Integrations first.',
    loadFailed: 'This couldn’t load. Try again in a moment.',
    libsFailed: 'Plex didn’t list your libraries, so nobody can be approved right now. Try again in a moment.',
    noLibs: 'Plex lists no libraries on your server.',
    noneWaiting: 'Nobody is waiting.',
    noneDecided: 'No answers in the last 30 days.',
    pickOne: 'Pick at least one library.',
    offline: 'That didn’t go through. Check your connection and try again.',
    shared: 'Approved. Plex sent them an invite.',
    existing: 'Approved. They already had access in Plex.',
    shareFailed: 'Approved, but Plex didn’t share. Share it in Plex yourself.',
    denied: 'Denied. They can ask again in 30 days.',
    blocked: 'Blocked. That Plex account can’t ask again.',
    unblocked: 'Unblocked. They can ask again.',
    copyFailed: 'Couldn’t copy. Their Plex username is on the card.'
  };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return plural(m, 'minute', 'minutes') + ' ago';
    var h = Math.round(s / 3600);
    if (h < 24) return plural(h, 'hour', 'hours') + ' ago';
    return plural(Math.round(s / 86400), 'day', 'days') + ' ago';
  }

  function day(iso) {
    var d = new Date(iso || '');
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  // The body as JSON, or {} for an empty body or an error page.
  function readJson(r) {
    return r.text().then(function (text) {
      var d = null;
      try { d = text ? JSON.parse(text) : null; } catch (e) { d = null; }
      return { status: r.status, ok: r.ok, d: d && typeof d === 'object' ? d : {} };
    }, function () { return { status: r.status, ok: r.ok, d: {} }; });
  }

  function tickedIn(box) {
    return Array.prototype.filter.call(box.querySelectorAll('input[type="checkbox"]'), function (b) {
      return b.checked;
    }).map(function (b) { return b.value; });
  }

  WSSettings.registerTab('access-requests', {
    // ctx: the page's (the kit passes it on each visit). Every listener and
    // request ends with its signal.
    mount: function (panel, api, ctx) {
      var signal = ctx.signal;
      var libraries = null;          // [{key, title, type}] once Plex lists them
      var libsFailed = false;
      var data = { pending: [], decided: [], blocked: [] };
      var busy = {};                 // request id: an answer is being given

      function checkRow(lib, checked, onChange) {
        var label = el('label', CHECK_ROW);
        var box = el('input', CHECK);
        box.type = 'checkbox';
        box.value = lib.key;
        box.checked = checked;
        if (onChange) box.addEventListener('change', onChange, { signal: signal });
        label.appendChild(box);
        label.appendChild(el('span', 'min-w-0 break-words', lib.title || 'Library ' + lib.key));
        return label;
      }

      function currentDefaults() {
        try {
          var keys = JSON.parse(api.get(KEY_LIBS) || '[]');
          return Array.isArray(keys) ? keys : [];
        } catch (e) { return []; }
      }

      // ---- The switch ----

      var sw = WSSettings.card('Sign-in page', 'Let people who don’t have access yet ask for it from the sign-in card.');
      sw.body.appendChild(api.toggle({ key: KEY_ON, label: 'Let people request access from the sign-in page' }));
      // The note's own box keeps its display, so hidden still hides it.
      var needsPlex = el('p', cls.help);
      var needsLine = el('span', 'flex items-center gap-2');
      var needsDot = el('span', 'ws-light ws-light-off');
      needsDot.setAttribute('aria-hidden', 'true');
      needsLine.appendChild(needsDot);
      needsLine.appendChild(el('span', '', MSG.needsPlex));
      needsPlex.appendChild(needsLine);
      needsPlex.setAttribute('data-ar-needs-plex', '');
      needsPlex.hidden = !!(api.saved('integration.plex.url') && api.saved('integration.plex.token'));
      sw.body.appendChild(needsPlex);
      panel.appendChild(sw.root);

      // ---- Default libraries (a setting) ----

      var defaults = WSSettings.card('Default libraries', 'Ticked for a new person when you approve them. You can change them for each person.');
      var libsBox = el('div', 'grid gap-x-6 max-w-2xl grid-cols-1 sm:grid-cols-2');
      libsBox.setAttribute('data-ar-defaults', '');
      var libsNote = el('p', cls.help);
      libsNote.setAttribute('role', 'status');
      var libsError = el('p', cls.help);
      defaults.body.appendChild(libsBox);
      defaults.body.appendChild(libsNote);
      defaults.body.appendChild(libsError);
      panel.appendChild(defaults.root);

      function paintDefaults() {
        libsBox.replaceChildren();
        if (!libraries) {
          libsNote.textContent = libsFailed ? MSG.libsFailed : '';
          return;
        }
        libsNote.textContent = libraries.length ? '' : MSG.noLibs;
        var on = currentDefaults();
        libraries.forEach(function (lib) {
          libsBox.appendChild(checkRow(lib, on.indexOf(lib.key) !== -1, function () {
            api.set(KEY_LIBS, JSON.stringify(tickedIn(libsBox)));
          }));
        });
      }
      api.track(KEY_LIBS, { get: function () { return JSON.stringify(tickedIn(libsBox)); },
                            set: function () { paintDefaults(); }, el: libsBox, errorEl: libsError });

      // ---- Waiting and Decided ----

      var waiting = WSSettings.card('Waiting', 'People who asked for access. Approving shares your Plex server with them.');
      var waitingList = el('div', 'space-y-3 max-w-2xl');
      waitingList.setAttribute('data-ar-waiting', '');
      waitingList.appendChild(el('span', 'skel skel-line block w-64 max-w-full'));
      waiting.body.appendChild(waitingList);
      panel.appendChild(waiting.root);

      var decided = WSSettings.card('Decided', 'Answers from the last 30 days, and the accounts you blocked.');
      var decidedList = el('div', 'space-y-3 max-w-2xl');
      decidedList.setAttribute('data-ar-decided', '');
      decided.body.appendChild(decidedList);
      panel.appendChild(decided.root);

      function who(r) {
        var head = el('div', 'flex items-center gap-3 min-w-0');
        if (r.avatar_url) {
          var img = el('img', 'h-10 w-10 shrink-0 rounded-full object-cover');
          img.alt = '';
          img.width = 40;
          img.height = 40;
          img.src = r.avatar_url;
          head.appendChild(img);
        }
        var names = el('div', 'min-w-0');
        names.appendChild(el('p', 'text-[15px] font-semibold text-frosted-blue break-words', r.plex_username));
        if (r.plex_email) names.appendChild(el('p', 'text-[13px] text-frosted-blue/70 break-all', r.plex_email));
        head.appendChild(names);
        return head;
      }

      function requestCard(r) {
        var card = el('article', CARD);
        card.setAttribute('data-ar-request', String(r.id));
        card.appendChild(who(r));
        var name = el('p', 'mt-3 text-[15px] text-frosted-blue break-words');
        name.appendChild(el('span', 'text-frosted-blue/70', 'Name: '));
        name.appendChild(document.createTextNode(r.name || ''));
        card.appendChild(name);
        var note = el('p', 'mt-1 text-[15px] text-frosted-blue whitespace-pre-line break-words max-w-prose', r.note || '');
        note.setAttribute('data-ar-note', '');
        card.appendChild(note);
        card.appendChild(el('p', 'mt-2 text-[13px] text-frosted-blue/60', 'Sent ' + ago(r.created_at)));
        var row = el('div', 'mt-4 flex flex-wrap gap-2');
        var approve = el('button', cls.btnPrimary, 'Approve');
        approve.type = 'button';
        approve.setAttribute('data-ar-approve', '');
        approve.setAttribute('aria-label', 'Approve ' + r.plex_username);
        approve.addEventListener('click', function () { approveIt(r, approve); }, { signal: signal });
        var deny = el('button', cls.btnGhost, 'Deny');
        deny.type = 'button';
        deny.setAttribute('data-ar-deny', '');
        deny.setAttribute('aria-label', 'Deny ' + r.plex_username);
        deny.addEventListener('click', function () { denyIt(r, deny); }, { signal: signal });
        row.appendChild(approve);
        row.appendChild(deny);
        card.appendChild(row);
        return card;
      }

      function outcome(r) {
        if (r.status === 'approved') {
          return 'Approved ' + ago(r.decided_at) + (r.share_state === 'shared' ? '. Plex sent the invite.'
            : r.share_state === 'existing' ? '. They already had access.' : '.');
        }
        if (r.status === 'denied') return 'Denied ' + ago(r.decided_at) + '. They can ask again after ' + day(r.can_ask_after) + '.';
        if (r.status === 'blocked') return 'Blocked ' + ago(r.decided_at) + '.';
        return '';
      }

      function decidedRow(r) {
        var item = el('article', CARD);
        item.setAttribute('data-ar-decided-row', String(r.id));
        item.appendChild(who(r));
        item.appendChild(el('p', 'mt-2 text-[13px] text-frosted-blue/70 break-words', outcome(r)));
        if (r.status === 'approved' && r.share_state === 'failed') {
          var reason = el('p', 'mt-1 text-[13px] text-status-err-text break-words', r.share_error || 'Plex didn’t share.');
          reason.setAttribute('data-ar-share-error', '');
          item.appendChild(reason);
          var copy = el('button', cls.btnGhost + ' mt-3', 'Share it in Plex yourself');
          copy.type = 'button';
          copy.setAttribute('data-ar-copy', '');
          copy.addEventListener('click', function () { copyName(r.plex_username); }, { signal: signal });
          item.appendChild(copy);
        }
        if (r.status === 'blocked') {
          var un = el('button', cls.btnGhost + ' mt-3', 'Unblock');
          un.type = 'button';
          un.setAttribute('data-ar-unblock', '');
          un.setAttribute('aria-label', 'Unblock ' + r.plex_username);
          un.addEventListener('click', function () { unblockIt(r, un); }, { signal: signal });
          item.appendChild(un);
        }
        return item;
      }

      function paintLists() {
        waitingList.replaceChildren();
        if (!data.pending.length) waitingList.appendChild(el('p', 'text-[15px] text-frosted-blue/70', MSG.noneWaiting));
        data.pending.forEach(function (r) { waitingList.appendChild(requestCard(r)); });
        decidedList.replaceChildren();
        var rows = data.decided.concat(data.blocked);
        if (!rows.length) decidedList.appendChild(el('p', 'text-[15px] text-frosted-blue/70', MSG.noneDecided));
        rows.forEach(function (r) { decidedList.appendChild(decidedRow(r)); });
        WSSettings.setCount(TAB, data.pending.length);
      }

      function retryBox(text, again) {
        var box = el('div', 'flex flex-wrap items-center gap-3');
        box.appendChild(el('p', 'text-[15px] text-frosted-blue/70', text));
        var b = el('button', cls.btnQuiet, 'Try again');
        b.type = 'button';
        b.addEventListener('click', again, { signal: signal });
        box.appendChild(b);
        return box;
      }

      // ---- The server ----

      function get(path) {
        return fetch(BASE + path, { credentials: 'same-origin', signal: signal }).then(readJson, function () {
          return { status: 0, ok: false, d: {} };
        });
      }

      function post(path, body) {
        var init = { method: 'POST', credentials: 'same-origin', signal: signal, headers: {} };
        if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        return fetch(BASE + path, init).then(readJson, function () { return { status: 0, ok: false, d: {} }; });
      }

      function leaveIf401(res) {
        if (res && res.status === 401) { WSSettings.leave('/login'); return true; }
        return false;
      }

      function failed(res) {
        var detail = res.d && typeof res.d.detail === 'string' ? res.d.detail : '';
        WSSettings.toast(detail || (res.status ? MSG.loadFailed : MSG.offline), 'err');
      }

      function loadLists() {
        return get('').then(function (res) {
          if (signal.aborted || leaveIf401(res)) return;
          if (!res.ok) { waitingList.replaceChildren(retryBox(MSG.loadFailed, loadLists)); return; }
          data = { pending: arr(res.d.pending), decided: arr(res.d.decided), blocked: arr(res.d.blocked) };
          paintLists();
        });
      }

      function loadLibraries() {
        return get('/libraries').then(function (res) {
          if (signal.aborted || leaveIf401(res)) return;
          libsFailed = !res.ok;
          libraries = res.ok ? arr(res.d.libraries).filter(function (l) { return l && typeof l.key === 'string'; }) : null;
          paintDefaults();
        });
      }

      // ---- Answers ----

      function approveIt(r, button) {
        if (busy[r.id]) return;
        if (!libraries || !libraries.length) {
          WSSettings.toast(libraries ? MSG.noLibs : MSG.libsFailed, 'err');
          loadLibraries();
          return;
        }
        busy[r.id] = true;
        var fs = el('fieldset', 'mt-2 space-y-2');
        fs.appendChild(el('legend', 'text-[13px] font-semibold text-frosted-blue/70 mb-1', 'Libraries ' + r.plex_username + ' gets'));
        var on = currentDefaults();
        libraries.forEach(function (lib) { fs.appendChild(checkRow(lib, on.indexOf(lib.key) !== -1, null)); });
        WSSettings.confirm({ title: 'Approve ' + r.plex_username + '?', body: fs, confirmLabel: 'Share and approve' }).then(function (ok) {
          if (!ok) { busy[r.id] = false; return; }
          var keys = tickedIn(fs);
          if (!keys.length) { busy[r.id] = false; WSSettings.toast(MSG.pickOne, 'err'); return; }
          button.disabled = true;
          return post('/' + r.id + '/approve', { library_keys: keys }).then(function (res) {
            busy[r.id] = false;
            if (signal.aborted || leaveIf401(res)) return;
            button.disabled = false;
            if (!res.ok) { failed(res); return loadLists(); }
            var state = res.d.share_state;
            WSSettings.toast(state === 'failed' ? MSG.shareFailed : state === 'existing' ? MSG.existing : MSG.shared,
                             state === 'failed' ? 'err' : 'ok');
            return loadLists();
          });
        });
      }

      function denyIt(r, button) {
        if (busy[r.id]) return;
        busy[r.id] = true;
        var body = el('div', 'space-y-3');
        body.appendChild(el('p', '', r.plex_username + ' can ask again in 30 days.'));
        var label = el('label', CHECK_ROW);
        var block = el('input', CHECK);
        block.type = 'checkbox';
        block.setAttribute('data-ar-block', '');
        label.appendChild(block);
        label.appendChild(el('span', '', 'Block this Plex account for good'));
        body.appendChild(label);
        WSSettings.confirm({ title: 'Deny ' + r.plex_username + '?', body: body, confirmLabel: 'Deny' }).then(function (ok) {
          if (!ok) { busy[r.id] = false; return; }
          button.disabled = true;
          var forGood = block.checked;
          return post('/' + r.id + '/deny', { block: forGood }).then(function (res) {
            busy[r.id] = false;
            if (signal.aborted || leaveIf401(res)) return;
            button.disabled = false;
            if (!res.ok) { failed(res); return loadLists(); }
            WSSettings.toast(forGood ? MSG.blocked : MSG.denied, 'ok');
            return loadLists();
          });
        });
      }

      function unblockIt(r, button) {
        if (busy[r.id]) return;
        busy[r.id] = true;
        button.disabled = true;
        post('/' + r.id + '/unblock').then(function (res) {
          busy[r.id] = false;
          if (signal.aborted || leaveIf401(res)) return;
          button.disabled = false;
          if (!res.ok) { failed(res); return loadLists(); }
          WSSettings.toast(MSG.unblocked, 'ok');
          return loadLists();
        });
      }

      function copyName(username) {
        var clip = window.navigator.clipboard;
        if (!clip || !clip.writeText) { WSSettings.toast(MSG.copyFailed, 'err'); return; }
        clip.writeText(username).then(function () {
          WSSettings.toast('Copied ' + username + '. Share your server with them in Plex.', 'ok');
        }, function () { WSSettings.toast(MSG.copyFailed, 'err'); });
      }

      var ready = Promise.all([loadLists(), loadLibraries()]);
      return Promise.race([ready, new Promise(function (resolve) { ctx.setTimeout(resolve, LOAD_WAIT); })]);
    }
  });
})();
