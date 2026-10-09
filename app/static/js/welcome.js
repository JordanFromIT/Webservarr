/**
 * WebServarr: Home's welcome tour (page helper, data-ws-page-script)
 *
 * Shown once to everyone, new or not, the first time Home is opened on this
 * device after version 2 (localStorage webservarr_welcome_v2_seen). It runs on
 * the shared engine (js/tour.js) and walks the shell: the event log, the
 * service status, the bell (and an offer to turn on notifications), adding
 * the site to the home screen, the calendar, Books and, on a phone, the tab
 * bar. "Welcome tour" in the account menu and in More (/?welcome=1) runs
 * it again.
 *
 * The two offers (notifications, home screen) keep their answer in
 * theme-loader.js WSAsk, which Home's push banner reads too:
 *   Turn on / Add       the browser's own question, from the tap
 *   Not now             asked again on the next visit: a full load or a
 *                       sign-in, never a soft navigation. Closing the tour
 *                       early (Skip, Escape) is a Not now for both.
 *   Don't ask me again  a confirmation first, then nothing asks again (the
 *                       banner included). The bell and More still have them.
 * A tour already seen asks again with one small bubble of its own (the
 * engine's quiet mode), at most one per visit, and never in a visit where
 * the banner or the tour has already asked.
 *
 * WSWelcome.mount(ctx) is called by pages/home.js on every visit, after the
 * banner has been decided; everything ends with ctx.signal.
 */
(function () {
  'use strict';

  var LG = '(min-width: 1024px)';
  var START_MS = 1200;     // the event log and the status have their words
  var REPLAY_MS = 400;     // asked for: soon, once the page has settled
  var REPLAY = 'welcome';  // /?welcome=1, the menus' "Welcome tour"

  var PUSH_BASE = 'Updates on your requests, issues and tickets, server problems and announcements land here.';
  var PUSH_STOP = 'You can still turn notifications on from the bell, under Notification settings.';
  var IOS_STEPS = [['Tap ', 'ios_share', ' Share in the browser toolbar'], 'Tap Add to Home Screen'];
  var PHONE_MENU_STEPS = [['Open the browser menu ', 'more_vert', ''], 'Tap Add to Home screen or Install app'];
  var DESKTOP_MENU_STEPS = ['Open the browser menu, or the install icon in the address bar', 'Choose Install, if your browser offers it'];

  function matches(q) {
    try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch (e) { return false; }
  }
  function phone() { return !matches(LG); }
  function installed() { return typeof window.WSInstalled === 'function' && !!window.WSInstalled(); }
  function ios() { return typeof window.WSInstallIOS === 'function' && !!window.WSInstallIOS(); }
  function ask() { return window.WSAsk; }

  // The operator's site name, or words that stand in for one (as More's row).
  function siteName() {
    var b = window.WEBSERVARR_THEME || ((window.WS_DATA || {}).branding) || {};
    var name = typeof b.app_name === 'string' ? b.app_name.trim() : '';
    return name || 'this site';
  }

  function toast(text) {
    if (window.WSUI && typeof window.WSUI.toast === 'function') window.WSUI.toast(text, 'err');
  }

  /* Where push stands on this device:
     'offer'        it can be asked for
     'granted'      already allowed
     'blocked'      refused in the browser: say how to undo that
     'ios'          an iPhone or iPad in a browser tab: only the home-screen app has push
     'unsupported'  no push here (the browser, the server, or an account with no email) */
  function pushKind() {
    if (ios() && !installed()) return 'ios';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    var user = (window.WS_DATA || {}).user || {};
    if (!user.has_email || !(window.WEBSERVARR_THEME || {}).vapid_public_key || !window.WSPush) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'blocked';
    return 'offer';
  }

  function pushAskable() { return pushKind() === 'offer' && ask().get('push') !== 'never'; }
  function installAskable() {
    var state = ask().get('install');
    return !installed() && state !== 'never' && state !== 'done';
  }

  function bell() {
    return phone() ? '#mobileTopBar button[title="Notifications"]' : '#appHeader button[title="Notifications"]';
  }

  /* A page's nav entry: the sidebar on a wide screen, the tab bar on a phone,
     or More when the tab bar has no room for it. null when the page is off. */
  function navEntry(href) {
    if (phone()) {
      var tab = '#wsTabList a[href="' + href + '"]';
      if (document.querySelector(tab)) return { target: tab, more: false };
      if (document.querySelector('#wsMoreNav a[href="' + href + '"]')) return { target: '#wsMoreBtn', more: true };
      return null;
    }
    var side = '#desktopNav a[href="' + href + '"]';
    return document.querySelector(side) ? { target: side, more: false } : null;
  }

  function eventLogShown() {
    var el = document.getElementById('wsEventLog');
    return !!el && !el.hidden && !el.classList.contains('hidden');
  }

  // ---- The answers ----

  function later(kind) {
    return function (ctl) { ask().set(kind, 'later'); ctl.next(); };
  }

  /* "Don't ask me again" asks first. Cancel puts the offer back. */
  function confirmStop(kind, words) {
    return function (ctl) {
      ctl.update({
        title: 'Stop asking?',
        body: words,
        list: null,
        actions: [
          { label: 'Stop asking', kind: 'primary', run: function (c) { ask().set(kind, 'never'); c.next(); } },
          { label: 'Cancel', kind: 'quiet', focus: true, run: function (c) { c.update(null); } }
        ]
      });
    };
  }

  /* Turn on: notifications.js's own subscribe path, straight from the tap
     (the browser only asks in answer to one). The step moves on the moment
     the browser says yes; the subscribe and the save finish behind it. */
  function turnOnPush(ctl) {
    var push = window.WSPush;
    var moved = false;
    return push.subscribe(function () {
      ask().set('push', '');
      moved = true;
      ctl.next();
    }).then(null, function (err) {
      var kind = push.failureKind(err);
      // The browser's own question, answered no (blocked: the permission
      // says so from now on) or closed (a Not now).
      if (kind === 'blocked' || kind === 'dismissed') {
        ask().set('push', kind === 'dismissed' ? 'later' : '');
        if (!moved) ctl.next();
        return;
      }
      var words = push.messages[kind] || push.messages.failed;
      if (moved) { toast(words); return; }
      ctl.update({
        body: words,
        list: null,
        actions: [{ label: 'Continue', kind: 'primary', focus: true, run: function (c) { c.next(); } }]
      });
    });
  }

  function pushOffer() {
    return [
      { label: 'Turn on notifications', kind: 'primary', busyLabel: 'Turning on…', run: turnOnPush },
      { label: 'Not now', kind: 'quiet', focus: true, run: later('push') },
      { label: 'Don’t ask me again', kind: 'link', run: confirmStop('push', PUSH_STOP) }
    ];
  }

  function installStop() {
    return phone() ? 'You can still add it from More.' : 'You can still install it from your browser’s menu.';
  }

  /* Add: the browser's own prompt where it has given us one (Chrome,
     Android), else the steps to take in its menu. */
  function addIt(ctl) {
    var inst = window.WS && window.WS.install;
    if (window.WSInstallPrompt && inst && typeof inst.prompt === 'function') {
      return inst.prompt().then(function (outcome) {
        ask().set('install', outcome === 'accepted' ? 'done' : 'later');
        ctl.next();
      });
    }
    ctl.update({
      body: 'Add it from your browser’s menu:',
      list: phone() ? PHONE_MENU_STEPS : DESKTOP_MENU_STEPS,
      actions: [
        { label: 'Done', kind: 'primary', focus: true, run: function (c) { ask().set('install', 'done'); c.next(); } },
        { label: 'Not now', kind: 'quiet', run: later('install') }
      ]
    });
  }

  // ---- The steps ----

  function pushStep() {
    return {
      target: bell(),
      icon: 'notifications',
      title: 'Notifications',
      view: function () {
        var kind = pushKind();
        if (kind === 'offer' && ask().get('push') !== 'never') {
          return { body: PUSH_BASE + ' Want them on this device too, even with the page closed?', actions: pushOffer() };
        }
        if (kind === 'blocked') {
          return { body: PUSH_BASE + ' This browser is blocking notifications from this site. To get them here, allow notifications in the browser’s site settings, then reload the page.' };
        }
        if (kind === 'ios') {
          return { body: PUSH_BASE + ' On an iPhone or iPad they only arrive in the home screen app: add it, open it from your home screen, then turn them on from the bell.' };
        }
        return { body: PUSH_BASE + ' To choose what you get, open the bell and pick Notification settings.' };
      }
    };
  }

  function installStep() {
    return {
      target: phone() ? '#wsMoreBtn' : null,
      icon: 'add_to_home_screen',
      view: function () {
        var onPhone = phone();
        var title = onPhone ? 'Add to home screen' : 'Install as an app';
        var body = onPhone ? 'Open ' + siteName() + ' from your home screen, full screen like an app.'
                           : 'Open ' + siteName() + ' in a window of its own, like an app.';
        var state = ask().get('install');
        if (state === 'never' || state === 'done') {
          return { title: title, body: body + (onPhone ? ' It’s under More whenever you want it.' : ' Your browser’s menu has it whenever you want it.'),
                   list: ios() ? IOS_STEPS : null };
        }
        var rest = [
          { label: 'Not now', kind: 'quiet', focus: true, run: later('install') },
          { label: 'Don’t ask me again', kind: 'link', run: confirmStop('install', installStop()) }
        ];
        if (ios()) {
          return { title: title, body: body + ' On an iPhone or iPad it’s also how you get notifications.', list: IOS_STEPS,
                   actions: [{ label: 'Done', kind: 'primary', run: function (c) { ask().set('install', 'done'); c.next(); } }].concat(rest) };
        }
        return { title: title, body: body,
                 actions: [{ label: onPhone ? 'Add to home screen' : 'Install app', kind: 'primary', run: addIt }].concat(rest) };
      }
    };
  }

  function navStep(href, icon, title, body) {
    var at = navEntry(href);
    if (!at) return null;
    return { target: at.target, icon: icon, title: title, body: body + (at.more ? ' Find it under More.' : '') };
  }

  /* The tour as this screen and this device have it, read when it starts. */
  function steps() {
    var onPhone = phone();
    var list = [];
    if (eventLogShown()) {
      list.push({ target: '#wsEventLog', icon: 'history', title: 'Event log',
                  body: 'A quick look around, starting here. The event log shows what’s happening: new movies and episodes, filled requests, outages and notes from the admin. Scroll it to see older events.' });
    }
    list.push({ target: onPhone ? '#wsStatusChip' : '#systemStatus', icon: 'monitor_heart', title: 'Service status',
                body: 'Shows at a glance whether everything is up. ' + (onPhone ? 'Tap' : 'Click') + ' it for the live health of each service.' });

    // On an iPhone or iPad in a browser tab, the home screen comes first:
    // notifications only work from there.
    var push = pushStep();
    var home = installed() ? null : installStep();
    if (home && ios()) list.push(home, push);
    else { list.push(push); if (home) list.push(home); }

    var cal = navStep('/calendar', 'calendar_month', 'Calendar', 'Upcoming movies and episodes, so you know what’s coming and when.');
    if (cal) list.push(cal);
    var books = navStep('/books', 'menu_book', 'New: Books', 'Read ebooks and listen to audiobooks right here. Each book keeps your place on every device.');
    if (books) list.push(books);
    if (onPhone && document.getElementById('wsTabBar')) {
      list.push({ target: '#wsTabBar', icon: 'travel_explore', title: 'Getting around',
                  body: 'Your main pages are always down here. The rest are under More.' });
    }

    // An offer the tour shows counts as Not now until it is answered, so a
    // tour closed early asks again next time.
    if (pushAskable() && !ask().get('push')) ask().set('push', 'later');
    if (home && installAskable() && !ask().get('install')) ask().set('install', 'later');
    return list;
  }

  /* What a seen tour asks again this visit, if anything: the home screen
     first on an iPhone or iPad tab (push needs it), else notifications. */
  function waiting() {
    var homeLater = ask().get('install') === 'later' && !installed();
    if (homeLater && ios()) return 'install';
    if (ask().get('push') === 'later' && pushKind() === 'offer') return 'push';
    return homeLater ? 'install' : null;
  }

  function promptStep(kind) {
    if (kind === 'push') {
      return { target: bell(), icon: 'notifications', title: 'Turn on notifications?',
               body: 'Get updates on your requests and server problems on this device, even with the page closed.',
               actions: pushOffer() };
    }
    var step = installStep();
    var view = step.view;
    step.view = function () {
      var v = view();
      v.title = v.title + '?';
      return v;
    };
    return step;
  }

  /* Takes ?welcome=1 off the address, so a reload does not run it again. */
  function dropReplayMark() {
    try {
      var u = new URL(location.href);
      if (u.searchParams.get(REPLAY) !== '1') return;
      u.searchParams.delete(REPLAY);
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) { /* the address stays; harmless */ }
  }

  function mount(ctx) {
    var Tour = window.WebServarrTour;
    if (!Tour || typeof Tour.init !== 'function' || !ask() || (ctx.signal && ctx.signal.aborted)) return;
    var replay = !!(ctx.url && ctx.url.searchParams && ctx.url.searchParams.get(REPLAY) === '1');
    var tour = Tour.init({ seenKey: ask().WELCOME_SEEN, steps: steps, signal: ctx.signal });

    if (replay) {
      dropReplayMark();
      ask().markAsked('welcome');
      ctx.setTimeout(tour.start, REPLAY_MS);
      return;
    }
    // Once per visit: a soft navigation back to Home never asks again.
    if (ask().asked()) return;
    ctx.setTimeout(function () {
      if (ask().asked()) return;
      if (!ask().welcomeSeen()) {
        ask().markAsked('welcome');
        tour.start();
        return;
      }
      var kind = waiting();
      if (!kind) return;
      ask().markAsked('welcome');
      Tour.init({ quiet: true, steps: [promptStep(kind)], signal: ctx.signal }).start();
    }, START_MS);
  }

  window.WSWelcome = { mount: mount, steps: steps };
})();
