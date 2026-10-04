/*
 * Books: getting this browser a Kavita session without ever going in circles.
 *
 * The Books page (when its answer says this person is not connected) and the
 * reader (a 401 from WebServarr's Kavita proxy) need this session to have a
 * Kavita sign-in, and the only way to get one is a full-page trip through
 * /kavita/connect, which comes back to /books. Done blindly every time, a sign-in that fails - or one
 * that "works" but still leaves Kavita saying no - becomes a loop: the page
 * flashes until the rate limit answers with raw JSON.
 *
 * So the pages ask here instead:
 *   - at most one automatic attempt a minute (the time is kept in
 *     sessionStorage, so it survives the round trip);
 *   - none at all after a sign-in reported failure (/books?kavita=error);
 *   - otherwise the page shows a plain message with a "Try again" button.
 * If storage can't be read, the answer is the message: never a loop.
 *
 * A page helper (data-ws-page-script): it loads once per document and only
 * defines window.WSKavita. Both pages are soft-navigation page modules, so
 * one document can hold many visits; each module calls init() from mount,
 * which starts the visit's own "problem showing" and "under way" state. The
 * trip to /kavita/connect is a full navigation through the router when it is
 * there (ws:before-hard-nav first, so a player can save its place).
 */
(function () {
  'use strict';

  var CONNECT_URL = '/kavita/connect';
  var LAST_TRY_KEY = 'ws:kavita-connect-at';
  var RETRY_WINDOW_MS = 60 * 1000;

  var blocked = false;   // the problem is showing; no automatic attempt this visit
  var leaving = false;   // an attempt is under way; later 401s just wait for it

  /** A new visit to Books or the reader (the page module's mount). */
  function init() {
    blocked = false;
    leaving = false;
  }

  /** Off to the sign-in: a full navigation, never a soft one (it leaves the site). */
  function leave() {
    leaving = true;
    var router = window.WS && window.WS.router;
    if (router && typeof router.hardNavigate === 'function') router.hardNavigate(CONNECT_URL);
    else window.location.href = CONNECT_URL;
  }

  function triedRecently() {
    try {
      var last = Number(sessionStorage.getItem(LAST_TRY_KEY)) || 0;
      return last > 0 && Date.now() - last < RETRY_WINDOW_MS;
    } catch (e) {
      return true;
    }
  }

  /** Record an attempt. False when it can't be recorded (then don't make one). */
  function markTry() {
    try {
      sessionStorage.setItem(LAST_TRY_KEY, String(Date.now()));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Read once, as the page mounts: did the sign-in just fail? If so, drop the
   * flag from the address (a reload or a shared link should not repeat it)
   * and make no automatic attempt on this visit.
   */
  function arrivedFromFailedConnect() {
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return false; }
    if (params.get('kavita') !== 'error') return false;
    params.delete('kavita');
    var query = params.toString();
    try {
      history.replaceState(history.state, '', location.pathname + (query ? '?' + query : '') + location.hash);
    } catch (e) { /* the message still shows; only the address keeps the flag */ }
    blocked = true;
    return true;
  }

  /**
   * A proxied call came back 401. Go and sign in to Kavita, unless that was
   * just tried (or failed) - then call onProblem() so the page can say so.
   */
  function reconnect(onProblem) {
    if (leaving) return;
    if (blocked || triedRecently() || !markTry()) {
      blocked = true;
      onProblem();
      return;
    }
    leave();
  }

  /** The "Try again" button. Counts as an attempt, so a still-broken sign-in shows the message again. */
  function retry() {
    markTry();
    leave();
  }

  window.WSKavita = { init: init, reconnect: reconnect, retry: retry, arrivedFromFailedConnect: arrivedFromFailedConnect };
})();
