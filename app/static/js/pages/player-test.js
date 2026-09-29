/**
 * WebServarr — the audiobook player's test launcher (page module)
 *
 * Every book in the audiobook library (GET /api/player/books), each with a
 * Play button that opens it in the player (WS.player, js/player/engine.js),
 * where the listener left off. For admins testing the player: the server
 * serves this page to admins only, while the player is on, and nothing in
 * the navigation links to it (app/main.py /player-test). Audiobook player
 * spec section 5.3; plan Task 10.
 *
 * A soft-navigation page (spec 4.2): everything runs from mount(ctx), and
 * every listener and fetch ends with ctx.signal. The player itself is
 * document-lifetime and keeps playing after the page is left; the page only
 * watches it (to label the playing book's button) for as long as the visit
 * lasts.
 */

const SHAPES = { single: 'Single file', parts: 'Multi-part' };

// The player's error bodies are fixed server messages (app/routers/player.py),
// but the page words its own: a 404 here means the player was switched off.
const PROBLEMS = {
  403: 'Your account can’t play the audiobook library. The player needs a Plex account with access to it.',
  404: 'The audiobook player is off. Choose an audiobook library in Settings to turn it on.',
  503: 'Plex isn’t answering right now. Try again in a moment.'
};

function isAbort(e) { return !!e && e.name === 'AbortError'; }

/* "17 h 5 min", "45 min", "1 min" */
function duration(ms) {
  const mins = Math.max(1, Math.round((Number(ms) || 0) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return m + ' min';
  return m ? h + ' h ' + m + ' min' : h + ' h';
}

function byline(book) {
  const parts = [];
  if (book.author) parts.push(escapeHtml(book.author));
  if (book.narrator) parts.push('Read by ' + escapeHtml(book.narrator));
  return parts.join(' · ') || '&nbsp;';
}

// The skeleton rows in #ptBooks copy this row's geometry (player-test.html).
// The button keeps one width whatever it says (Play, Pause, Opening…), so the
// rows' titles line up; on a phone it is the icon alone (its aria-label names
// the book), which leaves the title the room.
function bookRow(book) {
  const key = escapeHtml(String(book.key || ''));
  const title = escapeHtml(book.title || 'Untitled');
  const cover = book.cover
    ? '<img src="' + escapeHtml(book.cover) + '" alt="" loading="lazy" decoding="async" data-pt-cover ' +
        'class="absolute inset-0 size-full object-contain">'
    : '';
  const meta = [duration(book.duration_ms), SHAPES[book.shape] || ''].filter(Boolean).join(' · ');
  return '<li class="glass-card rounded-xl p-3 flex items-center gap-3 min-w-0" data-pt-book="' + key + '">' +
    '<span class="relative size-14 sm:size-16 shrink-0 rounded-lg overflow-hidden bg-background-dark/60 flex items-center justify-center">' +
      '<span class="material-symbols-outlined text-steel-blue" aria-hidden="true" data-pt-fallback' +
        (cover ? ' hidden' : '') + '>headphones</span>' + cover +
    '</span>' +
    '<span class="flex-1 min-w-0">' +
      '<span class="block font-semibold text-frosted-blue truncate" data-pt-title title="' + title + '">' + title + '</span>' +
      '<span class="block text-xs text-frosted-blue/70 truncate mt-0.5">' + byline(book) + '</span>' +
      '<span class="block text-xs text-steel-blue truncate mt-0.5">' + escapeHtml(meta) + '</span>' +
    '</span>' +
    '<button type="button" data-pt-play="' + key + '" aria-label="Play ' + title + '" ' +
      'class="shrink-0 inline-flex items-center justify-center gap-1 size-11 sm:size-auto sm:min-w-[6.5rem] sm:px-3 sm:py-2 rounded-[10px] bg-primary text-bright text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">' +
      '<span class="material-symbols-outlined text-xl sm:text-base" aria-hidden="true" data-pt-icon>play_arrow</span>' +
      '<span class="hidden sm:inline" data-pt-label>Play</span>' +
    '</button>' +
  '</li>';
}

function message(text, retry) {
  return '<li class="text-center text-steel-blue py-12">' +
    '<span class="material-symbols-outlined text-4xl mb-2 block opacity-50" aria-hidden="true">headphones</span>' +
    '<p>' + escapeHtml(text) + '</p>' +
    (retry
      ? '<button type="button" data-pt-retry class="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/15 text-frosted-blue border border-primary/30 text-sm font-bold hover:bg-primary/25 transition-all">' +
          '<span class="material-symbols-outlined text-base" aria-hidden="true">refresh</span>Try again</button>'
      : '') +
  '</li>';
}

class HttpError extends Error {
  constructor(status) { super('HTTP ' + status); this.status = status; }
}

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;
  const list = root.querySelector('#ptBooks');

  // ---- The player: which book is loaded, and is it playing ----

  let unwatch = null;
  let shown = { book: null, playing: false, loading: false };

  function player() { return (window.WS && window.WS.player) || null; }

  function label(btn, playing, loading) {
    const title = btn.closest('[data-pt-book]').querySelector('[data-pt-title]').textContent;
    btn.querySelector('[data-pt-icon]').textContent = playing ? 'pause' : 'play_arrow';
    btn.querySelector('[data-pt-label]').textContent = loading ? 'Opening…' : playing ? 'Pause' : 'Play';
    btn.setAttribute('aria-label', (playing ? 'Pause ' : 'Play ') + title);
    btn.disabled = !!loading;
  }

  // Brings the buttons in step with the player: only the loaded book's
  // button says Pause (or Opening…); every other one says Play.
  function sync() {
    if (signal.aborted) return;
    const p = player();
    const st = p ? p.state() : null;
    const now = {
      book: st && st.book ? String(st.book) : null,
      playing: !!(st && st.playing),
      loading: !!(st && st.loading)
    };
    if (now.book === shown.book && now.playing === shown.playing && now.loading === shown.loading) return;
    shown = now;
    root.querySelectorAll('[data-pt-play]').forEach(function (btn) {
      const mine = btn.getAttribute('data-pt-play') === now.book;
      label(btn, mine && now.playing, mine && now.loading);
    });
  }

  // Watches the player for as long as the visit lasts. The player may not be
  // there yet on a cold load (its module runs after this one can): the first
  // Play press watches it then.
  function watch() {
    const p = player();
    if (unwatch || !p || signal.aborted) return;
    unwatch = p.on('change', sync);
    const done = new AbortController();
    signal.addEventListener('abort', function () {
      unwatch();
      done.abort();
    }, { once: true, signal: done.signal });
  }

  function play(key) {
    const p = player();
    if (!p) {
      WSUI.toast('The player isn’t ready yet. Try again in a moment.', 'err');
      return;
    }
    watch();
    const st = p.state();
    if (st && String(st.book) === key && !st.error) {
      p.toggle();
      return;
    }
    // Where the listener left off. A failure is the player's to show (its
    // notices); open() rejects only when the saved place is not in the book.
    p.open(key, { autoplay: true }).catch(function (e) {
      if (signal.aborted) return;
      console.warn('The player could not open ' + key, e);
    });
    sync();
  }

  // ---- The list ----

  function fetcher() {
    return fetch('/api/player/books', { signal: signal }).then(function (r) {
      if (r.status === 401) { WS.leaveTo('/login'); throw new HttpError(401); }
      if (!r.ok) throw new HttpError(r.status);
      return r.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.books)) throw new Error('Unexpected response');
      return data.books;
    });
  }

  function render(books) {
    if (signal.aborted) return;
    WS.arrive('books', function () {
      WS.setHTML(list, books.length
        ? books.map(bookRow).join('')
        : message('The audiobook library has no books yet.', false));
      shown = { book: null, playing: false, loading: false };
      sync();
    });
  }

  function failed(err) {
    if (signal.aborted || isAbort(err) || (err && err.status === 401)) return;
    const status = err && err.status;
    WS.arrive('books', function () {
      WS.setHTML(list, message(PROBLEMS[status] || 'The audiobooks couldn’t be loaded. Try again in a moment.',
                               status !== 403 && status !== 404));
    });
  }

  async function load(fresh) {
    try {
      await WS.swr('player:books', fetcher, render, { maxAge: fresh ? 0 : undefined, onError: failed });
    } catch (e) {
      failed(e);
    }
  }

  root.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const btn = t.closest('[data-pt-play]');
    if (btn) { play(btn.getAttribute('data-pt-play')); return; }
    if (t.closest('[data-pt-retry]')) load(true);
  }, { signal: signal });

  // A cover that fails to load gives way to the headphones icon. error does
  // not bubble: heard on the way down.
  root.addEventListener('error', function (e) {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.hasAttribute('data-pt-cover')) return;
    const fallback = img.parentElement && img.parentElement.querySelector('[data-pt-fallback]');
    img.remove();
    if (fallback) fallback.hidden = false;
  }, { capture: true, signal: signal });

  watch();
  await load(false);
}
