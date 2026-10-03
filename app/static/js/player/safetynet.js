/**
 * WebServarr — the audiobook player's "Were you listening to one of these?"
 * safety net (ES module, document-lifetime)
 *
 * The work key that carries a listener's place from a book to its re-added
 * copy is a hint, and it misses some renames. When a book opens and the
 * listener has no place in it at all, the engine asks the server for their
 * places on books that have left the library (GET /api/player/orphans/<key>),
 * and if there are any it holds the book (state().safetyNet, a 'warning'
 * { kind: 'safety-net' }): nothing is saved, and nothing plays, not even a
 * preview, a lock-screen Play included. This panel is the question. Design:
 * docs/superpowers/specs/2026-10-03-audiobook-no-lost-place-design.md,
 * section 3. Loaded by the shell partial as its own module script right after
 * findplace.js (so it carries its own asset stamp); nothing imports it. Like
 * the engine it lives as long as the document: its listeners are added once,
 * and it has no timers. Styles: theme.css "Audiobook player" (theme
 * variables only; it borrows the helper's cards).
 *
 * The panel (WS.playerUI.panel 'safetynet', in the full player, which opens
 * with it) lists each place: the old title and narrator, how far into the
 * book and the chapter, and when it was last listened to, with "This is the
 * one" (WS.player.pickOrphan: the place goes through the "Find your place"
 * helper as an earlier copy, exactly as an automatically linked one does, and
 * confirming it links the two by hand), and "None of these"
 * (WS.player.dismissOrphans: stored on the server for this listener and
 * book, so it holds on every device; the book opens as a new book).
 *
 * Closing it (its back button, Escape, the phone's Back, closing the full
 * player) is "decide later": nothing is saved and the book stays held. A
 * prompt then stays above the bar, or at the top of the full player, until
 * the listener comes back to it or answers. A reload opens the book again,
 * and since nothing was saved it asks again.
 *
 * Text through textContent only; no markup from strings, no inline handlers.
 *
 * Pure (importable by Node, no DOM at import time):
 *   bookClock(ms)        "3:12:40", "0:12:05" (always hours: never a time of day)
 *   percentOf(ms, total) whole percent through, or null
 *   formatAgo(ms)        "just now", "3 min ago", "2 h ago", "3 days ago"
 *   createSafetyNet(env) the panel, given its surroundings
 *   boot(win, overrides) WS.playerSafetyNet
 *
 * WS.playerSafetyNet (for the tests):
 *   open(opener) -> bool   shows the panel (false when no question is open)
 *   hide()                 as closing it
 *   shown                  the panel is showing
 */

export const PANEL = 'safetynet';
export const TITLE = 'Were you listening to one of these?';

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function known(v) {
  return typeof v === 'number' && isFinite(v);
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

export function bookClock(ms) {
  const t = Math.max(0, Math.floor(num(ms) / 1000));
  return Math.floor(t / 3600) + ':' + pad(Math.floor((t % 3600) / 60)) + ':' + pad(t % 60);
}

export function percentOf(ms, total) {
  if (!known(ms) || !known(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((ms / total) * 100)));
}

export function formatAgo(ms) {
  const v = Number(ms);
  if (!isFinite(v) || v < 60000) return 'just now';
  const mins = Math.floor(v / 60000);
  if (mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' h ago';
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : days + ' days ago';
}

// ---------------------------------------------------------------------------
// The safety net
// ---------------------------------------------------------------------------

/* env: { player (WS.player), ui (WS.playerUI), doc, now() (wall clock: "last
   listened") }. */
export function createSafetyNet(env) {
  const player = env.player;
  const ui = env.ui;
  const doc = env.doc;
  const now = env.now || Date.now;

  function logError(e) {
    console.error('[player] the safety net failed', e);
  }

  function safely(fn) {
    return function () {
      try {
        fn.apply(null, arguments);
      } catch (e) {
        logError(e);
      }
    };
  }

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

  // ---- State ----

  let book = null;             // the book the question is for
  let drawnFor = '';           // what the list was drawn for
  let promptEntry = null;      // the prompt, while the panel is put off
  let isShown = false;
  let opening = null;          // the full player is being opened for the panel: its show()

  // ---- The panel ----

  const panel = ui.panel(PANEL, { title: TITLE, onHide: onPanelHidden });
  const lede = h('p', {
    class: 'wsp-fp-lede',
    text: 'This book is new to you. If you were listening to one of these before it was replaced, pick it and we\'ll help you find your place. Nothing is saved until you do.'
  });
  const list = h('ul', { class: 'wsp-fp-cands', role: 'list' });
  const noneBtn = h('button', { type: 'button', class: 'wsp-fp-btn wsp-sn-none', text: 'None of these' });
  panel.body.appendChild(h('div', { class: 'wsp-opt-sec wsp-fp wsp-sn' }, [lede, list, noneBtn]));

  noneBtn.addEventListener('click', safely(function () {
    player.dismissOrphans();
  }));

  function line(cls, text) {
    return h('p', { class: cls, text: text, hidden: !text });
  }

  // One place offered: what it was, how far, and when.
  function row(o) {
    const title = typeof o.book_title === 'string' && o.book_title ? o.book_title : 'An earlier book';
    const by = typeof o.narrator === 'string' && o.narrator ? 'Read by ' + o.narrator : '';
    const pct = percentOf(o.book_ms, o.book_duration_ms);
    const time = known(o.book_ms) ? bookClock(o.book_ms) + ' into the book' + (pct === null ? '' : ' · ' + pct + '%') : '';
    const chapter = typeof o.chapter_label === 'string' ? o.chapter_label : '';
    const at = Date.parse(o.updated_at);
    const when = isFinite(at) ? 'Last listened ' + formatAgo(now() - at) : '';
    const pick = h('button', { type: 'button', class: 'wsp-fp-btn is-primary wsp-sn-pick', text: 'This is the one', 'aria-label': 'This is the one: ' + title });
    pick.addEventListener('click', safely(function () {
      player.pickOrphan(o.key);
    }));
    return h('li', { class: 'wsp-fp-cand wsp-sn-item', 'data-key': o.key }, [
      h('div', { class: 'wsp-fp-cand-head' }, [
        h('p', { class: 'wsp-fp-kind wsp-sn-title', text: title }),
        line('wsp-fp-at', by),
        line('wsp-fp-at', time),
        line('wsp-fp-at', chapter),
        line('wsp-fp-at', when)
      ]),
      h('div', { class: 'wsp-fp-actions' }, [pick])
    ]);
  }

  // The list for the question open now (drawn again only when it changes).
  function draw() {
    const s = player.state();
    const q = s.safetyNet;
    if (!q) return;
    const key = s.book + '#' + JSON.stringify(q.orphans);
    if (key === drawnFor) return;
    drawnFor = key;
    list.textContent = '';
    q.orphans.forEach(function (o) { list.appendChild(row(o)); });
  }

  // ---- Showing and hiding ----

  function asking() {
    const s = player.state();
    return !!(s && s.book && s.safetyNet);
  }

  function dropPrompt() {
    const p = promptEntry;
    promptEntry = null;
    if (p) p.remove();
  }

  // Put off while the question is open: a way back stays in view.
  function ensurePrompt() {
    if (promptEntry || isShown || !asking()) return;
    promptEntry = ui.prompt({
      id: 'safetynet',
      message: TITLE,
      actions: [{ label: 'Take a look', primary: true, run: function () { promptEntry = null; open(null); } }]
    });
  }

  function onPanelHidden() {
    if (!isShown) return;
    isShown = false;
    ensurePrompt();
  }

  /* Shows the panel for the question open now, in the full player (opened
     for it when it is not). */
  function open(opener) {
    const s = player.state();
    if (!s.book || !s.safetyNet) return false;
    book = s.book;
    function show() {
      dropPrompt();
      isShown = true;
      panel.show(opener);
    }
    if (!ui.isOpen()) {
      // Shown from the full player's 'open' (below): in the tap that opens
      // it, the panel is the player's layer, not one of its own.
      opening = show;
      let ok = false;
      try {
        ok = ui.open();
      } finally {
        opening = null;
      }
      if (!ok) return false;
      if (!isShown) show();
    } else {
      show();
    }
    // Drawn afresh each time it is shown: "last listened" moves on.
    drawnFor = '';
    draw();
    return true;
  }

  function hide() {
    if (!isShown) return;
    panel.hide();
    // A panel shown beside the player on a wide screen is hidden all the same.
    onPanelHidden();
  }

  // ---- The engine and the view ----

  player.on('warning', safely(function (w) {
    if (!w || w.kind !== 'safety-net') return;
    const s = player.state();
    if (!s.book || w.book !== s.book || !s.safetyNet) return;
    if (!open(null)) ensurePrompt();
  }));

  player.on('change', safely(function (d) {
    const s = d && d.state ? d.state : player.state();
    if (s.book !== book && book !== null) {
      // Another book, or none: what showed was this one's.
      if (isShown) hide();
      dropPrompt();
      book = null;
      drawnFor = '';
    }
    if (!s.book || !s.safetyNet) {
      // Answered (a pick leads on to the helper, "None of these" to the
      // book itself): the question has done its job.
      dropPrompt();
      if (isShown) hide();
      book = null;
      drawnFor = '';
      return;
    }
    if (isShown) draw();
    else if (book !== null) ensurePrompt();
  }));

  // The full player opening while the question is open opens on the panel.
  ui.on('open', safely(function () {
    if (opening) {
      const show = opening;
      opening = null;
      show();
      return;
    }
    if (asking() && !isShown) open(null);
  }));

  return {
    open: function (opener) {
      try {
        return open(opener);
      } catch (e) {
        logError(e);
        return false;
      }
    },
    hide: hide,
    get shown() { return isShown; }
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/* Adds the safety net to the engine and view booted before it (WS.player,
   WS.playerUI), once per document, as WS.playerSafetyNet. Returns it, or
   null on a page without the player. */
export function boot(win, overrides) {
  const WS = win.WS || (win.WS = {});
  if (WS.playerSafetyNet) return WS.playerSafetyNet;
  const player = (overrides && overrides.player) || WS.player;
  const ui = (overrides && overrides.ui) || WS.playerUI;
  if (!player || !ui) return null;
  const net = createSafetyNet(Object.assign({
    player: player,
    ui: ui,
    doc: win.document,
    now: Date.now
  }, overrides || {}));
  WS.playerSafetyNet = net;
  return net;
}

if (typeof window !== 'undefined' && window.document) boot(window);
