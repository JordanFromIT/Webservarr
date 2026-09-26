/**
 * Settings: the one copy of "which sign-in methods work", and the question
 * asked before a save stops the method the admin is signed in with.
 * (WSSettings.ownSignIn; needs kit.js first.)
 *
 * Two tabs hold keys a method depends on: Sign-in (the switches, Authentik's
 * address and client ID) and Integrations (Plex's address and token). Both
 * register the same guard with the keys they own, so the rule and the dialog
 * live here once. The server's lockout guard still refuses a save that leaves
 * no usable method at all; this only asks first about the admin's own one.
 *
 * Loaded with the kit rather than with a tab, because tab modules load the
 * first time their tab opens, in any order.
 */
(function () {
  'use strict';

  // WS.user.auth_method -> the switch for that method.
  var FLAGS = { simple: 'features.show_simple_auth', plex: 'features.show_plex_auth',
                oidc: 'features.show_authentik_auth' };
  var NAMES = { simple: 'your username and password', plex: 'Plex', oidc: 'Authentik' };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // Set up enough for the sign-in page to offer it: the server's rule
  // (usable_sign_in_methods); it decides, this only shapes a warning and a
  // hint. read: api.saved or api.get. A token is set up when it holds
  // anything: the saved one (the mask) or one typed to replace it.
  function setUp(method, read) {
    if (method === 'plex') return !!read('integration.plex.url') && !!read('integration.plex.token');
    if (method === 'oidc') return !!read('integration.authentik.url') && !!read('integration.authentik.client_id');
    return true;
  }

  function usable(method, read) { return read(FLAGS[method]) === 'true' && setUp(method, read); }

  // How this session signed in, when it is one of the three.
  function sessionMethod() {
    var user = (window.WS && WS.user) || {};
    return hasOwn(FLAGS, user.auth_method) ? user.auth_method : null;
  }

  // Before a save of this tab that touches keysByMethod[the admin's method]:
  // ask when it would stop that method working. opts.askOnChange also asks
  // when those keys only change, since a new address or token may not work
  // (Integrations' Plex card). The cancel answer puts those keys back and
  // saves nothing, so the rest of the changes stay for another look.
  function guard(api, keysByMethod, opts) {
    opts = opts || {};
    api.beforeSave(function (keys) {
      var mine = sessionMethod();
      if (!mine || !hasOwn(keysByMethod, mine)) return true;
      var touched = keysByMethod[mine].filter(function (k) { return keys.indexOf(k) >= 0; });
      if (!touched.length || !usable(mine, api.saved)) return true;
      var breaks = !usable(mine, api.get);
      if (!breaks && !opts.askOnChange) return true;
      var ask = breaks ? {
        title: 'Turn off the way you signed in?',
        body: 'You signed in with ' + NAMES[mine] + '. After this change it won’t work, so next time ' +
          'you’ll need another way to sign in. You stay signed in for now.',
        confirmLabel: 'Turn it off', cancelLabel: 'Keep it on', danger: true
      } : {
        title: 'Change how ' + NAMES[mine] + ' sign-in connects?',
        body: 'You signed in with ' + NAMES[mine] + '. If the new details are wrong, signing in with ' +
          NAMES[mine] + ' stops working, so next time you’ll need another way to sign in. ' +
          'You stay signed in for now.',
        confirmLabel: 'Save the change', cancelLabel: 'Keep the old one', danger: true
      };
      return WSSettings.confirm(ask).then(function (ok) {
        if (!ok) touched.forEach(function (k) { api.set(k, api.saved(k)); });
        return ok;
      });
    });
  }

  WSSettings.ownSignIn = { FLAGS: FLAGS, NAMES: NAMES, setUp: setUp, usable: usable,
                           sessionMethod: sessionMethod, guard: guard };
})();
