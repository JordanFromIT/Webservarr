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
 *   renderContinueRow(items, notes, { compact, signal }) the Continue row (a
 *                                                       <section>), or null
 *                                                       when nothing is in progress
 * They touch no DOM at import time.
 */

const PAGE_SIZE = 36;
const SEARCH_WAIT_MS = 300;
const SEARCH_LIMIT = 60;
const SKELETON_CARDS = 12;
const BUILDING_POLL_MS = 10000;

const VIEW_KEY = 'webservarr_books_view:';
const CONTINUE_KEY = 'webservarr_books_continue:';

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
function coverBox(url, formats, signal) {
  const list = formats || [];
  const audioOnly = list.length === 1 && list[0] === 'audio';
  // Spans, so a cover is valid inside a button too.
  const box = el('span', 'relative block aspect-[2/3] overflow-hidden rounded-xl bg-frosted-blue/[0.07]');
  box.appendChild(icon(audioOnly ? 'headphones' : 'menu_book',
    'absolute inset-0 grid place-items-center text-[32px] text-frosted-blue/45'));
  if (url) {
    const img = el('img', audioOnly ? 'absolute inset-0 h-full w-full object-contain' : 'absolute inset-0 h-full w-full object-cover');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = url;
    img.addEventListener('error', function () { img.classList.add('hidden'); }, { once: true, signal: signal });
    box.appendChild(img);
  }
  box.appendChild(formatBadges(list));
  return box;
}

/**
 * A library card: the cover, the title (two lines of room whatever it is, so
 * every row is one height and lands on its skeleton) and one quiet line under
 * it, the author or, for a series, how many books it holds.
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
  cover.appendChild(coverBox(card.cover_url, card.formats, signal));
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
function noteLine(text) {
  const p = el('p', 'flex items-center gap-2 text-[15px] text-frosted-blue/70');
  p.appendChild(icon('info', 'text-[20px]'));
  p.appendChild(el('span', '', text));
  return p;
}

/**
 * The Continue row: what the person is partway through, newest first, as one
 * section with a heading and a sideways row of cards. Null when there is
 * nothing (the caller hides the row). `notes` ([{source, reason, text}]) are
 * shown quietly beneath it, so a source that is down says so without taking
 * the other format's cards away. compact is Home's smaller row.
 */
export function renderContinueRow(items, notes, opts) {
  const o = opts || {};
  const list = items || [];
  if (!list.length) return null;
  const section = el('section', '');
  section.setAttribute('aria-label', 'Continue');
  section.setAttribute('data-continue', '');
  section.appendChild(el('h2', 'mb-3 font-bold leading-snug text-frosted-blue ' + (o.compact ? 'text-[17px]' : 'text-xl'), 'Continue'));
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
    const line = noteLine(n.text);
    line.className += ' mt-3';
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
    // The first books drawn: the toolbar, the notes and Continue are written
    // in that one frame (commitFrame), so nothing already on screen moves.
    committed: false, pendingContinue: null,
    // Counts every redraw of page 1, so a next page asked for before one is dropped.
    renderGen: 0, building: false,
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

  // The Continue row is reserved from the first paint for a person who had one
  // last time (theme-loader.js does the same on a full load); this is the
  // soft-navigation visit, before anything is awaited.
  function markContinue(on) {
    if (on) html.setAttribute('data-books-continue', '');
    else html.removeAttribute('data-books-continue');
  }
  markContinue(storageGet(CONTINUE_KEY + user) === '1');

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
    if (state.committed) $('connectState').classList.remove('hidden');
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
  }

  function setNotes(which, notes) {
    state.notes[which] = Array.isArray(notes) ? notes : [];
    renderNotes();
  }

  /** Every list is read here, from the server. Its notes decide the hand-off,
      so they are looked at on the live answer only: never on a copy kept from
      an earlier visit (which may be a session old), and whether or not the
      answer differs from that copy and gets drawn again. */
  function readLive(url) {
    return WS.getJSON(url, { signal: signal }).then(function (data) {
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
    $('connectState').classList.toggle('hidden', !state.connectProblem);
    renderNotes();
    applyContinue();
  }

  function applyContinue() {
    const held = state.pendingContinue;
    if (!held) return;
    state.pendingContinue = null;
    const host = $('continueHost');
    host.textContent = '';
    host.setAttribute('aria-busy', 'false');
    if (held.row) host.appendChild(held.row);
    markContinue(!!held.row);
  }

  function renderContinue(data, fromCache, failed) {
    if (signal.aborted) return;
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    setNotes('continue', data && data.notes);
    const row = renderContinueRow(items, [], { signal: signal });
    // Shown with the first books (commitFrame), or at once when they are already in.
    state.pendingContinue = { row: row };
    if (state.committed) applyContinue();
    if (!fromCache && !failed) storageSet(CONTINUE_KEY + user, row ? '1' : '0');
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
    $('emptyRequest').classList.toggle('hidden', filtered || state.embed);
    showBody('emptyState');
  }

  function renderLibrary(data) {
    if (signal.aborted) return;
    commitFrame();
    state.renderGen++;
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    setNotes('library', data && data.notes);
    $('libraryGrid').textContent = '';
    state.building = false;
    if (items.length) {
      stopBuildingPoll();
      saveView();
      appendCards($('libraryGrid'), items);
      showBody('libraryGrid');
      setMore(data.next_cursor);
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
        if (gen !== state.gen || signal.aborted) return;
        renderLibrary(data);
      });
    }, {
      onError: function (err) {
        if (gen !== state.gen || quiet(err)) return;
        WS.arrive('library', function () { failedLibrary(err); });
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
      if (state.embed) {
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
  if (window.WSKavita && typeof window.WSKavita.init === 'function') window.WSKavita.init();
  // A sign-in that just failed: no automatic attempt on this visit (the helper
  // remembers), and the message shows when the answer says they are not connected.
  if (window.WSKavita && typeof window.WSKavita.arrivedFromFailedConnect === 'function') window.WSKavita.arrivedFromFailedConnect();

  const first = Promise.all([loadContinue(), loadLibrary(false)]);
  // A library that never answers does not keep the toolbar a skeleton for ever.
  ctx.setTimeout(commitFrame, 4000);

  // The sections are on screen (or their skeletons, which have their shape)
  // before mount resolves, so Back and Forward restore the scroll onto them. A
  // slow answer does not hold that up for long.
  await Promise.race([
    first,
    new Promise(function (resolve) { ctx.setTimeout(resolve, 1500); })
  ]);

  return function () { markContinue(false); };
}
