/**
 * WebServarr, Books (page module)
 *
 * One library of ebooks (Kavita) and audiobooks (Plex): a search box, a
 * Continue row of what the person is partway through, and a cover grid with
 * format chips and a sort. A cover opens the book in a pop-up over the page,
 * at the book's own address (/books/<id>, withBookDialog); a series is one
 * card that opens the series page. In Continue, the round play
 * button on a cover is what picks up from the person's place.
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
 * Also exports what the other Books pages draw with:
 *   renderBookCard(card, { signal })                   a cover card (an <a>)
 *   renderSeriesCard(card, { signal })                 a card of the Series view (a <button>)
 *   renderContinueRow(items, { signal, failed, onChange })  the Continue section, always
 *                                                       (with nothing in progress, one quiet line);
 *                                                       each card's More menu takes it out of the row
 *   coverBox(url, formats, signal, { badges, eager })  the 2:3 cover frame (the book page's: badges off, eager)
 *   noteLine(text, href)                               a quiet line about a source that is down
 *   rememberContinue(user)                             a book was just started: the next visit holds the row's room
 *   rememberRow(kind, user)                            the same for 'upnext' and 'mylist' (a book was just added)
 *   sendBooks(method, url, body)                       a write to the person's own Books data
 *   withBookDialog(ctx, own, changed)                  the book pop-up on the page (pages/book.js
 *                                                       bookDialog) and the page's ctx.onNavigate
 * They touch no DOM at import time.
 *
 * Continue is always shown, so the first-visit guide has it to point at; a
 * person who had books in progress last time gets the room of a row of cards
 * from the first paint, anyone else the room of its one empty line
 * (localStorage and an <html> flag). Under it, two rows of the person's own
 * (books 3b): Up next (their queue, in order: each book with Play or Read,
 * Move earlier, Move later and Remove) and My list (newest first). Each is
 * hidden while it is empty, and held from the first paint for a person who
 * had it last time (localStorage and an <html> flag each).
 *
 * Under them, two discovery shelves (books 3c), held and drawn the same way:
 * Recently added (the newest books, with New on those added since the
 * person's previous visit; loading it records this visit) and Popular on the
 * server (books several people listened to, with the server's rounded label).
 *
 * The toolbar's filters (Author, Series, Narrator) narrow the grid and a
 * search, together with the format chips. Each button opens a picker of the
 * names in the books this person can see (/api/books/facets, with counts): a
 * popover from PICKER_WIDE up, a bottom sheet below, run on the WSUI.modal
 * stack. The filters live in the address (?author=, ?series=, ?narrator=), so
 * Back, a refresh and a shared link keep them; a change is drawn here and the
 * router, which this page asks to replace the address, hands it back
 * (ctx.onNavigate). Exported for the tests: filtersFrom(url), filterHref(filters, base).
 *
 * Group series, a switch beside the sort: on, a series is one card; off,
 * every book is its own card with a "Dune #2" line. Remembered with the
 * format and the sort in the person's view (localStorage).
 *
 * Series, the fourth chip beside the formats (and remembered the same way):
 * the library becomes one card per series (/api/books?view=series), each a
 * fan of its first covers with its name, its author and "5 books", or "Book 2
 * of 5" for a series the person has started. The filters and the sort choose
 * and order the series; the search still finds books; Group series has
 * nothing to do there and is disabled. A card is a button that opens the
 * series in the grid's place (/api/books/series): its heading takes the
 * focus, its books are the library's cards in reading order (each opens the
 * book pop-up), and All series goes back to the cards, the focus to the one
 * that opened it. Any change to the list (a chip, the sort, a filter) closes
 * it. Not kept in the address: Back leaves Books as it does for the chips.
 *
 * The audiobook notice says where audiobooks are best heard, in a window
 * over the whole page on every visit to Books. Its Okay works after
 * NOTICE_WAIT_S seconds and closes it for this visit; its Don't show again
 * works after NOTICE_OFF_WAIT_S seconds and turns it off for the account
 * (kept on the server, so on every device). Scrolled to the end of the words
 * while Okay still waits, Okay says "Go back up and read the message!" (as it
 * does under a pointer or keyboard focus, in the page's CSS). The first-visit
 * guide waits for it to close.
 */

const PAGE_SIZE = 36;
const SEARCH_WAIT_MS = 300;
const SEARCH_LIMIT = 60;
const SKELETON_CARDS = 12;
const BUILDING_POLL_MS = 10000;
// How long the first books wait for the rows above them (Continue, Up next,
// My list, the shelves). A row drawn after the books would push them down, and
// a remembered row can still come back different (emptied, or newly filled),
// so every row is waited for on every visit; past this a slow source no longer
// holds up the library. The toolbar's skeleton gives way at the same time.
const ROWS_WAIT_MS = 4000;

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
// Every row above the library, top to bottom (Recently added beside Continue on a wide screen).
const ROW_ORDER = ['continue', 'recent', 'upnext', 'mylist', 'popular'];
const MOVE_MS = 200;               // a card trading places with its neighbour
const GUIDE_KEY = 'webservarr_books_guide_seen:';
// The audiobook notice: Don't show again is kept for the account (POST state
// "off"), and in this browser session's own record, per account ("off"), so a
// page fetched before the answer reached the server does not show it again.
const NOTICE_URL = '/api/books/me/notice';
const NOTICE_SESSION_KEY = 'webservarr_books_notice_session:';
// Seconds the window's Okay, and its Don't show again, wait before they work.
const NOTICE_WAIT_S = 30;
const NOTICE_OFF_WAIT_S = 45;
// The words count as read to the end within this many pixels of their bottom.
const NOTICE_END_PX = 8;
// The cards have their covers by then, so the first spotlight sits on something drawn.
const GUIDE_WAIT_MS = 900;

// The first-visit guide (the engine is js/tour.js, shared with the reader): what
// the page can do, in the order a person meets it. A step whose target is not
// on screen is shown in the middle of the page instead.
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
    body: 'Books you’ve started, to read or to listen to, wait in a Continue row. Press play on a cover to carry on from your place.'
  },
  {
    target: '#formatChips',
    icon: 'tune',
    title: 'Ebooks, audiobooks or both',
    body: 'Show everything, only the books you can read, only the ones you can listen to, or one card for each series.'
  },
  {
    target: '#libraryGrid > li:first-child',
    fallback: '#libraryGrid',
    icon: 'menu_book',
    title: 'Open a book',
    body: 'Tap a cover to see the book. Read opens the ebook and Listen plays the audiobook, and each keeps your place.'
  }
];

// 'series' is the Series view: every format, one card per series.
const FORMATS = ['all', 'ebook', 'audio', 'series'];
const SORTS = ['added', 'title', 'author'];
const SORT_LABELS = { added: 'Recently added', title: 'Title', author: 'Author' };
const TYPEAHEAD_MS = 500;          // letters typed within this of each other are one search

// The toolbar's filters: one name each, carried in the address (?author=,
// ?series=, ?narrator=) so Back, a refresh and a shared link keep them. The
// server matches a name ignoring case and spacing, among the books this
// person may see.
const FILTER_KINDS = ['author', 'series', 'narrator'];
const FILTERS = {
  author: { label: 'Author', plural: 'authors', every: 'All authors', find: 'Find an author' },
  series: { label: 'Series', plural: 'series', every: 'All series', find: 'Find a series' },
  narrator: { label: 'Narrator', plural: 'narrators', every: 'All narrators', find: 'Find a narrator' }
};
const NAME_MAX = 200;              // the longest name the server takes
const PICKER_SHOWN = 200;          // names drawn at once; typing narrows the rest
const PICKER_WIDE = '(min-width: 640px)';   // a popover from here up, a bottom sheet below
const SHEET_CLOSE_MS = 160;
const POP_CLOSE_MS = 160;          // theme.css .ws-pop's 140ms close, and a frame
const FORMAT_INFO = {
  ebook: { icon: 'menu_book', label: 'Ebook' },
  audio: { icon: 'headphones', label: 'Audiobook' }
};

// Class strings are written out whole: Tailwind only builds what it can read.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-4 gap-y-6';
const CHIP_ON = 'inline-flex items-center justify-center h-11 px-3 lg:h-10 lg:px-4 rounded-full text-[15px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus bg-primary text-bright';
const CHIP_OFF = 'inline-flex items-center justify-center h-11 px-3 lg:h-10 lg:px-4 rounded-full text-[15px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus bg-frosted-blue/[0.07] text-frosted-blue/70 hover:bg-frosted-blue/10 hover:text-frosted-blue';
const LINK_FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
// A filter button: a format chip's shape with a picker's arrow; filled like a pressed chip while it is in use.
const FILTER_ON = 'inline-flex h-11 shrink-0 items-center justify-center gap-1 rounded-full pl-3 pr-2 lg:h-10 lg:pl-4 lg:pr-3 text-[15px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus bg-primary text-bright';
const FILTER_OFF = 'inline-flex h-11 shrink-0 items-center justify-center gap-1 rounded-full pl-3 pr-2 lg:h-10 lg:pl-4 lg:pr-3 text-[15px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus bg-frosted-blue/[0.07] text-frosted-blue/70 hover:bg-frosted-blue/10 hover:text-frosted-blue';
// A filter in use: its kind, its name and a cross; the whole pill removes it.
const ACTIVE_CHIP = 'inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-full pl-3 pr-2 text-[15px] bg-frosted-blue/10 text-frosted-blue hover:bg-frosted-blue/[0.15] transition-colors ' + LINK_FOCUS;
const CLEAR_ALL = 'inline-flex h-9 shrink-0 items-center rounded-full px-3 text-[15px] font-semibold text-frosted-blue/70 hover:bg-frosted-blue/[0.07] hover:text-frosted-blue transition-colors ' + LINK_FOCUS;
const OPTION = 'flex min-h-12 sm:min-h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 text-[15px] text-frosted-blue hover:bg-frosted-blue/[0.07]';
// A card of the Series view: a button laid out as a library card.
const SERIES_CARD = 'group block w-full text-left ws-lift rounded-xl ' + LINK_FOCUS;
// Its fan of covers, back to front by how many there are: the first book at the
// front, bottom left; each one after it a step up and to the right, dimmer. All
// inside the card's own 2:3 box, so a row of them is as tall as a row of books.
const FAN = {
  1: ['absolute inset-0'],
  2: ['absolute bottom-0 left-0 w-[88%] rounded-xl bg-background-dark ring-2 ring-background-dark',
    'absolute bottom-[12%] left-[12%] w-[88%] rounded-xl bg-background-dark brightness-[.7]'],
  3: ['absolute bottom-0 left-0 w-[76%] rounded-xl bg-background-dark ring-2 ring-background-dark',
    'absolute bottom-[12%] left-[12%] w-[76%] rounded-xl bg-background-dark ring-2 ring-background-dark brightness-[.8]',
    'absolute bottom-[24%] left-[24%] w-[76%] rounded-xl bg-background-dark brightness-[.6]']
};
const SERIES_KEEP_MS = 2 * 60 * 1000;   // pages/books-list.js KEEP_MS: places move

function isAbort(e) { return !!e && e.name === 'AbortError'; }

/** A name as the address carries it: spacing collapsed, at most NAME_MAX. */
function cleanName(value) {
  return String(value || '').split(/\s+/).filter(Boolean).join(' ').slice(0, NAME_MAX);
}

/** The filters an address asks for ({ author, series, narrator }, '' for none). */
export function filtersFrom(url) {
  const params = url && url.searchParams;
  const out = {};
  FILTER_KINDS.forEach(function (k) { out[k] = cleanName(params ? params.get(k) : ''); });
  return out;
}

/** The Books address for these filters, keeping any other part of `base`'s query. */
export function filterHref(filters, base) {
  const url = new URL(base || '/books', 'https://x.invalid');
  FILTER_KINDS.forEach(function (k) {
    url.searchParams.delete(k);
    if (filters[k]) url.searchParams.set(k, filters[k]);
  });
  const qs = url.searchParams.toString();
  return '/books' + (qs ? '?' + qs : '');
}

/** True for a book's own address, /books/<id> (the pop-up's). */
function isBookAddress(url) {
  return !!url && /^\/books\/\d{1,10}\/?$/.test(url.pathname);
}

/**
 * The book pop-up on a Books page (Books, an author's or narrator's page, a
 * series): a book's address is drawn over the page by pages/book.js
 * bookDialog, loaded from the address the server wrote on #bookDialog (stamped,
 * like data-ws-dep on #wsPage). Registers the page's ctx.onNavigate: a book's
 * address opens the pop-up (and is never prefetched); the page's own address
 * under it closes it; anything else goes to own(url, how), the page's own
 * claim (the Books page's filters), or to the router. changed(kind): told of
 * a change made in the pop-up that the page shows ('list', 'queue', 'listen').
 * A full load of /books/<id> opens it at once (the server already shows it).
 */
export function withBookDialog(ctx, own, changed) {
  const host = ctx.root.querySelector('#bookDialog');
  const src = host ? host.getAttribute('data-ws-dep') : '';
  // The page's own history entry, now: a click may move the address before the pop-up loads.
  const st = window.history.state;
  const entry = st && st.ws === 1 && typeof st.i === 'number' ? st.i : null;
  let dialog = null;
  // The link last pressed on the page: the one that opened the pop-up gets the focus back.
  let pressed = null;
  if (src) {
    ctx.root.addEventListener('click', function (e) {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (a && !host.contains(a)) pressed = a;
    }, { capture: true, signal: ctx.signal });
  }
  function opener(url) {
    const a = pressed;
    pressed = null;
    return a && new URL(a.href, window.location.href).pathname === url.pathname ? a : null;
  }
  const ready = !src ? Promise.resolve(null) : import(src).then(function (m) {
    if (ctx.signal.aborted) return null;
    dialog = m.bookDialog({
      root: ctx.root, signal: ctx.signal, url: ctx.url, data: ctx.data, entry: entry,
      setTimeout: ctx.setTimeout, clearTimeout: ctx.clearTimeout, changed: changed
    });
    return dialog;
  }, function (e) {
    if (!ctx.signal.aborted) console.error('[books] the book pop-up did not load', e);
    return null;
  });
  if (isBookAddress(ctx.url)) {
    ready.then(function (d) { if (d) d.open(new URL(ctx.url.href)); });
  }
  if (typeof ctx.onNavigate !== 'function') return;
  ctx.onNavigate(function (url, how) {
    if (src && isBookAddress(url)) {
      const link = opener(url);
      if (dialog) return dialog.open(url, link);
      return ready.then(function (d) {
        if (d) return d.open(url, link);
        // No pop-up to draw it in: the book's own address, loaded whole.
        if (!ctx.signal.aborted && window.WS && WS.router) WS.router.hardNavigate(url.href);
        return '';
      });
    }
    if (dialog && dialog.leave(url)) {
      dialog.at(url);
      return true;
    }
    const took = own ? own(url, how) : false;
    if (took && dialog) dialog.at(url);
    return took;
  }, function (url) { return !!src && isBookAddress(url); });
}

/** "2", "2.5": a number in a series as a shelf writes it. */
function seriesNumber(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '';
  return String(Math.round(n * 100) / 100);
}

/** Text for matching a name as the person types: no accents, no case, spacing collapsed. */
function foldName(text) {
  let s = String(text || '');
  if (typeof s.normalize === 'function') s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Say that this person now has books in Continue, before its answer does. Books
 * holds a row of cards' room from the first frame for a person who had some last
 * time, so a book started here (the book page's Listen) is told to it at once:
 * the next visit does not meet cards it had no room for.
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
 * coverMark on the cover ({ text, accent, icon, data }); opts.seriesLine adds
 * a book's series and number ("Dune #2") on a third line.
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
  if (opts && opts.seriesLine && !series) {
    // Every book on its own (Group series off): its series and its number in
    // it. The name gives way to a long title; the number never does. A book in
    // no series keeps the line's room, so every row is one height.
    const line = el('span', 'flex min-h-5 min-w-0 items-center gap-1 text-[13px] leading-5 text-frosted-blue/70');
    line.setAttribute('data-series-line', '');
    if (card.series) {
      line.appendChild(el('span', 'min-w-0 truncate', card.series));
      const n = seriesNumber(card.series_number);
      if (n) line.appendChild(el('span', 'shrink-0 font-semibold tabular-nums text-frosted-blue', '#' + n));
    }
    a.appendChild(line);
  }
  return a;
}

/** "5 books", "1 book". */
function bookCount(n) {
  const count = typeof n === 'number' && isFinite(n) ? n : 0;
  return count + (count === 1 ? ' book' : ' books');
}

/**
 * A card of the Series view: a button (it opens the series on the page) with
 * a fan of the series' first covers (card.covers, else its one cover_url),
 * the series' formats on the front one, the name (two lines of room, as a
 * book's title), its author, and "5 books", or the person's place in it
 * ("Book 2 of 5", card.progress_label) when they have started it. The same
 * lines as a library card with a series line, so a skeleton holds either.
 */
export function renderSeriesCard(card, opts) {
  const signal = opts && opts.signal;
  const b = el('button', SERIES_CARD);
  b.type = 'button';
  // What the opened series shows before its answer is in.
  b.setAttribute('data-series', card.series || '');
  b.setAttribute('data-author', card.author || '');
  b.setAttribute('data-count', String(typeof card.count === 'number' ? card.count : 0));
  const given = Array.isArray(card.covers) && card.covers.length ? card.covers : [card.cover_url];
  const covers = given.filter(function (u) { return typeof u === 'string' && u; }).slice(0, 3);
  if (!covers.length) covers.push('');
  const fan = el('span', 'relative block aspect-[2/3]');
  const layers = FAN[covers.length];
  // Back to front, so the first book is drawn last, on top.
  for (let i = covers.length - 1; i >= 0; i--) {
    const layer = el('span', 'block ' + layers[i]);
    if (i > 0) layer.setAttribute('aria-hidden', 'true');
    layer.appendChild(coverBox(covers[i], i === 0 ? card.formats : [], signal, { badges: i === 0 }));
    fan.appendChild(layer);
  }
  b.appendChild(fan);
  b.appendChild(el('span', 'mt-2 text-[15px] font-semibold leading-snug text-frosted-blue line-clamp-2 min-h-[2.75em]', card.series || 'Untitled'));
  b.appendChild(el('span', 'block text-[13px] leading-5 text-frosted-blue/70 truncate min-h-5', card.author || ''));
  const place = typeof card.progress_label === 'string' ? card.progress_label : '';
  const line = el('span', 'flex min-h-5 min-w-0 items-center gap-1 text-[13px] leading-5 ' +
    (place ? 'font-semibold text-frosted-blue' : 'text-frosted-blue/70'));
  line.setAttribute('data-series-count', '');
  line.appendChild(el('span', 'min-w-0 truncate', place || bookCount(card.count)));
  b.appendChild(line);
  return b;
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

// The round button on a Continue cover. Shown on hover or focus where there is
// a mouse; always shown on touch, where there is no hover to find it with.
const RESUME_BTN = 'pointer-events-auto grid size-12 place-items-center rounded-full bg-background-dark/80 text-frosted-blue ' +
  'ring-1 ring-frosted-blue/25 shadow-lg transition-[opacity,background-color,box-shadow] duration-150 hover:bg-background-dark hover:ring-2 hover:ring-frosted-blue ' +
  '[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/cont:opacity-100 group-focus-within/cont:opacity-100 ' + LINK_FOCUS;
// The small More button on a Continue cover's top right corner: shown as the
// play button is, and kept while its menu is open.
const MORE_BTN = 'absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-full bg-background-dark/80 text-frosted-blue ' +
  'ring-1 ring-frosted-blue/25 transition-[opacity,background-color,box-shadow] duration-150 hover:bg-background-dark hover:ring-2 hover:ring-frosted-blue ' +
  '[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/cont:opacity-100 group-focus-within/cont:opacity-100 aria-expanded:opacity-100 ' + LINK_FOCUS;
const MENU_ITEM = 'flex min-h-11 w-full items-center gap-3 rounded-[10px] pl-3 pr-4 text-left text-[15px] font-semibold text-frosted-blue ' +
  'hover:bg-frosted-blue/[0.07] focus:bg-frosted-blue/10 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';
const CONTINUE_EMPTY = 'Books you start will show up here.';
const FADE_MS = 160;               // a Continue card leaving, or coming back
let continueIds = 0;

/**
 * One Continue card. The cover and its words open the book's own page; a
 * round button centred on the cover picks up from the person's place (an
 * audiobook in the player, an ebook in the reader); a small More button on
 * its corner opens the card's menu (onMore). All three are siblings laid over
 * the card, so no control sits inside another.
 */
function continueCard(item, signal, onMore) {
  const audio = item.format === 'audio';
  const resume = item.resume || {};
  const title = item.title || 'Untitled';
  // The lift is the whole card's, so moving onto the button does not drop it.
  const card = el('div', 'group/cont relative w-36 ws-lift rounded-xl');
  const node = el('a', 'block text-left rounded-xl ' + LINK_FOCUS);
  node.href = '/books/' + encodeURIComponent(String(item.book_id));
  node.setAttribute('data-continue-open', '');
  node.setAttribute('aria-label', 'Open ' + title);
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
  node.appendChild(el('span', 'mt-2 text-[15px] font-semibold leading-snug text-frosted-blue line-clamp-2 min-h-[2.75em]', title));
  const progress = el('span', 'block text-[13px] leading-5 text-frosted-blue/70 truncate min-h-5', item.progress_label || '');
  if (item.progress_label) {
    // The name says what the link does; the place is read after it.
    progress.id = 'continueProgress' + (++continueIds);
    node.setAttribute('aria-describedby', progress.id);
  }
  node.appendChild(progress);
  card.appendChild(node);

  // The cover's own box (the card's width, 2:3), so the button is at its centre.
  const spot = el('span', 'pointer-events-none absolute inset-x-0 top-0 flex aspect-[2/3] items-center justify-center');
  let play;
  if (audio) {
    play = el('button', RESUME_BTN);
    play.type = 'button';
    play.setAttribute('data-resume-audio', resume.plex_book_key || '');
    play.setAttribute('aria-label', 'Resume ' + title);
    play.addEventListener('click', function () { resumeAudio(resume.plex_book_key); }, { signal: signal });
  } else {
    play = el('a', RESUME_BTN);
    play.href = resume.read_url || node.href;
    play.setAttribute('data-resume-read', '');
    play.setAttribute('aria-label', 'Continue reading ' + title);
  }
  play.appendChild(icon(audio ? 'play_arrow' : 'auto_stories', 'text-[28px]'));
  spot.appendChild(play);
  card.appendChild(spot);

  if (onMore) {
    const more = el('button', MORE_BTN);
    more.type = 'button';
    more.id = 'continueMore' + (++continueIds);
    more.setAttribute('data-continue-more', '');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', 'More for ' + title);
    more.title = 'More';
    more.appendChild(icon('more_horiz', 'text-[20px]'));
    more.addEventListener('click', function () { onMore(more); }, { signal: signal });
    card.appendChild(more);
  }
  return card;
}

/** A quiet line about a source that is not answering. */
export function noteLine(text, href) {
  const p = el('p', 'flex items-center gap-2 text-[15px] text-frosted-blue/70');
  p.appendChild(icon('info', 'text-[20px]'));
  if (href) {
    // A page that cannot run the Kavita hand-off itself (Your stats) sends the person to the one that can.
    const a = el('a', 'underline underline-offset-2 hover:text-frosted-blue ' + LINK_FOCUS, text);
    a.href = href;
    p.appendChild(a);
  } else {
    p.appendChild(el('span', '', text));
  }
  return p;
}

function motionOff() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A popover (theme.css .ws-pop) just put in the page opens from its closed
    state: drawn closed first, then .is-open, so the transition runs. */
function popIn(node) {
  void node.offsetWidth;
  node.classList.add('is-open');
}

/** Run an animation, then `done` (at once where there is none). */
function animate(node, frames, ms, done) {
  if (typeof node.animate !== 'function') { done(); return; }
  let ran = false;
  const finish = function () { if (!ran) { ran = true; done(); } };
  const a = node.animate(frames, { duration: ms, easing: 'ease-out' });
  if (a && a.finished && typeof a.finished.then === 'function') a.finished.then(finish, finish);
  else finish();
}

/** Where each node is now, to slide them from there after the row changes. */
function lefts(nodes) {
  return nodes.map(function (n) { return n.getBoundingClientRect().left; });
}

/** The cards that moved slide from where they were (transform only, so nothing is
    laid out again); with reduced motion they are simply there. */
function slideFrom(nodes, before) {
  if (motionOff()) return;
  nodes.forEach(function (n, i) {
    const dx = before[i] - n.getBoundingClientRect().left;
    if (!dx || typeof n.animate !== 'function') return;
    n.animate([{ transform: 'translateX(' + dx + 'px)' }, { transform: 'none' }], { duration: MOVE_MS, easing: 'ease-out' });
  });
}

// The one Continue menu open, if any: { btn, close(back) }.
let continueMenu = null;

/**
 * A Continue card's menu (a menu button's menu): one item, "Remove from
 * Continue". A small popover under the More button, inside the window. The
 * item takes the focus; Escape closes it and gives the focus back to the
 * button, Tab closes it and goes on from the button, a press outside it or a
 * scroll closes it. run() is the item's action, after the menu has closed.
 */
function openContinueMenu(btn, run, signal) {
  if (continueMenu) {
    const same = continueMenu.btn === btn;
    continueMenu.close(true);
    if (same) return;
  }
  const ends = new AbortController();
  // ws-pop / ws-frost (theme.css): every popover's open and close, the
  // service status panel's, on the site's one frosted surface.
  const overlay = el('div', 'fixed inset-0 z-[95]');
  overlay.setAttribute('data-continue-menu-layer', '');
  const menu = el('div', 'ws-pop ws-frost absolute w-max min-w-48 max-w-[calc(100vw-2rem)] rounded-2xl border p-1.5');
  menu.id = 'continueMenu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-labelledby', btn.id);
  menu.setAttribute('data-continue-menu', '');
  const item = el('button', MENU_ITEM);
  item.type = 'button';
  item.tabIndex = -1;
  item.setAttribute('role', 'menuitem');
  item.setAttribute('data-continue-remove', '');
  item.appendChild(icon('visibility_off', 'shrink-0 text-[20px] text-frosted-blue/70'));
  item.appendChild(el('span', 'min-w-0 flex-1 whitespace-nowrap', 'Remove from Continue'));
  menu.appendChild(item);
  overlay.appendChild(menu);

  let gone = false;
  function close(back) {
    if (gone) return;
    gone = true;
    ends.abort();
    btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-controls');
    if (continueMenu && continueMenu.btn === btn) continueMenu = null;
    if (back && btn.isConnected) btn.focus({ preventScroll: true });
    if (motionOff()) { overlay.remove(); return; }
    overlay.inert = true;
    menu.classList.remove('is-open');
    window.setTimeout(function () { overlay.remove(); }, POP_CLOSE_MS);
  }
  continueMenu = { btn: btn, close: close };

  item.addEventListener('click', function () { close(false); run(); }, { signal: ends.signal });
  menu.addEventListener('keydown', function (e) {
    if (e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    // The default Tab then goes on from the button, as a menu button's Tab does.
    else if (e.key === 'Tab') close(true);
    // One item: the arrows, Home and End keep it.
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) !== -1) { e.preventDefault(); item.focus(); }
  }, { signal: ends.signal });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); }, { signal: ends.signal });
  window.addEventListener('scroll', function () { close(false); }, { passive: true, capture: true, signal: ends.signal });
  window.addEventListener('resize', function () { close(false); }, { signal: ends.signal });
  if (signal) signal.addEventListener('abort', function () { close(false); }, { once: true, signal: ends.signal });

  document.body.appendChild(overlay);
  // Under the button, its right edge on the button's, inside the window (above it when there is no room below).
  const r = btn.getBoundingClientRect();
  const w = Math.min(menu.getBoundingClientRect().width || 224, window.innerWidth - 32);
  menu.style.left = clamp(r.right - w, 16, Math.max(16, window.innerWidth - w - 16)) + 'px';
  if (window.innerHeight - r.bottom < 96 && r.top > 96) menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  else menu.style.top = (r.bottom + 6) + 'px';
  popIn(menu);
  btn.setAttribute('aria-expanded', 'true');
  btn.setAttribute('aria-controls', menu.id);
  item.focus({ preventScroll: true });
}

/**
 * The Continue section: what the person is partway through, newest first, as
 * a heading and a sideways row of cards. Always a section, so the first-visit
 * guide has it to point at: with nothing in progress it says where those
 * books will be, and when the list could not be read (failed) it says that.
 * Either line is the height books.html's empty skeleton holds.
 *
 * Each card's More menu takes the book out of this person's row (PUT
 * /api/books/<id>/continue-hidden): only the row, never their place in the
 * book, and it comes back by itself once they read or listen further. The
 * card fades out and the cards after it slide over (nothing else on the page
 * moves while there are cards left; the last one going gives way to the empty
 * line); a toast offers Undo, which puts it back where it was. The focus goes
 * to the next card's More button (the previous one's at the end), or to the
 * empty line. opts.onChange(items) hears every change to what the row shows.
 *
 * The page's own record of the visit: opts.gone (book id -> the updated_at
 * the server was sent) is written as a book is taken out and put back, and
 * opts.newest(item) gives the time to send (the newest the page has seen
 * for it). An Undo, or a refused Remove or Undo, that finds this row
 * replaced by a newer one calls opts.redraw() instead.
 */
export function renderContinueRow(items, opts) {
  const o = opts || {};
  const list = items || [];
  const section = el('section', '');
  section.setAttribute('aria-label', 'Continue');
  section.setAttribute('data-continue', '');
  section.appendChild(el('h2', 'mb-3 font-bold leading-snug text-xl text-frosted-blue', 'Continue'));

  function emptyLine(failed) {
    const line = el('p', 'text-[15px] leading-6 text-frosted-blue/70',
      failed ? 'Your books in progress didn’t load.' : CONTINUE_EMPTY);
    line.setAttribute('data-continue-empty', '');
    return line;
  }
  if (!list.length) {
    section.appendChild(emptyLine(o.failed));
    return section;
  }

  // The order the row came in, so Undo puts a card back where it was.
  const order = list.map(function (item) { return String(item.book_id); });
  const shown = {};
  list.forEach(function (item) { shown[String(item.book_id)] = item; });

  function liOf(id) {
    return section.querySelector('li[data-continue-item="' + id + '"]');
  }
  function current() {
    return Array.prototype.slice.call(section.querySelectorAll('li[data-continue-item]')).map(function (li) {
      return shown[li.getAttribute('data-continue-item')];
    });
  }
  function changed() {
    if (typeof o.onChange === 'function') o.onChange(current());
  }

  function cardItem(item) {
    const li = el('li', 'shrink-0');
    li.setAttribute('data-continue-item', String(item.book_id));
    li.appendChild(continueCard(item, o.signal, function (btn) {
      openContinueMenu(btn, function () { remove(String(item.book_id), true); }, o.signal);
    }));
    return li;
  }

  function makeRow() {
    const row = el('ul', 'books-row -mx-4 px-4 lg:mx-0 lg:px-0 flex gap-4 py-1');
    row.setAttribute('data-continue-row', '');
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
    return row;
  }

  const row = makeRow();
  list.forEach(function (item) { row.appendChild(cardItem(item)); });
  section.appendChild(row);

  function rowNow() { return section.querySelector('[data-continue-row]'); }

  function redraw() {
    if (typeof o.redraw === 'function' && !(o.signal && o.signal.aborted)) o.redraw();
  }

  /** Take a card out of the row (sent: tell the server, with a toast to undo it). */
  function remove(id, send) {
    const item = shown[id];
    const at = typeof o.newest === 'function' ? o.newest(item)
      : (item && item.updated_at ? item.updated_at : null);
    if (o.gone) o.gone[id] = at;
    if (!section.isConnected) redraw();
    const li = liOf(id);
    if (!li) return;
    const ul = li.parentNode;
    const next = li.nextElementSibling || li.previousElementSibling;
    const last = !next;
    li.inert = true;
    li.setAttribute('data-leaving', '');
    const fade = motionOff() ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }];
    animate(li, fade, FADE_MS, function () {
      // Undo pressed while it faded: it stays.
      if (!li.isConnected || !li.hasAttribute('data-leaving')) return;
      if (last) {
        // The row gives way to its empty line, its height eased down to the line's.
        const was = ul.getBoundingClientRect().height;
        const line = emptyLine(false);
        // Focusable only from here, for the focus to land on; it draws no ring.
        line.tabIndex = -1;
        line.classList.add('focus:outline-none');
        ul.replaceWith(line);
        if (!motionOff()) {
          const now = line.getBoundingClientRect().height;
          line.style.overflow = 'hidden';
          animate(line, [{ height: was + 'px', opacity: 0 }, { height: now + 'px', opacity: 1 }], MOVE_MS, function () {
            line.style.overflow = '';
          });
        }
        line.focus({ preventScroll: true });
      } else {
        const others = Array.prototype.slice.call(ul.children).filter(function (n) { return n !== li; });
        const before = lefts(others);
        li.remove();
        slideFrom(others, before);
        const more = next.querySelector('[data-continue-more]');
        if (more) more.focus({ preventScroll: true });
      }
      changed();
    });
    if (!send) return;
    const url = '/api/books/' + encodeURIComponent(id) + '/continue-hidden';
    const toast = window.WSUI && typeof window.WSUI.toast === 'function'
      ? window.WSUI.toast('Removed from Continue.', 'ok', { action: { label: 'Undo', run: function () { undo(id, url); } } })
      : null;
    sendBooks('PUT', url, { updated_at: at }).then(null, function () {
      if (toast && typeof toast.remove === 'function') toast.remove();
      if (window.WSUI && typeof window.WSUI.toast === 'function') window.WSUI.toast('Couldn’t remove it from Continue. Try again.', 'err');
      restore(id);
    });
  }

  /** Put a card back where it was in the row, the focus on it. */
  function restore(id) {
    if (o.gone) delete o.gone[id];
    if ((o.signal && o.signal.aborted) || !shown[id]) return;
    if (!section.isConnected) { redraw(); return; }
    const leaving = liOf(id);
    if (leaving) {
      // Still fading out: it stops and comes back as it was.
      leaving.removeAttribute('data-leaving');
      leaving.inert = false;
      if (typeof leaving.getAnimations === 'function') leaving.getAnimations().forEach(function (a) { a.cancel(); });
      const open = leaving.querySelector('[data-continue-open]');
      if (open) open.focus({ preventScroll: true });
      return;
    }
    let ul = rowNow();
    if (!ul) {
      ul = makeRow();
      const line = section.querySelector('[data-continue-empty]');
      if (line) line.replaceWith(ul); else section.appendChild(ul);
    }
    const others = Array.prototype.slice.call(ul.children);
    const before = lefts(others);
    const li = cardItem(shown[id]);
    const at = order.indexOf(id);
    const after = others.find(function (n) { return order.indexOf(n.getAttribute('data-continue-item')) > at; });
    ul.insertBefore(li, after || null);
    slideFrom(others, before);
    animate(li, [{ opacity: 0 }, { opacity: 1 }], FADE_MS, function () {});
    const open = li.querySelector('[data-continue-open]');
    if (open) open.focus({ preventScroll: true });
    changed();
  }

  /** Undo: the card back at once; the server told. Should it refuse, the card goes again. */
  function undo(id, url) {
    restore(id);
    sendBooks('DELETE', url).then(null, function () {
      if (window.WSUI && typeof window.WSUI.toast === 'function') window.WSUI.toast('Couldn’t put it back in Continue. Try again.', 'err');
      remove(id, false);
    });
  }

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
    format: 'all', sort: 'added', group: true,
    // The toolbar's filters, from the address (filtersFrom); '' is no filter.
    filters: filtersFrom(ctx.url),
    // The address a filter change of ours asked the router for (it claims that one).
    ownNav: null,
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
    // The books wait for every row's first answer (up to ROWS_WAIT_MS): a row
    // that comes in after them would push them down. A remembered row has its
    // room held, but its answer may not match the memory (the last book
    // finished, a shelf newly filled), so it is waited for too.
    // unsettled: the rows still waited for.
    unsettled: {}, waiting: [],
    // The toolbar shown in place of its skeleton (the same size): with the
    // books, or on its own once ROWS_WAIT_MS has passed without them.
    toolbarShown: false,
    // Up next: its books in the order on screen; moves sent one after another.
    queue: [], moving: 0, moveChain: null,
    // Counts every redraw of page 1, so a next page asked for before one is dropped.
    renderGen: 0, building: false, guideOffered: false,
    // The library's body on show (showBody), and the series opened from the
    // Series view ({ name, author, count }, or null) drawn in its place.
    body: 'gridSkeleton', opened: null, seriesGen: 0,
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
      if (saved && saved.group === false) state.group = false;
    } catch (e) { /* an old value: the defaults */ }
  }
  function saveView() {
    storageSet(VIEW_KEY + user, JSON.stringify({ format: state.format, sort: state.sort, group: state.group }));
  }

  // Up next and My list are each reserved from the first paint for a person
  // who had that row last time, and Continue gets a row of cards' room rather
  // than its empty line's (theme-loader.js does the same on a full load); this
  // is the soft-navigation visit, before anything is awaited.
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
    state.unsettled[name] = true;
  });

  // ---- The audiobook notice ----

  // A window on every visit, unless the person's account has Don't show
  // again (books_notice "off", from the page's render) or it was pressed
  // earlier in this browser session. Decided before the first await.
  const noticeWin = $('booksNoticeWindow');
  const account = ((ctx.data || {}).user || {}).identity_key || user;
  const noticeKey = NOTICE_SESSION_KEY + account;
  // The window: open, each button's seconds to go, and the guide waiting for it to close.
  const win = { modal: null, left: 0, offLeft: 0, guideWaiting: false, inerted: [], nudgeSaid: false };

  function sessionGet(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function sessionSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch (e) { /* blocked: the server's answer still holds */ }
  }

  /** The page's heading takes the focus, so it is not lost with the window. */
  function focusHeading() {
    const h1 = root.querySelector('h1');
    if (!h1) return;
    if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
    h1.focus({ preventScroll: true });
  }

  /** Everything but the window (the page, the shell) is inert while it is
      open, so neither a pointer nor a screen reader reaches it. Only what was
      not inert already is given back. Live regions stay out of it. */
  function inertAround(node) {
    for (let at = node; at && at !== document.body; at = at.parentElement) {
      const parent = at.parentElement;
      if (!parent) break;
      Array.prototype.forEach.call(parent.children, function (sib) {
        if (sib === at || sib.inert || /^(SCRIPT|STYLE|TEMPLATE|LINK)$/.test(sib.tagName) || sib.hasAttribute('aria-live')) return;
        sib.inert = true;
        win.inerted.push(sib);
      });
    }
  }
  function inertBack() {
    win.inerted.forEach(function (n) { n.inert = false; });
    win.inerted = [];
  }

  /** The count on a button: n seconds to go, or 0 (it works). */
  function setCount(btn, n) {
    btn.querySelector('[data-books-notice-count]').textContent = n > 0 ? '\u00a0(' + n + ')' : '';
    if (n > 0) btn.setAttribute('aria-disabled', 'true');
    else {
      btn.removeAttribute('aria-disabled');
      btn.classList.remove('is-running');
    }
  }

  /** Okay's nudge, "Go back up and read the message!", while it still
      waits: on (the words scrolled to their end) or off. Said once a visit. */
  function setNudge(on) {
    const okay = $('booksNoticeWindowOkay');
    if (on && win.modal && win.left > 0) {
      okay.setAttribute('data-books-notice-nudge', '');
      sayNudge();
    } else okay.removeAttribute('data-books-notice-nudge');
  }
  function sayNudge() {
    if (win.nudgeSaid || !win.modal || win.left <= 0) return;
    win.nudgeSaid = true;
    $('booksNoticeSay').textContent = 'Go back up and read the message!';
  }

  /** The words were scrolled: at their end (the buttons right under them)
      while Okay waits, the nudge; back up, Okay again. Words that fit
      never scroll, so never nudge. */
  function wordsScrolled() {
    const words = $('booksNoticeWindowWords');
    const rest = words.scrollHeight - words.clientHeight - words.scrollTop;
    setNudge(words.scrollHeight > words.clientHeight && rest <= NOTICE_END_PX);
  }

  function tick() {
    if (!win.modal || signal.aborted) return;
    if (win.left > 0) {
      win.left -= 1;
      setCount($('booksNoticeWindowOkay'), win.left);
      // From here Escape and a click outside close it, as Okay does, and it says Okay.
      if (win.left === 0) {
        setNudge(false);
        win.modal.release();
      }
    }
    if (win.offLeft > 0) {
      win.offLeft -= 1;
      setCount($('booksNoticeWindowOff'), win.offLeft);
    }
    if (win.left > 0 || win.offLeft > 0) ctx.setTimeout(tick, 1000);
  }

  /** The window. Nothing closes it for NOTICE_WAIT_S seconds: both buttons
      are aria-disabled (still in the Tab order), and Escape (the modal's
      hold) and a click outside do nothing. Don't show again waits
      NOTICE_OFF_WAIT_S. The counts are said once. */
  function openWindow() {
    const words = $('booksNoticeWindowWords');
    const okay = $('booksNoticeWindowOkay');
    const off = $('booksNoticeWindowOff');
    win.left = NOTICE_WAIT_S;
    win.offLeft = NOTICE_OFF_WAIT_S;
    win.nudgeSaid = false;
    okay.removeAttribute('data-books-notice-nudge');
    setCount(okay, win.left);
    setCount(off, win.offLeft);
    if (!motionOff()) {
      okay.classList.add('is-running');
      off.classList.add('is-running');
    }
    noticeWin.classList.add('is-opening');
    noticeWin.hidden = false;
    // The page's own scrollbar (below lg the page itself scrolls) keeps its room.
    if ((window.innerWidth || 0) > html.clientWidth && html.clientWidth > 0) html.setAttribute('data-books-notice-gutter', '');
    html.setAttribute('data-books-notice-open', '');
    // Words taller than the window scroll inside it, and can then be reached by Tab.
    if (words.scrollHeight > words.clientHeight) words.setAttribute('tabindex', '0');
    else words.removeAttribute('tabindex');
    // Focus goes back to the page's heading when it closes: nothing opened it.
    focusHeading();
    inertAround(noticeWin);
    win.modal = window.WSUI.modal(noticeWin, {
      box: $('booksNoticeBox'),
      initial: $('booksNoticeWindowTitle'),
      hold: true,
      onClose: windowClosed
    });
    ctx.setTimeout(function () {
      if (win.modal && !win.nudgeSaid) {
        $('booksNoticeSay').textContent = 'Okay will work in ' + NOTICE_WAIT_S + ' seconds, and Don\u2019t show again in ' + NOTICE_OFF_WAIT_S + '.';
      }
    }, 400);
    ctx.setTimeout(tick, 1000);
  }

  /** Closed by Okay or Don't show again, by Escape or a click outside once
      Okay works, or by the router before a navigation. Nothing is kept for
      Okay: the window is back on the next visit. */
  function windowClosed() {
    const finished = win.left <= 0;
    win.modal = null;
    $('booksNoticeWindowOkay').removeAttribute('data-books-notice-nudge');
    noticeWin.hidden = true;
    noticeWin.classList.remove('is-opening');
    $('booksNoticeSay').textContent = '';
    html.removeAttribute('data-books-notice-open');
    html.removeAttribute('data-books-notice-gutter');
    inertBack();
    if (finished && win.guideWaiting && !signal.aborted) {
      win.guideWaiting = false;
      ctx.setTimeout(startGuide, 300);
    }
  }

  /** Okay, Escape or a click outside: closed for this visit, once Okay works. */
  function closeWindow() {
    if (!win.modal || win.left > 0) return;
    win.modal.close();
  }

  /** Don't show again, once it works: closed, and off for the account. */
  function turnOff() {
    if (!win.modal || win.offLeft > 0) return;
    sessionSet(noticeKey, 'off');
    win.modal.close();
    // Not on the visit's signal: the answer goes through if they leave at once.
    sendBooks('POST', NOTICE_URL, { state: 'off' }).then(null, function () {
      if (window.WSUI && typeof window.WSUI.toast === 'function') {
        window.WSUI.toast('Don\u2019t show again wasn\u2019t saved, so the notice will be back on your next visit.', 'err');
      }
    });
  }

  if (noticeWin) {
    const brand = window.WEBSERVARR_THEME || (ctx.data || {}).branding || {};
    const site = typeof brand.app_name === 'string' ? brand.app_name.trim() : '';
    root.querySelectorAll('[data-books-notice-site]').forEach(function (n) { n.textContent = site || 'this site'; });
    const server = (ctx.data || {}).books_notice;
    // "window" (an older render may still say "inline"): open it. "off", or
    // Don't show again earlier this session: not.
    let open = (server === 'window' || server === 'inline') && sessionGet(noticeKey) !== 'off';
    // Not over a book's pop-up (a full load of its address): the window waits for the next visit.
    if (open && (html.hasAttribute('data-book-open') || !window.WSUI || typeof window.WSUI.modal !== 'function')) open = false;

    if (open) {
      $('booksNoticeWindowOkay').addEventListener('click', closeWindow, { signal: signal });
      $('booksNoticeWindowOff').addEventListener('click', turnOff, { signal: signal });
      noticeWin.querySelector('[data-books-notice-veil]').addEventListener('click', closeWindow, { signal: signal });
      $('booksNoticeWindowWords').addEventListener('scroll', wordsScrolled, { passive: true, signal: signal });
      // Keyboard focus on Okay while it waits shows the nudge (the CSS); a
      // screen reader hears it said, once.
      $('booksNoticeWindowOkay').addEventListener('focus', function () {
        const okay = $('booksNoticeWindowOkay');
        let keyboard = true;
        try { keyboard = okay.matches(':focus-visible'); } catch (e) { /* older engine: treat as keyboard */ }
        if (keyboard) sayNudge();
      }, { signal: signal });
      // Leaving the page: the window goes with it, and nothing is kept (the
      // router closes it first; this is for any other way the visit ends).
      const leaving = new AbortController();
      signal.addEventListener('abort', function () {
        leaving.abort();
        if (win.modal) win.modal.close();
      }, { once: true, signal: leaving.signal });
      openWindow();
    }
  }

  // ---- Showing one body at a time ----

  const BODIES = ['gridSkeleton', 'libraryGrid', 'errorState', 'buildingState', 'emptyState', 'filterEmpty'];
  function showBody(which) {
    state.body = which;
    // An open series keeps the place: the body changes under it, unseen.
    BODIES.forEach(function (id) { $(id).classList.toggle('hidden', !!state.opened || id !== which); });
    if (which !== 'libraryGrid' || state.opened) $('moreWrap').classList.add('hidden');
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
    showToolbar();
    renderNotes();
    applyRows();
  }

  /** The toolbar for its skeleton, which holds its exact size at every width
      (the controls' own words, unseen, so the rows wrap where theirs do). On
      its own (a library slower than ROWS_WAIT_MS) only the toolbar comes in:
      the rows and notes above and between would move the grid's skeleton, so
      they wait for the books (or their error) and land in that one write.
      alone: and only if it is exactly the skeleton's height (several filters
      in use can wrap to more rows than the skeleton's one); otherwise the
      skeleton stays until the books, before anything is painted. */
  function showToolbar(alone) {
    if (state.toolbarShown) return;
    const skel = $('toolbarSkel');
    const bar = $('toolbar');
    const held = alone ? skel.getBoundingClientRect().height : 0;
    skel.classList.add('hidden');
    bar.classList.remove('hidden');
    if (alone && Math.abs(bar.getBoundingClientRect().height - held) > 0.5) {
      bar.classList.add('hidden');
      skel.classList.remove('hidden');
      return;
    }
    state.toolbarShown = true;
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
      markRow(name, held.has);
    });
  }

  /** A row is drawn with the first books (commitFrame), or at once when they
      are already in. has: it has books (Continue is a section either way). A
      live answer (not a kept copy, not a failure) is what the next visit
      remembers. */
  function placeRow(name, row, remember, has) {
    const any = has === undefined ? !!row : has;
    state.pending[name] = { row: row, has: any };
    if (state.committed) applyRows();
    if (remember) storageSet(rowKey(name), any ? '1' : '0');
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

  // This visit's Continue as the person left it. A book taken out here (gone:
  // id -> the updated_at the server was sent) stays out of every answer drawn
  // or kept, however old the answer: one built before the PUT still has it.
  // newest: the latest activity seen for each book in any answer, which is
  // what a removal sends. raw: the last answer as it came, for a redraw.
  const cont = { gone: {}, newest: {}, raw: null };

  function atOf(value) {
    const n = value ? Date.parse(value) : NaN;
    return isNaN(n) ? -Infinity : n;
  }

  function noteNewest(items) {
    items.forEach(function (item) {
      const id = String(item.book_id);
      if (item.updated_at && atOf(item.updated_at) > atOf(cont.newest[id])) cont.newest[id] = item.updated_at;
    });
  }

  function newestOf(item) {
    if (!item) return null;
    const seen = cont.newest[String(item.book_id)];
    return seen && atOf(seen) > atOf(item.updated_at) ? seen : (item.updated_at || null);
  }

  function withoutGone(data) {
    if (!data || !Array.isArray(data.items)) return data;
    const items = data.items.filter(function (item) { return !(String(item.book_id) in cont.gone); });
    return items.length === data.items.length ? data : Object.assign({}, data, { items: items });
  }

  /** A live answer with newer activity for a book taken out than the server
      was sent (the PUT went from a kept copy): the server is sent the newer
      time, or the book would be back on the next visit. */
  function hideAgain(items) {
    items.forEach(function (item) {
      const id = String(item.book_id);
      if (!(id in cont.gone) || atOf(item.updated_at) <= atOf(cont.gone[id])) return;
      cont.gone[id] = item.updated_at;
      sendBooks('PUT', '/api/books/' + encodeURIComponent(id) + '/continue-hidden', { updated_at: item.updated_at })
        .then(null, function () { /* the row has it out; the next visit may show it again */ });
    });
  }

  function renderContinue(data, fromCache, failed) {
    if (signal.aborted) return;
    if (fromCache) cont.raw = data;
    if (data && Array.isArray(data.items)) noteNewest(data.items);
    const shown = withoutGone(data);
    const items = (shown && Array.isArray(shown.items)) ? shown.items : [];
    setNotes('continue', data && data.notes);
    const row = renderContinueRow(items, {
      signal: signal, failed: failed, onChange: continueChanged,
      gone: cont.gone, newest: newestOf, redraw: redrawContinue
    });
    // A card's menu open on the row this one replaces goes with it (its
    // Remove would act on a row no longer on screen); the focus goes to the
    // same book's More button in the new row.
    const from = continueMenu ? continueMenu.btn.closest('li[data-continue-item]') : null;
    if (continueMenu) continueMenu.close(false);
    placeRow('continue', row, !fromCache && !failed, items.length > 0);
    const back = from && row.querySelector('li[data-continue-item="' + from.getAttribute('data-continue-item') + '"] [data-continue-more]');
    if (back && back.isConnected) back.focus({ preventScroll: true });
  }

  /** The row again from the last answer, as this visit has it now. */
  function redrawContinue() {
    if (cont.raw) renderContinue(cont.raw, true, false);
  }

  /** A book taken out of Continue (or put back): the kept copy is out of date,
      and the next visit holds the room of what the row has now. */
  function continueChanged(items) {
    if (typeof WS.dropCache === 'function') WS.dropCache('books:continue');
    const any = items.length > 0;
    storageSet(rowKey('continue'), any ? '1' : '0');
    markRow('continue', any);
  }

  function loadContinue() {
    return WS.swr('books:continue', function () {
      // What swr draws and keeps: never a book taken out this visit.
      return readLive('/api/books/continue').then(function (data) {
        cont.raw = data;
        if (data && Array.isArray(data.items)) {
          noteNewest(data.items);
          hideAgain(data.items);
        }
        return withoutGone(data);
      });
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

  /** After Up next's last card goes: the next thing on the page, so the focus is never lost. */
  function focusAfterRows() {
    const next = root.querySelector('#mylistHost a, #popularHost a, #booksSearch');
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

  /** A skeleton card: a cover and the card's lines. withSeries: the series
      line's room too, shown while every book is its own card (the page style's
      html[data-books-flat] rule, as on books.html's own skeleton). */
  function skeletonCard(withSeries) {
    const d = el('div', '');
    d.appendChild(el('div', 'skel aspect-[2/3] rounded-xl'));
    d.appendChild(el('p', 'mt-2 text-[15px] leading-snug min-h-[2.75em]', ' '));
    d.appendChild(el('p', 'text-[13px] leading-5 min-h-5', ' '));
    if (withSeries) {
      const line = el('p', 'text-[13px] leading-5 min-h-5', ' ');
      line.setAttribute('data-skel', 'series');
      d.appendChild(line);
    }
    return d;
  }

  function showSkeleton(grid, count) {
    grid.textContent = '';
    for (let i = 0; i < count; i++) grid.appendChild(skeletonCard(grid.id === 'gridSkeleton'));
  }

  /** Every book is its own card: Group series off, or a series filter (the server lists a series' books one by one). */
  function flat() {
    return !state.group || !!state.filters.series;
  }

  function seriesView() {
    return state.format === 'series';
  }

  /** The format the APIs are asked for: the Series view has every format. */
  function apiFormat() {
    return seriesView() ? 'all' : state.format;
  }

  /** The grid skeleton's room for a third line on every card: every book its
      own card, or the Series view's count line (books.html; theme-loader.js on a full load). */
  function syncFlat() {
    if (flat() || seriesView()) html.setAttribute('data-books-flat', '');
    else html.removeAttribute('data-books-flat');
  }

  /** asSeries: the Series view's cards (renderSeriesCard). */
  function appendCards(grid, items, seriesLine, asSeries) {
    items.forEach(function (card) {
      const li = el('li', '');
      li.appendChild(asSeries && card && card.kind === 'series' ? renderSeriesCard(card, { signal: signal })
        : renderBookCard(card, { signal: signal, seriesLine: !!seriesLine }));
      grid.appendChild(li);
    });
  }

  function syncControls() {
    root.querySelectorAll('#formatChips [data-format]').forEach(function (b) {
      const on = b.getAttribute('data-format') === state.format;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.className = on ? CHIP_ON : CHIP_OFF;
    });
    $('sortValue').textContent = SORT_LABELS[state.sort];
    $('groupSwitch').setAttribute('aria-checked', state.group ? 'true' : 'false');
    // The Series view has no books to group.
    $('groupSwitch').disabled = seriesView();
  }

  function setMore(cursor) {
    state.cursor = cursor || null;
    state.moreBusy = false;
    const btn = $('moreBtn');
    btn.disabled = false;
    btn.textContent = 'Show more';
    $('moreWrap').classList.toggle('hidden', !state.cursor || !!state.opened);
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
    if (seriesView()) {
      title = 'No series yet';
      text = hasNotes ? 'Check back in a moment.' : 'Books that belong to a series show up here, one card for each series.';
    } else if (filtered) {
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
    ctx.setTimeout(startGuide, GUIDE_WAIT_MS);
  }

  function startGuide() {
    // Not over a book's pop-up (a full load of its address): next visit.
    if (signal.aborted || state.searching || state.connectProblem || html.hasAttribute('data-book-open')) return;
    // Off to sign in to Kavita: the page comes back and the guide is then shown (not marked seen now).
    if (state.reconnectTried || (window.WSKavita && typeof window.WSKavita.isLeaving === 'function' && window.WSKavita.isLeaving())) return;
    // Never with the audiobook notice's window: it starts once that has closed.
    if (win.modal) { win.guideWaiting = true; return; }
    const first = !guide.hasBeenSeen();
    guide.maybeStart();
    // Seen as soon as it has been shown, not only when it is finished: a person who
    // leaves the page half way is not walked through it again on every visit.
    if (first && guide.isActive()) storageSet(GUIDE_KEY + user, '1');
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
      appendCards($('libraryGrid'), items, flat(), seriesView());
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
    // Filters that match nothing: one line and the way back, whatever the format says.
    if (anyFilter()) { showBody('filterEmpty'); return; }
    showEmpty(state.notes.library.length > 0);
  }

  function libraryUrl(cursor) {
    const view = seriesView() ? '&view=series' : state.group ? '' : '&group=false';
    return '/api/books?format=' + apiFormat() + '&sort=' + state.sort + '&limit=' + PAGE_SIZE +
      view + filterQuery('') + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
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
    // A new list: an open series gives way to it (the focus stays on the control used).
    closeSeries(false);
    showBody('gridSkeleton');
    showSkeleton($('gridSkeleton'), SKELETON_CARDS);
    const kept = seriesView() ? 'series:' + state.sort : state.format + ':' + state.sort + (state.group ? '' : ':flat');
    return WS.swr('books:list:' + kept + filterKey(), function () {
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
      appendCards($('libraryGrid'), (data && Array.isArray(data.items)) ? data.items : [], flat(), seriesView());
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
    if (format === state.format && sort === state.sort) {
      // Series pressed again with a series open: back to every series.
      if (state.opened) closeSeries(true, true);
      return;
    }
    state.format = format;
    state.sort = sort;
    syncControls();
    syncFlat();
    stopBuildingPoll();
    loadLibrary(false);
  }

  /** Group series on or off: the books again, every book its own card when off. Remembered at once. */
  function setGroup(on) {
    if (on === state.group || seriesView()) return;
    state.group = on;
    syncControls();
    saveView();
    syncFlat();
    stopBuildingPoll();
    loadLibrary(false);
  }

  // ---- One series, opened from the Series view ----

  /** "6 books by Frank Herbert, in reading order". */
  function seriesMeta(author, count) {
    return bookCount(count) + (author ? ' by ' + author : '') + ', in reading order';
  }

  /** A card of the Series view pressed: the series takes the grid's place,
      its heading the focus, and its books are asked for. */
  function openSeries(card) {
    const name = card.getAttribute('data-series') || '';
    if (!name) return;
    const count = parseInt(card.getAttribute('data-count') || '0', 10) || 0;
    state.opened = { name: name, author: card.getAttribute('data-author') || '', count: count };
    $('seriesTitle').textContent = name;
    $('seriesMeta').textContent = seriesMeta(state.opened.author, count);
    showBody(state.body);
    $('seriesOpen').classList.remove('hidden');
    // Its top (All series, the heading) at the top of the screen, clear of the
    // phone's header (the section's scroll margin), so its books are in view.
    $('seriesTitle').focus({ preventScroll: true });
    if (typeof $('seriesOpen').scrollIntoView === 'function') $('seriesOpen').scrollIntoView({ block: 'start' });
    loadSeries();
  }

  function seriesSkeleton(count) {
    const grid = $('seriesGrid');
    grid.textContent = '';
    for (let i = 0; i < Math.max(1, Math.min(count || SKELETON_CARDS, SKELETON_CARDS)); i++) {
      const li = el('li', '');
      li.setAttribute('aria-hidden', 'true');
      li.appendChild(skeletonCard(true));
      grid.appendChild(li);
    }
    grid.setAttribute('aria-busy', 'true');
  }

  /** Its books, in the server's reading order (numbered first, then by title),
      as the library's cards with their series and number. */
  function drawSeries(data) {
    const items = data && Array.isArray(data.items) ? data.items : [];
    const name = data && typeof data.name === 'string' && data.name ? data.name : state.opened.name;
    if (!items.length) { showSeriesError(); return; }
    $('seriesTitle').textContent = name;
    $('seriesMeta').textContent = seriesMeta(state.opened.author, items.length);
    const grid = $('seriesGrid');
    grid.textContent = '';
    items.forEach(function (item) {
      const li = el('li', '');
      li.appendChild(renderBookCard(Object.assign({}, item, { series: name }), { signal: signal, seriesLine: true }));
      grid.appendChild(li);
    });
    grid.setAttribute('aria-busy', 'false');
    $('seriesError').classList.add('hidden');
    grid.classList.remove('hidden');
  }

  function showSeriesError() {
    $('seriesGrid').classList.add('hidden');
    $('seriesGrid').setAttribute('aria-busy', 'false');
    $('seriesError').classList.remove('hidden');
  }

  function loadSeries() {
    if (!state.opened) return null;
    const gen = ++state.seriesGen;
    const name = state.opened.name;
    $('seriesError').classList.add('hidden');
    $('seriesGrid').classList.remove('hidden');
    seriesSkeleton(state.opened.count);
    // The series page's own kept copy (pages/books-list.js): the same answer.
    return WS.swr('books:series:' + name, function () {
      return readLive('/api/books/series?name=' + encodeURIComponent(name));
    }, function (data) {
      if (gen !== state.seriesGen || signal.aborted) return;
      drawSeries(data);
    }, {
      maxAge: SERIES_KEEP_MS,
      onError: function (err) {
        if (gen !== state.seriesGen || quiet(err)) return;
        showSeriesError();
      }
    });
  }

  /** Back to the series' cards. back: All series (or Series again) was
      pressed, so the focus goes to the card that opened it (onChip: stays on
      the chip); otherwise a new list is on its way and the focus stays put. */
  function closeSeries(back, onChip) {
    if (!state.opened) return;
    const name = state.opened.name;
    state.opened = null;
    state.seriesGen++;
    $('seriesOpen').classList.add('hidden');
    $('seriesGrid').textContent = '';
    showBody(state.body);
    if (state.body === 'libraryGrid') $('moreWrap').classList.toggle('hidden', !state.cursor);
    if (!back || onChip) return;
    const cards = root.querySelectorAll('#libraryGrid [data-series]');
    let card = null;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-series') === name) { card = cards[i]; break; }
    }
    const to = card || root.querySelector('#formatChips [data-format="series"]');
    if (!to) return;
    // In the middle of the screen, never under the phone's header or tab bar.
    to.focus({ preventScroll: true });
    if (typeof to.scrollIntoView === 'function') to.scrollIntoView({ block: 'center' });
  }

  // ---- Filters: Author, Series, Narrator ----

  function anyFilter() {
    return FILTER_KINDS.some(function (k) { return !!state.filters[k]; });
  }

  /** The filters as query parameters ('&author=…'), all but `skip`. */
  function filterQuery(skip) {
    return FILTER_KINDS.filter(function (k) { return k !== skip && state.filters[k]; }).map(function (k) {
      return '&' + k + '=' + encodeURIComponent(state.filters[k]);
    }).join('');
  }

  /** The part of a kept list's name that is the filters (nothing without any). */
  function filterKey() {
    return anyFilter() ? ':' + FILTER_KINDS.map(function (k) { return encodeURIComponent(state.filters[k]); }).join('|') : '';
  }

  /** The buttons (filled while in use, their names saying which), the rows of
      filters in use (above the books and above a search's results), and the
      skeleton's room for that row. */
  function syncFilters() {
    root.querySelectorAll('#filterButtons [data-filter]').forEach(function (b) {
      const kind = b.getAttribute('data-filter');
      const value = state.filters[kind];
      b.className = value ? FILTER_ON : FILTER_OFF;
      // The visible word first, so a voice command by it still finds the button.
      if (value) b.setAttribute('aria-label', FILTERS[kind].label + ', ' + value);
      else b.removeAttribute('aria-label');
    });
    root.querySelectorAll('[data-active-filters]').forEach(drawActive);
    // The toolbar skeleton's room for that row (books.html; theme-loader.js on a full load).
    if (anyFilter()) html.setAttribute('data-books-filtered', '');
    else html.removeAttribute('data-books-filtered');
    syncFlat();
  }

  function drawActive(host) {
    host.textContent = '';
    const kinds = FILTER_KINDS.filter(function (k) { return !!state.filters[k]; });
    host.classList.toggle('hidden', !kinds.length);
    kinds.forEach(function (kind) {
      const value = state.filters[kind];
      const chip = el('button', ACTIVE_CHIP);
      chip.type = 'button';
      chip.setAttribute('data-remove', kind);
      // Named by its own words, then what a press does: "Author Jane Austen, remove filter".
      chip.title = value;
      chip.appendChild(el('span', 'shrink-0 text-frosted-blue/70', FILTERS[kind].label));
      chip.appendChild(document.createTextNode(' '));
      chip.appendChild(el('span', 'min-w-0 truncate font-semibold', value));
      chip.appendChild(el('span', 'sr-only', ', remove filter'));
      chip.appendChild(icon('close', 'shrink-0 text-[18px]'));
      host.appendChild(chip);
    });
    if (kinds.length) {
      const clear = el('button', CLEAR_ALL, 'Clear all');
      clear.type = 'button';
      clear.setAttribute('data-clear-filters', '');
      host.appendChild(clear);
    }
  }

  /** Take these filters: the controls show them and the books (and a search
      under way) are asked for again. False when nothing changed. */
  function applyFilters(next) {
    const same = FILTER_KINDS.every(function (k) { return (next[k] || '') === state.filters[k]; });
    if (same) return false;
    const was = state.filters;
    state.filters = {};
    FILTER_KINDS.forEach(function (k) { state.filters[k] = next[k] || ''; });
    syncFilters();
    stopBuildingPoll();
    loadLibrary(false);
    if (state.searching && state.query) runSearch(state.query);
    const added = FILTER_KINDS.filter(function (k) { return state.filters[k] && state.filters[k] !== was[k]; })[0];
    say(added ? 'Showing books filtered by ' + FILTERS[added].label.toLowerCase() + ': ' + state.filters[added]
      : anyFilter() ? 'Filter removed' : 'Filters cleared');
    return true;
  }

  /** A filter changed here: the books follow at once, and the address is
      replaced with one that carries the filters (the router records it and
      hands it back to this page, which already has it). */
  function setFilters(next) {
    if (!applyFilters(next)) return;
    const href = filterHref(state.filters, window.location.pathname + window.location.search);
    if (claiming && window.WS && WS.router && typeof WS.router.navigate === 'function') {
      state.ownNav = new URL(href, window.location.href).href;
      Promise.resolve(WS.router.navigate(href, { replace: true })).catch(function () { /* the books are already drawn */ });
    } else {
      try { window.history.replaceState(window.history.state, '', href); } catch (e) { /* the books still follow */ }
    }
  }

  function setFilter(kind, value) {
    const next = {};
    FILTER_KINDS.forEach(function (k) { next[k] = state.filters[k]; });
    next[kind] = cleanName(value);
    setFilters(next);
  }

  /** A pill pressed (or Clear all): the filter goes, and the focus moves to
      the next pill, else the one before, else the filter's own button (the
      search box, over a search's results). */
  function onActiveClick(e) {
    const host = e.currentTarget;
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || !host.contains(b)) return;
    const inToolbar = host.id === 'activeFilters';
    if (b.hasAttribute('data-clear-filters')) {
      setFilters({ author: '', series: '', narrator: '' });
      const first = inToolbar ? root.querySelector('#filterButtons [data-filter]') : input;
      if (first) first.focus();
      return;
    }
    const kind = b.getAttribute('data-remove');
    if (!kind) return;
    const pills = Array.prototype.slice.call(host.querySelectorAll('[data-remove]'));
    const at = pills.indexOf(b);
    const neighbour = pills[at + 1] || pills[at - 1];
    const then = neighbour ? neighbour.getAttribute('data-remove') : null;
    setFilter(kind, '');
    const back = then ? host.querySelector('[data-remove="' + then + '"]')
      : inToolbar ? root.querySelector('#filterButtons [data-filter="' + kind + '"]') : input;
    if (back) back.focus();
  }

  // ---- The picker: a popover from PICKER_WIDE up, a bottom sheet below ----

  // The names each picker offers, per address asked, for this visit.
  const facetCache = {};
  let picker = null;

  function facetUrl(kind) {
    return '/api/books/facets?facet=' + kind + '&format=' + apiFormat() + filterQuery(kind);
  }

  function loadFacet(kind) {
    const url = facetUrl(kind);
    if (!facetCache[url]) {
      // Through readLive, as every list is (on the visit's signal; a picker's list starts no hand-off).
      facetCache[url] = readLive(url, true).then(function (data) {
        const values = data && Array.isArray(data.values) ? data.values : [];
        return values.filter(function (v) { return v && typeof v.name === 'string' && v.name; }).map(function (v) {
          return { name: v.name, count: typeof v.count === 'number' ? v.count : 0, fold: foldName(v.name) };
        });
      });
      // A failure is not kept: the picker's Try again asks again.
      facetCache[url].catch(function () { delete facetCache[url]; });
    }
    return facetCache[url];
  }

  function wide() {
    return typeof window.matchMedia === 'function' && window.matchMedia(PICKER_WIDE).matches;
  }

  /**
   * One filter's picker: a search box over the names in the books this person
   * can see, each with its count, and "All …" to drop the filter. The box is a
   * combobox: the arrows move through the list, Enter picks, Escape closes
   * (WSUI.modal: the focus stays inside and goes back to the button after).
   */
  function openPicker(kind, btn) {
    if (picker) picker.close();
    if (sortMenu) sortMenu.close();
    const info = FILTERS[kind];
    const isWide = wide();
    const ends = new AbortController();
    const listId = 'booksPicker-' + kind;

    let overlay, panel, head;
    if (isWide) {
      // ws-pop / ws-frost (theme.css): every popover's open and close, the
      // service status panel's, on the site's one frosted surface.
      overlay = el('div', 'fixed inset-0 z-[95]');
      overlay.setAttribute('data-pop-layer', '');
      panel = el('div', 'ws-pop ws-frost absolute flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border');
      head = el('div', 'flex items-center gap-2 pb-2 pl-4 pr-2 pt-3');
      head.appendChild(el('h2', 'min-w-0 flex-1 text-[17px] font-semibold text-frosted-blue', info.label));
    } else {
      // The More sheet's own pieces (theme.css ws-sheet-*): the same grip, title and close.
      overlay = el('div', 'ws-sheet z-[95]');
      overlay.appendChild(el('div', 'ws-sheet-scrim'));
      // Focused itself on opening (the keyboard waits): a container, so no ring of its own.
      panel = el('div', 'ws-sheet-panel ws-frost focus:outline-none');
      // The list scrolls, not the panel: the title and the search stay put.
      panel.style.display = 'flex';
      panel.style.flexDirection = 'column';
      panel.style.overflow = 'hidden';
      head = el('div', 'ws-sheet-head');
      const grip = el('span', 'ws-sheet-grip');
      grip.setAttribute('aria-hidden', 'true');
      head.appendChild(grip);
      head.appendChild(el('h2', 'ws-sheet-title', info.label));
    }
    const titleId = listId + '-title';
    head.querySelector('h2').id = titleId;
    panel.setAttribute('aria-labelledby', titleId);
    const close = el('button', isWide
      ? 'grid size-10 shrink-0 place-items-center rounded-full text-frosted-blue/70 hover:bg-frosted-blue/[0.07] hover:text-frosted-blue ' + LINK_FOCUS
      : 'ws-sheet-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.appendChild(icon('close', 'text-[24px]'));
    head.appendChild(close);
    panel.appendChild(head);

    const find = el('div', isWide ? 'relative px-3 pb-2' : 'relative px-1 pb-2');
    find.appendChild(icon('search', 'pointer-events-none absolute top-1/2 -translate-y-1/2 text-[20px] text-frosted-blue/70 ' + (isWide ? 'left-6' : 'left-4')));
    const box = el('input', 'h-11 w-full rounded-[10px] border-0 bg-frosted-blue/[0.07] pl-10 pr-3 text-[16px] text-frosted-blue placeholder:text-frosted-blue/85 focus:outline-none focus:ring-2 focus:ring-focus');
    box.type = 'search';
    box.autocomplete = 'off';
    box.maxLength = NAME_MAX;
    box.placeholder = info.find;
    box.setAttribute('role', 'combobox');
    box.setAttribute('aria-label', info.find);
    box.setAttribute('aria-controls', listId);
    box.setAttribute('aria-expanded', 'true');
    box.setAttribute('aria-autocomplete', 'list');
    find.appendChild(box);
    panel.appendChild(find);

    const list = el('ul', 'min-h-0 flex-1 overflow-y-auto overscroll-contain ' + (isWide ? 'px-2 pb-2' : 'pb-2'));
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', info.label);
    panel.appendChild(list);
    const foot = el('p', 'hidden px-4 pb-3 pt-1 text-[13px] text-frosted-blue/85');
    panel.appendChild(foot);
    const heard = el('p', 'sr-only');
    heard.setAttribute('role', 'status');
    heard.setAttribute('aria-live', 'polite');
    panel.appendChild(heard);
    overlay.appendChild(panel);

    let values = null;            // the names, once in
    let shown = [];               // the options on screen: { value, node }
    let active = -1;

    function setActive(i) {
      if (!shown.length) { active = -1; box.removeAttribute('aria-activedescendant'); return; }
      active = clamp(i, 0, shown.length - 1);
      shown.forEach(function (o, n) {
        o.node.classList.toggle('bg-frosted-blue/10', n === active);
        o.node.classList.toggle('hover:bg-frosted-blue/[0.07]', n !== active);
      });
      box.setAttribute('aria-activedescendant', shown[active].node.id);
      if (typeof shown[active].node.scrollIntoView === 'function') shown[active].node.scrollIntoView({ block: 'nearest' });
    }

    function option(value, name, count, n) {
      const picked = (state.filters[kind] || '') === value;
      const li = el('li', OPTION + (picked ? ' font-semibold' : ''));
      li.id = listId + '-' + n;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', picked ? 'true' : 'false');
      if (value) li.setAttribute('data-value', value);
      else li.setAttribute('data-every', '');
      li.appendChild(icon('check', 'shrink-0 text-[20px] ' + (picked ? 'text-frosted-blue' : 'invisible')));
      li.appendChild(el('span', 'min-w-0 flex-1 truncate', name));
      if (typeof count === 'number') {
        li.appendChild(el('span', 'shrink-0 tabular-nums text-[13px] text-frosted-blue/90', String(count)));
        li.setAttribute('aria-label', name + ', ' + count + (count === 1 ? ' book' : ' books'));
      }
      return li;
    }

    function draw() {
      list.textContent = '';
      list.removeAttribute('aria-busy');
      shown = [];
      foot.classList.add('hidden');
      const q = foldName(box.value);
      const matches = q ? values.filter(function (v) { return v.fold.indexOf(q) !== -1; }) : values;
      // "All …" drops the filter; while a name is typed only names are offered.
      if (!q) shown.push({ value: '', node: option('', info.every, null, 0) });
      matches.slice(0, PICKER_SHOWN).forEach(function (v, i) {
        shown.push({ value: v.name, node: option(v.name, v.name, v.count, i + 1) });
      });
      shown.forEach(function (o) { list.appendChild(o.node); });
      if (!values.length) {
        foot.textContent = 'No ' + info.plural + ' in the books shown.';
        foot.classList.remove('hidden');
      } else if (q && !matches.length) {
        foot.textContent = 'No ' + info.plural + ' match “' + box.value.trim() + '”.';
        foot.classList.remove('hidden');
      } else if (matches.length > PICKER_SHOWN) {
        foot.textContent = 'Showing ' + PICKER_SHOWN + ' of ' + matches.length + '. Type to narrow the list.';
        foot.classList.remove('hidden');
      }
      heard.textContent = q ? (matches.length === 1 ? '1 match' : matches.length + ' matches') : '';
      // The pick in use starts highlighted; otherwise the first.
      const picked = shown.map(function (o) { return o.value; }).indexOf(state.filters[kind] || '');
      setActive(q ? 0 : Math.max(0, picked));
    }

    function loading() {
      list.textContent = '';
      list.setAttribute('aria-busy', 'true');
      ['w-3/4', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/5'].forEach(function (w) {
        const row = el('li', 'flex min-h-12 sm:min-h-10 items-center px-3');
        row.setAttribute('aria-hidden', 'true');
        row.appendChild(el('span', 'skel skel-line ' + w));
        list.appendChild(row);
      });
    }

    function failed() {
      list.textContent = '';
      list.removeAttribute('aria-busy');
      shown = [];
      setActive(-1);
      const row = el('li', 'flex flex-wrap items-center gap-3 px-3 py-3');
      row.appendChild(el('span', 'text-[15px] text-frosted-blue/85', 'The list didn’t load.'));
      const again = el('button', 'inline-flex h-9 items-center rounded-full px-3 text-[15px] font-semibold text-frosted-blue bg-frosted-blue/[0.07] hover:bg-frosted-blue/10 ' + LINK_FOCUS, 'Try again');
      again.type = 'button';
      again.addEventListener('click', function () { fill(); box.focus(); }, { signal: ends.signal });
      row.appendChild(again);
      list.appendChild(row);
    }

    function fill() {
      loading();
      loadFacet(kind).then(function (got) {
        if (ends.signal.aborted) return;
        values = got;
        draw();
      }, function (err) {
        if (ends.signal.aborted || quiet(err)) return;
        failed();
      });
    }

    function pick(i) {
      const o = shown[i];
      if (!o) return;
      picker.close();
      setFilter(kind, o.value);
    }

    box.addEventListener('input', function () { if (values) draw(); }, { signal: ends.signal });
    box.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'PageDown') { e.preventDefault(); setActive(active + 8); }
      else if (e.key === 'PageUp') { e.preventDefault(); setActive(active - 8); }
      else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) pick(active); }
    }, { signal: ends.signal });
    list.addEventListener('click', function (e) {
      const li = e.target && e.target.closest ? e.target.closest('[role="option"]') : null;
      if (!li) return;
      pick(shown.map(function (o) { return o.node; }).indexOf(li));
    }, { signal: ends.signal });
    close.addEventListener('click', function () { picker.close(); }, { signal: ends.signal });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || (e.target.classList && e.target.classList.contains('ws-sheet-scrim'))) picker.close();
    }, { signal: ends.signal });

    let handle = null;
    let gone = false;
    function teardown() {
      if (gone) return;
      gone = true;
      ends.abort();
      btn.setAttribute('aria-expanded', 'false');
      if (picker && picker.overlay === overlay) picker = null;
      const remove = function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
      if (reduced()) { remove(); return; }
      overlay.inert = true;
      if (isWide) {
        panel.classList.remove('is-open');
      } else {
        overlay.classList.remove('is-open');
        overlay.classList.add('is-closing');
      }
      window.setTimeout(remove, isWide ? POP_CLOSE_MS : SHEET_CLOSE_MS);
    }
    picker = {
      overlay: overlay,
      kind: kind,
      close: function () { if (handle) handle.close(); else teardown(); }
    };

    document.body.appendChild(overlay);
    if (isWide) { place(panel, btn); popIn(panel); }
    else {
      // From its closed place, then open: the panel slides up as the More sheet's does.
      void panel.offsetWidth;
      overlay.classList.add('is-open');
    }
    btn.setAttribute('aria-expanded', 'true');
    // Leaving with it open takes it away (the router also closes every dialog first).
    signal.addEventListener('abort', function () { if (picker) picker.close(); }, { once: true, signal: ends.signal });
    fill();
    // On a phone the keyboard waits for a tap in the search: most lists are short.
    const first = isWide ? box : panel;
    if (window.WSUI && typeof window.WSUI.modal === 'function') {
      handle = window.WSUI.modal(overlay, { box: panel, initial: first, onClose: teardown });
    } else {
      if (first === panel) panel.setAttribute('tabindex', '-1');
      first.focus();
      overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); picker.close(); btn.focus(); }
      }, { signal: ends.signal });
    }
  }

  /** The popover under its button (above it when there is more room there), inside the window. */
  function place(panel, btn) {
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 32);
    const left = clamp(r.left, 16, Math.max(16, window.innerWidth - w - 16));
    const below = window.innerHeight - r.bottom - 24;
    const above = r.top - 24;
    panel.style.left = left + 'px';
    if (below >= 280 || below >= above) {
      panel.style.top = (r.bottom + 8) + 'px';
      panel.style.maxHeight = Math.min(448, below) + 'px';
    } else {
      panel.style.bottom = (window.innerHeight - r.top + 8) + 'px';
      panel.style.maxHeight = Math.min(448, above) + 'px';
    }
  }

  // ---- The sort: a list of the orders, a popover or a sheet as the pickers are ----

  let sortMenu = null;

  /**
   * The sort's list (a listbox): the order in use is marked with a check and
   * starts highlighted; the arrows, Home and End move the highlight, letters
   * jump to an order, Enter or Space picks, Escape (WSUI.modal) and Tab close
   * it, and the focus goes back to the button. From PICKER_WIDE up it is a
   * small popover under the button; below, the filter pickers' bottom sheet.
   */
  function openSort(btn) {
    if (sortMenu) { sortMenu.close(); return; }
    if (picker) picker.close();
    const isWide = wide();
    const ends = new AbortController();
    const listId = 'booksSortList';

    let overlay, panel;
    const list = el('ul', 'group/sort focus:outline-none ' + (isWide ? 'p-2' : 'pb-2'));
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-labelledby', 'sortLabel');
    list.tabIndex = 0;
    if (isWide) {
      overlay = el('div', 'fixed inset-0 z-[95]');
      overlay.setAttribute('data-pop-layer', '');
      panel = el('div', 'ws-pop ws-frost absolute w-56 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-2xl border');
      panel.appendChild(list);
    } else {
      overlay = el('div', 'ws-sheet z-[95]');
      overlay.appendChild(el('div', 'ws-sheet-scrim'));
      panel = el('div', 'ws-sheet-panel ws-frost focus:outline-none');
      const head = el('div', 'ws-sheet-head');
      const grip = el('span', 'ws-sheet-grip');
      grip.setAttribute('aria-hidden', 'true');
      head.appendChild(grip);
      const title = el('h2', 'ws-sheet-title', 'Sort by');
      title.id = listId + '-title';
      head.appendChild(title);
      const close = el('button', 'ws-sheet-close');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      close.appendChild(icon('close', 'text-[24px]'));
      close.addEventListener('click', function () { sortMenu.close(); }, { signal: ends.signal });
      head.appendChild(close);
      panel.appendChild(head);
      panel.setAttribute('aria-labelledby', title.id);
      panel.appendChild(list);
    }
    overlay.appendChild(panel);

    const shown = SORTS.map(function (value, n) {
      const picked = value === state.sort;
      const li = el('li', OPTION + (picked ? ' font-semibold' : ''));
      li.id = listId + '-' + n;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', picked ? 'true' : 'false');
      li.setAttribute('data-sort', value);
      li.appendChild(icon('check', 'shrink-0 text-[20px] ' + (picked ? 'text-frosted-blue' : 'invisible')));
      li.appendChild(el('span', 'min-w-0 flex-1 truncate', SORT_LABELS[value]));
      list.appendChild(li);
      return { value: value, node: li };
    });
    let active = -1;
    function setActive(i) {
      active = clamp(i, 0, shown.length - 1);
      shown.forEach(function (o, n) {
        // The highlight, and a ring on it while the list has the keyboard's focus.
        o.node.classList.toggle('bg-frosted-blue/10', n === active);
        o.node.classList.toggle('group-focus-visible/sort:outline', n === active);
        o.node.classList.toggle('group-focus-visible/sort:outline-2', n === active);
        o.node.classList.toggle('group-focus-visible/sort:-outline-offset-2', n === active);
        o.node.classList.toggle('group-focus-visible/sort:outline-frosted-blue', n === active);
        o.node.classList.toggle('hover:bg-frosted-blue/[0.07]', n !== active);
      });
      list.setAttribute('aria-activedescendant', shown[active].node.id);
    }
    setActive(Math.max(0, SORTS.indexOf(state.sort)));

    function pick(i) {
      const o = shown[i];
      if (!o) return;
      // Chosen before the list goes, so the button already says it when the focus lands back on it.
      if (o.value !== state.sort) choose(state.format, o.value);
      sortMenu.close();
    }

    let typed = '';
    let typedAt = 0;
    list.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Home' || e.key === 'PageUp') { e.preventDefault(); setActive(0); }
      else if (e.key === 'End' || e.key === 'PageDown') { e.preventDefault(); setActive(shown.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
      else if (e.key === 'Tab' && isWide) { sortMenu.close(); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Type-ahead: the next order starting with what was typed; the same letter again moves on.
        const now = Date.now();
        typed = now - typedAt > TYPEAHEAD_MS ? e.key.toLowerCase() : typed + e.key.toLowerCase();
        typedAt = now;
        const same = typed.split('').every(function (c) { return c === typed[0]; });
        const want = same ? typed[0] : typed;
        for (let step = same ? 1 : 0; step <= shown.length; step++) {
          const n = (active + step) % shown.length;
          if (SORT_LABELS[shown[n].value].toLowerCase().indexOf(want) === 0) { setActive(n); break; }
        }
      }
    }, { signal: ends.signal });
    list.addEventListener('click', function (e) {
      const li = e.target && e.target.closest ? e.target.closest('[role="option"]') : null;
      if (li) pick(shown.map(function (o) { return o.node; }).indexOf(li));
    }, { signal: ends.signal });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || (e.target.classList && e.target.classList.contains('ws-sheet-scrim'))) sortMenu.close();
    }, { signal: ends.signal });

    let handle = null;
    let gone = false;
    function teardown() {
      if (gone) return;
      gone = true;
      ends.abort();
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-controls');
      if (sortMenu && sortMenu.overlay === overlay) sortMenu = null;
      const remove = function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
      if (reduced()) { remove(); return; }
      overlay.inert = true;
      if (isWide) panel.classList.remove('is-open');
      else {
        overlay.classList.remove('is-open');
        overlay.classList.add('is-closing');
      }
      window.setTimeout(remove, isWide ? POP_CLOSE_MS : SHEET_CLOSE_MS);
    }
    sortMenu = {
      overlay: overlay,
      close: function () { if (handle) handle.close(); else teardown(); }
    };

    document.body.appendChild(overlay);
    if (isWide) { placeSort(panel, btn); popIn(panel); }
    else {
      void panel.offsetWidth;
      overlay.classList.add('is-open');
    }
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-controls', listId);
    signal.addEventListener('abort', function () { if (sortMenu) sortMenu.close(); }, { once: true, signal: ends.signal });
    if (window.WSUI && typeof window.WSUI.modal === 'function') {
      handle = window.WSUI.modal(overlay, { box: panel, initial: list, onClose: teardown });
      // The shared stack gives Escape, the focus kept inside and handed back, and
      // the router's close before it leaves. A popover is the list itself, not a
      // dialog around one; the phone's sheet is a dialog titled Sort by.
      if (isWide) { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
    } else {
      list.focus();
      overlay.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); sortMenu.close(); btn.focus(); }
      }, { signal: ends.signal });
    }
  }

  /** The sort's popover under its button, on the button's side of the window; above it when there is more room there. */
  function placeSort(panel, btn) {
    const r = btn.getBoundingClientRect();
    const w = Math.min(Math.max(224, r.width), window.innerWidth - 32);
    const left = r.left + r.width / 2 > window.innerWidth / 2 ? r.right - w : r.left;
    panel.style.left = clamp(left, 16, Math.max(16, window.innerWidth - w - 16)) + 'px';
    panel.style.width = w + 'px';
    const below = window.innerHeight - r.bottom - 24;
    const above = r.top - 24;
    if (below >= 160 || below >= above) {
      panel.style.top = (r.bottom + 8) + 'px';
      panel.style.maxHeight = below + 'px';
    } else {
      panel.style.bottom = (window.innerHeight - r.top + 8) + 'px';
      panel.style.maxHeight = above + 'px';
    }
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

  /** A search: the rows above the search and the library under it step aside for the results. */
  function setSearching(on) {
    state.searching = on;
    $('browseRows').classList.toggle('hidden', on);
    $('libraryBody').classList.toggle('hidden', on);
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
    readLive('/api/books/search?q=' + encodeURIComponent(query) + '&limit=' + SEARCH_LIMIT + filterQuery('')).then(function (data) {
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
      $('searchClear').classList.add('hidden');
      if (anyFilter()) {
        // The filters may be what hides it: the way out is to drop them, not to ask for the book.
        $('searchEmptyTitle').textContent = 'No books match “' + query + '” with these filters';
        $('searchEmptyText').textContent = 'Clear the filters to search the whole library.';
        $('searchRequest').classList.add('hidden');
        $('searchClear').classList.remove('hidden');
      } else if (held) {
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
  // Its placeholder, cut off on a narrow phone, slides to its end and back
  // until the search has the focus or any text (ui.js; nothing moves under
  // reduced motion). Ends with the visit.
  if (window.WSUI && typeof window.WSUI.marqueePlaceholder === 'function' && $('booksSearchMarquee')) {
    window.WSUI.marqueePlaceholder(input, $('booksSearchMarquee'), signal);
  }
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
  $('sortBtn').addEventListener('click', function () { openSort($('sortBtn')); }, { signal: signal });
  $('sortBtn').addEventListener('keydown', function (e) {
    // The arrows open the list too, as they open a native one.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openSort($('sortBtn')); }
  }, { signal: signal });
  $('groupSwitch').addEventListener('click', function () { setGroup(!state.group); }, { signal: signal });
  $('moreBtn').addEventListener('click', loadMore, { signal: signal });
  $('retryBtn').addEventListener('click', function () { loadLibrary(false); loadContinue(); }, { signal: signal });
  $('emptyReset').addEventListener('click', function () { choose('all', state.sort); }, { signal: signal });
  // A card of the Series view opens its series; All series and Try again.
  $('libraryGrid').addEventListener('click', function (e) {
    const card = e.target && e.target.closest ? e.target.closest('button[data-series]') : null;
    if (card && seriesView()) openSeries(card);
  }, { signal: signal });
  $('seriesBack').addEventListener('click', function () { closeSeries(true); }, { signal: signal });
  $('seriesRetry').addEventListener('click', function () {
    loadSeries();
    $('seriesTitle').focus();
  }, { signal: signal });
  $('connectRetry').addEventListener('click', retryConnect, { signal: signal });

  root.querySelectorAll('#filterButtons [data-filter]').forEach(function (b) {
    const kind = b.getAttribute('data-filter');
    b.addEventListener('click', function () { openPicker(kind, b); }, { signal: signal });
    // A pointer on its way to the button: the names are asked for before the press.
    b.addEventListener('pointerenter', function () { loadFacet(kind).catch(function () { /* the picker asks again */ }); }, { signal: signal });
  });
  root.querySelectorAll('[data-active-filters]').forEach(function (host) {
    host.addEventListener('click', onActiveClick, { signal: signal });
  });
  $('filterEmptyClear').addEventListener('click', function () {
    setFilters({ author: '', series: '', narrator: '' });
    const first = root.querySelector('#filterButtons [data-filter]');
    if (first) first.focus();
  }, { signal: signal });
  $('searchClear').addEventListener('click', function () {
    setFilters({ author: '', series: '', narrator: '' });
    input.focus();
  }, { signal: signal });

  // A filter change of ours, and Back or Forward between two Books
  // addresses, are drawn here: the router only records the address. Any
  // other way in (the sidebar's Books, a link) is a fresh visit, as before.
  // A book's address is the pop-up's (withBookDialog), and only that is not
  // prefetched, so the other links still warm as they did.
  const claiming = typeof ctx.onNavigate === 'function';
  withBookDialog(ctx, function (url, how) {
    if (url.pathname.replace(/\/+$/, '') !== '/books') return false;
    const mine = state.ownNav !== null && state.ownNav === url.href;
    if (!mine && !(how && how.pop)) return false;
    state.ownNav = null;
    applyFilters(filtersFrom(url));
    return true;
  }, function (kind) {
    // A change made in the book's pop-up: the row it shows is drawn again.
    if (kind === 'list') loadMine('mylist');
    else if (kind === 'queue') loadMine('upnext');
    else if (kind === 'listen') loadContinue();
  });

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
  syncFilters();
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
  // A library that never answers does not keep the toolbar a skeleton for
  // ever, and a row that never answers does not hold the books for ever.
  ctx.setTimeout(function () { showToolbar(true); }, ROWS_WAIT_MS);
  ctx.setTimeout(function () { settleRow(null); }, ROWS_WAIT_MS);

  // The sections are on screen (or their skeletons, which have their shape)
  // before mount resolves, so Back and Forward restore the scroll onto them. A
  // slow answer does not hold that up for long.
  await Promise.race([
    first,
    new Promise(function (resolve) { ctx.setTimeout(resolve, 1500); })
  ]);

  return function () {
    ROW_ORDER.forEach(function (name) { markRow(name, false); });
    html.removeAttribute('data-books-filtered');
    html.removeAttribute('data-books-flat');
  };
}
