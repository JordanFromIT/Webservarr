// The shared marquee (ui.js WSUI.marquee and WSUI.marqueePlaceholder), run
// for real in happy-dom with a model of the layout (a word box's width is set
// by the test; words are 8px a character) and fake observers:
//  * only words that are cut off move (by 2px or more); the slide is the
//    distance they run past the box, about 32 px/s, with a 1.75 s rest at
//    each end, written as custom properties for theme.css to run.
//  * the words are moved into one track (the same nodes: read once).
//  * it measures again when the box resizes, and new words start over.
//  * it holds still off screen and while the tab is hidden, and goes on.
//  * reduced motion: nothing moves, the ellipsis stays, and a change of the
//    setting while the page is open is followed.
//  * enable(false) stops it; destroy() undoes it, and the last one ends the
//    observers and the listeners.
//  * a group (opts.group) keeps one beat: one slide time from the box that
//    runs furthest, each box its own distance, every running slide started
//    at the page's zero (so a late box, or new words, fall in step); a
//    held slide is left paused; boxes outside the group keep their own.
//  * the placeholder: an overlay with the input's placeholder slides while
//    the input is empty and unfocused, the input's own placeholder steps
//    aside meanwhile; focus or text stops it; the visit's end undoes it.
//  * theme.css: the rules the attributes drive.
//
// Run: node app/tests/js/marquee.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const UI = readFileSync(join(STATIC, 'js/ui.js'), 'utf8');
const THEME = readFileSync(join(STATIC, 'css/theme.css'), 'utf8');
const BOOKS_HTML = readFileSync(join(STATIC, 'books.html'), 'utf8');

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
function scenario(name, fn) {
  current = name;
  try { fn(); } catch (e) { check('threw: ' + (e && e.stack || e), false); }
}

const CHAR_PX = 8;

/* A page with ui.js loaded. widths: element -> its box's width. */
function page(o = {}) {
  const w = new Window({ url: 'https://dev.example.test/', width: 390, height: 844 });
  const d = w.document;
  const widths = new Map();
  const textWidth = (n) => n.textContent.length * CHAR_PX;
  const proto = w.HTMLElement.prototype;
  // Off the page, nothing has a size.
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return this.isConnected ? (widths.get(this) || 0) : 0; } });
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get() { return this.isConnected ? Math.max(widths.get(this) || 0, textWidth(this)) : 0; } });
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get() {
    if (!this.isConnected) return 0;
    return widths.has(this) ? widths.get(this) : textWidth(this);
  } });
  let hidden = false;
  Object.defineProperty(d, 'visibilityState', { configurable: true, get() { return hidden ? 'hidden' : 'visible'; } });
  const motion = { reduce: !!o.reduced, listeners: [] };
  w.matchMedia = (q) => ({
    get matches() { return q.indexOf('prefers-reduced-motion: reduce') !== -1 && motion.reduce; },
    media: q,
    addEventListener(type, fn) { motion.listeners.push(fn); },
    removeEventListener(type, fn) { motion.listeners = motion.listeners.filter((f) => f !== fn); }
  });
  const ros = [];
  const ios = [];
  w.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.els = new Set(); this.live = true; ros.push(this); }
    observe(el) { this.els.add(el); }
    unobserve(el) { this.els.delete(el); }
    disconnect() { this.els.clear(); this.live = false; }
    fire(el) { this.cb([...this.els].filter((x) => !el || x === el).map((target) => ({ target }))); }
  };
  w.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.els = new Set(); this.live = true; ios.push(this); }
    observe(el) { this.els.add(el); }
    unobserve(el) { this.els.delete(el); }
    disconnect() { this.els.clear(); this.live = false; }
    fire(el, on) { this.cb([{ target: el, isIntersecting: on }]); }
  };
  // The document's listeners, counted.
  const docListeners = new Map();
  const add = d.addEventListener.bind(d);
  const remove = d.removeEventListener.bind(d);
  d.addEventListener = (type, fn, opts) => { docListeners.set(type, (docListeners.get(type) || 0) + 1); add(type, fn, opts); };
  d.removeEventListener = (type, fn, opts) => { docListeners.set(type, (docListeners.get(type) || 0) - 1); remove(type, fn, opts); };
  // The browser's CSS animations, as a model: a track in a box marked
  // data-marquee has its one ws-marquee slide; while held (paused by
  // theme.css) its start time is unresolved, as a paused animation's is,
  // and giving it one would play it (counted in playedHeld).
  const anims = new Map();
  let playedHeld = 0;
  w.Element.prototype.getAnimations = function () {
    const track = this;
    const box = track.parentElement;
    if (!track.classList.contains('ws-marquee__track') || !box || !box.hasAttribute('data-marquee')) { anims.delete(track); return []; }
    let a = anims.get(track);
    if (!a) {
      let start = null;
      a = { animationName: 'ws-marquee',
            get startTime() { return start; },
            set startTime(v) { if (v !== null && track.parentElement && track.parentElement.getAttribute('data-marquee') === 'held') playedHeld += 1; start = v; },
            pause() { start = null; } };
      anims.set(track, a);
    }
    if (box.getAttribute('data-marquee') === 'held') a.pause();
    return [a];
  };
  w.eval(UI);
  const t = {
    w, d, widths, motion, ros, ios, docListeners,
    playedHeld: () => playedHeld,
    // A box's slide's start time as the browser would have it: null for none yet.
    startOf(box) {
      const tr = box.firstElementChild;
      if (!tr || !anims.has(tr)) return undefined;
      const a = tr.getAnimations()[0];
      return a ? a.startTime : undefined;
    },
    ro: () => ros[ros.length - 1],
    io: () => ios[ios.length - 1],
    setHidden(v) { hidden = v; d.dispatchEvent(new w.Event('visibilitychange')); },
    setReduced(v) { motion.reduce = v; motion.listeners.slice().forEach((fn) => fn({ matches: v })); },
    box(text, width) {
      const b = d.createElement('span');
      b.className = 'title';
      b.textContent = text;
      d.body.appendChild(b);
      widths.set(b, width);
      return b;
    }
  };
  return t;
}

const prop = (el, p) => el.style.getPropertyValue(p);
const words = (n) => 'x'.repeat(n);

scenario('words that fit do not move; words cut off slide the distance they run past the box', () => {
  const t = page();
  const fits = t.box(words(12), 100);        // 96px in 100
  const cut = t.box(words(20), 100);         // 160px in 100: 60px past
  const hair = t.box(words(20), 159);        // 1px past: rounding
  const m1 = t.w.WSUI.marquee(fits);
  t.w.WSUI.marquee(cut);
  t.w.WSUI.marquee(hair);
  check('words that fit: no mark, no slide (the ellipsis stays)', !fits.hasAttribute('data-marquee') && prop(fits, '--marquee-shift') === '');
  check('cut off by 1px: still', !hair.hasAttribute('data-marquee'));
  check('cut off: moving', cut.getAttribute('data-marquee') === 'run');
  check('the distance: 60px back', prop(cut, '--marquee-shift') === '-60px', prop(cut, '--marquee-shift'));
  // 60px at 32 px/s is 1.875 s, plus a 1.75 s rest (half at each end).
  check('one way takes the slide plus one rest', prop(cut, '--marquee-time') === '3.625s', prop(cut, '--marquee-time'));
  check('the first rest is whole: half of it before the start', prop(cut, '--marquee-delay') === '0.875s', prop(cut, '--marquee-delay'));
  check('the ease rests at both ends for half a rest each', prop(cut, '--marquee-ease') === 'linear(0, 0 24.14%, 1 75.86%, 1)', prop(cut, '--marquee-ease'));
  // What that means on screen, from the properties alone.
  const time = parseFloat(prop(cut, '--marquee-time'));
  const [, a, b] = prop(cut, '--marquee-ease').match(/0 ([\d.]+)%, 1 ([\d.]+)%/).map(Number);
  const speed = 60 / (time * (b - a) / 100);
  const restEnd = time * a / 100 * 2;
  check('a calm speed, 30 to 40 px/s', speed >= 30 && speed <= 40, speed);
  check('a rest of 1.5 to 2 s at each end', restEnd >= 1.5 && restEnd <= 2, restEnd);
  check('one track holds the same words, once', cut.children.length === 1 && cut.firstElementChild.className === 'ws-marquee__track' &&
    cut.textContent === words(20) && cut.childNodes.length === 1);
  check('a box that fits is wrapped too, so a later resize can start it', fits.firstElementChild && fits.firstElementChild.className === 'ws-marquee__track');
  m1.destroy();
});

scenario('it follows the box: a resize, new words, and the same words again', () => {
  const t = page();
  const b = t.box(words(20), 100);
  const changes = [];
  const m = t.w.WSUI.marquee(b, { onChange: (on) => changes.push(on) });
  check('started, and said so', b.getAttribute('data-marquee') === 'run' && changes.join() === 'true');
  check('the box is watched for its size and for being on screen', t.ro().els.has(b) && t.io().els.has(b));
  t.widths.set(b, 200);
  t.ro().fire(b);
  check('wider than its words: still again, and said so', !b.hasAttribute('data-marquee') && prop(b, '--marquee-shift') === '' && changes.join() === 'true,false');
  t.widths.set(b, 120);
  t.ro().fire(b);
  check('narrower: moving the new distance', b.getAttribute('data-marquee') === 'run' && prop(b, '--marquee-shift') === '-40px');
  const track = b.firstElementChild;
  m.refresh();
  check('refreshed with the same words: the same track, so the slide runs on', b.firstElementChild === track);
  b.textContent = words(30);
  m.refresh();
  check('new words: a new track (the slide starts over) and the new distance', b.firstElementChild !== track &&
    b.firstElementChild.className === 'ws-marquee__track' && prop(b, '--marquee-shift') === '-120px');
  check('the same box asked again is the same marquee', t.w.WSUI.marquee(b) === m && t.ro().els.size === 1);
  m.destroy();
});

scenario('it holds still off screen and while the tab is hidden, and goes on after', () => {
  const t = page();
  const b = t.box(words(20), 100);
  const m = t.w.WSUI.marquee(b);
  t.io().fire(b, false);
  check('off screen: held where it is (paused, not undone)', b.getAttribute('data-marquee') === 'held' && prop(b, '--marquee-shift') === '-60px');
  t.io().fire(b, true);
  check('back on screen: moving', b.getAttribute('data-marquee') === 'run');
  t.setHidden(true);
  check('the tab hidden: held', b.getAttribute('data-marquee') === 'held');
  t.setHidden(false);
  check('shown again: moving', b.getAttribute('data-marquee') === 'run');
  m.destroy();
});

scenario('reduced motion: nothing moves and the ellipsis stays; the setting is followed live', () => {
  const t = page({ reduced: true });
  const b = t.box(words(20), 100);
  const m = t.w.WSUI.marquee(b);
  check('cut off, but still: no mark and no slide', !b.hasAttribute('data-marquee') && prop(b, '--marquee-shift') === '' && prop(b, '--marquee-time') === '');
  check('the words are all there, once', b.textContent === words(20));
  t.setReduced(false);
  check('the setting turned off: it moves', b.getAttribute('data-marquee') === 'run');
  t.setReduced(true);
  check('and on again: still at once', !b.hasAttribute('data-marquee') && prop(b, '--marquee-ease') === '');
  m.destroy();
});

scenario('enable(false) holds it still; destroy() undoes it; the last one ends the observers and listeners', () => {
  const t = page();
  const a = t.box(words(20), 100);
  const b = t.box(words(30), 100);
  const ma = t.w.WSUI.marquee(a);
  const mb = t.w.WSUI.marquee(b);
  check('one observer of each kind for both', t.ros.length === 1 && t.ios.length === 1 && t.ro().els.size === 2);
  check('one visibility listener for both', t.docListeners.get('visibilitychange') === 1);
  check('one reduced-motion listener', t.motion.listeners.length === 1);
  ma.enable(false);
  check('disabled: still, with its ellipsis', !a.hasAttribute('data-marquee') && prop(a, '--marquee-shift') === '');
  ma.enable(true);
  check('enabled: moving again', a.getAttribute('data-marquee') === 'run');
  ma.destroy();
  check('destroyed: still, unwatched', !a.hasAttribute('data-marquee') && !t.ro().els.has(a) && !t.io().els.has(a));
  ma.destroy();
  ma.refresh();
  check('a second destroy, and a refresh after, do nothing', !a.hasAttribute('data-marquee') && t.ro().els.size === 1);
  check('the other runs on', b.getAttribute('data-marquee') === 'run');
  mb.destroy();
  check('the last gone: the observers end', !t.ros[0].live && !t.ios[0].live);
  check('and the listeners', t.docListeners.get('visibilitychange') === 0 && t.motion.listeners.length === 0);
  const c = t.box(words(20), 100);
  const mc = t.w.WSUI.marquee(c);
  check('a new one after that watches again', t.ros.length === 2 && t.ro().live && c.getAttribute('data-marquee') === 'run');
  mc.destroy();
});

scenario('a box off the page is still; on the page again, a resize starts it', () => {
  const t = page();
  const b = t.box(words(20), 100);
  const m = t.w.WSUI.marquee(b);
  b.remove();
  t.ro().fire(b);
  check('off the page: still', !b.hasAttribute('data-marquee'));
  t.d.body.appendChild(b);
  t.ro().fire(b);
  check('back: moving', b.getAttribute('data-marquee') === 'run');
  m.destroy();
});

scenario('a group keeps one beat: one slide time, each its own distance, all started together', () => {
  const t = page();
  const g = { group: 'lines' };
  const a = t.box(words(20), 100);           // 60px past
  const b = t.box(words(30), 100);           // 140px past: the furthest
  const fits = t.box(words(12), 100);
  const solo = t.box(words(20), 100);        // 60px past, in no group
  const ma = t.w.WSUI.marquee(a, g);
  const mb = t.w.WSUI.marquee(b, g);
  const mf = t.w.WSUI.marquee(fits, g);
  const ms = t.w.WSUI.marquee(solo);
  // 140px at 32 px/s is 4.375 s, rounded up to 5 s, plus a 1.75 s rest.
  check('both cut-off lines slide', a.getAttribute('data-marquee') === 'run' && b.getAttribute('data-marquee') === 'run');
  check('one slide time for the group, from the furthest, rounded up to a whole second', prop(a, '--marquee-time') === '6.750s' && prop(b, '--marquee-time') === '6.750s', [prop(a, '--marquee-time'), prop(b, '--marquee-time')]);
  check('the same rests and delay for both', prop(a, '--marquee-ease') === prop(b, '--marquee-ease') && prop(a, '--marquee-delay') === '0.875s' && prop(b, '--marquee-delay') === '0.875s');
  check('the rests are still 1.75 s at each end', prop(a, '--marquee-ease') === 'linear(0, 0 12.96%, 1 87.04%, 1)', prop(a, '--marquee-ease'));
  check('each covers its own distance in it', prop(a, '--marquee-shift') === '-60px' && prop(b, '--marquee-shift') === '-140px');
  check('the one that fits stays still', !fits.hasAttribute('data-marquee') && prop(fits, '--marquee-time') === '');
  check('both slides start at the page\'s zero: in step', t.startOf(a) === 0 && t.startOf(b) === 0);
  check('outside the group: its own time, its start left to the browser', prop(solo, '--marquee-time') === '3.625s' && t.startOf(solo) === undefined);

  // A pixel or two does not retime the group.
  t.widths.set(b, 101);
  t.ro().fire(b);
  check('139px past: the same whole-second beat', prop(a, '--marquee-time') === '6.750s' && prop(b, '--marquee-time') === '6.750s' && prop(b, '--marquee-shift') === '-139px');

  // Held off screen, it is left paused; back on screen it falls in step.
  t.io().fire(a, false);
  check('held: paused, not given a start (that would play it)', a.getAttribute('data-marquee') === 'held' && t.startOf(a) === null && t.playedHeld() === 0);
  t.widths.set(b, 102);
  t.ro().fire(b);
  t.setHidden(true);
  check('a resize or the tab hidden meanwhile: still nothing held is played', t.playedHeld() === 0 && t.startOf(a) === null && t.startOf(b) === null);
  t.setHidden(false);
  t.io().fire(a, true);
  check('back on screen: on the beat again', a.getAttribute('data-marquee') === 'run' && t.startOf(a) === 0);
  t.setHidden(true);
  t.setHidden(false);
  check('the tab hidden and shown: both back on the beat', t.startOf(a) === 0 && t.startOf(b) === 0);

  // A later, longer line: the group slows to its time; it starts in step.
  const late = t.box(words(40), 100);        // 220px past: 6.875 s, so 7 s
  const ml = t.w.WSUI.marquee(late, g);
  check('a later line falls in step at once', late.getAttribute('data-marquee') === 'run' && t.startOf(late) === 0);
  check('the group takes the new furthest one\'s time, all of it', [a, b, late].every((x) => prop(x, '--marquee-time') === '8.750s'), [a, b, late].map((x) => prop(x, '--marquee-time')));
  check('each still its own distance', prop(late, '--marquee-shift') === '-220px' && prop(a, '--marquee-shift') === '-60px');

  // New words: a new track, on the beat (not started over).
  const track = a.firstElementChild;
  a.textContent = words(24);
  ma.refresh();
  check('new words: a new track, started at the page\'s zero', a.firstElementChild !== track && t.startOf(a) === 0 && prop(a, '--marquee-shift') === '-92px');

  // The furthest gone: the rest go back to their own beat.
  ml.destroy();
  check('the furthest gone: the group\'s time shrinks back', [a, b].every((x) => prop(x, '--marquee-time') === '6.750s'), [a, b].map((x) => prop(x, '--marquee-time')));
  // One that stops fitting no longer sets the time.
  t.widths.set(b, 300);
  t.ro().fire(b);
  check('the furthest now fits: still, and the time is the last one\'s', !b.hasAttribute('data-marquee') && prop(a, '--marquee-time') === '4.750s', prop(a, '--marquee-time'));
  check('the solo box was never touched by the group', prop(solo, '--marquee-time') === '3.625s');
  [ma, mb, mf, ms].forEach((m) => m.destroy());
});

scenario('a group under reduced motion: nothing moves, nothing is timed', () => {
  const t = page({ reduced: true });
  const a = t.box(words(20), 100);
  const b = t.box(words(30), 100);
  const ms = [a, b].map((x) => t.w.WSUI.marquee(x, { group: 'lines' }));
  check('still, no timing', [a, b].every((x) => !x.hasAttribute('data-marquee') && prop(x, '--marquee-time') === '' && t.startOf(x) === undefined));
  t.setReduced(false);
  check('the setting turned off: both slide, in step', [a, b].every((x) => x.getAttribute('data-marquee') === 'run' && prop(x, '--marquee-time') === '6.750s' && t.startOf(x) === 0));
  ms.forEach((m) => m.destroy());
});

// ---- The placeholder (Books' search) ----

function searchPage(o) {
  const t = page(o);
  // The search as books.html writes it.
  const html = BOOKS_HTML.match(/<div class="relative min-w-0 flex-1">[\s\S]*?<\/div>/)[0];
  t.d.body.innerHTML = html + '<button id="elsewhere">x</button>';
  const input = t.d.getElementById('booksSearch');
  const overlay = t.d.getElementById('booksSearchMarquee');
  t.widths.set(overlay, o && o.width || 150);
  return Object.assign(t, { input, overlay });
}

scenario('books.html: the overlay sits over the input\'s text, unseen by screen readers and the pointer', () => {
  const t = searchPage();
  const c = t.overlay.className;
  check('hidden from screen readers (the input keeps its placeholder: read once)', t.overlay.getAttribute('aria-hidden') === 'true');
  check('the input\'s placeholder is still the input\'s', t.input.getAttribute('placeholder') === 'Title, author or narrator');
  check('the shared class', /\bws-marquee-ph\b/.test(c));
  check('over the input, not in the flow (nothing moves)', /\babsolute\b/.test(c) && /\binset-y-0\b/.test(c) && /\bpointer-events-none\b/.test(c));
  check('inset by the input\'s own padding (pl-12, pr-4)', /\bleft-12\b/.test(c) && /\bright-4\b/.test(c) && /\bpl-12\b/.test(t.input.className) && /\bpr-4\b/.test(t.input.className));
  check('the input\'s type and placeholder colour', /\btext-\[17px\]/.test(c) && /\btext-\[17px\]/.test(t.input.className) &&
    /\btext-frosted-blue\/70\b/.test(c) && /\bplaceholder:text-frosted-blue\/70\b/.test(t.input.className));
  check('one line, clipped, centred in the input\'s 48px', /\boverflow-hidden\b/.test(c) && /\bwhitespace-nowrap\b/.test(c) && /\bleading-\[3rem\]/.test(c) && /\bh-12\b/.test(t.input.className));
});

scenario('the placeholder slides while the search is empty and unfocused, and stops for focus or text', () => {
  const t = searchPage();
  const ctl = new t.w.AbortController();
  t.w.WSUI.marqueePlaceholder(t.input, t.overlay, ctl.signal);
  check('the overlay carries the placeholder\'s words', t.overlay.textContent === 'Title, author or narrator');
  check('cut off: it slides, and the input\'s own placeholder steps aside', t.overlay.getAttribute('data-marquee') === 'run' && t.input.hasAttribute('data-marquee-ph'));
  t.input.focus();
  check('focused: still, the input\'s own placeholder back', !t.overlay.hasAttribute('data-marquee') && !t.input.hasAttribute('data-marquee-ph'));
  t.input.blur();
  check('left empty: it slides again', t.overlay.getAttribute('data-marquee') === 'run' && t.input.hasAttribute('data-marquee-ph'));
  t.input.focus();
  t.input.value = 'dune';
  t.input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  t.input.blur();
  check('with text, even unfocused: still', !t.overlay.hasAttribute('data-marquee') && !t.input.hasAttribute('data-marquee-ph'));
  t.input.value = '';
  t.input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  check('emptied without the focus: slides', t.overlay.getAttribute('data-marquee') === 'run');
  ctl.abort();
  check('the visit ended: still, the input as it was, unwatched', !t.overlay.hasAttribute('data-marquee') && !t.input.hasAttribute('data-marquee-ph') && t.ro().els.size === 0 && !t.ro().live);
  t.input.focus();
  t.input.blur();
  check('and its listeners are gone', !t.overlay.hasAttribute('data-marquee'));
});

scenario('a placeholder that fits never shows the overlay', () => {
  const t = searchPage({ width: 400 });
  const ctl = new t.w.AbortController();
  t.w.WSUI.marqueePlaceholder(t.input, t.overlay, ctl.signal);
  check('not cut off: the input\'s own placeholder, no overlay', !t.overlay.hasAttribute('data-marquee') && !t.input.hasAttribute('data-marquee-ph'));
  ctl.abort();
});

scenario('reduced motion: the placeholder is shown as it is, cut off', () => {
  const t = searchPage({ reduced: true });
  const ctl = new t.w.AbortController();
  t.w.WSUI.marqueePlaceholder(t.input, t.overlay, ctl.signal);
  check('no overlay, the input\'s own placeholder', !t.overlay.hasAttribute('data-marquee') && !t.input.hasAttribute('data-marquee-ph'));
  ctl.abort();
});

// ---- theme.css ----

scenario('theme.css: the rules the marks drive', () => {
  const block = THEME.slice(THEME.indexOf('/* ---- Marquee'));
  const rule = (sel) => { const i = block.indexOf(sel + ' {'); return i === -1 ? '' : block.slice(i, block.indexOf('}', i)); };
  check('sliding, the words are clipped, not ellipsed', /text-overflow:\s*clip/.test(rule('[data-marquee]')));
  const track = rule('[data-marquee] > .ws-marquee__track');
  check('the track is one unbroken line that can move', /display:\s*inline-block/.test(track) && /white-space:\s*nowrap/.test(track));
  check('the slide: the box\'s timing, there and back for ever', /animation:\s*ws-marquee var\(--marquee-time[^;]*var\(--marquee-ease[^;]*var\(--marquee-delay[^;]*infinite alternate both/.test(track), track);
  check('held: paused where it is', /animation-play-state:\s*paused/.test(rule('[data-marquee="held"] > .ws-marquee__track')));
  check('the keyframe moves by the measured distance only', /@keyframes ws-marquee \{ to \{ transform: translateX\(var\(--marquee-shift/.test(block));
  check('reduced motion: no animation, whatever the marks', /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-marquee\] > \.ws-marquee__track \{ animation: none; \}/.test(block));
  check('the overlay is seen only while it slides', /\.ws-marquee-ph \{ visibility: hidden; \}/.test(block) && /\.ws-marquee-ph\[data-marquee\] \{ visibility: visible; \}/.test(block));
  check('meanwhile the input\'s own placeholder is transparent', /input\[data-marquee-ph\]::placeholder \{ color: transparent; \}/.test(block));
  check('after the event log\'s ellipsis, so the clip wins', THEME.indexOf('.ws-wheel__title {') !== -1 && THEME.indexOf('.ws-wheel__title {') < THEME.indexOf('[data-marquee] { text-overflow: clip; }'));
});

console.log(`${total - failed}/${total} checks passed` + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
