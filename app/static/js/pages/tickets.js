/**
 * WebServarr — Tickets (page module)
 *
 * Message the server admin and follow the replies: the caller's own tickets
 * (every ticket, for an admin), a New message form, and a detail modal with
 * the comments, the admin's status controls and an image lightbox.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. One delegated click listener on ctx.root serves the static
 * controls and the rebuilt ticket cards and attachments (data-action); the
 * detail's form controls are built with their own listeners, on the same
 * signal. The three overlays live inside #wsPage, so leaving the page takes
 * them away, open or not. The wiki pointers are wiki-hook.js (a page helper
 * script, data-ws-page-script), started from mount with the same ctx.
 */

const REFRESH_MS = 30000;
const PAGE_SIZE = 12;

// ---- Category display config ----
const CATEGORY_LABELS = {
  media_request: 'Media Request',
  playback_issue: 'Playback Issue',
  account_issue: 'Account Issue',
  feature_suggestion: 'Feature',
  other: 'Other'
};
// Theme colours only. The category is a neutral chip (its words say which);
// the status uses the request tones the home and requests pages use
// (resolved on a primary tint, in progress in the text colour, open on the
// accent, closed dimmed); and only high and urgent priority, the ones that
// need attention, take a status colour.
const CATEGORY_COLORS = {
  media_request: 'bg-frosted-blue/10 text-frosted-blue',
  playback_issue: 'bg-frosted-blue/10 text-frosted-blue',
  account_issue: 'bg-frosted-blue/10 text-frosted-blue',
  feature_suggestion: 'bg-frosted-blue/10 text-frosted-blue',
  other: 'bg-frosted-blue/10 text-frosted-blue'
};
const STATUS_COLORS = {
  open: 'bg-steel-blue/20 text-frosted-blue/80',
  in_progress: 'bg-frosted-blue/15 text-frosted-blue',
  resolved: 'bg-primary/30 text-frosted-blue',
  closed: 'bg-steel-blue/10 text-frosted-blue/80'
};
const PRIORITY_COLORS = {
  low: 'bg-frosted-blue/10 text-frosted-blue/80',
  medium: 'bg-frosted-blue/10 text-frosted-blue',
  high: 'bg-status-warn/10 text-status-warn-text',
  urgent: 'bg-status-err/10 text-status-err-text'
};

const OFF_NOTICE = 'Messages have been turned off, so this can’t be sent right now.';
// The ticket API's 403 detail while Tickets is switched off (app/routers/tickets.py).
const TICKETS_OFF_DETAIL = 'The ticket system is turned off';

// ---- Helpers ----

function isAbort(e) { return !!e && e.name === 'AbortError'; }

function createEl(tag, classes, text) {
  var el = document.createElement(tag);
  if (classes) el.className = classes;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function timeAgo(isoString) {
  if (!isoString) return '';
  var seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 0) seconds = 0;
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
  return new Date(isoString).toLocaleDateString();
}

// The site's one toast (ui.js): theme colours, a status light for the tone.
function showToast(message, type) {
  WSUI.toast(message, type === 'error' ? 'err' : 'ok');
}

export async function mount(ctx) {
  var root = ctx.root;
  var signal = ctx.signal;

  function $(id) { return root.querySelector('#' + id); }

  // This visit's state: every mount starts its own.
  var _tickets = [];
  var _currentFilter = 'all';
  var _currentCatFilter = 'all';
  var _currentPage = 0;
  var _total = 0;
  var _isAdmin = !!(ctx.data && ctx.data.user && ctx.data.user.is_admin);
  var _stopRefresh = null;

  // ---- Filter tabs ----

  function setFilter(status) {
    _currentFilter = status;
    _currentPage = 0;
    root.querySelectorAll('.filter-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-filter') === status);
    });
    loadTickets();
  }

  function setCategoryFilter(cat) {
    _currentCatFilter = cat;
    _currentPage = 0;
    root.querySelectorAll('.cat-filter-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-catfilter') === cat);
    });
    loadTickets();
  }

  // ---- Pagination ----

  function prevPage() { if (_currentPage > 0) { _currentPage--; loadTickets(); } }
  function nextPage() {
    if ((_currentPage + 1) * PAGE_SIZE < _total) { _currentPage++; loadTickets(); }
  }

  function updatePagination() {
    var pag = $('pagination');
    var totalPages = Math.max(1, Math.ceil(_total / PAGE_SIZE));
    if (_total <= PAGE_SIZE) { pag.classList.add('hidden'); return; }
    pag.classList.remove('hidden');
    $('pageInfo').textContent = 'Page ' + (_currentPage + 1) + ' of ' + totalPages;
    $('prevBtn').disabled = _currentPage === 0;
    $('nextBtn').disabled = (_currentPage + 1) >= totalPages;
  }

  // ---- Load tickets ----

  /* WS.getJSON for the ticket API, on the page's signal. A member gets 403
     once Tickets is switched off (the tab was open, or the page came from the
     prefetch cache). Instead of an error toast and a 403 every 30 s,
     ticketsTurnedOff() takes over. The promise never settles, so nothing
     renders from the failed call. */
  function ticketsJSON(url) {
    return WS.getJSON(url, { signal: signal }).catch(function (err) {
      if (!_isAdmin && err && err.message === 'HTTP 403') {
        ticketsTurnedOff();
        return new Promise(function () {});
      }
      throw err;
    });
  }

  var _ticketsOff = false;
  // Rejection a send uses once the off-flow has taken over: no error toast.
  var TICKETS_OFF = {};

  /* Stop polling, then go home as the server-side page gate would - unless the
     member is part-way through writing something. Their text is never thrown
     away: the notice goes in that surface, and they leave when they close it.
     A send's own 403 passes its button; a poll finds the open draft itself. */
  function ticketsTurnedOff(sendBtn) {
    _ticketsOff = true;
    if (_stopRefresh) { _stopRefresh(); _stopRefresh = null; }
    sendBtn = sendBtn || draftSendButton();
    if (sendBtn) { showOffNotice(sendBtn); return; }
    window.location.replace('/');
  }

  // The send button of an open compose surface holding typed text, or null.
  function draftSendButton() {
    if (!$('createModal').classList.contains('hidden') &&
        ($('createTitle').value.trim() ||
         $('createDescription').value.trim())) {
      return $('createSubmitBtn');
    }
    var comment = $('commentInput');
    if (comment && !$('detailModal').classList.contains('hidden') && comment.value.trim()) {
      return $('commentSendBtn');
    }
    return null;
  }

  // The notice says the draft can't be sent, so the button agrees.
  function showOffNotice(sendBtn) {
    sendBtn.disabled = true;
    var prev = sendBtn.previousElementSibling;
    if (prev && prev.hasAttribute('data-off-notice')) return;
    var notice = createEl('p', 'text-xs text-frosted-blue/80 bg-steel-blue/10 border border-steel-blue/25 rounded-lg px-3 py-2 mb-3', OFF_NOTICE);
    notice.setAttribute('data-off-notice', '');
    notice.setAttribute('role', 'status');
    sendBtn.parentNode.insertBefore(notice, sendBtn);
  }

  /* POST for the New message and comment forms. Rejects with the server's
     detail for the form's toast - except a member's "turned off" 403, which
     takes the off-flow by that form's button and rejects with TICKETS_OFF.
     Matching the detail keeps other 403s (a comment on someone else's ticket)
     on the toast. A page left mid-send rejects with the fetch's AbortError. */
  function postTicketForm(url, formData, sendBtn) {
    return fetch(url, { method: 'POST', body: formData, signal: signal }).then(function (r) {
      if (r.ok) return r.json();
      return r.json().then(function (d) {
        if (!_isAdmin && r.status === 403 && d.detail === TICKETS_OFF_DETAIL) {
          ticketsTurnedOff(sendBtn);
          throw TICKETS_OFF;
        }
        throw new Error(d.detail || 'Failed');
      });
    });
  }

  function loadTickets() {
    if (signal.aborted) return Promise.resolve();
    var params = new URLSearchParams();
    if (_currentFilter !== 'all') params.set('status', _currentFilter);
    if (_currentCatFilter !== 'all') params.set('category', _currentCatFilter);
    params.set('limit', PAGE_SIZE);
    params.set('offset', _currentPage * PAGE_SIZE);

    var url = (_isAdmin ? '/api/admin/tickets' : '/api/tickets') + '?' + params.toString();

    return WS.swr('tickets:' + url, function () { return ticketsJSON(url); }, function (data) {
      if (signal.aborted) return;   // left: the next page owns the arrival order now
      _tickets = data.tickets || [];
      _total = data.total || 0;
      WS.arrive('list', function () {
        renderTicketList();
        updatePagination();
      });
    }, {
      onError: function (err) {
        if (signal.aborted || isAbort(err)) return;   // left the page: not an error
        showToast('Failed to load tickets', 'error');
      }
    });
  }

  function loadCounts() {
    if (signal.aborted) return Promise.resolve();
    return WS.swr('tickets:counts', function () { return ticketsJSON('/api/tickets/counts'); }, function (data) {
      if (signal.aborted) return;
      WS.arrive('counts', function () {
        $('statTotal').textContent = data.total || 0;
        $('statOpen').textContent = data.open || 0;
        $('statInProgress').textContent = data.in_progress || 0;
        $('statResolved').textContent = data.resolved || 0;
      });
    }, {
      onError: function (err) {
        if (signal.aborted || isAbort(err)) return;
        WS.arrive('counts', function () {
          ['statTotal', 'statOpen', 'statInProgress', 'statResolved'].forEach(function (id) { $(id).textContent = '–'; });
        });
      }
    });
  }

  // ---- Render ticket list ----

  function renderTicketList() {
    var container = $('ticketList');
    var empty = $('emptyState');

    // Clear
    while (container.firstChild) container.removeChild(container.firstChild);

    if (_tickets.length === 0) {
      container.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    container.classList.remove('hidden');
    empty.classList.add('hidden');

    _tickets.forEach(function(ticket) {
      // The page's click listener opens it (data-action).
      var card = createEl('div', 'glass-card rounded-xl p-4 cursor-pointer hover:border-primary/40 transition-all border border-transparent');
      card.setAttribute('data-action', 'open-ticket');
      card.setAttribute('data-ticket-id', String(ticket.id));

      // Top row: title + badges (stacked on mobile, side-by-side on desktop)
      var topRow = createEl('div', 'flex flex-col lg:flex-row lg:items-start lg:justify-between gap-1 lg:gap-3 mb-2');

      var titleDiv = createEl('div', 'flex-1 min-w-0');
      var titleEl = createEl('p', 'text-frosted-blue font-bold text-sm truncate', ticket.title);
      titleDiv.appendChild(titleEl);

      // Creator (admin only)
      if (_isAdmin && ticket.creator_username) {
        var creatorEl = createEl('p', 'text-[10px] text-steel-blue mt-0.5', '@' + ticket.creator_username);
        titleDiv.appendChild(creatorEl);
      }

      var badgeDiv = createEl('div', 'flex items-center gap-1.5 flex-wrap lg:shrink-0 lg:justify-end');

      // Category badge
      var catBadge = createEl('span', 'px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ' + (CATEGORY_COLORS[ticket.category] || CATEGORY_COLORS.other), CATEGORY_LABELS[ticket.category] || ticket.category);
      badgeDiv.appendChild(catBadge);

      // Status badge
      var statusLabel = (ticket.status || 'open').replace('_', ' ');
      var statusBadge = createEl('span', 'px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ' + (STATUS_COLORS[ticket.status] || STATUS_COLORS.open), statusLabel);
      badgeDiv.appendChild(statusBadge);

      // Priority badge (if set)
      if (ticket.priority) {
        var priBadge = createEl('span', 'px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ' + (PRIORITY_COLORS[ticket.priority] || ''), ticket.priority);
        badgeDiv.appendChild(priBadge);
      }

      topRow.appendChild(titleDiv);
      topRow.appendChild(badgeDiv);
      card.appendChild(topRow);

      // Bottom row: description snippet + time
      var bottomRow = createEl('div', 'flex items-center justify-between gap-3');
      var descSnippet = createEl('p', 'text-xs text-steel-blue truncate flex-1', ticket.description);
      var timeEl = createEl('span', 'text-[10px] text-frosted-blue/70 shrink-0', timeAgo(ticket.created_at));
      bottomRow.appendChild(descSnippet);
      bottomRow.appendChild(timeEl);
      card.appendChild(bottomRow);

      container.appendChild(card);
    });
  }

  // ---- Create ticket ----

  // A tap outside the card closes it (the scrim), so what was typed stays
  // until the ticket is actually sent: opening again shows the draft, and only
  // a successful submit clears the form.
  function openCreateModal() {
    $('createModal').classList.remove('hidden');
  }

  function resetCreateForm() {
    $('createTitle').value = '';
    $('createDescription').value = '';
    var cat = $('createCategory');
    cat.value = 'media_request';
    cat.dispatchEvent(new Event('change'));   // the playback hint follows the category
    $('createImage').value = '';
  }

  function closeCreateModal() {
    $('createModal').classList.add('hidden');
    if (_ticketsOff) window.location.replace('/');
  }

  function submitNewTicket() {
    if (_ticketsOff) return;
    var title = $('createTitle').value.trim();
    var description = $('createDescription').value.trim();
    var category = $('createCategory').value;
    var imageInput = $('createImage');

    if (!title) { showToast('Title is required', 'error'); return; }
    if (!description) { showToast('Description is required', 'error'); return; }

    var formData = new FormData();
    formData.append('title', title);
    formData.append('description', description);
    formData.append('category', category);
    if (imageInput.files.length > 0) {
      formData.append('image', imageInput.files[0]);
    }

    var btn = $('createSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    postTicketForm('/api/tickets', formData, btn)
      .then(function() {
        // The form may have been closed, reopened and rewritten while this was
        // on its way: clear and close it only if it still holds what was sent.
        if ($('createTitle').value.trim() === title &&
            $('createDescription').value.trim() === description) {
          resetCreateForm();
          closeCreateModal();
        }
        showToast('Ticket submitted!', 'success');
        loadTickets();
        loadCounts();
      })
      .catch(function(e) { if (e !== TICKETS_OFF && !isAbort(e)) showToast(e.message, 'error'); })
      .finally(function() { btn.disabled = _ticketsOff; btn.textContent = 'Submit Ticket'; });
  }

  // ---- Ticket detail modal ----

  // Unsent comments, by ticket id, for this visit: the comment box is rebuilt
  // on every open, so a tap outside the card must not throw away what was
  // typed. Cleared once the comment is posted.
  var _commentDrafts = {};
  // Comments on their way, by ticket id (the text sent). A box rebuilt for
  // that ticket meanwhile (closed and reopened) waits for it instead of
  // offering a second send.
  var _commentSending = {};
  var _detailTicketId = null;

  function detailShowing(ticketId) {
    return !$('detailModal').classList.contains('hidden') && _detailTicketId === String(ticketId);
  }

  function openDetailModal(ticketId) {
    _detailTicketId = String(ticketId);
    $('detailModal').classList.remove('hidden');
    var content = $('detailContent');
    // Show loading
    while (content.firstChild) content.removeChild(content.firstChild);
    var loadingDiv = createEl('div', 'text-center text-steel-blue py-8');
    var spinner = createEl('span', 'material-symbols-outlined text-4xl mb-2 block opacity-50 animate-spin', 'progress_activity');
    loadingDiv.appendChild(spinner);
    loadingDiv.appendChild(createEl('p', '', 'Loading...'));
    content.appendChild(loadingDiv);

    ticketsJSON('/api/tickets/' + ticketId)
      .then(function(data) { renderDetailContent(data, data.comments || []); })
      .catch(function(err) {
        if (signal.aborted || isAbort(err)) return;   // left the page: nothing to say
        console.error('Detail modal error:', err); showToast('Failed to load ticket', 'error'); closeDetailModal();
      });
  }

  function closeDetailModal() {
    $('detailModal').classList.add('hidden');
    if (_ticketsOff) window.location.replace('/');
  }

  function renderDetailContent(ticket, comments) {
    var content = $('detailContent');
    while (content.firstChild) content.removeChild(content.firstChild);

    // Title
    content.appendChild(createEl('h3', 'text-lg font-bold text-frosted-blue mb-1 pr-8', ticket.title));

    // Creator (admin or own)
    if (ticket.creator_username) {
      content.appendChild(createEl('p', 'text-xs text-steel-blue mb-3', 'by @' + ticket.creator_username + ' · ' + timeAgo(ticket.created_at)));
    } else {
      content.appendChild(createEl('p', 'text-xs text-steel-blue mb-3', timeAgo(ticket.created_at)));
    }

    // Badges row
    var badgeRow = createEl('div', 'flex flex-wrap gap-2 mb-4');
    var catBadge = createEl('span', 'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ' + (CATEGORY_COLORS[ticket.category] || ''), CATEGORY_LABELS[ticket.category] || ticket.category);
    badgeRow.appendChild(catBadge);
    var statusLabel = (ticket.status || 'open').replace('_', ' ');
    var statusBadge = createEl('span', 'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ' + (STATUS_COLORS[ticket.status] || ''), statusLabel);
    badgeRow.appendChild(statusBadge);
    if (ticket.priority) {
      var priBadge = createEl('span', 'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ' + (PRIORITY_COLORS[ticket.priority] || ''), ticket.priority);
      badgeRow.appendChild(priBadge);
    }
    if (ticket.is_public) {
      badgeRow.appendChild(createEl('span', 'px-2.5 py-1 rounded-full text-[10px] font-bold uppercase bg-primary/20 text-frosted-blue', 'Public'));
    }
    content.appendChild(badgeRow);

    // Description
    content.appendChild(createEl('p', 'text-sm text-frosted-blue mb-4 whitespace-pre-wrap', ticket.description));

    // Image: the page's click listener opens it in the lightbox (data-action).
    if (ticket.image_path) {
      var img = document.createElement('img');
      img.src = ticket.image_path;
      img.className = 'w-full max-h-48 object-contain rounded-lg mb-4 cursor-pointer hover:opacity-80 transition-opacity';
      img.alt = 'Ticket attachment';
      img.setAttribute('data-action', 'lightbox');
      content.appendChild(img);
    }

    // Admin controls
    if (_isAdmin) {
      var controlsDiv = createEl('div', 'flex flex-wrap gap-2 mb-4 p-3 rounded-lg bg-frosted-blue/5 border border-steel-blue/20');

      // Status dropdown
      var statusSelect = document.createElement('select');
      statusSelect.className = 'px-2 py-1.5 bg-frosted-blue/[0.04] border border-steel-blue/20 rounded-lg text-frosted-blue text-xs focus:outline-none focus:ring-1 focus:ring-primary/30';
      ['open', 'in_progress', 'resolved', 'closed'].forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s.replace('_', ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
        if (s === ticket.status) opt.selected = true;
        statusSelect.appendChild(opt);
      });

      // Priority dropdown
      var prioritySelect = document.createElement('select');
      prioritySelect.className = 'px-2 py-1.5 bg-frosted-blue/[0.04] border border-steel-blue/20 rounded-lg text-frosted-blue text-xs focus:outline-none focus:ring-1 focus:ring-primary/30';
      var noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'No Priority';
      if (!ticket.priority) noneOpt.selected = true;
      prioritySelect.appendChild(noneOpt);
      ['low', 'medium', 'high', 'urgent'].forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p.charAt(0).toUpperCase() + p.slice(1);
        if (p === ticket.priority) opt.selected = true;
        prioritySelect.appendChild(opt);
      });

      // Public toggle
      var pubLabel = createEl('label', 'flex items-center gap-2 text-xs text-steel-blue cursor-pointer');
      var pubCheck = document.createElement('input');
      pubCheck.type = 'checkbox';
      pubCheck.checked = ticket.is_public;
      pubCheck.className = 'rounded border-steel-blue/30 bg-frosted-blue/[0.04] text-primary focus:ring-primary/30';
      pubLabel.appendChild(pubCheck);
      pubLabel.appendChild(document.createTextNode('Public'));

      // Save button
      var saveBtn = createEl('button', 'px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/80 text-bright text-xs font-bold transition-all ml-auto', 'Save');
      saveBtn.addEventListener('click', function() {
        fetch('/api/admin/tickets/' + ticket.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: statusSelect.value,
            priority: prioritySelect.value || null,
            is_public: pubCheck.checked,
          }),
          signal: signal,
        })
          .then(function(r) { return r.json(); })
          .then(function() {
            showToast('Ticket updated', 'success');
            loadTickets();
            loadCounts();
          })
          .catch(function(err) { if (!isAbort(err)) showToast('Failed to update', 'error'); });
      }, { signal: signal });

      // Delete button
      var delBtn = createEl('button', 'px-3 py-1.5 rounded-lg bg-frosted-blue/[0.06] hover:bg-frosted-blue/10 text-frosted-blue ring-1 ring-inset ring-[rgb(var(--ws-status-err))] text-xs font-bold transition-all', 'Delete');
      delBtn.addEventListener('click', function() {
        window.WSUI.confirm({
          title: 'Delete this ticket?',
          body: 'The ticket and its comments are removed for good.',
          confirmLabel: 'Delete ticket', cancelLabel: 'Keep it', danger: true
        }).then(function (ok) {
          if (!ok) return;
          fetch('/api/admin/tickets/' + ticket.id, { method: 'DELETE', signal: signal })
            .then(function(r) { return r.json(); })
            .then(function() {
              closeDetailModal();
              showToast('Ticket deleted', 'success');
              loadTickets();
              loadCounts();
            })
            .catch(function(err) { if (!isAbort(err)) showToast('Failed to delete', 'error'); });
        });
      }, { signal: signal });

      controlsDiv.appendChild(statusSelect);
      controlsDiv.appendChild(prioritySelect);
      controlsDiv.appendChild(pubLabel);
      controlsDiv.appendChild(saveBtn);
      controlsDiv.appendChild(delBtn);
      content.appendChild(controlsDiv);
    }

    // Separator
    content.appendChild(createEl('div', 'border-t border-steel-blue/20 my-4'));

    // Comments header
    content.appendChild(createEl('p', 'text-[10px] text-steel-blue font-bold uppercase tracking-wider mb-3', 'Comments (' + comments.length + ')'));

    // Comments list
    if (comments.length === 0) {
      content.appendChild(createEl('p', 'text-sm text-frosted-blue/70 italic mb-4', 'No comments yet'));
    } else {
      var commentsList = createEl('div', 'space-y-3 mb-4');
      comments.forEach(function(comment) {
        var cDiv = createEl('div', 'p-3 rounded-lg ' + (comment.is_admin ? 'bg-primary/10 border border-primary/20' : 'bg-frosted-blue/5 border border-steel-blue/10'));

        // Author + time
        var cHeader = createEl('div', 'flex items-center justify-between mb-1.5');
        var authorText = comment.is_admin ? 'Admin' : (comment.author_name || 'You');
        var cAuthor = createEl('span', 'text-xs font-bold ' + 'text-frosted-blue', authorText);
        if (comment.is_admin) {
          var adminBadge = createEl('span', 'ml-1.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-primary/20 text-frosted-blue uppercase', 'Staff');
          var authorWrap = createEl('div', 'flex items-center');
          authorWrap.appendChild(cAuthor);
          authorWrap.appendChild(adminBadge);
          cHeader.appendChild(authorWrap);
        } else {
          cHeader.appendChild(cAuthor);
        }
        cHeader.appendChild(createEl('span', 'text-[10px] text-frosted-blue/70', timeAgo(comment.created_at)));
        cDiv.appendChild(cHeader);

        // Message
        cDiv.appendChild(createEl('p', 'text-sm text-frosted-blue whitespace-pre-wrap', comment.message));

        // Image (opens in the lightbox, like the ticket's)
        if (comment.image_path) {
          var cImg = document.createElement('img');
          cImg.src = comment.image_path;
          cImg.className = 'mt-2 max-h-32 rounded-lg cursor-pointer hover:opacity-80 transition-opacity';
          cImg.alt = 'Comment attachment';
          cImg.setAttribute('data-action', 'lightbox');
          cDiv.appendChild(cImg);
        }

        commentsList.appendChild(cDiv);
      });
      content.appendChild(commentsList);
    }

    // Add comment form (only if own ticket or admin)
    if (ticket.is_own || _isAdmin) {
      var formDiv = createEl('div', 'border-t border-steel-blue/20 pt-4');
      var textarea = document.createElement('textarea');
      textarea.id = 'commentInput';
      textarea.placeholder = 'Write a comment...';
      textarea.rows = 3;
      textarea.value = _commentDrafts[ticket.id] || '';
      textarea.addEventListener('input', function() {
        if (textarea.value) _commentDrafts[ticket.id] = textarea.value;
        else delete _commentDrafts[ticket.id];
      }, { signal: signal });
      textarea.className = 'w-full px-3 py-2.5 bg-frosted-blue/[0.04] border border-steel-blue/20 rounded-lg text-frosted-blue placeholder-frosted-blue/70 text-sm resize-none focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 transition-all mb-2';

      var fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/webp';
      fileInput.className = 'w-full text-sm text-steel-blue file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-primary/20 file:text-frosted-blue hover:file:bg-primary/30 transition-all mb-2';

      var sendBtn = createEl('button', 'w-full py-2.5 rounded-lg bg-primary hover:bg-primary/80 text-bright text-sm font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed', 'Add Comment');
      sendBtn.id = 'commentSendBtn';
      sendBtn.setAttribute('data-ticket-id', String(ticket.id));
      if (Object.prototype.hasOwnProperty.call(_commentSending, ticket.id)) {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
      }
      sendBtn.addEventListener('click', function() {
        if (_ticketsOff) return;
        if (Object.prototype.hasOwnProperty.call(_commentSending, ticket.id)) return;
        var msg = textarea.value.trim();
        if (!msg) { showToast('Comment cannot be empty', 'error'); return; }

        var formData = new FormData();
        formData.append('message', msg);
        if (fileInput.files.length > 0) {
          formData.append('image', fileInput.files[0]);
        }

        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
        _commentSending[ticket.id] = msg;

        postTicketForm('/api/tickets/' + ticket.id + '/comments', formData, sendBtn)
          .then(function() {
            // Newer text typed meanwhile stays; only the sent text is cleared,
            // compared trimmed as it was posted (a stray space is not new text).
            if ((_commentDrafts[ticket.id] || '').trim() === msg) delete _commentDrafts[ticket.id];
            showToast('Comment added', 'success');
            if (detailShowing(ticket.id)) openDetailModal(ticket.id); // Refresh detail
          })
          .catch(function(e) { if (e !== TICKETS_OFF && !isAbort(e)) showToast(e.message, 'error'); })
          .finally(function() { sendBtn.disabled = _ticketsOff; sendBtn.textContent = 'Add Comment';
            delete _commentSending[ticket.id];
            // The box on screen for this ticket may be a rebuilt one.
            var live = $('commentSendBtn');
            if (live && live !== sendBtn && live.getAttribute('data-ticket-id') === String(ticket.id)) {
              live.disabled = _ticketsOff;
              live.textContent = 'Add Comment';
            }
          });
      }, { signal: signal });

      formDiv.appendChild(textarea);
      formDiv.appendChild(fileInput);
      formDiv.appendChild(sendBtn);
      content.appendChild(formDiv);
    }
  }

  // ---- Lightbox ----

  function openLightbox(src) {
    $('lightboxImg').src = src;
    $('lightbox').classList.remove('hidden');
    $('lightbox').classList.add('flex');
  }

  function closeLightbox() {
    $('lightbox').classList.add('hidden');
    $('lightbox').classList.remove('flex');
  }

  // ---- Wiring: one listener per kind, on the page or with its signal ----

  root.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    switch (el.getAttribute('data-action')) {
      case 'open-create': openCreateModal(); break;
      case 'close-create': closeCreateModal(); break;
      case 'submit-ticket': submitNewTicket(); break;
      case 'filter': setFilter(el.getAttribute('data-filter')); break;
      case 'cat-filter': setCategoryFilter(el.getAttribute('data-catfilter')); break;
      case 'prev-page': prevPage(); break;
      case 'next-page': nextPage(); break;
      case 'open-ticket': openDetailModal(parseInt(el.getAttribute('data-ticket-id'), 10)); break;
      case 'close-detail': closeDetailModal(); break;
      case 'lightbox': openLightbox(el.getAttribute('src')); break;
      case 'close-lightbox': closeLightbox(); break;
    }
  }, { signal: signal });

  // Escape closes the topmost of this page's overlays: the image lightbox,
  // then the ticket, then the new-ticket form. Not while an input method is
  // composing (Escape then cancels the composition). A WSUI dialog (the
  // delete confirmation) answers its own Escape first and stops it reaching
  // here; the check below is the belt to that.
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape' || e.isComposing || document.querySelector('.ws-dialog')) return;
    var shown = function(id) { return !$(id).classList.contains('hidden'); };
    if (shown('lightbox')) closeLightbox();
    else if (shown('detailModal')) closeDetailModal();
    else if (shown('createModal')) closeCreateModal();
  }, { signal: signal });

  // Show the cross-link hint only while Playback Issue is selected - it is the
  // one ticket category that belongs on the other help page more often than not.
  (function () {
    var cat = $('createCategory');
    var hint = $('playbackRedirectHint');
    if (!cat || !hint) return;
    function sync() {
      var overlaps = cat.value === 'playback_issue';
      hint.classList.toggle('hidden', !overlaps);
      hint.classList.toggle('block', overlaps);
      // The wiki pointer follows the same rule, and stays hidden entirely when
      // no admin has chosen a page for it.
      if (overlaps) {
        if (window.WikiHook) WikiHook.init(ctx, { container: 'wikiHookPlayback', hook: 'playback', lead: 'It may already be answered here:' });
      } else {
        var wikiBox = $('wikiHookPlayback');
        if (wikiBox) wikiBox.classList.add('hidden');
      }
    }
    cat.addEventListener('change', sync, { signal: signal });
    sync();
  })();

  if (window.WikiHook) WikiHook.init(ctx, { container: 'wikiHookTickets', hook: 'tickets', lead: 'Before you contact support:' });

  // Refresh every 30 s (a poll on a page already on screen reads nothing at
  // once: the first read is below).
  _stopRefresh = ctx.poll(function() { loadTickets(); loadCounts(); }, REFRESH_MS);

  // The counts and the list are on screen (the last visit's copy, or
  // fetched) before mount resolves, so Back and Forward restore the scroll
  // onto them.
  await Promise.all([loadTickets(), loadCounts()]);
}
