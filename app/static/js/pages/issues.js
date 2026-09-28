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
 * The detail modal lives inside #wsPage, so leaving the page takes it away
 * with the rest. The wiki pointer is wiki-hook.js (a page helper script,
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
  // that runs.
  var title = item.title || 'Unknown';
  var year = item.year ? String(item.year) : '';
  var mediaTypeLabel = item.media_type === 'tv' ? 'TV Show' : 'Movie';
  var typeBadgeColor = item.media_type === 'tv' ? 'badge-media-tv' : 'badge-media-movie';
  var posterUrl = item.poster_url || '';

  var row = document.createElement('div');
  row.className = 'flex items-center gap-3 p-2 rounded-lg hover:bg-frosted-blue/5 cursor-pointer transition-all border border-transparent hover:border-steel-blue/20';
  row.setAttribute('data-action', 'select-media');
  row.setAttribute('data-index', String(index));

  if (posterUrl) {
    // A poster that fails to load gives way to the placeholder after it
    // (the page's error listener).
    var img = document.createElement('img');
    img.src = posterUrl;
    img.alt = title;
    img.className = 'w-10 h-[60px] rounded object-cover shrink-0';
    img.setAttribute('data-poster', '');
    var fallback = document.createElement('div');
    fallback.className = 'w-10 h-[60px] rounded bg-frosted-blue/5 items-center justify-center shrink-0';
    fallback.style.display = 'none';
    fallback.setAttribute('data-poster-fallback', '');
    fallback.innerHTML = '<span class="material-symbols-outlined text-xl text-steel-blue/30">movie</span>';
    row.appendChild(img);
    row.appendChild(fallback);
  } else {
    var placeholder = document.createElement('div');
    placeholder.className = 'w-10 h-[60px] rounded bg-frosted-blue/5 flex items-center justify-center shrink-0';
    placeholder.innerHTML = '<span class="material-symbols-outlined text-xl text-steel-blue/30">movie</span>';
    row.appendChild(placeholder);
  }

  var info = document.createElement('div');
  info.className = 'flex-1 min-w-0';

  var titleP = document.createElement('p');
  titleP.className = 'text-frosted-blue text-sm font-medium truncate';
  titleP.textContent = title;
  info.appendChild(titleP);

  var metaRow = document.createElement('div');
  metaRow.className = 'flex items-center gap-2 mt-0.5';
  if (year) {
    var yearSpan = document.createElement('span');
    yearSpan.className = 'text-steel-blue text-[11px]';
    yearSpan.textContent = year;
    metaRow.appendChild(yearSpan);
  }
  var typeSpan = document.createElement('span');
  typeSpan.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded ' + typeBadgeColor;
  typeSpan.textContent = mediaTypeLabel;
  metaRow.appendChild(typeSpan);
  info.appendChild(metaRow);

  row.appendChild(info);
  return row;
}

// ---- Badges ----

function getIssueTypeBadge(type) {
  // One neutral chip: the icon and the word say which kind of problem it
  // is, so the kinds don't need a colour each.
  var configs = {
    'video':     { bg: 'bg-frosted-blue/10', text: 'text-frosted-blue', icon: 'videocam',  label: 'Video' },
    'audio':     { bg: 'bg-frosted-blue/10', text: 'text-frosted-blue', icon: 'volume_up', label: 'Audio' },
    'subtitles': { bg: 'bg-frosted-blue/10', text: 'text-frosted-blue', icon: 'subtitles', label: 'Subtitles' },
    'other':     { bg: 'bg-frosted-blue/10', text: 'text-frosted-blue', icon: 'more_horiz', label: 'Other' },
  };
  var c = configs[type] || configs['other'];
  return '<span class="px-2 py-0.5 rounded ' + c.bg + ' ' + c.text + ' text-[9px] font-bold uppercase tracking-wider inline-flex items-center gap-1">' +
    '<span class="material-symbols-outlined text-[10px]">' + c.icon + '</span>' + c.label + '</span>';
}

// Status colour only on deviation: an open issue is waiting on someone, so it
// takes the warning tint and status-text words; a resolved one is quiet.
function getIssueStatusBadge(status) {
  if (status === 'open') {
    return '<span class="px-2 py-0.5 rounded bg-status-warn/10 text-status-warn-text text-[9px] font-bold uppercase tracking-wider">Open</span>';
  }
  return '<span class="px-2 py-0.5 rounded bg-frosted-blue/10 text-frosted-blue/80 text-[9px] font-bold uppercase tracking-wider">Resolved</span>';
}

function buildIssueCard(issue) {
  var title = escapeHtml(issue.media_title || 'Unknown');
  var posterUrl = issue.poster_url || '';

  // A poster that fails to load gives way to the placeholder after it.
  var posterHtml = posterUrl
    ? '<img src="' + escapeHtml(posterUrl) + '" alt="' + title + '" class="w-12 h-[72px] rounded object-cover shrink-0" data-poster/>' +
      '<div class="w-12 h-[72px] rounded bg-frosted-blue/5 items-center justify-center shrink-0" style="display:none" data-poster-fallback><span class="material-symbols-outlined text-xl text-steel-blue/30">movie</span></div>'
    : '<div class="w-12 h-[72px] rounded bg-frosted-blue/5 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-xl text-steel-blue/30">movie</span></div>';

  var dateStr = issue.created_date ? getTimeAgo(new Date(issue.created_date)) : '';

  return '<div class="glass-card rounded-xl p-3 flex gap-3 items-start cursor-pointer hover:border-primary/40 transition-all" data-action="view-issue" data-issue-id="' + escapeHtml(String(issue.id)) + '">' +
    posterHtml +
    '<div class="flex-1 min-w-0">' +
      '<p class="text-frosted-blue text-sm font-bold truncate">' + title + '</p>' +
      '<div class="flex flex-wrap items-center gap-1.5 mt-1">' +
        getIssueTypeBadge(issue.issue_type) +
        getIssueStatusBadge(issue.status) +
      '</div>' +
      (dateStr ? '<p class="text-[10px] text-frosted-blue/70 mt-1.5">' + dateStr + '</p>' : '') +
    '</div>' +
  '</div>';
}

function setCommentBtn(btn, sending) {
  btn.disabled = sending;
  btn.textContent = sending ? 'Sending...' : 'Add Comment';
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

  if (window.WikiHook) WikiHook.init(ctx, { container: 'wikiHookIssues', hook: 'issues', lead: 'Might this help first?' });

  // ---- Search ----

  async function performSearch(query) {
    _currentSearchQuery = query;
    var section = $('searchResultsSection');
    var emptyState = $('searchEmptyState');
    var list = $('searchResultsList');

    section.classList.remove('hidden');
    emptyState.classList.add('hidden');

    list.innerHTML = '<div class="text-center text-steel-blue py-4">' +
      '<span class="material-symbols-outlined text-2xl mb-1 block opacity-50 animate-spin">progress_activity</span>' +
      '<p class="text-xs">Searching...</p></div>';

    try {
      var resp = await fetch('/api/integrations/seerr-search?query=' + encodeURIComponent(query) + '&page=1', { signal: signal });
      if (!resp.ok) throw new Error('Search failed');
      var data = await resp.json();

      var results = (data.results || []).filter(function (item) {
        // Only show items that exist in the library (have media_info_id)
        return item.media_info_id;
      });

      $('searchResultCount').textContent = results.length + ' in library';

      if (results.length === 0) {
        _searchResults = [];
        list.innerHTML = '<div class="text-center text-steel-blue py-4">' +
          '<span class="material-symbols-outlined text-2xl mb-1 block opacity-50">search_off</span>' +
          '<p class="text-xs">No library items found for "' + escapeHtml(query) + '"</p>' +
          '<p class="text-[10px] text-frosted-blue/70 mt-1">Only titles already in the library can be reported here</p></div>';
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
      list.innerHTML = '<div class="text-center text-frosted-blue/70 py-4">' +
        '<span class="material-symbols-outlined text-2xl mb-1 block text-status-err-text">error</span>' +
        '<p class="text-xs">Error searching. Is Seerr configured?</p></div>';
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
    $('selectedMediaYear').textContent = (item.year || '') + ' - ' + (item.media_type === 'tv' ? 'TV Show' : 'Movie');
    var poster = $('selectedMediaPoster');
    if (item.poster_url) {
      poster.src = item.poster_url;
      poster.style.display = '';
    } else {
      poster.style.display = 'none';
    }

    // Reset form
    $('issueMessage').value = '';
    root.querySelectorAll('.issue-type-btn').forEach(function (btn) {
      btn.classList.remove('active');
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
      if (parseInt(btn.getAttribute('data-type'), 10) === type) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  // ---- Submit Issue ----

  async function submitIssue() {
    if (!_selectedMedia) return;
    if (!_selectedIssueType) {
      showToast('Please select an issue type', 'error');
      return;
    }
    var message = $('issueMessage').value.trim();
    if (!message) {
      showToast('Please describe the issue', 'error');
      return;
    }

    var submitBtn = $('submitIssueBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>';
    submitBtn.classList.add('opacity-60');

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

      showToast('Issue reported successfully!', 'success');
      deselectMedia();
      ctx.setTimeout(function () { loadIssueCounts(); loadIssues(); }, 1500);

    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: nothing to say
      console.error('Submit issue error:', error);
      showToast(error.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Issue';
      submitBtn.classList.remove('opacity-60');
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
        $('statTotal').textContent = counts.total || 0;
        $('statOpen').textContent = counts.open || 0;
        $('statClosed').textContent = counts.closed || 0;
        $('issuesTotalCount').textContent = '(' + (counts.total || 0) + ')';
      });
    }, {
      onError: function (err) {
        if (signal.aborted || isAbort(err)) return;   // left the page: not an error
        console.log('Issue counts not available');
        WS.arrive('counts', function () {
          ['statTotal', 'statOpen', 'statClosed'].forEach(function (id) { $(id).textContent = '–'; });
        });
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
            '<div class="text-center text-steel-blue py-8">' +
            '<span class="material-symbols-outlined text-4xl mb-2 block opacity-50">report_problem</span>' +
            '<p>Could not load issues</p></div>');
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
      var msg = 'No issues found';
      if (_currentStatusFilter !== 'all' || _currentTypeFilter !== 'all') msg = 'No matching issues';
      WS.setHTML(list, '<div class="text-center text-steel-blue py-8">' +
        '<span class="material-symbols-outlined text-4xl mb-2 block opacity-50">check_circle</span>' +
        '<p>' + msg + '</p></div>');
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
      if (tab.getAttribute('data-sfilter') === filter) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });
    renderIssues();
  }

  function setTypeFilter(filter) {
    _currentTypeFilter = filter;
    root.querySelectorAll('.type-filter-tab').forEach(function (tab) {
      if (tab.getAttribute('data-tfilter') === filter) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
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
    modal.classList.remove('hidden');

    content.innerHTML = '<div class="text-center text-steel-blue py-8">' +
      '<span class="material-symbols-outlined text-4xl mb-2 block opacity-50 animate-spin">progress_activity</span>' +
      '<p>Loading issue...</p></div>';

    try {
      var resp = await fetch('/api/integrations/issues/' + issueId, { signal: signal });
      if (!resp.ok) throw new Error('API error');
      var issue = await resp.json();
      renderIssueDetail(issue);
    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: not an error
      content.innerHTML = '<div class="text-center text-frosted-blue/70 py-8">' +
        '<span class="material-symbols-outlined text-4xl mb-2 block text-status-err-text">error</span>' +
        '<p>Could not load issue details</p></div>';
    }
  }

  function renderIssueDetail(issue) {
    var content = $('modalContent');
    var posterUrl = issue.poster_url || '';
    var title = escapeHtml(issue.media_title || 'Unknown');
    var dateStr = issue.created_date ? getTimeAgo(new Date(issue.created_date)) : '';

    var posterHtml = posterUrl
      ? '<img src="' + escapeHtml(posterUrl) + '" alt="' + title + '" class="w-16 h-24 rounded object-cover shrink-0"/>'
      : '<div class="w-16 h-24 rounded bg-frosted-blue/5 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-2xl text-steel-blue/30">movie</span></div>';

    // Comments
    var comments = issue.comments || [];
    var commentsHtml = comments.map(function (c) {
      var commentDate = c.created_date ? getTimeAgo(new Date(c.created_date)) : '';
      return '<div class="p-3 rounded-lg bg-frosted-blue/5 border border-steel-blue/10">' +
        (commentDate ? '<p class="text-[10px] text-frosted-blue/70 mb-1.5">' + commentDate + '</p>' : '') +
        '<p class="text-sm text-frosted-blue/80 whitespace-pre-wrap">' + escapeHtml(c.message || '') + '</p>' +
      '</div>';
    }).join('');

    content.innerHTML = '' +
      // Header: poster + title + badges
      '<div class="flex gap-4 mb-4">' +
        posterHtml +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-frosted-blue text-base font-bold">' + title + '</p>' +
          '<div class="flex flex-wrap items-center gap-1.5 mt-1.5">' +
            getIssueTypeBadge(issue.issue_type) +
            getIssueStatusBadge(issue.status) +
          '</div>' +
          (dateStr ? '<p class="text-xs text-frosted-blue/70 mt-2">' + dateStr + '</p>' : '') +
        '</div>' +
      '</div>' +
      // Comments
      '<div class="border-t border-steel-blue/20 pt-4">' +
        '<p class="text-[10px] text-steel-blue font-bold uppercase tracking-wider mb-3">Comments (' + comments.length + ')</p>' +
        (commentsHtml ? '<div class="space-y-2 mb-4">' + commentsHtml + '</div>' : '<p class="text-sm text-frosted-blue/70 mb-4">No comments yet</p>') +
      '</div>' +
      // Add comment form
      '<div class="border-t border-steel-blue/20 pt-4">' +
        '<textarea id="commentMessage" placeholder="Add a comment..." class="w-full p-3 bg-frosted-blue/[0.04] border border-steel-blue/20 rounded-lg text-frosted-blue placeholder-frosted-blue/70 text-sm resize-none h-20 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-all"></textarea>' +
        '<button id="addCommentBtn" data-action="add-comment" data-issue-id="' + escapeHtml(String(issue.id)) + '" class="w-full py-2 mt-2 rounded-lg bg-primary hover:bg-primary/80 text-bright text-sm font-bold transition-all">Add Comment</button>' +
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
    var message = $('commentMessage').value.trim();
    if (!message) {
      showToast('Please enter a comment', 'error');
      return;
    }

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
      showToast('Comment added!', 'success');
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
    $('issueModal').classList.add('hidden');
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
      case 'submit': submitIssue(); break;
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
    } else if (t.id === 'commentMessage') {
      var id = t.getAttribute('data-issue-id');
      if (t.value) _commentDrafts[id] = t.value;
      else delete _commentDrafts[id];
    }
  }, { signal: signal });

  // Escape closes the issue detail, like every other overlay, but not while an
  // input method is composing. A WSUI dialog answers its own Escape first; the
  // check is the belt to that.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.isComposing || document.querySelector('.ws-dialog')) return;
    if (!$('issueModal').classList.contains('hidden')) closeModal();
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
