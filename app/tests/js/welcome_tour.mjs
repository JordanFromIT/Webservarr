// Home's welcome tour (js/welcome.js on the shared engine js/tour.js), run for
// real in happy-dom with theme-loader.js (WSAsk, WSPushOffer, the install
// helpers), notifications.js (the push path, faked at the browser's edge: no
// real push service, no real save) and Home's push banner:
//  * the steps, in order, on a desktop and on a phone, and where each points;
//    the home screen is a phone's only (never a desktop's, nor its prompt), and
//    its words never say install
//  * shown once (webservarr_welcome_v2_seen); "Welcome tour" runs it again
//  * the two offers: Not now asks again on the next load (a notice in the
//    bell's list, never a bubble) but not on a soft navigation; Don't ask me
//    again needs its confirmation, then silences the bell's notice and the
//    banner too
//  * the bell's notice (notifications.js): a tap on the bell never starts a
//    tour or a bubble; shown only when WSAsk allows it; Turn on, Not now and
//    Don't ask me again (with its confirmation); the blocked and iPhone
//    words; the home screen on a phone only; one notice per visit; one
//    unread in the badge until the list is opened or it is answered; it
//    outlives a soft navigation and nothing it leaves starts a bubble
//  * an iPhone in a Safari tab: the home screen first, notifications after
//  * nothing offered where it cannot be: already allowed, no push, blocked
//    (says how to unblock), already on the home screen
//  * one ask per visit: the banner and the tour never both
//  * Calendar points at Home's Upcoming Releases when its week has something,
//    else at the Calendar entry in the nav
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
function shell({ booksInMore = false, eventLog = true, releases = false } = {}) {
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
    <section id="upcomingReleasesSection" data-arrive="releases"${releases ? ' data-has-releases' : ''}><div id="releasesHead"><h3>Upcoming Releases</h3><a href="/calendar">View calendar</a></div></section>
  </div>
</main>`;
}

/* A fresh load of a document: a browser at a width, with push or not, a
   permission state and what this device remembers (store). */
function browser({ width = 1440, ua = 'desktop', push = true, permission = 'default', answer = 'granted',
                   store = {}, standalone = false, user = { username: 'sam', has_email: true },
                   booksInMore = false, eventLog = true, releases = false, prompt = null, unread = 0 } = {}) {
  const w = new Window({ url: 'https://dev.example.test/', width, height: width >= 1024 ? 900 : 844 });
  Object.defineProperty(w.navigator, 'userAgent', { value: UA[ua], configurable: true });
  if (ua === 'iphone') Object.defineProperty(w.navigator, 'standalone', { value: standalone, configurable: true });
  const calls = { asked: 0, subscribed: 0, posts: [], prompted: 0, toasts: [], fetched: [] };
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
    calls.fetched.push(((init && init.method) || 'GET') + ' ' + url);
    if (init && init.method === 'POST') calls.posts.push({ url, body: JSON.parse(init.body) });
    const body = String(url).indexOf('/api/notifications/unread-count') === 0 ? { count: unread } : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
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
  w.document.body.innerHTML = shell({ booksInMore, eventLog, releases });
  w.eval(NOTIFY);
  w.eval(TOUR);
  w.eval(WELCOME);
  w.console.error = () => {};
  w.console.warn = () => {};
  w.WSUI = { toast: (text) => calls.toasts.push(text) };
  // The shell's helpers notifications.js leans on (shell.js): no poll timer,
  // and the drop-down's open and close as plain class switches.
  w.WS = Object.assign(w.WS || {}, {
    poll: () => () => {},
    popOpen: (el) => { el.classList.remove('hidden'); el.classList.add('is-open'); },
    popClose: (el) => { el.classList.remove('is-open'); el.classList.add('hidden'); }
  });
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

/* The bell (notifications.js), as the shell starts it once per document. */
async function bellUp(w) {
  w.initNotifications();
  await wait(10);
}
const bellBtn = (d, phone = false) => d.querySelector((phone ? '#mobileTopBar' : '#appHeader') + ' button[title="Notifications"]');
const openBell = async (d, phone = false) => { bellBtn(d, phone).click(); await wait(10); };
const listOpen = (d) => !!d.querySelector('.ws-pop.is-open');
const badge = (d, phone = false) => {
  const b = bellBtn(d, phone).querySelector('span.absolute');
  return b && b.style.display !== 'none' ? b.textContent : '';
};
const notice = (d) => d.querySelector('[data-ws-notice]');
const noticeTitle = (d) => (notice(d) ? notice(d).querySelector('#wsNoticeTitle').textContent : '');
const noticeBody = (d) => (notice(d) ? notice(d).querySelector('#wsNoticeTitle').nextElementSibling.textContent : '');
const noticeActions = (d) => (notice(d) ? Array.from(notice(d).querySelectorAll('button')).map((b) => b.textContent) : []);
const noticeAction = (d, label) => Array.from(notice(d).querySelectorAll('button')).find((b) => b.textContent === label);
const noticeList = (d) => (notice(d) ? Array.from(notice(d).querySelectorAll('li')).map((li) => li.textContent.replace(/\s+/g, ' ').trim()) : []);
const PUSH_WORDS = 'Get updates on your requests and server problems on this device, even with the page closed.';
const PUSH_OFFER = ['Turn on', 'Not now', 'Don’t ask me again'];

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

const REL = '#upcomingReleasesSection[data-has-releases]';

await scenario('desktop: five steps, pointing at the header and the sidebar, no home screen', async () => {
  const { w, d } = browser();
  visit(w);
  await wait(10);
  check('starts on a first visit', on(d));
  check('not quiet: the fog is on', !quiet(d));
  const steps = w.WSWelcome.steps().map((s) => s.target);
  check('targets', JSON.stringify(steps) === JSON.stringify(['#wsEventLog', '#systemStatus', '#appHeader button[title="Notifications"]',
                                                             REL, '#desktopNav a[href="/books"]']), steps);
  const seen = walk(d);
  check('order: Notifications straight to Calendar', JSON.stringify(seen.map((s) => s.title)) ===
        JSON.stringify(['Event log', 'Service status', 'Notifications', 'Calendar', 'New: Books']), seen.map((s) => s.title));
  check('no tab bar step on a wide screen', !seen.some((s) => s.title === 'Getting around'));
  check('the status step says click', /Click it for the live health/.test(seen[1].body));
  check('the notifications step offers', JSON.stringify(seen[2].actions) === JSON.stringify(['Turn on notifications', 'Not now', 'Don’t ask me again']), seen[2].actions);
  check('nothing about the home screen or installing', seen.every((s) => !/home screen|install/i.test(s.title + s.body + s.actions.join(' '))), seen);
  check('a desktop is not left waiting to be asked', key(w, 'ws-install-ask') === null);
  check('the last step ends it', !on(d));
  check('seen', key(w, SEEN) === '1');
  await w.happyDOM.close();
});

await scenario('phone: seven steps, the top bar and the tab bar', async () => {
  const { w, d } = browser({ width: 390, ua: 'android' });
  const steps = w.WSWelcome.steps().map((s) => s.target);
  check('targets', JSON.stringify(steps) === JSON.stringify(['#wsEventLog', '#wsStatusChip', '#mobileTopBar button[title="Notifications"]', '#wsMoreBtn',
                                                             REL, '#wsTabList a[href="/books"]', '#wsTabBar']), steps);
  visit(w);
  await wait(10);
  const seen = walk(d);
  check('order', JSON.stringify(seen.map((s) => s.title)) ===
        JSON.stringify(['Event log', 'Service status', 'Notifications', 'Add to home screen', 'Calendar', 'New: Books', 'Getting around']), seen.map((s) => s.title));
  check('the status step says tap', /Tap it for the live health/.test(seen[1].body));
  check('the home screen offer', JSON.stringify(seen[3].actions) === JSON.stringify(['Add to home screen', 'Not now', 'Don’t ask me again']), seen[3].actions);
  check('its words', seen[3].body === 'Open Example Media from your home screen, full screen like an app.', seen[3].body);
  check('no install wording on a phone', seen.every((s) => !/install|app window/i.test(s.title + s.body + s.actions.join(' ') + s.list.join(' '))), seen);
  await w.happyDOM.close();
});

await scenario('phone: a page the tab bar has no room for points at More', async () => {
  const { w } = browser({ width: 390, ua: 'android', booksInMore: true });
  const books = w.WSWelcome.steps().find((s) => s.title === 'New: Books');
  check('More', books && books.target === '#wsMoreBtn', books && books.target);
  check('and says so', books && /Find it under More\.$/.test(books.body), books && books.body);
  await w.happyDOM.close();
});

await scenario('Calendar: Upcoming Releases when it has the week, else the nav entry', async () => {
  for (const [width, ua, nav] of [[1440, 'desktop', '#desktopNav a[href="/calendar"]'], [390, 'android', '#wsTabList a[href="/calendar"]']]) {
    const shown = browser({ width, ua, releases: true });
    // happy-dom lays nothing out: give the section a box, as a browser would.
    shown.d.getElementById('upcomingReleasesSection').getBoundingClientRect = () => ({ width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300 });
    const cal = shown.w.WSWelcome.steps().find((s) => s.title === 'Calendar');
    const v = Object.assign({}, cal, cal.view());
    check(ua + ': the section first, the nav entry as its fallback', cal.target === REL && cal.fallback === nav, [cal.target, cal.fallback]);
    check(ua + ': says the button is there', v.body === 'Upcoming movies and episodes, so you know what’s coming and when. Open the full calendar from here.', v.body);
    cal.before();
    check(ua + ': a week that fits: the whole section', cal.target === REL, cal.target);
    shown.d.getElementById('upcomingReleasesSection').getBoundingClientRect = () => ({ width: 374, height: 1400, top: 0, left: 0, right: 374, bottom: 1400 });
    cal.before();
    check(ua + ': taller than the screen: its header, with the button', cal.target === REL + ' #releasesHead', cal.target);
    await shown.w.happyDOM.close();

    // Hidden by its Home setting (no box), or a week with nothing in it (no mark).
    for (const opts of [{ releases: true }, { releases: false }]) {
      const off = browser(Object.assign({ width, ua }, opts));
      const step = off.w.WSWelcome.steps().find((s) => s.title === 'Calendar');
      const ov = Object.assign({}, step, step.view());
      check(ua + ': hidden or empty: the nav entry, the old words ' + JSON.stringify(opts),
            ov.fallback === nav && ov.body === 'Upcoming movies and episodes, so you know what’s coming and when.', ov.body);
      await off.w.happyDOM.close();
    }
  }
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
  check('moves on', title(d) === 'Calendar');
  check('remembered as later', key(first.w, 'ws-push-ask') === 'later');
  while (on(d)) $(d, 'tourNext').click();
  check('the browser was never asked', first.calls.asked === 0);
  // A soft navigation away and back: the same document.
  visit(first.w);
  await wait(10);
  check('no prompt on a soft navigation', !on(d));
  const store = Object.assign({}, first.w.localStorage);
  await first.w.happyDOM.close();

  // The next full load (or sign-in): a notice in the bell's list, no bubble.
  const next = browser({ store });
  await bellUp(next.w);
  visit(next.w);
  await wait(450);
  const n = next.d;
  check('no bubble over the page', !on(n));
  check('the banner stays away', $(n, 'pushPrompt').hidden);
  check('the bell hints at it', badge(n) === '1', badge(n));
  await openBell(n);
  check('the list opens', listOpen(n));
  check('the notice heads the list', notice(n) && notice(n).parentElement.parentElement.firstChild === notice(n).parentElement);
  check('its words', noticeTitle(n) === 'Turn on notifications' && noticeBody(n) === PUSH_WORDS, [noticeTitle(n), noticeBody(n)]);
  check('its buttons', JSON.stringify(noticeActions(n)) === JSON.stringify(PUSH_OFFER), noticeActions(n));
  check('Not now beside Turn on keeps its place', !noticeAction(n, 'Not now').classList.contains('-ms-2.5'));
  check('real buttons', Array.from(notice(n).querySelectorAll('button')).every((b) => b.type === 'button'));
  check('a labelled group', notice(n).getAttribute('role') === 'group' && notice(n).getAttribute('aria-labelledby') === 'wsNoticeTitle');
  await wait(450);
  check('still no bubble after the tap', !on(n));
  noticeAction(n, 'Not now').click();
  check('Not now: gone, still later', !notice(n) && key(next.w, 'ws-push-ask') === 'later');
  check('the list stays open', listOpen(n));
  check('the badge has nothing for it', badge(n) === '', badge(n));
  visit(next.w);
  await wait(450);
  check('and not again in this visit', !on(n) && !notice(n));
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

await scenario('Don’t ask me again confirms, then silences the bell, the tour and the banner', async () => {
  const { w, d } = browser({ store: { [SEEN]: '1', 'ws-push-ask': 'later' } });
  await bellUp(w);
  visit(w);
  await openBell(d);
  check('the notice', noticeTitle(d) === 'Turn on notifications');
  noticeAction(d, 'Don’t ask me again').click();
  check('a confirmation first', noticeTitle(d) === 'Stop asking?' && /from the bell, under Notification settings/.test(noticeBody(d)), noticeBody(d));
  check('Stop asking and Cancel', JSON.stringify(noticeActions(d)) === JSON.stringify(['Stop asking', 'Cancel']), noticeActions(d));
  check('focus on Cancel (Enter never stops anything)', d.activeElement === noticeAction(d, 'Cancel'), d.activeElement && d.activeElement.textContent);
  check('the change is said', /^Stop asking\?\. /.test(notice(d).querySelector('[aria-live]').textContent));
  check('nothing recorded yet', key(w, 'ws-push-ask') === 'later');
  check('the list stays open through it', listOpen(d));
  noticeAction(d, 'Cancel').click();
  check('Cancel puts the offer back', noticeTitle(d) === 'Turn on notifications' && noticeActions(d).length === 3);
  check('focus back on Don’t ask me again', d.activeElement === noticeAction(d, 'Don’t ask me again'), d.activeElement && d.activeElement.textContent);
  noticeAction(d, 'Don’t ask me again').click();
  noticeAction(d, 'Stop asking').click();
  check('recorded', key(w, 'ws-push-ask') === 'never');
  check('gone', !notice(d) && badge(d) === '');
  check('focus goes to the bell', d.activeElement === bellBtn(d), d.activeElement && d.activeElement.outerHTML.slice(0, 60));
  check('the banner is silenced too', w.WSPushOffer('ws-push-prompt-dismissed', 30) === false);
  const step = w.WSWelcome.steps().find((s) => s.title === 'Notifications');
  check('and the tour’s offer', !Object.assign({}, step, step.view()).actions);
  await w.happyDOM.close();

  const again = browser({ store: { [SEEN]: '1', 'ws-push-ask': 'never' } });
  await bellUp(again.w);
  visit(again.w);
  await wait(10);
  check('next load: no prompt', !on(again.d));
  check('next load: no banner', again.d.getElementById('pushPrompt').hidden);
  check('next load: no notice, no badge', !notice(again.d) && badge(again.d) === '');
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
  check('moved on', title(d) === 'Calendar');
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
  check('moved on', title(d) === 'Calendar');
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
  check('the steps', JSON.stringify(listed(d)) === JSON.stringify(['Open the browser menu more_vert', 'Tap Add to Home screen']), listed(d));
  check('the words', body(d) === 'Add it from your browser’s menu:', body(d));
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
  check('installed: no home screen step', titles.length === 5 && titles.indexOf('') === -1, titles);
  check('installed: nothing waiting', key(app.w, 'ws-install-ask') === null);
  await app.w.happyDOM.close();
  const phoneApp = browser({ width: 390, ua: 'android', standalone: true });
  const phoneTitles = phoneApp.w.WSWelcome.steps().map((s) => s.title || '');
  check('a phone home-screen app: no home screen step', phoneTitles.indexOf('Add to home screen') === -1 && phoneTitles.indexOf('') === -1, phoneTitles);
  await phoneApp.w.happyDOM.close();
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
  await bellUp(b.w);
  check('and no notice in the bell either', !notice(b.d) && badge(b.d) === '', badge(b.d));
  await b.w.happyDOM.close();

  // Seen, nothing for the banner (push allowed), the home screen waiting:
  // the bell's notice for it.
  const c = browser({ width: 390, ua: 'android', permission: 'granted', store: { [SEEN]: '1', 'ws-install-ask': 'later' } });
  await bellUp(c.w);
  visit(c.w);
  await wait(10);
  check('no bubble', !on(c.d));
  await openBell(c.d, true);
  check('the home screen notice', noticeTitle(c.d) === 'Add to home screen', noticeTitle(c.d));
  check('its words', noticeBody(c.d) === 'Open Example Media from your home screen, full screen like an app.' &&
        JSON.stringify(noticeActions(c.d)) === JSON.stringify(['Add to home screen', 'Not now', 'Don’t ask me again']), [noticeBody(c.d), noticeActions(c.d)]);
  noticeAction(c.d, 'Don’t ask me again').click();
  check('its confirmation', noticeTitle(c.d) === 'Stop asking?' && noticeBody(c.d) === 'You can still add it from More.', noticeBody(c.d));
  noticeAction(c.d, 'Stop asking').click();
  check('recorded', key(c.w, 'ws-install-ask') === 'never' && !notice(c.d));
  check('one at a time: banner hidden', c.d.getElementById('pushPrompt').hidden);
  await c.w.happyDOM.close();

  // The same on a desktop, or a tablet held wide: the home screen is never
  // asked about there, even one left waiting from a phone-width visit.
  for (const ua of ['desktop', 'iphone']) {
    const e = browser({ ua, permission: 'granted', store: { [SEEN]: '1', 'ws-install-ask': 'later', 'ws-push-ask': 'never' } });
    await bellUp(e.w);
    visit(e.w);
    await wait(10);
    check('no bubble on a wide screen: ' + ua, !on(e.d), on(e.d) && title(e.d));
    check('no home screen notice on a wide screen: ' + ua, !notice(e.d) && badge(e.d) === '', noticeTitle(e.d));
    await e.w.happyDOM.close();
  }
});

await scenario('home.js decides the banner first, marks it, then mounts the tour', async () => {
  const mark = HOME.indexOf("window.WSAsk.markAsked('banner')");
  const mount = HOME.indexOf('window.WSWelcome.mount(ctx)');
  check('both there', mark !== -1 && mount !== -1);
  check('in that order', mark < mount && HOME.indexOf('window.WSPushOffer(') < mark);
  check('Home loads the engine and the tour as page helpers', /<script src="\/static\/js\/tour\.js\?v=\d+" data-ws-page-script><\/script>\s*<script src="\/static\/js\/welcome\.js\?v=\d+" data-ws-page-script><\/script>/.test(INDEX));
});

// ---- The bell's notice ----

const LATER = { [SEEN]: '1', 'ws-push-ask': 'later' };

await scenario('a tap on the bell never starts a tour or a bubble', async () => {
  for (const [width, ua, phone] of [[1440, 'desktop', false], [390, 'android', true]]) {
    const { w, d } = browser({ width, ua, store: { [SEEN]: '1', 'ws-push-ask': 'later', 'ws-install-ask': 'later' } });
    await bellUp(w);
    // Tapped before Home has even mounted, again once it has, and once more
    // after the old prompt's delay.
    await openBell(d, phone);
    visit(w);
    await openBell(d, phone);
    await openBell(d, phone);
    await wait(450);
    check(ua + ': no tour layer shown', !on(d));
    check(ua + ': the list opens and the notice is in it', listOpen(d) && !!notice(d), noticeTitle(d));
    check(ua + ': the bell has no listener of the tour’s', !/WebServarrTour|tourLayer/.test(NOTIFY));
    await w.happyDOM.close();
  }
  check('welcome.js no longer starts a quiet prompt', !/quiet:\s*true/.test(WELCOME));
});

await scenario('the notice is shown only when WSAsk allows it', async () => {
  const shown = async (opts, phone = false) => {
    const { w, d } = browser(opts);
    await bellUp(w);
    visit(w);
    await wait(10);
    const hint = badge(d, phone);
    await openBell(d, phone);
    const out = { kind: notice(d) ? notice(d).getAttribute('data-ws-notice') : '', badge: hint };
    await w.happyDOM.close();
    return out;
  };
  check('later: shown', (await shown({ store: LATER })).kind === 'push');
  check('never asked by the tour, banner dismissed: shown', (await shown({ store: { [SEEN]: '1', 'ws-push-prompt-dismissed': String(Date.now()) } })).kind === 'push');
  check('never: not shown', (await shown({ store: { [SEEN]: '1', 'ws-push-ask': 'never' } })).kind === '');
  check('already allowed: not shown', (await shown({ store: LATER, permission: 'granted' })).kind === '');
  check('no push in this browser: not shown', (await shown({ store: LATER, push: false })).kind === '');
  check('no email on the account: not shown', (await shown({ store: LATER, user: { username: 'sam', has_email: false } })).kind === '');
  check('the banner asks this visit: not shown', (await shown({ store: { [SEEN]: '1' } })).kind === '');
  const first = await shown({});
  check('the tour has not been shown: it asks, not the bell', first.kind === '' && first.badge === '', first);
});

await scenario('Turn on: the shared subscribe path, then gone', async () => {
  const { w, d, calls } = browser({ store: LATER });
  await bellUp(w);
  let used = 0;
  const real = w.WSPush.subscribe;
  w.WSPush.subscribe = (onGranted) => { used += 1; return real(onGranted); };
  await openBell(d);
  noticeAction(d, 'Turn on').click();
  await wait(20);
  check('WSPush.subscribe ran once, from the tap', used === 1 && calls.asked === 1, [used, calls.asked]);
  check('subscribed and saved', calls.subscribed === 1 && calls.posts.length === 1, calls.posts);
  check('no longer waiting to ask', key(w, 'ws-push-ask') === null);
  check('gone, badge clear', !notice(d) && badge(d) === '');
  check('the banner has nothing to offer either', w.WSPushOffer('ws-push-prompt-dismissed', 30) === false);
  await w.happyDOM.close();
});

await scenario('Turn on: a failure says why and keeps the buttons', async () => {
  const { w, d } = browser({ store: LATER });
  await bellUp(w);
  let release;
  w.WSPush.subscribe = () => new Promise((resolve, reject) => { release = () => reject(new Error('boom')); });
  await openBell(d);
  noticeAction(d, 'Turn on').click();
  check('busy while the browser asks', noticeActions(d)[0] === 'Turning on…' && Array.from(notice(d).querySelectorAll('button')).every((b) => b.disabled));
  release();
  await wait(10);
  check('the words say what failed', noticeBody(d) === w.WSPush.messages.failed, noticeBody(d));
  check('and it is said aloud', notice(d).querySelector('[aria-live]').textContent.indexOf(w.WSPush.messages.failed) !== -1);
  check('the buttons are back', JSON.stringify(noticeActions(d)) === JSON.stringify(PUSH_OFFER) &&
        Array.from(notice(d).querySelectorAll('button')).every((b) => !b.disabled), noticeActions(d));
  check('nothing recorded', key(w, 'ws-push-ask') === 'later');
  await w.happyDOM.close();

  // The browser's own question refused: it goes, the permission decides.
  const no = browser({ store: LATER, answer: 'denied' });
  await bellUp(no.w);
  await openBell(no.d);
  noticeAction(no.d, 'Turn on').click();
  await wait(20);
  check('refused: gone for this visit', !notice(no.d) && key(no.w, 'ws-push-ask') === null);
  await no.w.happyDOM.close();
  // Closed without an answer: a Not now.
  const shut = browser({ store: LATER, answer: 'default' });
  await bellUp(shut.w);
  await openBell(shut.d);
  noticeAction(shut.d, 'Turn on').click();
  await wait(20);
  check('closed: later', !notice(shut.d) && key(shut.w, 'ws-push-ask') === 'later');
  await shut.w.happyDOM.close();
});

await scenario('blocked: how to unblock, no Turn on', async () => {
  const { w, d } = browser({ store: LATER, permission: 'denied' });
  await bellUp(w);
  check('counted in the badge', badge(d) === '1', badge(d));
  check('recorded as shown on its first visit', key(w, 'ws-push-blocked-seen') === 'shown');
  await openBell(d);
  check('the words', noticeTitle(d) === 'Notifications are blocked' &&
        noticeBody(d) === 'This browser is blocking notifications from this site. To get them here, allow notifications in the browser’s site settings, then reload the page.', [noticeTitle(d), noticeBody(d)]);
  check('the tour says the same', /allow notifications in the browser’s site settings, then reload the page\.$/.test(
    Object.assign({}, w.WSWelcome.steps().find((s) => s.title === 'Notifications')).view().body));
  check('Not now and Don’t ask me again', JSON.stringify(noticeActions(d)) === JSON.stringify(['Not now', 'Don’t ask me again']), noticeActions(d));
  check('a lone Not now sits on the words’ edge', noticeAction(d, 'Not now').classList.contains('-ms-2.5'));
  noticeAction(d, 'Don’t ask me again').click();
  noticeAction(d, 'Stop asking').click();
  check('silenced', key(w, 'ws-push-ask') === 'never' && !notice(d));
  await w.happyDOM.close();
});

await scenario('blocked: shown once, again only after its Not now', async () => {
  const load = async (store) => {
    const b = browser({ store, permission: 'denied' });
    await bellUp(b.w);
    return b;
  };
  // Never answered by the tour either ('' ): the first load says it.
  const first = await load({ [SEEN]: '1' });
  check('first load: shown', badge(first.d) === '1');
  await openBell(first.d);
  check('first load: the blocked words', noticeTitle(first.d) === 'Notifications are blocked');
  const ignored = Object.assign({}, first.w.localStorage);
  await first.w.happyDOM.close();

  // Left alone (the list opened, nothing pressed): not on the next load.
  const second = await load(ignored);
  check('ignored: not shown again', badge(second.d) === '', badge(second.d));
  await openBell(second.d);
  check('ignored: not in the list', !notice(second.d));
  await second.w.happyDOM.close();

  // Not now: back on the next visit, once.
  const third = await load(Object.assign({}, ignored, { 'ws-push-blocked-seen': '' }));
  await openBell(third.d);
  check('shown again when unseen', noticeTitle(third.d) === 'Notifications are blocked');
  noticeAction(third.d, 'Not now').click();
  check('Not now: gone for this visit', !notice(third.d) && key(third.w, 'ws-push-blocked-seen') === 'later' && key(third.w, 'ws-push-ask') === 'later');
  const afterLater = Object.assign({}, third.w.localStorage);
  await third.w.happyDOM.close();

  const fourth = await load(afterLater);
  check('after Not now: shown on the next visit', badge(fourth.d) === '1', badge(fourth.d));
  check('and recorded as shown again', key(fourth.w, 'ws-push-blocked-seen') === 'shown');
  await openBell(fourth.d);
  check('the same notice', noticeTitle(fourth.d) === 'Notifications are blocked');
  const ignoredAgain = Object.assign({}, fourth.w.localStorage);
  await fourth.w.happyDOM.close();

  const fifth = await load(ignoredAgain);
  check('left alone again: not shown', badge(fifth.d) === '', badge(fifth.d));
  await fifth.w.happyDOM.close();

  // Don't ask me again: never, even with the marker cleared.
  const never = await load({ [SEEN]: '1', 'ws-push-ask': 'never' });
  check('never: not shown', badge(never.d) === '');
  await never.w.happyDOM.close();

  // Not blocked: the marker plays no part in the normal reminder.
  const normal = browser({ store: { [SEEN]: '1', 'ws-push-ask': 'later', 'ws-push-blocked-seen': 'shown' } });
  await bellUp(normal.w);
  check('a normal reminder ignores the marker', badge(normal.d) === '1', badge(normal.d));
  await normal.w.happyDOM.close();
});

await scenario('an iPhone in Safari: the home screen first, then why push needs it', async () => {
  const both = browser({ width: 390, ua: 'iphone', push: false, store: { [SEEN]: '1', 'ws-push-ask': 'later', 'ws-install-ask': 'later' } });
  await bellUp(both.w);
  await openBell(both.d, true);
  check('the home screen comes first', noticeTitle(both.d) === 'Add to home screen', noticeTitle(both.d));
  check('says push needs it', /On an iPhone or iPad it’s also how you get notifications\.$/.test(noticeBody(both.d)), noticeBody(both.d));
  check('the Share steps', JSON.stringify(noticeList(both.d)) === JSON.stringify(['Tap ios_share Share in the browser toolbar', 'Tap Add to Home Screen']), noticeList(both.d));
  check('Done, Not now, Don’t ask me again', JSON.stringify(noticeActions(both.d)) === JSON.stringify(['Done', 'Not now', 'Don’t ask me again']), noticeActions(both.d));
  noticeAction(both.d, 'Done').click();
  check('done, and no second notice this visit', key(both.w, 'ws-install-ask') === 'done' && !notice(both.d));
  await both.w.happyDOM.close();

  // The home screen already answered: the push notice, which points at it.
  const push = browser({ width: 390, ua: 'iphone', push: false, store: { [SEEN]: '1', 'ws-push-ask': 'later', 'ws-install-ask': 'done' } });
  await bellUp(push.w);
  await openBell(push.d, true);
  check('notifications need the home screen app', noticeTitle(push.d) === 'Turn on notifications' &&
        /only arrive in the home screen app: add it/.test(noticeBody(push.d)), [noticeTitle(push.d), noticeBody(push.d)]);
  check('with the steps to add it', noticeList(push.d).length === 2, noticeList(push.d));
  check('no Turn on in a Safari tab', JSON.stringify(noticeActions(push.d)) === JSON.stringify(['Not now', 'Don’t ask me again']), noticeActions(push.d));
  check('its lone Not now sits on the words’ edge', noticeAction(push.d, 'Not now').classList.contains('-ms-2.5'));
  await push.w.happyDOM.close();
});

await scenario('the home screen notice: phones only, never from inside it', async () => {
  const store = { [SEEN]: '1', 'ws-push-ask': 'never', 'ws-install-ask': 'later' };
  const phone = browser({ width: 390, ua: 'android', store });
  await bellUp(phone.w);
  check('a phone: one unread for it', badge(phone.d, true) === '1', badge(phone.d, true));
  await openBell(phone.d, true);
  check('a phone: shown', noticeTitle(phone.d) === 'Add to home screen');
  noticeAction(phone.d, 'Add to home screen').click();
  await wait(10);
  check('no browser prompt: the menu steps', noticeBody(phone.d) === 'Add it from your browser’s menu:' &&
        JSON.stringify(noticeList(phone.d)) === JSON.stringify(['Open the browser menu more_vert', 'Tap Add to Home screen']) &&
        JSON.stringify(noticeActions(phone.d)) === JSON.stringify(['Done', 'Not now']), [noticeBody(phone.d), noticeActions(phone.d)]);
  check('focus on Done', phone.d.activeElement === noticeAction(phone.d, 'Done'));
  noticeAction(phone.d, 'Done').click();
  check('done', key(phone.w, 'ws-install-ask') === 'done' && !notice(phone.d));
  await phone.w.happyDOM.close();

  const prompted = browser({ width: 390, ua: 'android', store, prompt: 'accepted' });
  await bellUp(prompted.w);
  await openBell(prompted.d, true);
  noticeAction(prompted.d, 'Add to home screen').click();
  await wait(10);
  check('the browser’s own prompt, accepted: done', prompted.calls.prompted === 1 && key(prompted.w, 'ws-install-ask') === 'done' && !notice(prompted.d));
  await prompted.w.happyDOM.close();

  for (const opts of [{ width: 1440, ua: 'desktop' }, { width: 390, ua: 'android', standalone: true }]) {
    const none = browser(Object.assign({ store }, opts));
    await bellUp(none.w);
    check('none: ' + JSON.stringify(opts), !notice(none.d) && badge(none.d, opts.width < 1024) === '', noticeTitle(none.d));
    await none.w.happyDOM.close();
  }
});

await scenario('one notice per visit: notifications first', async () => {
  const store = { [SEEN]: '1', 'ws-push-ask': 'later', 'ws-install-ask': 'later' };
  const { w, d } = browser({ width: 390, ua: 'android', store });
  await bellUp(w);
  check('one unread, not two', badge(d, true) === '1', badge(d, true));
  await openBell(d, true);
  check('notifications first', notice(d).getAttribute('data-ws-notice') === 'push');
  check('only one in the list', d.querySelectorAll('[data-ws-notice]').length === 1);
  noticeAction(d, 'Not now').click();
  check('the home screen does not follow in the same visit', !notice(d) && badge(d, true) === '');
  const store2 = Object.assign({}, w.localStorage);
  await w.happyDOM.close();
  const next = browser({ width: 390, ua: 'android', store: store2 });
  await bellUp(next.w);
  check('next visit: asked again', badge(next.d, true) === '1');
  await openBell(next.d, true);
  check('next visit: the same notice', !!notice(next.d) && notice(next.d).getAttribute('data-ws-notice') === 'push');
  await next.w.happyDOM.close();
});

await scenario('the badge: one unread while the notice is new', async () => {
  const { w, d } = browser({ store: LATER, unread: 2 });
  await bellUp(w);
  check('the server’s two and the notice', badge(d) === '3', badge(d));
  await openBell(d);
  check('opening the list reads it', badge(d) === '2', badge(d));
  check('but it stays in the list until answered', !!notice(d));
  await openBell(d);
  await openBell(d);
  check('not counted again on a second open', badge(d) === '2', badge(d));
  await w.happyDOM.close();

  // Answered without ever closing the list: the count stays the server's.
  const two = browser({ store: LATER });
  await bellUp(two.w);
  check('alone: 1', badge(two.d) === '1', badge(two.d));
  await openBell(two.d);
  noticeAction(two.d, 'Not now').click();
  await wait(10);
  check('Not now: nothing', badge(two.d) === '', badge(two.d));
  check('client-side only: nothing marked read or sent', two.calls.fetched.every((f) => f.indexOf('GET ') === 0), two.calls.fetched);
  await two.w.happyDOM.close();

  // The tour answering in the same visit takes it away too.
  const tour = browser({ store: LATER });
  await bellUp(tour.w);
  tour.w.history.replaceState(null, '', '/?welcome=1');
  visit(tour.w, '?welcome=1');
  await wait(10);
  check('the tour asks this visit: the notice steps aside', on(tour.d) && !notice(tour.d) && badge(tour.d) === '', badge(tour.d));
  await tour.w.happyDOM.close();
});

await scenario('the notice outlives a soft navigation; nothing starts a bubble', async () => {
  const { w, d } = browser({ store: LATER });
  await bellUp(w);
  const home = visit(w);
  home.ctl.abort();                       // Home left before its timers ran
  await wait(450);
  check('no bubble after leaving', !on(d));
  check('the notice is still counted in the bell', badge(d) === '1');
  const back = visit(w);                  // back to Home, same document
  await wait(450);
  check('no bubble on the way back', !on(d));
  await openBell(d);
  check('and in the list', !!notice(d));
  noticeAction(d, 'Not now').click();
  back.ctl.abort();
  visit(w);
  await wait(450);
  check('Not now holds across soft navigations', !notice(d) && !on(d) && badge(d) === '');
  await w.happyDOM.close();
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
