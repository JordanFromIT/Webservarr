/**
 * WebServarr: Home (page module)
 *
 * Status first, then requests and news, then the rest (spec
 * docs/superpowers/specs/2026-10-04-home-redesign-and-status-feed-design.md,
 * section 2): the status strip with the server's gauges and services under
 * it; a way to request and everyone's recent requests; the latest news;
 * Continue, what is playing, what is coming; the two offers. Sections the
 * admin switched off (Settings > Pages > Home) are hidden by the server
 * (html[data-home-hide], which the router brings in step on every swap) and
 * never loaded. The status strip is not a switchable section.
 *
 * Nothing moves when an answer lands. Every section's skeleton is built from
 * the markup that replaces it, and the empty and error states hold the same
 * room. What the page cannot know from its markup the server marks on <html>
 * before the first paint: the strip's shape (data-home-status) and how many
 * news posts there are (data-home-news); Continue's room is remembered per
 * person. Rows of posters, tiles and streams scroll sideways, so their height
 * never depends on how many there are.
 *
 * A soft-navigation page (spec 4.2): everything below runs from mount(ctx),
 * each visit has its own state, and every listener, fetch and timer ends with
 * ctx.signal. The one read that does not is the service list: it is
 * WS.serviceStatus(), a single request shared with the header's status pill,
 * so this page never aborts it; its answer is dropped once the page is left.
 * Every node is built with textContent: no answer is parsed as markup into
 * the page.
 *
 * Continue is the Books page's own row in its compact form (renderContinueRow
 * from books.js, loaded from the address #wsPage names in data-ws-dep, which
 * the server stamps). Whether this person has one is remembered per person,
 * so a person who had a row last time gets its room from the first paint
 * (theme-loader.js on a full load, mount on a soft one) and nothing below it
 * moves; with nothing in progress the section stays hidden, and it is not
 * loaded at all while the Books page is off.
 */

const SECTIONS = ['services', 'news', 'streams', 'releases', 'requests'];
// Whether this person had a Continue row last time is the Books page's own
// memory (pages/books.js); the second says the row had a note under it.
const CONTINUE_KEY = 'webservarr_books_continue:';
const CONTINUE_NOTE_KEY = 'webservarr_home_continue_note:';
// Home shows at most two posts (app/pages.py HOME_NEWS_MAX reserves their room).
const NEWS_MAX = 2;
const NEWS_FRESH_MS = 72 * 60 * 60 * 1000; // under 3 days reads as "new"
const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frosted-blue';

function isAbort(e) { return !!e && e.name === 'AbortError'; }

function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
}

function icon(name, cls) {
    var s = el('span', 'material-symbols-outlined' + (cls ? ' ' + cls : ''), name);
    s.setAttribute('aria-hidden', 'true');
    return s;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function arr(v) { return Array.isArray(v) ? v : []; }

/** True when `node` already shows `parts` (what it was last drawn from); else
    records them. A poll that brings nothing new rebuilds nothing, so no image
    is drawn twice and nothing open is closed. */
function unchanged(node, parts) {
    var sig = JSON.stringify(parts);
    if (node.getAttribute('data-sig') === sig) return true;
    node.setAttribute('data-sig', sig);
    return false;
}

function sentenceCase(s) {
    s = String(s || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

// ---- Status: what the strip says ----

/** How long, in the feed's words ("12 min", "1 h 5 min", "2 days 3 h"). */
export function durationText(ms) {
    var minutes = Math.floor(Math.max(ms, 0) / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    minutes = minutes % 60;
    if (hours < 24) return hours + ' h' + (minutes ? ' ' + minutes + ' min' : '');
    var days = Math.floor(hours / 24);
    hours = hours % 24;
    return days + ' day' + (days === 1 ? '' : 's') + (hours ? ' ' + hours + ' h' : '');
}

/** "9:40 PM" today, "Mon 9:40 PM" this week, else the date and time. */
export function whenText(date) {
    var now = new Date();
    var time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (date.toDateString() === now.toDateString()) return time;
    if (now - date < 6 * 86400000) return date.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + time;
}

function itemText(item) { return String((item && (item.text || item.message || item.title)) || ''); }

function itemDate(item, key) {
    var v = item && item[key];
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * What the strip shows for a feed answer (GET /api/status/feed: {state, open,
 * items}), or for no answer (failed). Pure, so the shape rule can be checked
 * against the server's (status_feed.home_shape):
 *   card  an outage or an important note is open: the newest outage (else
 *         the newest note), its time, and how many more there are;
 *   line  everything running ("ok"), or "Status unavailable right now" for
 *         anything that is not a clear "ok" (Uptime Kuma silent, the feed
 *         unreachable): it never claims all is well without the feed saying so;
 *         with no Uptime Kuma ("off") the newest note, when there is one;
 *   none  no Uptime Kuma and nothing posted in the feed's window.
 */
export function statusModel(feed, failed) {
    var unavailable = { shape: 'line', tone: 'unknown', text: 'Status unavailable right now' };
    if (failed || !feed || typeof feed !== 'object') {
        unavailable.meta = 'Checking again shortly';
        return unavailable;
    }
    var open = arr(feed.open);
    var items = arr(feed.items);
    if (open.length) {
        var outages = open.filter(function (i) { return i && i.source === 'auto'; });
        var lead = outages[0] || open[0];
        var meta;
        if (outages.length) {
            var began = itemDate(lead, 'started_at') || itemDate(lead, 'created_at');
            meta = began ? 'Since ' + whenText(began) + ', ' + durationText(Date.now() - began.getTime()) + ' so far' : '';
        } else {
            var posted = itemDate(lead, 'created_at');
            meta = posted ? 'Posted ' + getTimeAgo(posted) : '';
        }
        return { shape: 'card', tone: outages.length ? 'down' : 'note', text: itemText(lead), meta: meta, more: open.length - 1 };
    }
    var latest = items[0];
    var latestAt = latest ? (itemDate(latest, 'at') || itemDate(latest, 'created_at')) : null;
    var since = latestAt ? 'Last update ' + getTimeAgo(latestAt) : '';
    if (feed.state === 'ok') {
        return { shape: 'line', tone: 'ok', text: 'All services running', meta: since || 'Nothing new in 30 days' };
    }
    if (feed.state === 'off') {
        if (!latest) return { shape: 'none' };
        return { shape: 'line', tone: 'note', text: itemText(latest), meta: latestAt ? getTimeAgo(latestAt, true) : '' };
    }
    unavailable.meta = since || 'Checking again shortly';
    return unavailable;
}

const STATUS_LINK = 'group block rounded-card transition-colors ' + FOCUS;

/** The strip's node for a model (statusModel). Built like the skeletons in #homeStatus. */
function renderStatus(model) {
    var a = el('a');
    a.href = '/status';
    if (model.shape === 'card') {
        var tint = model.tone === 'down'
            ? ' bg-status-err/10 ring-1 ring-inset ring-status-err/40 hover:bg-status-err/[0.15]'
            : ' bg-primary/15 ring-1 ring-inset ring-primary/40 hover:bg-primary/20';
        a.className = STATUS_LINK + ' p-4' + tint;
        a.setAttribute('data-status-shape', 'card');
        var row = el('div', 'flex items-start gap-3');
        if (model.tone === 'down') {
            var light = el('span', 'ws-light ws-light-error mt-2');
            light.setAttribute('aria-hidden', 'true');
            row.appendChild(light);
        } else {
            row.appendChild(icon('campaign', 'text-[20px] leading-6 text-frosted-blue shrink-0'));
        }
        // Two title lines' room in all (the skeleton's), the spare under the
        // words and above the link, so a one-line title reads as one block.
        var body = el('div', 'min-w-0 flex-1 flex flex-col min-h-[6.75rem]');
        body.appendChild(el('p', 'text-lead leading-6 font-bold text-frosted-blue line-clamp-2 break-words', model.text));
        body.appendChild(el('p', 'text-label leading-5 text-frosted-blue/70 mt-1 truncate', model.meta || ''));
        var go = el('p', 'text-body leading-6 font-semibold text-frosted-blue mt-auto pt-3 flex items-center gap-1',
            model.more > 0 ? 'See all ' + (model.more + 1) + ' updates' : 'See all status updates');
        go.appendChild(icon('chevron_right', 'text-[20px]'));
        body.appendChild(go);
        row.appendChild(body);
        a.appendChild(row);
        return a;
    }
    a.className = STATUS_LINK + ' flex items-center gap-3 h-16 sm:h-12 px-4 bg-frosted-blue/[0.04] hover:bg-frosted-blue/[0.07]';
    a.setAttribute('data-status-shape', 'line');
    a.setAttribute('data-status-tone', model.tone);
    if (model.tone === 'ok') {
        a.appendChild(icon('check_circle', 'text-[20px] text-frosted-blue/70 shrink-0'));
    } else if (model.tone === 'note') {
        a.appendChild(icon('campaign', 'text-[20px] text-frosted-blue/70 shrink-0'));
    } else {
        var dot = el('span', 'ws-light ws-light-unconfigured');
        dot.setAttribute('aria-hidden', 'true');
        a.appendChild(dot);
    }
    var words = el('span', 'min-w-0 flex-1 flex flex-col sm:flex-row sm:items-baseline sm:gap-3');
    words.appendChild(el('span', 'text-body leading-6 font-semibold text-frosted-blue truncate', model.text));
    words.appendChild(el('span', 'text-label leading-5 text-frosted-blue/70 truncate', model.meta || ''));
    a.appendChild(words);
    a.appendChild(icon('chevron_right', 'text-[20px] text-frosted-blue/70 shrink-0'));
    return a;
}

// ---- Poster cards (requests, coming soon): the Books card, compact ----

/**
 * One poster card: a 2:3 cover that holds its shape before the picture
 * lands (a glyph behind it for a missing or failed one), a two-line title
 * room and one quiet line. The skeleton cards in #requestsRow and
 * #releasesContainer are this card, empty. Not a link: the section's own
 * links lead on, so nothing here looks clickable.
 */
function posterCard(o, signal) {
    var li = el('li', 'w-28 shrink-0');
    var cover = el('span', 'relative block aspect-[2/3] overflow-hidden rounded-xl bg-frosted-blue/[0.07]');
    var mark = el('span', 'absolute inset-0 flex items-center justify-center');
    mark.appendChild(icon(o.glyph || 'movie', 'text-[32px] text-frosted-blue/45'));
    cover.appendChild(mark);
    if (o.poster) {
        var img = el('img', 'absolute inset-0 h-full w-full object-cover');
        img.alt = '';
        img.width = 112;
        img.height = 168;
        // The first few are on a phone's first screen: asked for at once.
        img.loading = o.eager ? 'eager' : 'lazy';
        img.decoding = 'async';
        img.src = o.poster;
        img.addEventListener('error', function () { img.classList.add('hidden'); }, { once: true, signal: signal });
        cover.appendChild(img);
    }
    li.appendChild(cover);
    li.appendChild(el('p', 'mt-2 text-[15px] font-semibold leading-snug text-frosted-blue line-clamp-2 min-h-[2.75em] break-words', o.title || 'Untitled'));
    li.appendChild(el('p', 'text-[13px] leading-5 truncate min-h-5 ' + (o.strong ? 'font-semibold text-frosted-blue' : 'text-frosted-blue/70'), o.sub || ''));
    return li;
}

/**
 * A row's empty or error line in the room of one card, so the row is the
 * height its skeleton was. `text` is always a fixed string from this file.
 */
function rowMessage(row, text) {
    clear(row);
    var li = el('li', 'relative w-full rounded-card bg-frosted-blue/[0.04]');
    li.setAttribute('data-row-message', '');
    var shape = el('div', 'invisible w-28');
    shape.setAttribute('aria-hidden', 'true');
    shape.appendChild(el('div', 'aspect-[2/3]'));
    shape.appendChild(el('p', 'mt-2 text-[15px] leading-snug min-h-[2.75em]', ' '));
    shape.appendChild(el('p', 'text-[13px] leading-5 min-h-5', ' '));
    li.appendChild(shape);
    var msg = el('p', 'absolute inset-0 flex items-center justify-center px-4 text-center text-body text-frosted-blue/70', text);
    li.appendChild(msg);
    row.appendChild(li);
}

// ---- Requests ----

const REQUEST_GLYPHS = { movie: 'movie', tv: 'tv', book: 'menu_book', audiobook: 'headphones' };

/** One recent request as a poster card. Deliberately no requester: the row
    shows everyone's requests, and the API sends no name. */
function requestCard(req, signal, eager) {
    var status = WS.requestStatus(req.status || 'pending');
    return posterCard({
        eager: !!eager,
        title: req.media_title || 'Untitled',
        poster: req.poster_url || '',
        glyph: REQUEST_GLYPHS[req.media_type] || 'movie',
        sub: sentenceCase(status.label),
        strong: status.tone === 'ready'
    }, signal);
}

// ---- Coming soon ----

/** A TMDB poster at a card's size (w342 covers a 112px card at 3x) rather
    than the full-size original the calendars name; any other address as it is. */
export function posterSize(url) {
    var u = String(url || '');
    return u.replace(/^(https:\/\/image\.tmdb\.org\/t\/p\/)original\//, '$1w342/');
}

function dayText(date) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var day = new Date(date.getTime());
    day.setHours(0, 0, 0, 0);
    var diff = Math.round((day - today) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return date.toLocaleDateString(undefined, { weekday: 'long' });
}

/**
 * The week's releases as cards, one per title per day ("3 new episodes"
 * when a show has several), in date order. `releases` is GET
 * /api/integrations/upcoming-releases.
 */
export function releaseCards(releases, now) {
    var cards = [];
    var byKey = {};
    // From the start of today to a week on: the calendars also send older dates.
    var from = new Date((now || new Date()).getTime());
    from.setHours(0, 0, 0, 0);
    var to = from.getTime() + 7 * 86400000;
    arr(releases).forEach(function (r) {
        if (!r || !r.air_date) return;
        var when = new Date(r.air_date);
        if (isNaN(when.getTime()) || when < from || when.getTime() >= to) return;
        var key = (r.media_type || '') + '|' + (r.title || '') + '|' + when.toDateString();
        if (byKey[key]) { byKey[key].count += 1; return; }
        var card = { title: r.title || 'Untitled', poster: posterSize(r.poster_url), tv: r.media_type === 'tv',
                     episode: r.episode_code || '', when: when, count: 1 };
        byKey[key] = card;
        cards.push(card);
    });
    cards.sort(function (a, b) { return a.when - b.when; });
    return cards.map(function (c) {
        var what = c.tv ? (c.count > 1 ? c.count + ' new episodes' : (c.episode || 'New episode')) : 'Movie';
        return { title: c.title, poster: c.poster, glyph: c.tv ? 'tv' : 'movie', sub: dayText(c.when) + ', ' + what };
    });
}

// ---- News ----

function newsSettings(branding) {
    var cfg = (branding || {}).news || {};
    return {
        count: Math.min(NEWS_MAX, cfg.homepage_count || 3),
        maxAgeDays: cfg.homepage_max_age_days === 0 ? 0 : (cfg.homepage_max_age_days || 30)
    };
}

/** A post's words, read from its sanitized HTML in an inert document (no
    image or script in it ever runs): one string per block. */
export function newsParagraphs(html) {
    var doc = new DOMParser().parseFromString('<body>' + (html || ''), 'text/html');
    var blocks = doc.body.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, pre');
    var out = [];
    if (blocks.length) {
        blocks.forEach(function (b) {
            if (b.querySelector('p, li')) return;   // its inner blocks speak for it
            var t = (b.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) out.push(t);
        });
    }
    if (!out.length) {
        var all = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
        if (all) out.push(all);
    }
    return out;
}

function newsDate(date) {
    if (Date.now() - date.getTime() < 604800000) return getTimeAgo(date, true);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * One post as a card, collapsed: the title (two lines' room on a phone, one
 * from sm), when, a three-line excerpt and Read more, which opens the whole
 * post in place. The skeleton cards in #newsContainer are this card, empty.
 */
function newsCard(post) {
    var created = new Date(post.created_at);
    var fresh = (Date.now() - created.getTime()) < NEWS_FRESH_MS;
    var card = el('article', 'bg-frosted-blue/[0.04] rounded-card p-4 min-w-0');
    var title = el('h3', 'text-lead leading-6 font-bold text-frosted-blue break-words line-clamp-2 min-h-12 sm:line-clamp-1 sm:min-h-6', post.title || '');
    title.setAttribute('data-news-title', '');
    card.appendChild(title);
    var meta = el('p', 'text-label leading-5 mt-0.5 text-frosted-blue/70 flex items-center gap-2 min-w-0');
    if (post.pinned || fresh) {
        meta.appendChild(el('span', 'shrink-0 inline-flex items-center h-5 px-2 rounded-full bg-primary/20 font-semibold text-frosted-blue',
            post.pinned ? 'Pinned' : 'New'));
    }
    meta.appendChild(el('span', 'truncate', isNaN(created.getTime()) ? '' : newsDate(created)));
    card.appendChild(meta);
    var paragraphs = newsParagraphs(post.content_html);
    var excerpt = el('p', 'text-body leading-6 mt-2 text-frosted-blue/70 line-clamp-3 min-h-[4.5rem]', paragraphs.join(' '));
    excerpt.setAttribute('data-news-excerpt', '');
    card.appendChild(excerpt);
    var full = el('div', 'hidden mt-2 space-y-2 text-body leading-6 text-frosted-blue/80');
    full.setAttribute('data-news-body', '');
    paragraphs.forEach(function (t) { full.appendChild(el('p', 'break-words', t)); });
    card.appendChild(full);
    var toggle = el('button', 'mt-2 inline-flex items-center gap-1 text-label leading-5 font-semibold text-frosted-blue/70 hover:text-frosted-blue rounded-btn ' + FOCUS);
    toggle.type = 'button';
    toggle.setAttribute('data-news-toggle', '');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.appendChild(el('span', '', 'Read more'));
    // A post that fits its excerpt has nothing more to show; the button keeps its room.
    if (paragraphs.join(' ').length <= 160) toggle.classList.add('invisible');
    card.appendChild(toggle);
    return card;
}

function toggleNewsCard(btn) {
    var card = btn.parentElement;
    var full = card.querySelector('[data-news-body]');
    var excerpt = card.querySelector('[data-news-excerpt]');
    var title = card.querySelector('[data-news-title]');
    if (!full) return;
    var open = btn.getAttribute('aria-expanded') !== 'true';
    full.classList.toggle('hidden', !open);
    if (excerpt) excerpt.classList.toggle('hidden', open);
    if (title) {
        ['line-clamp-2', 'min-h-12', 'sm:line-clamp-1', 'sm:min-h-6'].forEach(function (c) { title.classList.toggle(c, !open); });
    }
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.firstChild.textContent = open ? 'Show less' : 'Read more';
}

// ---- Streams ----

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

function clampPercent(n) { return Math.min(100, Math.max(0, Math.round(n) || 0)); }

/**
 * One stream's card: the artwork, the title, how well it is playing and how
 * far along it is. Never who is watching. The quality words keep the pure
 * status colours (the owner's exception to R140). "Why?" opens the reason
 * under a lower-quality stream. preview: the admin's sample preview is on (a
 * mark over the artwork says so). The skeleton cards in #streamsContainer
 * are this card, empty.
 */
function streamCard(stream, preview, signal) {
    var card = el('article', 'w-[17rem] sm:w-72 shrink-0 bg-frosted-blue/[0.04] rounded-card overflow-hidden');
    var art = el('div', 'relative aspect-video bg-frosted-blue/[0.07]');
    var mark = el('span', 'absolute inset-0 flex items-center justify-center');
    mark.appendChild(icon('movie', 'text-[32px] text-frosted-blue/45'));
    art.appendChild(mark);
    if (stream.thumb_url) {
        var img = el('img', 'absolute inset-0 h-full w-full object-cover');
        img.alt = '';
        img.width = 288;
        img.height = 162;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = stream.thumb_url;
        img.addEventListener('error', function () { img.classList.add('hidden'); }, { once: true, signal: signal });
        art.appendChild(img);
    }
    if (preview) art.appendChild(el('span', 'absolute top-3 left-3 inline-flex items-center h-6 px-2 rounded-full bg-background-dark/80 text-label font-semibold text-frosted-blue', 'Sample'));
    card.appendChild(art);

    var body = el('div', 'p-4');
    var name = String(stream.title || 'Untitled');
    if (stream.episode_info) name += ', ' + stream.episode_info;
    else if (stream.year) name += ' (' + stream.year + ')';
    body.appendChild(el('p', 'text-body leading-6 font-semibold text-frosted-blue truncate', name));

    var decision = String(stream.decision || 'Direct Play').toLowerCase();
    var line = el('p', 'text-label leading-5 mt-1 flex items-center gap-2 min-w-0');
    if (decision === 'transcode' || decision === 'transcoding') {
        line.appendChild(el('span', 'text-status-warn font-semibold truncate', 'Not playing at full quality'));
        var why = el('button', 'shrink-0 text-status-warn underline underline-offset-2 rounded-btn ' + FOCUS, 'Why?');
        why.type = 'button';
        why.setAttribute('data-action', 'stream-info');
        why.setAttribute('aria-expanded', 'false');
        line.appendChild(why);
    } else {
        line.appendChild(el('span', 'text-status-ok font-semibold truncate', 'Full quality'));
    }
    body.appendChild(line);
    if (decision === 'transcode' || decision === 'transcoding') {
        var from = stream.source_height ? stream.source_height + 'p' : String(stream.source_quality || 'its full quality');
        var to = stream.stream_height ? stream.stream_height + 'p' : String(stream.stream_quality || 'a lower quality');
        var reason = el('p', 'hidden mt-2 text-label leading-5 text-frosted-blue/80',
            'The file is ' + from + ' but it is playing at ' + to + '. Set the quality to Original in your Plex app for the best picture.');
        reason.setAttribute('data-stream-reason', '');
        body.appendChild(reason);
    }

    var pct = clampPercent(stream.progress);
    var track = el('div', 'mt-3 h-1 rounded-full bg-frosted-blue/10 overflow-hidden');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', 'Progress');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(pct));
    var fill = el('div', 'h-full rounded-full bg-primary');
    fill.style.width = pct + '%';
    track.appendChild(fill);
    body.appendChild(track);
    card.appendChild(body);
    return card;
}

/** The streams row's empty or error line, in the room of one card. */
function streamsMessage(container, text) {
    clear(container);
    container.removeAttribute('data-sig');   // the next streams are drawn
    var box = el('div', 'relative w-full rounded-card bg-frosted-blue/[0.04]');
    box.setAttribute('data-row-message', '');
    var shape = el('div', 'invisible w-[17rem] sm:w-72');
    shape.setAttribute('aria-hidden', 'true');
    shape.appendChild(el('div', 'aspect-video'));
    var inner = el('div', 'p-4');
    inner.appendChild(el('p', 'text-body leading-6', ' '));
    inner.appendChild(el('p', 'text-label leading-5 mt-1', ' '));
    inner.appendChild(el('div', 'mt-3 h-1'));
    shape.appendChild(inner);
    box.appendChild(shape);
    box.appendChild(el('p', 'absolute inset-0 flex items-center justify-center px-4 text-center text-body text-frosted-blue/70', text));
    container.appendChild(box);
}

// ---- Services ----

// Homelab icon mapping: service name substring to selfh.st icon slug.
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
    var lower = String(name || '').toLowerCase();
    for (var key in HOMELAB_ICONS) {
        if (lower.indexOf(key) !== -1) {
            return 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/' + HOMELAB_ICONS[key] + '.svg';
        }
    }
    return null;
}

// A service's state in words, and its order on the row: problems first.
// Colour only on a problem (the contract: a healthy state is quiet).
const SERVICE_STATES = {
    down:        { label: 'Down',        rank: 0, light: 'ws-light-error', words: 'text-status-err-text font-semibold', tile: 'bg-status-err/10' },
    degraded:    { label: 'Slow',        rank: 1, light: 'ws-light-warn',  words: 'text-status-warn-text font-semibold', tile: 'bg-status-warn/10' },
    maintenance: { label: 'Maintenance', rank: 2, light: 'ws-light-unconfigured', words: 'text-frosted-blue/70', tile: 'bg-frosted-blue/[0.04]' },
    unknown:     { label: 'Unknown',     rank: 3, light: 'ws-light-unconfigured', words: 'text-frosted-blue/70', tile: 'bg-frosted-blue/[0.04]' },
    up:          { label: 'Running',     rank: 4, light: '',               words: 'text-frosted-blue/70', tile: 'bg-frosted-blue/[0.04]' }
};

/** The services in row order: problems first, otherwise as Uptime Kuma lists them. */
export function orderServices(list) {
    return arr(list).map(function (svc, i) {
        var s = SERVICE_STATES[svc && svc.status] ? svc.status : 'unknown';
        return { name: (svc && svc.name) || 'Unknown', status: s, icon: (svc && svc.icon) || 'dns', last_check: svc && svc.last_check, i: i };
    }).sort(function (a, b) {
        return (SERVICE_STATES[a.status].rank - SERVICE_STATES[b.status].rank) || (a.i - b.i);
    });
}

/** One service tile; the skeleton tiles in #servicesContainer are this tile, empty. */
function serviceTile(svc, signal) {
    var state = SERVICE_STATES[svc.status];
    var li = el('li', 'w-28 shrink-0 rounded-inner p-3 ' + state.tile);
    li.setAttribute('data-service-state', svc.status);
    var box = el('div', 'flex flex-col items-center text-center');
    var url = getServiceIconUrl(svc.name);
    if (url) {
        var img = el('img', 'size-8 object-contain');
        img.alt = '';
        img.width = 32;
        img.height = 32;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = url;
        img.addEventListener('error', function () { img.classList.add('invisible'); }, { once: true, signal: signal });
        box.appendChild(img);
    } else {
        box.appendChild(icon(String(svc.icon), 'text-[32px] leading-8 size-8 text-frosted-blue/70'));
    }
    box.appendChild(el('span', 'mt-2 text-label leading-5 min-h-10 line-clamp-2 text-frosted-blue break-words', svc.name));
    var status = el('span', 'inline-flex items-center gap-1.5 text-label leading-5 ' + state.words);
    if (state.light) {
        var light = el('span', 'ws-light ' + state.light);
        light.setAttribute('aria-hidden', 'true');
        status.appendChild(light);
    }
    status.appendChild(el('span', '', state.label));
    box.appendChild(status);
    li.appendChild(box);
    return li;
}

export async function mount(ctx) {
    var root = ctx.root;
    var signal = ctx.signal;
    var html = document.documentElement;
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
    var _lastStreams = null;   // the last streams shown: a transient empty answer keeps them
    var _samples = null;

    // Admin-only preview, /?preview=streams: three sample streams through the
    // same renderer as real ones, so the card can be looked at with nothing
    // playing. Set below only when the server marked the page for an admin
    // (data-admin on <html>) and the session user is an admin; a member's URL
    // flag does nothing. While it is on, loadActiveStreams (and so the 30s
    // poll) renders the samples and never fetches, so nothing overwrites them.
    var _streamsPreview = false;

    // ---- Status ----

    function loadStatus() {
        return WS.swr('status:feed', function () {
            return WS.getJSON('/api/status/feed?days=30', { signal: signal });
        }, function (feed) { drawStatus(statusModel(feed, false)); }, {
            maxAge: 60 * 1000,
            onError: function (error) {
                if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                // Not reachable: never "all running".
                drawStatus(statusModel(null, true));
            }
        });
    }

    function drawStatus(model) {
        if (signal.aborted) return;
        WS.arrive('status', function () {
            if (signal.aborted) return;
            var host = byId('homeStatus');
            // The shape the CSS gives the section (none hides it); the server
            // marked the first one.
            if (html.getAttribute('data-home-status') !== model.shape) html.setAttribute('data-home-status', model.shape);
            host.setAttribute('aria-busy', 'false');
            if (model.shape === 'none') { clear(host); return; }
            var next = renderStatus(model);
            var now = host.firstElementChild;
            if (now && host.children.length === 1 && now.isEqualNode(next)) return;   // a poll that changed nothing
            clear(host);
            host.appendChild(next);
        });
    }

    // ---- News ----

    function loadNews() {
        var cfg = newsSettings(branding);
        var url = '/api/news/?limit=' + cfg.count;
        if (cfg.maxAgeDays > 0) url += '&max_age_days=' + cfg.maxAgeDays;

        return WS.swr('news:' + url, function () { return WS.getJSON(url, { signal: signal }); }, renderNews, {
            onError: function (error) {
                if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                WS.arrive('news', function () {
                    byId('newsContainer').removeAttribute('data-sig');
                    newsMessage('News can’t be shown right now.');
                });
            }
        });
    }

    // The empty and error line keeps the room the server reserved (one card,
    // or the empty line's), so nothing under it moves.
    function newsMessage(text) {
        var container = byId('newsContainer');
        clear(container);
        var reserved = Number(html.getAttribute('data-home-news'));
        if (!(reserved > 0)) {
            var line = el('p', 'h-12 flex items-center text-body text-frosted-blue/70', text);
            line.setAttribute('data-news-message', '');
            container.appendChild(line);
            return;
        }
        // As many empty cards as were reserved, the line over them.
        for (var i = 0; i < Math.min(reserved, NEWS_MAX); i++) {
            var shape = el('div', 'rounded-card p-4 min-w-0 bg-frosted-blue/[0.04]');
            shape.setAttribute('aria-hidden', 'true');
            shape.appendChild(el('p', 'text-lead leading-6 min-h-12 sm:min-h-6', ' '));
            shape.appendChild(el('p', 'text-label leading-5 mt-0.5', ' '));
            shape.appendChild(el('p', 'text-body leading-6 mt-2 min-h-[4.5rem]', ' '));
            shape.appendChild(el('p', 'mt-2 text-label leading-5', ' '));
            container.appendChild(shape);
        }
        var msg = el('p', 'absolute inset-0 flex items-center justify-center px-4 text-center text-body text-frosted-blue/70', text);
        msg.setAttribute('data-news-message', '');
        container.appendChild(msg);
    }

    function renderNews(posts) {
        if (signal.aborted) return;   // left: the next page owns the arrival order now
        var cfg = newsSettings(branding);
        WS.arrive('news', function () {
            var shown = arr(posts).slice(0, cfg.count);
            var container = byId('newsContainer');
            if (unchanged(container, shown.map(function (p) { return [p.id, p.title, p.content_html, p.created_at, p.pinned]; }))) return;
            if (!shown.length) { newsMessage('Nothing posted yet.'); return; }
            clear(container);
            shown.forEach(function (post) { container.appendChild(newsCard(post)); });
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

    // ---- How many requests wait (the nav badge, and the admins' link) ----

    async function loadRequestCount() {
        // The Requests nav item carries the badge in the desktop sidebar and in
        // the phone's tab bar or More sheet; there is none while Requests is
        // switched off. Admins also see the count on Home.
        const badges = document.querySelectorAll('[data-badge="requestsBadge"]');
        const waiting = html.hasAttribute('data-admin') ? byId('requestsWaiting') : null;
        if (!badges.length && !waiting) return;
        let pending = 0;
        try {
            const response = await fetch('/api/integrations/request-counts', { signal: signal });
            if (!response.ok) throw new Error('API error');
            const counts = await response.json();
            pending = Number(counts.pending) || 0;
        } catch (e) {
            if (signal.aborted || isAbort(e)) return;   // left the page: the badge keeps its count
            pending = 0;
        }
        if (signal.aborted) return;
        badges.forEach(function (badge) {
            badge.textContent = pending > 0 ? pending : '';
            badge.classList.toggle('hidden', !(pending > 0));
        });
        if (waiting) {
            // It held its room, unseen, from the first paint.
            waiting.textContent = pending > 0 ? pending + ' waiting for approval' : '';
            waiting.classList.toggle('invisible', !(pending > 0));
        }
    }

    // ---- Recent requests ----

    function loadRecentRequests() {
        return WS.swr('recent-requests', function () { return WS.getJSON('/api/integrations/recent-requests', { signal: signal }); }, renderRecentRequests, {
            onError: function (error) {
                if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                WS.arrive('requests', function () {
                    var row = byId('requestsRow');
                    row.removeAttribute('data-sig');   // the next answer is drawn, whatever it is
                    rowMessage(row, 'Recent requests can’t be shown right now.');
                });
            }
        });
    }

    function renderRecentRequests(requests) {
        if (signal.aborted) return;
        WS.arrive('requests', function () {
            var row = byId('requestsRow');
            var list = arr(requests);
            if (unchanged(row, list.map(function (r) { return [r.media_title, r.media_type, r.poster_url, r.status]; }))) return;
            if (!list.length) { rowMessage(row, 'Nothing has been requested yet.'); return; }
            clear(row);
            list.forEach(function (req, i) { row.appendChild(requestCard(req, signal, i < 3)); });
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
                // On error, keep showing previous data if available
                if (_lastStreams && _lastStreams.length > 0) return;
                WS.arrive('streams', function () {
                    streamsMessage(byId('streamsContainer'), 'Can’t show what’s playing right now.');
                });
            }
        });
    }

    function renderActiveStreams(streams) {
        if (signal.aborted) return;
        // An empty answer after streams were showing keeps them: Plex answers
        // empty for a moment now and then, and they would blink away and back.
        if ((!Array.isArray(streams) || streams.length === 0) && _lastStreams && _lastStreams.length > 0) {
            return;
        }
        _lastStreams = streams;
        WS.arrive('streams', function () {
            var container = byId('streamsContainer');
            if (!Array.isArray(streams) || streams.length === 0) {
                streamsMessage(container, 'Nothing is playing right now.');
                return;
            }
            // Only rebuilt when something changed, so an open "Why?" stays open.
            if (unchanged(container, streams.map(function (s) {
                return [s.session_id, s.title, s.decision, clampPercent(s.progress), s.thumb_url];
            }))) return;
            clear(container);
            streams.forEach(function (stream) {
                container.appendChild(streamCard(stream, _streamsPreview, signal));
            });
        });
    }

    // ---- Services ----

    function loadServices() {
        // One request shared with the header pill (WS.serviceStatus), cached for
        // the next visit. It never rejects: an unreachable monitor reads as none.
        return WS.swr('services', WS.serviceStatus, renderServices);
    }

    function renderServices(data) {
        if (signal.aborted) return;   // the shared answer landed after the page was left
        var services = orderServices(data);
        WS.arrive('services', function () {
            var row = byId('servicesContainer');
            if (services.length === 0) {
                clear(row);
                row.removeAttribute('data-sig');
                var li = el('li', 'relative w-full rounded-inner bg-frosted-blue/[0.04]');
                li.setAttribute('data-row-message', '');
                var shape = el('div', 'invisible w-28 p-3 flex flex-col items-center');
                shape.setAttribute('aria-hidden', 'true');
                shape.appendChild(el('span', 'size-8'));
                shape.appendChild(el('span', 'mt-2 text-label leading-5 min-h-10', ' '));
                shape.appendChild(el('span', 'text-label leading-5', ' '));
                li.appendChild(shape);
                li.appendChild(el('p', 'absolute inset-0 flex items-center justify-center px-4 text-center text-body text-frosted-blue/70', 'Service details aren’t available right now.'));
                row.appendChild(li);
                return;
            }
            var latest = null;
            services.forEach(function (svc) {
                if (svc.last_check) {
                    var d = new Date(svc.last_check + 'Z');
                    if (!isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
                }
            });
            var timer = byId('serviceLastChecked');
            if (timer && latest) {
                timer.dataset.lastCheck = latest.toISOString();
                timer.textContent = 'Checked ' + getTimeAgo(latest);
            }
            if (unchanged(row, services.map(function (s) { return [s.name, s.status, s.icon]; }))) return;
            clear(row);
            services.forEach(function (svc) { row.appendChild(serviceTile(svc, signal)); });
        });
    }

    // "Checked 12 seconds ago" over the tiles, kept current between refreshes.
    function tickLastChecked() {
        var t = byId('serviceLastChecked');
        if (t && t.dataset.lastCheck) {
            var words = 'Checked ' + getTimeAgo(new Date(t.dataset.lastCheck));
            if (t.textContent !== words) t.textContent = words;
        }
    }

    // ---- Upcoming releases ----

    function loadUpcomingReleases() {
        return WS.swr('releases:7', function () { return WS.getJSON('/api/integrations/upcoming-releases?days=7', { signal: signal }); }, renderUpcomingReleases, {
            onError: function (error) {
                if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                WS.arrive('releases', function () {
                    var row = byId('releasesContainer');
                    row.removeAttribute('data-sig');
                    rowMessage(row, 'The release calendar isn’t available right now.');
                });
            }
        });
    }

    function renderUpcomingReleases(releases) {
        if (signal.aborted) return;
        WS.arrive('releases', function () {
            var row = byId('releasesContainer');
            var cards = releaseCards(releases);
            if (unchanged(row, cards)) return;
            if (!cards.length) { rowMessage(row, 'Nothing new is due in the next week.'); return; }
            clear(row);
            cards.forEach(function (c) { row.appendChild(posterCard(c, signal)); });
        });
    }

    // ---- The server's gauges (Netdata) ----

    function setGauge(name, pct) {
        var circle = byId(name + 'GaugeCircle');
        if (!circle) return;
        var next = 251 - (251 * Math.min(Math.max(Number(pct) || 0, 0), 100) / 100);
        // Under half a percent of change is not worth a repaint.
        if (Math.abs((parseFloat(circle.style.strokeDashoffset) || 0) - next) < 1.25) return;
        circle.style.strokeDashoffset = next;
    }

    function setText(id, text) {
        var node = byId(id);
        if (node && node.textContent !== text) node.textContent = text;
    }

    async function loadSystemStats() {
        // No Netdata (the gauges are hidden from the first paint), or scrolled
        // out of sight: nothing to read this second.
        if (!html.hasAttribute('data-netdata')) return;
        var box = byId('netdataGauges');
        if (box && box.getBoundingClientRect) {
            var r = box.getBoundingClientRect();
            if (r.height && (r.bottom < 0 || r.top > (window.innerHeight || 0))) return;
        }
        try {
            var response = await fetch('/api/integrations/system-stats', { signal: signal });
            if (!response.ok) throw new Error('API error');
            var stats = await response.json();
            if (signal.aborted || !stats.configured || stats.error) return;

            if (stats.cpu_percent !== null && stats.cpu_percent !== undefined) {
                setText('cpuGaugeText', Math.round(stats.cpu_percent) + '%');
                setGauge('cpu', stats.cpu_percent);
            }
            if (stats.cpu_label) setText('cpuGaugeDetail', String(stats.cpu_label));
            else if (stats.cpu_cores) setText('cpuGaugeDetail', stats.cpu_cores + ' threads');

            if (stats.ram_percent !== null && stats.ram_percent !== undefined) {
                setText('ramGaugeText', Math.round(stats.ram_percent) + '%');
                setGauge('ram', stats.ram_percent);
            }
            if (stats.ram_label) setText('ramGaugeDetail', String(stats.ram_label));
            else if (stats.ram_used_mb != null && stats.ram_total_mb != null) {
                setText('ramGaugeDetail', (stats.ram_used_mb / 1024).toFixed(1) + ' of ' + (stats.ram_total_mb / 1024).toFixed(0) + ' GB');
            }

            var dl = stats.net_download_mbps != null ? Number(stats.net_download_mbps) : 0;
            var ul = stats.net_upload_mbps != null ? Number(stats.net_upload_mbps) : 0;
            setText('netDownText', dl.toFixed(1));
            setText('netUpText', ul.toFixed(1));
            setText('netGaugeDetail', stats.net_label ? String(stats.net_label) : (stats.net_unit === 'MBps' ? 'MB/s' : 'Mbps'));
            var netMax = stats.net_max || 1000;
            setGauge('net', (dl + ul) / netMax * 100);
        } catch (error) {
            if (signal.aborted || isAbort(error)) return;   // left the page: not an error
            // The gauges keep their last reading.
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
        if (btn.getAttribute('data-action') === 'stream-info') {
            // The reason sits under the quality line.
            var reason = btn.closest('article') && btn.closest('article').querySelector('[data-stream-reason]');
            if (!reason) return;
            var open = reason.classList.toggle('hidden') === false;
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
    }, { signal: signal });

    // Mouse drag and wheel for the sideways rows (a finger and a trackpad already work).
    ['servicesContainer', 'requestsRow', 'releasesContainer', 'streamsContainer'].forEach(function (id) {
        var row = byId(id);
        if (row && window.WS && typeof WS.dragScroll === 'function') WS.dragScroll(row, { signal: signal });
    });

    const user = await checkAuth();
    if (!user || signal.aborted) return;
    _streamsPreview = ctx.url.searchParams.get('preview') === 'streams' &&
        user.is_admin === true && document.documentElement.hasAttribute('data-admin');

    var first = [];
    first.push(loadStatus());   // the strip: not a switchable section
    if (sectionOn('services')) { first.push(loadServices()); first.push(loadSystemStats()); }
    if (sectionOn('requests')) first.push(loadRecentRequests());
    if (sectionOn('news')) first.push(loadNews());
    if (continueHost && booksOn) first.push(loadContinue());
    if (sectionOn('streams')) first.push(loadActiveStreams());
    if (sectionOn('releases')) first.push(loadUpcomingReleases());
    first.push(loadRequestCount());   // the nav badge and the admins' count, not a home section

    // Auto-refresh dynamic sections every 30 seconds (paused in background tabs)
    ctx.poll(function() {
        loadStatus();
        if (sectionOn('services')) loadServices();
        if (sectionOn('streams')) loadActiveStreams();
        if (sectionOn('requests')) loadRecentRequests();
        if (sectionOn('releases')) loadUpcomingReleases();
        loadRequestCount();
    }, 30000);

    if (sectionOn('services')) {
        // The gauges are read every second while they are on screen (loadSystemStats).
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
}
