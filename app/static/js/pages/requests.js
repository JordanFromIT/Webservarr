/**
 * WebServarr — Requests (page module)
 *
 * Ask for something new and see where earlier asks stand, in the Books
 * layout (audit M3, M8): one search for everything, whose results take the
 * place of the rest while there is a search; three shelves grouped by what
 * people want (Trending, Coming soon, Books), each filled from several
 * sources; the Request Status grid; the recent requests with their filter
 * chips; and a detail modal for a shelf poster. Cards are the Books card: the
 * cover, two lines of title, one quiet line, where a title stands as a mark
 * on its cover. The library summary is one quiet line, how long requests
 * usually take (audit H3).
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. One delegated click listener on ctx.root serves the static
 * controls and the rebuilt cards (data-action); a poster that fails to load is
 * swapped for its placeholder by one capturing error listener, not an inline
 * handler (a trending book whose cover fails leaves its row instead). Every
 * discover poster is a button, so the shelves work from the keyboard. The
 * modal is a dialog (WSUI.modal) and lives inside #wsPage, so leaving the
 * page takes it away, open or not. The discover rows and their skeletons are markup in
 * requests.html, so they are in the first paint.
 *
 * When the operator chose the Seerr embed as the Requests source, /requests
 * is requests-embed.html instead, run by pages/requests-embed.js.
 */

const CARDS_PER_PAGE = 12;
const REFRESH_MS = 30000;
const SEARCH_WAIT_MS = 300;

// The shelves, by the id of their row in requests.html: one want each, filled
// from several sources and interleaved (mergeShelf), so a shelf is never one
// service's list. A source is a Seerr discover endpoint by its suffix, or a
// path of its own (books come from Chaptarr). A books shelf shows covers only.
const SHELVES = [
  { id: 'trendingRow', sources: ['trending', 'popular-movies', 'popular-series'] },
  { id: 'comingRow',   sources: ['upcoming-movies', 'upcoming-series'] },
  { id: 'booksRow',    sources: ['/api/integrations/books-trending', '/api/integrations/audiobooks-trending'], coversOnly: true }
];

function sourceUrl(source) {
  return source.charAt(0) === '/' ? source : '/api/integrations/seerr-discover/' + source;
}

/**
 * One shelf from its sources' lists: taken in turn, one from each, so a
 * shelf mixes movies and shows (or ebooks and audiobooks) from the start,
 * and a title two sources both carry is shown once.
 */
function mergeShelf(lists) {
  var out = [], seen = {}, longest = 0;
  lists.forEach(function (l) { longest = Math.max(longest, l.length); });
  for (var i = 0; i < longest; i++) {
    lists.forEach(function (l) {
      var item = l[i];
      if (!item) return;
      var key = (item.media_type || 'movie') + ':' + item.id;
      if (seen[key]) return;
      seen[key] = true;
      out.push(item);
    });
  }
  return out;
}

function isAbort(e) { return !!e && e.name === 'AbortError'; }

// ---------------------------------------------------------------------------
// Request Status vocabulary
//
// Answers "where is the thing I asked for" for every outstanding request. The
// classification arrives pre-computed from /api/request-status; everything here
// is presentation. No arr vocabulary anywhere in the copy: the audience has
// never opened those applications.

const RS_REASONS = {
  ALREADY_AVAILABLE: 'Ready to watch, your app may need a refresh',
  DOWNLOADING:       'Downloading now',
  DOWNLOAD_STALLED:  'That copy stalled, looking for another',
  IMPORT_BLOCKED:    'Downloaded, but couldn’t be added to the library',
  NO_RELEASE_FOUND:  'No copy online yet, still checking',
  TV_PARTIAL:        'Some episodes here, rest still coming',
  NOT_RELEASED_YET:  'Not released yet',
  AWAITING_APPROVAL: 'Waiting to be approved',
  NOT_MONITORED:     'Not being searched for',
  NOT_TRACKED:       'Never got added to the download system',
  DECLINED:          'Turned down',
  UNSATISFIABLE:     'Can’t be fetched as requested',
  DEAD_END:          'Tried repeatedly without success',
  UNKNOWN:           'Being looked at'
};
// Short chip for the Status column; the sentence lives in "Why".
//
// Derived from reason_code, NOT from the coarse group. The group put 93 rows
// that are still being searched for under the same "On the way" chip as the
// 16 genuinely downloading, which reads as "minutes away" for requests that
// have found nothing in a year. Each chip now says only what is true.
const RS_STATUS = {
  DOWNLOADING:       { key: 'downloading', label: 'Downloading', cls: 'rs-chip-go' },
  DOWNLOAD_STALLED:  { key: 'retrying',    label: 'Retrying',    cls: 'rs-chip-go' },
  TV_PARTIAL:        { key: 'partial',     label: 'Partly here', cls: 'rs-chip-go' },
  // A show is never simply "downloading" -- it is some number of episodes in
  // and some number short, and saying "Downloading" for a series sitting at
  // 27 of 59 reads as nearly-here when it is not. Shows get their own chip
  // and the counts carry the truth. See rsStatusOf().
  _TV_FETCHING:      { key: 'gettingeps',  label: 'Getting episodes', cls: 'rs-chip-go' },
  _QUEUED:           { key: 'queued',      label: 'Queued',      cls: 'rs-chip-wait' },
  NO_RELEASE_FOUND:  { key: 'searching',   label: 'Searching',   cls: 'rs-chip-wait' },
  NOT_MONITORED:     { key: 'paused',      label: 'Paused',      cls: 'rs-chip-wait' },
  NOT_RELEASED_YET:  { key: 'unreleased',  label: 'Not out yet', cls: 'rs-chip-wait' },
  AWAITING_APPROVAL: { key: 'approval',    label: 'Needs approval', cls: 'rs-chip-stuck' },
  NOT_TRACKED:       { key: 'notadded',    label: 'Not added',   cls: 'rs-chip-stuck' },
  IMPORT_BLOCKED:    { key: 'stuck',       label: 'Stuck',       cls: 'rs-chip-stuck' },
  DECLINED:          { key: 'declined',    label: 'Declined',    cls: 'rs-chip-dead' },
  UNSATISFIABLE:     { key: 'cantget',     label: 'Can’t get',   cls: 'rs-chip-dead' },
  DEAD_END:          { key: 'cantget',     label: 'Can’t get',   cls: 'rs-chip-dead' },
  UNKNOWN:           { key: 'checking',    label: 'Checking',    cls: 'rs-chip-wait' }
};

const RS_COLUMNS = [
  { key: 'title',  label: 'Title',   min: 180, grow: true },
  { key: 'status', label: 'Status',  min: 120 },
  { key: 'why',    label: 'Why',     min: 240, hideMobile: true },
  { key: 'waited', label: 'Waiting', min: 100, hideMobile: true, numeric: true },
  { key: 'type',   label: 'Type',    min: 90,  hideMobile: true }
];

// Five rows, then the body scrolls. Measured from the rendered rows rather
// than assumed, because a row with a season/4K line under the title is taller
// than one without and a hardcoded height would cut the fifth row in half.
const RS_MAX_ROWS = 5;

function rsStatusOf(r) {
  // A show being fetched is not "downloading" in any sense a viewer means it.
  // Sonarr has episodes queued, but the series can be less than half here and
  // stay that way for months. Give it its own word and let the counts speak.
  if (r.media_type === 'tv' && (r.reason_code === 'DOWNLOADING' || r.reason_code === 'DOWNLOAD_STALLED')) {
    return RS_STATUS._TV_FETCHING;
  }
  // A film Radarr has grabbed but not started is queued, not downloading.
  // Reporting 0% as "Downloading" is the same overstatement in miniature.
  if (r.media_type === 'movie' && r.reason_code === 'DOWNLOADING' && !r.percent) {
    return RS_STATUS._QUEUED;
  }
  return RS_STATUS[r.reason_code] || { key: 'checking', label: 'Checking', cls: 'rs-chip-wait' };
}

// The "Why" sentence. For a show this is where the episode counts go, because
// "27 of 59 episodes here" answers the question far better than any verb can.
function rsReasonText(r) {
  var have = r.episodes_have, total = r.episodes_total;
  var hasCounts = typeof have === 'number' && typeof total === 'number' && total > 0;

  if (r.media_type === 'tv' && hasCounts) {
    var short = total - have;
    if (r.reason_code === 'DOWNLOADING' || r.reason_code === 'DOWNLOAD_STALLED') {
      var q = r.episodes_queued || 0;
      return have + ' of ' + total + ' episodes here' +
             (q ? ', ' + q + ' being fetched' : '') +
             (r.reason_code === 'DOWNLOAD_STALLED' ? ' (some copies failed, retrying)' : '');
    }
    if (r.reason_code === 'TV_PARTIAL') {
      return have + ' of ' + total + ' episodes here, ' + short + ' still being looked for';
    }
    if (r.reason_code === 'NO_RELEASE_FOUND' && have === 0) {
      return 'No episodes found online yet, still checking';
    }
  }
  if (r.media_type === 'movie' && r.reason_code === 'DOWNLOADING') {
    return r.percent ? 'Downloading, ' + Math.round(r.percent) + '% done'
                     : 'Found a copy, waiting for the download to start';
  }
  return RS_REASONS[r.reason_code] || 'Being looked at';
}

function rsDaysWaiting(iso) {
  if (!iso) return 0;
  var t = new Date(iso);
  return isNaN(t) ? 0 : Math.max(0, Math.floor((Date.now() - t.getTime()) / 86400000));
}
function rsWaitedText(d) {
  if (d < 1) return 'today';
  if (d === 1) return '1 day';
  if (d < 30) return d + ' days';
  var m = Math.round(d / 30);
  var y = Math.round(d / 365);
  return m < 12 ? m + (m === 1 ? ' month' : ' months')
                : y + (y === 1 ? ' year' : ' years');
}
function rsScopeText(r) {
  var p = [];
  if (r.is_4k) p.push('4K');
  if (r.seasons && r.seasons.length) {
    var s = r.seasons.slice().sort(function (a, b) { return a - b; });
    if (s.length === 1) p.push(s[0] === 0 ? 'Specials' : 'Season ' + s[0]);
    else if (s.indexOf(0) === -1 && s[s.length - 1] - s[0] === s.length - 1)
      p.push('Seasons ' + s[0] + ' to ' + s[s.length - 1]);
    else p.push(s.length + ' seasons');
  }
  return p.join(', ');
}

function rsCellValue(r, key) {
  switch (key) {
    case 'title':  return r.title || ('Request #' + r.request_id);
    case 'status': return rsStatusOf(r).label;
    case 'why':    return rsReasonText(r);
    case 'waited': return rsDaysWaiting(r.requested_at);
    case 'type':   return r.media_type === 'tv' ? 'Show' : 'Movie';
    default:       return '';
  }
}

// ---------------------------------------------------------------------------
// Media types and request statuses
//
// The words, in sentence case as Books writes them; the icon and the accent
// colour come from the shared vocabulary in shell.js (WS.mediaType), and the
// states from WS.requestStatus, so Home and this page agree on what each
// state is called.

const TYPE_WORDS = { movie: 'Movie', tv: 'TV show', book: 'Ebook', audiobook: 'Audiobook' };

function typeWord(mediaType) {
  return TYPE_WORDS[mediaType] || TYPE_WORDS.movie;
}

/** What a Request button asks for, said in the button's sentence. */
function requestNoun(mediaType) {
  return mediaType === 'tv' ? 'TV show' : typeWord(mediaType).toLowerCase();
}

/**
 * Media type accent, as a theme class rather than a fixed palette value.
 *
 * The three hues are theme settings (theme.color_media_movie / _tv / _book),
 * so an admin retheming the site retints these too. The classes live in
 * theme.css. On a card it is a small dot beside the type's word: the word
 * says it, the dot lets a shelf be scanned by kind.
 */
function mediaTypeAccent(mediaType) {
  return WS.mediaType(mediaType).accent;
}

/** Placeholder glyph when a title has no artwork. */
function mediaTypeIcon(mediaType) {
  return WS.mediaType(mediaType).icon;
}

/** Seerr's state for a title, or null for none: its "unknown" means nobody
    asked for it, so the title can be requested (never a "Requested" badge). */
function knownStatus(raw) {
  var s = raw ? String(raw).toLowerCase() : null;
  return s === 'unknown' ? null : s;
}

/** A state's word in sentence case ("Partly available"). */
function statusWord(status) {
  var label = WS.requestStatus(status).label;
  return label.charAt(0) + label.slice(1).toLowerCase();
}

// Tones for the status block under a search result, theme colours only:
// finished reads on a primary tint, things in motion in the text colour,
// not-yet-started and will-not-happen quiet.
const STATUS_TONE_CLASSES = {
  ready: 'bg-primary/30 text-frosted-blue',
  go:    'bg-frosted-blue/15 text-frosted-blue',
  wait:  'bg-frosted-blue/[0.07] text-frosted-blue/80',
  dead:  'bg-frosted-blue/[0.07] text-frosted-blue/80'
};

// The card's lines, as Books draws them (pages/books.js renderBookCard): two
// lines of room for the title whatever it is, then one quiet line, so every
// card is one height and lands on its skeleton in requests.html.
// line-clamp is its own display (a -webkit-box), so no display class beside it.
const CARD_TITLE = 'mt-2 text-body font-semibold leading-snug text-frosted-blue line-clamp-2 min-h-[2.75em]';
const CARD_SUB = 'flex items-center gap-1.5 min-w-0 text-label leading-5 min-h-5 text-frosted-blue/70';

/** The quiet line: the type's dot and word, then the year, author or date. */
function subLine(mediaType, extra) {
  return '<span class="' + CARD_SUB + '">' +
    '<span class="size-2 shrink-0 rounded-full bg-' + mediaTypeAccent(mediaType) + '" aria-hidden="true"></span>' +
    '<span class="min-w-0 truncate">' + escapeHtml(typeWord(mediaType) + (extra ? ', ' + extra : '')) + '</span>' +
  '</span>';
}

/**
 * Where a title stands, as a mark on the top left of its cover (where Books
 * marks a new book): the shared state's word, in the accent once it is on the
 * server, quiet otherwise. Nothing for a title no one has asked for, or for
 * Seerr's "unknown": no mark, never the word Unknown. Its words are part of
 * the card's name.
 */
// Card-only short words, for the marks that cannot fit a 144px cover.
const DISCOVER_SHORT_LABELS = { partially_available: 'Partly here' };

function statusMark(status) {
  if (!status || status === 'unknown') return '';
  var known = WS.requestStatus(status);
  var shown = DISCOVER_SHORT_LABELS[status] || statusWord(status);
  return '<span data-discover-status title="' + escapeHtml(statusWord(status)) + '" ' +
    'class="absolute left-2 top-2 inline-flex h-6 max-w-[calc(100%-1rem)] items-center rounded-full px-2 text-label font-semibold leading-none ' +
    (known.tone === 'ready' ? 'bg-primary text-bright' : 'bg-background-dark/80 text-frosted-blue') + '">' +
    '<span class="truncate">' + escapeHtml(shown) + '</span></span>';
}

// A poster image, or its placeholder glyph when there is none. The image
// carries data-fallback: the page's capturing error listener hides one that
// fails and shows the placeholder beside it.
// lazy: only for a poster that starts off screen (a card far along a shelf,
// the recent requests below the shelves); the first screenful is eager, as
// the page's largest picture is one of them.
function posterMarkup(posterUrl, alt, imgClass, iconClass, mediaType, lazy) {
  var glyph = '<span class="material-symbols-outlined ' + iconClass + ' text-frosted-blue/45" aria-hidden="true">' + mediaTypeIcon(mediaType) + '</span>';
  if (!posterUrl) {
    return '<span class="absolute inset-0 flex items-center justify-center poster-placeholder">' + glyph + '</span>';
  }
  return '<img src="' + escapeHtml(posterUrl) + '" alt="' + alt + '"' + (lazy ? ' loading="lazy"' : '') + ' decoding="async" class="' + imgClass + '" data-fallback/>' +
    '<span class="absolute inset-0 items-center justify-center poster-placeholder" style="display:none">' + glyph + '</span>';
}

/** The Books cover frame: 2:3, rounded, holding its shape before the picture lands. */
function coverMarkup(posterUrl, mediaType, mark, lazy) {
  return '<span class="relative block aspect-[2/3] overflow-hidden rounded-xl bg-frosted-blue/[0.07]">' +
    posterMarkup(posterUrl, '', 'absolute inset-0 w-full h-full object-cover', 'text-[32px]', mediaType, lazy) +
    (mark || '') +
  '</span>';
}

// A shelf poster. rowId and index name the item in the visit's shelf data;
// the page's click listener opens it (data-action="open-media").
function buildDiscoverCard(item, rowId, index) {
  var mediaType = item.media_type || 'movie';
  var status = item.media_status ? item.media_status.toLowerCase() : null;
  var statusHtml = statusMark(status);
  var extra = item.author || (item.year ? String(item.year) : '');

  // A button, as the Books covers are links: the cover, then the title on
  // two lines of room and the quiet line, the same box as the skeleton in
  // requests.html. The title names the button, so the poster's alt stays
  // empty. ws-lift on the card: the card is what is clicked.
  return (
    '<button type="button" class="flex w-36 shrink-0 flex-col text-left rounded-xl ws-lift group" ' +
        'data-action="open-media" data-row="' + escapeHtml(rowId) + '" data-index="' + index + '">' +
      coverMarkup(item.poster_url || '', mediaType, statusHtml, index >= 8) +
      '<span class="' + CARD_TITLE + '">' + escapeHtml(item.title || 'Untitled') + '</span>' +
      subLine(mediaType, extra) +
    '</button>'
  );
}

/** A state's words for the block under a search result. */
function getStatusPresentation(status, item) {
  var known = WS.requestStatus(status);
  var label = statusWord(status);
  // A count beats any adjective: "48 of 62 episodes" says exactly what is
  // here, where "Partly available" does not.
  if (status === 'partially_available' && item && item.episodes_total) {
    label = item.episodes_available + ' of ' + item.episodes_total + ' episodes';
  }
  return { tone: STATUS_TONE_CLASSES[known.tone] || STATUS_TONE_CLASSES.wait, label: label };
}

/**
 * The status block, the Request button's own box: a card does not change
 * shape depending on whether a title can be requested; only the words and
 * the colour of that box change.
 */
function getStatusBlock(status, item) {
  var s = getStatusPresentation(status, item);
  return '<div class="flex h-10 w-full items-center justify-center rounded-btn px-2 text-label font-semibold ' + s.tone + '">' +
    '<span class="truncate">' + escapeHtml(s.label) + '</span></div>';
}

/** The detail modal's state: a quiet line in the type's place. */
function getStatusBadge(status) {
  var s = getStatusPresentation(status);
  return '<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-label font-semibold ' + s.tone + '">' +
    escapeHtml(s.label) + '</span>';
}

function buildSearchCard(item) {
  var title = escapeHtml(item.title || 'Untitled');
  var mediaType = item.media_type || 'movie';
  var status = knownStatus(item.media_status);
  var status4k = knownStatus(item.media_status_4k);

  // Request button or status block (standard and 4K together: the best state).
  var combinedStatus = status;
  if (!combinedStatus && status4k) {
    combinedStatus = status4k;
  } else if (combinedStatus && status4k) {
    // If either is available, show available
    var availStatuses = ['available', 'completed'];
    if (availStatuses.indexOf(status4k) !== -1 && availStatuses.indexOf(combinedStatus) === -1) {
      combinedStatus = status4k;
    }
  }

  var action;
  if (!combinedStatus) {
    // Type and id ride in data-* attributes, read by the page's click
    // listener (data-action="request-media"), so a provider id like
    // "gr:3634639" never meets JavaScript source: HTML-escaping would not
    // stop a JS-context breakout. Chaptarr book ids are strings; Seerr's
    // numeric ids coerce back to int server-side. The button says what it
    // asks for; the title is in its name for a screen reader. ws-lift on
    // the button, not the card: the button is what is clicked.
    action = '<button type="button" data-action="request-media" data-request-type="' + escapeHtml(mediaType) + '" data-request-id="' + escapeHtml(String(item.id)) + '" data-request-title="' + title + '" class="ws-lift h-10 w-full rounded-btn bg-primary hover:bg-primary/90 px-2 text-body font-semibold text-bright transition-colors">' +
      'Request ' + escapeHtml(requestNoun(mediaType)) + '<span class="sr-only">: ' + title + '</span></button>';
  } else {
    action = getStatusBlock(combinedStatus, item);
  }

  // Books have no cover art more often than films, so the author does the
  // work the artwork would have done; films and shows give their year.
  var extra = item.author || (item.year ? String(item.year) : '');
  return '<div class="min-w-0">' +
    coverMarkup(item.poster_url || '', mediaType, '') +
    '<span class="' + CARD_TITLE + '">' + title + '</span>' +
    subLine(mediaType, extra) +
    '<div class="mt-2">' + action + '</div>' +
  '</div>';
}

function buildRequestCard(req) {
  var mediaType = req.media_type || 'movie';
  var status = (req.status || 'pending').toLowerCase();
  var requestedDate = req.requested_date ? getTimeAgo(req.requested_date, true) : '';

  // Not a control: the card shows where a request stands, on its cover.
  return '<div class="min-w-0" data-status="' + escapeHtml(status) + '">' +
    coverMarkup(req.poster_url || '', mediaType, statusMark(status), true) +
    '<span class="' + CARD_TITLE + '">' + escapeHtml(req.media_title || 'Untitled') + '</span>' +
    subLine(mediaType, requestedDate) +
  '</div>';
}

// ---- Library summary ----

/** A wait in the largest unit that still reads naturally, in words. */
function waitWords(minutes) {
  if (typeof minutes !== 'number' || !isFinite(minutes) || minutes <= 0) return '';
  function n(v, one, many) { return v + ' ' + (v === 1 ? one : many); }
  if (minutes < 60) return n(Math.max(1, Math.round(minutes)), 'minute', 'minutes');
  if (minutes < 60 * 48) return n(Math.round(minutes / 60), 'hour', 'hours');
  return n(Math.round(minutes / 1440), 'day', 'days');
}

// The site's one toast (ui.js): theme colours, a status light for the tone.
function showToast(message, type) {
  WSUI.toast(message, type === 'success' ? 'ok' : 'err');
}

// ---------------------------------------------------------------------------

export async function mount(ctx) {
  var root = ctx.root;
  var signal = ctx.signal;

  function $(id) { return root.querySelector('#' + id); }

  // This visit's state: every mount starts its own.
  var searchTimer = 0;
  var searchCtl = null;             // the search in flight: a newer one aborts it
  var _currentSearchQuery = '';
  var _currentSearchPage = 1;
  var _totalSearchPages = 1;
  var _searchResults = [];
  var _searchDisplayPage = 1;
  var _allRequests = [];
  var _currentFilter = 'all';
  var _requestsDisplayPage = 1;
  var _discoverItems = {};          // row id -> that row's items, for the modal
  var _dialog = null;               // the open media detail (WSUI.modal), or null

  // -------------------------------------------------------------------------
  // Request Status grid
  //
  // It is a real data grid rather than a list because the admin triages a few
  // hundred rows, but it has to stay legible to a family member checking on one
  // film. That shapes three decisions: columns auto-fit their content instead of
  // being fixed, the title column and the header stay pinned while the rest
  // scrolls, and on a phone the whole thing becomes a two-column list that
  // expands on tap rather than something to drag sideways.
  var RS = (function () {
    var _rows = [];
    var _snapshot = null;
    var _sort = { key: 'waited', dir: 'desc' };
    var _expanded = {};

    function visible() {
      var q = ($('rsSearch').value || '').trim().toLowerCase();
      var fs = $('rsFilterStatus').value;
      var ft = $('rsFilterType').value;

      var out = _rows.filter(function (r) {
        if (fs && rsStatusOf(r).key !== fs) return false;
        if (ft && r.media_type !== ft) return false;
        if (q) {
          var hay = (rsCellValue(r, 'title') + ' ' + rsCellValue(r, 'why') + ' ' + rsCellValue(r, 'status')).toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });

      var col = RS_COLUMNS.filter(function (c) { return c.key === _sort.key; })[0] || {};
      var dir = _sort.dir === 'asc' ? 1 : -1;
      out.sort(function (a, b) {
        var x = rsCellValue(a, _sort.key), y = rsCellValue(b, _sort.key);
        if (col.numeric) return (x - y) * dir;
        return String(x).localeCompare(String(y), undefined, { sensitivity: 'base' }) * dir;
      });
      return out;
    }

    function renderHead() {
      $('rsHead').innerHTML = RS_COLUMNS.map(function (c) {
        var active = _sort.key === c.key;
        var arrow = active ? (_sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more';
        return '<th data-col="' + c.key + '" class="rs-th' + (c.hideMobile ? ' rs-hide-sm' : '') +
                 (c.key === 'title' ? ' rs-sticky' : '') + '" style="min-width:' + c.min + 'px">' +
          '<button type="button" class="rs-sort" data-sort="' + c.key + '">' +
            escapeHtml(c.label) +
            '<span class="material-symbols-outlined text-[15px] ' + (active ? 'text-frosted-blue' : 'opacity-40') + '" aria-hidden="true">' + arrow + '</span>' +
          '</button>' +
          '<span class="rs-resizer" data-resize="' + c.key + '"></span>' +
        '</th>';
      }).join('');
    }

    function renderBody() {
      var rows = visible();
      var body = $('rsBody');
      var empty = $('rsEmpty');
      $('rsCount').textContent = String(rows.length);

      if (!rows.length) {
        body.innerHTML = '';
        empty.textContent = _rows.length
          ? 'Nothing matches those filters.'
          : 'Everything that has been asked for is on the server.';
        empty.classList.remove('hidden');
        $('rsScroll').classList.add('hidden');
        return;
      }
      empty.classList.add('hidden');
      $('rsScroll').classList.remove('hidden');

      body.innerHTML = rows.map(function (r) {
        var st = rsStatusOf(r);
        var id = String(r.request_id);
        var open = !!_expanded[id];
        var scope = rsScopeText(r);
        var main =
          '<tr class="rs-row" data-id="' + escapeHtml(id) + '">' +
            '<td class="rs-td rs-sticky">' +
              '<div class="flex items-center gap-2 min-w-0">' +
                '<span class="material-symbols-outlined text-frosted-blue/70 text-lg shrink-0 rs-only-sm" aria-hidden="true">' +
                  (open ? 'expand_less' : 'expand_more') + '</span>' +
                '<div class="min-w-0">' +
                  '<span class="font-bold text-frosted-blue break-words">' + escapeHtml(rsCellValue(r, 'title')) + '</span>' +
                  (r.year ? ' <span class="text-frosted-blue/70 text-label tabular-nums">' + escapeHtml(String(r.year)) + '</span>' : '') +
                  (scope ? '<span class="block text-label text-frosted-blue/70">' + escapeHtml(scope) + '</span>' : '') +
                '</div>' +
              '</div>' +
            '</td>' +
            '<td class="rs-td"><span class="rs-chip ' + st.cls + '">' + escapeHtml(st.label) + '</span></td>' +
            '<td class="rs-td rs-hide-sm text-frosted-blue/75">' + escapeHtml(rsCellValue(r, 'why')) + '</td>' +
            '<td class="rs-td rs-hide-sm text-frosted-blue/70 whitespace-nowrap">' + escapeHtml(rsWaitedText(rsDaysWaiting(r.requested_at))) + '</td>' +
            '<td class="rs-td rs-hide-sm text-frosted-blue/70">' + escapeHtml(rsCellValue(r, 'type')) + '</td>' +
          '</tr>';
        // Phone-only detail row: everything the narrow layout drops, revealed on tap.
        var detail = open
          ? '<tr class="rs-detail rs-only-sm-row"><td class="rs-td" colspan="5">' +
              '<p class="text-sm text-frosted-blue/75">' + escapeHtml(rsCellValue(r, 'why')) + '</p>' +
              '<p class="text-label text-frosted-blue/70 mt-1">' +
                escapeHtml(rsCellValue(r, 'type')) + ', waiting ' + escapeHtml(rsWaitedText(rsDaysWaiting(r.requested_at))) +
              '</p>' +
            '</td></tr>'
          : '';
        return main + detail;
      }).join('');
      applyRowCap();
      updateScrollShadows();
    }

    // Cap the body at five rows and let the rest scroll vertically.
    //
    // The height is measured from the rows that actually rendered rather than
    // assumed: a row carrying a season or 4K line under its title is taller than
    // one without, so a fixed pixel height would slice the fifth row in half on
    // some filters and leave a gap on others. The header is excluded from the cap
    // so it stays pinned above the scrolling rows.
    function applyRowCap() {
      var scroll = $('rsScroll');
      var body = $('rsBody');
      var visibleRows = [].slice.call(body.children).filter(function (tr) {
        return !tr.classList.contains('rs-detail') || tr.offsetParent !== null;
      });
      if (visibleRows.length <= RS_MAX_ROWS) {
        scroll.style.maxHeight = '';
        scroll.classList.remove('rs-capped');
        return;
      }
      var head = $('rsHead');
      var headH = head ? head.getBoundingClientRect().height : 0;
      var total = 0;
      for (var i = 0; i < RS_MAX_ROWS && i < visibleRows.length; i++) {
        total += visibleRows[i].getBoundingClientRect().height;
      }
      if (!total) return;
      scroll.style.maxHeight = Math.ceil(headH + total) + 'px';
      scroll.classList.add('rs-capped');
    }

    // Built from the statuses actually present, so the dropdown never offers a
    // filter that would return nothing.
    function renderFilters() {
      var seen = [], opts = [];
      _rows.forEach(function (r) {
        var st = rsStatusOf(r);
        if (seen.indexOf(st.key) === -1) { seen.push(st.key); opts.push(st); }
      });
      opts.sort(function (a, b) { return a.label.localeCompare(b.label); });
      $('rsFilterStatus').innerHTML =
        '<option value="">All statuses</option>' + opts.map(function (o) {
          return '<option value="' + escapeHtml(o.key) + '">' + escapeHtml(o.label) + '</option>';
        }).join('');
    }

    // Edge shadows are what tell someone there is more table to the right. Without
    // them a horizontally scrollable region just looks cut off.
    function updateScrollShadows() {
      var el = $('rsScroll');
      if (!el) return;
      var max = el.scrollWidth - el.clientWidth;
      el.classList.toggle('rs-more-right', max > 2 && el.scrollLeft < max - 2);
      el.classList.toggle('rs-more-left', el.scrollLeft > 2);
    }

    // Drag a header edge to resize. Columns auto-fit their content until someone
    // decides otherwise, at which point that width sticks for the session.
    function wireResizers() {
      var startX = 0, startW = 0, th = null;
      function move(e) {
        if (!th) return;
        var x = (e.touches ? e.touches[0].clientX : e.clientX);
        var w = Math.max(60, startW + (x - startX));
        th.style.minWidth = w + 'px';
        th.style.width = w + 'px';
        updateScrollShadows();
      }
      function stop() {
        th = null;
        document.body.classList.remove('rs-resizing');
        window.removeEventListener('mousemove', move);
      }
      $('rsHead').addEventListener('mousedown', function (e) {
        var handle = e.target.closest('[data-resize]');
        if (!handle) return;
        e.preventDefault();
        th = handle.closest('th');
        startX = e.clientX;
        startW = th.getBoundingClientRect().width;
        document.body.classList.add('rs-resizing');
        window.addEventListener('mousemove', move, { signal: signal });
        window.addEventListener('mouseup', stop, { once: true, signal: signal });
      }, { signal: signal });
    }

    function wire() {
      $('rsSearch').addEventListener('input', renderBody, { signal: signal });
      $('rsFilterStatus').addEventListener('change', renderBody, { signal: signal });
      $('rsFilterType').addEventListener('change', renderBody, { signal: signal });

      $('rsHead').addEventListener('click', function (e) {
        var btn = e.target.closest('[data-sort]');
        if (!btn) return;
        var key = btn.dataset.sort;
        if (_sort.key === key) _sort.dir = _sort.dir === 'asc' ? 'desc' : 'asc';
        else { _sort.key = key; _sort.dir = key === 'waited' ? 'desc' : 'asc'; }
        renderHead();
        renderBody();
      }, { signal: signal });

      // Row tap expands the dropped columns. Only meaningful on a narrow screen,
      // where those columns are not rendered.
      $('rsBody').addEventListener('click', function (e) {
        var row = e.target.closest('.rs-row');
        if (!row || window.innerWidth >= 1024) return;
        var id = row.dataset.id;
        _expanded[id] = !_expanded[id];
        renderBody();
      }, { signal: signal });

      $('rsScroll').addEventListener('scroll', updateScrollShadows, { passive: true, signal: signal });
      window.addEventListener('resize', updateScrollShadows, { signal: signal });
      wireResizers();
    }

    async function load() {
      try {
        var resp = await fetch('/api/request-status/', { signal: signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        _snapshot = await resp.json();
        if (signal.aborted) return;
        if (_snapshot.error) { $('rsSection').classList.add('hidden'); return; }
        _rows = _snapshot.items || [];
        if (!_rows.length) { $('rsSection').classList.add('hidden'); return; }
        // Rows since the page was rendered: the server's collapse no longer holds.
        document.documentElement.removeAttribute('data-rs-empty');

        var mins = Math.floor((Date.now() - new Date(_snapshot.generated_at).getTime()) / 60000);
        $('rsFresh').textContent =
          (isFinite(mins) && mins >= 30) ? 'Checked ' + getTimeAgo(_snapshot.generated_at) : '';

        renderFilters();
        renderHead();
        wire();
        renderBody();
      } catch (err) {
        if (signal.aborted || isAbort(err)) return;   // left the page: not an error
        console.error('Request status failed:', err);
        $('rsSection').classList.add('hidden');
      }
    }

    return { load: load };
  })();

  // ---- Shelves ----

  function discoverRow(id) { return $(id); }

  // The rows and their skeletons are already in the page (markup in
  // requests.html, in the first paint); this wires them for the visit.
  function buildDiscoverSection() {
    SHELVES.forEach(function (shelf) {
      var el = discoverRow(shelf.id);
      if (!el) return;
      // Set the arrows correctly from the outset - the skeleton row starts at its
      // left edge, so the left arrow must not be offered before any data arrives.
      el.addEventListener('scroll', function () { updateDiscoverArrows(el); }, { passive: true, signal: signal });
      updateDiscoverArrows(el);
      // Mouse drag-to-scroll. The row element outlives every render (only its
      // contents are replaced), so wiring it once here covers the fetched cards.
      WS.dragScroll(el, { signal: signal });
    });
  }

  // Every source of a shelf is read at once; one that fails gives nothing and
  // the shelf shows the others. Only a shelf whose sources all failed says so.
  function loadShelf(shelf) {
    var failed = 0;
    return Promise.all(shelf.sources.map(function (source) {
      return fetch(sourceUrl(source), { signal: signal })
        .then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })
        .then(function (items) { return Array.isArray(items) ? items : []; })
        .catch(function (err) {
          if (signal.aborted || isAbort(err)) return null;   // left the page: not an error
          console.warn('Shelf source ' + source + ' failed:', err);
          failed += 1;
          return [];
        });
    })).then(function (lists) {
      if (signal.aborted) return;
      if (failed === shelf.sources.length) { renderDiscoverRowError(shelf.id); return; }
      renderDiscoverRow(shelf.id, mergeShelf(lists.filter(Boolean)));
    });
  }

  function loadDiscoverLists() {
    return Promise.all(SHELVES.map(loadShelf));
  }

  // The book shelf shows covers only: a book with no cover is left out, and
  // one whose cover fails to load leaves the row (dropCover below). A shelf
  // of blank tiles read as an unfinished page.
  function coversOnly(rowId) {
    return SHELVES.some(function (shelf) { return shelf.id === rowId && shelf.coversOnly; });
  }

  function renderDiscoverRow(rowId, items) {
    var row = discoverRow(rowId);
    if (!row) return;
    if (items && coversOnly(rowId)) items = items.filter(function (it) { return !!it.poster_url; });
    if (!items || items.length === 0) {
      holdHeight(row);
      _discoverItems[rowId] = [];
      row.innerHTML = '<p class="text-frosted-blue/70 text-body py-4">Nothing to show here right now.</p>';
      updateDiscoverArrows(row);
      return;
    }
    // The modal reads the item back from here by the card's data-row and
    // data-index: data kept for the visit, never a node.
    _discoverItems[rowId] = items;
    row.innerHTML = items.map(function (item, i) { return buildDiscoverCard(item, rowId, i); }).join('');
    updateDiscoverArrows(row);
  }

  // A shelf that ends up with a line instead of posters keeps the height it
  // had (its skeleton's), so the shelves below it do not move up.
  function holdHeight(row) {
    if (!row.style.minHeight && row.offsetHeight) row.style.minHeight = row.offsetHeight + 'px';
  }

  function renderDiscoverRowError(rowId) {
    var row = discoverRow(rowId);
    if (!row) return;
    holdHeight(row);
    _discoverItems[rowId] = [];
    row.innerHTML = '<p class="text-frosted-blue/70 text-body py-4">This shelf isn\u2019t available right now.</p>';
    // A failed row has nothing to scroll, so it should not offer to.
    updateDiscoverArrows(row);
  }

  function scrollDiscoverRow(row, direction) {
    if (!row) return;
    WS.dragScroll.stop(row);   // a mouse-drag glide still coasting would fight this
    row.scrollBy({ left: direction * 400, behavior: 'smooth' });
  }

  /**
   * Show each arrow only when the row can actually travel that way.
   *
   * A row that is already at its left edge still offered a left arrow, which did
   * nothing when clicked.
   *
   * The 1px tolerance matters: scrollLeft is fractional on fractional-width
   * layouts and at the right-hand end rarely equals the maximum exactly, so an
   * exact comparison would leave a dead arrow showing at the end of every row.
   */
  function updateDiscoverArrows(row) {
    if (!row) return;
    var wrapper = row.closest('.discover-row-wrapper');
    if (!wrapper) return;

    var maxScroll = row.scrollWidth - row.clientWidth;
    var left = wrapper.querySelector('.discover-scroll-btn.left');
    var right = wrapper.querySelector('.discover-scroll-btn.right');

    if (left) left.disabled = row.scrollLeft <= 1;
    // Also covers rows whose content fits, where maxScroll is 0 and neither
    // direction has anywhere to go.
    if (right) right.disabled = row.scrollLeft >= maxScroll - 1;
  }

  // ---- Search ----

  async function performSearch(query) {
    _currentSearchQuery = query;
    // One search at a time. Its own controller, aborted by the next search,
    // by clearing the box, and (chained below) by leaving the page: an older
    // query answering late must never paint over the newer one.
    if (searchCtl) searchCtl.abort();
    var ctl = searchCtl = new AbortController();
    signal.addEventListener('abort', function () { ctl.abort(); }, { once: true, signal: ctl.signal });
    var grid = $('searchResultsGrid');

    // The results take the place of everything under the search, as on Books.
    showResults(true);

    // Show loading
    grid.textContent = '';
    var loadingP = document.createElement('p');
    loadingP.className = 'text-body text-frosted-blue/70 py-4 col-span-full';
    loadingP.textContent = 'Searching\u2026';
    grid.appendChild(loadingP);

    try {
      // Films/TV and books are searched together. Books are a separate
      // backend, so a Chaptarr outage must not take out film and TV search -
      // its failure resolves to an empty list rather than rejecting.
      var bookSearch = fetch('/api/integrations/chaptarr-search?query=' + encodeURIComponent(query), { signal: ctl.signal })
        .then(function (r) { return r.ok ? r.json() : { results: [] }; })
        .then(function (d) { return d.results || []; })
        .catch(function () { return []; });

      var resp = await fetch('/api/integrations/seerr-search?query=' + encodeURIComponent(query) + '&page=' + _currentSearchPage, { signal: ctl.signal });
      if (!resp.ok) throw new Error('Search failed');
      var data = await resp.json();
      if (signal.aborted) return;
      // A newer search, or a cleared box, has started since: this answer is
      // not the one on screen, so it touches nothing.
      if (_currentSearchQuery !== query || searchCtl !== ctl) return;

      _totalSearchPages = data.totalPages || 1;
      var screenResults = data.results || [];
      // Films and TV are painted without waiting for books. The book backend
      // takes seconds - most of it Open Library cover lookups - and holding
      // the whole result set hostage to it made every search feel broken.
      _searchResults = screenResults;
      // Keep _searchDisplayPage if set to -1 (going to last page), otherwise reset to 1
      if (_searchDisplayPage === -1) {
        _searchDisplayPage = getSearchTotalDisplayPages() || 1;
      } else {
        _searchDisplayPage = 1;
      }

      var found = data.totalResults || 0;
      $('searchResultCount').textContent = found === 1 ? '1 result' : found + ' results';

      if (screenResults.length) {
        renderSearchPage();
      } else {
        // Books may still land here, so this says "nothing yet" rather
        // than being the final word.
        grid.textContent = '';
        var emptyP = document.createElement('p');
        emptyP.className = 'text-body text-frosted-blue/70 py-4 col-span-full';
        emptyP.textContent = 'Nothing matches \u201c' + query + '\u201d.';
        grid.appendChild(emptyP);
      }
      updateSearchPagination();

      // Books arrive late and are merged in place. The query is re-checked
      // because a slow book search can outlive the search that started it.
      bookSearch.then(function (bookResults) {
        if (signal.aborted || searchCtl !== ctl) return;
        if (_currentSearchQuery !== query || !bookResults.length) return;
        if (_currentSearchPage !== 1) return;

        // Books only join the first API page; Seerr owns pagination and
        // there is no sensible way to page two independent sources
        // together.
        //
        // They are interleaved rather than appended: with 12 cards per
        // display page and ~20 Seerr results, appending would push every
        // book past the first page and make book search effectively
        // invisible. Books are slotted in after the top few screen results
        // so they always land on page one, while the strongest film/TV
        // match still leads.
        var LEAD_SCREEN_RESULTS = 3;
        _searchResults = screenResults.slice(0, LEAD_SCREEN_RESULTS)
          .concat(bookResults)
          .concat(screenResults.slice(LEAD_SCREEN_RESULTS));
        renderSearchPage();
        updateSearchPagination();
      });

    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: nothing to say
      if (searchCtl !== ctl) return;                   // a newer search owns the grid
      console.error('Search error:', error);
      grid.textContent = '';
      var errP = document.createElement('p');
      errP.className = 'text-body text-frosted-blue/70 py-4 col-span-full';
      errP.textContent = 'Search isn\u2019t working right now. Try again in a minute.';
      grid.appendChild(errP);
    }
  }

  // The grid is rebuilt on every render; its Request buttons are answered by
  // the page's click listener (data-action="request-media").
  function renderSearchPage() {
    var grid = $('searchResultsGrid');
    var start = (_searchDisplayPage - 1) * CARDS_PER_PAGE;
    var pageItems = _searchResults.slice(start, start + CARDS_PER_PAGE);
    grid.innerHTML = pageItems.map(buildSearchCard).join('');
  }

  // While there is a search its results are the page; cleared, the shelves
  // and the requests come back where they were.
  function showResults(on) {
    $('searchResultsSection').classList.toggle('hidden', !on);
    $('browseArea').classList.toggle('hidden', on);
  }

  function clearSearch() {
    if (searchCtl) searchCtl.abort();
    _currentSearchQuery = '';
    _currentSearchPage = 1;
    _searchResults = [];
    _searchDisplayPage = 1;
    showResults(false);
    $('searchResultsGrid').textContent = '';
    $('searchResultCount').textContent = '';
    $('searchPagination').classList.add('hidden');
  }

  function getSearchTotalDisplayPages() {
    return Math.ceil(_searchResults.length / CARDS_PER_PAGE);
  }

  function updateSearchPagination() {
    var pagination = $('searchPagination');
    var totalDisplayPages = getSearchTotalDisplayPages();
    // Show pagination if there are multiple display pages OR multiple API pages
    if (totalDisplayPages <= 1 && _totalSearchPages <= 1) {
      pagination.classList.add('hidden');
      return;
    }
    pagination.classList.remove('hidden');
    // Show current display page info
    var pageLabel = 'Page ' + _searchDisplayPage + ' of ' + totalDisplayPages;
    $('searchPageInfo').textContent = pageLabel;
    // Prev disabled if on first display page of first API page
    $('searchPrevBtn').disabled = (_searchDisplayPage <= 1 && _currentSearchPage <= 1);
    // Next disabled if on last display page of last API page
    $('searchNextBtn').disabled = (_searchDisplayPage >= totalDisplayPages && _currentSearchPage >= _totalSearchPages);
  }

  function searchPrevPage() {
    if (_searchDisplayPage > 1) {
      _searchDisplayPage--;
      renderSearchPage();
      updateSearchPagination();
    } else if (_currentSearchPage > 1) {
      // Go to previous API page, start at the last display page
      _currentSearchPage--;
      _searchDisplayPage = -1; // signal to go to last page after fetch
      performSearch(_currentSearchQuery);
    }
  }

  function searchNextPage() {
    var totalDisplayPages = getSearchTotalDisplayPages();
    if (_searchDisplayPage < totalDisplayPages) {
      _searchDisplayPage++;
      renderSearchPage();
      updateSearchPagination();
    } else if (_currentSearchPage < _totalSearchPages) {
      // Fetch next API page
      _currentSearchPage++;
      performSearch(_currentSearchQuery);
    }
  }

  // ---- Request Media ----

  async function requestMedia(mediaType, mediaId, is4k, buttonEl, title) {
    // Disable button immediately
    buttonEl.disabled = true;
    var origHtml = buttonEl.innerHTML;
    buttonEl.textContent = 'Requesting\u2026';
    buttonEl.classList.add('opacity-60', 'cursor-not-allowed');

    try {
      // Books go to Chaptarr, films and TV to Seerr. Book ids are strings
      // such as "gr:3634639", not numbers.
      var isBook = mediaType === 'book' || mediaType === 'audiobook';
      var resp = await fetch(
        isBook ? '/api/integrations/chaptarr-request' : '/api/integrations/seerr-request',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            isBook
              ? { bookId: String(mediaId), format: mediaType === 'audiobook' ? 'audiobook' : 'ebook' }
              : { mediaType: mediaType, mediaId: mediaId, is4k: is4k }
          ),
          signal: signal
        }
      );

      if (!resp.ok) {
        var errData = await resp.json().catch(function () { return {}; });
        throw new Error(errData.detail || 'Request failed');
      }
      if (signal.aborted) return;

      // Swap the button for the matching status block, so the card holds its
      // shape and the click reads as the same element changing state.
      buttonEl.outerHTML = getStatusBlock('pending');

      // Plain past tense naming the thing: "Requested Dune".
      showToast(title ? 'Requested ' + title : 'Requested', 'success');

      // Refresh existing requests after a short delay
      ctx.setTimeout(function () {
        loadRequestCounts();
        loadExistingRequests();
      }, 1500);

    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: nothing to say
      console.error('Request error:', error);
      buttonEl.disabled = false;
      buttonEl.innerHTML = origHtml;
      buttonEl.classList.remove('opacity-60', 'cursor-not-allowed');
      showToast(error.message || 'The request didn\u2019t go through. Try again.', 'error');
    }
  }

  // ---- Request counts and library summary ----

  async function loadRequestCounts() {
    // Counts the whole server's requests, which is what the panel shows.
    try {
      var resp = await fetch('/api/integrations/request-counts', { signal: signal });
      if (!resp.ok) throw new Error('API error');
      var counts = await resp.json();
      if (signal.aborted) return;
      $('requestsTotalCount').textContent = String(counts.total || 0);
    } catch (e) {
      // No count: the heading simply has none beside it.
      if (signal.aborted || isAbort(e)) return;
    }
  }

  // The summary's one figure a requester cares about, in the quiet line under
  // the search. Without it the line keeps its general words.
  async function loadLibrarySummary() {
    try {
      var resp = await fetch('/api/integrations/library-summary', { signal: signal });
      if (!resp.ok) throw new Error('API error');
      var s = await resp.json();
      if (signal.aborted) return;
      var wait = waitWords((s.wait_minutes || {}).total);
      if (wait) $('requestWait').textContent = 'Requests are handled automatically. Most arrive in about ' + wait + '.';
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      // The general line stays: nothing here is worth an error.
    }
  }

  // ---- Existing requests ----

  async function loadExistingRequests() {
    var grid = $('requestsGrid');
    try {
      var resp = await fetch('/api/integrations/recent-requests?limit=50', { signal: signal });
      if (!resp.ok) throw new Error('API error');
      var requests = await resp.json();
      if (signal.aborted) return;

      if (!Array.isArray(requests)) requests = [];
      _allRequests = requests;

      renderRequests();
    } catch (error) {
      if (signal.aborted || isAbort(error)) return;   // left the page: not an error
      console.error('Error loading requests:', error);
      grid.textContent = '';
      var errP = document.createElement('p');
      errP.className = 'text-body text-frosted-blue/70 py-4 col-span-full';
      errP.textContent = 'Requests can\u2019t be shown right now. Try again in a minute.';
      grid.appendChild(errP);
      updateRequestsPagination(0);
    }
  }

  function renderRequests() {
    var grid = $('requestsGrid');
    var filtered = _allRequests;

    if (_currentFilter !== 'all') {
      filtered = _allRequests.filter(function (req) {
        var s = (req.status || '').toLowerCase();
        if (_currentFilter === 'available') return s === 'available' || s === 'completed';
        if (_currentFilter === 'approved') return s === 'approved' || s === 'downloading';
        return s === _currentFilter;
      });
    }

    if (filtered.length === 0) {
      var msg = _currentFilter === 'all' ? 'Nothing has been requested yet.' : 'Nothing matches that filter.';
      grid.textContent = '';
      var emptyP = document.createElement('p');
      emptyP.className = 'text-body text-frosted-blue/70 py-4 col-span-full';
      emptyP.textContent = msg;
      grid.appendChild(emptyP);
      updateRequestsPagination(0);
      return;
    }

    // Clamp page to valid range
    var totalPages = Math.ceil(filtered.length / CARDS_PER_PAGE);
    if (_requestsDisplayPage > totalPages) _requestsDisplayPage = totalPages;
    if (_requestsDisplayPage < 1) _requestsDisplayPage = 1;

    var start = (_requestsDisplayPage - 1) * CARDS_PER_PAGE;
    var pageItems = filtered.slice(start, start + CARDS_PER_PAGE);

    grid.innerHTML = pageItems.map(buildRequestCard).join('');
    updateRequestsPagination(totalPages);
  }

  function updateRequestsPagination(totalPages) {
    var pagination = $('requestsPagination');
    if (totalPages <= 1) {
      pagination.classList.add('hidden');
      return;
    }
    pagination.classList.remove('hidden');
    $('requestsPageInfo').textContent = 'Page ' + _requestsDisplayPage + ' of ' + totalPages;
    $('requestsPrevBtn').disabled = _requestsDisplayPage <= 1;
    $('requestsNextBtn').disabled = _requestsDisplayPage >= totalPages;
  }

  function requestsPrevPage() {
    if (_requestsDisplayPage > 1) {
      _requestsDisplayPage--;
      renderRequests();
    }
  }

  function requestsNextPage() {
    _requestsDisplayPage++;
    renderRequests();
  }

  // ---- Filter tabs ----

  function setFilter(filter) {
    _currentFilter = filter;
    _requestsDisplayPage = 1;
    root.querySelectorAll('.filter-tab').forEach(function (tab) {
      tab.setAttribute('aria-pressed', tab.getAttribute('data-filter') === filter ? 'true' : 'false');
    });
    renderRequests();
  }

  // ---- Media detail modal ----

  function openMediaModal(item) {
    if (!item) return;
    var modal = $('mediaModal');
    var mediaType = item.media_type || 'movie';
    var status = knownStatus(item.media_status);

    // Poster: reset the error fallback each time
    var poster = $('modalPoster');
    poster.style.display = '';
    if (poster.nextElementSibling) poster.nextElementSibling.style.display = 'none';
    poster.src = item.poster_url || '';
    poster.alt = item.title || '';

    // Text content
    $('modalTitle').textContent = item.title || 'Untitled';
    $('modalYear').textContent = item.year || '';
    $('modalOverview').textContent = item.overview || 'No description available.';

    // The type, as the cards say it: the accent's dot and the word.
    var typeBadge = $('modalTypeBadge');
    typeBadge.innerHTML = subLine(mediaType, '');

    // Rating
    var ratingEl = $('modalRating');
    ratingEl.textContent = (item.vote_average && item.vote_average > 0)
      ? 'Rated ' + item.vote_average.toFixed(1) + ' of 10'
      : '';

    // Action area: Request button (the page's click listener sends it,
    // data-action="request-from-modal") or status badge
    var actionArea = $('modalActionArea');
    if (!status) {
      actionArea.innerHTML =
        '<button type="button" id="modalRequestBtn" data-action="request-from-modal" ' +
          'data-media-type="' + escapeHtml(mediaType) + '" ' +
          'data-media-id="' + escapeHtml(String(item.id)) + '" ' +
          'data-request-title="' + escapeHtml(item.title || '') + '" ' +
          'class="ws-lift w-full h-11 rounded-btn bg-primary hover:bg-primary/90 text-bright text-body font-semibold transition-colors">' +
          'Request ' + escapeHtml(requestNoun(mediaType)) +
        '</button>';
    } else {
      actionArea.innerHTML =
        '<div class="w-full py-2 flex items-center justify-center">' +
          getStatusBadge(status) +
        '</div>';
    }

    if (_dialog) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    _dialog = WSUI.modal(modal, {
      onClose: function () {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        // Clear action area to prevent stale button state on next open
        $('modalActionArea').innerHTML = '';
        _dialog = null;
      }
    });
  }

  function closeMediaModal() {
    if (_dialog) _dialog.close();
  }

  function requestFromModal(buttonEl) {
    var mediaType = buttonEl.getAttribute('data-media-type');
    // Passed through as the string it is: book ids look like "gr:3634639", and
    // the server turns a film or show's "550" into a number, as for search cards.
    var mediaId = buttonEl.getAttribute('data-media-id');
    // Reuse existing requestMedia: passes buttonEl so its built-in
    // progress/success/error handling works inside the modal action area.
    requestMedia(mediaType, mediaId, false, buttonEl, buttonEl.getAttribute('data-request-title'));
  }

  // ---- Poster fallbacks ----
  //
  // A poster (img[data-fallback]) that fails is hidden and the placeholder
  // after it shown. Image errors and loads do not bubble, so one capturing
  // listener of each on the page covers every card, however often the grids
  // are rebuilt. A load with no pixels (a broken image that "loaded" as 0x0)
  // counts as a failure too.
  function showPosterFallback(img) {
    img.style.display = 'none';
    if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
  }
  function posterOf(e) {
    var t = e.target;
    return t && t.tagName === 'IMG' && t.hasAttribute('data-fallback') ? t : null;
  }

  // ---- Wiring: one listener per kind, on the page or with its signal ----

  // On a covers-only shelf (the trending books) a failed cover takes its card
  // out of the row instead; a shelf left empty says so in one line.
  function dropCover(img) {
    var card = img.closest('[data-action="open-media"]');
    var row = card && card.parentNode;
    if (!row || !coversOnly(row.id)) return false;
    holdHeight(row);
    row.removeChild(card);
    if (!row.querySelector('[data-action="open-media"]')) {
      row.innerHTML = '<p class="text-frosted-blue/70 text-body py-4">Nothing to show here right now.</p>';
    }
    updateDiscoverArrows(row);
    return true;
  }

  root.addEventListener('error', function (e) {
    var img = posterOf(e);
    if (img && !dropCover(img)) showPosterFallback(img);
  }, { capture: true, signal: signal });
  root.addEventListener('load', function (e) {
    var img = posterOf(e);
    if (img && img.naturalWidth === 0 && !dropCover(img)) showPosterFallback(img);
  }, { capture: true, signal: signal });

  root.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    switch (el.getAttribute('data-action')) {
      case 'discover-scroll': {
        var wrap = el.closest('.discover-row-wrapper');
        scrollDiscoverRow(wrap && wrap.querySelector('.discover-row'), Number(el.getAttribute('data-dir')) || 1);
        break;
      }
      case 'open-media':
        openMediaModal((_discoverItems[el.getAttribute('data-row')] || [])[Number(el.getAttribute('data-index'))]);
        break;
      case 'request-media':
        requestMedia(el.getAttribute('data-request-type'), el.getAttribute('data-request-id'), false, el,
          el.getAttribute('data-request-title'));
        break;
      case 'request-from-modal': requestFromModal(el); break;
      case 'close-modal': closeMediaModal(); break;
      case 'filter': setFilter(el.getAttribute('data-filter')); break;
      case 'search-prev': searchPrevPage(); break;
      case 'search-next': searchNextPage(); break;
      case 'requests-prev': requestsPrevPage(); break;
      case 'requests-next': requestsNextPage(); break;
    }
  }, { signal: signal });

  // Escape closes the media detail: WSUI.modal answers it (not while an
  // input method is composing).

  // Widening the window can make a row fit entirely, which retires both arrows.
  window.addEventListener('resize', function () {
    SHELVES.forEach(function (r) { updateDiscoverArrows(discoverRow(r.id)); });
  }, { signal: signal });

  // Search with a short wait after the last keystroke; the wait is the
  // visit's timer, re-armed per keystroke.
  var searchInput = $('searchInput');
  searchInput.addEventListener('input', function () {
    var query = searchInput.value.trim();
    ctx.clearTimeout(searchTimer);
    if (query.length === 0) {
      clearSearch();
      return;
    }
    searchTimer = ctx.setTimeout(function () {
      _currentSearchPage = 1;
      _searchDisplayPage = 1;
      performSearch(query);
    }, SEARCH_WAIT_MS);
  }, { signal: signal });

  // Before the first await, so the first frame of the page has them: the
  // shelf arrows set for rows that start at their left edge.
  buildDiscoverSection();

  var user = await checkAuth();
  if (!user || signal.aborted) return;

  // /requests?q=<text>, as the Books page links it when a search finds
  // nothing ("Can't find it? Request it"): the search for that text runs on
  // arrival, as if it had been typed there.
  var arrivedWith = (ctx.url.searchParams.get('q') || '').trim().slice(0, 200);
  if (arrivedWith) {
    searchInput.value = arrivedWith;
    performSearch(arrivedWith);
  }

  // The shelves are not waited for: they already hold their final height,
  // and their sources take seconds.
  loadDiscoverLists();

  // Refresh every 30 s (a poll on a page already on screen reads nothing at
  // once: the first read is below).
  ctx.poll(function () {
    loadRequestCounts();
    loadExistingRequests();
  }, REFRESH_MS);

  // The status grid is five integration calls behind a cache and must never
  // hold up the search UI; nothing here waits on it beyond the cap below.
  // The sections are on screen before mount resolves, so Back and Forward
  // restore the scroll onto them, but never later than 1.5 s.
  await Promise.race([
    Promise.all([RS.load(), loadRequestCounts(), loadLibrarySummary(), loadExistingRequests()]),
    new Promise(function (resolve) { ctx.setTimeout(resolve, 1500); })
  ]);

  // Leaving mid-resize: the column drag's body class goes with the page.
  return function () { document.body.classList.remove('rs-resizing'); };
}
