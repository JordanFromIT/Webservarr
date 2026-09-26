/**
 * Settings > Sign-in: which sign-in methods the login page offers, their
 * setup, who counts as an admin, and the local admin account.
 *
 * The server refuses a save that leaves no usable method (422, lockout guard;
 * its message lands on the switch). This tab also asks before a save turns
 * off, or breaks the setup of, the method the admin is signed in with.
 *
 * The account form talks to /api/admin/account on its own and never goes
 * through the kit: its passwords are never staged, stored, logged or shown,
 * and the fields are emptied after every try.
 */
(function () {
  'use strict';

  var el = WSSettings.el, icon = WSSettings.icon, cls = WSSettings.cls;
  // WS.user.auth_method -> the switch for that method.
  var FLAGS = { simple: 'features.show_simple_auth', plex: 'features.show_plex_auth',
                oidc: 'features.show_authentik_auth' };
  // The keys on this tab a save can take a method away with.
  var OWN_KEYS = { simple: ['features.show_simple_auth'], plex: ['features.show_plex_auth'],
                   oidc: ['features.show_authentik_auth', 'integration.authentik.url',
                          'integration.authentik.client_id'] };
  var NAMES = { simple: 'your username and password', plex: 'Plex', oidc: 'Authentik' };
  // Every key on this tab that decides whether a method works.
  var METHOD_KEYS = ['features.show_simple_auth', 'features.show_plex_auth', 'features.show_authentik_auth',
                     'integration.authentik.url', 'integration.authentik.client_id'];
  // The Authentik switch and the fields its setup group holds.
  var AK_KEYS = ['features.show_authentik_auth', 'integration.authentik.url', 'integration.authentik.app_slug',
                 'integration.authentik.client_id', 'integration.authentik.client_secret'];
  // Task 6.3's Plex card on Integrations. Until it exists, go() just opens the tab.
  var PLEX_CARD = 'integration-card-plex';

  var MSG = {
    needCurrent: 'Enter your current password first.',
    nothing: 'Enter a new username or a new password.',
    short: 'The new password needs at least 8 characters.',
    mismatch: 'The new passwords don’t match.',
    failed: 'The account wasn’t updated. Try again.',
    offline: 'The account wasn’t updated. Check your connection and try again.',
    forbidden: 'Only admins can change the admin account.',
    busy: 'That was a lot of tries in a row. Wait a minute, then try again.',
    unconfirmed: 'Couldn’t confirm the account was updated. Try signing in with the new details.'
  };

  // ---- Which methods work ----

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // Set up enough for the sign-in page to offer it (the server's rule; it
  // decides, this only shapes a warning and a hint). read: api.saved or api.get.
  function setUp(method, read) {
    if (method === 'plex') return !!read('integration.plex.url') && read('integration.plex.token') === WSSettings.MASK;
    if (method === 'oidc') return !!read('integration.authentik.url') && !!read('integration.authentik.client_id');
    return true;
  }

  function usable(method, read) { return read(FLAGS[method]) === 'true' && setUp(method, read); }

  // How this session signed in, when it is one of the three.
  function sessionMethod() {
    var user = (window.WS && WS.user) || {};
    return hasOwn(FLAGS, user.auth_method) ? user.auth_method : null;
  }

  // ---- Pieces ----

  function methodCard(iconName, title, description) {
    var root = el('section', 'rounded-2xl border border-frosted-blue/10 bg-frosted-blue/[0.04] p-5');
    var head = el('div', 'flex items-center gap-3 mb-4');
    head.appendChild(icon(iconName, 'text-[24px] text-frosted-blue/70'));
    var t = el('div', 'min-w-0');
    t.appendChild(el('h3', 'text-[17px] font-bold text-frosted-blue', title));
    t.appendChild(el('p', 'text-[13px] text-frosted-blue/70', description));
    head.appendChild(t);
    root.appendChild(head);
    var body = el('div', 'space-y-5');
    root.appendChild(body);
    return { root: root, body: body };
  }

  function note(text, actionLabel, onAction) {
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

  function openPlexSetup() {
    WSSettings.go('integrations', PLEX_CARD);
  }

  // ---- Local admin account ----

  // {status, data}: data is the parsed JSON object, or null when the body is
  // empty or not JSON (a proxy's error page, say). Status 0: no answer.
  function readBody(r) {
    return r.text().then(function (text) {
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      return { status: r.status, data: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
    }, function () { return { status: r.status, data: null }; });
  }

  function sendAccount(body) {
    return fetch('/api/admin/account', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(readBody, function () { return { status: 0, data: null }; });
  }

  // A plain sentence for a failed update, or null after sending an admin
  // whose session has ended to the sign-in page. Only a 400 carries words
  // meant for people (wrong password, name taken); nothing else is echoed.
  function accountFailure(res) {
    var s = res.status, d = res.data;
    if (s === 401) { WSSettings.leave('/login'); return null; }
    if (s === 400 && d && typeof d.detail === 'string' && d.detail) return d.detail;
    if (s === 0) return MSG.offline;
    if (s === 403) return MSG.forbidden;
    if (s === 429) return MSG.busy;
    return MSG.failed;
  }

  function accountForm() {
    var wrap = el('div', 'space-y-4 pt-2');
    var user = (window.WS && WS.user) || {};
    if (user.auth_method !== 'simple') {
      wrap.appendChild(el('p', 'text-[13px] text-frosted-blue/70',
        'To change the local admin account, sign in with its username and password.'));
      return wrap;
    }
    var heading = el('p', 'text-[15px] font-semibold text-frosted-blue', 'Local admin account');
    heading.id = 'signinAccountTitle';
    wrap.appendChild(heading);
    var form = el('form', 'space-y-4');
    form.noValidate = true;
    form.setAttribute('aria-labelledby', heading.id);

    // The account's own name, hidden, so a password manager knows whose
    // password this is and doesn't fill it into "New username".
    var who = el('input', 'hidden');
    who.type = 'text';
    who.autocomplete = 'username';
    who.readOnly = true;
    who.tabIndex = -1;
    who.setAttribute('aria-hidden', 'true');
    who.value = user.username || '';
    form.appendChild(who);

    function field(id, label, type, autocomplete, placeholder) {
      var box = el('div');
      var l = el('label', cls.label, label);
      l.htmlFor = id;
      var i = el('input', cls.input);
      i.id = id;
      i.type = type;
      i.autocomplete = autocomplete;
      i.spellcheck = false;
      if (placeholder) i.placeholder = placeholder;
      box.appendChild(l);
      box.appendChild(i);
      return { box: box, input: i };
    }
    var cur = field('signinCurrentPassword', 'Current password', 'password', 'current-password');
    var name = field('signinNewUsername', 'New username', 'text', 'off', 'Leave empty to keep it');
    var pw = field('signinNewPassword', 'New password', 'password', 'new-password', 'At least 8 characters');
    var pw2 = field('signinConfirmPassword', 'Confirm new password', 'password', 'new-password');
    name.input.setAttribute('autocapitalize', 'off');
    var grid = el('div', 'grid sm:grid-cols-2 gap-4');
    [cur, name, pw, pw2].forEach(function (f) { grid.appendChild(f.box); });
    form.appendChild(grid);

    var row = el('div', 'flex flex-wrap items-center gap-4');
    var btn = el('button', cls.btnGhost, 'Update account');
    btn.type = 'submit';
    // cls.error's look, on the button's line instead of under a field.
    var error = el('p', 'hidden text-[13px] font-semibold text-frosted-blue flex items-center gap-1.5');
    error.id = 'signinAccountError';
    error.setAttribute('role', 'alert');
    row.appendChild(btn);
    row.appendChild(error);
    form.appendChild(row);
    wrap.appendChild(form);

    function say(message) {
      error.textContent = '';
      if (message) {
        error.appendChild(icon('error', 'text-base'));
        error.appendChild(document.createTextNode(message));
      }
      error.classList.toggle('hidden', !message);
    }
    function clearPasswords() {
      cur.input.value = '';
      pw.input.value = '';
      pw2.input.value = '';
    }

    var sending = false;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (sending) return;
      var body = {
        current_password: cur.input.value,
        new_username: name.input.value.trim(),
        new_password: pw.input.value,
        new_password_confirm: pw2.input.value
      };
      // [message, field to focus]; the password fields are emptied either way.
      var problem = !body.current_password ? [MSG.needCurrent, cur]
        : !body.new_username && !body.new_password ? [MSG.nothing, name]
        : body.new_password && body.new_password.length < 8 ? [MSG.short, cur]
        : body.new_password !== body.new_password_confirm ? [MSG.mismatch, cur]
        : null;
      if (problem) {
        clearPasswords();
        body = null;
        say(problem[0]);
        problem[1].input.focus();
        return;
      }
      sending = true;
      btn.disabled = true;
      form.setAttribute('aria-busy', 'true');
      say('');
      // What was sent, not what the box holds when the answer lands.
      var sentName = body.new_username;
      sendAccount(body).then(function (res) {
        clearPasswords();
        body = null;
        sending = false;
        btn.disabled = false;
        form.removeAttribute('aria-busy');
        if (res.status === 200 && res.data && res.data.success === true) {
          if (sentName && Array.isArray(res.data.updated) && res.data.updated.indexOf('username') >= 0) {
            who.value = sentName;
          }
          name.input.value = '';
          WSSettings.toast('Account updated', 'ok');
          return;
        }
        var message = res.status === 200 ? MSG.unconfirmed : accountFailure(res);
        if (!message) return;
        say(message);
        cur.input.focus();
      });
    });
    return wrap;
  }

  // ---- The tab ----

  WSSettings.registerTab('sign-in', {
    mount: function (panel, api) {
      var intro = WSSettings.card('Sign-in methods',
        'Choose how people sign in. Keep at least one method on and set up, or nobody will be able to sign in.');

      // Plex
      var plex = methodCard('play_circle', 'Plex', 'People sign in with their Plex account.');
      plex.body.appendChild(api.toggle({ key: 'features.show_plex_auth', label: 'Allow sign-in with Plex' }));
      var plexHint = note('Plex sign-in needs the Plex connection.', 'Set it up in Integrations', openPlexSetup);
      function syncPlexHint() { plexHint.classList.toggle('hidden', setUp('plex', api.saved)); }
      // Integrations may set the connection up while this tab stays mounted.
      document.addEventListener('ws-settings:saved', syncPlexHint);
      syncPlexHint();
      plex.body.appendChild(plexHint);
      intro.body.appendChild(plex.root);

      // Authentik
      var ak = methodCard('shield', 'Authentik', 'People sign in through your Authentik server.');
      ak.body.appendChild(api.toggle({ key: 'features.show_authentik_auth', label: 'Allow sign-in with Authentik' }));
      var akFields = el('div', 'grid sm:grid-cols-2 gap-5');
      akFields.appendChild(api.text({ key: 'integration.authentik.url', label: 'Authentik address', inputType: 'url',
        placeholder: 'https://auth.example.com' }));
      akFields.appendChild(api.text({ key: 'integration.authentik.app_slug', label: 'Application slug',
        help: 'Used to sign people out of Authentik too.' }));
      akFields.appendChild(api.text({ key: 'integration.authentik.client_id', label: 'Client ID' }));
      akFields.appendChild(api.secret({ key: 'integration.authentik.client_secret', label: 'Client secret' }));
      ak.body.appendChild(akFields);
      // Shown while Authentik is on or has an address, and never hidden while
      // a field in it holds a change (a 422 lands there) or has focus.
      function syncAk() {
        var dirty = api.dirtyKeys();
        var open = api.get('features.show_authentik_auth') === 'true' || !!api.get('integration.authentik.url') ||
          AK_KEYS.some(function (k) { return dirty.indexOf(k) >= 0; }) || akFields.contains(document.activeElement);
        akFields.classList.toggle('hidden', !open);
      }
      AK_KEYS.forEach(function (k) { api.onChange(k, syncAk); });
      syncAk();
      intro.body.appendChild(ak.root);

      // Username & password
      var simple = methodCard('password', 'Username & password', 'Sign in with the local admin account.');
      simple.body.appendChild(api.toggle({ key: 'features.show_simple_auth', label: 'Allow sign-in with a username and password' }));
      var account = accountForm();
      simple.body.appendChild(account);
      // Follows the saved switch, not a staged one, so the form (and its
      // message) can't vanish mid-use; a save of the switch updates it.
      function syncSimple() { account.classList.toggle('hidden', api.saved('features.show_simple_auth') !== 'true'); }
      api.onSaved(syncSimple);
      syncSimple();
      intro.body.appendChild(simple.root);

      var allOff = note('No sign-in method is on and set up. The server won’t save this, so turn one on and set it up.');
      // On and set up, by the same rule as the warning below: a switch that's
      // on without its connection counts for nothing.
      function syncAll() {
        var on = Object.keys(FLAGS).some(function (m) { return usable(m, api.get); });
        allOff.classList.toggle('hidden', on);
      }
      METHOD_KEYS.forEach(function (k) { api.onChange(k, syncAll); });
      // The Plex connection is saved on Integrations.
      document.addEventListener('ws-settings:saved', syncAll);
      syncAll();
      intro.body.appendChild(allOff);
      panel.appendChild(intro.root);

      var admin = WSSettings.card('Admin access', 'Who can open Settings.');
      admin.body.appendChild(api.text({ key: 'system.admin_email', label: 'Admin email', inputType: 'email',
        placeholder: 'you@example.com',
        help: 'Anyone who signs in with this email address becomes an admin. The Plex server owner is always an admin.' }));
      panel.appendChild(admin.root);

      // Before a save that would stop the admin's own method working: ask.
      // "Keep it on" puts that method's keys back and saves nothing, so the
      // rest of the changes stay for another look.
      api.beforeSave(function (keys) {
        var mine = sessionMethod();
        if (!mine) return true;
        var touched = OWN_KEYS[mine].filter(function (k) { return keys.indexOf(k) >= 0; });
        if (!touched.length || !usable(mine, api.saved) || usable(mine, api.get)) return true;
        return WSSettings.confirm({
          title: 'Turn off the way you signed in?',
          body: 'You signed in with ' + NAMES[mine] + '. After this change it won’t work, so next time ' +
            'you’ll need another way to sign in. You stay signed in for now.',
          confirmLabel: 'Turn it off', cancelLabel: 'Keep it on', danger: true
        }).then(function (ok) {
          if (!ok) touched.forEach(function (k) { api.set(k, api.saved(k)); });
          return ok;
        });
      });
    }
  });
})();
