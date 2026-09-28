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
 * the grid is rebuilt.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
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

function mediaBadge(release, cls, movieText, tvText) {
  const badge = document.createElement('span');
  if (release.media_type === 'movie') {
    badge.className = cls + ' badge-media-movie';
    badge.textContent = movieText;
  } else {
    badge.className = cls + ' badge-media-tv';
    badge.textContent = tvText;
  }
  return badge;
}

function checkMark(cls) {
  const check = document.createElement('span');
  check.className = 'material-symbols-outlined text-status-ok-text ' + cls;
  check.textContent = 'check_circle';
  return check;
}

function emptyNote(padding, iconSize, text) {
  const el = document.createElement('div');
  el.className = 'text-center text-steel-blue ' + padding;
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined ' + iconSize + ' mb-2 block opacity-30';
  icon.textContent = 'event_busy';
  const p = document.createElement('p');
  p.className = 'text-sm';
  p.textContent = text;
  el.appendChild(icon);
  el.appendChild(p);
  return el;
}

function buildReleaseEntry(release) {
  const entry = document.createElement('div');
  entry.className = 'flex items-center gap-1 mb-0.5 min-w-0';
  entry.appendChild(mediaBadge(release,
    'text-[8px] lg:text-[9px] font-bold px-1 py-0.5 rounded shrink-0 leading-none', 'MOV', 'TV'));

  const titleEl = document.createElement('span');
  titleEl.className = 'text-[9px] lg:text-[10px] text-frosted-blue/80 truncate leading-tight';
  if (release.media_type === 'tv' && release.episode_code) {
    titleEl.textContent = release.title + ' ' + release.episode_code;
  } else {
    titleEl.textContent = release.title;
  }
  entry.appendChild(titleEl);

  // The status-text shade: it reads on any background.
  if (release.has_file) entry.appendChild(checkMark('text-[10px] lg:text-xs shrink-0 leading-none'));
  return entry;
}

function buildDayCell(dayNum, dateStr, isCurrentMonth, isToday, isSelected, releases) {
  const cell = document.createElement('div');
  let cls = 'p-1.5 lg:p-2 bg-frosted-blue/[0.04] cursor-pointer hover:bg-frosted-blue/[0.08] transition-colors rounded-sm overflow-hidden';
  if (!isCurrentMonth) cls += ' opacity-40';
  if (isToday) cls += ' ring-2 ring-primary bg-primary/10';
  if (isSelected) cls += ' bg-primary/20 border border-primary/40';
  cell.className = cls;
  cell.setAttribute('data-action', 'day');
  cell.setAttribute('data-date', dateStr);

  const dateNumEl = document.createElement('div');
  dateNumEl.className = 'text-xs lg:text-sm font-bold mb-1 ' + (isToday ? 'text-frosted-blue' : 'text-steel-blue');
  dateNumEl.textContent = String(dayNum);
  cell.appendChild(dateNumEl);

  const shown = Math.min(releases.length, MAX_IN_CELL);
  for (let i = 0; i < shown; i++) cell.appendChild(buildReleaseEntry(releases[i]));

  if (releases.length > MAX_IN_CELL) {
    const moreEl = document.createElement('div');
    moreEl.className = 'text-[9px] text-frosted-blue/70 font-medium mt-0.5 pl-0.5';
    moreEl.textContent = '+' + (releases.length - MAX_IN_CELL) + ' more';
    cell.appendChild(moreEl);
  }
  return cell;
}

function buildAgendaRow(date, dateStr, isToday, dayReleases) {
  const row = document.createElement('div');
  row.className = 'flex gap-4 py-3 px-2 cursor-pointer';
  if (isToday) row.className += ' bg-primary/10 rounded-lg border border-primary/30';
  row.setAttribute('data-action', 'day');
  row.setAttribute('data-date', dateStr);

  const dateLabel = document.createElement('div');
  dateLabel.className = 'w-14 shrink-0 text-center pt-0.5';
  const dayNameEl = document.createElement('div');
  dayNameEl.className = 'text-[10px] font-bold uppercase tracking-wider ' + (isToday ? 'text-frosted-blue' : 'text-steel-blue');
  dayNameEl.textContent = DAY_SHORT[date.getDay()];
  dateLabel.appendChild(dayNameEl);
  const dayNumEl = document.createElement('div');
  dayNumEl.className = 'text-xl font-bold text-frosted-blue';
  dayNumEl.textContent = String(date.getDate());
  dateLabel.appendChild(dayNumEl);
  row.appendChild(dateLabel);

  const releasesCol = document.createElement('div');
  releasesCol.className = 'flex-1 min-w-0 flex flex-col gap-1';
  if (dayReleases.length === 0) {
    const none = document.createElement('span');
    none.className = 'text-sm text-frosted-blue/70 italic';
    none.textContent = 'No releases';
    releasesCol.appendChild(none);
  } else {
    dayReleases.forEach(function (release) {
      const item = document.createElement('div');
      item.className = 'flex items-center gap-2';
      item.appendChild(mediaBadge(release, 'text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0', 'MOV', 'TV'));
      const titleEl = document.createElement('span');
      titleEl.className = 'text-sm text-frosted-blue/80 truncate';
      let titleText = release.title || 'Unknown';
      if (release.media_type === 'tv' && release.episode_code) titleText += ' ' + release.episode_code;
      titleEl.textContent = titleText;
      item.appendChild(titleEl);
      if (release.has_file) item.appendChild(checkMark('text-xs shrink-0'));
      releasesCol.appendChild(item);
    });
  }
  row.appendChild(releasesCol);
  return row;
}

function buildDetailCard(release) {
  const card = document.createElement('div');
  card.className = 'flex gap-3 lg:gap-4 p-3 rounded-lg bg-frosted-blue/5 border border-steel-blue/10';

  if (release.poster_url) {
    // A poster that fails to load is hidden by the page's error listener.
    const poster = document.createElement('img');
    poster.src = release.poster_url;
    poster.alt = release.title || '';
    poster.className = 'w-14 h-[84px] lg:w-16 lg:h-24 rounded object-cover shrink-0';
    poster.setAttribute('data-poster', '');
    card.appendChild(poster);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'w-14 h-[84px] lg:w-16 lg:h-24 rounded bg-frosted-blue/5 flex items-center justify-center shrink-0';
    const phIcon = document.createElement('span');
    phIcon.className = 'material-symbols-outlined text-2xl text-steel-blue/30';
    phIcon.textContent = release.media_type === 'movie' ? 'movie' : 'tv';
    placeholder.appendChild(phIcon);
    card.appendChild(placeholder);
  }

  const info = document.createElement('div');
  info.className = 'flex-1 min-w-0';

  const titleRow = document.createElement('div');
  titleRow.className = 'flex items-start gap-2';
  const titleText = document.createElement('p');
  titleText.className = 'text-frosted-blue text-sm font-bold leading-snug';
  titleText.textContent = release.title || 'Unknown';
  titleRow.appendChild(titleText);
  if (release.has_file) {
    const checkIcon = checkMark('text-base shrink-0 mt-0.5');
    checkIcon.title = 'Available';
    titleRow.appendChild(checkIcon);
  }
  info.appendChild(titleRow);

  const badgesRow = document.createElement('div');
  badgesRow.className = 'flex flex-wrap items-center gap-1.5 mt-1';
  badgesRow.appendChild(mediaBadge(release, 'text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider', 'Movie', 'TV Show'));
  if (release.episode_code) {
    const codeBadge = document.createElement('span');
    codeBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-steel-blue/20 text-frosted-blue/80 uppercase tracking-wider';
    codeBadge.textContent = release.episode_code;
    badgesRow.appendChild(codeBadge);
  }
  info.appendChild(badgesRow);

  if (release.episode_title) {
    const epTitle = document.createElement('p');
    epTitle.className = 'text-xs text-frosted-blue/70 mt-1';
    epTitle.textContent = release.episode_title;
    info.appendChild(epTitle);
  }
  if (release.overview) {
    const overview = document.createElement('p');
    overview.className = 'text-xs text-frosted-blue/70 mt-1.5 line-clamp-2 lg:line-clamp-3 leading-relaxed';
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
  const grouped = {};               // "YYYY-MM" -> { "YYYY-MM-DD": [release, ...] }

  function monthKey() {
    return year + '-' + padZero(month + 1);
  }

  function buildGrid(byDate) {
    const range = visibleRange(year, month);
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
      grid.appendChild(buildDayCell(current.getDate(), dateStr, isCurrentMonth, dateStr === todayStr,
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
    if (!hasContent) grid.appendChild(emptyNote('py-12', 'text-4xl', 'No releases this month'));
  }

  function showDetailPanel(dateStr, releases) {
    panel.classList.remove('hidden');
    const parts = dateStr.split('-');
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    detailLabel.textContent = DAY_NAMES[d.getDay()] + ', ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();

    clearChildren(detailList);
    if (releases.length === 0) {
      detailList.appendChild(emptyNote('py-6', 'text-3xl', 'No releases on this day'));
      return;
    }
    releases.forEach(function (release) { detailList.appendChild(buildDetailCard(release)); });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function onDayClick(dateStr) {
    selectedDate = dateStr;
    const byDate = grouped[monthKey()] || {};
    buildGrid(byDate);   // the selection highlight
    showDetailPanel(dateStr, byDate[dateStr] || []);
  }

  function closeDetailPanel() {
    selectedDate = null;
    panel.classList.add('hidden');
    const byDate = grouped[monthKey()];
    if (byDate) buildGrid(byDate);   // clears the selection highlight
  }

  function showError() {
    clearChildren(grid);
    const cell = document.createElement('div');
    cell.className = 'col-span-7 text-center text-steel-blue py-12';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined text-4xl mb-2 block opacity-50';
    icon.textContent = 'error';
    const text = document.createElement('p');
    text.className = 'text-sm';
    text.textContent = 'Could not load calendar data';
    cell.appendChild(icon);
    cell.appendChild(text);
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
