// The Appearance tab's contrast maths (appearance.js) against the WCAG 2
// ratios in app/tests/contrast_vectors.json, which the Python suite computes
// with its own reference (test_theme_engine.ContrastGuard). Runs the
// functions as they are in appearance.js, not a copy.
// Run: node app/tests/js/contrast.mjs (CI job js-checks; npm run test:js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../static/js/settings/appearance.js'), 'utf8');
const start = src.indexOf('  // ---- Contrast (WCAG 2) ----');
const end = src.indexOf('  // ---- end contrast ----');
if (start < 0 || end < 0) throw new Error('the contrast block was not found in appearance.js');
const { contrast, tint } = new Function(src.slice(start, end) + '\nreturn { contrast: contrast, tint: tint };')();

const { cases, tints } = JSON.parse(readFileSync(join(here, '../contrast_vectors.json'), 'utf8'));
let failed = 0;
const near = (a, b) => Math.abs(a - b) < 0.001;
for (const c of cases) {
  const got = contrast(c.fg, c.bg);
  if (!near(got, c.ratio)) { failed += 1; console.error(`FAIL ${c.why}: contrast(${c.fg}, ${c.bg}) = ${got}, want ${c.ratio}`); }
}
for (const t of tints) {
  const mixed = tint(t.fg, t.bg, t.alpha);
  const got = contrast(t.fg, mixed);
  if (mixed.toUpperCase() !== t.tint || !near(got, t.ratio)) {
    failed += 1;
    console.error(`FAIL tint(${t.fg}, ${t.bg}, ${t.alpha}) = ${mixed} (${got}), want ${t.tint} (${t.ratio})`);
  }
}
if (cases.length < 15 || tints.length < 4) { console.error('FAIL the shared cases are missing'); failed += 1; }
const total = cases.length + tints.length;
console.log(`${total - failed}/${total} contrast cases agree with the Python reference`);
process.exit(failed ? 1 : 0);
