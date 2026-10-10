/**
 * WebServarr, Insights (page module)
 *
 * /insights, for admins only: the server sends anyone else away, and every
 * /api/admin/insights route answers 401 or 403 to them
 * (docs/superpowers/specs/2026-10-10-insights-design.md, section 7). Reading
 * and listening across everyone, in sections that each load on their own, so
 * one that fails, or whose source is down, never takes the others with it.
 * Right now is read again every 30 s while the page is visible. Top users,
 * the listening and reading history and Top played follow Plex's own
 * dashboard (in this site's theme): each has its own quiet filters (period,
 * whose, what), and a person's card opens them in the detail dialog. Trends,
 * Books and Habits share one period picker; the choice is remembered in this
 * browser (localStorage, a convenience: the page works without it). A book
 * opens in the same dialog, from Top played, Books or a person's books.
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
// Focus drawn inside the box, for rows in a column that clips what overflows it.
const FOCUS_IN = 'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';
const MUTED = 'text-[15px] leading-6 text-frosted-blue/70';
// Every section's body sits on the site's frosted surface (theme.css .ws-frost).
const PANEL = 'ws-frost mt-4 rounded-card border p-4 sm:p-6';
const SMALL = 'text-[13px] leading-5 text-frosted-blue/70';
const H3 = 'text-[17px] font-semibold text-frosted-blue';
const ROW = 'flex w-full min-w-0 items-start gap-3 rounded-xl px-3 py-2 -mx-3 text-left transition-colors hover:bg-frosted-blue/[0.07] ' + FOCUS;
// Plex app time, drawn as a mark: hatched, never a plain lighter fill alone.
const EST = 'ins-est';
// One bar's parts, top to bottom: the Plex estimate over the web player.
const LISTEN_PARTS = [['plex_ms', EST], ['web_ms', 'bg-frosted-blue']];
// A person's weeks: Kavita's measure of their reading on top of their listening.
const WEEK_PARTS = [['kavita_ms', 'bg-media-book']].concat(LISTEN_PARTS);
const WHAT = {
  listening: 'listening', plex: 'listening in a Plex app', reading: 'reading',
  visit: 'opening Books', request: 'asking for a book'
};
const PERIODS = ['30d', '90d', '1y', 'all'];
// Top users, history and Top played: Plex's periods, the last 7 days included.
const SPANS = ['7d', '30d', '90d', '1y', 'all'];
const SPAN_WORDS = { '7d': 'in the last 7 days', '30d': 'in the last 30 days', '90d': 'in the last 90 days',
  '1y': 'in the last year', all: 'yet' };
const MEDIA = ['all', 'web', 'plex', 'ebook'];
// The three kinds of time, bottom to top in a history bar: how each is drawn
// as a mark (.ins-site, the hatched estimate, the book colour) and as a top
// user's tinted row (insights.html), and how each is said.
const KINDS = [
  { field: 'web_ms', media: 'web', mark: 'ins-site', tint: 'ins-tint-site', label: 'Audiobooks (site)', short: 'Site', said: 'on the site' },
  { field: 'plex_ms', media: 'plex', mark: EST, tint: 'ins-tint-plex', label: 'Audiobooks (Plex app)', short: 'Plex apps',
    said: 'in Plex apps (an estimate)', estimate: true },
  // Kavita's own measure of reading (its kavita_ms keys), never the site's.
  { field: 'kavita_ms', media: 'ebook', mark: 'bg-media-book', tint: 'ins-tint-ebook', label: 'Ebooks (Kavita’s count)', short: 'Ebooks',
    said: 'reading ebooks, by Kavita’s count' }
];
// The history's y axis steps up in the first of these (in minutes) that needs
// four lines or fewer.
const STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080, 20160, 43200];
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

/** A count of something in words: "1 play", "12 plays". */
function count(n, word) { return num(n).toLocaleString() + ' ' + word + (num(n) === 1 ? '' : 's'); }

/** A long time as Plex's cards say it: "1 day, 15 hr"; under a day, as duration says it. */
function total(ms) {
  const minutes = Math.round(num(ms) / 60000);
  if (minutes < 24 * 60) return duration(ms);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days.toLocaleString() + (days === 1 ? ' day' : ' days') + (hours ? ', ' + hours + ' hr' : '');
}

/** An axis label: "45 min", "6 hr", "1.5 hr", "2 days". */
function tick(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return minutes + ' min';
  if (minutes < 48 * 60) return Math.round(minutes / 6) / 10 + ' hr';
  return Math.round(minutes / 144) / 10 + ' days';
}

/** The history's scale for its tallest bar: [the top of the axis, its step]. */
function scale(most) {
  const minutes = STEPS.find(function (m) { return most / (m * 60000) <= 4; });
  const step = minutes ? minutes * 60000 : Math.ceil(most / 4 / 86400000) * 86400000;
  return [Math.max(step, Math.ceil(most / step) * step), step];
}

/** A bar's name under the history: "Sat 10" for a day, "5 Oct" for the week
    that starts then, "Oct" for a month (with its year on the first and on January). */
function axisLabel(start, unit, first) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(start));
  if (!m) return '';
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  try {
    if (unit === 'day') return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
    if (unit === 'week') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return d.toLocaleDateString('en-GB', first || d.getMonth() === 0 ? { month: 'short', year: 'numeric' } : { month: 'short' });
  } catch (e) {
    return m[0];
  }
}

/** One of five palette hues for a person's letter circle, the same one each visit. */
function hue(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 9973;
  return 'ins-hue-' + (h % 5);
}

/** A cover address this page may load: only the Books pages' own, on this origin. */
function coverOf(url) {
  return /^\/api\/books\/\d+\/cover(\?v=\d+)?$/.test(text(url)) ? url : '';
}

function hourLabel(h) { return (h < 10 ? '0' : '') + h + ':00'; }

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;
  const $ = function (id) { return root.querySelector('#' + id); };
  const tz = timeZone();
  const state = {
    gen: {}, nowJSON: '', opener: null, detailGen: 0, period: storedPeriod(),
    topUsers: '7d', history: { period: '30d', media: 'all', person: '', data: null }, played: { period: '30d', person: '' }
  };

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
    const box = el('div', 'mt-3 first:mt-0');
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
    const li = el('li', 'flex min-w-0 items-start gap-3 rounded-inner bg-frosted-blue/[0.05] px-3 py-3');
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
    const box = el('div', PANEL);
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

  /** Everyone, by name, in the whose filters of the history and Top played. */
  function fillPeople(list) {
    const sorted = list.slice().sort(function (a, b) { return text(a.name).localeCompare(text(b.name)); });
    root.querySelectorAll('[data-ins-people]').forEach(function (select) {
      const keep = select.value;
      while (select.options.length > 1) select.remove(1);
      sorted.forEach(function (p) {
        const option = el('option', '', text(p.name));
        option.value = p.key;
        select.appendChild(option);
      });
      select.value = sorted.some(function (p) { return p.key === keep; }) ? keep : '';
    });
  }

  function drawPeople(data) {
    const box = el('div', PANEL);
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const people = (Array.isArray(data.people) ? data.people : []).filter(function (p) {
      return p && typeof p.key === 'string';
    });
    fillPeople(people);
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
      const kavita = num(p.kavita_ms_30d);
      const spent = [listened ? duration(listened) + ' listened in 30 days' +
        (plex ? ' (' + duration(plex) + ' in Plex apps, an estimate)' : '') : '',
      kavita ? duration(kavita) + ' reading in 30 days, by Kavita’s count' : ''].filter(Boolean);
      main.appendChild(el('span', 'block min-w-0 ' + SMALL, spent.join('. ')));
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

  // ---- Top users ----

  function swatch(mark) {
    const s = el('span', 'inline-block size-2.5 shrink-0 rounded-sm ' + mark);
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  /** Their plex.tv picture (served from this origin by the avatar route), over
      a letter circle that stays when there is none or it does not load. */
  function avatar(p) {
    const box = el('span', 'relative inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full text-[24px] font-semibold text-frosted-blue ' + hue(p.key));
    box.setAttribute('aria-hidden', 'true');
    box.appendChild(el('span', '', (Array.from(text(p.name).trim())[0] || '?').toUpperCase()));
    if (p.avatar === true) {
      const img = el('img', 'absolute inset-0 size-full object-cover');
      img.alt = '';
      img.width = 56;
      img.height = 56;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () { img.remove(); }, { signal: signal });
      img.src = API + 'avatar?key=' + encodeURIComponent(p.key);
      box.appendChild(img);
    }
    return box;
  }

  /** One person's card: picture, sessions and time, the name band, then a row
      a kind of time, each tinted more strongly the more of their time it holds. */
  function userCard(p) {
    // Four to a row from lg, as Plex shows them, never narrower than its rows need (288px):
    // where four do not fit, the next one peeks in and the row scrolls.
    const li = el('li', 'w-[min(82vw,288px)] shrink-0 snap-start lg:w-[max(288px,calc((100%-48px)/4))]');
    const card = el('button', 'ws-frost flex h-full w-full flex-col overflow-hidden rounded-card border text-left ' + FOCUS);
    card.type = 'button';
    card.setAttribute('data-ins-user', p.key);
    const head = el('span', 'flex items-center gap-4 px-4 pb-4 pt-5');
    head.appendChild(avatar(p));
    const figures = el('span', 'block min-w-0');
    figures.appendChild(el('span', 'block text-[15px] tabular-nums text-frosted-blue/70', count(p.sessions, 'session')));
    figures.appendChild(el('span', 'block text-[17px] font-semibold tabular-nums text-frosted-blue', total(p.total_ms)));
    head.appendChild(figures);
    card.appendChild(head);
    card.appendChild(el('span', 'block truncate bg-background-dark/30 px-4 py-3 text-[15px] font-semibold text-frosted-blue', text(p.name)));
    const most = KINDS.reduce(function (m, k) { return Math.max(m, num(p[k.field])); }, 0);
    KINDS.forEach(function (k) {
      const ms = num(p[k.field]);
      const row = el('span', 'flex items-center justify-between gap-2 px-4 py-3 text-[14px] ' + k.tint);
      row.setAttribute('data-ins-kind', k.media);
      row.style.setProperty('--ins-a', most ? (ms / most).toFixed(2) : '0');
      const name = el('span', 'inline-flex min-w-0 items-center gap-2 text-frosted-blue');
      name.appendChild(swatch(k.mark));
      name.appendChild(el('span', 'truncate', k.label));
      if (k.estimate) name.appendChild(el('span', 'sr-only', ', an estimate'));
      row.appendChild(name);
      row.appendChild(el('span', 'shrink-0 tabular-nums text-frosted-blue/80', duration(ms)));
      card.appendChild(row);
    });
    card.addEventListener('click', function () { openPerson(p.key, text(p.name), card); }, { signal: signal });
    li.appendChild(card);
    return li;
  }

  const pagers = Array.from(root.querySelectorAll('[data-ins-page]'));

  /** The arrows page the cards; each says it has nowhere to go at an end
      (aria-disabled, so a focused arrow keeps its focus). */
  function showPagers() {
    const row = $('insTopUsers').querySelector('[data-ins-scroller]');
    pagers.forEach(function (b) {
      const back = b.getAttribute('data-ins-page') === '-1';
      const stuck = !row || (back ? row.scrollLeft <= 1 : row.scrollLeft + row.clientWidth >= row.scrollWidth - 1);
      b.setAttribute('aria-disabled', String(stuck));
    });
  }

  pagers.forEach(function (b) {
    b.addEventListener('click', function () {
      const row = $('insTopUsers').querySelector('[data-ins-scroller]');
      if (!row || b.getAttribute('aria-disabled') === 'true' || typeof row.scrollBy !== 'function') return;
      // scroll-behavior on the row (motion-safe) decides whether this glides.
      row.scrollBy({ left: parseInt(b.getAttribute('data-ins-page'), 10) * Math.max(200, row.clientWidth - 48) });
    }, { signal: signal });
  });
  window.addEventListener('resize', showPagers, { signal: signal });

  function drawTopUsers(data) {
    const box = el('div', 'mt-4');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const list = (Array.isArray(data.people) ? data.people : []).filter(function (p) { return p && typeof p.key === 'string'; });
    if (!list.length) {
      const empty = el('div', PANEL.replace('mt-4 ', ''));
      empty.appendChild(emptyLine('No one listened or read ' + (SPAN_WORDS[state.topUsers] || 'in this period') + '.'));
      box.appendChild(empty);
      ctx.setTimeout(showPagers, 0);
      return box;
    }
    const row = el('ul', '-mx-1 flex snap-x snap-mandatory scroll-px-1 gap-4 overflow-x-auto px-1 pb-3 pt-1 custom-scrollbar motion-safe:scroll-smooth');
    row.setAttribute('data-ins-scroller', '');
    row.setAttribute('aria-label', 'Top users, most time first');
    list.forEach(function (p) { row.appendChild(userCard(p)); });
    row.addEventListener('scroll', showPagers, { signal: signal, passive: true });
    // A card reached by Tab comes fully into the row: the browser leaves one
    // that peeks in half hidden, so a clipped card is brought to the row's
    // start, which is where the row snaps.
    row.addEventListener('focusin', function (e) {
      const card = e.target && e.target.closest ? e.target.closest('li') : null;
      if (!card || typeof card.scrollIntoView !== 'function') return;
      const a = card.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (a.left < r.left || a.right > r.right) card.scrollIntoView({ block: 'nearest', inline: 'start' });
    }, { signal: signal });
    box.appendChild(row);
    box.appendChild(el('p', 'mt-2 ' + SMALL, 'Plex app time is an estimate: each track counts at its length, or until the person’s next track when that came sooner. Ebook time is the reading Kavita measured. A session is a book on a day, or a day of reading.'));
    ctx.setTimeout(showPagers, 0);
    return box;
  }

  // ---- Listening and reading history ----

  /** The history in Plex's shape: a stacked bar a day, week or month on an
      axis of time, the legend and the period's totals under it. The media
      filter only redraws what was read (state.history.data). */
  function historyBody(data) {
    const box = el('div', PANEL);
    box.setAttribute('data-ins-history', '');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const unit = text(data.bucket);
    const buckets = Array.isArray(data.buckets) ? data.buckets.filter(Boolean) : [];
    const kinds = KINDS.filter(function (k) { return state.history.media === 'all' || k.media === state.history.media; });
    const sum = function (b) { return kinds.reduce(function (t, k) { return t + num(b[k.field]); }, 0); };
    const most = buckets.reduce(function (m, b) { return Math.max(m, sum(b)); }, 0);
    const ebookShown = kinds.some(function (k) { return k.media === 'ebook'; });
    if (!most) {
      box.appendChild(el('p', MUTED, 'Nothing ' + (SPAN_WORDS[state.history.period] || 'in this period') + '.'));
      if (ebookShown && data.reading === false) box.appendChild(el('p', SMALL + ' mt-1', 'Ebook time shows here once reading in Kavita is recorded.'));
      return box;
    }
    const s = scale(most);
    const top = s[0];
    const plot = el('div', 'relative h-56 sm:h-64');
    for (let v = 0; v <= top; v += s[1]) {
      const line = el('div', 'absolute inset-x-0 h-0');
      line.setAttribute('aria-hidden', 'true');
      line.style.bottom = (v / top * 100) + '%';
      line.appendChild(el('span', 'absolute left-0 w-12 -translate-y-1/2 text-right text-[12px] tabular-nums text-frosted-blue/60', v ? tick(v) : '0'));
      line.appendChild(el('span', 'absolute left-14 right-0 border-t ' + (v ? 'border-frosted-blue/10' : 'border-frosted-blue/25')));
      plot.appendChild(line);
    }
    const ROWCLS = 'flex justify-around gap-1 px-1 sm:gap-4 sm:px-2 lg:gap-6';
    const COL = 'min-w-0 max-w-[160px] flex-1';
    const bars = el('ol', 'absolute inset-y-0 left-14 right-0 items-end ' + ROWCLS);
    bars.setAttribute('data-ins-bars', '');
    bars.setAttribute('aria-label', unit === 'day' ? 'Each day' : unit === 'week' ? 'Each week' : 'Each month');
    const parts = kinds.slice().reverse().map(function (k) { return [k.field, k.mark]; });
    const wide = Math.ceil(buckets.length / 12);
    const narrow = Math.ceil(buckets.length / 6);
    const names = el('div', 'ml-14 mt-2 ' + ROWCLS);
    names.setAttribute('aria-hidden', 'true');
    buckets.forEach(function (b, i) {
      const said = bucketLabel(b.start, unit) + ': ' + kinds.map(function (k) { return duration(b[k.field]) + ' ' + k.said; }).join(', ');
      const li = el('li', 'flex h-full flex-col justify-end ' + COL);
      li.title = said;
      li.appendChild(el('span', 'sr-only', said));
      stack(li, parts, b, top);
      bars.appendChild(li);
      const shown = i % wide === 0 ? (i % narrow === 0 ? '' : ' max-sm:invisible') : ' invisible';
      names.appendChild(el('span', 'truncate text-center text-[12px] text-frosted-blue/70 ' + COL + shown, axisLabel(b.start, unit, i === 0)));
    });
    plot.appendChild(bars);
    box.appendChild(plot);
    box.appendChild(names);

    const foot = el('div', 'mt-5 flex flex-wrap items-start justify-between gap-x-8 gap-y-2 ' + SMALL);
    const key = el('ul', 'flex flex-wrap gap-x-5 gap-y-1');
    key.setAttribute('data-ins-legend', '');
    kinds.forEach(function (k) {
      const item = el('li', 'inline-flex items-center gap-1.5');
      item.appendChild(swatch(k.mark));
      item.appendChild(el('span', '', k.label + (k.estimate ? ', an estimate' : '')));
      key.appendChild(item);
    });
    foot.appendChild(key);
    const totals = data.totals && typeof data.totals === 'object' ? data.totals : {};
    const sums = el('p', 'flex flex-wrap gap-x-4 gap-y-1 tabular-nums');
    sums.setAttribute('data-ins-totals-line', '');
    sums.appendChild(el('span', 'font-semibold text-frosted-blue/85', 'Totals'));
    kinds.forEach(function (k) { sums.appendChild(el('span', '', k.short + ' ' + duration(totals[k.field]))); });
    foot.appendChild(sums);
    box.appendChild(foot);
    const notes = [unit === 'week' ? 'Each bar is a week, Monday first, in your time zone.'
      : unit === 'day' ? 'Each bar is a day, in your time zone.' : 'Each bar is a month, in your time zone.'];
    if (ebookShown) notes.push(data.reading === false ? 'Ebook time shows here once reading in Kavita is recorded.' : 'Ebook time is the reading Kavita measured, by its day.');
    box.appendChild(el('p', 'mt-2 ' + SMALL, notes.join(' ')));
    return box;
  }

  function drawHistory(data) {
    state.history.data = data;
    return historyBody(data);
  }

  // ---- Top played ----

  /** A cover (or, for an author, a round stand-in) beside a row; the book icon
      stays when there is no cover or it does not load. */
  function thumb(url, round) {
    const box = el('span', 'relative flex shrink-0 items-center justify-center overflow-hidden bg-frosted-blue/10 ' +
      (round ? 'size-12 rounded-full' : 'h-[60px] w-10 rounded-[4px]'));
    box.setAttribute('aria-hidden', 'true');
    box.appendChild(icon(round ? 'person' : 'menu_book', 'text-[20px] text-frosted-blue/45'));
    const src = coverOf(url);
    if (src && !round) {
      const img = el('img', 'absolute inset-0 size-full object-cover');
      img.alt = '';
      img.width = 40;
      img.height = 60;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () { img.remove(); }, { signal: signal });
      img.src = src;
      box.appendChild(img);
    }
    return box;
  }

  /** One ranked row: a button that opens the book when it is a library book, else plain. */
  function playedRow(title, lines, art, bookId) {
    const li = el('li', 'min-w-0');
    const isBook = typeof bookId === 'number';
    const holder = el(isBook ? 'button' : 'div', 'flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left' +
      (isBook ? ' transition-colors hover:bg-frosted-blue/[0.07] ' + FOCUS_IN : ''));
    holder.appendChild(art);
    const words = el('span', 'block min-w-0 flex-1');
    words.appendChild(el('span', 'line-clamp-2 break-words text-[15px] font-semibold leading-5 text-frosted-blue', title));
    lines.filter(Boolean).forEach(function (line) {
      words.appendChild(el('span', 'block truncate text-[13px] leading-5 text-frosted-blue/70', line));
    });
    holder.appendChild(words);
    if (isBook) {
      holder.type = 'button';
      holder.setAttribute('data-ins-book', String(bookId));
      holder.addEventListener('click', function () { openBook(bookId, title, holder); }, { signal: signal });
    }
    li.appendChild(holder);
    return li;
  }

  /** A column: its top item's cover blurred behind its name, then its rows. */
  function playedColumn(title, kind, items, row) {
    const col = el('section', 'ws-frost min-w-0 overflow-hidden rounded-card border');
    col.setAttribute('data-ins-played', kind);
    const banner = el('div', 'relative flex h-24 items-center justify-center overflow-hidden');
    const art = items.length ? coverOf(items[0].cover_url) : '';
    if (art) {
      const img = el('img', 'ins-banner-art absolute inset-0 size-full object-cover');
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.width = 300;
      img.height = 96;
      img.decoding = 'async';
      img.addEventListener('error', function () { img.remove(); }, { signal: signal });
      img.src = art;
      banner.appendChild(img);
      banner.appendChild(el('span', 'ins-banner-dim absolute inset-0'));
    } else {
      banner.classList.add('bg-frosted-blue/[0.06]');
    }
    banner.appendChild(el('h3', 'relative text-xl font-bold text-frosted-blue', title));
    col.appendChild(banner);
    if (!items.length) {
      col.appendChild(el('p', MUTED + ' px-4 py-4', 'Nothing in this period.'));
      return col;
    }
    const list = el('ol', 'divide-y divide-frosted-blue/10');
    items.forEach(function (item) { list.appendChild(row(item)); });
    col.appendChild(list);
    return col;
  }

  function playsAndReads(item) {
    return [num(item.plays) ? count(item.plays, 'play') : '', num(item.reads) ? count(item.reads, 'read') : '']
      .filter(Boolean).join(', ');
  }

  function drawTopPlayed(data) {
    const box = el('div', 'mt-4');
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const list = function (rows, field) {
      return (Array.isArray(rows) ? rows : []).filter(function (r) { return r && text(r[field]); });
    };
    const audio = list(data.audiobooks, 'title');
    const grid = el('div', 'grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-4');
    grid.appendChild(playedColumn('Audiobooks', 'audiobooks', audio, function (b) {
      return playedRow(text(b.title), [count(b.plays, 'play') + (num(b.listened_ms) ? ', ' + duration(b.listened_ms) : ''),
        count(b.people, 'user')], thumb(b.cover_url), b.book_id);
    }));
    grid.appendChild(playedColumn('Ebooks', 'ebooks', list(data.ebooks, 'title'), function (b) {
      return playedRow(text(b.title), [count(b.reads, 'read'), num(b.finished).toLocaleString() + ' finished'],
        thumb(b.cover_url), b.book_id);
    }));
    grid.appendChild(playedColumn('Authors', 'authors', list(data.authors, 'name'), function (a) {
      return playedRow(text(a.name), [playsAndReads(a), count(a.people, 'user')], thumb('', true), null);
    }));
    grid.appendChild(playedColumn('Series', 'series', list(data.series, 'name'), function (a) {
      return playedRow(text(a.name), [playsAndReads(a), count(a.people, 'user')], thumb(a.cover_url), null);
    }));
    box.appendChild(grid);
    const words = ['A play is one person listening to a book on a day; a read is one person reading an ebook in the period.'];
    if (audio.some(function (b) { return num(b.plex_ms); })) words.push('Times include listening in Plex apps, which is an estimate.');
    box.appendChild(el('p', 'mt-3 ' + SMALL, words.join(' ')));
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

  // Plex's history has no place in a book: a start from Plex app time alone is an estimate.
  function fromPlex(count) {
    return num(count) ? ' (' + num(count) + ' from Plex app time, an estimate)' : '';
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

  function legend(reading) {
    const p = el('p', 'mt-2 flex flex-wrap gap-x-4 gap-y-1 ' + SMALL);
    p.setAttribute('aria-hidden', 'true');
    const keys = [['bg-frosted-blue', 'Web player'], [EST, 'Plex apps (an estimate)']];
    if (reading) keys.push(['bg-media-book', 'Ebooks (Kavita’s count)']);
    keys.forEach(function (k) {
      const item = el('span', 'inline-flex items-center gap-1.5');
      item.appendChild(el('span', 'inline-block size-2.5 rounded-sm ' + k[0]));
      item.appendChild(el('span', '', k[1]));
      p.appendChild(item);
    });
    return p;
  }

  /** 12 weeks of bars, web, Plex apps and Kavita's reading stacked; each week said in words. */
  function weeklyBars(weeks) {
    const section = el('section', 'mt-8');
    section.setAttribute('data-ins-weekly', '');
    section.appendChild(el('h3', H3, 'Each week'));
    const most = weeks.reduce(function (m, w) { return Math.max(m, num(w.web_ms) + num(w.plex_ms) + num(w.kavita_ms)); }, 0);
    const reading = weeks.some(function (w) { return num(w.kavita_ms); });
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
        (plex ? ', and ' + duration(plex) + ' in Plex apps (an estimate)' : '') +
        (num(w.kavita_ms) ? ', and ' + duration(w.kavita_ms) + ' reading ebooks (Kavita’s count)' : '');
      const li = el('li', 'flex h-full min-w-0 flex-col justify-end');
      li.title = words;
      li.appendChild(el('span', 'sr-only', words));
      stack(li, WEEK_PARTS, w, most);
      list.appendChild(li);
    });
    section.appendChild(list);
    section.appendChild(ends('Week of ' + dayLabel(weeks[0].week), 'Week of ' + dayLabel(weeks[weeks.length - 1].week)));
    section.appendChild(legend(reading));
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
    if (num(t.kavita_ms)) row.appendChild(figure(duration(t.kavita_ms), 'Reading ebooks, Kavita’s count'));
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

  // ---- Trends ----

  /** Pages read and active people a week. Hours listened is the history
      above (its own period), and the top books, authors and series are Top played. */
  function drawTrends(data) {
    const box = el('div', PANEL);
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const unit = text(data.bucket);
    const buckets = Array.isArray(data.buckets) ? data.buckets.filter(Boolean) : [];
    const tracking = data.tracking || {};
    const grid = el('div', 'grid gap-8 lg:grid-cols-2 lg:gap-10');
    if (!buckets.length || buckets.every(function (b) { return b.pages === null || b.pages === undefined; })) {
      const pages = el('section', 'min-w-0');
      pages.setAttribute('data-ins-pages', '');
      pages.appendChild(el('h3', H3, 'Pages read'));
      pages.appendChild(emptyLine('Pages read show here once reading in Kavita is recorded.', tracking.reading));
      grid.appendChild(pages);
    } else {
      const pages = barChart('data-ins-pages', 'Pages read', buckets, unit, [['pages', 'bg-media-book']], function (b) {
        return bucketLabel(b.start, unit) + ': ' + num(b.pages).toLocaleString() + ' pages';
      }, function (most) { return most.toLocaleString() + ' pages'; }, 'h-32');
      pages.appendChild(el('p', 'mt-1 ' + SMALL, 'By Kavita’s count; across days without a read, an estimate.'));
      grid.appendChild(pages);
    }
    const active = Array.isArray(data.active) ? data.active.filter(Boolean) : [];
    grid.appendChild(barChart('data-ins-active', 'Active people each week', active, 'week', [['people', 'bg-frosted-blue/70']], function (w) {
      return 'Week of ' + dayLabel(w.week) + ': ' + people(w.people);
    }, people, 'h-32'));
    box.appendChild(grid);
    return box;
  }

  // ---- Books ----

  function drawBooks(data) {
    const box = el('div', PANEL);
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const now = Date.now();
    const cols = el('div', 'grid gap-8 lg:grid-cols-2 lg:gap-x-10');

    const gone = el('section', 'min-w-0');
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

    const fin = el('section', 'min-w-0');
    fin.setAttribute('data-ins-finish', '');
    fin.appendChild(el('h3', H3, 'Finish rate'));
    fin.appendChild(el('p', SMALL, 'Books two or more people started in this period.'));
    const finish = Array.isArray(data.finish) ? data.finish.filter(Boolean) : [];
    if (!finish.length) {
      fin.appendChild(el('p', MUTED + ' mt-2', 'No book has two starters in this period.'));
    } else {
      const list = el('ul', 'mt-2 divide-y divide-frosted-blue/10');
      finish.forEach(function (f) {
        let words = num(f.started) + ' started' + fromPlex(f.started_plex) + ' · ' + num(f.finished) + ' finished · ' + num(f.rate) + '%';
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
    const box = el('div', PANEL);
    const lines = unavailableLines(data.unavailable);
    if (lines) box.appendChild(lines);
    const split = data.split && typeof data.split === 'object' ? data.split : {};
    const web = num(split.web_ms);
    const plex = num(split.plex_ms);
    const both = el('section', 'lg:max-w-[880px]');
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
    if (num(split.kavita_ms)) {
      const read = el('p', 'mt-1 ' + SMALL, 'Reading ebooks in the same period: ' + duration(split.kavita_ms) + ', by Kavita’s count.');
      read.setAttribute('data-ins-kavita', '');
      both.appendChild(read);
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
    row.appendChild(figure(num(t.started).toLocaleString(), 'Started' + fromPlex(t.started_plex)));
    row.appendChild(figure(num(t.finished).toLocaleString(), 'Finished'));
    row.appendChild(figure(num(t.rate) + '%', 'Finish rate' + (num(t.started_plex) ? ' (an estimate)' : '')));
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

  // ---- Top users, history and Top played: their own filters ----

  function whose(person) { return person ? '&person=' + encodeURIComponent(person) : ''; }

  function loadTopUsers() {
    return load('insTopUsers', 'ins-top-users', withZone(API + 'top-users?period=' + encodeURIComponent(state.topUsers)), drawTopUsers);
  }

  function loadHistory() {
    state.history.data = null;
    return load('insHistory', 'ins-history', withZone(API + 'history?period=' + encodeURIComponent(state.history.period) +
      whose(state.history.person)), drawHistory);
  }

  function loadPlayed() {
    return load('insTopPlayed', 'ins-top-played', withZone(API + 'top-played?period=' + encodeURIComponent(state.played.period) +
      whose(state.played.person)), drawTopPlayed);
  }

  /** A filter: its choice, kept when it is one of `allowed`, then `then`. */
  function filter(id, allowed, choose, then) {
    const select = $(id);
    select.addEventListener('change', function () {
      if (allowed && allowed.indexOf(select.value) === -1) return;
      choose(select.value);
      then();
    }, { signal: signal });
  }

  function busy(id) { $(id).setAttribute('aria-busy', 'true'); }

  filter('insTopUsersPeriod', SPANS, function (v) { state.topUsers = v; }, function () { busy('insTopUsers'); loadTopUsers(); });
  filter('insHistoryPeriod', SPANS, function (v) { state.history.period = v; }, function () { busy('insHistory'); loadHistory(); });
  filter('insHistoryPerson', null, function (v) { state.history.person = /^[0-9a-f]{24}$/.test(v) ? v : ''; },
    function () { busy('insHistory'); loadHistory(); });
  // What the history shows is drawn again from what was read; nothing is asked for.
  filter('insHistoryMedia', MEDIA, function (v) { state.history.media = v; }, function () {
    if (state.history.data) setBody('insHistory', historyBody(state.history.data));
  });
  filter('insTopPlayedPeriod', SPANS, function (v) { state.played.period = v; }, function () { busy('insTopPlayed'); loadPlayed(); });
  filter('insTopPlayedPerson', null, function (v) { state.played.person = /^[0-9a-f]{24}$/.test(v) ? v : ''; },
    function () { busy('insTopPlayed'); loadPlayed(); });

  // ---- Boot ----

  const first = Promise.all([
    load('insNow', 'ins-now', API + 'now', drawNow),
    loadTopUsers(),
    loadHistory(),
    loadPlayed(),
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
