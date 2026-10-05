/**
 * WebServarr — Home (page module)
 *
 * The dashboard: service health (with the server's gauges, which sit in the
 * header from xl), recent requests beside news, active streams and upcoming
 * releases. Sections the admin switched
 * off (Settings > Pages > Home) are hidden by the server (html[data-home-hide],
 * which the router brings in step on every swap) and never loaded.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. The one read that does not is the service list: it is
 * WS.serviceStatus(), a single request shared with the header's status pill,
 * so this page never aborts it; its answer is dropped once the page is left.
 * One delegated click listener on ctx.root serves the stream pager, a
 * stream's "More info" and the news cards' Read more (data-action,
 * data-news-toggle), however often the sections are rebuilt.
 *
 * Continue, the first section, is the Books page's own row in its compact
 * form (renderContinueRow from books.js, loaded from the address #wsPage
 * names in data-ws-dep, which the server stamps). Whether this person has one
 * is remembered per person, so a person who had a row last time gets its room
 * from the first paint (theme-loader.js on a full load, mount on a soft one)
 * and nothing below it moves; with nothing in progress the section stays
 * hidden, and it is not loaded at all while the Books page is off.
 */

const SECTIONS = ['services', 'news', 'streams', 'releases', 'requests'];
const STREAMS_PER_PAGE = 6;
// Whether this person had a Continue row last time is the Books page's own
// memory (pages/books.js); the second says the row had a note under it.
const CONTINUE_KEY = 'webservarr_books_continue:';
const CONTINUE_NOTE_KEY = 'webservarr_home_continue_note:';

function isAbort(e) { return !!e && e.name === 'AbortError'; }

// ---- News ----
//
// The homepage carries only current news. Two rules keep it that way, both
// admin-configurable from Settings > Pages:
//   * homepage_count caps how many posts can ever stack up down the page
//   * homepage_max_age_days retires stale posts from the homepage entirely
// Nothing is deleted -- /news lists the full archive. Pinned posts ignore both
// rules, because a pin is the admin saying "this stays up".
const NEWS_FRESH_MS = 72 * 60 * 60 * 1000; // under 3 days reads as "new"

function newsSettings(branding) {
    var cfg = (branding || {}).news || {};
    return {
        count: cfg.homepage_count || 3,
        maxAgeDays: cfg.homepage_max_age_days === 0 ? 0 : (cfg.homepage_max_age_days || 30)
    };
}

// Plain-text excerpt for a collapsed card. Built from the sanitized HTML the
// API already returned, so no new trust boundary is crossed here.
function newsExcerpt(html, limit) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    var text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text;
}

function newsDateLabel(date) {
    var secondsAgo = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secondsAgo < 60) return 'Just now';
    if (secondsAgo < 3600) return Math.floor(secondsAgo / 60) + 'm ago';
    if (secondsAgo < 86400) return Math.floor(secondsAgo / 3600) + 'h ago';
    if (secondsAgo < 604800) return Math.floor(secondsAgo / 86400) + 'd ago';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// The same card shape as the /news archive (pages/news.js) so a post looks the
// same in both. `expanded` decides whether the body is open on arrival; a
// collapsed card keeps its full content in the DOM behind a toggle rather than
// re-fetching.
function renderNewsCard(post, expanded) {
    var created = new Date(post.created_at);
    var isFresh = (Date.now() - created.getTime()) < NEWS_FRESH_MS;
    var accent = post.pinned ? 'border-l-primary' : (isFresh ? 'border-l-frosted-blue' : 'border-l-steel-blue/40');
    var icon = post.pinned ? 'push_pin' : (isFresh ? 'campaign' : 'article');
    var iconColor = post.pinned ? 'text-frosted-blue' : (isFresh ? 'text-frosted-blue' : 'text-steel-blue');

    var flag = '';
    if (post.pinned) {
        flag = '<span class="shrink-0 mt-0.5 text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-primary/20 text-frosted-blue">Pinned</span>';
    } else if (isFresh) {
        flag = '<span class="shrink-0 mt-0.5 text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded bg-frosted-blue/15 text-frosted-blue">New</span>';
    }

    var open = expanded || post.pinned || isFresh;
    var excerpt = newsExcerpt(post.content_html, 140);
    var bodyClasses = 'text-sm text-frosted-blue/80 mt-2 prose prose-invert max-w-none [&>div]:mb-2 [&>p]:mb-2 [&_br]:block';

    var body = open
        ? '<div class="' + bodyClasses + '" style="white-space:pre-line">' + post.content_html + '</div>'
        : '<p class="text-sm text-frosted-blue/70 mt-1 line-clamp-2 min-h-10">' + escapeHtml(excerpt) + '</p>' +
          '<div class="' + bodyClasses + ' hidden" data-news-body style="white-space:pre-line">' + post.content_html + '</div>';

    var toggle = open
        ? ''
        : '<button type="button" data-news-toggle class="mt-2 flex items-center gap-1 text-[11px] font-bold text-steel-blue hover:text-frosted-blue transition-colors">' +
            '<span data-news-toggle-text>Read more</span>' +
            '<span class="material-symbols-outlined text-sm transition-transform" data-news-chevron>expand_more</span>' +
          '</button>';

    // min-w-0 is load-bearing: the card is a grid item, and grid items default
    // to min-width:auto, so without it the card refuses to shrink below its
    // min-content width and pushes the whole page into horizontal scroll on a
    // phone. The title wraps rather than truncating for the same reason it is
    // not clipped -- on a narrow screen a cut-off headline is unreadable, and
    // there is room for two lines. A collapsed card keeps two lines' room for
    // the title on a phone and for the excerpt everywhere (min-h), so a short
    // post is the height of its skeleton card instead of shrinking under it;
    // an open card is as tall as its words, with no gap under the title.
    return '<div class="glass-card p-4 rounded-xl flex items-start gap-4 border-l-4 min-w-0 ' + accent + (open ? '' : ' opacity-80') + '">' +
        '<span class="material-symbols-outlined ' + iconColor + ' mt-0.5 shrink-0">' + icon + '</span>' +
        '<div class="flex-1 min-w-0">' +
            '<div class="flex items-start justify-between gap-3">' +
                '<div class="flex items-start gap-2 min-w-0">' +
                    flag +
                    '<h4 data-news-title class="font-bold text-frosted-blue break-words min-w-0' + (open ? '' : ' min-h-12 sm:min-h-0') + '">' + escapeHtml(post.title) + '</h4>' +
                '</div>' +
                '<span class="shrink-0 text-[10px] text-steel-blue font-bold uppercase">' + escapeHtml(newsDateLabel(created)) + '</span>' +
            '</div>' +
            body +
            toggle +
        '</div>' +
    '</div>';
}

function toggleNewsCard(btn) {
    var card = btn.parentElement;
    var full = card.querySelector('[data-news-body]');
    var excerpt = card.querySelector('.line-clamp-2');
    if (!full) return;
    var nowOpen = full.classList.toggle('hidden') === false;
    if (excerpt) excerpt.classList.toggle('hidden', nowOpen);
    // The title's two-line room on a phone is for the collapsed card only.
    var title = card.querySelector('[data-news-title]');
    if (title) title.classList.toggle('min-h-12', !nowOpen);
    btn.querySelector('[data-news-toggle-text]').textContent = nowOpen ? 'Show less' : 'Read more';
    btn.querySelector('[data-news-chevron]').style.transform = nowOpen ? 'rotate(180deg)' : '';
}

// ---- Active streams ----

// Sample artwork: a data: SVG drawn from the theme's own colours (a background
// image can't read CSS variables), never a real poster.
function sampleArtwork(from, to) {
    var css = getComputedStyle(document.documentElement);
    function tone(name) { return 'rgb(' + css.getPropertyValue(name).trim().split(/\s+/).join(',') + ')'; }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice">' +
        '<defs><radialGradient id="g" cx="30%" cy="25%" r="90%">' +
        '<stop offset="0" stop-color="' + tone(from) + '"/><stop offset="1" stop-color="' + tone(to) + '"/>' +
        '</radialGradient></defs><rect width="160" height="90" fill="url(#g)"/>' +
        '<circle cx="122" cy="28" r="34" fill="' + tone('--color-text') + '" fill-opacity=".14"/>' +
        '<circle cx="36" cy="80" r="46" fill="' + tone('--color-background') + '" fill-opacity=".35"/></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// Generic titles only: this file ships with the template.
function sampleStreams() {
    return [
        { session_id: 'sample-1', title: 'Sample Movie', year: 2026, decision: 'Direct Play', progress: 35,
          thumb_url: sampleArtwork('--color-secondary', '--color-primary') },
        { session_id: 'sample-2', title: 'Sample Show', episode_info: 'S1 E2', decision: 'Transcode', progress: 70,
          source_quality: '4K', source_height: 2160, stream_quality: '1080p', stream_height: 1080,
          thumb_url: sampleArtwork('--color-accent', '--color-background') },
        { session_id: 'sample-3', title: 'Sample Movie Without Artwork', year: 2025, decision: 'Direct Stream', progress: 5,
          thumb_url: '' }
    ];
}

// A Direct Play card with nothing in it: the shape the skeleton row in
// #streamsContainer is built from, repeated here for the empty and error
// states. Change one, change both.
const STREAM_CARD_SHAPE =
    '<div class="rounded-xl border border-transparent"><div class="aspect-video"></div>' +
    '<div class="p-4 space-y-3"><span class="text-xs font-bold">Direct Play</span>' +
    '<div class="space-y-1"><div class="flex text-[10px] font-bold uppercase"><span>Progress</span></div>' +
    '<div class="h-1"></div></div></div></div>';

// The empty and error states hold the height of the one row of cards the
// skeleton reserved, so the section neither shrinks when there is nothing
// playing nor jumps when the first stream starts. The message sits over an
// invisible card in the same grid columns. `label` is always a fixed string
// from this file, never data.
function streamsStateRow(label) {
    return '<div class="col-span-full relative">' +
            '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 invisible" aria-hidden="true">' +
                STREAM_CARD_SHAPE +
            '</div>' +
            '<div class="absolute inset-0 flex flex-col items-center justify-center text-center text-steel-blue">' +
                '<span class="material-symbols-outlined text-4xl mb-2 block opacity-50">play_circle</span>' +
                '<p>' + label + '</p>' +
            '</div>' +
        '</div>';
}

// One stream's card. preview: the admin's sample preview is on (a label over
// the artwork says so).
function renderStreamCard(stream, preview) {
    const progress = stream.progress || 0;
    const title = escapeHtml(stream.title || 'Unknown');
    const year = stream.year || '';
    const subtitle = stream.episode_info ? escapeHtml(stream.episode_info) : '';
    const decision = stream.decision || 'Direct Play';
    const thumbUrl = stream.thumb_url || '';
    const isTranscode = decision.toLowerCase() === 'transcode' || decision.toLowerCase() === 'transcoding';
    const sourceQuality = stream.source_quality || '';
    const sourceHeight = stream.source_height || 0;
    const streamQuality = stream.stream_quality || '';
    const streamHeight = stream.stream_height || 0;

    // Build display title: "Movie (2024)" or "Show (S01E05)"
    let displayTitle = title;
    if (subtitle) {
        displayTitle = `${title} (${subtitle})`;
    } else if (year) {
        displayTitle = `${title} (${year})`;
    }

    // Transcode warning or play type label. Owner exception to R140
    // (owner request): these words keep the pure status colours, not the -text mixes.
    // "More info" opens the details right after it (data-action, see mount).
    let playTypeHtml;
    if (isTranscode) {
        playTypeHtml = `
            <div>
                <span class="text-status-warn text-[11px] font-bold">Warning: Not playing at full quality!</span>
                <button type="button" data-action="stream-info" class="text-status-warn/70 hover:text-status-warn text-[10px] underline cursor-pointer block mt-0.5">More info</button>
                <div class="hidden mt-1.5 text-[10px] text-status-warn/80 leading-relaxed">
                    <p>Source file is ${sourceHeight ? sourceHeight + 'p' : escapeHtml(sourceQuality)} but you're streaming at ${streamHeight ? streamHeight + 'p' : escapeHtml(streamQuality)}${sourceQuality === streamQuality ? ' (if these values are the same it means it\'s a lower bitrate)' : ''}</p>
                    <p class="mt-1">Transcoding gives you a lower quality experience, change your Plex app quality setting to "Original" for the best experience.</p>
                </div>
            </div>`;
    } else {
        playTypeHtml = `<span class="text-status-ok text-xs font-bold">${escapeHtml(decision)} (Full Quality)</span>`;
    }

    const bgStyle = thumbUrl
        ? `background-image: url('${thumbUrl}'); background-size: cover; background-position: center;`
        : `background: linear-gradient(135deg, rgb(var(--color-primary) / 0.6), rgb(var(--color-secondary) / 0.4));`;

    return `
        <div class="glass-card rounded-xl overflow-hidden group">
            <div class="aspect-video relative overflow-hidden">
                <div class="absolute inset-0 bg-cover bg-center transition-transform duration-500 group-hover:scale-110" style="${bgStyle}"></div>
                <div class="absolute inset-0 bg-gradient-to-t from-background-dark via-transparent to-transparent"></div>
                ${preview ? '<span class="absolute top-3 left-3 px-2 py-0.5 rounded-full bg-background-dark/70 text-frosted-blue text-[10px] font-bold uppercase tracking-wider">Sample</span>' : ''}
                <div class="absolute bottom-4 left-4 right-4">
                    <h4 class="text-lg font-bold text-frosted-blue">${displayTitle}</h4>
                </div>
            </div>
            <div class="p-4 space-y-3">
                ${playTypeHtml}
                <div class="space-y-1">
                    <div class="flex justify-between text-[10px] text-steel-blue font-bold uppercase">
                        <span>Progress</span>
                        <span>${Math.min(100, Math.max(0, Math.round(progress) || 0))}%</span>
                    </div>
                    <div class="h-1 bg-frosted-blue/10 rounded-full overflow-hidden">
                        <div class="h-full bg-primary rounded-full" style="width: ${Math.min(100, Math.max(0, Math.round(progress) || 0))}%"></div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---- Recent requests ----

// The empty and error states take exactly the space of the ten skeleton
// rows they replace, so the card neither shrinks nor grows when they land
// (it sits above Active Streams, which would move).
//
// By composition rather than a fixed height: the message sits in the same grid
// cell as an invisible stack of ten row shapes built from the real row's
// markup (padding, 32px thumbnail, title line, the narrow card's type pill, 1px
// dividers). The rows mix rem with the pill's px text, so no single length
// matches them at every browser font size; the same markup does. `label` is
// always a fixed string from this file, never data.
function requestsStateRow(label) {
    const shape = (divider) =>
        `<div class="flex items-center gap-3 px-3 py-2.5${divider ? ' border-t border-transparent' : ''}">` +
            '<div class="size-8 shrink-0"></div>' +
            '<div class="min-w-0 flex-1"><p class="truncate">&nbsp;</p>' +
                '<div class="@md:hidden mt-1"><span class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold leading-none">' +
                    '<span class="material-symbols-outlined text-[13px] leading-none">movie</span><span>Movie</span></span></div>' +
            '</div>' +
        '</div>';
    let rows = shape(false);
    for (let i = 1; i < 10; i++) rows += shape(true);
    return '<tr><td colspan="3" class="p-0"><div class="grid">' +
            '<div class="col-start-1 row-start-1 invisible" aria-hidden="true">' + rows + '</div>' +
            '<div class="col-start-1 row-start-1 flex flex-col items-center justify-center px-6 text-center text-steel-blue">' +
                '<span class="material-symbols-outlined text-4xl mb-2 block opacity-50">shopping_cart</span>' +
                '<p>' + label + '</p>' +
            '</div>' +
        '</div></td></tr>';
}

// Status chip per tone (WS.requestStatus). Theme classes only, and the same
// grouping the requests page uses: finished on a primary tint, things in
// motion in the text colour, not-yet-started on the accent, and a request that
// will not happen dimmed rather than alarming. The words are always the text
// colour (at a step that still reads): Bright text is for solid primary
// fills, and plain accent text on its own tint fell short of 4.5:1.
const REQUEST_TONE_CLASSES = {
    ready: 'bg-primary/30 text-frosted-blue',
    go:    'bg-frosted-blue/15 text-frosted-blue',
    wait:  'bg-steel-blue/20 text-frosted-blue/80',
    dead:  'bg-steel-blue/10 text-frosted-blue/80'
};

function renderRequestRow(req) {
    const title = escapeHtml(req.media_title || 'Unknown');
    // Deliberately no requester name here. Recent Requests is a
    // server-wide view - it shows everyone's requests - so attributing
    // them would tell every user what every other user asked for. The
    // API does not return a requester field at all; this comment marks
    // that as intentional rather than an oversight to be "fixed".
    const posterUrl = req.poster_url || '';

    // Friendly words for Seerr's raw states (PARTIALLY_AVAILABLE and
    // friends), from the vocabulary the requests page uses too.
    const status = WS.requestStatus(req.status || 'pending');
    const statusCls = REQUEST_TONE_CLASSES[status.tone] || REQUEST_TONE_CLASSES.wait;

    const posterStyle = posterUrl
        ? `background-image: url('${posterUrl}'); background-size: cover; background-position: center;`
        : '';

    // Books and audiobooks come from Chaptarr, which has no artwork to
    // give, so the thumbnail slot would otherwise be an empty grey
    // square. A glyph at least says what kind of thing it is.
    const type = WS.mediaType(req.media_type || 'movie');
    const thumbInner = posterUrl
        ? ''
        : `<span class="material-symbols-outlined text-steel-blue/50 text-base leading-none">${type.icon}</span>`;

    // eBook and Audiobook share the book colour (there are three media
    // hues, not four); the label and icon tell them apart.
    const typePill = `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold leading-none whitespace-nowrap badge-${type.accent}">` +
        `<span class="material-symbols-outlined text-[13px] leading-none" aria-hidden="true">${type.icon}</span>${type.label}</span>`;

    // The skeleton rows in #requestsBody copy this row's geometry so
    // nothing moves when data lands. Change one, change both. The card is a
    // container: under 28rem of card the type folds into a pill under the
    // title and its own column closes to no width (it stays a column, so the
    // table keeps the three the skeleton rows span); from 28rem it shows.
    return `
        <tr>
            <td class="px-3 py-2.5">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="size-8 rounded bg-frosted-blue/[0.04] shrink-0 flex items-center justify-center" style="${posterStyle}">${thumbInner}</div>
                    <div class="min-w-0 flex-1">
                        <p class="font-medium text-frosted-blue truncate">${title}</p>
                        <div class="@md:hidden mt-1">${typePill}</div>
                    </div>
                </div>
            </td>
            <td class="p-0 @md:px-3 @md:py-2.5"><div class="hidden @md:block">${typePill}</div></td>
            <td class="px-3 py-2.5">
                <span class="inline-block px-2 py-0.5 rounded ${statusCls} text-[10px] font-bold uppercase leading-tight">${status.label}</span>
            </td>
        </tr>
    `;
}

// ---- Service health ----

// Homelab icon mapping — service name substring → selfh.st icon slug
const HOMELAB_ICONS = {
    'plex': 'plex', 'radarr': 'radarr', 'sonarr': 'sonarr', 'seerr': 'seerr',
    'tautulli': 'tautulli', 'jellyfin': 'jellyfin', 'emby': 'emby', 'lidarr': 'lidarr',
    'prowlarr': 'prowlarr', 'bazarr': 'bazarr', 'readarr': 'readarr', 'sabnzbd': 'sabnzbd',
    'qbittorrent': 'qbittorrent', 'transmission': 'transmission', 'deluge': 'deluge',
    'jackett': 'jackett', 'portainer': 'portainer', 'grafana': 'grafana',
    'prometheus': 'prometheus', 'netdata': 'netdata', 'pi-hole': 'pi-hole',
    'adguard': 'adguard-home', 'traefik': 'traefik', 'nginx': 'nginx-proxy-manager',
    'caddy': 'caddy', 'home assistant': 'home-assistant', 'homeassistant': 'home-assistant',
    'nextcloud': 'nextcloud', 'vaultwarden': 'vaultwarden', 'bitwarden': 'bitwarden',
    'wireguard': 'wireguard', 'tailscale': 'tailscale', 'unraid': 'unraid',
    'truenas': 'truenas', 'proxmox': 'proxmox', 'docker': 'docker',
    'watchtower': 'watchtower', 'uptime kuma': 'uptime-kuma', 'heimdall': 'heimdall',
    'homarr': 'homarr', 'organizr': 'organizr', 'authentik': 'authentik', 'authelia': 'authelia',
};

function getServiceIconUrl(name) {
    var lower = name.toLowerCase();
    for (var key in HOMELAB_ICONS) {
        if (lower.indexOf(key) !== -1) {
            return 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/' + HOMELAB_ICONS[key] + '.svg';
        }
    }
    return null;
}

function renderServiceTile(service) {
    var barBg, dotCls, textCls, statusLabel;

    switch(service.status) {
        // A tint of the state's colour with its dot, like the header
        // pill: the words stay quiet theme text while all is well and
        // take the status-text colour only when something is wrong.
        case 'up':
            barBg = 'bg-status-ok/10'; dotCls = 'ws-light-ok'; textCls = 'text-frosted-blue';
            statusLabel = 'Online';
            break;
        case 'degraded':
            barBg = 'bg-status-warn/10'; dotCls = 'ws-light-warn'; textCls = 'text-status-warn-text';
            statusLabel = 'Degraded';
            break;
        case 'down':
            barBg = 'bg-status-err/10'; dotCls = 'ws-light-error'; textCls = 'text-status-err-text';
            statusLabel = 'Offline';
            break;
        case 'maintenance':
            barBg = 'bg-steel-blue/20'; dotCls = 'ws-light-unconfigured'; textCls = 'text-frosted-blue/70';
            statusLabel = 'Maintenance';
            break;
        default:
            barBg = 'bg-steel-blue/20'; dotCls = 'ws-light-off'; textCls = 'text-frosted-blue/70';
            statusLabel = 'Unknown';
    }

    var iconUrl = getServiceIconUrl(service.display_name);
    var iconHtml = iconUrl
        ? '<img src="' + iconUrl + '" alt="" width="24" height="24" class="service-icon w-6 h-6 shrink-0 object-contain">'
        : '<span class="material-symbols-outlined text-2xl leading-6 text-steel-blue">' + escapeHtml(service.icon) + '</span>';

    // Compact: the 24px icon and the name on one line over the status bar.
    // Every tile is the same height whatever its name: the top row is a
    // fixed h-11 and the name keeps to one line (a narrow tile cuts it
    // short and carries the whole name as its title), so nothing can make
    // it taller. The skeleton tiles in #servicesContainer are this tile, empty.
    var name = escapeHtml(service.display_name);
    return '<div class="bg-baltic-blue/10 rounded-xl overflow-hidden border border-steel-blue/20 flex flex-col min-w-0 hover:border-primary/40 transition-all">' +
        '<div class="h-11 px-3 flex items-center gap-2.5 min-w-0">' +
            iconHtml +
            '<span class="min-w-0 truncate text-[13px] font-medium text-frosted-blue" title="' + name + '">' + name + '</span>' +
        '</div>' +
        '<div class="' + barBg + ' py-0.5 flex items-center justify-center gap-1.5">' +
            '<span class="ws-light ' + dotCls + '" aria-hidden="true"></span>' +
            '<span class="text-[10px] font-bold ' + textCls + ' uppercase tracking-wider">' + statusLabel + '</span>' +
        '</div>' +
    '</div>';
}

// ---- Upcoming releases ----

// Format Date to YYYY-MM-DD
function _fmtDate(d) {
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// Fills container with the next seven days' releases: a list of the days that
// have any (and today) on a phone, a seven-column row from lg.
function buildReleases(container, releases) {
    // Clear container
    while (container.firstChild) container.removeChild(container.firstChild);

    // Build 7 day columns starting from today
    var today = new Date();

    // Group releases by date
    var grouped = {};
    if (Array.isArray(releases)) {
        releases.forEach(function(r) {
            var dateKey = r.air_date ? r.air_date.substring(0, 10) : '';
            if (!dateKey) return;
            if (!grouped[dateKey]) grouped[dateKey] = [];
            grouped[dateKey].push(r);
        });
    }

    var isMobile = window.innerWidth < 1024;
    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var i, j, cellDate, dateStr, isToday, dayReleases, rel, badge, name, nameText, empty;

    if (isMobile) {
        // Mobile: vertical list grouped by day
        var list = document.createElement('div');
        list.className = 'flex flex-col gap-2';

        for (i = 0; i < 7; i++) {
            cellDate = new Date(today);
            cellDate.setDate(cellDate.getDate() + i);
            dateStr = _fmtDate(cellDate);
            isToday = (i === 0);
            dayReleases = grouped[dateStr] || [];
            if (dayReleases.length === 0 && !isToday) continue;

            var row = document.createElement('div');
            var rowCls = 'rounded-lg p-3 bg-frosted-blue/[0.04] flex gap-3';
            if (isToday) rowCls += ' ring-1 ring-primary bg-primary/10';
            row.className = rowCls;

            // Date label (left column)
            var dateCol = document.createElement('div');
            dateCol.className = 'shrink-0 w-12 text-center';
            var dayName = document.createElement('div');
            dayName.className = 'text-[10px] font-bold uppercase tracking-wider ' + (isToday ? 'text-frosted-blue' : 'text-frosted-blue/70');
            dayName.textContent = dayNames[cellDate.getDay()];
            dateCol.appendChild(dayName);
            var dayNum = document.createElement('div');
            dayNum.className = 'text-lg font-bold text-frosted-blue';
            dayNum.textContent = cellDate.getDate();
            dateCol.appendChild(dayNum);
            row.appendChild(dateCol);

            // Releases (right column)
            var relCol = document.createElement('div');
            relCol.className = 'flex-1 flex flex-col gap-1 min-w-0';

            if (dayReleases.length === 0) {
                empty = document.createElement('span');
                empty.className = 'text-xs text-frosted-blue/70 italic';
                empty.textContent = 'No releases';
                relCol.appendChild(empty);
            } else {
                for (j = 0; j < dayReleases.length; j++) {
                    rel = dayReleases[j];
                    badge = document.createElement('div');
                    badge.className = 'flex items-center gap-2 min-w-0';

                    var typeBadge = document.createElement('span');
                    if (rel.media_type === 'movie') {
                        typeBadge.className = 'text-[9px] font-bold uppercase px-1.5 py-0.5 rounded badge-media-movie shrink-0';
                        typeBadge.textContent = 'MOV';
                    } else {
                        typeBadge.className = 'text-[9px] font-bold uppercase px-1.5 py-0.5 rounded badge-media-tv shrink-0';
                        typeBadge.textContent = 'TV';
                    }
                    badge.appendChild(typeBadge);

                    name = document.createElement('span');
                    name.className = 'text-xs text-frosted-blue/90 truncate';
                    nameText = rel.title || 'Unknown';
                    if (rel.media_type === 'tv' && rel.episode_code) {
                        nameText += ' ' + rel.episode_code;
                    }
                    name.textContent = nameText;
                    badge.appendChild(name);

                    relCol.appendChild(badge);
                }
            }
            row.appendChild(relCol);
            list.appendChild(row);
        }
        container.appendChild(list);

    } else {
        // Desktop: 7-column grid

        // Day-of-week header row
        var headerRow = document.createElement('div');
        headerRow.className = 'grid grid-cols-7 gap-1 mb-1';
        for (var d = 0; d < 7; d++) {
            var dayDate = new Date(today);
            dayDate.setDate(dayDate.getDate() + d);
            var hdr = document.createElement('div');
            hdr.className = 'text-center text-[10px] font-bold uppercase tracking-wider text-frosted-blue/70';
            hdr.textContent = dayNames[dayDate.getDay()];
            headerRow.appendChild(hdr);
        }
        container.appendChild(headerRow);

        var grid = document.createElement('div');
        grid.className = 'grid grid-cols-7 gap-1';

        for (i = 0; i < 7; i++) {
            cellDate = new Date(today);
            cellDate.setDate(cellDate.getDate() + i);
            dateStr = _fmtDate(cellDate);
            isToday = (i === 0);
            dayReleases = grouped[dateStr] || [];

            var cell = document.createElement('div');
            var cellCls = 'rounded-lg p-2 lg:p-3 min-h-[130px] flex flex-col bg-frosted-blue/[0.04]';
            if (isToday) cellCls += ' ring-1 ring-primary bg-primary/10';
            cell.className = cellCls;

            // Day number
            var dayLabel = document.createElement('div');
            dayLabel.className = 'text-xs font-bold mb-1 ' + (isToday ? 'text-frosted-blue' : 'text-steel-blue');
            dayLabel.textContent = cellDate.getDate();
            cell.appendChild(dayLabel);

            // Release badges
            if (dayReleases.length === 0) {
                empty = document.createElement('div');
                empty.className = 'flex-1 flex items-center justify-center';
                var dash = document.createElement('span');
                dash.className = 'text-steel-blue/20 text-xs';
                dash.textContent = '—';
                empty.appendChild(dash);
                cell.appendChild(empty);
            } else {
                var rlist = document.createElement('div');
                rlist.className = 'flex flex-col gap-1 overflow-hidden';
                var maxShow = 4;
                for (j = 0; j < dayReleases.length && j < maxShow; j++) {
                    rel = dayReleases[j];
                    badge = document.createElement('div');
                    badge.className = 'flex items-center gap-1 min-w-0';

                    var dot = document.createElement('span');
                    if (rel.media_type === 'movie') {
                        dot.className = 'size-1.5 rounded-full bg-media-movie shrink-0';
                    } else {
                        dot.className = 'size-1.5 rounded-full bg-media-tv shrink-0';
                    }
                    badge.appendChild(dot);

                    name = document.createElement('span');
                    name.className = 'text-[10px] text-frosted-blue/80 truncate leading-tight';
                    nameText = rel.title || 'Unknown';
                    if (rel.media_type === 'tv' && rel.episode_code) {
                        nameText += ' ' + rel.episode_code;
                    }
                    name.textContent = nameText;
                    badge.appendChild(name);

                    rlist.appendChild(badge);
                }
                if (dayReleases.length > maxShow) {
                    var more = document.createElement('span');
                    more.className = 'text-[9px] text-frosted-blue/70 pl-3';
                    more.textContent = '+' + (dayReleases.length - maxShow) + ' more';
                    rlist.appendChild(more);
                }
                cell.appendChild(rlist);
            }

            grid.appendChild(cell);
        }
        container.appendChild(grid);
    }
}

function releasesError(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var errDiv = document.createElement('div');
    errDiv.className = 'text-center text-steel-blue py-8';
    var errIcon = document.createElement('span');
    errIcon.className = 'material-symbols-outlined text-4xl mb-2 block opacity-50';
    errIcon.textContent = 'calendar_month';
    var errText = document.createElement('p');
    errText.textContent = 'Sonarr/Radarr not configured';
    errDiv.appendChild(errIcon);
    errDiv.appendChild(errText);
    container.appendChild(errDiv);
}

export async function mount(ctx) {
    var root = ctx.root;
    var signal = ctx.signal;
    // The fetched page's own payload: the same one the server read for
    // html[data-home-hide], so the sections loaded are the sections shown.
    var branding = (ctx.data && ctx.data.branding) || window.WEBSERVARR_THEME || {};

    function byId(id) { return root.querySelector('#' + id); }

    // Add to home screen. A full load decided it before the first paint
    // (theme-loader.js WSInstallOffer: html[data-install-offer] shows the
    // card); a soft navigation decides it here, before the swapped page is
    // drawn. install.js (WS.install) wires its buttons for this visit.
    var install = byId('installCard');
    if (install) {
        var installMode = typeof window.WSInstallOffer === 'function'
            ? window.WSInstallOffer(install.dataset.dismissKey) : '';
        install.hidden = !installMode;
        if (installMode) install.dataset.mode = installMode;
        document.documentElement.removeAttribute('data-install-offer');
        if (installMode && window.WS && WS.install) WS.install.wireCard(install, signal);
    }

    // Push opt-in. A full load decided it before the first paint
    // (theme-loader.js WSPushOffer: html[data-push-offer] shows the card); a
    // soft navigation decides it here, before the swapped page is drawn. From
    // now on the card's hidden attribute says it, and notifications.js wires
    // its buttons and writes the dismissal under data-dismiss-key.
    var card = byId('pushPrompt');
    if (card) {
        card.hidden = !(typeof window.WSPushOffer === 'function' &&
                        window.WSPushOffer(card.dataset.dismissKey, Number(card.dataset.dismissDays)));
        document.documentElement.removeAttribute('data-push-offer');
        if (!card.hidden && typeof window.initPushPrompt === 'function') window.initPushPrompt(card, signal);
    }

    // Apply configurable section icons from branding
    var icons = branding.icons || {};
    var iconMap = {
        iconSectionServices: icons.section_services,
        iconSectionNews: icons.section_news,
        iconSectionStreams: icons.section_streams,
        iconSectionReleases: icons.section_releases,
        iconSectionRequests: icons.section_requests,
    };
    for (var elId in iconMap) {
        if (iconMap[elId]) {
            var el = byId(elId);
            if (el) el.textContent = iconMap[elId];
        }
    }

    // Sections the admin switched off (Settings > Pages > Home) are hidden by
    // the server (data-home-hide) and never loaded. Marking them arrived keeps
    // the top-down reveal from waiting for a section that will never come.
    var homeSections = branding.home_sections || {};
    function sectionOn(id) { return homeSections[id] !== false; }
    SECTIONS.forEach(function (id) {
        if (!sectionOn(id)) WS.arrive(id);
    });

    // ---- Continue (the Books page's row, compact) ----
    //
    // Books is on while it has something to show and the admin has not
    // switched it off (the same rule as its nav item).
    var features = branding.features || {};
    var booksOn = !!features.books_configured && (branding.sidebar_enabled || {}).library !== false;
    var continueHost = byId('homeContinue');
    var continueUser = ((ctx.data || {}).user || {}).username || '';
    function remembered(key) {
        try { return localStorage.getItem(key + continueUser); } catch (e) { return null; }
    }
    function remember(key, value) {
        try { localStorage.setItem(key + continueUser, value); } catch (e) { /* private mode: nothing is kept */ }
    }
    var continueModule = null;
    if (continueHost) {
        // Decided before anything is awaited, so the first frame is the final
        // one: the room a person's row had last time (a full load did it in
        // <head>, theme-loader.js), or none.
        var hadRow = booksOn && remembered(CONTINUE_KEY) === '1';
        continueHost.hidden = !hadRow;
        var noteSlot = continueHost.querySelector('[data-note-slot]');
        if (noteSlot) noteSlot.hidden = !(hadRow && remembered(CONTINUE_NOTE_KEY) === '1');
        document.documentElement.removeAttribute('data-home-continue');
        if (booksOn) {
            // Started now so it is in by the time the answer is.
            continueModule = import(root.getAttribute('data-ws-dep') || './books.js').catch(function (e) {
                console.error('The Continue row could not load:', e);
                return null;
            });
        } else {
            WS.arrive('continue');
        }
    }

    // This visit's state.
    var _streamPage = 0;
    var _lastStreams = null;   // the last streams shown: a transient empty answer keeps them
    var _samples = null;

    // Admin-only preview, /?preview=streams: three sample streams through the
    // same renderer as real ones, so the card can be looked at with nothing
    // playing. Set below only when the server marked the page for an admin
    // (data-admin on <html>) and the session user is an admin; a member's URL
    // flag does nothing. While it is on, loadActiveStreams (and so the 30s
    // poll) renders the samples and never fetches, so nothing overwrites them.
    var _streamsPreview = false;

    // ---- News ----

    function loadNews() {
        var cfg = newsSettings(branding);
        // Ask for one extra post: if the server has more than fits, the
        // "View all" link is worth showing. The extra is never rendered.
        var url = '/api/news/?limit=' + (cfg.count + 1);
        if (cfg.maxAgeDays > 0) url += '&max_age_days=' + cfg.maxAgeDays;

        return WS.swr('news:' + url, function () { return WS.getJSON(url, { signal: signal }); }, renderNews, {
            onError: function (error) {
                if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                console.error('Error loading news:', error);
                WS.arrive('news', function () {
                    WS.setHTML(byId('newsContainer'), `
                        <div class="text-center text-frosted-blue/70 py-8">
                            <span class="material-symbols-outlined text-4xl mb-2 block text-status-err-text">error</span>
                            <p>Error loading news</p>
                        </div>
                    `);
                });
            }
        });
    }

    function renderNews(posts) {
        if (signal.aborted) return;   // left: the next page owns the arrival order now
        var cfg = newsSettings(branding);
        const newsContainer = byId('newsContainer');
        const viewAll = byId('newsViewAll');

        WS.arrive('news', function () {
            if (!Array.isArray(posts) || posts.length === 0) {
                WS.setHTML(newsContainer, `
                    <div class="text-center text-steel-blue py-8">
                        <span class="material-symbols-outlined text-4xl mb-2 block opacity-50">newspaper</span>
                        <p>No news posts yet.</p>
                    </div>
                `);
            } else {
                var shown = posts.slice(0, cfg.count);
                WS.setHTML(newsContainer, shown.map(function (post) { return renderNewsCard(post, false); }).join(''));
            }
            // Older posts may still exist beyond the age window, so the archive
            // link stays available even when the homepage feed is empty. It holds
            // its space from the first paint (invisible), so showing it moves
            // nothing, including the admins' "Manage news" beside it.
            if (viewAll) {
                viewAll.classList.remove('invisible');
            }
        });
    }

    // ---- Continue ----

    function loadContinue() {
        return continueModule.then(function (mod) {
            if (signal.aborted) return;
            if (!mod || typeof mod.renderContinueRow !== 'function') { hideContinue(); return; }
            return WS.swr('books:continue', function () {
                return WS.getJSON('/api/books/continue', { signal: signal });
            }, function (data, fromCache) {
                renderContinue(mod, data, fromCache);
            }, {
                onError: function (error) {
                    if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                    // No Continue is not a reason to say anything on Home: the row stays away.
                    hideContinue();
                }
            });
        });
    }

    function hideContinue() {
        WS.arrive('continue', function () {
            if (signal.aborted) return;
            continueHost.hidden = true;
        });
    }

    function renderContinue(mod, data, fromCache) {
        if (signal.aborted) return;
        var items = (data && Array.isArray(data.items)) ? data.items : [];
        var notes = (data && Array.isArray(data.notes)) ? data.notes : [];
        WS.arrive('continue', function () {
            if (signal.aborted) return;
            // A person who is not connected to Kavita connects from Books (it
            // runs the hand-off); Home only says so, and links there.
            var row = mod.renderContinueRow(items, notes, { compact: true, signal: signal, connectHref: '/books' });
            // What takes the skeleton's place is the row, or nothing at all.
            continueHost.textContent = '';
            if (row) continueHost.appendChild(row);
            continueHost.hidden = !row;
            continueHost.setAttribute('aria-busy', 'false');
            if (!fromCache) {
                remember(CONTINUE_KEY, row ? '1' : '0');
                remember(CONTINUE_NOTE_KEY, row && row.querySelector('[data-continue-note]') ? '1' : '0');
            }
        });
    }

    // ---- The sidebar's pending-requests badge (not a home section) ----

    async function loadRequestCount() {
        // The Requests nav item carries the badge in the desktop sidebar and in
        // the phone's tab bar or More sheet; there is none while Requests is
        // switched off.
        const badges = document.querySelectorAll('[data-badge="requestsBadge"]');
        if (!badges.length) return;
        let pending = 0;
        try {
            const response = await fetch('/api/integrations/request-counts', { signal: signal });
            if (!response.ok) throw new Error('API error');
            const counts = await response.json();
            pending = counts.pending || 0;
        } catch (e) {
            if (signal.aborted || isAbort(e)) return;   // left the page: the badge keeps its count
            pending = 0;
        }
        if (signal.aborted) return;
        badges.forEach(function (badge) {
            badge.textContent = pending > 0 ? pending : '';
            badge.classList.toggle('hidden', !(pending > 0));
        });
    }

    // ---- Active streams ----

    function sampleSet() {
        if (!_samples) _samples = sampleStreams();
        return _samples;
    }

    async function loadActiveStreams() {
        if (_streamsPreview) { renderActiveStreams(sampleSet()); return; }
        return WS.swr('streams', function () { return WS.getJSON('/api/integrations/active-streams', { signal: signal }); }, renderActiveStreams, {
            maxAge: 60 * 1000,
            onError: function (error) {
                if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                console.error('Error loading active streams:', error);
                // On error, keep showing previous data if available
                if (_lastStreams && _lastStreams.length > 0) return;
                WS.arrive('streams', function () {
                    byId('streamChevrons').classList.add('hidden');
                    WS.setHTML(byId('streamsContainer'), streamsStateRow('Plex not configured'));
                });
            }
        });
    }

    function renderActiveStreams(streams) {
        if (signal.aborted) return;
        const container = byId('streamsContainer');

        // If API returns empty but we had data before, keep showing previous data
        // (prevents streams disappearing/reappearing due to transient Plex API issues)
        if ((!Array.isArray(streams) || streams.length === 0) && _lastStreams && _lastStreams.length > 0) {
            return; // Keep showing previous streams
        }
        _lastStreams = streams;

        WS.arrive('streams', function () {
            if (!Array.isArray(streams) || streams.length === 0) {
                WS.setHTML(container, streamsStateRow('No active streams'));
                return;
            }

            // Paginate streams
            var totalPages = Math.ceil(streams.length / STREAMS_PER_PAGE);
            if (_streamPage >= totalPages) _streamPage = 0;
            var pageStreams = streams.slice(_streamPage * STREAMS_PER_PAGE, (_streamPage + 1) * STREAMS_PER_PAGE);

            // Only update DOM if content actually changed (prevents flicker)
            WS.setHTML(container, pageStreams.map(function (stream) {
                return renderStreamCard(stream, _streamsPreview);
            }).join(''));

            // Show/hide pagination chevrons based on stream count
            byId('streamChevrons').classList.toggle('hidden', streams.length <= STREAMS_PER_PAGE);
        });
    }

    // Paginate streams
    function scrollStreams(direction) {
        if (!_lastStreams || _lastStreams.length === 0) return;
        var totalPages = Math.ceil(_lastStreams.length / STREAMS_PER_PAGE);
        _streamPage += direction;
        if (_streamPage < 0) _streamPage = totalPages - 1;
        if (_streamPage >= totalPages) _streamPage = 0;
        loadActiveStreams();
    }

    // ---- Recent requests ----

    function loadRecentRequests() {
        return WS.swr('recent-requests', function () { return WS.getJSON('/api/integrations/recent-requests', { signal: signal }); }, renderRecentRequests, {
            onError: function (error) {
                if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                console.error('Error loading recent requests:', error);
                WS.arrive('requests', function () {
                    WS.setHTML(byId('requestsBody'), requestsStateRow('Seerr not configured'));
                });
            }
        });
    }

    function renderRecentRequests(requests) {
        if (signal.aborted) return;
        const tbody = byId('requestsBody');

        WS.arrive('requests', function () {
            if (!Array.isArray(requests) || requests.length === 0) {
                WS.setHTML(tbody, requestsStateRow('No recent requests'));
                return;
            }
            WS.setHTML(tbody, requests.map(renderRequestRow).join(''));
        });
    }

    // ---- Service health ----

    function loadServices() {
        // One request shared with the header pill (WS.serviceStatus), cached for
        // the next visit. It never rejects: an unreachable monitor reads as none.
        return WS.swr('services', WS.serviceStatus, renderServices);
    }

    function renderServices(data) {
        if (signal.aborted) return;   // the shared answer landed after the page was left
        const servicesContainer = byId('servicesContainer');
        const services = (Array.isArray(data) ? data : []).map(svc => ({
            display_name: svc.name || 'Unknown',
            status: svc.status || 'unknown',
            icon: svc.icon || 'dns',
            last_check: svc.last_check
        }));

        WS.arrive('services', function () {
            if (services.length === 0) {
                WS.setHTML(servicesContainer, '<div class="text-center text-steel-blue py-8 col-span-full"><span class="material-symbols-outlined text-4xl mb-2 block opacity-50">dns</span><p>No services configured yet.</p></div>');
                return;
            }

            // Update "Last checked" timer in section header
            var latestCheck = null;
            services.forEach(function(svc) {
                if (svc.last_check) {
                    var d = new Date(svc.last_check + 'Z');
                    if (!latestCheck || d > latestCheck) latestCheck = d;
                }
            });
            var timerEl = byId('serviceLastChecked');
            if (timerEl && latestCheck) {
                timerEl.textContent = 'Checked ' + getTimeAgo(latestCheck);
                timerEl.dataset.lastCheck = latestCheck.toISOString();
            }

            WS.setHTML(servicesContainer, services.map(renderServiceTile).join(''));
        });
    }

    // "Checked 12s ago" under Service Health, kept current between refreshes.
    function tickLastChecked() {
        var el = byId('serviceLastChecked');
        if (el && el.dataset.lastCheck) {
            el.textContent = 'Checked ' + getTimeAgo(new Date(el.dataset.lastCheck));
        }
    }

    // ---- Upcoming releases ----

    function loadUpcomingReleases() {
        return WS.swr('releases:7', function () { return WS.getJSON('/api/integrations/upcoming-releases?days=7', { signal: signal }); }, renderUpcomingReleases, {
            onError: function (error) {
                if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                console.log('Upcoming releases not available');
                WS.arrive('releases', function () { releasesError(byId('releasesContainer')); });
            }
        });
    }

    function renderUpcomingReleases(releases) {
        if (signal.aborted) return;
        var container = byId('releasesContainer');
        WS.arrive('releases', function () { buildReleases(container, releases); });
    }

    // ---- The server's gauges (Netdata) ----
    //
    // Two copies of the same readings, both marked data-gauge-*, and every
    // reading is written to both: the compact row in Service Health (below
    // xl) and, from xl, the header's beside the status pill. The header is
    // the shell's, so Home adds its copy (from #homeHeaderGauges) once the
    // first reading is in, so it arrives whole, and the cleanup mount returns
    // takes it out when the visit ends (the router runs it on leave). The
    // status pill is the page's one lookup outside #wsPage. Without Netdata
    // (no html[data-netdata]) neither copy is shown.

    var headerGauges = null;

    function addHeaderGauges() {
        if (headerGauges || signal.aborted) return;
        if (!document.documentElement.hasAttribute('data-netdata')) return;
        var tpl = byId('homeHeaderGauges');
        var pill = document.getElementById('systemStatus');
        if (!tpl || !tpl.content || !tpl.content.firstElementChild || !pill || !pill.parentNode) return;
        removeHeaderGauges(pill.parentNode);   // one copy only, whatever an earlier visit left
        headerGauges = tpl.content.firstElementChild.cloneNode(true);
        pill.parentNode.insertBefore(headerGauges, pill.nextSibling);
    }

    function removeHeaderGauges(scope) {
        var old = (scope || document.documentElement).querySelectorAll('[data-home-gauges]');
        for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
        headerGauges = null;
    }

    function eachGauge(selector, fn) {
        [root, headerGauges].forEach(function (scope) {
            if (scope) Array.prototype.forEach.call(scope.querySelectorAll(selector), fn);
        });
    }
    function setGaugeText(selector, text) {
        eachGauge(selector, function (el) { el.textContent = text; });
    }
    function setGaugeRing(name, pct) {
        eachGauge('[data-gauge-ring="' + name + '"]', function (el) {
            el.style.strokeDashoffset = 251 - (251 * pct / 100);
        });
    }

    async function loadSystemStats() {
        try {
            var response = await fetch('/api/integrations/system-stats', { signal: signal });
            if (!response.ok) throw new Error('API error');
            var stats = await response.json();

            if (signal.aborted) return;
            addHeaderGauges();
            if (!stats.configured || stats.error) return;

            // Update CPU gauge
            if (stats.cpu_percent !== null) {
                var cpuPct = stats.cpu_percent;
                setGaugeText('[data-gauge-text="cpu"]', Math.round(cpuPct) + '%');
                setGaugeRing('cpu', cpuPct);
            }
            // Show CPU label (configurable in settings, falls back to thread count)
            if (stats.cpu_label) {
                setGaugeText('[data-gauge-detail="cpu"]', stats.cpu_label);
            } else if (stats.cpu_cores) {
                setGaugeText('[data-gauge-detail="cpu"]', stats.cpu_cores + 'T');
            }

            // Update RAM gauge
            if (stats.ram_percent !== null) {
                var ramPct = stats.ram_percent;
                setGaugeText('[data-gauge-text="ram"]', Math.round(ramPct) + '%');
                setGaugeRing('ram', ramPct);
            }
            // Show RAM label (configurable, falls back to used/total GB)
            if (stats.ram_label) {
                setGaugeText('[data-gauge-detail="ram"]', stats.ram_label);
            } else if (stats.ram_used_mb !== null && stats.ram_total_mb !== null) {
                var usedGB = (stats.ram_used_mb / 1024).toFixed(1);
                var totalGB = (stats.ram_total_mb / 1024).toFixed(0);
                setGaugeText('[data-gauge-detail="ram"]', usedGB + '/' + totalGB + ' GB');
            }

            // Update Network gauge
            var dl = stats.net_download_mbps != null ? stats.net_download_mbps : 0;
            var ul = stats.net_upload_mbps != null ? stats.net_upload_mbps : 0;
            var netUnitLabel = stats.net_unit === 'MBps' ? 'MB/s' : 'Mbps';
            setGaugeText('[data-gauge-net="down"]', dl.toFixed(1));
            setGaugeText('[data-gauge-net="up"]', ul.toFixed(1));
            setGaugeText('[data-gauge-unit]', netUnitLabel);
            // Show network label (configurable)
            if (stats.net_label) setGaugeText('[data-gauge-detail="net"]', stats.net_label);
            // Scale network gauge: percentage of configured max throughput
            var netMax = stats.net_max || 1000;
            setGaugeRing('net', Math.min((dl + ul) / netMax * 100, 100));

        } catch (error) {
            if (signal.aborted || isAbort(error)) return;   // left the page: not an error
            addHeaderGauges();   // as the compact row, it shows its empty readings
            console.log('System stats not available');
        }
    }

    // One delegated listener for the page's buttons, however often the
    // sections under them are rebuilt.
    root.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var toggle = t.closest('[data-news-toggle]');
        if (toggle && root.contains(toggle)) { toggleNewsCard(toggle); return; }
        var btn = t.closest('[data-action]');
        if (!btn || !root.contains(btn)) return;
        switch (btn.getAttribute('data-action')) {
            case 'streams-prev': scrollStreams(-1); break;
            case 'streams-next': scrollStreams(1); break;
            // The transcode details sit right after their "More info".
            case 'stream-info':
                if (btn.nextElementSibling) btn.nextElementSibling.classList.toggle('hidden');
                break;
        }
    }, { signal: signal });

    const user = await checkAuth();
    if (!user || signal.aborted) return;
    _streamsPreview = ctx.url.searchParams.get('preview') === 'streams' &&
        user.is_admin === true && document.documentElement.hasAttribute('data-admin');

    var first = [];
    if (continueHost && booksOn) first.push(loadContinue());
    if (sectionOn('news')) first.push(loadNews());
    if (sectionOn('services')) { first.push(loadServices()); first.push(loadSystemStats()); }
    if (sectionOn('streams')) first.push(loadActiveStreams());
    if (sectionOn('requests')) first.push(loadRecentRequests());
    if (sectionOn('releases')) first.push(loadUpcomingReleases());
    first.push(loadRequestCount());   // the sidebar badge, not a home section

    // Auto-refresh dynamic sections every 30 seconds (paused in background tabs)
    ctx.poll(function() {
        if (sectionOn('services')) loadServices();
        if (sectionOn('streams')) loadActiveStreams();
        if (sectionOn('requests')) loadRecentRequests();
        if (sectionOn('releases')) loadUpcomingReleases();
        loadRequestCount();
    }, 30000);

    if (sectionOn('services')) {
        // Real-time Netdata gauges — poll every 1 second
        ctx.poll(loadSystemStats, 1000);
        // Live-update "Last checked" timer every second
        ctx.poll(tickLastChecked, 1000);
    }

    // The sections are on screen (the last visit's copy, or fetched) before
    // mount resolves, so Back and Forward restore the scroll onto them. A slow
    // integration does not hold that up for long: the skeletons already have
    // the sections' shape.
    await Promise.race([
        Promise.all(first),
        new Promise(function (resolve) { ctx.setTimeout(resolve, 1500); })
    ]);

    // Leaving Home takes the header's gauges with it.
    return function () { removeHeaderGauges(null); };
}
