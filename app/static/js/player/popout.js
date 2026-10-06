/**
 * WebServarr — Pop out: the desktop player in a window of its own
 * (ES module, document-lifetime)
 *
 * The desktop player window (ui.js, WS.playerUI) has a Pop out button. What
 * it does is decided when it is pressed, from what the browser offers, so a
 * browser that gains always-on-top windows later gets them unchanged:
 *
 *   Document Picture-in-Picture (Chrome, Edge): a small window above every
 *   other app, holding the same player, moved into it (ui.dock: the same
 *   nodes, so every control, panel and prompt goes with it). The audio stays
 *   in this tab, so nothing restarts. Closing that window brings the player
 *   back to the top bar; closing this tab closes it too, and the engine's
 *   own leave saves the place, as on any leave.
 *
 *   Elsewhere (Firefox, Safari): an ordinary small window on this site's
 *   /player/remote page, a remote control (js/player-remote.js). This tab keeps the
 *   audio; the two talk over a BroadcastChannel named for this pop out only.
 *   The remote asks every PROBE_MS and this tab answers with the player's
 *   state (and sends it on every change); a message handler runs even in a
 *   background tab, so a quiet tab is not taken for a closed one. When this
 *   tab goes it says so ('bye'); when the remote goes, the pill comes back.
 *
 * No Pop out on phones: the window, and so its button, is desktop only.
 * Theme variables only (theme.css "Pop out"); nothing here writes HTML.
 *
 * Pure (importable by Node, no DOM at import time):
 *   remoteState(state, skipS)  what the remote is sent: the book, the chapter
 *                              as a span of book time, the time, play state
 *   createPopOut(env)          the pop out, given its surroundings (tests)
 *   boot(win, overrides)       wires it to WS.playerUI as WS.playerPopOut
 */

export const CHANNEL = 'ws-player-remote:';   // + the pop out's own id
export const REMOTE_URL = '/player/remote';
export const PUSH_MS = 250;            // state changes go at most this often
export const WATCH_MS = 1000;          // the remote window closed? checked this often
export const REMOTE_W = 380;
export const REMOTE_H = 320;
export const ID_RE = /^[a-z0-9]{12,40}$/;

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/* The current chapter as a span of book time (ui.js chapterSpan's rule),
   the whole book when it has none. */
function span(s) {
  const dur = num(s.bookDurationMs);
  const list = Array.isArray(s.chapters) ? s.chapters : [];
  const i = num(s.chapterIndex);
  const c = list.length && i >= 0 && i < list.length ? list[i] : null;
  if (!c) return { label: '', start: 0, end: dur };
  const start = num(c.start_ms);
  let end = num(c.end_ms);
  if (!(end > start)) end = i + 1 < list.length ? num(list[i + 1].start_ms) : dur;
  return { label: String(c.label || ''), start: start, end: Math.max(start, end) };
}

export function remoteState(s, skipS) {
  s = s || {};
  if (!s.book) return { book: null, loading: !!s.loading };
  const c = span(s);
  return {
    book: String(s.book),
    title: String(s.title || ''),
    author: String(s.author || ''),
    cover: String(s.cover || ''),
    chapter: c.label,
    start: c.start,
    end: c.end,
    at: num(s.bookMs),
    duration: num(s.bookDurationMs),
    playing: !!s.playing,
    busy: !!((s.loading && s.playing) || s.checking),
    held: !!(s.filesChanged || s.safetyNet),
    skip: num(skipS) || 10
  };
}

/* env: { ui (WS.playerUI), player (WS.player), win, doc, setTimeout,
   clearTimeout, pip (documentPictureInPicture, or none), openWindow(url,
   name, features) -> window | null, BroadcastChannel (or none), randomId()
   }. */
export function createPopOut(env) {
  const ui = env.ui;
  const player = env.player;
  const doc = env.doc;
  const win = env.win;
  const setT = env.setTimeout;
  const clearT = env.clearTimeout;
  let active = null;           // { kind: 'docked' | 'remote', stop() }

  function logError(e) {
    console.error('[player] pop out failed', e);
  }

  function skipS() {
    try {
      return num(player.setSkip()) || 10;
    } catch (e) {
      return 10;
    }
  }

  // ---- Picture-in-Picture ----

  // The page's look, in the new document: its stylesheets (the theme's
  // colours and the icon font with them), the <html> marks, the body's
  // classes. data-shell="hidden" there: no tab bar to make room for.
  function dressUp(pdoc) {
    const from = doc.documentElement;
    const to = pdoc.documentElement;
    Array.prototype.forEach.call(from.attributes, function (a) {
      if (a.name !== 'data-player-full') to.setAttribute(a.name, a.value);
    });
    to.setAttribute('data-shell', 'hidden');
    Array.prototype.forEach.call(doc.querySelectorAll('head link[rel="stylesheet"], head style'), function (n) {
      pdoc.head.appendChild(pdoc.importNode(n, true));
    });
    pdoc.title = doc.title;
    pdoc.body.className = doc.body.className + ' wsp-pip-body';
  }

  function pip(api) {
    const size = ui.windowRect();
    let req;
    try {
      // Called in the press itself: the browser only opens one for a gesture.
      req = api.requestWindow({ width: size.w, height: size.h });
    } catch (e) {
      req = Promise.reject(e);
    }
    Promise.resolve(req).then(function (pw) {
      let over = false;
      function end() {
        if (over) return;
        over = true;
        if (active && active.win === pw) active = null;
        try {
          pw.close();
        } catch (e) { /* gone */ }
      }
      if (!ui.isWindow() || !player.state().book) {
        end();
        return;
      }
      dressUp(pw.document);
      if (!ui.dock(pw.document, end)) {
        end();
        return;
      }
      active = { kind: 'docked', win: pw, stop: end };
      // Its own close (or Back to tab): the player goes back to the pill.
      pw.addEventListener('pagehide', function () {
        over = true;
        if (active && active.win === pw) active = null;
        ui.undock(false);
      });
    }, function (e) {
      logError(e);
      ui.notify("The player couldn't open in its own window. Try Pop out again.", { tone: 'err', id: 'popout' });
    });
  }

  // ---- The remote window ----

  function remote() {
    const BC = env.BroadcastChannel;
    if (typeof BC !== 'function') {
      ui.notify("This browser can't pop the player out.", { tone: 'err', id: 'popout' });
      return;
    }
    const id = env.randomId();
    let w = null;
    try {
      w = env.openWindow(REMOTE_URL + '#' + id, 'wsPlayerRemote' + id,
        'popup,width=' + REMOTE_W + ',height=' + REMOTE_H);
    } catch (e) {
      w = null;
    }
    if (!w) {
      ui.notify('Pop-ups are blocked for this site, so the player stayed here. Allow pop-ups, then try again.', { tone: 'err', id: 'popout' });
      return;
    }
    let ch;
    try {
      ch = new BC(CHANNEL + id);
    } catch (e) {
      try {
        w.close();
      } catch (err) { /* gone */ }
      logError(e);
      return;
    }
    let pushTimer = null;
    let watchTimer = null;
    let done = false;
    const offs = [];

    function post(m) {
      try {
        ch.postMessage(m);
      } catch (e) { /* closed */ }
    }
    function send() {
      pushTimer = null;
      post({ type: 'state', state: remoteState(player.state(), skipS()) });
    }
    function soon() {
      if (pushTimer === null) pushTimer = setT(send, PUSH_MS);
    }

    // The pop out is over: from here (bringBack, the book closed) or there.
    function stop(why) {
      if (done) return;
      done = true;
      if (active === entry) active = null;
      if (pushTimer !== null) clearT(pushTimer);
      if (watchTimer !== null) clearT(watchTimer);
      offs.forEach(function (off) {
        try {
          off();
        } catch (e) { /* gone */ }
      });
      if (why !== 'remote') post({ type: why === 'leave' ? 'bye' : 'end' });
      try {
        ch.close();
      } catch (e) { /* closed */ }
      if (why !== 'here') ui.setPopped(null);
      if (why === 'here' || why === 'book') {
        try {
          w.close();
        } catch (e) { /* not ours to close any more */ }
      }
    }
    const entry = { kind: 'remote', win: w, stop: function () { stop('here'); } };
    active = entry;

    ch.onmessage = function (e) {
      const m = e && e.data;
      if (!m || typeof m !== 'object' || done) return;
      if (m.type === 'hello' || m.type === 'probe') {
        send();
      } else if (m.type === 'bye') {
        stop('remote');
      } else if (m.type === 'cmd') {
        command(m);
        soon();
      }
    };

    function command(m) {
      const s = player.state();
      if (!s.book) return;
      if (m.cmd === 'toggle') {
        // Held (a question waits in the player): the player comes back here
        // to ask it, as the pill's Play opens it.
        if (s.safetyNet || (s.filesChanged && !s.playing && !s.checking)) {
          stop('here');
          ui.open();
          return;
        }
        Promise.resolve(player.toggle()).catch(logError);
      } else if (m.cmd === 'skip') {
        const dir = num(m.value) < 0 ? -1 : 1;
        player.skip(dir * skipS());
      } else if (m.cmd === 'seek') {
        const at = num(m.value);
        if (at >= 0 && at <= num(s.bookDurationMs)) player.seek(at);
      }
    }

    offs.push(player.on('change', function (d) {
      const s = d && d.state ? d.state : player.state();
      if (!s.book && !s.loading) {
        stop('book');
        return;
      }
      soon();
    }));
    const onLeave = function () { stop('leave'); };
    win.addEventListener('pagehide', onLeave);
    offs.push(function () { win.removeEventListener('pagehide', onLeave); });

    // The remote window closed without a word (a crash, a forced close).
    (function watch() {
      watchTimer = setT(function () {
        watchTimer = null;
        let gone = true;
        try {
          gone = !!w.closed;
        } catch (e) { /* gone */ }
        if (gone) stop('remote');
        else if (!done) watch();
      }, WATCH_MS);
    })();

    ui.setPopped(function () { stop('here'); });
  }

  // ---- Pop out ----

  function pop() {
    const s = player.state();
    if (!s || !s.book || active) return;
    const api = env.pip;
    if (api && typeof api.requestWindow === 'function') pip(api);
    else remote();
  }

  ui.popOut(pop);

  return {
    pop: pop,
    active: function () { return active ? active.kind : null; },
    end: function () {
      if (active) active.stop();
    }
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function randomId(win) {
  const a = new Uint8Array(12);
  try {
    win.crypto.getRandomValues(a);
  } catch (e) {
    for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
}

/* Wires Pop out to the player's window, once per document, as
   WS.playerPopOut. Returns it, or null on a page without the player. */
export function boot(win, overrides) {
  const WS = win.WS || (win.WS = {});
  if (WS.playerPopOut) return WS.playerPopOut;
  const ui = (overrides && overrides.ui) || WS.playerUI;
  const player = (overrides && overrides.player) || WS.player;
  if (!ui || !player || typeof ui.popOut !== 'function') return null;
  const po = createPopOut(Object.assign({
    ui: ui,
    player: player,
    win: win,
    doc: win.document,
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    pip: win.documentPictureInPicture || null,
    openWindow: function (url, name, features) { return win.open(url, name, features); },
    BroadcastChannel: typeof win.BroadcastChannel === 'function' ? win.BroadcastChannel : null,
    randomId: function () { return randomId(win); }
  }, overrides || {}));
  WS.playerPopOut = po;
  return po;
}

if (typeof window !== 'undefined' && window.document) boot(window);
