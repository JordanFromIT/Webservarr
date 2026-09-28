/**
 * WebServarr — eBook reader (page module)
 *
 * One book from Kavita, a page at a time: edge and key page turns, the
 * contents, a page jump, bookmarks, reading settings and the reader's guide.
 * The reading position lives in Kavita: saved a few seconds after each turn,
 * and once more when the reader is left.
 *
 * A full-screen view inside the site's one document: the server marks the
 * page <html data-shell="hidden"> (the sidebar, header and phone bar hidden,
 * #wsPlayer left on screen), and the router brings that in step on every
 * swap, so an audiobook keeps playing while a book is open.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal (the key, visibility and pagehide listeners included). Leaving
 * the reader by a soft navigation aborts that signal, and with it any
 * progress write still in flight, before the page's cleanup runs; so the
 * cleanup this mount returns makes the last save as its own request, a
 * beacon, which nothing aborts and which outlives the page. The reading
 * settings are set on #wsPage, so they go with the page.
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
const PANELS = ['loading', 'errorState', 'bookContent'];

/* ---- Reader guide (coach marks) ----
 *
 * Same engine as the library tour, in /static/js/tour.js. Started from the boot
 * chain rather than on a timer, because half these steps point at controls
 * that do not settle until the first page is on screen. openSettings and
 * closeSettings are the visit's (steps() below).
 */
function guideSteps(openSettings, closeSettings) {
  return [
    {
      target: '#navNext',
      fallback: '#bookContent',
      icon: 'auto_stories',
      title: 'Turning pages',
      body: 'Click either edge of the page to move forward or back, or use the arrow keys. Your place saves itself as you go, so you can close the tab and pick up here on any device.'
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
    {
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
      body: 'Text size, line spacing, how wide the lines run, and two columns if you prefer. The five swatches change the page colour, from black through to paper white. Your choices carry to every book you open.',
      before: openSettings
    },
    {
      target: '#readerBack',
      icon: 'arrow_back',
      title: 'When you are done',
      body: 'The arrow at the top left goes back to the library. Nothing needs saving first, and the book reappears under Your Bookshelf.',
      before: closeSettings
    }
  ];
}

export async function mount(ctx) {
  var root = ctx.root;
  var signal = ctx.signal;

  function el(id) { return root.querySelector('#' + id); }

  // This visit's state: every mount starts its own.
  var book = { seriesId: null, chapterId: null, volumeId: null, libraryId: null, pages: 0, title: '' };
  var current = { page: 0 };
  var saveTimer = 0;
  var lastSaved = -1;
  // The page Kavita is known to hold for this reader: the one it reported,
  // or the last write it accepted. The save on leave compares against this,
  // not lastSaved: a write still in flight when the page is left is aborted
  // with the visit, so it may never have landed.
  var confirmedPage = -1;
  // Whether current.page is a position we may write back to Kavita. False
  // until Kavita told us where this reader is (get-progress answered) or they
  // turned a page themselves. Otherwise a failed lookup, which opens the book
  // at the start, would overwrite their real place when they leave the page.
  var positionKnown = false;
  var guide = null;

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
    options.signal = signal;
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
    el('columns').checked = !!prefs.columns;
    el('fsVal').textContent = prefs.fontSize + 'px';
    el('lhVal').textContent = (prefs.lineHeight / 10).toFixed(1);
    el('mwVal').textContent = prefs.measure + 'rem';

    Array.prototype.forEach.call(el('themeButtons').children, function (b) {
      b.classList.toggle('bg-baltic-blue/40', b.dataset.theme === prefs.theme);
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
    return book.chapterId != null && activePanel === 'bookContent';
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
    return kavita('/api/Book/' + book.chapterId + '/chapters', null, true)
      .then(function (r) { return r.ok ? r.json() : []; })
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

    showPanel('loading');
    el('loadingText').textContent = 'Loading page ' + (page + 1) + '…';

    return kavita('/api/Book/' + book.chapterId + '/book-page?page=' + page)
      .then(function (r) {
        if (!r.ok) throw new Error('page HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) {
        if (signal.aborted) return;
        renderPage(html);
        if (!skipSave) {
          // The reader chose this page: from here it is theirs to save.
          positionKnown = true;
          queueProgress();
        }
      })
      .catch(function (err) {
        if (quiet(err)) return;
        // The arrows are off under an error, so Try again reloads this page
        // (with the same skipSave: a retry never confirms an unknown position).
        showError('Couldn’t load this page', String(err.message || err), function () {
          loadPage(page, skipSave);
        });
      });
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
    clearTimeout(saveTimer);
    saveTimer = ctx.setTimeout(saveProgress, SAVE_DEBOUNCE_MS);
  }

  /**
   * Write the reading position to Kavita. useBeacon: the last write, as the
   * reader is left (a soft navigation away, the tab hidden or closed). It is
   * a beacon: its own request, which neither the visit's aborted signal nor
   * the page unloading stops. It goes whenever Kavita is not known to hold
   * this page already, even if an ordinary write of it is in flight (leaving
   * aborts that one).
   */
  function saveProgress(useBeacon) {
    var held = useBeacon ? confirmedPage : lastSaved;
    if (!positionKnown || current.page === held) return;
    var payload = {
      libraryId: book.libraryId,
      seriesId: book.seriesId,
      volumeId: book.volumeId,
      chapterId: book.chapterId,
      pageNum: current.page
    };
    var body = JSON.stringify(payload);
    var page = current.page;
    lastSaved = page;

    if (useBeacon && navigator.sendBeacon) {
      // Fire-and-forget; same-origin so the session cookie rides along.
      if (navigator.sendBeacon('/kavita/api/Reader/progress',
        new Blob([body], { type: 'application/json' }))) confirmedPage = page;
      return;
    }
    if (signal.aborted) return;
    // A failed progress write must never interrupt reading: it is a
    // background call, and lastSaved = -1 makes the next save try again.
    kavita('/api/Reader/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }, true).then(function (r) {
      if (r.ok) confirmedPage = page;
      else lastSaved = -1;
    }).catch(function () { lastSaved = -1; });
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
        return (p && typeof p.pageNum === 'number') ? p.pageNum : 0;
      });
  }

  function restoreProgress() {
    // One quiet retry before giving up: a lost lookup would otherwise leave
    // the book at the start with saving switched off.
    return fetchProgress()
      .catch(function (err) { if (quiet(err)) throw err; return fetchProgress(); })
      .then(function (page) {
        positionKnown = true;
        lastSaved = page;
        confirmedPage = page;
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

  function openSettings() { el('settingsPanel').classList.remove('hidden'); }
  function closeSettings() { el('settingsPanel').classList.add('hidden'); }

  el('tocBtn').addEventListener('click', function () { toggleTOC(); }, { signal: signal });
  el('errorRetry').addEventListener('click', runRetry, { signal: signal });
  el('settingsBtn').addEventListener('click', function () {
    el('settingsPanel').classList.toggle('hidden');
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
  bindPref('columns', 'columns', function (t) { return t.checked; });

  Array.prototype.forEach.call(el('themeButtons').children, function (b) {
    b.addEventListener('click', function () {
      prefs.theme = b.dataset.theme; applyPrefs(); savePrefs();
    }, { signal: signal });
  });

  // Final write when the tab is hidden or closed, so that never loses the
  // position. Leaving by a soft navigation is the cleanup's (below).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveProgress(true);
  }, { signal: signal });
  window.addEventListener('pagehide', function () { saveProgress(true); }, { signal: signal });

  // ---- Boot ----

  loadPrefs();
  applyPrefs();

  if (window.WebServarrTour) {
    guide = window.WebServarrTour.init({
      seenKey: 'webservarr_reader_guide_seen',
      steps: guideSteps(openSettings, closeSettings),
      helpBtn: el('helpBtn'),
      // Started from the boot chain instead, once a page has rendered.
      autoStart: false,
      // Leaving the settings panel hanging open after a skipped tour would look
      // like a bug.
      onFinish: closeSettings,
      signal: signal
    });
  }

  // Leaving the reader: the last position goes to Kavita. The router runs
  // this after the visit's signal has aborted (and with it any ordinary
  // write in flight), so it is a beacon, the page's own request.
  var leave = function () { saveProgress(true); };

  var seriesId = ctx.url.searchParams.get('seriesId');
  if (!seriesId) {
    showError('No book selected', 'Open a book from the library.');
    return leave;
  }
  book.seriesId = parseInt(seriesId, 10);

  checkAuth().then(function () {
    return resolveChapter(book.seriesId);
  }).then(function (res) {
    book.chapterId = res.chapterId;
    book.volumeId = res.volumeId;
    return kavita('/api/Book/' + book.chapterId + '/book-info');
  }).then(function (r) {
    if (!r.ok) throw new Error('book-info HTTP ' + r.status);
    return r.json();
  }).then(function (info) {
    if (signal.aborted) throw new Error('reconnecting');
    book.pages = info.pages || 0;
    book.libraryId = info.libraryId;
    book.volumeId = info.volumeId || book.volumeId;
    book.title = info.bookTitle || info.seriesName || 'Reader';
    el('bookTitle').textContent = book.title;
    ctx.setTitle(book.title);
    loadTOC();
    return restoreProgress();
  }).then(function (page) {
    return loadPage(page, true);
  }).then(function () {
    // Only once there is a rendered page to point at. Starting earlier
    // spotlights an empty loading spinner.
    if (!signal.aborted && guide) guide.maybeStart();
  }).catch(function (err) {
    if (quiet(err)) return;
    showError('Couldn’t open this book', String(err.message || err));
  });

  return leave;
}
