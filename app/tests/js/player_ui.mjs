// The audiobook player's mini bar and full-screen player
// (app/static/js/player/ui.js) in happy-dom, drawing a scripted engine: a
// fake WS.player whose state the test sets and whose events it fires, with
// fake timers, a switchable reduced-motion preference and a measured bar
// height (happy-dom lays nothing out).
//
// Imports ui.js as it is, through a data: URL like player_engine.mjs, which
// also proves the module touches no DOM at import time.
// UI_JS=<path> runs the same cases against another copy of ui.js.
// Run: node app/tests/js/player_ui.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const UI_PATH = process.env.UI_JS || join(here, '../../static/js/player/ui.js');
const U = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(UI_PATH, 'utf8')));

let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${current}: ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}

// ---- Fake timers ----
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock() {
  let now = 0;
  let ids = 0;
  const due = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms) { const id = ++ids; due.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { due.delete(id); },
    pending() { return due.size; },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const [id, t] of due) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        now = next[1].at;
        due.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

// ---- A scripted engine ----

const H = 3600000;
const BOOK = {
  book: '500:1', title: 'Three Parts', author: 'A. Writer', narrator: 'N. Reader', series: 'Saga',
  cover: '/api/player/cover/500:1?v=77', bookDurationMs: 3 * H, bookMs: 700000, speed: 1,
  chapters: [
    { index: 1, label: 'Part 1 of 3', start_ms: 0, end_ms: 600000, track: '501' },
    { index: 2, label: 'Part 2 of 3', start_ms: 600000, end_ms: 1500000, track: '502' },
    { index: 3, label: 'Part 3 of 3', start_ms: 1500000, end_ms: 3 * H, track: '503' }
  ],
  chapterIndex: 1, trackIndex: 1, playing: true, loading: false
};
const EMPTY = {
  book: null, title: '', author: '', narrator: '', series: '', cover: '', chapters: [], chapterIndex: -1,
  trackIndex: -1, bookMs: 0, bookDurationMs: 0, position: null, playing: false, loading: false, speed: 1,
  connection: null, error: null, lastSavedAt: null, saveError: false, resumedFrom: null
};

function fakeEngine(initial) {
  const st = Object.assign({}, EMPTY, initial || {});
  const hs = { change: new Set(), ended: new Set(), error: new Set(), warning: new Set() };
  const calls = [];
  let skipS = 10;
  const e = {
    calls,
    state: () => JSON.parse(JSON.stringify(st)),
    set(patch, reason = 'time', extra) {
      Object.assign(st, patch);
      for (const fn of Array.from(hs.change)) fn(Object.assign({ reason, state: e.state() }, extra || {}));
    },
    emit(type, d) { for (const fn of Array.from(hs[type])) fn(d); },
    on(t, fn) { hs[t].add(fn); return () => hs[t].delete(fn); },
    listeners(t) { return hs[t].size; },
    toggle() { calls.push(['toggle']); },
    play() { calls.push(['play']); return Promise.resolve(); },
    pause() { calls.push(['pause']); },
    seek(ms) { calls.push(['seek', ms]); },
    skip(s) { calls.push(['skip', s]); },
    jumpToChapter(i) { calls.push(['jump', i]); },
    setSkip(x) { if (typeof x === 'number' && isFinite(x)) skipS = x; return skipS; },
    setSpeed(x) { return x; },
    retry() { calls.push(['retry']); return Promise.resolve(); },
    close() { calls.push(['close']); }
  };
  return e;
}

const NOW0 = Date.UTC(2026, 8, 29, 18, 0, 0);

function setup(o = {}) {
  const win = new Window({ url: 'https://ws.test/news' });
  const doc = win.document;
  doc.body.innerHTML = '<main><button id="pageBtn" type="button">Page</button></main><div id="wsPlayer" hidden></div>';
  const clock = fakeClock();
  const engine = fakeEngine(o.state);
  const env = { reduce: !!o.reduce, wide: !!o.wide, dialog: false, left: [], activation: o.activation !== false,
    watchers: [], made: 0, destroyed: 0 };
  // The browser's CloseWatcher, as far as the player uses it: made per layer,
  // destroyed when a layer closes some other way. closeRequest() is Android's
  // Back or an uncancelled Escape: the newest live watcher gets 'close'.
  class FakeCloseWatcher {
    constructor() {
      this.live = true;
      this.fns = [];
      env.made += 1;
      env.watchers.push(this);
    }
    addEventListener(type, fn) { if (type === 'close') this.fns.push(fn); }
    destroy() {
      if (!this.live) return;
      this.live = false;
      env.destroyed += 1;
      env.watchers.splice(env.watchers.indexOf(this), 1);
    }
  }
  env.closeRequest = function () {
    const w = env.watchers.pop();
    if (!w) return false;
    w.live = false;
    for (const fn of w.fns) fn(new win.Event('close'));
    return true;
  };
  // Escape as the browser handles it: the keydown, then (uncancelled) a close request.
  env.escape = function () {
    const ev = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    doc.activeElement.dispatchEvent(ev);
    if (!ev.defaultPrevented && o.closeWatcher !== false) env.closeRequest();
    return ev;
  };
  // Every history write the page makes.
  env.historyWrites = 0;
  for (const k of ['pushState', 'replaceState']) {
    const real = win.history[k].bind(win.history);
    win.history[k] = (...a) => { env.historyWrites += 1; return real(...a); };
  }
  const host = doc.getElementById('wsPlayer');
  const make = o.boot ? null : U.createUI;
  const opts = {
    doc, host, player: engine,
    matchMedia: (q) => ({ matches: q.indexOf('reduce') !== -1 ? env.reduce : q.indexOf('min-width') !== -1 ? env.wide : false }),
    // The bar is 72 px, and 30 more while it shows the warning.
    measure: (el) => (o.height !== undefined ? o.height : 72) + (el.querySelector('.wsp-warn') ? 30 : 0),
    isVisible: (el) => !el.closest('[hidden]'),
    now: () => NOW0 + clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ResizeObserver: null,
    isDialogOpen: () => env.dialog,
    leaveTo: (u) => env.left.push(u),
    win,
    CloseWatcher: o.closeWatcher === false ? null : FakeCloseWatcher,
    hasActivation: () => env.activation
  };
  const ui = make ? make(opts) : null;
  const q = (sel) => doc.querySelector(sel);
  const qa = (sel) => Array.from(doc.querySelectorAll(sel));
  const cssH = () => doc.documentElement.style.getPropertyValue('--ws-player-h');
  const key = (target, k, extra = {}) => {
    const ev = new win.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra));
    target.dispatchEvent(ev);
    return ev;
  };
  const pointer = (target, type, y, id = 1) => target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, clientY: y, clientX: 10, pointerId: id, button: 0 }));
  return { win, doc, host, clock, engine, env, ui, opts, q, qa, cssH, key, pointer };
}

async function run(name, fn) {
  current = name;
  try {
    await fn();
  } catch (e) {
    failed += 1;
    total += 1;
    console.error(`FAIL ${name}: threw ${e && e.stack ? e.stack : e}`);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

await run('clock and time-left formats', () => {
  check('m:ss', U.formatClock(245000) === '4:05', U.formatClock(245000));
  check('h:mm:ss', U.formatClock(3723000) === '1:02:03', U.formatClock(3723000));
  check('never negative', U.formatClock(-5) === '0:00');
  check('hours and minutes', U.formatLeft(5 * H + 12 * 60000) === '5 h 12 min left', U.formatLeft(5 * H + 12 * 60000));
  check('whole hours', U.formatLeft(2 * H) === '2 h left', U.formatLeft(2 * H));
  check('minutes', U.formatLeft(12 * 60000) === '12 min left');
  check('under a minute rounds up', U.formatLeft(20000) === '1 min left', U.formatLeft(20000));
});

await run('time left at 1.5x is two thirds of 1x', () => {
  const at1 = U.timeLeft({ bookDurationMs: 3 * H, bookMs: 0, speed: 1 });
  const at15 = U.timeLeft({ bookDurationMs: 3 * H, bookMs: 0, speed: 1.5 });
  check('1x is the whole book', at1 === 3 * H, at1);
  check('1.5x is two thirds of it', Math.abs(at15 - at1 * 2 / 3) < 1e-6, [at15, at1]);
  check('from where the listener is', U.timeLeft({ bookDurationMs: 3 * H, bookMs: H, speed: 2 }) === H);
  check('a bad speed counts as 1x', U.timeLeft({ bookDurationMs: H, bookMs: 0, speed: 0 }) === H);
  check('never negative', U.timeLeft({ bookDurationMs: H, bookMs: 2 * H, speed: 1 }) === 0);
});

await run('finishes around', () => {
  const now = new Date(2026, 8, 29, 18, 0, 0).getTime();
  const same = U.finishesAround(now, 2 * H);
  check('the same day is a time', same === new Date(now + 2 * H).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), same);
  const later = U.finishesAround(now, 30 * H);
  check('within the week has the day', later.indexOf(new Date(now + 30 * H).toLocaleDateString([], { weekday: 'short' })) === 0, later);
  const far = U.finishesAround(now, 10 * 24 * H);
  check('further is a date', far === new Date(now + 10 * 24 * H).toLocaleDateString([], { month: 'short', day: 'numeric' }), far);
});

await run('chapter span', () => {
  const s = U.chapterSpan(BOOK);
  check('the current chapter', s.index === 1 && s.start === 600000 && s.end === 1500000 && s.label === 'Part 2 of 3', s);
  const none = U.chapterSpan(Object.assign({}, BOOK, { chapters: [], chapterIndex: -1 }));
  check('no chapters: the whole book', none.index === -1 && none.start === 0 && none.end === 3 * H, none);
  check('no book: none', U.chapterSpan(EMPTY) === null);
  const noEnd = U.chapterSpan(Object.assign({}, BOOK, { chapters: [{ label: 'A', start_ms: 0 }, { label: 'B', start_ms: 5000 }], chapterIndex: 0 }));
  check('a missing end is the next start', noEnd.end === 5000, noEnd);
});

// ---------------------------------------------------------------------------
// The mini bar
// ---------------------------------------------------------------------------

await run('the bar is hidden until a book is open, then --ws-player-h is its height', () => {
  const t = setup();
  check('the slot stays hidden', t.host.hidden === true);
  check('the bar is hidden', t.q('.wsp-bar').hidden === true);
  check('no height claimed', t.cssH() === '' || t.cssH() === '0px', t.cssH());
  t.engine.set(BOOK, 'open');
  check('the slot shows', t.host.hidden === false);
  check('the bar shows', t.q('.wsp-bar').hidden === false);
  check('--ws-player-h is the bar height', t.cssH() === '72px', t.cssH());
  check('the title', t.q('.wsp-bar-title').textContent === 'Three Parts');
  check('the chapter and the time left', t.q('.wsp-bar-meta').textContent === 'Part 2 of 3 · 2 h 49 min left', t.q('.wsp-bar-meta').textContent);
  check('the cover', t.q('.wsp-bar-art img').getAttribute('src') === BOOK.cover);
  check('the progress line', t.q('.wsp-line-fill').style.transform === 'scaleX(' + (700000 / (3 * H)).toFixed(4) + ')', t.q('.wsp-line-fill').style.transform);
  check('the play button says pause while playing', t.q('.wsp-bar .wsp-play').getAttribute('aria-label') === 'Pause');
  t.engine.set({ playing: false }, 'pause');
  check('and play while paused', t.q('.wsp-bar .wsp-play').getAttribute('aria-label') === 'Play');
  t.q('.wsp-bar .wsp-play').click();
  check('it toggles the engine', JSON.stringify(t.engine.calls) === '[["toggle"]]', t.engine.calls);
  t.engine.set(EMPTY, 'close');
  check('closed: hidden again', t.q('.wsp-bar').hidden === true && t.host.hidden === true);
  check('closed: no height', t.cssH() === '0px', t.cssH());
});

await run('the bar follows its own height', () => {
  const t = setup({ height: 88 });
  t.engine.set(BOOK, 'open');
  check('measured height', t.cssH() === '88px', t.cssH());
});

await run('opening a book shows the bar at once, as a skeleton', () => {
  const t = setup();
  t.engine.set({ loading: true }, 'loading');
  check('shown while loading', t.q('.wsp-bar').hidden === false && t.cssH() === '72px', t.cssH());
  check('a skeleton title', t.q('.wsp-bar-title').classList.contains('wsp-skel'));
  check('the play button is busy only when it will play', t.q('.wsp-bar .wsp-play').getAttribute('aria-label') === 'Play');
  t.engine.set({ playing: true }, 'play');
  check('busy', t.q('.wsp-bar .wsp-play').getAttribute('aria-label') === 'Loading');
  t.engine.set(Object.assign({}, BOOK, { loading: true }), 'open');
  check('the title replaces it', t.q('.wsp-bar-title').textContent === 'Three Parts' && !t.q('.wsp-bar-title').classList.contains('wsp-skel'));
  t.engine.set({ loading: false }, 'play');
  check('then pause', t.q('.wsp-bar .wsp-play').getAttribute('aria-label') === 'Pause');
});

await run('a failed open hides the bar and keeps the error on screen', () => {
  const t = setup();
  t.engine.set({ loading: true }, 'loading');
  const msg = "Your Plex account doesn't have access to this server";
  t.engine.emit('error', { code: 'forbidden', message: msg, retry: null });
  t.engine.set({ loading: false, error: { code: 'forbidden', message: msg } }, 'error');
  check('the bar goes', t.q('.wsp-bar').hidden === true && t.cssH() === '0px', t.cssH());
  check('the slot stays for the notice', t.host.hidden === false);
  const n = t.q('.wsp-notice');
  check('the API message, as it is', n && n.querySelector('.wsp-notice-text').textContent === msg);
  check('an alert', n && n.getAttribute('role') === 'alert');
  check('no Retry without a retry', !t.qa('.wsp-notice-btn').some((b) => b.textContent === 'Retry'));
  check('it can be dismissed', !!n.querySelector('.wsp-notice-x'));
  t.clock.advance(60000);
  check('it stays', t.qa('.wsp-notice').length === 1);
  t.engine.set({ error: null }, 'close');
  check('it goes with the error', t.qa('.wsp-notice').length === 0 && t.host.hidden === true);
});

await run('the book finished', () => {
  const t = setup();
  t.engine.set(Object.assign({}, BOOK, { bookMs: 3 * H, chapterIndex: 2, playing: false }), 'ended');
  check('says so', t.q('.wsp-bar-meta').textContent === 'Part 3 of 3 · Finished', t.q('.wsp-bar-meta').textContent);
  check('no clock', t.q('.wsp-left').textContent === 'Finished', t.q('.wsp-left').textContent);
});

// ---------------------------------------------------------------------------
// The full player
// ---------------------------------------------------------------------------

await run('open and close: the bar, the close button, Escape, focus back', async () => {
  // The page's own Escape (no CloseWatcher; the watcher path is below).
  const t = setup({ closeWatcher: false });
  t.engine.set(BOOK, 'open');
  const openBtn = t.q('.wsp-bar-open');
  const full = t.q('.wsp-full');
  let opened = 0;
  let closed = 0;
  t.ui.on('open', () => { opened += 1; });
  t.ui.on('close', () => { closed += 1; });
  check('a dialog, labelled by the title', full.getAttribute('role') === 'dialog' && full.getAttribute('aria-modal') === 'true' &&
    full.getAttribute('aria-labelledby') === 'wspTitle' && t.q('#wspTitle').textContent === 'Three Parts');
  check('closed at first', full.hidden === true && !t.ui.isOpen());
  openBtn.focus();
  openBtn.click();
  check('opens from the bar', t.ui.isOpen() && full.hidden === false && full.classList.contains('is-open'));
  check('marked on <html>', t.doc.documentElement.hasAttribute('data-player-full'));
  check('the bar says it is expanded', openBtn.getAttribute('aria-expanded') === 'true');
  check('the bar is out of reach', t.q('.wsp-bar').hasAttribute('inert'));
  check('focus moves in', full.contains(t.doc.activeElement) && t.doc.activeElement.getAttribute('aria-label') === 'Close the player');
  check('open heard', opened === 1);
  t.key(t.doc.activeElement, 'Escape');
  check('Escape closes', !t.ui.isOpen() && !full.classList.contains('is-open'));
  check('focus goes back to the bar', t.doc.activeElement === openBtn);
  check('the bar is back', !t.q('.wsp-bar').hasAttribute('inert') && openBtn.getAttribute('aria-expanded') === 'false');
  check('close heard', closed === 1);
  await t.clock.advance(400);
  check('then it is gone', full.hidden === true && !t.doc.documentElement.hasAttribute('data-player-full'));

  t.q('#pageBtn').focus();
  t.ui.open();
  t.q('.wsp-full .wsp-icon-btn').click();
  check('the close button closes', !t.ui.isOpen());
  check('focus goes back where it was', t.doc.activeElement === t.q('#pageBtn'));

  t.ui.open();
  t.env.dialog = true;
  t.key(t.doc.activeElement, 'Escape');
  check('a dialog on top takes Escape', t.ui.isOpen());
  t.env.dialog = false;
  t.key(t.doc.activeElement, 'Escape', { isComposing: true });
  check('mid-composition Escape is the input method\'s', t.ui.isOpen());
  t.key(t.doc.activeElement, 'Escape');
  check('then it closes', !t.ui.isOpen());
});

await run('focus stays inside while open', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.ui.open();
  const full = t.q('.wsp-full');
  const f = Array.from(full.querySelectorAll('button, input')).filter((el) => !el.closest('[hidden]') && !el.disabled);
  const first = f[0];
  const last = f[f.length - 1];
  check('the first is the close button', first.getAttribute('aria-label') === 'Close the player');
  last.focus();
  const ev = t.key(last, 'Tab');
  check('Tab from the last wraps to the first', t.doc.activeElement === first && ev.defaultPrevented);
  t.key(first, 'Tab', { shiftKey: true });
  check('Shift+Tab from the first wraps to the last', t.doc.activeElement === last);
  t.q('#pageBtn').focus();
  check('focus that escapes comes back', full.contains(t.doc.activeElement));
  t.ui.close();
  t.q('#pageBtn').focus();
  check('closed: nothing held', t.doc.activeElement === t.q('#pageBtn'));
});

await run('swipe down closes, a short drag springs back', async () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.ui.open();
  const sheet = t.q('.wsp-sheet');
  const top = t.q('.wsp-top-label');
  t.pointer(top, 'pointerdown', 100);
  t.pointer(top, 'pointermove', 150);
  check('the sheet follows the finger', sheet.style.transform === 'translateY(50px)' && sheet.classList.contains('is-dragging'), sheet.style.transform);
  t.pointer(top, 'pointerup', 150);
  check('50 px springs back', t.ui.isOpen() && sheet.style.transform === '' && !sheet.classList.contains('is-dragging'));

  t.pointer(top, 'pointerdown', 100);
  t.pointer(top, 'pointermove', 180);
  t.pointer(top, 'pointermove', 260);
  t.pointer(top, 'pointerup', 260);
  check('160 px closes', !t.ui.isOpen());

  t.ui.open();
  const cover = t.q('.wsp-full-art');
  t.pointer(cover, 'pointerdown', 300);
  await t.clock.advance(50);
  t.pointer(cover, 'pointermove', 340);
  await t.clock.advance(50);
  t.pointer(cover, 'pointermove', 380);
  t.pointer(cover, 'pointerup', 380);
  check('a flick from the cover closes (80 px in 100 ms)', !t.ui.isOpen());

  t.ui.open();
  const range = t.q('.wsp-range');
  t.pointer(range, 'pointerdown', 400);
  t.pointer(range, 'pointermove', 700);
  t.pointer(range, 'pointerup', 700);
  check('never from the scrubber', t.ui.isOpen() && sheet.style.transform === '');
  const play = t.q('.wsp-full .wsp-play');
  t.pointer(play, 'pointerdown', 400);
  t.pointer(play, 'pointermove', 700);
  check('never from a button', sheet.style.transform === '');
  t.pointer(play, 'pointerup', 700);
  t.pointer(top, 'pointerdown', 100);
  t.pointer(top, 'pointermove', 400);
  t.pointer(top, 'pointercancel', 400);
  check('a cancelled drag springs back', t.ui.isOpen() && sheet.style.transform === '');
});

await run('reduced motion disables the slide', async () => {
  const moving = setup();
  moving.engine.set(BOOK, 'open');
  moving.ui.open();
  moving.ui.close();
  check('with motion the sheet slides away first', moving.q('.wsp-full').hidden === false);
  moving.q('.wsp-sheet').dispatchEvent(Object.assign(new moving.win.Event('transitionend', { bubbles: true }), { propertyName: 'transform' }));
  check('and goes when the slide ends', moving.q('.wsp-full').hidden === true);

  const still = setup({ reduce: true });
  still.engine.set(BOOK, 'open');
  still.ui.open();
  check('reduced: it is there at once', still.q('.wsp-full').hidden === false && still.q('.wsp-full').classList.contains('is-open'));
  still.ui.close();
  check('reduced: it goes at once, no slide to wait for', still.q('.wsp-full').hidden === true &&
    !still.doc.documentElement.hasAttribute('data-player-full'));
  check('reduced: no timer left behind', still.clock.pending() === 0, still.clock.pending());

  const back = setup();
  back.engine.set(BOOK, 'open');
  back.ui.open();
  back.ui.close();
  back.ui.open();
  await back.clock.advance(1000);
  check('reopened while sliding away: it stays', back.ui.isOpen() && back.q('.wsp-full').hidden === false);
});

await run('the full player shows the book', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.ui.open();
  check('series', t.q('.wsp-series').textContent === 'Saga');
  check('author and narrator', t.q('.wsp-byline').textContent === 'A. Writer · Read by N. Reader', t.q('.wsp-byline').textContent);
  check('the chapter', t.q('.wsp-chapter').textContent === 'Part 2 of 3');
  check('its time', t.q('.wsp-times').children[0].textContent === '1:40' && t.q('.wsp-times').children[1].textContent === '−13:20',
    t.q('.wsp-times').textContent);
  const left = t.q('.wsp-left').textContent;
  check('time left and the clock', left === '2 h 49 min left · Finishes around ' + U.finishesAround(NOW0, 3 * H - 700000), left);
  t.engine.set({ speed: 1.5 }, 'speed');
  const left15 = t.q('.wsp-left').textContent;
  const ms15 = (3 * H - 700000) / 1.5;
  check('at 1.5x: two thirds, and an earlier clock', left15 === U.formatLeft(ms15) + ' · Finishes around ' + U.finishesAround(NOW0, ms15), left15);
  check('the bar follows the speed too', t.q('.wsp-bar-meta').textContent === 'Part 2 of 3 · ' + U.formatLeft(ms15));
  t.engine.set({ narrator: '', series: '' }, 'open');
  const t2 = setup();
  t2.engine.set(Object.assign({}, BOOK, { narrator: '', series: '', book: '9:1' }), 'open');
  check('no narrator: the author alone', t2.q('.wsp-byline').textContent === 'A. Writer');
  check('no series: hidden', t2.q('.wsp-series').hidden === true);
});

await run('covers keep their shape', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  const img = t.q('.wsp-full-art img');
  check('a picture, not a background', img && img.getAttribute('src') === BOOK.cover && img.getAttribute('alt') === '');
  const css = readFileSync(join(here, '../../static/css/theme.css'), 'utf8');
  check('contained, never cropped', /\.wsp-art img \{[^}]*object-fit: contain;/.test(css));
  img.dispatchEvent(new t.win.Event('error'));
  check('a broken cover shows the mark', img.hidden === true && t.q('.wsp-full-art .wsp-art-mark').hidden === false);
  const t2 = setup();
  t2.engine.set(Object.assign({}, BOOK, { cover: '' }), 'open');
  check('no cover: the mark', t2.q('.wsp-bar-art .wsp-art-mark').hidden === false && !t2.q('.wsp-bar-art img').getAttribute('src'));
});

await run('CloseWatcher: one per layer, closed innermost first, never history', () => {
  const t = setup();
  const len = t.win.history.length;
  t.engine.set(BOOK, 'open');
  const openBtn = t.q('.wsp-bar-open');
  openBtn.focus();
  openBtn.click();
  check('the player has a watcher', t.env.watchers.length === 1);
  t.env.closeRequest();
  check('a close request (Android Back) closes the player', !t.ui.isOpen());
  check('focus back on the bar', t.doc.activeElement === openBtn);
  check('no watcher left', t.env.watchers.length === 0);

  t.ui.open();
  const chaptersBtn = t.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1);
  chaptersBtn.click();
  check('a panel over the player: a second watcher', t.env.watchers.length === 2 && t.q('.wsp-full').getAttribute('data-view') === 'chapters');
  t.env.closeRequest();
  check('the first close request closes the panel', t.ui.isOpen() && !t.q('.wsp-full').hasAttribute('data-view') && t.env.watchers.length === 1);
  check('focus back on the button that showed it', t.doc.activeElement === chaptersBtn);
  t.env.closeRequest();
  check('the next closes the player', !t.ui.isOpen() && t.env.watchers.length === 0);

  t.ui.open();
  chaptersBtn.click();
  let ev = t.env.escape();
  check('Escape is left to the browser: not cancelled', !ev.defaultPrevented);
  check('Escape: the panel first', t.ui.isOpen() && !t.q('.wsp-full').hasAttribute('data-view') && t.env.watchers.length === 1);
  ev = t.env.escape();
  check('Escape again: the player', !t.ui.isOpen() && t.env.watchers.length === 0 && !ev.defaultPrevented);

  check('no history entry, ever', t.env.historyWrites === 0 && t.win.history.length === len, [t.env.historyWrites, t.win.history.length]);

  const wide = setup({ wide: true });
  wide.engine.set(BOOK, 'open');
  wide.ui.open();
  wide.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1).click();
  check('wide: a panel beside the player has no watcher', wide.env.watchers.length === 1);
  wide.env.escape();
  check('wide: Escape closes the player', !wide.ui.isOpen() && wide.env.watchers.length === 0);
});

await run('every way a layer closes destroys its watcher', async () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  const chaptersBtn = () => t.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1);
  const ways = {
    'the close button': () => t.q('.wsp-full .wsp-icon-btn').click(),
    'WS.playerUI.close()': () => t.ui.close(),
    'a swipe': () => {
      const top = t.q('.wsp-top-label');
      t.pointer(top, 'pointerdown', 100);
      t.pointer(top, 'pointermove', 200);
      t.pointer(top, 'pointermove', 300);
      t.pointer(top, 'pointerup', 300);
    },
    'the book closing': () => { t.engine.set(EMPTY, 'close'); t.engine.set(BOOK, 'open'); },
    'a new page': () => t.win.dispatchEvent(new t.win.CustomEvent('ws:page-mounted', { detail: {} })),
    'a wiki view': () => t.win.dispatchEvent(new t.win.CustomEvent('ws:page-claimed', { detail: {} }))
  };
  for (const [name, way] of Object.entries(ways)) {
    t.ui.open();
    chaptersBtn().click();
    const made = t.env.made;
    way();
    check(name + ': closed', !t.ui.isOpen(), name);
    check(name + ': both watchers gone', t.env.watchers.length === 0, [name, t.env.watchers.length, made]);
  }
  t.ui.open();
  chaptersBtn().click();
  t.q('.wsp-panel-back').click();
  check('the panel\'s back button: its watcher gone, the player\'s kept', t.env.watchers.length === 1 && t.ui.isOpen());
  chaptersBtn().click();
  t.qa('.wsp-chapter-item')[2].click();
  check('a jump from the list: the same', t.env.watchers.length === 1 && !t.q('.wsp-full').hasAttribute('data-view'));
  t.ui.close();
  for (let n = 0; n < 20; n++) {
    t.ui.open();
    chaptersBtn().click();
    if (n % 2) { t.env.closeRequest(); t.env.closeRequest(); } else t.ui.close();
  }
  check('20 opens and closes leave no watcher', t.env.watchers.length === 0 && !t.ui.isOpen() && t.env.made === t.env.destroyed + 20,
    [t.env.watchers.length, t.env.made, t.env.destroyed]);
  check('and no history', t.env.historyWrites === 0);
});

await run('no tap or key: no watcher, Escape handled here', () => {
  const t = setup({ activation: false });
  t.engine.set(BOOK, 'open');
  t.ui.open();
  check('no watcher', t.env.watchers.length === 0);
  const ev = t.env.escape();
  check('Escape closes it itself', !t.ui.isOpen() && ev.defaultPrevented);
});

await run('no CloseWatcher: Escape innermost first, the player closes when a page is shown', () => {
  const t = setup({ closeWatcher: false });
  t.engine.set(BOOK, 'open');
  t.ui.open();
  t.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1).click();
  let ev = t.env.escape();
  check('Escape: the panel first', ev.defaultPrevented && t.ui.isOpen() && !t.q('.wsp-full').hasAttribute('data-view'));
  ev = t.env.escape();
  check('Escape again: the player', ev.defaultPrevented && !t.ui.isOpen());
  t.ui.open();
  t.win.dispatchEvent(new t.win.CustomEvent('ws:page-mounted', { detail: { url: '/x' } }));
  check('Back (a page mounted) closes it', !t.ui.isOpen());
  t.ui.open();
  t.win.dispatchEvent(new t.win.CustomEvent('ws:page-claimed', { detail: { url: '/wiki/a' } }));
  check('a wiki view shown under it closes it', !t.ui.isOpen());
  t.win.dispatchEvent(new t.win.CustomEvent('ws:page-mounted', { detail: {} }));
  check('a page mounting with the player closed changes nothing', !t.ui.isOpen() && t.q('.wsp-bar').hidden === false);
  check('no history', t.env.historyWrites === 0);
});

await run('T7U1: keys inside the full player never reach the page', () => {
  const t = setup();
  const turned = [];
  // A reader's page-turn keys, on document (reader.js).
  t.doc.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'j' || e.key === ' ') { e.preventDefault(); turned.push(e.key); }
    else if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); turned.push(e.key); }
  });
  t.engine.set(BOOK, 'open');
  t.ui.open();
  const play = t.q('.wsp-full .wsp-play');
  play.focus();
  const space = t.key(play, ' ');
  for (const k of ['ArrowRight', 'ArrowLeft', 'j', 'k']) t.key(play, k);
  check('the page heard none of them', turned.length === 0, turned);
  check('Space is left to the button (not cancelled)', !space.defaultPrevented);
  const f = Array.from(t.q('.wsp-full').querySelectorAll('button, input')).filter((el) => !el.closest('[hidden]') && !el.disabled);
  f[f.length - 1].focus();
  t.key(f[f.length - 1], 'Tab');
  check('Tab still wraps', t.doc.activeElement === f[0]);
  t.env.escape();
  check('Escape still closes', !t.ui.isOpen());
  t.key(t.doc.body, 'ArrowRight');
  check('closed, the page has its keys back', turned.join() === 'ArrowRight', turned);
});

await run('T7U2: the warning shows over a panel too', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.ui.open();
  t.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1).click();
  const msg = "Your place isn't being saved. Last saved 9:41 PM.";
  t.engine.emit('warning', { kind: 'not-saved', active: true, lastSavedAt: 1, message: msg });
  const live = t.qa('.wsp-warn-live')[1];
  check('in the sheet, outside the player view a panel hides', live.parentNode === t.q('.wsp-sheet') && !live.closest('.wsp-main'));
  check('said', live.textContent === msg);
  const css = readFileSync(join(here, '../../static/css/theme.css'), 'utf8');
  check('no rule hides it with the player view', !/\.wsp-main[^{]*\.wsp-warn-live/.test(css));
});

await run('T7U3: only a real flick closes', async () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.ui.open();
  const top = t.q('.wsp-top-label');
  // 99 px quickly, then held for 3 s before letting go.
  t.pointer(top, 'pointerdown', 100);
  await t.clock.advance(30);
  t.pointer(top, 'pointermove', 199);
  await t.clock.advance(3000);
  t.pointer(top, 'pointerup', 199);
  check('a drag held still is no flick', t.ui.isOpen());
  // An 8 px wobble, fast.
  t.pointer(top, 'pointerdown', 100);
  await t.clock.advance(5);
  t.pointer(top, 'pointermove', 108);
  await t.clock.advance(5);
  t.pointer(top, 'pointerup', 108);
  check('a wobble is no flick', t.ui.isOpen());
  // 60 px in 60 ms, released at once.
  t.pointer(top, 'pointerdown', 100);
  await t.clock.advance(30);
  t.pointer(top, 'pointermove', 130);
  await t.clock.advance(30);
  t.pointer(top, 'pointerup', 160);
  check('a flick closes', !t.ui.isOpen());
});

await run('T7U4: slots never start a swipe', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  const menu = t.doc.createElement('div');
  menu.textContent = 'Skip length';
  t.ui.fill('menu', menu);
  t.ui.open();
  for (const name of U.SLOTS) check(name + ' opts out', t.ui.slot(name).hasAttribute('data-no-swipe'));
  t.pointer(menu, 'pointerdown', 100);
  t.pointer(menu, 'pointermove', 400);
  t.pointer(menu, 'pointerup', 400);
  check('a drag on the menu is not a swipe', t.ui.isOpen() && t.q('.wsp-sheet').style.transform === '');
});

await run('T7U5: the book closing under the full player puts focus somewhere real', () => {
  const t = setup();
  t.doc.querySelector('main').insertAdjacentHTML('afterbegin', '<div id="wsPage"><h1 id="pageTitle">News</h1></div>');
  t.engine.set(BOOK, 'open');
  const openBtn = t.q('.wsp-bar-open');
  openBtn.focus();
  openBtn.click();
  t.engine.set(EMPTY, 'close');
  check('not the hidden bar: the page heading', t.doc.activeElement === t.q('#pageTitle') && t.q('#pageTitle').getAttribute('tabindex') === '-1',
    t.doc.activeElement && t.doc.activeElement.outerHTML.slice(0, 60));
  // A failed open: its Retry.
  t.engine.set(BOOK, 'open');
  openBtn.focus();
  openBtn.click();
  t.engine.set({ book: null, loading: true }, 'loading');
  t.engine.emit('error', { code: 'unreachable', message: "Can't reach the media server", retry: () => Promise.resolve() });
  t.engine.set(Object.assign({}, EMPTY, { error: { code: 'unreachable', message: "Can't reach the media server" } }), 'error');
  check('a failed open: focus on Retry', t.doc.activeElement && t.doc.activeElement.textContent === 'Retry', t.doc.activeElement && t.doc.activeElement.outerHTML.slice(0, 80));
});

await run('T7U6: a retry that can no longer find the place says so', async () => {
  const t = setup();
  const lost = Object.assign(new Error("The saved place is in a part this book doesn't have"), { name: 'UnknownTrack' });
  t.engine.emit('error', { code: 'unreachable', message: "Can't reach the media server", retry: () => Promise.reject(lost) });
  const quiet = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  t.qa('.wsp-notice-btn').find((b) => b.textContent === 'Retry').click();
  await flush();
  console.error = quiet;
  const texts = t.qa('.wsp-notice-text').map((n) => n.textContent);
  check('the resume-lost notice', texts.indexOf("Couldn't find your saved place in this book") !== -1, texts);
  check('not just a log line', logged.length === 0, logged);
});

// ---------------------------------------------------------------------------
// The warning
// ---------------------------------------------------------------------------

await run('the not-saved warning, in both, in live regions', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  const [barLive, fullLive] = t.qa('.wsp-warn-live');
  check('two regions: the bar\'s and the full player\'s', barLive && fullLive && t.q('.wsp-bar').contains(barLive) && t.q('.wsp-full').contains(fullLive));
  for (const r of [barLive, fullLive]) {
    check('polite status region', r.getAttribute('role') === 'status' && r.getAttribute('aria-live') === 'polite' && r.getAttribute('aria-atomic') === 'true');
    check('empty at rest', r.textContent === '');
  }
  const msg = "Your place isn't being saved. Last saved 9:41 PM.";
  t.engine.emit('warning', { kind: 'not-saved', active: true, lastSavedAt: 1, message: msg });
  t.engine.set({ saveError: true }, 'save');
  check('the bar says it', barLive.textContent === msg, barLive.textContent);
  check('the full player says it', fullLive.textContent === msg, fullLive.textContent);
  check('the bar grows and the page follows', t.cssH() === '102px', t.cssH());
  t.engine.set({ bookMs: 710000 }, 'time');
  check('it stays while saves fail', barLive.textContent === msg);
  t.engine.emit('warning', { kind: 'not-saved', active: false, lastSavedAt: 2, message: '' });
  t.engine.set({ saveError: false }, 'save');
  check('cleared on active:false', barLive.textContent === '' && fullLive.textContent === '');
  check('the page gets its space back', t.cssH() === '72px', t.cssH());
  t.engine.emit('warning', { kind: 'not-saved', active: true, lastSavedAt: 1, message: msg });
  t.engine.emit('warning', { kind: 'not-saved', active: false, lastSavedAt: 2, message: msg });
  check('active:false clears it even with a stale message', barLive.textContent === '' && fullLive.textContent === '');
  t.engine.emit('warning', { kind: 'not-saved', active: true, lastSavedAt: 1, message: msg });
  t.engine.set(EMPTY, 'close');
  check('a closed book clears it', barLive.textContent === '');
});

// ---------------------------------------------------------------------------
// The scrubber
// ---------------------------------------------------------------------------

await run('the scrubber seeks on release only', async () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.ui.open();
  const range = t.q('.wsp-range');
  check('the chapter is its length', range.getAttribute('max') === '900' && range.value === '100', [range.getAttribute('max'), range.value]);
  check('it says where, in words', range.getAttribute('aria-valuetext') === '1 minute 40 seconds of 15 minutes', range.getAttribute('aria-valuetext'));
  check('labelled', range.getAttribute('aria-label') === 'Position in this chapter');
  t.pointer(range, 'pointerdown', 10);
  range.value = '500';
  range.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  check('dragging does not seek', !t.engine.calls.some((c) => c[0] === 'seek'));
  check('the drag shows live', t.q('.wsp-times').children[0].textContent === '8:20' && t.q('.wsp-times').children[1].textContent === '−6:40',
    t.q('.wsp-times').textContent);
  t.engine.set({ bookMs: 702000 }, 'time');
  check('playback does not pull it back', range.value === '500');
  range.value = '520';
  range.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  range.dispatchEvent(new t.win.Event('change', { bubbles: true }));
  const seeks = t.engine.calls.filter((c) => c[0] === 'seek');
  check('one seek on release, into the chapter', seeks.length === 1 && seeks[0][1] === 600000 + 520000, seeks);
  t.engine.set({ bookMs: 1120000 }, 'seek');
  check('then it follows playback', range.value === '520');

  t.pointer(range, 'pointerdown', 10);
  t.pointer(range, 'pointerup', 10);
  await t.clock.advance(1);
  t.engine.set({ bookMs: 1130000 }, 'time');
  check('a tap that moved nothing lets go', range.value === '530', range.value);

  t.engine.calls.length = 0;
  t.key(range, 'ArrowRight');
  t.key(range, 'ArrowLeft');
  check('arrows move by the skip length', JSON.stringify(t.engine.calls) === '[["skip",10],["skip",-10]]', t.engine.calls);
  t.engine.setSkip(30);
  t.key(range, 'ArrowUp');
  check('whatever it is', JSON.stringify(t.engine.calls.slice(-1)) === '[["skip",30]]', t.engine.calls);
});

await run('no book: the scrubber is off', () => {
  const t = setup();
  t.engine.set({ loading: true }, 'loading');
  check('disabled while loading', t.q('.wsp-range').disabled === true);
});

// ---------------------------------------------------------------------------
// Skip and the chapter list
// ---------------------------------------------------------------------------

await run('skip buttons use the engine\'s skip length', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  const [back, fwd] = t.qa('.wsp-skip');
  check('labelled with the seconds', back.textContent.indexOf('10') !== -1 && fwd.textContent.indexOf('10') !== -1);
  check('named for a screen reader', back.getAttribute('aria-label') === 'Back 10 seconds' && fwd.getAttribute('aria-label') === 'Forward 10 seconds');
  back.click();
  fwd.click();
  check('they skip', JSON.stringify(t.engine.calls) === '[["skip",-10],["skip",10]]', t.engine.calls);
  t.engine.setSkip(30);
  t.engine.set({}, 'time');
  check('a new length relabels them', back.getAttribute('aria-label') === 'Back 30 seconds' && t.q('.wsp-skip-n').textContent === '30');
  fwd.click();
  check('and skips by it', JSON.stringify(t.engine.calls.slice(-1)) === '[["skip",30]]');
});

await run('the chapter list marks the current chapter and jumps', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.ui.open();
  const items = t.qa('.wsp-chapter-item');
  check('one per chapter', items.length === 3);
  check('names and lengths', items[0].textContent.indexOf('Part 1 of 3') !== -1 && items[1].querySelector('.wsp-chapter-len').textContent === '15:00');
  check('the current one marked', items[1].getAttribute('aria-current') === 'true' && !items[0].hasAttribute('aria-current') && items[1].classList.contains('is-current'));
  check('earlier ones are past', items[0].classList.contains('is-past') && !items[2].classList.contains('is-past'));
  const chaptersBtn = t.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1);
  check('a Chapters button', chaptersBtn && !chaptersBtn.closest('[hidden]'));
  chaptersBtn.focus();
  chaptersBtn.click();
  check('it shows the list over the player on a phone', t.q('.wsp-full').getAttribute('data-view') === 'chapters');
  check('focus on its heading', t.doc.activeElement === t.q('#wspPanel-chapters'));
  items[2].click();
  check('a tap jumps', JSON.stringify(t.engine.calls) === '[["jump",2]]', t.engine.calls);
  check('and goes back to the player', !t.q('.wsp-full').hasAttribute('data-view'));
  check('focus back on the button', t.doc.activeElement === chaptersBtn);
  t.engine.set({ chapterIndex: 2, bookMs: 1500000 }, 'jump');
  check('the mark moves', items[2].getAttribute('aria-current') === 'true' && !items[1].hasAttribute('aria-current'));
  t.q('.wsp-full .wsp-icon-btn').focus();
  chaptersBtn.click();
  t.q('.wsp-panel-back').click();
  check('the back button returns', !t.q('.wsp-full').hasAttribute('data-view'));
  check('focus back on the button that showed it, even when the tap did not focus it', t.doc.activeElement === chaptersBtn);

  const wide = setup({ wide: true });
  wide.engine.set(BOOK, 'open');
  wide.ui.open();
  check('wide: the list is beside the player', wide.q('.wsp-full').hasAttribute('data-side') && wide.q('[data-panel="chapters"]').hidden === false);
  wide.qa('.wsp-chapter-item')[0].click();
  check('wide: a jump keeps it', JSON.stringify(wide.engine.calls) === '[["jump",0]]' && wide.q('[data-panel="chapters"]').hidden === false);

  const one = setup();
  one.engine.set(Object.assign({}, BOOK, { chapters: [BOOK.chapters[0]], chapterIndex: 0 }), 'open');
  check('one chapter: no Chapters button', one.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1).closest('[hidden]') !== null);
  check('one chapter: nothing beside', !one.q('.wsp-full').hasAttribute('data-side'));
});

await run('a new book redraws the list', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.engine.set(EMPTY, 'close');
  t.engine.set(Object.assign({}, BOOK, { book: '600:1', title: 'Two', chapters: BOOK.chapters.slice(0, 2), chapterIndex: 0 }), 'open');
  check('its chapters', t.qa('.wsp-chapter-item').length === 2);
  check('its title', t.q('.wsp-bar-title').textContent === 'Two' && t.q('#wspTitle').textContent === 'Two');
});

// ---------------------------------------------------------------------------
// Notices, errors and prompts
// ---------------------------------------------------------------------------

await run('an unreachable server: the copy and Retry', async () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  let retried = 0;
  t.engine.emit('error', { code: 'unreachable', message: "Can't reach the media server", retry: () => { retried += 1; return Promise.resolve(); } });
  t.engine.set({ error: { code: 'unreachable', message: "Can't reach the media server" }, playing: false }, 'error');
  const n = t.q('.wsp-notice');
  check('the copy', n && n.querySelector('.wsp-notice-text').textContent === "Can't reach the media server");
  const btn = t.qa('.wsp-notice-btn').find((b) => b.textContent === 'Retry');
  check('a Retry button', !!btn);
  await t.clock.advance(120000);
  check('it waits for the listener', t.qa('.wsp-notice').length === 1);
  btn.click();
  await flush();
  check('Retry retries', retried === 1);
  check('and the notice goes', t.qa('.wsp-notice').length === 0);
  t.engine.emit('error', { code: 'unreachable', message: "Can't reach the media server", retry: () => Promise.reject(new Error('x')) });
  t.engine.emit('error', { code: 'unreachable', message: "Can't reach the media server", retry: () => Promise.resolve() });
  check('one error notice at a time', t.qa('.wsp-notice').length === 1);
  t.engine.set({ error: null, playing: true }, 'retry');
  check('the error ending takes it away', t.qa('.wsp-notice').length === 0);
});

await run('a session that ended offers sign-in', () => {
  const t = setup();
  t.engine.emit('error', { code: 'signed-out', message: 'Your session has ended. Sign in again to listen.', retry: null });
  const b = t.qa('.wsp-notice-btn').find((x) => x.textContent === 'Sign in');
  check('a Sign in button', !!b);
  b.click();
  check('it goes through the shell', JSON.stringify(t.env.left) === '["/login"]', t.env.left);
});

await run('a skipped part and a lost place are notices', async () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  t.engine.emit('warning', { kind: 'resume-lost', message: "Couldn't find your saved place in this book" });
  t.engine.emit('warning', { kind: 'part-skipped', message: "Part 2 of 3 couldn't be played, so it was skipped." });
  const texts = t.qa('.wsp-notice-text').map((n) => n.textContent);
  check('the resume-lost copy', texts[0] === "Couldn't find your saved place in this book", texts);
  check('the part-skipped copy', texts[1] === "Part 2 of 3 couldn't be played, so it was skipped.", texts);
  check('polite, not alerts', t.qa('.wsp-notice').every((n) => !n.hasAttribute('role')) && t.q('.wsp-notices').getAttribute('aria-live') === 'polite');
  await t.clock.advance(U.NOTICE_MS + 10);
  check('they go by themselves', t.qa('.wsp-notice').length === 0);
});

await run('notices: the API for the features', async () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  let undone = 0;
  const n = t.ui.notify('Jumped 12 min. Undo', { action: { label: 'Undo', run: () => { undone += 1; } }, duration: 8000 });
  check('shown above the bar', t.q('#wsPlayer > .wsp-notices .wsp-notice') !== null);
  await t.clock.advance(7990);
  check('still there before its time', n.shown);
  t.qa('.wsp-notice-btn')[0].click();
  check('its button runs and removes it', undone === 1 && !n.shown && t.qa('.wsp-notice').length === 0);
  const m = t.ui.notify('Sleep timer off');
  await t.clock.advance(U.NOTICE_MS + 1);
  check('by default it goes after a while', !m.shown);
  const a = t.ui.notify('one', { id: 'x', duration: 0 });
  const b = t.ui.notify('two', { id: 'x', duration: 0 });
  check('the same id replaces', !a.shown && b.shown && t.qa('.wsp-notice').length === 1);
  b.remove();
  for (let i = 0; i < 5; i++) t.ui.notify('n' + i);
  check('at most three at once', t.qa('.wsp-notice').length === U.MAX_NOTICES);
  check('the newest kept', t.qa('.wsp-notice-text').map((x) => x.textContent).join() === 'n2,n3,n4');
  t.ui.open();
  check('inside the full player while it is open', t.q('.wsp-sheet .wsp-notices') !== null);
  t.ui.close();
  check('back above the bar after', t.q('#wsPlayer > .wsp-notices') !== null);
});

await run('prompts: handoff and up next', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  const ran = [];
  const p = t.ui.prompt({
    message: 'Continue from 1:02:03 (Chrome on Android, 2 hours ago)?',
    actions: [{ label: 'Continue', run: () => ran.push('continue'), primary: true }, { label: 'Start from here', run: () => ran.push('here') }]
  });
  const btns = t.qa('.wsp-prompt .wsp-notice-btn');
  check('its buttons', btns.map((b) => b.textContent).join('|') === 'Continue|Start from here');
  check('the primary one stands out', btns[0].classList.contains('is-primary') && !btns[1].classList.contains('is-primary'));
  check('no dismiss: it is a question', !t.q('.wsp-prompt .wsp-notice-x'));
  t.clock.advance(600000);
  check('it waits', p.shown);
  const q = t.ui.prompt({ message: 'Up next: Book Two', actions: [{ label: 'Play', run: () => ran.push('play'), primary: true }] });
  check('a new prompt replaces the last', !p.shown && q.shown && t.qa('.wsp-prompt').length === 1);
  t.q('.wsp-prompt .wsp-notice-btn').click();
  check('pressed: runs and goes', JSON.stringify(ran) === '["play"]' && !q.shown);
});

await run('slots stay hidden until filled; panels', () => {
  const t = setup();
  t.engine.set(BOOK, 'open');
  for (const name of U.SLOTS) check(name + ' hidden at first', t.ui.slot(name).hidden === true && t.ui.slot(name).childElementCount === 0);
  check('an unknown slot', t.ui.slot('nope') === null);
  const b = t.ui.actionButton({ text: '1.5×', label: 'Speed' });
  check('an action button', b.tagName === 'BUTTON' && b.type === 'button' && b.textContent === '1.5×Speed');
  t.ui.fill('speed', b);
  check('filled: shown', t.ui.slot('speed').hidden === false && t.ui.slot('speed').contains(b));
  t.ui.clear('speed');
  check('cleared: hidden again', t.ui.slot('speed').hidden === true && !t.ui.slot('speed').contains(b));
  const h = t.ui.panel('history', { title: 'History' });
  check('the same panel twice', t.ui.panel('history') === h);
  h.body.appendChild(t.doc.createElement('ol'));
  t.ui.open();
  h.show();
  check('shown', h.shown && t.q('.wsp-full').getAttribute('data-view') === 'history' && t.q('[data-panel="history"]').hidden === false &&
    t.q('[data-panel="chapters"]').hidden === true);
  check('named by its title', t.q('[data-panel="history"]').getAttribute('aria-labelledby') === 'wspPanel-history' && t.q('#wspPanel-history').textContent === 'History');
  h.hide();
  check('hidden', !h.shown && !t.q('.wsp-full').hasAttribute('data-view'));
  h.show();
  t.ui.close();
  check('closing the player resets it', !h.shown);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await run('boot: once per document, in #wsPlayer, beside the engine\'s audio', () => {
  const win = new Window({ url: 'https://ws.test/news' });
  const doc = win.document;
  doc.body.innerHTML = '<main></main><div id="wsPlayer" hidden><audio data-ws-player-audio></audio></div>';
  const engine = fakeEngine();
  win.WS = { player: engine };
  const ui = U.boot(win);
  check('WS.playerUI', win.WS.playerUI === ui && typeof ui.notify === 'function');
  check('a second boot is the same one', U.boot(win) === ui);
  check('one bar', doc.querySelectorAll('.wsp-bar').length === 1);
  check('the audio stays', doc.querySelector('#wsPlayer > audio') !== null);
  check('it listens to the engine once', engine.listeners('change') === 1 && engine.listeners('warning') === 1 && engine.listeners('error') === 1);
  const bare = new Window({ url: 'https://ws.test/login' });
  bare.WS = { player: fakeEngine() };
  check('no #wsPlayer: nothing', U.boot(bare) === null && !bare.WS.playerUI);
  const noEngine = new Window({ url: 'https://ws.test/news' });
  noEngine.document.body.innerHTML = '<div id="wsPlayer" hidden></div>';
  check('no engine: nothing', U.boot(noEngine) === null);
});

await run('no markup from strings', () => {
  const src = readFileSync(UI_PATH, 'utf8');
  check('no innerHTML or insertAdjacentHTML', !/innerHTML|insertAdjacentHTML|outerHTML/.test(src));
  check('no intervals', src.indexOf('setInterval') === -1);
});

const summary = `${total - failed}/${total} player UI cases pass`;
if (failed) {
  console.error(summary.replace('pass', 'checked') + `, ${failed} failed`);
  process.exit(1);
}
console.log(summary);
