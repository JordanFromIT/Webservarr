// The shared toast (ui.js WSUI.toast), run for real in happy-dom on a fake
// clock, and its placement and motion in theme.css:
//  * one polite live region (#wsToasts, .ws-toasts) made on first use, the
//    first toast a beat after it; an error toast is itself an alert.
//  * every toast is .ws-toast on the one frost (.ws-frost); it stays 4 s
//    (6 s an error, 4 s more with a button), then takes .is-leaving and is
//    gone once the leave has run (ui.js TOAST_OUT_MS, theme.css 200ms).
//  * under the pointer or holding the focus it stays, and leaves 2 s after.
//  * several stack downward, the newest last; past three the oldest leaves.
//  * the action button (Undo, Retry) closes it and runs; remove() is at once.
//  * a soft navigation that drops the region from the body gets a new one.
//  * theme.css: top right 8px under the 64px header on a wide screen, the
//    account name's 32px gutter, sliding in from the right; under the phone
//    top bar with 16px gutters, dropping down; the top of the screen with
//    the shell hidden; a fade only with reduced motion.
//
// Run: node app/tests/js/toast.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const UI = readFileSync(join(STATIC, 'js/ui.js'), 'utf8');
const THEME = readFileSync(join(STATIC, 'css/theme.css'), 'utf8');

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

/* A page with ui.js loaded, on a clock the test moves by hand. */
function page() {
  const w = new Window({ url: 'https://dev.example.test/', width: 1440, height: 900 });
  let now = 0;
  let seq = 0;
  const timers = new Map();
  w.setTimeout = (fn, ms) => { seq += 1; timers.set(seq, { at: now + (ms || 0), fn }); return seq; };
  w.clearTimeout = (id) => { timers.delete(id); };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const tick = (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  w.eval(UI);
  const d = w.document;
  const box = () => d.getElementById('wsToasts');
  const toasts = () => (box() ? Array.from(box().children) : []);
  return { w, d, tick, box, toasts };
}

scenario('the region and the first toast', () => {
  const { w, tick, box, toasts } = page();
  w.WSUI.toast('Requested.', 'ok');
  check('the region exists at once', !!box());
  check('it is the shared placement class, not page utilities', box().className === 'ws-toasts', box().className);
  check('a polite live region', box().getAttribute('aria-live') === 'polite');
  check('the first toast waits a beat after its region', toasts().length === 0);
  tick(50);
  const t = toasts()[0];
  check('then it is in', !!t && t.textContent === 'Requested.');
  const cls = t.className.split(/\s+/);
  check('a .ws-toast on the one frost', cls.includes('ws-toast') && cls.includes('ws-frost'), t.className);
  check('no colour, blur or shadow of its own', !cls.some((c) => /^(bg-|backdrop-|shadow-)/.test(c)), t.className);
  check('no width of its own (the region sets it)', !cls.some((c) => /^(max-w-|w-)/.test(c)), t.className);
  check('a success is not an alert', !t.hasAttribute('role'));
  w.WSUI.toast('Could not request it.', 'err');
  const e = toasts()[1];
  check('a second toast lands at once, below the first', !!e && e.textContent === 'Could not request it.');
  check('an error is an alert', e.getAttribute('role') === 'alert');
});

scenario('it stays, slides out, and goes', () => {
  const { w, tick, toasts } = page();
  w.WSUI.toast('Saved.', 'ok');
  tick(50);
  tick(3900);
  check('still settled just before 4 s', toasts().length === 1 && !toasts()[0].classList.contains('is-leaving'));
  tick(50);
  check('at 4 s from the call it starts to leave', toasts()[0] && toasts()[0].classList.contains('is-leaving'));
  tick(199);
  check('it stays while the leave runs', toasts().length === 1);
  tick(1);
  check('then it is gone', toasts().length === 0);
});

scenario('an error and a toast with a button stay longer', () => {
  const { w, tick, toasts } = page();
  w.WSUI.toast('First', 'ok');
  tick(50);
  w.WSUI.toast('Broke', 'err');
  w.WSUI.toast('Removed from Continue.', 'ok', { action: { label: 'Undo', run() {} } });
  tick(4000);
  const left = toasts().map((t) => t.textContent);
  check('the error and the Undo toast outlast a plain one', left.includes('Broke') && left.includes('Removed from Continue.Undo'), left);
  tick(2200);
  check('the error leaves at 6 s', !toasts().some((t) => t.textContent === 'Broke'));
  check('the Undo toast is still up', toasts().some((t) => t.textContent.startsWith('Removed')));
  tick(2000);
  check('the Undo toast leaves at 8 s', toasts().length === 0);
});

scenario('the action closes it and runs', () => {
  const { w, d, tick, toasts } = page();
  let ran = 0;
  w.WSUI.toast('Removed from Continue.', 'ok', { action: { label: 'Undo', run() { ran += 1; } } });
  tick(50);
  const btn = toasts()[0].querySelector('button');
  check('one real button, named by its label', !!btn && btn.type === 'button' && btn.textContent === 'Undo');
  btn.click();
  check('pressed: gone at once, and it ran', toasts().length === 0 && ran === 1);
  check('nothing focusable is left behind', !d.querySelector('#wsToasts button'));
});

scenario('under the pointer or the focus it stays', () => {
  const { w, tick, toasts } = page();
  w.WSUI.toast('Removed from Continue.', 'ok', { action: { label: 'Undo', run() {} } });
  tick(50);
  const t = toasts()[0];
  t.dispatchEvent(new w.Event('mouseenter'));
  tick(20000);
  check('hovered, it does not leave', toasts().length === 1 && !t.classList.contains('is-leaving'));
  t.dispatchEvent(new w.Event('mouseleave'));
  tick(1999);
  check('let go, it waits 2 s', !t.classList.contains('is-leaving'));
  tick(1);
  check('then leaves', t.classList.contains('is-leaving'));
  tick(200);

  w.WSUI.toast('Removed from Continue.', 'ok', { action: { label: 'Undo', run() {} } });
  const u = toasts()[0];
  u.querySelector('button').focus();
  u.dispatchEvent(new w.FocusEvent('focusin', { bubbles: true }));
  tick(20000);
  check('focused, it does not leave', toasts().length === 1 && !u.classList.contains('is-leaving'));
  u.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  tick(2000);
  check('focus gone, it leaves 2 s later', u.classList.contains('is-leaving'));
});

scenario('a burst keeps three on screen', () => {
  const { w, tick, toasts } = page();
  w.WSUI.toast('One', 'ok');
  tick(50);
  w.WSUI.toast('Two', 'ok');
  w.WSUI.toast('Three', 'ok');
  check('three stack, newest last', toasts().map((t) => t.textContent).join() === 'One,Two,Three');
  w.WSUI.toast('Four', 'ok');
  check('a fourth sends the oldest out', toasts()[0].classList.contains('is-leaving') && toasts()[3].textContent === 'Four');
  w.WSUI.toast('Five', 'ok');
  const leaving = toasts().filter((t) => t.classList.contains('is-leaving')).map((t) => t.textContent);
  check('a fifth during that leave sends the next oldest', leaving.join() === 'One,Two', leaving);
  tick(200);
  check('three remain', toasts().map((t) => t.textContent).join() === 'Three,Four,Five');
});

scenario('remove() takes it down at once', () => {
  const { w, tick, toasts } = page();
  const h = w.WSUI.toast('Retrying', 'info', { action: { label: 'Retry', run() {} } });
  tick(50);
  h.remove();
  check('gone', toasts().length === 0);
  const g = w.WSUI.toast('Quick', 'info');
  g.remove();
  tick(5000);
  check('removed before it arrived, it never does', toasts().length === 0);
});

scenario('a region dropped by a page swap is made again', () => {
  const { w, d, tick, box, toasts } = page();
  w.WSUI.toast('One', 'ok');
  tick(50);
  box().remove();
  w.WSUI.toast('After the swap', 'ok');
  check('a new region in the body', !!box() && box().parentNode === d.body);
  tick(50);
  check('the toast shows in it', toasts().length === 1 && toasts()[0].textContent === 'After the swap');
  w.WSUI.toast('Two', 'ok');
  w.WSUI.toast('Three', 'ok');
  check('the old region\'s toasts do not count towards three', toasts().every((t) => !t.classList.contains('is-leaving')));
});

// ---- theme.css ----
const rule = (sel, from = THEME) => {
  const at = from.indexOf(sel + ' {');
  return at < 0 ? '' : from.slice(at, from.indexOf('}', at));
};
const media = (q) => {
  const out = [];
  let at = THEME.indexOf('@media ' + q + ' {');
  while (at >= 0) {
    let depth = 0; let i = THEME.indexOf('{', at);
    for (; i < THEME.length; i += 1) {
      if (THEME[i] === '{') depth += 1;
      else if (THEME[i] === '}') { depth -= 1; if (!depth) break; }
    }
    out.push(THEME.slice(at, i + 1));
    at = THEME.indexOf('@media ' + q + ' {', i);
  }
  return out.find((m) => m.includes('.ws-toast')) || '';
};

scenario('placement and motion', () => {
  const base = rule('\n.ws-toasts');
  check('fixed, above the page, never catching clicks between toasts',
    /position: fixed/.test(base) && /z-index: 90/.test(base) && /pointer-events: none/.test(base), base);
  check('phone: 8px under the 56px top bar and its safe area',
    /inset-block-start: calc\(3\.5rem \+ 1px \+ env\(safe-area-inset-top\) \+ 8px\)/.test(base), base);
  check('phone: 16px gutters', /inset-inline: 16px/.test(base), base);
  check('a column, 8px apart, newest last', /flex-direction: column/.test(base) && /gap: 8px/.test(base), base);
  check('never placed against the bottom (the player and tab bars)', !/inset-block-end|bottom:/.test(base), base);
  const wide = media('(min-width: 1024px)');
  check('desktop: 8px under the 64px header', /\.ws-toasts \{[^}]*inset-block-start: calc\(4rem \+ 8px\)/.test(wide), wide);
  check('desktop: on the account name\'s 32px gutter, at the right', /inset-inline: auto 32px/.test(wide), wide);
  check('desktop: slides in from the right', /\.ws-toast \{ animation-name: ws-toast-in; \}/.test(wide) &&
    /@keyframes ws-toast-in \{ from \{ opacity: 0; transform: translateX\(calc\(100% \+ 32px\)\); \} \}/.test(THEME));
  check('desktop: leaves the way it came', /\.ws-toast\.is-leaving \{ animation-name: ws-toast-out; \}/.test(wide) &&
    /@keyframes ws-toast-out \{ to \{ opacity: 0; transform: translateX\(calc\(100% \+ 32px\)\); \} \}/.test(THEME));
  check('phone: drops down into place', /\n\.ws-toast \{ animation: ws-toast-drop 320ms/.test(THEME) &&
    /@keyframes ws-toast-drop \{ from \{ opacity: 0; transform: translateY\(-16px\); \} \}/.test(THEME));
  const leave = THEME.match(/\n\.ws-toast\.is-leaving \{[^}]*animation: ws-toast-lift (\d+)ms/);
  const out = UI.match(/TOAST_OUT_MS = (\d+);/);
  check('ui.js waits the leave out exactly', leave && out && leave[1] === out[1], [leave && leave[1], out && out[1]]);
  check('the shell hidden: the top of the screen',
    /html\[data-shell="hidden"\] \.ws-toasts \{ inset-block-start: calc\(env\(safe-area-inset-top\) \+ 16px\); \}/.test(THEME));
  const reduced = media('(prefers-reduced-motion: reduce)');
  check('reduced motion: a fade in and a fade out, nothing moves',
    /\.ws-toast \{ animation-name: ws-toast-fade-in;/.test(reduced) && /\.ws-toast\.is-leaving \{ animation-name: ws-toast-fade-out; \}/.test(reduced) &&
    /@keyframes ws-toast-fade-in \{ from \{ opacity: 0; \} \}/.test(THEME) && /@keyframes ws-toast-fade-out \{ to \{ opacity: 0; \} \}/.test(THEME), reduced);
  check('the reduced-motion rules come after the wide ones, so they win',
    THEME.indexOf(reduced) > THEME.indexOf(wide));
});

console.log(`toast: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
