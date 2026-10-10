// The request access steps inside the sign-in card (login-request.js over
// login.html, with login.js as the page runs it), in happy-dom with a
// scripted server, a fake popup and a fake clock. Covers: the link only when
// the site takes requests; every step, its heading focused and announced;
// the popup path (the popup's message only, the popup closed early, the
// popup blocked and reopened, a second completion); the phone path (away
// and back, and back without the stored PIN); the form (the counter, the
// checks, one send for two presses); every server answer the card can get;
// each status message; Back to sign in and the browser's Back.
// Run: node app/tests/js/login_request.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const LOGIN_HTML = readFileSync(join(STATIC, 'login.html'), 'utf8');
const LOGIN_JS = readFileSync(join(STATIC, 'js/login.js'), 'utf8');
const REQUEST_JS = readFileSync(join(STATIC, 'js/login-request.js'), 'utf8');

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
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

const NOT_YET = 'PIN not yet authorized. Try again.';
const AUTH_URL = 'https://app.plex.tv/auth#?code=CODE';
const NEW = { state: 'new', username: 'newperson', avatar_url: 'https://plex.tv/users/abc/avatar?c=1' };

// answers: { 'POST /api/access-requests/pin': [reply, reply...] } taken in
// order, the last one repeating. A reply is { status, body } or 'offline'.
function server(answers) {
  const calls = [];
  const fetch = (url, init = {}) => {
    const key = (init.method || 'GET') + ' ' + String(url);
    calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
    const list = answers[key];
    if (!list) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('{}') });
    const reply = list.length > 1 ? list.shift() : list[0];
    if (reply === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    const status = reply.status || 200;
    return Promise.resolve({ ok: status >= 200 && status < 300, status,
                             text: () => Promise.resolve(JSON.stringify(reply.body || {})) });
  };
  return { calls, fetch, sent: (key) => calls.filter((c) => c.key === key) };
}

function fakeTimers(w) {
  let now = 0;
  let ids = 0;
  const due = new Map();
  const def = (name, value) => Object.defineProperty(w, name, { value, configurable: true, writable: true });
  def('setTimeout', (fn, ms) => { const id = ++ids; due.set(id, { at: now + (ms || 0), fn, every: 0 }); return id; });
  def('setInterval', (fn, ms) => { const id = ++ids; due.set(id, { at: now + ms, fn, every: ms }); return id; });
  def('clearTimeout', (id) => due.delete(id));
  def('clearInterval', (id) => due.delete(id));
  return {
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of due) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        now = next[1].at;
        if (next[1].every) next[1].at += next[1].every; else due.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}

async function page(o = {}) {
  const w = new Window({ url: o.url || 'https://ws.test/login', width: o.width || 1440, height: 900 });
  const doc = w.document;
  doc.body.innerHTML = LOGIN_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script\b[^>]*><\/script>/g, '');
  const clock = fakeTimers(w);
  const s = server(o.answers || {});
  w.fetch = s.fetch;
  const popups = [];
  const opened = [];
  w.open = (url, name, features) => {
    opened.push({ url, name, features });
    if (o.blockPopup && opened.length <= (o.blockPopup === 'always' ? 99 : 1)) return null;
    const p = { closed: false, location: { href: url }, close() { this.closed = true; } };
    popups.push(p);
    return p;
  };
  const assigned = [];
  w.location.assign = (url) => assigned.push(url);
  if (o.phone) Object.defineProperty(w.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; Mobile)', configurable: true });
  if (o.storedPin !== undefined) w.sessionStorage.setItem('access_pin_id', o.storedPin);
  w.history.back = () => { w.history.replaceState(null, '', '/login'); w.dispatchEvent(new w.Event('popstate')); };
  w.WEBSERVARR_THEME = { auth_methods: { simple: true, plex: true, authentik: true, request_access: o.on !== false } };
  w.eval(REQUEST_JS);
  w.eval(LOGIN_JS);
  await flush();
  const t = {
    w, doc, s, clock, popups, opened, assigned,
    q: (sel) => doc.querySelector(sel),
    step() {
      if (doc.getElementById('requestAccess').hidden) return 'signin';
      const shown = Array.from(doc.querySelectorAll('[data-ra-step]')).filter((n) => !n.hidden);
      return shown.length === 1 ? shown[0].getAttribute('data-ra-step') : 'broken:' + shown.length;
    },
    heading() { const n = doc.querySelector(`[data-ra-step="${t.step()}"] [data-ra-heading]`); return n; },
    error: () => doc.getElementById('raError').textContent,
    live: () => doc.getElementById('raLive').textContent,
    async click(sel) { (typeof sel === 'string' ? doc.querySelector(sel) : sel).click(); await flush(); },
    async message(source, data, origin) {
      w.dispatchEvent(new w.MessageEvent('message', { data, origin: origin || 'https://ws.test', source }));
      await flush();
    },
    async close() { await w.happyDOM.abort(); w.close(); }
  };
  return t;
}

async function run(name, fn) {
  current = name;
  const made = [];
  try { await fn(async (o) => { const t = await page(o); made.push(t); return t; }); }
  catch (e) { failed += 1; total += 1; console.error(`FAIL ${name}: threw ${e && e.stack || e}`); }
  finally { while (made.length) await made.pop().close(); }
}

const PIN_OK = { body: { pin_id: 4242, auth_url: AUTH_URL } };
const IDENTIFY = 'POST /api/access-requests/identify';
const PIN = 'POST /api/access-requests/pin';
const SUBMIT = 'POST /api/access-requests';

function focusedOnHeading(t) { const h = t.heading(); return !!h && t.doc.activeElement === h; }

async function toWaiting(open, o = {}) {
  const t = await open({ answers: Object.assign({ [PIN]: [PIN_OK] }, o.answers || {}), blockPopup: o.blockPopup });
  await t.click('#requestAccessLink');
  await t.click('[data-ra-plex]');
  return t;
}

await run('feature off', async (open) => {
  const t = await open({ on: false, url: 'https://ws.test/login?access_request=complete#request-access', storedPin: '4242' });
  check('no link', t.q('#requestAccessLinkRow').hidden === true);
  check('the card is today\'s card', t.step() === 'signin' && !t.q('#loginForm').hidden);
  check('nothing asked of the server', t.s.calls.length === 0, t.s.calls);
});

await run('entering the flow', async (open) => {
  const t = await open();
  const before = t.w.history.length;
  check('the link shows', t.q('#requestAccessLinkRow').hidden === false);
  check('its words', t.q('#requestAccessLink').textContent.trim() === 'New here? Request access');
  await t.click('#requestAccessLink');
  check('S1', t.step() === 'intro');
  check('one history entry, #request-access', t.w.location.hash === '#request-access' && t.w.history.length === before + 1);
  check('the sign-in form is hidden', t.q('#loginForm').hidden === true);
  check('focus on the heading', focusedOnHeading(t));
  check('announced', t.live() === 'Request access', t.live());
  check('the heading can take focus', t.heading().getAttribute('tabindex') === '-1');
});

await run('back to sign in and the browser\'s Back', async (open) => {
  const t = await open();
  await t.click('#requestAccessLink');
  await t.click('[data-ra-step="intro"] [data-ra-back]');
  check('S0 again', t.step() === 'signin' && !t.q('#loginForm').hidden && !t.q('#requestAccessLinkRow').hidden);
  check('focus back on the link', t.doc.activeElement === t.q('#requestAccessLink'));
  check('the hash is gone', t.w.location.hash === '');
  await t.click('#requestAccessLink');
  t.w.history.back();
  await flush();
  check('Back returns to S0', t.step() === 'signin');
});

await run('popup: the message from the popup', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ body: NEW }] } });
  check('opened inside the click, then sent to Plex', t.opened.length === 1 && t.popups[0].location.href === AUTH_URL, t.opened);
  check('S2', t.step() === 'waiting' && focusedOnHeading(t) && t.live() === 'Waiting for Plex…', t.live());
  await t.message({}, { type: 'plex-access-complete' });
  await t.message(t.popups[0], { type: 'plex-auth-complete' });
  await t.message(t.popups[0], { type: 'plex-access-complete' }, 'https://evil.test');
  check('nobody else is heard', t.s.sent(IDENTIFY).length === 0);
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('identify with the PIN', t.s.sent(IDENTIFY).length === 1 && t.s.sent(IDENTIFY)[0].body.pin_id === 4242);
  check('S3 with who they are', t.step() === 'form' && t.q('[data-ra-username]').textContent === 'newperson');
  check('the avatar', t.q('[data-ra-avatar]').getAttribute('src') === NEW.avatar_url && !t.q('[data-ra-avatar]').hidden);
  check('the popup is closed', t.popups[0].closed === true);
  await t.clock.advance(3000);
  check('no second identify after the popup closed', t.s.sent(IDENTIFY).length === 1);
});

await run('popup: closed before it finished', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 400, body: { detail: NOT_YET } }] } });
  t.popups[0].closed = true;
  await t.clock.advance(1000);
  check('one identify', t.s.sent(IDENTIFY).length === 1);
  check('back to S1 with why', t.step() === 'intro' && t.error() === 'Plex sign-in was closed before it finished.', t.error());
});

await run('popup: a second completion is not an error', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 409, body: { detail: 'busy' } }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('stays on S2 with no error', t.step() === 'waiting' && t.error() === '', t.error());
});

await run('popup: Plex still finishing', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 400, body: { detail: NOT_YET } }, { body: NEW }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('waits, no error', t.step() === 'waiting' && t.error() === '');
  await t.clock.advance(2000);
  check('asked again, then the form', t.s.sent(IDENTIFY).length === 2 && t.step() === 'form');
});

await run('popup: blocked, then reopened from a click', async (open) => {
  const t = await toWaiting(open, { blockPopup: 'once', answers: { [IDENTIFY]: [{ body: NEW }] } });
  check('S2 says the window was blocked', t.step() === 'waiting' && t.error() === 'Your browser blocked the Plex window. Allow pop-ups, then press Reopen Plex sign-in.', t.error());
  check('the error sits just above the buttons', t.q('#raError').nextElementSibling === t.q('[data-ra-reopen]'));
  await t.click('[data-ra-reopen]');
  check('reopened at Plex', t.opened.length === 2 && t.opened[1].url === AUTH_URL && t.error() === '');
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('then on to the form', t.step() === 'form');
});

await run('cancel while waiting', async (open) => {
  const t = await toWaiting(open);
  await t.click('[data-ra-cancel]');
  check('S1, the popup closed', t.step() === 'intro' && t.popups[0].closed === true);
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('a late message is ignored', t.s.sent(IDENTIFY).length === 0);
});

await run('starting fails', async (open) => {
  for (const [reply, words] of [[{ status: 503, body: { detail: 'Plex isn\'t answering right now. Try again in a minute.' } }, 'Plex isn\'t answering right now. Try again in a minute.'],
                                [{ status: 429, body: { detail: 'Rate limit exceeded: 5 per 1 minute' } }, 'Too many tries. Wait a few minutes and try again.'],
                                ['offline', 'That didn’t go through. Check your connection and try again.']]) {
    const t = await open({ answers: { [PIN]: [reply] } });
    await t.click('#requestAccessLink');
    await t.click('[data-ra-plex]');
    check(`${words}: stays on S1`, t.step() === 'intro' && t.error() === words, t.error());
    check('the blank popup is closed again', t.popups.every((p) => p.closed));
  }
});

await run('closed while in the flow', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 403, body: { detail: 'Access requests are closed.' } }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('back to S0 with why, no link', t.step() === 'signin' && t.q('#requestAccessLinkRow').hidden === true &&
    t.error() === 'Access requests are closed.', t.error());
});

// Plex refused the person's token, or the PIN ran out (identify's 400
// EXPIRED): asking again can't help, so the card starts again at S1.
await run('identify: the Plex sign-in expired', async (open) => {
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ status: 400, body: { detail: 'That Plex sign-in expired. Start again.' } }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('S1 says start again', t.step() === 'intro' && t.error() === 'That Plex sign-in expired. Start again.', t.error());
  check('the error sits just above the Plex button', t.q('#raError').nextElementSibling === t.q('[data-ra-plex]'));
  await t.clock.advance(5000);
  check('asked once', t.s.sent(IDENTIFY).length === 1);
});

async function toForm(open, answers) {
  const t = await toWaiting(open, { answers: Object.assign({ [IDENTIFY]: [{ body: NEW }] }, answers) });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  return t;
}

function type(t, sel, text) { const n = t.q(sel); n.value = text; n.dispatchEvent(new t.w.Event('input')); }

await run('the form', async (open) => {
  const t = await toForm(open, { [SUBMIT]: [{ body: { state: 'pending', sent: true } }] });
  check('S3 focused and announced', focusedOnHeading(t) && t.live() === 'Request access');
  check('name field', t.q('#raName').getAttribute('autocomplete') === 'name' && t.q('label[for="raName"]'));
  check('note label', t.q('label[for="raNote"]').textContent.trim() === 'Who are you and how do you know us?');
  check('counter starts at 0/1000', t.q('#raCount').textContent === '0/1000');
  type(t, '#raNote', 'Hello');
  check('counter counts', t.q('#raCount').textContent === '5/1000');
  type(t, '#raName', '   ');
  await t.click('[data-ra-send]');
  check('an empty name is caught here', t.s.sent(SUBMIT).length === 0 && t.error() !== '' && t.doc.activeElement === t.q('#raName'));
  type(t, '#raName', ' Sam ');
  t.q('[data-ra-send]').click();
  t.q('[data-ra-send]').click();
  await flush();
  check('two presses, one send', t.s.sent(SUBMIT).length === 1, t.s.sent(SUBMIT));
  check('what was sent', JSON.stringify(t.s.sent(SUBMIT)[0].body) === JSON.stringify({ name: 'Sam', note: 'Hello' }));
  check('S4', t.step() === 'sent' && focusedOnHeading(t));
  check('S4 words', t.q('[data-ra-step="sent"]').textContent.indexOf('Watch your email for the Plex invite.') !== -1);
});

await run('the form: what the server can say', async (open) => {
  const cases = [
    [{ status: 400, body: { detail: 'Your Plex check timed out. Start again.' } }, 'intro', 'Your Plex check timed out. Start again.'],
    [{ status: 503, body: { detail: 'Lots of requests are arriving at once. Try again in a moment.' } }, 'form', 'Lots of requests are arriving at once. Try again in a moment.'],
    [{ status: 422, body: { detail: 'Enter your name (up to 80 characters).' } }, 'form', 'Enter your name (up to 80 characters).'],
    [{ status: 422, body: { detail: [{ msg: 'too long' }] } }, 'form', 'Check your name and your answer, then try again.'],
    [{ status: 429, body: { detail: 'Rate limit exceeded' } }, 'form', 'Too many tries. Wait a few minutes and try again.'],
    [{ body: { state: 'approved', sent: false } }, 'status', '']
  ];
  for (const [reply, where, words] of cases) {
    const t = await toForm(open, { [SUBMIT]: [reply] });
    type(t, '#raName', 'Sam');
    type(t, '#raNote', 'Hi');
    await t.click('[data-ra-send]');
    check(`${JSON.stringify(reply).slice(0, 60)}: ${where}`, t.step() === where && t.error() === words, [t.step(), t.error()]);
    check('the button works again', t.q('[data-ra-send]').disabled === false);
  }
});

// The cap is reached after the ticket was used (ruling 2026-10-10): the
// form can't be sent again, so the card ends there with Back to sign in.
await run('the form: the cap is reached', async (open) => {
  const FULL = 'We\'re not taking new requests right now. Try again later.';
  const t = await toForm(open, { [SUBMIT]: [{ status: 503, body: { detail: FULL } }] });
  type(t, '#raName', 'Sam');
  type(t, '#raNote', 'Hi');
  await t.click('[data-ra-send]');
  check('S5 says so', t.step() === 'status' && t.q('[data-ra-status]').textContent === FULL && t.error() === '',
    [t.step(), t.q('[data-ra-status]').textContent, t.error()]);
  check('focused on its heading', focusedOnHeading(t));
  const button = t.q('[data-ra-step="status"] [data-ra-back]');
  check('its button', button.textContent.trim() === 'Back to sign in');
  await t.click(button);
  check('back on the link', t.step() === 'signin' && t.doc.activeElement === t.q('#requestAccessLink'));
  check('one send only', t.s.sent(SUBMIT).length === 1);
});

await run('the form: closed while filling it in', async (open) => {
  const t = await toForm(open, { [SUBMIT]: [{ status: 403, body: { detail: 'Access requests are closed.' } }] });
  type(t, '#raName', 'Sam');
  type(t, '#raNote', 'Hi');
  await t.click('[data-ra-send]');
  check('S0 with why, no link', t.step() === 'signin' && t.q('#requestAccessLinkRow').hidden === true &&
    t.error() === 'Access requests are closed.', t.error());
  check('the line is on screen, under the sign-in form', !t.q('#raError').closest('#requestAccess') &&
    t.q('#loginForm').compareDocumentPosition(t.q('#raError')) === 4);
  check('focus on the first sign-in control', t.doc.activeElement === t.q('#username'));
});

await run('each status', async (open) => {
  const cases = [
    [{ state: 'pending', submitted_at: '2026-10-09T12:00:00.000Z' }, /^Your request is waiting for review\. Sent .*2026.*\.$/],
    [{ state: 'approved' }, /^You’re approved\. Accept the Plex invite from your email or a Plex app, then sign in here\.$/],
    [{ state: 'invited' }, /^You’re approved\. Accept the Plex invite from your email or a Plex app, then sign in here\.$/],
    [{ state: 'denied', can_ask_after: '2026-11-08T12:00:00.000Z' }, /^This request wasn’t approved\. You can ask again after .*2026.*\.$/],
    [{ state: 'blocked' }, /^This Plex account can’t request access\.$/],
    [{ state: 'member' }, /^You already have access\.$/]
  ];
  for (const [answer, words] of cases) {
    const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ body: Object.assign({ username: 'x', avatar_url: '' }, answer) }] } });
    await t.message(t.popups[0], { type: 'plex-access-complete' });
    const said = t.q('[data-ra-status]').textContent;
    check(`${answer.state}: S5`, t.step() === 'status' && focusedOnHeading(t));
    check(`${answer.state}: says so`, words.test(said), said);
    const button = t.q('[data-ra-step="status"] [data-ra-back]');
    check(`${answer.state}: its button`, button.textContent.trim() === (answer.state === 'member' ? 'Sign in' : 'Back to sign in'));
    if (answer.state === 'member') {
      await t.click(button);
      check('member: to S0, on the first sign-in control', t.step() === 'signin' && t.doc.activeElement === t.q('#username'));
    }
  }
});

await run('phone: away to Plex and back', async (open) => {
  const t = await open({ phone: true, width: 390, answers: { [PIN]: [PIN_OK] } });
  await t.click('#requestAccessLink');
  await t.click('[data-ra-plex]');
  check('no popup', t.opened.length === 0);
  check('the PIN is kept for the way back', t.w.sessionStorage.getItem('access_pin_id') === '4242');
  check('off to Plex', JSON.stringify(t.assigned) === JSON.stringify([AUTH_URL]), t.assigned);
});

await run('phone: back from Plex', async (open) => {
  const t = await open({ url: 'https://ws.test/login?access_request=complete', storedPin: '4242',
                         answers: { [IDENTIFY]: [{ body: { state: 'pending', username: 'x', avatar_url: '', submitted_at: '2026-10-09T12:00:00.000Z' } }] } });
  check('identify with the kept PIN', t.s.sent(IDENTIFY).length === 1 && t.s.sent(IDENTIFY)[0].body.pin_id === 4242);
  check('the query is gone and the step has its hash', t.w.location.search === '' && t.w.location.hash === '#request-access');
  check('the PIN is forgotten', t.w.sessionStorage.getItem('access_pin_id') === null);
  check('S5', t.step() === 'status');
});

await run('phone: back without the PIN', async (open) => {
  const t = await open({ url: 'https://ws.test/login?access_request=complete' });
  check('no identify', t.s.sent(IDENTIFY).length === 0);
  check('S1 says start again', t.step() === 'intro' && t.error() === 'That Plex sign-in expired. Start again.', t.error());
});

await run('text stays text', async (open) => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const t = await toWaiting(open, { answers: { [IDENTIFY]: [{ body: { state: 'new', username: evil, avatar_url: '' } }] } });
  await t.message(t.popups[0], { type: 'plex-access-complete' });
  check('shown as text', t.q('[data-ra-username]').textContent === evil && t.q('[data-ra-username]').children.length === 0);
  check('no avatar without a URL', t.q('[data-ra-avatar]').hidden === true);
});

console.log(`${total - failed}/${total} login request cases pass`);
if (failed) process.exit(1);
