/**
 * WebServarr, Books (page module)
 *
 * One library of ebooks (Kavita) and audiobooks (Plex): a search box, a
 * Continue row of what the person is partway through, and a cover grid with
 * format chips and a sort. A cover opens the book's own page (/books/<id>); a
 * series is one card that opens the series page.
 *
 * Everything comes from the Books APIs (/api/books, /search, /continue). A
 * book's progress is read live by the server, never kept by this page. A
 * per-person note in an answer (Kavita not connected, a source down) is shown
 * quietly; "not connected" runs the existing Kavita hand-off
 * (kavita-connect.js) and the page loads again when it comes back.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. Markup is built with textContent only.
 *
 * Also exports what the other Books pages and Home draw with:
 *   renderBookCard(card, { signal })                   a cover card (an <a>)
 *   renderContinueRow(items, notes, { compact, signal, connectHref }) the
 *                                                       Continue row (a <section>), or
 *                                                       null when nothing is in progress
 *   coverBox(url, formats, signal, { badges, eager })  the 2:3 cover frame (the book page's: badges off, eager)
 *   noteLine(text)                                     a quiet line about a source that is down
 *   rememberContinue(user)                             a book was just started: the next visit holds the row's room
 *   rememberRow(kind, user)                            the same for 'upnext' and 'mylist' (a book was just added)
 *   sendBooks(method, url, body)                       a write to the person's own Books data
 * They touch no DOM at import time.
 *
 * Above the library, as Continue is, two rows of the person's own (books 3b):
 * Up next (their queue, in order: each book with Play or Read, Move earlier,
 * Move later and Remove) and My list (newest first). Each is hidden while it
 * is empty, and held from the first paint for a person who had it last time,
 * exactly as Continue is (localStorage and an <html> flag each).
 *
 * Under them, two discovery shelves (books 3c), held and drawn the same way:
 * Recently added (the newest books, with New on those added since the
 * person's previous visit; loading it records this visit) and Popular on the
 * server (books several people listened to, with the server's rounded label).
 */

const PAGE_SIZE = 36;
const SEARCH_WAIT_MS = 300;
const SEARCH_LIMIT = 60;
const SKELETON_CARDS = 12;
const BUILDING_POLL_MS = 10000;
const CONTINUE_WAIT_MS = 1500;

const VIEW_KEY = 'webservarr_books_view:';
const CONTINUE_KEY = 'webservarr_books_continue:';
// The person's own rows: where each one's memory is, its <html> flag and its host.
const ROWS = {
  upnext: { key: 'webservarr_books_upnext:', flag: 'data-books-upnext', host: 'upnextHost', url: '/api/books/me/queue', cache: 'books:me:queue' },
  mylist: { key: 'webservarr_books_mylist:', flag: 'data-books-mylist', host: 'mylistHost', url: '/api/books/me/list', cache: 'books:me:list' },
  // The discovery shelves (books 3c): held and drawn the same way.
  recent: { key: 'webservarr_books_recent:', flag: 'data-books-recent', host: 'recentHost', url: '/api/books/recent', cache: 'books:recent' },
  popular: { key: 'webservarr_books_popular:', flag: 'data-books-popular', host: 'popularHost', url: '/api/books/popular', cache: 'books:popular' }
};
// Every row above the library, top to bottom.
const ROW_ORDER = ['continue', 'upnext', 'mylist', 'recent', 'popular'];
const MOVE_MS = 200;               // a card trading places with its neighbour
const GUIDE_KEY = 'webservarr_books_guide_seen:';
// The cards have their covers by then, so the first spotlight sits on something drawn.
const GUIDE_WAIT_MS = 900;

// The first-visit guide (the engine is js/tour.js, shared with the reader): what
// the page can do, in the order a person meets it. A step whose target is not
// on screen (no Continue row yet) is shown in the middle of the page instead.
const GUIDE_STEPS = [
  {
    target: '#booksSearch',
    icon: 'search',
    title: 'Find a book',
    body: 'Type a title, an author or a narrator. If we don’t have it yet, the search lets you ask for it.'
  },
  {
    target: '#continueHost [data-continue]',
    icon: 'bookmark',
    title: 'Pick up where you left off',
    body: 'Books you’ve started, to read or to listen to, wait in a Continue row. Tap one to carry on from your place.'
  },
  {
    target: '#formatChips',
    icon: 'tune',
    title: 'Ebooks, audiobooks or both',
    body: 'Show everything, only the books you can read, or only the ones you can listen to.'
  },
  {
    target: '#libraryGrid > li:first-child',
    fallback: '#libraryGrid',
    icon: 'menu_book',
    title: 'Open a book',
    body: 'Tap a cover to see the book. Read opens the ebook and Listen plays the audiobook, and each keeps your place.'
  }
];

const FORMATS = ['all', 'ebook', 'audio'];
const SORTS = ['added', 'title', 'author'];
const FORMAT_INFO = {
  ebook: { icon: 'menu_book', label: 'Ebook' },
  audio: { icon: 'headphones', label: 'Audiobook' }
};

// Class strings are written out whole: Tailwind only builds what it can read.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-4 gap-y-6';
const CHIP_ON = 'inline-flex items-center h-10 px-4 rounded-full text-[15px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frosted-blue bg-primary text-bright';
const CHIP_OFF = 'inline-flex items-center h-10 px-4 rounded-full text-[15px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frosted-blue bg-frosted-blue/[0.07] text-frosted-blue/70 hover:bg-frosted-blue/10 hover:text-frosted-blue';
const LINK_FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frosted-blue';

function isAbort(e) { return !!e && e.name === 'AbortError'; }

/**
 * Say that this person now has a Continue row, before its answer does. Books and
 * Home hold the row's room from the first frame for a person who had one last
 * time, so a book started here (the book page's Listen) is told to them at once:
 * the next visit does not meet a row it had no room for.
 */
export function rememberContinue(user) {
  try { localStorage.setItem(CONTINUE_KEY + (user || ''), '1'); } catch (e) { /* private mode: nothing is kept */ }
}

/** The same for the person's own rows: a book was just put on My list
    ('mylist') or in Up next ('upnext'), so the next Books visit holds that row's room. */
export function rememberRow(kind, user) {
  const row = ROWS[kind];
  if (!row) return;
  try { localStorage.setItem(row.key + (user || ''), '1'); } catch (e) { /* private mode: nothing is kept */ }
}

/**
 * A write to the person's own Books data (My list, Up next, a rating): the
 * answer's JSON, or an Error carrying its status. Not on a page's signal: a
 * change the person made goes through even when they leave the page at once
 * (the page only stops drawing its answer).
 */
export function sendBooks(method, url, body) {
  const init = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return window.fetch(url, init).then(function (r) {
    return r.json().then(function (d) { return d; }, function () { return null; }).then(function (data) {
      if (!r.ok) {
        const e = new Error('HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return data;
    });
  });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function icon(name, cls) {
  const s = el('span', 'material-symbols-outlined' + (cls ? ' ' + cls : ''), name);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function clamp(n, low, high) { return Math.max(low, Math.min(high, n)); }

// ---- Cards ----

/** The format badges on a cover: one round mark per format the book has. */
function formatBadges(formats) {
  const wrap = el('span', 'absolute left-2 bottom-2 flex gap-1');
  (formats || []).forEach(function (f) {
    const info = FORMAT_INFO[f];
    if (!info) return;
    const b = el('span', 'grid place-items-center size-6 rounded-full bg-background-dark/80 text-frosted-blue');
    b.setAttribute('data-format', f);
    b.title = info.label;
    b.appendChild(icon(info.icon, 'text-[16px]'));
    b.appendChild(el('span', 'sr-only', info.label));
    wrap.appendChild(b);
  });
  return wrap;
}

/**
 * The cover box: a 2:3 frame that holds its shape before the picture lands,
 * the format's icon behind it for a cover that never loads (a failed image
 * hides itself), and the format badges on top. An audiobook's cover is square
 * art: shown whole rather than cropped.
 */
export function coverBox(url, formats, signal, opts) {
  const list = formats || [];
  const audioOnly = list.length === 1 && list[0] === 'audio';
  // Spans, so a cover is valid inside a button too.
  const box = el('span', 'relative block aspect-[2/3] overflow-hidden rounded-xl bg-frosted-blue/[0.07]');
  // A flex frame, not the icon itself: the icon font's own display rule would beat a grid class on it.
  const mark = el('span', 'absolute inset-0 flex items-center justify-center');
  mark.appendChild(icon(audioOnly ? 'headphones' : 'menu_book', 'text-[32px] text-frosted-blue/45'));
  box.appendChild(mark);
  if (url) {
    const img = el('img', audioOnly ? 'absolute inset-0 h-full w-full object-contain' : 'absolute inset-0 h-full w-full object-cover');
    img.alt = '';
    // The book page's own cover is what the page is waiting for (eager); a card's is below some fold.
    img.loading = opts && opts.eager ? 'eager' : 'lazy';
    if (opts && opts.eager) img.setAttribute('fetchpriority', 'high');
    img.decoding = 'async';
    img.src = url;
    img.addEventListener('error', function () { img.classList.add('hidden'); }, { once: true, signal: signal });
    box.appendChild(img);
  }
  // The book's own page has its buttons for this; a card needs the marks.
  if (!(opts && opts.badges === false)) box.appendChild(formatBadges(list));
  return box;
}

/**
 * A mark on the top left of a cover (where Up next puts a book's place):
 * "New" in the accent, or a quiet one such as a listener count. Its words
 * are part of the card's link text.
 */
function coverMark(text, opts) {
  const o = opts || {};
  const mark = el('span', 'absolute left-2 top-2 inline-flex h-6 max-w-[calc(100%-1rem)] items-center gap-1 rounded-full px-2 text-[13px] font-semibold leading-none ' +
    (o.accent ? 'bg-primary text-bright' : 'bg-background-dark/80 text-frosted-blue'));
  if (o.icon) mark.appendChild(icon(o.icon, 'text-[16px]'));
  mark.appendChild(el('span', 'truncate', text));
  if (o.data) mark.setAttribute(o.data, '');
  return mark;
}

/**
 * A library card: the cover, the title (two lines of room whatever it is, so
 * every row is one height and lands on its skeleton) and one quiet line under
 * it, the author or, for a series, how many books it holds. opts.mark puts a
 * coverMark on the cover ({ text, accent, icon, data }).
 */
export function renderBookCard(card, opts) {
  const signal = opts && opts.signal;
  const series = card.kind === 'series';
  const a = el('a', 'group block ws-lift rounded-xl ' + LINK_FOCUS);
  a.href = series ? '/books/series?name=' + encodeURIComponent(card.series || '') : '/books/' + encodeURIComponent(String(card.id));
  const cover = el('span', 'relative block');
  if (series) {
    // Two pages behind the cover: more than one book.
    const back = el('span', 'absolute inset-x-3 -top-2 h-full rounded-xl bg-frosted-blue/10');
    const mid = el('span', 'absolute inset-x-1.5 -top-1 h-full rounded-xl bg-frosted-blue/[0.15]');
    back.setAttribute('aria-hidden', 'true');
    mid.setAttribute('aria-hidden', 'true');
    cover.appendChild(back);
    cover.appendChild(mid);
  }
  const box = coverBox(card.cover_url, card.formats, signal);
  if (opts && opts.mark && opts.mark.text) box.appendChild(coverMark(opts.mark.text, opts.mark));
  cover.appendChild(box);
  a.appendChild(cover);
  const title = series ? card.series : card.title;
  a.appendChild(el('span', 'mt-2 text-[15px] font-semibold leading-snug text-frosted-blue line-clamp-2 min-h-[2.75em]', title || 'Untitled'));
  const sub = series ? card.count + (card.count === 1 ? ' book' : ' books') : card.author;
  a.appendChild(el('span', 'block text-[13px] leading-5 text-frosted-blue/70 truncate min-h-5', sub || ''));
  return a;
}

function resumeAudio(key) {
  const p = window.WS && window.WS.player;
  if (!p || typeof p.open !== 'function') {
    if (window.WSUI && typeof window.WSUI.toast === 'function') {
      window.WSUI.toast('The player isn’t ready yet. Try again in a moment.', 'err');
    }
    return;
  }
  // Where the listener left off. A failure is the player's to show.
  Promise.resolve(p.open(key, { autoplay: true })).catch(function (e) {
    console.warn('The player could not open ' + key, e);
  });
}

/** One Continue card: an ebook is a link into the reader, an audiobook a button for the player. */
function continueCard(item, compact, signal) {
  const audio = item.format === 'audio';
  const width = compact ? 'w-28' : 'w-36';
  const base = 'group block ' + width + ' shrink-0 text-left ws-lift rounded-xl ' + LINK_FOCUS;
  const resume = item.resume || {};
  let node;
  if (audio) {
    node = el('button', base);
    node.type = 'button';
    node.setAttribute('data-resume-audio', resume.plex_book_key || '');
    node.addEventListener('click', function () { resumeAudio(resume.plex_book_key); }, { signal: signal });
  } else {
    node = el('a', base);
    node.href = resume.read_url || '/books/' + encodeURIComponent(String(item.book_id));
  }
  const box = coverBox(item.cover_url, [item.format], signal);
  if (typeof item.percent === 'number') {
    // The bar is drawn from CSSOM (no style attribute in markup).
    // On a dark track, so it reads over any cover.
    const track = el('span', 'absolute inset-x-0 bottom-0 block h-1.5 bg-background-dark/70');
    const fill = el('span', 'block h-full bg-frosted-blue');
    fill.style.width = clamp(item.percent, 0, 100) + '%';
    track.setAttribute('aria-hidden', 'true');
    track.appendChild(fill);
    box.appendChild(track);
  }
  node.appendChild(box);
  node.appendChild(el('span', 'mt-2 text-[15px] font-semibold leading-snug text-frosted-blue ' +
    (compact ? 'line-clamp-1' : 'line-clamp-2 min-h-[2.75em]'), item.title || 'Untitled'));
  node.appendChild(el('span', 'block text-[13px] leading-5 text-frosted-blue/70 truncate min-h-5', item.progress_label || ''));
  return node;
}

/** A quiet line about a source that is not answering. */
export function noteLine(text, href) {
  const p = el('p', 'flex items-center gap-2 text-[15px] text-frosted-blue/70');
  p.appendChild(icon('info', 'text-[20px]'));
  if (href) {
    // A page that cannot run the Kavita hand-off itself (Home) sends the person to the one that can.
    const a = el('a', 'underline underline-offset-2 hover:text-frosted-blue ' + LINK_FOCUS, text);
    a.href = href;
    p.appendChild(a);
  } else {
    p.appendChild(el('span', '', text));
  }
  return p;
}

/**
 * The Continue row: what the person is partway through, newest first, as one
 * section with a heading and a sideways row of cards. Null when there is
 * nothing (the caller hides the row). `notes` ([{source, reason, text}]) are
 * shown quietly beneath it, so a source that is down says so without taking
 * the other format's cards away. compact is Home's smaller row; connectHref,
 * when given, makes the "not connected" note a link to the page that can
 * connect (Books runs that itself and passes none).
 */
export function renderContinueRow(items, notes, opts) {
  const o = opts || {};
  const list = items || [];
  if (!list.length) return null;
  const section = el('section', '');
  section.setAttribute('aria-label', 'Continue');
  section.setAttribute('data-continue', '');
  if (o.compact) {
    // Home's own section heading (an icon, then the title), so it reads as one of its sections.
    const head = el('div', 'flex items-center gap-3 mb-4');
    head.appendChild(icon('auto_stories', 'text-steel-blue'));
    head.appendChild(el('h2', 'text-xl font-bold text-frosted-blue', 'Continue'));
    section.appendChild(head);
  } else {
    section.appendChild(el('h2', 'mb-3 font-bold leading-snug text-xl text-frosted-blue', 'Continue'));
  }
  const row = el('ul', 'books-row -mx-4 px-4 lg:mx-0 lg:px-0 flex gap-4 py-1');
  list.forEach(function (item) {
    const li = el('li', 'shrink-0');
    li.appendChild(continueCard(item, !!o.compact, o.signal));
    row.appendChild(li);
  });
  // A mouse drags the row, and a plain wheel moves it sideways until it can go
  // no further (then the page scrolls on); a trackpad's sideways swipe and a
  // finger already work natively.
  if (window.WS && typeof window.WS.dragScroll === 'function') window.WS.dragScroll(row, { signal: o.signal });
  row.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = row.scrollWidth - row.clientWidth;
    if (max <= 1) return;
    const next = clamp(row.scrollLeft + (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY), 0, max);
    if (next === row.scrollLeft) return;
    row.scrollLeft = next;
    e.preventDefault();
  }, { passive: false, signal: o.signal });
  section.appendChild(row);
  const seen = {};
  (notes || []).forEach(function (n) {
    if (!n || !n.text || seen[n.text]) return;
    seen[n.text] = true;
    const line = noteLine(n.text, o.connectHref && n.reason === 'not_connected' ? o.connectHref : '');
    line.className += ' mt-3';
    line.setAttribute('data-continue-note', '');
    section.appendChild(line);
  });
  return section;
}

// ---- The page ----

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;
  const user = ((ctx.data || {}).user || {}).username || '';
  const $ = function (id) { return root.querySelector('#' + id); };
  const html = document.documentElement;

  const state = {
    format: 'all', sort: 'added',
    query: '', searching: false,
    gen: 0, searchGen: 0,
    cursor: null, moreBusy: false,
    notes: { library: [], continue: [] },
    reconnectTried: false, connectProblem: false,
    stopBuildingPoll: null,
    // The first books drawn: the toolbar, the notes, Continue, Up next and My
    // list are written in that one frame (commitFrame), so nothing already on
    // screen moves. pending: each row's answer ({ row }), held until then.
    committed: false, pending: {},
    // A visit with no memory of one of those rows (a first ever visit) has the
    // books wait for its answer (up to CONTINUE_WAIT_MS): a row that comes in
    // after them would push them down. Rows it remembers have their room
    // reserved, so they are not waited for. unsettled: the rows still waited for.
    unsettled: {}, waiting: [],
    // Up next: its books in the order on screen; moves sent one after another.
    queue: [], moving: 0, moveChain: null,
    // Counts every redraw of page 1, so a next page asked for before one is dropped.
    renderGen: 0, building: false, guideOffered: false,
    embed: ((ctx.data || {}).branding || {}).requests_source === 'seerr_embed'
  };

  // ---- What the last visit left ----

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode: nothing is kept */ }
  }

  function readView() {
    try {
      const saved = JSON.parse(storageGet(VIEW_KEY + user) || 'null');
      if (saved && FORMATS.indexOf(saved.format) !== -1) state.format = saved.format;
      if (saved && SORTS.indexOf(saved.sort) !== -1) state.sort = saved.sort;
    } catch (e) { /* an old value: the defaults */ }
  }
  function saveView() {
    storageSet(VIEW_KEY + user, JSON.stringify({ format: state.format, sort: state.sort }));
  }

  // Continue, Up next and My list are each reserved from the first paint for
  // a person who had that row last time (theme-loader.js does the same on a
  // full load); this is the soft-navigation visit, before anything is awaited.
  function markRow(name, on) {
    const flag = name === 'continue' ? 'data-books-continue' : ROWS[name].flag;
    if (on) html.setAttribute(flag, '');
    else html.removeAttribute(flag);
  }
  function rowKey(name) {
    return (name === 'continue' ? CONTINUE_KEY : ROWS[name].key) + user;
  }
  ROW_ORDER.forEach(function (name) {
    const hint = storageGet(rowKey(name));
    markRow(name, hint === '1');
    if (hint === null) state.unsettled[name] = true;
  });

  // ---- Showing one body at a time ----

  const BODIES = ['gridSkeleton', 'libraryGrid', 'errorState', 'buildingState', 'emptyState'];
  function showBody(which) {
    BODIES.forEach(function (id) { $(id).classList.toggle('hidden', id !== which); });
    if (which !== 'libraryGrid') $('moreWrap').classList.add('hidden');
  }

  function quiet(err) { return signal.aborted || isAbort(err); }

  // ---- Notes, and the Kavita hand-off ----

  function reconnectKavita() {
    const helper = window.WSKavita;
    if (!helper || typeof helper.reconnect !== 'function') { showConnectProblem(); return; }
    helper.reconnect(showConnectProblem);
  }

  function retryConnect() {
    const helper = window.WSKavita;
    if (!helper || typeof helper.retry !== 'function') { window.location.reload(); return; }
    helper.retry();
  }

  function showConnectProblem() {
    if (signal.aborted) return;
    state.connectProblem = true;
    // Before the first books are drawn it waits for commitFrame.
    if (state.committed) { $('connectState').classList.remove('hidden'); syncConnect(); }
    renderNotes();
  }

  /** "Not connected" means this person has no Kavita link yet: the hand-off,
      once per visit. It comes back to this page and the data loads again. */
  function checkReconnect(notes) {
    if (state.reconnectTried) return;
    const need = (notes || []).some(function (n) { return n && n.source === 'kavita' && n.reason === 'not_connected'; });
    if (!need) return;
    state.reconnectTried = true;
    reconnectKavita();
  }

  /** The connect message: shown once the hand-off was refused. While a "not
      connected" note is in the answer (even a kept copy of one) its room is
      held, unseen, so the message coming in after the books are drawn moves
      nothing. */
  function syncConnect() {
    const box = $('connectState');
    const wants = state.notes.library.concat(state.notes.continue).some(function (n) { return n && n.reason === 'not_connected'; });
    box.classList.toggle('hidden', !(state.connectProblem || wants));
    box.classList.toggle('invisible', wants && !state.connectProblem);
  }

  function renderNotes() {
    if (!state.committed) return;
    const box = $('notes');
    box.textContent = '';
    const seen = {};
    state.notes.library.concat(state.notes.continue).forEach(function (n) {
      if (!n || !n.text) return;
      // The connect message says it already; a hand-off under way needs no words.
      if (n.reason === 'not_connected') return;
      const key = n.source + '|' + n.reason;
      if (seen[key]) return;
      seen[key] = true;
      box.appendChild(noteLine(n.text));
    });
    box.classList.toggle('hidden', !box.firstChild);
    syncConnect();
  }

  function setNotes(which, notes) {
    state.notes[which] = Array.isArray(notes) ? notes : [];
    renderNotes();
  }

  /** Every list is read here, from the server. Its notes decide the hand-off,
      so they are looked at on the live answer only: never on a copy kept from
      an earlier visit (which may be a session old), and whether or not the
      answer differs from that copy and gets drawn again. */
  function readLive(url, quietNotes) {
    return WS.getJSON(url, { signal: signal }).then(function (data) {
      // One book's answer, read to open it from Up next (quietNotes), starts no hand-off of its own.
      if (quietNotes) return data;
      checkReconnect(data && data.notes);
      return data;
    });
  }

  // ---- Continue ----

  /** The one write that brings in everything above the books: the toolbar
      (until then its skeleton), the connect message, the notes and Continue.
      Everything under them is replaced in the same frame, so nothing that was
      already on screen moves, with or without a Continue row, notes or a
      failed sign-in. */
  function commitFrame() {
    if (state.committed) return;
    state.committed = true;
    $('toolbarSkel').classList.add('hidden');
    $('toolbar').classList.remove('hidden');
    renderNotes();
    applyRows();
  }

  function hostOf(name) {
    return $(name === 'continue' ? 'continueHost' : ROWS[name].host);
  }

  /** Every row whose answer is in goes into its host (nothing: the host hides). */
  function applyRows() {
    Object.keys(state.pending).forEach(function (name) {
      const held = state.pending[name];
      delete state.pending[name];
      const host = hostOf(name);
      host.textContent = '';
      host.setAttribute('aria-busy', 'false');
      if (held.row) host.appendChild(held.row);
      markRow(name, !!held.row);
    });
  }

  /** A row is drawn with the first books (commitFrame), or at once when they
      are already in. A live answer (not a kept copy, not a failure) is what
      the next visit remembers. */
  function placeRow(name, row, remember) {
    state.pending[name] = { row: row };
    if (state.committed) applyRows();
    if (remember) storageSet(rowKey(name), row ? '1' : '0');
    settleRow(name);
  }

  /** A row has answered (or the wait is over): once none is waited for, what waited goes on. */
  function settleRow(name) {
    if (name) delete state.unsettled[name];
    else state.unsettled = {};
    if (Object.keys(state.unsettled).length) return;
    const go = state.waiting;
    state.waiting = [];
    go.forEach(function (fn) { fn(); });
  }

  function afterContinue(fn) {
    if (!Object.keys(state.unsettled).length) fn();
    else state.waiting.push(fn);
  }

  function renderContinue(data, fromCache, failed) {
    if (signal.aborted) return;
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    setNotes('continue', data && data.notes);
    placeRow('continue', renderContinueRow(items, [], { signal: signal }), !fromCache && !failed);
  }

  function loadContinue() {
    return WS.swr('books:continue', function () {
      return readLive('/api/books/continue');
    }, function (data, fromCache) {
      if (signal.aborted) return;
      WS.arrive('continue', function () { renderContinue(data, fromCache, false); });
    }, {
      onError: function (err) {
        if (quiet(err)) return;
        // No Continue is not a reason to hold up the library.
        WS.arrive('continue', function () { renderContinue(null, false, true); });
      }
    });
  }

  // ---- My list and Up next ----

  function player() { return (window.WS && window.WS.player) || null; }

  function toast(text) {
    if (window.WSUI && typeof window.WSUI.toast === 'function') window.WSUI.toast(text, 'err');
  }

  function rowHead(text) {
    return el('h2', 'mb-3 font-bold leading-snug text-xl text-frosted-blue', text);
  }

  function rowList(tag) {
    const list = el(tag, 'books-row -mx-4 px-4 lg:mx-0 lg:px-0 flex gap-4 py-1');
    if (window.WS && typeof window.WS.dragScroll === 'function') window.WS.dragScroll(list, { signal: signal });
    return list;
  }

  /** A row of library cards under a heading (My list and the discovery
      shelves). markOf(card) gives a card its cover mark, or nothing. Null when empty. */
  function cardRow(label, data, items, markOf) {
    if (!items.length) return null;
    const section = el('section', '');
    section.setAttribute('aria-label', label);
    section.setAttribute(data, '');
    section.appendChild(rowHead(label));
    const list = rowList('ul');
    items.forEach(function (card) {
      const li = el('li', 'w-36 shrink-0');
      li.appendChild(renderBookCard(card, { signal: signal, mark: markOf ? markOf(card) : null }));
      list.appendChild(li);
    });
    section.appendChild(list);
    return section;
  }

  /** My list: the person's books, newest first. */
  function myListRow(items) {
    return cardRow('My list', 'data-mylist', items, null);
  }

  /** Recently added: the newest books, those added since the person's last
      visit marked New (the server decides; never on a first visit). */
  function recentRow(items) {
    return cardRow('Recently added', 'data-recent', items, function (card) {
      return card.is_new === true ? { text: 'New', accent: true, data: 'data-new' } : null;
    });
  }

  /** Popular on the server: books several people listened to, each with the
      server's rounded label ("5+ listeners"), never a count of its own. */
  function popularRow(items) {
    return cardRow('Popular on the server', 'data-popular', items, function (card) {
      return typeof card.listeners_label === 'string' && card.listeners_label
        ? { text: card.listeners_label, icon: 'headphones', data: 'data-listeners' } : null;
    });
  }

  const BUILD_ROW = { mylist: myListRow, recent: recentRow, popular: popularRow };

  // Class strings are written out whole: Tailwind only builds what it can read.
  const ROW_BTN = 'ws-lift inline-flex h-10 min-w-0 items-center justify-center gap-1 rounded-[10px] px-2 text-[15px] font-semibold ' + LINK_FOCUS;
  const ROW_ICON = 'ws-lift grid size-10 place-items-center rounded-[10px] text-frosted-blue/70 hover:bg-frosted-blue/[0.07] hover:text-frosted-blue disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ' + LINK_FOCUS;

  /** One Up next card: the book (a link to its page) with its place in the
      queue on the cover, Play and/or Read, and Move earlier, Move later and
      Remove. Nothing nested: the link and the buttons are siblings. */
  function upNextCard(card) {
    const id = String(card.id);
    const title = card.title || 'Untitled';
    const li = el('li', 'w-40 shrink-0');
    li.setAttribute('data-queued', id);
    const a = el('a', 'group block ws-lift rounded-xl ' + LINK_FOCUS);
    a.href = '/books/' + encodeURIComponent(id);
    const box = coverBox(card.cover_url, card.formats, signal);
    const place = el('span', 'absolute left-2 top-2 grid h-6 min-w-6 place-items-center rounded-full bg-background-dark/80 px-1.5 text-[13px] font-bold tabular-nums text-frosted-blue');
    place.setAttribute('data-place', '');
    place.setAttribute('aria-hidden', 'true');
    box.appendChild(place);
    a.appendChild(box);
    a.appendChild(el('span', 'mt-2 text-[15px] font-semibold leading-snug text-frosted-blue line-clamp-2 min-h-[2.75em]', title));
    a.appendChild(el('span', 'block text-[13px] leading-5 text-frosted-blue/70 truncate min-h-5', card.author || ''));
    li.appendChild(a);

    const formats = Array.isArray(card.formats) ? card.formats : [];
    const go = el('div', 'mt-2 grid grid-cols-2 gap-2');
    if (formats.indexOf('audio') !== -1) go.appendChild(openButton('play', 'play_arrow', 'Play', title, card));
    if (formats.indexOf('ebook') !== -1) go.appendChild(openButton('read', 'menu_book', 'Read', title, card));
    if (go.children.length === 1) go.firstChild.classList.add('col-span-2');
    li.appendChild(go);

    const tools = el('div', 'mt-1 flex items-center justify-between');
    tools.appendChild(iconButton('earlier', 'chevron_left', 'Move ' + title + ' earlier'));
    tools.appendChild(iconButton('later', 'chevron_right', 'Move ' + title + ' later'));
    const gap = el('span', 'flex-1');
    gap.setAttribute('aria-hidden', 'true');
    tools.appendChild(gap);
    tools.appendChild(iconButton('remove', 'close', 'Remove ' + title + ' from Up next'));
    li.appendChild(tools);
    return li;
  }

  function openButton(kind, name, word, title, card) {
    const b = el('button', ROW_BTN + ' bg-frosted-blue/[0.07] text-frosted-blue hover:bg-frosted-blue/10');
    b.type = 'button';
    b.setAttribute('data-up', kind);
    b.setAttribute('aria-label', word + ' ' + title);
    b.appendChild(icon(name, 'text-[20px] shrink-0'));
    const words = el('span', 'truncate', word);
    words.setAttribute('data-word', word);
    b.appendChild(words);
    b.addEventListener('click', function () {
      if (kind === 'play') playQueued(card, b); else readQueued(card, b);
    }, { signal: signal });
    return b;
  }

  function iconButton(kind, name, label) {
    const b = el('button', ROW_ICON);
    b.type = 'button';
    b.setAttribute('data-up', kind);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(name, 'text-[24px]'));
    return b;
  }

  /** Up next: the queue in order. Null when empty. */
  function upNextRow(items) {
    if (!items.length) return null;
    const section = el('section', '');
    section.setAttribute('aria-label', 'Up next');
    section.setAttribute('data-upnext', '');
    section.appendChild(rowHead('Up next'));
    // An ordered list: the order is the point (a screen reader says "2 of 5").
    const list = rowList('ol');
    list.setAttribute('data-upnext-list', '');
    items.forEach(function (card) { list.appendChild(upNextCard(card)); });
    list.addEventListener('click', function (e) {
      const b = e.target && e.target.closest ? e.target.closest('button[data-up]') : null;
      if (!b || b.disabled) return;
      const kind = b.getAttribute('data-up');
      const li = b.closest('li');
      if (kind === 'earlier' || kind === 'later') moveQueued(li, kind === 'earlier' ? -1 : 1, b);
      else if (kind === 'remove') removeQueued(li.getAttribute('data-queued'), true);
    }, { signal: signal });
    section.appendChild(list);
    syncPlaces(list);
    return section;
  }

  function queueList() { return root.querySelector('[data-upnext-list]'); }

  /** The numbers on the covers and which moves are possible, from the order on screen. */
  function syncPlaces(list) {
    const cards = Array.prototype.slice.call(list.children);
    cards.forEach(function (li, i) {
      li.querySelector('[data-place]').textContent = String(i + 1);
      li.querySelector('[data-up="earlier"]').disabled = i === 0;
      li.querySelector('[data-up="later"]').disabled = i === cards.length - 1;
    });
    state.queue = cards.map(function (li) { return li.getAttribute('data-queued'); });
  }

  function reduced() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Two cards trade places: each slides from where it was (none with reduced motion). */
  function slide(nodes, before) {
    if (reduced()) return;
    nodes.forEach(function (n, i) {
      const dx = before[i] - n.getBoundingClientRect().left;
      if (!dx || typeof n.animate !== 'function') return;
      n.animate([{ transform: 'translateX(' + dx + 'px)' }, { transform: 'none' }], { duration: MOVE_MS, easing: 'ease-out' });
    });
  }

  /** Move a queued book one place earlier (-1) or later (1). The cards trade
      places at once; the server is told, one move after another, and a move
      it refuses puts the queue back as it has it. The focus stays on the
      button pressed (the other move, when that one can go no further). */
  function moveQueued(li, step, btn) {
    const list = li.parentNode;
    const other = step < 0 ? li.previousElementSibling : li.nextElementSibling;
    if (!other) return;
    const before = [li.getBoundingClientRect().left, other.getBoundingClientRect().left];
    // The neighbour moves, not this card: a focused element taken out of the page loses the focus.
    if (step < 0) list.insertBefore(other, li.nextSibling);
    else list.insertBefore(other, li);
    syncPlaces(list);
    slide([li, other], before);
    if (btn.disabled) {
      const twin = li.querySelector(step < 0 ? '[data-up="later"]' : '[data-up="earlier"]');
      if (twin && !twin.disabled) twin.focus();
    }
    const id = li.getAttribute('data-queued');
    const to = state.queue.indexOf(id);
    say((step < 0 ? 'Moved earlier, ' : 'Moved later, ') + 'now number ' + (to + 1) + ' in Up next');
    forgetKept('upnext');
    state.moving += 1;
    const send = function () { return sendBooks('POST', '/api/books/me/queue/move', { book_id: parseInt(id, 10), to: to }); };
    // The chain never rejects (each move has its own outcome), so a refused move does not stop the next.
    state.moveChain = (state.moveChain || Promise.resolve()).then(send).then(function (data) {
      state.moving -= 1;
      if (signal.aborted || state.moving) return;
      const items = data && Array.isArray(data.items) ? data.items : null;
      // The server's order is the truth: drawn again only when it differs.
      if (items && items.map(function (c) { return String(c.id); }).join() !== state.queue.join()) redrawQueue(items);
    }, function () {
      state.moving -= 1;
      if (signal.aborted) return;
      toast('Couldn’t move it in Up next. Try again.');
      reloadQueue();
    });
  }

  /** Take a book out of Up next: its card goes at once (the focus to its
      neighbour), and comes back if the server refuses. */
  function removeQueued(id, asked) {
    const list = queueList();
    const li = list && list.querySelector('[data-queued="' + id + '"]');
    if (li) {
      const next = li.nextElementSibling || li.previousElementSibling;
      const hadFocus = li.contains(document.activeElement);
      li.remove();
      if (next) {
        syncPlaces(list);
        if (hadFocus) next.querySelector('[data-up="remove"]').focus();
      } else {
        state.queue = [];
        placeRow('upnext', null, true);
        if (hadFocus) focusAfterRows();
      }
    }
    forgetKept('upnext');
    sendBooks('DELETE', '/api/books/' + encodeURIComponent(id) + '/queue').then(function () {
      if (asked) say('Removed from Up next');
    }, function () {
      if (signal.aborted) return;
      if (asked) toast('Couldn’t remove it from Up next. Try again.');
      reloadQueue();
    });
  }

  /** After the last card of a row goes: the next thing on the page, so the focus is never lost. */
  function focusAfterRows() {
    const next = root.querySelector('#mylistHost a, #recentHost a, #popularHost a, #formatChips button');
    if (next) next.focus();
  }

  // A screen reader hears what a press did (the cards' own text does not change).
  function say(text) {
    const line = $('booksSaid');
    if (line) line.textContent = text;
  }

  /** A kept copy of a row is out of date once the person changes it here. */
  function forgetKept(name) {
    if (typeof WS.dropCache === 'function') WS.dropCache(ROWS[name].cache);
  }

  function redrawQueue(items) {
    const focused = document.activeElement;
    const which = focused && focused.closest ? focused.closest('[data-queued]') : null;
    const kind = focused && focused.getAttribute ? focused.getAttribute('data-up') : null;
    placeRow('upnext', upNextRow(items), true);
    if (which && kind) {
      const back = root.querySelector('[data-queued="' + which.getAttribute('data-queued') + '"] [data-up="' + kind + '"]');
      if (back && !back.disabled) back.focus();
    }
  }

  function reloadQueue() {
    readLive(ROWS.upnext.url, true).then(function (data) {
      if (signal.aborted) return;
      redrawQueue(data && Array.isArray(data.items) ? data.items : []);
    }, function () { /* the row stays as it is; the next visit reads it again */ });
  }

  /** The book's own answer (its preferred edition, its reader address), read
      when Play or Read is pressed: a queue card does not carry them. */
  function opening(btn, on) {
    const words = btn.querySelector('[data-word]');
    btn.setAttribute('aria-disabled', on ? 'true' : 'false');
    words.textContent = on ? 'Opening…' : words.getAttribute('data-word');
  }

  function bookAnswer(card) {
    return readLive('/api/books/' + encodeURIComponent(String(card.id)), true);
  }

  function playQueued(card, btn) {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const p = player();
    if (!p || typeof p.open !== 'function') {
      toast('The player isn’t ready yet. Try again in a moment.');
      return;
    }
    opening(btn, true);
    bookAnswer(card).then(function (data) {
      const audio = data && data.formats && data.formats.audio;
      const editions = audio && Array.isArray(audio.editions) ? audio.editions : [];
      const keys = editions.map(function (e) { return e.plex_book_key; });
      const key = keys.indexOf(audio && audio.preferred) !== -1 ? audio.preferred : keys[0];
      if (!key) throw new Error('No audiobook to play');
      if (signal.aborted) return null;
      dequeueWhenPlaying(String(card.id), String(key));
      rememberContinue(user);
      // Where the listener left off; a failure is the player's to show.
      return Promise.resolve(p.open(key, { autoplay: true })).catch(function (e) {
        console.warn('The player could not open ' + key, e);
      });
    }).catch(function (e) {
      if (signal.aborted || isAbort(e)) return;
      toast('This audiobook is unavailable right now. Try again in a moment.');
    }).then(function () {
      if (!signal.aborted) opening(btn, false);
    });
  }

  /** A queued book the person plays leaves Up next once it really plays (not
      while the player holds it to ask where to start). Another book first, or
      leaving the page, drops this. */
  function dequeueWhenPlaying(id, key) {
    const p = player();
    if (!p || typeof p.on !== 'function' || typeof p.state !== 'function') return;
    const done = new AbortController();
    const off = p.on('change', function () {
      const st = p.state() || {};
      if (st.book === null || st.book === undefined || st.book === '') return;
      if (String(st.book) !== key) { stop(); return; }
      if (st.playing && !st.filesChanged && !st.safetyNet) {
        stop();
        removeQueued(id, false);
      }
    });
    function stop() {
      off();
      done.abort();
    }
    signal.addEventListener('abort', stop, { once: true, signal: done.signal });
  }

  function readQueued(card, btn) {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    opening(btn, true);
    bookAnswer(card).then(function (data) {
      const f = data && data.formats && data.formats.ebook;
      const href = f && typeof f.read_url === 'string' && f.read_url.indexOf('/reader?') === 0 ? f.read_url : '';
      if (!href) throw new Error('No ebook to read');
      if (signal.aborted) return;
      if (window.WS && WS.router && typeof WS.router.navigate === 'function') WS.router.navigate(href);
      else window.location.assign(href);
    }).catch(function (e) {
      if (signal.aborted || isAbort(e)) return;
      toast('This ebook is unavailable right now. Try again in a moment.');
    }).then(function () {
      if (!signal.aborted) opening(btn, false);
    });
  }

  function renderMine(name, data, fromCache, failed) {
    if (signal.aborted) return;
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    if (name === 'upnext' && state.moving) return;    // the person is reordering: theirs is newer
    placeRow(name, name === 'upnext' ? upNextRow(items) : BUILD_ROW[name](items), !fromCache && !failed);
  }

  function loadMine(name) {
    const row = ROWS[name];
    return WS.swr(row.cache, function () {
      return readLive(row.url, true);
    }, function (data, fromCache) {
      renderMine(name, data, fromCache, false);
    }, {
      onError: function (err) {
        if (quiet(err)) return;
        // Not there (an account that keeps no books of its own) or failing: no row, and the library goes on.
        renderMine(name, null, false, true);
      }
    });
  }

  // ---- The library ----

  function skeletonCard() {
    const d = el('div', '');
    d.appendChild(el('div', 'skel aspect-[2/3] rounded-xl'));
    d.appendChild(el('p', 'mt-2 text-[15px] leading-snug min-h-[2.75em]', ' '));
    d.appendChild(el('p', 'text-[13px] leading-5 min-h-5', ' '));
    return d;
  }

  function showSkeleton(grid, count) {
    grid.textContent = '';
    for (let i = 0; i < count; i++) grid.appendChild(skeletonCard());
  }

  function appendCards(grid, items) {
    items.forEach(function (card) {
      const li = el('li', '');
      li.appendChild(renderBookCard(card, { signal: signal }));
      grid.appendChild(li);
    });
  }

  function syncControls() {
    root.querySelectorAll('#formatChips [data-format]').forEach(function (b) {
      const on = b.getAttribute('data-format') === state.format;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.className = on ? CHIP_ON : CHIP_OFF;
    });
    $('sortSelect').value = state.sort;
  }

  function setMore(cursor) {
    state.cursor = cursor || null;
    state.moreBusy = false;
    const btn = $('moreBtn');
    btn.disabled = false;
    btn.textContent = 'Show more';
    $('moreWrap').classList.toggle('hidden', !state.cursor);
    // A watcher only reports a change; asking it again reports where the button
    // is now, so a page that was dropped (or one that left the button still in
    // reach) is followed by the next.
    if (state.cursor && watcher) { watcher.unobserve($('moreWrap')); watcher.observe($('moreWrap')); }
  }

  let watcher = null;

  function stopBuildingPoll() {
    if (state.stopBuildingPoll) { state.stopBuildingPoll(); state.stopBuildingPoll = null; }
  }

  function showEmpty(hasNotes) {
    const filtered = state.format !== 'all';
    let title = 'No books yet';
    let text = 'Books you request show up here once they’re ready.';
    if (filtered) {
      title = state.format === 'ebook' ? 'No ebooks to show' : 'No audiobooks to show';
      text = 'Try another filter to see the rest of the library.';
    } else if (hasNotes) {
      title = 'No books to show right now';
      text = 'Check back in a moment.';
    }
    if (state.embed && !filtered && !hasNotes) text = 'Books show up here once they’re added.';
    $('emptyTitle').textContent = title;
    $('emptyText').textContent = text;
    $('emptyReset').classList.toggle('hidden', !filtered);
    // Requests is Seerr's own page then, which cannot ask for a book.
    // (Nor while a source is not answering: the book may be there.)
    $('emptyRequest').classList.toggle('hidden', filtered || state.embed || hasNotes);
    showBody('emptyState');
  }

  // ---- The first-visit guide ----

  let guide = null;

  /** Once the books are on screen, so its spotlights sit on real covers, and never over a
      page that could not load or a search: a person's first visit gets it, once. */
  function offerGuide() {
    if (!guide || state.guideOffered || signal.aborted) return;
    state.guideOffered = true;
    ctx.setTimeout(function () {
      if (signal.aborted || state.searching || state.connectProblem) return;
      // Off to sign in to Kavita: the page comes back and the guide is then shown (not marked seen now).
      if (state.reconnectTried || (window.WSKavita && typeof window.WSKavita.isLeaving === 'function' && window.WSKavita.isLeaving())) return;
      const first = !guide.hasBeenSeen();
      guide.maybeStart();
      // Seen as soon as it has been shown, not only when it is finished: a person who
      // leaves the page half way is not walked through it again on every visit.
      if (first && guide.isActive()) storageSet(GUIDE_KEY + user, '1');
    }, GUIDE_WAIT_MS);
  }

  function renderLibrary(data) {
    if (signal.aborted) return;
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    setNotes('library', data && data.notes);
    commitFrame();
    state.renderGen++;
    $('libraryGrid').textContent = '';
    state.building = false;
    if (items.length) {
      stopBuildingPoll();
      saveView();
      appendCards($('libraryGrid'), items);
      showBody('libraryGrid');
      setMore(data.next_cursor);
      offerGuide();
      return;
    }
    if (data && data.building) {
      // Not saved as this person's view, and not kept by the cache: an empty
      // answer from a first build is not what the chip looks like.
      state.building = true;
      showBody('buildingState');
      // A catalog still being built: look again every few seconds, on the visit's poll.
      if (!state.stopBuildingPoll) state.stopBuildingPoll = ctx.poll(function () { loadLibrary(true); }, BUILDING_POLL_MS);
      return;
    }
    stopBuildingPoll();
    saveView();
    showEmpty(state.notes.library.length > 0);
  }

  function libraryUrl(cursor) {
    return '/api/books?format=' + state.format + '&sort=' + state.sort + '&limit=' + PAGE_SIZE +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  }

  function failedLibrary(err) {
    if (quiet(err)) return;
    commitFrame();
    showBody('errorState');
  }

  /** Load the first page for the chosen format and sort. quietly: a re-check
      that leaves what is on screen alone until the answer is in. */
  function loadLibrary(quietly) {
    const gen = ++state.gen;
    if (quietly) {
      return readLive(libraryUrl()).then(function (data) {
        if (gen !== state.gen || signal.aborted) return;
        renderLibrary(data);
      }, function (err) {
        if (gen !== state.gen) return;
        failedLibrary(err);
      });
    }
    showBody('gridSkeleton');
    showSkeleton($('gridSkeleton'), SKELETON_CARDS);
    return WS.swr('books:list:' + state.format + ':' + state.sort, function () {
      return readLive(libraryUrl());
    }, function (data) {
      if (gen !== state.gen || signal.aborted) return;
      WS.arrive('library', function () {
        afterContinue(function () {
          if (gen !== state.gen || signal.aborted) return;
          renderLibrary(data);
        });
      });
    }, {
      onError: function (err) {
        if (gen !== state.gen || quiet(err)) return;
        WS.arrive('library', function () { afterContinue(function () { failedLibrary(err); }); });
      }
    }).then(function () {
      // swr keeps every answer it draws; an empty one from a first build is not worth keeping.
      if (gen === state.gen && state.building && typeof WS.dropCache === 'function') WS.dropCache('books:list:');
    });
  }

  function loadMore() {
    if (state.moreBusy || !state.cursor || signal.aborted) return;
    state.moreBusy = true;
    const gen = state.gen;
    const page = state.renderGen;
    const btn = $('moreBtn');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    WS.getJSON(libraryUrl(state.cursor), { signal: signal }).then(function (data) {
      // Page 1 was drawn again meanwhile (a fresh answer over the kept copy):
      // this page followed the old one and would repeat or skip books.
      if (gen !== state.gen || page !== state.renderGen || signal.aborted) return;
      appendCards($('libraryGrid'), (data && Array.isArray(data.items)) ? data.items : []);
      setMore(data && data.next_cursor);
    }, function (err) {
      if (gen !== state.gen || page !== state.renderGen || quiet(err)) return;
      // The button stays, to try again.
      state.moreBusy = false;
      btn.disabled = false;
      btn.textContent = 'Try again';
    });
  }

  function choose(format, sort) {
    if (format === state.format && sort === state.sort) return;
    state.format = format;
    state.sort = sort;
    syncControls();
    stopBuildingPoll();
    loadLibrary(false);
  }

  // ---- Search ----

  const SEARCH_PARTS = ['searchSkeleton', 'searchGrid', 'searchEmpty', 'searchError'];
  function showSearchPart(which) {
    SEARCH_PARTS.forEach(function (id) { $(id).classList.toggle('hidden', id !== which); });
  }

  // The count a screen reader hears. With no match the empty message says it
  // for everyone else, so the line is then for the screen reader alone.
  function setStatus(text, readerOnly) {
    const line = $('searchStatus');
    line.textContent = text;
    line.classList.toggle('sr-only', !!readerOnly);
  }

  function setSearching(on) {
    state.searching = on;
    $('browseArea').classList.toggle('hidden', on);
    $('searchSection').classList.toggle('hidden', !on);
  }

  function leaveSearch() {
    state.searchGen++;
    state.query = '';
    ctx.clearTimeout(searchTimer);
    setSearching(false);
  }

  function requestHref(data, query) {
    const given = data && typeof data.request_url === 'string' ? data.request_url : '';
    return given.indexOf('/requests?q=') === 0 ? given : '/requests?q=' + encodeURIComponent(query);
  }

  function runSearch(query) {
    const gen = ++state.searchGen;
    state.query = query;
    setSearching(true);
    setStatus('Searching\u2026', false);
    showSkeleton($('searchSkeleton'), 6);
    showSearchPart('searchSkeleton');
    readLive('/api/books/search?q=' + encodeURIComponent(query) + '&limit=' + SEARCH_LIMIT).then(function (data) {
      if (gen !== state.searchGen || signal.aborted) return;
      const items = (data && Array.isArray(data.items)) ? data.items : [];
      setNotes('library', data && data.notes);
      const grid = $('searchGrid');
      grid.textContent = '';
      if (items.length) {
        appendCards(grid, items);
        setStatus(items.length === 1 ? '1 book found' : items.length + ' books found', false);
        showSearchPart('searchGrid');
        return;
      }
      setStatus('No matches', true);
      const held = data && data.request_url === null;
      if (held) {
        // A source is not answering, so a book may be there that cannot be listed: no "request it".
        const why = (data.notes || []).filter(function (n) { return n && n.text; })[0];
        $('searchEmptyTitle').textContent = 'No matches right now';
        $('searchEmptyText').textContent = !why ? 'Try the search again in a moment.'
          : why.reason === 'not_connected' ? why.text + '.' : why.text + '. Try the search again in a moment.';
        $('searchRequest').classList.add('hidden');
      } else if (state.embed) {
        // Requests is Seerr's own page, which cannot ask for a book and drops the search.
        $('searchEmptyTitle').textContent = 'Not in the library yet';
        $('searchEmptyText').textContent = 'No books match “' + query + '”. Check the spelling.';
        $('searchRequest').classList.add('hidden');
      } else {
        $('searchEmptyTitle').textContent = 'No books match “' + query + '”';
        $('searchEmptyText').textContent = 'Check the spelling, or ask for it.';
        $('searchRequest').classList.remove('hidden');
        $('searchRequest').href = requestHref(data, query);
      }
      showSearchPart('searchEmpty');
    }, function (err) {
      if (gen !== state.searchGen || quiet(err)) return;
      setStatus('', false);
      showSearchPart('searchError');
    });
  }

  let searchTimer = 0;
  const input = $('booksSearch');
  input.addEventListener('input', function () {
    ctx.clearTimeout(searchTimer);
    const query = input.value.trim();
    if (!query) { leaveSearch(); return; }
    if (query === state.query && state.searching) return;
    searchTimer = ctx.setTimeout(function () { runSearch(query); }, SEARCH_WAIT_MS);
  }, { signal: signal });
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing) return;
    const query = input.value.trim();
    if (!query) return;
    ctx.clearTimeout(searchTimer);
    runSearch(query);
  }, { signal: signal });

  // ---- Controls ----

  root.querySelectorAll('#formatChips [data-format]').forEach(function (b) {
    b.addEventListener('click', function () { choose(b.getAttribute('data-format'), state.sort); }, { signal: signal });
  });
  $('sortSelect').addEventListener('change', function () {
    const v = $('sortSelect').value;
    choose(state.format, SORTS.indexOf(v) !== -1 ? v : 'added');
  }, { signal: signal });
  $('moreBtn').addEventListener('click', loadMore, { signal: signal });
  $('retryBtn').addEventListener('click', function () { loadLibrary(false); loadContinue(); }, { signal: signal });
  $('emptyReset').addEventListener('click', function () { choose('all', state.sort); }, { signal: signal });
  $('connectRetry').addEventListener('click', retryConnect, { signal: signal });

  // The next page comes in as the button nears the screen; the button is
  // still there for a keyboard or a browser without the observer.
  if (typeof IntersectionObserver === 'function') {
    watcher = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) loadMore();
    }, { rootMargin: '600px 0px' });
    watcher.observe($('moreWrap'));
    const done = new AbortController();
    signal.addEventListener('abort', function () { watcher.disconnect(); done.abort(); }, { once: true, signal: done.signal });
  }

  // ---- Boot ----

  // Before the first await: this person's last view is on the controls from
  // the first frame, and the skeletons already have their shape.
  readView();
  syncControls();
  // The help button runs it on request, whenever.
  if (window.WebServarrTour && typeof window.WebServarrTour.init === 'function') {
    guide = window.WebServarrTour.init({
      seenKey: GUIDE_KEY + user,
      steps: GUIDE_STEPS,
      helpBtn: $('helpBtn'),
      // Started by offerGuide, once the books are drawn.
      autoStart: false,
      signal: signal
    });
  }
  if (window.WSKavita && typeof window.WSKavita.init === 'function') window.WSKavita.init();
  // A sign-in that just failed: no automatic attempt on this visit (the helper
  // remembers), and the message shows when the answer says they are not connected.
  if (window.WSKavita && typeof window.WSKavita.arrivedFromFailedConnect === 'function') window.WSKavita.arrivedFromFailedConnect();

  // Recently added records this visit on the server (its New marks are against the visit before).
  const first = Promise.all([loadContinue(), loadMine('upnext'), loadMine('mylist'), loadMine('recent'), loadMine('popular'), loadLibrary(false)]);
  // A library that never answers does not keep the toolbar a skeleton for ever.
  ctx.setTimeout(commitFrame, 4000);
  if (Object.keys(state.unsettled).length) ctx.setTimeout(function () { settleRow(null); }, CONTINUE_WAIT_MS);

  // The sections are on screen (or their skeletons, which have their shape)
  // before mount resolves, so Back and Forward restore the scroll onto them. A
  // slow answer does not hold that up for long.
  await Promise.race([
    first,
    new Promise(function (resolve) { ctx.setTimeout(resolve, 1500); })
  ]);

  return function () {
    ROW_ORDER.forEach(function (name) { markRow(name, false); });
  };
}
