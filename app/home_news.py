"""Home's News & Updates cards, written into the page by the server.

On a phone News sits above Service Health, so the section has to be its real
height from the first paint: a skeleton cannot know how many posts there are
or how long an open (pinned or new) one is, and every difference would move
Service Health and Recent Requests when the answer landed. The server writes
the same cards pages/home.js would (renderNewsCard, the "No news posts yet"
empty state) for the same posts (the news API's rules for a homepage read:
published only, pinned first, the homepage count and age window), and the
page script then takes over without changing their height.

The markup here is a copy of renderNewsCard's, kept in step by a shared set
of cases: app/tests/news_card_vectors.json, checked against this module by
test_home_news.py and against home.js by app/tests/js/news_cards.mjs.
"""
import logging
import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Optional

from app.content import sanitize_html

logger = logging.getLogger(__name__)

# pages/home.js: NEWS_FRESH_MS (under 3 days reads as "new").
NEWS_FRESH_MS = 72 * 60 * 60 * 1000
EXCERPT_LIMIT = 140
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

# JavaScript's \s, and what String.prototype.trim removes: Python's \s is a
# slightly different set, so the excerpt names the characters itself.
_JS_SPACE = ("\t\n\v\f\r \u00a0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200B))
             + "\u2028\u2029\u202f\u205f\u3000\ufeff")
_JS_SPACES_RE = re.compile("[" + re.escape(_JS_SPACE) + "]+")
_JS_TRIM_END_RE = re.compile("[" + re.escape(_JS_SPACE) + "]+$")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

BODY_CLASSES = "text-sm text-frosted-blue/80 mt-2 prose prose-invert max-w-none [&>div]:mb-2 [&>p]:mb-2 [&_br]:block"

# pages/home.js: NEWS_EMPTY_HTML.
NEWS_EMPTY_HTML = ('<div class="text-center text-steel-blue py-8">'
                   '<span class="material-symbols-outlined text-4xl mb-2 block opacity-50">newspaper</span>'
                   '<p>No news posts yet.</p></div>')


def escape_html(text) -> str:
    """auth.js escapeHtml: & < > " ' (the apostrophe as &#39;)."""
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


class _Text(HTMLParser):
    """An element's textContent: every text node, joined, entities decoded."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def _utf16_len(s: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in s)


def _utf16_slice(s: str, limit: int) -> str:
    """String.prototype.slice(0, limit), which counts UTF-16 units. Where the
    cut falls inside a pair JavaScript keeps half a character; here it goes."""
    out, units = [], 0
    for ch in s:
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            break
        out.append(ch)
    return "".join(out)


def news_excerpt(content_html: str, limit: int = EXCERPT_LIMIT) -> str:
    """home.js newsExcerpt: the post's text, spaces collapsed, cut at limit."""
    parser = _Text()
    parser.feed(content_html or "")
    parser.close()
    text = _JS_SPACES_RE.sub(" ", "".join(parser.parts)).strip(_JS_SPACE)
    if _utf16_len(text) > limit:
        return _JS_TRIM_END_RE.sub("", _utf16_slice(text, limit)) + "…"
    return text


def _ms(value: datetime) -> int:
    """Milliseconds since the epoch of a stored (naive UTC) or aware time, cut
    to the millisecond as the API sends it (utc_iso)."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return (value - _EPOCH) // timedelta(milliseconds=1)


def news_date_label(created_ms: int, now_ms: int) -> str:
    """home.js newsDateLabel. Past a week the browser writes the date in its own
    language and time zone; the server writes it the en-US way in UTC, and
    the page script rewrites it in place (the same width, near enough)."""
    seconds_ago = (now_ms - created_ms) // 1000
    if seconds_ago < 60:
        return "Just now"
    if seconds_ago < 3600:
        return f"{seconds_ago // 60}m ago"
    if seconds_ago < 86400:
        return f"{seconds_ago // 3600}h ago"
    if seconds_ago < 604800:
        return f"{seconds_ago // 86400}d ago"
    d = datetime.fromtimestamp(created_ms / 1000, tz=timezone.utc)
    return f"{_MONTHS[d.month - 1]} {d.day}, {d.year}"


def render_news_card(post: dict, now_ms: int, expanded: bool = False) -> str:
    """home.js renderNewsCard, character for character. post: title,
    content_html (already sanitised), created_at (a datetime), pinned."""
    created_ms = _ms(post["created_at"])
    pinned = bool(post.get("pinned"))
    is_fresh = (now_ms - created_ms) < NEWS_FRESH_MS
    accent = "border-l-primary" if pinned else ("border-l-frosted-blue" if is_fresh else "border-l-steel-blue/40")
    icon = "push_pin" if pinned else ("campaign" if is_fresh else "article")
    icon_color = "text-frosted-blue" if pinned else ("text-frosted-blue" if is_fresh else "text-steel-blue")

    flag = ""
    if pinned:
        flag = ('<span class="shrink-0 mt-0.5 text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 '
                'rounded bg-primary/20 text-frosted-blue">Pinned</span>')
    elif is_fresh:
        flag = ('<span class="shrink-0 mt-0.5 text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 '
                'rounded bg-frosted-blue/15 text-frosted-blue">New</span>')

    is_open = expanded or pinned or is_fresh
    content_html = post.get("content_html") or ""
    excerpt = news_excerpt(content_html, EXCERPT_LIMIT)

    if is_open:
        body = '<div class="' + BODY_CLASSES + '" style="white-space:pre-line">' + content_html + '</div>'
    else:
        body = ('<p class="text-sm text-frosted-blue/70 mt-1 line-clamp-2 min-h-10">' + escape_html(excerpt) + '</p>'
                '<div class="' + BODY_CLASSES + ' hidden" data-news-body style="white-space:pre-line">'
                + content_html + '</div>')

    toggle = "" if is_open else (
        '<button type="button" data-news-toggle class="mt-2 flex items-center gap-1 text-[11px] font-bold '
        'text-steel-blue hover:text-frosted-blue transition-colors">'
        '<span data-news-toggle-text>Read more</span>'
        '<span class="material-symbols-outlined text-sm transition-transform" data-news-chevron>expand_more</span>'
        '</button>')

    return ('<div class="glass-card p-4 rounded-xl flex items-start gap-4 border-l-4 min-w-0 ' + accent
            + ('' if is_open else ' opacity-80') + '">'
            + '<span class="material-symbols-outlined ' + icon_color + ' mt-0.5 shrink-0">' + icon + '</span>'
            + '<div class="flex-1 min-w-0">'
            + '<div class="flex items-start justify-between gap-3">'
            + '<div class="flex items-start gap-2 min-w-0">'
            + flag
            + '<h4 data-news-title class="font-bold text-frosted-blue break-words min-w-0'
            + ('' if is_open else ' min-h-12 sm:min-h-0') + '">' + escape_html(post.get("title") or "") + '</h4>'
            + '</div>'
            + '<span class="shrink-0 text-[10px] text-steel-blue font-bold uppercase">'
            + escape_html(news_date_label(created_ms, now_ms)) + '</span>'
            + '</div>'
            + body
            + toggle
            + '</div>'
            + '</div>')


def render_home_news(posts: list, count: int, now_ms: int) -> str:
    """home.js renderNews: the first `count` posts as cards, or the empty state."""
    if not posts:
        return NEWS_EMPTY_HTML
    return "".join(render_news_card(p, now_ms) for p in posts[:count])


def home_news_settings(branding: dict) -> tuple:
    """home.js newsSettings: (count, max_age_days), 0 days meaning no window."""
    cfg = (branding or {}).get("news") or {}
    count = cfg.get("homepage_count") or 3
    raw_age = cfg.get("homepage_max_age_days")
    max_age = 0 if raw_age == 0 else (raw_age or 30)
    return count, max_age


def load_home_news(branding: dict) -> Optional[dict]:
    """The posts Home would read for a signed-in person, or None when the News
    section is off or the database cannot say (the page keeps its skeleton
    and the script fills it, as before). Published posts only: the page asks
    the API for published posts, whoever is reading."""
    if (branding.get("home_sections") or {}).get("news") is False:
        return None
    from app.database import SessionLocal
    from app.routers.news import news_query

    count, max_age = home_news_settings(branding)
    db = None
    try:
        db = SessionLocal()
        rows = news_query(db, published_only=True, max_age_days=max_age or None).limit(count + 1).all()
        posts = [{"title": r.title, "content_html": sanitize_html(r.content_html or ""),
                  "created_at": r.created_at, "pinned": bool(r.pinned)} for r in rows]
    except Exception:  # noqa: BLE001 - the page script fills the section instead
        logger.warning("Could not read Home's news for the page render", exc_info=True)
        return None
    finally:
        if db is not None:
            db.close()
    return {"posts": posts, "count": count}


def now_ms() -> int:
    return (datetime.now(timezone.utc) - _EPOCH) // timedelta(milliseconds=1)
