// The desktop player (app/static/js/player/ui.js and popout.js, and the
// remote window's app/static/js/player-remote.js) in
// happy-dom: the top bar's pill and its states, the pill expanding into the
// player as a drop-down under it (the pill again, its Collapse and Escape
// back to the pill, the pill's Stop (right of Play) with Resume, panels
// opening below and closing again, the drop-down growing for them and
// shrinking back), nothing to move or size, soft navigation, scrolling and
// outside clicks leaving it open, the phone keeping the sheet, and Pop out
// through fakes: Document Picture-in-Picture (a second happy-dom document)
// and the remote window over a fake BroadcastChannel, both ends.
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
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); }
  };
}

// A desktop page: the top bar with the pill's slot, a 1440x900 viewport
// whose top bar ends at 64 px, the pill 300 px wide ending at 1240 px.
function setup(o = {}) {
  const win = new Window({ url: 'https://ws.test/' });
  const doc = win.document;
  doc.body.innerHTML = '<header id="appHeader"><div id="wsPlayerPill" hidden></div><button id="bell" type="button">Bell</button></header>' +
    '<main><div id="wsPage"><h1>Home</h1><button id="pageBtn" type="button">Page</button></div></main><div id="wsPlayer" hidden></div>';
  if (o.shellHidden) doc.documentElement.setAttribute('data-shell', 'hidden');
  const clock = fakeClock();
  const engine = fakeEngine(o.state);
  const env = { wide: o.wide !== false, reduce: !!o.reduce, vp: { w: 1440, h: 900 }, pill: { left: 940, right: 1240 }, wideFns: [] };
  const storage = o.storage || memoryStorage();
  const opts = {
    doc, host: doc.getElementById('wsPlayer'), player: engine,
    matchMedia: (q) => ({
      get matches() { return q.indexOf('reduce') !== -1 ? env.reduce : q.indexOf('min-width') !== -1 ? env.wide : false; },
      addEventListener(type, fn) { if (type === 'change' && q.indexOf('min-width') !== -1) env.wideFns.push(fn); }
    }),
    // The bar is gone on a desktop page (0 px); the drop-down, with no
    // panel, is 400 px tall, else the height it was given.
    measure: (el) => (el.classList.contains('wsp-full') ? (el.style.height ? parseInt(el.style.height, 10) : 400) : env.wide ? 0 : 72),
    isVisible: (el) => !el.closest('[hidden]'),
    now: () => clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ResizeObserver: null,
    isDialogOpen: () => false,
    win,
    CloseWatcher: null,
    hasActivation: () => true,
    storage,
    viewport: () => ({ w: env.vp.w, h: env.vp.h }),
    topLimit: () => 64,
    pillBox: () => env.pill
  };
  if (o.noPill) opts.pillSlot = null;
  if (o.storageKeys) for (const k of o.storageKeys) storage.setItem(k, '{"at":"bottom"}');
  // The tablet bar's gap above the tab bar (theme.css --wsp-bar-gap).
  if (o.gap !== undefined) {
    const real = win.getComputedStyle.bind(win);
    win.getComputedStyle = (el) => (el.classList.contains('wsp-bar') ? { getPropertyValue: (p) => (p === '--wsp-bar-gap' ? o.gap : '') } : real(el));
  }
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
  const t = setup();
  const slot = t.q('#wsPlayerPill');
  const pill = t.q('.wsp-pill');
  check('built in the top bar, left of the bell', pill && slot.contains(pill) && slot.nextElementSibling === t.q('#bell'));
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
    t.q('.wsp-pill-open').getAttribute('aria-label') === 'Collapse the player: Three Parts');
  check('the pill controls the player', t.q('.wsp-pill-open').getAttribute('aria-controls') === t.full.id && t.full.id === 'wspFull');
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
  check('said once, here, while it is collapsed', t.q('.wsp-pill [role="status"]').textContent.indexOf("isn't being saved") !== -1);
  t.ui.open();
  check('the drop-down says it while expanded', t.q('.wsp-pill [role="status"]').textContent === '');
  t.ui.close();

  t.engine.set(EMPTY, 'close');
  check('the book closed: hidden', slot.hidden === true);
});

await run('the pill: play pauses without opening; a held book expands it', () => {
  const t = setup({ state: BOOK });
  t.q('.wsp-pill-play').click();
  check('toggled', t.engine.calls.some((c) => c[0] === 'toggle'));
  check('nothing opened', !t.ui.isOpen());
  t.engine.set({ playing: false, filesChanged: { old: {}, spot: 0 } }, 'pause');
  t.q('.wsp-pill-play').click();
  check('held: it expands for Find your place', t.ui.isOpen() && t.ui.isWindow());
});

// ---------------------------------------------------------------------------
// The drop-down
// ---------------------------------------------------------------------------

await run('the pill expands into the player: part of the page, not a dialog', async () => {
  const t = setup({ state: BOOK });
  const captures = [];
  const add = t.doc.addEventListener.bind(t.doc);
  t.doc.addEventListener = (type, fn, opt) => { if (opt === true) captures.push(type); return add(type, fn, opt); };
  t.q('.wsp-pill-open').focus();
  t.q('.wsp-pill-open').click();
  check('expands as the drop-down', t.ui.isOpen() && t.ui.isWindow() && t.full.classList.contains('is-window'));
  check('aria-expanded on the pill', t.q('.wsp-pill-open').getAttribute('aria-expanded') === 'true');
  check('a region, not a modal dialog', t.full.getAttribute('role') === 'region' && !t.full.hasAttribute('aria-modal') &&
    t.full.getAttribute('aria-label') === 'Audiobook player');
  check('the page is not marked or blocked', !t.doc.documentElement.hasAttribute('data-player-full') && captures.length === 0, captures);
  check('focus on the title', t.doc.activeElement === t.q('#wspTitle'));
  check('the sheet\'s close button gives way to Collapse', t.q('.wsp-full [aria-label="Close the player"]').hidden &&
    !label(t, 'Collapse the player').hidden && label(t, 'Collapse the player').textContent === 'expand_less');
  check('nothing to move or size: no grip, no corner, no Stop in it', !t.full.querySelector('.wsp-win-grip, .wsp-win-resize') &&
    !t.full.querySelector('[aria-label^="Move"], [aria-label^="Resize"], [aria-label^="Stop"]'));
  check('no Pop out until popout.js offers it', label(t, 'Pop out into its own window').hidden);
  const tab = t.key(t.q('#wspTitle'), 'Tab');
  check('Tab is never trapped', !tab.defaultPrevented);
  t.q('#pageBtn').focus();
  check('focus may leave', t.doc.activeElement === t.q('#pageBtn') && t.ui.isOpen());
  check('hangs under the pill, right edges together, 400 wide', JSON.stringify(t.rect()) === JSON.stringify({ x: 840, y: 74, w: 400, h: null }), t.rect());
  check('as tall as the room under the top bar at most', t.full.style.maxHeight === (900 - 74 - 14) + 'px', t.full.style.maxHeight);
  check('its pointer under the pill\'s middle', t.full.style.getPropertyValue('--wsp-caret') === '250px', t.full.style.getPropertyValue('--wsp-caret'));
  check('opens with its drop and fade', t.full.classList.contains('is-opening'));
  await t.clock.advance(300);
  check('which ends', !t.full.classList.contains('is-opening'));
});

await run('no dragging and nothing kept: pointer moves on its top bar do nothing', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  const before = JSON.stringify(t.rect());
  const top = t.q('.wsp-top-label');
  t.pointer(top, 'pointerdown', 1200, 90);
  t.pointer(top, 'pointermove', 600, 400);
  t.pointer(top, 'pointerup', 600, 400);
  check('it stays under the pill', JSON.stringify(t.rect()) === before, t.rect());
  check('nothing kept on this device', t.storage.m.size === 0, Array.from(t.storage.m.keys()));
});

await run('collapse: the pill again, Collapse and Escape; it plays on; focus to the pill', async () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  t.q('.wsp-pill-open').click();
  check('the pill collapses it', !t.ui.isOpen() && t.q('.wsp-pill-open').getAttribute('aria-expanded') === 'false');
  await t.clock.advance(200);
  check('then it is gone', t.full.hidden === true && !t.full.classList.contains('is-window'));
  t.ui.open();
  const ev = t.key(t.q('#wspTitle'), 'Escape');
  check('Escape collapses', !t.ui.isOpen() && ev.defaultPrevented);
  check('focus to the pill', t.doc.activeElement === t.q('.wsp-pill-open'));
  await t.clock.advance(200);
  t.ui.open();
  label(t, 'Collapse the player').click();
  check('Collapse collapses', !t.ui.isOpen() && t.doc.activeElement === t.q('.wsp-pill-open'));
  check('and the book plays on', t.engine.calls.length === 0 && t.engine.state().playing === true && !t.q('#wsPlayerPill').hidden &&
    t.q('.wsp-pill').getAttribute('data-state') === 'playing', t.engine.calls);
  await t.clock.advance(200);
  t.ui.open();
  t.q('.wsp-pill-open').focus();
  const pe = t.key(t.q('.wsp-pill-open'), 'Escape');
  check('Escape on the pill collapses it too', !t.ui.isOpen() && pe.defaultPrevented && t.doc.activeElement === t.q('.wsp-pill-open'));
  const idle = t.key(t.q('.wsp-pill-open'), 'Escape');
  check('collapsed, the pill leaves Escape alone', !idle.defaultPrevented);
  await t.clock.advance(200);
  t.ui.open();
  t.q('#pageBtn').focus();
  t.ui.close();
  check('focus on the page stays there', t.doc.activeElement === t.q('#pageBtn'));
});

await run('the pill\'s Play and Stop work while it is expanded', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  t.q('.wsp-pill-play').click();
  check('Play toggles, and it stays expanded', t.engine.calls.some((c) => c[0] === 'toggle') && t.ui.isOpen());
  t.q('.wsp-pill-stop').click();
  check('Stop closes the book and the drop-down', t.engine.calls.some((c) => c[0] === 'close') && !t.ui.isOpen());
});

await run('soft navigation, scrolling and outside clicks leave it open; a full-screen view closes it', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  t.q('#pageBtn').click();
  t.doc.body.dispatchEvent(new t.win.PointerEvent('pointerdown', { bubbles: true }));
  t.doc.body.click();
  check('a click on the page: still open', t.ui.isOpen());
  t.win.dispatchEvent(new t.win.Event('scroll'));
  check('the page scrolled: still open', t.ui.isOpen());
  t.env.pill = { left: 1000, right: 1240 };
  t.win.dispatchEvent(new t.win.CustomEvent('ws:page-mounted', { detail: { url: 'https://ws.test/books' } }));
  check('Home to Books: still open', t.ui.isOpen() && t.ui.isWindow());
  check('and under the pill where the new top bar put it', t.full.style.getPropertyValue('--wsp-caret') === '280px', t.full.style.getPropertyValue('--wsp-caret'));
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
  check('a phone: no place or pointer set', !p.full.style.left && !p.full.style.getPropertyValue('--wsp-caret'));
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
  check('narrowed: the drop-down closes', !t.ui.isOpen());
  t.ui.open();
  check('then the sheet', t.ui.isOpen() && !t.ui.isWindow());
  t.env.setWide(true);
  check('widened: the sheet closes', !t.ui.isOpen());
});

await run('a smaller browser window keeps it inside', () => {
  const t = setup({ state: BOOK });
  t.ui.open();
  t.env.vp = { w: 1100, h: 700 };
  t.env.pill = { left: 800, right: 900 };
  t.win.dispatchEvent(new t.win.Event('resize'));
  check('follows the pill, room to the new bottom', t.rect().x === 500 && t.rect().w === 400 && t.full.style.maxHeight === (700 - 74 - 14) + 'px', [t.rect(), t.full.style.maxHeight]);
  t.ui.close();
  t.env.vp = { w: 1440, h: 900 };
  t.win.dispatchEvent(new t.win.Event('resize'));
  check('collapsed, it no longer listens', t.full.style.maxHeight === '' || t.full.style.maxHeight === (700 - 74 - 14) + 'px');
});

await run('fitDrop: under the pill, at least 400 wide, never off screen', () => {
  const vp = { w: 1440, h: 900, top: 64 };
  check('right-aligned with the pill', JSON.stringify(U.fitDrop({ left: 940, right: 1240 }, vp)) === JSON.stringify({ x: 840, y: 74, w: 400, room: 812, caret: 250 }), U.fitDrop({ left: 940, right: 1240 }, vp));
  const wide = U.fitDrop({ left: 700, right: 1240 }, vp);
  check('a wider pill: its width', wide.w === 540 && wide.x === 700 && wide.caret === 270, wide);
  const tight = U.fitDrop({ left: 300, right: 388 }, { w: 1024, h: 768, top: 64 });
  check('a pill near the left: slid right to stay inside', tight.x === 8 && tight.w === 400 && tight.caret === 336, tight);
  const tiny = U.fitDrop({ left: 1000, right: 1088 }, { w: 1024, h: 768, top: 64 });
  check('a pill past the right edge: kept 8 px in', tiny.x === 1024 - 8 - 400, tiny);
  const tinyCaret = U.fitDrop({ left: 1300, right: 1440 }, vp);
  check('the pointer never leaves its corner\'s curve', tinyCaret.caret <= tinyCaret.w - U.DROP_CARET, tinyCaret);
  const none = U.fitDrop(null, vp);
  check('no pill box: top right', none.x === 1440 - 24 - 400 && none.y === 74, none);
  check('a short screen: room is what is left', U.fitDrop({ left: 940, right: 1240 }, { w: 1440, h: 300, top: 64 }).room === 212);
});

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function withPanels(t) {
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
  const chapters = () => t.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1);
  return { tune, speedBtn, chapters };
}

await run('panels open below and close again, each from its own button', () => {
  const t = setup({ state: BOOK });
  const { tune, speedBtn, chapters: ch } = withPanels(t);
  t.ui.open();
  const chapters = ch();
  check('no panel at first', !t.full.hasAttribute('data-view') && t.qa('.wsp-panel').every((p) => p.hidden));
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
  check('pressed again: closed, back to the player alone', !t.full.hasAttribute('data-view'));
  chapters.click();
  t.q('.wsp-chapter-item[data-index="2"]').click();
  check('a chapter jumps and the list stays', t.engine.calls.some((c) => c[0] === 'jump' && c[1] === 2) && t.full.getAttribute('data-view') === 'chapters');
  const esc = t.key(t.q('.wsp-chapter-item[data-index="2"]'), 'Escape');
  check('Escape closes the panel first, focus back on its button', esc.defaultPrevented && t.ui.isOpen() &&
    !t.full.hasAttribute('data-view') && t.doc.activeElement === chapters);
  t.key(chapters, 'Escape');
  check('then Escape collapses', !t.ui.isOpen());
  t.ui.open();
  ch().click();
  t.ui.close();
  check('collapsing closes the panel', !t.full.hasAttribute('data-view') && t.full.style.height === '');
  check('on the sheet the buttons carry no expanded state', (() => {
    const p = setup({ state: BOOK, wide: false });
    p.ui.open();
    return p.qa('.wsp-action').every((b) => !b.hasAttribute('aria-expanded'));
  })());
});

await run('a panel grows the drop-down to the room under the top bar, smoothly, and it shrinks back', async () => {
  const t = setup({ state: BOOK });
  const { speedBtn, chapters } = withPanels(t);
  t.ui.open();
  check('the player alone: its content\'s height', t.rect().h === null);
  chapters().click();
  check('Chapters: from its own height...', t.full.classList.contains('is-sizing') && t.rect().h === 812, [t.full.className, t.rect()]);
  await t.clock.advance(300);
  check('...to the room under the top bar, and stays', !t.full.classList.contains('is-sizing') && t.rect().h === 812, t.rect());
  speedBtn.click();
  check('another panel: the same height, nothing runs', !t.full.classList.contains('is-sizing') && t.rect().h === 812);
  speedBtn.click();
  check('closed: back down to the player', t.full.classList.contains('is-sizing') && t.rect().h === 400, t.rect());
  await t.clock.advance(300);
  check('then its content\'s height again', !t.full.classList.contains('is-sizing') && t.rect().h === null, t.rect());
  t.env.vp = { w: 1440, h: 700 };
  chapters().click();
  await t.clock.advance(300);
  check('a shorter screen: less room', t.rect().h === 700 - 74 - 14, t.rect());

  const r = setup({ state: BOOK, reduce: true });
  withPanels(r);
  r.ui.open();
  r.qa('.wsp-action').find((b) => b.textContent.indexOf('Chapters') !== -1).click();
  check('reduced motion: at once', !r.full.classList.contains('is-sizing') && r.rect().h === 812, r.rect());
});

await run('prompts and notices: inside the drop-down while expanded, on the page while collapsed', () => {
  const t = setup({ state: BOOK });
  const early = t.ui.prompt({ message: 'Up next: Book Two. Play it?', actions: [{ label: 'Play', primary: true }], id: 'upnext' });
  check('collapsed: on the page, not hidden', !!t.q('.wsp-prompt') && !t.full.contains(t.q('.wsp-prompt')) && !t.q('#wsPlayer').hidden);
  t.ui.open();
  check('expanded: it moves inside', t.full.contains(t.q('.wsp-prompt')));
  early.remove();
  const pr = t.ui.prompt({ message: 'Continue from 1:02:03 (Chrome on Android, 2 h ago)?', actions: [{ label: 'Continue', primary: true }] });
  check('inside the drop-down', t.full.contains(t.q('.wsp-prompt')));
  t.ui.close();
  check('in the page once it collapses', !t.full.contains(t.q('.wsp-prompt')) && !!t.q('.wsp-prompt'));
  pr.remove();
});

await run('the pill\'s Stop: right of Play, playing or paused; the book closes, the place is saved, Resume', async () => {
  const t = setup({ state: BOOK });
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
  check('expanded: Stop is still the pill\'s', !stop.hidden);
  stop.focus();
  stop.click();
  check('the book is closed, the drop-down too', t.engine.calls.some((c) => c[0] === 'close') && !t.ui.isOpen());
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
  check('collapsed: the same', c.engine.calls.some((x) => x[0] === 'close') && c.q('#wsPlayerPill').hidden &&
    c.doc.activeElement === Array.from(c.q('.wsp-notice').querySelectorAll('button')).find((b) => b.textContent === 'Resume'));

  const h = setup({ state: Object.assign({}, BOOK, { playing: false, safetyNet: { failed: false, orphans: [] } }) });
  check('held: no claim of a save in its name', h.q('.wsp-pill-stop').getAttribute('aria-label') === 'Stop listening');
  h.q('.wsp-pill-stop').click();
  check('held: no claim that anything was saved', h.q('.wsp-notice').textContent.indexOf('Your place is as it was.') !== -1);
});

const roomOf = (t) => t.doc.documentElement.style.getPropertyValue('--ws-player-h');

await run('desktop: the pill only, no bar, no handle, no room kept at the bottom', () => {
  const t = setup({ state: BOOK, gap: '12px' });
  check('the pill shows, left of the bell', !t.q('#wsPlayerPill').hidden && t.q('#wsPlayerPill').nextElementSibling === t.q('#bell'));
  check('cover, Play, then Stop', JSON.stringify(Array.from(t.q('.wsp-pill').children).slice(0, 3).map((e) => e.className.split(' ').pop())) ===
    JSON.stringify(['wsp-pill-open', 'wsp-pill-play', 'wsp-pill-stop']));
  check('no handle and no place menu', !t.q('.wsp-grip') && !t.q('#wspDockMenu') && !t.q('.wsp-dock-target') && !t.q('.wsp-dock-ghost'));
  check('the bar is the pilled one, no room kept, no gap', t.q('.wsp-bar').classList.contains('wsp-bar-pilled') && roomOf(t) === '0px', roomOf(t));
});

await run('tablets: the bar with Stop right of Play, room for it and its gap; phones as before', async () => {
  const t = setup({ state: BOOK, wide: false, gap: '12px' });
  const stop = t.q('.wsp-bar-stop');
  check('Stop right of Play in the bar', stop && t.q('.wsp-bar-row .wsp-play').nextElementSibling === stop && stop.textContent === 'stop');
  check('named for what it does', stop.getAttribute('aria-label') === 'Stop listening, your place is saved' && !stop.hasAttribute('aria-disabled'));
  check('room for the bar and the gap above the tab bar', roomOf(t) === '84px', roomOf(t));
  t.engine.set({ loading: true }, 'loading');
  check('loading: inert', stop.getAttribute('aria-disabled') === 'true');
  stop.click();
  check('an inert Stop does nothing', !t.engine.calls.some((c) => c[0] === 'close'));
  t.engine.set({ loading: false }, 'loading');
  t.q('.wsp-bar-open').click();
  check('the bar opens the full player, as ever', t.ui.isOpen() && !t.ui.isWindow());
  t.ui.close();
  await t.clock.advance(400);
  stop.click();
  check('Stop closes the book, the place is saved', t.engine.calls.some((c) => c[0] === 'close') &&
    t.q('.wsp-notice').textContent.indexOf('Stopped at 11:40. Your place is saved.') !== -1);
  check('focus on Resume', t.doc.activeElement === Array.from(t.q('.wsp-notice').querySelectorAll('button')).find((b) => b.textContent === 'Resume'));
  const p = setup({ state: BOOK, wide: false });
  check('a phone (no gap): the bar\'s height only', roomOf(p) === '72px', roomOf(p));
  p.env.setWide(true);
  check('widened: the pill shows (the room follows the bar\'s ResizeObserver)', !p.q('#wsPlayerPill').hidden);
});

await run('places kept by the earlier movable window and bar are dropped on load', () => {
  const keys = ['ws-player-dock:abc0123456789def', 'ws-player-dock:fff0123456789aaa', 'ws-player-dock', 'ws-player-window:abc0123456789def',
    'ws-player-window:fff0123456789aaa', 'ws-player-window', 'ws-player-docked', 'ws-player-windowed'];
  const t = setup({ state: BOOK, storageKeys: keys });
  check('dock and window places gone', keys.slice(0, 6).every((k) => t.storage.getItem(k) === null), Array.from(t.storage.m.keys()));
  check('everything else kept', t.storage.getItem('ws-player-docked') !== null && t.storage.getItem('ws-player-windowed') !== null);
  check('the pill shows as ever', !t.q('#wsPlayerPill').hidden);
  const s = memoryStorage();
  s.key = () => { throw new Error('blocked'); };
  s.setItem('ws-player-dock:abc0123456789def', '{}');
  let threw = false;
  try { setup({ state: BOOK, storage: s }); } catch (e) { threw = true; }
  check('a storage that throws is no problem', !threw);
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
  check('asked for a window its size', pip.asked.length === 1 && pip.asked[0].width === 400, pip.asked);
  const pdoc = pip.win.document;
  check('the same window, moved into it', pdoc.body.contains(t.full) && !t.doc.body.contains(t.full) && t.full.classList.contains('is-pip'));
  check('dressed like the page', !!pdoc.getElementById('ws-theme') && pdoc.documentElement.getAttribute('data-shell') === 'hidden');
  check('inside #wsPlayer there, so its rules hold', pdoc.getElementById('wsPlayer').contains(t.full));
  check('nothing to collapse or pop, no pointer', label(t, 'Collapse the player').hidden && label(t, 'Pop out into its own window').hidden &&
    !t.full.style.getPropertyValue('--wsp-caret') && !t.full.style.left);
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
  const t = setup({ state: BOOK });
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
