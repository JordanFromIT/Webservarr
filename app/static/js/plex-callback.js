/**
 * WebServarr — Plex sign-in hand-back (/auth/plex-callback-page)
 *
 * Plex sends the sign-in popup back to this page. In the popup it tells the
 * login page that opened it and closes; opened as a redirect instead (phones),
 * it returns to the login page, which finishes the sign-in from there.
 *
 * The first thing in the page's <head>, ahead of every stylesheet: a pending
 * stylesheet holds back the classic scripts after it, and a slow one must
 * never keep the popup open. It needs no element of the page.
 *
 * The message is only for this origin: the login page that opened the popup
 * is on it, and so is this page (Plex returns to the app's own address).
 */
(function () {
  'use strict';
  if (window.opener) {
    window.opener.postMessage({ type: 'plex-auth-complete' }, window.location.origin);
    window.close();
  } else {
    window.location.href = '/login?plex_auth=complete';
  }
})();
