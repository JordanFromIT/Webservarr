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
 * opens the full player.
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
 *   prompt({ message, actions: [{ label, run, primary }], id }) -> { remove() }
 *       A question in the same place (handoff, up next): stays until one of
 *       its buttons is pressed (which removes it, then runs run) or
 *       remove(). id defaults to 'prompt', so a new prompt replaces the last.
 *   slot(name)        the element of a slot: 'menu' (the full player's top
 *                     right), 'speed', 'sleep', 'history' (its row of actions)
 *   fill(name, node)  puts node in the slot and shows it; clear(name) empties
 *                     and hides it again. A slot is hidden until it is filled.
 *   actionButton({ icon, text, label }) -> <button>
 *                     a button styled for the row of actions: an icon (or a
 *                     short text such as "1.5×") over its label
 *   panel(name, { title }) -> { body, show(), hide(), shown }
 *                     a view of the full player like Chapters: beside the
 *                     player on a wide screen, over it (with a back button)
 *                     on a phone. body is where its content goes.
 *   open(), close(), isOpen()        the full player
 *   on('open' | 'close', fn) -> unsubscribe
 */

export const SWIPE_CLOSE_PX = 120;     // a swipe down this far closes the full player
export const SWIPE_FLING = 0.6;        // or a flick this fast (px per ms)
export const SLIDE_MS = 250;           // the full player's slide
export const NOTICE_MS = 5000;
export const NOTICE_ERR_MS = 7000;
export const ACTION_EXTRA_MS = 4000;   // more time to reach a notice's button
export const MAX_NOTICES = 3;
export const CLOCK_MS = 30000;         // the "finishes around" clock, while paused
export const SLOTS = ['menu', 'speed', 'sleep', 'history'];

const WIDE = '(min-width: 1024px)';
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

// ---------------------------------------------------------------------------
// The UI
// ---------------------------------------------------------------------------

/* env: { doc, host (#wsPlayer), player (WS.player), matchMedia(query),
   measure(el) -> px, isVisible(el), now(), setTimeout, clearTimeout,
   ResizeObserver, isDialogOpen(), leaveTo(url) }. */
export function createUI(env) {
  const doc = env.doc;
  const host = env.host;
  const player = env.player;
  const root = doc.documentElement;
  const setT = env.setTimeout;
  const clearT = env.clearTimeout;
  const now = env.now || Date.now;
  const measure = env.measure || function (el) { return el.getBoundingClientRect().height; };
  const isVisible = env.isVisible || function (el) {
    return !el.closest('[hidden]') && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  };
  const handlers = { open: new Set(), close: new Set() };

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
  let lastFocus = null;        // focus before the full player opened
  let closing = null;          // { timer, onEnd } while the slide down runs
  let drag = null;             // a swipe: { id, y0, dy, moving, samples: [[t, y]] }
  let view = null;             // the panel shown over the player (phone) or beside it (wide)
  let panelFrom = null;        // what showed it, for focus on the way back

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
  const bar = h('section', { class: 'wsp-bar', 'aria-label': 'Audiobook player', hidden: true }, [
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
    slots[name] = h('div', { class: 'wsp-slot wsp-slot-' + name, 'data-slot': name, hidden: true });
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
  const chaptersSlot = h('div', { class: 'wsp-slot', hidden: true }, [chaptersBtn]);
  const main = h('div', { class: 'wsp-main' }, [
    fullArt.frame,
    h('div', { class: 'wsp-meta', 'data-swipe': '' }, [series, title, byline]),
    fullWarn,
    h('div', { class: 'wsp-scrub' }, [
      chapLabel,
      range,
      h('div', { class: 'wsp-times' }, [elapsed, remaining])
    ]),
    leftLine,
    h('div', { class: 'wsp-controls' }, [backBtn, fullPlay, fwdBtn]),
    h('div', { class: 'wsp-actions' }, [slots.speed, chaptersSlot, slots.sleep, slots.history])
  ]);
  const side = h('div', { class: 'wsp-side' });
  const noticeBox = h('div', { class: 'wsp-notices', 'aria-live': 'polite' });
  const sheet = h('div', { class: 'wsp-sheet' }, [
    h('div', { class: 'wsp-ambient', 'aria-hidden': 'true' }, [ambientImg]),
    h('div', { class: 'wsp-top', 'data-swipe': '' }, [
      h('span', { class: 'wsp-grab', 'aria-hidden': 'true' }),
      closeBtn,
      h('span', { class: 'wsp-top-label', text: 'Now playing' }),
      slots.menu
    ]),
    h('div', { class: 'wsp-body' }, [main, side])
  ]);
  const full = h('div', { class: 'wsp-full', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wspTitle', hidden: true }, [sheet]);

  host.appendChild(bar);
  host.appendChild(full);
  host.appendChild(noticeBox);

  // ---- Panels ----

  const panels = new Map();   // name -> { section, body, heading, api }

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
      show: function () { showPanel(name); },
      hide: function () { hidePanel(name); },
      get shown() { return view === name; }
    };
    panels.set(name, { section: section, body: body, heading: heading, api: api });
    drawPanels();
    return api;
  }

  function drawPanels() {
    const many = chapterCount() > 1;
    const shown = view || (many ? 'chapters' : null);
    panels.forEach(function (p, name) { setHidden(p.section, name !== shown); });
    setAttr(full, 'data-view', view);
    setAttr(full, 'data-side', shown ? '' : null);
  }

  function showPanel(name) {
    if (!panels.has(name)) return;
    panelFrom = doc.activeElement;
    view = name;
    drawPanels();
    if (name === 'chapters') centreCurrent();
    const p = panels.get(name);
    try {
      p.heading.focus({ preventScroll: true });
    } catch (e) { /* not focusable yet */ }
  }

  function hidePanel(name) {
    if (name && view !== name) return;
    if (view === null) return;
    view = null;
    drawPanels();
    const back = panelFrom;
    panelFrom = null;
    if (isOpen && back && back.isConnected && full.contains(back) && isVisible(back)) back.focus({ preventScroll: true });
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
  chaptersBtn.addEventListener('click', function () { showPanel('chapters'); });

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
    el.appendChild(h('p', { class: 'wsp-notice-text', text: String(message == null ? '' : message) }));
    let timer = null;
    let gone = false;
    const entry = { el: el, sticky: false, remove: remove };
    function remove() {
      if (gone) return;
      gone = true;
      if (timer !== null) clearT(timer);
      const hadFocus = el.contains(doc.activeElement);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (id && notices.get(id) === entry) notices.delete(id);
      const at = order.indexOf(entry);
      if (at !== -1) order.splice(at, 1);
      syncHost();
      if (hadFocus) {
        const back = isOpen ? fullPlay : (barShown ? barPlay : null);
        if (back) back.focus({ preventScroll: true });
      }
    }
    const actions = (o.actions || []).filter(function (a) { return a && a.label; });
    if (actions.length) {
      const row = h('div', { class: 'wsp-notice-actions' });
      actions.forEach(function (a) {
        const b = h('button', { type: 'button', class: 'wsp-notice-btn' + (a.primary ? ' is-primary' : ''), text: String(a.label) });
        b.addEventListener('click', function () {
          remove();
          if (typeof a.run === 'function') safely(a.run)();
        });
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
    return { remove: remove, get shown() { return !gone; } };
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
    syncHost();
    measureBar();
  }

  if (typeof env.ResizeObserver === 'function') {
    try {
      new env.ResizeObserver(function () { measureBar(); }).observe(bar);
    } catch (e) { /* measured on each change of shape instead */ }
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
  }

  // ---- Drawing ----

  function playing(s) { return !!(s && s.playing); }

  function drawPlay(btn, s) {
    const busy = !!(s.loading && s.playing);
    const name = busy ? 'progress_activity' : playing(s) ? 'pause' : 'play_arrow';
    const label = busy ? 'Loading' : playing(s) ? 'Pause' : 'Play';
    const ic = btn.firstChild;
    setText(ic, name);
    ic.classList.toggle('wsp-spin', busy);
    setAttr(btn, 'aria-label', label);
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
    drawSkip();
    drawTime(s);
    if (!s.saveError) setWarn('');
    if (!s.error) dropNotice('error');
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
    // By the skip length, not a second at a time.
    let n = 10;
    try {
      n = num(player.setSkip()) || 10;
    } catch (err) { /* the default */ }
    player.skip(step * n);
  });

  // ---- Controls ----

  barPlay.addEventListener('click', safely(function () { return player.toggle(); }));
  fullPlay.addEventListener('click', safely(function () { return player.toggle(); }));
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

  function onKey(e) {
    if (!isOpen || dialogOpen() || e.defaultPrevented) return;
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) {
      e.preventDefault();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const a = doc.activeElement;
    if (!full.contains(a)) {
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
    syncHost();
  }

  function tickClock() {
    clockTimer = null;
    if (!isOpen) return;
    if (lastState) drawTime(lastState);
    clockTimer = setT(tickClock, CLOCK_MS);
  }

  function open() {
    if (!barShown) return false;
    if (closing) {
      clearT(closing.timer);
      sheet.removeEventListener('transitionend', closing.onEnd);
      closing = null;
    }
    if (isOpen) return true;
    isOpen = true;
    lastFocus = doc.activeElement;
    full.hidden = false;
    root.setAttribute('data-player-full', '');
    bar.setAttribute('inert', '');
    setAttr(openBtn, 'aria-expanded', 'true');
    sheet.appendChild(noticeBox);
    syncHost();
    // The closed place is drawn first, so the slide runs from it.
    if (motion()) void sheet.offsetWidth;
    full.classList.add('is-open');
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('focusin', onFocusIn);
    render(player.state());
    centreCurrent();
    if (clockTimer === null) clockTimer = setT(tickClock, CLOCK_MS);
    closeBtn.focus({ preventScroll: true });
    emit('open');
    return true;
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    endDrag();
    full.classList.remove('is-open');
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('focusin', onFocusIn);
    if (clockTimer !== null) {
      clearT(clockTimer);
      clockTimer = null;
    }
    bar.removeAttribute('inert');
    setAttr(openBtn, 'aria-expanded', 'false');
    host.appendChild(noticeBox);
    view = null;
    panelFrom = null;
    drawPanels();
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
    const back = lastFocus && lastFocus.isConnected && lastFocus !== doc.body && !full.contains(lastFocus) &&
      !lastFocus.closest('[inert]') ? lastFocus : (barShown ? openBtn : null);
    lastFocus = null;
    if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
    emit('close');
  }

  // ---- Swipe down to close ----

  function endDrag() {
    drag = null;
    sheet.classList.remove('is-dragging');
    sheet.style.transform = '';
  }

  sheet.addEventListener('pointerdown', function (e) {
    if (!isOpen || drag || (e.button !== undefined && e.button > 0)) return;
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
    let v = 0;
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    if (last[0] > first[0]) v = (last[1] - first[1]) / (last[0] - first[0]);
    if (!cancelled && d.moving && (d.dy >= SWIPE_CLOSE_PX || v >= SWIPE_FLING)) {
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
    else if (w.kind === 'part-skipped' || w.kind === 'resume-lost') notify(w.message, { id: w.kind });
  });
  player.on('error', function (e) {
    if (!e) return;
    let action = null;
    if (typeof e.retry === 'function') action = { label: 'Retry', run: e.retry };
    else if (e.code === 'signed-out' && typeof env.leaveTo === 'function') action = { label: 'Sign in', run: function () { env.leaveTo('/login'); } };
    notify(e.message, { tone: 'err', id: 'error', duration: 0, action: action });
  });

  render(player.state());

  return {
    open: open,
    close: close,
    isOpen: function () { return isOpen; },
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
    leaveTo: function (url) {
      if (WS.leaveTo) WS.leaveTo(url);
      else win.location.href = url;
    }
  }, overrides || {}));
  WS.playerUI = ui;
  return ui;
}

if (typeof window !== 'undefined' && window.document) boot(window);
