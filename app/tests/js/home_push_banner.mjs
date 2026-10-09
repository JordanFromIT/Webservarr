// Home's push offer, the slim banner at the top of Home (index.html
// #pushPrompt), run for real in happy-dom:
//  * theme-loader.js WSPushOffer: who is offered it (signed in with an email,
//    push set up on the server, a browser with push, permission not yet
//    given or refused, not "Not now"-ed within 30 days), on every width,
//    and only Home is marked for the first paint. An iPhone has push only
//    as a home-screen app (Safari has no PushManager in a tab).
//  * the banner itself: one line of words, Turn on and a close button, no
//    install card anywhere on Home.
//  * notifications.js initPushPrompt: Turn on asks the browser and runs the
//    shared subscribe path (faked here: no real push service, no real
//    save), the banner leaves on the grant; the close button remembers the
//    dismissal under the banner's key; a refusal hides it without
//    remembering; everything ends with the visit.
//
// Run: node app/tests/js/home_push_banner.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const LOADER = readFileSync(join(STATIC, 'js/theme-loader.js'), 'utf8');
const NOTIFY = readFileSync(join(STATIC, 'js/notifications.js'), 'utf8');
const INDEX = readFileSync(join(STATIC, 'index.html'), 'utf8');
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, fn) {
  current = name;
  try { await fn(); } catch (e) { check('threw: ' + (e && e.stack || e), false); }
}

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
};

const KEY = 'ws-push-prompt-dismissed';
const DAY = 86400000;

function banner() {
  return INDEX.match(/<section\b[^>]*id="pushPrompt"[\s\S]*?<\/section>/)[0];
}

/* A browser at a width, signed in or not, with or without push, with a
   permission state and storage. Runs theme-loader.js as the <head> does,
   then puts Home's banner in. The push path is faked end to end: the
   permission prompt, the service worker, the push service and the save. */
function browser({ width = 390, ua = 'android', user = { username: 'sam', has_email: true }, vapid = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
                   push = true, permission = 'default', answer = 'granted', page = 'index', store = {}, storage = 'ok' } = {}) {
  const w = new Window({ url: 'https://dev.example.test/', width, height: 800 });
  Object.defineProperty(w.navigator, 'userAgent', { value: UA[ua], configurable: true });
  const calls = { asked: 0, subscribed: 0, posts: [] };
  if (push) {
    const sub = {
      endpoint: 'https://push.example.test/ep/1',
      options: {},
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; },
      unsubscribe() { return Promise.resolve(true); }
    };
    const reg = { pushManager: {
      getSubscription: () => Promise.resolve(null),
      subscribe: () => { calls.subscribed += 1; return Promise.resolve(sub); }
    } };
    Object.defineProperty(w.navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg), register: () => Promise.resolve(reg) }, configurable: true });
    w.PushManager = function PushManager() {};
  } else {
    delete w.PushManager;
  }
  const N = {
    permission,
    requestPermission() { calls.asked += 1; N.permission = answer; return Promise.resolve(answer); }
  };
  w.Notification = N;
  w.fetch = (url, init) => {
    if (init && init.method === 'POST') calls.posts.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  // Reduced motion: the banner goes at once (no 200 ms collapse to wait on).
  w.matchMedia = (q) => ({ matches: q.indexOf('prefers-reduced-motion') !== -1, media: q, addEventListener() {}, removeEventListener() {} });
  if (storage === 'throw') {
    Object.defineProperty(w, 'localStorage', { get() { throw new Error('storage blocked'); }, configurable: true });
  } else {
    // Someone who has had the welcome tour (js/welcome.js): until then the
    // tour, not the banner, asks (welcome_tour.mjs covers the hand-over).
    const all = Object.assign({ webservarr_welcome_v2_seen: '1' }, store);
    Object.keys(all).forEach((k) => w.localStorage.setItem(k, all[k]));
  }
  const data = { branding: { app_name: 'WebServarr', vapid_public_key: vapid }, user, page };
  w.document.head.innerHTML = '<script id="ws-data" type="application/json">' + JSON.stringify(data) + '</script>';
  w.eval(LOADER);
  if (vapid) w.WEBSERVARR_THEME = Object.assign({}, w.WEBSERVARR_THEME || {}, { vapid_public_key: vapid });
  w.document.body.innerHTML = banner();
  w.eval(NOTIFY);
  w.console.error = () => {};
  return { w, calls };
}

/* What pages/home.js does on each visit: decide, take the mark off, wire. */
function visit(w) {
  const card = w.document.getElementById('pushPrompt');
  card.hidden = !(typeof w.WSPushOffer === 'function' &&
                  w.WSPushOffer(card.dataset.dismissKey, Number(card.dataset.dismissDays)));
  w.document.documentElement.removeAttribute('data-push-offer');
  const ctl = new w.AbortController();
  if (!card.hidden) w.initPushPrompt(card, ctl.signal);
  return { card, ctl };
}

// ---- Who is offered it ----

await scenario('who gets the banner', async () => {
  const cases = [
    ['a phone with push, never asked', {}, true],
    ['a desktop browser too (the same banner, no big card)', { width: 1440, ua: 'desktop' }, true],
    ['an account with no email', { user: { username: 'sam', has_email: false } }, false],
    ['push not set up on the server', { vapid: '' }, false],
    ['a browser without push (an iPhone in a Safari tab)', { ua: 'iphone', push: false }, false],
    ['an iPhone home-screen app (it has push)', { ua: 'iphone' }, true],
    ['already allowed', { permission: 'granted' }, false],
    ['already refused', { permission: 'denied' }, false],
    ['closed within 30 days', { store: { [KEY]: String(Date.now() - 29 * DAY) } }, false],
    ['closed more than 30 days ago', { store: { [KEY]: String(Date.now() - 31 * DAY) } }, true],
    ['storage blocked: offered', { storage: 'throw' }, true],
    ['signed out', { user: null }, false]
  ];
  for (const [what, opts, want] of cases) {
    const { w } = browser(opts);
    const got = w.WSPushOffer(KEY, 30);
    check(what, got === want, { got, want });
    check(what + ': Home is marked for the first paint', w.document.documentElement.hasAttribute('data-push-offer') === want);
    await w.happyDOM.close();
  }
  const { w } = browser({ page: 'issues' });
  check('only Home is marked', !w.document.documentElement.hasAttribute('data-push-offer'));
  await w.happyDOM.close();
});

// ---- The banner ----

await scenario('one slim line: the words, Turn on, a close button', async () => {
  const { w } = browser();
  const d = w.document;
  const card = d.getElementById('pushPrompt');
  check('hidden until decided, no class on the section', card.hidden && !card.hasAttribute('class'));
  const row = card.firstElementChild;
  check('one row, centred', row && row.classList.contains('flex') && row.classList.contains('items-center') && !row.classList.contains('flex-col'));
  check('no taller than a button row (48px minimum, slim padding)', row.classList.contains('min-h-12') && row.classList.contains('py-1.5'));
  const title = d.getElementById('pushPromptTitle');
  check('the words', title && title.textContent === 'Get notified when your requests are ready');
  check('labelled by them', card.getAttribute('aria-labelledby') === 'pushPromptTitle');
  const texts = Array.from(card.querySelectorAll('p')).filter((p) => p.textContent.trim());
  check('no second line of explanation', texts.length === 1, texts.map((p) => p.textContent));
  const enable = card.querySelector('[data-push-prompt-enable]');
  const later = card.querySelector('[data-push-prompt-later]');
  check('Turn on, then the close button (Tab meets them in that order)', enable && later && (enable.compareDocumentPosition(later) & 4));
  check('Turn on says so', enable.querySelector('[data-push-label-idle]').textContent === 'Turn on');
  const busy = enable.querySelector('[data-push-label-busy]');
  check('busy: a spinner (turning only where motion is allowed) with its words for screen readers',
        busy.querySelector('[aria-hidden="true"]').textContent === 'progress_activity' &&
        busy.querySelector('[aria-hidden="true"]').classList.contains('motion-safe:animate-spin') &&
        busy.querySelector('.sr-only').textContent === 'Turning on…');
  check('the close button is named for what it does', later.getAttribute('aria-label') === 'Not now' && later.textContent.trim() === 'close');
  check('its icon is not read out', later.querySelector('.material-symbols-outlined').getAttribute('aria-hidden') === 'true');
  check('a target of at least 24px (32px)', later.classList.contains('size-8'));
  check('both have a visible focus ring', [enable, later].every((b) => b.className.indexOf('focus-visible:ring-2') !== -1));
  const msg = card.querySelector('[data-push-prompt-msg]');
  check('a polite message line that takes no room while empty', msg.getAttribute('aria-live') === 'polite' && msg.classList.contains('empty:hidden'));
  await w.happyDOM.close();
  check('the first paint shows it with its gap below', THEME.indexOf('html[data-push-offer] #pushPrompt[hidden] { display: block; margin-bottom: 2rem; }') !== -1);
});

await scenario('no home-screen card on Home', async () => {
  check('no install card in the page', INDEX.indexOf('installCard') === -1 && INDEX.indexOf('data-install') === -1);
  check('no first-paint mark for it', LOADER.indexOf('data-install-offer') === -1 && THEME.indexOf('data-install-offer') === -1 && THEME.indexOf('#installCard') === -1);
  check('the push banner is the first thing on Home', /data-home-stack>\s*<!--[\s\S]*?-->\s*<section id="pushPrompt"/.test(INDEX));
});

// ---- What it does ----

await scenario('Turn on asks the browser and subscribes through the shared path', async () => {
  const { w, calls } = browser();
  const { card } = visit(w);
  check('shown', !card.hidden);
  card.querySelector('[data-push-prompt-enable]').click();
  await wait(20);
  check('the browser asked once', calls.asked === 1, calls.asked);
  check('subscribed', calls.subscribed === 1, calls.subscribed);
  check('saved to the server', calls.posts.length === 1 && calls.posts[0].url === '/api/notifications/push-subscribe' &&
        calls.posts[0].body.endpoint === 'https://push.example.test/ep/1', calls.posts);
  check('the banner went on the grant', card.hidden);
  check('not remembered as Not now (permission decides from now on)', w.localStorage.getItem(KEY) === null);
  check('not offered again', w.WSPushOffer(KEY, 30) === false);
  await w.happyDOM.close();
});

await scenario('the close button remembers on this device', async () => {
  const { w, calls } = browser();
  const { card } = visit(w);
  const before = Date.now();
  card.querySelector('[data-push-prompt-later]').click();
  check('hidden', card.hidden);
  const at = Number(w.localStorage.getItem(KEY));
  check('remembered with the time', at >= before && at <= Date.now(), at);
  check('the browser was never asked', calls.asked === 0);
  check('not offered on the next visit', visit(w).card.hidden);
  await w.happyDOM.close();
});

await scenario('blocked storage: the close button still hides it', async () => {
  const { w } = browser({ storage: 'throw' });
  const { card } = visit(w);
  card.querySelector('[data-push-prompt-later]').click();
  check('hidden', card.hidden);
  await w.happyDOM.close();
});

await scenario('refused in the browser: hidden, not remembered (permission says it)', async () => {
  const { w, calls } = browser({ answer: 'denied' });
  const { card } = visit(w);
  card.querySelector('[data-push-prompt-enable]').click();
  await wait(20);
  check('asked', calls.asked === 1);
  check('nothing subscribed', calls.subscribed === 0 && calls.posts.length === 0);
  check('hidden', card.hidden);
  check('not offered again', w.WSPushOffer(KEY, 30) === false);
  await w.happyDOM.close();
});

await scenario('the banner ends with the visit', async () => {
  const { w, calls } = browser();
  const { card, ctl } = visit(w);
  ctl.abort();
  card.querySelector('[data-push-prompt-later]').click();
  card.querySelector('[data-push-prompt-enable]').click();
  await wait(20);
  check('no longer wired', !card.hidden && w.localStorage.getItem(KEY) === null && calls.asked === 0);
  await w.happyDOM.close();
});

console.log(`home_push_banner: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
