/**
 * Stamp app.css with a hash of every file Tailwind scanned to build it.
 *
 * Tailwind only emits the classes it saw, so markup shipped without a rebuild
 * silently loses styling. app/tests/test_css_build.py recomputes this hash
 * with the same algorithm and fails when the committed CSS is stale.
 *
 * Algorithm (keep in step with the test): for each content file, sorted by
 * its POSIX path relative to the repo root (code-point order), feed
 * "<path>\n", the file bytes, then "\n" into SHA-256; take 16 hex chars.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

// Mirrors CONTENT_GLOBS in app/tests/test_css_build.py.
const GLOBS = [
  ["app/static", /\.html$/],
  ["app/static/partials", /\.html$/],
  ["app/static/js", /\.js$/],
  ["app/static/js/settings", /\.js$/],
  ["app", /^pages\.py$/],
  ["app/static/css", /^tailwind\.src\.css$/],
];

const rel = (p) => relative(ROOT, p).split(sep).join("/");
const files = new Set();
for (const [dir, re] of GLOBS) {
  let names = [];
  try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
  for (const n of names) {
    const p = join(ROOT, dir, n);
    if (re.test(n) && statSync(p).isFile()) files.add(p);
  }
}
const sorted = [...files].sort((a, b) => (rel(a) < rel(b) ? -1 : rel(a) > rel(b) ? 1 : 0));

const h = createHash("sha256");
for (const p of sorted) {
  h.update(rel(p) + "\n");
  h.update(readFileSync(p));
  h.update("\n");
}
const hash = h.digest("hex").slice(0, 16);

const out = join(ROOT, "app/static/css/app.css");
const body = readFileSync(out, "utf8").replace(/^\/\* ws-css:[0-9a-f]{16} \*\/\n/, "");
writeFileSync(out, `/* ws-css:${hash} */\n` + body);
console.log(`stamped app.css with ws-css:${hash} (${sorted.length} content files)`);
