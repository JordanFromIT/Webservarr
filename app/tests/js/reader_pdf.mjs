// The reader's PDF books (pages/reader-pdf.js, and pages/reader.js's PDF
// path): the sizing and swipe rules, the three-page window of drawn pages,
// the outline as contents, how PDF.js is asked to open the file, and the
// reader run in happy-dom over reader.html's own markup with a stand-in
// PDF.js (a data: module) and a scripted Kavita proxy. Covers: a PDF is
// told from book-info (no EPUB page or contents call is ever made for it),
// it opens at Kavita's place, a turn draws the next page and saves it 0-based,
// page= opens that page and saves it, a sample asks and saves nothing, text
// settings and bookmarks are off, the outline lists the contents, a 401
// goes round the Kavita hand-off, leaving closes the file, and an EPUB still
// loads PDF.js not at all.
// READER_JS=<path> / READER_PDF_JS=<path> run the same cases on other copies.
// Run: node app/tests/js/reader_pdf.mjs (npm run test:js; CI js-checks).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC = join(here, '../../static');
const dataUrl = (src) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
const PDF_SRC = readFileSync(process.env.READER_PDF_JS || join(STATIC, 'js/pages/reader-pdf.js'), 'utf8');
const P = await import(dataUrl(PDF_SRC));
const reader = await import(dataUrl(readFileSync(process.env.READER_JS || join(STATIC, 'js/pages/reader.js'), 'utf8')));
const READER_HTML = readFileSync(join(STATIC, 'reader.html'), 'utf8');

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
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// ---------------------------------------------------------------------------
// A stand-in PDF.js document: pages of 400 x 600 at scale 1, renders that
// finish when the test lets them (or at once), and an outline.
// ---------------------------------------------------------------------------

function fakeDoc(opts) {
  const o = Object.assign({ pages: 781, outline: [], hold: false, failOnce: false }, opts || {});
  const doc = {
    numPages: o.pages, renders: [], cancelled: [], held: [], cleaned: [],
    getPage(n) {
      return Promise.resolve({
        cleanup() { doc.cleaned.push(n - 1); return true; },
        getViewport({ scale }) { return { width: 400 * scale, height: 600 * scale, scale }; },
        render(params) {
          const entry = { page: n - 1, params };
          doc.renders.push(entry);
          let done;
          const promise = new Promise((resolve, reject) => { done = { resolve, reject }; });
          if (o.failOnce) { o.failOnce = false; done.reject(new Error('Bad XRef entry')); } else if (o.hold) doc.held.push(done); else done.resolve();
          return { promise, cancel() { doc.cancelled.push(n - 1); done.reject(new Error('cancelled')); } };
        }
      });
    },
    getOutline() { return Promise.resolve(o.outline); },
    getDestination(name) { return Promise.resolve(name === 'ch2' ? [{ num: 50 }, { name: 'XYZ' }] : null); },
    getPageIndex(ref) { return Promise.resolve(ref.num); }
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

await run('rules', async () => {
  check('a PDF is Kavita\'s format 4', reader.isPdfBook({ seriesFormat: 4 }) && !reader.isPdfBook({ seriesFormat: 3 }) &&
    !reader.isPdfBook({}) && !reader.isPdfBook(null));
  check('a phone fits the width', P.fitScale(400, 600, { width: 390, height: 500, phone: true }) === 390 / 400);
  check('a wide screen fits the whole page', P.fitScale(400, 600, { width: 1392, height: 776, phone: false }) === 776 / 600);
  check('and the width when that is the tighter', P.fitScale(400, 600, { width: 300, height: 776, phone: false }) === 300 / 400);
  check('the screen\'s own pixel ratio', P.backingRatio(2, 500, 750) === 2 && P.backingRatio(undefined, 500, 750) === 1);
  check('held to 3', P.backingRatio(4, 300, 400) === 3);
  const big = P.backingRatio(3, 2000, 3000);
  check('and to the pixel budget', Math.abs(2000 * 3000 * big * big - P.MAX_BACKING_PIXELS) < 1 && big < 3, big);
  check('a quick sideways swipe left turns forward', P.swipeTurn(-120, 10, 200) === 1);
  check('right turns back', P.swipeTurn(90, -20, 300) === -1);
  check('short, slow or mostly up and down does not', P.swipeTurn(-30, 0, 100) === 0 && P.swipeTurn(-200, 0, 1200) === 0 &&
    P.swipeTurn(-80, 70, 200) === 0);
  check('kept pages are the neighbours, inside the book', JSON.stringify(P.keptPages(0, 10)) === '[0,1]' &&
    JSON.stringify(P.keptPages(5, 10)) === '[4,5,6]' && JSON.stringify(P.keptPages(9, 10)) === '[8,9]');
  check('nothing at import time', !('document' in globalThis));
});

// ---------------------------------------------------------------------------
// The window of drawn pages
// ---------------------------------------------------------------------------

const win0 = new Window({ url: 'https://ws.test/reader' });
const room = { width: 390, height: 600, phone: true, ratio: 2 };

await run('only the page and its neighbours are drawn', async () => {
  const doc = fakeDoc();
  const book = P.pdfBook(doc, win0.document);
  check('the count is the file\'s', book.pages === 781);
  const canvas = await book.draw(10, room);
  await flush();
  check('page 11 and both neighbours drawn', JSON.stringify(doc.renders.map((r) => r.page).sort((a, b) => a - b)) === '[9,10,11]',
    doc.renders.map((r) => r.page));
  check('sized to the phone\'s width, backed at its ratio', canvas.style.width === '390px' && canvas.width === 780 &&
    canvas.style.height === '585px' && canvas.height === 1170, [canvas.style.width, canvas.width, canvas.style.height, canvas.height]);
  check('drawn at the backing scale', doc.renders.find((r) => r.page === 10).params.viewport.scale === (390 / 400) * 2);
  check('a neighbour answers at once', book.drawn(11, room) && !book.drawn(12, room));
  const again = doc.renders.length;
  await book.draw(11, room);
  await flush();
  check('turning to it draws only the next one', doc.renders.length === again + 1 && doc.renders[doc.renders.length - 1].page === 12);
  check('a new room is drawn again', !book.drawn(11, Object.assign({}, room, { width: 500 })));
  const jump = doc.renders.length;
  await book.draw(500, room);
  await flush();
  check('a jump draws the new window only', doc.renders.slice(jump).map((r) => r.page).sort((a, b) => a - b).join() === '499,500,501');
  check('and lets the old window go', !book.drawn(11, room) && !book.drawn(12, room));
  const ends = P.pdfBook(fakeDoc({ pages: 3 }), win0.document);
  await ends.draw(0, room);
  await flush();
  check('the first page has one neighbour', ends.drawn(1, room) && !ends.drawn(-1, room));
});

await run('the room a page is drawn for', async () => {
  const phone = { width: 390, height: 700, phone: true, ratio: 3 };
  check('a phone\'s height does not count (fitted to the width)', P.roomKey(phone) === P.roomKey(Object.assign({}, phone, { height: 760 })));
  check('its width and ratio do', P.roomKey(phone) !== P.roomKey(Object.assign({}, phone, { width: 412 })) &&
    P.roomKey(phone) !== P.roomKey(Object.assign({}, phone, { ratio: 2 })));
  const wide = { width: 1392, height: 776, phone: false, ratio: 1 };
  check('a wide screen\'s height does', P.roomKey(wide) !== P.roomKey(Object.assign({}, wide, { height: 700 })));
  const doc = fakeDoc();
  const book = P.pdfBook(doc, win0.document);
  await book.draw(10, phone);
  await flush();
  const renders = doc.renders.length;
  check('a phone toolbar sliding away draws nothing again', book.drawn(10, Object.assign({}, phone, { height: 760 })) && doc.renders.length === renders);
});

await run('a page let go is cleaned up in PDF.js', async () => {
  const doc = fakeDoc();
  const book = P.pdfBook(doc, win0.document);
  await book.draw(10, room);
  await flush();
  check('nothing cleaned while kept', doc.cleaned.length === 0, doc.cleaned);
  await book.draw(400, room);
  await flush();
  check('the old window\'s pages are', [9, 10, 11].every((i) => doc.cleaned.includes(i)) && !doc.cleaned.includes(400), doc.cleaned);
  const held = fakeDoc({ hold: true });
  const slow = P.pdfBook(held, win0.document);
  slow.draw(10, room).then(null, () => {});
  await flush();
  slow.draw(300, room).then(null, () => {});
  await flush();
  check('a page still drawing is cancelled, then cleaned', held.cancelled.includes(10) && held.cleaned.includes(10), [held.cancelled, held.cleaned]);
});

await run('a page let go while drawing is cancelled', async () => {
  const doc = fakeDoc({ hold: true });
  const book = P.pdfBook(doc, win0.document);
  const first = book.draw(10, room).then(() => 'drawn', () => 'refused');
  await flush();
  book.draw(300, room).then(null, () => {});
  await flush();
  check('its render was cancelled', doc.cancelled.includes(10), doc.cancelled);
  check('and its draw refused', (await first) === 'refused');
});

await run('the outline is the contents', async () => {
  const outline = [
    { title: 'One', dest: [{ num: 3 }, { name: 'XYZ' }], items: [] },
    { title: 'Two', dest: 'ch2', items: [{ title: 'Two, part', dest: [7], items: [] }] },
    { title: 'Lost', dest: 'nowhere', items: [{ title: 'Found', dest: [{ num: 60 }], items: [] }] },
    { title: 'Gone', dest: 'nowhere', items: [] }
  ];
  const list = await P.pdfBook(fakeDoc({ outline }), win0.document).contents();
  check('titles and pages from 0', JSON.stringify(list.map((n) => [n.title, n.page])) === '[["One",3],["Two",50],["Lost",60]]', list);
  check('children kept', list[1].children.length === 1 && list[1].children[0].page === 7);
  check('none is an empty list', (await P.pdfBook(fakeDoc({ outline: null }), win0.document).contents()).length === 0);
});

await run('how PDF.js is asked', async () => {
  const asked = [];
  let destroyed = 0;
  const doc = fakeDoc({ pages: 12 });
  const lib = {
    GlobalWorkerOptions: {},
    getDocument(src) { asked.push(src); return { promise: Promise.resolve(doc), destroy() { destroyed += 1; } }; }
  };
  const ctl = new AbortController();
  const book = await P.openPdf(lib, { url: '/kavita/api/Reader/pdf?chapterId=198', workerSrc: '/w.mjs?v=1', assets: '/static/vendor/pdfjs/',
    signal: ctl.signal, document: win0.document });
  const src = asked[0];
  check('the worker from the stamped address', lib.GlobalWorkerOptions.workerSrc === '/w.mjs?v=1');
  check('the proxy\'s file in 1 MB ranges, nothing fetched ahead', src.url === '/kavita/api/Reader/pdf?chapterId=198' &&
    src.rangeChunkSize === 1048576 && src.disableAutoFetch === true && src.disableStream === true, src);
  check('no WebAssembly; the vendored decoders, fonts and cmaps', src.useWasm === false && src.wasmUrl === '/static/vendor/pdfjs/wasm/' &&
    src.standardFontDataUrl === '/static/vendor/pdfjs/standard_fonts/' && src.cMapUrl === '/static/vendor/pdfjs/cmaps/', src);
  check('the book', book.pages === 12);
  check('open until the visit ends', destroyed === 0);
  ctl.abort();
  check('then closed', destroyed === 1);
});

// ---------------------------------------------------------------------------
// The reader on a PDF
// ---------------------------------------------------------------------------

// The stand-in PDF.js the reader imports: it hands each getDocument to the
// test's hook on globalThis.
const FAKE_PDFJS = 'export const GlobalWorkerOptions = {};\n' +
  'export function getDocument(src) { return globalThis.__readerPdfTest(src); }\n';

async function readerVisit(search, opts) {
  // progress: Kavita's saved pageNum, which counts a PDF's pages from 1 (11:
  // the 11th page) and an EPUB's from 0. A save moves it, as Kavita does.
  const o = Object.assign({ format: 4, progress: 11, outline: [], openStatus: 0, hold: false, failPageOnce: false }, opts || {});
  const win = new Window({ url: 'https://ws.test/reader' + search, width: o.width || 390, height: o.height || 844 });
  const doc = win.document;
  Object.defineProperty(doc.documentElement, 'clientWidth', { get: () => win.innerWidth, configurable: true });
  doc.body.innerHTML = READER_HTML.match(/<div id="wsPage"[\s\S]*<\/main>/)[0].replace(/<\/main>$/, '');
  doc.getElementById('readerPdfJs').setAttribute('data-ws-dep', dataUrl(PDF_SRC));
  doc.getElementById('pdfjsLib').setAttribute('data-ws-dep', dataUrl(FAKE_PDFJS + '// ' + Math.random()));
  doc.getElementById('pdfjsWorker').setAttribute('data-ws-dep', '/static/vendor/pdfjs/pdf.worker.min.mjs?v=x');
  const ctl = new win.AbortController();
  const calls = [];
  const posts = [];
  const opened = [];
  const pdf = fakeDoc({ pages: 781, outline: o.outline, hold: o.hold, failOnce: o.failRenderOnce });
  let destroyed = 0;
  let reconnects = 0;
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(g, k); Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  set('window', win); set('document', doc); set('localStorage', win.localStorage);
  set('getComputedStyle', win.getComputedStyle.bind(win));
  set('checkAuth', () => Promise.resolve());
  set('WS', { player: null, data: { user: { username: 'sam' } } });
  set('navigator', { sendBeacon() { return true; } });
  set('__readerPdfTest', (src) => {
    opened.push(src);
    const failure = o.openStatus ? Object.assign(new Error('Unexpected server response (' + o.openStatus + ')'), { status: o.openStatus }) : null;
    return { promise: failure ? Promise.reject(failure) : Promise.resolve(pdf), destroy() { destroyed += 1; } };
  });
  win.WS = g.WS;
  win.WSKavita = { init() {}, reconnect() { reconnects += 1; } };
  const answers = (url) => {
    if (/\/Book\/198\/book-info$/.test(url)) {
      return { pages: 781, libraryId: 1, volumeId: 197, seriesId: 130, seriesFormat: o.format, bookTitle: 'Harry Potter and the Deathly Hallows' };
    }
    if (/\/Book\/198\/book-page\?page=\d+$/.test(url)) {
      if (o.failPageOnce) { o.failPageOnce = false; return null; }
      return '<p>A page.</p>';
    }
    if (/\/Book\/198\/chapters$/.test(url)) return [{ title: 'Kavita\'s chapter', page: 2 }];
    if (/get-progress\?chapterId=198$/.test(url)) return JSON.stringify({ pageNum: o.progress });
    if (/Reader\/progress(\?format=pdf)?$/.test(url)) return '';
    return null;
  };
  const fetchFn = (url, init) => {
    calls.push(String(url));
    if (init && init.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      if (/Reader\/progress(\?format=pdf)?$/.test(String(url))) o.progress = JSON.parse(init.body).pageNum;
    }
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
  for (let i = 0; i < 4; i++) await flush();
  const $ = (id) => doc.getElementById(id);
  const visit = {
    calls, posts, opened, pdf, doc, $, win, get kavitaPage() { return o.progress; },
    get reconnects() { return reconnects; },
    get destroyed() { return destroyed; },
    pageInfo: () => $('pageInfo').textContent.replace(/\s/g, ''),
    async settle() { await flush(); timers.splice(0).forEach((fn) => fn()); await flush(); },
    async end() {
      ctl.abort();
      await mounted;
      if (typeof leave === 'function') leave();
      await flush();
      for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(g, k, saved[k]); else delete g[k]; }
    }
  };
  return visit;
}

const drawnPages = (v) => v.pdf.renders.map((r) => r.page);
const saves = (v) => v.posts.filter((x) => /Reader\/progress(\?format=pdf)?$/.test(x.url)).map((x) => x.body.pageNum);

await run('a PDF opens at Kavita\'s place, drawn by PDF.js', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198');
  try {
    check('the proxy\'s file for the chapter', v.opened.length === 1 && v.opened[0].url === '/kavita/api/Reader/pdf?chapterId=198', v.opened);
    check('never an EPUB page or Kavita\'s contents', !v.calls.some((u) => /book-page|\/chapters/.test(u)), v.calls);
    check('Kavita\'s place was read', v.calls.some((u) => /get-progress\?chapterId=198/.test(u)));
    check('page 11 drawn, with its neighbours', drawnPages(v).includes(10) && drawnPages(v).includes(9) && drawnPages(v).includes(11), drawnPages(v));
    check('on screen as 11 of 781', v.pageInfo() === '11/781', v.pageInfo());
    check('the canvas is in the PDF panel, the EPUB panel hidden', v.$('pdfContent').querySelector('canvas') &&
      !v.$('pdfContent').classList.contains('hidden') && v.$('bookContent').classList.contains('hidden'));
    check('text settings and bookmarks off', v.$('textSettings').hidden === true && v.$('bookmarkBtn').hidden === true);
    await v.settle();
    check('opening saves nothing', saves(v).length === 0, saves(v));

    v.$('navNext').click();
    await flush();
    check('a turn shows 12', v.pageInfo() === '12/781', v.pageInfo());
    check('without the spinner (it was drawn already)', v.$('loading').classList.contains('hidden'));
    await v.settle();
    check('and saves it as Kavita counts a PDF\'s pages, from 1', JSON.stringify(saves(v)) === '[12]', saves(v));
    check('telling the proxy it is a PDF (for Right now)', v.posts.every((x) => /\/kavita\/api\/Reader\/progress\?format=pdf$/.test(x.url)), v.posts.map((x) => x.url));

    v.doc.dispatchEvent(new v.win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await v.settle();
    check('the arrow key turns back', v.pageInfo() === '11/781' && saves(v)[saves(v).length - 1] === 11, [v.pageInfo(), saves(v)]);
    for (let i = 0; i < 3; i++) { v.$('pageJumpInput').value = '781'; v.$('pageJumpForm').dispatchEvent(new v.win.Event('submit', { cancelable: true })); }
    await v.settle();
    check('the last page saves the page count, so Kavita marks it read', v.pageInfo() === '781/781' && saves(v)[saves(v).length - 1] === 781,
      [v.pageInfo(), saves(v)]);
  } finally {
    await v.end();
  }
  check('leaving closes the file', v.destroyed === 1);
});

await run('page= opens that page and saves it', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198&page=20');
  try {
    check('Kavita\'s place was still read', v.calls.some((u) => /get-progress\?chapterId=198/.test(u)));
    check('page 20 (19 from 0) drawn, not Kavita\'s 11', v.pageInfo() === '20/781' && drawnPages(v).includes(19), [v.pageInfo(), drawnPages(v)]);
    await v.settle();
    check('saved as a page jump (Kavita\'s 20)', saves(v).length >= 1 && saves(v).every((p) => p === 20), saves(v));
    check('and page= has left the address, so a reload opens Kavita\'s place', v.win.location.search === '?seriesId=130&chapterId=198', v.win.location.search);
  } finally {
    await v.end();
  }
});

await run('a sample asks and saves nothing', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198&sample=1');
  try {
    check('opens at the first page', v.pageInfo() === '1/781', v.pageInfo());
    check('never asks Kavita where the reader is', !v.calls.some((u) => /get-progress/.test(u)), v.calls);
    v.$('navNext').click();
    await v.settle();
    check('turns', v.pageInfo() === '2/781');
    check('and saves nothing', v.posts.length === 0, v.posts);
  } finally {
    await v.end();
  }
  check('nothing after leaving either', v.posts.length === 0);
});

await run('the outline lists the contents', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198', { outline: [{ title: 'Chapter Two', dest: [{ num: 40 }], items: [] }] });
  try {
    const links = Array.from(v.$('tocList').querySelectorAll('a'));
    check('one entry, the outline\'s', links.length === 1 && links[0].textContent === 'Chapter Two', links.map((a) => a.textContent));
    links[0].click();
    await v.settle();
    check('it goes to its page', v.pageInfo() === '41/781' && saves(v)[saves(v).length - 1] === 41, [v.pageInfo(), saves(v)]);
  } finally {
    await v.end();
  }
});

await run('a refused sign-in goes round the hand-off', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198', { openStatus: 401 });
  try {
    check('reconnects', v.reconnects === 1);
    check('and shows no error of its own', v.$('errorState').classList.contains('hidden'));
  } finally {
    await v.end();
  }
  const hidden = await readerVisit('?seriesId=130&chapterId=198', { openStatus: 404 });
  try {
    check('any other refusal is the book\'s error', !hidden.$('errorState').classList.contains('hidden') && hidden.reconnects === 0);
  } finally {
    await hidden.end();
  }
});

await run('an EPUB is untouched', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198', { format: 3, progress: 10 });
  try {
    check('PDF.js never opened', v.opened.length === 0);
    check('Kavita\'s page and contents asked for', v.calls.some((u) => /book-page\?page=10$/.test(u)) && v.calls.some((u) => /\/chapters$/.test(u)), v.calls);
    check('the HTML in the EPUB panel', v.$('bookContent').textContent.includes('A page.') && v.$('pdfContent').classList.contains('hidden'));
    check('text settings and bookmarks on', v.$('textSettings').hidden === false && v.$('bookmarkBtn').hidden === false);
  } finally {
    await v.end();
  }
});

await run('an EPUB\'s pages are saved from 0, as before', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198', { format: 3, progress: 10 });
  try {
    check('opens at Kavita\'s 10 as page 11', v.pageInfo() === '11/781', v.pageInfo());
    v.$('navNext').click();
    await v.settle();
    check('a turn to 12 saves 11', JSON.stringify(saves(v)) === '[11]', saves(v));
    check('to the plain address', v.posts.every((x) => /\/kavita\/api\/Reader\/progress$/.test(x.url)), v.posts.map((x) => x.url));
  } finally {
    await v.end();
  }
});

await run('a resize redraws only when the room changed, and keeps the place', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198');
  const scrolls = [];
  v.win.scrollTo = (x, y) => { scrolls.push([x, y]); };
  try {
    await v.settle();
    const before = v.pdf.renders.length;
    v.win.dispatchEvent(new v.win.Event('resize'));
    await v.settle();
    check('the same size: nothing drawn, no jump to the top', v.pdf.renders.length === before && scrolls.length === 0, [v.pdf.renders.length - before, scrolls]);
    v.win.happyDOM.setViewport({ width: 390, height: 900 });
    v.win.dispatchEvent(new v.win.Event('resize'));
    await v.settle();
    check('a phone\'s height only (the toolbar sliding away): the same', v.pdf.renders.length === before && scrolls.length === 0,
      [v.pdf.renders.length - before, scrolls]);
    v.win.happyDOM.setViewport({ width: 412, height: 900 });
    v.win.dispatchEvent(new v.win.Event('resize'));
    await v.settle();
    const canvas = v.$('pdfContent').querySelector('canvas');
    check('a new width draws the page again at it', v.pdf.renders.length > before && canvas.style.width === '412px', [v.pdf.renders.length - before, canvas.style.width]);
    check('still the same page, kept where it was scrolled, never the spinner', v.pageInfo() === '11/781' && scrolls.length === 0 &&
      v.$('loading').classList.contains('hidden'), [v.pageInfo(), scrolls]);
    check('and a redraw saves nothing', saves(v).length === 0, saves(v));
    v.$('navNext').click();
    await v.settle();
    check('a turn still starts the new page at its top', scrolls.length === 1, scrolls);
  } finally {
    await v.end();
  }
});

await run('a resize during a page load is drawn once the page is up', async () => {
  const v = await readerVisit('?seriesId=130&chapterId=198', { hold: true });
  try {
    check('the first page is still drawing', !v.$('loading').classList.contains('hidden') && v.pdf.held.length > 0);
    v.win.happyDOM.setViewport({ width: 844, height: 390 });       // turned to landscape
    v.win.dispatchEvent(new v.win.Event('resize'));
    await v.settle();
    for (let i = 0; i < 4; i++) { v.pdf.held.splice(0).forEach((d) => d.resolve()); await v.settle(); }
    const canvas = v.$('pdfContent').querySelector('canvas');
    // 844 wide is not a phone: the whole page fits 390 - 56 - 12 - 56 = 266 high.
    check('page 11 is drawn for the new window', v.pageInfo() === '11/781' && canvas && canvas.style.height === '266px',
      canvas && [canvas.style.width, canvas.style.height]);
  } finally {
    await v.end();
  }
});

for (const [format, name, opts] of [[3, 'EPUB', { failPageOnce: true, progress: 10 }], [4, 'PDF', { failRenderOnce: true }]]) {
  await run(`${name}: page= is taken on the first page shown, even after Try again`, async () => {
    const v = await readerVisit('?seriesId=130&chapterId=198&page=143', Object.assign({ format }, opts));
    let href;
    try {
      check('the first load failed', !v.$('errorState').classList.contains('hidden'));
      check('nothing saved, page= kept meanwhile', saves(v).length === 0 && /page=143/.test(v.win.location.search), [saves(v), v.win.location.search]);
      v.$('errorRetry').click();
      await v.settle();
      const at = format === 4 ? 143 : 142;
      check('Try again shows 143 and saves it', v.pageInfo() === '143/781' && saves(v).length === 1 && saves(v)[0] === at, [v.pageInfo(), saves(v)]);
      check('and page= has left the address', v.win.location.search === '?seriesId=130&chapterId=198', v.win.location.search);
      v.$('pageJumpInput').value = '200';
      v.$('pageJumpForm').dispatchEvent(new v.win.Event('submit', { cancelable: true }));
      await v.settle();
      href = v.win.location.search;
    } finally {
      await v.end();
    }
    const held = v.kavitaPage;
    const again = await readerVisit(href, { format, progress: held });
    try {
      await again.settle();
      check('a reload opens at the newer 200 and saves nothing', again.pageInfo() === '200/781' && saves(again).length === 0,
        [again.pageInfo(), saves(again)]);
    } finally {
      await again.end();
    }
  });
}

console.log(`reader_pdf: ${total - failed}/${total} checks passed`);
if (failed) process.exit(1);
