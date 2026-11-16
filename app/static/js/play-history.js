/**
 * WebServarr: Play history (ES module, document-lifetime)
 *
 * The window that lists the person's own listening and reading sessions,
 * newest first, grouped by day, with All / Audiobooks / eBooks chips and a
 * "Load more" (GET /api/me/history, a page at a time; app/routers/play_history.py).
 * Opened from the account menu (from lg) and from More (phones), both
 * [data-play-history]. The window is static markup in the shell
 * (#wsHistory, shell-sidebar.html), run as a dialog by WSUI.modal: focus
 * goes to Close, Tab stays inside, Escape closes it and focus goes back to
 * the menu button (or More). The router closes it before a page swap.
 *
 * Each row's actions:
 * - An audiobook session's "Play from here": the book opens in the player
 *   through its normal open (where the listener left off, with the handoff
 *   question, the saved places read first, the files-changed and safety-net
 *   holds as ever), loaded but not played, and then goes to where the
 *   session ended with the player's own seek: an explicit move of the
 *   listener's, saved like a move on the scrubber or a tap in the player's
 *   history panel (Undo over 2 minutes; compare-and-swap against another
 *   device's newer save, which then asks before anything is overwritten).
 *   Then it plays. On a phone the full player opens (WS.playerUI.openOnStart).
 * - An eBook session's "Continue reading from here": the reader at that
 *   page (/reader?seriesId=&chapterId=&page=, js/pages/reader.js).
 * - "Book page": the book's own page.
 *
 * The window keeps one height, so nothing moves when the list lands. Text
 * is written with textContent only. Shell chrome, not a page module: it runs
 * once and its listeners stay, as the header and More do.
 *
 * Pure (importable by Node, no DOM at import time):
 *   bookClock(ms)                 "28:05:10"
 *   spanText(ms)                  "24 min", "1 h 7 min"
 *   chapterName(label)            "Chapter 3" for a bare number, else the label
 *   dayLabel(ms, nowMs)           "Today", "Yesterday", "Fri 13 Nov" (and the year when not this one)
 *   timeOfDay(ms)                 "7:42 pm"
 *   groupByDay(items, nowMs)      [{ label, items }] in the items' order
 *   audioRow(item), ebookRow(item)  what a row says: { where, left, bar, meta, action, aria }
 *   historyUrl(kind, before)      the API address for one page
 *   createHistory(env)            the window, given its surroundings
 *   boot(win)                     WS.playHistory
 */

export const HISTORY_URL = '/api/me/history';
export const PAGE = 20;
export const KINDS = ['all', 'audio', 'ebook'];
const DAY_MS = 86400000;

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function bookClock(ms) {
  const t = Math.max(0, Math.floor((num(ms) || 0) / 1000));
  return Math.floor(t / 3600) + ':' + pad(Math.floor((t % 3600) / 60)) + ':' + pad(t % 60);
}

export function spanText(ms) {
  const m = Math.round((num(ms) || 0) / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return m + ' min';
  const rest = m % 60;
  return Math.floor(m / 60) + ' h' + (rest ? ' ' + rest + ' min' : '');
}

export function chapterName(label) {
  const t = typeof label === 'string' ? label.trim() : '';
  return /^(?:\d+|(?=[MDCLXVI])M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/.test(t) ? 'Chapter ' + t : t;
}

function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayLabel(ms, nowMs) {
  const days = Math.round((dayStart(nowMs) - dayStart(ms)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ms);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date(nowMs).getFullYear()) opts.year = 'numeric';
  try {
    return d.toLocaleDateString([], opts);
  } catch (e) {
    return d.toDateString();
  }
}

export function timeOfDay(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M$/i, function (m, p) {
      return ' ' + p.toLowerCase() + 'm';
    });
  } catch (e) {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/* Items (newest first, as the API gives them) by the local day they ended. */
export function groupByDay(items, nowMs) {
  const out = [];
  let cur = null;
  (Array.isArray(items) ? items : []).forEach(function (it) {
    const end = Date.parse(it && it.end);
    if (!isFinite(end)) return;
    const label = dayLabel(end, nowMs);
    if (!cur || cur.label !== label) {
      cur = { label: label, items: [] };
      out.push(cur);
    }
    cur.items.push(it);
  });
  return out;
}

// The session's place in the whole book as percentages: what came before it
// and the session itself. null when either end or the length is unknown.
function bar(from, to, total) {
  const a = num(from);
  const b = num(to);
  const t = num(total);
  if (a === null || b === null || !t || t <= 0) return null;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(t, Math.max(a, b));
  return { before: (lo / t) * 100, start: (lo / t) * 100, width: Math.max(0, (hi - lo) / t) * 100 };
}

/* What an audiobook session's row says. */
export function audioRow(it) {
  const chapter = chapterName(it.chapter_label) || '';
  const end = num(it.to_ms);
  const total = num(it.duration_ms);
  const left = end !== null && total ? spanText(Math.max(0, total - end)) + ' left' : '';
  const meta = [];
  if (num(it.from_ms) !== null && end !== null) meta.push(bookClock(it.from_ms) + ' to ' + bookClock(end));
  meta.push('Listened ' + spanText(it.listened_ms));
  if (it.device) meta.push(String(it.device));
  const at = end !== null ? bookClock(end) : chapter;
  return {
    where: chapter || (end !== null ? bookClock(end) + ' into the book' : ''),
    left: left,
    bar: bar(it.from_ms, end, total),
    meta: meta,
    icon: 'headphones',
    action: 'Play from here',
    actionIcon: 'play_arrow',
    aria: 'Play ' + it.title + (at ? ' from ' + at : '')
  };
}

/* What an eBook session's row says. */
export function ebookRow(it) {
  const pages = num(it.pages);
  const first = num(it.start_page);
  const last = num(it.end_page);
  const chapter = num(it.chapter) ? 'Chapter ' + it.chapter : '';
  let where;
  let left = '';
  const meta = [];
  if (pages && last !== null) {
    where = (chapter ? chapter + ', page ' : 'Page ') + last;
    left = 'of ' + pages;
    if (first !== null) meta.push(first === last ? 'Page ' + last : 'Pages ' + first + ' to ' + last);
  } else {
    where = chapter || (last !== null ? 'Page ' + last : '');
  }
  meta.push('Read ' + spanText(it.read_ms));
  return {
    where: where,
    left: left,
    // Pages count from 1 here; the bar runs from the page before the first.
    bar: pages && first !== null && last !== null ? bar(first - 1, last, pages) : null,
    meta: meta,
    icon: 'menu_book',
    action: 'Continue reading from here',
    actionIcon: 'auto_stories',
    aria: 'Continue reading ' + it.title + (where ? ' from ' + where.charAt(0).toLowerCase() + where.slice(1) : '')
  };
}

export function historyUrl(kind, before) {
  const k = KINDS.indexOf(kind) === -1 ? 'all' : kind;
  return HISTORY_URL + '?kind=' + k + '&limit=' + PAGE + (before ? '&before=' + encodeURIComponent(before) : '');
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/* env: { doc, win, fetch, now(), modal (WSUI.modal), player() -> WS.player,
   playerUI() -> WS.playerUI, closeChrome(), reducedMotion(), navigate(url) }. */
export function createHistory(env) {
  const doc = env.doc;
  const overlay = doc.getElementById('wsHistory');
  if (!overlay) return null;
  const list = doc.getElementById('wsHxList');
  const closeBtn = overlay.querySelector('.ws-hx-close');
  const chips = Array.prototype.slice.call(overlay.querySelectorAll('[data-hx-filter]'));
  const now = env.now || Date.now;

  let dialog = null;
  let closeTimer = null;
  let kind = 'all';
  // One load at a time: { kind, items, next, status: 'loading'|'ready'|'error', more: 'idle'|'loading'|'error' }.
  let view = null;
  let ctrl = null;
  let seq = 0;

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name) {
    const i = el('span', 'material-symbols-outlined', name);
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  // ---- Loading ----

  function load(append) {
    if (ctrl) ctrl.abort();
    const my = ++seq;
    const c = typeof AbortController === 'function' ? new AbortController() : null;
    ctrl = c;
    const before = append && view ? view.next : null;
    if (append) view.more = 'loading';
    else view = { kind: kind, items: [], next: null, status: 'loading', more: 'idle' };
    draw();
    let req;
    try {
      req = env.fetch(historyUrl(kind, before), { credentials: 'same-origin', signal: c ? c.signal : undefined,
        headers: { Accept: 'application/json' } });
    } catch (e) {
      req = Promise.reject(e);
    }
    return Promise.resolve(req).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      if (my !== seq) return;
      const items = data && Array.isArray(data.items) ? data.items : [];
      const firstNew = view.items.length;
      view.items = view.items.concat(items);
      view.next = data && typeof data.next_before === 'string' ? data.next_before : null;
      view.notes = data && Array.isArray(data.notes) ? data.notes : [];
      view.status = 'ready';
      view.more = 'idle';
      draw();
      // After Load more: focus the first new session's main action.
      if (append && items.length) {
        const rows = list.querySelectorAll('.ws-hx-row');
        const row = rows[firstNew];
        const go = row && row.querySelector('[data-hx-go]');
        if (go) go.focus();
      }
    }).catch(function (e) {
      if (my !== seq || (e && e.name === 'AbortError')) return;
      if (append) view.more = 'error';
      else view.status = 'error';
      draw();
    }).finally(function () {
      if (my === seq) ctrl = null;
    });
  }

  // ---- Drawing ----

  function draw() {
    list.textContent = '';
    if (!view || view.status === 'loading') return drawLoading();
    if (view.status === 'error') {
      return drawState('cloud_off', 'Your history didn’t load',
        'The server didn’t answer. Check your connection, then try again.',
        { label: 'Try again', icon: 'refresh', run: function () { load(false); } });
    }
    if (!view.items.length) return drawEmpty();
    const days = groupByDay(view.items, now());
    days.forEach(function (d, i) {
      const sec = el('section', 'ws-hx-day');
      const h = el('h3', 'ws-hx-day-h', d.label);
      h.id = 'wsHxDay' + i;
      sec.setAttribute('aria-labelledby', h.id);
      sec.appendChild(h);
      const ul = el('ul', 'ws-hx-rows');
      d.items.forEach(function (it) { ul.appendChild(row(it)); });
      sec.appendChild(ul);
      list.appendChild(sec);
    });
    if (view.next) {
      const more = el('button', 'ws-hx-btn is-ghost is-wide');
      more.type = 'button';
      more.setAttribute('data-hx-more', '');
      if (view.more === 'loading') {
        more.textContent = 'Loading…';
        more.setAttribute('aria-disabled', 'true');
      } else {
        more.textContent = view.more === 'error' ? 'Couldn’t load more. Try again' : 'Load more';
      }
      list.appendChild(more);
    } else {
      list.appendChild(el('p', 'ws-hx-end', 'That’s everything from the last 180 days.'));
    }
  }

  function drawEmpty() {
    const note = (view.notes || []).filter(function (n) { return n && n.text; })[0];
    if (kind === 'all') {
      return drawState('history', 'Nothing here yet',
        'When you listen to an audiobook or read an eBook, each session shows up here so you can go back to any point.',
        { label: 'Browse books', icon: 'menu_book', href: '/books' });
    }
    const audio = kind === 'audio';
    return drawState(audio ? 'headphones' : 'menu_book', audio ? 'No audiobook listening yet' : 'No eBook reading yet',
      note && note.reason === 'not_connected' && !audio ? note.text + '.' :
        'Nothing in the last 180 days. Switch to All to see everything else.',
      { label: 'Show all', run: function () { setKind('all'); } });
  }

  function drawState(ic, title, text, action) {
    const s = el('div', 'ws-hx-state');
    s.appendChild(icon(ic));
    s.appendChild(el('h3', null, title));
    s.appendChild(el('p', null, text));
    let a;
    if (action.href) {
      a = el('a', 'ws-hx-btn is-primary');
      a.href = action.href;
    } else {
      a = el('button', 'ws-hx-btn is-primary');
      a.type = 'button';
      a.addEventListener('click', action.run);
    }
    if (action.icon) a.appendChild(icon(action.icon));
    a.appendChild(doc.createTextNode(action.label));
    s.appendChild(a);
    list.appendChild(s);
  }

  function skel(w, h, radius) {
    const n = el('div', 'skel');
    n.style.width = w;
    n.style.height = h + 'px';
    if (radius) n.style.borderRadius = radius + 'px';
    return n;
  }

  function drawLoading() {
    const sec = el('div', 'ws-hx-day');
    sec.setAttribute('aria-busy', 'true');
    const sr = el('span', 'sr-only', 'Loading your history');
    sr.setAttribute('role', 'status');
    sec.appendChild(sr);
    const h = skel('64px', 13);
    h.style.margin = '20px 0 8px';
    sec.appendChild(h);
    for (let i = 0; i < 4; i++) {
      const r = el('div', 'ws-hx-sk-row');
      r.appendChild(skel('56px', 56, 6));
      const st = el('div', 'ws-hx-sk-stack');
      [['70%', 15], ['45%', 13], ['100%', 4], ['60%', 13], ['130px', 36]].forEach(function (d) {
        st.appendChild(skel(d[0], d[1]));
      });
      r.appendChild(st);
      sec.appendChild(r);
    }
    list.appendChild(sec);
  }

  function row(it) {
    const audio = it.kind === 'audio';
    const say = audio ? audioRow(it) : ebookRow(it);
    const li = el('li', 'ws-hx-row');
    const cover = el('img', 'ws-hx-cover ' + (audio ? 'is-audio' : 'is-ebook'));
    cover.alt = '';
    cover.loading = 'lazy';
    cover.decoding = 'async';
    cover.width = audio ? 56 : 44;
    cover.height = audio ? 56 : 66;
    if (it.cover_url) cover.src = it.cover_url;
    cover.addEventListener('error', function () { cover.removeAttribute('src'); }, { once: true });
    li.appendChild(cover);

    const body = el('div', 'ws-hx-body');
    const top = el('div', 'ws-hx-top');
    top.appendChild(el('h4', 'ws-hx-name', it.title || ''));
    const end = Date.parse(it.end);
    top.appendChild(el('span', 'ws-hx-time', isFinite(end) ? timeOfDay(end) : ''));
    body.appendChild(top);

    const where = el('p', 'ws-hx-where');
    where.appendChild(icon(say.icon));
    if (say.where) where.appendChild(el('b', null, say.where));
    if (say.left) where.appendChild(el('span', 'ws-hx-left', say.left));
    body.appendChild(where);

    if (say.bar) {
      const b = el('div', 'ws-hx-span');
      b.setAttribute('aria-hidden', 'true');
      const before = el('i', 'is-before');
      before.style.width = say.bar.before + '%';
      const sess = el('i', 'is-session');
      sess.style.left = say.bar.start + '%';
      sess.style.width = say.bar.width + '%';
      b.appendChild(before);
      b.appendChild(sess);
      body.appendChild(b);
    }
    const meta = el('p', 'ws-hx-meta');
    say.meta.forEach(function (t) { meta.appendChild(el('span', null, t)); });
    body.appendChild(meta);
    li.appendChild(body);

    const acts = el('div', 'ws-hx-acts');
    let go;
    if (audio) {
      go = el('button', 'ws-hx-btn is-ghost');
      go.type = 'button';
      go.addEventListener('click', function () { playFrom(it, go); });
    } else {
      go = el('a', 'ws-hx-btn is-ghost');
      go.href = it.read_url;
    }
    go.setAttribute('data-hx-go', '');
    go.setAttribute('aria-label', say.aria);
    go.appendChild(icon(say.actionIcon));
    go.appendChild(doc.createTextNode(say.action));
    acts.appendChild(go);
    const page = el('a', 'ws-hx-btn is-quiet', 'Book page');
    page.href = it.book_url;
    page.setAttribute('aria-label', (it.title || 'This book') + ', book page');
    acts.appendChild(page);
    li.appendChild(acts);
    return li;
  }

  // ---- Play from here ----

  function toast(text, tone) {
    const w = env.win && env.win.WSUI;
    if (w && typeof w.toast === 'function') w.toast(text, tone || 'err');
  }

  async function playFrom(it, btn) {
    const p = env.player();
    if (!p || typeof p.open !== 'function') {
      toast('The player isn’t ready yet. Try again in a moment.');
      return;
    }
    if (btn.getAttribute('aria-disabled') === 'true') return;
    btn.setAttribute('aria-disabled', 'true');
    const key = it.plex_book_key;
    const place = it.place || {};
    close();
    const s0 = p.state();
    let opened;
    try {
      // Where the listener left off first, through the player's own open:
      // the saved places are read, and its questions (another device's newer
      // place, the files changed, the safety net) are asked as ever.
      opened = s0 && s0.book === key && !s0.error ? null : p.open(key, { autoplay: false });
      const ui = env.playerUI();
      if (ui && typeof ui.openOnStart === 'function') ui.openOnStart();
      await opened;
    } catch (e) {
      console.warn('The player could not open ' + key, e);
      return;
    } finally {
      btn.removeAttribute('aria-disabled');
    }
    const s = p.state();
    if (!s || s.book !== key || s.error || s.safetyNet) return;   // the player shows why
    const ms = p.placeMs(String(place.track), Number(place.offset_ms));
    if (ms === null || ms === undefined) {
      toast('That place isn’t in this copy of the book. Your place is as it was.', 'info');
      return;
    }
    // The listener's own move, as a tap in the player's history panel is.
    p.seek(ms);
    if (!p.state().filesChanged) p.play();
  }

  // ---- Open and close ----

  function setKind(k) {
    if (KINDS.indexOf(k) === -1) k = 'all';
    kind = k;
    chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('data-hx-filter') === k)); });
    list.scrollTop = 0;
    load(false);
  }

  function hide() {
    overlay.classList.remove('is-opening');
    if (env.reducedMotion()) {
      overlay.hidden = true;
      return;
    }
    overlay.classList.add('is-closing');
    closeTimer = env.win.setTimeout(function () {
      closeTimer = null;
      overlay.hidden = true;
      overlay.classList.remove('is-closing');
    }, 160);
  }

  function open(opener) {
    if (dialog) return;
    if (closeTimer) {
      env.win.clearTimeout(closeTimer);
      closeTimer = null;
    }
    // Focus goes back to the button the menu hangs from (the menu item itself
    // is hidden with the menu), so it is focused before the dialog takes note.
    if (opener && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    overlay.classList.remove('is-closing', 'is-opening');
    overlay.hidden = false;
    void overlay.offsetWidth;
    overlay.classList.add('is-opening');
    kind = 'all';
    chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('data-hx-filter') === 'all')); });
    list.scrollTop = 0;
    dialog = env.modal(overlay, {
      box: overlay.querySelector('[data-dialog-box]'),
      initial: closeBtn,
      onClose: function () {
        dialog = null;
        if (ctrl) ctrl.abort();
        seq++;
        hide();
      }
    });
    load(false);
  }

  function close() {
    if (dialog) dialog.close();
  }

  overlay.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-hx-close]')) { close(); return; }
    const chip = t.closest('[data-hx-filter]');
    if (chip) {
      const k = chip.getAttribute('data-hx-filter');
      if (k !== kind || (view && view.status === 'error')) setKind(k);
      return;
    }
    const more = t.closest('[data-hx-more]');
    if (more) {
      if (view && view.more !== 'loading' && view.next) load(true);
      return;
    }
    // A link chosen (Book page, Continue reading, Browse books): the window
    // goes, and the router takes the link.
    if (t.closest('a[href]')) close();
  });

  // The entries: the account menu's item (from lg) and More's row (phones).
  doc.addEventListener('click', function (e) {
    const t = e.target;
    const entry = t && t.closest ? t.closest('[data-play-history]') : null;
    if (!entry) return;
    e.preventDefault();
    const inSheet = !!entry.closest('#wsMoreSheet');
    if (typeof env.closeChrome === 'function') env.closeChrome();
    const back = doc.getElementById(inSheet ? 'wsMoreBtn' : 'userMenuBtn');
    open(back);
  });

  return { open: open, close: close, isOpen: function () { return !!dialog; } };
}

export function boot(win) {
  const WS = win.WS;
  const WSUI = win.WSUI;
  if (!WS || !WSUI || typeof WSUI.modal !== 'function') return null;
  const reduced = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const h = createHistory({
    doc: win.document,
    win: win,
    fetch: win.fetch.bind(win),
    now: Date.now,
    modal: WSUI.modal,
    player: function () { return WS.player || null; },
    playerUI: function () { return WS.playerUI || null; },
    closeChrome: WS.closeChrome,
    reducedMotion: function () { return !!(reduced && reduced.matches); }
  });
  if (h) WS.playHistory = h;
  return h;
}

if (typeof window !== 'undefined' && window.document) boot(window);
