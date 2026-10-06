// The desktop player (app/static/js/player/ui.js and popout.js, and the
// remote window's app/static/js/player-remote.js) in
// happy-dom: the top bar's pill and its states, the floating window (open,
// its X and Escape back to the pill, the pill's Stop (right of Play) with
// Resume, panels opening below and
// closing again, Playback settings back to Chapters), moving and sizing it
// by pointer and keyboard inside the viewport, its remembered place per
// listener, soft navigation leaving it open, the phone keeping the sheet,
// and Pop out through fakes: Document Picture-in-Picture (a second happy-dom
// document) and the remote window over a fake BroadcastChannel, both ends.
//
// Imports the modules as they are, through data: URLs, which also proves
// they touch no DOM at import time.
// Run: node app/tests/js/player_window.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(join(here, '../../static/js/player', name), 'utf8')));
const U = await load('ui.js');
const P = await load('popout.js');
const R = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(join(here, '../../static/js/player-remote.js'), 'utf8')));

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

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock() {
  let now = 0;
  let ids = 0;
  const due = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms) { const id = ++ids; due.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { due.delete(id); },
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
  const e = {
    calls,
    state: () => JSON.parse(JSON.stringify(st)),
    set(patch, reason = 'time') {
      Object.assign(st, patch);
      for (const fn of Array.from(hs.change)) fn({ reason, state: e.state() });
    },
    emit(type, d) { for (const fn of Array.from(hs[type])) fn(d); },
    on(t, fn) { hs[t].add(fn); return () => hs[t].delete(fn); },
    toggle() { calls.push(['toggle']); },
    seek(ms) { calls.push(['seek', ms]); },
    skip(s) { calls.push(['skip', s]); },
    jumpToChapter(i) { calls.push(['jump', i]); },
    setSkip() { return 15; },
    open(key, o) { calls.push(['open', key, o]); return Promise.resolve(); },
    close() { calls.push(['close']); e.set(EMPTY, 'close'); }
  };
  return e;
}

function memoryStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }
  };
}

// A desktop page: the top bar with the pill's slot, a 1440x900 viewport
// whose top bar ends at 64 px (the window stays from 72 px down).
function setup(o = {}) {
  const win = new Window({ url: 'https://ws.test/' });
  const doc = win.document;
  doc.body.innerHTML = '<header id="appHeader"><div id="wsPlayerPill" hidden></div><button id="bell" type="button">Bell</button></header>' +
    '<main><div id="wsPage"><h1>Home</h1><button id="pageBtn" type="button">Page</button></div></main><div id="wsPlayer" hidden></div>';
  if (o.shellHidden) doc.documentElement.setAttribute('data-shell', 'hidden');
  const clock = fakeClock();
  const engine = fakeEngine(o.state);
  const env = { wide: o.wide !== false, reduce: false, vp: { w: 1440, h: 900 }, wideFns: [], id: o.identity || 'abc0123456789def' };
  const storage = o.storage || memoryStorage();
  // The player kept in the top bar (the pill), or elsewhere, before it is built.
  if (o.dock) storage.setItem('ws-player-dock:' + env.id, JSON.stringify(typeof o.dock === 'string' ? { at: o.dock } : o.dock));
  const opts = {
    doc, host: doc.getElementById('wsPlayer'), player: engine,
    matchMedia: (q) => ({
      get matches() { return q.indexOf('reduce') !== -1 ? env.reduce : q.indexOf('min-width') !== -1 ? env.wide : false; },
      addEventListener(type, fn) { if (type === 'change' && q.indexOf('min-width') !== -1) env.wideFns.push(fn); }
    }),
    // The long bar on a desktop page is 73 px tall (its row and top border),
    // the square 168, the phone's bar 72; the window, with no panel, 400.
    measure: (el) => (el.classList.contains('wsp-full') ? 400 : el.classList.contains('wsp-bar')
      ? (!env.wide ? 72 : el.getAttribute('data-shape') === 'square' ? 168 : 73) : 0),
    isVisible: (el) => !el.closest('[hidden]'),
    now: () => clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ResizeObserver: null,
    isDialogOpen: () => false,
    win,
    CloseWatcher: null,
    hasActivation: () => true,
    storage,
    identity: () => env.id,
    viewport: () => ({ w: env.vp.w, h: env.vp.h }),
    topLimit: () => 72,
    laneLeft: () => (env.wide ? 256 : 0)
  };
  if (o.noPill) opts.pillSlot = null;
  const ui = U.createUI(opts);
  const q = (sel) => doc.querySelector(sel);
  const qa = (sel) => Array.from(doc.querySelectorAll(sel));
  const key = (target, k, extra = {}) => {
    const ev = new win.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra));
    target.dispatchEvent(ev);
    return ev;
  };
  const pointer = (target, type, x, y) => target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
  const full = doc.querySelector('.wsp-full');
  const rect = () => ({ x: parseInt(full.style.left, 10), y: parseInt(full.style.top, 10), w: parseInt(full.style.width, 10), h: full.style.height ? parseInt(full.style.height, 10) : null });
  env.setWide = (v) => { env.wide = !!v; for (const fn of env.wideFns) fn({ matches: env.wide }); };
  return { win, doc, clock, engine, env, ui, opts, q, qa, key, pointer, full, rect, storage };
}

const label = (t, text) => Array.from(t.full.querySelectorAll('.wsp-icon-btn, .wsp-win-resize')).find((b) => b.getAttribute('aria-label') === text);

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

await run('the pill: hidden without a book, then each of its states', () => {
  const t = setup({ dock: 'top' });
  const slot = t.q('#wsPlayerPill');
  const pill = t.q('.wsp-pill');
  check('built in the top bar, left of the bell', pill && slot.contains(pill) && slot.nextElementSibling === t.q('#bell'));
  check('its handle first, then the cover', pill.firstElementChild === t.q('.wsp-pill-grip') && pill.children[1] === t.q('.wsp-pill-open'));
  check('hidden with no book', slot.hidden === true);

  t.engine.set({ loading: true, playing: true, title: '' }, 'loading');
  check('opening a book: loading', !slot.hidden && pill.getAttribute('data-state') === 'loading', pill.getAttribute('data-state'));
  check('loading: its play button waits', t.q('.wsp-pill-play').getAttribute('aria-label') === 'Loading');

  t.engine.set(BOOK, 'open');
  check('playing', pill.getAttribute('data-state') === 'playing');
  check('title', t.q('.wsp-pill-title').textContent === 'Three Parts');
  check('chapter and time left', t.q('.wsp-pill-words').textContent === 'Part 2 of 3 · 2 h 49 min left', t.q('.wsp-pill-words').textContent);
  check('progress line', t.q('.wsp-pill-fill').style.transform === 'scaleX(0.0648)', t.q('.wsp-pill-fill').style.transform);
  check('cover', t.q('.wsp-pill-art img').getAttribute('src') === BOOK.cover);
  check('play button says Pause', t.q('.wsp-pill-play').getAttribute('aria-label') === 'Pause');
  check('open button names the book', t.q('.wsp-pill-open').getAttribute('aria-label') === 'Open the player: Three Parts');

  t.engine.set({ playing: false }, 'pause');
  check('paused', pill.getAttribute('data-state') === 'paused' && t.q('.wsp-pill-play').getAttribute('aria-label') === 'Play');

  t.ui.open();
  check('player open', pill.hasAttribute('data-open') && t.q('.wsp-pill-open').getAttribute('aria-expanded') === 'true' &&
    t.q('.wsp-pill-open').getAttribute('aria-label') === 'Hide the player: Three Parts');
  t.ui.close();
  check('closed again', !pill.hasAttribute('data-open'));

  t.ui.setPopped(() => {});
  check('popped out', pill.hasAttribute('data-popped') && t.q('.wsp-pill-words').textContent === 'Playing in its own window' &&
    t.q('.wsp-pill-open').getAttribute('aria-label') === 'Bring the player back: Three Parts');
  t.ui.setPopped(null);
  check('back', !pill.hasAttribute('data-popped'));

  t.engine.set({ saveError: true }, 'save');
  t.engine.emit('warning', { kind: 'not-saved', active: true, message: "Your place isn't being saved. Last saved 9:41 PM." });
  check('the warning on the pill', pill.hasAttribute('data-warn') && t.q('.wsp-pill-words').textContent.indexOf("isn't being saved") !== -1);
  check('said once, here, while the window is closed', t.q('.wsp-pill [role="status"]').textContent.indexOf("isn't being saved") !== -1);
  t.ui.open();
  check('the window says it while open', t.q('.wsp-pill [role="status"]').textContent === '');
  t.ui.close();

  t.engine.set(EMPTY, 'close');
  check('the book closed: hidden', slot.hidden === true);
});

await run('the pill: play pauses without opening; a held book opens the window', () => {
  const t = setup({ state: BOOK, dock: 'top' });
  t.q('.wsp-pill-play').click();
  check('toggled', t.engine.calls.some((c) => c[0] === 'toggle'));
  check('nothing opened', !t.ui.isOpen());
  t.engine.set({ playing: false, filesChanged: { old: {}, spot: 0 } }, 'pause');
  t.q('.wsp-pill-play').click();
  check('held: the window opens for Find your place', t.ui.isOpen() && t.ui.isWindow());
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

await run('the window: part of the page, not a dialog', async () => {
  const t = setup({ state: BOOK });
  const captures = [];
  const add = t.doc.addEventListener.bind(t.doc);
  t.doc.addEventListener = (type, fn, opt) => { if (opt === true) captures.push(type); return add(type, fn, opt); };
  t.q('.wsp-pill-open').focus();
  t.q('.wsp-pill-open').click();
  check('opens as the window', t.ui.isOpen() && t.ui.isWindow() && t.full.classList.contains('is-window'));
  check('a region, not a modal dialog', t.full.getAttribute('role') === 'region' && !t.full.hasAttribute('aria-modal') &&
    t.full.getAttribute('aria-label') === 'Audiobook player');
  check('the page is not marked or blocked', !t.doc.documentElement.hasAttribute('data-player-full') && captures.length === 0, captures);
  check('focus on the title', t.doc.activeElement === t.q('#wspTitle'));
  check('the sheet\'s close button gives way to the window\'s', t.q('.wsp-full [aria-label="Close the player"]').hidden &&
    !label(t, 'Close player window').hidden && !label(t, 'Move the player. Arrow keys move it, Home puts it back.').hidden);
  check('one close, no Minimise or Stop in the window', !label(t, 'Minimise to the top bar') && !label(t, 'Stop and close the book') &&
    !t.full.querySelector('[aria-label^="Stop"]'));
  check('no Pop out until popout.js offers it', label(t, 'Pop out into its own window').hidden);
  const tab = t.key(t.q('#wspTitle'), 'Tab');
  check('Tab is never trapped', !tab.defaultPrevented);
  t.q('#pageBtn').focus();
  check('focus may leave', t.doc.activeElement === t.q('#pageBtn') && t.ui.isOpen());
  check('placed at the top right, below the top bar', JSON.stringify(t.rect()) === JSON.stringify({ x: 1440 - 380 - 24, y: 76, w: 380, h: null }), t.rect());
  check('opens with its scale and fade', t.full.classList.contains('is-opening'));
  await t.clock.advance(300);
  check('which ends', !t.full.classList.contains('is-opening'));
});

await run('Escape and the X send it to the pill and it plays on; the pill hides it; focus follows', async () => {
  const t = setup({ state: BOOK, dock: 'top' });
  t.ui.open();
  t.q('.wsp-pill-open').click();
  check('the pill hides it', !t.ui.isOpen());
  await t.clock.advance(200);
  check('then it is gone', t.full.hidden === true && !t.full.classList.contains('is-window'));
  t.ui.open();
  const ev = t.key(t.q('#wspTitle'), 'Escape');
  check('Escape minimises', !t.ui.isOpen() && ev.defaultPrevented);
  check('focus to the pill', t.doc.activeElement === t.q('.wsp-pill-open'));
  await t.clock.advance(200);
  t.ui.open();
  const x = label(t, 'Close player window');
  check('the X is the close icon', x.textContent === 'close');
  x.click();
  check('the X minimises', !t.ui.isOpen() && t.doc.activeElement === t.q('.wsp-pill-open'));
  check('and the book plays on', t.engine.calls.length === 0 && t.engine.state().playing === true && !t.q('#wsPlayerPill').hidden &&
    t.q('.wsp-pill').getAttribute('data-state') === 'playing', t.engine.calls);
  await t.clock.advance(200);
  t.ui.open();
  t.q('#pageBtn').focus();
  t.ui.close();
  check('focus on the page stays there', t.doc.activeElement === t.q('#pageBtn'));
});

await run('soft navigation leaves it open; a full-screen view closes it', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  t.win.dispatchEvent(new t.win.CustomEvent('ws:page-mounted', { detail: { url: 'https://ws.test/books' } }));
  check('Home to Books: still open', t.ui.isOpen() && t.ui.isWindow());
  t.win.dispatchEvent(new t.win.CustomEvent('ws:page-claimed', { detail: { url: 'https://ws.test/wiki' } }));
  check('a page\'s own view: still open', t.ui.isOpen());
  t.doc.documentElement.setAttribute('data-shell', 'hidden');
  t.win.dispatchEvent(new t.win.CustomEvent('ws:page-mounted', { detail: { url: 'https://ws.test/reader?id=1' } }));
  check('the reader: closed', !t.ui.isOpen());
});

await run('a full-screen view and a phone keep the sheet', () => {
  const t = setup({ state: BOOK, shellHidden: true });
  t.ui.open();
  check('the reader on a desktop: the sheet', t.ui.isOpen() && !t.ui.isWindow() && t.full.getAttribute('role') === 'dialog' &&
    t.doc.documentElement.hasAttribute('data-player-full'));
  t.ui.close();
  const p = setup({ state: BOOK, wide: false });
  p.ui.open();
  check('a phone: the sheet, modal as ever', p.ui.isOpen() && !p.ui.isWindow() && p.full.getAttribute('aria-modal') === 'true' &&
    !p.full.classList.contains('is-window') && p.doc.activeElement.getAttribute('aria-label') === 'Close the player');
  check('a phone: the bar takes its room', p.doc.documentElement.style.getPropertyValue('--ws-player-h') === '72px');
  p.ui.close();
  const n = setup({ state: BOOK, noPill: true });
  n.ui.open();
  check('no top bar slot: the sheet', !n.ui.isWindow());
});

await run('across lg the open one closes', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  t.env.setWide(false);
  check('narrowed: the window closes', !t.ui.isOpen());
  t.ui.open();
  check('then the sheet', t.ui.isOpen() && !t.ui.isWindow());
  t.env.setWide(true);
  check('widened: the sheet closes', !t.ui.isOpen());
});

// ---------------------------------------------------------------------------
// Moving and sizing
// ---------------------------------------------------------------------------

await run('dragged by its top bar, kept inside the viewport, remembered', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  const top = t.q('.wsp-top-label');
  t.pointer(top, 'pointerdown', 1200, 90);
  check('moving', t.full.classList.contains('is-moving'));
  t.pointer(top, 'pointermove', 1000, 290);
  check('it follows', t.rect().x === 1036 - 200 && t.rect().y === 276, t.rect());
  t.pointer(top, 'pointermove', -500, -500);
  check('never past the left or under the top bar', t.rect().x === 8 && t.rect().y === 72, t.rect());
  t.pointer(top, 'pointermove', 5000, 5000);
  check('never past the right or the bottom', t.rect().x === 1440 - 380 - 8 && t.rect().y === 900 - 400 - 8, t.rect());
  t.pointer(top, 'pointerup', 5000, 5000);
  check('done', !t.full.classList.contains('is-moving'));
  const kept = JSON.parse(t.storage.getItem('ws-player-window:abc0123456789def'));
  check('kept for this listener', kept.x === 1052 && kept.y === 492, kept);
  const b = t.q('.wsp-top [aria-label="Close player window"]');
  t.pointer(b, 'pointerdown', 1300, 500);
  check('its buttons do not start a move', !t.full.classList.contains('is-moving'));

  const again = setup({ state: BOOK, storage: t.storage });
  again.ui.open();
  check('the same place next time', again.rect().x === 1052 && again.rect().y === 492, again.rect());
  const other = setup({ state: BOOK, storage: t.storage, identity: 'fff0123456789aaa' });
  other.ui.open();
  check('another listener has their own', other.rect().x === 1036 && other.rect().y === 76, other.rect());
});

await run('a smaller browser window keeps it inside', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  const top = t.q('.wsp-top-label');
  t.pointer(top, 'pointerdown', 1200, 90);
  t.pointer(top, 'pointermove', 1400, 500);
  t.pointer(top, 'pointerup', 1400, 500);
  t.env.vp = { w: 1100, h: 700 };
  t.win.dispatchEvent(new t.win.Event('resize'));
  check('back inside', t.rect().x === 1100 - 380 - 8 && t.rect().y === 700 - 400 - 8, t.rect());
  t.ui.close();
  t.env.vp = { w: 1440, h: 900 };
  t.win.dispatchEvent(new t.win.Event('resize'));
  t.ui.open();
  check('closed, it no longer listens; reopened, the kept place again', t.rect().x === 1052, t.rect());
});

await run('the keyboard: the grip moves it, Home puts it back, the corner sizes it', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  const grip = label(t, 'Move the player. Arrow keys move it, Home puts it back.');
  const corner = label(t, 'Resize the player. Arrow keys change its size.');
  grip.focus();
  let ev = t.key(grip, 'ArrowLeft');
  check('left 16', t.rect().x === 1036 - 16 && ev.defaultPrevented, t.rect());
  t.key(grip, 'ArrowDown', { shiftKey: true });
  check('Shift: down 64', t.rect().y === 76 + 64, t.rect());
  check('remembered', JSON.parse(t.storage.getItem('ws-player-window:abc0123456789def')).y === 140);
  check('the arrows never reach the player\'s shortcuts', t.engine.calls.every((c) => c[0] !== 'skip'));
  t.key(grip, 'Home');
  check('Home: back to the top right', t.rect().x === 1036 && t.rect().y === 76, t.rect());
  t.key(corner, 'ArrowRight');
  check('wider by 16', t.rect().w === 396, t.rect());
  for (let i = 0; i < 20; i++) t.key(corner, 'ArrowRight', { shiftKey: true });
  check('no wider than its limit', t.rect().w === 520, t.rect());
  for (let i = 0; i < 20; i++) t.key(corner, 'ArrowLeft', { shiftKey: true });
  check('no narrower than its limit', t.rect().w === 340, t.rect());
  t.key(corner, 'ArrowDown');
  check('no panel open: its height is its content', t.rect().h === null);
  t.q('.wsp-actions .wsp-action').click();
  check('a panel: a height', t.rect().h === 600, t.rect());
  t.key(corner, 'ArrowDown', { shiftKey: true });
  check('taller by 64', t.rect().h === 664, t.rect());
  ev = t.key(t.q('#wspTitle'), 'ArrowRight');
  check('elsewhere in it the arrows are the player\'s (features.js listens there)', !ev.defaultPrevented);
});

await run('the corner drags its size', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  t.q('.wsp-actions .wsp-action').click();
  const corner = t.q('.wsp-win-resize');
  t.pointer(corner, 'pointerdown', 1416, 676);
  t.pointer(corner, 'pointermove', 1456, 726);
  check('wider and taller (inside the viewport)', t.rect().w === 380 + 40 - 0 && t.rect().h === 650, t.rect());
  t.pointer(corner, 'pointerup', 1456, 726);
  const kept = JSON.parse(t.storage.getItem('ws-player-window:abc0123456789def'));
  check('kept', kept.w === 420 && kept.h === 650, kept);
});

await run('fitWindow: limits and defaults', () => {
  const vp = { w: 1440, h: 900, top: 72 };
  check('defaults', JSON.stringify(U.fitWindow({}, vp, null)) === JSON.stringify({ x: 1036, y: 76, w: 380, h: 600, room: 820 }), U.fitWindow({}, vp, null));
  const small = U.fitWindow({ h: 900 }, { w: 1024, h: 600, top: 72 }, null);
  check('a short screen: no taller than there is room', small.h === 520 && small.y === 72, small);
  const tiny = U.fitWindow({ h: 300 }, vp, null);
  check('never under its minimum', tiny.h === 480, tiny);
  const c = U.fitWindow({ y: 800 }, vp, 400);
  check('collapsed: its own height, kept on screen', c.h === 400 && c.y === 492, c);
});

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

await run('panels open below and close again; Playback settings goes back to Chapters', () => {
  const t = setup({ state: BOOK });
  // As features.js fills them: a settings toggle in the top bar, Speed below.
  const settings = t.ui.panel('settings', { title: 'Playback settings' });
  const tune = t.doc.createElement('button');
  tune.className = 'wsp-icon-btn';
  tune.setAttribute('aria-label', 'Playback settings');
  tune.addEventListener('click', () => { if (settings.shown) settings.hide(); else settings.show(tune); });
  t.ui.fill('menu', tune);
  const speed = t.ui.panel('speed', { title: 'Speed' });
  const speedBtn = t.ui.actionButton({ text: '1×', label: 'Speed' });
  speedBtn.addEventListener('click', () => speed.show(speedBtn));
  t.ui.fill('speed', speedBtn);
  t.ui.open();
  check('no panel at first', !t.full.hasAttribute('data-view') && t.qa('.wsp-panel').every((p) => p.hidden));
  const chapters = t.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1);
  check('buttons say they are closed', chapters.getAttribute('aria-expanded') === 'false' && speedBtn.getAttribute('aria-expanded') === 'false');
  chapters.click();
  check('Chapters opens below', t.full.getAttribute('data-view') === 'chapters' && chapters.getAttribute('aria-expanded') === 'true' &&
    !t.q('[data-panel="chapters"]').hidden);
  chapters.click();
  check('pressed again it closes', !t.full.hasAttribute('data-view') && chapters.getAttribute('aria-expanded') === 'false');
  check('focus stays on it', t.doc.activeElement === chapters);
  speedBtn.click();
  check('Speed', t.full.getAttribute('data-view') === 'speed' && speedBtn.getAttribute('aria-expanded') === 'true');
  speedBtn.click();
  check('Speed closes too', !t.full.hasAttribute('data-view'));
  tune.click();
  check('Playback settings', t.full.getAttribute('data-view') === 'settings');
  tune.click();
  check('pressed again: Chapters, not nothing', t.full.getAttribute('data-view') === 'chapters' && !t.q('[data-panel="chapters"]').hidden);
  t.q('.wsp-chapter-item[data-index="2"]').click();
  check('a chapter jumps and the list stays', t.engine.calls.some((c) => c[0] === 'jump' && c[1] === 2) && t.full.getAttribute('data-view') === 'chapters');
  t.ui.close();
  check('closing closes the panel', !t.full.hasAttribute('data-view'));
  check('on the sheet the buttons carry no expanded state', (() => {
    const p = setup({ state: BOOK, wide: false });
    p.ui.open();
    return p.qa('.wsp-action').every((b) => !b.hasAttribute('aria-expanded'));
  })());
});

await run('prompts and notices show inside the window while it is open', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  const pr = t.ui.prompt({ message: 'Continue from 1:02:03 (Chrome on Android, 2 h ago)?', actions: [{ label: 'Continue', primary: true }] });
  check('inside the window', t.full.contains(t.q('.wsp-prompt')));
  t.ui.close();
  check('in the page once it closes', !t.full.contains(t.q('.wsp-prompt')) && !!t.q('.wsp-prompt'));
  pr.remove();
});

await run('the pill\'s Stop: right of Play, playing or paused; the book closes, the place is saved, Resume', async () => {
  const t = setup({ state: BOOK, dock: 'top' });
  const stop = t.q('.wsp-pill-stop');
  const live = () => !stop.hidden && !stop.hasAttribute('aria-disabled');
  check('playing: Stop, named for what it does', live() && stop.getAttribute('aria-label') === 'Stop listening, your place is saved' &&
    stop.getAttribute('title') === 'Stop listening' && stop.textContent === 'stop');
  check('right of Play', t.q('.wsp-pill-play').nextElementSibling === stop);
  check('no narrow-bar marker any more', !t.q('.wsp-pill').hasAttribute('data-stop'));
  t.engine.set({ playing: false }, 'pause');
  check('paused: Stop', live());
  t.engine.set({ loading: true }, 'loading');
  check('loading: kept in place but inert', !stop.hidden && stop.getAttribute('aria-disabled') === 'true');
  stop.click();
  check('an inert Stop does nothing', !t.engine.calls.some((c) => c[0] === 'close') && !t.q('.wsp-notice'));
  t.engine.set({ loading: false, checking: true }, 'loading');
  check('reading the saved places: inert', !stop.hidden && stop.getAttribute('aria-disabled') === 'true');
  stop.focus();
  t.engine.set({ checking: false }, 'pause');
  check('then live again, focus where it was', live() && t.doc.activeElement === stop);
  t.engine.set({ playing: true }, 'play');
  check('playing: still there, focus kept', live() && t.doc.activeElement === stop);

  const p = setup({ state: Object.assign({}, BOOK, { playing: true }) });
  p.q('.wsp-pill-stop').click();
  check('stops a book that is playing', p.engine.calls.some((x) => x[0] === 'close') && p.q('#wsPlayerPill').hidden &&
    p.q('.wsp-notice').textContent.indexOf('Stopped at 11:40. Your place is saved.') !== -1);
  t.engine.set({ playing: false }, 'pause');

  t.ui.open();
  check('the window open: Stop is still the pill\'s', !stop.hidden);
  stop.focus();
  stop.click();
  check('the book is closed, the window too', t.engine.calls.some((c) => c[0] === 'close') && !t.ui.isOpen());
  const n = t.q('.wsp-notice');
  check('says where, and that it is saved', n && n.textContent.indexOf('Stopped at 11:40. Your place is saved.') !== -1, n && n.textContent);
  check('the pill goes', t.q('#wsPlayerPill').hidden);
  const resume = Array.from(n.querySelectorAll('button')).find((b) => b.textContent === 'Resume');
  check('focus on Resume', t.doc.activeElement === resume);
  resume.click();
  await flush();
  const o = t.engine.calls.find((c) => c[0] === 'open');
  check('Resume opens the same book where it was left, playing', o && o[1] === '500:1' && o[2].autoplay === true, o);

  const c = setup({ state: Object.assign({}, BOOK, { playing: false }) });
  c.q('.wsp-pill-stop').click();
  check('window closed: the same', c.engine.calls.some((x) => x[0] === 'close') && c.q('#wsPlayerPill').hidden &&
    c.doc.activeElement === Array.from(c.q('.wsp-notice').querySelectorAll('button')).find((b) => b.textContent === 'Resume'));

  const h = setup({ state: Object.assign({}, BOOK, { playing: false, safetyNet: { failed: false, orphans: [] } }) });
  check('held: no claim of a save in its name', h.q('.wsp-pill-stop').getAttribute('aria-label') === 'Stop listening');
  h.q('.wsp-pill-stop').click();
  check('held: no claim that anything was saved', h.q('.wsp-notice').textContent.indexOf('Your place is as it was.') !== -1);
});

// ---------------------------------------------------------------------------
// The desktop bar's place: the long bar at the bottom, the square, the top bar
// ---------------------------------------------------------------------------

// At 1440x900 with a 256 px sidebar the long bar spans x 256 to 1440 on the
// bottom edge, 73 px tall; its grip is at its left end, about 276, 863. The
// square is 168 px; a drag from the long bar or the pill holds it by the
// middle of its handle strip (84, 12 in from its top left). The top bar ends
// at 64 (the window's limit, 72, less 8); the bottom band starts at 780.
const dockOf = (t) => JSON.parse(t.storage.getItem('ws-player-dock:abc0123456789def'));
const spot = (t) => [parseInt(t.q('.wsp-bar').style.getPropertyValue('--wsp-x'), 10), parseInt(t.q('.wsp-bar').style.getPropertyValue('--wsp-y'), 10)];
const roomOf = (t) => t.doc.documentElement.style.getPropertyValue('--ws-player-h');
const said = (t) => t.q('#wsPlayer > [role="status"]').textContent;
const shapeOf = (t) => t.q('.wsp-bar').getAttribute('data-shape');
const placeOf = (t) => t.q('.wsp-bar').getAttribute('data-dock');
function drag(t, from, path, end = 'pointerup') {
  t.pointer(from, 'pointerdown', path[0][0], path[0][1]);
  for (const [x, y] of path.slice(1)) t.pointer(t.doc.body, 'pointermove', x, y);
  const last = path[path.length - 1];
  if (end) t.pointer(t.doc.body, end, last[0], last[1]);
}

await run('the long bar along the bottom by default, with its handle and Stop; the page keeps room for it', () => {
  const t = setup({ state: BOOK });
  const bar = t.q('.wsp-bar');
  check('a desktop page: the long bar at the bottom', bar.classList.contains('wsp-bar-dockable') && placeOf(t) === 'bottom' && shapeOf(t) === 'long');
  check('nothing kept yet', t.storage.getItem('ws-player-dock:abc0123456789def') === null);
  check('the pill\'s slot is hidden', t.q('#wsPlayerPill').hidden === true);
  check('room for the whole bar, and nothing more', roomOf(t) === '73px', roomOf(t));
  const grip = t.q('.wsp-bar-grip');
  check('the handle comes first and offers a menu', bar.querySelector('.wsp-bar-row').firstElementChild === grip &&
    grip.getAttribute('aria-haspopup') === 'menu' && grip.getAttribute('aria-expanded') === 'false' &&
    grip.getAttribute('aria-label') === 'Move the player. Press for places to put it.', grip.getAttribute('aria-label'));
  const stop = t.q('.wsp-bar-stop');
  check('Stop, right of Play', t.q('.wsp-bar .wsp-play').nextElementSibling === stop && stop.getAttribute('aria-label') === 'Stop listening, your place is saved');
  check('the cover and title say they open the player', t.q('.wsp-bar-open').textContent.indexOf('Open the player: ') === 0 &&
    !t.q('.wsp-bar-open').hasAttribute('aria-haspopup') && t.q('.wsp-bar-open').getAttribute('title') === 'Open the player: Three Parts');
});

await run('the bar opens the window and hides it; Escape and the X come back to it; its Stop stops', async () => {
  const t = setup({ state: BOOK });
  const open = t.q('.wsp-bar-open');
  open.focus();
  open.click();
  check('the window, as from the pill', t.ui.isOpen() && t.ui.isWindow() && t.q('.wsp-bar').hasAttribute('data-open') &&
    open.getAttribute('aria-expanded') === 'true' && open.textContent.indexOf('Hide the player: ') === 0 &&
    open.getAttribute('title') === 'Hide the player: Three Parts');
  check('the bar\'s warning is not said twice', t.q('.wsp-bar .wsp-warn-live').getAttribute('aria-hidden') === 'true');
  open.click();
  check('pressed again it hides it', !t.ui.isOpen() && !t.q('.wsp-bar').hasAttribute('data-open'));
  await t.clock.advance(200);
  open.click();
  t.key(t.q('#wspTitle'), 'Escape');
  check('Escape: focus back to the bar', !t.ui.isOpen() && t.doc.activeElement === open);
  await t.clock.advance(200);
  open.click();
  label(t, 'Close player window').click();
  check('the X: focus back to the bar, the book plays on', !t.ui.isOpen() && t.doc.activeElement === open && t.engine.calls.length === 0);
  t.q('.wsp-bar-stop').click();
  check('Stop closes the book', t.engine.calls.some((c) => c[0] === 'close') && t.q('.wsp-bar').hidden &&
    t.q('.wsp-notice').textContent.indexOf('Stopped at 11:40. Your place is saved.') !== -1);
  check('focus on Resume', t.doc.activeElement && t.doc.activeElement.textContent === 'Resume');
});

await run('dragged it is the square; let go anywhere else it stays there; both snap zones show while it moves', async () => {
  const t = setup({ state: BOOK });
  const menus = [];
  t.doc.addEventListener('ws:menu-open', (e) => menus.push(e.detail));
  const grip = t.q('.wsp-bar-grip');
  drag(t, grip, [[276, 863], [278, 864]], null);
  check('a press that has not travelled is not a drag yet', !t.doc.documentElement.hasAttribute('data-wsp-drag') && shapeOf(t) === 'long');
  t.pointer(t.doc.body, 'pointermove', 700, 400);
  const root = t.doc.documentElement;
  check('dragging: the square', shapeOf(t) === 'square' && t.q('.wsp-bar').classList.contains('is-dragging'));
  check('both zones show: the top bar\'s slot and the bottom band', root.hasAttribute('data-wsp-drag') && t.q('#wsPlayerPill').hidden === false &&
    !!t.q('#wsPlayer > .wsp-dock-ghost .wsp-dock-zone') && t.q('#wsPlayerPill .wsp-dock-target') !== null);
  check('the bell panel and the account menu are told to close', menus.length === 1 && menus[0] === t.q('#wspDockMenu'));
  check('held by its handle under the pointer', JSON.stringify(spot(t)) === JSON.stringify([616, 388]), spot(t));
  check('no zone under it', !root.hasAttribute('data-wsp-drop'));
  check('the page keeps its room until it is let go', roomOf(t) === '73px', roomOf(t));
  t.pointer(t.doc.body, 'pointerup', 700, 400);
  check('let go: it stays there, a square', placeOf(t) === 'free' && shapeOf(t) === 'square' && JSON.stringify(spot(t)) === JSON.stringify([616, 388]));
  check('the zones go', !root.hasAttribute('data-wsp-drag') && t.q('#wsPlayerPill').hidden === true && !t.q('.wsp-bar').classList.contains('is-dragging'));
  check('kept on this device', JSON.stringify(dockOf(t)) === JSON.stringify({ at: 'free', x: 616, y: 388 }), dockOf(t));
  check('the page needs no room for it now', roomOf(t) === '0px', roomOf(t));
  check('its handle now offers the arrow keys', grip.getAttribute('aria-label') === 'Move the player. Press for places to put it, or use the arrow keys.');
  check('let go where it was drawn, it does not arrive again', !t.q('.wsp-bar').classList.contains('is-arriving'));
  await t.clock.advance(100);
  check('said', said(t) === 'Player moved.', said(t));
  t.q('.wsp-bar-grip').click();
  check('the click that ends a drag opens no menu', t.q('#wspDockMenu').hidden);
  drag(t, grip, [[700, 400], [-500, 2000]]);
  check('the square moves from where it was taken, kept inside the viewport and below the top bar',
    JSON.stringify(spot(t)) === JSON.stringify([8, 900 - 168 - 8]) && placeOf(t) === 'free', spot(t));
  drag(t, grip, [[100, 736], [5000, 300]]);
  check('never past the right edge', JSON.stringify(spot(t)) === JSON.stringify([1440 - 168 - 8, 288]), spot(t));
});

await run('let go on the bottom band it is the long bar again', async () => {
  const t = setup({ state: BOOK, dock: { at: 'free', x: 100, y: 200 } });
  check('starts where it was kept, a square', placeOf(t) === 'free' && shapeOf(t) === 'square' && JSON.stringify(spot(t)) === JSON.stringify([100, 200]) && roomOf(t) === '0px');
  drag(t, t.q('.wsp-bar-grip'), [[150, 210], [300, 500], [200, 850]], null);
  check('over the sidebar: no zone', !t.doc.documentElement.hasAttribute('data-wsp-drop'));
  t.pointer(t.doc.body, 'pointermove', 600, 820);
  check('over the bottom band: that zone lights', t.doc.documentElement.getAttribute('data-wsp-drop') === 'bottom' && !t.q('.wsp-bar').classList.contains('is-near'));
  check('the square stays inside the viewport', JSON.stringify(spot(t)) === JSON.stringify([550, 724]), spot(t));
  t.pointer(t.doc.body, 'pointerup', 600, 820);
  check('snapped: the long bar', placeOf(t) === 'bottom' && shapeOf(t) === 'long' && dockOf(t).at === 'bottom' && dockOf(t).x === undefined);
  check('its spot is gone and the room is back', t.q('.wsp-bar').style.getPropertyValue('--wsp-x') === '' && roomOf(t) === '73px');
  check('it rises into place', t.q('.wsp-bar').classList.contains('is-arriving'));
  await t.clock.advance(300);
  check('then rests', !t.q('.wsp-bar').classList.contains('is-arriving'));
  check('said', said(t) === 'Player moved to the bottom bar.', said(t));
});

await run('let go on the top bar it becomes the pill; dragged out of the pill it is the square again', async () => {
  const t = setup({ state: BOOK });
  const grip = t.q('.wsp-bar-grip');
  grip.focus();
  drag(t, grip, [[276, 863], [800, 300], [900, 100]], null);
  check('over the top bar: that zone lights and the square gives way', t.doc.documentElement.getAttribute('data-wsp-drop') === 'top' &&
    t.q('.wsp-bar').classList.contains('is-near'));
  t.pointer(t.doc.body, 'pointerup', 900, 100);
  check('in the top bar', placeOf(t) === 'top' && dockOf(t).at === 'top' && t.q('#wsPlayerPill').hidden === false);
  check('the page needs no room', roomOf(t) === '0px');
  check('the pill arrives', t.q('.wsp-pill').classList.contains('is-arriving'));
  check('focus follows to its handle', t.doc.activeElement === t.q('.wsp-pill-grip'));
  await t.clock.advance(300);
  check('said', said(t) === 'Player moved to the top bar.', said(t));
  check('then rests', !t.q('.wsp-pill').classList.contains('is-arriving'));

  drag(t, t.q('.wsp-pill-grip'), [[1000, 32], [990, 40], [700, 500]], null);
  check('out of the top bar: the square, held by its handle', t.q('.wsp-bar').classList.contains('is-dragging') && shapeOf(t) === 'square' &&
    JSON.stringify(spot(t)) === JSON.stringify([616, 488]), spot(t));
  check('the top bar still offers itself', t.q('#wsPlayerPill').hidden === false);
  t.pointer(t.doc.body, 'pointerup', 700, 500);
  check('let go there: it stays there', placeOf(t) === 'free' && t.q('#wsPlayerPill').hidden === true &&
    JSON.stringify(dockOf(t)) === JSON.stringify({ at: 'free', x: 616, y: 488 }));

  t.ui.open();
  drag(t, t.q('.wsp-bar-grip'), [[700, 500], [900, 120]]);
  check('from the square to the top bar', placeOf(t) === 'top');
  drag(t, t.q('.wsp-pill-grip'), [[1000, 32], [990, 40], [600, 860]]);
  check('from the pill to the bottom', placeOf(t) === 'bottom' && shapeOf(t) === 'long' && roomOf(t) === '73px');
  check('the window stayed open through it all', t.ui.isOpen() && t.ui.isWindow());
});

await run('Escape cancels a drag', () => {
  const t = setup({ state: BOOK });
  drag(t, t.q('.wsp-bar-grip'), [[276, 863], [700, 300]], null);
  const ev = t.key(t.doc.body, 'Escape');
  check('back where it was, the long bar', ev.defaultPrevented && placeOf(t) === 'bottom' && shapeOf(t) === 'long' &&
    !t.doc.documentElement.hasAttribute('data-wsp-drag') && t.storage.getItem('ws-player-dock:abc0123456789def') === null && roomOf(t) === '73px');
  t.pointer(t.doc.body, 'pointermove', 900, 100);
  t.pointer(t.doc.body, 'pointerup', 900, 100);
  check('the rest of that drag does nothing', placeOf(t) === 'bottom');
});

await run('the keyboard: the handle\'s menu with Float, the square\'s arrows, Home; focus follows', async () => {
  const t = setup({ state: BOOK });
  const grip = t.q('.wsp-bar-grip');
  const menu = t.q('#wspDockMenu');
  const items = () => Array.from(menu.querySelectorAll('[role="menuitem"]')).filter((b) => !b.hidden).map((b) => b.textContent);
  grip.focus();
  grip.click();
  check('pressed: the other places, focus on the first', !menu.hidden && grip.getAttribute('aria-expanded') === 'true' &&
    JSON.stringify(items()) === JSON.stringify(['arrow_upwardMove to top bar', 'open_withFloat']) && t.doc.activeElement === menu.querySelector('[data-to="top"]'), items());
  t.key(t.doc.activeElement, 'Escape');
  check('Escape closes it, focus back on the handle', menu.hidden && grip.getAttribute('aria-expanded') === 'false' && t.doc.activeElement === grip);
  let ev = t.key(grip, 'ArrowUp');
  check('the long bar\'s handle has no arrow keys', !ev.defaultPrevented && placeOf(t) === 'bottom');
  ev = t.key(grip, 'Home');
  check('nor Home', !ev.defaultPrevented && placeOf(t) === 'bottom');
  grip.click();
  t.doc.activeElement.click();
  check('Move to top bar: the bar flies there', t.q('.wsp-bar').classList.contains('is-leaving') && menu.hidden);
  await t.clock.advance(300);
  check('then it is the pill, focus on its handle', placeOf(t) === 'top' && t.doc.activeElement === t.q('.wsp-pill-grip'));
  check('said', said(t) === 'Player moved to the top bar.');
  const pg = t.q('.wsp-pill-grip');
  pg.click();
  check('the pill\'s menu offers the bottom bar and Float', JSON.stringify(items()) === JSON.stringify(['arrow_downwardMove to bottom bar', 'open_withFloat']) &&
    pg.getAttribute('aria-expanded') === 'true', items());
  t.key(t.doc.activeElement, 'ArrowDown');
  check('the arrows move through them', t.doc.activeElement === menu.querySelector('[data-to="free"]'));
  t.doc.activeElement.click();
  check('Float: the square at the bottom right, focus on its handle', placeOf(t) === 'free' && shapeOf(t) === 'square' &&
    JSON.stringify(spot(t)) === JSON.stringify([1440 - 168 - 24, 900 - 168 - 24]) && t.doc.activeElement === grip, spot(t));
  check('it arrives there', t.q('.wsp-bar').classList.contains('is-arriving'));
  check('the page needs no room', roomOf(t) === '0px');
  await t.clock.advance(300);
  check('said, with how to move it', said(t) === 'Player floating at the bottom right. The arrow keys on its handle move it.', said(t));

  ev = t.key(grip, 'ArrowUp');
  check('an arrow: 16 px up', ev.defaultPrevented && placeOf(t) === 'free' && JSON.stringify(spot(t)) === JSON.stringify([1248, 692]), spot(t));
  t.key(grip, 'ArrowLeft', { shiftKey: true });
  check('Shift: 64 px', JSON.stringify(spot(t)) === JSON.stringify([1184, 692]) &&
    JSON.stringify(dockOf(t)) === JSON.stringify({ at: 'free', x: 1184, y: 692 }), spot(t));
  for (let i = 0; i < 30; i++) t.key(grip, 'ArrowUp', { shiftKey: true });
  check('kept below the top bar', spot(t)[1] === 72, spot(t));
  check('the arrows never reach the player\'s shortcuts', t.engine.calls.every((c) => c[0] !== 'skip'));
  check('the arrows say nothing', said(t) === 'Player floating at the bottom right. The arrow keys on its handle move it.');
  grip.getBoundingClientRect = () => ({ left: 1184, right: 1352, top: 72, bottom: 96, width: 168, height: 24 });
  grip.click();
  check('from the square: the top bar and the bottom bar', JSON.stringify(items()) === JSON.stringify(['arrow_upwardMove to top bar', 'arrow_downwardMove to bottom bar']), items());
  check('near the top of the screen its menu opens below the handle', menu.style.top === '104px' && menu.style.bottom === '', menu.style.top);
  t.key(t.doc.activeElement, 'ArrowDown');
  t.key(t.doc.activeElement, 'ArrowDown');
  check('and round', t.doc.activeElement === menu.querySelector('[data-to="top"]'));
  t.key(t.doc.activeElement, 'Tab');
  check('Tab leaves it from the handle', menu.hidden && t.doc.activeElement === grip);
  ev = t.key(grip, 'Home');
  check('Home: back to the bottom bar', ev.defaultPrevented && placeOf(t) === 'bottom' && shapeOf(t) === 'long' && t.doc.activeElement === grip && roomOf(t) === '73px');
  await t.clock.advance(300);
  check('said', said(t) === 'Player moved to the bottom bar.');
  grip.getBoundingClientRect = () => ({ left: 256, right: 296, top: 828, bottom: 900, width: 40, height: 72 });
  grip.click();
  check('over the long bar\'s handle', menu.style.bottom === '80px' && menu.style.top === '', menu.style.bottom);
  t.pointer(t.q('#pageBtn'), 'pointerdown', 10, 10);
  check('a press elsewhere closes the menu', menu.hidden);
  grip.click();
  t.doc.dispatchEvent(new t.win.CustomEvent('ws:menu-open', { detail: null }));
  check('so does another menu opening', menu.hidden && grip.getAttribute('aria-expanded') === 'false');
  grip.click();
  menu.querySelector('[data-to="free"]').click();
  check('Float from the long bar too', placeOf(t) === 'free' && JSON.stringify(spot(t)) === JSON.stringify([1248, 708]));
});

await run('the square: remembered, kept inside a smaller window, back when it grows', () => {
  const t = setup({ state: BOOK });
  drag(t, t.q('.wsp-bar-grip'), [[276, 863], [684, 712]]);
  check('kept', JSON.stringify(dockOf(t)) === JSON.stringify({ at: 'free', x: 600, y: 700 }), dockOf(t));
  const again = setup({ state: BOOK, storage: t.storage });
  check('the same spot next time, a square, no room', placeOf(again) === 'free' && shapeOf(again) === 'square' &&
    JSON.stringify(spot(again)) === JSON.stringify([600, 700]) && roomOf(again) === '0px');
  const other = setup({ state: BOOK, storage: t.storage, identity: 'fff0123456789aaa' });
  check('another listener has their own', placeOf(other) === 'bottom');
  t.env.vp = { w: 1100, h: 640 };
  t.win.dispatchEvent(new t.win.Event('resize'));
  check('a smaller window: kept inside it', JSON.stringify(spot(t)) === JSON.stringify([600, 640 - 168 - 8]), spot(t));
  t.env.vp = { w: 700, h: 640 };
  t.win.dispatchEvent(new t.win.Event('resize'));
  check('narrower still: in from the right edge too', JSON.stringify(spot(t)) === JSON.stringify([700 - 168 - 8, 640 - 168 - 8]), spot(t));
  t.env.vp = { w: 1440, h: 900 };
  t.win.dispatchEvent(new t.win.Event('resize'));
  check('and back where it was when it grows', JSON.stringify(spot(t)) === JSON.stringify([600, 700]), spot(t));
});

await run('a place kept by the earlier floating bar', () => {
  const bottom = setup({ state: BOOK, dock: { at: 'bottom' } });
  check('its bottom centre: the long bar', placeOf(bottom) === 'bottom' && shapeOf(bottom) === 'long' && roomOf(bottom) === '73px');
  const free = setup({ state: BOOK, dock: { at: 'free', x: 684, y: 367 } });
  check('its spot of its own: the square there', placeOf(free) === 'free' && shapeOf(free) === 'square' &&
    JSON.stringify(spot(free)) === JSON.stringify([684, 367]) && roomOf(free) === '0px');
  const low = setup({ state: BOOK, dock: { at: 'free', x: 1300, y: 826 } });
  check('a spot the wider bar fitted is kept inside the viewport', JSON.stringify(spot(low)) === JSON.stringify([1264, 724]), spot(low));
  const top = setup({ state: BOOK, dock: { at: 'top' } });
  check('the top bar stays the top bar', placeOf(top) === 'top' && top.q('#wsPlayerPill').hidden === false && roomOf(top) === '0px');
  const odd = setup({ state: BOOK, dock: { at: 'centre' } });
  check('anything else: the long bar', placeOf(odd) === 'bottom' && shapeOf(odd) === 'long');
});

await run('the window opens, and Stop stops, from every shape', () => {
  for (const dock of ['bottom', { at: 'free', x: 400, y: 300 }, 'top']) {
    const t = setup({ state: BOOK, dock });
    const name = typeof dock === 'string' ? dock : 'square';
    const open = name === 'top' ? t.q('.wsp-pill-open') : t.q('.wsp-bar-open');
    open.click();
    check(name + ': the window opens', t.ui.isOpen() && t.ui.isWindow());
    open.click();
    check(name + ': and hides', !t.ui.isOpen());
    (name === 'top' ? t.q('.wsp-pill-stop') : t.q('.wsp-bar-stop')).click();
    check(name + ': Stop closes the book', t.engine.calls.some((c) => c[0] === 'close') && t.q('.wsp-bar').hidden && t.q('#wsPlayerPill').hidden);
  }
});

await run('the square shows no words: its cover\'s tooltip names the book, or says the warning', () => {
  const t = setup({ state: BOOK, dock: { at: 'free', x: 400, y: 300 } });
  const open = t.q('.wsp-bar-open');
  check('named by the book', open.getAttribute('title') === 'Open the player: Three Parts' && open.textContent.indexOf('Three Parts') !== -1);
  t.engine.emit('warning', { kind: 'not-saved', active: true, message: "Your place isn't being saved. Last saved 9:41 PM." });
  check('the warning: in its tooltip, its border says so', open.getAttribute('title') === "Your place isn't being saved. Last saved 9:41 PM." &&
    t.q('.wsp-bar').hasAttribute('data-warn'));
  check('and it is still said', t.q('.wsp-bar .wsp-warn-live').textContent.indexOf("isn't being saved") !== -1 &&
    !t.q('.wsp-bar .wsp-warn-live').hasAttribute('aria-hidden'));
  t.engine.emit('warning', { kind: 'not-saved', active: false });
  check('gone again', open.getAttribute('title') === 'Open the player: Three Parts' && !t.q('.wsp-bar').hasAttribute('data-warn'));
});

await run('tablets and phones: the bar, no handle to drag, room as before; a kept place waits for the desktop', () => {
  const t = setup({ state: BOOK, wide: false, dock: 'top' });
  check('the bar takes its room', roomOf(t) === '72px', roomOf(t));
  drag(t, t.q('.wsp-bar-grip'), [[20, 800], [400, 300]]);
  check('nothing to drag', !t.doc.documentElement.hasAttribute('data-wsp-drag') && dockOf(t).at === 'top');
  t.q('.wsp-bar-grip').click();
  check('nothing to choose', t.q('#wspDockMenu').hidden);
  t.q('.wsp-bar-open').click();
  check('the bar opens the full player, as ever', t.ui.isOpen() && !t.ui.isWindow());
  check('no tooltip there', !t.q('.wsp-bar-open').hasAttribute('title'));
  t.ui.close();
  t.env.setWide(true);
  check('widened: back in the top bar', roomOf(t) === '0px' && t.q('#wsPlayerPill').hidden === false);
  t.env.setWide(false);
  check('narrowed again: the bar\'s room', roomOf(t) === '72px');
  const f = setup({ state: BOOK, wide: false, dock: { at: 'free', x: 400, y: 300 } });
  check('a kept square: no spot and no arrows below lg', f.q('.wsp-bar').style.getPropertyValue('--wsp-x') === '' && roomOf(f) === '72px' &&
    !f.key(f.q('.wsp-bar-grip'), 'ArrowUp').defaultPrevented);
  const r = setup({ state: BOOK, shellHidden: true, dock: 'top' });
  check('a full-screen view: the phone\'s bar there too', roomOf(r) === '73px', roomOf(r));
});

await run('readDock, fitSquare, floatSpot, dropZone', () => {
  check('the long bar by default', JSON.stringify(U.readDock(null)) === JSON.stringify({ at: 'bottom' }) &&
    JSON.stringify(U.readDock({ at: 'sideways' })) === JSON.stringify({ at: 'bottom' }));
  check('a spot needs both numbers', JSON.stringify(U.readDock({ at: 'free', x: 3 })) === JSON.stringify({ at: 'bottom' }) &&
    JSON.stringify(U.readDock({ at: 'free', x: 3.4, y: 9.6 })) === JSON.stringify({ at: 'free', x: 3, y: 10 }));
  check('the top bar', JSON.stringify(U.readDock({ at: 'top', x: 1, y: 2 })) === JSON.stringify({ at: 'top' }));
  const vp = { w: 1440, h: 900, top: 72 };
  check('fitSquare keeps it in', JSON.stringify(U.fitSquare({ x: -50, y: 0 }, vp)) === JSON.stringify({ x: 8, y: 72 }) &&
    JSON.stringify(U.fitSquare({ x: 5000, y: 5000 }, vp)) === JSON.stringify({ x: 1264, y: 724 }));
  check('Float: the bottom right', JSON.stringify(U.floatSpot(vp)) === JSON.stringify({ x: 1248, y: 708 }) &&
    JSON.stringify(U.floatSpot({ w: 1024, h: 600, top: 72 })) === JSON.stringify({ x: 832, y: 408 }));
  check('the top band', U.dropZone({ x: 900, y: 135 }, vp, 64, 256) === 'top' && U.dropZone({ x: 900, y: 136 }, vp, 64, 256) === 'free');
  check('the bottom band', U.dropZone({ x: 900, y: 780 }, vp, 64, 256) === 'bottom' && U.dropZone({ x: 900, y: 779 }, vp, 64, 256) === 'free');
  check('neither over the sidebar', U.dropZone({ x: 200, y: 30 }, vp, 64, 256) === 'free' && U.dropZone({ x: 200, y: 880 }, vp, 64, 256) === 'free');
});

await run('the pill stays openable in the narrowest top bar', () => {
  const t = setup({ state: BOOK, dock: 'top' });
  check('the cover is the pill\'s, never taken away', !t.q('.wsp-pill-open').hidden);
  t.q('.wsp-pill-open').click();
  check('it opens the window', t.ui.isOpen() && t.ui.isWindow());
});

// ---------------------------------------------------------------------------
// Pop out: Document Picture-in-Picture
// ---------------------------------------------------------------------------

function fakePip(t) {
  const api = { asked: [], win: null, refuse: false };
  api.requestWindow = (o) => {
    api.asked.push(o);
    if (api.refuse) return Promise.reject(new Error('no gesture'));
    const w = new Window({ url: 'about:blank' });
    w.close = () => { if (w.gone) return; w.gone = true; w.dispatchEvent(new w.Event('pagehide')); };
    api.win = w;
    return Promise.resolve(w);
  };
  return api;
}

function popOut(t, o = {}) {
  return P.createPopOut(Object.assign({
    ui: t.ui, player: t.engine, win: t.win, doc: t.doc,
    setTimeout: t.clock.setTimeout, clearTimeout: t.clock.clearTimeout,
    pip: null, openWindow: () => null, BroadcastChannel: null, randomId: () => 'abcdef0123456789'
  }, o));
}

await run('Pop out with Picture-in-Picture: the window moves into it and back', async () => {
  const t = setup({ state: BOOK });
  t.doc.head.innerHTML = '<style id="ws-theme">:root{--color-text:1 2 3}</style>';
  const pip = fakePip(t);
  const po = popOut(t, { pip });
  t.ui.open();
  const btn = label(t, 'Pop out into its own window');
  check('Pop out is offered', !btn.hidden);
  btn.click();
  await flush();
  check('asked for a window its size', pip.asked.length === 1 && pip.asked[0].width === 380, pip.asked);
  const pdoc = pip.win.document;
  check('the same window, moved into it', pdoc.body.contains(t.full) && !t.doc.body.contains(t.full) && t.full.classList.contains('is-pip'));
  check('dressed like the page', !!pdoc.getElementById('ws-theme') && pdoc.documentElement.getAttribute('data-shell') === 'hidden');
  check('inside #wsPlayer there, so its rules hold', pdoc.getElementById('wsPlayer').contains(t.full));
  check('nothing to move, size, minimise or pop', label(t, 'Move the player. Arrow keys move it, Home puts it back.').hidden &&
    label(t, 'Close player window').hidden && label(t, 'Pop out into its own window').hidden);
  check('the pill says it is popped out', t.q('.wsp-pill').hasAttribute('data-popped') && po.active() === 'docked');
  check('the audio host stays in the page', t.doc.getElementById('wsPlayer') !== null);
  t.key(t.q('#wspTitle') || pdoc.getElementById('wspTitle'), 'Escape');
  check('Escape there does not close it', t.ui.isOpen() && pdoc.body.contains(t.full));
  t.engine.set({ playing: false }, 'pause');
  check('it still draws the player', pdoc.querySelector('.wsp-play-lg').getAttribute('aria-label') === 'Play');

  pip.win.close();
  check('its own close never stops the book', !t.engine.calls.some((c) => c[0] === 'close') && t.engine.state().book === '500:1');
  check('its own close: back in the page, minimised to the pill', t.doc.getElementById('wsPlayer').contains(t.full) && !t.ui.isOpen() &&
    !t.q('.wsp-pill').hasAttribute('data-popped') && po.active() === null);
  await t.clock.advance(200);

  t.ui.open();
  label(t, 'Pop out into its own window').click();
  await flush();
  t.q('.wsp-pill-open').click();
  check('the pill brings it back, open in the page', t.ui.isOpen() && t.ui.isWindow() && t.doc.getElementById('wsPlayer').contains(t.full) &&
    pip.win.gone === true && !t.full.classList.contains('is-pip'));

  label(t, 'Pop out into its own window').click();
  await flush();
  t.engine.set(EMPTY, 'close');
  check('the book closing closes it', pip.win.gone === true && t.doc.getElementById('wsPlayer').contains(t.full) && !t.ui.isOpen());

  const r = setup({ state: BOOK });
  const rpip = fakePip(r);
  rpip.refuse = true;
  popOut(r, { pip: rpip });
  r.ui.open();
  const quiet = console.error;
  console.error = () => {};
  try {
    label(r, 'Pop out into its own window').click();
    await flush();
  } finally {
    console.error = quiet;
  }
  check('refused: it stays, with a notice', r.ui.isOpen() && r.full.ownerDocument === r.doc && r.q('.wsp-notice') !== null);
});

// ---------------------------------------------------------------------------
// Pop out: the remote window, both ends
// ---------------------------------------------------------------------------

function fakeChannels() {
  const hub = new Map();
  class BC {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      this.closed = false;
      if (!hub.has(name)) hub.set(name, new Set());
      hub.get(name).add(this);
    }
    postMessage(data) {
      if (this.closed) throw new Error('closed');
      const copy = JSON.parse(JSON.stringify(data));
      for (const other of hub.get(this.name)) {
        if (other !== this && !other.closed) setImmediate(() => { if (!other.closed && other.onmessage) other.onmessage({ data: copy }); });
      }
    }
    close() { this.closed = true; hub.get(this.name).delete(this); }
  }
  return { BC, hub };
}

function remoteSide(ch, clock, o = {}) {
  const win = new Window({ url: 'https://ws.test/player/remote#abcdef0123456789' });
  const doc = win.document;
  doc.body.innerHTML = '<main id="wsRemote"></main>';
  const env = { closed: 0, loads: 0 };
  const fakePlayer = o.player;
  const remote = R.createRemote({
    doc, root: doc.getElementById('wsRemote'), id: o.id || 'abcdef0123456789', siteName: o.site === undefined ? 'My Media' : o.site,
    BroadcastChannel: ch.BC, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now,
    closeWindow: () => { env.closed += 1; },
    loadPlayer: () => { env.loads += 1; return Promise.resolve(fakePlayer); }
  });
  return { win, doc, env, remote, q: (s) => doc.querySelector(s) };
}

await run('the remote window: plays the tab, which keeps the audio', async () => {
  const t = setup({ state: BOOK, dock: 'top' });
  const ch = fakeChannels();
  const opened = [];
  const fakeRemoteWin = { closed: false, close() { this.closed = true; } };
  const po = popOut(t, { BroadcastChannel: ch.BC, openWindow: (url, name, features) => { opened.push([url, name, features]); return fakeRemoteWin; } });
  t.ui.open();
  label(t, 'Pop out into its own window').click();
  check('a small window on the remote page, its own channel', opened.length === 1 && opened[0][0] === '/player/remote#abcdef0123456789' &&
    /popup/.test(opened[0][2]), opened);
  check('the window here closes; the pill says popped out', !t.ui.isOpen() && t.q('.wsp-pill').hasAttribute('data-popped') && po.active() === 'remote');

  const r = remoteSide(ch, t.clock);
  check('connecting at first', r.q('.wsr-status').textContent === 'Connecting to your My Media tab');
  await flush();
  check('the tab answers hello with the book', r.q('.wsr-title').textContent === 'Three Parts' && r.q('.wsr-chapter').textContent === 'Part 2 of 3');
  check('connected', r.q('.wsr-status').textContent === 'Connected to your My Media tab');
  check('times in the chapter', r.q('.wsp-times').textContent === '1:40−13:20', r.q('.wsp-times').textContent);
  r.q('.wsr-play').click();
  await flush();
  check('Play/Pause plays the tab', t.engine.calls.filter((c) => c[0] === 'toggle').length === 1);
  r.q('.wsp-skip').click();
  await flush();
  check('back by the skip length', t.engine.calls.some((c) => c[0] === 'skip' && c[1] === -15));
  const range = r.q('.wsp-range');
  range.value = '300';
  range.dispatchEvent(new r.win.Event('change', { bubbles: true }));
  await flush();
  check('the scrubber seeks in the chapter', t.engine.calls.some((c) => c[0] === 'seek' && c[1] === 600000 + 300000));
  t.engine.set({ playing: false }, 'pause');
  await t.clock.advance(300);
  check('changes reach it', r.q('.wsr-play').getAttribute('aria-label') === 'Play');
  await t.clock.advance(5000);
  check('a quiet tab is not a closed tab (it answers the probes)', !r.remote.gone());

  // The remote's own window closed: the pill comes back.
  r.remote.leave();
  await flush();
  check('remote closed: the pill comes back', !t.q('.wsp-pill').hasAttribute('data-popped') && po.active() === null);
  check('and the book was never stopped', !t.engine.calls.some((c) => c[0] === 'close') && t.engine.state().book === '500:1' && !t.q('#wsPlayerPill').hidden);
});

await run('the remote window: the tab closes, Play here carries on', async () => {
  const t = setup({ state: BOOK });
  const ch = fakeChannels();
  const fakeRemoteWin = { closed: false, close() { this.closed = true; } };
  popOut(t, { BroadcastChannel: ch.BC, openWindow: () => fakeRemoteWin });
  t.ui.open();
  label(t, 'Pop out into its own window').click();
  const opened = [];
  const fakeUI = { open() { opened.push(1); return true; } };
  const fakePl = fakeEngine();
  const r = remoteSide(ch, t.clock, { player: { player: fakePl, ui: fakeUI } });
  await flush();
  t.win.dispatchEvent(new t.win.Event('pagehide'));
  await flush();
  check('the tab says goodbye: gone at once', r.remote.gone() && !r.q('.wsr-gone').hidden && r.q('.wsr-card').hidden);
  check('where it stopped, and saved', r.q('.wsr-gone-text').textContent === 'Your My Media tab was closed, so playback stopped at 11:40. Your place is saved.',
    r.q('.wsr-gone-text').textContent);
  const here = Array.from(r.doc.querySelectorAll('.wsr-btn')).find((b) => /Play here$/.test(b.textContent));
  check('Play here is offered, with focus', here && !here.hidden && r.doc.activeElement === here);
  here.click();
  await flush();
  check('the player loads here and opens the book from the saved place', r.env.loads === 1 &&
    fakePl.calls.some((c) => c[0] === 'open' && c[1] === '500:1' && c[2].autoplay === true));
  fakePl.set(BOOK, 'loading');
  check('and shows it', opened.length === 1);

  // A tab that just stops answering (crashed, discarded): within ~2 s.
  const t2 = setup({ state: BOOK });
  const ch2 = fakeChannels();
  popOut(t2, { BroadcastChannel: ch2.BC, openWindow: () => ({ closed: false, close() {} }) });
  t2.ui.open();
  label(t2, 'Pop out into its own window').click();
  const r2 = remoteSide(ch2, t2.clock);
  await flush();
  // The tab's end goes silent (its channel is the first one made).
  Array.from(ch2.hub.get('ws-player-remote:abcdef0123456789'))[0].close();
  await t2.clock.advance(1400);
  check('not yet', !r2.remote.gone());
  await t2.clock.advance(1400);
  check('gone within about 2 s', r2.remote.gone());

  const r3 = remoteSide(fakeChannels(), t2.clock, { id: 'abcdef0123456789' });
  await t2.clock.advance(2200);
  check('opened with no tab: says so, no Play here', r3.remote.gone() && r3.q('.wsr-gone-text').textContent.indexOf('is not open') !== -1 &&
    Array.from(r3.doc.querySelectorAll('.wsr-btn')).find((b) => /Play here$/.test(b.textContent)).hidden);
  const r4 = remoteSide(fakeChannels(), t2.clock, { id: 'bad' });
  check('a bad address: gone at once', r4.remote.gone());
});

await run('the remote window: brought back, or the book closed, it closes', async () => {
  const t = setup({ state: BOOK });
  const ch = fakeChannels();
  const w = { closed: false, close() { this.closed = true; } };
  popOut(t, { BroadcastChannel: ch.BC, openWindow: () => w });
  t.ui.open();
  label(t, 'Pop out into its own window').click();
  const r = remoteSide(ch, t.clock);
  await flush();
  t.q('.wsp-pill-open').click();
  await flush();
  check('the pill brings it back into the page', t.ui.isOpen() && t.ui.isWindow() && !t.q('.wsp-pill').hasAttribute('data-popped'));
  check('the remote is told and closed', w.closed && r.env.closed === 1);

  const t2 = setup({ state: BOOK });
  const ch2 = fakeChannels();
  const w2 = { closed: false, close() { this.closed = true; } };
  popOut(t2, { BroadcastChannel: ch2.BC, openWindow: () => w2 });
  t2.ui.open();
  label(t2, 'Pop out into its own window').click();
  remoteSide(ch2, t2.clock);
  await flush();
  w2.closed = true;
  await t2.clock.advance(1100);
  check('its window closed without a word: noticed', !t2.q('.wsp-pill').hasAttribute('data-popped'));

  const t3 = setup({ state: BOOK });
  popOut(t3, { BroadcastChannel: fakeChannels().BC, openWindow: () => null });
  t3.ui.open();
  label(t3, 'Pop out into its own window').click();
  check('pop-ups blocked: it stays, with a notice', t3.ui.isOpen() && t3.q('.wsp-notice').textContent.indexOf('Pop-ups are blocked') !== -1);
});

await run('remoteState', () => {
  const s = P.remoteState(BOOK, 15);
  check('the chapter as a span, the time, the skip', s.chapter === 'Part 2 of 3' && s.start === 600000 && s.end === 1500000 && s.at === 700000 && s.skip === 15 && s.playing === true, s);
  check('no book', P.remoteState(EMPTY, 10).book === null);
  check('held', P.remoteState(Object.assign({}, BOOK, { filesChanged: { spot: 0 } })).held === true);
});

console.log(failed ? `${total - failed}/${total} player window cases checked, ${failed} failed` : `${total}/${total} player window cases pass`);
if (failed) process.exit(1);
