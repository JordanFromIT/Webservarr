// One focus colour site-wide (theme.css --ws-focus, Tailwind "focus"), at
// least 3:1 against what it is drawn on:
//  * the token is the text colour, and the shipped palette's text colour is
//    over 3:1 on the page and on the frost over the page (the icy tint, no
//    floor), where the primary blue it replaced was 2.8:1 (appearance.js's
//    own WCAG maths). Over very bright art the floorless frost gives the ring
//    up (about 1.1:1 over white), the trade the owner chose; that is pinned
//    below so a change to it is noticed;
//  * every :focus-visible outline in theme.css and the pages' own <style>
//    blocks, and the fields' focus ring, use the token;
//  * no markup or script asks for a focus outline, ring or border in any
//    other colour, and WSUI's buttons and field (ui.js, run in happy-dom)
//    carry the token's classes.
//
// Run: node app/tests/js/focus_ring.mjs (npm run test:js; CI js-checks).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const THEME = readFileSync(join(STATIC, 'css/theme.css'), 'utf8');
const UI = readFileSync(join(STATIC, 'js/ui.js'), 'utf8');
const TAILWIND = readFileSync(join(here, '../../../tailwind.config.js'), 'utf8');
const appearance = readFileSync(join(STATIC, 'js/settings/appearance.js'), 'utf8');
const start = appearance.indexOf('  // ---- Contrast (WCAG 2) ----');
const end = appearance.indexOf('  // ---- end contrast ----');
const { contrast, tint } = new Function(appearance.slice(start, end) + '\nreturn { contrast: contrast, tint: tint };')();

let failed = 0;
let total = 0;
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${what}` + (info === undefined ? '' : ` (${JSON.stringify(info)})`));
  }
}

// ---- The token and its contrast ----
const root = THEME.slice(THEME.indexOf(':where(:root) {'), THEME.indexOf('}', THEME.indexOf(':where(:root) {')));
const hex = (name) => (root.match(new RegExp('--hex-' + name + ': (#[0-9A-Fa-f]{6});')) || [])[1];
check('the token is the text colour', /--ws-focus: var\(--color-text\);/.test(root), root.slice(-400));
check('Tailwind\'s "focus" colour is the token', /"focus": "rgb\(var\(--ws-focus\) \/ <alpha-value>\)"/.test(TAILWIND));
const text = hex('text');
const page = hex('background');
const primary = hex('primary');
const secondary = hex('secondary');
// The frost (theme.css .ws-frost): the icy tint, the secondary mixed 30%
// toward the text colour, at 30%, over what is behind, with no floor.
const floor = (THEME.match(/--ws-frost-floor: ([\d.]+);/) || [])[1];
const icy = tint(text, secondary, 0.3);
const frost = tint(icy, tint(page, page, +floor), 0.3);
const frostOverWhite = tint(icy, tint(page, '#FFFFFF', +floor), 0.3);
const onPage = contrast(text, page);
const onFrost = contrast(text, frost);
check('the frost has no floor', floor === '0', floor);
check('the ring is over 3:1 on the page', onPage >= 3, onPage);
check('and over 3:1 on the frost over the page', onFrost >= 3, [frost, onFrost]);
check('(the primary blue it replaced was under 3:1 on the page)', contrast(primary, page) < 3, contrast(primary, page));
check('over white the floorless frost gives the ring up (the chosen trade)', contrast(text, frostOverWhite) < 1.2,
  [frostOverWhite, contrast(text, frostOverWhite)]);

// ---- Every focus rule uses it ----
const rules = THEME.split('\n').filter((l) => /:focus(-visible)?\b[^{]*\{[^}]*outline: 2px solid/.test(l));
check('theme.css: every one-line :focus-visible outline is the token', rules.length > 15 && rules.every((l) => /outline: 2px solid rgb\(var\(--ws-focus\)\)/.test(l)),
  rules.filter((l) => !/--ws-focus/.test(l)));
check('theme.css: the one shared ring is the token',
  /:where\(a\[href\], button, summary, \[role="button"\], \[tabindex\]:not\(\[tabindex="-1"\]\)\):focus-visible \{\s*outline: 2px solid rgb\(var\(--ws-focus\)\);/.test(THEME));
check('theme.css: a focused field\'s ring and border are the token',
  /input:focus, textarea:focus, select:focus \{\s*--tw-ring-color: rgb\(var\(--ws-focus\)\);[^}]*border-color: rgb\(var\(--ws-focus\)\);/.test(THEME));

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'css' && name !== 'vendor') files(p, out); }
    else if (/\.(html|js)$/.test(name)) out.push(p);
  }
  return out;
}
const sources = files(STATIC).concat([join(here, '../../pages.py')]);
const off = [];
for (const p of sources) {
  const s = readFileSync(p, 'utf8');
  const bad = s.match(/\b(?:peer-)?focus(?:-visible|-within)?:(?:outline|ring|border)-(?!none\b|offset|0\b|2\b|transparent\b|focus\b)[a-z][\w-]*(?:\/\d+)?/g) || [];
  bad.forEach((b) => off.push(p.slice(STATIC.length) + ' ' + b));
  const styled = s.match(/:focus-visible[^{]*\{[^}]*outline:[^;}]*rgb\(var\(--(?!ws-focus)[\w-]+\)/g) || [];
  styled.forEach((b) => off.push(p.slice(STATIC.length) + ' ' + b));
}
// Bare widths and styles (outline-2, ring-2, ring-offset-2, border-transparent) are not colours.
const colours = off.filter((o) => !/:(?:outline|ring|border)-(?:\d|offset-\d|\[|dashed|dotted|solid|double)/.test(o) && !/ring-offset-background-dark$/.test(o));
check('no focus outline, ring or border in another colour anywhere', colours.length === 0, colours);

// ---- WSUI's buttons and field, as ui.js builds them ----
const w = new Window({ url: 'https://dev.example.test/' });
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
w.eval(UI);
const cls = w.WSUI.cls;
for (const name of ['btnPrimary', 'btnGhost', 'btnQuiet', 'btnDanger']) {
  check(`WSUI.cls.${name}: the token's ring`, /\bfocus-visible:outline-focus\b/.test(cls[name]) && !/outline-primary/.test(cls[name]), cls[name]);
}
check('WSUI.cls.input: the token\'s ring', /\bfocus:ring-focus\b/.test(cls.input) && !/ring-primary/.test(cls.input), cls.input);
await w.happyDOM.abort();
w.close();

console.log(`${total - failed}/${total} focus ring checks pass`);
if (failed) process.exit(1);
