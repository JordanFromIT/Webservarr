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
 *   old chapter's name, when they last listened, and, for a place from an
 *   earlier copy of the book (linked_from), that copy's title and narrator;
 * - the candidate spots in this copy (candidates() below), each with this
 *   copy's chapter there, Preview (the obvious action: 15 s from the spot,
 *   nothing saved) and "Use this spot" (the confirm: WS.player.confirmPlace);
 * - on the chosen candidate (the one previewed or picked), a nudge: a
 *   scrubber (it moves the spot when let go) and back and forward by the
 *   skip length. The chosen spot is the engine's
 *   (state().filesChanged.spot). Once per hold, while it is still at the
 *   hold's start, the first playable candidate is picked (never one pulled
 *   in from past this copy's end); after that the spot is the listener's: a
 *   move anywhere else while held (the full player's scrubber, a chapter,
 *   the lock screen, a history entry) moves it, another old place shown
 *   keeps it, and it shows as "Your chosen spot" when it is near no
 *   candidate;
 * - "Show history" (the features' history panel) and "Start from the
 *   beginning" (WS.player.startOver).
 * With no book time on the old place (a place saved before this change),
 * there are no candidates: only the history and the start. A candidate in a
 * part this browser can't decode is shown as unavailable: no preview, no
 * confirm. While a confirm (or start over) waits, on its read of the saved
 * places (state().checking) or on the question that read asked, Preview
 * waits and the panel says so. The chosen spot is shown where a confirm
 * would land it (landingFor); when that is far back from it (landingFar: a
 * part this browser can't play in between), the panel says so and names
 * the nearest spot it can play, so nothing lands far from the listener's
 * spot unseen. A confirm that could not land (the engine's 'part-format'
 * warning marked landing) ends the wait, and the helper shows again if it
 * was put off. A refused move's "Pick another" lasts until the spot moves,
 * a Play or preview, or the helper is shown again.
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
 *       -> [{ kind: 'time'|'percent', bookMs, chapterLabel, unavailable, clamped }]
 *       'time': old.book_ms; 'percent': the same fraction of this copy
 *       (absent without old.book_duration_ms). Both are clamped to END_MS
 *       before this copy's end (clamped: true when that moved one), so a
 *       confirm never lands at the very end;
 *       only 'time' when they are NEAR_MS or less apart. [] without old.book_ms.
 *       blocked: fn(bookMs) -> true in a part this browser can't decode, or
 *       the engine's parts() ([{ start_ms, duration_ms, playable }]).
 *   landingFor(ms, durationMs, parts)   where a confirm of ms lands (as engine.js)
 *   landingFar(ms, durationMs, parts)   true when that is further than WALK_MS back
 *                          (for a part that can't play): the engine keeps the
 *                          book held rather than land there unasked
 *   bookClock(ms)          "3:12:40", "0:12:05" (always hours: never a time of day)
 *   percentOf(ms, total)   whole percent through, or null
 *   formatAgo(ms)          "just now", "3 min ago", "2 h ago", "3 days ago"
 *   copyLine(old)          "From an earlier copy: <title>, read by <narrator>" (a linked
 *                          copy only), or ''
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
export const END_MS = 30000;           // a candidate is never nearer the copy's end than this
export const WALK_MS = 60000;          // a confirm never lands further back than this unasked (engine PLACE_WALK_MS)
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

/* The earlier copy, named, so a wrong match is plain to see. Only for a
   place from an earlier copy (linked_from): files changed within the same
   album are this copy's own book. */
export function copyLine(old) {
  const o = old || {};
  if (!o.linked_from) return '';
  const title = text(o.book_title);
  if (!title) return 'From an earlier copy';
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
  // Never at the very end: placed there, the next Play would start the book
  // again from 0:00.
  const limit = Math.max(0, dur - END_MS);
  function spot(kind, ms) {
    const v = Math.max(0, Math.min(limit, ms));
    return { kind: kind, bookMs: v, chapterLabel: chapterAt(chapters, v), unavailable: isBlocked(v), clamped: ms > limit };
  }
  const out = [spot('time', at)];
  const total = o.book_duration_ms;
  if (known(total) && total > 0) {
    const p = spot('percent', Math.round((Math.min(at, total) / total) * dur));
    if (Math.abs(p.bookMs - out[0].bookMs) > NEAR_MS) out.push(p);
  }
  return out;
}

/* Where a confirm of ms lands, as the engine places it (engine.js
   landingSpot): no nearer the end than END_MS, and, when that margin pulls it
   into a part this browser can't decode, the last playable spot before that
   part (END_MS short of its end where the part is long enough). parts: the
   engine's parts(). */
export function landingFor(ms, durationMs, parts) {
  const dur = Number(durationMs);
  if (!isFinite(dur) || dur <= 0) return Math.max(0, num(ms));
  const lim = Math.max(0, dur - END_MS);
  const v = Math.max(0, Math.min(lim, num(ms)));
  const list = Array.isArray(parts) ? parts : [];
  let i = -1;
  for (let k = 0; k < list.length; k++) {
    if (v < num(list[k].start_ms) + num(list[k].duration_ms) || k === list.length - 1) { i = k; break; }
  }
  // Only the margin's pull is moved on: a spot in such a part by itself is
  // refused by the engine, as ever.
  if (i === -1 || list[i].playable !== false || v >= num(ms)) return v;
  for (let j = i - 1; j >= 0; j--) {
    if (list[j].playable === false) continue;
    const start = num(list[j].start_ms);
    return Math.max(start, Math.min(lim, start + num(list[j].duration_ms) - END_MS));
  }
  return v;
}

/* Whether a confirm of ms would land (landingFor) further than WALK_MS from
   where the end margin alone puts it, for a part this browser can't decode
   in between: the engine never lands there unasked (it keeps the book held),
   so the helper shows that spot and says why. false for a landing that is
   itself refused (it is no walk). As engine.js walkedFar. */
export function landingFar(ms, durationMs, parts) {
  const dur = Number(durationMs);
  if (!isFinite(dur) || dur <= 0) return false;
  const to = landingFor(ms, dur, parts);
  if (blockedBy(parts)(to)) return false;
  const from = Math.max(0, Math.min(Math.max(0, dur - END_MS), num(ms)));
  return Math.abs(from - to) > WALK_MS;
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
  let opening = null;          // the full player is being opened for the helper: its show()
  let pending = false;         // a confirm (or start over) is waiting on its read or question
  let rematch = false;         // the old place changed under a kept spot (see follow)
  let refused = false;         // the engine refused a spot (a part this browser can't play) since the last choice
  let seenSpot = null;         // the chosen spot when last drawn: a refusal lasts until it moves
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

  // The first candidate that can play and was not pulled in from past this
  // copy's end (the same point in the book is the better guess then), else
  // none.
  function firstOpen() {
    for (let i = 0; i < list.length; i++) if (!list[i].unavailable && !list[i].clamped) return i;
    return -1;
  }

  // Once per hold (or per history entry when not held): the first candidate
  // is the chosen spot, so the nudge, the full player's Play and the time
  // shown are all at it. Held, that is a move of the held playhead (nothing
  // saved), and only while the spot is still where the hold put it: a spot
  // the listener moved (a history entry, the lock screen) is theirs.
  function select(s) {
    const i = firstOpen();
    if (mode === 'held' && spotNow(s) !== 0) {
      chosen = -1;
      ownSpot = null;
      return;
    }
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
    // A refused move leaves the spot where it was; once it moves (a valid
    // move, here or elsewhere), what was refused is no longer the news.
    if (seenSpot !== null && at !== seenSpot) refused = false;
    seenSpot = at;
    if (ownSpot !== null && at === ownSpot) return;
    ownSpot = at;
    // A spot kept from another old place is only a candidate's when it is
    // that very spot; else it shows as itself, beside the candidates.
    const reach = rematch ? NEAR_MS : NUDGE_MS;
    rematch = false;
    if (chosen !== -1 && cardOf(chosen) && Math.abs(at - centreOf(chosen)) <= reach) return;
    let near = -1;
    for (let i = 0; i < list.length; i++) {
      if (!list[i].unavailable && Math.abs(at - list[i].bookMs) <= reach &&
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
    // The spot as it can be used (a move elsewhere may have taken it to the
    // very end; a confirm stops END_MS short of it).
    const spot = usable(spotNow(s), s);
    const dur = num(s.bookDurationMs);
    // A confirm waits on its read, then on any question that read asked.
    // Then: the spot shown is far back from the listener's (a part that
    // can't play in between), or a move was refused.
    const waiting = isHeld && (checking || pending);
    const far = isHeld && walkedFar(spotNow(s), s);
    setText(status, !isHeld ? '' : checking ? 'Checking for a newer place…' : pending ? 'Answer the question above to carry on.' :
      far ? "That part can't play in this browser. The nearest spot it can play is " + bookClock(spot) + '.' :
        refused ? "That spot can't play in this browser. Pick another." : '');
    // The spots (the chosen spot's own card, after a move, even with none).
    const any = list.length > 0 || chosen === SPOT;
    setHidden(candHead, !any);
    setHidden(candList, !any);
    setHidden(none, !!list.length);
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
      c.prev.disabled = off || (waiting && !playing);
      setAttr(c.prev, 'aria-label', (playing ? 'Pause the preview' : 'Preview from ' + bookClock(v)) + ', ' + KIND_LABEL[c.kind]);
      c.use.disabled = off;
      setAttr(c.use, 'aria-label', 'Use this spot, ' + bookClock(v) + ', ' + KIND_LABEL[c.kind]);
      if (isChosen && nudge.parentNode !== c.li) c.li.insertBefore(nudge, c.li.lastChild);
    });
    const nudged = cardOf(chosen);
    if (!nudged || nudged.li.hidden || (nudged.cand && nudged.cand.unavailable)) {
      if (nudge.parentNode) nudge.parentNode.removeChild(nudge);
    } else if (!scrubbing) {
      drawNudge(spot, dur > 0 ? usable(dur, s) : Infinity);
    }
    const n = Math.round(skipMs() / 1000);
    setAttr(nudgeBack, 'aria-label', 'Back ' + n + ' seconds');
    setAttr(nudgeFwd, 'aria-label', 'Forward ' + n + ' seconds');
    setHidden(historyRow.parentNode, !features());
  }

  // The scrubber spans the nudge's reach either side of its card (and the
  // spot, wherever a move took it), within the book, up to the furthest spot
  // a confirm can land (top: END_MS short of the end, or the last playable
  // spot before it).
  function drawNudge(spot, top) {
    const c = centreOf(chosen);
    const lo = Math.max(0, Math.min(c - NUDGE_MS, spot));
    const hi = Math.min(top, Math.max(c + NUDGE_MS, spot));
    nudgeLo = lo;
    const max = Math.max(1, Math.round((hi - lo) / 1000));
    setAttr(nudgeRange, 'max', String(max));
    const v = String(Math.min(max, Math.max(0, Math.round((spot - lo) / 1000))));
    if (nudgeRange.value !== v) nudgeRange.value = v;
    nudgeRange.style.setProperty('--wsp-p', ((Number(v) / max) * 100).toFixed(2) + '%');
    setAttr(nudgeRange, 'aria-valuetext', spoken(spot) + ' into the book');
  }

  // ---- The choices ----

  // A spot as it can be used: where the engine's confirm would land it
  // (landingFor).
  function usable(v, s) {
    let parts = [];
    try {
      parts = player.parts();
    } catch (e) { /* none known */ }
    return landingFor(v, s.bookDurationMs, parts);
  }

  // Whether that is far back from v (landingFar): the engine won't land it
  // unasked.
  function walkedFar(v, s) {
    let parts = [];
    try {
      parts = player.parts();
    } catch (e) { /* none known */ }
    return landingFar(v, s.bookDurationMs, parts);
  }

  // A choice from a helper not showing (its hold is over, or the book went)
  // does nothing: there is no place for it to go.
  function live() {
    return isShown && mode !== null && !!old;
  }

  function move(v) {
    if (!live()) return;
    refused = false;
    const s = player.state();
    const to = usable(v, s);
    // Already there (a drag let go, then its change): nothing to move.
    if (to === spotNow(s)) {
      draw();
      return;
    }
    if (mode === 'held') {
      if (!held()) return;
      // The helper's own move: its card stays the chosen one.
      ownSpot = to;
      player.seek(to);
      ownSpot = spotNow(player.state());
    } else {
      freeSpot = to;
      ownSpot = to;
    }
    draw();
  }

  function valueOf(c) {
    const s = player.state();
    const i = c === spotCard ? SPOT : cards.indexOf(c);
    return usable(i === chosen || !c.cand ? spotNow(s) : c.cand.bookMs, s);
  }

  function onPreview(c) {
    if (!live() || mode !== 'held' || !held()) return;
    refused = false;
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
    if (!live()) return;
    const v = valueOf(c);
    if (mode === 'held') {
      if (!held()) return;
      const i = c === spotCard ? SPOT : cards.indexOf(c);
      refused = false;
      if (player.confirmPlace(v)) {
        chosen = i;
        ownSpot = spotNow(player.state());
        pending = true;
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
    if (!live()) return;
    if (mode === 'held') {
      if (held() && player.startOver()) pending = true;
      draw();
      return;
    }
    player.seek(0);
    hide();
  }));
  // Steps go from the spot as shown (a move elsewhere may have taken the
  // engine's to the very end; it shows, and is used, END_MS short of it).
  function stepFrom() {
    const s = player.state();
    return usable(spotNow(s), s);
  }
  nudgeBack.addEventListener('click', safely(function () { move(stepFrom() - skipMs()); }));
  nudgeFwd.addEventListener('click', safely(function () { move(stepFrom() + skipMs()); }));
  nudgeRange.addEventListener('input', safely(function () {
    // Shows where the drag is; moves when it is let go.
    scrubbing = true;
    const v = nudgeLo + Number(nudgeRange.value) * 1000;
    const c = cardOf(chosen);
    if (c) setText(c.at, [bookClock(v), chapterAt(player.state().chapters, v)].filter(Boolean).join(' · '));
  }));
  function commitDrag() {
    scrubbing = false;
    move(nudgeLo + Number(nudgeRange.value) * 1000);
  }
  // Let go: the drag moves the spot (a browser may send the change after
  // the pointerup, or not at all for a drag back to where it began).
  nudgeRange.addEventListener('change', safely(commitDrag));
  nudgeRange.addEventListener('pointerup', safely(function () {
    if (scrubbing) commitDrag();
  }));
  // Cancelled, or left another way: back to where the spot is.
  ['pointercancel', 'blur'].forEach(function (type) {
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
    move(stepFrom() + step * FINE_MS);
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
    // Held, the first candidate is picked once per hold, whatever place the
    // helper shows later; not held, once per history entry.
    const id = (isHeld ? 'hold' + holds : 'free|' + oldKey(next)) + '|' + s.book;
    const fresh = id !== selectedFor;
    const changed = !old || oldKey(old) !== oldKey(next) || mode !== nextMode;
    old = Object.assign({}, next);
    mode = nextMode;
    book = s.book;
    // Shown again: a refusal from before is old news.
    refused = false;
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
    build(player.state());
    if (fresh) {
      selectedFor = id;
      select(player.state());
    } else if (changed) {
      // Another old place, the spot kept: its card is worked out afresh.
      chosen = -1;
      ownSpot = null;
      rematch = true;
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
    pending = false;
    rematch = false;
    refused = false;
    seenSpot = null;
    drawnFor = '';
    setText(status, '');
  }

  // ---- The engine and the view ----

  // A spot refused (a part this browser can't play): the book stays held,
  // and the panel says why. Only the confirm's own landing (landing: true)
  // ends its wait: a move refused while the question waits leaves it
  // waiting. That landing shows the helper again if it was put off, so a
  // confirm never comes to nothing unseen.
  player.on('warning', safely(function (w) {
    if (!w || w.kind !== 'part-format' || mode !== 'held' || !held()) return;
    if (w.landing) {
      pending = false;
      if (!isShown) open(null, null);
    }
    refused = true;
    if (isShown) draw();
  }));

  player.on('warning', safely(function (w) {
    if (!w || w.kind !== 'files-changed') return;
    const s = player.state();
    if (!s.book || w.book !== s.book || !s.filesChanged) return;
    holds += 1;
    open(null, null);
  }));

  player.on('change', safely(function (d) {
    const s = d && d.state ? d.state : player.state();
    // A Play (a preview, while held) is a choice made since the refusal.
    if (d && (d.reason === 'play' || d.reason === 'preview')) refused = false;
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
    if (opening) {
      const show = opening;
      opening = null;
      show();
      return;
    }
    if (held() && !isShown) open(null, null);
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
