/**
 * WebServarr: request access, inside the sign-in card (/login)
 *
 * A visitor asks for access from the sign-in card
 * (docs/superpowers/specs/2026-10-10-request-access-design.md, section 9).
 * They prove their Plex account in the Plex window, fill in a short form,
 * and the admin answers in Settings. Nothing here signs anyone in: the
 * server makes no session for this flow.
 *
 * The steps are static blocks in login.html, hidden until shown, so nothing
 * is built from markup strings; what Plex or the person typed is set as
 * text. Loaded before login.js, which calls WSRequestAccess.apply(theme)
 * whenever it applies the sign-in methods. A file: the CSP is script-src 'self'.
 */
var WSRequestAccess = (function () {
  'use strict';

  var API = '/api/access-requests';
  var HASH = '#request-access';
  var PIN_KEY = 'access_pin_id';
  var NOTE_MAX = 1000;
  var NOT_YET = 'PIN not yet authorized. Try again.';
  var RETRY_MS = 2000;
  var RETRIES = 5;
  var POLL_MS = 1000;
  var MSG = {
    closedEarly: 'Plex sign-in was closed before it finished.',
    blocked: 'Your browser blocked the Plex window. Allow pop-ups, then press Reopen Plex sign-in.',
    plexDown: 'Plex isn’t answering right now. Try again in a minute.',
    offline: 'That didn’t go through. Check your connection and try again.',
    tooMany: 'Too many tries. Wait a few minutes and try again.',
    expired: 'That Plex sign-in expired. Start again.',
    closed: 'Access requests are closed.',
    form: 'Check your name and your answer, then try again.'
  };
  // Submit's answer when 20 requests already wait. The ticket is used up by
  // then, so the form can't be sent again: the card ends on it (S5).
  var FULL = 'We’re not taking new requests right now. Try again later.';
  var APPROVED = 'You’re approved. Accept the Plex invite from your email or a Plex app, then sign in here.';
  var STATUS = {
    pending: function (d) { return 'Your request is waiting for review. Sent ' + day(d.submitted_at) + '.'; },
    approved: function () { return APPROVED; },
    invited: function () { return APPROVED; },
    denied: function (d) { return 'This request wasn’t approved. You can ask again after ' + day(d.can_ask_after) + '.'; },
    blocked: function () { return 'This Plex account can’t request access.'; },
    member: function () { return 'You already have access.'; },
    full: function (d) { return d.detail || FULL; }
  };

  var on = false;          // the site takes requests (auth_methods.request_access)
  var wired = false;
  var resumed = false;     // the phone's way back has been looked at
  var pushed = false;      // this page pushed the #request-access entry
  var current = 'signin';
  var popup = null;
  var pollTimer = null;
  var pinId = null;
  var authUrl = '';
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function step(name) { return document.querySelector('[data-ra-step="' + name + '"]'); }

  function day(iso) {
    var d = new Date(iso || '');
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function setError(text) { $('raError').textContent = text || ''; }

  // The server writes straight apostrophes; the card's own words curly ones.
  function same(a, b) { return String(a).replace(/’/g, "'") === String(b).replace(/’/g, "'"); }

  // Shown means no ancestor hides it (login.js hides the password fields by
  // style when that sign-in is off).
  function shown(n) {
    for (; n && n !== document.body; n = n.parentElement) {
      if (n.hidden || n.classList.contains('hidden') || n.style.display === 'none') return false;
    }
    return !!n;
  }

  function firstSignIn() {
    var c = document.querySelectorAll('#loginForm input, #loginForm button');
    for (var i = 0; i < c.length; i++) if (shown(c[i])) return c[i];
    return null;
  }

  // One step on screen. 'signin' is today's card (S0).
  function show(name, firstControl) {
    current = name;
    var inFlow = name !== 'signin';
    $('loginForm').hidden = inFlow;
    $('requestAccessLinkRow').hidden = inFlow || !on;
    $('requestAccess').hidden = !inFlow;
    var steps = document.querySelectorAll('#requestAccess [data-ra-step]');
    for (var i = 0; i < steps.length; i++) steps[i].hidden = steps[i].getAttribute('data-ra-step') !== name;
    // The error line sits just above this step's buttons (Jordan, mockup
    // 2026-10-10); on the sign-in step, back in its place under the form.
    var err = $('raError');
    var first = inFlow ? step(name).querySelector('button') : null;
    if (first) first.parentNode.insertBefore(err, first);
    else $('requestAccess').parentNode.insertBefore(err, $('requestAccess').nextSibling);
    setError('');
    if (!inFlow) {
      // The link, unless it just went away (requests closed): then the form.
      var target = firstControl || !shown($('requestAccessLink')) ? firstSignIn() : $('requestAccessLink');
      if (target && shown(target)) target.focus();
      return;
    }
    var h = step(name).querySelector('[data-ra-heading]');
    $('raLive').textContent = h ? h.textContent : '';
    if (h) h.focus();
  }

  function enter(name) {
    if (location.hash !== HASH) {
      history.pushState(null, '', location.pathname + location.search + HASH);
      pushed = true;
    }
    show(name);
  }

  function leaveHash() {
    if (location.hash !== HASH) return;
    if (pushed) { pushed = false; history.back(); return; }
    history.replaceState(null, '', location.pathname + location.search);
  }

  function backToSignIn(firstControl) {
    stopPopup(true);
    pinId = null;
    show('signin', firstControl);
    leaveHash();
  }

  function onPop() {
    if (location.hash === HASH) { if (on && current === 'signin') show('intro'); return; }
    pushed = false;
    if (current !== 'signin') { stopPopup(true); pinId = null; show('signin'); }
  }

  // ---- The server ----

  function send(url, body) {
    var init = { method: 'POST', credentials: 'same-origin', headers: {} };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(url, init).then(function (r) {
      return r.text().then(function (text) {
        var d = null;
        try { d = text ? JSON.parse(text) : null; } catch (e) { d = null; }
        d = d && typeof d === 'object' ? d : {};
        return { ok: r.ok, status: r.status, data: d, detail: typeof d.detail === 'string' ? d.detail : '' };
      });
    }, function () { return { ok: false, status: 0, data: {}, detail: '' }; });
  }

  // An answer the card can't move on with: say why, on the same step.
  function fail(res) {
    if (res.status === 403) { closeFlow(); return; }
    setError(res.status === 0 ? MSG.offline
      : res.status === 429 ? MSG.tooMany
      : res.detail ? res.detail
      : res.status === 422 ? MSG.form : MSG.plexDown);
  }

  // The site stopped taking requests while this card was open.
  function closeFlow() {
    on = false;
    backToSignIn(false);
    setError(MSG.closed);
  }

  // ---- Plex ----

  function stopPopup(closeIt) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (closeIt && popup && !popup.closed) popup.close();
    popup = null;
  }

  function watch(win) {
    stopPopup(false);
    popup = win;
    pollTimer = setInterval(function () {
      if (popup && popup.closed) { stopPopup(false); identify('closed', 0); }
    }, POLL_MS);
  }

  function onMessage(e) {
    // Only the popup this page opened, back on this origin (plex-callback.js
    // posts to it), and only the request flow's message.
    if (!popup || e.origin !== window.location.origin || e.source !== popup) return;
    if (!e.data || e.data.type !== 'plex-access-complete') return;
    stopPopup(true);
    identify('message', 0);
  }

  function isPhone() { return /Mobi|Android/i.test(navigator.userAgent) || window.innerWidth < 768; }

  function startPlex() {
    if (busy) return;
    setError('');
    var phone = isPhone();
    // Opened inside the click, before any wait, so the browser allows it.
    var win = phone ? null : window.open('', 'PlexAccess', 'width=800,height=600');
    busy = true;
    send(API + '/pin').then(function (res) {
      busy = false;
      if (!res.ok || !res.data.pin_id || !res.data.auth_url) {
        if (win && !win.closed) win.close();
        fail(res);
        return;
      }
      pinId = res.data.pin_id;
      authUrl = res.data.auth_url;
      if (phone) {
        try { sessionStorage.setItem(PIN_KEY, String(pinId)); } catch (e) { /* the way back then says start again */ }
        location.assign(authUrl);
        return;
      }
      show('waiting');
      if (!win || win.closed) { setError(MSG.blocked); return; }
      win.location.href = authUrl;
      watch(win);
    });
  }

  function reopen() {
    if (!authUrl || pinId == null) { show('intro'); setError(MSG.expired); return; }
    setError('');
    var win = window.open(authUrl, 'PlexAccess', 'width=800,height=600');
    if (!win) { setError(MSG.blocked); return; }
    watch(win);
  }

  function identify(why, tries) {
    if (pinId == null) { show('intro'); setError(MSG.expired); return; }
    var id = pinId;
    send(API + '/identify', { pin_id: id }).then(function (res) {
      if (id !== pinId) return;              // a newer start, or the card was left
      if (res.status === 409) return;         // another call is finishing this PIN; its answer counts
      if (res.ok) { pinId = null; land(res.data); return; }
      if (res.status === 400 && res.detail === NOT_YET) {
        if (why === 'closed') { pinId = null; show('intro'); setError(MSG.closedEarly); return; }
        if (tries < RETRIES) { setTimeout(function () { identify(why, tries + 1); }, RETRY_MS); return; }
        pinId = null; show('intro'); setError(MSG.expired); return;
      }
      if (res.status === 400) { pinId = null; show('intro'); setError(res.detail || MSG.expired); return; }
      fail(res);
    });
  }

  // ---- After identify ----

  function land(d) {
    if (d.state === 'new') { fillForm(d); show('form'); return; }
    showStatus(d);
  }

  function fillForm(d) {
    var box = step('form');
    box.querySelector('[data-ra-username]').textContent = typeof d.username === 'string' ? d.username : '';
    var img = box.querySelector('[data-ra-avatar]');
    if (typeof d.avatar_url === 'string' && d.avatar_url) { img.src = d.avatar_url; img.hidden = false; }
    else { img.removeAttribute('src'); img.hidden = true; }
    $('raName').value = '';
    $('raNote').value = '';
    count();
  }

  function showStatus(d) {
    var box = step('status');
    var say = STATUS[d.state];
    box.setAttribute('data-state', say ? d.state : '');
    box.querySelector('[data-ra-status]').textContent = say ? say(d) : MSG.expired;
    box.querySelector('[data-ra-back]').textContent = d.state === 'member' ? 'Sign in' : 'Back to sign in';
    show('status');
  }

  function count() { $('raCount').textContent = $('raNote').value.length + '/' + NOTE_MAX; }

  function submit(e) {
    e.preventDefault();
    if (busy) return;
    var name = $('raName').value.trim();
    var note = $('raNote').value.trim();
    if (!name || !note) { setError(MSG.form); (name ? $('raNote') : $('raName')).focus(); return; }
    var button = step('form').querySelector('[data-ra-send]');
    busy = true;
    button.disabled = true;
    send(API, { name: name, note: note }).then(function (res) {
      busy = false;
      button.disabled = false;
      if (res.ok && res.data.sent) { show('sent'); return; }
      if (res.ok) { showStatus(res.data); return; }
      if (res.status === 503 && same(res.detail, FULL)) { showStatus({ state: 'full', detail: res.detail }); return; }
      if (res.status === 400) { show('intro'); setError(res.detail || MSG.expired); return; }
      fail(res);
    });
  }

  // ---- Wiring ----

  function wire() {
    wired = true;
    $('requestAccessLink').addEventListener('click', function (e) { e.preventDefault(); enter('intro'); });
    document.querySelector('[data-ra-plex]').addEventListener('click', startPlex);
    document.querySelector('[data-ra-reopen]').addEventListener('click', reopen);
    document.querySelector('[data-ra-cancel]').addEventListener('click', function () {
      stopPopup(true);
      pinId = null;
      show('intro');
    });
    var backs = document.querySelectorAll('[data-ra-back]');
    for (var i = 0; i < backs.length; i++) {
      backs[i].addEventListener('click', function () {
        backToSignIn(current === 'status' && step('status').getAttribute('data-state') === 'member');
      });
    }
    step('form').addEventListener('submit', submit);
    // An avatar Plex can't serve is left out rather than shown broken.
    step('form').querySelector('[data-ra-avatar]').addEventListener('error', function () { this.hidden = true; });
    $('raNote').addEventListener('input', count);
    window.addEventListener('message', onMessage);
    window.addEventListener('popstate', onPop);
  }

  // A phone back from Plex: /login?access_request=complete. Ignored while
  // the site takes no requests.
  function resume() {
    resumed = true;
    var params = new URLSearchParams(location.search);
    if (params.get('access_request') !== 'complete') {
      if (location.hash === HASH) show('intro');
      return;
    }
    var stored = null;
    try { stored = sessionStorage.getItem(PIN_KEY); sessionStorage.removeItem(PIN_KEY); } catch (e) { stored = null; }
    history.replaceState(null, '', location.pathname);
    enter('waiting');
    if (!stored || !/^[0-9]+$/.test(stored)) { show('intro'); setError(MSG.expired); return; }
    pinId = parseInt(stored, 10);
    identify('return', 0);
  }

  function apply(theme) {
    on = !!(theme && theme.auth_methods && theme.auth_methods.request_access);
    var row = $('requestAccessLinkRow');
    if (!row || !$('requestAccess')) return;
    if (current === 'signin') row.hidden = !on;
    if (!on) return;
    if (!wired) wire();
    if (!resumed) resume();
  }

  return { apply: apply };
})();
