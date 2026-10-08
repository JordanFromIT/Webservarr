/**
 * WebServarr: the event log (shell module)
 *
 * The status feed's newest events, at the top of every shell page's content
 * (partials/shell-event-log.html, rendered by app/pages.py). One section for
 * the life of the document: on a soft navigation the router swaps #wsPage
 * and says so (ws:swap, synchronously, before anything is drawn), and this
 * module puts its own live section in place of the copy the new page
 * brought. So the wheel, the history someone turned back to, its timers and
 * the one 30 s poll carry on from page to page and nothing is built twice.
 * A page without the section (the reader, full-screen) leaves it out of the
 * document until the next page has one; it reads nothing meanwhile.
 *
 * Exposes WS.eventLog: { adopt(root), load(), tick() }.
 * Pure parts (no DOM at import time, so Node can import it):
 * createEventLog, startEventLog.
 */

// The status feed's newest events on a wheel (theme.css .ws-wheel): the
// newest line flat at the bottom, older ones curled up over the top and
// dimmed. A new event turns the wheel one notch; several turn it one notch
// each, in order. Under reduced motion the lines crossfade in place instead.
// Only the front line is in the accessibility tree; a new event is announced
// once through the section's polite live region. Text is written with
// textContent only.
//
// Library lines (Sonarr, Radarr and Chaptarr: "Added: Dune (2021)")
// carry a grey tick, and a grab its muted " · not guaranteed".
//
// What the feed pins (an open outage, an open important note) is not on the
// wheel: it is a row of its own above it (theme.css .ws-pinned), with its
// icon, until it is resolved, so the wheel rolls on under it. The server
// writes the rows into the page (app/home_event_log.py, the same markup) and
// the rows are taken over by their data-key. Resolved, an outage's two
// events and a note join the wheel's history; a new pinned row is announced.
//
// People can turn the wheel back through the feed's history (30 days): the
// mouse wheel or trackpad over it, a vertical drag, or the arrow keys with
// it focused (Home and End for the newest and the oldest). It only takes the
// scroll while there is more history that way, so the page still scrolls at
// either end. Turned back, new events don't move it: "Latest" (and
// WHEEL_IDLE_MS without a turn) brings it back to the newest.
//
// The ends hold: a scroll or drag that turned the wheel and reaches the
// newest or the oldest keeps the rest of that gesture (the wheel nudges, a
// few px, to say so), so a fast spin back to the newest does not run on down
// the page. A scroll ends after WHEEL_GESTURE_GAP_MS without a wheel event
// (a trackpad's momentum keeps firing until it stops, so it is held too), a
// drag when the finger lifts. Only a gesture that starts at the end goes to
// the page, so the wheel never traps the page's scroll. Keys are not held.

const WHEEL_LINES = 5;
const WHEEL_MS = 650;   // theme.css --wheel-duration
const WHEEL_IDLE_MS = 15000;    // turned back, it goes back to the newest after this long untouched
const WHEEL_STEP_PX = 40;       // scroll (or less, added up) that turns one notch
const WHEEL_DRAG_PX = 24;       // a drag this far turns one notch
const WHEEL_GESTURE_GAP_MS = 250;   // this long without a wheel event ends a scroll gesture
const WHEEL_HELD_MS = 260;      // theme.css .ws-wheel[data-held] nudge, and a little over
const WHEEL_QUIET = {
    empty: 'No outages or notes this month',
    unavailable: 'Status unavailable right now'
};
const WHEEL_SR_PREFIX = { note: 'Note: ', important: 'Important: ' };
// Nothing on the wheel but something pinned above it.
const WHEEL_QUIET_PINNED = 'No other events this month';
// A pinned row's icon and its words for screen readers (app/home_event_log.py).
const PINNED_ICON = { down: 'error', important: 'warning' };
const PINNED_PREFIX = { down: 'Problem: ', important: 'Important: ' };

function feedTime(iso) {
    var t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return isNaN(t) ? null : t;
}

// The feed's items as events, newest first. An outage is two events: it went
// down (when it began; pinned while it is open) and, once resolved, it came
// back (when it ended, the item's own text). A note is one event, when it was
// posted, and so is a library line, with its note ("not guaranteed") if any.
// What the feed sends as "open" is pinned: an open outage, an important note.
function feedEvents(data) {
    var open = Array.isArray(data.open) ? data.open : [];
    var rows = [].concat(open, Array.isArray(data.items) ? data.items : []);
    var out = [];
    var seen = {};
    rows.forEach(function (it, n) {
        if (!it || typeof it !== 'object' || seen[it.id]) return;
        seen[it.id] = true;
        var text = typeof it.text === 'string' ? it.text : '';
        if (n < open.length) {
            if (!text || it.resolved || it.source === 'library') return;
            var since = feedTime(it.source === 'auto' ? it.started_at : it.created_at);
            if (since === null) since = feedTime(it.source === 'auto' ? it.created_at : it.at);
            if (since === null) return;
            out.push(it.source === 'auto'
                ? { key: 'a' + it.id + ':down', id: it.id, type: 'down', text: text, at: since, pinned: true }
                : { key: 'n' + it.id, id: it.id, type: 'important', text: text, at: since, pinned: true });
            return;
        }
        if (it.source === 'auto') {
            var began = feedTime(it.started_at);
            if (began === null) began = feedTime(it.created_at);
            if (it.resolved) {
                var ended = feedTime(it.ended_at);
                if (ended === null) ended = feedTime(it.at);
                if (began !== null && typeof it.service === 'string' && it.service) {
                    out.push({ key: 'a' + it.id + ':down', type: 'down', text: it.service + ' is down', at: began });
                }
                // Back up: the green tick. No longer monitored (it left the
                // status page, so nobody knows): the neutral one.
                if (ended !== null && text) {
                    out.push({ key: 'a' + it.id + ':up', type: it.unmonitored === true ? 'unmonitored' : 'up',
                               text: text, at: ended });
                }
            }
        } else if (it.source === 'library') {
            var when = feedTime(it.created_at);
            if (when === null) when = feedTime(it.at);
            if (when !== null && text) {
                out.push({ key: 'l' + it.id, type: 'library', text: text,
                           note: typeof it.note === 'string' ? it.note : '', at: when });
            }
        } else {
            var at = feedTime(it.created_at);
            if (at === null) at = feedTime(it.at);
            if (at !== null && text) out.push({ key: 'n' + it.id, type: it.important ? 'important' : 'note', text: text, at: at });
        }
    });
    // Newest first; at the same moment an outage's return comes after its start.
    out.sort(function (a, b) { return (b.at - a.at) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0); });
    return out;
}

// What the wheel shows of `list` (newest first, nothing pinned): the newest
// WHEEL_LINES events.
function onWheel(list) {
    return list.slice(0, WHEEL_LINES);
}

// The pinned rows' order, the feed's own: the newest first, then the higher id.
function pinnedOrder(a, b) {
    return (b.at - a.at) || ((Number(b.id) || 0) - (Number(a.id) || 0));
}

// A line as one string: for its title and for the live region.
function eventWords(ev) {
    return (WHEEL_SR_PREFIX[ev.type] || '') + ev.text + (ev.note ? ' · ' + ev.note : '');
}

function wheelTime(at) {
    var s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : d + ' days ago';
}

// One wheel on one section. env: { setTimeout, clearTimeout, signal } (the
// owner's: its abort ends the wheel's input and timers) and reducedMotion().
export function createEventLog(section, env) {
    var wheel = section.querySelector('[data-event-wheel]');
    var pinnedList = section.querySelector('[data-event-pinned]');
    var announcer = section.querySelector('[data-event-announce]');
    var latest = section.querySelector('[data-event-latest]');
    var lines = [];      // on the wheel, newest first: { key, ev, el }
    var leaving = [];
    var seen = null;     // keys shown so far; null until the first answer
    var steps = [];
    var announceTimer = null;
    var all = [];        // every event of the last answer, newest first
    var offset = 0;      // notches turned back from the newest; 0 follows the newest
    var anchor = null;   // turned back: the front event's key, which keeps it in place
    var newestAt = null; // the newest event's time in the last answer
    var idleTimer = null;
    var scrolled = 0;    // scroll added up towards one notch
    var dragY = null;
    // The scroll gesture and the drag under way: took, it turned (or tried to
    // turn) the wheel, so an end holds it; held, it is being held at an end
    // now (nudged once until it turns again). null: none.
    var gesture = null;
    var gestureTimer = null;
    var drag = null;
    var heldTimer = null;

    // What the wheel shows of `list`: following the newest, onWheel (an open
    // outage held); turned back, the WHEEL_LINES events from the front one.
    function pick(list) {
        return offset === 0 ? onWheel(list) : list.slice(offset, offset + WHEEL_LINES);
    }

    function fill(el, ev) {
        el.setAttribute('data-type', ev.type);
        el.title = ev.text + (ev.note ? ' · ' + ev.note : '');
        var text = el.querySelector('.ws-wheel__text');
        var prefix = WHEEL_SR_PREFIX[ev.type] || '';
        text.textContent = '';
        if (prefix) {
            var sr = document.createElement('span');
            sr.className = 'sr-only';
            sr.textContent = prefix;
            text.appendChild(sr);
        }
        if (ev.note) {
            // The title gives way (ellipsis) and the note stays readable,
            // even on a phone.
            text.setAttribute('data-noted', '');
            var title = document.createElement('span');
            title.className = 'ws-wheel__title';
            title.textContent = ev.text;
            text.appendChild(title);
            var note = document.createElement('span');
            note.className = 'ws-wheel__note';
            note.textContent = ' · ' + ev.note;
            text.appendChild(note);
        } else {
            text.removeAttribute('data-noted');
            text.appendChild(document.createTextNode(ev.text));
        }
        var time = el.querySelector('time');
        if (ev.at !== null) {
            if (!time) {
                time = document.createElement('time');
                time.className = 'ws-wheel__time';
                el.appendChild(time);
            }
            time.dateTime = new Date(ev.at).toISOString();
            time.textContent = wheelTime(ev.at);
        } else if (time) {
            el.removeChild(time);
        }
    }

    function build(ev) {
        var el = document.createElement('div');
        el.className = 'ws-wheel__line';
        var mark = document.createElement('span');
        mark.className = 'ws-wheel__mark';
        mark.setAttribute('aria-hidden', 'true');
        el.appendChild(mark);
        var text = document.createElement('span');
        text.className = 'ws-wheel__text';
        el.appendChild(text);
        fill(el, ev);
        return el;
    }

    // A line joining at the front turns up from under the front edge; one
    // joining further back (a newer one was deleted) fades in on its notch.
    function enter(el, slot, before, animate) {
        var from = slot === 0 ? 'is-entering' : 'is-appearing';
        el.style.setProperty('--i', String(slot));
        if (animate) el.classList.add(from);
        if (before && before.parentNode === wheel) wheel.insertBefore(el, before);
        else wheel.appendChild(el);
        if (animate) {
            void el.offsetHeight;   // commit the start, so the turn animates
            el.classList.remove(from);
        }
    }

    function leave(el) {
        if (!el || el.classList.contains('is-leaving')) return;
        el.classList.add('is-leaving');
        el.setAttribute('aria-hidden', 'true');
        el.removeAttribute('title');
        leaving.push(el);
        env.setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
            var k = leaving.indexOf(el);
            if (k !== -1) leaving.splice(k, 1);
        }, WHEEL_MS + 80);
        // In a burst only one line fades out at a time (a whole set when
        // crossfading), so the wheel never shows a stack of ghosts.
        var cap = env.reducedMotion() ? WHEEL_LINES + 1 : 1;
        while (leaving.length > cap) {
            var old = leaving.shift();
            if (old.parentNode) old.parentNode.removeChild(old);
        }
    }

    // Put what the wheel shows of `list` (onWheel) on their notches. animate: lines
    // that join turn up from the front edge (or fade, crossfading); without
    // it they are simply there. crossfade: every line fades out where it is
    // and the new set fades in.
    function place(list, animate, crossfade) {
        var target = pick(list);
        var keep = {};
        target.forEach(function (ev) { keep[ev.key] = true; });
        var rank = {};
        list.forEach(function (ev, i) { rank[ev.key] = i; });
        var front = target.length ? rank[target[0].key] : 0;
        var old = {};
        lines.forEach(function (ln) {
            if (crossfade || !keep[ln.key]) {
                // Turned back, a line newer than the new front goes down
                // under the front edge; any other fades out on its notch.
                if (!crossfade && rank[ln.key] < front) ln.el.style.setProperty('--i', '-1');
                leave(ln.el);
            } else {
                old[ln.key] = ln;
            }
        });
        var next = [];
        target.forEach(function (ev, i) {
            var ln = old[ev.key];
            if (ln) {
                if (ln.ev.text !== ev.text || ln.ev.type !== ev.type || ln.ev.at !== ev.at ||
                    ln.ev.note !== ev.note) fill(ln.el, ev);
                ln.ev = ev;
                ln.el.style.setProperty('--i', String(i));
            } else {
                ln = { key: ev.key, ev: ev, el: build(ev) };
                // In the document oldest first, as on screen top to bottom.
                enter(ln.el, i, i > 0 ? next[i - 1].el : null, animate);
            }
            if (i === 0) ln.el.removeAttribute('aria-hidden');
            else ln.el.setAttribute('aria-hidden', 'true');
            next.push(ln);
        });
        lines = next;
        if (seen) target.forEach(function (ev) { seen[ev.key] = true; });
    }

    function announce(ev, words) {
        if (!announcer) return;
        if (announceTimer !== null) env.clearTimeout(announceTimer);
        announcer.textContent = words || eventWords(ev);
        // Cleared later, so browse mode does not read the newest event twice.
        announceTimer = env.setTimeout(function () { announcer.textContent = ''; announceTimer = null; }, 7000);
    }

    // ---- Pinned rows, above the wheel ----
    //
    // Each row: <li data-key data-type title> with its icon (hidden from
    // screen readers), its words after a hidden "Problem: " or "Important: ",
    // and its time, as app/home_event_log.py writes them.

    function fillPinned(el, ev) {
        el.setAttribute('data-type', ev.type);
        el.title = ev.text;
        el.querySelector('.ws-pinned__icon').textContent = PINNED_ICON[ev.type];
        var text = el.querySelector('.ws-pinned__text');
        text.textContent = '';
        var sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = PINNED_PREFIX[ev.type];
        text.appendChild(sr);
        text.appendChild(document.createTextNode(ev.text));
        var time = el.querySelector('time');
        time.setAttribute('datetime', new Date(ev.at).toISOString());
        time.textContent = wheelTime(ev.at);
    }

    function buildPinned(ev) {
        var el = document.createElement('li');
        el.className = 'ws-pinned__row';
        el.setAttribute('data-key', ev.key);
        var icon = document.createElement('span');
        icon.className = 'ws-pinned__icon material-symbols-outlined';
        icon.setAttribute('aria-hidden', 'true');
        el.appendChild(icon);
        var text = document.createElement('span');
        text.className = 'ws-pinned__text';
        el.appendChild(text);
        var time = document.createElement('time');
        time.className = 'ws-pinned__time';
        el.appendChild(time);
        fillPinned(el, ev);
        return el;
    }

    // The words a row reads as, for the live region.
    function pinnedWords(ev) {
        return PINNED_PREFIX[ev.type] + ev.text;
    }

    // Bring the rows in step with `pinned` (newest first). A row already
    // there (the server's, or the last answer's) is kept as it is unless
    // what it says changed, so taking the server's rows over moves nothing.
    // Returns the events that were not pinned before.
    function placePinned(pinned) {
        if (!pinnedList) return [];
        var had = {};
        Array.prototype.forEach.call(pinnedList.children, function (el) {
            var k = el.getAttribute('data-key');
            if (k) had[k] = el;
        });
        var added = [];
        pinned.forEach(function (ev, i) {
            var el = had[ev.key];
            if (el) {
                delete had[ev.key];
                var time = el.querySelector('time');
                var words = el.querySelector('.ws-pinned__text');
                if (!time || !words || !el.querySelector('.ws-pinned__icon')) {
                    var fresh = buildPinned(ev);
                    pinnedList.replaceChild(fresh, el);
                    el = fresh;
                } else if (el.getAttribute('data-type') !== ev.type || el.title !== ev.text ||
                           time.getAttribute('datetime') !== new Date(ev.at).toISOString() ||
                           words.textContent !== PINNED_PREFIX[ev.type] + ev.text) {
                    fillPinned(el, ev);
                } else if (time.textContent !== wheelTime(ev.at)) {
                    time.textContent = wheelTime(ev.at);
                }
            } else {
                el = buildPinned(ev);
                added.push(ev);
            }
            if (pinnedList.children[i] !== el) pinnedList.insertBefore(el, pinnedList.children[i] || null);
        });
        Object.keys(had).forEach(function (k) { pinnedList.removeChild(had[k]); });
        // Anything else in the list (not a row of ours) goes too.
        while (pinnedList.children.length > pinned.length) pinnedList.removeChild(pinnedList.lastChild);
        var none = pinned.length === 0;
        if (pinnedList.hidden !== none) pinnedList.hidden = none;
        return added;
    }

    function cancelSteps() {
        steps.forEach(function (id) { env.clearTimeout(id); });
        steps = [];
    }

    // ---- Turning back through the history ----

    function deepest() {
        return all.length && all[0].type !== 'quiet' ? all.length - 1 : 0;
    }

    function canTurn(dir) {
        return dir > 0 ? offset < deepest() : offset > 0;
    }

    function showLatest() {
        if (latest) latest.hidden = offset === 0;
    }

    function armIdle() {
        if (idleTimer !== null) env.clearTimeout(idleTimer);
        idleTimer = null;
        if (offset > 0) idleTimer = env.setTimeout(function () { idleTimer = null; turnTo(0); }, WHEEL_IDLE_MS);
    }

    // Turn to `n` notches back (0: the newest). False when it is there already.
    function turnTo(n) {
        n = Math.max(0, Math.min(deepest(), n));
        if (n === offset || seen === null || section.hidden) return false;
        cancelSteps();
        offset = n;
        anchor = n ? all[n].key : null;
        place(all, true, env.reducedMotion());
        showLatest();
        armIdle();
        return true;
    }

    // The wheel nudges towards the end it is held at (theme.css
    // .ws-wheel[data-held]). Under reduced motion it does not.
    function nudge(end) {
        if (env.reducedMotion()) return;
        if (heldTimer !== null) env.clearTimeout(heldTimer);
        wheel.removeAttribute('data-held');
        void wheel.offsetHeight;    // restart the nudge
        wheel.setAttribute('data-held', end);
        heldTimer = env.setTimeout(function () { heldTimer = null; wheel.removeAttribute('data-held'); }, WHEEL_HELD_MS);
    }

    // Input in `dir` with nothing more that way. True: the gesture turned
    // the wheel, so the end holds it (and the wheel nudges, once per arrival).
    // False: it started at the end, and the page has it.
    function holds(g, dir) {
        if (!g || !g.took) return false;
        if (!g.held) {
            g.held = true;
            nudge(dir > 0 ? 'oldest' : 'newest');
        }
        return true;
    }

    // The gesture turned the wheel: it is the wheel's now. Input that could
    // turn it but did not (less than a notch) leaves the gesture the page's.
    function takes(g) {
        if (!g) return;
        g.took = true;
        g.held = false;
    }

    function endGesture() {
        gestureTimer = null;
        gesture = null;
    }

    function onScroll(e) {
        if (e.ctrlKey) return;                  // a pinch: the page zooms
        // Every wheel event keeps the gesture going, momentum included.
        if (gestureTimer !== null) env.clearTimeout(gestureTimer);
        if (!gesture) gesture = { took: false, held: false };
        gestureTimer = env.setTimeout(endGesture, WHEEL_GESTURE_GAP_MS);
        var dy = e.deltaY * (e.deltaMode === 1 ? WHEEL_STEP_PX : e.deltaMode === 2 ? WHEEL_STEP_PX * 10 : 1);
        if (!dy) return;
        var dir = dy < 0 ? 1 : -1;              // up the page is back in time
        if (!canTurn(dir)) {
            // The end: held if this gesture turned the wheel, else the page scrolls.
            scrolled = 0;
            if (holds(gesture, dir)) e.preventDefault();
            return;
        }
        e.preventDefault();
        if (scrolled && (scrolled < 0) !== (dy < 0)) scrolled = 0;
        scrolled += dy;
        if (Math.abs(scrolled) >= WHEEL_STEP_PX) {
            scrolled = 0;
            if (turnTo(offset + dir)) takes(gesture);
        }
    }

    function onDragStart(e) {
        dragY = e.touches && e.touches.length === 1 ? e.touches[0].clientY : null;
        drag = dragY === null ? null : { took: false, held: false };
    }

    function onDrag(e) {
        if (dragY === null || !e.touches || e.touches.length !== 1) return;
        var y = e.touches[0].clientY;
        var dy = y - dragY;
        if (!dy) return;
        var dir = dy > 0 ? 1 : -1;              // pulling down brings older lines down
        if (!canTurn(dir)) {
            if (holds(drag, dir)) {
                // Held to the end of the drag; a turn back counts from here.
                if (e.cancelable) e.preventDefault();
                dragY = y;
            } else {
                dragY = null;                   // started at the end: the page scrolls
            }
            return;
        }
        if (e.cancelable) e.preventDefault();
        if (Math.abs(dy) >= WHEEL_DRAG_PX) {
            dragY = y;
            if (turnTo(offset + dir)) takes(drag);
        }
    }

    function onDragEnd() { dragY = null; drag = null; }

    function onKey(e) {
        var to = null;
        if (e.key === 'ArrowUp') to = offset + 1;
        else if (e.key === 'ArrowDown') to = offset - 1;
        else if (e.key === 'Home') to = 0;
        else if (e.key === 'End') to = deepest();
        if (to !== null && turnTo(to)) e.preventDefault();
    }

    // "Latest": back to the newest, focus kept on the wheel.
    function toLatest() {
        var hadFocus = latest && document.activeElement === latest;
        turnTo(0);
        if (hadFocus) wheel.focus();
    }

    // The wheel's own input: scroll, drag and keys, and "Latest", until the
    // owner's signal ends.
    if (latest && env.signal) latest.addEventListener('click', toLatest, { signal: env.signal });
    if (wheel && env.signal) {
        wheel.addEventListener('wheel', onScroll, { signal: env.signal, passive: false });
        wheel.addEventListener('touchstart', onDragStart, { signal: env.signal, passive: true });
        wheel.addEventListener('touchmove', onDrag, { signal: env.signal, passive: false });
        wheel.addEventListener('touchend', onDragEnd, { signal: env.signal });
        wheel.addEventListener('touchcancel', onDragEnd, { signal: env.signal });
        wheel.addEventListener('keydown', onKey, { signal: env.signal });
    }

    // data: the feed's answer, or null when it could not be read.
    // quiet: true for a copy kept from an earlier visit, painted at once.
    function render(data, quiet) {
        var state = data && typeof data === 'object' ? data.state : 'unavailable';
        var feedAll = state === 'unavailable' ? [] : feedEvents(data);
        var pinned = feedAll.filter(function (ev) { return ev.pinned; }).sort(pinnedOrder);
        var events = feedAll.filter(function (ev) { return !ev.pinned; });
        // Without Uptime Kuma the log shows only when it has something to
        // show: a note, an outage or a library line (status_feed.home_off,
        // the same rule).
        if (state === 'off' && !events.length && !pinned.length) {
            cancelSteps();
            section.hidden = true;
            placePinned([]);
            offset = 0;
            anchor = null;
            armIdle();
            showLatest();
            return;
        }
        var quietKey = state === 'unavailable' ? 'unavailable' : pinned.length ? 'pinned' : 'empty';
        var list = events.length ? events
            : [{ key: 'quiet:' + quietKey, type: 'quiet',
                 text: quietKey === 'pinned' ? WHEEL_QUIET_PINNED : WHEEL_QUIET[quietKey], at: null }];
        cancelSteps();
        var before = newestAt;
        all = list;
        newestAt = list[0].at;
        var first = seen === null || section.hidden;
        var added = placePinned(pinned);
        if (first) seen = {};
        // A pinned event was shown: when it is resolved and joins the wheel
        // it is not new (an outage's return is, and is announced).
        pinned.forEach(function (ev) { seen[ev.key] = true; });
        if (first) {
            // The first answer (or the section coming back): the lines are
            // simply there, nothing turns and nothing is announced.
            section.hidden = false;
            if (wheel.querySelector('.skel')) wheel.textContent = '';   // the skeleton
            offset = 0;
            anchor = null;
            armIdle();
            showLatest();
            place(list, false, false);
            return;
        }
        // A new problem is announced as it is pinned; what turns in on the
        // wheel in the same answer is said after it, in the same message.
        var lead = added.length && !quiet ? pinnedWords(added[0]) : '';
        if (lead) announce(added[0], lead);
        function say(ev) { announce(ev, lead ? lead + '. ' + eventWords(ev) : null); }
        if (offset > 0) {
            // Turned back: the same front event stays at the front (a new
            // event never moves the view), and new events are only announced.
            var at = -1;
            for (var i = 0; i < list.length; i++) if (list[i].key === anchor) { at = i; break; }
            offset = at >= 0 ? at : Math.min(offset, deepest());
            anchor = offset ? list[offset].key : null;
            showLatest();
            if (offset > 0) {
                var arrived = list.filter(function (ev) {
                    return ev.type !== 'quiet' && !seen[ev.key] && (before === null || ev.at > before);
                });
                place(list, !quiet, false);
                if (arrived.length && !quiet) {
                    arrived.forEach(function (ev) { seen[ev.key] = true; });
                    say(arrived[0]);
                }
                return;
            }
            armIdle();
        }
        // New: not shown before, and newer than every event on the wheel now.
        var front = -Infinity;
        lines.forEach(function (ln) { if (ln.ev.at !== null && ln.ev.at > front) front = ln.ev.at; });
        var shown = onWheel(list);
        var fresh = shown.filter(function (ev) { return ev.type !== 'quiet' && !seen[ev.key] && ev.at >= front; });
        if (!fresh.length || quiet) {
            place(list, !quiet, false);
            return;
        }
        var isFresh = {};
        fresh.forEach(function (ev) { isFresh[ev.key] = true; });
        var base = list.filter(function (ev) { return !isFresh[ev.key]; });
        var newest = fresh[0];
        if (env.reducedMotion()) {
            place(list, true, true);
            say(newest);
            return;
        }
        // One notch per new event, oldest first, each after the last turn.
        var order = fresh.slice().reverse();
        function upTo(n) {
            var add = {};
            for (var k = 0; k < n; k++) add[order[k].key] = true;
            return list.filter(function (ev) { return !isFresh[ev.key] || add[ev.key]; });
        }
        place(base, true, false);
        order.forEach(function (ev, k) {
            var turn = function () {
                place(upTo(k + 1), true, false);
                if (k === order.length - 1) say(newest);
            };
            if (k === 0) turn();
            else steps.push(env.setTimeout(turn, k * (WHEEL_MS + 60)));
        });
    }

    function refreshTimes() {
        lines.forEach(function (ln) {
            var t = ln.el.querySelector('time');
            if (!t || ln.ev.at === null) return;
            var next = wheelTime(ln.ev.at);
            if (t.textContent !== next) t.textContent = next;
        });
        if (pinnedList) {
            Array.prototype.forEach.call(pinnedList.querySelectorAll('time'), function (t) {
                var at = feedTime(t.getAttribute('datetime'));
                var next = at === null ? '' : wheelTime(at);
                if (next && t.textContent !== next) t.textContent = next;
            });
        }
    }

    return { render: render, refreshTimes: refreshTimes, toLatest: toLatest };
}

// Polled with the shell's other live parts; a copy read this long ago is
// read again when a new page takes the section over.
const POLL_MS = 30000;
const STALE_MS = 15000;

/* The section for the whole visit. env: { document, WS (shell.js: swr,
   getJSON, poll), target (where ws:swap is heard: window), setTimeout,
   clearTimeout, signal (ends everything; never, in the browser),
   reducedMotion(), now() }. */
export function startEventLog(env) {
    var WS = env.WS;
    var section = null;   // the live section, from the first page that had one
    var log = null;
    var reading = null;   // the read on its way, shared
    var readAt = -Infinity;

    function take(el) {
        section = el;
        log = createEventLog(el, env);
    }

    // A copy kept from earlier in the session paints at once (swr), and what
    // happened since then turns in. A read on its way is shared.
    function load() {
        if (!log) return Promise.resolve(null);
        if (reading) return reading;
        reading = WS.swr('status:feed', function () { return WS.getJSON('/api/status/feed'); }, function (data, fromCache) {
            if (env.signal && env.signal.aborted) return;
            log.render(data, fromCache);
        }, {
            onError: function () {
                if (env.signal && env.signal.aborted) return;
                log.render(null, false);
            }
        }).then(function (v) {
            reading = null;
            readAt = env.now();
            return v;
        }, function () {
            reading = null;
            return null;
        });
        return reading;
    }

    // The poll: only while the section is on a page.
    function tick() {
        if (!log || !section.isConnected) return;
        load();
        log.refreshTimes();
    }

    // The page the router just put in: its copy of the section gives way to
    // the live one. Read again if the last answer is old.
    function adopt(root) {
        var copy = root && root.querySelector ? root.querySelector('#wsEventLog') : null;
        if (!copy) return;
        if (!section) {
            take(copy);
            load();
            return;
        }
        if (copy !== section) copy.replaceWith(section);
        if (env.now() - readAt > STALE_MS) load();
    }

    var first = env.document.getElementById('wsEventLog');
    if (first) {
        take(first);
        load();
    }
    WS.poll(tick, POLL_MS, env.signal);
    if (env.target) {
        env.target.addEventListener('ws:swap', function (e) { adopt(e.detail && e.detail.root); },
                                    env.signal ? { signal: env.signal } : undefined);
    }
    return { adopt: adopt, load: load, tick: tick };
}

// In the browser, once: shell.js has made window.WS (a module runs after it).
if (typeof window !== 'undefined' && window.WS && !window.WS.eventLog) {
    window.WS.eventLog = startEventLog({
        document: document,
        WS: window.WS,
        target: window,
        setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
        clearTimeout: function (id) { clearTimeout(id); },
        signal: new AbortController().signal,
        reducedMotion: function () {
            return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        },
        now: function () { return Date.now(); }
    });
}
