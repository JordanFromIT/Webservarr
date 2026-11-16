// Play history (app/static/js/play-history.js): the pure words and grouping,
// then the window run in happy-dom over the shell's own markup (the
// #wsHistory block in partials/shell-sidebar.html and the two entries), with
// a scripted /api/me/history, a stand-in for WSUI.modal and a fake player.
// Covers: the entries open it (focus back to the menu button), the skeleton
// and the list grouped by day, the filters, Load more and the end line, the
// empty and error states, Play from here (the player's own open first, then
// its seek to where the session ended, then play; a book already loaded is
// not opened again; a held book is left to the player), and the reader
// opening at the page in its address (page=), saved as a page jump.
// PLAY_HISTORY_JS=<path> / READER_JS=<path> run the same cases on other copies.
// Run: node app/tests/js/play_history.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
const H = await import(dataUrl(readFileSync(process.env.PLAY_HISTORY_JS || join(STATIC, 'js/play-history.js'), 'utf8')));
const reader = await import(dataUrl(readFileSync(process.env.READER_JS || join(STATIC, 'js/pages/reader.js'), 'utf8')));
const SIDEBAR = readFileSync(join(STATIC, 'partials/shell-sidebar.html'), 'utf8');
const HEADER = readFileSync(join(STATIC, 'partials/shell-header.html'), 'utf8');
const READER_HTML = readFileSync(join(STATIC, 'reader.html'), 'utf8');
const WINDOW_HTML = SIDEBAR.match(/<div id="wsHistory"[\s\S]*?\n<\/div>\n/)[0];

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
async function run(name, fn) {
  current = name;
  try {
    await fn();
  } catch (e) {
    failed += 1;
    total += 1;
    console.error(`FAIL ${name}: threw ${e && e.stack ? e.stack : e}`);
  }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

await run('words', async () => {
  check('book clock keeps its hours', H.bookClock(101154000) === '28:05:54' && H.bookClock(65000) === '0:01:05');
  check('spans', H.spanText(24 * 60000) === '24 min' && H.spanText(67 * 60000) === '1 h 7 min' && H.spanText(120 * 60000) === '2 h' && H.spanText(10000) === 'under a minute');
  check('a bare chapter number is named', H.chapterName('12') === 'Chapter 12' && H.chapterName('XIV') === 'Chapter XIV' && H.chapterName('Closing Credits') === 'Closing Credits');
  const now = new Date(2026, 10, 15, 21, 0).getTime();
  check('today and yesterday', H.dayLabel(new Date(2026, 10, 15, 0, 5).getTime(), now) === 'Today' && H.dayLabel(new Date(2026, 10, 14, 23, 59).getTime(), now) === 'Yesterday');
  const fri = H.dayLabel(new Date(2026, 10, 13, 9).getTime(), now);
  check('older days name the weekday and date', /13/.test(fri) && /Fri/.test(fri) && !/2026/.test(fri), fri);
  check('another year shows it', /2025/.test(H.dayLabel(new Date(2025, 11, 30).getTime(), now)));
  check('time of day in lower case', /^\d{1,2}:\d{2}( [ap]m)?$/.test(H.timeOfDay(new Date(2026, 10, 15, 19, 42).getTime())), H.timeOfDay(new Date(2026, 10, 15, 19, 42).getTime()));
  check('the API address', H.historyUrl('audio', null) === '/api/me/history?kind=audio&limit=20' &&
    H.historyUrl('films', 'x~a1') === '/api/me/history?kind=all&limit=20&before=x~a1');
});

const T = new Date(2026, 10, 15, 20, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();
function audio(id, endMs, extra) {
  return Object.assign({ kind: 'audio', id: 'a' + id, book_id: 1, title: 'This Inevitable Ruin', author: 'Matt Dinniman',
    cover_url: '/api/books/1/cover?v=1', book_url: '/books/1', plex_book_key: '100:1', start: iso(endMs - 24 * 60000),
    end: iso(endMs), listened_ms: 24 * 60000, device: 'Chrome on Android', chapter_label: 'Closing Credits',
    from_ms: 101110000, to_ms: 102554000, duration_ms: 103238000, place: { track: 't9', offset_ms: 4000 } }, extra || {});
}
function ebook(id, endMs, extra) {
  return Object.assign({ kind: 'ebook', id: 'e' + id, book_id: 2, title: 'Children of Time', author: 'Adrian Tchaikovsky',
    cover_url: '/api/books/2/cover?v=1', book_url: '/books/2', start: iso(endMs - 38 * 60000), end: iso(endMs),
    read_ms: 38 * 60000, chapter: 12, start_page: 121, end_page: 143, pages: 600,
    read_url: '/reader?seriesId=5&chapterId=70&page=143' }, extra || {});
}

await run('what a row says', async () => {
  const a = H.audioRow(audio(1, T));
  check('chapter and time left', a.where === 'Closing Credits' && a.left === '11 min left', a);
  check('the span, time listened and device', a.meta.join('|') === '28:05:10 to 28:29:14|Listened 24 min|Chrome on Android', a.meta);
  check('the bar: before and the session', Math.abs(a.bar.before - 97.93) < 0.01 && Math.abs(a.bar.width - 1.4) < 0.01, a.bar);
  check('the action names the book and the time', a.action === 'Play from here' && a.aria === 'Play This Inevitable Ruin from 28:29:14', a.aria);
  const unknown = H.audioRow(audio(2, T, { from_ms: null, to_ms: null, chapter_label: null }));
  check('no book time saved: no bar, no span', unknown.bar === null && unknown.meta[0] === 'Listened 24 min', unknown);
  const e = H.ebookRow(ebook(1, T));
  check('chapter, page and pages', e.where === 'Chapter 12, page 143' && e.left === 'of 600' && e.meta.join('|') === 'Pages 121 to 143|Read 38 min', e);
  check('the reading action', e.action === 'Continue reading from here' && e.aria === 'Continue reading Children of Time from chapter 12, page 143', e.aria);
  const plain = H.ebookRow(ebook(2, T, { chapter: null }));
  check('no chapter number: the page alone', plain.where === 'Page 143', plain.where);
});

await run('grouping by day keeps the order', async () => {
  const items = [audio(1, T), ebook(2, T - 3600000), audio(3, T - 26 * 3600000), audio(4, T - 50 * 3600000)];
  const days = H.groupByDay(items, T);
  check('three days', days.map((d) => d.label).slice(0, 2).join('|') === 'Today|Yesterday' && days.length === 3, days.map((d) => d.label));
  check('items stay newest first', days[0].items.map((i) => i.id).join() === 'a1,e2');
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

function page(opts) {
  opts = opts || {};
  const win = new Window({ url: 'https://ws.test/' });
  const doc = win.document;
  doc.body.innerHTML = HEADER.replace(/\{\{\{?\w+\}?\}\}/g, '') + '<button id="wsMoreBtn">More</button>' +
    '<dialog id="wsMoreSheet"><button type="button" class="ws-sheet-row" data-play-history>Play history</button></dialog>' + WINDOW_HTML;
  const calls = [];
  const queue = opts.answers || [];
  const fetchFn = (url) => {
    calls.push(String(url));
    const a = queue.length ? queue.shift() : { items: [], next_before: null, notes: [] };
    if (a instanceof Error) return Promise.reject(a);
    if (typeof a === 'number') return Promise.resolve({ ok: false, status: a, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(a) });
  };
  const modal = { opened: 0, closer: null };
  const env = {
    doc, win, fetch: fetchFn, now: () => T,
    modal(overlay, o) {
      modal.opened += 1;
      modal.previous = doc.activeElement;
      if (o.initial) o.initial.focus();
      let done = false;
      modal.closer = () => { if (done) return; done = true; o.onClose(); if (modal.previous) modal.previous.focus(); };
      return { close: modal.closer, release() {} };
    },
    player: () => opts.player || null,
    playerUI: () => opts.playerUI || null,
    closeChrome: () => { env.chromeClosed = (env.chromeClosed || 0) + 1; },
    reducedMotion: () => true
  };
  win.WSUI = { toast(text, tone) { (env.toasts = env.toasts || []).push([text, tone]); } };
  const h = H.createHistory(env);
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => Array.from(doc.querySelectorAll(s));
  const click = (n) => n.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  return { win, doc, h, env, calls, modal, $, $$, click };
}

await run('the account menu opens the window; focus goes to Close and comes back to the menu button', async () => {
  const p = page({ answers: [{ items: [audio(1, T), ebook(2, T - 3600000)], next_before: null, notes: [] }] });
  const entry = p.$('#userMenuDropdown [data-play-history]');
  check('the account menu has the entry above Welcome tour', !!entry && entry.nextElementSibling && /Welcome tour/.test(entry.nextElementSibling.textContent));
  p.click(entry);
  check('open, menus closed', !p.$('#wsHistory').hidden && p.env.chromeClosed === 1 && p.modal.opened === 1);
  check('focus on Close', p.doc.activeElement === p.$('.ws-hx-close'));
  check('the dialog remembers the menu button, not the hidden item', p.modal.previous === p.$('#userMenuBtn'));
  check('the skeleton holds the list while it loads', p.$$('#wsHxList .skel').length > 10 && !!p.$('#wsHxList [aria-busy="true"]'));
  check('asked for the first page of all', p.calls[0] === '/api/me/history?kind=all&limit=20');
  await flush();
  check('rows drawn under Today', p.$('.ws-hx-day-h').textContent === 'Today' && p.$$('.ws-hx-row').length === 2);
  const row = p.$$('.ws-hx-row')[0];
  check('title, time and where', row.querySelector('.ws-hx-name').textContent === 'This Inevitable Ruin' && /Closing Credits/.test(row.querySelector('.ws-hx-where').textContent));
  check('the bar is decorative', row.querySelector('.ws-hx-span').getAttribute('aria-hidden') === 'true');
  check('covers are sized before they load', row.querySelector('img').getAttribute('width') === '56' && p.$$('.ws-hx-row')[1].querySelector('img').getAttribute('height') === '66');
  const read = p.$$('.ws-hx-row')[1].querySelector('[data-hx-go]');
  check('the eBook action is the reader at the page', read.tagName === 'A' && read.getAttribute('href') === '/reader?seriesId=5&chapterId=70&page=143');
  check('Book page links the book', p.$$('.ws-hx-row')[1].querySelector('.is-quiet').getAttribute('href') === '/books/2');
  check('the end line', p.$('.ws-hx-end').textContent === 'That’s everything from the last 180 days.');
  p.click(p.$('.ws-hx-close'));
  check('Close hides it and focus goes back to the menu button', p.$('#wsHistory').hidden && p.doc.activeElement === p.$('#userMenuBtn'));
});

await run('More opens it too, and focus comes back to More', async () => {
  const p = page();
  p.click(p.$('#wsMoreSheet [data-play-history]'));
  check('open from More', !p.$('#wsHistory').hidden && p.modal.previous === p.$('#wsMoreBtn'));
  await flush();
  check('the empty state invites to browse', /Nothing here yet/.test(p.$('.ws-hx-state').textContent) && p.$('.ws-hx-state a').getAttribute('href') === '/books');
  p.click(p.$('.ws-hx-state a'));
  check('a link chosen closes the window', p.$('#wsHistory').hidden);
});

await run('filters, Load more and the end of the list', async () => {
  const p = page({ answers: [
    { items: [audio(1, T)], next_before: 'c1', notes: [] },
    { items: [ebook(2, T)], next_before: null, notes: [] },
    { items: [audio(3, T)], next_before: 'c3', notes: [] },
    { items: [audio(4, T - 26 * 3600000)], next_before: null, notes: [] }
  ] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  check('Load more while there is more', p.$('[data-hx-more]').textContent === 'Load more');
  p.click(p.$('[data-hx-filter="ebook"]'));
  check('the chip is pressed and the list reloads', p.$('[data-hx-filter="ebook"]').getAttribute('aria-pressed') === 'true' &&
    p.$('[data-hx-filter="all"]').getAttribute('aria-pressed') === 'false' && p.calls[1] === '/api/me/history?kind=ebook&limit=20');
  await flush();
  check('eBooks only', p.$$('.ws-hx-row').length === 1 && !!p.$('.ws-hx-cover.is-ebook'));
  p.click(p.$('[data-hx-filter="audio"]'));
  await flush();
  p.click(p.$('[data-hx-more]'));
  check('Load more asks past the cursor', p.calls[3] === '/api/me/history?kind=audio&limit=20&before=c3');
  check('and says so meanwhile', p.$('[data-hx-more]').getAttribute('aria-disabled') === 'true');
  await flush();
  check('the next page is added under its own day', p.$$('.ws-hx-row').length === 2 && p.$$('.ws-hx-day-h').map((n) => n.textContent).join('|') === 'Today|Yesterday');
  check('focus on the first new session', p.doc.activeElement === p.$$('.ws-hx-row')[1].querySelector('[data-hx-go]'));
  check('then the end line', !p.$('[data-hx-more]') && !!p.$('.ws-hx-end'));
});

await run('error and the filtered empty state', async () => {
  const p = page({ answers: [503, { items: [], next_before: null, notes: [] }, { items: [], next_before: null, notes: [] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  check('the error says what to do', /Your history didn’t load/.test(p.$('.ws-hx-state').textContent) && /Try again/.test(p.$('.ws-hx-state button').textContent));
  p.click(p.$('.ws-hx-state button'));
  await flush();
  check('Try again asks again', p.calls.length === 2 && /Nothing here yet/.test(p.$('.ws-hx-state').textContent));
  p.click(p.$('[data-hx-filter="audio"]'));
  await flush();
  check('a filter with nothing offers All', /No audiobook listening yet/.test(p.$('.ws-hx-state').textContent) && /Show all/.test(p.$('.ws-hx-state button').textContent));
});

await run('a source the server could not read: its note shows, and the list never claims to be everything', async () => {
  const down = { source: 'kavita', reason: 'unavailable', text: 'Ebooks are unavailable right now' };
  let p = page({ answers: [{ items: [audio(1, T)], next_before: null, notes: [down] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  check('the note is above the list', p.$('#wsHxList').firstElementChild.className === 'ws-hx-note' &&
    /Ebooks are unavailable right now\./.test(p.$('.ws-hx-note').textContent));
  check('the listening still shows', p.$$('.ws-hx-row').length === 1);
  check('no "everything" line', !p.$('.ws-hx-end'));
  p = page({ answers: [{ items: [], next_before: null, notes: [{ source: 'kavita', reason: 'not_connected', text: 'Connect to your ebook library to see your reading' }] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  check('with nothing to list too, the note still shows over the empty state', !!p.$('.ws-hx-note') && !!p.$('.ws-hx-state'));
  p = page({ answers: [{ items: [audio(1, T)], next_before: null, notes: [] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  check('every source answered: no note, and the end line', !p.$('.ws-hx-note') && !!p.$('.ws-hx-end'));
});

await run('an empty page with more behind it is read past, never shown as empty', async () => {
  let p = page({ answers: [
    { items: [], next_before: 'k1', notes: [] },
    { items: [], next_before: 'k2', notes: [] },
    { items: [ebook(2, T)], next_before: null, notes: [] }
  ] });
  p.h.open(p.$('#userMenuBtn'));
  check('still the skeleton while it reads on', !!p.$('#wsHxList [aria-busy="true"]'));
  await flush();
  check('it asked past each empty page', p.calls.join('|') === '/api/me/history?kind=all&limit=20|/api/me/history?kind=all&limit=20&before=k1|/api/me/history?kind=all&limit=20&before=k2', p.calls);
  check('and shows what it found', p.$$('.ws-hx-row').length === 1 && !p.$('.ws-hx-state'));
  const empties = [];
  for (let i = 0; i <= H.EMPTY_HOPS; i++) empties.push({ items: [], next_before: 'z' + i, notes: [] });
  p = page({ answers: empties.concat([{ items: [audio(1, T)], next_before: null, notes: [] }]) });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  check('a bounded number of reads', p.calls.length === H.EMPTY_HOPS + 1, p.calls);
  check('then a way on, not the empty state', /Load more/.test(p.$('.ws-hx-state').textContent) && !/Nothing here yet/.test(p.$('.ws-hx-state').textContent));
  p.click(p.$('.ws-hx-state button'));
  await flush();
  check('which reads on from there', p.calls[p.calls.length - 1] === '/api/me/history?kind=all&limit=20&before=z' + H.EMPTY_HOPS && p.$$('.ws-hx-row').length === 1, p.calls);
});

function fakePlayer(state) {
  const log = [];
  const p = {
    log,
    s: Object.assign({ book: null, error: null, safetyNet: null, filesChanged: null }, state || {}),
    state() { return Object.assign({}, p.s); },
    open(key, o) { log.push(['open', key, o]); p.s.book = key; return Promise.resolve(); },
    placeMs(track, offset) { log.push(['placeMs', track, offset]); return track === 't9' ? 50000 + offset : null; },
    seek(ms) { log.push(['seek', ms]); },
    play() { log.push(['play']); return Promise.resolve(); }
  };
  return p;
}

await run('Play from here: the player opens the book its own way, then moves to where the session ended', async () => {
  const player = fakePlayer();
  const ui = { n: 0, openOnStart() { ui.n += 1; } };
  const p = page({ player, playerUI: ui, answers: [{ items: [audio(1, T)], next_before: null, notes: [] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  const go = p.$('[data-hx-go]');
  check('a real button with a name', go.tagName === 'BUTTON' && go.getAttribute('aria-label') === 'Play This Inevitable Ruin from 28:29:14');
  p.click(go);
  check('the window goes first', p.$('#wsHistory').hidden);
  await flush();
  check('opened loaded but not playing, where they left off (no at)', JSON.stringify(player.log[0]) === JSON.stringify(['open', '100:1', { autoplay: false }]), player.log);
  check('the full player opens on a phone', ui.n === 1);
  check('then the seek to the session\'s end, then play', JSON.stringify(player.log.slice(1)) === JSON.stringify([['placeMs', 't9', 4000], ['seek', 54000], ['play']]), player.log);
});

await run('Play from here on a book already loaded does not open it again', async () => {
  const player = fakePlayer({ book: '100:1' });
  const p = page({ player, answers: [{ items: [audio(1, T)], next_before: null, notes: [] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  p.click(p.$('[data-hx-go]'));
  await flush();
  check('no open, just the move and play', !player.log.some((x) => x[0] === 'open') && player.log.some((x) => x[0] === 'seek'), player.log);
});

await run('Play from here leaves a held book to the player', async () => {
  const net = fakePlayer();
  net.open = (key) => { net.log.push(['open', key]); net.s.book = key; net.s.safetyNet = { orphans: [] }; return Promise.resolve(); };
  let p = page({ player: net, answers: [{ items: [audio(1, T)], next_before: null, notes: [] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  p.click(p.$('[data-hx-go]'));
  await flush();
  check('the safety net\'s question: no move, no play', !net.log.some((x) => x[0] === 'seek' || x[0] === 'play'), net.log);
  const gone = fakePlayer();
  p = page({ player: gone, answers: [{ items: [audio(1, T, { place: { track: 'old', offset_ms: 5 } })], next_before: null, notes: [] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  p.click(p.$('[data-hx-go]'));
  await flush();
  check('a place not in this copy: nothing moves, and it says so', !gone.log.some((x) => x[0] === 'seek') && p.env.toasts && /isn’t in this copy/.test(p.env.toasts[0][0]), p.env.toasts);
  const held = fakePlayer();
  held.open = (key) => { held.log.push(['open', key]); held.s.book = key; held.s.filesChanged = { spot: 0 }; return Promise.resolve(); };
  p = page({ player: held, answers: [{ items: [audio(1, T)], next_before: null, notes: [] }] });
  p.h.open(p.$('#userMenuBtn'));
  await flush();
  p.click(p.$('[data-hx-go]'));
  await flush();
  check('files changed: the move only sets the helper\'s spot, nothing plays', held.log.some((x) => x[0] === 'seek') && !held.log.some((x) => x[0] === 'play'), held.log);
});

// ---------------------------------------------------------------------------
// The reader opens at the page in its address
// ---------------------------------------------------------------------------

await run('the reader\'s page from the address', async () => {
  const q = (s) => new URLSearchParams(s);
  check('a page', reader.readerPage(q('seriesId=5&chapterId=7&page=143')) === 143);
  check('none, junk or zero is none', reader.readerPage(q('seriesId=5')) === null && reader.readerPage(q('page=abc')) === null &&
    reader.readerPage(q('page=0')) === null && reader.readerPage(q('page=-4')) === null);
  check('the target is unchanged by it', JSON.stringify(reader.readerTarget(q('seriesId=5&chapterId=77&page=3'))) === JSON.stringify({ seriesId: 5, chapterId: 77 }));
});

async function readerVisit(search) {
  const win = new Window({ url: 'https://ws.test/reader' + search });
  const doc = win.document;
  doc.body.innerHTML = READER_HTML.match(/<div id="wsPage"[\s\S]*<\/main>/)[0].replace(/<\/main>$/, '');
  const ctl = new win.AbortController();
  const calls = [];
  const posts = [];
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win); set('document', doc); set('localStorage', win.localStorage);
  set('getComputedStyle', win.getComputedStyle.bind(win));
  set('checkAuth', () => Promise.resolve());
  set('WS', { player: null, data: { user: { username: 'sam' } } });
  set('navigator', { sendBeacon() { return true; } });
  win.WS = g.WS;
  const answers = (url) => {
    if (/\/Book\/77\/book-info$/.test(url)) return { pages: 600, libraryId: 1, volumeId: 905, seriesId: 5, bookTitle: 'Children of Time' };
    if (/\/Book\/77\/book-page\?page=\d+$/.test(url)) return '<p>A page.</p>';
    if (/\/Book\/77\/chapters$/.test(url)) return [];
    if (/get-progress\?chapterId=77$/.test(url)) return JSON.stringify({ pageNum: 300 });
    if (/Reader\/progress$/.test(url)) return '';
    return null;
  };
  const fetchFn = (url, init) => {
    calls.push(String(url));
    if (init && init.method === 'POST') posts.push({ url: String(url), body: JSON.parse(init.body) });
    const a = answers(String(url));
    const ok = a !== null;
    return Promise.resolve({ ok, status: ok ? 200 : 404, json: () => Promise.resolve(a),
      text: () => Promise.resolve(typeof a === 'string' ? a : JSON.stringify(a)) });
  };
  set('fetch', fetchFn);
  win.fetch = fetchFn;
  const timers = [];
  const ctx = {
    root: doc.getElementById('wsPage'), signal: ctl.signal, url: new URL('https://ws.test/reader' + search),
    data: g.WS.data, poll() { return () => {}; },
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    setTitle() {}, beforeLeave() {}
  };
  let leave = null;
  const mounted = reader.mount(ctx).then((fn) => { leave = fn; });
  await flush();
  await flush();
  timers.splice(0).forEach((fn) => fn());     // the save's debounce
  await flush();
  const pageInfo = doc.getElementById('pageInfo').textContent;
  ctl.abort();
  await mounted;
  if (typeof leave === 'function') leave();
  await flush();
  for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; }
  return { calls, posts, pageInfo };
}

await run('the reader opens at page= and saves it as a page jump', async () => {
  const v = await readerVisit('?seriesId=5&chapterId=77&page=143');
  check('Kavita\'s place was still read first', v.calls.some((u) => /get-progress\?chapterId=77/.test(u)), v.calls);
  check('the page asked for is 143 (142 from 0), not Kavita\'s 300', v.calls.some((u) => /book-page\?page=142$/.test(u)) && !v.calls.some((u) => /book-page\?page=300$/.test(u)), v.calls);
  check('shown as 143 of 600', v.pageInfo.replace(/\s/g, '') === '143/600', v.pageInfo);
  const saves = v.posts.filter((x) => /Reader\/progress$/.test(x.url));
  check('and saved there', saves.length >= 1 && saves.every((x) => x.body.pageNum === 142), saves.map((x) => x.body));
  const plain = await readerVisit('?seriesId=5&chapterId=77');
  check('without page= it opens where Kavita has the reader, and saves nothing', plain.calls.some((u) => /book-page\?page=300$/.test(u)) &&
    !plain.posts.some((x) => /Reader\/progress$/.test(x.url)), plain.calls);
});

console.log(`play_history: ${total - failed}/${total} checks passed`);
if (failed) process.exit(1);
