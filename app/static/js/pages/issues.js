/**
 * WebServarr — Issues (page module)
 *
 * Report a problem with a title already in the library (search, pick it, say
 * what is wrong) and follow the caller's own Seerr issues, with a detail
 * modal for each one's comments.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. One delegated click listener on ctx.root serves every control
 * (data-action), including the cards and the comment button rebuilt from
 * strings; one capturing error listener hides a poster that fails to load.
 * Every card and search result is a button, so the page works from the
 * keyboard. The detail is a dialog (WSUI.modal: focus in, Tab kept inside,
 * Escape, focus back); it lives inside #wsPage, so leaving the page takes it
 * away with the rest. The wiki pointer is wiki-hook.js (a page helper script,
 * data-ws-page-script), started from mount with the same ctx.
 */

const REFRESH_MS = 30000;
const SEARCH_DELAY_MS = 300;

function isAbort(e) { return !!e && e.name === 'AbortError'; }

// The site's one toast (ui.js): theme colours, a status light for the tone.
function showToast(message, type) {
  WSUI.toast(message, type === 'success' ? 'ok' : 'err');
}

function buildSearchResultItem(item, index) {
  // The row names its place in this search's results; the click listener
  // reads the item from there, so nothing about the title goes into markup
  // that runs. A button, so a title can be picked from the keyboard.
  var title = item.title || 'Unknown';
  var year = item.year ? String(item.year) : '';
  var mediaTypeLabel = item.media_type === 'tv' ? 'TV show' : 'Movie';
  var typeBadgeColor = item.media_type === 'tv' ? 'badge-media-tv' : 'badge-media-movie';
  var posterUrl = item.poster_url || '';

  var li = document.createElement('li');
  var row = document.createElement('button');
  row.type = 'button';
  row.className = 'w-full text-left flex items-center gap-3 p-2 rounded-inner hover:bg-frosted-blue/[0.07] transition-colors';
  row.setAttribute('data-action', 'select-media');
  row.setAttribute('data-index', String(index));
  li.appendChild(row);

  if (posterUrl) {
    // A poster that fails to load gives way to the placeholder after it
    // (the page's error listener).
    var img = document.createElement('img');
    img.src = posterUrl;
    img.alt = '';
    img.className = 'w-10 h-[60px] rounded-md object-cover shrink-0';
    img.setAttribute('data-poster', '');
    var fallback = document.createElement('div');
    fallback.className = 'w-10 h-[60px] rounded-md bg-frosted-blue/5 items-center justify-center shrink-0';
    fallback.style.display = 'none';
    fallback.setAttribute('data-poster-fallback', '');
    fallback.innerHTML = '<span class="material-symbols-outlined text-xl text-steel-blue/30">movie</span>';
    row.appendChild(img);
    row.appendChild(fallback);
  } else {
    var placeholder = document.createElement('div');
    placeholder.className = 'w-10 h-[60px] rounded-md bg-frosted-blue/5 flex items-center justify-center shrink-0';
    placeholder.innerHTML = '<span class="material-symbols-outlined text-xl text-steel-blue/30">movie</span>';
    row.appendChild(placeholder);
  }

  var info = document.createElement('div');
  info.className = 'flex-1 min-w-0';

  var titleP = document.createElement('span');
  titleP.className = 'block text-frosted-blue text-body font-semibold truncate';
  titleP.textContent = title;
  info.appendChild(titleP);

  var metaRow = document.createElement('span');
  metaRow.className = 'flex items-center gap-2 mt-0.5';
  if (year) {
    var yearSpan = document.createElement('span');
    yearSpan.className = 'text-frosted-blue/70 text-label tabular-nums';
    yearSpan.textContent = year;
    metaRow.appendChild(yearSpan);
  }
  var typeSpan = document.createElement('span');
  typeSpan.className = CHIP + ' ' + typeBadgeColor;
  typeSpan.textContent = mediaTypeLabel;
  metaRow.appendChild(typeSpan);
  info.appendChild(metaRow);

  row.appendChild(info);
  return li;
}

// ---- Badges ----

// One chip, as the Books pages draw it: sentence case, 13px, fully rounded.
// Kept for the open state alone (status colour only on deviation) and the
// detail dialog; on a card the kind is a quiet word with its icon, as Books
// writes a book's formats.
var CHIP = 'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-label font-semibold';

var ISSUE_KINDS = {
  'video':     { icon: 'videocam',   label: 'Video' },
  'audio':     { icon: 'volume_up',  label: 'Audio' },
  'subtitles': { icon: 'subtitles',  label: 'Subtitles' },
  'other':     { icon: 'more_horiz', label: 'Other' }
};

function getIssueTypeBadge(type) {
  // One neutral chip: the icon and the word say which kind of problem it
  // is, so the kinds don't need a colour each.
  var c = ISSUE_KINDS[type] || ISSUE_KINDS['other'];
  return '<span class="' + CHIP + ' bg-frosted-blue/10 text-frosted-blue">' +
    '<span class="material-symbols-outlined text-[15px]" aria-hidden="true">' + c.icon + '</span>' + c.label + '</span>';
}

/** The kind on a card: the icon and the word, quiet. */
function issueKindWord(type) {
  var c = ISSUE_KINDS[type] || ISSUE_KINDS['other'];
  return '<span class="inline-flex items-center gap-1"><span class="material-symbols-outlined text-base" aria-hidden="true">' + c.icon + '</span>' + c.label + '</span>';
}

// Status colour only on deviation: an open issue is waiting on someone, so it
// takes the warning tint and status-text words; a resolved one is quiet.
function getIssueStatusBadge(status) {
  if (status === 'open') {
    return '<span class="' + CHIP + ' bg-status-warn/10 text-status-warn-text">Open</span>';
  }
  return '<span class="' + CHIP + ' bg-frosted-blue/10 text-frosted-blue/80">Resolved</span>';
}

/** The counts, in one quiet line: what is open first, since that is the news. */
function countsLine(counts) {
  var open = counts.open || 0, closed = counts.closed || 0;
  if (!open && !closed) return 'Nothing reported yet';
  return open + ' open, ' + closed + ' resolved';
}

// The Books list row (pages/books-list.js ROW): a 16px-radius surface, the
// poster at its 2:3, the title, then one quiet line.
function buildIssueCard(issue) {
  var title = escapeHtml(issue.media_title || 'Untitled');
  var posterUrl = issue.poster_url || '';

  // A poster that fails to load gives way to the placeholder after it. The
  // title is the button's name, so the poster's alt stays empty.
  var THUMB = 'w-12 aspect-[2/3] rounded-lg shrink-0';
  var placeholder = '<span class="material-symbols-outlined text-xl text-frosted-blue/45" aria-hidden="true">movie</span>';
  var posterHtml = posterUrl
    ? '<img src="' + escapeHtml(posterUrl) + '" alt="" loading="lazy" class="' + THUMB + ' object-cover" data-poster/>' +
      '<span class="' + THUMB + ' bg-frosted-blue/[0.07] items-center justify-center" style="display:none" data-poster-fallback>' + placeholder + '</span>'
    : '<span class="' + THUMB + ' bg-frosted-blue/[0.07] flex items-center justify-center">' + placeholder + '</span>';

  var dateStr = issue.created_date ? getTimeAgo(issue.created_date, true) : '';

  // A button: the whole card opens the detail, from a click or the keyboard.
  return '<button type="button" class="w-full text-left rounded-2xl bg-frosted-blue/[0.04] hover:bg-frosted-blue/[0.07] p-3 flex gap-3 items-center transition-colors" data-action="view-issue" data-issue-id="' + escapeHtml(String(issue.id)) + '">' +
    posterHtml +
    '<span class="flex-1 min-w-0">' +
      '<span class="flex items-start justify-between gap-2">' +
        '<span class="min-w-0 text-frosted-blue text-body sm:text-lead font-semibold leading-snug line-clamp-2">' + title + '</span>' +
        (issue.status === 'open' ? '<span class="shrink-0">' + getIssueStatusBadge('open') + '</span>' : '') +
      '</span>' +
      '<span class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-label leading-5 text-frosted-blue/70">' +
        issueKindWord(issue.issue_type) +
        (issue.status === 'open' ? '' : '<span>Resolved</span>') +
        (dateStr ? '<span>' + escapeHtml(dateStr) + '</span>' : '') +
      '</span>' +
    '</span>' +
  '</button>';
}

function setCommentBtn(btn, sending) {
  btn.disabled = sending;
  btn.textContent = sending ? 'Sending...' : 'Post comment';
  btn.classList.toggle('opacity-60', sending);
}

export async function mount(ctx) {
  var root = ctx.root;
  var signal = ctx.signal;

  function $(id) { return root.querySelector('#' + id); }

  // This visit's state: every mount starts its own.
  var _currentSearchQuery = '';
  var _searchSeq = 0;          // bumped by every keystroke: only the last one searches
  var _searchResults = [];     // the rows on screen, by data-index
  var _allIssues = [];
  var _currentStatusFilter = 'all';
  var _currentTypeFilter = 'all';
  var _selectedMedia = null;
  var _selectedIssueType = null;
  // Unsent comments, by issue id, for this visit: the detail is rebuilt on
  // every open, so closing it must not throw away what was typed. Cleared
  // once the comment is posted.
  var _commentDrafts = {};
  // Comments on their way, by issue id (the text sent). A detail rebuilt for
  // that issue meanwhile (closed and reopened) waits for it instead of
  // offering a second send.
  var _commentSending = {};
  var _detailIssueId = null;
  var _dialog = null;          // the open detail (WSUI.modal), or null

  if (window.WikiHook) WikiHook.init(ctx, { container: 'wikiHookIssues', hook: 'issues', lead: 'Might this help first?' });

  // ---- Search ----

  async function performSearch(query) {
    _currentSearchQuery = query;
    var section = $('searchResultsSection');
    var emptyState = $('searchEmptyState');
    var list = $('searchResultsList');

    section.classList.remove('hidden');
    emptyState.classList.add('hidden');

    $('searchResultCount').textContent = '';
    list.innerHTML = '<li class="text-frosted-blue/70 text-body py-3 px-2">Searching&hellip;</li>';

    try {
      var resp = await fetch('/api/integrations/seerr-search?query=' + encodeURIComponent(query) + '&page=1', { signal: signal });
      if (!resp.ok) throw new Error('Search failed');
      var data = await resp.json();

      var results = (data.results || []).filter(function (item) {
        // Only show items that exist in the library (have media_info_id)
        return item.media_info_id;
      });

      $('searchResultCount').textContent = results.length === 1 ? '1 title in the library' : results.length + ' titles in the library';

      if (results.length === 0) {
        _searchResults = [];
        list.innerHTML = '<li class="py-3 px-2">' +
          '<p class="text-body text-frosted-blue">Nothing in the library matches \u201c' + escapeHtml(query) + '\u201d.</p>' +
          '<p class="text-label text-frosted-blue/70 mt-1">Only titles already in the library can be reported here.</p></li>';
        return;
      }

      // What selectMedia is handed: the same shape the rows always carried.
      _searchResults = results.map(function (item) {
        return {
          id: item.id,
          media_type: item.media_type,
          title: item.title || 'Unknown',
          year: item.year || '',
          poster_url: item.poster_url || '',
          media_info_id: item.media_info_id,
        };
      });
      list.innerHTML = '';
      _searchResults.forEach(function (item, i) {
        list.appendChild(buildSearchResultItem(item, i));
      });

    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: not an error
      console.error('Search error:', error);
      list.innerHTML = '<li class="py-3 px-2 text-body text-frosted-blue/70">' +
        'Search isn\u2019t working right now. Try again in a minute.</li>';
    }
  }

  function clearSearch() {
    _currentSearchQuery = '';
    _searchResults = [];
    $('searchResultsSection').classList.add('hidden');
    $('searchEmptyState').classList.remove('hidden');
    $('searchResultsList').innerHTML = '';
    $('searchResultCount').textContent = '';
  }

  // ---- Media Selection ----

  function selectMedia(item) {
    _selectedMedia = item;
    _selectedIssueType = null;

    // Show issue form, hide search
    $('issueFormSection').classList.remove('hidden');
    $('searchResultsSection').classList.add('hidden');
    $('searchEmptyState').classList.add('hidden');
    $('searchInput').value = '';

    // Populate selected media display
    $('selectedMediaTitle').textContent = item.title;
    $('selectedMediaYear').textContent = (item.year ? item.year + ', ' : '') + (item.media_type === 'tv' ? 'TV show' : 'Movie');
    var poster = $('selectedMediaPoster');
    if (item.poster_url) {
      poster.src = item.poster_url;
      poster.style.display = '';
    } else {
      poster.style.display = 'none';
    }

    // Reset form
    $('issueMessage').value = '';
    clearInvalid();
    root.querySelectorAll('.issue-type-btn').forEach(function (btn) {
      btn.setAttribute('aria-pressed', 'false');
    });
  }

  function deselectMedia() {
    _selectedMedia = null;
    _selectedIssueType = null;
    $('issueFormSection').classList.add('hidden');
    $('searchEmptyState').classList.remove('hidden');
    $('searchInput').value = '';
    $('searchInput').focus();
  }

  function selectIssueType(type) {
    _selectedIssueType = type;
    root.querySelectorAll('.issue-type-btn').forEach(function (btn) {
      btn.setAttribute('aria-pressed', parseInt(btn.getAttribute('data-type'), 10) === type ? 'true' : 'false');
    });
    markInvalid('issueTypeField', 'issueTypeError', false);
  }

  // ---- Validation: the field says what is missing, not a toast ----

  // Settings' pattern (.ws-invalid): the field takes the error ring, the line
  // under it says what to do, and the first one missing takes the focus.
  function markInvalid(fieldId, errorId, bad) {
    var field = $(fieldId);
    field.classList.toggle('ws-invalid', bad);
    if (field.tagName !== 'FIELDSET') field.setAttribute('aria-invalid', bad ? 'true' : 'false');
    $(errorId).classList.toggle('hidden', !bad);
  }

  function clearInvalid() {
    markInvalid('issueTypeField', 'issueTypeError', false);
    markInvalid('issueMessage', 'issueMessageError', false);
  }

  // ---- Send the report ----

  async function submitIssue() {
    if (!_selectedMedia) return;
    var message = $('issueMessage').value.trim();
    markInvalid('issueTypeField', 'issueTypeError', !_selectedIssueType);
    markInvalid('issueMessage', 'issueMessageError', !message);
    if (!_selectedIssueType) { root.querySelector('.issue-type-btn').focus(); return; }
    if (!message) { $('issueMessage').focus(); return; }

    var submitBtn = $('submitIssueBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending\u2026';

    try {
      var resp = await fetch('/api/integrations/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueType: _selectedIssueType,
          message: message,
          mediaId: _selectedMedia.media_info_id,
        }),
        signal: signal,
      });
      if (!resp.ok) {
        var err = await resp.json().catch(function () { return {}; });
        throw new Error(err.detail || 'Failed to create issue');
      }

      showToast('Report sent for ' + _selectedMedia.title, 'success');
      deselectMedia();
      ctx.setTimeout(function () { loadIssueCounts(); loadIssues(); }, 1500);

    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: nothing to say
      console.error('Submit issue error:', error);
      showToast(error.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send report';
    }
  }

  // ---- Issue Counts ----

  function loadIssueCounts() {
    if (signal.aborted) return Promise.resolve();
    return WS.swr('issues:counts', function () {
      return WS.getJSON('/api/integrations/issue-counts', { signal: signal });
    }, function (counts) {
      if (signal.aborted) return;   // left: the next page owns the arrival order now
      WS.arrive('counts', function () {
        $('issuesCounts').textContent = countsLine(counts);
      });
    }, {
      onError: function (err) {
        if (signal.aborted || isAbort(err)) return;   // left the page: not an error
        // No figure to show: the line keeps its height, empty.
        WS.arrive('counts', function () { $('issuesCounts').textContent = ''; });
      }
    });
  }

  // ---- Issues List ----

  function loadIssues() {
    if (signal.aborted) return Promise.resolve();
    return WS.swr('issues:list', function () {
      return WS.getJSON('/api/integrations/issues?take=50', { signal: signal });
    }, function (data) {
      if (signal.aborted) return;
      _allIssues = data.results || [];
      WS.arrive('list', renderIssues);
    }, {
      onError: function (err) {
        if (signal.aborted || isAbort(err)) return;
        console.error('Error loading issues:', err);
        WS.arrive('list', function () {
          WS.setHTML($('issuesList'),
            '<p class="text-body text-frosted-blue/70 py-6">Reported problems can\u2019t be shown right now. Try again in a minute.</p>');
        });
      }
    });
  }

  function renderIssues() {
    var list = $('issuesList');
    var filtered = _allIssues;

    // Apply status filter
    if (_currentStatusFilter !== 'all') {
      filtered = filtered.filter(function (issue) {
        return issue.status === _currentStatusFilter;
      });
    }
    // Apply type filter
    if (_currentTypeFilter !== 'all') {
      filtered = filtered.filter(function (issue) {
        return issue.issue_type === _currentTypeFilter;
      });
    }

    if (filtered.length === 0) {
      var msg = 'Nothing has been reported yet.';
      if (_currentStatusFilter !== 'all' || _currentTypeFilter !== 'all') msg = 'Nothing matches those filters.';
      WS.setHTML(list, '<p class="text-body text-frosted-blue/70 py-6">' + msg + '</p>');
      return;
    }

    WS.setHTML(list, filtered.map(function (issue) {
      return buildIssueCard(issue);
    }).join(''));
  }

  // ---- Filter Tabs ----

  function setStatusFilter(filter) {
    _currentStatusFilter = filter;
    root.querySelectorAll('.status-filter-tab').forEach(function (tab) {
      tab.setAttribute('aria-pressed', tab.getAttribute('data-sfilter') === filter ? 'true' : 'false');
    });
    renderIssues();
  }

  function setTypeFilter(filter) {
    _currentTypeFilter = filter;
    root.querySelectorAll('.type-filter-tab').forEach(function (tab) {
      tab.setAttribute('aria-pressed', tab.getAttribute('data-tfilter') === filter ? 'true' : 'false');
    });
    renderIssues();
  }

  // ---- Issue Detail Modal ----

  function issueShowing(issueId) {
    return !$('issueModal').classList.contains('hidden') && _detailIssueId === String(issueId);
  }

  async function viewIssue(issueId) {
    _detailIssueId = String(issueId);
    var modal = $('issueModal');
    var content = $('modalContent');
    content.innerHTML = '<p id="issueDetailTitle" class="text-frosted-blue/70 text-body py-8 text-center">Loading the report\u2026</p>';
    if (!_dialog) {
      modal.classList.remove('hidden');
      _dialog = WSUI.modal(modal, { onClose: function () { modal.classList.add('hidden'); _dialog = null; } });
    }

    try {
      var resp = await fetch('/api/integrations/issues/' + issueId, { signal: signal });
      if (!resp.ok) throw new Error('API error');
      var issue = await resp.json();
      renderIssueDetail(issue);
    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: not an error
      content.innerHTML = '<p id="issueDetailTitle" class="text-frosted-blue/70 text-body py-8 text-center">This report can\u2019t be shown right now. Try again in a minute.</p>';
    }
  }

  function renderIssueDetail(issue) {
    var content = $('modalContent');
    var posterUrl = issue.poster_url || '';
    var title = escapeHtml(issue.media_title || 'Unknown');
    var dateStr = issue.created_date ? getTimeAgo(issue.created_date) : '';

    var posterHtml = posterUrl
      ? '<img src="' + escapeHtml(posterUrl) + '" alt="" class="w-16 h-24 rounded-btn object-cover shrink-0"/>'
      : '<div class="w-16 h-24 rounded-btn bg-frosted-blue/5 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-2xl text-steel-blue/30" aria-hidden="true">movie</span></div>';

    // Comments
    var comments = issue.comments || [];
    var commentsHtml = comments.map(function (c) {
      var commentDate = c.created_date ? getTimeAgo(c.created_date, true) : '';
      return '<div class="p-3 rounded-inner bg-frosted-blue/[0.04]">' +
        (commentDate ? '<p class="text-label text-frosted-blue/70 mb-1.5">' + escapeHtml(commentDate) + '</p>' : '') +
        '<p class="text-body text-frosted-blue/80 whitespace-pre-wrap">' + escapeHtml(c.message || '') + '</p>' +
      '</div>';
    }).join('');

    content.innerHTML = '' +
      // Header: poster + title + badges
      '<div class="flex gap-4 mb-5 pr-10">' +
        posterHtml +
        '<div class="flex-1 min-w-0">' +
          '<h2 id="issueDetailTitle" class="text-frosted-blue text-lead font-bold">' + title + '</h2>' +
          '<div class="flex flex-wrap items-center gap-1.5 mt-1.5">' +
            getIssueTypeBadge(issue.issue_type) +
            getIssueStatusBadge(issue.status) +
          '</div>' +
          (dateStr ? '<p class="text-label text-frosted-blue/70 mt-2">Reported ' + escapeHtml(dateStr) + '</p>' : '') +
        '</div>' +
      '</div>' +
      // Comments
      '<div class="border-t border-frosted-blue/10 pt-4">' +
        '<h3 class="text-body font-semibold text-frosted-blue mb-3">' + (comments.length === 1 ? '1 comment' : comments.length + ' comments') + '</h3>' +
        (commentsHtml ? '<div class="space-y-2 mb-4">' + commentsHtml + '</div>' : '<p class="text-body text-frosted-blue/70 mb-4">No comments yet.</p>') +
      '</div>' +
      // Add comment form
      '<div class="border-t border-frosted-blue/10 pt-4">' +
        '<label for="commentMessage" class="block text-label font-semibold text-frosted-blue/70 mb-1.5">Add a comment</label>' +
        '<textarea id="commentMessage" aria-describedby="commentError" class="w-full p-3 bg-frosted-blue/[0.04] border border-frosted-blue/10 rounded-btn text-frosted-blue placeholder-frosted-blue/70 text-body resize-none h-24 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"></textarea>' +
        '<p id="commentError" class="hidden text-label font-semibold text-status-err-text mt-1.5">Write something first.</p>' +
        '<button type="button" id="addCommentBtn" data-action="add-comment" data-issue-id="' + escapeHtml(String(issue.id)) + '" class="ws-lift w-full py-2.5 mt-2 rounded-btn bg-primary hover:bg-primary/90 text-bright text-body font-semibold transition-colors">Post comment</button>' +
      '</div>';

    // The draft is kept by the page's delegated input listener.
    var textarea = $('commentMessage');
    textarea.setAttribute('data-issue-id', String(issue.id));
    textarea.value = _commentDrafts[issue.id] || '';
    if (Object.prototype.hasOwnProperty.call(_commentSending, issue.id)) {
      setCommentBtn($('addCommentBtn'), true);
    }
  }

  async function addComment(issueId) {
    if (Object.prototype.hasOwnProperty.call(_commentSending, issueId)) return;
    var box = $('commentMessage');
    var message = box.value.trim();
    box.classList.toggle('ws-invalid', !message);
    box.setAttribute('aria-invalid', message ? 'false' : 'true');
    $('commentError').classList.toggle('hidden', !!message);
    if (!message) { box.focus(); return; }

    setCommentBtn($('addCommentBtn'), true);
    _commentSending[issueId] = message;

    try {
      var resp = await fetch('/api/integrations/issues/' + issueId + '/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message }),
        signal: signal,
      });
      if (!resp.ok) {
        var err = await resp.json().catch(function () { return {}; });
        throw new Error(err.detail || 'Failed to add comment');
      }

      // Newer text typed meanwhile stays; only the sent text is cleared,
      // compared trimmed as it was posted (a stray space is not new text).
      if ((_commentDrafts[issueId] || '').trim() === message) delete _commentDrafts[issueId];
      showToast('Comment posted', 'success');
      // Reload the issue detail, unless it was closed or another one opened
      if (issueShowing(issueId)) viewIssue(issueId);

    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: nothing to say
      showToast(error.message, 'error');
    } finally {
      delete _commentSending[issueId];
      // The box on screen for this issue may be a rebuilt one.
      var live = $('addCommentBtn');
      if (live && live.getAttribute('data-issue-id') === String(issueId)) setCommentBtn(live, false);
    }
  }

  function closeModal() {
    if (_dialog) _dialog.close();
  }

  // ---- Wiring: one listener per kind, on the page or with its signal ----

  root.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    switch (el.getAttribute('data-action')) {
      case 'close-modal': closeModal(); break;
      case 'deselect': deselectMedia(); break;
      case 'issue-type': selectIssueType(parseInt(el.getAttribute('data-type'), 10)); break;
      case 'status-filter': setStatusFilter(el.getAttribute('data-sfilter')); break;
      case 'type-filter': setTypeFilter(el.getAttribute('data-tfilter')); break;
      case 'select-media': {
        var item = _searchResults[parseInt(el.getAttribute('data-index'), 10)];
        if (item) selectMedia(item);
        break;
      }
      case 'view-issue': viewIssue(parseInt(el.getAttribute('data-issue-id'), 10)); break;
      case 'add-comment': addComment(parseInt(el.getAttribute('data-issue-id'), 10)); break;
    }
  }, { signal: signal });

  // error does not bubble: caught on the way down, for every poster. The
  // placeholder right after it, if there is one, takes its place.
  root.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG' || !t.hasAttribute('data-poster')) return;
    t.style.display = 'none';
    var fallback = t.nextElementSibling;
    if (fallback && fallback.hasAttribute('data-poster-fallback')) fallback.style.display = 'flex';
  }, { capture: true, signal: signal });

  root.addEventListener('input', function (e) {
    var t = e.target;
    if (!t) return;
    if (t.id === 'searchInput') {
      // Debounced: each keystroke replaces the last one's wait.
      var query = t.value.trim();
      var seq = ++_searchSeq;
      if (query.length === 0) {
        clearSearch();
        return;
      }
      ctx.setTimeout(function () {
        if (seq === _searchSeq) performSearch(query);
      }, SEARCH_DELAY_MS);
    } else if (t.id === 'issueMessage') {
      if (t.value.trim()) markInvalid('issueMessage', 'issueMessageError', false);
    } else if (t.id === 'commentMessage') {
      if (t.value.trim()) { t.classList.remove('ws-invalid'); $('commentError').classList.add('hidden'); }
      var id = t.getAttribute('data-issue-id');
      if (t.value) _commentDrafts[id] = t.value;
      else delete _commentDrafts[id];
    }
  }, { signal: signal });

  // The report form sends on submit (its button, or Enter in the search-free
  // fields); Escape on the detail is WSUI.modal's.
  $('issueFormSection').addEventListener('submit', function (e) {
    e.preventDefault();
    submitIssue();
  }, { signal: signal });

  ctx.poll(function () {
    loadIssueCounts();
    loadIssues();
  }, REFRESH_MS);

  // The counts and the list are on screen (the last visit's copy, or
  // fetched) before mount resolves, so Back and Forward restore the scroll
  // onto them.
  await Promise.all([loadIssueCounts(), loadIssues()]);
}
