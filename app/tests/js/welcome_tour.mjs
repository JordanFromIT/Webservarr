// Home's welcome tour (js/welcome.js on the shared engine js/tour.js), run for
// real in happy-dom with theme-loader.js (WSAsk, WSPushOffer, the install
// helpers), notifications.js (the push path, faked at the browser's edge: no
// real push service, no real save) and Home's push banner:
//  * the steps, in order, on a desktop and on a phone, and where each points
//  * shown once (webservarr_welcome_v2_seen); "Welcome tour" runs it again
//  * the two offers: Not now asks again on the next load but not on a soft
//    navigation; Don't ask me again needs its confirmation, then silences the
//    tour's prompt and the banner too
//  * an iPhone in a Safari tab: the home screen first, notifications after
//  * nothing offered where it cannot be: already allowed, no push, blocked
//    (says how to unblock), already on the home screen
//  * one ask per visit: the banner and the tour never both
//  * the tour ends with the visit; a plain tour (Books, the reader) is as before
//
// Run: node app/tests/js/welcome_tour.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const LOADER = readFileSync(join(STATIC, 'js/theme-loader.js'), 'utf8');
const NOTIFY = readFileSync(join(STATIC, 'js/notifications.js'), 'utf8');
const TOUR = readFileSync(join(STATIC, 'js/tour.js'), 'utf8');
const WELCOME = readFileSync(join(STATIC, 'js/welcome.js'), 'utf8');
const INDEX = readFileSync(join(STATIC, 'index.html'), 'utf8');
const HOME = readFileSync(join(STATIC, 'js/pages/home.js'), 'utf8');

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
const SEEN = 'webservarr_welcome_v2_seen';
const VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

function banner() {
  return INDEX.match(/<section\b[^>]*id="pushPrompt"[\s\S]*?<\/section>/)[0];
}

/* The shell as the server renders it, in the parts the tour points at. */
function shell({ booksInMore = false, eventLog = true } = {}) {
  const tab = (href, label) => `<li><a class="ws-navtab" href="${href}"><span class="ws-navtab-label">${label}</span></a></li>`;
  return `
<aside id="desktopSidebar"><nav id="desktopNav">
  <a href="/">Home</a><a href="/requests">Requests</a><a href="/calendar">Calendar</a><a href="/books">Books</a>
</nav></aside>
<div id="mobileTopBar">
  <button type="button" id="wsStatusChip">Online</button>
  <div class="relative"><button title="Notifications" aria-label="Notifications">bell</button></div>
</div>
<nav id="wsTabBar"><ul id="wsTabList">
  ${tab('/', 'Home')}${tab('/requests', 'Requests')}${tab('/calendar', 'Calendar')}${booksInMore ? tab('/issues', 'Issues') : tab('/books', 'Books')}
  <li><button type="button" id="wsMoreBtn" class="ws-navtab">More</button></li>
</ul></nav>
<dialog id="wsMoreSheet"><ul id="wsMoreNav">${booksInMore ? '<li><a class="ws-sheet-row" href="/books">Books</a></li>' : ''}</ul></dialog>
<main>
  <header id="appHeader">
    <button type="button" id="systemStatus">All Systems Online</button>
    <button title="Notifications" aria-label="Notifications">bell</button>
    <button id="userMenuBtn">Sam</button>
  </header>
  <div id="wsPage">
    <section id="wsEventLog"${eventLog ? '' : ' hidden'}><h2>Event log</h2></section>
    ${banner()}
  </div>
</main>`;
}

/* A fresh load of a document: a browser at a width, with push or not, a
   permission state and what this device remembers (store). */
function browser({ width = 1440, ua = 'desktop', push = true, permission = 'default', answer = 'granted',
                   store = {}, standalone = false, user = { username: 'sam', has_email: true },
                   booksInMore = false, eventLog = true, prompt = null } = {}) {
  const w = new Window({ url: 'https://dev.example.test/', width, height: width >= 1024 ? 900 : 844 });
  Object.defineProperty(w.navigator, 'userAgent', { value: UA[ua], configurable: true });
  if (ua === 'iphone') Object.defineProperty(w.navigator, 'standalone', { value: standalone, configurable: true });
  const calls = { asked: 0, subscribed: 0, posts: [], prompted: 0, toasts: [] };
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
    const N = {
      permission,
      requestPermission() { calls.asked += 1; N.permission = answer; return Promise.resolve(answer); }
    };
    w.Notification = N;
  } else {
    delete w.PushManager;
    delete w.Notification;
  }
  w.fetch = (url, init) => {
    if (init && init.method === 'POST') calls.posts.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  w.matchMedia = (q) => {
    let matches = false;
    if (q.indexOf('prefers-reduced-motion') !== -1) matches = true;
    else if (q.indexOf('display-mode: standalone') !== -1) matches = standalone && ua !== 'iphone';
    else if (q.indexOf('min-width: 1024px') !== -1) matches = width >= 1024;
    return { matches, media: q, addEventListener() {}, removeEventListener() {} };
  };
  Object.keys(store).forEach((k) => w.localStorage.setItem(k, store[k]));
  const data = { branding: { app_name: 'Example Media', vapid_public_key: VAPID }, user, page: 'index' };
  w.document.head.innerHTML = '<script id="ws-data" type="application/json">' + JSON.stringify(data) + '</script>';
  w.eval(LOADER);
  w.WEBSERVARR_THEME = Object.assign({}, w.WEBSERVARR_THEME || {}, { app_name: 'Example Media', vapid_public_key: VAPID });
  w.document.body.innerHTML = shell({ booksInMore, eventLog });
  w.eval(NOTIFY);
  w.eval(TOUR);
  w.eval(WELCOME);
  w.console.error = () => {};
  w.console.warn = () => {};
  w.WSUI = { toast: (text) => calls.toasts.push(text) };
  if (prompt) {
    w.WSInstallPrompt = {};
    w.WS = Object.assign(w.WS || {}, { install: { prompt: () => { calls.prompted += 1; w.WSInstallPrompt = null; return Promise.resolve(prompt); } } });
  }
  return { w, d: w.document, calls };
}

/* One visit of Home, as pages/home.js mounts it: the banner decided, then
   the welcome tour. The visit's timers end with it (the router's ctx). */
function visit(w, search = '') {
  const ctl = new w.AbortController();
  const card = w.document.getElementById('pushPrompt');
  card.hidden = !(typeof w.WSPushOffer === 'function' &&
                  w.WSPushOffer(card.dataset.dismissKey, Number(card.dataset.dismissDays)));
  w.document.documentElement.removeAttribute('data-push-offer');
  if (!card.hidden) w.initPushPrompt(card, ctl.signal);
  if (!card.hidden && w.WSAsk) w.WSAsk.markAsked('banner');
  const ctx = {
    root: w.document.getElementById('wsPage'),
    signal: ctl.signal,
    url: new URL('https://dev.example.test/' + search),
    setTimeout: (fn) => {
      const id = w.setTimeout(fn, 0);
      ctl.signal.addEventListener('abort', () => w.clearTimeout(id), { once: true });
      return id;
    }
  };
  w.WSWelcome.mount(ctx);
  return { ctl, card };
}

const $ = (d, id) => d.getElementById(id);
const on = (d) => !!$(d, 'tourLayer') && !$(d, 'tourLayer').classList.contains('hidden');
const title = (d) => $(d, 'tourTitle').textContent;
const body = (d) => $(d, 'tourBody').textContent;
const quiet = (d) => $(d, 'tourLayer').classList.contains('tour-quiet');
const actions = (d) => Array.from($(d, 'tourActions').querySelectorAll('button')).map((b) => b.textContent);
const action = (d, label) => Array.from($(d, 'tourActions').querySelectorAll('button')).find((b) => b.textContent === label);
const listed = (d) => Array.from($(d, 'tourList').querySelectorAll('li')).map((li) => li.textContent.replace(/\s+/g, ' ').trim());
const continueShown = (d) => $(d, 'tourNext').style.display !== 'none';
const key = (w, k) => w.localStorage.getItem(k);

/* Walks the tour with Continue (or a step's Not now), noting each step. */
function walk(d) {
  const seen = [];
  for (let i = 0; i < 12 && on(d); i++) {
    seen.push({ title: title(d), body: body(d), actions: actions(d), list: listed(d) });
    if (continueShown(d)) $(d, 'tourNext').click();
    else action(d, 'Not now').click();
  }
  return seen;
}

// ---- The steps, in order ----

await scenario('desktop: six steps, pointing at the header and the sidebar', async () => {
  const { w, d } = browser();
  visit(w);
  await wait(10);
  check('starts on a first visit', on(d));
  check('not quiet: the fog is on', !quiet(d));
  const steps = w.WSWelcome.steps().map((s) => s.target);
  check('targets', JSON.stringify(steps) === JSON.stringify(['#wsEventLog', '#systemStatus', '#appHeader button[title="Notifications"]', null,
                                                             '#desktopNav a[href="/calendar"]', '#desktopNav a[href="/books"]']), steps);
  const seen = walk(d);
  check('order', JSON.stringify(seen.map((s) => s.title)) ===
        JSON.stringify(['Event log', 'Service status', 'Notifications', 'Install as an app', 'Calendar', 'New: Books']), seen.map((s) => s.title));
  check('no tab bar step on a wide screen', !seen.some((s) => s.title === 'Getting around'));
  check('the status step says click', /Click it for the live health/.test(seen[1].body));
  check('the notifications step offers', JSON.stringify(seen[2].actions) === JSON.stringify(['Turn on notifications', 'Not now', 'Don’t ask me again']), seen[2].actions);
  check('the install step uses the site name', /Open Example Media in a window of its own/.test(seen[3].body), seen[3].body);
  check('the last step ends it', !on(d));
  check('seen', key(w, SEEN) === '1');
  await w.happyDOM.close();
});

await scenario('phone: seven steps, the top bar and the tab bar', async () => {
  const { w, d } = browser({ width: 390, ua: 'android' });
  const steps = w.WSWelcome.steps().map((s) => s.target);
  check('targets', JSON.stringify(steps) === JSON.stringify(['#wsEventLog', '#wsStatusChip', '#mobileTopBar button[title="Notifications"]', '#wsMoreBtn',
                                                             '#wsTabList a[href="/calendar"]', '#wsTabList a[href="/books"]', '#wsTabBar']), steps);
  visit(w);
  await wait(10);
  const seen = walk(d);
  check('order', JSON.stringify(seen.map((s) => s.title)) ===
        JSON.stringify(['Event log', 'Service status', 'Notifications', 'Add to home screen', 'Calendar', 'New: Books', 'Getting around']), seen.map((s) => s.title));
  check('the status step says tap', /Tap it for the live health/.test(seen[1].body));
  check('the home screen offer', JSON.stringify(seen[3].actions) === JSON.stringify(['Add to home screen', 'Not now', 'Don’t ask me again']), seen[3].actions);
  await w.happyDOM.close();
});

await scenario('phone: a page the tab bar has no room for points at More', async () => {
  const { w } = browser({ width: 390, ua: 'android', booksInMore: true });
  const books = w.WSWelcome.steps().find((s) => s.title === 'New: Books');
  check('More', books && books.target === '#wsMoreBtn', books && books.target);
  check('and says so', books && /Find it under More\.$/.test(books.body), books && books.body);
  await w.happyDOM.close();
});

await scenario('an event log the admin switched off is not toured', async () => {
  const { w } = browser({ eventLog: false });
  const titles = w.WSWelcome.steps().map((s) => s.title || '');
  check('no event log step', titles.indexOf('Event log') === -1 && titles[0] === 'Service status', titles);
  await w.happyDOM.close();
});

// ---- Shown once ----

await scenario('seen: not again on the next load, but Welcome tour runs it', async () => {
  const { w, d } = browser({ store: { [SEEN]: '1', 'ws-push-ask': 'never', 'ws-install-ask': 'never' } });
  visit(w);
  await wait(10);
  check('no tour', !on(d));
  w.history.replaceState(null, '', '/?welcome=1');
  visit(w, '?welcome=1');
  await wait(10);
  check('the replay link runs it', on(d) && title(d) === 'Event log');
  check('and takes its mark off the address', w.location.search === '', w.location.search);
  // Everything already answered: the steps only explain.
  const seen = walk(d);
  check('no offers after Don’t ask me again', seen.every((s) => s.actions.length === 0), seen.map((s) => s.actions));
  await w.happyDOM.close();
});

await scenario('focus moves into the bubble and goes back after', async () => {
  const { w, d } = browser();
  const before = $(d, 'userMenuBtn');
  before.focus();
  visit(w);
  await wait(450);
  check('the bubble is a labelled dialog', $(d, 'tourBubble').getAttribute('role') === 'dialog' &&
        $(d, 'tourBubble').getAttribute('aria-labelledby') === 'tourTitle' && $(d, 'tourBubble').getAttribute('aria-modal') === 'true');
  check('focus in the bubble', d.activeElement === $(d, 'tourBubble'), d.activeElement && d.activeElement.id);
  $(d, 'tourNext').click();
  $(d, 'tourNext').click();
  await wait(450);
  check('on an offer, focus lands on Not now (Enter never turns anything on)', d.activeElement === action(d, 'Not now'), d.activeElement && d.activeElement.textContent);
  check('the step change is said', /Notifications\./.test($(d, 'tourSay').textContent));
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape ends it', !on(d));
  check('focus back where it was', d.activeElement === before, d.activeElement && d.activeElement.id);
  await w.happyDOM.close();
});

// ---- Not now ----

await scenario('Not now asks again on the next load, not on a soft navigation', async () => {
  const first = browser();
  visit(first.w);
  await wait(10);
  const d = first.d;
  $(d, 'tourNext').click();
  $(d, 'tourNext').click();
  check('on the offer', title(d) === 'Notifications');
  action(d, 'Not now').click();
  check('moves on', title(d) === 'Install as an app');
  check('remembered as later', key(first.w, 'ws-push-ask') === 'later');
  action(d, 'Not now').click();
  while (on(d)) $(d, 'tourNext').click();
  check('the browser was never asked', first.calls.asked === 0);
  // A soft navigation away and back: the same document.
  visit(first.w);
  await wait(10);
  check('no prompt on a soft navigation', !on(d));
  const store = Object.assign({}, first.w.localStorage);
  await first.w.happyDOM.close();

  // The next full load (or sign-in): the tour's own small prompt.
  const next = browser({ store });
  visit(next.w);
  await wait(10);
  const n = next.d;
  check('asks again, once', on(n) && title(n) === 'Turn on notifications?', on(n) && title(n));
  check('quiet: no fog, no Skip, no dots', quiet(n) && $(n, 'tourSkip').hidden && $(n, 'tourFoot').style.display === 'none');
  check('a quiet prompt is not modal', !$(n, 'tourBubble').hasAttribute('aria-modal'));
  check('the banner stays away', $(n, 'pushPrompt').hidden);
  n.dispatchEvent(new next.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes it, still later', !on(n) && key(next.w, 'ws-push-ask') === 'later');
  visit(next.w);
  await wait(10);
  check('and not again in this visit', !on(n));
  await next.w.happyDOM.close();
});

await scenario('closing the tour early is a Not now for both offers', async () => {
  const { w, d } = browser({ width: 390, ua: 'android' });
  visit(w);
  await wait(10);
  $(d, 'tourSkip').click();
  check('ended and seen', !on(d) && key(w, SEEN) === '1');
  check('push later', key(w, 'ws-push-ask') === 'later');
  check('home screen later', key(w, 'ws-install-ask') === 'later');
  await w.happyDOM.close();
});

// ---- Don't ask me again ----

await scenario('Don’t ask me again confirms, then silences the tour and the banner', async () => {
  const { w, d } = browser({ store: { [SEEN]: '1', 'ws-push-ask': 'later' } });
  visit(w);
  await wait(10);
  check('the small prompt', title(d) === 'Turn on notifications?');
  action(d, 'Don’t ask me again').click();
  check('a confirmation first', title(d) === 'Stop asking?' && /from the bell, under Notification settings/.test(body(d)), body(d));
  check('Stop asking and Cancel', JSON.stringify(actions(d)) === JSON.stringify(['Stop asking', 'Cancel']), actions(d));
  check('nothing recorded yet', key(w, 'ws-push-ask') === 'later');
  action(d, 'Cancel').click();
  check('Cancel puts the offer back', title(d) === 'Turn on notifications?' && actions(d).length === 3);
  action(d, 'Don’t ask me again').click();
  action(d, 'Stop asking').click();
  check('recorded', key(w, 'ws-push-ask') === 'never');
  check('closed', !on(d));
  check('the banner is silenced too', w.WSPushOffer('ws-push-prompt-dismissed', 30) === false);
  await w.happyDOM.close();

  const again = browser({ store: { [SEEN]: '1', 'ws-push-ask': 'never' } });
  visit(again.w);
  await wait(10);
  check('next load: no prompt', !on(again.d));
  check('next load: no banner', again.d.getElementById('pushPrompt').hidden);
  await again.w.happyDOM.close();
});

await scenario('the same for the home screen, in the tour', async () => {
  const { w, d } = browser({ width: 390, ua: 'android' });
  visit(w);
  await wait(10);
  while (title(d) !== 'Add to home screen') $(d, 'tourNext').click();
  action(d, 'Don’t ask me again').click();
  check('confirmation', title(d) === 'Stop asking?' && body(d) === 'You can still add it from More.', body(d));
  action(d, 'Stop asking').click();
  check('recorded, and on to the next step', key(w, 'ws-install-ask') === 'never' && title(d) === 'Calendar');
  $(d, 'tourNext').click();
  $(d, 'tourBack').click();
  $(d, 'tourBack').click();
  check('Back shows it without the offer', title(d) === 'Add to home screen' && actions(d).length === 0 && continueShown(d));
  await w.happyDOM.close();
});

// ---- Turning things on ----

await scenario('Turn on runs the site’s own subscribe path and moves on at the grant', async () => {
  const { w, d, calls } = browser();
  visit(w);
  await wait(10);
  $(d, 'tourNext').click();
  $(d, 'tourNext').click();
  action(d, 'Turn on notifications').click();
  await wait(20);
  check('the browser asked once', calls.asked === 1, calls.asked);
  check('subscribed and saved', calls.subscribed === 1 && calls.posts.length === 1 &&
        calls.posts[0].url === '/api/notifications/push-subscribe', calls.posts);
  check('moved on', title(d) === 'Install as an app');
  check('no longer waiting to ask', key(w, 'ws-push-ask') === null);
  $(d, 'tourBack').click();
  check('Back: allowed now, nothing to offer', title(d) === 'Notifications' && actions(d).length === 0);
  await w.happyDOM.close();
});

await scenario('a refused browser question moves on and is not asked again', async () => {
  const { w, d, calls } = browser({ answer: 'denied' });
  visit(w);
  await wait(10);
  $(d, 'tourNext').click();
  $(d, 'tourNext').click();
  action(d, 'Turn on notifications').click();
  await wait(20);
  check('asked', calls.asked === 1);
  check('moved on', title(d) === 'Install as an app');
  check('the permission decides from now on', key(w, 'ws-push-ask') === null);
  await w.happyDOM.close();
});

await scenario('Add to home screen: the browser’s own prompt where there is one', async () => {
  const { w, d, calls } = browser({ width: 390, ua: 'android', prompt: 'accepted' });
  visit(w);
  await wait(10);
  while (title(d) !== 'Add to home screen') $(d, 'tourNext').click();
  action(d, 'Add to home screen').click();
  await wait(10);
  check('shown once', calls.prompted === 1);
  check('done', key(w, 'ws-install-ask') === 'done' && title(d) === 'Calendar');
  await w.happyDOM.close();
});

await scenario('a browser prompt that never answers leaves the step usable', async () => {
  const { w, d } = browser({ width: 390, ua: 'android', prompt: 'accepted' });
  w.WS.install.prompt = () => new Promise(() => {});
  visit(w);
  await wait(10);
  while (title(d) !== 'Add to home screen') $(d, 'tourNext').click();
  action(d, 'Add to home screen').click();
  await wait(10);
  check('buttons not held', !action(d, 'Not now').disabled);
  action(d, 'Not now').click();
  check('Not now still moves on', title(d) === 'Calendar' && key(w, 'ws-install-ask') === 'later');
  await w.happyDOM.close();
});

await scenario('a browser prompt that shows nothing falls back to the menu steps', async () => {
  const { w, d } = browser({ width: 390, ua: 'android', prompt: 'accepted' });
  w.WS.install.prompt = () => Promise.resolve(null);
  visit(w);
  await wait(10);
  while (title(d) !== 'Add to home screen') $(d, 'tourNext').click();
  action(d, 'Add to home screen').click();
  await wait(10);
  check('the steps', listed(d).length === 2 && JSON.stringify(actions(d)) === JSON.stringify(['Done', 'Not now']), actions(d));
  await w.happyDOM.close();
});

await scenario('Add to home screen: the menu steps where there is no prompt', async () => {
  const { w, d } = browser({ width: 390, ua: 'android' });
  visit(w);
  await wait(10);
  while (title(d) !== 'Add to home screen') $(d, 'tourNext').click();
  action(d, 'Add to home screen').click();
  check('the steps', JSON.stringify(listed(d)) === JSON.stringify(['Open the browser menu more_vert', 'Tap Add to Home screen or Install app']), listed(d));
  check('Done and Not now', JSON.stringify(actions(d)) === JSON.stringify(['Done', 'Not now']), actions(d));
  action(d, 'Done').click();
  check('done', key(w, 'ws-install-ask') === 'done' && title(d) === 'Calendar');
  await w.happyDOM.close();
});

// ---- iPhone and iPad ----

await scenario('an iPhone in Safari: the home screen first, with its steps', async () => {
  const { w, d } = browser({ width: 390, ua: 'iphone', push: false });
  visit(w);
  await wait(10);
  const seen = walk(d);
  const titles = seen.map((s) => s.title);
  check('order', JSON.stringify(titles) ===
        JSON.stringify(['Event log', 'Service status', 'Add to home screen', 'Notifications', 'Calendar', 'New: Books', 'Getting around']), titles);
  const home = seen[2];
  check('the two Share steps', JSON.stringify(home.list) === JSON.stringify(['Tap ios_share Share in the browser toolbar', 'Tap Add to Home Screen']), home.list);
  check('Done, Not now, Don’t ask me again', JSON.stringify(home.actions) === JSON.stringify(['Done', 'Not now', 'Don’t ask me again']), home.actions);
  check('notifications: from the home screen app, no offer', /only arrive in the home screen app/.test(seen[3].body) && seen[3].actions.length === 0, seen[3]);
  await w.happyDOM.close();
});

await scenario('an iPhone home-screen app: no home screen step, notifications offered', async () => {
  const { w } = browser({ width: 390, ua: 'iphone', standalone: true });
  const titles = w.WSWelcome.steps().map((s) => s.title || '');
  check('no install step', titles.indexOf('') === -1 && titles.indexOf('Add to home screen') === -1, titles);
  await w.happyDOM.close();
});

// ---- Nothing offered where it cannot be ----

await scenario('already allowed, no push, blocked, already installed', async () => {
  const views = (opts) => {
    const { w } = browser(opts);
    const step = w.WSWelcome.steps().find((s) => s.title === 'Notifications');
    const v = Object.assign({}, step, step.view());
    w.happyDOM.close();
    return v;
  };
  const granted = views({ permission: 'granted' });
  check('allowed: explained, no offer', !granted.actions && /Notification settings/.test(granted.body), granted);
  const none = views({ push: false });
  check('no push: explained, no offer', !none.actions, none);
  const noEmail = views({ user: { username: 'sam', has_email: false } });
  check('no email: no offer', !noEmail.actions);
  const blocked = views({ permission: 'denied' });
  check('blocked: how to unblock, no offer', !blocked.actions && /allow notifications in the browser’s site settings, then reload/.test(blocked.body), blocked.body);
  for (const opts of [{ permission: 'granted' }, { push: false }, { permission: 'denied' }]) {
    const { w } = browser(opts);
    w.WSWelcome.steps();
    check('nothing left waiting: ' + JSON.stringify(opts), key(w, 'ws-push-ask') === null);
    await w.happyDOM.close();
  }
  const app = browser({ standalone: true });
  const titles = app.w.WSWelcome.steps().map((s) => s.title || '');
  check('installed: no install step', titles.length === 5 && titles.indexOf('') === -1, titles);
  check('installed: nothing waiting', key(app.w, 'ws-install-ask') === null);
  await app.w.happyDOM.close();
});

// ---- One ask per visit ----

await scenario('the banner and the tour never both ask', async () => {
  // First visit: the tour asks, the banner waits.
  const a = browser();
  check('no banner while the tour has not been shown', a.w.WSPushOffer('ws-push-prompt-dismissed', 30) === false);
  check('no first-paint mark for it', !a.d.documentElement.hasAttribute('data-push-offer'));
  visit(a.w);
  await wait(10);
  check('the tour runs', on(a.d) && a.d.getElementById('pushPrompt').hidden);
  await a.w.happyDOM.close();

  // Seen, push never asked by the tour (offered when it was not possible),
  // the home screen waiting: the banner asks about push, the tour stays away.
  const b = browser({ store: { [SEEN]: '1', 'ws-install-ask': 'later' } });
  visit(b.w);
  await wait(10);
  check('the banner shows', !b.d.getElementById('pushPrompt').hidden);
  check('no tour prompt the same visit', !on(b.d));
  await b.w.happyDOM.close();

  // Seen, nothing for the banner (push allowed), the home screen waiting:
  // the tour's prompt for it.
  const c = browser({ width: 390, ua: 'android', permission: 'granted', store: { [SEEN]: '1', 'ws-install-ask': 'later' } });
  visit(c.w);
  await wait(10);
  check('the home screen prompt', on(c.d) && title(c.d) === 'Add to home screen?' && quiet(c.d), on(c.d) && title(c.d));
  check('one at a time: banner hidden', c.d.getElementById('pushPrompt').hidden);
  await c.w.happyDOM.close();
});

await scenario('home.js decides the banner first, marks it, then mounts the tour', async () => {
  const mark = HOME.indexOf("window.WSAsk.markAsked('banner')");
  const mount = HOME.indexOf('window.WSWelcome.mount(ctx)');
  check('both there', mark !== -1 && mount !== -1);
  check('in that order', mark < mount && HOME.indexOf('window.WSPushOffer(') < mark);
  check('Home loads the engine and the tour as page helpers', /<script src="\/static\/js\/tour\.js\?v=\d+" data-ws-page-script><\/script>\s*<script src="\/static\/js\/welcome\.js\?v=\d+" data-ws-page-script><\/script>/.test(INDEX));
});

// ---- The visit ends ----

await scenario('a soft navigation away tears it down, unseen', async () => {
  const { w, d } = browser();
  const { ctl } = visit(w);
  await wait(10);
  check('running', on(d));
  ctl.abort();
  check('the layer is gone', !$(d, 'tourLayer'));
  check('not recorded as seen', key(w, SEEN) === null);
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  check('its keys are gone', !$(d, 'tourLayer'));

  const late = browser();
  const v = visit(late.w);
  v.ctl.abort();
  await wait(10);
  check('left before it started: it never starts', !$(late.d, 'tourLayer') || !on(late.d));
  await late.w.happyDOM.close();
  await w.happyDOM.close();
});

await scenario('it waits for an open dialog or sheet to close', async () => {
  const { w, d } = browser();
  const sheet = d.getElementById('wsMoreSheet');
  sheet.setAttribute('open', '');
  visit(w);
  await wait(10);
  check('not over the sheet', !on(d));
  sheet.removeAttribute('open');
  await wait(700);
  check('starts once it closed', on(d) && title(d) === 'Event log');
  await w.happyDOM.close();
});

// ---- A plain tour, as Books and the reader have it ----

await scenario('a plain tour is unchanged', async () => {
  const { w, d } = browser();
  const ctl = new w.AbortController();
  const plain = w.WebServarrTour.init({ seenKey: 'plain_seen', signal: ctl.signal, steps: [
    { target: '#systemStatus', icon: 'search', title: 'One', body: 'First.' },
    { target: '#wsEventLog', icon: 'menu_book', title: 'Two', body: 'Second.' }
  ] });
  plain.start();
  check('Continue, dots, Skip, no step buttons', continueShown(d) && $(d, 'tourDots').children.length === 2 &&
        !$(d, 'tourSkip').hidden && $(d, 'tourActions').hidden && $(d, 'tourList').hidden);
  check('fogged', !quiet(d));
  $(d, 'tourNext').click();
  check('Got it on the last', $(d, 'tourNext').textContent === 'Got it');
  $(d, 'tourNext').click();
  check('finished and seen', !on(d) && key(w, 'plain_seen') === '1');
  ctl.abort();
  await w.happyDOM.close();
});

console.log(`welcome_tour: ${total - failed}/${total} passed`);
if (failed) process.exit(1);
