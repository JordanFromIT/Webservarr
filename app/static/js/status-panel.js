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
 * While open it is live: asked again every REFRESH_MS (so the pill and chip
 * follow too), new checks slide into the strips, and the "Checked" and "for
 * N min" words stay current. Closed, or in a background tab, it asks nothing.
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
  var REFRESH_MS = 15000;      // while open, asked again this often (Kuma checks most monitors every 20 s)
  var TICK_MS = 5000;          // and its "Checked ..." and "Down for ..." words kept current
  var SLIDE_MS = 300;          // new checks slide in this long
  var SLIDE_MAX = 6;           // more new checks than this at once just show
  var SHEET_CLOSE_MS = 160;    // the sheet's 140ms slide away (theme.css .ws-sheet.is-closing), and a frame
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

  function setText(n, s) { if (n.textContent !== s) n.textContent = s; }
  function setAttr(n, a, v) { if (n.getAttribute(a) !== v) n.setAttribute(a, v); }

  // ---- New checks arriving ----
  //
  // While the panel is open it asks again every REFRESH_MS. Checks that are
  // new since the last answer slide in from the right of the strip and the
  // oldest slide off the left; the reply line moves with them and eases to
  // its new scale. One frame loop drives every row so they move together.
  // Reduced motion, a catch-up of more than SLIDE_MAX checks, or a strip
  // still filling up just shows the new state.
  var anims = [], raf = 0;
  function ease(p) { return 1 - Math.pow(1 - p, 3); }
  function frame(ts) {
    raf = 0;
    anims = anims.filter(function (a) {
      if (a.start === null) a.start = ts;
      var p = Math.min(1, (ts - a.start) / SLIDE_MS);
      a.step(ease(p));
      if (p < 1) return true;
      a.end();
      return false;
    });
    if (anims.length) raf = requestAnimationFrame(frame);
  }
  function play(a) {
    a.start = null;
    anims.push(a);
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function finish(a) {
    var i = anims.indexOf(a);
    if (i === -1) return;
    anims.splice(i, 1);
    a.step(1);
    a.end();
  }

  // The checks as a strip of bars, one per check, newest on the right. The
  // bars sit on a track inside the strip, so new ones can come in past its
  // right edge and slide into place.
  function setBars(track, kinds) {
    while (track.children.length > kinds.length) track.removeChild(track.lastChild);
    while (track.children.length < kinds.length) track.appendChild(el('i'));
    kinds.forEach(function (k, i) { setAttr(track.children[i], 'data-k', k); });
  }
  function stripLabel(kinds) {
    var counts = { up: 0, slow: 0, trouble: 0, down: 0, maint: 0 };
    kinds.forEach(function (k) { counts[k] = (counts[k] || 0) + 1; });
    var bad = counts.down + counts.trouble + counts.slow;
    var parts = [counts.up + ' fine'];
    if (counts.down) parts.push(counts.down + ' down');
    if (counts.slow + counts.trouble) parts.push((counts.slow + counts.trouble) + ' slow');
    if (counts.maint) parts.push(counts.maint + ' planned work');
    return 'Last ' + kinds.length + ' checks: ' + (bad || counts.maint ? parts.join(', ') : 'all fine');
  }

  // Reply times as a line; a check with no reply breaks it. scale is the
  // range the line spans; slots the checks the width holds; shift how many
  // slots it has moved left (part way through a slide).
  var SW = 64, SH = 20;
  function sparkScale(beats) {
    var vals = beats.map(function (b) { return b.ping; }).filter(function (v) { return typeof v === 'number'; });
    if (!vals.length) return null;
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1) hi = lo + 1;
    var pad = 0.12 * (hi - lo);
    return { lo: lo - pad, hi: hi + pad };
  }
  function drawSpark(svg, beats, scale, slots, shift) {
    var runs = [], cur = [];
    if (scale) {
      beats.forEach(function (b, i) {
        if (typeof b.ping !== 'number') { if (cur.length) runs.push(cur); cur = []; return; }
        var x = slots === 1 ? SW : ((i - shift) / (slots - 1)) * SW;
        var y = SH - ((b.ping - scale.lo) / (scale.hi - scale.lo)) * SH;
        cur.push([x, y]);
      });
      if (cur.length) runs.push(cur);
    }
    while (svg.childNodes.length > runs.length) svg.removeChild(svg.lastChild);
    while (svg.childNodes.length < runs.length) svg.appendChild(sv('polyline', {}));
    runs.forEach(function (run, i) {
      // A lone reply between gaps still shows: a dot-length line.
      if (run.length === 1) run = [[run[0][0] - 0.5, run[0][1]], [run[0][0] + 0.5, run[0][1]]];
      svg.childNodes[i].setAttribute('points', run.map(function (p) { return p[0].toFixed(2) + ',' + p[1].toFixed(2); }).join(' '));
    });
  }
  function mix(a, b, t) {
    if (!a) return b;
    return { lo: a.lo + (b.lo - a.lo) * t, hi: a.hi + (b.hi - a.hi) * t };
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

  // How many checks at the end of next are new since prev: -1 when prev is
  // empty or next no longer holds prev's newest (too far behind to tell).
  function newChecks(prev, next) {
    if (!prev.length) return -1;
    var t = prev[prev.length - 1].time;
    for (var i = next.length - 1; i >= 0; i--) if (next[i].time === t) return next.length - 1 - i;
    return -1;
  }
  function beatSig(beats) {
    if (!beats.length) return '';
    var a = beats[0], z = beats[beats.length - 1];
    return beats.length + '|' + a.time + '|' + z.time + '|' + z.status + '|' + z.ping;
  }

  // One service's row, kept across answers and updated in place.
  function Row() {
    var r = { beats: [], sig: '', scale: null, anim: null };
    r.li = el('li', 'ws-sp-row');
    r.dot = dot('up');
    r.li.appendChild(r.dot);
    var mid = el('div', 'ws-sp-who');
    r.name = el('p', 'ws-sp-name');
    r.state = el('p', 'ws-sp-state');
    mid.appendChild(r.name);
    mid.appendChild(r.state);
    r.li.appendChild(mid);
    var up = el('p', 'ws-sp-up');
    r.pct = el('span', 'ws-sp-pct');
    r.win = el('span', 'ws-sp-window');
    up.appendChild(r.pct);
    up.appendChild(r.win);
    r.li.appendChild(up);
    r.graphs = el('div', 'ws-sp-graphs');
    r.strip = el('div', 'ws-sp-strip');
    r.strip.setAttribute('role', 'img');
    r.track = el('div', 'ws-sp-track');
    r.strip.appendChild(r.track);
    r.spark = sv('svg', { 'class': 'ws-sp-spark', viewBox: '0 0 ' + SW + ' ' + SH, preserveAspectRatio: 'none',
      'aria-hidden': 'true', focusable: 'false', width: String(SW), height: String(SH) });
    r.ms = el('span', 'ws-sp-ms');
    r.ms.setAttribute('title', 'Reply time of the last check');
    r.graphs.appendChild(r.strip);
    r.graphs.appendChild(r.spark);
    r.graphs.appendChild(r.ms);
    return r;
  }

  function updateRow(r, m, now, motion) {
    setAttr(r.li, 'data-k', m.k);
    setAttr(r.dot, 'data-k', m.k);
    setText(r.name, name(m));
    setText(r.state, stateWords(m, now));
    var pct = (m.service.uptime || {})[range];
    if (range === '24h' && typeof pct !== 'number') pct = m.service.uptime_24h;
    var has = typeof pct === 'number';
    setAttr(r.pct, 'class', has ? 'ws-sp-pct' : 'ws-sp-na');
    setText(r.pct, has ? fmtUp(pct) : 'Not available');
    setText(r.win, rangeNote());

    var beats = Array.isArray(m.service.beats) ? m.service.beats : [];
    if (!m.kinds.length) {
      if (r.graphs.parentNode) r.li.removeChild(r.graphs);
      r.beats = []; r.sig = ''; r.scale = null;
      return;
    }
    if (!r.graphs.parentNode) r.li.appendChild(r.graphs);
    var sig = beatSig(beats);
    if (sig === r.sig) return;              // nothing new: leave the graphs (and any slide) be
    if (r.anim) finish(r.anim);
    var lr = lastReply(m);
    setText(r.ms, lr.text);
    setAttr(r.ms, 'data-k', lr.k);
    setAttr(r.strip, 'aria-label', stripLabel(m.kinds));

    var prev = r.beats, prevScale = r.scale;
    var n = newChecks(prev, beats);
    var L = beats.length;
    var scale = sparkScale(beats);
    r.beats = beats; r.sig = sig; r.scale = scale;

    var bars = r.track.children;
    var pitch = bars.length > 1 ? bars[1].getBoundingClientRect().left - bars[0].getBoundingClientRect().left : 0;
    if (!motion || n < 1 || n > SLIDE_MAX || prev.length !== L || L < 2 || !(pitch > 0)) {
      setBars(r.track, m.kinds);
      drawSpark(r.spark, beats, scale, L, 0);
      return;
    }
    // The bars that stay take their (possibly re-judged) kinds; the new
    // ones go on past the right edge at the same width.
    var gap = pitch - bars[0].getBoundingClientRect().width;
    var i;
    for (i = 0; i < L - n; i++) setAttr(bars[i + n], 'data-k', m.kinds[i]);
    for (i = L - n; i < L; i++) {
      var b = el('i');
      b.setAttribute('data-k', m.kinds[i]);
      r.track.appendChild(b);
    }
    r.track.style.width = ((L + n) * pitch - gap) + 'px';
    var both = prev.concat(beats.slice(L - n));
    r.spark.style.clipPath = 'inset(-4px 0)';
    r.anim = {
      step: function (t) {
        r.track.style.transform = 'translateX(' + (-t * n * pitch).toFixed(2) + 'px)';
        drawSpark(r.spark, both, mix(prevScale, scale, t), L, t * n);
      },
      end: function () {
        for (var j = 0; j < n; j++) r.track.removeChild(r.track.firstChild);
        r.track.style.transform = '';
        r.track.style.width = '';
        r.spark.style.clipPath = '';
        drawSpark(r.spark, beats, scale, L, 0);
        r.anim = null;
      }
    };
    play(r.anim);
  }

  // ---- One panel body (the popover's and the sheet's) ----
  //
  // Built once; render() updates the words and the rows in place (rows are
  // kept per service), so a refresh never moves focus off the window switch
  // or Close, and the panel keeps its size while checks come in.
  // onRetryGone: where focus goes when "Try again" had it and is no longer
  // needed (the answer came back).
  function Body(idPrefix, closable, onRetryGone) {
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

    var rowsById = {};
    var unknownSig = null;   // the names last listed while not answering

    function renderUnknown(services) {
      rowsById = {};
      var sig = services.map(function (s) { return s.name || ''; }).join('\n');
      if (unknownSig === sig && list.classList.contains('ws-sp-list-unknown')) return;
      unknownSig = sig;
      list.textContent = '';
      list.classList.add('ws-sp-list-unknown');
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
    }

    function renderRows(models, now, motion) {
      if (list.classList.contains('ws-sp-list-unknown')) {
        list.textContent = '';
        list.classList.remove('ws-sp-list-unknown');
        list.removeAttribute('aria-label');
        unknownSig = null;
      }
      var seen = {};
      var order = models.slice().sort(function (a, b) { return RANK[a.k] - RANK[b.k]; }).map(function (m, i) {
        var id = m.service.id !== undefined && m.service.id !== null ? 'id:' + m.service.id : 'n:' + name(m) + ':' + i;
        seen[id] = true;
        var r = rowsById[id] || (rowsById[id] = Row());
        updateRow(r, m, now, motion);
        return r.li;
      });
      Object.keys(rowsById).forEach(function (id) {
        if (seen[id]) return;
        var r = rowsById[id];
        if (r.anim) finish(r.anim);
        if (r.li.parentNode) list.removeChild(r.li);
        delete rowsById[id];
      });
      // Move rows only when the order changed (a service turned worse or better).
      var same = list.children.length === order.length;
      for (var i = 0; same && i < order.length; i++) same = list.children[i] === order[i];
      if (!same) order.forEach(function (li) { list.appendChild(li); });
    }

    // last: the status answer (current()); motion: new checks may slide in.
    function render(last, motion) {
      var now = Date.now();
      var services = (last && last.list) || [];
      var models = services.map(function (s) { return WS.statusModel(s); });
      var unavailable = !!(last && last.unavailable);
      var sum = summary(models, { unavailable: unavailable, lastGood: unavailable ? last.lastGood : 0 }, now);
      setAttr(head, 'data-tone', sum.tone);
      setText(title, sum.title);
      setText(sub, sum.sub);
      setText(checked, unavailable || !last || !last.at ? ''
        : (last.cached ? 'Checking now' : (now - last.at < MIN ? 'Checked just now' : 'Checked ' + dur(now - last.at) + ' ago')));
      checked.hidden = !checked.textContent;
      var retryHadFocus = document.activeElement === retry;
      retry.hidden = !unavailable;
      pick.hidden = unavailable || !models.length;
      segs.querySelectorAll('input').forEach(function (i) { i.checked = i.value === range; });

      if (unavailable) {
        renderUnknown(services);
        setText(foot, services.length ? 'Names are from the last good check.' : '');
      } else {
        renderRows(models, now, motion);
        var n = models.reduce(function (most, m) { return Math.max(most, m.kinds.length); }, 0);
        setText(foot, n ? 'Bars show the last ' + n + ' checks, newest on the right.' : '');
      }
      list.hidden = !list.firstChild;
      foot.hidden = !foot.textContent;
      if (retryHadFocus && retry.hidden && onRetryGone) onRetryGone();
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
  // motion: an answer just landed, so the open panel's new checks slide in.
  function renderAll(motion) {
    var last = current();
    var slide = !!motion && !reduced();
    bodies.forEach(function (b) { b.render(last, slide && b.shown()); });
  }
  document.addEventListener('ws:status', function () { if (isOpen()) renderAll(true); });

  function wireBody(b) {
    b.segs.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || t.name === undefined || !t.checked) return;
      range = t.value;
      saveRange(range);
      renderAll();
    });
    // Busy is aria-disabled, not disabled: a disabled button drops focus.
    b.retry.addEventListener('click', function () {
      if (b.retry.getAttribute('aria-disabled') === 'true') return;
      b.retry.setAttribute('aria-disabled', 'true');
      b.retryText.textContent = 'Checking';
      WS.serviceStatus({ fresh: true }).then(function () {
        b.retry.removeAttribute('aria-disabled');
        b.retryText.textContent = 'Try again';
        renderAll();
      });
    });
    bodies.push(b);
  }

  // While open: asked again every REFRESH_MS and the words kept current,
  // both through WS.poll, so nothing runs in a background tab (it asks at
  // once on coming back) and nothing outlives the panel's close.
  var live = null;
  function startRefresh() {
    stopRefresh();
    live = new AbortController();
    WS.serviceStatus();
    WS.poll(function () { WS.serviceStatus(); }, REFRESH_MS, live.signal);
    WS.poll(function () { renderAll(); }, TICK_MS, live.signal);
  }
  function stopRefresh() { if (live) { live.abort(); live = null; } }

  // ---- Desktop popover ----
  var pop = null, popBody = null;
  var popOpen = false, pinned = false, openTimer = 0, closeTimer = 0;

  function isOpen() { return popOpen || sheetIsOpen(); }

  function buildPop() {
    pop = el('div', 'ws-pop ws-sp-pop ws-frost hidden');
    pop.id = 'wsStatusPop';
    pop.setAttribute('role', 'region');
    pop.setAttribute('aria-labelledby', 'wsStatusPopTitle');
    popBody = Body('wsStatusPop', true, function () {
      (popBody.close.hidden ? pill : popBody.close).focus({ preventScroll: true });
    });
    popBody.shown = function () { return popOpen; };
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
    sheetBody = Body('wsStatusSheet', false, function () { x.focus({ preventScroll: true }); });
    sheetBody.shown = sheetIsOpen;
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
