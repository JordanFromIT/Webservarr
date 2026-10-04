/**
 * WebServarr — Requests (page module)
 *
 * Ask for something new and see where earlier asks stand: the discover
 * shelves (Seerr's trending and popular lists, books from Chaptarr), the
 * library summary, the Request Status grid, search with Request buttons, the
 * recent requests with their filter tabs, and a detail modal for a discover
 * poster.
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

const CARDS_PER_PAGE = 9;
const REFRESH_MS = 30000;
const SEARCH_WAIT_MS = 300;

// Discover row sources, by the id of their row in requests.html.
//
// Most rows come from Seerr's discover endpoints and are named by their
// endpoint suffix. A row can instead carry an explicit `url` when its source is
// something else entirely - books come from Open Library by way of Chaptarr,
// not from Seerr.
const DISCOVER_ROWS = [
  { id: 'trendingRow',       endpoint: 'trending' },
  { id: 'popularMoviesRow',  endpoint: 'popular-movies' },
  { id: 'upcomingMoviesRow', endpoint: 'upcoming-movies' },
  { id: 'popularSeriesRow',  endpoint: 'popular-series' },
  { id: 'upcomingSeriesRow', endpoint: 'upcoming-series' },
  { id: 'trendingBooksRow',      endpoint: 'books-trending',      url: '/api/integrations/books-trending' },
  { id: 'trendingAudiobooksRow', endpoint: 'audiobooks-trending', url: '/api/integrations/audiobooks-trending' }
];

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
// Media types and request statuses (shared vocabulary, shell.js)

/**
 * Media type presentation. Three kinds share this page: films and TV from
 * Seerr, books from Chaptarr.
 *
 * The badge is a corner overlay to match the pattern already used here. Labels
 * are short enough that it stays legible over cover art.
 */
function mediaTypeLabel(mediaType) {
  return WS.mediaType(mediaType).label;   // shared with the home page (shell.js)
}

/**
 * Media type accent, as a theme class rather than a fixed palette value.
 *
 * The three hues are theme settings (theme.color_media_movie / _tv / _book),
 * so an admin retheming the site retints these too, and a media type keeps one
 * colour across the badge and the Request button alike. The classes live in
 * theme.css - see the note there.
 */
function mediaTypeAccent(mediaType) {
  return WS.mediaType(mediaType).accent;
}

function mediaTypeBadgeColor(mediaType) {
  return 'badge-' + mediaTypeAccent(mediaType);
}

/**
 * Colour for the media-type noun inside a Request button.
 *
 * The shipped defaults are measured against the button's #125793 fill - cyan
 * 5.16, amber 5.18, purple 5.49, all clearing 4.5:1. The button's 13px
 * semibold counts as normal text for contrast rather than large, which is why
 * the obvious purple-300 (4.23) was not good enough. An admin picking their own
 * accents owns that tradeoff.
 */
function mediaTypeNounColor(mediaType) {
  return 'text-' + mediaTypeAccent(mediaType);
}

/** Placeholder glyph when a title has no artwork. */
function mediaTypeIcon(mediaType) {
  return WS.mediaType(mediaType).icon;
}

// Labels and tones come from the shared vocabulary in shell.js
// (WS.requestStatus), so the home page's Recent Requests says the same words
// in the same colours for the same state: finished reads on a primary tint,
// things in motion in the text colour, not-yet-started on the accent, and a
// request that will not happen dimmed rather than alarming. Theme colours
// only; each tone keeps its 1px border so the block's box never changes.
const STATUS_TONE_CLASSES = {
  ready: {bg: 'bg-primary/30',      text: 'text-frosted-blue',    border: 'border-primary/40'},
  go:    {bg: 'bg-frosted-blue/15', text: 'text-frosted-blue',    border: 'border-frosted-blue/20'},
  wait:  {bg: 'bg-steel-blue/20',   text: 'text-frosted-blue/80', border: 'border-steel-blue/30'},
  dead:  {bg: 'bg-steel-blue/10',   text: 'text-frosted-blue/80', border: 'border-steel-blue/20'}
};

/**
 * Where a discover card's title stands, as a label beside its type badge.
 *
 * The words and tones are the site's shared request vocabulary
 * (WS.requestStatus, styled by STATUS_TONE_CLASSES above), so a card says what
 * Home's Recent Requests says for the same state. Words rather than a coloured
 * dot on the poster, which nobody could decode without a key. Nothing is shown
 * for a title no one has asked for, or for Seerr's "unknown": no label, never
 * the word "Unknown". It shares the card's second line with the type, so the
 * card is one height whether a title has a status or not.
 */
// Card-only short words, for labels that cannot fit beside the type on a
// 128px card: "Partly Available" beside "TV show" always ended "Partly Av…".
// The full shared label stays in the title, and everywhere else says it whole.
const DISCOVER_SHORT_LABELS = { partially_available: 'Partial' };

function discoverStatusLabel(status) {
  if (!status || status === 'unknown') return '';
  var known = WS.requestStatus(status);
  var shown = DISCOVER_SHORT_LABELS[status] || known.label;
  return '<span data-discover-status title="' + escapeHtml(known.label) + '" ' +
    'class="min-w-0 truncate text-frosted-blue/70">' +
    escapeHtml(shown) + '</span>';
}

// A poster image, or its placeholder glyph when there is none. The image
// carries data-fallback: the page's capturing error listener hides one that
// fails and shows the placeholder beside it.
function posterMarkup(posterUrl, alt, imgClass, iconClass, mediaType) {
  var glyph = '<span class="material-symbols-outlined ' + iconClass + ' text-steel-blue/40">' + mediaTypeIcon(mediaType) + '</span>';
  if (!posterUrl) {
    return '<div class="absolute inset-0 flex items-center justify-center poster-placeholder">' + glyph + '</div>';
  }
  return '<img src="' + escapeHtml(posterUrl) + '" alt="' + alt + '" class="' + imgClass + '" data-fallback/>' +
    '<div class="absolute inset-0 items-center justify-center poster-placeholder" style="display:none">' + glyph + '</div>';
}

// The discover poster. rowId and index name the item in the visit's shelf
// data; the page's click listener opens it (data-action="open-media").
function buildDiscoverCard(item, rowId, index) {
  var title = escapeHtml(item.title || 'Unknown');
  var mediaType = item.media_type || 'movie';
  var typeBadge = mediaTypeLabel(mediaType);
  var posterUrl = item.poster_url || '';
  var status = item.media_status ? item.media_status.toLowerCase() : null;
  var statusHtml = discoverStatusLabel(status);

  // The title names the button, so the poster's alt stays empty.
  var posterHtml = posterMarkup(posterUrl, '', 'absolute inset-0 w-full h-full object-cover', 'text-3xl', mediaType);

  // A button, as the Books covers are links: the poster, then two lines (the
  // title, then the type and any status), the same box as the skeleton in
  // requests.html. ws-lift on the card: the card is what is clicked.
  return (
    '<button type="button" class="shrink-0 w-32 text-left rounded-inner ws-lift group" ' +
        'data-action="open-media" data-row="' + escapeHtml(rowId) + '" data-index="' + index + '">' +
      '<span class="block aspect-[2/3] relative overflow-hidden rounded-inner bg-frosted-blue/[0.04]">' +
        posterHtml +
      '</span>' +
      '<span class="block pt-2">' +
        '<span class="block text-label leading-5 font-semibold text-frosted-blue truncate">' + title + '</span>' +
        // One line that never wraps: the type keeps its width and the status
        // gives way, ending in an ellipsis on the longest label.
        '<span class="flex items-center gap-1.5 min-w-0 text-label leading-5">' +
          '<span class="shrink-0 font-semibold ' + mediaTypeNounColor(mediaType) + '">' + typeBadge + '</span>' +
          statusHtml +
        '</span>' +
      '</span>' +
    '</button>'
  );
}

/**
 * One definition of what each status looks like and is called.
 *
 * Colour carries the meaning at a glance: green means you can watch or read it
 * now, amber means it is coming, red means it is not.
 *
 * Wording is written from the requester's side. "Pending" describes the
 * request queue rather than what the person did, so it reads "Requested".
 * "Processing" is internal vocabulary, so it reads "Downloading".
 */
function getStatusPresentation(status, mediaType, item) {
  var known = WS.requestStatus(status);
  var tone = STATUS_TONE_CLASSES[known.tone] || STATUS_TONE_CLASSES.wait;
  var p = {bg: tone.bg, text: tone.text, border: tone.border, label: known.label};
  switch (status) {
    case 'available':
    case 'completed':
    case 'approved':
    case 'pending':
    case 'declined':
      return p;

    case 'processing':
    case 'downloading':
      // Not "Downloading". Seerr's processing state only means the
      // request was handed to Sonarr or Radarr - it may be searching
      // indexers, waiting on an upgrade, or stalled with no release
      // found at all. Claiming a download is in progress sets an
      // expectation nothing here can actually verify.
      return p;

    case 'partially_available':
      // A count beats any adjective: "48 of 62 Episodes" tells someone
      // exactly what they are getting, where "Partial" tells them
      // nothing. Falls back to words when the count is unavailable.
      if (item && item.episodes_total) {
        p.label = item.episodes_available + ' of ' + item.episodes_total + ' Episodes';
        p.selfDescribing = true;
      }
      return p;

    default:
      p = {bg: STATUS_TONE_CLASSES.wait.bg, text: STATUS_TONE_CLASSES.wait.text, border: STATUS_TONE_CLASSES.wait.border};
      p.label = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
      return p;
  }
}

/**
 * Full-width status block, sized to match the Request button.
 *
 * A card should not change shape depending on whether an item is requestable -
 * the action slot stays the same rectangle and only its colour and words
 * change.
 */
function getStatusBlock(status, mediaType, typeLabel, item) {
  var s = getStatusPresentation(status, mediaType, item);
  // An episode count already says "TV Show" by implication, and "TV Show ·
  // 48 of 62 Episodes" overflows the block at this width.
  if (s.selfDescribing) typeLabel = '';
  var prefix = typeLabel ? typeLabel + ' ' : '';
  return '<div class="w-full py-2 px-1 rounded-btn border text-center text-label font-semibold ' +
    s.bg + ' ' + s.text + ' ' + s.border + '">' + prefix + s.label + '</div>';
}

/** Compact pill, for request cards and the detail modal: the one chip. */
function getStatusBadge(status, mediaType) {
  var s = getStatusPresentation(status, mediaType);
  return '<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-label font-semibold ' + s.bg + ' ' + s.text + '">' +
    s.label + '</span>';
}

function buildSearchCard(item) {
  var title = escapeHtml(item.title || 'Unknown');
  var year = item.year ? escapeHtml(String(item.year)) : '';
  var mediaType = item.media_type || 'movie';
  var typeBadge = mediaTypeLabel(mediaType);
  var posterUrl = item.poster_url || '';
  var status = item.media_status ? item.media_status.toLowerCase() : null;
  var status4k = item.media_status_4k ? item.media_status_4k.toLowerCase() : null;
  var mediaId = item.id;

  // The card is not a link, so its poster does not zoom on hover.
  var posterHtml = posterMarkup(posterUrl, title, 'absolute inset-0 w-full h-full object-cover', 'text-4xl', mediaType);

  // Request button or status badge (combined standard + 4K: show best available status)
  var combinedStatus = status;
  // If standard has a status, use it; also consider 4K status for "available"/"partially_available"
  if (!combinedStatus && status4k) {
    combinedStatus = status4k;
  } else if (combinedStatus && status4k) {
    // If either is available, show available
    var availStatuses = ['available', 'completed'];
    if (availStatuses.indexOf(status4k) !== -1 && availStatuses.indexOf(combinedStatus) === -1) {
      combinedStatus = status4k;
    }
  }

  var stdHtml;
  if (!combinedStatus) {
    // The media type lives on the button rather than a separate pill, so
    // what is being requested is stated at the moment of committing to it.
    //
    // Type and id ride in data-* attributes, read by the page's click
    // listener (data-action="request-media"), so a provider id like
    // "gr:3634639" never meets JavaScript source: HTML-escaping would not
    // stop a JS-context breakout. Chaptarr book ids are strings; Seerr's
    // numeric ids coerce back to int server-side.
    // border-transparent so the button matches the status block's height
    // exactly - otherwise the card jumps 2px depending on its state.
    // ws-lift on the button, not the card: the button is what is clicked.
    stdHtml = '<button type="button" data-action="request-media" data-request-type="' + escapeHtml(mediaType) + '" data-request-id="' + escapeHtml(String(mediaId)) + '" data-request-title="' + title + '" class="ws-lift w-full py-2 px-1 rounded-btn border border-transparent bg-primary hover:bg-primary/90 text-bright text-label font-semibold transition-colors">Request <span class="' + mediaTypeNounColor(mediaType) + '">' + typeBadge + '</span></button>';
  } else {
    // Same rectangle as the button, so the card keeps its shape. The type
    // is carried here too, since there is no button to state it.
    stdHtml = getStatusBlock(combinedStatus, mediaType, typeBadge, item);
  }

  // No type pill on the card: the media type is carried by the action itself
  // ("Request eBook"), which states it where the decision is made and keeps
  // the card free of a floating label.
  return '<div class="rounded-card bg-frosted-blue/[0.04] overflow-hidden flex flex-col">' +
    '<div class="aspect-[2/3] relative overflow-hidden">' +
      posterHtml +
    '</div>' +
    '<div class="p-3 flex flex-col gap-2 flex-1">' +
      '<div class="flex-1">' +
        '<p class="text-frosted-blue text-body font-semibold leading-tight line-clamp-2">' + title + '</p>' +
        // Books have no cover art (Chaptarr's are behind its UI login),
        // so the author does the work the artwork would have done.
        (item.author ? '<p class="text-frosted-blue/70 text-label mt-0.5 truncate">' + escapeHtml(item.author) + '</p>' : '') +
        (year ? '<p class="text-frosted-blue/70 text-label mt-0.5 tabular-nums">' + year + '</p>' : '') +
      '</div>' +
      '<div class="space-y-1.5">' + stdHtml + '</div>' +
    '</div>' +
  '</div>';
}

function buildRequestCard(req) {
  var title = escapeHtml(req.media_title || 'Unknown');
  var mediaType = req.media_type || 'movie';
  var typeBadge = mediaTypeLabel(mediaType);
  var typeBadgeColor = mediaTypeBadgeColor(mediaType);
  var posterUrl = req.poster_url || '';
  var status = (req.status || 'pending').toLowerCase();
  var requestedDate = req.requested_date ? getTimeAgo(req.requested_date, true) : '';

  // The card is not a link, so its poster does not zoom on hover.
  var posterHtml = posterMarkup(posterUrl, title, 'absolute inset-0 w-full h-full object-cover', 'text-4xl', mediaType);

  return '<div class="rounded-card bg-frosted-blue/[0.04] overflow-hidden" data-status="' + status + '">' +
    '<div class="aspect-[2/3] relative overflow-hidden">' +
      posterHtml +
    '</div>' +
    // Status sits below the artwork rather than over it. As an overlay it
    // read as a watermark stamped across the cover, and it obscured the
    // part of the poster people recognise a title by.
    '<div class="p-3 space-y-1">' +
      '<div class="flex items-center gap-1.5 flex-wrap">' +
        '<span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-label font-semibold ' + typeBadgeColor + '">' + typeBadge + '</span>' +
        getStatusBadge(status, mediaType) +
      '</div>' +
      '<p class="text-frosted-blue text-body font-semibold leading-tight line-clamp-2">' + title + '</p>' +
      (requestedDate ? '<p class="text-label text-frosted-blue/70">' + escapeHtml(requestedDate) + '</p>' : '') +
    '</div>' +
  '</div>';
}

// ---- Library summary formats ----

/** Thousands separators, so 39710 reads as a quantity rather than a serial. */
function formatCount(n) {
  return (n || 0).toLocaleString();
}

/**
 * A wait in the largest unit that still reads naturally.
 *
 * Minutes up to an hour, then hours, then days - "11 min" and "3 days" are
 * both immediately meaningful where "0.18 h" and "4,320 min" are not.
 */
function formatWait(minutes) {
  if (minutes === undefined || minutes === null) return '--';
  if (minutes < 60) return Math.round(minutes) + ' min';
  if (minutes < 60 * 48) return Math.round(minutes / 60) + ' hr';
  return Math.round(minutes / 1440) + ' days';
}

/** Binary units, matching what Sonarr, Radarr and the NAS all report. */
function formatBytes(bytes) {
  if (!bytes) return '0 GB';
  var tb = bytes / Math.pow(1024, 4);
  if (tb >= 1) return tb.toFixed(1) + ' TB';
  return Math.round(bytes / Math.pow(1024, 3)) + ' GB';
}

// The site's one toast (ui.js): theme colours, a status light for the tone.
function showToast(message, type) {
  WSUI.toast(message, type === 'success' ? 'ok' : 'err');
}

// ---- Search bar motion: timings and placement ----
//
// The bar lives above the trending rows on arrival, where it is the first thing
// seen, and slides down into the results panel once a search begins. It is one
// element that moves, not two that swap, so focus and the caret survive.

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * True on phones and tablets - anything driven by a finger rather than a
 * pointer.
 *
 * Touch still gets the glide - jumping straight to the end state read as a
 * broken page on a real device (confirmed on a Galaxy S26+), not a
 * considered one. What touch loses is the duration: SEARCH_MOVE_DURATION_TOUCH
 * keeps the scroll lock brief instead of holding it for the full pointer-length
 * animation, which is what made the instant jump seem worth it in the first
 * place.
 */
function coarsePointer() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

// Where the search field comes to rest, measured from the top of whatever is
// scrolling. Both numbers were taken from the positions Jordan scrolled to by
// hand rather than guessed at.
//
// Desktop scrolls the inner panel, which has nothing overlapping it, so the
// field sits just below its top edge.
const SLOT_SCROLL_GAP = 34;

// Mobile scrolls the document, and the nav bar is sticky across the top, so a
// field placed at the same 34px would sit underneath it. The bar is measured
// rather than hardcoded so this stays correct if its height changes.
const SLOT_SCROLL_CLEARANCE_MOBILE = 61;

function slotScrollGap() {
  if (window.innerWidth >= 1024) return SLOT_SCROLL_GAP;
  var bar = document.getElementById('mobileTopBar');   // the shell's phone bar
  var barHeight = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
  return barHeight + SLOT_SCROLL_CLEARANCE_MOBILE;
}

// How long the bar takes to travel. This is scenery rather than a response to
// an action, and it runs while the user is still typing, so it should never
// look like it is hurrying them - but it also holds the scroll for its whole
// duration, so it cannot linger either.
const SEARCH_MOVE_DURATION = 3000;

// Touch runs shorter than pointer, but 700ms turned out to be too short to read
// as movement at all -- on a phone it looked like the bar snapped rather than
// travelled. The constraint it was protecting is real: a scroll lock lingering
// for multiple seconds on a real device (confirmed on a Galaxy S26+) reads as a
// hung page. 1800ms sits between the two, long enough to be visibly a glide and
// short enough that the hold is never mistaken for the page having stopped
// responding.
const SEARCH_MOVE_DURATION_TOUCH = 1800;

/**
 * Work out how far to scroll to bring a slot into view, without doing it.
 *
 * Returned as a plan rather than applied, because the scroll has to be driven
 * frame by frame alongside the bar rather than performed up front.
 *
 * scrollIntoView cannot be used here: it scrolls *every* scrollable ancestor,
 * so the inner panel and the window both move and the two compound into an
 * overshoot that pushes the bar up under the header and clips it. This walks up
 * to the one element that actually scrolls, clamped to its real range, so the
 * slot lands exactly slotScrollGap() below the top.
 */
function scrollPlanFor(slot) {
  var node = slot.parentElement;
  var container = null;
  while (node && node !== document.body) {
    var overflowY = window.getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      container = node;
      break;
    }
    node = node.parentElement;
  }

  if (container) {
    var delta = slot.getBoundingClientRect().top
              - container.getBoundingClientRect().top
              - slotScrollGap();
    var max = Math.max(0, container.scrollHeight - container.clientHeight);
    return {
      el: container,
      from: container.scrollTop,
      to: Math.max(0, Math.min(container.scrollTop + delta, max)),
    };
  }

  // Narrow layouts scroll the document instead - the panel is only
  // overflow-y-auto at the lg breakpoint.
  var top = window.scrollY + slot.getBoundingClientRect().top - slotScrollGap();
  var docMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return {el: null, from: window.scrollY, to: Math.max(0, Math.min(top, docMax))};
}

function applyScroll(plan, value) {
  if (plan.el) plan.el.scrollTop = value;
  else window.scrollTo(0, value);
}

/**
 * What the page scrolls to bring into view when the search bar moves.
 *
 * The panel that CONTAINS the bar, not a nearby landmark. This used to anchor
 * on the stats row, which worked only because the search columns sat directly
 * beneath it -- scrolling the stats to the top happened to leave the bar just
 * below. That coupling was invisible until the request-status grid was inserted
 * between them, at which point the same scroll put the stats at the top and the
 * bar roughly 400px below the fold.
 *
 * Anchoring on the search columns themselves states the actual intent: land the
 * panel the bar is flying into at the top of the view. Nothing added above it
 * can break that again.
 */
function searchScrollAnchor(slot) {
  return slot;
}

function scrollSlotIntoPlace(slot) {
  var plan = scrollPlanFor(searchScrollAnchor(slot));
  applyScroll(plan, plan.to);
}

/** Gentle at both ends, so nothing in the move starts or stops abruptly. */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
  var _searchBarPosition = 'home';
  var _searchMoveRaf = null;
  var _scrollLockFailsafe = 0;
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

  // ---- Discover lists ----

  function discoverRow(id) { return $(id); }

  // The rows and their skeletons are already in the page (markup in
  // requests.html, in the first paint); this wires them for the visit.
  function buildDiscoverSection() {
    DISCOVER_ROWS.forEach(function (row) {
      var el = discoverRow(row.id);
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

  function loadDiscoverLists() {
    return Promise.all(DISCOVER_ROWS.map(function (row) {
      return fetch(row.url || ('/api/integrations/seerr-discover/' + row.endpoint), { signal: signal })
        .then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })
        .then(function (items) {
          if (signal.aborted) return;
          renderDiscoverRow(row.id, items);
        })
        .catch(function (err) {
          if (signal.aborted || isAbort(err)) return;   // left the page: not an error
          console.warn('Discover list ' + row.endpoint + ' failed:', err);
          renderDiscoverRowError(row.id);
        });
    }));
  }

  // The book shelves show covers only: a trending book with no cover is left
  // out, and one whose cover fails to load leaves the row (dropCover below).
  // A shelf of blank tiles read as an unfinished page.
  function coversOnly(rowId) { return rowId === 'trendingBooksRow' || rowId === 'trendingAudiobooksRow'; }

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
    var section = $('searchResultsSection');
    var emptyState = $('searchEmptyState');
    var grid = $('searchResultsGrid');

    // Show section, hide empty state
    section.classList.remove('hidden');
    emptyState.classList.add('hidden');

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
        // They are interleaved rather than appended: with 9 cards per
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

  function clearSearch() {
    if (searchCtl) searchCtl.abort();
    _currentSearchQuery = '';
    _currentSearchPage = 1;
    _searchResults = [];
    _searchDisplayPage = 1;
    $('searchResultsSection').classList.add('hidden');
    $('searchEmptyState').classList.remove('hidden');
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
      buttonEl.outerHTML = getStatusBlock('pending', mediaType, mediaTypeLabel(mediaType));

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

  // ---- Search bar motion ----

  function searchSlot(position) {
    return $(position === 'dock' ? 'searchDock' : 'searchHomeSlot');
  }

  // ---- Scroll lock ----
  //
  // While the bar is travelling it owns the scroll position, so wheel and touch
  // input are swallowed for the duration. A stuck lock would leave the page
  // unscrollable with nothing to show why, so unlocking is made unconditional:
  // the animation unlocks when it finishes, a failsafe timer unlocks anyway
  // if it somehow never does, and leaving the page ends both listeners and
  // the timer with the visit.

  function swallowScroll(e) {
    e.preventDefault();
  }

  function lockScroll() {
    if (_scrollLockFailsafe) ctx.clearTimeout(_scrollLockFailsafe);
    // passive:false is required - a passive listener may not preventDefault,
    // and wheel/touchmove default to passive on window in most browsers.
    window.addEventListener('wheel', swallowScroll, { passive: false, signal: signal });
    window.addEventListener('touchmove', swallowScroll, { passive: false, signal: signal });
    _scrollLockFailsafe = ctx.setTimeout(unlockScroll, SEARCH_MOVE_DURATION + 2000);
  }

  function unlockScroll() {
    window.removeEventListener('wheel', swallowScroll, { passive: false });
    window.removeEventListener('touchmove', swallowScroll, { passive: false });
    if (_scrollLockFailsafe) {
      ctx.clearTimeout(_scrollLockFailsafe);
      _scrollLockFailsafe = 0;
    }
  }

  function wireSearchBarMotion() {
    var bar = $('searchBar');
    var slot = searchSlot('home');
    var dock = searchSlot('dock');
    if (!bar || !slot || bar.parentElement === slot) return;

    // Hold the dock open at the height the bar occupies, before lifting the bar
    // out of it.
    //
    // The bar spends the whole visit somewhere else - floated at the trending
    // heading, then in flight - and an empty dock collapses to nothing, so
    // everything below it sits a bar's height too high until the moment the bar
    // lands, at which point the copy underneath drops. Measuring the dock while
    // the bar is still inside it reserves exactly the right space, so the
    // returning bar displaces nothing.
    //
    // The measurement is taken here rather than hardcoded so it stays correct
    // if the field's padding or type size ever changes. mount runs with the
    // page in the document and its styles applied, so the box is real.
    if (dock && bar.parentElement === dock) {
      var occupied = dock.getBoundingClientRect().height
                  || bar.getBoundingClientRect().height;
      if (occupied > 0) dock.style.minHeight = occupied + 'px';
    }

    slot.appendChild(bar);
  }

  /**
   * Move the search bar between the trending heading and the results panel.
   *
   * The two slots are roughly 1700px apart, so no animation can show that whole
   * journey - the bar would spend it off screen. Instead the bar is lifted out of
   * the flow and pinned to its current screen position while the page scrolls
   * beneath it, then glides the short remaining distance into its slot. What the
   * user sees is the bar travelling to its new home, rather than the page moving
   * under a stationary bar.
   */
  function moveSearchBar(position) {
    if (position === _searchBarPosition) return;
    _searchBarPosition = position;

    var bar = $('searchBar');
    var target = searchSlot(position);
    if (!bar || !target) return;

    if (_searchMoveRaf !== null) {
      cancelAnimationFrame(_searchMoveRaf);
      _searchMoveRaf = null;
      // A cancelled move never reaches its own unlock, so release here too.
      unlockScroll();
    }

    var input = $('searchInput');

    function settle() {
      // The caret is read here, immediately before the move - NOT when the
      // move was scheduled. The animation runs for seconds and the user keeps
      // typing throughout; restoring a caret captured back then drops it into
      // the middle of what they have since written, so "Test" comes out
      // "Tste".
      var hadFocus = document.activeElement === input;
      var selStart = hadFocus ? input.selectionStart : null;
      var selEnd = hadFocus ? input.selectionEnd : null;

      target.appendChild(bar);
      bar.style.cssText = '';

      // Reparenting blurs a focused descendant, so focus and caret go back.
      if (hadFocus) {
        input.focus({preventScroll: true});
        try { input.setSelectionRange(selStart, selEnd); } catch (e) { /* not selectable */ }
      }
    }

    if (reducedMotion()) {
      settle();
      scrollSlotIntoPlace(target);
      return;
    }

    // 1. Pin the bar where it currently appears, so the scroll cannot drag it.
    var start = bar.getBoundingClientRect();
    bar.style.position = 'fixed';
    bar.style.top = start.top + 'px';
    bar.style.left = start.left + 'px';
    bar.style.width = start.width + 'px';
    bar.style.maxWidth = 'none';
    bar.style.margin = '0';
    bar.style.zIndex = '50';
    bar.style.transition = 'none';

    // 2. Work out how far to scroll. The bar's destination is deliberately NOT
    //    precomputed - see the frame loop.
    var anchor = searchScrollAnchor(target);
    var plan = scrollPlanFor(anchor);
    var scrollFrom = plan.from;

    // 3. Drive the scroll and the bar from one clock, with one easing curve.
    //
    // Previously the page jumped in a single frame and only then did the bar
    // glide, which read as two separate events - a lurch, then a slide. Moving
    // both together at the same rate means the page slides beneath a bar that
    // is itself travelling, and the whole thing reads as one movement. A CSS
    // transition cannot do this: the bar is position:fixed, so its viewport
    // coordinates have to be recomputed against the scroll on every frame.
    var DURATION = coarsePointer() ? SEARCH_MOVE_DURATION_TOUCH : SEARCH_MOVE_DURATION;
    var started = null;

    // The move owns the scroll position for its whole duration, so wheel and
    // touch scrolling are held off rather than allowed to fight it. Keyboard is
    // deliberately left alone: the user is typing in the search field, where
    // arrows move the caret and space is a character.
    lockScroll();

    function frame(now) {
      // Left mid-move: the bar went with the page, and the scroller this
      // would drive is the next page's.
      if (signal.aborted) { _searchMoveRaf = null; return; }
      if (started === null) started = now;
      var progress = Math.min(1, (now - started) / DURATION);
      var eased = easeInOutCubic(progress);

      // The scroll DESTINATION is re-read every frame for the same reason the
      // bar's is, one block down: the page reflows underneath the animation.
      // It used to be computed once and eased toward, which was correct only
      // as long as nothing above the dock changed height mid-flight. The
      // request-status grid does exactly that -- it loads asynchronously and
      // then caps itself to five rows -- so a target measured before it
      // settled left the page scrolled short of where the bar landed.
      //
      // Only the destination is live; the starting point stays fixed, or the
      // easing would be measured from a position that is itself moving.
      var live = scrollPlanFor(anchor);
      applyScroll(live, progress < 1 ? scrollFrom + (live.to - scrollFrom) * eased : live.to);

      // The destination is re-read every frame, after the scroll for that
      // frame has been applied, rather than computed once up front.
      //
      // A precomputed coordinate goes stale: the page reflows underneath the
      // animation as results render and discover rows resolve, so by the time
      // the bar arrives, the slot is no longer where it was predicted to be -
      // and the bar visibly snaps into place when it is finally reparented.
      // Tracking the live slot means the last frame and the reparented
      // position are the same position, so there is nothing left to snap.
      //
      // The slot is empty while the bar is in flight, so its box is exactly
      // where the bar will sit once dropped back in.
      var dest = target.getBoundingClientRect();
      bar.style.top = (start.top + (dest.top - start.top) * eased) + 'px';
      bar.style.left = (start.left + (dest.left - start.left) * eased) + 'px';
      bar.style.width = (start.width + (dest.width - start.width) * eased) + 'px';

      if (progress < 1) {
        _searchMoveRaf = requestAnimationFrame(frame);
        return;
      }

      _searchMoveRaf = null;
      unlockScroll();
      settle();
    }

    _searchMoveRaf = requestAnimationFrame(frame);
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

  async function loadLibrarySummary() {
    try {
      var resp = await fetch('/api/integrations/library-summary', { signal: signal });
      if (!resp.ok) throw new Error('API error');
      var s = await resp.json();
      if (signal.aborted) return;

      $('statMovies').textContent = formatCount(s.movies);
      $('statShows').textContent = formatCount(s.shows);
      $('statEpisodes').textContent = formatCount(s.episodes);
      $('statEbooks').textContent = formatCount(s.ebooks);
      $('statAudiobooks').textContent = formatCount(s.audiobooks);
      $('statSize').textContent = formatBytes(s.bytes);
      $('statAdded').textContent = formatCount(s.added_recently);
      $('statInProgress').textContent = formatCount(s.in_progress);
      $('statUnreleased').textContent = formatCount(s.unreleased);

      var waits = s.wait_minutes || {};
      $('statWait').textContent = formatWait(waits.total);

      $('statFulfilled').textContent = (s.fulfilled_percent || 0) + '%';
      $('statComplete').textContent = (s.percent || 0) + '%';

      var seasonPct = s.seasons
        ? Math.round(100 * (s.complete_seasons || 0) / s.seasons)
        : 0;
      $('statSeasons').textContent = seasonPct + '%';

      var q = s.quality || {};
      var qm = q.movies || {};
      var qe = q.episodes || {};
      $('statHdPct').textContent = (q.hd_or_better_pct || 0) + '%';
      $('stat4kMovies').textContent = formatCount(qm['4k']);
      $('stat4kEpisodes').textContent = formatCount(qe['4k']);
    } catch (e) {
      if (signal.aborted || isAbort(e)) return;
      // Labels with no figures beside them say nothing: one line instead,
      // over the panel's own box (kept, unseen), so nothing below it moves.
      var row = $('statsRow');
      if (row.querySelector('[data-stats-note]')) return;
      row.classList.add('relative');
      if (row.firstElementChild) row.firstElementChild.classList.add('invisible');
      var note = document.createElement('p');
      note.className = 'absolute inset-0 text-body text-frosted-blue/70';
      note.setAttribute('data-stats-note', '');
      note.textContent = 'Library figures aren\u2019t available right now.';
      row.appendChild(note);
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
    var status = item.media_status ? item.media_status.toLowerCase() : null;

    // Poster: reset the error fallback each time
    var poster = $('modalPoster');
    poster.style.display = '';
    if (poster.nextElementSibling) poster.nextElementSibling.style.display = 'none';
    poster.src = item.poster_url || '';
    poster.alt = item.title || '';

    // Text content
    $('modalTitle').textContent = item.title || 'Unknown';
    $('modalYear').textContent = item.year || '';
    $('modalOverview').textContent = item.overview || 'No description available.';

    // Type badge. Driven by the same theme accents as the cards, so a type reads
    // identically here and in the grid - and so books are not labelled "Movie".
    var typeBadge = $('modalTypeBadge');
    typeBadge.textContent = mediaTypeLabel(mediaType);
    typeBadge.className = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-label font-semibold ' + mediaTypeBadgeColor(mediaType);

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
          'class="ws-lift w-full py-2.5 rounded-btn bg-primary hover:bg-primary/90 text-bright text-body font-semibold transition-colors">' +
          'Request <span class="' + mediaTypeNounColor(mediaType) + '">' + mediaTypeLabel(mediaType) + '</span>' +
        '</button>';
    } else {
      actionArea.innerHTML =
        '<div class="w-full py-2 flex items-center justify-center">' +
          getStatusBadge(status, mediaType) +
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
    DISCOVER_ROWS.forEach(function (r) { updateDiscoverArrows(discoverRow(r.id)); });
  }, { signal: signal });

  // Search with a short wait after the last keystroke; the wait is the
  // visit's timer, re-armed per keystroke.
  var searchInput = $('searchInput');
  searchInput.addEventListener('input', function () {
    var query = searchInput.value.trim();
    ctx.clearTimeout(searchTimer);
    // One-way: once the bar has settled into the results panel it stays
    // there. Sending it back up on an empty field means the bar flies away
    // the moment someone clears the box to retype, taking the field out
    // from under them mid-correction.
    if (query.length) moveSearchBar('dock');
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
  // search bar floated up to the trending heading and the discover arrows
  // set for rows that start at their left edge.
  wireSearchBarMotion();
  buildDiscoverSection();

  var user = await checkAuth();
  if (!user || signal.aborted) return;

  // /requests?q=<text>, as the Books page links it when a search finds
  // nothing ("Can't find it? Request it"): the search for that text runs on
  // arrival, as if it had been typed there.
  var arrivedWith = (ctx.url.searchParams.get('q') || '').trim().slice(0, 200);
  if (arrivedWith) {
    searchInput.value = arrivedWith;
    moveSearchBar('dock');
    performSearch(arrivedWith);
  }

  // The discover rows are not waited for: they already hold their final
  // height, and their sources take seconds.
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
