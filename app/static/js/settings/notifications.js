/**
 * Settings > Notifications: whether push works, a test push to yourself, an
 * announcement to everyone, and how often the server checks for news.
 * The test push and the announcement are actions (their own buttons); only
 * the check intervals go through the save bar.
 *
 * The tab waits (briefly) for the push status, a fast call. Each status line
 * keeps its height whatever it says, so nothing moves when it fills in or
 * refreshes after a test push or an announcement.
 */
(function () {
  'use strict';

  var el = WSSettings.el, icon = WSSettings.icon, cls = WSSettings.cls;
  var STATUS_URL = '/api/admin/notifications/status';
  var TEST_URL = '/api/admin/notifications/test-push';
  var SEND_URL = '/api/admin/notifications/send';
  // The tab shows after this long even if the status hasn't answered; it fills in when it does.
  var STATUS_WAIT = 3000;
  var INTERVALS = [
    ['notifications.poll_interval_seerr', 'Requests', 'How often to check for request updates.'],
    ['notifications.poll_interval_monitors', 'Service outages', 'How often to check Uptime Kuma.'],
    ['notifications.poll_interval_news', 'News posts', 'How often to check for new posts.'],
    ['notifications.poll_interval_tickets', 'Tickets', 'How often to check for ticket replies.']
  ];

  var MSG = {
    ready: 'Push notifications are set up.',
    notReady: 'Push notifications aren’t set up.',
    statusFailed: 'Push status couldn’t load right now.',
    noDevices: 'No devices have push turned on yet.',
    noLastPush: 'No pushes since the server last started.',
    testFailed: 'The test push couldn’t be sent.',
    testOffline: 'The test push couldn’t be sent. Check your connection.',
    testNone: 'None of your devices have push turned on. Turn it on from the bell menu, then try again.',
    needBoth: 'Add a title and a message first.',
    sendFailed: 'The announcement wasn’t sent. Try again.',
    sendOffline: 'The announcement wasn’t sent. Check your connection.',
    sendNobody: 'Nobody got it: no one has push on or has had a recent notification.',
    busy: 'That was a lot of tries in a row. Wait a minute, then try again.',
    speed: 'Shorter means quicker alerts and a little more work for your services.'
  };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // A count from the server, or 0 when it isn't one.
  function num(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0; }

  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(s / 3600);
    if (h < 24) return plural(h, 'hour', 'hours') + ' ago';
    return plural(Math.round(s / 86400), 'day', 'days') + ' ago';
  }

  // Seconds in plain words: 45 -> "45 seconds", 120 -> "2 minutes", 7200 -> "2 hours".
  function plainSeconds(s) {
    if (s >= 3600 && s % 3600 === 0) return plural(s / 3600, 'hour', 'hours');
    if (s >= 60 && s % 60 === 0) return plural(s / 60, 'minute', 'minutes');
    return plural(s, 'second', 'seconds');
  }

  // "from <min> to <max>" in plain words, from the setting's own meta; '' when it has no range.
  function rangeOf(key) {
    var m = WSSettings.metaFor(key);
    if (!m || typeof m.min !== 'number' || typeof m.max !== 'number') return '';
    return 'from ' + plainSeconds(m.min) + ' to ' + plainSeconds(m.max);
  }

  // The body as JSON, or {} for an empty body or an error page.
  function readJson(r) {
    return r.text().then(function (text) {
      var d = null;
      try { d = text ? JSON.parse(text) : null; } catch (e) { d = null; }
      return { status: r.status, ok: r.ok, d: d && typeof d === 'object' ? d : {} };
    }, function () { return { status: r.status, ok: r.ok, d: {} }; });
  }

  function sentence(text) {
    text = String(text).trim();
    return /[.!?…]$/.test(text) ? text : text + '.';
  }

  // Also clears a skeleton bar still in the line (it has no text of its own).
  function setText(node, text) {
    if (node.textContent !== text || node.firstElementChild) node.textContent = text;
  }

  function lastPushText(last) {
    if (!last || typeof last !== 'object') return MSG.noLastPush;
    var tried = num(last.attempted), when = ago(last.at);
    return 'Last push' + (last.category === 'test' ? ' (a test)' : '') + (when ? ' ' + when : '') +
      ': delivered to ' + num(last.succeeded) + ' of ' + plural(tried, 'device', 'devices') + '.';
  }

  WSSettings.registerTab('notifications', {
    mount: function (panel, api) {
      var status = null, statusSeq = 0;

      // ---- Push status and the test push ----

      var pushCard = WSSettings.card('Push notifications', 'Alerts that reach people’s phones and computers, even when the site is closed.');
      // Three lines of fixed height, each a skeleton bar until the status lands.
      // Not a live region: the minute count would be read out every minute.
      // What a test push or an announcement did is told in its toast.
      var statusBox = el('div', 'space-y-2');
      var readyLine = el('p', 'min-h-6 flex items-start gap-2 text-[15px] leading-6 text-frosted-blue');
      var light = el('span', 'ws-light ws-light-checking mt-[7px]');
      light.setAttribute('aria-hidden', 'true');
      var readyText = el('span', 'min-w-0');
      readyText.appendChild(el('span', 'skel skel-line inline-block align-middle w-56'));
      readyLine.appendChild(light);
      readyLine.appendChild(readyText);
      var devicesLine = el('p', 'min-h-5 text-[13px] leading-5 text-frosted-blue/70');
      devicesLine.appendChild(el('span', 'skel skel-line inline-block align-middle w-64 max-w-full'));
      var lastLine = el('p', 'min-h-5 text-[13px] leading-5 text-frosted-blue/70');
      lastLine.appendChild(el('span', 'skel skel-line inline-block align-middle w-72 max-w-full'));
      statusBox.appendChild(readyLine);
      statusBox.appendChild(devicesLine);
      statusBox.appendChild(lastLine);
      pushCard.body.appendChild(statusBox);

      var testRow = el('div');
      var testBtn = el('button', cls.btnGhost);
      testBtn.type = 'button';
      testBtn.appendChild(icon('notifications_active', 'text-base'));
      testBtn.appendChild(document.createTextNode('Send a test push to me'));
      testRow.appendChild(testBtn);
      testRow.appendChild(el('p', cls.help, 'Only your own devices get it. Turn on push from the bell menu on a device first.'));
      pushCard.body.appendChild(testRow);
      panel.appendChild(pushCard.root);

      function paintStatus() {
        var d = status;
        var lightCls = 'ws-light mt-[7px] ' + (d.push_ready ? 'ws-light-ok' : 'ws-light-warn');
        if (light.className !== lightCls) light.className = lightCls;
        setText(readyText, d.push_ready ? MSG.ready
          : (typeof d.reason === 'string' && d.reason.trim() ? d.reason : MSG.notReady));
        var devices = num(d.devices), users = num(d.users);
        setText(devicesLine, devices ? plural(devices, 'device', 'devices') + ' from ' +
          plural(users, 'person', 'people') + ' can receive them.' : MSG.noDevices);
        setText(lastLine, lastPushText(d.last_push));
      }

      // A failed first load says so on the first line; a failed refresh keeps
      // what is shown. Answers that land out of order are dropped.
      function loadStatus() {
        var mine = ++statusSeq;
        return fetch(STATUS_URL, { credentials: 'same-origin' }).then(readJson, function () {
          return { status: 0, ok: false, d: {} };
        }).then(function (res) {
          if (mine !== statusSeq) return;
          if (res.status === 401) { WSSettings.leave('/login'); return; }
          if (!res.ok || typeof res.d.push_ready !== 'boolean') {
            if (status) return;
            light.className = 'ws-light mt-[7px] ws-light-unconfigured';
            setText(readyText, MSG.statusFailed);
            setText(devicesLine, '');
            setText(lastLine, '');
            return;
          }
          status = res.d;
          paintStatus();
        }).catch(function (e) {
          if (window.console) console.error(e);
        });
      }

      testBtn.addEventListener('click', function () {
        testBtn.disabled = true;
        fetch(TEST_URL, { method: 'POST', credentials: 'same-origin' }).then(readJson, function () {
          return null;
        }).then(function (res) {
          if (!res) { WSSettings.toast(MSG.testOffline, 'err'); return; }
          if (res.status === 401) { WSSettings.leave('/login'); return; }
          var d = res.d;
          if (res.status === 400 && typeof d.detail === 'string' && d.detail.trim()) {
            WSSettings.toast(sentence(d.detail), 'err');
          } else if (res.status === 429) {
            WSSettings.toast(MSG.busy, 'err');
          } else if (!res.ok) {
            WSSettings.toast(MSG.testFailed, 'err');
          } else {
            var tried = num(d.attempted), got = num(d.succeeded);
            if (!tried) WSSettings.toast(MSG.testNone, 'info');
            else WSSettings.toast('Sent to ' + got + ' of your ' + plural(tried, 'device', 'devices') + '.', got ? 'ok' : 'err');
            loadStatus();
          }
        }).catch(function (e) {
          if (window.console) console.error(e);
          WSSettings.toast(MSG.testFailed, 'err');
        }).then(function () { testBtn.disabled = false; });
      });

      // ---- Announcement ----

      var ann = WSSettings.card('Announcement to everyone', 'Sends a notification to everyone who uses the site, and a push to anyone who has push on.');
      var title = el('input', cls.input);
      title.id = 'notifAnnounceTitle';
      title.maxLength = 120;
      title.autocomplete = 'off';
      var titleLabel = el('label', cls.label, 'Title');
      titleLabel.htmlFor = title.id;
      var body = el('textarea', cls.input);
      body.id = 'notifAnnounceBody';
      body.rows = 3;
      body.maxLength = 500;
      var bodyLabel = el('label', cls.label, 'Message');
      bodyLabel.htmlFor = body.id;
      var sendBtn = el('button', cls.btnPrimary);
      sendBtn.type = 'button';
      sendBtn.appendChild(icon('campaign', 'text-base'));
      sendBtn.appendChild(document.createTextNode('Send announcement'));
      var f1 = el('div'); f1.appendChild(titleLabel); f1.appendChild(title);
      var f2 = el('div'); f2.appendChild(bodyLabel); f2.appendChild(body);
      ann.body.appendChild(f1);
      ann.body.appendChild(f2);
      ann.body.appendChild(sendBtn);
      panel.appendChild(ann.root);

      sendBtn.addEventListener('click', function () {
        var t = title.value.trim(), b = body.value.trim();
        if (!t || !b) { WSSettings.toast(MSG.needBoth, 'err'); (t ? body : title).focus(); return; }
        var n = status ? num(status.recipients) : null;
        WSSettings.confirm({
          title: n === null ? 'Send to everyone?' : 'Send to ' + plural(n, 'person', 'people') + '?',
          // A string body goes in as text (the dialog sets textContent), so the admin's title is safe here.
          body: '“' + t + '” goes to everyone right away. It can’t be taken back.',
          confirmLabel: 'Send', cancelLabel: 'Cancel'
        }).then(function (ok) {
          if (!ok) return;
          sendBtn.disabled = true;
          return fetch(SEND_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: t, body: b }), credentials: 'same-origin'
          }).then(readJson, function () {
            return null;
          }).then(function (res) {
            if (!res) { WSSettings.toast(MSG.sendOffline, 'err'); return; }
            if (res.status === 401) { WSSettings.leave('/login'); return; }
            if (res.status === 429) { WSSettings.toast(MSG.busy, 'err'); return; }
            if (!res.ok) { WSSettings.toast(MSG.sendFailed, 'err'); return; }
            var sent = num(res.d.sent_to);
            if (!sent) { WSSettings.toast(MSG.sendNobody, 'info'); return; }
            WSSettings.toast('Sent to ' + plural(sent, 'person', 'people') + '.', 'ok');
            title.value = '';
            body.value = '';
            loadStatus();
          });
        }).catch(function (e) {
          if (window.console) console.error(e);
          WSSettings.toast(MSG.sendFailed, 'err');
        }).then(function () { sendBtn.disabled = false; });
      });

      // ---- Check intervals (the save bar) ----

      // The allowed range is each setting's own min and max. One sentence on
      // the card when all four share it, else one on each field.
      var ranges = INTERVALS.map(function (x) { return rangeOf(x[0]); });
      var shared = ranges.every(function (r) { return r === ranges[0]; }) ? ranges[0] : '';
      var checks = WSSettings.card('How often to check',
        (shared ? 'Each can be ' + shared + '. ' : '') + MSG.speed);
      var grid = el('div', 'grid sm:grid-cols-2 gap-5');
      INTERVALS.forEach(function (x, i) {
        var own = !shared && ranges[i] ? ' Any time ' + ranges[i] + '.' : '';
        grid.appendChild(api.text({ key: x[0], label: x[1], help: x[2] + own, inputType: 'number', suffix: 'seconds' }));
      });
      checks.body.appendChild(grid);
      panel.appendChild(checks.root);

      // "Last push … ago" keeps counting while the tab is open.
      if (window.WS && WS.poll) WS.poll(function () { if (status) paintStatus(); }, 30000);

      return Promise.race([loadStatus(), new Promise(function (done) { setTimeout(done, STATUS_WAIT); })]);
    }
  });
})();
