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
 * signal. The ticket cards are buttons, so the list works from the keyboard.
 * The three overlays are dialogs (WSUI.modal: focus in, Tab kept inside,
 * Escape closes the topmost, focus back) and live inside #wsPage, so leaving
 * the page takes them away, open or not. The wiki pointers are wiki-hook.js (a page helper
 * script, data-ws-page-script), started from mount with the same ctx.
 */

const REFRESH_MS = 30000;
const PAGE_SIZE = 12;

// ---- Category display config ----
const CATEGORY_LABELS = {
  media_request: 'Media request',
  playback_issue: 'Playback problem',
  account_issue: 'Account problem',
  feature_suggestion: 'Suggestion',
  other: 'Other'
};
const STATUS_LABELS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
const PRIORITY_LABELS = { low: 'Low priority', medium: 'Medium priority', high: 'High priority', urgent: 'Urgent' };
// One chip, as the Books pages draw it: sentence case, 13px, fully rounded.
const CHIP = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-label font-semibold ';
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

const OFF_NOTICE = 'Tickets have been turned off, so this can’t be sent right now.';
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

// The site's one relative date (auth.js), in sentence case: it stands alone.
function timeAgo(isoString) { return getTimeAgo(isoString, true); }

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
  // The open dialogs (WSUI.modal), by overlay id.
  var _dialogs = {};

  function openDialog(id, opts) {
    if (_dialogs[id]) return;
    var overlay = $(id);
    overlay.classList.remove('hidden');
    if (id === 'lightbox') overlay.classList.add('flex');
    _dialogs[id] = WSUI.modal(overlay, {
      initial: opts && opts.initial,
      onClose: function () {
        overlay.classList.add('hidden');
        if (id === 'lightbox') overlay.classList.remove('flex');
        delete _dialogs[id];
        if (opts && opts.onClose) opts.onClose();
      }
    });
  }
  function closeDialog(id) { if (_dialogs[id]) _dialogs[id].close(); }

  // ---- Filter tabs ----

  function setFilter(status) {
    _currentFilter = status;
    _currentPage = 0;
    root.querySelectorAll('.filter-tab').forEach(function(btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-filter') === status ? 'true' : 'false');
    });
    loadTickets();
  }

  function setCategoryFilter(cat) {
    _currentCatFilter = cat;
    _currentPage = 0;
    root.querySelectorAll('.cat-filter-tab').forEach(function(btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-catfilter') === cat ? 'true' : 'false');
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
    goHome();
  }

  // Home, in place of this entry, as the server's page gate would send them:
  // a soft navigation, so whatever plays in #wsPlayer plays on.
  function goHome() {
    if (window.WS && WS.router && typeof WS.router.navigate === 'function') WS.router.navigate('/', { replace: true });
    else window.location.replace('/');
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
    var notice = createEl('p', 'text-body text-frosted-blue/80 bg-frosted-blue/[0.04] rounded-inner px-3 py-2 mb-3', OFF_NOTICE);
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
      // An error page that is not JSON (a proxy's 413, say) still rejects
      // with a message, not a parse error.
      return r.json().catch(function () { return {}; }).then(function (d) {
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
        // No figure to show: the box keeps its height with a blank line.
        WS.arrive('counts', function () {
          ['statTotal', 'statOpen', 'statInProgress', 'statResolved'].forEach(function (id) { $(id).textContent = '\u00a0'; });
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
      // A button, so the whole card opens the ticket from a click or the
      // keyboard; the page's click listener opens it (data-action).
      var card = createEl('button', 'block w-full text-left rounded-inner bg-frosted-blue/[0.04] hover:bg-frosted-blue/[0.07] p-4 transition-colors');
      card.type = 'button';
      card.setAttribute('data-action', 'open-ticket');
      card.setAttribute('data-ticket-id', String(ticket.id));

      // Top row: title + badges (stacked on mobile, side-by-side on desktop)
      var topRow = createEl('span', 'flex flex-col lg:flex-row lg:items-start lg:justify-between gap-1.5 lg:gap-3 mb-2');

      var titleDiv = createEl('span', 'block flex-1 min-w-0');
      var titleEl = createEl('span', 'block text-frosted-blue font-semibold text-body truncate', ticket.title);
      titleDiv.appendChild(titleEl);

      // Creator (admin only)
      if (_isAdmin && ticket.creator_username) {
        var creatorEl = createEl('span', 'block text-label text-frosted-blue/70 mt-0.5', '@' + ticket.creator_username);
        titleDiv.appendChild(creatorEl);
      }

      var badgeDiv = createEl('span', 'flex items-center gap-1.5 flex-wrap lg:shrink-0 lg:justify-end');

      // Category badge
      var catBadge = createEl('span', CHIP + (CATEGORY_COLORS[ticket.category] || CATEGORY_COLORS.other), CATEGORY_LABELS[ticket.category] || ticket.category);
      badgeDiv.appendChild(catBadge);

      // Status badge
      var statusBadge = createEl('span', CHIP + (STATUS_COLORS[ticket.status] || STATUS_COLORS.open), STATUS_LABELS[ticket.status] || STATUS_LABELS.open);
      badgeDiv.appendChild(statusBadge);

      // Priority badge (if set)
      if (ticket.priority) {
        var priBadge = createEl('span', CHIP + (PRIORITY_COLORS[ticket.priority] || ''), PRIORITY_LABELS[ticket.priority] || ticket.priority);
        badgeDiv.appendChild(priBadge);
      }

      topRow.appendChild(titleDiv);
      topRow.appendChild(badgeDiv);
      card.appendChild(topRow);

      // Bottom row: description snippet + time
      var bottomRow = createEl('span', 'flex items-center justify-between gap-3');
      var descSnippet = createEl('span', 'text-label text-frosted-blue/70 truncate flex-1', ticket.description);
      var timeEl = createEl('span', 'text-label text-frosted-blue/70 shrink-0', timeAgo(ticket.created_at));
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
    openDialog('createModal', { initial: $('createTitle'), onClose: function () { if (_ticketsOff) goHome(); } });
  }

  function resetCreateForm() {
    $('createTitle').value = '';
    $('createDescription').value = '';
    var cat = $('createCategory');
    cat.value = 'media_request';
    cat.dispatchEvent(new Event('change'));   // the playback hint follows the category
    $('createImage').value = '';
    clearInvalid();
  }

  function closeCreateModal() { closeDialog('createModal'); }

  // ---- Validation: the field says what is missing, not a toast ----

  // Settings' pattern (.ws-invalid): the field takes the error ring and the
  // line under it says what to do; the first one missing takes the focus.
  function markInvalid(id, bad) {
    var field = $(id);
    field.classList.toggle('ws-invalid', bad);
    field.setAttribute('aria-invalid', bad ? 'true' : 'false');
    $(id + 'Error').classList.toggle('hidden', !bad);
  }
  function clearInvalid() {
    markInvalid('createTitle', false);
    markInvalid('createDescription', false);
  }

  function submitNewTicket() {
    if (_ticketsOff) return;
    var title = $('createTitle').value.trim();
    var description = $('createDescription').value.trim();
    var category = $('createCategory').value;
    var imageInput = $('createImage');

    markInvalid('createTitle', !title);
    markInvalid('createDescription', !description);
    if (!title) { $('createTitle').focus(); return; }
    if (!description) { $('createDescription').focus(); return; }

    var formData = new FormData();
    formData.append('title', title);
    formData.append('description', description);
    formData.append('category', category);
    if (imageInput.files.length > 0) {
      formData.append('image', imageInput.files[0]);
    }

    var btn = $('createSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Sending\u2026';

    postTicketForm('/api/tickets', formData, btn)
      .then(function() {
        // The form may have been closed, reopened and rewritten while this was
        // on its way: clear and close it only if it still holds what was sent.
        if ($('createTitle').value.trim() === title &&
            $('createDescription').value.trim() === description) {
          resetCreateForm();
          closeCreateModal();
        }
        showToast('Ticket sent', 'success');
        loadTickets();
        loadCounts();
      })
      .catch(function(e) { if (e !== TICKETS_OFF && !isAbort(e)) showToast(e.message, 'error'); })
      .finally(function() { btn.disabled = _ticketsOff; btn.textContent = 'Send ticket'; });
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
    return !!_dialogs.detailModal && _detailTicketId === String(ticketId);
  }

  function openDetailModal(ticketId) {
    _detailTicketId = String(ticketId);
    var content = $('detailContent');
    // Show loading
    while (content.firstChild) content.removeChild(content.firstChild);
    var loading = createEl('p', 'text-frosted-blue/70 text-body py-8 text-center', 'Loading the ticket\u2026');
    loading.id = 'ticketDetailTitle';
    content.appendChild(loading);
    openDialog('detailModal', { onClose: function () { if (_ticketsOff) goHome(); } });

    ticketsJSON('/api/tickets/' + ticketId)
      .then(function(data) { renderDetailContent(data, data.comments || []); })
      .catch(function(err) {
        if (signal.aborted || isAbort(err)) return;   // left the page: nothing to say
        console.error('Detail modal error:', err); showToast('Failed to load ticket', 'error'); closeDetailModal();
      });
  }

  function closeDetailModal() { closeDialog('detailModal'); }

  function renderDetailContent(ticket, comments) {
    var content = $('detailContent');
    while (content.firstChild) content.removeChild(content.firstChild);

    // Title
    var heading = createEl('h2', 'text-h3 font-bold text-frosted-blue mb-1 pr-10', ticket.title);
    heading.id = 'ticketDetailTitle';
    content.appendChild(heading);

    // Creator (admin or own)
    if (ticket.creator_username) {
      content.appendChild(createEl('p', 'text-label text-frosted-blue/70 mb-3', 'From @' + ticket.creator_username + ', ' + getTimeAgo(ticket.created_at)));
    } else {
      content.appendChild(createEl('p', 'text-label text-frosted-blue/70 mb-3', timeAgo(ticket.created_at)));
    }

    // Badges row
    var badgeRow = createEl('div', 'flex flex-wrap gap-2 mb-4');
    var catBadge = createEl('span', CHIP + (CATEGORY_COLORS[ticket.category] || ''), CATEGORY_LABELS[ticket.category] || ticket.category);
    badgeRow.appendChild(catBadge);
    var statusBadge = createEl('span', CHIP + (STATUS_COLORS[ticket.status] || ''), STATUS_LABELS[ticket.status] || STATUS_LABELS.open);
    badgeRow.appendChild(statusBadge);
    if (ticket.priority) {
      var priBadge = createEl('span', CHIP + (PRIORITY_COLORS[ticket.priority] || ''), PRIORITY_LABELS[ticket.priority] || ticket.priority);
      badgeRow.appendChild(priBadge);
    }
    if (ticket.is_public) {
      badgeRow.appendChild(createEl('span', CHIP + 'bg-primary/20 text-frosted-blue', 'Public'));
    }
    content.appendChild(badgeRow);

    // Description
    content.appendChild(createEl('p', 'text-body text-frosted-blue mb-4 whitespace-pre-wrap', ticket.description));

    // Image: a button around it opens it in the lightbox (data-action), so
    // the larger view is reachable from the keyboard too.
    if (ticket.image_path) {
      content.appendChild(attachmentButton(ticket.image_path, 'Attached screenshot', 'w-full max-h-48 object-contain', 'block w-full mb-4'));
    }

    // Admin controls
    if (_isAdmin) {
      var controlsDiv = createEl('div', 'flex flex-wrap items-center gap-2 mb-4 p-3 rounded-inner bg-frosted-blue/[0.04]');

      // Status dropdown
      var statusSelect = document.createElement('select');
      statusSelect.setAttribute('aria-label', 'Status');
      statusSelect.className = 'h-10 pl-3 pr-9 bg-frosted-blue/[0.04] border border-frosted-blue/10 rounded-btn text-frosted-blue text-label focus:outline-none focus:ring-2 focus:ring-focus';
      ['open', 'in_progress', 'resolved', 'closed'].forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s;
        opt.textContent = STATUS_LABELS[s];
        if (s === ticket.status) opt.selected = true;
        statusSelect.appendChild(opt);
      });

      // Priority dropdown
      var prioritySelect = document.createElement('select');
      prioritySelect.setAttribute('aria-label', 'Priority');
      prioritySelect.className = 'h-10 pl-3 pr-9 bg-frosted-blue/[0.04] border border-frosted-blue/10 rounded-btn text-frosted-blue text-label focus:outline-none focus:ring-2 focus:ring-focus';
      var noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'No priority';
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
      var pubLabel = createEl('label', 'flex items-center gap-2 text-label text-frosted-blue/80 cursor-pointer');
      var pubCheck = document.createElement('input');
      pubCheck.type = 'checkbox';
      pubCheck.checked = ticket.is_public;
      pubCheck.className = 'rounded border-steel-blue/30 bg-frosted-blue/[0.04] text-primary focus:ring-focus';
      pubLabel.appendChild(pubCheck);
      pubLabel.appendChild(document.createTextNode('Public'));

      // Save button
      var saveBtn = createEl('button', 'h-10 px-4 rounded-btn bg-primary hover:bg-primary/90 text-bright text-label font-semibold transition-colors ml-auto', 'Save');
      saveBtn.type = 'button';
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
          // Only a 2xx is success: a ticket deleted meanwhile answers 404
          // {"detail": "Ticket not found"}, and that detail is what shows.
          .then(function (r) {
            if (r.ok) return r.json();
            return r.json().catch(function () { return {}; }).then(function (b) {
              var e = new Error(b.detail || 'Failed to update'); e.server = true; throw e;
            });
          })
          .then(function() {
            showToast('Ticket updated', 'success');
            loadTickets();
            loadCounts();
          })
          .catch(function(err) { if (!isAbort(err)) showToast(err.server ? err.message : 'Failed to update', 'error'); });
      }, { signal: signal });

      // Delete button
      var delBtn = createEl('button', 'h-10 px-4 rounded-btn bg-frosted-blue/[0.06] hover:bg-frosted-blue/10 text-frosted-blue ring-1 ring-inset ring-[rgb(var(--ws-status-err))] text-label font-semibold transition-colors', 'Delete');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function() {
        window.WSUI.confirm({
          title: 'Delete this ticket?',
          body: 'The ticket and its comments are removed for good.',
          confirmLabel: 'Delete ticket', cancelLabel: 'Keep it', danger: true
        }).then(function (ok) {
          if (!ok) return;
          // 204 No Content on success: nothing to parse. A failure (a ticket
          // already gone, say) carries the server's detail, which is shown.
          fetch('/api/admin/tickets/' + ticket.id, { method: 'DELETE', signal: signal })
            .then(function (r) {
              if (r.ok) return;
              return r.json().catch(function () { return {}; }).then(function (b) {
                var e = new Error(b.detail || 'Failed to delete'); e.server = true; throw e;
              });
            })
            .then(function() {
              closeDetailModal();
              showToast('Ticket deleted', 'success');
              loadTickets();
              loadCounts();
            })
            .catch(function(err) { if (!isAbort(err)) showToast(err.server ? err.message : 'Failed to delete', 'error'); });
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
    content.appendChild(createEl('div', 'border-t border-frosted-blue/10 my-4'));

    // Comments header
    content.appendChild(createEl('h3', 'text-body font-semibold text-frosted-blue mb-3', comments.length === 1 ? '1 comment' : comments.length + ' comments'));

    // Comments list
    if (comments.length === 0) {
      content.appendChild(createEl('p', 'text-body text-frosted-blue/70 mb-4', 'No comments yet.'));
    } else {
      var commentsList = createEl('div', 'space-y-3 mb-4');
      comments.forEach(function(comment) {
        var cDiv = createEl('div', 'p-3 rounded-inner ' + (comment.is_admin ? 'bg-primary/10' : 'bg-frosted-blue/[0.04]'));

        // Author + time
        var cHeader = createEl('div', 'flex items-center justify-between gap-3 mb-1.5');
        var authorText = comment.is_admin ? 'Admin' : (comment.author_name || 'You');
        var cAuthor = createEl('span', 'text-label font-semibold text-frosted-blue', authorText);
        cHeader.appendChild(cAuthor);
        cHeader.appendChild(createEl('span', 'text-label text-frosted-blue/70', timeAgo(comment.created_at)));
        cDiv.appendChild(cHeader);

        // Message
        cDiv.appendChild(createEl('p', 'text-body text-frosted-blue whitespace-pre-wrap', comment.message));

        // Image (opens in the lightbox, like the ticket's)
        if (comment.image_path) {
          cDiv.appendChild(attachmentButton(comment.image_path, 'Attached image', 'max-h-32', 'mt-2 inline-block'));
        }

        commentsList.appendChild(cDiv);
      });
      content.appendChild(commentsList);
    }

    // Add comment form (only if own ticket or admin)
    if (ticket.is_own || _isAdmin) {
      var formDiv = createEl('div', 'border-t border-frosted-blue/10 pt-4');
      var commentLabel = createEl('label', 'block text-label font-semibold text-frosted-blue/70 mb-1.5', 'Add a comment');
      commentLabel.htmlFor = 'commentInput';
      formDiv.appendChild(commentLabel);
      var textarea = document.createElement('textarea');
      textarea.id = 'commentInput';
      textarea.rows = 3;
      textarea.setAttribute('aria-describedby', 'commentInputError');
      var commentError = createEl('p', 'hidden text-label font-semibold text-status-err-text -mt-1 mb-2', 'Write something first.');
      commentError.id = 'commentInputError';
      textarea.value = _commentDrafts[ticket.id] || '';
      textarea.addEventListener('input', function() {
        if (textarea.value) _commentDrafts[ticket.id] = textarea.value;
        else delete _commentDrafts[ticket.id];
        if (textarea.value.trim()) { textarea.classList.remove('ws-invalid'); commentError.classList.add('hidden'); }
      }, { signal: signal });
      textarea.className = 'w-full px-3.5 py-2.5 bg-frosted-blue/[0.04] border border-frosted-blue/10 rounded-btn text-frosted-blue placeholder-frosted-blue/70 text-body resize-none focus:outline-none focus:ring-2 focus:ring-focus focus:border-transparent transition-colors mb-2';

      var fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/webp';
      fileInput.setAttribute('aria-label', 'Attach an image (optional)');
      fileInput.className = 'w-full text-body text-frosted-blue/70 file:mr-3 file:py-1.5 file:px-3 file:rounded-btn file:border-0 file:text-label file:font-semibold file:bg-frosted-blue/[0.07] file:text-frosted-blue hover:file:bg-frosted-blue/10 transition-colors mb-2';

      var sendBtn = createEl('button', 'ws-lift w-full py-2.5 rounded-btn bg-primary hover:bg-primary/90 text-bright text-body font-semibold transition-colors disabled:opacity-30 disabled:cursor-not-allowed', 'Post comment');
      sendBtn.type = 'button';
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
        textarea.classList.toggle('ws-invalid', !msg);
        textarea.setAttribute('aria-invalid', msg ? 'false' : 'true');
        commentError.classList.toggle('hidden', !!msg);
        if (!msg) { textarea.focus(); return; }

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
            showToast('Comment posted', 'success');
            if (detailShowing(ticket.id)) openDetailModal(ticket.id); // Refresh detail
          })
          .catch(function(e) { if (e !== TICKETS_OFF && !isAbort(e)) showToast(e.message, 'error'); })
          .finally(function() { sendBtn.disabled = _ticketsOff; sendBtn.textContent = 'Post comment';
            delete _commentSending[ticket.id];
            // The box on screen for this ticket may be a rebuilt one.
            var live = $('commentSendBtn');
            if (live && live !== sendBtn && live.getAttribute('data-ticket-id') === String(ticket.id)) {
              live.disabled = _ticketsOff;
              live.textContent = 'Post comment';
            }
          });
      }, { signal: signal });

      formDiv.appendChild(textarea);
      formDiv.appendChild(commentError);
      formDiv.appendChild(fileInput);
      formDiv.appendChild(sendBtn);
      content.appendChild(formDiv);
    }
  }

  // ---- Lightbox ----

  // An attached image as a button that opens it larger. The button carries
  // the name; the picture inside is described by it, so its alt is empty.
  function attachmentButton(src, label, imgClass, btnClass) {
    var btn = createEl('button', btnClass + ' rounded-btn overflow-hidden hover:opacity-80 transition-opacity');
    btn.type = 'button';
    btn.setAttribute('data-action', 'lightbox');
    btn.setAttribute('data-src', src);
    btn.setAttribute('aria-label', label + ', open it larger');
    var img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.className = imgClass + ' rounded-btn';
    btn.appendChild(img);
    return btn;
  }

  function openLightbox(src, label) {
    $('lightboxImg').src = src;
    $('lightboxImg').alt = label || 'Attached image';
    openDialog('lightbox');
  }

  function closeLightbox() { closeDialog('lightbox'); }

  // ---- Wiring: one listener per kind, on the page or with its signal ----

  root.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    switch (el.getAttribute('data-action')) {
      case 'open-create': openCreateModal(); break;
      case 'close-create': closeCreateModal(); break;
      case 'filter': setFilter(el.getAttribute('data-filter')); break;
      case 'cat-filter': setCategoryFilter(el.getAttribute('data-catfilter')); break;
      case 'prev-page': prevPage(); break;
      case 'next-page': nextPage(); break;
      case 'open-ticket': openDetailModal(parseInt(el.getAttribute('data-ticket-id'), 10)); break;
      case 'close-detail': closeDetailModal(); break;
      case 'lightbox': openLightbox(el.getAttribute('data-src'), (el.getAttribute('aria-label') || '').replace(/, open it larger$/, '')); break;
      case 'close-lightbox': closeLightbox(); break;
    }
  }, { signal: signal });

  // Escape closes the topmost of this page's overlays (the image lightbox,
  // then the ticket, then the new-ticket form): WSUI.modal's stack answers it.
  // The form sends on submit, so Enter in the subject sends too.
  $('createForm').addEventListener('submit', function (e) {
    e.preventDefault();
    submitNewTicket();
  }, { signal: signal });
  ['createTitle', 'createDescription'].forEach(function (id) {
    $(id).addEventListener('input', function () { if ($(id).value.trim()) markInvalid(id, false); }, { signal: signal });
  });

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
