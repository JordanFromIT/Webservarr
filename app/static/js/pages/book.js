/**
 * WebServarr, a book (the Books pages' pop-up)
 *
 * /books/<id>: one book, whatever formats it comes in, in a pop-up over the
 * Books page it was opened from (bookDialog, below; the frame is
 * partials/book-dialog.html). The cover, the title,
 * who wrote and read it (each a link to their page), the series it belongs to,
 * and two buttons: Read, which opens the reader at the book's own chapter, and
 * Listen, which plays the audiobook. Each says how far the person is. A book
 * with several narrators is one page: Listen offers them, with the one the
 * person was last in preselected; their places stay per narrator. A format the
 * library lacks is a link to ask for it; one whose source is down is a
 * disabled button that says so.
 *
 * Everything comes from GET /api/books/<id> (the server reads the progress
 * live and decides what this person may see). Everything is drawn in one write
 * (commit), over a skeleton with the same shape: the heading stays and
 * everything after it is a new element, so nothing already on screen moves.
 *
 * The card helpers come from books.js, loaded by the address the server wrote
 * (and stamped with that file's content hash) in #wsPage's data-ws-dep: so a
 * cached old books.js is never paired with a new page. No import statement.
 *
 * The person's own (books 3b, from the same answer: my_list, queue_position,
 * my_rating): "Add to My list" / "On My list", "Add to Up next" (or its place
 * in the queue with Remove), and their own 1 to 5 stars with Clear. Each
 * change shows at once and is sent (books.js sendBooks); one the server
 * refuses is put back, with a toast. And a sample of each format the person
 * can open: "Read a sample" opens the reader's sample mode (nothing saved),
 * "Try a sample" plays the first 5 minutes of the picked narrator's edition
 * (WS.player.sample, which saves nothing) and, while it plays, is "Stop
 * sample" with the time left. The player's own corner says so too
 * (features.js), since a sample plays on across pages.
 *
 * mount(ctx) draws one book into ctx.root (#bookBody) and is run by
 * bookDialog for each book it opens, as the router runs a page: each book has
 * its own state, and every listener, fetch and timer ends with ctx.signal (a
 * write the person made is let finish: books.js sendBooks). In the pop-up
 * ctx also has close() (the not-found state's way out is Close) and
 * onChange(kind), told of a change the page under it shows ('list', 'queue',
 * 'listen'). Markup is built with textContent only.
 *
 * bookDialog(page) runs the pop-up for a Books page (books.js withBookDialog
 * calls it, with the page's ctx). A click on a book is claimed from the router:
 * the address becomes /books/<id> (a history entry), the pop-up opens over the
 * page, which keeps its place and its scroll, and Back closes it. Escape, Close
 * and a press on the dim close it too, by the same step back (or, when the
 * address was never the page's, by replacing it with the page's own). A full
 * load of /books/<id> is the Books page with the pop-up already on screen
 * (<html data-book-open>, server-rendered); it is taken over here. It is a
 * modal (WSUI.modal: focus kept inside, Escape), labelled by the book's title;
 * focus goes back to the card that opened it. A link inside it (an author, a
 * narrator, a series) is an ordinary navigation, and the router closes the
 * pop-up as it swaps the page.
 */
const KEEP_MS = 2 * 60 * 1000;      // a kept copy older than this is not painted: places move
const MOUNT_WAIT_MS = 1500;         // the page is on screen (or its skeleton) before mount resolves
const FOLD_AT = 400;                // a description longer than this folds behind "Show more"
const MAX_ID = 2147483647;          // a database id; anything larger cannot be one

const LINK_FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frosted-blue';
// Class strings are written out whole: Tailwind only builds what it can read.
const BTN = 'ws-lift relative flex w-full items-center gap-3 min-h-14 overflow-hidden rounded-[10px] px-4 py-2 text-left ' + LINK_FOCUS;
const MAIN = ' bg-primary text-bright';
const QUIET = ' bg-frosted-blue/[0.07] text-frosted-blue hover:bg-frosted-blue/10';
const OFF = ' cursor-not-allowed bg-frosted-blue/[0.04] text-frosted-blue/70';
const PERSON = 'font-semibold text-frosted-blue underline-offset-4 hover:underline ' + LINK_FOCUS + ' rounded-sm';
// A quiet text button under a format's button (a sample), and the person's own buttons.
const TEXT_BTN = 'mt-2 -ml-2 inline-flex h-10 max-w-full items-center gap-2 rounded-[10px] px-2 text-[15px] font-semibold text-frosted-blue/70 hover:bg-frosted-blue/[0.07] hover:text-frosted-blue ' + LINK_FOCUS;
const MINE_BTN = 'ws-lift flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[10px] px-4 text-left text-[15px] font-semibold text-frosted-blue ' + LINK_FOCUS;
const MINE_OFF = ' bg-frosted-blue/[0.07] hover:bg-frosted-blue/10';
const MINE_ON = ' bg-frosted-blue/[0.15] hover:bg-frosted-blue/20';
const STAR = 'grid size-10 place-items-center rounded-[10px] hover:bg-frosted-blue/[0.07] ' + LINK_FOCUS;
const STAR_FILL = 'text-[28px] text-frosted-blue [font-variation-settings:\'FILL\'_1]';
const STAR_HINT = 'text-[28px] text-frosted-blue/70 [font-variation-settings:\'FILL\'_1]';
const STAR_EMPTY = 'text-[28px] text-frosted-blue/45';
const SAMPLE_PARAM = '&sample=1';

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

/** The book's id from /books/<id>, or null when the address is not one. */
function bookId(pathname) {
  const m = /^\/books\/(\d{1,10})\/?$/.exec(pathname || '');
  const n = m ? parseInt(m[1], 10) : 0;
  return n >= 1 && n <= MAX_ID ? n : null;
}

/** The HTTP status of a failed WS.getJSON (it carries it only in its message). */
function statusOf(err) {
  if (err && typeof err.status === 'number') return err.status;
  const m = /HTTP (\d{3})/.exec(err && err.message || '');
  return m ? parseInt(m[1], 10) : 0;
}

/** Only Requests's own search is a request link (never another address). */
function requestHref(link) {
  return typeof link === 'string' && link.indexOf('/requests?q=') === 0 ? link : '';
}

/** Only the reader's own address is a Read link. */
function readerHref(link) {
  return typeof link === 'string' && link.indexOf('/reader?') === 0 ? link : '';
}

function personHref(role, name) {
  return '/books/person?role=' + role + '&name=' + encodeURIComponent(name);
}

function numberText(n) {
  return typeof n === 'number' && isFinite(n) ? String(n) : '';
}

function when(progress) {
  const t = progress && progress.updated_at ? Date.parse(progress.updated_at) : NaN;
  return isNaN(t) ? 0 : t;
}

/** 1st, 2nd, 3rd, 4th... 11th, 12th, 13th, 21st. */
export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return n + 'th';
  const last = n % 10;
  return n + (last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th');
}

/** "4:32 left": a sample's time left, seconds rounded up. */
export function leftText(ms) {
  const t = Math.max(0, Math.ceil((typeof ms === 'number' && isFinite(ms) ? ms : 0) / 1000));
  const s = t % 60;
  return Math.floor(t / 60) + ':' + (s < 10 ? '0' : '') + s + ' left';
}

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;
  const $ = function (id) { return root.querySelector('#' + id); };
  const { coverBox, rememberContinue, rememberRow, sendBooks } = await import(root.getAttribute('data-ws-dep') || './books.js');
  const who = ((ctx.data || {}).user || {}).username || '';
  // In the pop-up: its Close, and what the page under it is told.
  const closeView = typeof ctx.close === 'function' ? ctx.close : null;
  function told(kind) {
    if (typeof ctx.onChange === 'function') ctx.onChange(kind);
  }

  const state = {
    id: bookId(ctx.url.pathname),
    gen: 0,
    data: null,
    edition: '',            // the narrator picked: a plex_book_key
    reconnectTried: false, connectProblem: false, connectView: false,
    opening: '',            // a plex_book_key this page asked the player for, until the player shows it
    unwatch: null,
    // The person's own: null until the answer has them (an older answer has none: no buttons).
    mine: null,             // { list: bool, queue: int|null, rating: int|null }
    busy: {},               // 'list' | 'queue' | 'rating': a write of that kind is on its way
    sampleAsked: '',        // the edition key this page asked to sample, until it plays or fails
    sampleFailed: false,
    addressFixed: false,
    embed: ((ctx.data || {}).branding || {}).requests_source === 'seerr_embed'
  };

  // The skeleton as the server sent it, to put back for Try again.
  const skeleton = {
    cover: $('bookCover').cloneNode(true),
    title: Array.prototype.slice.call($('bookTitle').childNodes).map(function (n) { return n.cloneNode(true); }),
    rest: $('bookRest').cloneNode(true)
  };

  function quiet(err) { return signal.aborted || isAbort(err); }

  // ---- The Kavita hand-off ----

  /** Not connected to Kavita yet, for a book that has an ebook: Read is the way in. */
  function needsConnect(data) {
    return !data.formats.ebook && !data.request_links.ebook &&
      data.notes.some(function (n) { return n && n.source === 'kavita' && n.reason === 'not_connected'; });
  }

  /** From a live answer only, once per visit: the existing hand-off, which comes back to Books. */
  function startConnect() {
    if (state.reconnectTried) return;
    state.reconnectTried = true;
    const helper = window.WSKavita;
    if (!helper || typeof helper.reconnect !== 'function') { connectProblem(); return; }
    helper.reconnect(connectProblem);
  }

  function connectProblem() {
    if (signal.aborted) return;
    state.connectProblem = true;
    if (state.connectView) { showConnect(); return; }
    const sub = root.querySelector('[data-action="read"] [data-sub]');
    if (sub) sub.textContent = connectText();
  }

  function connectText() {
    return state.connectProblem ? 'Couldn’t connect. Press to try again' : 'Connect your ebook library';
  }

  function retryConnect() {
    const helper = window.WSKavita;
    if (!helper || typeof helper.retry !== 'function') { window.location.reload(); return; }
    helper.retry();
  }

  // ---- The player ----

  function player() { return (window.WS && window.WS.player) || null; }

  /** Watches the player for as long as the visit lasts. It may not be there yet
      on a cold load: the first Listen press looks again. */
  function watch() {
    const p = player();
    if (state.unwatch || !p || typeof p.on !== 'function' || signal.aborted) return;
    state.unwatch = p.on('change', syncListen);
    const unSample = p.on('sample-change', onSample);
    const done = new AbortController();
    signal.addEventListener('abort', function () {
      state.unwatch();
      if (typeof unSample === 'function') unSample();
      done.abort();
    }, { once: true, signal: done.signal });
  }

  function editionOf(key) {
    const audio = state.data && state.data.formats.audio;
    return audio ? audio.editions.filter(function (e) { return e.plex_book_key === key; })[0] || null : null;
  }

  /** What Listen says: Pause while the picked edition plays, Opening while the
      player loads it, else Listen; and under it the picked edition's place. */
  function syncListen() {
    if (signal.aborted) return;
    const btn = root.querySelector('[data-action="listen"]');
    const edition = editionOf(state.edition);
    if (!btn || !edition || btn.hasAttribute('data-off')) return;
    const p = player();
    const st = p && typeof p.state === 'function' ? p.state() : null;
    const mine = !!st && String(st.book) === edition.plex_book_key;
    // The engine holds no book (state().book is null) while it fetches one, so
    // "Opening" is this page's own flag, until the player shows the key or an error.
    if (state.opening && st && (String(st.book) === state.opening || st.error)) state.opening = '';
    const loading = (mine && !!st.loading) || state.opening === edition.plex_book_key;
    const playing = mine && !!st.playing && !loading;
    btn.querySelector('[data-icon]').textContent = playing ? 'pause' : 'play_arrow';
    btn.querySelector('[data-label]').textContent = loading ? 'Opening…' : playing ? 'Pause' : 'Listen';
    // A place made just now (by this page's own Listen) is not in the answer yet.
    const begun = mine && (playing || (typeof st.bookMs === 'number' && st.bookMs > 0));
    btn.querySelector('[data-sub]').textContent = edition.progress ? edition.progress.label : begun ? 'In progress' : 'Not started';
    btn.disabled = loading;
  }

  function listen() {
    const edition = editionOf(state.edition);
    if (!edition || state.opening) return;
    const p = player();
    if (!p) {
      if (window.WSUI && typeof window.WSUI.toast === 'function') {
        window.WSUI.toast('The player isn’t ready yet. Try again in a moment.', 'err');
      }
      return;
    }
    watch();
    const st = typeof p.state === 'function' ? p.state() : null;
    if (st && String(st.book) === edition.plex_book_key && !st.error) {
      p.toggle();
      return;
    }
    // Where the listener left off. A failure is the player's to show (its
    // notices); open() rejects only when the saved place is not in the book.
    const key = edition.plex_book_key;
    state.opening = key;
    Promise.resolve(p.open(key, { autoplay: true })).then(function () {
      // A place now exists, so the next Books visit has cards in Continue: it is told now.
      rememberContinue(who);
      told('listen');
    }, function (e) {
      if (signal.aborted) return;
      console.warn('The player could not open ' + key, e);
    }).then(function () {
      // Settled (playing, failed, or refused): the player's own state says which from here.
      if (state.opening === key) state.opening = '';
      syncListen();
    });
    syncListen();
  }

  // ---- Samples ----

  function isMine(key) {
    return !!editionOf(String(key || ''));
  }

  /** The sample playing, if it is one of this book's editions. */
  function mySample() {
    const p = player();
    const s = p && typeof p.sampleState === 'function' ? p.sampleState() : null;
    return s && isMine(s.book) ? s : null;
  }

  /** "Try a sample": Stop sample with the time left while one of this book's
      plays; "Sample unavailable right now" after one failed (press to try again). */
  function syncSample() {
    if (signal.aborted) return;
    const btn = root.querySelector('[data-action="sample"]');
    if (!btn) return;
    const s = mySample();
    const starting = !s && !!state.sampleAsked;
    const label = s ? 'Stop sample' : starting ? 'Starting the sample…' : state.sampleFailed ? 'Sample unavailable right now' : 'Try a sample';
    btn.querySelector('[data-icon]').textContent = s ? 'stop_circle' : 'play_circle';
    btn.querySelector('[data-label]').textContent = label;
    const left = btn.querySelector('[data-left]');
    left.textContent = !s ? '' : s.loading && !(s.bookMs > 0) ? 'Starting…' : leftText(s.leftMs);
    left.classList.toggle('hidden', !left.textContent);
  }

  function onSample(d) {
    if (signal.aborted) return;
    // The sample this page asked for could not play.
    if (d && d.reason === 'error' && state.sampleAsked) state.sampleFailed = true;
    syncSample();
  }

  function trySample() {
    const p = player();
    if (!p || typeof p.sample !== 'function') {
      if (window.WSUI && typeof window.WSUI.toast === 'function') {
        window.WSUI.toast('The player isn’t ready yet. Try again in a moment.', 'err');
      }
      return;
    }
    watch();
    if (mySample()) {
      p.stopSample();
      return;
    }
    if (state.sampleAsked) return;
    const key = state.edition;
    if (!editionOf(key)) return;
    state.sampleAsked = key;
    state.sampleFailed = false;
    syncSample();
    Promise.resolve(p.sample(key)).then(function (ok) {
      if (signal.aborted) return;
      if (state.sampleAsked === key) state.sampleAsked = '';
      if (!ok && !mySample()) state.sampleFailed = true;
      syncSample();
    }, function () {
      if (signal.aborted) return;
      state.sampleAsked = '';
      state.sampleFailed = true;
      syncSample();
    });
  }

  /** The quiet button under Listen: the first 5 minutes of the picked narrator, nothing saved. */
  function sampleButton() {
    const b = el('button', TEXT_BTN);
    b.type = 'button';
    b.setAttribute('data-action', 'sample');
    b.appendChild(icon('play_circle', 'text-[22px] shrink-0'));
    b.lastChild.setAttribute('data-icon', '');
    b.appendChild(el('span', 'truncate', 'Try a sample'));
    b.lastChild.setAttribute('data-label', '');
    b.appendChild(el('span', 'hidden shrink-0 font-medium tabular-nums', ''));
    b.lastChild.setAttribute('data-left', '');
    b.addEventListener('click', trySample, { signal: signal });
    return b;
  }

  /** The quiet link under Read: the reader's sample mode, at the book's first chapter. */
  function readSampleLink(href) {
    const a = el('a', TEXT_BTN);
    a.setAttribute('data-action', 'read-sample');
    a.href = href + SAMPLE_PARAM;
    a.appendChild(icon('auto_stories', 'text-[22px] shrink-0'));
    a.appendChild(el('span', 'truncate', 'Read a sample'));
    return a;
  }

  // ---- My list, Up next, rating ----

  function toast(text) {
    if (window.WSUI && typeof window.WSUI.toast === 'function') window.WSUI.toast(text, 'err');
  }

  // What a press did, for a screen reader (the buttons' own words change too).
  function say(text) {
    const line = root.querySelector('#bookSaid');
    if (line) line.textContent = text;
  }

  /** The kept copies of this book and of the Books rows are out of date once
      the person changes them here. */
  function forgetKept() {
    if (typeof WS.dropCache !== 'function') return;
    WS.dropCache('book:' + state.id);
    WS.dropCache('books:me:');
  }

  /** One change of the person's own: shown at once, sent, put back (with a
      toast) when refused. One at a time per kind; presses meanwhile wait out. */
  function change(kind, next, method, url, body, words) {
    if (state.busy[kind] || !state.mine) return;
    const before = Object.assign({}, state.mine);
    state.busy[kind] = true;
    Object.assign(state.mine, next);
    syncMine();
    say(words.done);
    forgetKept();
    sendBooks(method, url, body).then(function (data) {
      state.busy[kind] = false;
      if (signal.aborted) return;
      // The server's place in the queue is the one shown.
      if (kind === 'queue' && data && 'queue_position' in data) state.mine.queue = data.queue_position;
      syncMine();
      told(kind);
    }, function (err) {
      state.busy[kind] = false;
      if (signal.aborted) return;
      state.mine = before;
      syncMine();
      say('');
      toast(err && err.status === 409 ? words.full : words.failed);
    });
  }

  function bookUrl(part) {
    return '/api/books/' + encodeURIComponent(String(state.data.book.id)) + '/' + part;
  }

  function toggleList() {
    if (!state.mine) return;
    if (state.mine.list) {
      change('list', { list: false }, 'DELETE', bookUrl('list'), undefined,
        { done: 'Removed from My list', failed: 'Couldn’t update My list. Try again.' });
    } else {
      rememberRow('mylist', who);
      change('list', { list: true }, 'PUT', bookUrl('list'), undefined,
        { done: 'Added to My list', failed: 'Couldn’t update My list. Try again.', full: 'My list is full. Remove a book to add this one.' });
    }
  }

  function addToQueue() {
    if (!state.mine || state.mine.queue !== null) return;
    rememberRow('upnext', who);
    change('queue', { queue: -1 }, 'PUT', bookUrl('queue'), undefined,
      { done: 'Added to Up next', failed: 'Couldn’t update Up next. Try again.', full: 'Up next is full. Remove a book to add this one.' });
  }

  function removeFromQueue() {
    if (!state.mine || state.mine.queue === null) return;
    const remove = root.querySelector('[data-mine="unqueue"]');
    const hadFocus = !!remove && remove === document.activeElement;
    change('queue', { queue: null }, 'DELETE', bookUrl('queue'), undefined,
      { done: 'Removed from Up next', failed: 'Couldn’t update Up next. Try again.' });
    // Remove hides itself: the focus goes to Add to Up next, beside it.
    if (hadFocus) root.querySelector('[data-mine="queue"]').focus();
  }

  function rate(stars) {
    if (!state.mine || state.mine.rating === stars) return;
    if (stars === null) {
      const clear = root.querySelector('[data-mine="clear"]');
      const hadFocus = !!clear && clear === document.activeElement;
      change('rating', { rating: null }, 'DELETE', bookUrl('rating'), undefined,
        { done: 'Rating cleared', failed: 'Couldn’t clear your rating. Try again.' });
      // Clear hides itself: the focus goes to the first star, beside it.
      if (hadFocus) root.querySelector('[data-star="1"]').focus();
    } else {
      change('rating', { rating: stars }, 'PUT', bookUrl('rating'), { stars: stars },
        { done: 'Rated ' + stars + (stars === 1 ? ' star' : ' stars'), failed: 'Couldn’t save your rating. Try again.' });
    }
  }

  function mineButton(kind) {
    const b = el('button', MINE_BTN + MINE_OFF);
    b.type = 'button';
    b.setAttribute('data-mine', kind);
    b.appendChild(icon('add', 'text-[22px] shrink-0'));
    b.lastChild.setAttribute('data-icon', '');
    b.appendChild(el('span', 'truncate', ''));
    b.lastChild.setAttribute('data-label', '');
    return b;
  }

  /** "Add to My list" / "On My list"; "Add to Up next" / "2nd in Up next" with
      Remove; the stars and Clear. Drawn from state.mine whenever it changes. */
  function syncMine() {
    if (signal.aborted || !state.mine) return;
    const m = state.mine;
    const list = root.querySelector('[data-mine="list"]');
    if (list) {
      list.className = MINE_BTN + (m.list ? MINE_ON : MINE_OFF);
      list.querySelector('[data-icon]').textContent = m.list ? 'check' : 'add';
      list.querySelector('[data-label]').textContent = m.list ? 'On My list' : 'Add to My list';
    }
    const queue = root.querySelector('[data-mine="queue"]');
    const remove = root.querySelector('[data-mine="unqueue"]');
    if (queue) {
      const queued = m.queue !== null && m.queue !== undefined;
      queue.className = MINE_BTN + (queued ? MINE_ON : MINE_OFF);
      queue.querySelector('[data-icon]').textContent = queued ? 'playlist_add_check' : 'playlist_add';
      queue.querySelector('[data-label]').textContent = !queued ? 'Add to Up next'
        : m.queue >= 0 ? ordinal(m.queue + 1) + ' in Up next' : 'In Up next';
      // Queued, it is a statement with its own Remove beside it, not a button that does something else.
      if (queued) queue.setAttribute('aria-disabled', 'true'); else queue.removeAttribute('aria-disabled');
      remove.classList.toggle('hidden', !queued);
      remove.classList.toggle('inline-flex', queued);
    }
    const stars = root.querySelectorAll('[data-star]');
    Array.prototype.forEach.call(stars, function (b) {
      const n = parseInt(b.getAttribute('data-star'), 10);
      b.setAttribute('aria-pressed', m.rating === n ? 'true' : 'false');
    });
    paintStars(0);
    const clear = root.querySelector('[data-mine="clear"]');
    // Its room is kept while there is nothing to clear, so the row never changes width.
    if (clear) clear.classList.toggle('invisible', !m.rating);
  }

  /** The stars filled to the rating, or (hint) to the one under the pointer. */
  function paintStars(hint) {
    const rating = state.mine ? state.mine.rating || 0 : 0;
    Array.prototype.forEach.call(root.querySelectorAll('[data-star]'), function (b) {
      const n = parseInt(b.getAttribute('data-star'), 10);
      const glyph = b.querySelector('[data-icon]');
      glyph.className = 'material-symbols-outlined ' + (hint ? (n <= hint ? STAR_HINT : STAR_EMPTY) : (n <= rating ? STAR_FILL : STAR_EMPTY));
    });
  }

  function ratingRow() {
    const wrap = el('div', 'mt-5');
    wrap.setAttribute('data-rating', '');
    const label = el('p', 'text-[15px] font-medium text-frosted-blue/70', 'Your rating');
    label.id = 'ratingLabel';
    wrap.appendChild(label);
    const row = el('div', 'mt-1 -ml-2 flex items-center');
    const group = el('div', 'flex items-center');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', 'ratingLabel');
    for (let n = 1; n <= 5; n++) {
      const b = el('button', STAR);
      b.type = 'button';
      b.setAttribute('data-star', String(n));
      b.setAttribute('aria-label', n + (n === 1 ? ' star' : ' stars'));
      b.appendChild(icon('star', STAR_EMPTY));
      b.lastChild.setAttribute('data-icon', '');
      b.addEventListener('click', function () { rate(n); }, { signal: signal });
      b.addEventListener('mouseenter', function () { paintStars(n); }, { signal: signal });
      group.appendChild(b);
    }
    group.addEventListener('mouseleave', function () { paintStars(0); }, { signal: signal });
    row.appendChild(group);
    const clear = el('button', 'invisible ml-2 inline-flex h-10 items-center rounded-[10px] px-2 text-[15px] font-semibold text-frosted-blue/70 hover:bg-frosted-blue/[0.07] hover:text-frosted-blue ' + LINK_FOCUS, 'Clear');
    clear.type = 'button';
    clear.setAttribute('data-mine', 'clear');
    clear.setAttribute('aria-label', 'Clear your rating');
    clear.addEventListener('click', function () { rate(null); }, { signal: signal });
    row.appendChild(clear);
    wrap.appendChild(row);
    return wrap;
  }

  /** My list and Up next, then the stars; null for an answer without them. */
  function mineBlock() {
    if (!state.mine) return null;
    const box = el('div', 'mt-6 max-w-xl');
    box.setAttribute('data-mine-block', '');
    // The same two columns as Read and Listen above, one under the other when narrow.
    const row = el('div', 'grid gap-3 @[30rem]:grid-cols-2');
    const list = mineButton('list');
    list.addEventListener('click', toggleList, { signal: signal });
    row.appendChild(list);
    const cell = el('div', 'flex min-w-0 items-center gap-2');
    const queue = mineButton('queue');
    queue.addEventListener('click', addToQueue, { signal: signal });
    cell.appendChild(queue);
    const remove = el('button', 'hidden h-11 shrink-0 items-center rounded-[10px] px-3 text-[15px] font-semibold text-frosted-blue/70 hover:bg-frosted-blue/[0.07] hover:text-frosted-blue ' + LINK_FOCUS, 'Remove');
    remove.type = 'button';
    remove.setAttribute('data-mine', 'unqueue');
    remove.setAttribute('aria-label', 'Remove from Up next');
    remove.addEventListener('click', removeFromQueue, { signal: signal });
    cell.appendChild(remove);
    row.appendChild(cell);
    box.appendChild(row);
    box.appendChild(ratingRow());
    const said = el('p', 'sr-only', '');
    said.id = 'bookSaid';
    said.setAttribute('role', 'status');
    said.setAttribute('aria-live', 'polite');
    box.appendChild(said);
    return box;
  }

  // ---- Drawing ----

  /** A big button, or a link looking like one: the format's icon, a verb, and
      under it where the person is (or why they can't be). */
  function control(tag, kind, tone, name, label, sub) {
    const node = el(tag, BTN + tone);
    if (kind) node.setAttribute('data-action', kind);
    node.appendChild(icon(name, 'text-[28px] shrink-0'));
    node.lastChild.setAttribute('data-icon', '');
    const words = el('span', 'min-w-0 flex-1');
    words.appendChild(el('span', 'block text-[17px] font-semibold leading-tight', label));
    words.lastChild.setAttribute('data-label', '');
    words.appendChild(el('span', 'block truncate text-[13px] font-medium leading-snug', sub));
    words.lastChild.setAttribute('data-sub', '');
    node.appendChild(words);
    return node;
  }

  /** A thin bar along the bottom of a button for a place in progress (drawn from CSSOM). */
  function bar(node, progress, main) {
    if (!progress || progress.finished || typeof progress.percent !== 'number') return;
    const track = el('span', 'absolute inset-x-0 bottom-0 block h-1 ' + (main ? 'bg-bright/25' : 'bg-frosted-blue/[0.15]'));
    const fill = el('span', 'block h-full ' + (main ? 'bg-bright' : 'bg-frosted-blue'));
    fill.style.width = Math.max(0, Math.min(100, progress.percent)) + '%';
    track.setAttribute('data-bar', '');
    track.setAttribute('aria-hidden', 'true');
    track.appendChild(fill);
    node.appendChild(track);
  }

  function requestLink(kind, href) {
    const word = kind === 'ebook' ? 'ebook' : 'audiobook';
    const a = control('a', '', QUIET, kind === 'ebook' ? 'menu_book' : 'headphones', 'Request the ' + word, 'No ' + word + ' in the library yet');
    a.setAttribute('data-request', kind);
    a.href = href;
    return a;
  }

  function slot(kind, node) {
    const cell = el('div', 'min-w-0');
    cell.setAttribute('data-slot', kind);
    cell.appendChild(node);
    return cell;
  }

  function noteText(data, source, fallback) {
    const n = data.notes.filter(function (x) { return x && x.source === source && x.text; })[0];
    return n ? n.text : fallback;
  }

  function ebookSlot(data, lead) {
    const f = data.formats.ebook;
    const notes = data.notes;
    if (f) {
      const href = readerHref(f.read_url);
      const failed = !f.progress && notes.some(function (n) { return n && n.source === 'kavita'; });
      const sub = f.progress ? f.progress.label : failed ? 'Progress unavailable' : 'Not started';
      if (!href) {
        const off = control('button', 'read', OFF, 'menu_book', 'Read', 'This ebook can’t be opened right now');
        off.type = 'button';
        off.disabled = true;
        return slot('ebook', off);
      }
      const main = lead === 'read';
      const a = control('a', 'read', main ? MAIN : QUIET, 'menu_book', 'Read', sub);
      a.href = href;
      bar(a, f.progress, main);
      const cell = slot('ebook', a);
      cell.appendChild(readSampleLink(href));
      return cell;
    }
    if (data.request_links.ebook) {
      const href = requestHref(data.request_links.ebook);
      return href && !state.embed ? slot('ebook', requestLink('ebook', href)) : null;
    }
    if (needsConnect(data)) {
      const b = control('button', 'read', QUIET, 'menu_book', 'Read', connectText());
      b.type = 'button';
      b.addEventListener('click', retryConnect, { signal: signal });
      return slot('ebook', b);
    }
    if (notes.some(function (n) { return n && n.source === 'kavita'; })) {
      const off = control('button', 'read', OFF, 'menu_book', 'Read', noteText(data, 'kavita', 'Ebooks are unavailable right now'));
      off.type = 'button';
      off.disabled = true;
      return slot('ebook', off);
    }
    return null;      // hidden from this person: not shown, not offered for request
  }

  function audioSlot(data, lead) {
    const f = data.formats.audio;
    if (f && f.editions.length) {
      const main = lead === 'listen';
      const b = control('button', 'listen', main ? MAIN : QUIET, 'play_arrow', 'Listen', '');
      b.type = 'button';
      b.addEventListener('click', listen, { signal: signal });
      const edition = editionOf(state.edition);
      b.querySelector('[data-sub]').textContent = edition && edition.progress ? edition.progress.label : 'Not started';
      bar(b, edition && edition.progress, main);
      const cell = slot('audio', b);
      if (f.editions.length > 1) cell.appendChild(narratorPicker(f.editions));
      cell.appendChild(sampleButton());
      return cell;
    }
    if (data.request_links.audio) {
      const href = requestHref(data.request_links.audio);
      return href && !state.embed ? slot('audio', requestLink('audio', href)) : null;
    }
    if (data.notes.some(function (n) { return n && n.source === 'plex'; })) {
      const off = control('button', 'listen', OFF, 'headphones', 'Listen', noteText(data, 'plex', 'Audiobooks are unavailable right now'));
      off.type = 'button';
      off.disabled = true;
      off.setAttribute('data-off', '');
      return slot('audio', off);
    }
    return null;
  }

  /** Several narrators: one book, and the picker chooses which recording Listen plays. */
  function narratorPicker(editions) {
    const wrap = el('div', 'mt-3');
    const label = el('label', 'mb-1 block text-[13px] font-medium text-frosted-blue/70', 'Narrator');
    label.setAttribute('for', 'narratorSelect');
    const box = el('div', 'relative');
    const select = el('select', 'w-full appearance-none h-10 rounded-[10px] border-0 bg-frosted-blue/[0.07] pl-4 pr-10 text-[15px] text-frosted-blue cursor-pointer focus:outline-none focus:ring-2 focus:ring-frosted-blue');
    select.id = 'narratorSelect';
    editions.forEach(function (e) {
      const name = e.narrator || 'Unknown narrator';
      const o = el('option', '', e.progress ? name + ' (' + e.progress.label + ')' : name);
      o.value = e.plex_book_key;
      select.appendChild(o);
    });
    select.value = state.edition;
    select.addEventListener('change', function () {
      if (!editionOf(select.value)) { select.value = state.edition; return; }
      state.edition = select.value;
      syncListen();
      const btn = root.querySelector('[data-action="listen"]');
      const edition = editionOf(state.edition);
      const old = btn && btn.querySelector('[data-bar]');
      if (old) old.remove();
      if (btn && edition) bar(btn, edition.progress, /bg-primary/.test(btn.className));
    }, { signal: signal });
    box.appendChild(select);
    box.appendChild(icon('expand_more', 'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-frosted-blue/70'));
    wrap.appendChild(label);
    wrap.appendChild(box);
    return wrap;
  }

  /** Which of Read and Listen leads: the format they were last in, still
      unfinished; with neither started, Read. */
  function leader(data) {
    const f = data.formats;
    const edition = f.audio ? editionOf(state.edition) : null;
    const read = f.ebook && f.ebook.progress && !f.ebook.progress.finished ? when(f.ebook.progress) : -1;
    const hear = edition && edition.progress && !edition.progress.finished ? when(edition.progress) : -1;
    if (read < 0 && hear < 0) return f.ebook ? 'read' : 'listen';
    return hear > read ? 'listen' : 'read';
  }

  function byline(data) {
    const b = data.book;
    const box = el('div', 'mt-4 space-y-1 break-words');
    if (b.author) {
      const p = el('p', 'text-[17px] text-frosted-blue', 'By ');
      const a = el('a', PERSON, b.author);
      a.href = personHref('author', b.author);
      a.setAttribute('data-person', 'author');
      p.appendChild(a);
      box.appendChild(p);
    }
    const names = (b.narrators || []).filter(Boolean);
    if (names.length) {
      const p = el('p', 'text-[15px] text-frosted-blue/70', 'Narrated by ');
      names.forEach(function (name, i) {
        if (i) p.appendChild(document.createTextNode(', '));
        const a = el('a', PERSON, name);
        a.href = personHref('narrator', name);
        a.setAttribute('data-person', 'narrator');
        p.appendChild(a);
      });
      box.appendChild(p);
    }
    if (b.series) {
      const number = numberText(b.series_number);
      const p = el('p', 'text-[15px] text-frosted-blue/70', number ? 'Book ' + number + ' of ' : 'Part of ');
      const a = el('a', PERSON, b.series);
      a.href = '/books/series?name=' + encodeURIComponent(b.series);
      a.setAttribute('data-series-link', '');
      p.appendChild(a);
      box.appendChild(p);
    }
    return box;
  }

  /** The description as paragraphs of text; a long one is folded behind a button. */
  function about(text) {
    const paragraphs = String(text || '').split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!paragraphs.length) return null;
    const wrap = el('div', 'mt-8 max-w-[65ch]');
    const body = el('div', 'space-y-3 break-words text-[16px] leading-relaxed text-frosted-blue');
    body.id = 'bookAbout';
    paragraphs.forEach(function (s) { body.appendChild(el('p', '', s)); });
    wrap.appendChild(body);
    if (paragraphs.join(' ').length > FOLD_AT) {
      const toggle = el('button', 'mt-2 -ml-2 inline-flex h-10 items-center rounded-[10px] px-2 text-[15px] font-semibold text-frosted-blue/70 hover:text-frosted-blue ' + LINK_FOCUS, 'Show more');
      toggle.id = 'aboutToggle';
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', 'bookAbout');
      const fold = function (folded) {
        // Folded: the first paragraph, four lines of it. Open: all of it.
        body.querySelectorAll('p').forEach(function (p, i) {
          p.classList.toggle('line-clamp-4', folded && i === 0);
          p.classList.toggle('hidden', folded && i > 0);
        });
        toggle.setAttribute('aria-expanded', folded ? 'false' : 'true');
        toggle.textContent = folded ? 'Show more' : 'Show less';
      };
      fold(true);
      toggle.addEventListener('click', function () { fold(toggle.getAttribute('aria-expanded') === 'true'); }, { signal: signal });
      wrap.appendChild(toggle);
    }
    return wrap;
  }

  function buildRest(data) {
    const rest = el('div', '');
    rest.id = 'bookRest';
    rest.appendChild(byline(data));
    const lead = leader(data);
    const cells = [ebookSlot(data, lead), audioSlot(data, lead)].filter(Boolean);
    if (cells.length) {
      const actions = el('div', 'mt-6 grid max-w-xl items-start gap-3 @[30rem]:grid-cols-2');
      cells.forEach(function (c) { actions.appendChild(c); });
      rest.appendChild(actions);
    }
    const mine = mineBlock();
    if (mine) rest.appendChild(mine);
    const text = about(data.book.description);
    if (text) rest.appendChild(text);
    return rest;
  }

  function swapCover(node) {
    const old = $('bookCover');
    node.id = 'bookCover';
    old.replaceWith(node);
  }

  function swapRest(node) {
    $('bookRest').replaceWith(node);
  }

  function done(title) {
    $('bookView').setAttribute('aria-busy', 'false');
    if (title && typeof ctx.setTitle === 'function') ctx.setTitle(title);
  }

  /** One write: the heading's text, and the cover and everything after it as new elements. */
  function commit(data) {
    const b = data.book;
    state.data = data;
    const editions = data.formats.audio ? data.formats.audio.editions : [];
    const preferred = data.formats.audio && data.formats.audio.preferred;
    state.edition = editions.some(function (e) { return e.plex_book_key === preferred; }) ? preferred : (editions[0] ? editions[0].plex_book_key : '');

    const formats = [];
    if (data.formats.ebook) formats.push('ebook');
    if (data.formats.audio) formats.push('audio');
    const cover = el('div', 'w-36 @[34rem]:w-full');
    cover.appendChild(coverBox(b.cover_url, formats, signal, { badges: false, eager: true }));
    swapCover(cover);
    $('bookTitle').textContent = b.title || 'Untitled';
    state.mine = data.mine;
    swapRest(buildRest(data));
    done(b.title);
    watch();
    syncListen();
    syncSample();
    syncMine();
    // A merged book: the address becomes the surviving book's, without a history
    // entry (while it is still this book's: the pop-up may be closing).
    if (b.id !== state.id && !state.addressFixed && typeof b.id === 'number' && bookId(window.location.pathname) === state.id) {
      state.addressFixed = true;
      try {
        window.history.replaceState(window.history.state, '', '/books/' + b.id + ctx.url.search + ctx.url.hash);
      } catch (e) { /* the page is right; only the address is not */ }
    }
  }

  function message(kind, title, text, action) {
    const rest = el('div', 'mt-4 max-w-xl');
    rest.id = 'bookRest';
    rest.setAttribute('data-state', kind);
    rest.appendChild(el('p', 'text-[17px] text-frosted-blue/70', text));
    if (action) rest.appendChild(action);
    swapCover((function () {
      const c = el('div', 'w-36 @[34rem]:w-full');
      c.appendChild(coverBox(null, [], signal, { badges: false }));
      return c;
    })());
    $('bookTitle').textContent = title;
    swapRest(rest);
    done('');
  }

  function showNotFound() {
    let back;
    if (closeView) {
      // In the pop-up the page is under it: Close is the way back.
      back = el('button', 'ws-lift mt-6 inline-flex h-11 items-center rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Close');
      back.type = 'button';
      back.addEventListener('click', closeView, { signal: signal });
    } else {
      back = el('a', 'ws-lift mt-6 inline-flex h-11 items-center rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Back to Books');
      back.href = '/books';
    }
    message('notfound', 'We couldn’t find that book', 'It may have been removed from the library, or this link is out of date.', back);
  }

  /** An ebook this person cannot see only because Kavita does not know them yet
      (the API's 404 says so): the hand-off runs once, from here, and comes back
      to this page; if it cannot (it was just tried, or failed) they are told, with a button. */
  function showConnect() {
    state.connectView = true;
    const action = el('button', 'ws-lift mt-6 h-11 rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Connect');
    action.id = 'bookConnect';
    action.type = 'button';
    action.addEventListener('click', retryConnect, { signal: signal });
    message('connect', 'Connect your ebook library',
      state.connectProblem ? 'We couldn’t connect you to the ebook library just now. Try again in a moment.'
        : 'This book is in the ebook library. Connecting you now.',
      state.connectProblem ? action : null);
  }

  /** A source that is not answering (the API's 404 says "unavailable"): the book is
      there, it just cannot be opened now. Never "removed from the library". */
  function showUnavailable(note) {
    const retry = el('button', 'ws-lift mt-6 h-11 rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Try again');
    retry.id = 'bookRetry';
    retry.type = 'button';
    retry.addEventListener('click', function () { showSkeleton(); load(true); }, { signal: signal });
    message('unavailable', note && note.text ? note.text : 'Books are unavailable right now',
      'The library still has this book. It will open as soon as it answers again. Try again in a moment.', retry);
  }

  function showError() {
    const retry = el('button', 'ws-lift mt-6 h-11 rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Try again');
    retry.id = 'bookRetry';
    retry.type = 'button';
    retry.addEventListener('click', function () { showSkeleton(); load(true); }, { signal: signal });
    message('error', 'We couldn’t load this book', 'Everything else on the site is unaffected. Try again in a moment.', retry);
  }

  /** Back to the skeleton (Try again): fresh copies, so nothing on screen is reused. */
  function showSkeleton() {
    swapCover(skeleton.cover.cloneNode(true));
    const heading = $('bookTitle');
    heading.textContent = '';
    skeleton.title.forEach(function (n) { heading.appendChild(n.cloneNode(true)); });
    swapRest(skeleton.rest.cloneNode(true));
    $('bookView').setAttribute('aria-busy', 'true');
  }

  // ---- Loading ----

  function valid(data) {
    return !!data && typeof data === 'object' && !!data.book && typeof data.book === 'object' &&
      !!data.formats && typeof data.formats === 'object';
  }

  /** The answer with every part this page reads present, whatever came. */
  function tidy(data) {
    const f = data.formats;
    const audio = f.audio && Array.isArray(f.audio.editions) ? f.audio : null;
    // The person's own, when the answer has them (all three, or none of them).
    const has = typeof data.my_list === 'boolean' && 'queue_position' in data && 'my_rating' in data;
    const place = data.queue_position;
    const stars = data.my_rating;
    return {
      book: data.book,
      formats: { ebook: f.ebook || null, audio: audio },
      request_links: Object.assign({ ebook: null, audio: null }, data.request_links || {}),
      notes: Array.isArray(data.notes) ? data.notes : [],
      mine: has ? {
        list: data.my_list,
        queue: typeof place === 'number' && place >= 0 ? place : null,
        rating: typeof stars === 'number' && stars >= 1 && stars <= 5 ? stars : null
      } : null
    };
  }

  /** The book, from the server. Its notes decide the hand-off, so they are
      looked at on the live answer only, never on a kept copy. */
  function readLive() {
    return WS.getJSON('/api/books/' + encodeURIComponent(String(state.id)), { signal: signal }).then(function (data) {
      if (!valid(data)) throw new Error('Unexpected response');
      const tidied = tidy(data);
      if (needsConnect(tidied)) startConnect();
      return data;
    });
  }

  function load(fresh) {
    const gen = ++state.gen;
    return WS.swr('book:' + state.id, readLive, function (data) {
      if (signal.aborted || gen !== state.gen) return;
      WS.arrive('book', function () {
        if (signal.aborted || gen !== state.gen) return;
        commit(tidy(data));
      });
    }, {
      maxAge: fresh ? 0 : KEEP_MS,
      onError: function (err) {
        if (gen !== state.gen || quiet(err)) return;
        WS.arrive('book', function () {
          if (signal.aborted || gen !== state.gen) return;
          if (statusOf(err) === 404 && err.body && err.body.reason === 'not_connected') { startConnect(); showConnect(); return; }
          if (statusOf(err) === 404 && err.body && err.body.reason === 'unavailable') { showUnavailable((err.body.notes || [])[0]); return; }
          if (statusOf(err) === 404) showNotFound(); else showError();
        });
      }
    });
  }

  // ---- Boot ----

  // (In the pop-up the page under it has started the visit, and read the address.)
  if (!closeView && window.WSKavita && typeof window.WSKavita.init === 'function') window.WSKavita.init();
  // A sign-in that just failed sends the person back here: no automatic attempt this visit.
  if (!closeView && window.WSKavita && typeof window.WSKavita.arrivedFromFailedConnect === 'function') window.WSKavita.arrivedFromFailedConnect();

  if (!state.id) {
    WS.arrive('book', showNotFound);
    return;
  }

  const first = load(false);
  // The page is on screen (or its skeleton, which has its shape) before mount
  // resolves, so Back and Forward restore the scroll onto it. A slow answer
  // does not hold that up for long.
  await Promise.race([
    first,
    new Promise(function (resolve) { ctx.setTimeout(resolve, MOUNT_WAIT_MS); })
  ]);
}

// ---- The pop-up ----

const CLOSE_MS = 130;               // the pop-up's fade out (its keyframes are theme.css's)
// Written out whole for Tailwind. The dim fades in and the box rises with it;
// on the way out both fade. Each animates its own opacity, never an ancestor's,
// so the frosted box keeps its blur of the page throughout.
const DIM_IN = 'animate-[ws-vt-in_160ms_ease-out_both]';
const BOX_IN = 'animate-[ws-dialog-in_180ms_ease-out_both]';
const FADE_OUT = 'animate-[ws-vt-out_130ms_ease-in_both]';

function reduceMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** "<site> - <name>", as the router titles a view (router.js pageTitle). */
function viewTitle(name) {
  const b = (window.WS && window.WS.data && window.WS.data.branding) || {};
  const site = typeof b.app_name === 'string' ? b.app_name.trim() : '';
  return site ? site + ' - ' + name : name;
}

function entryOf(st) {
  return st && st.ws === 1 && typeof st.i === 'number' ? st.i : null;
}

/**
 * The pop-up over a Books page. page: { root (#wsPage), signal, url, data,
 * setTimeout, clearTimeout } (the page's ctx), entry (the page's history
 * entry, router.js state.i, when it was mounted) and changed(kind) (what to
 * tell it). Null when the page has no #bookDialog. Returns:
 *   open(url, link)  a book's address: drawn here; link, the one pressed (focus
 *                goes back to it). A promise of the book's title (the router
 *                titles and announces the view with it)
 *   leave(url)   true when url is the pop-up's own way back (the page's
 *                address under it, or the one it asked the router for), which
 *                then closes it; anything else is left to the page and router
 *   at(url)      the page is at url now (its own claim took it): the address
 *                under the pop-up, which closes if it was open
 */
export function bookDialog(page) {
  const overlay = page.root.querySelector('#bookDialog');
  if (!overlay) return null;
  const box = overlay.querySelector('[data-dialog-box]');
  const dim = overlay.querySelector('.ws-scrim');
  const html = document.documentElement;
  // The skeleton as the server sent it: each book starts from a fresh copy.
  const blank = overlay.querySelector('#bookBody').cloneNode(true);
  const UI = window.WSUI;

  // The page's own address under the pop-up, and its history entry (as the
  // page had them when it was mounted: the address may already be a book's by
  // the time this module is loaded). A full load of /books/<id> never had
  // one: the Books page's, with no entry.
  const loaded = bookId(page.url.pathname) !== null;
  let base = loaded ? { href: new URL('/books', page.url.href).href, i: null }
    : { href: page.url.href, i: typeof page.entry === 'number' ? page.entry : null };
  let visit = null;         // the book on screen: { id, ctl, done(title) }
  let modal = null;         // its WSUI.modal while it is open
  let closing = '';         // 'nav': closed for a navigation, which moves the address itself
  let keep = false;         // the router closes every dialog after a claim; not this one
  let leaving = '';         // the address this pop-up asked the router for on closing
  let opener = null;        // the link that opened it (focus goes back to it)
  let pageTitle = '';
  let hideTimer = 0;
  let listened = false;

  overlay.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('[data-book-close]')) close();
  }, { signal: page.signal });
  page.signal.addEventListener('abort', function () {
    endVisit();
    if (modal) { closing = 'nav'; modal.close(); }
  }, { once: true });

  function isOpen() { return !!visit; }

  function endVisit() {
    if (!visit) return;
    visit.ctl.abort();
    visit.done('');
    visit = null;
  }

  function startModal() {
    if (modal || !visit || page.signal.aborted) return;
    // The card that opened it has the focus first, so it gets it back.
    if (opener && document.activeElement !== opener && document.contains(opener)) {
      try { opener.focus({ preventScroll: true }); } catch (e) { /* the modal takes it anyway */ }
    }
    if (!UI || typeof UI.modal !== 'function') return;
    modal = UI.modal(overlay, { box: box, onClose: onClose });
  }

  /** WSUI.modal closed it: Escape, close() below, or the router before a swap. */
  function onClose() {
    modal = null;
    if (keep) {
      // The router's closing of every dialog after it gave this pop-up a book.
      keep = false;
      startModal();
      return;
    }
    const why = closing;
    closing = '';
    hide();
    // The router closes dialogs and leaves the page in one go: then nothing
    // here is left to do.
    Promise.resolve().then(function () {
      if (page.signal.aborted) return;
      if (why !== 'nav') leaveAddress();
      refocus();
    });
  }

  /** Escape, Close, the dim, or the not-found state's Close. */
  function close() {
    if (modal) { modal.close(); return; }
    if (!visit) return;
    hide();
    leaveAddress();
    refocus();
  }

  /** Closed for a navigation (Back, or the page's own claim): no address change here. */
  function closeForNav() {
    if (!visit) return;
    if (modal) { closing = 'nav'; modal.close(); return; }
    hide();
    refocus();
  }

  function refocus() {
    const to = opener && document.contains(opener) ? opener : page.root.querySelector('h1');
    opener = null;
    if (!to) return;
    if (to.tagName === 'H1' && !to.hasAttribute('tabindex')) to.setAttribute('tabindex', '-1');
    try { to.focus({ preventScroll: true }); } catch (e) { /* nothing to focus */ }
  }

  /** The address back to the page's: one step back when the entry before is
      the page's (the pop-up was opened from it), else the page's address in
      place of this one. */
  function leaveAddress() {
    const at = entryOf(window.history.state);
    // Either way the router hands the address back (leave), and it is taken as is.
    leaving = base.href;
    if (base.i !== null && at !== null && at === base.i + 1) {
      window.history.back();
      return;
    }
    const router = window.WS && window.WS.router;
    if (router && typeof router.navigate === 'function') {
      Promise.resolve(router.navigate(base.href, { replace: true })).catch(function () { /* the page is already shown */ });
    } else {
      leaving = '';
      try { window.history.replaceState(window.history.state, '', base.href); } catch (e) { /* only the address is off */ }
    }
  }

  function hide() {
    if (!visit) return;
    endVisit();
    if (pageTitle) document.title = pageTitle;
    if (listened) {
      listened = false;
      tell('listen');
    }
    const animated = !reduceMotion() && box.classList.contains(BOX_IN);
    if (!animated) { finishHide(); return; }
    overlay.inert = true;
    box.classList.remove(BOX_IN);
    dim.classList.remove(DIM_IN);
    box.classList.add(FADE_OUT);
    dim.classList.add(FADE_OUT);
    hideTimer = page.setTimeout(finishHide, CLOSE_MS);
  }

  function finishHide() {
    if (hideTimer) page.clearTimeout(hideTimer);
    hideTimer = 0;
    overlay.inert = false;
    [BOX_IN, DIM_IN, FADE_OUT].forEach(function (c) { box.classList.remove(c); dim.classList.remove(c); });
    if (!visit) html.removeAttribute('data-book-open');
  }

  function tell(kind) {
    if (typeof page.changed === 'function') {
      try { page.changed(kind); } catch (e) { console.error(e); }
    }
  }

  function open(url, link) {
    const id = bookId(url.pathname);
    if (id === null) return Promise.resolve('');
    if (visit && visit.id === id) return visit.title;
    const was = isOpen();
    leaving = '';
    if (hideTimer) finishHide();
    if (!was) {
      pageTitle = document.title;
      opener = link && document.contains(link) ? link : null;
    } else if (modal) {
      keep = true;
      Promise.resolve().then(function () { keep = false; });
    }
    endVisit();
    const ctl = new AbortController();
    let done;
    const title = new Promise(function (resolve) { done = resolve; });
    visit = { id: id, ctl: ctl, title: title, done: done };

    const body = overlay.querySelector('#bookBody');
    body.replaceWith(blank.cloneNode(true));
    if (!was) {
      // Opened by a press: it fades in. Already on screen (a full load of the
      // address, server-rendered): it stays as it is.
      if (!html.hasAttribute('data-book-open') && !reduceMotion()) {
        dim.classList.add(DIM_IN);
        box.classList.add(BOX_IN);
      }
      html.setAttribute('data-book-open', '');
      // After the router has closed the dialogs it closes on a claim.
      Promise.resolve().then(function () { if (visit && visit.ctl === ctl) startModal(); });
    }

    const signal = ctl.signal;
    mount({
      root: overlay.querySelector('#bookBody'),
      signal: signal,
      url: new URL(url.href),
      data: (window.WS && window.WS.data) || page.data,
      setTimeout: function (fn, ms) {
        return page.setTimeout(function () { if (!signal.aborted) fn(); }, ms);
      },
      setTitle: function (name) {
        if (signal.aborted || typeof name !== 'string' || !name) return;
        document.title = viewTitle(name);
        done(name);
      },
      close: close,
      onChange: function (kind) {
        if (kind === 'listen') listened = true;
        else tell(kind);
      }
    }).then(function () {
      // On screen (or its skeleton) without a title yet: the view is not
      // named; the tab still takes the title when it comes.
      done('');
    }, function (e) {
      if (!signal.aborted) console.error('[book] the pop-up could not draw the book', e);
      done('');
    });
    return title;
  }

  function leave(url) {
    if (leaving && url.href === leaving) {
      leaving = '';
      return true;
    }
    if (!isOpen() || url.href !== base.href) return false;
    closeForNav();
    return true;
  }

  function at(url) {
    base = { href: url.href, i: entryOf(window.history.state) };
    closeForNav();
  }

  return { open: open, leave: leave, at: at };
}
