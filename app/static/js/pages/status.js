/**
 * WebServarr: Status (page module)
 *
 * The status feed (GET /api/status/feed?days=30: {state, open, items}; spec
 * docs/superpowers/specs/2026-10-04-home-redesign-and-status-feed-design.md,
 * section 3): what is happening now, pinned (open outages and important
 * notes), or the one-line state when nothing is; then the last 30 days,
 * newest first, by day. Home's status strip links here.
 *
 * The state line never says "All services running" unless the feed says
 * "ok": Uptime Kuma silent ("unavailable") or the feed unreachable reads
 * "Status unavailable right now". With no Uptime Kuma ("off") there is no
 * line, only the notes.
 *
 * Admins post a short note ("Post a note" opens the form above the feed;
 * POST /api/status/notes), and resolve or delete their notes from the feed.
 * The button and the note tools are admin-only from the first paint
 * (ws-admin-only); every write is checked again by the server.
 *
 * A soft-navigation page (spec 4.2): everything runs from mount(ctx) and
 * ends with ctx.signal. Every node is built with textContent.
 */

const FEED_URL = '/api/status/feed?days=30';
const NOTE_MAX = 280;
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

function arr(v) { return Array.isArray(v) ? v : []; }

function itemText(item) { return String((item && (item.text || item.message || item.title)) || ''); }

function itemDate(item, key) {
    var v = item && item[key];
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

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

function timeText(date) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Today", "Yesterday", else "Monday, September 28". */
export function dayLabel(date, now) {
    var today = new Date((now || new Date()).getTime());
    today.setHours(0, 0, 0, 0);
    var day = new Date(date.getTime());
    day.setHours(0, 0, 0, 0);
    var diff = Math.round((today - day) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/** The history, by day, newest first: [{ label, items }]. */
export function groupByDay(items, now) {
    var groups = [];
    var byLabel = {};
    arr(items).forEach(function (item) {
        var at = itemDate(item, 'at') || itemDate(item, 'created_at');
        if (!at) return;
        var label = dayLabel(at, now);
        if (!byLabel[label]) { byLabel[label] = { label: label, items: [] }; groups.push(byLabel[label]); }
        byLabel[label].items.push({ item: item, at: at });
    });
    return groups;
}

/** The one-line state for a feed with nothing open: null for "off". */
export function stateLine(feed, failed) {
    if (failed || !feed) return { tone: 'unknown', text: 'Status unavailable right now' };
    if (feed.state === 'ok') return { tone: 'ok', text: 'All services running' };
    if (feed.state === 'off') return null;
    return { tone: 'unknown', text: 'Status unavailable right now' };
}

function lineNode(line) {
    var box = el('div', 'flex items-center gap-3 h-16 sm:h-12 px-4 rounded-card bg-frosted-blue/[0.04]');
    box.setAttribute('data-state-line', line.tone);
    if (line.tone === 'ok') {
        box.appendChild(icon('check_circle', 'text-[20px] text-frosted-blue/70 shrink-0'));
    } else {
        var dot = el('span', 'ws-light ws-light-unconfigured');
        dot.setAttribute('aria-hidden', 'true');
        box.appendChild(dot);
    }
    box.appendChild(el('p', 'text-body font-semibold text-frosted-blue', line.text));
    return box;
}

/** Admin tools on one note: resolve (while open) and delete. */
function noteTools(item) {
    var tools = el('div', 'ws-admin-only mt-2 -ml-2 flex flex-wrap gap-1');
    if (item.source !== 'admin') return null;
    var id = String(item.id);
    if (!item.resolved) {
        var resolve = el('button', 'inline-flex items-center gap-1 h-8 px-2 rounded-btn text-label font-semibold text-frosted-blue/70 hover:text-frosted-blue hover:bg-frosted-blue/[0.06] ' + FOCUS);
        resolve.type = 'button';
        resolve.setAttribute('data-note-action', 'resolve');
        resolve.setAttribute('data-id', id);
        resolve.appendChild(icon('check', 'text-[18px]'));
        resolve.appendChild(el('span', '', 'Mark resolved'));
        tools.appendChild(resolve);
    }
    var del = el('button', 'inline-flex items-center gap-1 h-8 px-2 rounded-btn text-label font-semibold text-frosted-blue/70 hover:text-frosted-blue hover:bg-frosted-blue/[0.06] ' + FOCUS);
    del.type = 'button';
    del.setAttribute('data-note-action', 'delete');
    del.setAttribute('data-id', id);
    del.appendChild(icon('delete', 'text-[18px]'));
    del.appendChild(el('span', '', 'Delete'));
    tools.appendChild(del);
    return tools;
}

/** One open outage or important note, as a card. */
function openCard(item) {
    var outage = item.source === 'auto';
    var card = el('article', 'rounded-card p-4 ' + (outage
        ? 'bg-status-err/10 ring-1 ring-inset ring-status-err/40'
        : 'bg-primary/15 ring-1 ring-inset ring-primary/40'));
    card.setAttribute('data-open', outage ? 'outage' : 'note');
    var row = el('div', 'flex items-start gap-3');
    if (outage) {
        var light = el('span', 'ws-light ws-light-error mt-2');
        light.setAttribute('aria-hidden', 'true');
        row.appendChild(light);
    } else {
        row.appendChild(icon('campaign', 'text-[20px] leading-6 text-frosted-blue shrink-0'));
    }
    var body = el('div', 'min-w-0 flex-1');
    body.appendChild(el('p', 'text-lead leading-6 font-bold text-frosted-blue break-words', itemText(item)));
    var meta;
    if (outage) {
        var began = itemDate(item, 'started_at') || itemDate(item, 'created_at');
        meta = began ? 'Since ' + timeText(began) + (dayLabel(began) === 'Today' ? '' : ', ' + dayLabel(began)) +
            '. Down ' + durationText(Date.now() - began.getTime()) + ' so far.' : '';
    } else {
        var posted = itemDate(item, 'created_at');
        meta = posted ? 'Posted ' + getTimeAgo(posted) : '';
    }
    body.appendChild(el('p', 'text-label leading-5 text-frosted-blue/70 mt-1', meta));
    var tools = noteTools(item);
    if (tools) body.appendChild(tools);
    row.appendChild(body);
    card.appendChild(row);
    return card;
}

/** One history row: the time, then what happened. */
function historyRow(entry) {
    var item = entry.item;
    var li = el('li', 'flex gap-4 py-3');
    li.appendChild(el('span', 'w-20 shrink-0 text-label leading-6 text-frosted-blue/70 tabular-nums', timeText(entry.at)));
    var body = el('div', 'min-w-0 flex-1');
    body.appendChild(el('p', 'text-body leading-6 text-frosted-blue break-words', itemText(item)));
    var meta = [];
    if (item.source === 'admin') meta.push(item.resolved ? 'Note from the admin, resolved' : 'Note from the admin');
    if (item.service && item.source === 'admin') meta.push(String(item.service));
    if (meta.length) body.appendChild(el('p', 'text-label leading-5 text-frosted-blue/70', meta.join(', ')));
    var tools = noteTools(item);
    if (tools) body.appendChild(tools);
    li.appendChild(body);
    return li;
}

/** The whole feed (what replaces the skeleton). */
export function renderFeed(feed, failed) {
    var wrap = el('div', '');
    var open = failed ? [] : arr(feed && feed.open);
    if (open.length) {
        wrap.appendChild(el('h2', 'mb-3 font-bold leading-snug text-xl text-frosted-blue', 'Happening now'));
        var list = el('div', 'space-y-3');
        open.forEach(function (item) { list.appendChild(openCard(item)); });
        wrap.appendChild(list);
    } else {
        var line = stateLine(feed, failed);
        if (line) wrap.appendChild(lineNode(line));
    }
    var history = el('section', wrap.firstChild ? 'mt-8' : '');
    history.setAttribute('aria-labelledby', 'statusHistoryTitle');
    var h = el('h2', 'mb-3 font-bold leading-snug text-xl text-frosted-blue', 'Last 30 days');
    h.id = 'statusHistoryTitle';
    history.appendChild(h);
    if (failed) {
        history.appendChild(el('p', 'text-body text-frosted-blue/70', 'The status history can’t be shown right now. Try again in a minute.'));
    } else {
        var groups = groupByDay(feed && feed.items);
        if (!groups.length) {
            history.appendChild(el('p', 'text-body text-frosted-blue/70', 'Nothing to report in the last 30 days.'));
        }
        groups.forEach(function (g) {
            history.appendChild(el('h3', 'mt-4 text-body font-semibold text-frosted-blue/70', g.label));
            var ol = el('ol', 'divide-y divide-frosted-blue/[0.07]');
            g.items.forEach(function (entry) { ol.appendChild(historyRow(entry)); });
            history.appendChild(ol);
        });
    }
    wrap.appendChild(history);
    return wrap;
}

function send(method, url, body) {
    var init = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    return window.fetch(url, init).then(function (r) {
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json().catch(function () { return null; });
    });
}

function toast(text, tone) {
    if (window.WSUI && typeof window.WSUI.toast === 'function') window.WSUI.toast(text, tone);
}

export async function mount(ctx) {
    var root = ctx.root;
    var signal = ctx.signal;
    var host = root.querySelector('#statusFeed');
    var isAdmin = document.documentElement.hasAttribute('data-admin');

    function draw(feed, failed) {
        if (signal.aborted) return;
        WS.arrive('feed', function () {
            if (signal.aborted) return;
            var next = renderFeed(feed, failed);
            var now = host.firstElementChild;
            host.setAttribute('aria-busy', 'false');
            if (now && host.children.length === 1 && now.isEqualNode(next)) return;   // a poll that changed nothing
            host.textContent = '';
            host.appendChild(next);
        });
    }

    function load() {
        return WS.swr('status:feed', function () { return WS.getJSON(FEED_URL, { signal: signal }); },
            function (feed) { draw(feed, false); }, {
                maxAge: 60 * 1000,
                onError: function (error) {
                    if (signal.aborted || isAbort(error)) return;   // left the page: not an error
                    draw(null, true);
                }
            });
    }

    // Home's strip reads the same kept copy: a change here is news to it too.
    function reload() {
        if (WS.dropCache) WS.dropCache('status:feed');
        return load();
    }

    // ---- Admins: post, resolve, delete ----

    var form = root.querySelector('#statusComposer');
    if (form && isAdmin) {
        var note = root.querySelector('#statusNote');
        var count = root.querySelector('#statusNoteCount');
        var error = root.querySelector('#statusNoteError');
        var service = root.querySelector('#statusNoteService');
        var important = root.querySelector('#statusNoteImportant');
        var post = root.querySelector('#statusNotePost');
        var busy = false;
        function markInvalid(bad) {
            note.classList.toggle('ws-invalid', bad);
            note.setAttribute('aria-invalid', bad ? 'true' : 'false');
            error.classList.toggle('hidden', !bad);
        }
        var opener = root.querySelector('#statusComposeOpen');
        function setOpen(open) {
            form.hidden = !open;
            if (opener) opener.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) note.focus();
            else if (opener) opener.focus();
        }
        if (opener) opener.addEventListener('click', function () { setOpen(form.hidden); }, { signal: signal });
        root.querySelector('#statusNoteCancel').addEventListener('click', function () { markInvalid(false); setOpen(false); }, { signal: signal });
        form.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.preventDefault(); markInvalid(false); setOpen(false); }
        }, { signal: signal });
        note.addEventListener('input', function () {
            count.textContent = note.value.length + ' of ' + NOTE_MAX;
            if (note.value.trim()) markInvalid(false);
        }, { signal: signal });
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            if (busy) return;
            var text = note.value.trim();
            markInvalid(!text);
            if (!text) { note.focus(); return; }
            busy = true;
            post.disabled = true;
            send('POST', '/api/status/notes', { text: text, important: !!important.checked, service: service.value.trim() || null })
                .then(function () {
                    note.value = '';
                    service.value = '';
                    important.checked = false;
                    count.textContent = '0 of ' + NOTE_MAX;
                    setOpen(false);
                    toast('Note posted', 'ok');
                    return reload();
                }, function (err) {
                    toast(err && err.status === 403 ? 'Only an admin can post notes.' : 'The note wasn’t posted. Try again.', 'err');
                })
                .then(function () { busy = false; post.disabled = false; });
        }, { signal: signal });
    }

    root.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-note-action]') : null;
        if (!btn || !root.contains(btn) || !isAdmin) return;
        var id = encodeURIComponent(btn.getAttribute('data-id') || '');
        if (btn.getAttribute('data-note-action') === 'resolve') {
            send('POST', '/api/status/notes/' + id + '/resolve').then(function () {
                toast('Marked resolved', 'ok');
                return reload();
            }, function () { toast('That note wasn’t changed. Try again.', 'err'); });
            return;
        }
        var ask = window.WSUI && WSUI.confirm
            ? WSUI.confirm({ title: 'Delete this note?', body: 'It leaves the status feed for everyone.', confirmLabel: 'Delete', danger: true })
            : Promise.resolve(false);
        ask.then(function (yes) {
            if (!yes || signal.aborted) return;
            send('DELETE', '/api/status/notes/' + id).then(function () {
                toast('Note deleted', 'ok');
                return reload();
            }, function () { toast('That note wasn’t deleted. Try again.', 'err'); });
        });
    }, { signal: signal });

    var first = load();
    ctx.poll(load, 30000);
    await Promise.race([first, new Promise(function (resolve) { ctx.setTimeout(resolve, 1500); })]);
}
