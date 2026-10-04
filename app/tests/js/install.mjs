// "Add to home screen" (spec 2026-10-04-mobile-nav-and-home-screen-design.md,
// Part 2), run for real in happy-dom:
//  * theme-loader.js: catches Chromium's beforeinstallprompt before anything
//    paints (keeps it, remembers it was offered, says so), and
//    WSInstallOffer(key) decides Home's card: below lg, signed in, not
//    already an installed app, not "Not now"-ed on this device; 'ios' on an
//    iPhone or iPad, 'prompt' where the browser offers its own install;
//    otherwise none. Storage that throws counts as never dismissed.
//  * install.js: the card's buttons (Add calls the browser's prompt once,
//    Not now remembers, the card goes once installed or once the prompt is
//    spent, a remembered prompt that never comes hides it) and the More
//    sheet's row (gone in an installed app; the prompt where there is one,
//    else the two iOS steps or the browser-menu steps, as a disclosure).
//
// INSTALL_JS=<path> runs the same cases against another copy of install.js.
// Run: node app/tests/js/install.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const LOADER = readFileSync(join(STATIC, 'js/theme-loader.js'), 'utf8');
const INSTALL_PATH = process.env.INSTALL_JS || join(STATIC, 'js/install.js');
const INDEX = readFileSync(join(STATIC, 'index.html'), 'utf8');
const PARTIAL = readFileSync(join(STATIC, 'partials/shell-sidebar.html'), 'utf8');

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const install = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(readFileSync(INSTALL_PATH, 'utf8')));

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0'
};

function card() {
  return INDEX.match(/<section\b[^>]*id="installCard"[\s\S]*?<\/section>/)[0];
}
function sheet() {
  return PARTIAL.match(/<dialog id="wsMoreSheet"[\s\S]*?<\/dialog>/)[0]
    .replace(/\{\{\{\w+\}\}\}/g, '').replace(/\{\{\w+\}\}/g, 'x');
}

/* A browser: its width, its kind, whether it runs as an installed app, its
   storage, and whether it offers beforeinstallprompt. Runs theme-loader.js
   as the <head> does, then puts Home's card and the More sheet in. */
function browser({ width = 390, ua = 'android', standalone = false, navStandalone, storage = 'ok', bip = true,
                   user = true, page = 'index', store = {} } = {}) {
  const w = new Window({ url: 'https://dev.example.test/', width, height: 800 });
  Object.defineProperty(w.navigator, 'userAgent', { value: UA[ua], configurable: true });
  Object.defineProperty(w.navigator, 'maxTouchPoints', { value: ua === 'ipad' || ua === 'iphone' ? 5 : (ua === 'android' ? 5 : 0), configurable: true });
  if (navStandalone !== undefined) Object.defineProperty(w.navigator, 'standalone', { value: navStandalone, configurable: true });
  // happy-dom has the handler property; a browser without the event does not.
  if (bip) w.onbeforeinstallprompt = null;
  else delete w.onbeforeinstallprompt;
  const real = w.matchMedia.bind(w);
  w.matchMedia = (q) => (q === '(display-mode: standalone)'
    ? { matches: standalone, media: q, addEventListener() {}, removeEventListener() {} } : real(q));
  if (storage === 'throw') {
    Object.defineProperty(w, 'localStorage', { get() { throw new Error('storage blocked'); }, configurable: true });
  } else {
    Object.keys(store).forEach((k) => w.localStorage.setItem(k, store[k]));
  }
  const data = { branding: { app_name: 'WebServarr' }, user: user ? { username: 'sam' } : null, page };
  w.document.head.innerHTML = '<script id="ws-data" type="application/json">' + JSON.stringify(data) + '</script>';
  w.eval(LOADER);
  w.document.body.innerHTML = card() + sheet();
  w.WS = { closeChrome() { w.__closed = (w.__closed || 0) + 1; } };
  return w;
}

function bipEvent(w, outcome) {
  const e = new w.Event('beforeinstallprompt', { cancelable: true });
  e.prompts = 0;
  e.prompt = () => { e.prompts += 1; return Promise.resolve(); };
  e.userChoice = Promise.resolve({ outcome: outcome || 'accepted', platform: 'web' });
  return e;
}

async function scenario(name, fn) {
  current = name;
  try { await fn(); } catch (e) { check('threw: ' + (e && e.stack || e), false); }
}

// ---- theme-loader.js ----

await scenario('the prompt is caught before anything paints', async () => {
  const w = browser();
  const heard = [];
  w.addEventListener('ws:install-prompt', () => heard.push(1));
  const e = bipEvent(w);
  w.dispatchEvent(e);
  check('the mini-infobar is held back', e.defaultPrevented);
  check('kept for later', w.WSInstallPrompt === e);
  check('remembered on this device', w.localStorage.getItem('ws-install-prompt-seen') === '1');
  check('announced', heard.length === 1);
  check('Home offers the card now', w.WSInstallOffer('ws-install-card-dismissed') === 'prompt');
  await w.happyDOM.close();
});

await scenario('who gets the card', async () => {
  const cases = [
    ['an Android phone that was offered the prompt before', { store: { 'ws-install-prompt-seen': '1' } }, 'prompt'],
    ['an Android phone never offered it', {}, ''],
    ['a browser with no install prompt', { bip: false, ua: 'firefox', store: { 'ws-install-prompt-seen': '1' } }, ''],
    ['an iPhone', { ua: 'iphone', bip: false }, 'ios'],
    ['an iPad (it says Macintosh)', { ua: 'ipad', bip: false }, 'ios'],
    ['a wide screen', { width: 1280, store: { 'ws-install-prompt-seen': '1' } }, ''],
    ['an iPad at desktop width', { ua: 'ipad', bip: false, width: 1180 }, ''],
    ['already installed (display-mode)', { standalone: true, store: { 'ws-install-prompt-seen': '1' } }, ''],
    ['already installed (iOS home-screen app)', { ua: 'iphone', bip: false, navStandalone: true }, ''],
    ['said Not now on this device', { ua: 'iphone', bip: false, store: { 'ws-install-card-dismissed': '1' } }, ''],
    ['storage blocked: shows again', { ua: 'iphone', bip: false, storage: 'throw' }, 'ios'],
    ['signed out', { ua: 'iphone', bip: false, user: false }, '']
  ];
  for (const [what, opts, want] of cases) {
    const w = browser(opts);
    const got = w.WSInstallOffer('ws-install-card-dismissed');
    check(what, got === want, { got, want });
    check(what + ': Home is marked for the first paint', (w.document.documentElement.getAttribute('data-install-offer') || '') === want);
    await w.happyDOM.close();
  }
  const w = browser({ ua: 'iphone', bip: false, page: 'issues' });
  check('only Home is marked', !w.document.documentElement.hasAttribute('data-install-offer'));
  check('installed is known', w.WSInstalled() === false && w.WSInstallIOS() === true);
  await w.happyDOM.close();
});

// ---- install.js: Home's card ----

function decide(w, api) {
  const c = w.document.getElementById('installCard');
  const mode = w.WSInstallOffer(c.dataset.dismissKey);
  c.hidden = !mode;
  if (mode) c.dataset.mode = mode;
  const ctl = new w.AbortController();
  if (mode) api.wireCard(c, ctl.signal);
  return { c, ctl, mode };
}

await scenario('Android: Add asks the browser once, and the card goes when it is installed', async () => {
  const w = browser();
  const e = bipEvent(w, 'accepted');
  w.dispatchEvent(e);
  const api = install.create(w);
  const { c } = decide(w, api);
  const add = c.querySelector('[data-install-add]');
  check('shown', !c.hidden);
  check('ready', add.getAttribute('aria-disabled') !== 'true');
  add.click();
  add.click();
  await wait(10);
  check('the browser asked once', e.prompts === 1, e.prompts);
  check('spent', w.WSInstallPrompt === null);
  check('the card goes', c.hidden);
  await w.happyDOM.close();
});

await scenario('Android: a prompt the person turns down is spent, so the card goes for now', async () => {
  const w = browser();
  const e = bipEvent(w, 'dismissed');
  w.dispatchEvent(e);
  const api = install.create(w);
  const { c } = decide(w, api);
  c.querySelector('[data-install-add]').click();
  await wait(10);
  check('hidden', c.hidden);
  check('not remembered as Not now', w.localStorage.getItem('ws-install-card-dismissed') === null);
  await w.happyDOM.close();
});

await scenario('Android: a remembered prompt is waited for, then used', async () => {
  const w = browser({ store: { 'ws-install-prompt-seen': '1' } });
  const api = install.create(w, { waitMs: 200 });
  const { c } = decide(w, api);
  const add = c.querySelector('[data-install-add]');
  check('shown from the first paint', !c.hidden);
  check('waits for the browser', add.getAttribute('aria-disabled') === 'true');
  add.click();
  const e = bipEvent(w);
  w.dispatchEvent(e);
  check('ready once offered', add.getAttribute('aria-disabled') === 'false');
  check('a press while waiting asked nothing', e.prompts === 0);
  add.click();
  await wait(10);
  check('asked', e.prompts === 1);
  await w.happyDOM.close();
});

await scenario('Android: a remembered prompt that never comes hides the card and is forgotten', async () => {
  const w = browser({ store: { 'ws-install-prompt-seen': '1' } });
  const api = install.create(w, { waitMs: 60 });
  const { c } = decide(w, api);
  await wait(120);
  check('hidden', c.hidden);
  check('forgotten', w.localStorage.getItem('ws-install-prompt-seen') === null);
  await w.happyDOM.close();
});

await scenario('Not now remembers on this device; blocked storage still hides it', async () => {
  let w = browser({ ua: 'iphone', bip: false });
  let api = install.create(w);
  let { c } = decide(w, api);
  check('iOS shows the steps, not a button', c.dataset.mode === 'ios');
  c.querySelector('[data-install-later]').click();
  check('hidden', c.hidden);
  check('remembered', w.localStorage.getItem('ws-install-card-dismissed') !== null);
  check('Home no longer offers it', w.WSInstallOffer('ws-install-card-dismissed') === '');
  await w.happyDOM.close();
  w = browser({ ua: 'iphone', bip: false, storage: 'throw' });
  api = install.create(w);
  ({ c } = decide(w, api));
  c.querySelector('[data-install-later]').click();
  check('hidden without storage', c.hidden);
  await w.happyDOM.close();
});

await scenario('the card ends with the visit', async () => {
  const w = browser({ ua: 'iphone', bip: false });
  const api = install.create(w);
  const { c, ctl } = decide(w, api);
  ctl.abort();
  c.querySelector('[data-install-later]').click();
  check('no longer wired', !c.hidden && w.localStorage.getItem('ws-install-card-dismissed') === null);
  await w.happyDOM.close();
});

await scenario('installing from anywhere removes the card and the row', async () => {
  const w = browser();
  w.dispatchEvent(bipEvent(w));
  const api = install.create(w);
  api.wireRow();
  const { c } = decide(w, api);
  const row = w.document.querySelector('[data-install-row]');
  check('the row shows while not installed', !row.hidden);
  w.dispatchEvent(new w.Event('appinstalled'));
  check('card gone', c.hidden);
  check('row gone', row.hidden);
  check('nothing to remember', w.localStorage.getItem('ws-install-prompt-seen') === null);
  await w.happyDOM.close();
});

// ---- install.js: the More sheet's row ----

await scenario('an installed app has no row', async () => {
  const w = browser({ standalone: true });
  install.create(w).wireRow();
  check('hidden', w.document.querySelector('[data-install-row]').hidden);
  await w.happyDOM.close();
});

await scenario('the row asks the browser where it can, and closes the sheet', async () => {
  const w = browser();
  const e = bipEvent(w);
  w.dispatchEvent(e);
  install.create(w).wireRow();
  const btn = w.document.querySelector('[data-install-action]');
  btn.click();
  await wait(10);
  check('asked', e.prompts === 1);
  check('the sheet closed', w.__closed === 1);
  check('no steps shown', w.document.getElementById('wsInstallHelp').hidden);
  await w.happyDOM.close();
});

await scenario('on an iPhone the row opens the two steps', async () => {
  const w = browser({ ua: 'iphone', bip: false });
  install.create(w).wireRow();
  const d = w.document;
  const btn = d.querySelector('[data-install-action]');
  const help = d.getElementById('wsInstallHelp');
  check('shown', !d.querySelector('[data-install-row]').hidden);
  btn.click();
  check('expanded', btn.getAttribute('aria-expanded') === 'true' && !help.hidden);
  check('the iOS steps', !d.querySelector('[data-install-steps="ios"]').hidden && d.querySelector('[data-install-steps="menu"]').hidden);
  btn.click();
  check('collapses again', btn.getAttribute('aria-expanded') === 'false' && help.hidden);
  await w.happyDOM.close();
});

await scenario('elsewhere the row points at the browser menu', async () => {
  const w = browser({ ua: 'firefox', bip: false });
  install.create(w).wireRow();
  const d = w.document;
  d.querySelector('[data-install-action]').click();
  check('the menu steps', !d.querySelector('[data-install-steps="menu"]').hidden && d.querySelector('[data-install-steps="ios"]').hidden);
  await w.happyDOM.close();
});

console.log(`install: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
