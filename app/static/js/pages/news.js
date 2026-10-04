/**
 * WebServarr — News archive (page module)
 *
 * The counterpart to the homepage feed. The homepage deliberately shows only a
 * handful of recent posts and retires anything past the configured age window;
 * this page is where those posts keep living. No age filter, no cap — just
 * pagination, so the list can grow indefinitely without the homepage doing so.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. Admins' post editor is news-editor.js (a page helper script,
 * data-ws-page-script), started from mount with the same ctx.
 */

const PAGE_SIZE = 20;
const FRESH_MS = 72 * 60 * 60 * 1000; // matches the homepage's "New" threshold

function isAbort(e) { return !!e && e.name === 'AbortError'; }

function excerpt(html, limit) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text;
}

// The site's one relative date (auth.js) for the last week, then the date.
function dateLabel(date) {
  if (Date.now() - date.getTime() < 604800000) return getTimeAgo(date, true);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// One state, one signal: a pinned, new or draft post says so in words at the
// head of its quiet line (no chip, stripe or per-state icon on top). The
// Books list row's surface and type: a 16px-radius card, the title, one
// quiet line, then the excerpt. The skeleton cards in #newsArchive copy
// this card's geometry. Archive cards start collapsed regardless of age:
// this is a list to scan, not a feed to read straight through.
function renderCard(post, isAdmin) {
  const created = new Date(post.created_at);
  const isFresh = (Date.now() - created.getTime()) < FRESH_MS;
  const FLAG = 'inline-flex items-center gap-1 font-semibold text-frosted-blue';

  let flag = '';
  if (post.pinned) {
    flag = '<span class="' + FLAG + '"><span class="material-symbols-outlined text-base" aria-hidden="true">push_pin</span>Pinned</span>';
  } else if (isFresh) {
    flag = '<span class="' + FLAG + '">New</span>';
  }
  if (!post.published) {
    flag = '<span class="' + FLAG + '">Draft</span>' + flag;
  }
  const id = escapeHtml(String(post.id));
  const TOOL = 'inline-flex items-center gap-1 h-8 px-2 rounded-btn text-label font-semibold text-frosted-blue/70 hover:text-frosted-blue hover:bg-frosted-blue/[0.07]';

  const bodyClasses = 'text-body text-frosted-blue/80 mt-2 prose prose-invert max-w-[70ch] [&>div]:mb-2 [&>p]:mb-2 [&_br]:block';

  // min-w-0: grid items default to min-width:auto and will otherwise
  // overflow the page on mobile. The min-h on the title (phone) and the
  // excerpt keep a short post the height of its skeleton card; Read more
  // drops the title's (see below).
  return '<article class="rounded-2xl bg-frosted-blue/[0.04] p-4 sm:p-5 min-w-0">' +
    '<h2 data-news-title class="text-lead sm:text-h3 leading-snug font-bold text-frosted-blue break-words min-w-0 min-h-12 sm:min-h-0">' + escapeHtml(post.title) + '</h2>' +
    '<p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-label leading-5 text-frosted-blue/70">' +
      flag +
      '<span>' + escapeHtml(dateLabel(created)) + '</span>' +
      '<span>By ' + escapeHtml(post.author_name || 'the admin') + '</span>' +
    '</p>' +
    '<p class="text-body text-frosted-blue/70 mt-1 line-clamp-2 min-h-12 max-w-[70ch]">' + escapeHtml(excerpt(post.content_html, 180)) + '</p>' +
    '<div class="' + bodyClasses + ' hidden" data-news-body style="white-space:pre-line">' + post.content_html + '</div>' +
    (isAdmin
      ? '<div class="mt-2 -ml-2 flex flex-wrap gap-1">' +
          '<button type="button" data-news-action="edit" data-id="' + id + '" class="' + TOOL + '"><span class="material-symbols-outlined text-base" aria-hidden="true">edit</span>Edit</button>' +
          '<button type="button" data-news-action="pin" data-id="' + id + '" data-pinned="' + (post.pinned ? '1' : '0') + '" class="' + TOOL + '"><span class="material-symbols-outlined text-base" aria-hidden="true">push_pin</span>' + (post.pinned ? 'Unpin' : 'Pin') + '</button>' +
          '<button type="button" data-news-action="delete" data-id="' + id + '" data-title="' + escapeHtml(post.title) + '" class="' + TOOL + '"><span class="material-symbols-outlined text-base" aria-hidden="true">delete</span>Delete</button>' +
        '</div>'
      : '') +
    '<button type="button" data-news-toggle class="mt-2 flex items-center gap-1 h-6 text-label font-semibold text-frosted-blue/70 hover:text-frosted-blue transition-colors">' +
      '<span data-news-toggle-text>Read more</span>' +
      '<span class="material-symbols-outlined text-base transition-transform" data-news-chevron aria-hidden="true">expand_more</span>' +
    '</button>' +
  '</article>';
}

// Empty and failed lists say what is going on in a line, as Books does.
function emptyState() {
  return '<div class="py-10 max-w-xl">' +
    '<p class="text-lead font-semibold text-frosted-blue">No news yet</p>' +
    '<p class="mt-1 text-body text-frosted-blue/70">Posts from the people who run this server show up here.</p>' +
  '</div>';
}

function errorState() {
  return '<div class="py-10 max-w-xl">' +
    '<p class="text-lead font-semibold text-frosted-blue">News can’t be shown right now</p>' +
    '<p class="mt-1 text-body text-frosted-blue/70">Try again in a minute.</p>' +
  '</div>';
}

export async function mount(ctx) {
  var root = ctx.root;
  var signal = ctx.signal;

  // This visit's state: every mount starts its own.
  var _offset = 0;
  var _loading = false;
  var _reloadAfter = false;
  // Bumped by every reload(). A page started before the latest reload (a
  // "Load older posts" still in flight when a write landed) is dropped when
  // it answers, so it can never paint the pre-write list.
  var _gen = 0;
  // Bumped by every Edit and New post click. Edit fetches the post before the
  // editor opens, so an older click whose answer lands late is ignored: the
  // panel shown is always the one asked for last.
  var _editClick = 0;
  // Admins see drafts too, and manage every post in place. The server decides
  // who gets drafts (published_only=false is ignored for anyone else); this
  // only chooses what to ask for and whether to draw the tools.
  var isAdmin = !!(ctx.data && ctx.data.user && ctx.data.user.is_admin);

  var listEl = root.querySelector('#newsArchive');
  var moreBtn = root.querySelector('#newsLoadMore');
  var moreText = root.querySelector('#newsLoadMoreText');

  if (isAdmin && window.NewsEditor) NewsEditor.init(ctx);

  // fresh: skip the cached copy and paint the server's answer (after a write).
  async function loadPage(fresh) {
    if (signal.aborted) return;
    if (_loading) {
      if (fresh === true) _reloadAfter = true;   // a write landed mid-load: reload once it ends
      return;
    }
    _loading = true;
    fresh = fresh === true;
    moreText.textContent = 'Loading…';

    var offset = _offset;
    var gen = _gen;
    // Fetch one past the page size: if it comes back, there is another page.
    // Cheaper than a separate count query and never goes stale against it.
    var url = '/api/news/?limit=' + (PAGE_SIZE + 1) + '&offset=' + offset + (isAdmin ? '&published_only=false' : '');
    var key = isAdmin ? 'news:archive:admin' : 'news:archive';

    function fetcher() {
      return WS.getJSON(url, { signal: signal }).then(function (posts) {
        if (!Array.isArray(posts)) throw new Error('Unexpected response');
        return posts;
      });
    }

    function render(posts) {
      if (gen !== _gen) return;
      if (signal.aborted) return;   // left: the next page owns the arrival order now
      var hasMore = posts.length > PAGE_SIZE;
      var page = posts.slice(0, PAGE_SIZE);
      var html = page.map(function (post) { return renderCard(post, isAdmin); }).join('');

      if (offset === 0) {
        WS.arrive('posts', function () {
          WS.setHTML(listEl, page.length ? html : emptyState());
        });
        _offset = page.length;
      } else {
        listEl.insertAdjacentHTML('beforeend', html);
        _offset = offset + page.length;
      }

      moreBtn.classList.toggle('hidden', !hasMore);
      moreBtn.classList.toggle('flex', hasMore);
      moreText.textContent = 'Load older posts';
    }

    try {
      if (offset === 0) {
        // The first page paints from the last visit at once, then refreshes.
        var got = await WS.swr(key, fetcher, render, fresh ? { maxAge: 0 } : undefined);
        if (got === null) throw new Error('Request failed');
      } else {
        render(await fetcher());
      }
    } catch (err) {
      if (gen !== _gen) return;
      if (signal.aborted || isAbort(err)) return;   // left the page: not an error
      console.error('Error loading news archive:', err);
      if (offset === 0) {
        WS.arrive('posts', function () { WS.setHTML(listEl, errorState()); });
      }
      moreText.textContent = 'Try again';
    } finally {
      _loading = false;
      if (_reloadAfter && !signal.aborted) { _reloadAfter = false; reload(); }
    }
  }

  // ---- Admin: manage posts in place ----

  // Back to the first page, fetched fresh (never the cached copy).
  function reload() {
    _gen += 1;
    _offset = 0;
    loadPage(true);
  }

  // After every successful write: prefetched copies of / and /news, and this
  // user's cached news lists, all predate it.
  function newsChanged() {
    if (signal.aborted) return;
    WS.clearPageCache();
    WS.dropCache('news:');
    reload();
  }

  function write(btn, url, init, okText, errText) {
    btn.disabled = true;
    fetch(url, Object.assign({}, init, { signal: signal })).then(function (r) {
      if (r.status === 401) { WS.leaveTo('/login'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      WSUI.toast(okText, 'ok');
      newsChanged();
    }).catch(function (e) {
      if (isAbort(e)) return;
      WSUI.toast(errText, 'err');
    }).then(function () { btn.disabled = false; });
  }

  function toggleCard(btn) {
    var card = btn.parentElement;
    var full = card.querySelector('[data-news-body]');
    var teaser = card.querySelector('.line-clamp-2');
    if (!full) return;
    var nowOpen = full.classList.toggle('hidden') === false;
    if (teaser) teaser.classList.toggle('hidden', nowOpen);
    // The title's two-line room on a phone is for the collapsed card only.
    var title = card.querySelector('[data-news-title]');
    if (title) title.classList.toggle('min-h-12', !nowOpen);
    btn.querySelector('[data-news-toggle-text]').textContent = nowOpen ? 'Show less' : 'Read more';
    btn.querySelector('[data-news-chevron]').style.transform = nowOpen ? 'rotate(180deg)' : '';
  }

  // One delegated listener for the page, so it keeps working for cards
  // appended by "Load older posts" and for every re-render.
  root.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var toggle = t.closest('[data-news-toggle]');
    if (toggle) { toggleCard(toggle); return; }

    if (t.closest('#newsLoadMore')) { loadPage(); return; }

    if (!isAdmin) return;
    if (t.closest('#newsNewPost')) {
      _editClick += 1;
      NewsEditor.open(null, newsChanged);
      return;
    }

    var btn = t.closest('[data-news-action]');
    if (!btn) return;
    var id = parseInt(btn.getAttribute('data-id'), 10);
    var action = btn.getAttribute('data-news-action');
    if (action === 'edit') {
      // Opens (or reports a failure) only if this is still the latest Edit
      // click and nothing opened or dismissed the editor meanwhile.
      var ticket = ++_editClick, seen = NewsEditor.generation();
      WS.getJSON('/api/news/' + id, { signal: signal }).then(function (post) {
        if (ticket === _editClick && seen === NewsEditor.generation()) NewsEditor.open(post, newsChanged);
      }).catch(function (e) {
        if (isAbort(e)) return;
        if (ticket === _editClick && seen === NewsEditor.generation()) WSUI.toast('That post couldn’t be opened. Try again.', 'err');
      });
    } else if (action === 'pin') {
      var pinned = btn.getAttribute('data-pinned') === '1';
      write(btn, '/api/news/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                                     body: JSON.stringify({ pinned: !pinned }) },
            pinned ? 'Unpinned.' : 'Pinned to the top.', 'That didn’t work. Try again.');
    } else if (action === 'delete') {
      WSUI.confirm({ title: 'Delete this post?', body: '“' + btn.getAttribute('data-title') + '” will be gone for everyone. This can’t be undone.',
                     confirmLabel: 'Delete post', cancelLabel: 'Keep it', danger: true }).then(function (ok) {
        if (!ok || signal.aborted) return;
        write(btn, '/api/news/' + id, { method: 'DELETE' }, 'Post deleted.', 'The post wasn’t deleted. Try again.');
      });
    }
  }, { signal: signal });

  // The first page is on screen (the last visit's copy, or fetched) before
  // mount resolves, so Back and Forward restore the scroll onto it.
  await loadPage();
}
