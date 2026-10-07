/**
 * WebServarr, Books (page module)
 *
 * One library of ebooks (Kavita) and audiobooks (Plex): a search box, a
 * Continue row of what the person is partway through, and a cover grid with
 * filters and a sort. A cover opens the book's own page (/books/<id>); a
 * series is one card that opens the series page. In Continue, the round play
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
 *   renderContinueRow(items, { signal, failed })       the Continue section, always
 *                                                       (with nothing in progress, one quiet line)
 *   coverBox(url, formats, signal, { badges, eager })  the 2:3 cover frame (the book page's: badges off, eager)
 *   noteLine(text, href)                               a quiet line about a source that is down
 *   rememberContinue(user)                             a book was just started: the next visit holds the row's room
 *   rememberRow(kind, user)                            the same for 'upnext' and 'mylist' (a book was just added)
 *   sendBooks(method, url, body)                       a write to the person's own Books data
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
 * The toolbar's Filters button opens a panel that drops over the books (not
 * a dialog: a region under the toolbar, frosted so the covers show faintly
 * through). It holds Format (all, ebooks, audiobooks) and Author, Series and
 * Narrator, each a list of the names in the books this person can see with
 * counts (/api/books/facets, each counted among what the other filters
 * keep), a find box for a long list, and checkboxes: names of one filter are
 * alternatives, the filters all apply, with the search and the sort. Every
 * tick filters the books at once (after LIVE_WAIT_MS, so a run of ticks is
 * one request); the badge and the row of filters in use follow at once. The
 * names live in the address (?author=A&author=B, ?series=, ?narrator=), so
 * Back, a refresh and a shared link keep them; a change is drawn here and the
 * router, which this page asks to replace the address, hands it back
 * (ctx.onNavigate). The format and the sort are this person's remembered
 * view (localStorage), as is Group series beside the sort: off, every book is
 * its own card with a "Dune #2" line. Exported for the tests:
 * filtersFrom(url), filterHref(filters, base).
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
    target: '#filtersBtn',
    icon: 'tune',
    title: 'Narrow the library',
    body: 'Filters shows only ebooks or only audiobooks, or the books of an author, a series or a narrator. The books change as you tick.'
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
const SORT_LABELS = { added: 'Recently added', title: 'Title', author: 'Author' };
const TYPEAHEAD_MS = 500;          // letters typed within this of each other are one search

// The filters panel's names: any number of each, carried in the address
// (?author=A&author=B, ?series=, ?narrator=) so Back, a refresh and a shared
// link keep them. The server matches a name ignoring case and spacing, among
// the books this person may see.
const FILTER_KINDS = ['author', 'series', 'narrator'];
const FILTERS = {
  author: { label: 'Author', plural: 'authors' },
  series: { label: 'Series', plural: 'series' },
  narrator: { label: 'Narrator', plural: 'narrators' }
};
const FORMAT_WORDS = { ebook: 'Ebooks', audio: 'Audiobooks' };
const NAME_MAX = 200;              // the longest name the server takes
const NAMES_MAX = 50;              // names of one filter the server takes at once
const FACET_SHOWN = 6;             // names a list shows before "Show all"
const FACET_FIND_FROM = 8;         // a find box once a list is longer than this
const FACET_DRAWN = 200;           // names drawn at once; the find box narrows the rest
const LIVE_WAIT_MS = 150;          // ticks this close together are one request
const PANEL_MIN_PX = 360;          // less room than this under the toolbar: the page scrolls it up first
const PICKER_WIDE = '(min-width: 640px)';   // the sort: a popover from here up, a bottom sheet below
const SHEET_CLOSE_MS = 200;
const FORMAT_INFO = {
  ebook: { icon: 'menu_book', label: 'Ebook' },
  audio: { icon: 'headphones', label: 'Audiobook' }
};

// Class strings are written out whole: Tailwind only builds what it can read.
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-4 gap-y-6';
const LINK_FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frosted-blue';
// A filter in use: its kind, its name and a cross; the whole pill removes it.
const ACTIVE_CHIP = 'inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-full pl-3 pr-2 text-[15px] bg-frosted-blue/10 text-frosted-blue hover:bg-frosted-blue/[0.15] transition-colors ' + LINK_FOCUS;
const CLEAR_ALL = 'inline-flex h-9 shrink-0 items-center rounded-full px-3 text-[15px] font-semibold text-frosted-blue/70 hover:bg-frosted-blue/[0.07] hover:text-frosted-blue transition-colors ' + LINK_FOCUS;
const OPTION = 'flex min-h-12 sm:min-h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 text-[15px] text-frosted-blue hover:bg-frosted-blue/[0.07]';
// A name in the filters panel: a real checkbox (visually hidden; the box beside it shows it), the name and its count.
const FACET_OPT = 'group/opt -mx-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2 text-[15px] text-frosted-blue hover:bg-frosted-blue/[0.07] @lg:min-h-10';
const FACET_BOX = 'grid size-5 shrink-0 place-items-center rounded-[5px] border-2 border-frosted-blue/60 text-frosted-blue peer-checked:border-frosted-blue peer-checked:bg-primary peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-frosted-blue';
const FACET_MARK = 'text-[16px] font-bold opacity-0 group-has-[:checked]/opt:opacity-100';
const FACET_NAME = 'min-w-0 flex-1 truncate group-has-[:checked]/opt:font-semibold';
const FACET_COUNT = 'shrink-0 text-[13px] tabular-nums text-frosted-blue/70';
// A list opened with Show all scrolls inside its column where the columns sit side by side.
const FACET_LIST_ALL = '@lg:max-h-72 @lg:overflow-y-auto @lg:overscroll-contain @lg:pr-1';

function isAbort(e) { return !!e && e.name === 'AbortError'; }

/** A name as the address carries it: spacing collapsed, at most NAME_MAX. */
function cleanName(value) {
  return String(value || '').split(/\s+/).filter(Boolean).join(' ').slice(0, NAME_MAX);
}

/** A name as the server compares it: spacing collapsed, case ignored (accents kept). */
function nameKey(value) {
  let s = cleanName(value);
  if (typeof s.normalize === 'function') s = s.normalize('NFC');
  return s.toLowerCase();
}

/** One filter's names: cleaned, blanks and repeats (by nameKey) dropped, at most NAMES_MAX. */
function cleanNames(values) {
  const out = [];
  const seen = {};
  [].concat(values || []).forEach(function (v) {
    const name = cleanName(v);
    const key = nameKey(name);
    if (!name || seen[key] || out.length >= NAMES_MAX) return;
    seen[key] = true;
    out.push(name);
  });
  return out;
}

/** The filters an address asks for ({ author, series, narrator }, each a list of names, empty for none). */
export function filtersFrom(url) {
  const params = url && url.searchParams;
  const out = {};
  FILTER_KINDS.forEach(function (k) { out[k] = cleanNames(params ? params.getAll(k) : []); });
  return out;
}

/** The Books address for these filters (a name or a list of names each), keeping any other part of `base`'s query. */
export function filterHref(filters, base) {
  const url = new URL(base || '/books', 'https://x.invalid');
  FILTER_KINDS.forEach(function (k) {
    url.searchParams.delete(k);
    cleanNames(filters[k]).forEach(function (v) { url.searchParams.append(k, v); });
  });
  const qs = url.searchParams.toString();
  return '/books' + (qs ? '?' + qs : '');
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
let continueIds = 0;

/**
 * One Continue card. The cover and its words open the book's own page; a
 * round button centred on the cover picks up from the person's place (an
 * audiobook in the player, an ebook in the reader). The two are siblings,
 * the button laid over the cover, so neither control sits inside the other.
 */
function continueCard(item, signal) {
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

/**
 * The Continue section: what the person is partway through, newest first, as
 * a heading and a sideways row of cards. Always a section, so the first-visit
 * guide has it to point at: with nothing in progress it says where those
 * books will be, and when the list could not be read (failed) it says that.
 * Either line is the height books.html's empty skeleton holds.
 */
export function renderContinueRow(items, opts) {
  const o = opts || {};
  const list = items || [];
  const section = el('section', '');
  section.setAttribute('aria-label', 'Continue');
  section.setAttribute('data-continue', '');
  section.appendChild(el('h2', 'mb-3 font-bold leading-snug text-xl text-frosted-blue', 'Continue'));
  if (!list.length) {
    const line = el('p', 'text-[15px] leading-6 text-frosted-blue/70',
      o.failed ? 'Your books in progress didn’t load.' : 'Books you start will show up here.');
    line.setAttribute('data-continue-empty', '');
    section.appendChild(line);
    return section;
  }
  const row = el('ul', 'books-row -mx-4 px-4 lg:mx-0 lg:px-0 flex gap-4 py-1');
  list.forEach(function (item) {
    const li = el('li', 'shrink-0');
    li.appendChild(continueCard(item, o.signal));
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
    // The filters panel's names, from the address (filtersFrom); an empty list is no filter.
    filters: filtersFrom(ctx.url),
    // The format and filters the books on screen were last asked for with (filterSig).
    asked: '',
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

  // The view is this person's own on this browser (localStorage, in try/catch:
  // a private window keeps the choice for the visit only).
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
    if (hint === null) state.unsettled[name] = true;
  });

  // ---- Showing one body at a time ----

  const BODIES = ['gridSkeleton', 'libraryGrid', 'errorState', 'buildingState', 'emptyState', 'filterEmpty'];
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

  function renderContinue(data, fromCache, failed) {
    if (signal.aborted) return;
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    setNotes('continue', data && data.notes);
    placeRow('continue', renderContinueRow(items, { signal: signal, failed: failed }), !fromCache && !failed, items.length > 0);
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
    const next = root.querySelector('#mylistHost a, #recentHost a, #popularHost a, #filtersBtn');
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
    return !state.group || state.filters.series.length > 0;
  }

  function appendCards(grid, items, seriesLine) {
    items.forEach(function (card) {
      const li = el('li', '');
      li.appendChild(renderBookCard(card, { signal: signal, seriesLine: !!seriesLine }));
      grid.appendChild(li);
    });
  }

  function syncControls() {
    root.querySelectorAll('input[name="booksFormat"]').forEach(function (r) { r.checked = r.value === state.format; });
    $('sortValue').textContent = SORT_LABELS[state.sort];
    $('groupSwitch').setAttribute('aria-checked', state.group ? 'true' : 'false');
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
      // Not over a search or the open filters panel (the next visit offers it then).
      if (signal.aborted || state.searching || state.connectProblem || panelOpen()) return;
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
    liveBusy(false);
    state.building = false;
    if (items.length) {
      stopBuildingPoll();
      saveView();
      appendCards($('libraryGrid'), items, flat());
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
    return '/api/books?format=' + state.format + '&sort=' + state.sort + '&limit=' + PAGE_SIZE +
      (state.group ? '' : '&group=false') + filterQuery() + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  }

  /** The books on screen are being asked for again (a tick in the panel): dimmed and busy until the answer. */
  function liveBusy(on) {
    const grid = $('libraryGrid');
    grid.classList.toggle('opacity-60', on);
    if (on) grid.setAttribute('aria-busy', 'true'); else grid.removeAttribute('aria-busy');
  }

  function failedLibrary(err) {
    if (quiet(err)) return;
    commitFrame();
    liveBusy(false);
    showBody('errorState');
  }

  /** Load the first page for the chosen format and sort. quietly: a re-check
      that leaves what is on screen alone until the answer is in ('live': a
      tick in the panel, the books dimmed meanwhile). */
  function loadLibrary(quietly) {
    const gen = ++state.gen;
    if (quietly === 'live' && !$('libraryGrid').classList.contains('hidden')) liveBusy(true);
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
    return WS.swr('books:list:' + state.format + ':' + state.sort + (state.group ? '' : ':flat') + filterKey(), function () {
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
      appendCards($('libraryGrid'), (data && Array.isArray(data.items)) ? data.items : [], flat());
      setMore(data && data.next_cursor);
    }, function (err) {
      if (gen !== state.gen || page !== state.renderGen || quiet(err)) return;
      // The button stays, to try again.
      state.moreBusy = false;
      btn.disabled = false;
      btn.textContent = 'Try again';
    });
  }

  /** The sort changed (the sort menu): the books in that order. */
  function chooseSort(sort) {
    if (sort === state.sort) return;
    state.sort = sort;
    syncControls();
    stopBuildingPoll();
    loadLibrary(false);
  }

  /** Group series on or off: the books again, every book its own card when off. Remembered at once. */
  function setGroup(on) {
    if (on === state.group) return;
    state.group = on;
    syncControls();
    saveView();
    syncFlags();
    stopBuildingPoll();
    loadLibrary(false);
  }

  // ---- Filters: Format, Author, Series, Narrator ----

  /** Any name filter (the format has its own empty state). */
  function anyFilter() {
    return FILTER_KINDS.some(function (k) { return state.filters[k].length > 0; });
  }

  /** How many filters are in use: the format (when not all) and every name. */
  function activeCount() {
    return (state.format !== 'all' ? 1 : 0) + FILTER_KINDS.reduce(function (n, k) { return n + state.filters[k].length; }, 0);
  }

  /** The name filters as query parameters ('&author=A&author=B…'). */
  function filterQuery() {
    return FILTER_KINDS.map(function (k) {
      return state.filters[k].map(function (v) { return '&' + k + '=' + encodeURIComponent(v); }).join('');
    }).join('');
  }

  /** The part of a kept list's name that is the filters (nothing without any). */
  function filterKey() {
    return anyFilter() ? ':' + FILTER_KINDS.map(function (k) {
      return state.filters[k].map(encodeURIComponent).join(',');
    }).join('|') : '';
  }

  /** What the books are asked for with, to tell whether a change is one. */
  function filterSig() {
    return state.format + '|' + filterKey();
  }

  /** The skeleton's room for the row of filters in use, and for a third line on every card. */
  function syncFlags() {
    if (activeCount()) html.setAttribute('data-books-filtered', '');
    else html.removeAttribute('data-books-filtered');
    if (flat()) html.setAttribute('data-books-flat', '');
    else html.removeAttribute('data-books-flat');
  }

  /** The Filters button's badge, the rows of filters in use (above the books
      and above a search's results), each list's "2 selected", Clear all, and
      the skeleton's room for those rows. */
  function syncFilters() {
    const n = activeCount();
    const badge = $('filtersCount');
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('hidden', !n);
    // The visible word first, so a voice command by it still finds the button.
    if (n) filtersBtn.setAttribute('aria-label', 'Filters, ' + n + ' in use');
    else filtersBtn.removeAttribute('aria-label');
    $('filterClearAll').setAttribute('aria-disabled', n ? 'false' : 'true');
    FILTER_KINDS.forEach(function (k) {
      const len = state.filters[k].length;
      facetSection(k).querySelector('[data-selected]').textContent = len ? len + ' selected' : '';
    });
    root.querySelectorAll('[data-active-filters]').forEach(drawActive);
    syncFlags();
  }

  /** The filters in use, in the order the panel lists them. */
  function activeItems() {
    const items = [];
    if (state.format !== 'all') items.push({ kind: 'format', value: state.format, label: 'Format', text: FORMAT_WORDS[state.format] });
    FILTER_KINDS.forEach(function (k) {
      state.filters[k].forEach(function (v) { items.push({ kind: k, value: v, label: FILTERS[k].label, text: v }); });
    });
    return items;
  }

  function drawActive(host) {
    host.textContent = '';
    const items = activeItems();
    host.classList.toggle('hidden', !items.length);
    items.forEach(function (it) {
      const chip = el('button', ACTIVE_CHIP);
      chip.type = 'button';
      chip.setAttribute('data-remove', it.kind);
      chip.setAttribute('data-value', it.value);
      // Named by its own words, then what a press does: "Author Jane Austen, remove filter".
      chip.title = it.text;
      chip.appendChild(el('span', 'shrink-0 text-frosted-blue/70', it.label));
      chip.appendChild(document.createTextNode(' '));
      chip.appendChild(el('span', 'min-w-0 truncate font-semibold', it.text));
      chip.appendChild(el('span', 'sr-only', ', remove filter'));
      chip.appendChild(icon('close', 'shrink-0 text-[18px]'));
      host.appendChild(chip);
    });
    if (items.length) {
      const clear = el('button', CLEAR_ALL, 'Clear all');
      clear.type = 'button';
      clear.setAttribute('data-clear-filters', '');
      host.appendChild(clear);
    }
  }

  /** The address for the filters on screen: replaced, not pushed (the router
      records it and hands it back to this page, which already has it). */
  function replaceAddress() {
    const href = filterHref(state.filters, window.location.pathname + window.location.search);
    if (href === window.location.pathname + window.location.search) return;
    if (claiming && window.WS && WS.router && typeof WS.router.navigate === 'function') {
      state.ownNav = new URL(href, window.location.href).href;
      Promise.resolve(WS.router.navigate(href, { replace: true })).catch(function () { /* the books are already drawn */ });
    } else {
      try { window.history.replaceState(window.history.state, '', href); } catch (e) { /* the books still follow */ }
    }
  }

  let liveTimer = 0;

  /** The filters changed here: the badge and the rows follow at once; the
      books, the address, the panel's counts and a search under way follow
      after LIVE_WAIT_MS (live: a tick in the panel, the books on screen stay
      until the answer) or now. */
  function filtersChanged(live) {
    syncFilters();
    ctx.clearTimeout(liveTimer);
    if (live) liveTimer = ctx.setTimeout(function () { flushFilters(true); }, LIVE_WAIT_MS);
    else flushFilters(false);
  }

  function flushFilters(live) {
    ctx.clearTimeout(liveTimer);
    const sig = filterSig();
    if (sig === state.asked) return;
    state.asked = sig;
    replaceAddress();
    stopBuildingPoll();
    loadLibrary(live ? 'live' : false);
    if (panelOpen()) refreshFacets();
    if (state.searching && state.query) runSearch(state.query);
  }

  /** Filters from the address (Back or Forward between two Books addresses):
      the controls show them and the books are asked for again. False when
      nothing changed. */
  function applyFilters(next) {
    const was = filterKey();
    FILTER_KINDS.forEach(function (k) { state.filters[k] = cleanNames(next[k]); });
    if (filterKey() === was) return false;
    syncFilters();
    if (panelOpen()) drawPanel();
    flushFilters(false);
    return true;
  }

  function setFormat(format, live) {
    if (format === state.format || FORMATS.indexOf(format) === -1) return;
    state.format = format;
    syncControls();
    filtersChanged(live);
  }

  function removeFilter(kind, value) {
    if (kind === 'format') { setFormat('all', false); return; }
    if (!state.filters[kind]) return;
    const key = nameKey(value);
    state.filters[kind] = state.filters[kind].filter(function (v) { return nameKey(v) !== key; });
    if (panelOpen()) drawPanel();
    filtersChanged(false);
  }

  function clearFilters() {
    state.format = 'all';
    FILTER_KINDS.forEach(function (k) { state.filters[k] = []; });
    syncControls();
    if (panelOpen()) drawPanel();
    filtersChanged(false);
    say('Filters cleared');
  }

  /** A pill pressed (or Clear all): the filter goes, and the focus moves to
      the next pill, else the one before, else the Filters button (the search
      box, over a search's results). */
  function onActiveClick(e) {
    const host = e.currentTarget;
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || !host.contains(b)) return;
    const inToolbar = host.id === 'activeFilters';
    if (b.hasAttribute('data-clear-filters')) {
      clearFilters();
      (inToolbar ? filtersBtn : input).focus();
      return;
    }
    const kind = b.getAttribute('data-remove');
    if (!kind) return;
    const pills = Array.prototype.slice.call(host.querySelectorAll('[data-remove]'));
    const at = pills.indexOf(b);
    const neighbour = pills[at + 1] || pills[at - 1];
    const then = neighbour ? [neighbour.getAttribute('data-remove'), neighbour.getAttribute('data-value')] : null;
    removeFilter(kind, b.getAttribute('data-value'));
    say(activeCount() ? 'Filter removed' : 'Filters cleared');
    const back = then ? Array.prototype.slice.call(host.querySelectorAll('[data-remove]')).filter(function (p) {
      return p.getAttribute('data-remove') === then[0] && p.getAttribute('data-value') === then[1];
    })[0] : null;
    (back || (inToolbar ? filtersBtn : input)).focus();
  }

  // ---- The filters panel: drops over the books under the toolbar ----

  const panel = $('filterPanel');
  const filtersBtn = $('filtersBtn');
  const panelBody = $('filterPanelBody');
  // The counts each address asked for gave, for this visit.
  const facetCache = {};
  // The counts on screen: { format: { all, ebook, audio }, author: [{ name, count, fold, key }], … }.
  let facets = null;
  let facetsFailed = false;
  let facetGen = 0;
  // A list opened with Show all, per filter.
  const showAll = {};
  // Listeners that live while the panel is open.
  let panelEnds = null;

  function facetSection(kind) { return panel.querySelector('[data-facet="' + kind + '"]'); }
  function findBox(kind) { return facetSection(kind).querySelector('[data-find] input'); }

  function facetUrl() {
    return '/api/books/facets?facet=format&facet=author&facet=series&facet=narrator&format=' + state.format + filterQuery();
  }

  function loadFacets() {
    const url = facetUrl();
    if (!facetCache[url]) {
      // Through readLive, as every list is (on the visit's signal; the counts start no hand-off).
      facetCache[url] = readLive(url, true).then(function (data) {
        const given = (data && data.facets) || {};
        const out = { format: { all: 0, ebook: 0, audio: 0 } };
        (Array.isArray(given.format) ? given.format : []).forEach(function (v) {
          if (v && FORMATS.indexOf(v.name) !== -1 && typeof v.count === 'number') out.format[v.name] = v.count;
        });
        FILTER_KINDS.forEach(function (k) {
          out[k] = (Array.isArray(given[k]) ? given[k] : []).filter(function (v) {
            return v && typeof v.name === 'string' && v.name;
          }).map(function (v) {
            return { name: v.name, count: typeof v.count === 'number' ? v.count : 0, fold: foldName(v.name), key: nameKey(v.name) };
          });
        });
        return out;
      });
      // A failure is not kept: Try again asks again.
      facetCache[url].catch(function () { delete facetCache[url]; });
    }
    return facetCache[url];
  }

  /** The counts for the filters on screen; the lists are drawn again when they come. */
  function refreshFacets() {
    const gen = ++facetGen;
    facetsFailed = false;
    panelBody.setAttribute('aria-busy', 'true');
    if (!facets) drawPanel();
    loadFacets().then(function (got) {
      if (gen !== facetGen || signal.aborted) return;
      facets = got;
      panelBody.removeAttribute('aria-busy');
      drawPanel();
    }, function (err) {
      if (gen !== facetGen || quiet(err)) return;
      panelBody.removeAttribute('aria-busy');
      // Counts already on screen stay (a little behind); with none, the panel says so.
      if (!facets) { facetsFailed = true; drawPanel(); }
    });
  }

  /** Every list again from `facets` and the filters, the focus and the scroll where they were. */
  function drawPanel() {
    const top = panelBody.scrollTop;
    const focused = document.activeElement && panel.contains(document.activeElement)
      ? document.activeElement.getAttribute('data-fk') : null;
    $('facetError').classList.toggle('hidden', !facetsFailed);
    FORMATS.forEach(function (f) {
      panel.querySelector('[data-count="' + f + '"]').textContent = facets ? String(facets.format[f]) : '';
    });
    FILTER_KINDS.forEach(drawFacet);
    panelBody.scrollTop = top;
    if (focused && document.activeElement !== null && !panel.contains(document.activeElement)) {
      const back = Array.prototype.slice.call(panel.querySelectorAll('[data-fk]')).filter(function (n) {
        return n.getAttribute('data-fk') === focused;
      })[0];
      if (back) back.focus({ preventScroll: true });
    }
  }

  function facetOption(kind, v, on) {
    const li = el('li', '');
    const label = el('label', FACET_OPT);
    label.title = v.name;
    const box = el('input', 'peer sr-only');
    box.type = 'checkbox';
    box.value = v.name;
    box.checked = on;
    box.setAttribute('data-kind', kind);
    box.setAttribute('data-fk', kind + ':' + v.key);
    label.appendChild(box);
    const mark = el('span', FACET_BOX);
    mark.setAttribute('aria-hidden', 'true');
    mark.appendChild(icon('check', FACET_MARK));
    label.appendChild(mark);
    label.appendChild(el('span', FACET_NAME, v.name));
    const count = el('span', FACET_COUNT, String(v.count));
    count.setAttribute('aria-hidden', 'true');
    label.appendChild(count);
    label.appendChild(el('span', 'sr-only', ', ' + v.count + (v.count === 1 ? ' book' : ' books')));
    li.appendChild(label);
    return li;
  }

  /**
   * One filter's list: the names with most books first (a name in use is
   * always shown, in its own place, with 0 when nothing else leaves it any),
   * the first FACET_SHOWN until Show all, a find box over a long list.
   */
  function drawFacet(kind) {
    const sec = facetSection(kind);
    const list = sec.querySelector('[data-list]');
    const none = sec.querySelector('[data-none]');
    const more = sec.querySelector('[data-more]');
    const find = sec.querySelector('[data-find]');
    const box = find.querySelector('input');
    const info = FILTERS[kind];
    const listTop = list.scrollTop;
    list.textContent = '';
    if (!facets) {
      find.classList.add('hidden');
      more.classList.add('hidden');
      none.classList.add('hidden');
      if (!facetsFailed) {
        ['w-3/4', 'w-1/2', 'w-2/3', 'w-2/5'].forEach(function (w) {
          const row = el('li', 'flex min-h-11 items-center @lg:min-h-10');
          row.setAttribute('aria-hidden', 'true');
          row.appendChild(el('span', 'skel skel-line ' + w));
          list.appendChild(row);
        });
      }
      return;
    }
    const chosen = state.filters[kind].map(nameKey);
    const byKey = {};
    const values = facets[kind].filter(function (v) { byKey[v.key] = true; return v.count > 0 || chosen.indexOf(v.key) !== -1; });
    state.filters[kind].forEach(function (n) {
      if (!byKey[nameKey(n)]) values.push({ name: n, count: 0, fold: foldName(n), key: nameKey(n) });
    });
    values.sort(function (a, b) { return (b.count - a.count) || (a.fold < b.fold ? -1 : a.fold > b.fold ? 1 : 0); });
    const q = foldName(box.value);
    const all = !!showAll[kind];
    const hits = q ? values.filter(function (v) { return v.fold.indexOf(q) !== -1; }) : values;
    const shown = (q || all) ? hits.slice(0, FACET_DRAWN) : hits.filter(function (v, i) {
      return i < FACET_SHOWN || chosen.indexOf(v.key) !== -1;
    });
    shown.forEach(function (v) { list.appendChild(facetOption(kind, v, chosen.indexOf(v.key) !== -1)); });
    find.classList.toggle('hidden', values.length <= FACET_FIND_FROM && !box.value);
    let line = '';
    if (!values.length) line = 'No ' + info.plural + ' in the books shown.';
    else if (q && !hits.length) line = 'No ' + info.plural + ' match “' + box.value.trim() + '”.';
    else if ((q || all) && hits.length > FACET_DRAWN) line = 'Showing ' + FACET_DRAWN + ' of ' + hits.length + '. Type to narrow the list.';
    none.textContent = line;
    none.classList.toggle('hidden', !line);
    const canMore = !q && values.length > FACET_SHOWN;
    more.classList.toggle('hidden', !canMore);
    more.setAttribute('aria-expanded', all ? 'true' : 'false');
    more.querySelector('[data-more-text]').textContent = all ? 'Show fewer' : 'Show all ' + values.length + ' ' + info.plural;
    more.querySelector('.material-symbols-outlined').textContent = all ? 'expand_less' : 'expand_more';
    list.className = all && !q ? FACET_LIST_ALL : '';
    list.scrollTop = listTop;
  }

  function panelOpen() { return !panel.classList.contains('hidden'); }

  /** The panel's height: what is left of the window under the toolbar, above
      the tab bar and the player. With too little left, the toolbar is first
      scrolled to the top, so the panel drops into the room the books had. */
  function fitPanel(mayScroll) {
    const row = $('toolbarRow');
    // The box the page scrolls in (from 1024px the page's own, which ends above
    // the player; below, the window, whose tab bar and player the shell keeps
    // out of the way with scroll-padding-bottom).
    let box = null;
    for (let n = row.parentElement; n && n !== document.body && !box; n = n.parentElement) {
      const oy = window.getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') box = n;
    }
    function bottom() {
      let b = window.innerHeight - (parseFloat(window.getComputedStyle(html).scrollPaddingBottom) || 0);
      if (box) b = Math.min(b, box.getBoundingClientRect().bottom);
      return b - 12;
    }
    let room = bottom() - row.getBoundingClientRect().bottom - 8;
    if (mayScroll && room < Math.min(PANEL_MIN_PX, window.innerHeight * 0.6) && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'start' });
      room = bottom() - row.getBoundingClientRect().bottom - 8;
    }
    panel.style.maxHeight = Math.max(240, Math.round(room)) + 'px';
  }

  function openPanel() {
    if (panelOpen()) return;
    if (sortMenu) sortMenu.close();
    panel.classList.remove('hidden');
    filtersBtn.setAttribute('aria-expanded', 'true');
    fitPanel(true);
    panelEnds = new AbortController();
    // A press anywhere else closes it (the click still does what it does there).
    document.addEventListener('click', onOutsideClick, { capture: true, signal: panelEnds.signal });
    document.addEventListener('keydown', onPanelKey, { signal: panelEnds.signal });
    // The focus leaving the toolbar (Tab on past the panel) closes it, so the
    // focus is never on something the panel covers.
    $('toolbarRow').addEventListener('focusout', onPanelFocusOut, { signal: panelEnds.signal });
    window.addEventListener('resize', function () { fitPanel(false); }, { signal: panelEnds.signal });
    // Leaving the page takes it, and its listeners, with it.
    signal.addEventListener('abort', function () { closePanel(false); }, { once: true, signal: panelEnds.signal });
    drawPanel();
    refreshFacets();
  }

  /** Close the panel; refocus: the Filters button takes the focus (Escape, Close, the button itself). */
  function closePanel(refocus) {
    if (!panelOpen()) return;
    panel.classList.add('hidden');
    filtersBtn.setAttribute('aria-expanded', 'false');
    if (panelEnds) { panelEnds.abort(); panelEnds = null; }
    facetGen++;
    FILTER_KINDS.forEach(function (k) { findBox(k).value = ''; showAll[k] = false; });
    if (refocus) filtersBtn.focus();
  }

  function onOutsideClick(e) {
    const t = e.target;
    if (panel.contains(t) || filtersBtn.contains(t)) return;
    const inside = panel.contains(document.activeElement);
    closePanel(false);
    // A press on something that takes no focus would leave it on nothing.
    if (inside || document.activeElement === document.body) filtersBtn.focus({ preventScroll: true });
  }

  function onPanelKey(e) {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    // Escape in a find box with words in it empties the box first (the browser's own).
    if (e.target && e.target.type === 'search' && panel.contains(e.target) && e.target.value) return;
    const mine = panel.contains(document.activeElement) || document.activeElement === filtersBtn;
    e.preventDefault();
    closePanel(mine);
  }

  function onPanelFocusOut(e) {
    const to = e.relatedTarget;
    if (!to || panel.contains(to) || to === filtersBtn) return;
    closePanel(false);
  }

  /** A tick, an untick or a format picked in the panel: the books follow at once. */
  function onPanelChange(e) {
    const box = e.target;
    if (!box || box.tagName !== 'INPUT') return;
    if (box.type === 'radio' && box.name === 'booksFormat') { setFormat(box.value, true); return; }
    if (box.type !== 'checkbox') return;
    const kind = box.getAttribute('data-kind');
    if (!state.filters[kind]) return;
    const key = nameKey(box.value);
    const next = state.filters[kind].filter(function (v) { return nameKey(v) !== key; });
    if (box.checked) {
      if (next.length >= NAMES_MAX) { box.checked = false; toast('That’s as many ' + FILTERS[kind].plural + ' as one filter takes.'); return; }
      next.push(box.value);
    }
    state.filters[kind] = next;
    filtersChanged(true);
  }

  // ---- The sort: a list of the orders, a popover from PICKER_WIDE up, a bottom sheet below ----

  let sortMenu = null;

  function wide() {
    return typeof window.matchMedia === 'function' && window.matchMedia(PICKER_WIDE).matches;
  }

  /**
   * The sort's list (a listbox): the order in use is marked with a check and
   * starts highlighted; the arrows, Home and End move the highlight, letters
   * jump to an order, Enter or Space picks, Escape (WSUI.modal) and Tab close
   * it, and the focus goes back to the button. From PICKER_WIDE up it is a
   * small popover under the button; below, the filter pickers' bottom sheet.
   */
  function openSort(btn) {
    if (sortMenu) { sortMenu.close(); return; }
    closePanel(false);
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
      overlay = el('div', 'ws-dialog fixed inset-0 z-[95]');
      panel = el('div', 'ws-dialog-box absolute w-56 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-2xl border border-frosted-blue/10 bg-background-dark shadow-2xl');
      panel.appendChild(list);
    } else {
      overlay = el('div', 'ws-sheet z-[95]');
      overlay.appendChild(el('div', 'ws-sheet-scrim'));
      panel = el('div', 'ws-sheet-panel focus:outline-none');
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
      if (o.value !== state.sort) chooseSort(o.value);
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
      if (!isWide) overlay.classList.remove('is-open');
      overlay.classList.add('is-closing');
      window.setTimeout(remove, isWide ? 160 : SHEET_CLOSE_MS);
    }
    sortMenu = {
      overlay: overlay,
      close: function () { if (handle) handle.close(); else teardown(); }
    };

    document.body.appendChild(overlay);
    if (isWide) placeSort(panel, btn);
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
    readLive('/api/books/search?q=' + encodeURIComponent(query) + '&limit=' + SEARCH_LIMIT +
      (state.format !== 'all' ? '&format=' + state.format : '') + filterQuery()).then(function (data) {
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
      if (activeCount()) {
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

  $('sortBtn').addEventListener('click', function () { openSort($('sortBtn')); }, { signal: signal });
  $('sortBtn').addEventListener('keydown', function (e) {
    // The arrows open the list too, as they open a native one.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openSort($('sortBtn')); }
  }, { signal: signal });
  $('groupSwitch').addEventListener('click', function () { setGroup(!state.group); }, { signal: signal });
  $('moreBtn').addEventListener('click', loadMore, { signal: signal });
  $('retryBtn').addEventListener('click', function () { loadLibrary(false); loadContinue(); }, { signal: signal });
  $('emptyReset').addEventListener('click', function () { setFormat('all', false); }, { signal: signal });
  $('connectRetry').addEventListener('click', retryConnect, { signal: signal });

  // The filters panel.
  filtersBtn.addEventListener('click', function () { if (panelOpen()) closePanel(true); else openPanel(); }, { signal: signal });
  // A pointer or the keyboard on its way to the button: the counts are asked for before the press.
  ['pointerenter', 'focus'].forEach(function (type) {
    filtersBtn.addEventListener(type, function () { loadFacets().catch(function () { /* the panel asks again */ }); }, { signal: signal });
  });
  panel.addEventListener('change', onPanelChange, { signal: signal });
  $('filterClose').addEventListener('click', function () { closePanel(true); }, { signal: signal });
  $('filterClearAll').addEventListener('click', function () {
    if (!activeCount()) return;
    clearFilters();
  }, { signal: signal });
  $('facetRetry').addEventListener('click', function () {
    refreshFacets();
    // The button goes once the counts come: the focus waits on the format in use.
    const picked = panel.querySelector('input[name="booksFormat"]:checked');
    if (picked) picked.focus();
  }, { signal: signal });
  FILTER_KINDS.forEach(function (kind) {
    findBox(kind).addEventListener('input', function () { drawFacet(kind); }, { signal: signal });
    facetSection(kind).querySelector('[data-more]').addEventListener('click', function () {
      showAll[kind] = !showAll[kind];
      drawFacet(kind);
    }, { signal: signal });
  });
  root.querySelectorAll('[data-active-filters]').forEach(function (host) {
    host.addEventListener('click', onActiveClick, { signal: signal });
  });
  $('filterEmptyClear').addEventListener('click', function () {
    clearFilters();
    filtersBtn.focus();
  }, { signal: signal });
  $('searchClear').addEventListener('click', function () {
    clearFilters();
    input.focus();
  }, { signal: signal });

  // A filter change of ours, and Back or Forward between two Books
  // addresses, are drawn here: the router only records the address. Any
  // other way in (the sidebar's Books, a link) is a fresh visit, as before.
  // Nothing is claimed for the prefetch, so links still warm as they did.
  let claiming = false;
  if (typeof ctx.onNavigate === 'function') {
    claiming = true;
    ctx.onNavigate(function (url, how) {
      if (url.pathname.replace(/\/+$/, '') !== '/books') return false;
      const mine = state.ownNav !== null && state.ownNav === url.href;
      if (!mine && !(how && how.pop)) return false;
      state.ownNav = null;
      applyFilters(filtersFrom(url));
      return true;
    }, function () { return false; });
  }

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
  state.asked = filterSig();
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
    html.removeAttribute('data-books-filtered');
    html.removeAttribute('data-books-flat');
  };
}
