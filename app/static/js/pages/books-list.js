/**
 * WebServarr, an author, a narrator or a series (page module)
 *
 * Two pages, one module (the page says which in data-kind):
 *   /books/person?role=author|narrator&name=...   that person's books, as cards
 *   /books/series?name=...                        a series in reading order, one
 *                                                 row per book with the person's
 *                                                 place in each format
 *
 * A name travels in the query string, never in the path, so a "/", a comma, a
 * quote or any Unicode in it comes back exactly as it went. Everything comes
 * from GET /api/books/person and /api/books/series: the server decides what
 * this person may see and sorts the series (by number, books without one
 * last); the page draws what it is given, in that order.
 *
 * Drawn in one write over a skeleton with the same shape: the heading stays
 * and everything after it is a new element, so nothing already on screen moves.
 *
 * The card helpers come from books.js, loaded by the address the server wrote
 * (and stamped with that file's content hash) in #wsPage's data-ws-dep: so a
 * cached old books.js is never paired with a new page. No import statement.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. Markup is built with textContent only.
 */
const KEEP_MS = 2 * 60 * 1000;      // a kept copy older than this is not painted: places move
const MOUNT_WAIT_MS = 1500;         // the page is on screen (or its skeleton) before mount resolves
const NAME_MAX = 200;               // the API's own limit on a name

const LINK_FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frosted-blue';
// Class strings are written out whole: Tailwind only builds what it can read.
const GRID = 'mt-6 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-4 gap-y-6';
const ROW = 'group grid grid-cols-[1.5rem_3.75rem_minmax(0,1fr)] items-center gap-3 rounded-2xl bg-frosted-blue/[0.04] p-2.5 transition-colors hover:bg-frosted-blue/[0.07] sm:grid-cols-[2rem_4.5rem_minmax(0,1fr)] sm:gap-4 sm:p-3 ' + LINK_FOCUS;
const FORMAT_INFO = {
  ebook: { icon: 'menu_book', label: 'Ebook' },
  audio: { icon: 'headphones', label: 'Audiobook' }
};

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

/** The HTTP status of a failed WS.getJSON (it carries it only in its message). */
function statusOf(err) {
  if (err && typeof err.status === 'number') return err.status;
  const m = /HTTP (\d{3})/.exec(err && err.message || '');
  return m ? parseInt(m[1], 10) : 0;
}

function numberText(n) {
  return typeof n === 'number' && isFinite(n) ? String(n) : '';
}

function count(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

/** A name that can be asked for: something to look up, and not longer than the API takes. */
function usable(name) {
  return typeof name === 'string' && name.trim() !== '' && Array.from(name).length <= NAME_MAX;
}

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;
  const $ = function (id) { return root.querySelector('#' + id); };
  const { renderBookCard, coverBox, noteLine } = await import(root.getAttribute('data-ws-dep') || './books.js');

  const kind = root.getAttribute('data-kind') === 'series' ? 'series' : 'person';
  const params = ctx.url.searchParams;
  const role = params.get('role');
  const name = params.get('name');
  // What to ask for, or null when the address is not a page.
  const target = (function () {
    if (!usable(name)) return null;
    if (kind === 'series') return { url: '/api/books/series?name=' + encodeURIComponent(name), key: 'books:series:' + name };
    if (role !== 'author' && role !== 'narrator') return null;
    return { url: '/api/books/person?role=' + role + '&name=' + encodeURIComponent(name), key: 'books:person:' + role + ':' + name };
  })();
  const state = { gen: 0, reconnectTried: false, connectProblem: false };

  const skeleton = {
    title: Array.prototype.slice.call($('listTitle').childNodes).map(function (n) { return n.cloneNode(true); }),
    rest: $('listRest').cloneNode(true)
  };

  function quiet(err) { return signal.aborted || isAbort(err); }

  // ---- The Kavita hand-off ----

  function needsConnect(data) {
    return data.notes.some(function (n) { return n && n.source === 'kavita' && n.reason === 'not_connected'; });
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
    // After the page is drawn (a helper that answers late): the line goes in last.
    const rest = $('listRest');
    if (rest && !rest.querySelector('[data-connect]') && rest.getAttribute('data-ready') === 'true') rest.appendChild(connectLine());
  }

  function retryConnect() {
    const helper = window.WSKavita;
    if (!helper || typeof helper.retry !== 'function') { window.location.reload(); return; }
    helper.retry();
  }

  function connectLine() {
    const box = el('div', 'mt-3 flex flex-wrap items-center gap-x-4 gap-y-2');
    box.setAttribute('data-connect', '');
    box.appendChild(noteLine('We couldn’t connect you to the eBook library right now.'));
    const b = el('button', 'ws-lift h-10 rounded-[10px] bg-frosted-blue/[0.07] px-4 text-[15px] font-semibold text-frosted-blue ' + LINK_FOCUS, 'Try again');
    b.type = 'button';
    b.addEventListener('click', retryConnect, { signal: signal });
    box.appendChild(b);
    return box;
  }

  // ---- Drawing ----

  function formatChip(format, progress) {
    const info = FORMAT_INFO[format];
    const chip = el('span', 'inline-flex items-center gap-1 text-[13px] leading-5 text-frosted-blue/70');
    chip.setAttribute('data-format', format);
    chip.appendChild(icon(info.icon, 'text-[16px]'));
    if (progress && progress.label) {
      // Heard as "Ebook, Ch. 2 · 43%".
      chip.appendChild(el('span', 'sr-only', info.label + ', '));
      chip.appendChild(el('span', '', progress.label));
    } else {
      chip.appendChild(el('span', '', info.label));
    }
    return chip;
  }

  /** One book of the series: its number, its cover, and the person's place in each format. */
  function seriesRow(item) {
    const a = el('a', ROW);
    a.href = '/books/' + encodeURIComponent(String(item.id));
    const number = el('span', 'text-center text-[17px] font-bold leading-none tabular-nums text-frosted-blue/70 sm:text-[20px]', numberText(item.series_number));
    number.setAttribute('data-number', '');
    a.appendChild(number);
    a.appendChild(coverBox(item.cover_url, item.formats, signal, { badges: false }));
    const text = el('span', 'block min-w-0');
    text.appendChild(el('span', 'block text-[15px] font-semibold leading-snug text-frosted-blue line-clamp-3 sm:text-[17px] sm:line-clamp-2', item.title || 'Untitled'));
    if (item.author) text.appendChild(el('span', 'block truncate text-[13px] leading-5 text-frosted-blue/70', item.author));
    const chips = el('span', 'mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5');
    const progress = item.progress || {};
    (item.formats || []).forEach(function (f) {
      if (FORMAT_INFO[f]) chips.appendChild(formatChip(f, progress[f === 'audio' ? 'audio' : 'ebook']));
    });
    text.appendChild(chips);
    a.appendChild(text);
    return a;
  }

  function descriptor(data) {
    const n = data.items.length;
    if (kind === 'series') return n === 1 ? '1 book' : n + ' books, in reading order';
    return data.role === 'narrator' || role === 'narrator'
      ? count(n, 'book', 'books') + ' read by this narrator'
      : count(n, 'book', 'books') + ' by this author';
  }

  function buildRest(data) {
    const rest = el('div', '');
    rest.id = 'listRest';
    rest.setAttribute('data-ready', 'true');
    rest.appendChild(el('p', 'mt-2 text-[15px] leading-6 text-frosted-blue/70', descriptor(data)));
    // A source that is down, said once and quietly; "not connected" is the hand-off's.
    const seen = {};
    data.notes.forEach(function (n) {
      if (!n || !n.text || n.reason === 'not_connected' || seen[n.text]) return;
      seen[n.text] = true;
      const line = noteLine(n.text);
      line.className += ' mt-3';
      rest.appendChild(line);
    });
    if (state.connectProblem) rest.appendChild(connectLine());
    if (kind === 'series') {
      const list = el('ol', 'mt-6 max-w-3xl space-y-3');
      list.id = 'seriesList';
      data.items.forEach(function (item) {
        const li = el('li', '');
        li.appendChild(seriesRow(item));
        list.appendChild(li);
      });
      rest.appendChild(list);
    } else {
      const grid = el('ul', GRID);
      grid.id = 'listGrid';
      data.items.forEach(function (card) {
        const li = el('li', '');
        li.appendChild(renderBookCard(card, { signal: signal }));
        grid.appendChild(li);
      });
      rest.appendChild(grid);
    }
    return rest;
  }

  function swapRest(node) {
    $('listRest').replaceWith(node);
  }

  function done(title) {
    $('listView').setAttribute('aria-busy', 'false');
    if (title && typeof ctx.setTitle === 'function') ctx.setTitle(title);
  }

  /** One write: the heading's text and everything after it as a new element. */
  function commit(data) {
    const shown = data.name || name;
    $('listTitle').textContent = shown;
    swapRest(buildRest(data));
    done(shown);
  }

  function message(state_, title, text, action) {
    const rest = el('div', 'mt-4 max-w-xl');
    rest.id = 'listRest';
    rest.setAttribute('data-state', state_);
    rest.appendChild(el('p', 'text-[17px] text-frosted-blue/70', text));
    if (action) rest.appendChild(action);
    $('listTitle').textContent = title;
    swapRest(rest);
    done('');
  }

  const WHO = { author: 'author', narrator: 'narrator' };

  function showNotFound() {
    const what = kind === 'series' ? 'series' : WHO[role] || 'page';
    const back = el('a', 'ws-lift mt-6 inline-flex h-11 items-center rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Back to Books');
    back.href = '/books';
    message('notfound', 'We couldn’t find that ' + what,
      kind === 'series' ? 'There’s no series by that name in the library, or this link is out of date.'
        : 'There’s nobody by that name in the library, or this link is out of date.', back);
  }

  function showError() {
    const retry = el('button', 'ws-lift mt-6 h-11 rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS, 'Try again');
    retry.id = 'retryBtn';
    retry.type = 'button';
    retry.addEventListener('click', function () { showSkeleton(); load(true); }, { signal: signal });
    message('error', name || 'Books', 'We couldn’t load this list. Everything else on the site is unaffected. Try again in a moment.', retry);
  }

  function showSkeleton() {
    const heading = $('listTitle');
    heading.textContent = '';
    skeleton.title.forEach(function (n) { heading.appendChild(n.cloneNode(true)); });
    swapRest(skeleton.rest.cloneNode(true));
    $('listView').setAttribute('aria-busy', 'true');
  }

  // ---- Loading ----

  function valid(data) {
    return !!data && typeof data === 'object' && Array.isArray(data.items);
  }

  function tidy(data) {
    return { name: typeof data.name === 'string' ? data.name : '', role: data.role, items: data.items, notes: Array.isArray(data.notes) ? data.notes : [] };
  }

  /** The list, from the server. Its notes decide the hand-off, so they are
      looked at on the live answer only, never on a kept copy. */
  function readLive() {
    return WS.getJSON(target.url, { signal: signal }).then(function (data) {
      if (!valid(data)) throw new Error('Unexpected response');
      if (needsConnect(tidy(data))) startConnect();
      return data;
    });
  }

  function load(fresh) {
    const gen = ++state.gen;
    return WS.swr(target.key, readLive, function (data) {
      if (signal.aborted || gen !== state.gen) return;
      WS.arrive('list', function () {
        if (signal.aborted || gen !== state.gen) return;
        commit(tidy(data));
      });
    }, {
      maxAge: fresh ? 0 : KEEP_MS,
      onError: function (err) {
        if (gen !== state.gen || quiet(err)) return;
        WS.arrive('list', function () {
          if (signal.aborted || gen !== state.gen) return;
          const status = statusOf(err);
          if (status === 404 || status === 422) showNotFound(); else showError();
        });
      }
    });
  }

  // ---- Boot ----

  if (window.WSKavita && typeof window.WSKavita.init === 'function') window.WSKavita.init();
  // A sign-in that just failed sends the person back here: no automatic attempt this visit.
  if (window.WSKavita && typeof window.WSKavita.arrivedFromFailedConnect === 'function') window.WSKavita.arrivedFromFailedConnect();

  if (!target) {
    WS.arrive('list', showNotFound);
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
