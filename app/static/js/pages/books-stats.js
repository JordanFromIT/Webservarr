/**
 * WebServarr, Your stats (page module)
 *
 * /books/stats: the person's own listening (time, books finished, their
 * streak, each of the last 12 weeks, their top authors) and, while their
 * ebook library is linked, their reading. Everything comes from
 * GET /api/books/me/stats, which answers for the session's own account only;
 * the page sends the browser's time zone so days and weeks are the person's.
 *
 * The weekly bars are plain elements sized from CSSOM with theme colours: no
 * chart library. Every bar also says its week and time in words, for a
 * screen reader.
 *
 * Drawn in one write over a skeleton with the same shape: the heading and its
 * line stay, and everything after them is a new element, so nothing already on
 * screen moves. noteLine comes from books.js, loaded by the address the server
 * wrote (and stamped) in #wsPage's data-ws-dep. No import statement.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. Markup is built with textContent only.
 */
const KEEP_MS = 2 * 60 * 1000;      // a kept copy older than this is not painted
const MOUNT_WAIT_MS = 1500;         // the page is on screen (or its skeleton) before mount resolves

const LINK_FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frosted-blue';
const BUTTON = 'ws-lift mt-6 inline-flex h-11 items-center rounded-[10px] bg-primary px-5 text-[15px] font-semibold text-bright ' + LINK_FOCUS;
const H2 = 'text-xl font-bold leading-snug text-frosted-blue';

function isAbort(e) { return !!e && e.name === 'AbortError'; }

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function icon(name, cls) {
  const s = el('span', 'material-symbols-outlined' + (cls ? ' ' + cls : ''), name);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

/** The HTTP status of a failed WS.getJSON. */
function statusOf(err) {
  if (err && typeof err.status === 'number') return err.status;
  const m = /HTTP (\d{3})/.exec(err && err.message || '');
  return m ? parseInt(m[1], 10) : 0;
}

function num(n) {
  return typeof n === 'number' && isFinite(n) && n > 0 ? n : 0;
}

/** A time in words: "45 min", "3 hr", "12 hr 30 min". */
function duration(ms) {
  const minutes = Math.round(num(ms) / 60000);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours.toLocaleString() + ' hr' + (rest ? ' ' + rest + ' min' : '');
}

/** A Monday as the API gives it ("2026-09-28") in the person's words ("28 Sept"). */
function weekLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  try {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch (e) {
    return iso;
  }
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

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;
  const $ = function (id) { return root.querySelector('#' + id); };
  const { noteLine } = await import(root.getAttribute('data-ws-dep') || './books.js');

  const tz = timeZone();
  const url = '/api/books/me/stats' + (tz ? '?tz=' + encodeURIComponent(tz) : '');
  const state = { gen: 0 };
  const skeleton = $('statsRest').cloneNode(true);

  function quiet(err) { return signal.aborted || isAbort(err); }

  // ---- Drawing ----

  /** One figure: what it is, then the number (shown above its words). */
  function figure(value, label, big, extra) {
    const box = el('div', big ? 'col-span-2' : '');
    const dl = el('dl', 'flex flex-col-reverse');
    dl.appendChild(el('dt', 'mt-1 text-[15px] leading-6 text-frosted-blue/70', label));
    dl.appendChild(el('dd', (big ? 'text-[32px] sm:text-[44px] ' : 'text-[24px] ') +
      'font-extrabold leading-[1.1] tracking-[-0.02em] tabular-nums text-frosted-blue', value));
    box.appendChild(dl);
    if (extra) box.appendChild(el('p', 'text-[13px] leading-5 text-frosted-blue/70 tabular-nums', extra));
    return box;
  }

  function figures(data) {
    const row = el('div', 'mt-8 grid grid-cols-2 gap-x-8 gap-y-6 sm:flex sm:flex-wrap sm:items-end sm:gap-x-12');
    row.setAttribute('data-figures', '');
    const recent = num(data.listened_ms_6mo);
    const all = num(data.listened_ms_all);
    row.appendChild(figure(duration(recent), 'Listened in the last 6 months', true,
      duration(all) !== duration(recent) ? duration(all) + ' all time' : ''));
    const finished = num(data.finished);
    row.appendChild(figure(finished.toLocaleString(), finished === 1 ? 'Book finished' : 'Books finished', false));
    const streak = num(data.streak_days);
    row.appendChild(figure(streak === 1 ? '1 day' : streak.toLocaleString() + ' days', 'Listening streak', false));
    return row;
  }

  /** The last 12 weeks as bars, this week at full strength. Each bar says
      its week and time in words; the bars themselves are only a picture. */
  function weekly(weeks) {
    const section = el('section', 'mt-12 max-w-3xl');
    section.setAttribute('aria-labelledby', 'weeklyTitle');
    section.setAttribute('data-weekly', '');
    const h = el('h2', H2, 'Each week');
    h.id = 'weeklyTitle';
    section.appendChild(h);
    const most = weeks.reduce(function (m, w) { return Math.max(m, num(w.ms)); }, 0);
    section.appendChild(el('p', 'mt-1 text-[15px] leading-6 text-frosted-blue/70',
      most ? 'Your best of the last 12 weeks: ' + duration(most) + '.' : 'Nothing in the last 12 weeks yet.'));
    const list = el('ol', 'mt-4 grid h-40 grid-cols-12 items-end gap-1 border-b border-frosted-blue/10 sm:gap-2');
    weeks.forEach(function (w, i) {
      const ms = num(w.ms);
      const last = i === weeks.length - 1;
      const words = (last ? 'This week' : 'Week of ' + weekLabel(w.week)) + ': ' + duration(ms);
      const li = el('li', 'flex h-full min-w-0 flex-col justify-end');
      li.setAttribute('data-week', w.week || '');
      li.title = words;
      li.appendChild(el('span', 'sr-only', words));
      const bar = el('span', 'stats-bar block w-full rounded-t-[4px] ' + (last ? 'bg-frosted-blue' : 'bg-frosted-blue/35'));
      bar.setAttribute('aria-hidden', 'true');
      bar.setAttribute('data-bar', '');
      // A week with nothing keeps a sliver on the baseline, so the row of weeks still reads.
      bar.style.height = ms && most ? Math.max(3, Math.round(ms / most * 100)) + '%' : '2px';
      li.appendChild(bar);
      list.appendChild(li);
    });
    section.appendChild(list);
    const ends = el('div', 'mt-2 flex justify-between text-[13px] leading-5 text-frosted-blue/70');
    ends.setAttribute('aria-hidden', 'true');
    ends.appendChild(el('span', '', weeks.length ? weekLabel(weeks[0].week) : ''));
    ends.appendChild(el('span', '', 'This week'));
    section.appendChild(ends);
    return section;
  }

  /** The authors listened to most, as links to their pages, each with a bar against the first. */
  function authors(list) {
    const section = el('section', 'mt-12 max-w-xl');
    section.setAttribute('aria-labelledby', 'authorsTitle');
    section.setAttribute('data-authors', '');
    const h = el('h2', H2, 'Your top authors');
    h.id = 'authorsTitle';
    section.appendChild(h);
    const most = num(list[0].ms) || 1;
    const ol = el('ol', 'mt-4 space-y-1');
    list.forEach(function (a) {
      const li = el('li', '');
      const link = el('a', 'block rounded-xl px-3 py-2 -mx-3 transition-colors hover:bg-frosted-blue/[0.07] ' + LINK_FOCUS);
      link.href = '/books/person?role=author&name=' + encodeURIComponent(a.name);
      const line = el('span', 'flex items-baseline justify-between gap-4');
      line.appendChild(el('span', 'min-w-0 truncate text-[15px] font-semibold text-frosted-blue', a.name));
      line.appendChild(el('span', 'shrink-0 text-[13px] tabular-nums text-frosted-blue/70', duration(a.ms)));
      link.appendChild(line);
      const track = el('span', 'mt-2 block h-1.5 rounded-full bg-frosted-blue/[0.07]');
      track.setAttribute('aria-hidden', 'true');
      const fill = el('span', 'block h-full rounded-full bg-frosted-blue/60');
      fill.style.width = Math.max(2, Math.round(num(a.ms) / most * 100)) + '%';
      track.appendChild(fill);
      link.appendChild(track);
      li.appendChild(link);
      ol.appendChild(li);
    });
    section.appendChild(ol);
    return section;
  }

  /** Reading, from the person's own ebook library link; or why it is not here. */
  function reading(data) {
    const r = data.reading;
    const kavita = data.notes.filter(function (n) { return n && n.source === 'kavita' && n.text; });
    if (!r && !kavita.length) return null;      // no ebook library on this site
    const section = el('section', 'mt-12');
    section.setAttribute('aria-labelledby', 'readingTitle');
    section.setAttribute('data-reading', '');
    const h = el('h2', H2, 'Reading');
    h.id = 'readingTitle';
    section.appendChild(h);
    if (r && typeof r === 'object') {
      const pages = num(r.pages);
      // Nothing read: one line, not a row of zeros.
      if (pages <= 0 && num(r.hours) <= 0) {
        const none = el('p', 'mt-3 text-[15px] leading-6 text-frosted-blue/70', 'Nothing read yet.');
        none.setAttribute('data-reading-none', '');
        section.appendChild(none);
        return section;
      }
      const row = el('div', 'mt-4 grid grid-cols-2 gap-x-8 gap-y-6 sm:flex sm:flex-wrap sm:items-end sm:gap-x-12');
      row.appendChild(figure(pages.toLocaleString(), pages === 1 ? 'Page read' : 'Pages read', false));
      row.appendChild(figure(duration(num(r.hours) * 3600000), 'Time reading', false));
      section.appendChild(row);
      return section;
    }
    const n = kavita[0];
    // Not linked yet: Books runs the link on arrival, so the note takes them there.
    const line = noteLine(n.text, n.reason === 'not_connected' ? '/books' : '');
    line.className += ' mt-3';
    line.setAttribute('data-reading-note', '');
    section.appendChild(line);
    return section;
  }

  /** Nothing listened to yet: what this page will show, and the way to start. */
  function noListening() {
    const box = el('div', 'mt-8 max-w-xl');
    box.setAttribute('data-empty', '');
    box.appendChild(icon('headphones', 'text-4xl text-frosted-blue/70'));
    box.appendChild(el('p', 'mt-3 text-[17px] font-semibold text-frosted-blue', 'No listening yet'));
    box.appendChild(el('p', 'mt-1 text-[15px] leading-6 text-frosted-blue/70',
      'Start an audiobook and your listening time, your streak and your top authors show up here.'));
    const go = el('a', BUTTON, 'Find an audiobook');
    go.href = '/books';
    box.appendChild(go);
    return box;
  }

  function buildRest(data) {
    const rest = el('div', '');
    rest.id = 'statsRest';
    rest.setAttribute('data-ready', 'true');
    const listened = num(data.listened_ms_all) > 0 || num(data.finished) > 0;
    if (listened) {
      rest.appendChild(figures(data));
      rest.appendChild(weekly(data.weekly));
      if (data.top_authors.length) rest.appendChild(authors(data.top_authors));
    } else {
      rest.appendChild(noListening());
    }
    const r = reading(data);
    if (r) rest.appendChild(r);
    return rest;
  }

  function swapRest(node) {
    $('statsRest').replaceWith(node);
    $('statsView').setAttribute('aria-busy', 'false');
  }

  function message(kind, title, text, action) {
    const rest = el('div', 'mt-8 max-w-xl');
    rest.id = 'statsRest';
    rest.setAttribute('data-state', kind);
    rest.appendChild(el('p', 'text-[17px] font-semibold text-frosted-blue', title));
    rest.appendChild(el('p', 'mt-1 text-[15px] leading-6 text-frosted-blue/70', text));
    if (action) rest.appendChild(action);
    swapRest(rest);
  }

  function showNoAccount() {
    const back = el('a', BUTTON, 'Back to Books');
    back.href = '/books';
    message('noaccount', 'Stats aren’t kept for this account',
      'This sign-in doesn’t keep books of its own, so there’s nothing to count.', back);
  }

  function showError() {
    const retry = el('button', BUTTON, 'Try again');
    retry.id = 'retryBtn';
    retry.type = 'button';
    retry.addEventListener('click', function () {
      $('statsRest').replaceWith(skeleton.cloneNode(true));
      $('statsView').setAttribute('aria-busy', 'true');
      load(true);
    }, { signal: signal });
    message('error', 'We couldn’t load your stats',
      'Everything else on the site is unaffected. Try again in a moment.', retry);
  }

  // ---- Loading ----

  /** Only what this page draws, each part checked. */
  function tidy(data) {
    const d = data && typeof data === 'object' ? data : {};
    return {
      listened_ms_6mo: d.listened_ms_6mo,
      listened_ms_all: d.listened_ms_all,
      finished: d.finished,
      streak_days: d.streak_days,
      weekly: (Array.isArray(d.weekly) ? d.weekly : []).filter(function (w) { return w && typeof w.week === 'string'; }),
      top_authors: (Array.isArray(d.top_authors) ? d.top_authors : []).filter(function (a) { return a && typeof a.name === 'string' && a.name; }),
      reading: d.reading && typeof d.reading === 'object' ? d.reading : null,
      notes: Array.isArray(d.notes) ? d.notes : []
    };
  }

  function load(fresh) {
    const gen = ++state.gen;
    return WS.swr('books:stats', function () {
      return WS.getJSON(url, { signal: signal });
    }, function (data) {
      if (signal.aborted || gen !== state.gen) return;
      WS.arrive('stats', function () {
        if (signal.aborted || gen !== state.gen) return;
        swapRest(buildRest(tidy(data)));
      });
    }, {
      maxAge: fresh ? 0 : KEEP_MS,
      onError: function (err) {
        if (gen !== state.gen || quiet(err)) return;
        WS.arrive('stats', function () {
          if (signal.aborted || gen !== state.gen) return;
          if (statusOf(err) === 403) showNoAccount(); else showError();
        });
      }
    });
  }

  // ---- Boot ----

  const first = load(false);
  // The page is on screen (or its skeleton, which has its shape) before mount
  // resolves, so Back and Forward restore the scroll onto it.
  await Promise.race([
    first,
    new Promise(function (resolve) { ctx.setTimeout(resolve, MOUNT_WAIT_MS); })
  ]);
}
