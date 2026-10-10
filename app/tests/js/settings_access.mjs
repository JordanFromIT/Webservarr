// Settings > Access requests (app/static/js/settings/access-requests.js),
// run for real in happy-dom over Settings' own markup and the real kit, with
// a scripted server. Covers: the tab's count badge and its accessible name
// on any tab; the four cards; the switch's Plex note; the default libraries
// as settings (staged, saved through the bulk save); each waiting request
// shown as text (line breaks kept, markup not run); Approve (the dialog
// with the default libraries ticked, one dialog for two presses, at least
// one library, the share's outcome, Plex not listing libraries means no
// dialog); the failed share's reason and the copy button; Deny and Block;
// Unblock; a failed load and Try again; both dialogs opening on a choice,
// not their action, so one Enter shares or denies nothing.
// Run: node app/tests/js/settings_access.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const SETTINGS_HTML = readFileSync(join(STATIC, 'settings.html'), 'utf8');
const SRC = {};
for (const f of ['ui.js', 'settings/kit.js', 'settings/signin-rule.js', 'settings/access-requests.js']) {
  SRC[f] = readFileSync(join(STATIC, 'js', f), 'utf8');
}

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
const flush = async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setImmediate(r)); };
const MASK = '••••••••';
const LIBS = [{ key: '1', title: 'Movies', type: 'movie' }, { key: '2', title: 'TV', type: 'show' }];
const NOTE = 'Line one\nLine two <b>not bold</b>';

function request(id, extra = {}) {
  return Object.assign({ id, plex_username: 'user' + id, plex_email: `u${id}@example.com`, avatar_url: '',
    name: 'Name ' + id, note: NOTE, status: 'pending', share_state: null, share_error: null, library_keys: [],
    created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), decided_at: null, can_ask_after: null }, extra);
}

function makeServer(over = {}) {
  const s = Object.assign({
    calls: [], pending: [request(1), request(2)], decided: [], blocked: [request(9, { status: 'blocked', decided_at: new Date().toISOString() })],
    libsStatus: 200, listStatus: 200, approveReply: null,
    values: { 'access_requests.enabled': 'false', 'access_requests.default_libraries': '["1"]',
              'integration.plex.url': 'http://192.168.1.2:32400', 'integration.plex.token': MASK }
  }, over);
  s.fetch = (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    s.calls.push({ method, url: String(url), body });
    const u = new URL(String(url), 'https://ws.test');
    const reply = (status, b) => Promise.resolve({ ok: status >= 200 && status < 300, status,
      json: () => Promise.resolve(b), text: () => Promise.resolve(b === undefined ? '' : JSON.stringify(b)) });
    if (u.pathname === '/api/admin/settings' && u.search.indexOf('view=registry') !== -1) {
      const meta = {};
      for (const k of Object.keys(s.values)) meta[k] = { type: k.endsWith('enabled') ? 'bool' : 'text', default: '', secret: k.endsWith('token'), max_length: 2000 };
      return reply(200, { values: s.values, meta, mask: MASK, page_order: [], page_addresses: {}, address_credentials: {} });
    }
    if (u.pathname === '/api/admin/settings/bulk' && method === 'PUT') {
      for (const it of body.settings) s.values[it.key] = it.value;
      return reply(200, { values: Object.fromEntries(body.settings.map((it) => [it.key, it.value])) });
    }
    const base = '/api/admin/access-requests';
    if (u.pathname === base + '/count') return reply(200, { pending: s.pending.length });
    if (u.pathname === base + '/libraries') return s.libsStatus === 200 ? reply(200, { libraries: LIBS }) : reply(s.libsStatus, { detail: 'Plex didn\'t answer' });
    if (u.pathname === base && method === 'GET') {
      return s.listStatus === 200 ? reply(200, { pending: s.pending, decided: s.decided, blocked: s.blocked }) : reply(s.listStatus, { detail: 'down' });
    }
    const m = u.pathname.match(/^\/api\/admin\/access-requests\/(\d+)\/(approve|deny|unblock)$/);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      if (m[2] === 'unblock') { s.blocked = s.blocked.filter((r) => r.id !== id); return reply(200, { ok: true }); }
      const row = s.pending.find((r) => r.id === id);
      if (!row) return reply(409, { detail: 'That request was already answered.' });
      s.pending = s.pending.filter((r) => r.id !== id);
      if (m[2] === 'deny') {
        const done = Object.assign({}, row, { status: body.block ? 'blocked' : 'denied', decided_at: new Date().toISOString(),
          can_ask_after: body.block ? null : new Date(Date.now() + 30 * 86400000).toISOString() });
        (body.block ? s.blocked : s.decided).unshift(done);
        return reply(200, done);
      }
      const done = Object.assign({}, row, { status: 'approved', decided_at: new Date().toISOString(), library_keys: body.library_keys },
        s.approveReply || { share_state: 'shared', share_error: null });
      s.decided.unshift(done);
      return reply(200, done);
    }
    return reply(404, {});
  };
  return s;
}

async function visit(o = {}) {
  const url = o.url || 'https://ws.test/settings#access-requests';
  const win = new Window({ url });
  const doc = win.document;
  doc.body.innerHTML = SETTINGS_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
  const ctl = new win.AbortController();
  const server = o.server || makeServer();
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const clipboard = [];
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText(text) { clipboard.push(text); return Promise.resolve(); } }, configurable: true });
  set('window', win);
  set('document', doc);
  set('location', win.location);
  set('localStorage', win.localStorage);
  set('fetch', server.fetch);
  if (!process.env.DEBUG_TEST) set('console', { error() {}, warn() {}, log() {}, info() {}, debug() {} });
  set('ResizeObserver', class { observe() {} disconnect() {} });
  set('CustomEvent', win.CustomEvent);
  set('Event', win.Event);
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const run = (name) => new Function('window', 'document', 'localStorage', 'location', 'WSUI', 'WSSettings', 'fetch', SRC[name])(
    win, doc, win.localStorage, win.location, win.WSUI, win.WSSettings, globalThis.fetch);
  run('ui.js');
  run('settings/kit.js');
  run('settings/signin-rule.js');
  run('settings/access-requests.js');
  const toasts = [];
  const realToast = win.WSUI.toast;
  win.WSUI.toast = (m, kind) => { toasts.push([m, kind]); return realToast(m, kind); };
  const ctx = { signal: ctl.signal, url: new URL(url), setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
                clearTimeout: (id) => clearTimeout(id), poll() { return () => {}; }, beforeLeave() {}, onNavigate() {} };
  const t = {
    win, doc, server, toasts, clipboard, ctl,
    q: (sel) => doc.querySelector(sel),
    qa: (sel) => Array.from(doc.querySelectorAll(sel)),
    release() { for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; } },
    async open() { win.WSSettings.init(ctx); await new Promise((r) => setTimeout(r, 20)); await flush(); return t; },
    async press(sel) { (typeof sel === 'string' ? doc.querySelector(sel) : sel).click(); await new Promise((r) => setTimeout(r, 10)); await flush(); },
    // The open dialog: one that is closing fades out for a moment first.
    dialog: () => Array.from(doc.querySelectorAll('.ws-dialog:not(.is-closing) .ws-dialog-box')).pop() || null,
    button(box, words) { return Array.from(box.querySelectorAll('button')).find((b) => b.textContent.trim() === words); },
    calls: (method, path) => server.calls.filter((c) => c.method === method && c.url.indexOf(path) === 0)
  };
  return t;
}

async function run(name, fn) {
  current = name;
  const made = [];
  try { await fn(async (o) => { const t = await visit(o); made.push(t); return t.open(); }); }
  catch (e) { failed += 1; total += 1; console.error(`FAIL ${name}: threw ${e && e.stack || e}`); }
  finally { while (made.length) { const t = made.pop(); t.ctl.abort(); t.release(); } }
}

const panel = '[data-settings-panel="access-requests"]';
const tab = '#tab-access-requests';

await run('the badge, on any tab', async (open) => {
  const t = await open({ url: 'https://ws.test/settings#general' });
  const badge = t.q(`${tab} [data-tab-count]`);
  check('shows the count', !badge.hidden && badge.textContent === '2', badge.textContent);
  check('named for screen readers', t.q(tab).getAttribute('aria-label') === 'Access requests 2 waiting');
  check('the badge itself is not read twice', badge.getAttribute('aria-hidden') === 'true');
  const none = await open({ url: 'https://ws.test/settings#general', server: makeServer({ pending: [] }) });
  check('hidden at 0, no extra name', none.q(`${tab} [data-tab-count]`).hidden && !none.q(tab).hasAttribute('aria-label'));
});

await run('the panel', async (open) => {
  const t = await open();
  const heads = t.qa(`${panel} h2`).map((h) => h.textContent);
  check('four cards', JSON.stringify(heads) === JSON.stringify(['Sign-in page', 'Default libraries', 'Waiting', 'Decided']), heads);
  check('the switch', t.q(`${panel} [role="switch"]`) !== null);
  check('Plex is connected: no note', t.q('[data-ar-needs-plex]').hidden === true);
  const cards = t.qa('[data-ar-request]');
  check('pending in order', cards.map((c) => c.getAttribute('data-ar-request')).join() === '1,2');
  const note = cards[0].querySelector('[data-ar-note]');
  check('the note as text with its line breaks', note.textContent === NOTE && note.querySelector('b') === null);
  check('who and when', cards[0].textContent.indexOf('user1') !== -1 && cards[0].textContent.indexOf('u1@example.com') !== -1 &&
    cards[0].textContent.indexOf('Name 1') !== -1 && /Sent 3 hours ago/.test(cards[0].textContent), cards[0].textContent);
  check('named buttons', cards[0].querySelector('[data-ar-approve]').getAttribute('aria-label') === 'Approve user1');
  check('the blocked account with Unblock', t.q('[data-ar-decided-row="9"] [data-ar-unblock]') !== null);
});

await run('Plex not connected', async (open) => {
  const s = makeServer();
  s.values['integration.plex.token'] = '';
  const t = await open({ server: s });
  check('the switch says it needs Plex', t.q('[data-ar-needs-plex]').hidden === false);
});

await run('default libraries are a setting', async (open) => {
  const t = await open();
  const boxes = t.qa('[data-ar-defaults] input[type="checkbox"]');
  check('one per library, the saved one ticked', boxes.map((b) => b.value + ':' + b.checked).join() === '1:true,2:false');
  boxes[1].click();
  await flush();
  check('staged, the save bar up', t.q('#settingsSaveBar').hidden === false);
  const save = Array.from(t.doc.querySelectorAll('#settingsSaveBar button')).find((b) => /Save/.test(b.textContent));
  await t.press(save);
  const put = t.calls('PUT', '/api/admin/settings/bulk')[0];
  check('saved as a list', put && JSON.stringify(put.body.settings) === JSON.stringify([{ key: 'access_requests.default_libraries', value: '["1","2"]' }]), put && put.body);
});

await run('approve', async (open) => {
  const t = await open();
  const button = t.q('[data-ar-request="1"] [data-ar-approve]');
  await t.press(button);
  await t.press(button);
  check('one dialog for two presses', t.qa('.ws-dialog:not(.is-closing)').length === 1);
  const box = t.dialog();
  check('titled for the person', box.textContent.indexOf('Approve user1?') !== -1);
  const ticks = Array.from(box.querySelectorAll('input[type="checkbox"]'));
  check('the default library ticked', ticks.map((b) => b.value + ':' + b.checked).join() === '1:true,2:false');
  ticks[1].click();
  await t.press(t.button(box, 'Share and approve'));
  const post = t.calls('POST', '/api/admin/access-requests/1/approve');
  check('one approve with the ticked libraries', post.length === 1 && JSON.stringify(post[0].body) === JSON.stringify({ library_keys: ['1', '2'] }));
  check('said so', t.toasts.some(([m, k]) => m === 'Approved. Plex sent them an invite.' && k === 'ok'), t.toasts);
  check('moved to Decided', t.q('[data-ar-request="1"]') === null && t.q('[data-ar-decided-row="1"]') !== null);
  check('the badge follows', t.q(`${tab} [data-tab-count]`).textContent === '1');
});

await run('approve needs a library', async (open) => {
  const t = await open();
  await t.press('[data-ar-request="1"] [data-ar-approve]');
  const box = t.dialog();
  box.querySelector('input[type="checkbox"]').click();
  await t.press(t.button(box, 'Share and approve'));
  check('nothing sent', t.calls('POST', '/api/admin/access-requests/1/approve').length === 0);
  check('says why', t.toasts.some(([m]) => m === 'Pick at least one library.'));
  check('still waiting', t.q('[data-ar-request="1"]') !== null);
});

await run('Plex lists no libraries: no dialog', async (open) => {
  const t = await open({ server: makeServer({ libsStatus: 503 }) });
  const before = t.calls('GET', '/api/admin/access-requests/libraries').length;
  await t.press('[data-ar-request="1"] [data-ar-approve]');
  check('no dialog', t.dialog() === null);
  check('says why', t.toasts.some(([m, k]) => k === 'err' && /libraries/.test(m)), t.toasts);
  check('asks Plex again', t.calls('GET', '/api/admin/access-requests/libraries').length === before + 1);
  check('still waiting', t.q('[data-ar-request="1"]') !== null);
});

await run('a share that failed', async (open) => {
  const t = await open({ server: makeServer({ approveReply: { share_state: 'failed', share_error: 'Plex refused the share (HTTP 400)' } }) });
  await t.press('[data-ar-request="1"] [data-ar-approve]');
  await t.press(t.button(t.dialog(), 'Share and approve'));
  check('said so', t.toasts.some(([m, k]) => k === 'err' && /Share it in Plex yourself/.test(m)), t.toasts);
  const row = t.q('[data-ar-decided-row="1"]');
  check('the reason on the row', row.querySelector('[data-ar-share-error]').textContent === 'Plex refused the share (HTTP 400)');
  await t.press(row.querySelector('[data-ar-copy]'));
  check('the username copied', JSON.stringify(t.clipboard) === '["user1"]');
  check('confirmed', t.toasts.some(([m]) => m === 'Copied user1. Share your server with them in Plex.'));
});

await run('deny and block', async (open) => {
  const t = await open();
  await t.press('[data-ar-request="1"] [data-ar-deny]');
  await t.press(t.button(t.dialog(), 'Deny'));
  check('denied', JSON.stringify(t.calls('POST', '/api/admin/access-requests/1/deny')[0].body) === '{"block":false}');
  await t.press('[data-ar-request="2"] [data-ar-deny]');
  const box = t.dialog();
  check('the block choice', box.textContent.indexOf('Block this Plex account for good') !== -1);
  box.querySelector('[data-ar-block]').click();
  await t.press(t.button(box, 'Deny'));
  check('blocked', JSON.stringify(t.calls('POST', '/api/admin/access-requests/2/deny')[0].body) === '{"block":true}');
  check('both answered', t.qa('[data-ar-request]').length === 0);
});

await run('unblock', async (open) => {
  const t = await open();
  await t.press('[data-ar-decided-row="9"] [data-ar-unblock]');
  check('sent', t.calls('POST', '/api/admin/access-requests/9/unblock').length === 1);
  check('gone from the list', t.q('[data-ar-decided-row="9"]') === null);
});

await run('a failed load, then Try again', async (open) => {
  const s = makeServer({ listStatus: 503 });
  const t = await open({ server: s });
  const retry = Array.from(t.doc.querySelectorAll(`${panel} button`)).find((b) => b.textContent === 'Try again');
  check('says so with Try again', !!retry);
  s.listStatus = 200;
  await t.press(retry);
  check('then the list', t.qa('[data-ar-request]').length === 2);
});

await run('a dialog opens on its first choice, so Enter shares nothing', async (open) => {
  const t = await open();
  const enter = async (node) => {
    node.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    node.dispatchEvent(new t.win.KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10)); await flush();
  };
  await t.press('[data-ar-request="1"] [data-ar-approve]');
  let box = t.dialog();
  const firstLib = box.querySelector('input[type="checkbox"]');
  check('Approve starts on the first library', t.doc.activeElement === firstLib, t.doc.activeElement && t.doc.activeElement.outerHTML);
  await enter(t.doc.activeElement);
  check('Enter there approves nothing', t.calls('POST', '/api/admin/access-requests/1/approve').length === 0);
  check('the dialog stays open', t.dialog() === box);
  await t.press(t.button(box, 'Cancel'));
  await t.press('[data-ar-request="1"] [data-ar-deny]');
  box = t.dialog();
  check('Deny starts on the block box', t.doc.activeElement === box.querySelector('[data-ar-block]'), t.doc.activeElement && t.doc.activeElement.outerHTML);
  await enter(t.doc.activeElement);
  check('Enter there denies nothing', t.calls('POST', '/api/admin/access-requests/1/deny').length === 0);
  check('the deny dialog stays open', t.dialog() === box);
  await t.press(t.button(box, 'Cancel'));
  check('still waiting', t.q('[data-ar-request="1"]') !== null);
  // The shared dialog: initial is opt-in. 'title' starts on the heading; a
  // dialog without it still starts on its OK (or Cancel when danger).
  t.win.WSUI.confirm({ title: 'Heading start', body: 'x', initial: 'title' });
  await flush();
  check('initial title focuses the heading', t.doc.activeElement && t.doc.activeElement.tagName === 'H2' && t.doc.activeElement.textContent === 'Heading start');
  await t.press(t.button(t.dialog(), 'Cancel'));
  t.win.WSUI.confirm({ title: 'Plain', body: 'x', confirmLabel: 'OK here' });
  await flush();
  check('without it, OK as before', t.doc.activeElement && t.doc.activeElement.textContent === 'OK here');
  await t.press(t.button(t.dialog(), 'Cancel'));
  t.win.WSUI.confirm({ title: 'Danger', body: 'x', danger: true });
  await flush();
  check('danger, Cancel as before', t.doc.activeElement && t.doc.activeElement.textContent === 'Cancel');
  await t.press(t.button(t.dialog(), 'Cancel'));
});

console.log(`${total - failed}/${total} settings access cases pass`);
if (failed) process.exit(1);
