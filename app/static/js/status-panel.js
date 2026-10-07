/**
 * WebServarr: the service status panel.
 *
 * Opens from the header's status pill (#systemStatus, from lg) as a popover:
 * on hover after a short pause (it closes again when the pointer leaves), or
 * pinned open by a click or Enter, with a Close button. Escape, a click
 * outside, focus leaving it, another header menu opening or a page swap
 * close it. Below lg the top bar's status chip (#wsStatusChip) opens the
 * same panel as a bottom sheet (a modal <dialog>, like More).
 *
 * The panel lists every service the pill counts, problems first (the
 * popover sets them in two columns, read across then down, so the problems
 * take the top band): its state in plain words, its uptime over the window
 * the viewer picked (24 hours, 30 days or all time; remembered in this
 * browser per user, see RANGE_KEY),
 * a strip of its last 50 checks and a line of their reply times (a gap
 * where a check got no reply). The data is WS.serviceStatus, the pill's own
 * request; shell.js owns the pill, the chip and the words for the overall
 * state, and this module reads its model (WS.statusModel, WS.statusSummary).
 *
 * Document-lifetime: the header and the top bar are the shell's and stay
 * across soft navigation, so this runs once and its listeners stay.
 * Text is written with textContent only.
 */
(function () {
  'use strict';

  var WS = window.WS;
  var pill = document.getElementById('systemStatus');
  var chip = document.getElementById('wsStatusChip');
  if (!WS || !WS.serviceStatus || (!pill && !chip)) return;

  var OPEN_DELAY = 220;        // hover this long before the popover opens
  var CLOSE_DELAY = 320;       // and away this long before it closes
  var REFRESH_MS = 30000;      // while open, asked again this often
  var SHEET_CLOSE_MS = 200;    // the sheet's slide away (theme.css .ws-sheet.is-closing)
  var SWIPE_CLOSE_PX = 80;
  var SWIPE_FLING = 0.5;
  var MIN = 60000;
  var SVG = 'http://www.w3.org/2000/svg';

  var RANGES = [
    { id: '24h', label: '24 hours', note: 'past day' },
    { id: '30d', label: '30 days', note: 'past 30 days' },
    { id: 'all', label: 'All time', note: 'all time' }
  ];
  // Problems first; services in the same state keep Uptime Kuma's order.
  var RANK = { down: 0, trouble: 1, slow: 2, maint: 3, unknown: 4, up: 5 };

  // ---- The uptime window, remembered per user in this browser ----
  //
  // localStorage, not the server: WebServarr has no general per-user
  // preference store (the player's and the notifications' are tied to those
  // features and their identities), and this is a viewing convenience that
  // may differ by device. Private mode or blocked storage just means 24 hours.
  var RANGE_KEY = 'ws:' + (WS.user && WS.user.username ? WS.user.username : 'anon') + ':status-range';
  function readRange() {
    try {
      var v = localStorage.getItem(RANGE_KEY);
      for (var i = 0; i < RANGES.length; i++) if (RANGES[i].id === v) return v;
    } catch (e) { /* storage blocked */ }
    return '24h';
  }
  function saveRange(v) {
    try { localStorage.setItem(RANGE_KEY, v); } catch (e) { /* storage blocked */ }
  }
  var range = readRange();

  // ---- Words ----
  function dur(ms) {
    var m = Math.max(1, Math.round(ms / MIN));
    if (m < 90) return m + ' min';
    var h = Math.round(m / 60);
    return h < 48 ? h + ' h' : Math.round(h / 24) + ' days';
  }
  function fmtMs(v) { return v >= 1000 ? (v / 1000).toFixed(1) + ' s' : v + ' ms'; }
  function fmtUp(v) {
    if (v === 100) return '100%';
    var s = v.toFixed(1);
    if (s === '100.0') s = v.toFixed(2);   // 99.97 is not 100
    return s + '%';
  }
  // How long the current run has lasted: from its first check, or "over"
  // the whole window when it began before the oldest check we have.
  function runFor(m, now) {
    if (m.since) return dur(now - m.since);
    var beats = m.service.beats || [];
    var first = beats.length ? Date.parse(beats[0].time) : NaN;
    return isNaN(first) ? '' : 'over ' + dur(now - first);
  }
  function stateWords(m, now) {
    var t = runFor(m, now);
    switch (m.k) {
      case 'up': return 'Running';
      case 'down': return t ? 'Down for ' + t : 'Down';
      case 'slow': return t ? 'Slow for ' + t : 'Slow';
      case 'trouble': return 'Having trouble';
      case 'maint': return 'Down for planned work';
      default: return 'No answer';
    }
  }
  function name(m) { return m.service.name || 'A service'; }

  function summary(models, last, now) {
    if (last.unavailable) {
      var ago = last.lastGood ? ' Last answer ' + dur(now - last.lastGood) + ' ago.' : '';
      return { tone: 'off', title: 'Status unavailable right now',
        sub: 'The status checker isn’t answering, so we can’t say what is running.' + ago };
    }
    if (!models.length) {
      return { tone: 'off', title: 'No services to show', sub: 'No services are being checked right now.' };
    }
    var down = models.filter(function (m) { return m.k === 'down'; });
    var warn = models.filter(function (m) { return m.k === 'slow' || m.k === 'trouble'; });
    var maint = models.filter(function (m) { return m.k === 'maint'; });
    var rest = models.length - down.length - warn.length - maint.length;
    var restLine = rest === 0 ? '' : (rest === models.length - 1 || !(down.length + warn.length + maint.length > 1)
      ? 'Everything else is running.' : 'The rest are running.');
    if (down.length === 1) {
      var also = warn.length ? name(warn[0]) + (warn[0].k === 'slow' ? ' is slow too.' : ' is having trouble too.') : restLine;
      return { tone: 'err', title: name(down[0]) + ' is down',
        sub: (runFor(down[0], now) ? 'Down for ' + runFor(down[0], now) + '. ' : '') + also };
    }
    if (down.length > 1) {
      return { tone: 'err', title: down.length + ' services are down',
        sub: down.length === models.length ? 'None of them answered their last check.' : restLine };
    }
    if (warn.length === 1) {
      var w = warn[0];
      if (w.k === 'slow') {
        return { tone: 'warn', title: name(w) + ' is slow right now',
          sub: 'Slower than usual for ' + runFor(w, now) + '. ' + restLine };
      }
      return { tone: 'warn', title: name(w) + ' is having trouble',
        sub: 'Its last check did not go through cleanly. ' + restLine };
    }
    if (warn.length > 1) {
      return { tone: 'warn', title: warn.length + ' services are slow', sub: restLine };
    }
    if (maint.length) {
      return { tone: 'ok', title: maint.length === 1 ? name(maint[0]) + ' is down for planned work'
        : maint.length + ' services are down for planned work', sub: restLine };
    }
    return { tone: 'ok', title: 'Everything is running',
      sub: models.length === 1 ? 'The service answered its last check.'
        : 'All ' + models.length + ' services answered their last check.' };
  }

  // ---- DOM helpers ----
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function sv(tag, attrs) {
    var n = document.createElementNS(SVG, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function icon(nameText) {
    var i = el('span', 'material-symbols-outlined', nameText);
    i.setAttribute('aria-hidden', 'true');
    return i;
  }
  function dot(k) {
    var d = el('span', 'ws-sp-dot');
    d.setAttribute('data-k', k);
    d.setAttribute('aria-hidden', 'true');
    return d;
  }

  // The last checks, one bar each, newest on the right.
  function strip(m) {
    var box = el('div', 'ws-sp-strip');
    var counts = { up: 0, slow: 0, trouble: 0, down: 0, maint: 0 };
    m.kinds.forEach(function (k) {
      var i = el('i');
      i.setAttribute('data-k', k);
      box.appendChild(i);
      counts[k] = (counts[k] || 0) + 1;
    });
    var bad = counts.down + counts.trouble + counts.slow;
    var parts = [counts.up + ' fine'];
    if (counts.down) parts.push(counts.down + ' down');
    if (counts.slow + counts.trouble) parts.push((counts.slow + counts.trouble) + ' slow');
    if (counts.maint) parts.push(counts.maint + ' planned work');
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', 'Last ' + m.kinds.length + ' checks: ' + (bad || counts.maint ? parts.join(', ') : 'all fine'));
    return box;
  }

  // Reply times as a line; a check with no reply breaks it.
  function spark(m) {
    var w = 64, h = 20;
    var beats = m.service.beats || [];
    var vals = beats.map(function (b) { return b.ping; }).filter(function (v) { return typeof v === 'number'; });
    var svg = sv('svg', { 'class': 'ws-sp-spark', viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none',
      'aria-hidden': 'true', focusable: 'false', width: String(w), height: String(h) });
    if (!vals.length) return svg;
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1) hi = lo + 1;
    var pad = 0.12 * (hi - lo);
    lo -= pad; hi += pad;
    var runs = [], cur = [];
    beats.forEach(function (b, i) {
      if (typeof b.ping !== 'number') { if (cur.length) runs.push(cur); cur = []; return; }
      var x = beats.length === 1 ? w : (i / (beats.length - 1)) * w;
      var y = h - ((b.ping - lo) / (hi - lo)) * h;
      cur.push(x.toFixed(2) + ',' + y.toFixed(2));
    });
    if (cur.length) runs.push(cur);
    runs.forEach(function (run) {
      // A lone reply between gaps still shows: a dot-length line.
      if (run.length === 1) { var p = run[0].split(','); run = [(+p[0] - 0.5) + ',' + p[1], (+p[0] + 0.5) + ',' + p[1]]; }
      svg.appendChild(sv('polyline', { points: run.join(' ') }));
    });
    return svg;
  }

  function lastReply(m) {
    var beats = m.service.beats || [];
    var last = beats[beats.length - 1];
    if (!last || typeof last.ping !== 'number') {
      return { text: last ? 'No reply' : '', k: last ? 'down' : 'up' };
    }
    return { text: fmtMs(last.ping), k: m.kinds[m.kinds.length - 1] === 'slow' ? 'slow' : 'up' };
  }

  function rangeNote() {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].id === range) return RANGES[i].note;
    return '';
  }

  function row(m, now) {
    var li = el('li', 'ws-sp-row');
    li.setAttribute('data-k', m.k);
    li.appendChild(dot(m.k));
    var mid = el('div', 'ws-sp-who');
    mid.appendChild(el('p', 'ws-sp-name', name(m)));
    mid.appendChild(el('p', 'ws-sp-state', stateWords(m, now)));
    li.appendChild(mid);
    var pct = (m.service.uptime || {})[range];
    if (range === '24h' && typeof pct !== 'number') pct = m.service.uptime_24h;
    var up = el('p', 'ws-sp-up');
    if (typeof pct === 'number') {
      up.appendChild(el('span', 'ws-sp-pct', fmtUp(pct)));
    } else {
      up.appendChild(el('span', 'ws-sp-na', 'Not available'));
    }
    up.appendChild(el('span', 'ws-sp-window', rangeNote()));
    li.appendChild(up);
    if (m.kinds.length) {
      var g = el('div', 'ws-sp-graphs');
      g.appendChild(strip(m));
      g.appendChild(spark(m));
      var lr = lastReply(m);
      var ms = el('span', 'ws-sp-ms', lr.text);
      ms.setAttribute('data-k', lr.k);
      ms.setAttribute('title', 'Reply time of the last check');
      g.appendChild(ms);
      li.appendChild(g);
    }
    return li;
  }

  // ---- One panel body (the popover's and the sheet's) ----
  //
  // Built once; render() rewrites the words and the rows in place, so a
  // refresh never moves focus off the window switch or Close.
  function Body(idPrefix, closable) {
    var root = document.createDocumentFragment();
    var head = el('div', 'ws-sp-summary');
    head.appendChild(el('span', 'ws-sp-summary-dot'));
    head.lastChild.setAttribute('aria-hidden', 'true');
    var title = el('p', 'ws-sp-title');
    title.id = idPrefix + 'Title';
    head.appendChild(title);
    var close = null;
    if (closable) {
      close = el('button', 'ws-sp-close');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      close.appendChild(icon('close'));
      close.hidden = true;
      head.appendChild(close);
    }
    var sub = el('p', 'ws-sp-sub');
    head.appendChild(sub);
    var checked = el('p', 'ws-sp-checked');
    head.appendChild(checked);
    var retry = el('button', 'ws-sp-retry');
    retry.type = 'button';
    retry.appendChild(icon('refresh'));
    var retryText = el('span', '', 'Try again');
    retry.appendChild(retryText);
    retry.hidden = true;
    head.appendChild(retry);
    root.appendChild(head);

    var pick = el('fieldset', 'ws-sp-range');
    pick.appendChild(el('legend', 'ws-sp-range-label', 'Uptime over'));
    var segs = el('div', 'ws-sp-segs');
    RANGES.forEach(function (r) {
      var lab = el('label', 'ws-sp-seg');
      var input = el('input', 'ws-sp-seg-input');
      input.type = 'radio';
      input.name = idPrefix + 'Range';
      input.value = r.id;
      input.checked = r.id === range;
      lab.appendChild(input);
      lab.appendChild(el('span', '', r.label));
      segs.appendChild(lab);
    });
    pick.appendChild(segs);
    root.appendChild(pick);

    var list = el('ul', 'ws-sp-list');
    root.appendChild(list);
    var foot = el('p', 'ws-sp-foot');
    root.appendChild(foot);

    function render(last) {
      var now = Date.now();
      var services = (last && last.list) || [];
      var models = services.map(function (s) { return WS.statusModel(s); });
      var unavailable = !!(last && last.unavailable);
      var sum = summary(models, { unavailable: unavailable, lastGood: unavailable ? last.lastGood : 0 }, now);
      head.setAttribute('data-tone', sum.tone);
      title.textContent = sum.title;
      sub.textContent = sum.sub;
      checked.textContent = unavailable || !last || !last.at ? ''
        : (last.cached ? 'Checking now' : (now - last.at < MIN ? 'Checked just now' : 'Checked ' + dur(now - last.at) + ' ago'));
      checked.hidden = !checked.textContent;
      retry.hidden = !unavailable;
      pick.hidden = unavailable || !models.length;
      segs.querySelectorAll('input').forEach(function (i) { i.checked = i.value === range; });

      list.textContent = '';
      list.classList.toggle('ws-sp-list-unknown', unavailable);
      if (unavailable) {
        list.setAttribute('aria-label', 'Services, last known names');
        services.forEach(function (s) {
          var li = el('li', 'ws-sp-row');
          li.setAttribute('data-k', 'unknown');
          li.appendChild(dot('unknown'));
          var mid = el('div', 'ws-sp-who');
          mid.appendChild(el('p', 'ws-sp-name', s.name || 'A service'));
          mid.appendChild(el('p', 'ws-sp-state', 'No answer'));
          li.appendChild(mid);
          list.appendChild(li);
        });
        foot.textContent = services.length ? 'Names are from the last good check.' : '';
      } else {
        list.removeAttribute('aria-label');
        models.slice().sort(function (a, b) { return RANK[a.k] - RANK[b.k]; })
          .forEach(function (m) { list.appendChild(row(m, now)); });
        var n = models.reduce(function (most, m) { return Math.max(most, m.kinds.length); }, 0);
        foot.textContent = n ? 'Bars show the last ' + n + ' checks, newest on the right.' : '';
      }
      list.hidden = !list.firstChild;
      foot.hidden = !foot.textContent;
    }

    return { fragment: root, render: render, close: close, retry: retry, retryText: retryText, segs: segs };
  }

  // ---- Data ----
  function current() {
    var last = WS.statusLast();
    if (!last) return null;
    if (!last.unavailable) return last;
    // Not answering: the last good answer's names, never its states.
    return { list: last.known || [], unavailable: true, at: last.at, lastGood: last.lastGood || 0 };
  }

  var bodies = [];
  function renderAll() {
    var last = current();
    bodies.forEach(function (b) { b.render(last); });
  }
  document.addEventListener('ws:status', function () { if (isOpen()) renderAll(); });

  function wireBody(b) {
    b.segs.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || t.name === undefined || !t.checked) return;
      range = t.value;
      saveRange(range);
      renderAll();
    });
    b.retry.addEventListener('click', function () {
      b.retry.disabled = true;
      b.retryText.textContent = 'Checking';
      WS.serviceStatus({ fresh: true }).then(function () {
        b.retry.disabled = false;
        b.retryText.textContent = 'Try again';
        renderAll();
      });
    });
    bodies.push(b);
  }

  var refreshTimer = 0;
  function startRefresh() {
    stopRefresh();
    WS.serviceStatus();
    refreshTimer = setInterval(function () {
      if (document.visibilityState === 'visible') WS.serviceStatus();
      else renderAll();
    }, REFRESH_MS);
  }
  function stopRefresh() { clearInterval(refreshTimer); refreshTimer = 0; }

  // ---- Desktop popover ----
  var pop = null, popBody = null;
  var popOpen = false, pinned = false, openTimer = 0, closeTimer = 0;

  function isOpen() { return popOpen || sheetIsOpen(); }

  function buildPop() {
    pop = el('div', 'ws-pop ws-sp-pop ws-frost ws-frost-read hidden');
    pop.id = 'wsStatusPop';
    pop.setAttribute('role', 'region');
    pop.setAttribute('aria-labelledby', 'wsStatusPopTitle');
    popBody = Body('wsStatusPop', true);
    pop.appendChild(popBody.fragment);
    wireBody(popBody);
    pill.parentNode.insertBefore(pop, pill.nextSibling);
    popBody.close.addEventListener('click', function () { closePop(true); });
  }

  function setPinned(p) {
    pinned = p;
    if (popBody) popBody.close.hidden = !p;
  }
  // The room from the pill to the window's right edge, less a margin: the
  // two-column panel's widest (theme.css .ws-sp-pop reads --ws-sp-room).
  var EDGE = 24;
  function fitPop() {
    var room = (document.documentElement.clientWidth || window.innerWidth) - pill.getBoundingClientRect().left - EDGE;
    pop.style.setProperty('--ws-sp-room', Math.max(320, Math.floor(room)) + 'px');
  }
  window.addEventListener('resize', function () { if (popOpen) fitPop(); });

  function openPop(pin) {
    clearTimeout(closeTimer); clearTimeout(openTimer);
    if (pill.getAttribute('data-state') === 'unknown') return;   // nothing to say yet
    setPinned(pin || pinned);
    if (popOpen) return;
    popOpen = true;
    fitPop();
    renderAll();
    WS.popOpen(pop);
    pill.setAttribute('aria-expanded', 'true');
    document.dispatchEvent(new CustomEvent('ws:menu-open', { detail: pop }));
    startRefresh();
  }
  function closePop(returnFocus) {
    clearTimeout(closeTimer); clearTimeout(openTimer);
    if (!popOpen) return;
    popOpen = false;
    setPinned(false);
    WS.popClose(pop);
    pill.setAttribute('aria-expanded', 'false');
    if (!sheetIsOpen()) stopRefresh();
    if (returnFocus) pill.focus({ preventScroll: true });
  }
  function inPop(node) { return !!node && (pill.contains(node) || pop.contains(node)); }

  if (pill) {
    buildPop();
    pill.addEventListener('pointerenter', function (e) {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(closeTimer);
      if (!popOpen) openTimer = setTimeout(function () { openPop(false); }, OPEN_DELAY);
    });
    var leave = function (e) {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(openTimer);
      if (popOpen && !pinned) closeTimer = setTimeout(function () { closePop(false); }, CLOSE_DELAY);
    };
    pill.addEventListener('pointerleave', leave);
    pop.addEventListener('pointerleave', leave);
    pop.addEventListener('pointerenter', function () { clearTimeout(closeTimer); });
    pill.addEventListener('click', function (e) {
      e.stopPropagation();   // the other header menus close on a document click
      if (popOpen && pinned) closePop(false);
      else openPop(true);
    });
    // A click inside the panel is not a click outside it (header menus close on document clicks).
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('pointerdown', function (e) {
      if (popOpen && !inPop(e.target)) closePop(false);
    });
    document.addEventListener('focusin', function (e) {
      if (popOpen && !inPop(e.target)) closePop(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || e.isComposing || !popOpen) return;
      closePop(inPop(document.activeElement) || pinned);
    });
    document.addEventListener('ws:menu-open', function (e) {
      if (e.detail !== pop) closePop(false);
    });
  }

  // ---- Phone bottom sheet ----
  var sheet = null, sheetPanel = null, sheetBody = null, sheetTimer = 0;
  function sheetIsOpen() { return !!sheet && sheet.open && !sheet.classList.contains('is-closing'); }

  function buildSheet() {
    sheet = el('dialog', 'ws-sheet ws-sp-sheet');
    sheet.id = 'wsStatusSheet';
    sheet.setAttribute('aria-labelledby', 'wsStatusSheetHead');
    sheet.appendChild(el('div', 'ws-sheet-scrim'));
    sheet.lastChild.setAttribute('data-sheet-close', '');
    sheetPanel = el('div', 'ws-sheet-panel ws-frost');
    var head = el('div', 'ws-sheet-head');
    var grip = el('span', 'ws-sheet-grip');
    grip.setAttribute('aria-hidden', 'true');
    head.appendChild(grip);
    var h = el('h2', 'ws-sheet-title', 'Service status');
    h.id = 'wsStatusSheetHead';
    head.appendChild(h);
    var x = el('button', 'ws-sheet-close');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.setAttribute('data-sheet-close', '');
    x.appendChild(icon('close'));
    head.appendChild(x);
    sheetPanel.appendChild(head);
    sheetBody = Body('wsStatusSheet', false);
    sheetPanel.appendChild(sheetBody.fragment);
    wireBody(sheetBody);
    sheet.appendChild(sheetPanel);
    document.body.appendChild(sheet);

    sheet.addEventListener('cancel', function (e) { e.preventDefault(); closeSheet(true); });
    sheet.addEventListener('close', function () {
      sheet.classList.remove('is-open', 'is-closing');
      document.documentElement.classList.remove('ws-sheet-open');
      chip.setAttribute('aria-expanded', 'false');
    });
    sheet.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('[data-sheet-close]')) closeSheet(true);
    });
    // The head frosts only once rows scroll under it (theme.css .is-stuck);
    // at the top it is part of the one pane.
    sheetPanel.addEventListener('scroll', function () {
      head.classList.toggle('is-stuck', sheetPanel.scrollTop > 0);
    }, { passive: true });
    wireSwipe();
  }

  function finishSheet(restore) {
    clearTimeout(sheetTimer);
    sheetTimer = 0;
    sheet.classList.remove('is-open', 'is-closing');
    sheetPanel.style.transform = '';
    sheetPanel.style.transition = '';
    if (sheet.open) sheet.close();
    document.documentElement.classList.remove('ws-sheet-open');
    if (!popOpen) stopRefresh();
    if (restore) chip.focus({ preventScroll: true });
  }
  function openSheet() {
    if (sheetIsOpen()) return;
    if (!sheet) buildSheet();
    if (sheet.open) finishSheet(false);
    document.dispatchEvent(new CustomEvent('ws:menu-open', { detail: sheet }));
    renderAll();
    sheet.showModal();
    document.documentElement.classList.add('ws-sheet-open');
    void sheetPanel.offsetHeight;   // reflow: the closed state is drawn before it changes
    sheet.classList.add('is-open');
    chip.setAttribute('aria-expanded', 'true');
    startRefresh();
  }
  function reduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function closeSheet(restore, now) {
    if (!sheet || !sheet.open || (sheet.classList.contains('is-closing') && !now)) return;
    sheet.classList.remove('is-open');
    chip.setAttribute('aria-expanded', 'false');
    if (now || reduced()) { finishSheet(restore); return; }
    sheet.classList.add('is-closing');
    sheetTimer = setTimeout(function () { finishSheet(restore); }, SHEET_CLOSE_MS);
  }

  // Swipe down from the top of the sheet's scroll closes it, as More does.
  function wireSwipe() {
    var drag = null;
    sheetPanel.addEventListener('touchstart', function (e) {
      drag = null;
      if (!sheet.open || e.touches.length !== 1 || sheetPanel.scrollTop > 0) return;
      drag = { y: e.touches[0].clientY, dy: 0, v: 0, t: performance.now(), moved: false };
    }, { passive: true });
    sheetPanel.addEventListener('touchmove', function (e) {
      if (!drag || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - drag.y;
      if (!drag.moved && dy <= 0) { drag = null; return; }
      drag.moved = true;
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, dy);
      var t = performance.now();
      drag.v = (dy - drag.dy) / Math.max(1, t - drag.t);
      drag.t = t;
      drag.dy = dy;
      sheetPanel.style.transition = 'none';
      sheetPanel.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: false });
    function release(cancelled) {
      var d = drag;
      drag = null;
      if (!d || !d.moved) return;
      if (!cancelled && (d.dy > SWIPE_CLOSE_PX || d.v > SWIPE_FLING)) { closeSheet(true); return; }
      sheetPanel.style.transition = '';
      sheetPanel.style.transform = '';
    }
    sheetPanel.addEventListener('touchend', function () { release(false); });
    sheetPanel.addEventListener('touchcancel', function () { release(true); });
  }

  if (chip) {
    chip.setAttribute('aria-expanded', 'false');
    chip.addEventListener('click', function () {
      if (chip.getAttribute('data-state') === 'unknown') return;
      if (sheetIsOpen()) closeSheet(true);
      else openSheet();
    });
    document.addEventListener('ws:menu-open', function (e) {
      if (sheet && e.detail !== sheet) closeSheet(false, true);
    });
  }

  // The popover is the wide layout's, the sheet the narrow one's.
  if (window.matchMedia) {
    var wide = window.matchMedia('(min-width: 1024px)');
    var onWidth = function () {
      if (wide.matches) closeSheet(false, true);
      else closePop(false);
    };
    if (wide.addEventListener) wide.addEventListener('change', onWidth);
    else if (wide.addListener) wide.addListener(onWidth);
  }

  // For tests and the dev kit: open or close in code.
  WS.statusPanel = {
    open: function () {
      if (window.matchMedia && window.matchMedia('(min-width: 1024px)').matches) { if (pill) openPop(true); }
      else if (chip) openSheet();
    },
    close: function () { if (pill) closePop(false); closeSheet(false, true); },
    isOpen: isOpen
  };
})();
