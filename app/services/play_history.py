"""
Play history: a person's own listening and reading sessions, newest first,
for the Play history window (GET /api/me/history).

Listening comes from the player's check-in log (listening_log), which holds
a row about every 10 s while a book plays and is pruned after
listening.LOG_DAYS. The rows are grouped into sessions the way the player's
own history panel groups one book's log (player/features.js groupSessions),
so a session reads the same in both places: within one book, a new session
starts at another device (its device id, else its label) or after a gap of
more than SESSION_GAP. Ten minutes, from the dev log: check-ins sit 10 s
apart, short pauses (3 and 6 minutes) resume the same sitting, and the next
gaps up (14, 19, 53 and 56 minutes) were each a new sitting after a leave or
a pause. Kavita closes a reading session after the same 10 minutes without a
page turn, so both kinds of session mean the same thing.

Reading comes from Kavita's own reading sessions (kavita.reading_sessions),
read with the person's own token: WebServarr keeps only each book's latest
place (ebook_places), never a session.

Paging is by a cursor, the newest-first position of the last session given:
"<ISO instant>Z~a<log row id>" for listening (the session's newest row),
"<ISO instant>Z~e<session id>.<chapter id>" for reading. The next page holds
the sessions that sort after it, by (end, kind, id). A listening session
running across the cursor is never split into a second, partial one: the log
is read from SESSION_GAP above the cursor, so its newer rows are seen, its
end lands above the cursor and it is left out as the earlier page's.

Every query is by the caller's identity. Nothing is kept between calls (two
uvicorn workers).
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterable, List, Optional, Tuple

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models import ListeningLog
from app.services import listening

SESSION_GAP = timedelta(minutes=10)
PAGE_DEFAULT = 20
PAGE_MAX = 50
KINDS = ("all", "audio", "ebook")
BATCH = 2000                       # log rows read at a time
EMPTY_HOPS = 4                     # empty pages read past in one request (see the router)
# The id a reading resume key carries: every session ending at that instant
# sorts before it, so none of them is skipped.
RESUME_ID = 10 ** 18 - 1
DAYS = listening.LOG_DAYS          # how far back history goes (the log's own reach)

# Within a cursor's (end, kind, id, sub) order, listening sorts after reading
# at the same instant.
RANK = {"a": 1, "e": 0}

_CURSOR = re.compile(r"(?P<at>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)Z~(?P<kind>[ae])"
                     r"(?P<id>\d{1,18})(?:\.(?P<sub>\d{1,18}))?", re.ASCII)


def parse_cursor(value: str) -> tuple:
    """(end, rank, id, sub) from a history cursor. Raises ValueError."""
    m = _CURSOR.fullmatch(value) if isinstance(value, str) else None
    if not m:
        raise ValueError("before must be a cursor from an earlier page")
    try:
        at = datetime.fromisoformat(m.group("at"))
    except ValueError:
        raise ValueError("before must be a cursor from an earlier page") from None
    if at > datetime.max - SESSION_GAP:
        # Reading starts SESSION_GAP above the cursor: no such time exists.
        raise ValueError("before must be a cursor from an earlier page")
    return at, RANK[m.group("kind")], int(m.group("id")), int(m.group("sub") or 0)


def make_cursor(key: tuple) -> str:
    at, rank, ident, sub = key
    kind = "a" if rank == RANK["a"] else "e"
    return at.isoformat(timespec="microseconds") + "Z~" + kind + str(ident) + (f".{sub}" if kind == "e" else "")


# --- Listening sessions ---------------------------------------------------------------

@dataclass
class AudioSession:
    book_key: str
    who: str
    device: str
    end_id: int
    end_at: datetime
    end_track: str
    end_offset_ms: int
    end_book_ms: Optional[int]
    duration_ms: Optional[int]
    chapter_label: Optional[str]
    start_at: datetime
    start_book_ms: Optional[int]
    listened_ms: int = 0
    closed: bool = False
    rows: int = 1

    @property
    def key(self) -> tuple:
        return (self.end_at, RANK["a"], self.end_id, 0)


def _who(device_id, device) -> str:
    return ("id:" + device_id) if device_id else ("label:" + (device or ""))


def group_rows(rows: Iterable, keys=None, sessions: Optional[list] = None,
               open_by_book: Optional[dict] = None) -> list:
    """Log rows, newest first, as listening sessions in the order found
    (newest end first). Each row is (id, book_key, track_key, offset_ms,
    device, device_id, event, at, book_ms, book_duration_ms, chapter_label).
    `keys`: only rows of these books count (None: all). `sessions` and
    `open_by_book` carry the state across batches (group_rows fills them)."""
    out = sessions if sessions is not None else []
    open_ = open_by_book if open_by_book is not None else {}
    for (row_id, book, track, offset, device, device_id, event, at, book_ms, book_dur, label) in rows:
        if keys is not None and book not in keys:
            continue
        who = _who(device_id, device)
        cur = open_.get(book)
        if cur is not None and cur.who == who and cur.start_at - at <= SESSION_GAP:
            # An older row of the same sitting. A playing row counts the time to
            # the next row (the newer one already in the session) when that gap is
            # short, as listening.listened_spans counts it.
            gap = cur.start_at - at
            if event in listening.PLAYING_EVENTS and timedelta(0) <= gap <= listening.LISTEN_GAP:
                cur.listened_ms += int(gap.total_seconds() * 1000)
            cur.start_at = at
            cur.start_book_ms = book_ms if book_ms is not None else cur.start_book_ms
            cur.rows += 1
            continue
        if cur is not None:
            cur.closed = True
        cur = AudioSession(book_key=book, who=who, device=device or "", end_id=row_id, end_at=at,
                           end_track=str(track), end_offset_ms=int(offset), end_book_ms=book_ms,
                           duration_ms=book_dur, chapter_label=(label or None), start_at=at,
                           start_book_ms=book_ms)
        open_[book] = cur
        out.append(cur)
    return out


def audio_sessions(db: Session, identity: str, keys, before: Optional[tuple], limit: int,
                   now: Optional[datetime] = None) -> Tuple[List[AudioSession], bool]:
    """(up to `limit` listening sessions that sort after `before`, newest
    first; whether there are more). `keys`: the book keys the caller may
    see (a session of any other book is left out). One query at a time of
    BATCH rows, newest first, stopping as soon as the page's sessions are
    complete."""
    L = ListeningLog
    cols = (L.id, L.book_key, L.track_key, L.offset_ms, L.device, L.device_id, L.event, L.at, L.book_ms,
            L.book_duration_ms, L.chapter_label)
    base = db.query(*cols).filter(L.identity == identity)
    if before is not None:
        base = base.filter(L.at <= before[0] + SESSION_GAP)
    found: list = []
    open_by_book: dict = {}
    last = None
    while True:
        q = base
        if last is not None:
            q = q.filter(or_(L.at < last[0], and_(L.at == last[0], L.id < last[1])))
        batch = q.order_by(L.at.desc(), L.id.desc()).limit(BATCH).all()
        group_rows(batch, keys, found, open_by_book)
        done = len(batch) < BATCH
        if batch:
            last = (batch[-1][7], batch[-1][0])
        oldest = last[0] if last else None
        for s in open_by_book.values():
            # Any row not read yet is no newer than `oldest`, so it would be
            # further than SESSION_GAP from this session's start.
            if done or (oldest is not None and s.start_at - oldest > SESSION_GAP):
                s.closed = True
        eligible = [s for s in found if before is None or s.key < before]
        page = eligible[:limit]
        if done or (len(eligible) > limit and all(s.closed for s in page)):
            return page, len(eligible) > limit


# --- Reading sessions -----------------------------------------------------------------

@dataclass
class EbookSession:
    session_id: int
    chapter_id: int
    start: datetime
    end: datetime
    start_page: int
    end_page: int
    pages: int
    seconds: int

    @property
    def key(self) -> tuple:
        return (self.end, RANK["e"], self.session_id, self.chapter_id)


def ebook_page(rows: list, chapters: dict, before: Optional[tuple], limit: int,
               complete: bool) -> Tuple[List[EbookSession], bool, Optional[tuple]]:
    """(up to `limit` reading sessions in books the caller may see, newest
    end first; whether there may be more; where the next page starts when
    none of these rows could be shown). `rows` are kavita.reading_sessions
    rows, `chapters` the Kavita chapter ids the caller may see (catalog
    books), `complete` whether Kavita had no more."""
    seen = set()
    items = []
    for r in rows:
        k = (r["session_id"], r["chapter_id"])
        if k in seen or r["chapter_id"] not in chapters:
            continue
        seen.add(k)
        s = EbookSession(session_id=r["session_id"], chapter_id=r["chapter_id"], start=r["start"], end=r["end"],
                         start_page=r["start_page"], end_page=r["end_page"], pages=r["pages"],
                         seconds=r["seconds"])
        if before is None or s.key < before:
            items.append(s)
    items.sort(key=lambda s: s.key, reverse=True)
    more = len(items) > limit or not complete
    resume = None
    if not complete and len(items) <= limit and rows:
        # Kavita had more than one read could take and too few of them could be
        # shown: the next page goes on below the oldest row read.
        oldest = min(r["end"] for r in rows)
        resume = (oldest, RANK["e"], RESUME_ID, 0)
    return items[:limit], more, resume


# --- Shared ---------------------------------------------------------------------------

def page_size(limit) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= PAGE_MAX:
        raise ValueError(f"limit must be from 1 to {PAGE_MAX}")
    return limit


@dataclass
class Merged:
    items: list = field(default_factory=list)
    next_key: Optional[tuple] = None


def merge(audio: list, audio_more: bool, ebooks: list, ebook_more: bool, limit: int,
          ebook_resume: Optional[tuple] = None) -> Merged:
    """Both kinds in one newest-first page of at most `limit`, and the key the
    next page starts after (None: no more). A kind with more to give holds
    the page's end at its own last session: the next page reads past it."""
    both = sorted(audio + ebooks, key=lambda s: s.key, reverse=True)
    page = both[:limit]
    more = len(both) > limit or audio_more or ebook_more
    if not more:
        return Merged(page, None)
    if page:
        next_key = page[-1].key
        # A kind that stopped early (it had more) must not be skipped past: the
        # page ends no later than that kind's last session.
        for items, has_more in ((audio, audio_more), (ebooks, ebook_more)):
            if has_more and items:
                last = items[-1].key
                if last > next_key:
                    page = [s for s in page if s.key >= last]
                    next_key = last
        # Reading that stopped early with nothing it could show has read only
        # down to ebook_resume: the page ends there too, so the sessions
        # between it and the end of this page are read next, not skipped.
        if ebook_more and not ebooks and ebook_resume is not None and ebook_resume > next_key:
            page = [s for s in page if s.key >= ebook_resume]
            next_key = ebook_resume
        return Merged(page, next_key)
    return Merged([], ebook_resume)
