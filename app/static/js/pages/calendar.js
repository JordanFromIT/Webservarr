/**
 * WebServarr — Calendar (page module)
 *
 * Upcoming Radarr and Sonarr releases for one month: a month grid on desktop,
 * an agenda list on a phone. A day opens the detail panel under the grid.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit starts on this month with its own state, and every listener,
 * fetch and timer ends with ctx.signal. One delegated click listener on
 * ctx.root serves the buttons and the day cells (data-action), however often
 * the grid is rebuilt. Every day is a button named for its date and what is
 * on it, so a day opens from the keyboard too; the panel it opens takes the
 * focus, and Escape (or its close button) hands it back to that day.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REFRESH_MS = 60000;
const MAX_IN_CELL = 3;

function isAbort(e) { return !!e && e.name === 'AbortError'; }

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function padZero(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatDateISO(date) {
  return date.getFullYear() + '-' + padZero(date.getMonth() + 1) + '-' + padZero(date.getDate());
}

// The grid runs from the Sunday on or before the 1st to the Saturday on or
// after the last day of the month.
function visibleRange(year, month) {
  const startDate = new Date(year, month, 1);
  startDate.setDate(startDate.getDate() - startDate.getDay());
  const endDate = new Date(year, month + 1, 0);
  if (endDate.getDay() < 6) endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));
  return { startDate: startDate, endDate: endDate };
}

function dayCount(startDate, endDate) {
  return Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
}

// One chip, as the Books pages draw it: sentence case, 13px, fully rounded.
const CHIP = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-label font-semibold shrink-0';

function mediaBadge(release) {
  const badge = document.createElement('span');
  const movie = release.media_type === 'movie';
  badge.className = CHIP + (movie ? ' badge-media-movie' : ' badge-media-tv');
  badge.textContent = movie ? 'Movie' : 'TV show';
  return badge;
}

// In a day cell there is no room for a word: a dot in the type's colour. The
// cell's name says the type in words, and the panel spells it out.
function mediaDot(release) {
  const dot = document.createElement('span');
  dot.className = 'size-2 rounded-full shrink-0 ' + (release.media_type === 'movie' ? 'bg-media-movie' : 'bg-media-tv');
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function checkMark(cls) {
  const check = document.createElement('span');
  check.className = 'material-symbols-outlined text-status-ok-text ' + cls;
  check.setAttribute('aria-hidden', 'true');
  check.textContent = 'check_circle';
  return check;
}

function releaseName(release) {
  let text = release.title || 'Unknown';
  if (release.media_type === 'tv' && release.episode_code) text += ' ' + release.episode_code;
  return text;
}

// What a day's button says to a screen reader: the date, then each release.
function dayLabel(date, releases) {
  const label = DAY_NAMES[date.getDay()] + ', ' + MONTH_NAMES[date.getMonth()] + ' ' + date.getDate();
  if (!releases.length) return label + ', nothing coming';
  return label + ', ' + releases.map(function (r) {
    return (r.media_type === 'movie' ? 'movie ' : 'TV show ') + releaseName(r) + (r.has_file ? ' (here)' : '');
  }).join('; ');
}

function emptyNote(padding, text) {
  const p = document.createElement('p');
  p.className = 'text-body text-frosted-blue/70 ' + padding;
  p.textContent = text;
  return p;
}

function buildReleaseEntry(release) {
  const entry = document.createElement('span');
  entry.className = 'flex items-center gap-1.5 mb-0.5 min-w-0';
  entry.appendChild(mediaDot(release));

  const titleEl = document.createElement('span');
  titleEl.className = 'text-xs text-frosted-blue/80 truncate leading-tight';
  titleEl.textContent = releaseName(release);
  entry.appendChild(titleEl);

  // The status-text shade: it reads on any background.
  if (release.has_file) entry.appendChild(checkMark('text-[13px] shrink-0 leading-none'));
  return entry;
}

function buildDayCell(date, dateStr, isCurrentMonth, isToday, isSelected, releases) {
  // A button: a day opens from the keyboard as well as the mouse.
  const cell = document.createElement('button');
  cell.type = 'button';
  let cls = 'flex flex-col justify-start w-full min-w-0 text-left p-1.5 lg:p-2 bg-frosted-blue/[0.04] hover:bg-frosted-blue/[0.08] transition-colors rounded-sm overflow-hidden';
  if (!isCurrentMonth) cls += ' opacity-40';
  if (isToday) cls += ' ring-2 ring-inset ring-primary bg-primary/10';
  if (isSelected) cls += ' bg-primary/20';
  cell.className = cls;
  cell.setAttribute('data-action', 'day');
  cell.setAttribute('data-date', dateStr);
  cell.setAttribute('aria-label', dayLabel(date, releases) + (isToday ? ' (today)' : ''));
  if (isSelected) cell.setAttribute('aria-expanded', 'true');

  const dateNumEl = document.createElement('span');
  dateNumEl.className = 'block text-label font-bold mb-1 tabular-nums ' + (isToday ? 'text-frosted-blue' : 'text-frosted-blue/70');
  dateNumEl.textContent = String(date.getDate());
  cell.appendChild(dateNumEl);

  const shown = Math.min(releases.length, MAX_IN_CELL);
  for (let i = 0; i < shown; i++) cell.appendChild(buildReleaseEntry(releases[i]));

  if (releases.length > MAX_IN_CELL) {
    const moreEl = document.createElement('span');
    moreEl.className = 'block text-xs text-frosted-blue/70 font-medium mt-0.5';
    moreEl.textContent = (releases.length - MAX_IN_CELL) + ' more';
    cell.appendChild(moreEl);
  }
  return cell;
}

function buildAgendaRow(date, dateStr, isToday, dayReleases) {
  // A button, like the grid's days: the whole row opens the day.
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'w-full text-left flex gap-4 py-3 px-2 rounded-inner hover:bg-frosted-blue/[0.04] transition-colors';
  if (isToday) row.className += ' bg-primary/10';
  row.setAttribute('data-action', 'day');
  row.setAttribute('data-date', dateStr);
  row.setAttribute('aria-label', dayLabel(date, dayReleases) + (isToday ? ' (today)' : ''));

  const dateLabel = document.createElement('span');
  dateLabel.className = 'w-14 shrink-0 text-center pt-0.5';
  const dayNameEl = document.createElement('span');
  dayNameEl.className = 'block text-label font-semibold ' + (isToday ? 'text-frosted-blue' : 'text-frosted-blue/70');
  dayNameEl.textContent = isToday ? 'Today' : DAY_SHORT[date.getDay()];
  dateLabel.appendChild(dayNameEl);
  const dayNumEl = document.createElement('span');
  dayNumEl.className = 'block text-h3 font-bold text-frosted-blue tabular-nums';
  dayNumEl.textContent = String(date.getDate());
  dateLabel.appendChild(dayNumEl);
  row.appendChild(dateLabel);

  const releasesCol = document.createElement('span');
  releasesCol.className = 'flex-1 min-w-0 flex flex-col gap-1.5';
  if (dayReleases.length === 0) {
    const none = document.createElement('span');
    none.className = 'text-body text-frosted-blue/70';
    none.textContent = 'Nothing coming today';
    releasesCol.appendChild(none);
  } else {
    dayReleases.forEach(function (release) {
      const item = document.createElement('span');
      item.className = 'flex items-center gap-2 min-w-0';
      // The word from sm up; on a phone the title needs the room, so the
      // type's dot stands in (the row's name and the day's panel say it).
      const chip = mediaBadge(release);
      chip.className += ' hidden sm:inline-flex';
      item.appendChild(chip);
      const dot = mediaDot(release);
      dot.className += ' sm:hidden';
      item.appendChild(dot);
      const titleEl = document.createElement('span');
      titleEl.className = 'text-body text-frosted-blue/80 truncate';
      titleEl.textContent = releaseName(release);
      item.appendChild(titleEl);
      if (release.has_file) item.appendChild(checkMark('text-base shrink-0'));
      releasesCol.appendChild(item);
    });
  }
  row.appendChild(releasesCol);
  return row;
}

function buildDetailCard(release) {
  const card = document.createElement('div');
  card.className = 'flex gap-3 lg:gap-4 p-3 rounded-inner bg-frosted-blue/[0.04]';

  if (release.poster_url) {
    // A poster that fails to load is hidden by the page's error listener.
    const poster = document.createElement('img');
    poster.src = release.poster_url;
    poster.alt = release.title || '';
    poster.className = 'w-14 h-[84px] lg:w-16 lg:h-24 rounded-md object-cover shrink-0';
    poster.setAttribute('data-poster', '');
    card.appendChild(poster);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'w-14 h-[84px] lg:w-16 lg:h-24 rounded-md bg-frosted-blue/5 flex items-center justify-center shrink-0';
    const phIcon = document.createElement('span');
    phIcon.className = 'material-symbols-outlined text-2xl text-steel-blue/30';
    phIcon.setAttribute('aria-hidden', 'true');
    phIcon.textContent = release.media_type === 'movie' ? 'movie' : 'tv';
    placeholder.appendChild(phIcon);
    card.appendChild(placeholder);
  }

  const info = document.createElement('div');
  info.className = 'flex-1 min-w-0';

  const titleRow = document.createElement('div');
  titleRow.className = 'flex items-start gap-2';
  const titleText = document.createElement('p');
  titleText.className = 'text-frosted-blue text-body font-semibold leading-snug';
  titleText.textContent = release.title || 'Unknown';
  titleRow.appendChild(titleText);
  if (release.has_file) {
    titleRow.appendChild(checkMark('text-base shrink-0 mt-0.5'));
    const here = document.createElement('span');
    here.className = 'sr-only';
    here.textContent = 'Already here';
    titleRow.appendChild(here);
  }
  info.appendChild(titleRow);

  const badgesRow = document.createElement('div');
  badgesRow.className = 'flex flex-wrap items-center gap-1.5 mt-1';
  badgesRow.appendChild(mediaBadge(release));
  if (release.episode_code) {
    const codeBadge = document.createElement('span');
    codeBadge.className = CHIP + ' bg-frosted-blue/10 text-frosted-blue/80 tabular-nums';
    codeBadge.textContent = release.episode_code;
    badgesRow.appendChild(codeBadge);
  }
  info.appendChild(badgesRow);

  if (release.episode_title) {
    const epTitle = document.createElement('p');
    epTitle.className = 'text-label text-frosted-blue/70 mt-1';
    epTitle.textContent = release.episode_title;
    info.appendChild(epTitle);
  }
  if (release.overview) {
    const overview = document.createElement('p');
    overview.className = 'text-label text-frosted-blue/70 mt-1.5 line-clamp-2 lg:line-clamp-3 leading-relaxed';
    overview.textContent = release.overview;
    info.appendChild(overview);
  }

  card.appendChild(info);
  return card;
}

export async function mount(ctx) {
  const root = ctx.root;
  const signal = ctx.signal;

  const grid = root.querySelector('#calendarGrid');
  const monthLabel = root.querySelector('#monthLabel');
  const panel = root.querySelector('#dayDetailPanel');
  const detailLabel = root.querySelector('#detailDateLabel');
  const detailList = root.querySelector('#detailReleasesList');

  // This visit's state: every mount starts on this month.
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();       // 0-indexed
  let selectedDate = null;          // "YYYY-MM-DD" or null
  let panelOpener = false;          // the panel was opened from a day: focus goes back to it
  const grouped = {};               // "YYYY-MM" -> { "YYYY-MM-DD": [release, ...] }

  function monthKey() {
    return year + '-' + padZero(month + 1);
  }

  function buildGrid(byDate) {
    const range = visibleRange(year, month);
    // A refresh rebuilds every day: the one holding the focus gets it back.
    const focused = document.activeElement && grid.contains(document.activeElement)
      ? document.activeElement.getAttribute('data-date') : null;
    buildDays(byDate, range);
    if (focused) {
      const again = dayButton(focused);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function buildDays(byDate, range) {
    clearChildren(grid);

    if (window.innerWidth < 1024) {
      // Agenda view on a phone.
      grid.className = 'flex flex-col flex-1 min-h-0';
      grid.style.gridTemplateRows = '';
      buildAgenda(byDate);
      return;
    }

    grid.className = 'grid grid-cols-7 gap-px flex-1 min-h-0 lg:overflow-hidden';
    const todayStr = formatDateISO(new Date());
    grid.style.gridTemplateRows = 'repeat(' + Math.ceil(dayCount(range.startDate, range.endDate) / 7) + ', 1fr)';

    const current = new Date(range.startDate);
    while (current <= range.endDate) {
      const dateStr = formatDateISO(current);
      const isCurrentMonth = current.getMonth() === month && current.getFullYear() === year;
      grid.appendChild(buildDayCell(new Date(current), dateStr, isCurrentMonth, dateStr === todayStr,
                                    selectedDate === dateStr, byDate[dateStr] || []));
      current.setDate(current.getDate() + 1);
    }
  }

  function buildAgenda(byDate) {
    const todayStr = formatDateISO(new Date());
    const last = new Date(year, month + 1, 0);
    let hasContent = false;
    const current = new Date(year, month, 1);
    while (current <= last) {
      const dateStr = formatDateISO(current);
      const isToday = dateStr === todayStr;
      const dayReleases = byDate[dateStr] || [];
      // Empty days are skipped, except today.
      if (dayReleases.length || isToday) {
        hasContent = true;
        grid.appendChild(buildAgendaRow(current, dateStr, isToday, dayReleases));
      }
      current.setDate(current.getDate() + 1);
    }
    if (!hasContent) grid.appendChild(emptyNote('py-12', 'Nothing is coming this month.'));
  }

  function showDetailPanel(dateStr, releases) {
    panel.classList.remove('hidden');
    const parts = dateStr.split('-');
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    detailLabel.textContent = DAY_NAMES[d.getDay()] + ', ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();

    clearChildren(detailList);
    if (releases.length === 0) {
      detailList.appendChild(emptyNote('py-4', 'Nothing is coming on this day.'));
      return;
    }
    releases.forEach(function (release) { detailList.appendChild(buildDetailCard(release)); });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // The day's button in the grid as rebuilt (the rebuild replaces it).
  function dayButton(dateStr) {
    return grid.querySelector('[data-action="day"][data-date="' + dateStr + '"]');
  }

  function onDayClick(dateStr) {
    selectedDate = dateStr;
    const byDate = grouped[monthKey()] || {};
    buildGrid(byDate);   // the selection highlight
    showDetailPanel(dateStr, byDate[dateStr] || []);
    // The panel's heading takes the focus, so a keyboard user lands on what
    // they opened; Escape or the close button brings them back to the day.
    panelOpener = true;
    detailLabel.focus({ preventScroll: true });
  }

  function closeDetailPanel() {
    const was = selectedDate;
    selectedDate = null;
    panel.classList.add('hidden');
    const byDate = grouped[monthKey()];
    if (byDate) buildGrid(byDate);   // clears the selection highlight
    if (panelOpener && was) {
      const back = dayButton(was);
      if (back) back.focus({ preventScroll: true });
    }
    panelOpener = false;
  }

  function showError() {
    clearChildren(grid);
    const cell = document.createElement('p');
    cell.className = 'col-span-7 text-body text-frosted-blue/70 py-12';
    cell.textContent = 'The release calendar isn\u2019t available right now. Try again in a minute.';
    grid.appendChild(cell);
  }

  function fetchAndRender() {
    if (signal.aborted) return Promise.resolve();
    const key = monthKey();
    const range = visibleRange(year, month);
    const url = '/api/integrations/upcoming-releases?start=' + formatDateISO(range.startDate) +
                '&days=' + dayCount(range.startDate, range.endDate);

    return WS.swr('calendar:' + key, function () {
      return WS.getJSON(url, { signal: signal });
    }, function (releases) {
      if (signal.aborted) return;           // left: the next page owns the arrival order now
      if (key !== monthKey()) return;       // the month changed while this was in flight
      const byDate = {};
      releases.forEach(function (release) {
        const dateKey = release.air_date ? release.air_date.substring(0, 10) : '';
        if (!dateKey) return;
        if (!byDate[dateKey]) byDate[dateKey] = [];
        byDate[dateKey].push(release);
      });
      grouped[key] = byDate;
      WS.arrive('month', function () {
        buildGrid(byDate);
        // An open detail panel follows the refresh.
        if (selectedDate) showDetailPanel(selectedDate, byDate[selectedDate] || []);
      });
    }, { onError: function (err) {
      if (signal.aborted || isAbort(err)) return;   // left the page: not an error
      console.error('Calendar fetch error:', err);
      showError();
    } });
  }

  function renderMonth() {
    monthLabel.textContent = MONTH_NAMES[month] + ' ' + year;
    // A skeleton month while the data comes in: the same grid the real month
    // uses, so nothing moves when it lands. The first paint's markup already
    // carries one; only a month change needs it rebuilt.
    if (!grid.querySelector('.skel')) {
      clearChildren(grid);
      grid.className = 'grid grid-cols-7 gap-px flex-1 min-h-0 lg:overflow-hidden';
      grid.style.gridTemplateRows = 'repeat(5, 1fr)';
      for (let i = 0; i < 35; i++) {
        const cell = document.createElement('div');
        cell.className = 'skel rounded-lg';
        cell.setAttribute('aria-hidden', 'true');
        grid.appendChild(cell);
      }
    }
    return fetchAndRender();
  }

  function moveMonth(delta) {
    month += delta;
    if (month < 0) { month = 11; year -= 1; }
    else if (month > 11) { month = 0; year += 1; }
    selectedDate = null;
    panel.classList.add('hidden');
    renderMonth();
  }

  function goToToday() {
    const today = new Date();
    year = today.getFullYear();
    month = today.getMonth();
    selectedDate = null;
    panel.classList.add('hidden');
    renderMonth();
  }

  root.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const el = t.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    switch (el.getAttribute('data-action')) {
      case 'prev-month': moveMonth(-1); break;
      case 'next-month': moveMonth(1); break;
      case 'today': goToToday(); break;
      case 'close-panel': closeDetailPanel(); break;
      case 'day': onDayClick(el.getAttribute('data-date')); break;
    }
  }, { signal: signal });

  // Escape closes an open day, unless a dialog or an input method has it.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.isComposing || panel.classList.contains('hidden')) return;
    if (window.WSUI && WSUI.isDialogOpen()) return;
    closeDetailPanel();
  }, { signal: signal });

  // error does not bubble: caught on the way down, for every poster.
  root.addEventListener('error', function (e) {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.hasAttribute('data-poster')) t.style.display = 'none';
  }, { capture: true, signal: signal });

  ctx.poll(fetchAndRender, REFRESH_MS);

  // The month is on screen (the last visit's copy, or fetched) before mount
  // resolves, so Back and Forward restore the scroll onto it.
  await renderMonth();
}
