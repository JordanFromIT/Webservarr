/**
 * WebServarr, Insights (page module)
 *
 * /insights, for admins only: the server sends anyone else away, and every
 * /api/admin/insights route answers 401 or 403 to them
 * (docs/superpowers/specs/2026-10-10-insights-design.md, section 7). Reading
 * and listening across everyone, in sections that each load on their own, so
 * one that fails, or whose source is down, never takes the others with it.
 * Right now is read again every 30 s while the page is visible. A person opens
 * in the detail dialog. Trends, Books and Habits share one period picker; the
 * choice is remembered in this browser (localStorage, a convenience: the page
 * works without it). A book opens in the same dialog, from Trends, Books or a
 * person's books.
 *
 * Every read goes through readLive, on the page's signal. Markup is built with
 * textContent only. Time in Plex apps is called an estimate wherever it shows,
 * and drawn hatched (.ins-est, insights.html) wherever it is a mark.
 * The page has no blue primary button (at most one per view, and this page
 * needs none): its buttons are all the neutral kind.
 *
 * A soft-navigation page (spec 4.2): everything runs from mount(ctx), and every
 * listener, fetch and timer ends with ctx.signal.
 */
const NOW_EVERY_MS = 30 * 1000;
const MOUNT_WAIT_MS = 1500;
const API = '/api/admin/insights/';

const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
const NEUTRAL = 'ws-lift inline-flex h-10 items-center rounded-[10px] border border-frosted-blue/15 px-4 text-[15px] font-semibold text-frosted-blue hover:bg-frosted-blue/[0.07] ' + FOCUS;
const MUTED = 'text-[15px] leading-6 text-frosted-blue/70';
const SMALL = 'text-[13px] leading-5 text-frosted-blue/70';
const H3 = 'text-[17px] font-semibold text-frosted-blue';
const ROW = 'flex w-full min-w-0 items-start gap-3 rounded-xl px-3 py-2 -mx-3 text-left transition-colors hover:bg-frosted-blue/[0.07] ' + FOCUS;
// Plex app time, drawn as a mark: hatched, never a plain lighter fill alone.
const EST = 'ins-est';
// One bar's parts, top to bottom: the Plex estimate over the web player.
const LISTEN_PARTS = [['plex_ms', EST], ['web_ms', 'bg-frosted-blue']];
const WHAT = {
  listening: 'listening', plex: 'listening in a Plex app', reading: 'reading',
  visit: 'opening Books', request: 'asking for a book'
};
const PERIODS = ['30d', '90d', '1y', 'all'];
const PERIOD_KEY = 'webservarr:insights:period';
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// The heatmap's five steps, none to most; the key under it shows the same five.
const HEAT = ['bg-frosted-blue/[0.04]', 'bg-frosted-blue/20', 'bg-frosted-blue/40', 'bg-frosted-blue/65', 'bg-frosted-blue'];

function isAbort(e) { return !!e && e.name === 'AbortError'; }

function el(tag, cls, words) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (words !== undefined && words !== null) n.textContent = words;
  return n;
}

function icon(name, cls) {
  const s = el('span', 'material-symbols-outlined' + (cls ? ' ' + cls : ''), name);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function num(n) { return typeof n === 'number' && isFinite(n) && n > 0 ? n : 0; }

function text(v) { return typeof v === 'string' ? v : ''; }

/** A time in words: "45 min", "3 hr", "12 hr 30 min"; a few seconds is "under 1 min", not "0 min". */
function duration(ms) {
  const minutes = Math.round(num(ms) / 60000);
  if (!minutes && num(ms)) return 'under 1 min';
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours.toLocaleString() + ' hr' + (rest ? ' ' + rest + ' min' : '');
}

/** A day ("2026-10-11") or a moment (ISO with a zone) as the approved design
    writes it, day first in every browser: "11 Oct 2026". */
function dayLabel(iso) {
  const s = text(iso);
  let d = null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  else if (s) d = new Date(s);
  if (!d || !isFinite(d.getTime())) return '';
  try {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return s.slice(0, 10);
  }
}

/** How long ago, in words: "just now", "5 min ago", "3 hr ago", "yesterday", "4 days ago", else the day. */
function ago(iso, now) {
  const t = Date.parse(text(iso));
  if (!isFinite(t)) return '';
  const minutes = Math.max(0, Math.round((now - t) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' hr ago';
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? 'yesterday' : days + ' days ago';
  return dayLabel(iso);
}

/** The browser's own time zone (an IANA name), or nothing. */
function timeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.length <= 64 ? tz : '';
  } catch (e) {
    return '';
  }
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** The period this browser chose last time; 90 days without one (or without storage). */
function storedPeriod() {
  try {
    const p = window.localStorage.getItem(PERIOD_KEY);
    return PERIODS.indexOf(p) === -1 ? '90d' : p;
  } catch (e) {
    return '90d';              // storage blocked (a private window): the default
  }
}

function storePeriod(p) {
  try {
    window.localStorage.setItem(PERIOD_KEY, p);
  } catch (e) {
    // Storage blocked: the choice lasts this visit only, which is all a convenience owes.
  }
}

/** A bucket's start in words, day first as the rest of the page: a day,
    "Week of 5 Oct 2026", or "October 2026". */
function bucketLabel(start, unit) {
  if (unit === 'week') return 'Week of ' + dayLabel(start);
  if (unit !== 'month') return dayLabel(start);
  const m = /^(\d{4})-(\d{2})/.exec(text(start));
  if (!m) return '';
  try {
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  } catch (e) {
    return m[0];
  }
}

function people(n) { return num(n).toLocaleString() + (num(n) === 1 ? ' person' : ' people'); }

function hourLabel(h) { return (h < 10 ? '0' : '') + h + ':00'; }

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;
  const $ = function (id) { return root.querySelector('#' + id); };
  const tz = timeZone();
  const state = { gen: {}, nowJSON: '', opener: null, detailGen: 0, period: storedPeriod() };

  function quiet(err) { return signal.aborted || isAbort(err); }

  /** Every read of the page, from the server, on the page's signal. */
  function readLive(url) {
    return WS.getJSON(url, { signal: signal });
  }

  function withZone(url) {
    return tz ? url + (url.indexOf('?') === -1 ? '?' : '&') + 'tz=' + encodeURIComponent(tz) : url;
  }

  // ---- Sections ----

  /** A section's body (its skeleton, or what an earlier load drew) becomes `node`. */
  function setBody(sectionId, node) {
    const section = $(sectionId);
    node.setAttribute('data-ins-body', '');
    section.querySelector('[data-ins-body]').replaceWith(node);
    section.setAttribute('aria-busy', 'false');
  }

  function noteLine(words, source) {
    const p = el('p', 'flex items-start gap-2 ' + MUTED);
    p.setAttribute('data-ins-unavailable', source);
    p.appendChild(icon('cloud_off', 'mt-1 text-base'));
    p.appendChild(el('span', 'min-w-0', words));
    return p;
  }

  /** The lines saying a source could not be read, drawn in place of nothing else. */
  function unavailableLines(list) {
    const missing = Array.isArray(list) ? list : [];
    const box = el('div', 'mb-3 space-y-1');
    if (missing.indexOf('plex') !== -1) {
      box.appendChild(noteLine('Plex isn’t answering, so listening in Plex apps is missing here.', 'plex'));
    }
    if (missing.indexOf('kavita') !== -1) {
      box.appendChild(noteLine('Kavita didn’t answer the last nightly read, so reading may be a day behind.', 'kavita'));
    }
    return box.firstChild ? box : null;
  }

  function failed(retry) {
    const box = el('div', 'mt-4');
    box.setAttribute('data-ins-failed', '');
    box.appendChild(el('p', MUTED, 'This part couldn’t load.'));
    const again = el('button', NEUTRAL + ' mt-3', 'Try again');
    again.type = 'button';
    again.addEventListener('click', retry, { signal: signal });
    box.appendChild(again);
    return box;
  }

  /** Nothing to show: what this part will show, and since when it has been recorded. */
  function emptyLine(words, since) {
    const box = el('div', 'mt-3');
    box.setAttribute('data-ins-empty', '');
    box.appendChild(el('p', MUTED, words));
    const day = dayLabel(since);
    if (day) box.appendChild(el('p', SMALL, 'Tracking started on ' + day + '.'));
    return box;
  }

  /** One section's read: the answer replaces its body in one write, in the
      page's top-down order (WS.arrive); a failure replaces it with Try again. */
  function load(sectionId, arriveKey, url, draw) {
    const gen = (state.gen[sectionId] || 0) + 1;
    state.gen[sectionId] = gen;
    function current() { return !signal.aborted && gen === state.gen[sectionId]; }
    return readLive(url).then(function (data) {
      if (!current()) return;
      WS.arrive(arriveKey, function () {
        if (current()) setBody(sectionId, draw(data && typeof data === 'object' ? data : {}));
      });
    }, function (err) {
      if (quiet(err) || !current()) return;
      WS.arrive(arriveKey, function () {
        if (current()) setBody(sectionId, failed(function () { load(sectionId, arriveKey, url, draw); }));
      });
    });
  }

  // ---- Right now ----

  function nowJSON(data) {
    return JSON.stringify([data.listening, data.reading, data.unavailable]);
  }

  function nowItem(item, audio) {
    const li = el('li', 'flex min-w-0 items-start gap-3 rounded-xl border border-frosted-blue/10 px-3 py-3');
    li.setAttribute('data-ins-now', audio ? 'listening' : 'reading');
    li.appendChild(icon(audio ? 'headphones' : 'menu_book', 'mt-0.5 text-xl text-frosted-blue/70'));
    const body = el('div', 'min-w-0 flex-1');
    body.appendChild(el('p', 'break-words text-[15px] font-semibold text-frosted-blue', text(item.name)));
    body.appendChild(el('p', 'break-words text-[15px] leading-6 text-frosted-blue', text(item.title)));
    const bits = [];
    if (audio) bits.push(item.state === 'playing' ? 'Playing' : 'Paused');
    bits.push(item.where === 'plex' ? 'in a Plex app' : (audio ? 'in the web player' : 'in the reader'));
    if (typeof item.percent === 'number') bits.push(item.percent + '% through');
    body.appendChild(el('p', SMALL, bits.join(' · ')));
    li.appendChild(body);
    return li;
  }

  function drawNow(data) {
    state.nowJSON = nowJSON(data);
    const box = el('div', 'mt-4');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const listening = Array.isArray(data.listening) ? data.listening.filter(Boolean) : [];
    const reading = Array.isArray(data.reading) ? data.reading.filter(Boolean) : [];
    if (!listening.length && !reading.length) {
      box.appendChild(emptyLine('No one is listening or reading right now.'));
      return box;
    }
    const list = el('ul', 'grid gap-2 sm:grid-cols-2');
    listening.forEach(function (item) { list.appendChild(nowItem(item, true)); });
    reading.forEach(function (item) { list.appendChild(nowItem(item, false)); });
    box.appendChild(list);
    return box;
  }

  /** The 30 s refresh: drawn again only when the answer changed. A missed
      refresh keeps what is on screen; the next one tries again. */
  function refreshNow() {
    return readLive(API + 'now').then(function (data) {
      const fresh = data && typeof data === 'object' ? data : {};
      if (signal.aborted || nowJSON(fresh) === state.nowJSON) return;
      setBody('insNow', drawNow(fresh));
    }, function (err) {
      if (!quiet(err) && window.console) console.info('Insights: Right now was not refreshed', err && err.message);
    });
  }

  // ---- People ----

  function drawPeople(data) {
    const box = el('div', 'mt-4');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const people = (Array.isArray(data.people) ? data.people : []).filter(function (p) {
      return p && typeof p.key === 'string';
    });
    if (!people.length) {
      box.appendChild(emptyLine('No one has listened or read yet.'));
      return box;
    }
    const now = Date.now();
    const list = el('ul', 'divide-y divide-frosted-blue/10');
    people.forEach(function (p) {
      const li = el('li', 'py-1');
      const open = el('button', ROW);
      open.type = 'button';
      open.setAttribute('data-ins-person', p.key);
      // Narrow: one stack. From lg: who, time listened and books in three columns.
      const main = el('span', 'block min-w-0 flex-1 lg:grid lg:grid-cols-[minmax(0,15rem)_minmax(0,13rem)_minmax(0,1fr)] lg:gap-x-6');
      const who = el('span', 'block min-w-0');
      who.appendChild(el('span', 'block break-words text-[15px] font-semibold text-frosted-blue', text(p.name)));
      const last = p.last_active ? 'Last active ' + ago(p.last_active, now) + (WHAT[p.last_what] ? ', ' + WHAT[p.last_what] : '')
        : 'Not active yet';
      who.appendChild(el('span', 'block ' + SMALL, last));
      main.appendChild(who);
      const plex = num(p.plex_ms_30d);
      const listened = num(p.listened_ms_30d) + plex;
      main.appendChild(el('span', 'block min-w-0 ' + SMALL, listened ? duration(listened) + ' listened in 30 days' +
        (plex ? ' (' + duration(plex) + ' in Plex apps, an estimate)' : '') : ''));
      const current = Array.isArray(p.current) ? p.current.filter(Boolean) : [];
      if (current.length) {
        const books = el('span', 'mt-1 flex min-w-0 flex-wrap gap-x-4 gap-y-1 lg:mt-0');
        current.forEach(function (c) {
          const how = typeof c.percent === 'number' ? ' · ' + c.percent + '%' : (c.where === 'plex' ? ' · in a Plex app' : '');
          const b = el('span', 'min-w-0 max-w-full break-words text-[13px] leading-5 text-frosted-blue/85', text(c.title));
          if (how) b.appendChild(el('span', 'text-frosted-blue/60', how));
          books.appendChild(b);
        });
        main.appendChild(books);
      }
      open.appendChild(main);
      open.appendChild(icon('chevron_right', 'mt-0.5 text-xl text-frosted-blue/50'));
      open.addEventListener('click', function () { openPerson(p.key, text(p.name), open); }, { signal: signal });
      li.appendChild(open);
      list.appendChild(li);
    });
    box.appendChild(list);
    return box;
  }

  // ---- The detail dialog ----

  const dialog = $('insDetail');

  function giveFocusBack() {
    const opener = state.opener;
    state.opener = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  }

  function closeDetail() {
    state.detailGen += 1;                  // a late answer draws nothing
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    giveFocusBack();
  }

  const closeButton = dialog.querySelector('[data-ins-close]');
  closeButton.addEventListener('click', closeDetail, { signal: signal });
  // Escape (the browser closes the dialog itself) gives focus back the same way.
  // Leaving the page swaps #wsPage out, dialog and all, which takes it off the
  // top layer; a late answer then draws nothing (state.detailGen, signal).
  dialog.addEventListener('close', function () { state.detailGen += 1; giveFocusBack(); }, { signal: signal });
  // A click on the dim area around the box (from sm up) lands on the dialog
  // itself, never on its content, and closes it.
  dialog.addEventListener('click', function (e) { if (e.target === dialog) closeDetail(); }, { signal: signal });

  function openDetail(title, url, draw, opener) {
    state.detailGen += 1;
    const gen = state.detailGen;
    if (opener) state.opener = opener;   // a book opened from a person keeps the row that opened the person
    $('insDetailTitle').textContent = title;
    const body = $('insDetailBody');
    // A book opened from inside the dialog: the button that had focus is about
    // to go, so focus moves to Close rather than falling out to the page.
    if (body.contains(document.activeElement)) closeButton.focus();
    clear(body);
    body.appendChild(el('div', 'skel h-40 rounded-xl'));
    if (!dialog.hasAttribute('open')) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    readLive(url).then(function (data) {
      if (signal.aborted || gen !== state.detailGen) return;
      const answer = data && typeof data === 'object' ? data : {};
      $('insDetailTitle').textContent = text(answer.name) || text(answer.title) || title;
      clear(body);
      body.appendChild(draw(answer));
    }, function (err) {
      if (quiet(err) || gen !== state.detailGen) return;
      clear(body);
      body.appendChild(el('p', MUTED, err && err.status === 404 ? 'That person or book isn’t here any more.'
        : 'This part couldn’t load.'));
    });
  }

  /** One figure: what it is, then the number (shown above its words). */
  function figure(value, label) {
    const dl = el('dl', 'flex flex-col-reverse');
    dl.appendChild(el('dt', 'mt-1 ' + SMALL, label));
    dl.appendChild(el('dd', 'text-[24px] font-extrabold leading-[1.1] tracking-[-0.02em] tabular-nums text-frosted-blue', value));
    return dl;
  }

  function bar(ms, most, cls) {
    const b = el('span', 'ins-bar block w-full ' + cls);
    b.setAttribute('aria-hidden', 'true');
    b.style.height = ms && most ? Math.max(2, Math.round(ms / most * 100)) + '%' : '0';
    return b;
  }

  /** One bar's parts (pairs of field and class), top to bottom: only the parts
      with time, a 2px gap between them, 4px round corners on the top one. */
  function stack(li, parts, row, most) {
    const shown = parts.filter(function (p) { return num(row[p[0]]) > 0; });
    shown.forEach(function (p, i) {
      li.appendChild(bar(num(row[p[0]]), most, p[1] + (i === 0 ? ' rounded-t-[4px]' : '') + (i < shown.length - 1 ? ' mb-[2px]' : '')));
    });
  }

  /** The tallest value, on a faint line at the chart's top (its dashed edge). */
  function peak(words) {
    const p = el('p', 'mt-3 tabular-nums ' + SMALL, words);
    p.setAttribute('aria-hidden', 'true');
    p.setAttribute('data-ins-peak', '');
    return p;
  }

  /** The first and last bucket under a chart, so the bars have a time scale. */
  function ends(first, last) {
    const row = el('div', 'mt-2 flex justify-between gap-4 ' + SMALL);
    row.setAttribute('aria-hidden', 'true');
    row.appendChild(el('span', '', first));
    row.appendChild(el('span', '', last));
    return row;
  }

  function legend() {
    const p = el('p', 'mt-2 flex flex-wrap gap-x-4 gap-y-1 ' + SMALL);
    p.setAttribute('aria-hidden', 'true');
    [['bg-frosted-blue', 'Web player'], [EST, 'Plex apps (an estimate)']].forEach(function (k) {
      const item = el('span', 'inline-flex items-center gap-1.5');
      item.appendChild(el('span', 'inline-block size-2.5 rounded-sm ' + k[0]));
      item.appendChild(el('span', '', k[1]));
      p.appendChild(item);
    });
    return p;
  }

  /** 12 weeks of bars, web and Plex apps stacked; each week said in words. */
  function weeklyBars(weeks) {
    const section = el('section', 'mt-8');
    section.setAttribute('data-ins-weekly', '');
    section.appendChild(el('h3', H3, 'Each week'));
    const most = weeks.reduce(function (m, w) { return Math.max(m, num(w.web_ms) + num(w.plex_ms)); }, 0);
    if (!most) {
      section.appendChild(el('p', MUTED + ' mt-1', 'Nothing in the last 12 weeks.'));
      return section;
    }
    section.appendChild(peak(duration(most)));
    const list = el('ol', 'mt-1 grid h-32 grid-cols-12 items-end gap-1 border-y border-frosted-blue/10 sm:gap-2');
    list.style.borderTopStyle = 'dashed';
    weeks.forEach(function (w) {
      const web = num(w.web_ms);
      const plex = num(w.plex_ms);
      const words = 'Week of ' + dayLabel(w.week) + ': ' + duration(web) +
        (plex ? ', and ' + duration(plex) + ' in Plex apps (an estimate)' : '');
      const li = el('li', 'flex h-full min-w-0 flex-col justify-end');
      li.title = words;
      li.appendChild(el('span', 'sr-only', words));
      stack(li, LISTEN_PARTS, w, most);
      list.appendChild(li);
    });
    section.appendChild(list);
    section.appendChild(ends('Week of ' + dayLabel(weeks[0].week), 'Week of ' + dayLabel(weeks[weeks.length - 1].week)));
    section.appendChild(legend());
    return section;
  }

  function bookLine(b, now) {
    const bits = [];
    if (text(b.author)) bits.push(b.author);
    bits.push(b.finished ? 'Finished' : (typeof b.percent === 'number' ? b.percent + '% through' : 'Started'));
    const time = num(b.listened_ms) + num(b.plex_ms);
    if (time) bits.push(duration(time) + ' listened' + (num(b.plex_ms) ? ' (the Plex part an estimate)' : ''));
    if (b.last_at) bits.push(ago(b.last_at, now));
    return bits.join(' · ');
  }

  function bookList(books) {
    const section = el('section', 'mt-8');
    section.appendChild(el('h3', H3, 'Books'));
    if (!books.length) {
      section.appendChild(el('p', MUTED + ' mt-1', 'No books yet.'));
      return section;
    }
    const now = Date.now();
    const list = el('ul', 'mt-2 divide-y divide-frosted-blue/10');
    books.forEach(function (b) {
      // No opener: Close then gives focus back to the person's row in People.
      const li = bookItem(b.book_id, text(b.title), bookLine(b, now), 'data-ins-detail-book', false);
      li.setAttribute('data-ins-book-row', '');
      list.appendChild(li);
    });
    section.appendChild(list);
    return section;
  }

  function requestList(items, tracking) {
    const section = el('section', 'mt-8');
    section.appendChild(el('h3', H3, 'Requests'));
    if (!items.length) {
      section.appendChild(emptyLine('No book requests.', tracking && tracking.requests));
      return section;
    }
    const list = el('ul', 'mt-2 space-y-2');
    items.forEach(function (r) {
      const li = el('li', 'min-w-0');
      li.appendChild(el('p', 'break-words text-[15px] text-frosted-blue', text(r.title)));
      const how = r.book_id === null || r.book_id === undefined ? 'not in the library yet'
        : (r.started_at ? 'started ' + dayLabel(r.started_at) : 'not started');
      li.appendChild(el('p', SMALL, 'Asked ' + dayLabel(r.requested_at) + ' · ' + how + ' (matched by title)'));
      list.appendChild(li);
    });
    section.appendChild(list);
    return section;
  }

  function drawPerson(data) {
    const box = el('div', '');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const t = data.totals && typeof data.totals === 'object' ? data.totals : {};
    const row = el('div', 'grid grid-cols-2 gap-x-8 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-12');
    row.setAttribute('data-ins-totals', '');
    row.appendChild(figure(duration(t.listened_ms), 'In the web player'));
    if (num(t.plex_ms)) row.appendChild(figure(duration(t.plex_ms), 'In Plex apps (an estimate)'));
    const finished = num(t.finished);
    row.appendChild(figure(finished.toLocaleString(), finished === 1 ? 'Book finished' : 'Books finished'));
    if (typeof t.pages_read === 'number') row.appendChild(figure(t.pages_read.toLocaleString(), 'Pages read, by Kavita’s count'));
    box.appendChild(row);
    box.appendChild(weeklyBars(Array.isArray(data.weekly) ? data.weekly.filter(Boolean) : []));
    box.appendChild(bookList(Array.isArray(data.books) ? data.books.filter(Boolean) : []));
    box.appendChild(requestList(Array.isArray(data.requests) ? data.requests.filter(Boolean) : [], data.tracking));
    return box;
  }

  function openPerson(key, name, opener) {
    openDetail(name, withZone(API + 'person?key=' + encodeURIComponent(key)), drawPerson, opener);
  }

  // ---- Charts and lists shared by Trends, Books and Habits ----

  /** A bar chart over time: its tallest value on the dashed top edge, a bar a
      bucket (each said in words), the first and last bucket under it. */
  function barChart(hook, title, buckets, unit, parts, words, peakWords, heightCls) {
    const section = el('section', 'min-w-0');
    section.setAttribute(hook, '');
    section.appendChild(el('h3', H3, title));
    const most = buckets.reduce(function (m, b) {
      return Math.max(m, parts.reduce(function (sum, p) { return sum + num(b[p[0]]); }, 0));
    }, 0);
    if (!most) {
      section.appendChild(el('p', MUTED + ' mt-1', 'Nothing in this period.'));
      return section;
    }
    section.appendChild(peak(peakWords(most)));
    const list = el('ol', 'mt-1 flex ' + heightCls + ' items-end gap-px border-y border-frosted-blue/10 sm:gap-1');
    list.style.borderTopStyle = 'dashed';
    buckets.forEach(function (b) {
      const said = words(b);
      const li = el('li', 'flex h-full min-w-0 flex-1 flex-col justify-end');
      li.title = said;
      li.appendChild(el('span', 'sr-only', said));
      stack(li, parts, b, most);
      list.appendChild(li);
    });
    section.appendChild(list);
    const first = buckets[0];
    const last = buckets[buckets.length - 1];
    section.appendChild(ends(bucketLabel(first.start || first.week, unit), bucketLabel(last.start || last.week, unit)));
    return section;
  }

  /** A book in a list: a button that opens it when it is a library book, else
      plain words. An opener of false keeps whatever opened the dialog already. */
  function bookItem(bookId, title, line, hook, opener) {
    const li = el('li', 'min-w-0 py-1');
    const isBook = typeof bookId === 'number';
    const holder = isBook ? el('button', ROW) : el('div', 'w-full min-w-0 px-3 py-2 -mx-3');
    const words = el('span', 'block min-w-0 flex-1');
    words.appendChild(el('span', 'block break-words text-[15px] font-semibold text-frosted-blue', title));
    words.appendChild(el('span', 'block break-words ' + SMALL, line));
    holder.appendChild(words);
    if (isBook) {
      holder.type = 'button';
      holder.setAttribute(hook || 'data-ins-book', String(bookId));
      holder.appendChild(icon('chevron_right', 'mt-0.5 text-xl text-frosted-blue/50'));
      holder.addEventListener('click', function () {
        openBook(bookId, title, opener === false ? null : holder);
      }, { signal: signal });
    }
    li.appendChild(holder);
    return li;
  }

  function topList(title, rows, books) {
    const section = el('section', 'min-w-0');
    section.setAttribute('data-ins-top', title);
    section.appendChild(el('h3', H3, title));
    const list = (Array.isArray(rows) ? rows : []).filter(function (r) { return r && (text(r.title) || text(r.name)); });
    if (!list.length) {
      section.appendChild(el('p', MUTED + ' mt-1', 'Nothing in this period.'));
      return section;
    }
    const ol = el('ol', 'mt-2 space-y-1');
    list.forEach(function (r) {
      const line = (num(r.listened_ms) ? duration(r.listened_ms) + ' · ' : '') + people(r.people);
      const li = bookItem(books ? r.book_id : null, text(r.title) || text(r.name), line);
      ol.appendChild(li);
    });
    section.appendChild(ol);
    return section;
  }

  // ---- Trends ----

  function drawTrends(data) {
    const box = el('div', 'mt-2');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const unit = text(data.bucket);
    const buckets = Array.isArray(data.buckets) ? data.buckets.filter(Boolean) : [];
    const tracking = data.tracking || {};
    // From lg: Hours listened leads in a 3fr column; the two smaller charts stack in 2fr beside it.
    const grid = el('div', 'mt-2 grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-10');
    const lead = el('div', 'min-w-0');
    lead.appendChild(barChart('data-ins-trend', 'Hours listened', buckets, unit, LISTEN_PARTS, function (b) {
      return bucketLabel(b.start, unit) + ': ' + duration(b.web_ms) +
        (num(b.plex_ms) ? ', and ' + duration(b.plex_ms) + ' in Plex apps (an estimate)' : '');
    }, duration, 'h-40 lg:h-[216px]'));
    if (buckets.some(function (b) { return num(b.web_ms) + num(b.plex_ms); })) lead.appendChild(legend());
    grid.appendChild(lead);
    const side = el('div', 'grid min-w-0 content-start gap-8 lg:gap-6');
    if (!buckets.length || buckets.every(function (b) { return b.pages === null || b.pages === undefined; })) {
      const pages = el('section', 'min-w-0');
      pages.setAttribute('data-ins-pages', '');
      pages.appendChild(el('h3', H3, 'Pages read'));
      pages.appendChild(emptyLine('Pages read show here once reading in Kavita is recorded.', tracking.reading));
      side.appendChild(pages);
    } else {
      const pages = barChart('data-ins-pages', 'Pages read', buckets, unit, [['pages', 'bg-frosted-blue/70']], function (b) {
        return bucketLabel(b.start, unit) + ': ' + num(b.pages).toLocaleString() + ' pages';
      }, function (most) { return most.toLocaleString() + ' pages'; }, 'h-28 lg:h-20');
      pages.appendChild(el('p', 'mt-1 ' + SMALL, 'By Kavita’s count; across days without a read, an estimate.'));
      side.appendChild(pages);
    }
    const active = Array.isArray(data.active) ? data.active.filter(Boolean) : [];
    side.appendChild(barChart('data-ins-active', 'Active people each week', active, 'week', [['people', 'bg-frosted-blue/70']], function (w) {
      return 'Week of ' + dayLabel(w.week) + ': ' + people(w.people);
    }, people, 'h-28 lg:h-20'));
    grid.appendChild(side);
    box.appendChild(grid);
    const tops = el('div', 'mt-10 grid gap-8 lg:grid-cols-3');
    tops.appendChild(topList('Top books', data.top_books, true));
    tops.appendChild(topList('Top authors', data.top_authors, false));
    tops.appendChild(topList('Top series', data.top_series, false));
    box.appendChild(tops);
    const timed = [data.top_books, data.top_authors, data.top_series].some(function (rows) {
      return Array.isArray(rows) && rows.some(function (r) { return r && num(r.listened_ms); });
    });
    if (timed) box.appendChild(el('p', 'mt-3 ' + SMALL, 'Times include listening in Plex apps, which is an estimate.'));
    return box;
  }

  // ---- Books ----

  function drawBooks(data) {
    const box = el('div', 'mt-2');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const now = Date.now();
    const cols = el('div', 'grid gap-8 lg:grid-cols-2 lg:gap-x-10');

    const gone = el('section', 'mt-2 min-w-0');
    gone.setAttribute('data-ins-abandoned', '');
    gone.appendChild(el('h3', H3, 'Abandoned'));
    gone.appendChild(el('p', SMALL, 'Unfinished and untouched for 30 days or more.'));
    const abandoned = Array.isArray(data.abandoned) ? data.abandoned.filter(Boolean) : [];
    if (!abandoned.length) {
      gone.appendChild(el('p', MUTED + ' mt-2', 'Nothing abandoned.'));
    } else {
      const list = el('ul', 'mt-2 divide-y divide-frosted-blue/10');
      abandoned.forEach(function (a) {
        const bits = [text(a.name)];
        if (typeof a.percent === 'number') bits.push(a.percent + '%');
        if (text(a.chapter)) bits.push('stopped in ' + a.chapter);
        const when = ago(a.last_at, now);
        if (when) bits.push('last touched ' + when);
        list.appendChild(bookItem(a.book_id, text(a.title), bits.join(' · ')));
      });
      gone.appendChild(list);
    }
    cols.appendChild(gone);

    const fin = el('section', 'mt-2 min-w-0');
    fin.setAttribute('data-ins-finish', '');
    fin.appendChild(el('h3', H3, 'Finish rate'));
    fin.appendChild(el('p', SMALL, 'Books two or more people started in this period.'));
    const finish = Array.isArray(data.finish) ? data.finish.filter(Boolean) : [];
    if (!finish.length) {
      fin.appendChild(el('p', MUTED + ' mt-2', 'No book has two starters in this period.'));
    } else {
      const list = el('ul', 'mt-2 divide-y divide-frosted-blue/10');
      finish.forEach(function (f) {
        let words = num(f.started) + ' started · ' + num(f.finished) + ' finished · ' + num(f.rate) + '%';
        if (f.drop_off && text(f.drop_off.chapter)) {
          words += ' · most who stopped, stopped in ' + f.drop_off.chapter + ' (' + people(f.drop_off.people) + ')';
        }
        list.appendChild(bookItem(f.book_id, text(f.title), words));
      });
      fin.appendChild(list);
    }
    cols.appendChild(fin);
    box.appendChild(cols);

    const never = el('section', 'mt-8');
    never.setAttribute('data-ins-never', '');
    never.appendChild(el('h3', H3, 'Never opened'));
    const nv = data.never_opened && typeof data.never_opened === 'object' ? data.never_opened : {};
    const count = num(nv.count);
    never.appendChild(el('p', SMALL, count.toLocaleString() + (count === 1 ? ' book' : ' books') +
      ' no one has opened, as far as WebServarr can tell.'));
    const items = Array.isArray(nv.items) ? nv.items.filter(Boolean) : [];
    if (items.length) {
      const list = el('ul', 'mt-2 grid divide-y divide-frosted-blue/10 lg:grid-cols-2 lg:gap-x-10 lg:divide-y-0');
      items.forEach(function (b) {
        list.appendChild(bookItem(b.book_id, text(b.title), [text(b.author), b.added_at ? 'added ' + dayLabel(b.added_at) : '']
          .filter(Boolean).join(' · ')));
      });
      never.appendChild(list);
      if (count > items.length) never.appendChild(el('p', 'mt-2 ' + SMALL, 'The newest ' + items.length.toLocaleString() + ' are listed.'));
    }
    box.appendChild(never);
    return box;
  }

  // ---- Habits ----

  function heatmap(rows) {
    const section = el('section', 'mt-8');
    section.setAttribute('data-ins-heatmap', '');
    section.appendChild(el('h3', H3, 'Time of day'));
    const grid = DAYS.map(function (_d, i) {
      const row = Array.isArray(rows) && Array.isArray(rows[i]) ? rows[i] : [];
      const hours = [];
      for (let h = 0; h < 24; h++) hours.push(num(row[h]));
      return hours;
    });
    let most = 0;
    let busiest = null;
    grid.forEach(function (hours, d) {
      hours.forEach(function (ms, h) { if (ms > most) { most = ms; busiest = [d, h]; } });
    });
    const line = el('p', SMALL, busiest ? 'Busiest: ' + DAYS[busiest[0]] + ', ' + hourLabel(busiest[1]) : 'No listening in this period.');
    line.setAttribute('data-ins-busiest', '');
    section.appendChild(line);
    if (!busiest) return section;
    const wrap = el('div', 'mt-3 max-w-full lg:max-w-[880px]');
    const table = el('table', 'w-full table-fixed border-separate border-spacing-[2px]');
    table.appendChild(el('caption', 'sr-only', 'Listening by day and hour, in your time zone. The Plex app part is an estimate.'));
    const head = el('thead', '');
    const hr = el('tr', '');
    hr.appendChild(el('th', 'w-9', ''));
    for (let h = 0; h < 24; h++) {
      const th = el('th', 'p-0 text-center text-[12px] font-normal text-frosted-blue/60', h % 6 === 0 ? String(h) : '');
      th.setAttribute('scope', 'col');
      th.setAttribute('aria-label', hourLabel(h));
      hr.appendChild(th);
    }
    head.appendChild(hr);
    table.appendChild(head);
    const body = el('tbody', '');
    grid.forEach(function (hours, d) {
      const tr = el('tr', '');
      const th = el('th', 'pr-1 text-left text-[12px] font-normal text-frosted-blue/70', DAY_SHORT[d]);
      th.setAttribute('scope', 'row');
      th.setAttribute('aria-label', DAYS[d]);
      tr.appendChild(th);
      hours.forEach(function (ms, h) {
        const level = ms ? Math.min(4, Math.ceil(ms / most * 4)) : 0;
        const td = el('td', 'h-4 rounded-[3px] p-0 sm:h-5 ' + HEAT[level]);
        const said = DAYS[d] + ', ' + hourLabel(h) + ': ' + (ms ? duration(ms) : 'nothing');
        td.title = said;
        td.appendChild(el('span', 'sr-only', said));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    // In sight, not only in the caption: the estimate rule covers every figure that includes Plex.
    const foot = el('div', 'mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 ' + SMALL);
    foot.appendChild(el('span', 'min-w-0', 'In your time zone. Plex app listening in it is an estimate.'));
    const key = el('span', 'inline-flex items-center gap-1');
    key.setAttribute('aria-hidden', 'true');
    key.setAttribute('data-ins-key', '');
    key.appendChild(el('span', 'mr-1', 'Less'));
    HEAT.forEach(function (c) { key.appendChild(el('span', 'inline-block size-3 rounded-[3px] ' + c)); });
    key.appendChild(el('span', 'ml-1', 'More'));
    foot.appendChild(key);
    wrap.appendChild(foot);
    section.appendChild(wrap);
    return section;
  }

  function drawHabits(data) {
    const box = el('div', 'mt-2');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const split = data.split && typeof data.split === 'object' ? data.split : {};
    const web = num(split.web_ms);
    const plex = num(split.plex_ms);
    const both = el('section', 'mt-2 lg:max-w-[880px]');
    both.setAttribute('data-ins-split', '');
    both.appendChild(el('h3', H3, 'Web player and Plex apps'));
    if (!web && !plex) {
      both.appendChild(el('p', MUTED + ' mt-1', 'No listening in this period.'));
    } else {
      // The web player solid, the Plex estimate hatched after a 2px gap.
      const track = el('div', 'mt-3 flex h-3 gap-[2px] overflow-hidden rounded-full');
      track.setAttribute('aria-hidden', 'true');
      if (web) {
        const a = el('span', 'block h-full bg-frosted-blue');
        a.style.width = Math.round(web / (web + plex) * 100) + '%';
        track.appendChild(a);
      }
      if (plex) track.appendChild(el('span', 'block h-full flex-1 ' + EST));
      both.appendChild(track);
      both.appendChild(el('p', 'mt-2 ' + SMALL, 'Web player ' + duration(web) + ' · Plex apps ' + duration(plex) + ' (an estimate)'));
    }
    box.appendChild(both);
    box.appendChild(heatmap(data.heatmap));

    const asked = el('section', 'mt-8');
    asked.setAttribute('data-ins-requested', '');
    asked.appendChild(el('h3', H3, 'Requested then read'));
    const req = data.requested && typeof data.requested === 'object' ? data.requested : {};
    const items = Array.isArray(req.items) ? req.items.filter(Boolean) : [];
    if (!num(req.total)) {
      asked.appendChild(emptyLine('No book requests in this period.', (data.tracking || {}).requests));
    } else {
      asked.appendChild(el('p', SMALL, num(req.read) + ' of ' + num(req.total) +
        (num(req.total) === 1 ? ' requested book was' : ' requested books were') +
        ' started by the person who asked (matched by title).'));
      const list = el('ul', 'mt-2 grid divide-y divide-frosted-blue/10 lg:grid-cols-2 lg:gap-x-10 lg:divide-y-0');
      items.forEach(function (r) {
        const how = r.book_id === null || r.book_id === undefined ? 'not in the library yet'
          : (r.started_at ? 'started ' + dayLabel(r.started_at) : 'not started');
        list.appendChild(bookItem(r.book_id, text(r.title), text(r.name) + ' · asked ' + dayLabel(r.requested_at) + ' · ' + how));
      });
      asked.appendChild(list);
    }
    box.appendChild(asked);
    return box;
  }

  // ---- One book ----

  function drawBook(data) {
    const box = el('div', '');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const meta = [text(data.author), text(data.series)].filter(Boolean).join(' · ');
    if (meta) box.appendChild(el('p', MUTED, meta));
    const t = data.totals && typeof data.totals === 'object' ? data.totals : {};
    const row = el('div', 'mt-4 grid grid-cols-2 gap-x-8 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-12');
    row.setAttribute('data-ins-totals', '');
    row.appendChild(figure(num(t.started).toLocaleString(), 'Started'));
    row.appendChild(figure(num(t.finished).toLocaleString(), 'Finished'));
    row.appendChild(figure(num(t.rate) + '%', 'Finish rate'));
    row.appendChild(figure(duration(t.listened_ms), 'In the web player'));
    if (num(t.plex_ms)) row.appendChild(figure(duration(t.plex_ms), 'In Plex apps (an estimate)'));
    box.appendChild(row);
    if (data.drop_off && text(data.drop_off.chapter)) {
      box.appendChild(el('p', MUTED + ' mt-4', 'Most who stopped, stopped in ' + data.drop_off.chapter + ' (' + people(data.drop_off.people) + ').'));
    }
    const now = Date.now();
    const who = el('section', 'mt-8');
    who.appendChild(el('h3', H3, 'People'));
    const listed = Array.isArray(data.people) ? data.people.filter(Boolean) : [];
    if (!listed.length) {
      who.appendChild(el('p', MUTED + ' mt-1', 'No one has started it yet.'));
    } else {
      const list = el('ul', 'mt-2 divide-y divide-frosted-blue/10');
      listed.forEach(function (p) {
        const li = el('li', 'min-w-0 py-2');
        li.appendChild(el('p', 'break-words text-[15px] font-semibold text-frosted-blue', text(p.name)));
        li.appendChild(el('p', 'break-words ' + SMALL, bookLine(p, now)));
        list.appendChild(li);
      });
      who.appendChild(list);
    }
    box.appendChild(who);
    const asked = Array.isArray(data.requested_by) ? data.requested_by.filter(Boolean) : [];
    if (asked.length) {
      const req = el('section', 'mt-8');
      req.appendChild(el('h3', H3, 'Requested by'));
      const list = el('ul', 'mt-2 space-y-1');
      asked.forEach(function (r) {
        list.appendChild(el('li', SMALL, text(r.name) + ' · asked ' + dayLabel(r.requested_at) + ' (matched by title)'));
      });
      req.appendChild(list);
      box.appendChild(req);
    }
    return box;
  }

  function openBook(bookId, title, opener) {
    openDetail(title, API + 'book/' + encodeURIComponent(String(bookId)), drawBook, opener);
  }

  // ---- The period ----

  function showPeriod() {
    root.querySelectorAll('[data-period]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-period') === state.period));
    });
  }

  function loadPeriodSections() {
    const p = encodeURIComponent(state.period);
    return Promise.all([
      load('insTrends', 'ins-trends', withZone(API + 'trends?period=' + p), drawTrends),
      load('insBooks', 'ins-books', API + 'books?period=' + p, drawBooks),
      load('insHabits', 'ins-habits', withZone(API + 'habits?period=' + p), drawHabits)
    ]);
  }

  root.querySelectorAll('[data-period]').forEach(function (b) {
    b.addEventListener('click', function () {
      const p = b.getAttribute('data-period');
      if (PERIODS.indexOf(p) === -1 || p === state.period) return;
      state.period = p;
      storePeriod(p);
      showPeriod();
      ['insTrends', 'insBooks', 'insHabits'].forEach(function (id) { $(id).setAttribute('aria-busy', 'true'); });
      loadPeriodSections();
    }, { signal: signal });
  });
  showPeriod();

  // ---- Boot ----

  const first = Promise.all([
    load('insNow', 'ins-now', API + 'now', drawNow),
    load('insPeople', 'ins-people', API + 'people', drawPeople),
    loadPeriodSections()
  ]);
  ctx.poll(function () {
    if (document.visibilityState !== 'hidden') refreshNow();
  }, NOW_EVERY_MS);
  // The page is on screen (or its skeletons, which have its shape) before
  // mount resolves, so Back and Forward restore the scroll onto it.
  await Promise.race([
    first,
    new Promise(function (resolve) { ctx.setTimeout(resolve, MOUNT_WAIT_MS); })
  ]);
}
