/**
 * WebServarr — the player's remote window (/player/remote; ES module)
 *
 * Pop out (popout.js) opens this page in a small window of its own where the
 * browser has no always-on-top window for pages (Firefox, Safari). It is a
 * remote control: the tab that opened it keeps the audio, and the two talk
 * over a BroadcastChannel named by this window's address (#<id>), so only
 * that tab answers. Nothing here plays, saves or fetches while it is a
 * remote.
 *
 * It asks every PROBE_MS ("probe") and the tab answers with the player's
 * state, as it also does on every change. No answer for GONE_MS, or the
 * tab's own 'bye' as it closes, means the tab is gone: playback stopped
 * there and its place was saved by its leave. The window then offers Play
 * here, which loads the player into this window (the same modules the shell
 * loads, in the same order, from the content-stamped addresses this page
 * carries) and opens the book where the listener left off: the newest of
 * the saved places, as any open. 'end' from the tab (the book closed there,
 * or the player came back into the page) closes this window.
 *
 * Words name the site as the operator calls it (the #ws-data branding).
 * Theme variables only (theme.css "Pop out"); text through textContent only.
 *
 * Pure (importable by Node, no DOM at import time):
 *   createRemote(env)   the remote, given its surroundings (tests)
 *   boot(win, overrides)
 */

export const CHANNEL = 'ws-player-remote:';   // as popout.js
export const PROBE_MS = 700;
export const GONE_MS = 2000;
const ID_RE = /^[a-z0-9]{12,40}$/;

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatClock(ms) {
  const t = Math.max(0, Math.floor(num(ms) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

/* env: { doc, root (the page's #wsRemote), id (from the address), siteName,
   BroadcastChannel, setTimeout, clearTimeout, now(), closeWindow(),
   loadPlayer() -> Promise<{ player, ui }> }. */
export function createRemote(env) {
  const doc = env.doc;
  const root = env.root;
  const setT = env.setTimeout;
  const clearT = env.clearTimeout;
  const now = env.now || Date.now;
  const site = env.siteName ? String(env.siteName) : '';
  const tabName = site ? 'your ' + site + ' tab' : 'the tab that opened it';

  function h(tag, props, kids) {
    const n = doc.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (kids) kids.forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function icon(name, cls) {
    return h('span', { class: 'material-symbols-outlined' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', text: name });
  }
  function setText(el, v) {
    const t = v == null ? '' : String(v);
    if (el.textContent !== t) el.textContent = t;
  }
  function setAttr(el, k, v) {
    if (v === null) {
      if (el.hasAttribute(k)) el.removeAttribute(k);
    } else if (el.getAttribute(k) !== v) {
      el.setAttribute(k, v);
    }
  }

  // ---- What it shows ----

  const img = h('img', { alt: '', decoding: 'async', hidden: true });
  const mark = icon('headphones', 'wsp-art-mark');
  img.addEventListener('load', function () { if (img.getAttribute('src')) { img.hidden = false; mark.hidden = true; } });
  img.addEventListener('error', function () { img.hidden = true; mark.hidden = false; });
  const title = h('h1', { class: 'wsr-title wsp-skel', text: '' });
  const chapter = h('p', { class: 'wsr-chapter' });
  const range = h('input', { type: 'range', class: 'wsp-range', min: '0', max: '1', step: '1', value: '0', 'aria-label': 'Position in this chapter', disabled: true });
  const elapsed = h('span', { class: 'wsp-time' });
  const remaining = h('span', { class: 'wsp-time' });
  const backN = h('span', { class: 'wsp-skip-n' });
  const fwdN = h('span', { class: 'wsp-skip-n' });
  const back = h('button', { type: 'button', class: 'wsp-skip', 'aria-label': 'Back 10 seconds', disabled: true }, [icon('replay'), backN]);
  const fwd = h('button', { type: 'button', class: 'wsp-skip', 'aria-label': 'Forward 10 seconds', disabled: true }, [icon('replay', 'wsp-mirror'), fwdN]);
  const play = h('button', { type: 'button', class: 'wsp-play wsr-play', 'aria-label': 'Play', disabled: true }, [icon('play_arrow')]);
  const status = h('p', { class: 'wsr-status', role: 'status' }, [
    h('span', { class: 'ws-light ws-light-unconfigured', 'aria-hidden': 'true' }),
    h('span', { text: 'Connecting to ' + tabName })
  ]);
  const card = h('section', { class: 'wsr-card', 'aria-label': 'Player remote' }, [
    h('div', { class: 'wsr-hero' }, [h('span', { class: 'wsp-art wsr-art' }, [mark, img]), h('div', { class: 'wsr-text' }, [title, chapter])]),
    h('div', { class: 'wsr-scrub' }, [range, h('div', { class: 'wsp-times' }, [elapsed, remaining])]),
    h('div', { class: 'wsp-controls wsr-controls' }, [back, play, fwd]),
    status
  ]);
  const goneText = h('p', { class: 'wsr-gone-text' });
  const hereBtn = h('button', { type: 'button', class: 'wsr-btn is-primary' }, [icon('play_arrow', 'wsr-btn-icon'), h('span', { text: 'Play here' })]);
  const closeBtn = h('button', { type: 'button', class: 'wsr-btn', text: 'Close' });
  const gone = h('section', { class: 'wsr-gone', hidden: true, 'aria-labelledby': 'wsrGone' }, [
    h('h1', { class: 'sr-only', id: 'wsrGone', text: 'Player remote' }),
    goneText,
    h('div', { class: 'wsr-gone-actions' }, [hereBtn, closeBtn])
  ]);
  root.textContent = '';
  root.appendChild(card);
  root.appendChild(gone);

  // ---- Talking to the tab ----

  let ch = null;
  let last = null;            // the last state the tab sent
  let heard = null;           // when it last spoke
  let probeTimer = null;
  let over = false;           // the tab is gone (or never answered)
  let scrubbing = false;

  function post(m) {
    if (!ch) return;
    try {
      ch.postMessage(m);
    } catch (e) { /* closed */ }
  }

  function draw(st) {
    last = st;
    if (!st || !st.book) return;
    setText(title, st.title);
    title.classList.remove('wsp-skel');
    setText(chapter, st.chapter);
    if (img.getAttribute('src') !== (st.cover || null)) {
      img.hidden = true;
      mark.hidden = false;
      if (st.cover) img.setAttribute('src', st.cover);
      else img.removeAttribute('src');
    }
    const len = Math.max(0, num(st.end) - num(st.start));
    const at = Math.min(len, Math.max(0, num(st.at) - num(st.start)));
    if (!scrubbing) {
      setAttr(range, 'max', String(Math.max(1, Math.round(len / 1000))));
      const v = String(Math.floor(at / 1000));
      if (range.value !== v) range.value = v;
      range.style.setProperty('--wsp-p', (len ? (at / len) * 100 : 0).toFixed(2) + '%');
      setText(elapsed, formatClock(at));
      setText(remaining, '−' + formatClock(len - at));
      setAttr(range, 'aria-valuetext', formatClock(at) + ' of ' + formatClock(len));
    }
    const n = num(st.skip) || 10;
    setText(backN, n);
    setText(fwdN, n);
    setAttr(back, 'aria-label', 'Back ' + n + ' seconds');
    setAttr(fwd, 'aria-label', 'Forward ' + n + ' seconds');
    const ic = play.firstChild;
    setText(ic, st.busy ? 'progress_activity' : st.playing ? 'pause' : 'play_arrow');
    ic.classList.toggle('wsp-spin', !!st.busy);
    setAttr(play, 'aria-label', st.busy ? 'Loading' : st.playing ? 'Pause' : 'Play');
    [range, back, fwd, play].forEach(function (b) { b.disabled = false; });
    setText(status.lastChild, 'Connected to ' + tabName);
    status.firstChild.className = 'ws-light ws-light-ok';
  }

  function goneNow() {
    if (over) return;
    over = true;
    if (probeTimer !== null) clearT(probeTimer);
    probeTimer = null;
    try {
      if (ch) ch.close();
    } catch (e) { /* closed */ }
    ch = null;
    const st = last && last.book ? last : null;
    if (st) {
      setText(goneText, 'Your ' + (site ? site + ' tab' : 'player tab') + ' was closed, so playback stopped at ' +
        formatClock(st.at) + '. Your place is saved.');
    } else {
      setText(goneText, 'This window plays from ' + tabName + ', and it is not open. Open it, then use Pop out there.');
    }
    hereBtn.hidden = !st || !!st.held;
    card.hidden = true;
    gone.hidden = false;
    const f = hereBtn.hidden ? closeBtn : hereBtn;
    try {
      f.focus({ preventScroll: true });
    } catch (e) { /* not focusable */ }
  }

  function probe() {
    probeTimer = null;
    if (over) return;
    const since = heard === null ? null : now() - heard;
    if ((heard === null && now() - started >= GONE_MS) || (since !== null && since >= GONE_MS)) {
      goneNow();
      return;
    }
    post({ type: 'probe' });
    probeTimer = setT(probe, PROBE_MS);
  }

  const started = now();
  if (!ID_RE.test(String(env.id || '')) || typeof env.BroadcastChannel !== 'function') {
    goneNow();
  } else {
    try {
      ch = new env.BroadcastChannel(CHANNEL + env.id);
      ch.onmessage = function (e) {
        const m = e && e.data;
        if (!m || typeof m !== 'object' || over) return;
        heard = now();
        if (m.type === 'state') draw(m.state);
        else if (m.type === 'bye') goneNow();
        else if (m.type === 'end') env.closeWindow();
      };
      post({ type: 'hello' });
      probeTimer = setT(probe, PROBE_MS);
    } catch (e) {
      goneNow();
    }
  }

  // ---- Its controls ----

  function cmd(c, value) {
    post({ type: 'cmd', cmd: c, value: value });
  }
  play.addEventListener('click', function () { cmd('toggle'); });
  back.addEventListener('click', function () { cmd('skip', -1); });
  fwd.addEventListener('click', function () { cmd('skip', 1); });
  range.addEventListener('input', function () {
    scrubbing = true;
    const ms = Number(range.value) * 1000;
    setText(elapsed, formatClock(ms));
  });
  range.addEventListener('change', function () {
    scrubbing = false;
    if (last && last.book) cmd('seek', num(last.start) + Number(range.value) * 1000);
  });
  range.addEventListener('keydown', function (e) {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (!e.repeat) cmd('skip', step);
  });
  closeBtn.addEventListener('click', function () { env.closeWindow(); });

  // Play here: the player itself, in this window, from the saved place.
  let starting = false;
  hereBtn.addEventListener('click', function () {
    const st = last;
    if (starting || !st || !st.book) return;
    starting = true;
    hereBtn.setAttribute('aria-disabled', 'true');
    setText(goneText, 'Starting the book here.');
    Promise.resolve(env.loadPlayer()).then(function (p) {
      const off = p.player.on('change', function () {
        if (p.ui.open()) off();
      });
      return p.player.open(st.book, { autoplay: true });
    }).then(function () {
      gone.hidden = true;
    }, function (e) {
      console.error('[player] the remote could not start the player', e);
      starting = false;
      hereBtn.removeAttribute('aria-disabled');
      setText(goneText, "The player couldn't start in this window. Close it and open the book from Books.");
    });
  });

  return {
    state: function () { return last; },
    gone: function () { return over; },
    // This window is going: the tab is told, so its pill comes back.
    leave: function () {
      post({ type: 'bye' });
    }
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

// The player's modules, one after another (each runs once the one before it
// has): the shell's own order and addresses, read from this page.
function loadPlayer(win) {
  const doc = win.document;
  const WS = win.WS || (win.WS = {});
  // The saves key the local copy by the listener (shell.js sets this on a
  // shell page).
  if (!WS.user) WS.user = (win.WS_DATA && win.WS_DATA.user) || null;
  const urls = Array.prototype.map.call(doc.querySelectorAll('[data-ws-dep]'), function (n) {
    return n.getAttribute('data-ws-dep');
  }).filter(function (u) { return /^\/static\/js\/player\/[a-z]+\.js(\?[\w.=-]*)?$/.test(String(u)); });
  return urls.reduce(function (p, url) {
    return p.then(function () {
      return new Promise(function (resolve, reject) {
        const s = doc.createElement('script');
        s.type = 'module';
        s.src = url;
        s.addEventListener('load', function () { resolve(); });
        s.addEventListener('error', function () { reject(new Error('a player module did not load')); });
        doc.body.appendChild(s);
      });
    });
  }, Promise.resolve()).then(function () {
    if (!WS.player || !WS.playerUI) throw new Error('the player did not start');
    return { player: WS.player, ui: WS.playerUI };
  });
}

export function boot(win, overrides) {
  const doc = win.document;
  const root = doc.getElementById('wsRemote');
  if (!root) return null;
  const data = win.WS_DATA || {};
  const branding = data.branding || {};
  const remote = createRemote(Object.assign({
    doc: doc,
    root: root,
    id: String(win.location.hash || '').replace(/^#/, ''),
    siteName: typeof branding.app_name === 'string' ? branding.app_name.trim() : '',
    BroadcastChannel: typeof win.BroadcastChannel === 'function' ? win.BroadcastChannel : null,
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    now: Date.now,
    closeWindow: function () { win.close(); },
    loadPlayer: function () { return loadPlayer(win); }
  }, overrides || {}));
  win.addEventListener('pagehide', function () { remote.leave(); });
  return remote;
}

if (typeof window !== 'undefined' && window.document) boot(window);
