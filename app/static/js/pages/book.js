/**
 * WebServarr, a book (page module)
 *
 * /books/<id>: one book, whatever formats it comes in. The cover, the title,
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
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. Markup is built with textContent only.
 */
import { coverBox } from './books.js';

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

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;
  const $ = function (id) { return root.querySelector('#' + id); };

  const state = {
    id: bookId(ctx.url.pathname),
    gen: 0,
    data: null,
    edition: '',            // the narrator picked: a plex_book_key
    reconnectTried: false, connectProblem: false,
    unwatch: null,
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
    const done = new AbortController();
    signal.addEventListener('abort', function () {
      state.unwatch();
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
    const loading = mine && !!st.loading;
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
    if (!edition) return;
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
    Promise.resolve(p.open(edition.plex_book_key, { autoplay: true })).catch(function (e) {
      if (signal.aborted) return;
      console.warn('The player could not open ' + edition.plex_book_key, e);
    });
    syncListen();
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
      return slot('ebook', a);
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
    const box = el('div', 'mt-4 space-y-1');
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
    const body = el('div', 'space-y-3 text-[16px] leading-relaxed text-frosted-blue');
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
      const actions = el('div', 'mt-6 grid max-w-xl items-start gap-3 sm:grid-cols-2');
      cells.forEach(function (c) { actions.appendChild(c); });
      rest.appendChild(actions);
    }
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
    const cover = el('div', 'w-40 sm:w-full');
    cover.appendChild(coverBox(b.cover_url, formats, signal, { badges: false }));
    swapCover(cover);
    $('bookTitle').textContent = b.title || 'Untitled';
    swapRest(buildRest(data));
    done(b.title);
    watch();
    syncListen();
    // A merged book: the address becomes the surviving book's, without a history entry.
    if (b.id !== state.id && !state.addressFixed && typeof b.id === 'number') {
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
      const c = el('div', 'w-40 sm:w-full');
      c.appendChild(coverBox(null, [], signal, { badges: false }));
      return c;
    })());
    $('bookTitle').textContent = title;
    swapRest(rest);
    done('');
  }

  function showNotFound() {
    const back = el('a', 'ws-lift mt-6 inline-flex h-11 items-center rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Back to Books');
    back.href = '/books';
    message('notfound', 'We couldn’t find that book', 'It may have been removed from the library, or this link is out of date.', back);
  }

  function showError() {
    const retry = el('button', 'ws-lift mt-6 h-11 rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Try again');
    retry.id = 'retryBtn';
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
    return {
      book: data.book,
      formats: { ebook: f.ebook || null, audio: audio },
      request_links: Object.assign({ ebook: null, audio: null }, data.request_links || {}),
      notes: Array.isArray(data.notes) ? data.notes : []
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
          if (statusOf(err) === 404) showNotFound(); else showError();
        });
      }
    });
  }

  // ---- Boot ----

  if (window.WSKavita && typeof window.WSKavita.init === 'function') window.WSKavita.init();

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
