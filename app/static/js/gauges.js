/**
 * WebServarr: the server's gauges (shell module)
 *
 * CPU, RAM and the network from Netdata, in both headers
 * (partials/shell-gauges.html, rendered by app/pages.py into the desktop
 * header and the phone's top bar; only one shows at any width). One poll
 * for the whole app, once a second while the tab is on screen (WS.poll),
 * and every reading is written to both copies. The headers are the shell's,
 * so a soft navigation never swaps them and nothing here runs twice.
 *
 * They show while Netdata is set up: the server marks <html data-netdata>
 * and the router brings the mark in step on every swap, so a poll with the
 * mark gone reads nothing (theme.css hides the gauges then). They hold their
 * room from the first paint but stay hidden (data-pending) until the first
 * answer, so they arrive whole and nothing beside them moves.
 *
 * Pure part (no DOM at import time, so Node can import it): startGauges.
 */

const POLL_MS = 1000;
const RING = 251;   // the ring's circumference (r = 40), its full dash offset

/* env: { document, WS (shell.js: poll), fetch, signal (optional) }.
   Returns { tick() }. */
export function startGauges(env) {
    var doc = env.document;
    var busy = false;

    function each(selector, fn) {
        Array.prototype.forEach.call(doc.querySelectorAll('[data-ws-gauges] ' + selector), fn);
    }
    function setText(selector, text) {
        each(selector, function (el) { if (el.textContent !== text) el.textContent = text; });
    }
    function setRing(name, pct) {
        var offset = String(RING - (RING * Math.max(0, Math.min(100, pct)) / 100));
        each('[data-gauge-ring="' + name + '"]', function (el) {
            if (el.style.strokeDashoffset !== offset) el.style.strokeDashoffset = offset;
        });
    }
    function reveal() {
        Array.prototype.forEach.call(doc.querySelectorAll('[data-ws-gauges][data-pending]'), function (el) {
            el.removeAttribute('data-pending');
        });
    }

    function show(stats) {
        if (!stats || !stats.configured || stats.error) return;
        if (stats.cpu_percent !== null && stats.cpu_percent !== undefined) {
            setText('[data-gauge-text="cpu"]', Math.round(stats.cpu_percent) + '%');
            setRing('cpu', stats.cpu_percent);
        }
        if (stats.ram_percent !== null && stats.ram_percent !== undefined) {
            setText('[data-gauge-text="ram"]', Math.round(stats.ram_percent) + '%');
            setRing('ram', stats.ram_percent);
        }
        // Whole numbers on one line under one unit; screen readers get the
        // unit in full after each figure.
        var dl = stats.net_download_mbps != null ? stats.net_download_mbps : 0;
        var ul = stats.net_upload_mbps != null ? stats.net_upload_mbps : 0;
        var bytes = stats.net_unit === 'MBps';
        setText('[data-gauge-net="down"]', String(Math.round(dl)));
        setText('[data-gauge-net="up"]', String(Math.round(ul)));
        setText('[data-gauge-unit]', bytes ? 'MB/s' : 'Mbps');
        setText('[data-gauge-unit-long]', bytes ? 'megabytes per second' : 'megabits per second');
        // The network ring: the share of the configured top speed.
        var netMax = stats.net_max || 1000;
        setRing('net', (dl + ul) / netMax * 100);
    }

    // One reading at a time: a slow answer is never overtaken by the next.
    // An answer that is not a reading shows the gauges with their empty
    // readings, as before the first one.
    function tick() {
        if (busy || !doc.documentElement.hasAttribute('data-netdata')) return;
        if (env.signal && env.signal.aborted) return;
        busy = true;
        env.fetch('/api/integrations/system-stats').then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        }).then(function (stats) {
            reveal();
            show(stats);
        }, function () {
            reveal();
        }).then(function () { busy = false; });
    }

    tick();
    env.WS.poll(tick, POLL_MS, env.signal);
    return { tick: tick };
}

// In the browser, once: shell.js has made window.WS (a module runs after it).
if (typeof window !== 'undefined' && window.WS && !window.WS.gauges) {
    window.WS.gauges = startGauges({
        document: document,
        WS: window.WS,
        fetch: function (url) { return fetch(url); }
    });
}
