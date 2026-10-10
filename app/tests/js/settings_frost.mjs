// Settings > Appearance > Frosted glass: the seven sliders (tint, blur,
// highlight, sheen, grain, shadow depth, saturation boost), run for real in
// happy-dom (a dev-only dependency) over Settings' own markup (settings.html),
// the real kit and appearance.js, with a scripted server. Then theme-loader.js
// applying a payload after a save, with its bounds.
//
// Covers: each slider starts at the saved value with its number beside it
// and its Reset off at the default; dragging writes the custom property on
// <html> at once (the live preview), stages the setting and shows the save
// bar; Discard puts the saved value back, on the slider and on <html>; a
// slider's Reset stages its default; "Reset frosted glass to default" stages
// every default; Save sends whole numbers; theme-loader.js writes each
// strength as hundredths and ignores anything out of bounds or fractional.
//
// Run: node app/tests/js/settings_frost.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const SETTINGS_HTML = readFileSync(join(STATIC, 'settings.html'), 'utf8');
const SRC = {};
for (const f of ['ui.js', 'settings/kit.js', 'settings/appearance.js', 'theme-loader.js']) {
  SRC[f] = readFileSync(join(STATIC, 'js', f), 'utf8');
}

let failed = 0;
let total = 0;
let current = '';
function check(what, ok, info) {
  total += 1;
  if (!ok) {
    failed += 1;
    process.stderr.write(`FAIL ${current}: ${what}` + (info === undefined ? "" : ` (${JSON.stringify(info)})`) + "\n");
  }
}
const flush = async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setImmediate(r)); };

// The registry rows (app/settings_registry.py), as the settings view sends them.
const FROST = {
  'theme.frost_tint': { def: '25', max: 60, cssVar: '--ws-frost-tint-a' },
  'theme.frost_blur': { def: '15', max: 64, cssVar: '--ws-frost-blur' },
  'theme.frost_highlight': { def: '100', max: 200, cssVar: '--ws-frost-hl' },
  'theme.frost_sheen': { def: '0', max: 30, cssVar: '--ws-frost-sheen' },
  'theme.frost_grain': { def: '0', max: 15, cssVar: '--ws-frost-grain' },
  'theme.frost_depth': { def: '100', max: 200, cssVar: '--ws-frost-depth' },
  'theme.frost_saturation': { def: '100', max: 200, cssVar: '--ws-frost-sat' }
};
const COLOURS = ['primary', 'secondary', 'accent', 'text', 'text_secondary', 'background', 'media_movie', 'media_tv',
  'media_book', 'new_flag', 'status_ok', 'status_warn', 'status_err', 'gauge_cpu', 'gauge_ram', 'gauge_net'];
const HEX = { text: '#BEEEF4', background: '#000000', text_secondary: '#FFFFFF' };

function registry(values) {
  const meta = {};
  for (const [k, f] of Object.entries(FROST)) meta[k] = { type: 'int', default: f.def, min: 0, max: f.max, public: true };
  for (const c of COLOURS) meta['theme.color_' + c] = { type: 'color', default: HEX[c] || '#125793', public: true };
  meta['theme.gauges_colourful'] = { type: 'bool', default: 'false', public: true };
  meta['theme.font'] = { type: 'text', default: 'Spline Sans', pattern: '[A-Za-z0-9 \\-]{1,60}', max_length: 60, public: true };
  meta['theme.custom_css'] = { type: 'text', default: '', max_length: 20000, public: true };
  return { values, meta, mask: '••••••••', page_order: [], page_addresses: {}, address_credentials: {} };
}

async function visit(saved = {}) {
  const win = new Window({ url: 'https://ws.test/settings#appearance' });
  const doc = win.document;
  doc.body.innerHTML = SETTINGS_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
  const values = {};
  for (const [k, f] of Object.entries(FROST)) values[k] = f.def;
  for (const c of COLOURS) values['theme.color_' + c] = HEX[c] || '#125793';
  Object.assign(values, { 'theme.gauges_colourful': 'false', 'theme.font': 'Spline Sans', 'theme.custom_css': '' }, saved);
  const calls = [];
  const fetchStub = (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init.body });
    const u = new URL(url, 'https://ws.test');
    const reply = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)) });
    if (u.pathname === '/api/admin/settings' && u.search.includes('view=registry')) return reply(200, registry(values));
    if (u.pathname === '/api/admin/settings/bulk' && method === 'PUT') {
      const written = {};
      for (const it of JSON.parse(init.body).settings) { values[it.key] = it.value; written[it.key] = it.value; }
      return reply(200, { values: written });
    }
    if (u.pathname === '/api/admin/settings/shell') return reply(503, {});
    return reply(404, {});
  };
  const g = globalThis;
  const prior = {};
  const set = (k, v) => { prior[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win);
  set('document', doc);
  set('location', win.location);
  set('localStorage', win.localStorage);
  set('fetch', fetchStub);
  if (!process.env.DEBUG_TEST) set('console', { error() {}, warn() {}, log() {}, info() {}, debug() {} });
  set('ResizeObserver', class { observe() {} disconnect() {} });
  set('CustomEvent', win.CustomEvent);
  set('Event', win.Event);
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const run = (name) => new Function('window', 'document', 'localStorage', 'location', 'WSUI', 'WSSettings', 'fetch', SRC[name])(
    win, doc, win.localStorage, win.location, win.WSUI, win.WSSettings, fetchStub);
  run('ui.js');
  run('settings/kit.js');
  run('settings/appearance.js');
  const ctl = new win.AbortController();
  const ctx = { signal: ctl.signal, url: new URL('https://ws.test/settings#appearance'), setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (id) => win.clearTimeout(id), poll() { return () => {}; }, beforeLeave() {}, onNavigate() {} };
  win.WSSettings.init(ctx);
  await flush();
  const root = doc.documentElement;
  const t = {
    win, doc, calls, values, root,
    range: (key) => doc.getElementById('ws-f-' + key.replace(/[._]/g, '-')),
    row: (key) => t.range(key).closest('.min-w-0'),
    prop: (name) => root.style.getPropertyValue(name),
    async drag(key, v) { const r = t.range(key); r.value = String(v); r.dispatchEvent(new win.Event('input', { bubbles: true })); await flush(); },
    async press(node) { node.click(); await flush(); },
    button: (text) => Array.from(doc.querySelectorAll('button')).find((b) => b.textContent.trim().endsWith(text)),
    done() { ctl.abort(); for (const k of Object.keys(prior)) { if (prior[k]) Object.defineProperty(g, k, prior[k]); else delete g[k]; } }
  };
  return t;
}

async function scenario(name, fn) {
  current = name;
  let t = null;
  try { t = await visit(fn.saved); await fn(t); } catch (e) { failed += 1; total += 1; process.stderr.write(`FAIL ${name}: threw ${e && e.stack || e}`); } finally { if (t) t.done(); }
}
const S = (saved, fn) => Object.assign(fn, { saved });

await scenario('the sliders at the saved values', S({ 'theme.frost_tint': '40' }, async (t) => {
  const order = Array.from(t.doc.querySelectorAll('[data-settings-panel="appearance"] input.wsp-range')).map((r) => r.id);
  check('seven sliders in the card order', order.join() === ['tint', 'blur', 'highlight', 'sheen', 'grain', 'depth', 'saturation']
    .map((k) => 'ws-f-theme-frost-' + k).join(), order);
  check('tint at the saved 40, shown as .40', t.range('theme.frost_tint').value === '40' && /\.40/.test(t.row('theme.frost_tint').textContent));
  check('blur at 15 px, bounded 0 to 64', t.range('theme.frost_blur').value === '15' && t.range('theme.frost_blur').max === '64' && /15 px/.test(t.row('theme.frost_blur').textContent));
  check('depth reads 100%', /100%/.test(t.row('theme.frost_depth').textContent));
  check('sheen reads 0 and says so', t.range('theme.frost_sheen').getAttribute('aria-valuetext') === 'No sheen');
  check('each slider is labelled', Object.keys(FROST).every((k) => t.doc.querySelector(`label[for="${t.range(k).id}"]`)));
  const resetOf = (k) => t.row(k).querySelector('button');
  check('a slider at its default has its Reset off', resetOf('theme.frost_blur').disabled === true);
  check('a slider off its default has its Reset on', resetOf('theme.frost_tint').disabled === false);
  check('Reset says what it resets', resetOf('theme.frost_tint').getAttribute('aria-label') === 'Reset tint to default');
  check('the saved values are on <html>', t.prop('--ws-frost-tint-a') === '0.4' && t.prop('--ws-frost-blur') === 'blur(15px)');
}));

await scenario('dragging previews live, Discard puts it back', S({}, async (t) => {
  await t.drag('theme.frost_depth', 150);
  check('the depth is on <html> at once', t.prop('--ws-frost-depth') === '1.5', t.prop('--ws-frost-depth'));
  check('and shown beside the slider', /150%/.test(t.row('theme.frost_depth').textContent));
  await t.drag('theme.frost_grain', 6);
  check('the grain is on <html> as an opacity', t.prop('--ws-frost-grain') === '0.06');
  await t.drag('theme.frost_blur', 40);
  check('the blur is on <html>', t.prop('--ws-frost-blur') === 'blur(40px)');
  const discard = t.button('Discard');
  check('the save bar offers Discard', !!discard);
  await t.press(discard);
  check('Discard puts the saved depth back on <html>', t.prop('--ws-frost-depth') === '1', t.prop('--ws-frost-depth'));
  check('and the grain', t.prop('--ws-frost-grain') === '0');
  check('and the blur', t.prop('--ws-frost-blur') === 'blur(15px)');
  check('and on the sliders', t.range('theme.frost_depth').value === '100' && t.range('theme.frost_blur').value === '15');
  check('nothing was saved', !t.calls.some((c) => c.method === 'PUT'));
}));

await scenario('a slider\'s Reset and the card\'s reset stage the defaults', S({ 'theme.frost_tint': '40', 'theme.frost_sheen': '12', 'theme.frost_saturation': '180' }, async (t) => {
  await t.press(t.row('theme.frost_tint').querySelector('button'));
  check('Reset stages the tint default', t.range('theme.frost_tint').value === '25' && t.prop('--ws-frost-tint-a') === '0.25');
  check('only that one', t.range('theme.frost_sheen').value === '12');
  await t.press(t.button('Reset frosted glass to default'));
  check('the card reset stages every default', t.range('theme.frost_sheen').value === '0' && t.range('theme.frost_saturation').value === '100');
  check('and shows them', t.prop('--ws-frost-sheen') === '0' && t.prop('--ws-frost-sat') === '1');
  check('nothing is saved until Save', !t.calls.some((c) => c.method === 'PUT'));
  await t.press(t.button('Save'));
  const put = t.calls.find((c) => c.method === 'PUT');
  const sent = put ? Object.fromEntries(JSON.parse(put.body).settings.map((s) => [s.key, s.value])) : {};
  check('Save sends the whole numbers', sent['theme.frost_tint'] === '25' && sent['theme.frost_sheen'] === '0' && sent['theme.frost_saturation'] === '100', sent);
}));

// ---- theme-loader.js: a payload after a save, held to the bounds ----
current = 'theme-loader bounds';
{
  const win = new Window({ url: 'https://ws.test/' });
  const g = globalThis;
  const keep = {};
  for (const k of ['window', 'document', 'fetch']) keep[k] = Object.getOwnPropertyDescriptor(g, k);
  Object.defineProperty(g, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(g, 'document', { value: win.document, configurable: true, writable: true });
  Object.defineProperty(g, 'fetch', { value: () => new Promise(() => {}), configurable: true, writable: true });
  try {
    new Function('window', 'document', SRC['theme-loader.js'])(win, win.document);
    const root = win.document.documentElement;
    const prop = (n) => root.style.getPropertyValue(n);
    win.WSTheme.apply({ frost_blur: 64, frost_tint: 7, frost_highlight: 200, frost_sheen: 30, frost_grain: 15, frost_depth: 0, frost_saturation: 150 });
    check('each strength as hundredths', prop('--ws-frost-tint-a') === '0.07' && prop('--ws-frost-hl') === '2' && prop('--ws-frost-sheen') === '0.3' &&
      prop('--ws-frost-grain') === '0.15' && prop('--ws-frost-depth') === '0' && prop('--ws-frost-sat') === '1.5',
      ['tint-a', 'hl', 'sheen', 'grain', 'depth', 'sat'].map((n) => prop('--ws-frost-' + n)));
    check('the blur up to 64', prop('--ws-frost-blur') === 'blur(64px)');
    win.WSTheme.apply({ frost_blur: 65, frost_tint: 61, frost_highlight: 2.5, frost_sheen: -1, frost_grain: '9', frost_depth: 201, frost_saturation: null });
    check('out of bounds, fractional or not a number leaves the last value', prop('--ws-frost-blur') === 'blur(64px)' &&
      prop('--ws-frost-tint-a') === '0.07' && prop('--ws-frost-hl') === '2' && prop('--ws-frost-sheen') === '0.3' &&
      prop('--ws-frost-grain') === '0.15' && prop('--ws-frost-depth') === '0' && prop('--ws-frost-sat') === '1.5');
  } catch (e) {
    failed += 1; total += 1; process.stderr.write('FAIL theme-loader bounds: threw ' + (e && e.stack || e) + '\n');
  } finally {
    for (const k of Object.keys(keep)) { if (keep[k]) Object.defineProperty(g, k, keep[k]); else delete g[k]; }
  }
}

console.log(`settings_frost: ${total - failed}/${total} checks passed`);
if (failed) process.exit(1);
