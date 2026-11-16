/**
 * WebServarr — eBook reader (page module)
 *
 * One book from Kavita, a page at a time: edge and key page turns, the
 * contents, a page jump, bookmarks, reading settings and the reader's guide.
 * The reading position lives in Kavita: saved a few seconds after each turn,
 * and once more when the reader is left.
 *
 * A PDF book (Kavita's format 4 in book-info) is the same reader with its
 * pages drawn in the browser by PDF.js (pages/reader-pdf.js, loaded only
 * then), from the file Kavita serves through the proxy: Kavita's page API
 * reads only EPUBs. Its pages are numbered as the EPUB path numbers them
 * (from 0 to Kavita, from 1 on screen and in page=), its place is saved the
 * same way, and the contents are the PDF's own outline. Text settings and
 * bookmarks are off for it: its pages are drawn as the file has them, and a
 * Kavita bookmark is a picture of a page Kavita would have to cut out.
 *
 * A full-screen view inside the site's one document: the server marks the
 * page <html data-shell="hidden"> (the sidebar, header and phone bar hidden,
 * #wsPlayer left on screen), and the router brings that in step on every
 * swap, so an audiobook keeps playing while a book is open.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal (the key, visibility and pagehide listeners included), with
 * one deliberate exception: the progress writes. Each is a keepalive request
 * off the signal, one at a time (progressWriter), so a write in flight when
 * the reader is left still lands, and the last save, which the cleanup this
 * mount returns sends after it, lands last. Each has its own deadline, whose
 * timer is the one timer here not the visit's. They touch nothing on the page.
 * The reading settings are set on #wsPage, so they go with the page.
 *
 * A page in the address (/reader?seriesId=&chapterId=&page=N, from 1: Play
 * history's "Continue reading from here") opens the book at that page, after
 * Kavita's own place has been read, and saves it as a page jump does. Only
 * when Play history marked it (takeStartPage): a link from anywhere else
 * must not move a reader's place, so an unmarked page= is ignored. Either
 * way it leaves the address (dropStartPage), so it is used once.
 *
 * Sample mode (/reader?seriesId=&chapterId=&sample=1, books spec 3b section
 * 7, "Read a sample"): the same reader, read-only. It opens at the first
 * page and never asks Kavita where the reader is (no get-progress), never
 * writes a position (no progress POST, no beacon, no last save: there is no
 * writer, and the position is never known), and bookmarks are off. A
 * "Sample" banner offers Start reading (the same address without sample=1)
 * and Close (back). The browser is what enforces it: a hand-made request
 * through the proxy can still write, which the spec accepts.
 */

const PREFS_KEY = 'webservarr_reader_prefs';
const SAVE_DEBOUNCE_MS = 5000;

const CONNECT_TITLE = "Couldn't open this book";
const CONNECT_MESSAGE = "We couldn't connect you to the eBook library right now. Please try again in a few minutes.";

const THEMES = {
  site:  null,                                  // follow the site theme
  light: { bg: '#FBFAF7', fg: '#1A1A1A' },
  sepia: { bg: '#F4ECD8', fg: '#4A3B28' },
  dark:  { bg: '#111315', fg: '#D6D6D6' },
  // True #000 so OLED pixels switch off entirely. Text is held slightly below
  // pure white: full-contrast white on black haloes badly on OLED.
  black: { bg: '#000000', fg: '#C9CCD1' }
};

// One of these at a time, so a stale error never sits above a working page.
// A book's page shows in bookContent (an EPUB's HTML) or pdfContent (a PDF's
// drawn page).
const PANELS = ['loading', 'errorState', 'bookContent', 'pdfContent'];

/* The reading position's writes to Kavita (run by
 * app/tests/js/reader_progress.mjs).
 *
 * One queue per book for the whole document, shared by every visit's
 * writer for that book (key: the chapter Kavita keeps the position under):
 * a write goes when every earlier write for the book, from any visit, has
 * answered. Two writes in flight could be answered, and taken by Kavita, in
 * either order, so the page Kavita holds would be a guess; and a book left
 * while Kavita was slow and then reopened would otherwise have its new
 * visit's write overtaken by the old visit's last save. The queues hold
 * data only (page numbers and promises), never the page.
 *
 * Within a visit, write(page) queues at once when the visit has nothing
 * queued or in flight, and otherwise becomes the page waiting its turn (a
 * newer turn replaces it). A write whose turn comes when Kavita already
 * holds its page, or after a newer send was confirmed (a beacon), is not
 * sent.
 *
 * confirmed (per book) moves forward in send order only: an answer
 * confirms its page only when its write was sent after the one that set
 * confirmed, so a late "taken" for an older write never sets it back.
 *
 * Leaving the reader:
 *   leave(page)  a soft navigation: the document keeps running, so the last
 *                save joins the book's queue and goes after everything before
 *                it (send makes it a keepalive request the visit's end does
 *                not stop), so it lands last. Nothing more goes from this
 *                visit. Returns a promise that settles once it has answered,
 *                was not needed, or reached its deadline (below).
 *   sent(page)   a hard exit (the tab hidden or closed): there is no time to
 *                wait, so the caller sends a beacon at once and records it
 *                here as the newest send; writes still waiting in the queue
 *                are then not sent. A write already in flight may reach
 *                Kavita after the beacon and leave it on the older page: a
 *                rare race this accepts, and the next visit's first turn
 *                writes the position again.
 * send(page, deadline) returns (a promise of) true when Kavita took the
 * page, false or a rejection when not. known(page): Kavita reported the
 * reader there.
 *
 * A write that never answers must not hold the book's queue for good (every
 * later write, and the next visit's lookup of the saved position, waits on
 * it). So each write has a deadline, WRITE_DEADLINE_MS after it is sent:
 * deadline is an AbortSignal for that write alone (never the page's signal,
 * which a leave aborts), aborted then. A write past its deadline counts as
 * answered with an unknown outcome: it confirms nothing, an answer after it
 * is ignored, and the queue moves on. Kavita taking the aborted write even
 * later still, after the next one, is a rare race this accepts, like the
 * beacon's; the next turn writes the position again. The deadline's timer
 * is the clock's (the page's own window by default: it must outlive the
 * visit, as the write does), and is cleared when the write answers.
 *
 * The soft-leave save is the exception: it is the visit's last word and
 * nothing retries it, so a Kavita that is slow rather than gone must still
 * get it. Its deadline is never aborted. At the deadline the queue stops
 * waiting for it (later writes and a reopen's lookup go on, and leave()'s
 * promise settles), but the request runs to completion, and its answer,
 * whenever it comes, confirms its page in send order: only when no newer
 * send has been confirmed. The accepted residual: a leave-save still in
 * flight after the deadline may be taken by Kavita after a newer write
 * (a reopened visit's) and leave Kavita on the older page; the next turn
 * writes the position again. If the book's entry has left progressQueues
 * by the time it answers, the answer goes to the old entry and a new
 * writer, which starts from Kavita's own report, never sees it.
 *
 * settled(ms, timers): a promise that settles when every write queued for
 * the book so far has answered, or after ms on timers (the visit's ctx), if
 * sooner. The reader asks Kavita where it is only after that, and waits no
 * longer than RESTORE_WAIT_MS, so a slow save never keeps a book from
 * opening. Without ms it waits for the queue alone.
 *
 * A book's entry leaves progressQueues once its queue has drained and no
 * writer holds it (every writer ends with leave(), leave(null) when there is
 * nothing to save), so the map does not grow over a long session. A new
 * writer then starts fresh; one made while the book still has a save pending
 * shares its queue and goes behind it.
 */
export const WRITE_DEADLINE_MS = 15000;
export const RESTORE_WAIT_MS = 5000;

// book key -> { confirmed, confirmedAt, sends, queued, writers, tail }
// (exported for app/tests/js/reader_progress.mjs, which checks it empties).
export const progressQueues = new Map();

function progressQueue(key) {
  let q = progressQueues.get(key);
  if (!q) {
    q = { confirmed: -1, confirmedAt: 0, sends: 0, queued: 0, writers: 0, tail: Promise.resolve() };
    progressQueues.set(key, q);
  }
  return q;
}

// Nothing queued and no writer: the book's entry goes.
function releaseQueue(key, q) {
  if (q.queued === 0 && q.writers === 0 && progressQueues.get(key) === q) progressQueues.delete(key);
}

export function progressWriter(send, key, clock) {
  const book = String(key);
  const q = progressQueue(book);
  const timers = clock || globalThis;
  const TIMED_OUT = {};
  let mine = null;       // this visit's write queued or in flight
  let waiting = null;
  let closed = false;    // left: nothing more goes, and the writer lets go of the queue
  q.writers += 1;

  // A tie is known() recording Kavita's report while this write was out:
  // Kavita taking the write came after that report, so the write wins. Sends
  // are numbered one each, so no other tie exists.
  function take(at, page, ok) {
    if (ok === true && at >= q.confirmedAt) {
      q.confirmedAt = at;
      q.confirmed = page;
    }
  }

  // Behind every earlier write for the book (at once when there is none).
  // at: this send's place in order. last: the soft-leave save, which the
  // deadline never aborts (the queue only stops waiting for it).
  function enqueue(page, at, last) {
    function run() {
      if (at < q.confirmedAt || page === q.confirmed) return undefined;
      const deadline = new AbortController();
      let timer = 0;
      const late = new Promise(function (resolve) {
        timer = timers.setTimeout(function () { if (!last) deadline.abort(); resolve(TIMED_OUT); }, WRITE_DEADLINE_MS);
      });
      let answer;
      try { answer = Promise.resolve(send(page, deadline.signal)); } catch (e) { answer = Promise.resolve(false); }
      answer = answer.then(null, function () { return false; });
      // The leave-save's answer counts whenever it comes, in send order.
      if (last) answer.then(function (ok) { take(at, page, ok); });
      return Promise.race([answer, late]).then(function (ok) {
        timers.clearTimeout(timer);
        if (ok !== TIMED_OUT && !last) take(at, page, ok);   // past the deadline: unknown, not taken
      });
    }
    const done = (q.queued ? q.tail.then(run) : Promise.resolve(run()))
      .then(function () { q.queued -= 1; releaseQueue(book, q); });
    q.queued += 1;
    q.tail = done;
    return done;
  }

  function go(page) {
    const done = enqueue(page, ++q.sends);
    mine = done;
    done.then(function () {
      if (mine === done) mine = null;
      if (closed) return;
      const next = waiting;
      waiting = null;
      if (next !== null && next !== q.confirmed) go(next);
    });
    return done;
  }

  return {
    get confirmed() { return q.confirmed; },
    known: function (page) { q.confirmed = page; q.confirmedAt = q.sends; },
    settled: function (ms, visit) {
      const tail = q.tail;
      if (!ms) return tail;
      return new Promise(function (resolve) {
        const cap = visit.setTimeout(resolve, ms);
        tail.then(function () { visit.clearTimeout(cap); resolve(); });
      });
    },
    write: function (page) {
      if (closed) return;
      if (mine) waiting = page;
      else go(page);
    },
    sent: function (page) {
      waiting = null;
      q.confirmedAt = ++q.sends;
      q.confirmed = page;
    },
    // page null: nothing to save (the position was never known).
    leave: function (page) {
      if (closed) return Promise.resolve();
      closed = true;
      waiting = null;
      q.writers -= 1;
      if (page === null || page === undefined) {
        releaseQueue(book, q);
        return Promise.resolve();
      }
      return enqueue(page, ++q.sends, true);
    }
  };
}

/* ---- Reader guide (coach marks) ----
 *
 * Same engine as the library tour, in /static/js/tour.js. Started from the boot
 * chain rather than on a timer, because half these steps point at controls
 * that do not settle until the first page is on screen. openSettings and
 * closeSettings are the visit's (steps() below).
 */
function guideSteps(openSettings, closeSettings, pdf) {
  return [
    {
      target: '#navNext',
      fallback: pdf ? '#pdfContent' : '#bookContent',
      icon: 'auto_stories',
      title: 'Turning pages',
      body: pdf
        ? 'Tap or click either edge of the page to move forward or back, swipe on a phone, or use the arrow keys. Your place saves itself as you go, so you can close the tab and pick up here on any device.'
        : 'Tap or click either edge of the page to move forward or back, or use the arrow keys. Your place saves itself as you go, so you can close the tab and pick up here on any device.'
    },
    {
      target: '#pageInfo',
      icon: 'tag',
      title: 'Where you are',
      body: 'The counter at the bottom shows the page you are on and how many there are. Click it to type a page number and jump straight there.'
    },
    {
      target: '#tocBtn',
      icon: 'toc',
      title: 'Chapters',
      body: 'Opens the table of contents. The chapter you are in is highlighted, and picking any other one takes you to it.'
    },
    pdf ? null : {
      target: '#bookmarkBtn',
      icon: 'bookmark_add',
      title: 'Bookmarks',
      body: 'Marks the current page so you can find it again later. Separate from your reading position, which is always saved anyway.'
    },
    {
      target: '#settingsPanel',
      fallback: '#settingsBtn',
      icon: 'text_fields',
      title: 'Make it comfortable',
      body: pdf
        ? 'The five page colours, from black through to paper white, set the colour around the page. The page itself shows just as it was printed. Your choice carries to every book you open.'
        : 'Text size, line spacing, how wide the lines run, and two columns if you prefer. The five page colours run from black through to paper white. Your choices carry to every book you open.',
      before: openSettings
    },
    {
      target: '#readerBack',
      icon: 'arrow_back',
      title: 'When you are done',
      body: 'The arrow at the top left goes back to your books. Nothing needs saving first, and the book reappears under Continue.',
      before: closeSettings
    }
  ].filter(Boolean);
}

/**
 * What the address asks the reader to open: { seriesId, chapterId }, each a
 * positive whole number or null. A book (Books, the book page) names its own
 * chapter; an address with the series alone opens the series' first readable
 * chapter. A chapter that is not a number is no chapter.
 */
export function readerTarget(params) {
  function id(key) {
    var raw = params.get(key);
    var n = /^\d{1,10}$/.test(raw || '') ? parseInt(raw, 10) : 0;
    return n > 0 ? n : null;
  }
  return { seriesId: id('seriesId'), chapterId: id('chapterId') };
}

/**
 * The page the address asks the reader to open at (page=, as the reader
 * numbers pages, from 1), or null. Play history's "Continue reading from
 * here" names one: the reader opens there instead of where Kavita has them,
 * and that is their choice, saved like a page jump (a turn of their own).
 */
export function readerPage(params) {
  var raw = params.get('page');
  var n = /^\d{1,6}$/.test(raw || '') ? parseInt(raw, 10) : 0;
  return n > 0 ? n : null;
}

/**
 * The page= to open at, only when Play history marked it as its link was
 * followed: localStorage[READER_START_KEY] is {"chapterId:page": ms, ...}
 * (js/play-history.js markReaderStart). localStorage, not sessionStorage, so
 * a link opened in a new tab (middle-click, Ctrl/Cmd+click, long-press)
 * carries it too; each mark is good for READER_START_TTL_MS. This one, and
 * any expired, are cleared whatever happens, so a mark is used once.
 * Without a matching live mark (a link someone sent, an old tab), null.
 */
export const READER_START_KEY = 'ws-reader-start';
export const READER_START_TTL_MS = 2 * 60 * 1000;
export function takeStartPage(params, storage, now) {
  var t = typeof now === 'number' ? now : Date.now();
  var page = readerPage(params);
  var chapter = readerTarget(params).chapterId;
  var mark = chapter + ':' + page;
  var live = false;
  try {
    var raw = storage ? storage.getItem(READER_START_KEY) : null;
    if (raw === null) return null;
    var marks = {};
    try { marks = JSON.parse(raw) || {}; } catch (e) { marks = {}; }
    var kept = {};
    var left = 0;
    Object.keys(marks).forEach(function (k) {
      var at = marks[k];
      var fresh = typeof at === 'number' && t - at >= 0 && t - at <= READER_START_TTL_MS;
      if (k === mark) live = fresh;
      else if (fresh) { kept[k] = at; left += 1; }
    });
    if (left) storage.setItem(READER_START_KEY, JSON.stringify(kept));
    else storage.removeItem(READER_START_KEY);
  } catch (e) { return null; }
  return page && chapter && live ? page : null;
}

function localStore() {
  try { return window.localStorage; } catch (e) { return null; }
}

/**
 * True when Kavita's book-info names a PDF (its seriesFormat, Kavita's
 * MangaFormat: 3 is an EPUB, 4 a PDF). Read from what the reader already has,
 * so a PDF is never first asked for as an EPUB page.
 */
export const PDF_FORMAT = 4;
export function isPdfBook(info) {
  return !!info && info.seriesFormat === PDF_FORMAT;
}

export async function mount(ctx) {
  var root = ctx.root;
  var signal = ctx.signal;

  function el(id) { return root.querySelector('#' + id); }

  // This visit's state: every mount starts its own.
  // pdf: the open PDF (reader-pdf.js openPdf) when the book is one, else null.
  var book = { seriesId: null, chapterId: null, volumeId: null, libraryId: null, pages: 0, title: '', pdf: null };
  var current = { page: 0 };
  var saveTimer = 0;
  var lastSaved = -1;
  // The writes, through the book's queue (progressWriter), made once the
  // chapter is known; writer.confirmed is the page Kavita is known to hold
  // for this reader (the one it reported, or the newest write it took, in
  // send order). The saves on leaving compare against that, not lastSaved:
  // a page queued or in flight may not have landed. Nothing is written
  // before the position is known, which comes after the writer.
  var writer = null;
  // Whether current.page is a position we may write back to Kavita. False
  // until Kavita told us where this reader is (get-progress answered) or they
  // turned a page themselves. Otherwise a failed lookup, which opens the book
  // at the start, would overwrite their real place when they leave the page.
  var positionKnown = false;
  var guide = null;
  // Page loads started, so only the newest one puts its page up (loadPage).
  var turns = 0;
  // A PDF page on screen: its index and the room it was drawn for (a resize
  // to the same room draws nothing; a redraw of that page keeps the scroll).
  var shownPdf = { page: -1, key: '' };
  // A resize that came while a page was loading, for once it is up.
  var redrawPending = false;
  // page= (Play history) still to be taken as the reader's choice: on the
  // first page put on screen, whenever that is (boot, or Try again after a
  // failed first load). Set at boot.
  var startPending = false;
  // page= still to be dropped from the address, taken or not, on that same
  // first page.
  var dropPending = false;
  // Sample mode (see the top): nothing about this visit is ever saved.
  var sample = ctx.url.searchParams.get('sample') === '1';

  // A new visit for the sign-in helper: nothing blocked, nothing under way.
  if (window.WSKavita && typeof window.WSKavita.init === 'function') window.WSKavita.init();

  /**
   * Proxy call, on the visit's signal. A 401 means the Kavita session lapsed.
   *
   * For the calls that put the book on screen (the book, its chapter, a page)
   * that re-runs the handshake - or, when kavita-connect.js says it was just
   * tried, explains instead of going round again.
   *
   * A background call (progress save, bookmark, contents, saved position)
   * passes background=true: on a 401 it just fails. It never takes over the
   * page and never leaves it mid-book; a progress write is retried with the
   * next one.
   */
  function kavita(path, options, background) {
    options = options || {};
    options.credentials = 'include';
    // The visit's signal, unless the call brings its own (a progress write,
    // which must outlive the visit: sendProgress).
    if (!('signal' in options)) options.signal = signal;
    return fetch('/kavita' + path, options).then(function (res) {
      if (res.status === 401) {
        if (background) throw new Error('unauthorized');
        if (!signal.aborted) reconnectKavita();
        throw new Error('reconnecting');
      }
      return res;
    });
  }

  /** Go and sign in to Kavita, or say why not. Without the helper script, explain and stay. */
  function reconnectKavita() {
    var helper = window.WSKavita;
    if (!helper || typeof helper.reconnect !== 'function') {
      showConnectProblem();
      return;
    }
    helper.reconnect(showConnectProblem);
  }

  /** The Try again button. Without the helper, a reload is the honest retry. */
  function retryConnect() {
    var helper = window.WSKavita;
    if (!helper || typeof helper.retry !== 'function') {
      window.location.reload();
      return;
    }
    helper.retry();
  }

  function showConnectProblem() {
    showError(CONNECT_TITLE, CONNECT_MESSAGE, retryConnect);
  }

  // A page being left, or the reconnect already under way: nothing to say.
  function quiet(err) {
    return signal.aborted || (!!err && (err.name === 'AbortError' || err.message === 'reconnecting'));
  }

  // ---- Preferences (local; reading position itself lives in Kavita) ----

  var prefs = { theme: 'site', fontSize: 18, lineHeight: 17, measure: 42, columns: false };

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) { var p = JSON.parse(raw); for (var k in p) prefs[k] = p[k]; }
    } catch (e) { /* defaults are fine */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  function applyPrefs() {
    // On #wsPage: every reader surface is inside it, and the settings leave
    // with the page instead of staying on <html> for the next one.
    var style = root.style;
    var t = THEMES[prefs.theme];
    if (t) {
      style.setProperty('--reader-bg', t.bg);
      style.setProperty('--reader-fg', t.fg);
    } else {
      // Seed from the site theme so the book opens matching the site.
      var cs = getComputedStyle(document.documentElement);
      style.setProperty('--reader-bg', (cs.getPropertyValue('--hex-background') || '#000000').trim());
      style.setProperty('--reader-fg', (cs.getPropertyValue('--hex-text') || '#BEEEF4').trim());
    }
    style.setProperty('--reader-font-size', prefs.fontSize + 'px');
    style.setProperty('--reader-line-height', (prefs.lineHeight / 10).toString());
    style.setProperty('--reader-measure', prefs.measure + 'rem');
    style.setProperty('--reader-columns', prefs.columns ? '2' : '1');

    el('fontSize').value = prefs.fontSize;
    el('lineHeight').value = prefs.lineHeight;
    el('measure').value = prefs.measure;
    el('columns').setAttribute('aria-checked', prefs.columns ? 'true' : 'false');
    // In reader terms: the size as a number, spacing and line length
    // as a word.
    el('fsVal').textContent = prefs.fontSize + ' px';
    el('lhVal').textContent = prefs.lineHeight <= 14 ? 'Tight' : prefs.lineHeight <= 18 ? 'Normal' : 'Loose';
    el('mwVal').textContent = prefs.measure <= 38 ? 'Narrow' : prefs.measure <= 54 ? 'Medium' : 'Wide';
    // The player's slider (theme.css .wsp-range) fills to --wsp-p.
    ['fontSize', 'lineHeight', 'measure'].forEach(function (id) {
      var r = el(id), min = Number(r.min), max = Number(r.max);
      r.style.setProperty('--wsp-p', Math.round((Number(r.value) - min) / (max - min) * 100) + '%');
    });
    el('lineHeight').setAttribute('aria-valuetext', el('lhVal').textContent);
    el('measure').setAttribute('aria-valuetext', el('mwVal').textContent);

    Array.prototype.forEach.call(el('themeButtons').children, function (b) {
      var on = b.dataset.theme === prefs.theme;
      b.classList.toggle('bg-baltic-blue/40', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---- Loading ----

  var activePanel = 'loading';

  function showPanel(which) {
    activePanel = which;
    PANELS.forEach(function (id) {
      el(id).classList.toggle('hidden', id !== which);
    });
    // The edge zones sit outside the panels, over everything. Under an error
    // there is no page to turn, so they go too (and every page key waits).
    var turning = which !== 'errorState';
    el('navPrev').hidden = !turning;
    el('navNext').hidden = !turning;
  }

  /**
   * Page turning needs the current page on screen: no error, and nothing still
   * loading. During boot the saved position is still being looked up, and a
   * turn then would be saved over it once boot falls back to the first page.
   * It also keeps one turn from starting on top of another.
   */
  function canTurnPage() {
    return book.chapterId != null && (activePanel === 'bookContent' || activePanel === 'pdfContent');
  }

  var retryAction = null;

  /** onRetry: what Try again does here (sign in again, or reload the page); none for other errors. */
  function showError(title, detail, onRetry) {
    if (signal.aborted) return;
    el('errorTitle').textContent = title;
    el('errorDetail').textContent = detail || '';
    retryAction = onRetry || null;
    el('errorRetry').classList.toggle('hidden', !retryAction);
    showPanel('errorState');
  }

  function runRetry() {
    if (retryAction) retryAction();
  }

  function resolveChapter(seriesId) {
    return kavita('/api/Series/series-detail?seriesId=' + encodeURIComponent(seriesId))
      .then(function (r) {
        if (!r.ok) throw new Error('detail HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        var keys = ['specials', 'chapters', 'volumes', 'storylineChapters'];
        for (var i = 0; i < keys.length; i++) {
          var group = d[keys[i]] || [];
          for (var j = 0; j < group.length; j++) {
            var item = group[j];
            var chapters = item.chapters || [item];
            for (var k = 0; k < chapters.length; k++) {
              if (chapters[k].id) {
                return { chapterId: chapters[k].id, volumeId: chapters[k].volumeId || item.id };
              }
            }
          }
        }
        throw new Error('no readable chapter in this series');
      });
  }

  function loadTOC() {
    // A PDF's contents are its own outline, read by PDF.js.
    var listed = book.pdf
      ? book.pdf.contents()
      : kavita('/api/Book/' + book.chapterId + '/chapters', null, true)
        .then(function (r) { return r.ok ? r.json() : []; });
    return listed
      .then(function (nodes) {
        if (signal.aborted) return;
        var list = el('tocList');
        list.innerHTML = '';
        function add(items, depth) {
          (items || []).forEach(function (n) {
            var a = document.createElement('a');
            a.href = '#';
            a.className = 'toc-link block py-1 px-2 rounded hover:bg-baltic-blue/30 text-frosted-blue/90 truncate';
            a.style.paddingLeft = (8 + depth * 12) + 'px';
            a.textContent = n.title || 'Untitled';
            a.dataset.page = n.page;
            a.addEventListener('click', function (e) {
              e.preventDefault();
              goToPage(parseInt(n.page, 10) || 0);
              toggleTOC(false);
            }, { signal: signal });
            list.appendChild(a);
            if (n.children && n.children.length) add(n.children, depth + 1);
          });
        }
        add(nodes, 0);
        if (!list.children.length) {
          list.innerHTML = '<p class="text-xs text-steel-blue px-2">No contents listed for this book.</p>';
        }
      })
      .catch(function () { /* a missing TOC must not stop reading */ });
  }

  // The top of the book's page: the document scrolls the reader (reader.html).
  function scrollToTop() {
    window.scrollTo(0, 0);
  }

  function renderPage(html) {
    var container = el('bookContent');
    // VERBATIM. Kavita's annotation xPaths are relative to .book-content, so
    // the element tree inside must not be altered.
    container.innerHTML = html;
    showPanel('bookContent');
    scrollToTop();
  }

  /** The reader's page turns (edges, keys, contents, page jump) come through here. */
  function goToPage(page, skipSave) {
    if (!canTurnPage()) return Promise.resolve();
    return loadPage(page, skipSave);
  }

  /**
   * Put a page on screen. Past the page-turn check, so only goToPage, boot's
   * first page and a failed page's Try again call it: boot runs under the
   * spinner and Try again under the error, where the check refuses.
   */
  function loadPage(page, skipSave) {
    if (page < 0) page = 0;
    if (book.pages && page > book.pages - 1) page = book.pages - 1;
    current.page = page;
    updateChrome();
    // A PDF page drawn already (a neighbour of the last) goes up at once,
    // with no spinner between; so a turn can come before it answers, and
    // only the newest turn's page is put on screen.
    var turn = ++turns;
    var room = book.pdf ? pdfRoom() : null;

    // A redraw of the PDF page on screen (a resize) keeps it up meanwhile.
    if (!room || (!book.pdf.drawn(page, room) && page !== shownPdf.page)) {
      showPanel('loading');
      el('loadingText').textContent = 'Loading page ' + (page + 1) + '…';
    }

    var shown = room
      ? book.pdf.draw(page, room).then(function (canvas) {
        if (signal.aborted || turn !== turns) return false;
        renderPdfPage(canvas, page, room);
        return true;
      })
      : kavita('/api/Book/' + book.chapterId + '/book-page?page=' + page)
        .then(function (r) {
          if (!r.ok) throw new Error('page HTTP ' + r.status);
          return r.text();
        })
        .then(function (html) {
          if (signal.aborted) return false;
          renderPage(html);
          return true;
        });

    return shown
      .then(function (rendered) {
        if (!rendered) return;
        if (redrawPending) {
          redrawPending = false;
          redrawSoon();
        }
        if (startPending) {
          // The page the address named is the reader's own choice: once it
          // is on screen it is saved, as a page jump is.
          startPending = false;
          positionKnown = true;
          queueProgress();
        }
        if (dropPending) {
          // And page= leaves the address (dropStartPage), taken or ignored.
          dropPending = false;
          dropStartPage();
        }
        if (!skipSave) {
          // The reader chose this page: from here it is theirs to save
          // (never in a sample, where nothing is saved).
          if (sample) return;
          positionKnown = true;
          queueProgress();
        }
      })
      .catch(function (err) {
        if (quiet(err) || turn !== turns) return;
        // The arrows are off under an error, so Try again reloads this page
        // (with the same skipSave: a retry never confirms an unknown position).
        showError('Couldn’t load this page', String(err.message || err), function () {
          loadPage(page, skipSave);
        });
      });
  }

  /**
   * The room a PDF page is drawn for: the width of the reading surface (all
   * of it on a phone), and on wider screens the height between the top bar
   * and the page counter, less the player and a sample's banner, so the whole
   * page shows. ratio: the screen's pixels per CSS pixel, for sharp pages.
   */
  function pdfRoom() {
    var phone = window.innerWidth <= 640;
    var width = document.documentElement.clientWidth - (phone ? 0 : 48);
    var player = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ws-player-h')) || 0;
    var banner = el('sampleBanner').hidden ? 0 : el('sampleBanner').offsetHeight;
    // 56 the top bar, 12 the space above the page, 56 the page counter.
    var height = window.innerHeight - 56 - 12 - 56 - player - banner;
    return { width: Math.max(width, 120), height: Math.max(height, 160), phone: phone, ratio: window.devicePixelRatio || 1 };
  }

  function renderPdfPage(canvas, page, room) {
    var container = el('pdfContent');
    if (canvas.parentNode !== container || container.childNodes.length !== 1) container.replaceChildren(canvas);
    showPanel('pdfContent');
    // A new page starts at its top; the same page drawn again stays put.
    if (page !== shownPdf.page) scrollToTop();
    shownPdf = { page: page, key: pdfHelper.roomKey(room) };
  }

  function updateChrome() {
    el('pageInfo').textContent = book.pages
      ? (current.page + 1) + ' / ' + book.pages
      : String(current.page + 1);
    el('pageJumpTotal').textContent = book.pages ? '/ ' + book.pages : '';
    el('pageJumpInput').max = book.pages || 1;
    el('navPrev').disabled = current.page <= 0;
    el('navNext').disabled = book.pages ? current.page >= book.pages - 1 : false;
  }

  /** Swap the page readout for an input so a page can be typed directly. */
  function openPageJump() {
    var input = el('pageJumpInput');
    el('pageInfo').classList.add('hidden');
    el('pageJumpForm').classList.remove('hidden');
    el('pageJumpForm').classList.add('flex');
    input.value = current.page + 1;
    input.focus();
    input.select();
  }

  function closePageJump() {
    el('pageJumpForm').classList.add('hidden');
    el('pageJumpForm').classList.remove('flex');
    el('pageInfo').classList.remove('hidden');
  }

  // ---- Progress ----

  function queueProgress() {
    ctx.clearTimeout(saveTimer);
    saveTimer = ctx.setTimeout(saveProgress, SAVE_DEBOUNCE_MS);
  }

  /**
   * Write the reading position to Kavita, through the writer (one at a
   * time). useBeacon: a hard exit (the tab hidden or closed), with no time
   * to wait for a write in flight: a beacon, its own request that the page
   * unloading does not stop, sent whenever Kavita is not known to hold this
   * page (see progressWriter for the race that accepts). Leaving by a soft
   * navigation is leaveReader's.
   */
  function saveProgress(useBeacon) {
    // No writer before the chapter is known; nothing is known then either.
    var held = useBeacon ? (writer ? writer.confirmed : -1) : lastSaved;
    if (!positionKnown || current.page === held) return;
    var page = current.page;
    lastSaved = page;

    if (useBeacon && navigator.sendBeacon) {
      // Fire-and-forget; same-origin so the session cookie rides along.
      if (navigator.sendBeacon('/kavita/api/Reader/progress' + pdfMark(),
        new Blob([progressBody(page)], { type: 'application/json' }))) writer.sent(page);
      return;
    }
    if (signal.aborted) return;
    writer.write(page);
  }

  function progressBody(page) {
    return JSON.stringify({
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
      pageNum: toKavitaPage(page)
    });
  }

  // Kavita counts a PDF's pages from 1 (its own PDF reader saves the page
  // number it shows, and a PDF is read when that reaches its page count) and
  // an EPUB's from 0. The reader counts from 0 for both; only these two
  // convert.
  // A PDF's saves say so (format=pdf), for Insights' Right now, which shows
  // the page as the reader does; the proxy keeps it from Kavita.
  function pdfMark() { return book.pdf ? '?format=pdf' : ''; }
  function toKavitaPage(page) { return book.pdf ? page + 1 : page; }
  function fromKavitaPage(pageNum) { return book.pdf ? Math.max(pageNum - 1, 0) : pageNum; }

  /**
   * One write, for the writer: true when Kavita took the page. Not on the
   * visit's signal, and keepalive: a write in flight when the reader is left
   * finishes (it touches nothing on the page), so the last save, which the
   * writer sends after it, lands after it. Its own signal is the writer's
   * deadline for this write alone, never aborted for the soft-leave save
   * (progressWriter). A failed write must never
   * interrupt reading: it is a background call, and lastSaved = -1 makes the
   * next save try again.
   */
  function sendProgress(page, deadline) {
    return kavita('/api/Reader/progress' + pdfMark(), {
      method: 'POST',
      signal: deadline,
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: progressBody(page)
    }, true).then(function (r) {
      if (!r.ok) lastSaved = -1;
      return r.ok;
    }).catch(function () { lastSaved = -1; return false; });
  }

  /** Where Kavita has this reader. Rejects when that isn't actually known. */
  function fetchProgress() {
    return kavita('/api/Reader/get-progress?chapterId=' + book.chapterId, null, true)
      .then(function (r) {
        if (!r.ok) throw new Error('progress HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        // An empty or null body is Kavita's "not started": a known page 0.
        // Anything unparsable throws, and the position stays unknown.
        var p = text ? JSON.parse(text) : null;
        return (p && typeof p.pageNum === 'number') ? fromKavitaPage(p.pageNum) : 0;
      });
  }

  function restoreProgress() {
    // Asked once every save for this book already on its way (an earlier
    // visit's, Kavita being slow) has answered, so the answer is the newest
    // position; but after RESTORE_WAIT_MS at most, so a save that never
    // answers cannot keep the book from opening. One quiet retry before
    // giving up: a lost lookup would otherwise leave the book at the start
    // with saving switched off.
    return writer.settled(RESTORE_WAIT_MS, ctx).then(fetchProgress)
      .catch(function (err) { if (quiet(err)) throw err; return fetchProgress(); })
      .then(function (page) {
        positionKnown = true;
        lastSaved = page;
        writer.known(page);
        return page;
      })
      .catch(function (err) { if (quiet(err)) throw err; return 0; });   // position unknown: open at the start, never save it
  }

  // ---- UI wiring ----

  function toggleTOC(force) {
    var panel = el('tocPanel');
    var open = typeof force === 'boolean' ? force : panel.classList.contains('closed');
    panel.classList.toggle('closed', !open);
  }

  // Opens and closes as every popover does (theme.css .ws-pop, shell.js
  // WS.popOpen / WS.popClose); shown at once if the shell is not there.
  var shellPop = window.WS && typeof window.WS.popOpen === 'function' ? window.WS : null;
  function settingsOpen() { return !el('settingsPanel').classList.contains('hidden'); }
  function openSettings() {
    if (shellPop) shellPop.popOpen(el('settingsPanel'));
    else el('settingsPanel').classList.remove('hidden');
  }
  function closeSettings() {
    if (shellPop) shellPop.popClose(el('settingsPanel'));
    else el('settingsPanel').classList.add('hidden');
  }

  el('tocBtn').addEventListener('click', function () { toggleTOC(); }, { signal: signal });
  el('errorRetry').addEventListener('click', runRetry, { signal: signal });
  el('settingsBtn').addEventListener('click', function () {
    if (settingsOpen()) closeSettings();
    else openSettings();
  }, { signal: signal });

  el('navPrev').addEventListener('click', function () { goToPage(current.page - 1); }, { signal: signal });
  el('navNext').addEventListener('click', function () { goToPage(current.page + 1); }, { signal: signal });

  el('pageInfo').addEventListener('click', openPageJump, { signal: signal });

  el('pageJumpForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var n = parseInt(el('pageJumpInput').value, 10);
    closePageJump();
    if (!isNaN(n)) goToPage(n - 1);   // the field is 1-based, pages are 0-based
  }, { signal: signal });

  el('pageJumpInput').addEventListener('keydown', function (e) {
    // Stop the reader's own arrow/space shortcuts firing while typing.
    e.stopPropagation();
    if (e.key === 'Escape') closePageJump();
  }, { signal: signal });
  el('pageJumpInput').addEventListener('blur', closePageJump, { signal: signal });

  el('bookmarkBtn').addEventListener('click', function () {
    if (sample) return;
    kavita('/api/Reader/bookmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seriesId: book.seriesId, volumeId: book.volumeId,
        chapterId: book.chapterId, page: current.page
      })
    }, true).then(function (r) {
      el('bookmarkIcon').textContent = r.ok ? 'bookmark_added' : 'bookmark_add';
      ctx.setTimeout(function () { el('bookmarkIcon').textContent = 'bookmark_add'; }, 1800);
    }).catch(function () { /* a bookmark is a convenience; reading goes on */ });
  }, { signal: signal });

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === 'j' || e.key === ' ') {
      if (!canTurnPage()) return;
      e.preventDefault();
      goToPage(current.page + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'k') {
      if (!canTurnPage()) return;
      e.preventDefault();
      goToPage(current.page - 1);
    } else if (e.key === 't') toggleTOC();
    else if (e.key === 'Escape') { toggleTOC(false); closeSettings(); }
  }, { signal: signal });

  function bindPref(id, key, transform) {
    el(id).addEventListener('input', function (e) {
      prefs[key] = transform ? transform(e.target) : parseInt(e.target.value, 10);
      applyPrefs(); savePrefs();
    }, { signal: signal });
  }
  bindPref('fontSize', 'fontSize');
  bindPref('lineHeight', 'lineHeight');
  bindPref('measure', 'measure');
  el('columns').addEventListener('click', function () {
    prefs.columns = !prefs.columns;
    applyPrefs(); savePrefs();
  }, { signal: signal });

  Array.prototype.forEach.call(el('themeButtons').children, function (b) {
    b.addEventListener('click', function () {
      prefs.theme = b.dataset.theme; applyPrefs(); savePrefs();
    }, { signal: signal });
  });

  // Final write when the tab is hidden or closed (a hard exit: a beacon, no
  // waiting), so that never loses the position. Leaving by a soft navigation
  // is the cleanup's (below).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveProgress(true);
  }, { signal: signal });
  window.addEventListener('pagehide', function () { saveProgress(true); }, { signal: signal });

  // A PDF is drawn for the room it has: a new size (a phone turned, a window
  // resized) or a new pixel ratio (the window moved to another screen, which
  // fires no resize) draws the page on screen again, once that settles.
  var resizeTimer = 0;
  function redrawSoon() {
    if (!book.pdf) return;
    ctx.clearTimeout(resizeTimer);
    resizeTimer = ctx.setTimeout(function () {
      // Mid-load: once the page is up (loadPage). The same room: nothing.
      if (!canTurnPage()) redrawPending = true;
      else if (pdfHelper.roomKey(pdfRoom()) !== shownPdf.key) goToPage(current.page, true);
    }, 200);
  }
  window.addEventListener('resize', redrawSoon, { signal: signal });
  function watchPixelRatio() {
    if (signal.aborted || typeof window.matchMedia !== 'function') return;
    var now = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    if (!now || typeof now.addEventListener !== 'function') return;
    now.addEventListener('change', function () { redrawSoon(); watchPixelRatio(); }, { once: true, signal: signal });
  }

  // A PDF's page turns with a sideways swipe too (reader-pdf.js swipeTurn):
  // drawn to the screen's width on a phone, nothing else moves sideways.
  // Never while zoomed in (that swipe pans), with two fingers, or over the
  // reader's own controls.
  var swipe = null;
  root.addEventListener('touchstart', function (e) {
    swipe = null;
    if (!book.pdf || !pdfHelper || e.touches.length !== 1) return;
    if (e.target.closest && e.target.closest('#readerBar, #tocPanel, #settingsPanel, #readerFooter, #sampleBanner')) return;
    if (window.visualViewport && window.visualViewport.scale > 1.01) return;
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() };
  }, { signal: signal, passive: true });
  root.addEventListener('touchend', function (e) {
    var from = swipe;
    swipe = null;
    if (!from || e.touches.length || !e.changedTouches.length || !canTurnPage()) return;
    var t = e.changedTouches[0];
    var step = pdfHelper.swipeTurn(t.clientX - from.x, t.clientY - from.y, Date.now() - from.at);
    if (step) goToPage(current.page + step);
  }, { signal: signal, passive: true });
  root.addEventListener('touchcancel', function () { swipe = null; }, { signal: signal, passive: true });

  /* The Sample banner: Start reading is this book read normally (the same
     chapter, its place restored and saved); Close goes back where the
     sample was opened from, or to Books on a first page. */
  function showSample() {
    el('bookmarkBtn').hidden = true;
    var read = '/reader?seriesId=' + target.seriesId + (target.chapterId ? '&chapterId=' + target.chapterId : '');
    el('sampleStart').setAttribute('href', read);
    el('sampleClose').addEventListener('click', function () {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('/books');
    }, { signal: signal });
    el('sampleBanner').hidden = false;
  }

  /**
   * page= is a one-time instruction: once that page is open (and saved as a
   * jump), it leaves the address. Left there, a reload, a phone restoring a
   * discarded tab or Back to this entry (the router mounts again from the
   * address) would reopen the old page and write it over the newer place
   * Kavita holds by then. The entry is replaced, its router state kept.
   */
  function dropStartPage() {
    try {
      var u = new URL(window.location.href);
      if (!u.searchParams.has('page')) return;
      u.searchParams.delete('page');
      window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
    } catch (e) { /* the address keeps it; a reload opens that page again */ }
  }

  // ---- PDF books ----

  // reader-pdf.js, once a PDF is opened.
  var pdfHelper = null;

  // A file this page loads as a helper, at the address the server stamped.
  function dep(id) { return el(id).getAttribute('data-ws-dep'); }

  /**
   * Open the book's PDF and switch the reader to it: no text settings and no
   * bookmarks (see the top). A refused sign-in (401) goes round the Kavita
   * hand-off as a page load does.
   */
  function openPdfBook() {
    el('textSettings').hidden = true;
    el('bookmarkBtn').hidden = true;
    return Promise.all([import(dep('readerPdfJs')), import(dep('pdfjsLib'))]).then(function (mods) {
      if (signal.aborted) throw new Error('reconnecting');
      pdfHelper = mods[0];
      return pdfHelper.openPdf(mods[1], {
        url: '/kavita/api/Reader/pdf?chapterId=' + book.chapterId,
        workerSrc: dep('pdfjsWorker'),
        assets: '/static/vendor/pdfjs/',
        signal: signal,
        document: document
      });
    }).then(function (pdf) {
      book.pdf = pdf;
      // The file's own count: every page in it can be drawn. Kavita counted
      // the same file.
      book.pages = pdf.pages || book.pages;
      watchPixelRatio();
    }, function (err) {
      if (err && err.status === 401) {
        if (!signal.aborted) reconnectKavita();
        throw new Error('reconnecting');
      }
      throw err;
    });
  }

  // ---- Boot ----

  loadPrefs();
  applyPrefs();

  if (window.WebServarrTour) {
    guide = window.WebServarrTour.init({
      seenKey: 'webservarr_reader_guide_seen',
      // Asked when the guide starts, by then the book's format is known.
      steps: function () { return guideSteps(openSettings, closeSettings, !!book.pdf); },
      helpBtn: el('helpBtn'),
      // Started from the boot chain instead, once a page has rendered.
      autoStart: false,
      // Leaving the settings panel hanging open after a skipped tour would look
      // like a bug.
      onFinish: closeSettings,
      signal: signal
    });
  }

  // Leaving the reader by a soft navigation: the router runs this after the
  // visit's signal has aborted, and the document keeps running, so the last
  // position goes after any write in flight (progressWriter leave), as a
  // keepalive request, and lands last. With the position never known there
  // is nothing to save, and the writer just lets go of the book's queue.
  var leave = function () {
    if (writer) writer.leave(positionKnown ? current.page : null);
  };

  var target = readerTarget(ctx.url.searchParams);
  var startPage = takeStartPage(ctx.url.searchParams, localStore());
  startPending = !!startPage && !sample;
  dropPending = ctx.url.searchParams.has('page') && !sample;
  if (!target.seriesId) {
    showError('No book selected', 'Open a book from the library.');
    return leave;
  }
  book.seriesId = target.seriesId;
  if (sample) showSample();

  checkAuth().then(function () {
    // The book's own chapter when the address names it (its volume comes from
    // book-info below); else the series' first.
    if (target.chapterId) return { chapterId: target.chapterId, volumeId: null };
    return resolveChapter(book.seriesId);
  }).then(function (res) {
    book.chapterId = res.chapterId;
    book.volumeId = res.volumeId;
    // One queue per chapter, the position's key in Kavita, for every visit.
    // Not once the visit has ended: its cleanup, which lets go of the
    // writer, has already run.
    if (signal.aborted) throw new Error('reconnecting');
    // A sample has no writer: nothing of it is ever written.
    if (!sample) writer = progressWriter(sendProgress, 'chapter:' + book.chapterId);
    return kavita('/api/Book/' + book.chapterId + '/book-info');
  }).then(function (r) {
    if (!r.ok) throw new Error('book-info HTTP ' + r.status);
    return r.json();
  }).then(function (info) {
    if (signal.aborted) throw new Error('reconnecting');
    book.pages = info.pages || 0;
    book.libraryId = info.libraryId;
    book.volumeId = info.volumeId || book.volumeId;
    // The chapter's own series, not the address's: a chapter named in the
    // address belongs where Kavita says it does, and progress is saved there.
    book.seriesId = info.seriesId || book.seriesId;
    book.title = info.bookTitle || info.seriesName || 'Reader';
    el('bookTitle').textContent = book.title;
    ctx.setTitle(book.title);
    // Kavita's page API reads EPUBs only: a PDF is opened here instead.
    return isPdfBook(info) ? openPdfBook() : null;
  }).then(function () {
    if (signal.aborted) throw new Error('reconnecting');
    loadTOC();
    // A sample opens at the start and never asks where the reader is. A page
    // named in the address (Play history) is opened instead of Kavita's place,
    // which is still read first, so the writer knows what Kavita holds.
    if (sample) return 0;
    return restoreProgress().then(function (known) { return startPage ? startPage - 1 : known; });
  }).then(function (page) {
    return loadPage(page, true);
  }).then(function () {
    // Only once there is a rendered page to point at. Starting earlier
    // spotlights an empty loading spinner.
    if (!signal.aborted && guide && !sample) guide.maybeStart();
  }).catch(function (err) {
    if (quiet(err)) return;
    showError('Couldn’t open this book', String(err.message || err));
  });

  return leave;
}
