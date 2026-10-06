/**
 * WebServarr — the audiobook player's mini bar and full-screen player
 * (ES module, document-lifetime)
 *
 * Draws WS.player (engine.js) in #wsPlayer, which soft navigation never
 * touches: built once, so the same bar node stays on screen from page to
 * page while the book plays. Loaded by the shell partial as its own module
 * script right after engine.js (so it carries its own asset stamp), it only
 * reads the engine's state() and listens to its events; it never plays,
 * saves or fetches anything itself. Design:
 * docs/superpowers/specs/2026-09-28-audiobook-player-design.md, sections 6, 7
 * and 9. Styles: theme.css "Audiobook player" (theme variables only).
 *
 * Mini bar: shown while a book is loaded (and while one is being opened):
 * cover, title, chapter, time left, play/pause and a thin progress line. Its
 * height is --ws-player-h on <html>, so the page gives up that much at the
 * bottom and nothing is ever under it (0px while it is hidden). Tapping it
 * opens the full player. While the book is held because its files changed
 * (state().filesChanged), its Play opens the full player too, where the
 * "Find your place" helper (findplace.js) is: playing there is only ever a
 * preview, and the place is the listener's to choose. The same while the
 * safety net's question is open (state().safetyNet, safetynet.js), though
 * nothing plays at all then.
 *
 * Full player: an overlay above the page and the top bar (a modal dialog:
 * focus stays inside while it is open and goes back where it was on close).
 * Cover, title, author and narrator, the chapter scrubber (it seeks when it
 * is let go, never while dragged; the arrow keys move it by the skip length),
 * the chapter's time, the book's time left at the current speed and a
 * "finishes around" clock, skip back and forward by the engine's skip length,
 * play/pause, the chapter list, and hidden slots for the features that come
 * later. It closes by a swipe down (from the top bar, the cover or the
 * title), the close button or Escape. It slides; with reduced motion it
 * simply appears and goes.
 *
 * The "not saved" warning shows in both, each in a polite live region (the
 * one not on screen is hidden from assistive tech, so it is announced once).
 * Errors, a skipped part and a lost place are notices; an error with a retry
 * carries Retry and stays until the error ends.
 *
 * Pure (importable by Node, no DOM at import time):
 *   formatClock(ms)          "4:05", "1:02:03"
 *   formatLeft(ms)           "5 h 12 min left", "12 min left", "1 min left"
 *   timeLeft(state)          ms of listening left at the current speed
 *   finishesAround(now, ms)  the clock time listening ends: "9:40 PM",
 *                            "Tue 9:40 PM" within the week, else "Oct 12"
 *   chapterSpan(state)       { index, label, start, end } of the current chapter
 *   createUI(env)            the UI, given its surroundings (tests)
 *   boot(win, overrides)     builds it in #wsPlayer as WS.playerUI
 *
 * WS.playerUI, for the features (Tasks 8 and 9):
 *   notify(message, { tone, action, duration, id }) -> { remove() }
 *       A notice: above the bar, or at the top of the full player while it
 *       is open. tone 'info' (default) or 'err' (an alert). action
 *       { label, run }: one button; pressing it removes the notice, then
 *       runs run(). duration: ms on screen (default 5 s, errors 7 s, 4 s more
 *       with an action); 0 keeps it until remove(), and gives it a Dismiss
 *       button. id: a notice with the same id replaces the earlier one.
 *   prompt({ message, actions: [{ label, run, primary, keep }], id })
 *       -> { remove(), update({ message, busy }), shown }
 *       A question in the same place (handoff, up next): stays until one of
 *       its buttons is pressed (which removes it, then runs run) or
 *       remove(). id defaults to 'prompt', so a new prompt replaces the last.
 *       keep: pressing that button only runs run; the prompt stays until
 *       run's owner removes it. update: a new message in place, and busy
 *       true makes its buttons wait (aria-disabled, presses ignored; not
 *       disabled, so the focus stays on the one pressed) keeping its
 *       height, so nothing under it moves; busy false ends that.
 *   slot(name)        the element of a slot: 'menu' (the full player's top
 *                     right), 'speed', 'sleep', 'history' (its row of actions).
 *                     A slot never starts a swipe (data-no-swipe); anything
 *                     else a feature adds to a swipe area opts out the same way.
 *   fill(name, node)  puts node in the slot and shows it; clear(name) empties
 *                     and hides it again. A slot is hidden until it is filled.
 *   actionButton({ icon, text, label }) -> <button>
 *                     a button styled for the row of actions: an icon (or a
 *                     short text such as "1.5×") over its label
 *   panel(name, { title, onHide }) -> { body, show(opener), hide(), shown }
 *                     a view of the full player like Chapters: beside the
 *                     player on a wide screen, over it (with a back button)
 *                     on a phone. body is where its content goes; opener, the
 *                     button that showed it, gets focus back when it hides.
 *                     onHide() is called whenever it stops showing: its back
 *                     button, Escape or Back, another panel shown in its
 *                     place, hide(), or the full player closing.
 *                     Call show() from the tap or key that asks for it: only
 *                     then does the panel get a CloseWatcher of its own (the
 *                     phone's Back closes it alone); shown from an 'open'
 *                     handler (the tap that opened the player, which made
 *                     the player's), it gets none. Shown any other way, Escape
 *                     still closes it first, but Back closes the player.
 *   open(), close(), isOpen()        the full player
 *   on('open' | 'close', fn) -> unsubscribe
 *   onKey(fn) -> unsubscribe
 *                     fn(event) for each key pressed inside the full player
 *                     while it is open (the features' shortcuts), except
 *                     Escape and Tab, a key a control there has already
 *                     handled (defaultPrevented), and any key while a WSUI
 *                     dialog is over it. A key aimed outside the player while
 *                     it is open is swallowed and never reaches fn.
 *
 * Closing: Escape and, on a phone, Back close the innermost layer first (a
 * panel over the player, then the player). Where the browser has CloseWatcher,
 * each layer opened by a tap or a key gets one, so the browser's own close
 * request (Android Back, Escape) closes it; no history entry is ever written.
 * Elsewhere Escape is handled here, Back navigates the page as usual, and the
 * full player closes when a new page (or a page's own view) is shown. Keys
 * pressed inside the full player never reach the page under it (a reader's
 * page-turn keys, say); a feature that wants a key there listens inside it.
 * The full player closes whenever a page (or a wiki view) is shown under it,
 * including Back on a desktop browser, which is no close request.
 *
 * Desktop (lg and up, where the shell's top bar shows and has the pill's
 * slot, #wsPlayerPill): the mini bar gives way to a pill in the top bar
 * (cover, title, chapter and time left, play/pause, a thin progress line;
 * playing, paused, open, popped out and loading), and open() shows the same
 * player as a floating window instead of the full-screen sheet. The window
 * is part of the page, not a dialog: Tab goes in and out of it, nothing
 * behind it is blocked, page keys still reach the page, and soft navigation
 * leaves it open. It moves by its top bar and resizes from its corner (and by
 * the keyboard: the grip's arrows move it, Shift for bigger steps, Home puts
 * it back; the corner's arrows size it), stays inside the viewport, and its
 * place and size are kept per listener on this device. Its panels open
 * below the player and close again from the same button (Playback settings
 * gives way to Chapters). Escape or its X (Close player window) sends it back
 * to the pill and focus with it; the book plays on. Only the pill stops a
 * book: its Stop, right of Play, closes the book playing or paused ("Your
 * place is saved", Resume). A full-screen view (the reader) keeps the bar
 * and the sheet.
 *
 * Pop out (popout.js) moves the window into a window of its own: dock()
 * puts this same window in a Document Picture-in-Picture document, and
 * setPopped() marks the pill while a remote-control window plays the tab.
 */

export const SWIPE_CLOSE_PX = 120;     // a swipe down this far closes the full player
export const SWIPE_FLING = 0.6;        // or a flick this fast (px per ms)...
export const FLING_MIN_PX = 48;        // ...that has come at least this far
export const FLING_WINDOW_MS = 100;    // a flick's speed: over its last 100 ms, the release included
export const SLIDE_MS = 250;           // the full player's slide
export const NOTICE_MS = 5000;
export const NOTICE_ERR_MS = 7000;
export const ACTION_EXTRA_MS = 4000;   // more time to reach a notice's button
export const MAX_NOTICES = 3;
export const CLOCK_MS = 30000;         // the "finishes around" clock, while paused
export const SLOTS = ['menu', 'speed', 'sleep', 'history'];

// The desktop window: its size and limits, the gap it keeps from the
// viewport's edges, and the arrow keys' steps.
export const WIN = { w: 380, minW: 340, maxW: 520, h: 600, minH: 480, maxH: 900 };
export const WIN_GAP = 8;
export const WIN_STEP = 16;
export const WIN_STEP_BIG = 64;
export const WIN_IN_MS = 200;          // its open (opacity only with reduced motion)
export const WIN_OUT_MS = 160;         // ...and its close
export const WIN_KEY = 'ws-player-window';   // + ':' + the listener's identity key

const WIDE = '(min-width: 1024px)';
const RESUME_LOST = "Couldn't find your saved place in this book";
const REDUCE = '(prefers-reduced-motion: reduce)';
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

export function formatClock(ms) {
  const t = Math.max(0, Math.floor(num(ms) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

// Whole minutes, rounded up: a book with 20 s left has "1 min left".
export function formatLeft(ms) {
  const mins = Math.ceil(Math.max(0, num(ms)) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return m + ' min left';
  return m ? h + ' h ' + m + ' min left' : h + ' h left';
}

// Spoken form for the scrubber's aria-valuetext.
function spoken(ms) {
  const t = Math.max(0, Math.floor(num(ms) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const parts = [];
  if (h) parts.push(h + (h === 1 ? ' hour' : ' hours'));
  if (m) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
  if (s || !parts.length) parts.push(s + (s === 1 ? ' second' : ' seconds'));
  return parts.join(' ');
}

export function timeLeft(state) {
  const s = state || {};
  const left = Math.max(0, num(s.bookDurationMs) - num(s.bookMs));
  const speed = num(s.speed) > 0 ? num(s.speed) : 1;
  return left / speed;
}

export function finishesAround(nowMs, leftMs) {
  const now = new Date(num(nowMs));
  const end = new Date(num(nowMs) + Math.max(0, num(leftMs)));
  const time = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(end) - day(now)) / 86400000);
  if (days <= 0) return time;
  if (days < 7) return end.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return end.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* The current chapter as a span of book time, or the whole book when it has
   no chapters. null with no book. */
export function chapterSpan(state) {
  const s = state || {};
  const dur = num(s.bookDurationMs);
  const list = Array.isArray(s.chapters) ? s.chapters : [];
  const i = num(s.chapterIndex);
  const c = list.length && i >= 0 && i < list.length ? list[i] : null;
  if (!c) return s.book ? { index: -1, label: '', start: 0, end: dur } : null;
  const start = num(c.start_ms);
  let end = num(c.end_ms);
  if (!(end > start)) end = i + 1 < list.length ? num(list[i + 1].start_ms) : dur;
  return { index: i, label: String(c.label || ''), start: start, end: Math.max(start, end) };
}

function clampN(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function given(v) {
  return typeof v === 'number' && isFinite(v);
}

/* Where the desktop window goes: the listener's place and size (geo: x, y,
   w, h, each may be missing) kept inside the viewport (vp: w, h, top: the
   first row under the top bar), at the size limits (WIN). collapsedH: the
   window's own height when no panel is open (it sizes to its content), else
   null. Missing values are the default: WIN's size, at the top right. */
export function fitWindow(geo, vp, collapsedH) {
  const g = geo || {};
  const top = num(vp.top);
  const room = Math.max(0, num(vp.h) - top - WIN_GAP);
  const w = clampN(given(g.w) ? g.w : WIN.w, Math.min(WIN.minW, num(vp.w) - 2 * WIN_GAP), Math.min(WIN.maxW, num(vp.w) - 2 * WIN_GAP));
  const h = collapsedH !== null && collapsedH !== undefined
    ? Math.min(num(collapsedH), room)
    : clampN(given(g.h) ? g.h : WIN.h, Math.min(WIN.minH, room), Math.min(WIN.maxH, room));
  const x = clampN(given(g.x) ? g.x : num(vp.w) - w - 3 * WIN_GAP, WIN_GAP, Math.max(WIN_GAP, num(vp.w) - w - WIN_GAP));
  const y = clampN(given(g.y) ? g.y : top + WIN_GAP / 2, top, Math.max(top, num(vp.h) - h - WIN_GAP));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), room: Math.round(room) };
}

// ---------------------------------------------------------------------------
// The UI
// ---------------------------------------------------------------------------

/* env: { doc, host (#wsPlayer), player (WS.player), matchMedia(query),
   measure(el) -> px, isVisible(el), now(), setTimeout, clearTimeout,
   ResizeObserver, isDialogOpen(), leaveTo(url), win (for the router's
   events), CloseWatcher (the browser's, or none), hasActivation() (a tap or
   a key is being handled now), pillSlot (the top bar's #wsPlayerPill, or
   none: no desktop window), storage (localStorage, or none), identity() (the
   listener's identity key), viewport() -> { w, h }, topLimit() (px: the
   window stays below the top bar) }. */
export function createUI(env) {
  const doc = env.doc;
  const host = env.host;
  const player = env.player;
  const root = doc.documentElement;
  const pillSlot = env.pillSlot === undefined ? doc.getElementById('wsPlayerPill') : env.pillSlot;
  const setT = env.setTimeout;
  const clearT = env.clearTimeout;
  const now = env.now || Date.now;
  const measure = env.measure || function (el) { return el.getBoundingClientRect().height; };
  const isVisible = env.isVisible || function (el) {
    return !el.closest('[hidden]') && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const handlers = { open: new Set(), close: new Set() };
  const keyFns = new Set();

  // What is drawn, and the full player's own state.
  let lastState = null;
  let drawnBook;               // the book the text and covers are drawn for (undefined: none)
  let listBook = null;         // the book the chapter list is drawn for
  let marked = -1;             // the chapter marked current in the list
  let barShown = false;
  let lastPx = null;           // --ws-player-h as last set
  let warnText = '';
  let scrubbing = false;       // the scrubber is held: time changes do not move it
  let scrubSpan = null;        // the chapter it was taken in
  let clockTimer = null;
  let isOpen = false;
  let errorNote = null;       // the error notice, for its Retry (drawRetry)
  let retryHeld = false;      // the safety net's question is open: that Retry waits
  let lastFocus = null;        // focus before the full player opened
  let closing = null;          // { timer, onEnd } while the slide down runs
  let drag = null;             // a swipe: { id, y0, dy, moving, samples: [[t, y]] }
  let view = null;             // the panel shown over the player (phone) or beside it (wide)
  let panelFrom = null;        // what showed it, for focus on the way back
  // CloseWatchers, one per layer: the full player's, and a panel's while it
  // covers the player. null where the browser has none, or the layer was
  // opened with no tap or key (a watcher made then would share the previous
  // one's close request).
  let watcher = null;
  let panelWatcher = null;
  let openedAt = null;         // the address the full player opened on
  let panelTapped = false;     // the panel over the player got its watcher from a tap
  // The full player's 'open' handlers are running, and its watcher was made
  // in this tap: a panel they show (the same tap) gets none of its own (the
  // two would share one close request, and one Back would close both).
  // Escape still closes it first.
  let watcherTap = false;
  // The desktop window: the open player is the floating window (not the
  // sheet); docked: it sits in a Picture-in-Picture document ({ doc, holder });
  // popped: it plays in a window of its own ({ kind, end }), shown on the pill.
  let windowed = false;
  let docked = null;
  let popped = null;
  let popOutFn = null;         // popout.js: what Pop out does
  let winDrag = null;          // a move or resize: { kind, id, x0, y0, from }
  let winWatch = null;         // the viewport's resize listener while it shows
  let winAnim = null;          // the open's class timer

  // again: re-made for a layer that had one (the screen turned), not a new
  // layer, so no tap is needed.
  function watch(onClose, again) {
    const CW = env.CloseWatcher;
    if (typeof CW !== 'function') return null;
    try {
      if (!again && env.hasActivation && !env.hasActivation()) return null;
      const w = new CW();
      w.addEventListener('close', onClose);
      return w;
    } catch (e) {
      return null;
    }
  }

  function unwatch(w) {
    if (!w) return;
    try {
      w.destroy();
    } catch (e) { /* gone already */ }
  }

  function matches(q) {
    try {
      return !!(env.matchMedia && env.matchMedia(q).matches);
    } catch (e) {
      return false;
    }
  }
  function motion() { return !matches(REDUCE); }

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

  function setHidden(el, hide) {
    if (el.hidden !== !!hide) el.hidden = !!hide;
  }

  function logError(e) {
    console.error('[player] the player view failed', e);
  }

  function safely(fn) {
    return function () {
      try {
        const r = fn.apply(null, arguments);
        if (r && typeof r.catch === 'function') r.catch(logError);
      } catch (e) {
        logError(e);
      }
    };
  }

  // A cover: the picture at its own shape inside a square frame (never
  // cropped: most audiobook covers are tall print covers), or a headphones
  // mark when there is none or it will not load.
  function art(cls) {
    const img = h('img', { alt: '', decoding: 'async', hidden: true });
    const mark = icon('headphones', 'wsp-art-mark');
    const a = { frame: h('span', { class: 'wsp-art ' + cls }, [mark, img]), img: img, mark: mark, src: '' };
    img.addEventListener('load', function () {
      if (!a.src) return;
      img.hidden = false;
      mark.hidden = true;
    });
    img.addEventListener('error', function () {
      img.hidden = true;
      mark.hidden = false;
    });
    return a;
  }

  function setArt(a, url) {
    if (a.src === url) return;
    a.src = url;
    a.img.hidden = true;
    a.mark.hidden = !!url;
    if (url) a.img.src = url;
    else a.img.removeAttribute('src');
  }

  // ---- The mini bar ----

  const barLine = h('span', { class: 'wsp-line-fill' });
  const barWarn = h('div', { class: 'wsp-warn-live', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const barArt = art('wsp-bar-art');
  const barTitle = h('span', { class: 'wsp-bar-title' });
  const barMeta = h('span', { class: 'wsp-bar-meta' });
  const openBtn = h('button', { type: 'button', class: 'wsp-bar-open', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, [
    h('span', { class: 'sr-only', text: 'Open the player: ' }),
    barArt.frame,
    h('span', { class: 'wsp-bar-text' }, [barTitle, barMeta])
  ]);
  const barPlay = h('button', { type: 'button', class: 'wsp-play wsp-play-sm', 'aria-label': 'Play' }, [icon('play_arrow')]);
  // With the top bar's pill (a desktop page), the bar shows only below lg and
  // on a full-screen view (theme.css): its measured height is 0 elsewhere.
  const bar = h('section', { class: 'wsp-bar' + (pillSlot ? ' wsp-bar-pilled' : ''), 'aria-label': 'Audiobook player', hidden: true }, [
    h('div', { class: 'wsp-line', 'aria-hidden': 'true' }, [barLine]),
    barWarn,
    h('div', { class: 'wsp-bar-row' }, [openBtn, barPlay])
  ]);

  // ---- The full player ----

  const ambientImg = h('img', { alt: '', decoding: 'async', hidden: true });
  ambientImg.addEventListener('load', function () { if (ambientImg.getAttribute('src')) ambientImg.hidden = false; });
  ambientImg.addEventListener('error', function () { ambientImg.hidden = true; });
  const closeBtn = h('button', { type: 'button', class: 'wsp-icon-btn', 'aria-label': 'Close the player' }, [icon('keyboard_arrow_down')]);
  const slots = {};
  SLOTS.forEach(function (name) {
    slots[name] = h('div', { class: 'wsp-slot wsp-slot-' + name, 'data-slot': name, 'data-no-swipe': '', hidden: true });
  });
  const fullArt = art('wsp-full-art');
  fullArt.frame.setAttribute('data-swipe', '');
  const series = h('p', { class: 'wsp-series' });
  const title = h('h2', { class: 'wsp-title', id: 'wspTitle' });
  const byline = h('p', { class: 'wsp-byline' });
  const fullWarn = h('div', { class: 'wsp-warn-live', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const chapLabel = h('p', { class: 'wsp-chapter', id: 'wspChapter' });
  const range = h('input', {
    type: 'range', class: 'wsp-range', min: '0', max: '1', step: '1', value: '0',
    'aria-label': 'Position in this chapter'
  });
  const elapsed = h('span', { class: 'wsp-time' });
  const remaining = h('span', { class: 'wsp-time' });
  const leftLine = h('p', { class: 'wsp-left' });
  const backN = h('span', { class: 'wsp-skip-n' });
  const fwdN = h('span', { class: 'wsp-skip-n' });
  const backBtn = h('button', { type: 'button', class: 'wsp-skip' }, [icon('replay'), backN]);
  const fwdBtn = h('button', { type: 'button', class: 'wsp-skip' }, [icon('replay', 'wsp-mirror'), fwdN]);
  const fullPlay = h('button', { type: 'button', class: 'wsp-play wsp-play-lg', 'aria-label': 'Play' }, [icon('play_arrow')]);
  const chaptersBtn = actionButton({ icon: 'format_list_bulleted', label: 'Chapters' });
  const chaptersSlot = h('div', { class: 'wsp-slot', 'data-no-swipe': '', hidden: true }, [chaptersBtn]);
  const actionsRow = h('div', { class: 'wsp-actions' }, [slots.speed, chaptersSlot, slots.sleep, slots.history]);
  // The desktop window's own controls, in its top bar (hidden on the sheet).
  const grip = h('button', {
    type: 'button', class: 'wsp-icon-btn wsp-win-grip', hidden: true, title: 'Move',
    'aria-label': 'Move the player. Arrow keys move it, Home puts it back.'
  }, [icon('drag_indicator')]);
  const popBtn = h('button', { type: 'button', class: 'wsp-icon-btn wsp-win-btn', hidden: true, title: 'Pop out', 'aria-label': 'Pop out into its own window' }, [icon('picture_in_picture_alt')]);
  const winSep = h('span', { class: 'wsp-win-sep', 'aria-hidden': 'true', hidden: true });
  // The window's X only closes the window: the book plays on in the pill.
  // Stopping is the pill's own ✕, offered while paused.
  const winCloseBtn = h('button', { type: 'button', class: 'wsp-icon-btn wsp-win-btn', hidden: true, title: 'Close player window', 'aria-label': 'Close player window' }, [icon('close')]);
  const resizeBtn = h('button', {
    type: 'button', class: 'wsp-win-resize', hidden: true, title: 'Resize',
    'aria-label': 'Resize the player. Arrow keys change its size.'
  });
  const main = h('div', { class: 'wsp-main' }, [
    fullArt.frame,
    h('div', { class: 'wsp-meta', 'data-swipe': '' }, [series, title, byline]),
    h('div', { class: 'wsp-scrub' }, [
      chapLabel,
      range,
      h('div', { class: 'wsp-times' }, [elapsed, remaining])
    ]),
    leftLine,
    h('div', { class: 'wsp-controls' }, [backBtn, fullPlay, fwdBtn]),
    actionsRow
  ]);
  const side = h('div', { class: 'wsp-side' });
  const noticeBox = h('div', { class: 'wsp-notices', 'aria-live': 'polite' });
  // The warning and, while the player is open, the notices: one column under
  // the top bar, above whichever view shows, so neither covers the other.
  const alerts = h('div', { class: 'wsp-alerts' }, [fullWarn]);
  const topBar = h('div', { class: 'wsp-top', 'data-swipe': '' }, [
    h('span', { class: 'wsp-grab', 'aria-hidden': 'true' }),
    closeBtn,
    grip,
    h('span', { class: 'wsp-top-label', text: 'Now playing' }),
    slots.menu,
    popBtn,
    winSep,
    winCloseBtn
  ]);
  const sheet = h('div', { class: 'wsp-sheet', tabindex: '-1' }, [
    h('div', { class: 'wsp-ambient', 'aria-hidden': 'true' }, [ambientImg]),
    topBar,
    alerts,
    h('div', { class: 'wsp-body' }, [main, side]),
    resizeBtn
  ]);
  const full = h('div', { class: 'wsp-full', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wspTitle', hidden: true }, [sheet]);

  host.appendChild(bar);
  host.appendChild(full);
  host.appendChild(noticeBox);

  // ---- The top bar's pill (desktop) ----
  //
  // In the shell's top bar, left of the bell: the cover and title open the
  // window (or hide it, or bring a popped-out player back); the round button
  // plays and pauses without opening anything. Shown while the bar would be.

  const pillArt = art('wsp-pill-art');
  const pillTitle = h('span', { class: 'wsp-pill-title' });
  const pillWords = h('span', { class: 'wsp-pill-words' });
  const pillMeta = h('span', { class: 'wsp-pill-meta' }, [
    h('span', { class: 'wsp-eq', 'aria-hidden': 'true' }, [h('span'), h('span'), h('span')]),
    pillWords
  ]);
  const pillOpen = h('button', { type: 'button', class: 'wsp-pill-open', 'aria-expanded': 'false' }, [
    pillArt.frame,
    h('span', { class: 'wsp-pill-text' }, [pillTitle, pillMeta])
  ]);
  const pillPlay = h('button', { type: 'button', class: 'wsp-play wsp-pill-play', 'aria-label': 'Play' }, [icon('play_arrow')]);
  // Stop, right of Play: always in its place while the pill shows, so Play
  // never moves under the pointer. Inert (aria-disabled) while it can't act.
  const pillStop = h('button', { type: 'button', class: 'wsp-icon-btn wsp-pill-stop', title: 'Stop listening' }, [icon('stop')]);
  const pillFill = h('span', { class: 'wsp-pill-fill' });
  // The not-saved warning, said here while the window is not open (the
  // window's own says it then), so it is announced once.
  const pillWarn = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const pill = h('div', { class: 'wsp-pill', role: 'group', 'aria-label': 'Audiobook player', 'data-state': 'paused' }, [
    pillOpen,
    pillPlay,
    pillStop,
    h('span', { class: 'wsp-pill-line', 'aria-hidden': 'true' }, [pillFill]),
    pillWarn
  ]);
  if (pillSlot) {
    pillSlot.textContent = '';
    pillSlot.appendChild(pill);
  }

  // ---- Panels ----

  const panels = new Map();   // name -> { section, body, heading, api, onHide }

  function panel(name, opts) {
    name = String(name);
    if (panels.has(name)) return panels.get(name).api;
    const id = 'wspPanel-' + name.replace(/[^\w-]/g, '');
    const heading = h('h3', { class: 'wsp-panel-title', id: id, tabindex: '-1', text: (opts && opts.title) || name });
    const back = h('button', { type: 'button', class: 'wsp-icon-btn wsp-panel-back', 'aria-label': 'Back to the player' }, [icon('arrow_back')]);
    const body = h('div', { class: 'wsp-panel-body' });
    const section = h('section', { class: 'wsp-panel', 'data-panel': name, 'aria-labelledby': id, hidden: true }, [
      h('div', { class: 'wsp-panel-head' }, [back, heading]),
      body
    ]);
    back.addEventListener('click', function () { hidePanel(name); });
    side.appendChild(section);
    const api = {
      body: body,
      show: function (opener) { showPanel(name, opener); },
      hide: function () { hidePanel(name); },
      get shown() { return view === name; }
    };
    const onHide = opts && typeof opts.onHide === 'function' ? opts.onHide : null;
    panels.set(name, { section: section, body: body, heading: heading, api: api, onHide: onHide });
    drawPanels();
    return api;
  }

  // The panel that was showing has stopped: its own onHide.
  function left(name) {
    const p = name === null ? null : panels.get(name);
    if (p && p.onHide) safely(p.onHide)();
  }

  // The slot a panel's button sits in, and back.
  function slotPanel(s) {
    if (s === chaptersSlot) return 'chapters';
    return s ? s.getAttribute('data-slot') : null;
  }

  function drawPanels() {
    const many = chapterCount() > 1;
    // The window opens a panel below the player only when asked, and
    // closes it again; the sheet on a wide screen keeps Chapters beside it.
    const shown = windowed ? view : view || (many ? 'chapters' : null);
    panels.forEach(function (p, name) { setHidden(p.section, name !== shown); });
    setAttr(full, 'data-view', view);
    setAttr(full, 'data-side', shown ? '' : null);
    // In the window each action button opens and closes its panel: it says so.
    [chaptersSlot, slots.speed, slots.sleep, slots.history].forEach(function (s) {
      const b = s.querySelector('button');
      if (b) setAttr(b, 'aria-expanded', windowed ? (view === slotPanel(s) ? 'true' : 'false') : null);
    });
  }

  // opener: the button that showed it, for focus on the way back (a tap does
  // not focus a button everywhere; Safari's does not).
  function showPanel(name, opener) {
    if (!panels.has(name)) return;
    panelFrom = opener && opener.nodeType === 1 ? opener : doc.activeElement;
    const was = view;
    view = name;
    // Over the player (a phone): a layer of its own, closed first.
    if (isOpen && !windowed && !panelWatcher && !watcherTap && !matches(WIDE)) panelTapped = watchPanel(false);
    drawPanels();
    // The window grows to hold it (and stays on screen).
    placeWindow();
    fitDocked();
    if (name === 'chapters') centreCurrent();
    const p = panels.get(name);
    try {
      p.heading.focus({ preventScroll: true });
    } catch (e) { /* not focusable yet */ }
    if (was !== null && was !== name) left(was);
  }

  function watchPanel(again) {
    panelWatcher = watch(function () {
      panelWatcher = null;
      hidePanel(null);
    }, again);
    return !!panelWatcher;
  }

  // The screen turned: a panel is a layer only while it covers the player.
  function onWideChange() {
    // Across lg the window and the sheet trade places: the open one closes
    // (in its own window it stays).
    if (isOpen && !docked && windowed !== windowable()) {
      close();
      return;
    }
    if (!isOpen || view === null) return;
    if (matches(WIDE)) {
      const w = panelWatcher;
      panelWatcher = null;
      unwatch(w);
    } else if (!panelWatcher && panelTapped) {
      // Only a watcher the panel had from its tap is made again: one made
      // for a panel shown without a tap could join the player's, and one
      // Back would close both.
      watchPanel(true);
    }
  }

  function hidePanel(name) {
    if (name && view !== name) return;
    if (view === null) return;
    const was = view;
    // In the window, Playback settings gives way to Chapters (as the sheet
    // on a wide screen shows them beside it), not to nothing.
    view = windowed && was === 'settings' && chapterCount() > 1 ? 'chapters' : null;
    panelTapped = false;
    const w = panelWatcher;
    panelWatcher = null;
    unwatch(w);
    drawPanels();
    if (view === 'chapters') centreCurrent();
    fitDocked();
    placeWindow();
    const back = panelFrom;
    panelFrom = null;
    if (isOpen && back && back.isConnected && full.contains(back) && isVisible(back)) back.focus({ preventScroll: true });
    left(was);
  }

  // ---- Chapters ----

  const chapters = panel('chapters', { title: 'Chapters' });
  const chapterList = h('ol', { class: 'wsp-chapter-list' });
  chapters.body.appendChild(chapterList);

  function chapterCount() {
    const s = lastState;
    return s && Array.isArray(s.chapters) ? s.chapters.length : 0;
  }

  function drawChapters(s) {
    listBook = s.book;
    marked = -1;
    chapterList.textContent = '';
    const list = Array.isArray(s.chapters) ? s.chapters : [];
    list.forEach(function (c, i) {
      const start = num(c.start_ms);
      let end = num(c.end_ms);
      if (!(end > start)) end = i + 1 < list.length ? num(list[i + 1].start_ms) : num(s.bookDurationMs);
      const b = h('button', { type: 'button', class: 'wsp-chapter-item', 'data-index': String(i) }, [
        icon('graphic_eq', 'wsp-chapter-now'),
        h('span', { class: 'wsp-chapter-name', text: String(c.label || 'Chapter ' + (i + 1)) }),
        h('span', { class: 'wsp-chapter-len', text: formatClock(Math.max(0, end - start)) })
      ]);
      chapterList.appendChild(h('li', null, [b]));
    });
    setHidden(chaptersSlot, list.length < 2);
    drawPanels();
  }

  function markChapter(i) {
    if (i === marked) return;
    const items = chapterList.querySelectorAll('.wsp-chapter-item');
    items.forEach(function (b, n) {
      const cur = n === i;
      setAttr(b, 'aria-current', cur ? 'true' : null);
      b.classList.toggle('is-current', cur);
      b.classList.toggle('is-past', n < i);
    });
    marked = i;
  }

  // The current chapter to the middle of the list (the list scrolls, never
  // the page underneath).
  function centreCurrent() {
    const cur = chapterList.querySelector('.wsp-chapter-item.is-current');
    const box = chapters.body;
    if (!cur || !box) return;
    const li = cur.parentNode;
    box.scrollTop = Math.max(0, li.offsetTop - box.clientHeight / 2 + li.offsetHeight / 2);
  }

  chapterList.addEventListener('click', function (e) {
    const b = e.target && e.target.closest ? e.target.closest('.wsp-chapter-item') : null;
    if (!b) return;
    player.jumpToChapter(Number(b.getAttribute('data-index')));
    // On a phone the list covers the player: back to it, to see the jump.
    if (!matches(WIDE)) hidePanel('chapters');
  });
  chaptersBtn.addEventListener('click', function () { showPanel('chapters', chaptersBtn); });
  // In the window an action button pressed again closes its panel (before
  // the button's own handler, which only ever shows it).
  actionsRow.addEventListener('click', function (e) {
    if (!windowed || !e.target || !e.target.closest) return;
    const s = e.target.closest('.wsp-slot');
    const name = s ? slotPanel(s) : null;
    if (!name || view !== name || !e.target.closest('button')) return;
    e.stopPropagation();
    hidePanel(name);
  }, true);

  // ---- Slots ----

  function slot(name) {
    return slots[name] || null;
  }

  function fill(name, node) {
    const s = slots[name];
    if (!s) return null;
    s.textContent = '';
    if (node) s.appendChild(node);
    setHidden(s, !node);
    drawPanels();
    return s;
  }

  function clear(name) {
    fill(name, null);
  }

  function actionButton(o) {
    o = o || {};
    const top = o.icon ? icon(o.icon, 'wsp-action-icon') : h('span', { class: 'wsp-action-icon wsp-action-text', 'aria-hidden': 'true', text: o.text || '' });
    return h('button', { type: 'button', class: 'wsp-action' }, [top, h('span', { class: 'wsp-action-label', text: o.label || '' })]);
  }

  // ---- Notices and prompts ----

  const notices = new Map();   // id -> entry
  const order = [];            // entries, oldest first

  function addNotice(message, o) {
    const id = o.id ? String(o.id) : null;
    if (id && notices.has(id)) notices.get(id).remove();
    const err = o.tone === 'err';
    const el = h('div', {
      class: 'wsp-notice' + (o.prompt ? ' wsp-prompt' : '') + (err ? ' is-err' : ''),
      role: err ? 'alert' : null
    });
    if (!o.prompt) el.appendChild(h('span', { class: 'ws-light ' + (err ? 'ws-light-error' : 'ws-light-unconfigured'), 'aria-hidden': 'true' }));
    const textEl = h('p', { class: 'wsp-notice-text', text: String(message == null ? '' : message) });
    el.appendChild(textEl);
    const buttons = [];
    let timer = null;
    let gone = false;
    const entry = { el: el, sticky: false, remove: remove };
    function remove() {
      if (gone) return;
      gone = true;
      if (timer !== null) clearT(timer);
      const hadFocus = el.contains((el.ownerDocument || doc).activeElement);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (id && notices.get(id) === entry) notices.delete(id);
      const at = order.indexOf(entry);
      if (at !== -1) order.splice(at, 1);
      syncHost();
      syncScroll();
      if (hadFocus) {
        const back = isOpen ? fullPlay : barShown ? (pillOnScreen() ? pillPlay : barPlay) : null;
        if (back) back.focus({ preventScroll: true });
      }
    }
    const actions = (o.actions || []).filter(function (a) { return a && a.label; });
    if (actions.length) {
      const row = h('div', { class: 'wsp-notice-actions' });
      actions.forEach(function (a) {
        const b = h('button', { type: 'button', class: 'wsp-notice-btn' + (a.primary ? ' is-primary' : ''), text: String(a.label) });
        b.addEventListener('click', function () {
          if (b.getAttribute('aria-disabled') === 'true') return;
          if (!a.keep) remove();
          if (typeof a.run === 'function') safely(a.run)();
        });
        buttons.push(b);
        row.appendChild(b);
      });
      el.appendChild(row);
    }
    let ms = o.duration;
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
      ms = (err ? NOTICE_ERR_MS : NOTICE_MS) + (actions.length ? ACTION_EXTRA_MS : 0);
    }
    if (o.prompt) ms = 0;
    if (ms === 0) {
      entry.sticky = true;
      if (!o.prompt) {
        const x = h('button', { type: 'button', class: 'wsp-icon-btn wsp-notice-x', 'aria-label': 'Dismiss' }, [icon('close')]);
        x.addEventListener('click', remove);
        el.appendChild(x);
      }
    } else {
      timer = setT(remove, ms);
    }
    // Too many: the oldest that would go by itself goes now, else the oldest.
    while (order.length >= MAX_NOTICES) {
      const old = order.find(function (n) { return !n.sticky; }) || order[0];
      old.remove();
    }
    if (id) notices.set(id, entry);
    order.push(entry);
    // Prompts above notices; newest nearest the bar.
    if (o.prompt) noticeBox.insertBefore(el, noticeBox.firstChild);
    else noticeBox.appendChild(el);
    syncHost();
    syncScroll();
    // A new message in place; busy: its buttons wait (still there, so the
    // focus and the layout stay), the prompt no shorter than it was.
    function update(u) {
      if (gone || !u) return;
      if (typeof u.busy === 'boolean') {
        // The words' block keeps its height, so the buttons under it stay put.
        if (u.busy) textEl.style.minHeight = textEl.getBoundingClientRect().height + 'px';
        else textEl.style.minHeight = '';
        el.setAttribute('aria-busy', u.busy ? 'true' : 'false');
        // aria-disabled, not disabled: a browser moves the focus off a
        // button made disabled, and the one pressed must keep it. Presses
        // meanwhile are ignored (the click handler).
        buttons.forEach(function (b) {
          b.setAttribute('aria-disabled', u.busy ? 'true' : 'false');
        });
      }
      if (u.message != null) textEl.textContent = String(u.message);
    }
    return { remove: remove, update: update, get shown() { return !gone; } };
  }

  function notify(message, o) {
    o = o || {};
    return addNotice(message, {
      tone: o.tone === 'err' ? 'err' : 'info',
      actions: o.action ? [o.action] : [],
      duration: o.duration,
      id: o.id
    });
  }

  function prompt(o) {
    o = o || {};
    return addNotice(o.message, {
      prompt: true,
      actions: Array.isArray(o.actions) ? o.actions : [],
      id: o.id ? o.id : 'prompt'
    });
  }

  function dropNotice(id) {
    const n = notices.get(id);
    if (n) n.remove();
  }

  // ---- The bar's place on the page ----

  function measureBar() {
    const px = barShown ? Math.max(0, Math.round(num(measure(bar)))) : 0;
    if (px === lastPx) return;
    lastPx = px;
    root.style.setProperty('--ws-player-h', px + 'px');
  }

  function syncHost() {
    setHidden(host, !(barShown || isOpen || noticeBox.childElementCount > 0));
  }

  function showBar(show) {
    if (show === barShown) return;
    barShown = show;
    setHidden(bar, !show);
    if (pillSlot) setHidden(pillSlot, !show);
    syncHost();
    measureBar();
  }

  function pillOnScreen() {
    return !!pillSlot && barShown && isVisible(pill);
  }

  if (typeof env.ResizeObserver === 'function') {
    try {
      new env.ResizeObserver(function () { measureBar(); }).observe(bar);
      // The screen turning or the alerts changing the column's height.
      new env.ResizeObserver(function () { syncScroll(); }).observe(main);
    } catch (e) { /* measured on each change of shape instead */ }
  }

  // ---- A short screen ----

  // The player's column overflows (a short screen, with alerts showing): the
  // cover and the title stop taking the touch, so it scrolls from them too
  // (the top bar still swipes it closed).
  function syncScroll() {
    if (!isOpen) return;
    main.classList.toggle('is-scrollable', main.scrollHeight > main.clientHeight + 1);
  }

  // ---- The warning ----

  function warnNode(text) {
    return h('p', { class: 'wsp-warn' }, [
      h('span', { class: 'ws-light ws-light-warn', 'aria-hidden': 'true' }),
      h('span', { text: text })
    ]);
  }

  function setWarn(text) {
    text = text ? String(text) : '';
    if (text === warnText) return;
    warnText = text;
    [barWarn, fullWarn].forEach(function (live) {
      live.textContent = '';
      if (text) live.appendChild(warnNode(text));
    });
    measureBar();
    syncScroll();
    if (lastState) drawPill(lastState);
  }

  // ---- Drawing ----

  function playing(s) { return !!(s && s.playing); }

  function drawPlay(btn, s) {
    // Loading while asked to play, or a late Play reading the saved places first.
    const busy = !!((s.loading && s.playing) || s.checking);
    const name = busy ? 'progress_activity' : playing(s) ? 'pause' : 'play_arrow';
    const label = busy ? 'Loading' : playing(s) ? 'Pause' : 'Play';
    const ic = btn.firstChild;
    setText(ic, name);
    ic.classList.toggle('wsp-spin', busy);
    setAttr(btn, 'aria-label', label);
    // The safety net's question is open: nothing plays until it is answered.
    // aria-disabled, not disabled (a disabled button can't keep the focus),
    // and dimmed by theme.css; the press does nothing (the engine holds), but
    // the bar's opens the full player on the question.
    setAttr(btn, 'aria-disabled', s.safetyNet ? 'true' : null);
  }

  function drawBook(s) {
    drawnBook = s.book;
    const loadingOnly = !s.book;
    setText(barTitle, s.title);
    setText(title, s.title);
    barTitle.classList.toggle('wsp-skel', loadingOnly);
    barMeta.classList.toggle('wsp-skel', loadingOnly);
    title.classList.toggle('wsp-skel', loadingOnly);
    setText(series, s.series);
    setHidden(series, !s.series);
    const by = [];
    if (s.author) by.push(s.author);
    if (s.narrator) by.push('Read by ' + s.narrator);
    setText(byline, by.join(' · '));
    setArt(barArt, s.cover || '');
    setArt(fullArt, s.cover || '');
    if (ambientImg.getAttribute('src') !== (s.cover || null)) {
      ambientImg.hidden = true;
      if (s.cover) ambientImg.src = s.cover;
      else ambientImg.removeAttribute('src');
    }
    if (listBook !== s.book) drawChapters(s);
  }

  function drawSkip() {
    let n = 10;
    try {
      n = num(player.setSkip()) || 10;
    } catch (e) { /* the default */ }
    setText(backN, n);
    setText(fwdN, n);
    setAttr(backBtn, 'aria-label', 'Back ' + n + ' seconds');
    setAttr(fwdBtn, 'aria-label', 'Forward ' + n + ' seconds');
  }

  function drawScrub(span, atMs) {
    const len = Math.max(0, span.end - span.start);
    const max = Math.max(1, Math.round(len / 1000));
    const at = Math.min(len, Math.max(0, atMs));
    setAttr(range, 'max', String(max));
    const v = String(Math.min(max, Math.floor(at / 1000)));
    if (range.value !== v) range.value = v;
    range.style.setProperty('--wsp-p', (len ? (at / len) * 100 : 0).toFixed(2) + '%');
    setAttr(range, 'aria-valuetext', spoken(at) + ' of ' + spoken(len));
    setText(elapsed, formatClock(at));
    setText(remaining, '−' + formatClock(len - at));
  }

  function drawTime(s) {
    const dur = num(s.bookDurationMs);
    const p = dur > 0 ? Math.min(1, Math.max(0, num(s.bookMs) / dur)) : 0;
    const tf = 'scaleX(' + p.toFixed(4) + ')';
    if (barLine.style.transform !== tf) barLine.style.transform = tf;
    const span = chapterSpan(s);
    const left = timeLeft(s);
    const leftText = !s.book || !dur ? '' : left <= 0 ? 'Finished' : formatLeft(left);
    setText(barMeta, [span && span.label, leftText].filter(Boolean).join(' · '));
    setText(chapLabel, span ? span.label : '');
    setHidden(chapLabel, !(span && span.label));
    if (span && !scrubbing) drawScrub(span, num(s.bookMs) - span.start);
    range.disabled = !s.book;
    let line = leftText;
    if (s.book && dur && left > 0) line += ' · Finishes around ' + finishesAround(now(), left);
    setText(leftLine, line);
    markChapter(span ? span.index : -1);
  }

  // The pill: the bar's words and line, and which of its states it is in.
  function drawPill(s) {
    if (!pillSlot || !s) return;
    const loadingOnly = !s.book;
    const up = isOpen && windowed && !docked;
    setAttr(pill, 'data-state', loadingOnly ? 'loading' : playing(s) ? 'playing' : 'paused');
    setAttr(pill, 'data-open', up ? '' : null);
    setAttr(pill, 'data-popped', popped ? '' : null);
    setAttr(pill, 'data-warn', warnText ? '' : null);
    setText(pillTitle, s.title);
    let words = '';
    if (!loadingOnly) words = warnText || (popped ? 'Playing in its own window' : barMeta.textContent);
    setText(pillWords, words);
    const tf = barLine.style.transform;
    if (pillFill.style.transform !== tf) pillFill.style.transform = tf;
    setArt(pillArt, s.cover || '');
    drawPlay(pillPlay, s);
    // Stop acts on a loaded book, playing or paused, but not while it opens,
    // loads a part or reads its saved places (a newer place may be coming).
    const canStop = !loadingOnly && !s.loading && !s.checking;
    const held = !!(s.filesChanged || s.safetyNet);
    setAttr(pillStop, 'aria-disabled', canStop ? null : 'true');
    setAttr(pillStop, 'aria-label', held ? 'Stop listening' : 'Stop listening, your place is saved');
    const what = popped ? 'Bring the player back' : up ? 'Hide the player' : 'Open the player';
    setAttr(pillOpen, 'aria-label', what + (s.title ? ': ' + s.title : ''));
    setAttr(pillOpen, 'aria-expanded', up ? 'true' : 'false');
    setAttr(pillOpen, 'title', warnText || (popped ? 'Bring the player back into the page' : what));
    // The warning is said here only while the window's own is not showing.
    const say = warnText && !isOpen ? warnText : '';
    if (pillWarn.textContent !== say) pillWarn.textContent = say;
  }

  function render(s) {
    if (!s) return;
    lastState = s;
    const show = !!s.book || (!!s.loading && !s.error);
    showBar(show);
    if (!show) {
      if (isOpen) close();
      drawnBook = undefined;
    } else if (drawnBook !== s.book) {
      drawBook(s);
    }
    drawPlay(barPlay, s);
    drawPlay(fullPlay, s);
    drawRetry(!!s.safetyNet);
    drawSkip();
    drawTime(s);
    if (!s.saveError) setWarn('');
    if (!s.error) dropNotice('error');
    drawPill(s);
  }

  // ---- The scrubber ----

  function scrubStart() {
    if (scrubbing) return;
    scrubbing = true;
    scrubSpan = chapterSpan(player.state());
  }

  function scrubEnd() {
    scrubbing = false;
    scrubSpan = null;
    render(player.state());
  }

  range.addEventListener('pointerdown', scrubStart);
  range.addEventListener('input', function () {
    scrubStart();
    if (!scrubSpan) return;
    // Show where the drag is, but only seek when it is let go.
    const at = Number(range.value) * 1000;
    drawScrub(scrubSpan, at);
  });
  range.addEventListener('change', function () {
    const span = scrubSpan || chapterSpan(player.state());
    scrubbing = false;
    scrubSpan = null;
    if (span) player.seek(span.start + Number(range.value) * 1000);
    render(player.state());
  });
  ['pointerup', 'pointercancel', 'blur'].forEach(function (type) {
    range.addEventListener(type, function () {
      // A release that changed nothing sends no change event.
      setT(function () { if (scrubbing) scrubEnd(); }, 0);
    });
  });
  range.addEventListener('keydown', function (e) {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    // One skip a press: a held key does not run on to the book's end (its
    // repeats are still kept from the range's own stepping).
    if (e.repeat) return;
    // By the skip length, not a second at a time.
    let n = 10;
    try {
      n = num(player.setSkip()) || 10;
    } catch (err) { /* the default */ }
    player.skip(step * n);
  });

  // ---- Controls ----

  // A retry reopens the book at a place, which can be one it no longer has.
  function retryFailed(err) {
    if (err && err.name === 'UnknownTrack') notify(RESUME_LOST, { id: 'resume-lost' });
    else logError(err);
  }

  function guarded(fn) {
    return function () {
      let r;
      try {
        r = fn();
      } catch (err) {
        retryFailed(err);
        return;
      }
      if (r && typeof r.catch === 'function') r.catch(retryFailed);
    };
  }

  // Held for the book's changed files, the bar's Play opens the full player,
  // where the listener finds their place (a Play there previews it); held
  // for the safety net's question, where it is asked.
  // Playing a preview (it reads Pause) or reading the saved places, it is
  // the toggle as ever.
  const miniPlay = guarded(function () {
    const s = player.state();
    if (s && s.book && (s.safetyNet || (s.filesChanged && !s.playing && !s.checking))) {
      open();
      return null;
    }
    return player.toggle();
  });
  barPlay.addEventListener('click', miniPlay);
  pillPlay.addEventListener('click', miniPlay);
  pillOpen.addEventListener('click', function () {
    if (popped) bringBack();
    else if (isOpen && windowed) close();
    else open();
  });
  fullPlay.addEventListener('click', guarded(function () { return player.toggle(); }));
  full.addEventListener('keydown', onKey);
  backBtn.addEventListener('click', function () { player.skip(-(num(player.setSkip()) || 10)); });
  fwdBtn.addEventListener('click', function () { player.skip(num(player.setSkip()) || 10); });
  openBtn.addEventListener('click', function () { open(); });
  closeBtn.addEventListener('click', function () { close(); });

  // ---- Open and close ----

  function emit(type) {
    handlers[type].forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        logError(e);
      }
    });
  }

  function dialogOpen() {
    try {
      return !!(env.isDialogOpen && env.isDialogOpen());
    } catch (e) {
      return false;
    }
  }

  function focusables() {
    return Array.prototype.slice.call(full.querySelectorAll(FOCUSABLE)).filter(isVisible);
  }

  // The innermost layer first: a panel over the player, then the player. A
  // layer with a CloseWatcher is closed by the browser's own close request,
  // which this Escape becomes unless it is cancelled here.
  function escapeInnermost(e) {
    const panelUp = view !== null && !matches(WIDE);
    if (panelUp ? panelWatcher : watcher) return;
    e.preventDefault();
    if (panelUp) hidePanel(view);
    else close();
  }

  // While the full player is open, on document in the capture phase: a key
  // whose target is outside it (focus left on the page, as a click on the
  // cover in Chrome or on any button in Safari leaves it) is still the
  // player's. It never reaches the page's own keys; Escape closes the
  // innermost layer, Tab comes back inside.
  function onDocKey(e) {
    if (!isOpen || dialogOpen() || full.contains(e.target)) return;
    e.stopPropagation();
    if (e.defaultPrevented) return;
    if (e.key === 'Escape' && !e.isComposing) {
      escapeInnermost(e);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const f = focusables();
      if (f.length) (e.shiftKey ? f[f.length - 1] : f[0]).focus();
    }
  }

  // The features' shortcuts (features.js): keys pressed in the player.
  function runKeys(e) {
    keyFns.forEach(function (fn) {
      try {
        fn(e);
      } catch (err) {
        logError(err);
      }
    });
  }

  // On the full player itself: a key pressed in it is the player's, and never
  // reaches the page under it (a reader's Space and arrows turn its pages).
  function onKey(e) {
    if (!isOpen) return;
    e.stopPropagation();
    if (dialogOpen() || e.defaultPrevented) return;
    if (windowed) {
      // The window: Escape sends it back to the top bar (in its own window
      // it stays), Tab goes on through the page, other keys are the
      // features' shortcuts.
      if (e.key === 'Escape' && !e.isComposing) {
        if (docked) return;
        e.preventDefault();
        close();
      } else if (e.key !== 'Tab') {
        runKeys(e);
      }
      return;
    }
    if (e.key === 'Escape' && !e.isComposing) {
      escapeInnermost(e);
      return;
    }
    if (e.key !== 'Tab') {
      runKeys(e);
      return;
    }
    const f = focusables();
    if (!f.length) {
      e.preventDefault();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const a = doc.activeElement;
    // Focus on the sheet itself (a tap on the cover) is outside the controls.
    if (!full.contains(a) || a === sheet) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && a === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && a === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Focus that escapes anyway (assistive tech, a click behind) comes back.
  function onFocusIn(e) {
    if (!isOpen || dialogOpen() || full.contains(e.target)) return;
    const f = focusables();
    if (f.length) f[0].focus();
  }

  function finishClose() {
    if (!closing) return;
    clearT(closing.timer);
    sheet.removeEventListener('transitionend', closing.onEnd);
    closing = null;
    full.hidden = true;
    root.removeAttribute('data-player-full');
    if (windowed) {
      windowed = false;
      shapeWindow(false);
    }
    syncHost();
  }

  function tickClock() {
    clockTimer = null;
    if (!isOpen) return;
    if (lastState) drawTime(lastState);
    clockTimer = setT(tickClock, CLOCK_MS);
  }

  // ---- The desktop window ----

  // The window, rather than the sheet: a desktop page whose top bar shows
  // (and holds the pill), not a full-screen view such as the reader.
  function windowable() {
    return !!pillSlot && matches(WIDE) && root.getAttribute('data-shell') !== 'hidden';
  }

  // The same element as the sheet, dressed as a window or back.
  function shapeWindow(on) {
    full.classList.toggle('is-window', on);
    setAttr(full, 'role', on ? 'region' : 'dialog');
    setAttr(full, 'aria-modal', on ? null : 'true');
    setAttr(full, 'aria-labelledby', on ? null : 'wspTitle');
    setAttr(full, 'aria-label', on ? 'Audiobook player' : null);
    setAttr(title, 'tabindex', on ? '-1' : null);
    setHidden(closeBtn, on);
    [grip, popBtn, winSep, winCloseBtn, resizeBtn].forEach(function (b) { setHidden(b, !on); });
    drawWindowChrome();
    if (!on) {
      full.classList.remove('is-pip', 'is-opening', 'is-closing', 'is-moving');
      ['left', 'top', 'width', 'height', 'maxHeight'].forEach(function (k) { full.style[k] = ''; });
    }
    drawPanels();
  }

  // In a window of its own there is nothing to move, size or pop, and that
  // window's own close brings the player back to the pill.
  function drawWindowChrome() {
    const free = windowed && !docked;
    [grip, winCloseBtn, resizeBtn].forEach(function (b) { setHidden(b, !free); });
    setHidden(popBtn, !free || !popOutFn);
    setHidden(winSep, !free);
  }

  function storeKey() {
    let id = '';
    try {
      id = String((env.identity && env.identity()) || '');
    } catch (e) { /* none */ }
    return WIN_KEY + (id ? ':' + id : '');
  }

  // Where the listener left it, on this device; {} when nothing is kept (or
  // storage is off: a private window simply forgets).
  let geo = null;
  function readGeo() {
    if (geo) return geo;
    geo = {};
    try {
      const raw = env.storage ? env.storage.getItem(storeKey()) : null;
      const v = raw ? JSON.parse(raw) : null;
      if (v && typeof v === 'object') ['x', 'y', 'w', 'h'].forEach(function (k) { if (given(v[k])) geo[k] = v[k]; });
    } catch (e) { /* not remembered */ }
    return geo;
  }
  function saveGeo() {
    try {
      if (env.storage) env.storage.setItem(storeKey(), JSON.stringify(readGeo()));
    } catch (e) { /* not remembered */ }
  }

  function viewport() {
    if (env.viewport) return env.viewport();
    return { w: root.clientWidth || 0, h: root.clientHeight || 0 };
  }
  function topLimit() {
    if (env.topLimit) return num(env.topLimit());
    const hdr = doc.getElementById('appHeader');
    const b = hdr ? hdr.getBoundingClientRect().bottom : 0;
    return Math.max(0, b) + WIN_GAP;
  }

  // Puts it where it belongs: the kept place and size, inside the viewport.
  function placeWindow() {
    if (!isOpen || !windowed || docked) return null;
    const vp = viewport();
    vp.top = topLimit();
    const g = readGeo();
    const collapsed = view === null;
    let r = fitWindow(g, vp, collapsed ? 0 : null);
    full.style.width = r.w + 'px';
    full.style.maxHeight = r.room + 'px';
    if (collapsed) {
      full.style.height = '';
      r = fitWindow(g, vp, num(measure(full)));
    } else {
      full.style.height = r.h + 'px';
    }
    full.style.left = r.x + 'px';
    full.style.top = r.y + 'px';
    return r;
  }

  function onViewport() {
    if (!winDrag) placeWindow();
  }

  function watchWindow(on) {
    const w = env.win || doc.defaultView;
    if (!w || typeof w.addEventListener !== 'function') return;
    if (on && !winWatch) {
      winWatch = onViewport;
      w.addEventListener('resize', winWatch);
    } else if (!on && winWatch) {
      w.removeEventListener('resize', winWatch);
      winWatch = null;
    }
  }

  // Its height follows its content while no panel is open (a prompt, the
  // warning): kept on screen as it grows.
  if (typeof env.ResizeObserver === 'function') {
    try {
      new env.ResizeObserver(function () { if (windowed && !winDrag && view === null) placeWindow(); }).observe(full);
    } catch (e) { /* placed on each change instead */ }
  }

  // ---- Moving and sizing it ----

  function startDrag(kind, e) {
    if (!windowed || docked || winDrag || (e.button !== undefined && e.button > 0)) return;
    const r = placeWindow();
    if (!r) return;
    winDrag = { kind: kind, id: e.pointerId, x0: e.clientX, y0: e.clientY, from: r, el: e.currentTarget };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) { /* moves still arrive while over it */ }
    full.classList.add('is-moving');
    e.preventDefault();
  }

  function moveDrag(e) {
    const d = winDrag;
    if (!d || e.pointerId !== d.id) return;
    const g = readGeo();
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (d.kind === 'move') {
      g.x = d.from.x + dx;
      g.y = d.from.y + dy;
    } else {
      g.w = d.from.w + dx;
      if (view !== null) g.h = d.from.h + dy;
    }
    keepPlaced();
  }

  function endWinDrag(e) {
    const d = winDrag;
    if (!d || (e && e.pointerId !== d.id)) return;
    winDrag = null;
    full.classList.remove('is-moving');
    saveGeo();
  }

  // What was applied is what is kept, so the limits stick.
  function keepPlaced() {
    const r = placeWindow();
    if (!r) return;
    const g = readGeo();
    if (given(g.x)) g.x = r.x;
    if (given(g.y)) g.y = r.y;
    if (given(g.w)) g.w = r.w;
    if (given(g.h) && view !== null) g.h = r.h;
  }

  topBar.addEventListener('pointerdown', function (e) {
    const t = e.target;
    if (!windowed || !t || !t.closest) return;
    // Its buttons are buttons; the grip and the bar itself move it.
    const b = t.closest('button');
    if (b && b !== grip) return;
    startDrag('move', e);
  });
  resizeBtn.addEventListener('pointerdown', function (e) { startDrag('size', e); });
  [topBar, resizeBtn].forEach(function (n) {
    n.addEventListener('pointermove', moveDrag);
    n.addEventListener('pointerup', endWinDrag);
    n.addEventListener('pointercancel', endWinDrag);
  });

  function arrowStep(e) {
    const step = e.shiftKey ? WIN_STEP_BIG : WIN_STEP;
    return { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] || null;
  }

  grip.addEventListener('keydown', function (e) {
    if (!windowed || docked || e.altKey || e.ctrlKey || e.metaKey) return;
    const g = readGeo();
    const d = arrowStep(e);
    if (e.key === 'Home') {
      delete g.x;
      delete g.y;
    } else if (d) {
      const r = placeWindow();
      if (!r) return;
      g.x = r.x + d[0];
      g.y = r.y + d[1];
    } else {
      return;
    }
    e.preventDefault();
    keepPlaced();
    saveGeo();
  });

  resizeBtn.addEventListener('keydown', function (e) {
    if (!windowed || docked || e.altKey || e.ctrlKey || e.metaKey) return;
    const d = arrowStep(e);
    if (!d) return;
    e.preventDefault();
    const r = placeWindow();
    if (!r) return;
    const g = readGeo();
    g.w = r.w + d[0];
    if (view !== null) g.h = r.h + d[1];
    keepPlaced();
    saveGeo();
  });

  // The window's X: back to the pill, as Escape does; the book plays on.
  winCloseBtn.addEventListener('click', function () { close(); });
  popBtn.addEventListener('click', function () {
    if (popOutFn) safely(popOutFn)();
  });

  // The pill's Stop: the book closes, playing or paused (its last save goes
  // as it does), with a way back to the same place.
  pillStop.addEventListener('click', function () {
    const s = player.state();
    if (!s || !s.book || s.loading || s.checking) return;
    const key = s.book;
    const held = !!(s.filesChanged || s.safetyNet);
    const msg = held ? 'Stopped. Your place is as it was.' : 'Stopped at ' + formatClock(s.bookMs) + '. Your place is saved.';
    notify(msg, {
      id: 'stopped',
      action: { label: 'Resume', run: guarded(function () { return player.open(key, { autoplay: true }); }) }
    });
    const stopped = notices.get('stopped');
    player.close();
    if (isOpen) close();
    // The pill has gone with the book: focus to Resume.
    const resume = stopped && stopped.el.querySelector('.wsp-notice-btn');
    if (resume && resume.isConnected) resume.focus({ preventScroll: true });
  });

  // ---- Its own window (popout.js) ----

  // The window into a Picture-in-Picture document (it must be open in the
  // page): the same nodes, so every control, panel and prompt goes with it;
  // the audio stays in this tab. end() closes that window.
  function dock(pdoc, end) {
    if (!isOpen || !windowed || docked || !pdoc || !pdoc.body) return false;
    endWinDrag();
    watchWindow(false);
    const holder = pdoc.createElement('div');
    holder.id = 'wsPlayer';
    holder.className = 'wsp-pip-host';
    pdoc.body.appendChild(holder);
    ['left', 'top', 'width', 'height', 'maxHeight'].forEach(function (k) { full.style[k] = ''; });
    full.classList.remove('is-opening', 'is-closing');
    full.classList.add('is-pip');
    holder.appendChild(full);
    docked = { doc: pdoc, holder: holder };
    popped = { kind: 'docked', end: typeof end === 'function' ? end : function () {} };
    drawWindowChrome();
    if (lastState) drawPill(lastState);
    try {
      title.focus({ preventScroll: true });
    } catch (e) { /* not focusable there yet */ }
    return true;
  }

  // Back from it: into the page, open (stay) or minimised to the pill.
  function undock(stay) {
    if (!docked) return;
    const d = docked;
    docked = null;
    popped = null;
    full.classList.remove('is-pip');
    host.insertBefore(full, bar.nextSibling);
    if (d.holder.parentNode) d.holder.parentNode.removeChild(d.holder);
    drawWindowChrome();
    if (stay && isOpen) {
      placeWindow();
      watchWindow(true);
      try {
        title.focus({ preventScroll: true });
      } catch (e) { /* not focusable */ }
    } else if (isOpen) {
      close();
    }
    if (lastState) drawPill(lastState);
  }

  // A window of its own plays the tab (remote control): the window here
  // closes and the pill says so; end() closes that one. null: it ended.
  function setPopped(end) {
    if (docked) return;
    popped = typeof end === 'function' ? { kind: 'remote', end: end } : null;
    if (popped && isOpen) close();
    if (lastState) drawPill(lastState);
  }

  // The pill pressed while it plays elsewhere: the player comes back here.
  function bringBack() {
    const p = popped;
    if (!p) return;
    if (docked) {
      undock(true);
    } else {
      popped = null;
      open();
    }
    safely(p.end)();
    if (lastState) drawPill(lastState);
  }

  // Its own window is the size of this one; with a panel open it wants room.
  function windowRect() {
    const r = isOpen && windowed && !docked ? full.getBoundingClientRect() : null;
    return { w: r && r.width ? Math.round(r.width) : WIN.w, h: r && r.height ? Math.round(r.height) : WIN.minH - 80 };
  }

  // In its own window, a panel opening asks for the height to show it.
  function fitDocked() {
    if (!docked || view === null) return;
    const w = docked.doc.defaultView;
    try {
      if (w && w.innerHeight < WIN.minH && typeof w.resizeTo === 'function') w.resizeTo(w.outerWidth, w.outerHeight + (WIN.minH - w.innerHeight));
    } catch (e) { /* the browser decides */ }
  }

  // ---- Open and close ----

  function open() {
    if (!barShown) return false;
    // Playing in a remote window: the player comes back into the page.
    if (popped && !docked) {
      const p = popped;
      popped = null;
      safely(p.end)();
    }
    if (closing) {
      clearT(closing.timer);
      sheet.removeEventListener('transitionend', closing.onEnd);
      closing = null;
      if (windowed && !windowable()) {
        windowed = false;
        shapeWindow(false);
      }
    }
    if (isOpen) return true;
    isOpen = true;
    if (!windowed) {
      windowed = windowable();
      if (windowed) shapeWindow(true);
    }
    lastFocus = doc.activeElement;
    openedAt = address();
    full.hidden = false;
    alerts.appendChild(noticeBox);
    if (windowed) {
      full.classList.remove('is-closing');
      full.classList.add('is-open');
      syncHost();
      render(player.state());
      placeWindow();
      watchWindow(true);
      if (winAnim !== null) clearT(winAnim);
      full.classList.remove('is-opening');
      void full.offsetWidth;
      full.classList.add('is-opening');
      winAnim = setT(function () {
        winAnim = null;
        full.classList.remove('is-opening');
      }, WIN_IN_MS + 50);
      centreCurrent();
      syncScroll();
      if (clockTimer === null) clockTimer = setT(tickClock, CLOCK_MS);
      try {
        title.focus({ preventScroll: true });
      } catch (e) { /* not focusable */ }
      emit('open');
      return true;
    }
    root.setAttribute('data-player-full', '');
    bar.setAttribute('inert', '');
    setAttr(openBtn, 'aria-expanded', 'true');
    syncHost();
    // The closed place is drawn first, so the slide runs from it.
    if (motion()) void sheet.offsetWidth;
    full.classList.add('is-open');
    doc.addEventListener('focusin', onFocusIn);
    doc.addEventListener('keydown', onDocKey, true);
    watcher = watch(function () {
      watcher = null;
      close();
    });

    render(player.state());
    centreCurrent();
    syncScroll();
    if (clockTimer === null) clockTimer = setT(tickClock, CLOCK_MS);
    closeBtn.focus({ preventScroll: true });
    watcherTap = !!watcher;
    try {
      emit('open');
    } finally {
      watcherTap = false;
    }
    return true;
  }

  function close() {
    if (!isOpen) return;
    // In its own window: that window goes, and the player comes back here.
    if (docked) {
      const p = popped;
      docked.holder.parentNode && docked.holder.parentNode.removeChild(docked.holder);
      docked = null;
      popped = null;
      full.classList.remove('is-pip');
      host.insertBefore(full, bar.nextSibling);
      drawWindowChrome();
      if (p) safely(p.end)();
    }
    const focusIn = full.contains(doc.activeElement) || doc.activeElement === doc.body || !doc.activeElement;
    isOpen = false;
    // Whatever closed it, its watchers go (a watcher the browser just closed
    // is gone already).
    const w = watcher;
    const pw = panelWatcher;
    watcher = null;
    panelWatcher = null;
    panelTapped = false;
    unwatch(pw);
    unwatch(w);
    endDrag();
    endWinDrag();
    watchWindow(false);
    full.classList.remove('is-open');
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('keydown', onDocKey, true);
    if (clockTimer !== null) {
      clearT(clockTimer);
      clockTimer = null;
    }
    bar.removeAttribute('inert');
    setAttr(openBtn, 'aria-expanded', 'false');
    host.appendChild(noticeBox);
    const was = view;
    view = null;
    panelFrom = null;
    drawPanels();
    left(was);
    if (windowed) {
      // A short fade back towards the top bar (opacity only with reduced
      // motion), then gone. Focus goes to the pill when it was in the window.
      if (winAnim !== null) {
        clearT(winAnim);
        winAnim = null;
      }
      full.classList.remove('is-opening');
      full.classList.add('is-closing');
      closing = { timer: setT(finishClose, WIN_OUT_MS), onEnd: null };
      lastFocus = null;
      if (lastState) drawPill(lastState);
      if (focusIn) {
        // The narrowest top bar has no cover to open the window: Play then.
        const back = pillOnScreen() ? (isVisible(pillOpen) ? pillOpen : pillPlay) : fallbackFocus();
        if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
      }
      emit('close');
      return;
    }
    // The top bar and the page stay under the sheet until it has slid away.
    closing = { timer: null, onEnd: null };
    closing.onEnd = function (e) {
      if (e.target === sheet && e.propertyName === 'transform') finishClose();
    };
    if (motion()) {
      sheet.addEventListener('transitionend', closing.onEnd);
      closing.timer = setT(finishClose, SLIDE_MS + 100);
    } else {
      finishClose();
    }
    let back = lastFocus && lastFocus.isConnected && lastFocus !== doc.body && !full.contains(lastFocus) &&
      !lastFocus.closest('[inert]') ? lastFocus : openBtn;
    lastFocus = null;
    // Not where it was if that is gone from view (the bar, when the book
    // closed or failed to open): an error's Retry, else the page.
    if (!isVisible(back)) back = fallbackFocus();
    if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
    emit('close');
  }

  function fallbackFocus() {
    const retry = noticeBox.querySelector('.wsp-notice.is-err .wsp-notice-btn') || noticeBox.querySelector('.wsp-notice-btn');
    if (retry && isVisible(retry)) return retry;
    const target = doc.querySelector('#wsPage h1') || doc.querySelector('main');
    if (target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    return target;
  }

  // ---- Swipe down to close ----

  function endDrag() {
    drag = null;
    sheet.classList.remove('is-dragging');
    sheet.style.transform = '';
  }

  // A tap on the sheet outside anything focusable (the cover, the title, the
  // times) keeps focus in the player, so its keys stay its own.
  sheet.addEventListener('pointerdown', function (e) {
    const t = e.target;
    if (!isOpen || !t || !t.closest || t.closest(FOCUSABLE)) return;
    try {
      sheet.focus({ preventScroll: true });
    } catch (err) { /* not focusable here */ }
  });
  sheet.addEventListener('pointerdown', function (e) {
    if (!isOpen || windowed || drag || (e.button !== undefined && e.button > 0)) return;
    const t = e.target;
    if (!t || !t.closest || !t.closest('[data-swipe]') || t.closest('button, input, a, [data-no-swipe]')) return;
    drag = { id: e.pointerId, y0: e.clientY, dy: 0, moving: false, samples: [[now(), e.clientY]] };
    try {
      sheet.setPointerCapture(e.pointerId);
    } catch (err) { /* moves still arrive while over the sheet */ }
  });
  sheet.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.y0);
    drag.samples.push([now(), e.clientY]);
    if (drag.samples.length > 6) drag.samples.shift();
    if (!drag.moving && drag.dy > 6) {
      drag.moving = true;
      sheet.classList.add('is-dragging');
    }
    if (drag.moving) sheet.style.transform = 'translateY(' + Math.round(drag.dy) + 'px)';
  });
  function release(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    // The release is a sample too: a drag held still before letting go is
    // no flick, however fast it moved earlier.
    const end = [now(), typeof e.clientY === 'number' ? e.clientY : d.y0 + d.dy];
    const dy = Math.max(0, end[1] - d.y0);
    let from = null;
    for (const s of d.samples) {
      if (end[0] - s[0] <= FLING_WINDOW_MS) {
        from = s;
        break;
      }
    }
    if (!from) from = d.samples[d.samples.length - 1];
    const v = end[0] > from[0] ? (end[1] - from[1]) / (end[0] - from[0]) : 0;
    if (!cancelled && d.moving && (dy >= SWIPE_CLOSE_PX || (v >= SWIPE_FLING && dy >= FLING_MIN_PX))) {
      // Let the slide carry on from where the finger left it.
      drag = null;
      sheet.classList.remove('is-dragging');
      sheet.style.transform = '';
      close();
    } else {
      endDrag();
    }
  }
  sheet.addEventListener('pointerup', function (e) { release(e, false); });
  sheet.addEventListener('pointercancel', function (e) { release(e, true); });

  // ---- The engine ----

  player.on('change', function (d) {
    try {
      render(d && d.state ? d.state : player.state());
    } catch (e) {
      logError(e);
    }
  });
  player.on('warning', function (w) {
    if (!w) return;
    if (w.kind === 'not-saved') setWarn(w.active ? w.message : '');
    else if (w.kind === 'part-skipped' || w.kind === 'resume-lost' || w.kind === 'part-format') notify(w.message, { id: w.kind });
  });
  // The error's Retry while the safety net's question is open: it would play
  // nothing, so it waits like a busy prompt's buttons (aria-disabled, dimmed)
  // and comes back to life when the question is answered.
  function drawRetry(held) {
    if (held === retryHeld) return;
    retryHeld = held;
    if (errorNote && errorNote.shown) errorNote.update({ busy: held });
  }

  player.on('error', function (e) {
    if (!e) return;
    let action = null;
    if (typeof e.retry === 'function') action = { label: 'Retry', run: guarded(e.retry) };
    else if (e.code === 'signed-out' && typeof env.leaveTo === 'function') action = { label: 'Sign in', run: function () { env.leaveTo('/login'); } };
    errorNote = notify(e.message, { tone: 'err', id: 'error', duration: 0, action: action });
    let held = false;
    try {
      const s = player.state();
      held = !!(s && s.safetyNet);
    } catch (err) { /* not held */ }
    if (action && held) errorNote.update({ busy: true });
    retryHeld = held;
  });

  // Where the address is now: the router's (location), as it records a page's
  // address before the page mounts.
  function address() {
    try {
      return (typeof location !== 'undefined' && location ? location : win.location).href;
    } catch (e) {
      return '';
    }
  }

  function withoutHash(u) {
    try {
      const x = new URL(u, address() || undefined);
      x.hash = '';
      return x.href;
    } catch (e) {
      return String(u || '');
    }
  }

  // The width at which a panel sits beside the player: on a change (a turned
  // phone) the panel's watcher is made or dropped to match.
  try {
    const wideQuery = env.matchMedia && env.matchMedia(WIDE);
    if (wideQuery && typeof wideQuery.addEventListener === 'function') wideQuery.addEventListener('change', onWideChange);
    else if (wideQuery && typeof wideQuery.addListener === 'function') wideQuery.addListener(onWideChange);
  } catch (e) { /* no media queries: nothing turns */ }

  // A new page, or a page's own new view (the wiki's), shown while the full
  // player is open (Back where no CloseWatcher takes it, a link): the player
  // makes way for it.
  const win = env.win || doc.defaultView;
  if (win && typeof win.addEventListener === 'function') {
    ['ws:page-mounted', 'ws:page-claimed'].forEach(function (type) {
      win.addEventListener(type, function (e) {
        // A page mounts after its first fetches: one the player was opened
        // over (tapped while it loaded) is the page it opened on.
        const url = e && e.detail && e.detail.url;
        if (!isOpen) return;
        // The window stays open from page to page (in its own window it is
        // no page's); a full-screen view (the reader) is the sheet's.
        if (windowed) {
          if (!docked && !windowable()) close();
          return;
        }
        if (!url || withoutHash(url) !== withoutHash(openedAt)) close();
      });
    });
  }

  render(player.state());

  return {
    open: open,
    close: close,
    isOpen: function () { return isOpen; },
    // The open player is the floating window (desktop), not a modal sheet:
    // keys on the page are still the page's (features.js).
    isWindow: function () { return isOpen && windowed; },
    // Pop out (popout.js): fn() runs from the window's Pop out press.
    popOut: function (fn) {
      popOutFn = typeof fn === 'function' ? fn : null;
      drawWindowChrome();
    },
    dock: dock,
    undock: undock,
    setPopped: setPopped,
    popped: function () { return popped ? popped.kind : null; },
    windowRect: windowRect,
    notify: notify,
    prompt: prompt,
    slot: slot,
    fill: fill,
    clear: clear,
    actionButton: actionButton,
    panel: panel,
    on: function (type, fn) {
      const set = handlers[type];
      if (!set || typeof fn !== 'function') return function () {};
      set.add(fn);
      return function () { set.delete(fn); };
    },
    onKey: function (fn) {
      if (typeof fn !== 'function') return function () {};
      keyFns.add(fn);
      return function () { keyFns.delete(fn); };
    }
  };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/* Builds the UI in #wsPlayer as WS.playerUI, once per document, for the
   engine booted before it (WS.player). Returns it, or null on a page without
   the player. */
export function boot(win, overrides) {
  const WS = win.WS || (win.WS = {});
  if (WS.playerUI) return WS.playerUI;
  const doc = win.document;
  const host = doc.getElementById('wsPlayer');
  const player = (overrides && overrides.player) || WS.player;
  if (!host || !player) return null;
  const ui = createUI(Object.assign({
    doc: doc,
    host: host,
    player: player,
    matchMedia: typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null,
    now: Date.now,
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    ResizeObserver: win.ResizeObserver || null,
    isDialogOpen: function () { return !!(win.WSUI && win.WSUI.isDialogOpen && win.WSUI.isDialogOpen()); },
    win: win,
    CloseWatcher: typeof win.CloseWatcher === 'function' ? win.CloseWatcher : null,
    // Where the browser cannot say, a watcher is made anyway.
    hasActivation: function () {
      const ua = win.navigator && win.navigator.userActivation;
      return !ua || !!ua.isActive;
    },
    leaveTo: function (url) {
      if (WS.leaveTo) WS.leaveTo(url);
      else win.location.href = url;
    },
    storage: (function () {
      try {
        return win.localStorage || null;
      } catch (e) {
        return null;
      }
    })(),
    identity: function () {
      const u = WS.user;
      return u && typeof u.identity_key === 'string' ? u.identity_key : '';
    }
  }, overrides || {}));
  WS.playerUI = ui;
  return ui;
}

if (typeof window !== 'undefined' && window.document) boot(window);
