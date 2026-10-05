"""Home's pinned problems, written into the page by the server.

An open outage or an open important note (status_feed._pinned) is not on the
event log's wheel: it is a row of its own between the "Event log" heading and
the wheel, until it is resolved. The rows sit above the wheel, so the server
writes them into Home's HTML and the section is its real height from the
first paint; pages/home.js (createEventLog) then takes the same rows over,
by their data-key, without rebuilding them.

The markup here is a copy of home.js's pinned rows (buildPinned), kept in
step by a shared set of cases: app/tests/event_pinned_vectors.json, checked
against this module by test_home_event_log.py and against home.js by
app/tests/js/home_event_log.mjs.
"""
import html
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import List, Optional

logger = logging.getLogger(__name__)

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

# The empty list, as index.html has it. render_html swaps it for the rows.
PINNED_EMPTY = '<ul class="ws-pinned" data-event-pinned role="list" aria-label="Current problems" hidden></ul>'
PINNED_OPEN = '<ul class="ws-pinned" data-event-pinned role="list" aria-label="Current problems">'

# home.js PINNED_ICON and PINNED_PREFIX: an outage and an important note.
PINNED_ICON = {"down": "error", "important": "warning"}
PINNED_PREFIX = {"down": "Problem: ", "important": "Important: "}


def _js_round(x: float) -> int:
    """Math.round: halves go up, also below zero."""
    return math.floor(x + 0.5)


def feed_time(value) -> Optional[int]:
    """home.js feedTime: an ISO time as epoch milliseconds, or None."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (parsed - _EPOCH) // timedelta(milliseconds=1)


def wheel_time(at_ms: int, now_ms: int) -> str:
    """home.js wheelTime: "just now", "6 min ago", "2 h ago", "yesterday"."""
    s = max(0, _js_round((now_ms - at_ms) / 1000))
    if s < 45:
        return "just now"
    m = _js_round(s / 60)
    if m < 60:
        return f"{m} min ago"
    h = _js_round(m / 60)
    if h < 24:
        return f"{h} h ago"
    d = _js_round(h / 24)
    return "yesterday" if d == 1 else f"{d} days ago"


def _iso_ms(at_ms: int) -> str:
    """Date.prototype.toISOString."""
    when = _EPOCH + timedelta(milliseconds=at_ms)
    return when.strftime("%Y-%m-%dT%H:%M:%S.") + f"{when.microsecond // 1000:03d}Z"


def pinned_events(open_items: list) -> List[dict]:
    """home.js feedEvents for the feed's "open" items: {key, id, type, text,
    at}, newest first (then the higher id), as the feed orders them."""
    out = []
    seen = set()
    for it in open_items or []:
        if not isinstance(it, dict) or it.get("id") in seen:
            continue
        seen.add(it.get("id"))
        text = it.get("text") if isinstance(it.get("text"), str) else ""
        if not text or it.get("resolved") or it.get("source") == "library":
            continue
        if it.get("source") == "auto":
            at = feed_time(it.get("started_at"))
            if at is None:
                at = feed_time(it.get("created_at"))
            key, kind = f"a{it.get('id')}:down", "down"
        else:
            at = feed_time(it.get("created_at"))
            if at is None:
                at = feed_time(it.get("at"))
            key, kind = f"n{it.get('id')}", "important"
        if at is None:
            continue
        out.append({"key": key, "id": it.get("id"), "type": kind, "text": text, "at": at})
    out.sort(key=lambda ev: (-ev["at"], -(ev["id"] if isinstance(ev["id"], int) else 0)))
    return out


def render_pinned_row(ev: dict, now_ms: int) -> str:
    """One row, as home.js buildPinned writes it."""
    esc = html.escape
    return ('<li class="ws-pinned__row" data-key="' + esc(ev["key"], quote=True)
            + '" data-type="' + ev["type"] + '" title="' + esc(ev["text"], quote=True) + '">'
            + '<span class="ws-pinned__icon material-symbols-outlined" aria-hidden="true">'
            + PINNED_ICON[ev["type"]] + '</span>'
            + '<span class="ws-pinned__text"><span class="sr-only">' + PINNED_PREFIX[ev["type"]] + '</span>'
            + esc(ev["text"], quote=False) + '</span>'
            + '<time class="ws-pinned__time" datetime="' + _iso_ms(ev["at"]) + '">'
            + wheel_time(ev["at"], now_ms) + '</time></li>')


def render_pinned(open_items: list, now_ms: int) -> str:
    """The whole list: PINNED_EMPTY when nothing is pinned."""
    events = pinned_events(open_items)
    if not events:
        return PINNED_EMPTY
    return PINNED_OPEN + "".join(render_pinned_row(ev, now_ms) for ev in events) + "</ul>"


def now_ms() -> int:
    return (datetime.now(timezone.utc) - _EPOCH) // timedelta(milliseconds=1)
