/**
 * WebServarr — the audiobook player's "Find your place" helper (ES module,
 * document-lifetime)
 *
 * When a book's files changed since the listener last saved a place (the
 * engine holds it: state().filesChanged, a 'warning' { kind: 'files-changed' }),
 * the place they had may not line up with the new files. The helper shows
 * where they were and offers spots in this copy to carry on from, with a
 * preview of each, a nudge, and the confirm. Loaded by the shell partial as
 * its own module script right after features.js (so it carries its own asset
 * stamp); nothing imports it. Like the engine it lives as long as the
 * document: its listeners are added once, and it has no timers. Design:
 * docs/superpowers/specs/2026-09-30-audiobook-files-changed-design.md,
 * section 5. Styles: theme.css "Audiobook player" (theme variables only).
 *
 * The panel (WS.playerUI.panel 'findplace', in the full player: over it on
 * a phone, beside it on a wide screen) opens on the 'files-changed' warning,
 * with the full player, and again whenever the full player opens while the
 * book is held (the bar's Play opens it too: ui.js). It shows:
 * - where the listener was: the book time, how far through the book, the
 *   old chapter's name, when they last listened, and the earlier copy's
 *   title and narrator when the place came from one;
 * - the candidate spots in this copy (candidates() below), each with this
 *   copy's chapter there, Preview (the obvious action: 15 s from the spot,
 *   nothing saved) and "Use this spot" (the confirm: WS.player.confirmPlace);
 * - on the chosen candidate (the one previewed or picked), a nudge: a
 *   scrubber and back and forward by the skip length. The chosen spot is
 *   the engine's (state().filesChanged.spot): a move anywhere else while
 *   held (the full player's scrubber, a chapter, the lock screen, a history
 *   entry) moves it, and it shows as "Your chosen spot" when it is near no
 *   candidate;
 * - "Show history" (the features' history panel) and "Start from the
 *   beginning" (WS.player.startOver).
 * With no book time on the old place (a place saved before this change),
 * there are no candidates: only the history and the start. A candidate in a
 * part this browser can't decode is shown as unavailable: no preview, no
 * confirm. While the confirm reads the saved places (state().checking),
 * Preview waits.
 *
 * Closing it (its back button, Escape, the phone's Back, closing the full
 * player) is "decide later": nothing is saved and the book stays held. A
 * prompt ("Find your place") then stays above the bar, or at the top of the
 * full player, until the listener comes back to it or places the book.
 *
 * A history entry whose part is gone (features.js) opens the helper with
 * that entry as the old place. While the book is held the choices are the
 * same; when it is not (an earlier copy's entry, after the book was
 * placed), there is no preview (it would play, and so save) and "Use this
 * spot" is an ordinary move of the listener's (saved, with Undo over 2
 * minutes).
 *
 * Text through textContent only; no markup from strings, no inline handlers.
 *
 * Pure (importable by Node, no DOM at import time):
 *   candidates(old, durationMs, chapters, blocked)
 *       -> [{ kind: 'time'|'percent', bookMs, chapterLabel, unavailable }]
 *       'time': old.book_ms clamped to this copy's length; 'percent': the
 *       same fraction of this copy (absent without old.book_duration_ms);
 *       only 'time' when they are NEAR_MS or less apart. [] without old.book_ms.
 *       blocked: fn(bookMs) -> true in a part this browser can't decode, or
 *       the engine's parts() ([{ start_ms, duration_ms, playable }]).
 *   bookClock(ms)          "3:12:40", "0:12:05" (always hours: never a time of day)
 *   percentOf(ms, total)   whole percent through, or null
 *   formatAgo(ms)          "just now", "3 min ago", "2 h ago", "3 days ago"
 *   copyLine(old)          "From an earlier copy: <title>, read by <narrator>", or ''
 *   createFindPlace(env)   the helper, given its surroundings
 *   boot(win, overrides)   WS.playerFindPlace
 *
 * WS.playerFindPlace (for features.js and the tests):
 *   open(old, opener) -> bool   shows the helper; old: a place as in
 *                               state().filesChanged.old (null: the held one)
 *   hide()                      as closing it
 *   shown                       the panel is showing
 */

export const NEAR_MS = 5000;           // candidates this close (or closer) are one
export const NUDGE_MS = 300000;        // the nudge reaches this far either side of its candidate
export const FINE_MS = 1000;           // an arrow key on the nudge moves this much
export const PANEL = 'findplace';

const SKIP_S = 10;

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

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/* The earlier copy, named, so a wrong match is plain to see. */
export function copyLine(old) {
  const o = old || {};
  const title = text(o.book_title);
  if (!title) return o.linked_from || o.earlier ? 'From an earlier copy' : '';
  const by = text(o.narrator);
  return 'From an earlier copy: ' + title + (by ? ', read by ' + by : '');
}

// The chapter a book time is in: the last one starting at or before it.
function chapterAt(chapters, ms) {
  const list = Array.isArray(chapters) ? chapters : [];
  let found = -1;
  for (let i = 0; i < list.length; i++) {
    if (num(list[i].start_ms) <= ms) found = i;
    else break;
  }
  if (found === -1 && list.length) found = 0;
  return found === -1 ? '' : String(list[found].label || 'Chapter ' + (found + 1));
}

// The part a book time is in: a part's first instant is that part's.
function blockedBy(blocked) {
  if (typeof blocked === 'function') {
    return function (ms) {
      try {
        return !!blocked(ms);
      } catch (e) {
        return false;
      }
    };
  }
  const parts = Array.isArray(blocked) ? blocked : [];
  return function (ms) {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] || {};
      if (ms < num(p.start_ms) + num(p.duration_ms) || i === parts.length - 1) return p.playable === false;
    }
    return false;
  };
}

export function candidates(old, durationMs, chapters, blocked) {
  const o = old || {};
  const dur = Number(durationMs);
  const at = o.book_ms;
  if (!known(at) || at < 0 || !isFinite(dur) || dur <= 0) return [];
  const isBlocked = blockedBy(blocked);
  function spot(kind, ms) {
    const v = Math.max(0, Math.min(dur, ms));
    return { kind: kind, bookMs: v, chapterLabel: chapterAt(chapters, v), unavailable: isBlocked(v) };
  }
  const out = [spot('time', Math.min(at, dur))];
  const total = o.book_duration_ms;
  if (known(total) && total > 0) {
    const p = spot('percent', Math.round((Math.min(at, total) / total) * dur));
    if (Math.abs(p.bookMs - out[0].bookMs) > NEAR_MS) out.push(p);
  }
  return out;
}

// "+5 s", "−1 min 20 s": how far the nudge moved a candidate.
function delta(ms) {
  const s = Math.round(num(ms) / 1000);
  if (!s) return '';
  const a = Math.abs(s);
  const m = Math.floor(a / 60);
  const r = a % 60;
  return (s < 0 ? '−' : '+') + (m ? m + ' min' + (r ? ' ' : '') : '') + (r ? r + ' s' : '');
}

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

const KIND_LABEL = { time: 'Same time', percent: 'Same point in the book', spot: 'Your chosen spot' };

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

/* env: { player (WS.player), ui (WS.playerUI), doc, now() (wall clock: "last
   listened"), features() -> WS.playerFeatures or null (its showHistory) }. */
export function createFindPlace(env) {
  const player = env.player;
  const ui = env.ui;
  const doc = env.doc;
  const now = env.now || Date.now;

  function logError(e) {
    console.error('[player] finding the place failed', e);
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

  function safely(fn) {
    return function () {
      try {
        fn.apply(null, arguments);
      } catch (e) {
        logError(e);
      }
    };
  }

  function features() {
    try {
      return typeof env.features === 'function' ? env.features() : (env.features || null);
    } catch (e) {
      return null;
    }
  }

  function skipMs() {
    let n = SKIP_S;
    try {
      n = num(player.setSkip()) || SKIP_S;
    } catch (e) { /* the default */ }
    return n * 1000;
  }

  // ---- What it is showing ----

  let old = null;              // the old place shown
  let mode = null;             // 'held' (the engine holds the book) or 'free' (a history entry, not held)
  let book = null;             // the book it is for
  let list = [];               // candidates() for old in this copy
  let chosen = -1;             // the card the nudge is on: a candidate, SPOT (the chosen spot), or -1
  let ownSpot = null;          // the spot as the helper last set it (held), so a move elsewhere shows
  let freeSpot = null;         // the chosen spot when not held (nothing in the engine to keep it)
  let spotCentre = null;       // the chosen spot's card: where its nudge is centred
  let selectedFor = null;      // the hold (or entry) whose first candidate was picked at the open
  let holds = 0;               // a number per hold (each files-changed warning)
  let promptEntry = null;      // the "Find your place" prompt, while the helper is put off
  let isShown = false;
  let opening = false;         // the full player is being opened for the helper
  const SPOT = 'spot';

  // ---- The panel ----

  const panel = ui.panel(PANEL, { title: 'Find your place', onHide: onPanelHidden });
  const lede = h('p', { class: 'wsp-fp-lede' });
  const oldCopy = h('p', { class: 'wsp-fp-copy' });
  const oldTime = h('p', { class: 'wsp-fp-old-time' });
  const oldChapter = h('p', { class: 'wsp-fp-old-chapter' });
  const oldWhen = h('p', { class: 'wsp-fp-old-when' });
  const oldCard = h('div', { class: 'wsp-fp-old' }, [
    h('p', { class: 'wsp-fp-eyebrow', text: 'Where you were' }),
    oldCopy, oldTime, oldChapter, oldWhen
  ]);
  const status = h('p', { class: 'wsp-fp-status', role: 'status' });
  const candHead = h('h4', { class: 'wsp-opt-head wsp-fp-head', text: 'Pick a spot in this copy' });
  const candList = h('ul', { class: 'wsp-fp-cands', role: 'list' });
  const none = h('p', { class: 'wsp-opt-note wsp-fp-none',
    text: "There's no saved time to match in this copy. Your listening history may help you find it." });

  // The nudge: on the chosen card.
  const nudgeBack = h('button', { type: 'button', class: 'wsp-icon-btn wsp-fp-step' }, [icon('replay')]);
  const nudgeFwd = h('button', { type: 'button', class: 'wsp-icon-btn wsp-fp-step' }, [icon('replay', 'wsp-mirror')]);
  const nudgeRange = h('input', {
    type: 'range', class: 'wsp-range wsp-fp-range', min: '0', max: '1', step: '1', value: '0',
    'aria-label': 'Adjust the spot'
  });
  const nudge = h('div', { class: 'wsp-fp-nudge', 'data-no-swipe': '' }, [nudgeBack, nudgeRange, nudgeFwd]);
  let nudgeLo = 0;             // the scrubber's start, book ms
  let scrubbing = false;

  const historyRow = h('button', { type: 'button', class: 'wsp-row wsp-fp-row' }, [
    icon('history', 'wsp-fp-row-icon'), h('span', { class: 'wsp-row-text', text: 'Show history' })
  ]);
  const startRow = h('button', { type: 'button', class: 'wsp-row wsp-fp-row' }, [
    icon('restart_alt', 'wsp-fp-row-icon'), h('span', { class: 'wsp-row-text', text: 'Start from the beginning' })
  ]);
  const others = h('ul', { class: 'wsp-rows wsp-fp-others', role: 'list' }, [
    h('li', null, [historyRow]), h('li', null, [startRow])
  ]);
  panel.body.appendChild(h('div', { class: 'wsp-opt-sec wsp-fp' }, [lede, oldCard, status, candHead, candList, none, others]));

  // A card: a candidate, or the chosen spot (SPOT) when it is near none.
  function card(kind) {
    const kindEl = h('p', { class: 'wsp-fp-kind', text: KIND_LABEL[kind] || '' });
    const at = h('p', { class: 'wsp-fp-at' });
    const note = h('p', { class: 'wsp-fp-note', hidden: true });
    const prev = h('button', { type: 'button', class: 'wsp-fp-btn is-primary wsp-fp-preview' }, [
      icon('play_arrow', 'wsp-fp-btn-icon'), h('span', { class: 'wsp-fp-btn-text', text: 'Preview' })
    ]);
    const use = h('button', { type: 'button', class: 'wsp-fp-btn wsp-fp-use', text: 'Use this spot' });
    const li = h('li', { class: 'wsp-fp-cand', 'data-kind': kind }, [
      h('div', { class: 'wsp-fp-cand-head' }, [kindEl, at, note]),
      h('div', { class: 'wsp-fp-actions' }, [prev, use])
    ]);
    const c = { kind: kind, li: li, at: at, note: note, prev: prev, use: use, cand: null };
    prev.addEventListener('click', safely(function () { onPreview(c); }));
    use.addEventListener('click', safely(function () { onUse(c); }));
    return c;
  }

  let cards = [];              // one per candidate
  const spotCard = card(SPOT);
  let drawnFor = '';           // what the cards were made for

  function held() {
    const s = player.state();
    return !!(s && s.book && s.filesChanged);
  }

  // The chosen spot: the engine's while held, else the helper's own.
  function spotNow(s) {
    if (mode === 'held') return s.filesChanged ? num(s.filesChanged.spot) : 0;
    return freeSpot === null ? 0 : freeSpot;
  }

  function cardOf(i) {
    return i === SPOT ? spotCard : i >= 0 && i < cards.length ? cards[i] : null;
  }

  function centreOf(i) {
    if (i === SPOT) return spotCentre === null ? 0 : spotCentre;
    const c = cardOf(i);
    return c && c.cand ? c.cand.bookMs : 0;
  }

  function oldKey(o) {
    return [o.source || '', o.track || '', o.offset_ms, o.book_ms, o.updated_at || '', o.linked_from || ''].join('|');
  }

  // The cards for the old place in this copy (made again only when they change).
  function build(s) {
    let parts = [];
    try {
      parts = player.parts();
    } catch (e) { /* none known */ }
    list = candidates(old, s.bookDurationMs, s.chapters, parts);
    const key = (s.book || '') + '#' + JSON.stringify(list);
    if (key === drawnFor) return;
    drawnFor = key;
    candList.textContent = '';
    cards = list.map(function (cand) {
      const c = card(cand.kind);
      c.cand = cand;
      candList.appendChild(c.li);
      return c;
    });
    candList.appendChild(spotCard.li);
    if (typeof chosen === 'number' && chosen >= cards.length) chosen = -1;
  }

  // The first candidate that can play, else none.
  function firstOpen() {
    for (let i = 0; i < list.length; i++) if (!list[i].unavailable) return i;
    return -1;
  }

  // At the open of a hold (or a history entry): the first candidate is the
  // chosen spot, so the nudge, the full player's Play and the time shown
  // are all at it. Held, that is a move of the held playhead (nothing saved).
  function select(s) {
    const i = firstOpen();
    chosen = i;
    if (i === -1) {
      if (mode === 'free') freeSpot = null;
      ownSpot = spotNow(s);
      return;
    }
    const v = list[i].bookMs;
    if (mode === 'held') {
      if (Math.abs(spotNow(s) - v) > 0) player.seek(v);
      ownSpot = spotNow(player.state());
    } else {
      freeSpot = v;
      ownSpot = v;
    }
  }

  // A move made elsewhere while held (the full player, a chapter, the lock
  // screen, a history entry): the chosen spot is where it landed, on the
  // candidate it is near, else a card of its own.
  function follow(s) {
    if (mode !== 'held') return;
    const at = spotNow(s);
    if (ownSpot !== null && at === ownSpot) return;
    ownSpot = at;
    if (typeof chosen === 'number' && chosen >= 0 && Math.abs(at - centreOf(chosen)) <= NUDGE_MS) return;
    let near = -1;
    for (let i = 0; i < list.length; i++) {
      if (!list[i].unavailable && Math.abs(at - list[i].bookMs) <= NUDGE_MS &&
          (near === -1 || Math.abs(at - list[i].bookMs) < Math.abs(at - list[near].bookMs))) near = i;
    }
    if (near !== -1) {
      chosen = near;
    } else {
      chosen = SPOT;
      spotCentre = at;
    }
  }

  function draw() {
    const s = player.state();
    if (!isShown || !old) return;
    build(s);
    follow(s);
    const isHeld = mode === 'held';
    const checking = !!s.checking;
    setText(lede, isHeld
      ? "This book's files have changed since you last listened. Pick where to carry on: nothing is saved until you do."
      : 'That place is in files this book no longer has. Pick the same spot in this copy.');
    // Where they were.
    const copy = copyLine(old);
    setText(oldCopy, copy);
    setHidden(oldCopy, !copy);
    const pct = percentOf(old.book_ms, old.book_duration_ms);
    const time = known(old.book_ms) ? bookClock(old.book_ms) + ' into the book' + (pct === null ? '' : ' · ' + pct + '%') : '';
    setText(oldTime, time);
    setHidden(oldTime, !time);
    const chapter = text(old.chapter_label);
    setText(oldChapter, chapter);
    setHidden(oldChapter, !chapter);
    const at = Date.parse(old.updated_at);
    const when = isFinite(at) ? 'Last listened ' + formatAgo(now() - at) : '';
    setText(oldWhen, when);
    setHidden(oldWhen, !when);
    setText(status, isHeld && checking ? 'Checking for a newer place…' : '');
    // The spots (the chosen spot's own card, after a move, even with none).
    const any = list.length > 0 || chosen === SPOT;
    setHidden(candHead, !any);
    setHidden(candList, !any);
    setHidden(none, !!list.length);
    const spot = spotNow(s);
    const dur = num(s.bookDurationMs);
    cards.concat([spotCard]).forEach(function (c, n) {
      const i = c === spotCard ? SPOT : n;
      const isChosen = i === chosen;
      if (c === spotCard) setHidden(c.li, !isChosen);
      const off = !!(c.cand && c.cand.unavailable);
      const v = isChosen ? spot : c.cand ? c.cand.bookMs : spot;
      const label = isChosen || !c.cand ? chapterAt(s.chapters, v) : c.cand.chapterLabel;
      const moved = isChosen && c.cand ? delta(spot - c.cand.bookMs) : '';
      setText(c.at, [bookClock(v), label, moved].filter(Boolean).join(' · '));
      let note = '';
      if (off) note = "Can't play in this browser";
      else if (c.cand && c.cand.kind === 'time' && known(old.book_ms) && old.book_ms > dur) note = 'This copy ends before then';
      setText(c.note, note);
      setHidden(c.note, !note);
      c.li.classList.toggle('is-chosen', isChosen);
      c.li.classList.toggle('is-off', off);
      // Preview: held only (it would save otherwise); Pause while it plays.
      setHidden(c.prev, !isHeld);
      const playing = isHeld && isChosen && !!s.playing;
      setText(c.prev.firstChild, playing ? 'pause' : 'play_arrow');
      setText(c.prev.lastChild, playing ? 'Pause' : 'Preview');
      c.prev.disabled = off || (checking && !playing);
      setAttr(c.prev, 'aria-label', (playing ? 'Pause the preview' : 'Preview from ' + bookClock(v)) + ', ' + KIND_LABEL[c.kind]);
      c.use.disabled = off;
      setAttr(c.use, 'aria-label', 'Use this spot, ' + bookClock(v) + ', ' + KIND_LABEL[c.kind]);
      if (isChosen && nudge.parentNode !== c.li) c.li.insertBefore(nudge, c.li.lastChild);
    });
    const nudged = cardOf(chosen);
    if (!nudged || nudged.li.hidden || (nudged.cand && nudged.cand.unavailable)) {
      if (nudge.parentNode) nudge.parentNode.removeChild(nudge);
    } else if (!scrubbing) {
      drawNudge(spot, dur);
    }
    const n = Math.round(skipMs() / 1000);
    setAttr(nudgeBack, 'aria-label', 'Back ' + n + ' seconds');
    setAttr(nudgeFwd, 'aria-label', 'Forward ' + n + ' seconds');
    setHidden(historyRow.parentNode, !features());
  }

  // The scrubber spans the nudge's reach either side of its card (and the
  // spot, wherever a move took it), within the book.
  function drawNudge(spot, dur) {
    const c = centreOf(chosen);
    const lo = Math.max(0, Math.min(c - NUDGE_MS, spot));
    const hi = Math.min(dur > 0 ? dur : Infinity, Math.max(c + NUDGE_MS, spot));
    nudgeLo = lo;
    const max = Math.max(1, Math.round((hi - lo) / 1000));
    setAttr(nudgeRange, 'max', String(max));
    const v = String(Math.min(max, Math.max(0, Math.round((spot - lo) / 1000))));
    if (nudgeRange.value !== v) nudgeRange.value = v;
    nudgeRange.style.setProperty('--wsp-p', ((Number(v) / max) * 100).toFixed(2) + '%');
    setAttr(nudgeRange, 'aria-valuetext', spoken(spot) + ' into the book');
  }

  // ---- The choices ----

  function move(v) {
    const s = player.state();
    const dur = num(s.bookDurationMs);
    const to = Math.max(0, dur > 0 ? Math.min(dur, v) : v);
    if (mode === 'held') {
      if (!held()) return;
      player.seek(to);
      ownSpot = spotNow(player.state());
    } else {
      freeSpot = to;
      ownSpot = to;
    }
    draw();
  }

  function valueOf(c) {
    const i = c === spotCard ? SPOT : cards.indexOf(c);
    return i === chosen ? spotNow(player.state()) : c.cand ? c.cand.bookMs : spotNow(player.state());
  }

  function onPreview(c) {
    if (mode !== 'held' || !held()) return;
    const s = player.state();
    const i = c === spotCard ? SPOT : cards.indexOf(c);
    if (i === chosen && s.playing) {
      player.pause();
      return;
    }
    if (player.previewAt(valueOf(c))) {
      chosen = i;
      if (i === SPOT) spotCentre = spotNow(player.state());
      ownSpot = spotNow(player.state());
    }
    draw();
  }

  function onUse(c) {
    const v = valueOf(c);
    if (mode === 'held') {
      if (!held()) return;
      const i = c === spotCard ? SPOT : cards.indexOf(c);
      if (player.confirmPlace(v)) {
        chosen = i;
        ownSpot = spotNow(player.state());
      }
      draw();
      return;
    }
    // Not held: an ordinary move of the listener's, saved as their place.
    player.seek(v);
    hide();
  }

  historyRow.addEventListener('click', safely(function () {
    const f = features();
    if (f && typeof f.showHistory === 'function') f.showHistory(historyRow);
  }));
  startRow.addEventListener('click', safely(function () {
    if (mode === 'held') {
      if (held()) player.startOver();
      draw();
      return;
    }
    player.seek(0);
    hide();
  }));
  nudgeBack.addEventListener('click', safely(function () { move(spotNow(player.state()) - skipMs()); }));
  nudgeFwd.addEventListener('click', safely(function () { move(spotNow(player.state()) + skipMs()); }));
  nudgeRange.addEventListener('input', safely(function () {
    // Shows where the drag is; moves when it is let go.
    scrubbing = true;
    const v = nudgeLo + Number(nudgeRange.value) * 1000;
    const c = cardOf(chosen);
    if (c) setText(c.at, [bookClock(v), chapterAt(player.state().chapters, v)].filter(Boolean).join(' · '));
  }));
  nudgeRange.addEventListener('change', safely(function () {
    scrubbing = false;
    move(nudgeLo + Number(nudgeRange.value) * 1000);
  }));
  ['pointerup', 'pointercancel', 'blur'].forEach(function (type) {
    nudgeRange.addEventListener(type, function () {
      if (!scrubbing) return;
      scrubbing = false;
      safely(draw)();
    });
  });
  nudgeRange.addEventListener('keydown', safely(function (e) {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    // A second at a time (the player's keys, which skip, never see it).
    e.preventDefault();
    move(spotNow(player.state()) + step * FINE_MS);
  }));

  // ---- Showing and hiding ----

  function dropPrompt() {
    const p = promptEntry;
    promptEntry = null;
    if (p) p.remove();
  }

  // Put off while held: a way back stays in view.
  function ensurePrompt() {
    if (promptEntry || isShown || !held()) return;
    promptEntry = ui.prompt({
      id: 'findplace',
      message: 'This book has changed since you last listened.',
      actions: [{ label: 'Find your place', primary: true, run: function () { promptEntry = null; open(null, null); } }]
    });
  }

  function onPanelHidden() {
    if (!isShown) return;
    isShown = false;
    scrubbing = false;
    ensurePrompt();
  }

  /* Shows the helper for old (null: the held place). Held, the first
     candidate becomes the chosen spot the first time a hold (or a history
     entry) is shown; after that the listener's own choice is kept. */
  function open(o, opener) {
    const s = player.state();
    if (!s.book) return false;
    const isHeld = !!s.filesChanged;
    let next = o && typeof o === 'object' ? o : null;
    if (!next) {
      if (!isHeld) return false;
      next = s.filesChanged.old;
    }
    const nextMode = isHeld ? 'held' : 'free';
    const id = (isHeld ? 'hold' + holds : 'free') + '|' + s.book + '|' + oldKey(next);
    const fresh = id !== selectedFor;
    old = Object.assign({}, next);
    mode = nextMode;
    book = s.book;
    if (!ui.isOpen()) {
      opening = true;
      let ok = false;
      try {
        ok = ui.open();
      } finally {
        opening = false;
      }
      if (!ok) return false;
    }
    dropPrompt();
    isShown = true;
    panel.show(opener);
    build(player.state());
    if (fresh) {
      selectedFor = id;
      select(player.state());
    }
    draw();
    return true;
  }

  function hide() {
    if (!isShown) return;
    panel.hide();
    // A panel shown beside the player on a wide screen is hidden all the same.
    onPanelHidden();
  }

  function reset() {
    old = null;
    mode = null;
    book = null;
    chosen = -1;
    ownSpot = null;
    freeSpot = null;
    spotCentre = null;
    drawnFor = '';
  }

  // ---- The engine and the view ----

  player.on('warning', safely(function (w) {
    if (!w || w.kind !== 'files-changed') return;
    const s = player.state();
    if (!s.book || w.book !== s.book || !s.filesChanged) return;
    holds += 1;
    open(null, null);
  }));

  player.on('change', safely(function (d) {
    const s = d && d.state ? d.state : player.state();
    if (s.book !== book && book !== null) {
      // Another book, or none: what showed was this one's.
      if (isShown) hide();
      dropPrompt();
      reset();
    }
    if (!s.book || !s.filesChanged) {
      dropPrompt();
      // Placed (or let go): the held helper has done its job.
      if (mode === 'held' && isShown) hide();
      if (mode === 'held') reset();
      else if (isShown) draw();
      return;
    }
    if (isShown && mode === 'free') {
      // The book was held while a history entry showed: the held place now.
      open(null, null);
      return;
    }
    if (isShown) draw();
    else if (book !== null || promptEntry) ensurePrompt();
  }));

  // The full player opening while the book is held opens on the helper.
  ui.on('open', safely(function () {
    if (!opening && held() && !isShown) open(null, null);
  }));

  return {
    open: function (o, opener) {
      try {
        return open(o, opener);
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

/* Adds the helper to the engine and view booted before it (WS.player,
   WS.playerUI), once per document, as WS.playerFindPlace. Returns it, or
   null on a page without the player. */
export function boot(win, overrides) {
  const WS = win.WS || (win.WS = {});
  if (WS.playerFindPlace) return WS.playerFindPlace;
  const player = (overrides && overrides.player) || WS.player;
  const ui = (overrides && overrides.ui) || WS.playerUI;
  if (!player || !ui) return null;
  const helper = createFindPlace(Object.assign({
    player: player,
    ui: ui,
    doc: win.document,
    now: Date.now,
    features: function () { return WS.playerFeatures || null; }
  }, overrides || {}));
  WS.playerFindPlace = helper;
  return helper;
}

if (typeof window !== 'undefined' && window.document) boot(window);
