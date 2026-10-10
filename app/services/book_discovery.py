"""
Books discovery (spec 2026-10-04-books-page-discovery-design.md): Recently
added with New badges, Popular on the server, a person's own listening stats,
series follows and "New in your series" notifications.

Privacy is the rule everything here is built around:
- What is a person's own (their visit, stats, follows) is read and written by
  their account identity (tickets.account_identity) only.
- Popularity is a count of different people per book, nothing else. A book
  with fewer than POPULAR_MIN listeners has no row, and the read side checks
  the floor again; the browser only ever gets a rounded label.
- A notification goes to the email the person's own Books visit recorded
  (book_visits), and says only the series and how many books.

Nothing is held in this module between calls (two uvicorn workers): visits,
popularity, follows and announcements are tables; every write that decides
something starts with a write, so SQLite's write lock is held before it reads.
"""

import asyncio
import hashlib
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote

from sqlalchemy import case, exists, func
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.integrations import plex_player as pp
from app.models import (Book, BookAnnounced, BookAudioEdition, BookFollow, BookListEntry, BookPopularity, BookVisit,
                        ListeningDaily, ListeningLog, ListeningPosition, Setting)
from app.services import book_catalog, listening
from app.services.notification_poller import _create_notification
from app.services.push import send_push_to_users
from app.utils import identity_email

logger = logging.getLogger(__name__)

# Recently added: a book's "new" date is the later of the dates of the formats
# the person can reach (a format added later makes it new again).
NEW_WINDOW = timedelta(days=30)
RECENT_MAX = 12
# A visit is a load of Books; the one before it stays the "previous visit"
# while loads come less than VISIT_GAP apart, so browsing never clears badges.
VISIT_GAP = timedelta(minutes=30)

# Popular on the server (audio only for now).
POPULAR_WINDOW = timedelta(days=90)
POPULAR_MIN = 3              # a hard floor: 1 is a person, and 2 lets either one identify the other
POPULAR_MAX = 12
LISTENER_MS = 5 * 60 * 1000  # less than this in a book is a mis-tap, not a listener
POPULARITY_INTERVAL = 60 * 60
LABEL_STEPS = (100, 50, 20, 10, 5, POPULAR_MIN)

# Stats.
STATS_WEEKS = 12
TOP_AUTHORS = 5

# Follows.
MANUAL = "manual"
READ = "read"
OFF = "off"
LIST = "list"
LISTEN = "listen"

CATEGORY = "books"
# Internal row (not an operator setting): set once announcing has a baseline,
# so a fresh database's first catalog never announces every book in it.
ANNOUNCE_BASELINE_KEY = "books.announce_baseline"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def series_key(name) -> str:
    return book_catalog.name_key(name)


# --- Visits and Recently added ------------------------------------------------------

def record_visit(db: Session, identity: str, email: str, now: Optional[datetime] = None) -> Optional[datetime]:
    """Record a load of Books for this person and return their previous
    visit (None on a first visit, and on loads within VISIT_GAP of it). One
    statement, so two workers cannot both roll the visit forward. `email`
    (their session's) is kept when there is one."""
    now = now or _now()
    V = BookVisit
    stmt = sqlite_insert(V).values(identity=identity, email=email or None, seen_at=now, prev_seen_at=None)
    stmt = stmt.on_conflict_do_update(index_elements=[V.identity], set_={
        "prev_seen_at": case((V.seen_at < now - VISIT_GAP, V.seen_at), else_=V.prev_seen_at),
        "seen_at": now,
        "email": func.coalesce(stmt.excluded.email, V.email),
    })
    db.execute(stmt)
    db.commit()
    return db.query(V.prev_seen_at).filter(V.identity == identity).scalar()


def format_dates(db: Session) -> Dict[int, Tuple[Optional[datetime], Optional[datetime]]]:
    """{live book id: (ebook added, audiobook added)}."""
    return {i: (e, a) for i, e, a in db.query(Book.id, Book.ebook_added_at, Book.audio_added_at)
            .filter(Book.merged_into.is_(None))}


def recent(rows: Iterable[book_catalog.CatalogRow], dates: dict, prev_seen_at: Optional[datetime],
           now: Optional[datetime] = None) -> List[Tuple[book_catalog.CatalogRow, bool]]:
    """The RECENT_MAX newest of these books added in the last NEW_WINDOW,
    newest first, each with whether it is new since `prev_seen_at` (never
    on a first visit, when that is None). A book's date is the later of the
    dates of the formats the person can reach."""
    now = now or _now()
    cutoff = now - NEW_WINDOW
    found = []
    for row in rows:
        ebook_at, audio_at = dates.get(row.id, (None, None))
        reached = [d for d, ok in ((ebook_at, row.ebook), (audio_at, row.audio)) if ok and d is not None]
        newest = max(reached) if reached else row.added_at
        if newest is not None and newest >= cutoff:
            found.append((newest, row))
    found.sort(key=lambda pair: (pair[0], pair[1].id), reverse=True)
    return [(row, prev_seen_at is not None and newest > prev_seen_at) for newest, row in found[:RECENT_MAX]]


# --- Popular ------------------------------------------------------------------------

def listeners_label(count: int) -> str:
    """A rounded count: "3+ listeners", "5+ listeners"... never the exact
    number, and nothing below the floor."""
    step = next(s for s in LABEL_STEPS if count >= s)
    return f"{step}+ listeners"


def popular(db: Session) -> List[Tuple[int, int]]:
    """[(book id, listeners)] from the last computation, most listened
    first; only books at or above the floor."""
    return [(b, n) for b, n in db.query(BookPopularity.book_id, BookPopularity.listeners)
            .filter(BookPopularity.listeners >= POPULAR_MIN)
            .order_by(BookPopularity.listeners.desc(), BookPopularity.book_id)]


def store_popularity(db: Session, plays: Optional[list], now: Optional[datetime] = None) -> int:
    """Recompute book_popularity: per live book, the different people who
    listened in the last POPULAR_WINDOW. WebServarr's own data (a place at
    least LISTENER_MS in, or that much time in the log) counts identities;
    Plex's history (`plays`: (account, book key), None when Plex could not
    be read) counts Plex accounts. The two cannot be matched, so the larger
    count stands, never their sum (one person would count twice). Editions
    of one book count a person once. Returns how many books qualify."""
    now = now or _now()
    since = now - POPULAR_WINDOW
    db.query(BookPopularity).delete(synchronize_session=False)      # the write lock, then the read
    editions = book_catalog.live_editions(db)
    own: Dict[int, set] = {}
    P = ListeningPosition
    for identity, key in (db.query(P.identity, P.book_key)
                          .filter(P.updated_at >= since, P.book_ms >= LISTENER_MS, P.identity != "")):
        if key in editions:
            own.setdefault(editions[key][0], set()).add(identity)
    L = ListeningLog
    by_identity: Dict[str, list] = {}
    for identity, at, event, key in (db.query(L.identity, L.at, L.event, L.book_key)
                                     .filter(L.at >= since, L.identity != "").order_by(L.identity, L.at, L.id)):
        by_identity.setdefault(identity, []).append((at, event, key))
    for identity, rows in by_identity.items():
        per_key: Dict[str, int] = {}
        for _at, key, ms in listening.listened_spans(rows):
            per_key[key] = per_key.get(key, 0) + ms
        for key, ms in per_key.items():
            if ms >= LISTENER_MS and key in editions:
                own.setdefault(editions[key][0], set()).add(identity)
    heard: Dict[int, set] = {}
    for account, key in plays or ():
        if key in editions:
            heard.setdefault(editions[key][0], set()).add(account)
    qualified = 0
    for book_id in set(own) | set(heard):
        count = max(len(own.get(book_id, ())), len(heard.get(book_id, ())))
        if count >= POPULAR_MIN:
            db.add(BookPopularity(book_id=book_id, listeners=count, computed_at=now))
            qualified += 1
    db.commit()
    return qualified


async def refresh(now: Optional[datetime] = None) -> None:
    """The leader's hourly pass: popularity (Plex's history read first; when
    it cannot be read, WebServarr's own data alone) and the listening
    rollup by day and by hour."""
    now = now or _now()
    try:
        plays = await pp.play_history(now - POPULAR_WINDOW)
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        logger.info("Plex play history could not be read for Popular: %s", type(exc).__name__)
        plays = None

    def write() -> None:
        db = SessionLocal()
        try:
            store_popularity(db, plays, now)
            listening.roll_up(db, now)
            listening.roll_up_hours(db, now)
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    await asyncio.to_thread(write)


# --- Stats ----------------------------------------------------------------------------

def _local_day(at: datetime, zone) -> date:
    return at.replace(tzinfo=timezone.utc).astimezone(zone).date()


def stats(db: Session, identity: str, zone=timezone.utc, now: Optional[datetime] = None) -> dict:
    """This person's own listening: {listened_ms_6mo, listened_ms_all,
    finished, streak_days, weekly: [{week, ms}], top_authors: [{name, ms}]}.

    Time is wall time from the log (listening.listened_spans); the log keeps
    LOG_DAYS, and all-time adds the days rolled up into listening_daily
    before they were pruned, with what check-ins logged after their day was
    rolled up change (listening.late_changes) until the next rollup takes
    them in, so all-time is never less than six months. Days and weeks
    (Monday first) are in `zone`.
    The streak is the run of days with listening up to today, or up to
    yesterday while today has none yet. Books finished are lifetime (places
    are never pruned), one per catalog book however many editions. Top
    authors are by time over the log."""
    now = now or _now()
    six_months = now - timedelta(days=listening.LOG_DAYS)
    done = listening.rolled_through(db)
    after_rolled = datetime.combine(done + timedelta(days=1), datetime.min.time()) if done else None
    since = None if after_rolled is None else min(six_months, after_rolled)
    spans = listening.listened_spans(listening.log_rows(db, identity, since))

    recent_spans = [(at, key, ms) for at, key, ms in spans if at >= six_months and ms]
    rolled = (db.query(func.coalesce(func.sum(ListeningDaily.ms), 0))
              .filter(ListeningDaily.identity == identity).scalar())
    unrolled = sum(ms for at, _key, ms in spans if after_rolled is None or at >= after_rolled)
    late = sum(ms for ms, _books in listening.late_changes(db, done, listening.rolled_log_id(db), identity).values())

    per_day: Dict[date, int] = {}
    per_book: Dict[str, int] = {}
    for at, key, ms in recent_spans:
        day = _local_day(at, zone)
        per_day[day] = per_day.get(day, 0) + ms
        per_book[key] = per_book.get(key, 0) + ms

    today = _local_day(now, zone)
    days = set(per_day)
    first_logged = _local_day(six_months, zone)
    days |= {d for (d,) in db.query(ListeningDaily.day).filter(ListeningDaily.identity == identity,
                                                                ListeningDaily.ms > 0) if d < first_logged}
    day = today if today in days else today - timedelta(days=1)
    streak = 0
    while day in days:
        streak += 1
        day -= timedelta(days=1)

    monday = today - timedelta(days=today.weekday())
    weeks = [monday - timedelta(weeks=n) for n in range(STATS_WEEKS - 1, -1, -1)]
    weekly = {w: 0 for w in weeks}
    for d, ms in per_day.items():
        start = d - timedelta(days=d.weekday())
        if start in weekly:
            weekly[start] += ms

    return {"listened_ms_6mo": sum(ms for _at, _key, ms in recent_spans),
            "listened_ms_all": int(rolled or 0) + unrolled + late,
            "finished": _finished(db, identity),
            "streak_days": streak,
            "weekly": [{"week": w.isoformat(), "ms": weekly[w]} for w in weeks],
            "top_authors": _top_authors(db, identity, per_book)}


def _top_authors(db: Session, identity: str, per_book: Dict[str, int]) -> List[dict]:
    """The authors of the books listened to, by time: the catalog's author
    for an edition still in it, else the one the place kept."""
    if not per_book:
        return []
    editions = book_catalog.live_editions(db, per_book)
    authors = {i: a for i, a in db.query(Book.id, Book.author).filter(
        Book.id.in_({book_id for book_id, _n in editions.values()}))}
    kept = {k: a for k, a in db.query(ListeningPosition.book_key, ListeningPosition.author).filter(
        ListeningPosition.identity == identity, ListeningPosition.book_key.in_(list(per_book)))}
    totals: Dict[str, list] = {}
    for key, ms in per_book.items():
        name = (authors.get(editions[key][0]) if key in editions else None) or kept.get(key) or ""
        if not name.strip():
            continue
        entry = totals.setdefault(series_key(name), [name, 0])
        entry[1] += ms
    ranked = sorted(totals.values(), key=lambda e: (-e[1], book_catalog.fold(e[0])))
    return [{"name": name, "ms": ms} for name, ms in ranked[:TOP_AUTHORS]]


def _finished(db: Session, identity: str) -> int:
    places = listening.get_places(db, identity)
    keys = [k for k, p in places.items() if p["finished"]]
    if not keys:
        return 0
    editions = book_catalog.live_editions(db, keys)
    works = {k: w for k, w in db.query(ListeningPosition.book_key, ListeningPosition.work_key).filter(
        ListeningPosition.identity == identity, ListeningPosition.book_key.in_(keys))}
    live_works = {w: b for w, b in db.query(BookAudioEdition.work_key, BookAudioEdition.book_id)
                  .join(Book, Book.id == BookAudioEdition.book_id)
                  .filter(Book.merged_into.is_(None), BookAudioEdition.work_key.isnot(None))}
    books = set()
    for key in keys:
        work = works.get(key)
        if key in editions:
            books.add(("book", editions[key][0]))
        elif work and work in live_works:
            books.add(("book", live_works[work]))
        else:
            books.add(("work", work) if work else ("key", key))
    return len(books)


# --- Follows --------------------------------------------------------------------------

def set_follow(db: Session, identity: str, series: str, source: str) -> None:
    """Follow (MANUAL) or unfollow (OFF) a series by hand: the person's
    choice replaces whatever was there."""
    key = series_key(series)
    db.execute(sqlite_insert(BookFollow).values(identity=identity, series=key, source=source, created_at=_now())
               .on_conflict_do_update(index_elements=[BookFollow.identity, BookFollow.series],
                                      set_={"source": source}))
    db.commit()


def note_reading(db: Session, identity: str, series_names: Iterable[str]) -> None:
    """The person is reading a book of each series (seen through their own
    Kavita link): they follow it, unless they have a choice about it already
    (an Unfollow stands)."""
    now = _now()
    for key in {series_key(s) for s in series_names if series_key(s)}:
        db.execute(sqlite_insert(BookFollow).values(identity=identity, series=key, source=READ, created_at=now)
                   .on_conflict_do_nothing())
    db.commit()


def _series_books(db: Session, key: str, exclude: Iterable[int] = ()) -> Dict[int, Optional[float]]:
    """{live book id: series number} of the series."""
    skip = set(exclude)
    return {i: n for i, s, n in db.query(Book.id, Book.series, Book.series_number)
            .filter(Book.merged_into.is_(None), Book.series != "")
            if i not in skip and series_key(s) == key}


def followers(db: Session, key: str, identity: Optional[str] = None,
              exclude: Iterable[int] = ()) -> Dict[str, Optional[float]]:
    """{identity: the highest series number they have reached} for everyone
    following the series (only `identity` when given). Following is a book
    of it on their list, at least LISTENER_MS into one in audio, a Follow by
    hand or reading it; an Unfollow stops all of these. A follower with no
    numbered book reached has None. `exclude`: books not to count (the new
    ones being announced)."""
    numbers = _series_books(db, key, exclude)
    reached: Dict[str, Optional[float]] = {}

    def reach(who: str, number: Optional[float]) -> None:
        held = reached.get(who)
        reached[who] = number if held is None else (held if number is None else max(held, number))

    if numbers:
        ids = list(numbers)
        q = db.query(BookListEntry.identity, BookListEntry.book_id).filter(BookListEntry.book_id.in_(ids))
        if identity is not None:
            q = q.filter(BookListEntry.identity == identity)
        for who, book_id in q:
            reach(who, numbers[book_id])
        keys = {k: b for k, b in db.query(BookAudioEdition.plex_book_key, BookAudioEdition.book_id)
                .filter(BookAudioEdition.book_id.in_(ids))}
        if keys:
            P = ListeningPosition
            q = db.query(P.identity, P.book_key).filter(P.book_key.in_(list(keys)), P.book_ms >= LISTENER_MS)
            if identity is not None:
                q = q.filter(P.identity == identity)
            for who, key_ in q:
                reach(who, numbers[keys[key_]])
    q = db.query(BookFollow.identity, BookFollow.source).filter(BookFollow.series == key)
    if identity is not None:
        q = q.filter(BookFollow.identity == identity)
    for who, source in q:
        if source == OFF:
            reached.pop(who, None)
        elif who not in reached:
            reached[who] = None
    return {who: n for who, n in reached.items() if who}


def is_following(db: Session, identity: str, series: str) -> bool:
    key = series_key(series)
    return bool(identity and key) and identity in followers(db, key, identity=identity)


# --- New in your series ---------------------------------------------------------------

def _announce(session_factory, now: datetime) -> List[Tuple[Tuple[str, str, str], List[str]]]:
    """Mark every live book not yet dealt with, and file one notification per
    follower per series for those that are new: [((title, body, url),
    [emails])] to push once the rows are committed.

    The first statement deletes the marks of books that left the catalog (a
    write, so the write lock is held before anything is read): two passes
    can never both see a book unmarked. Passed over silently: everything
    before the baseline (a fresh database's first catalog), a book that
    absorbed an already marked one (a merge), a book whose newest format is
    older than NEW_WINDOW, and a book without a series or a number. A
    follower hears of the books numbered past the highest they have reached,
    if they have a recorded email and have not turned Books notifications off."""
    db = session_factory()
    try:
        db.query(BookAnnounced).filter(~exists().where(Book.id == BookAnnounced.book_id)).delete(
            synchronize_session=False)
        marked = {i for (i,) in db.query(BookAnnounced.book_id)}
        live = db.query(Book).filter(Book.merged_into.is_(None)).order_by(Book.id).all()
        new = [b for b in live if b.id not in marked]
        baseline = db.query(Setting).filter(Setting.key == ANNOUNCE_BASELINE_KEY).first()
        for book in new:
            db.add(BookAnnounced(book_id=book.id, announced_at=now))
        if baseline is None:
            db.add(Setting(key=ANNOUNCE_BASELINE_KEY, value=now.isoformat(),
                           description="New-in-series announcements started (internal)"))
            db.commit()
            return []
        absorbed = {t for (t,) in db.query(Book.merged_into).filter(Book.merged_into.isnot(None),
                                                                     Book.id.in_(marked))} if marked else set()
        groups: Dict[str, List[Book]] = {}
        for book in new:
            dates = [d for d in (book.ebook_added_at, book.audio_added_at) if d is not None]
            newest = max(dates) if dates else book.added_at
            key = series_key(book.series)
            if (book.id in absorbed or newest is None or newest < now - NEW_WINDOW or not key
                    or book.series_number is None):
                continue
            groups.setdefault(key, []).append(book)

        pushes: Dict[Tuple[str, str, str], List[str]] = {}
        new_ids = {b.id for b in new}
        for key, books in sorted(groups.items()):
            following = followers(db, key, exclude=new_ids)
            if not following:
                continue
            emails = {i: e for i, e in db.query(BookVisit.identity, BookVisit.email)
                      .filter(BookVisit.identity.in_(list(following)))}
            name = books[0].series
            title = f"New in {name}"[:200]
            url = "/books/series?name=" + quote(name, safe="")
            digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
            reference = f"books:{digest}:{min(b.id for b in books)}:{len(books)}"
            for who, reached in sorted(following.items()):
                email = identity_email(emails.get(who))
                count = sum(1 for b in books if reached is None or b.series_number > reached)
                if not email or not count:
                    continue
                body = "1 new book" if count == 1 else f"{count} new books"
                if _create_notification(db, email, CATEGORY, title, body, reference) is not None:
                    db.flush()               # the next follower's dedup check sees it (one email, two accounts)
                    pushes.setdefault((title, body, url), []).append(email)
        db.commit()
        return list(pushes.items())
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


async def announce(session_factory=None, rebuild_ok: bool = True) -> int:
    """After a catalog rebuild: announce the new books in followed series
    (_announce) and push them. A push that fails is logged and dropped; it
    never fails the rebuild. Returns how many notifications were filed."""
    if not rebuild_ok:
        return 0
    pushes = await asyncio.to_thread(_announce, session_factory or SessionLocal, _now())
    filed = 0
    for (title, body, url), emails in pushes:
        filed += len(emails)
        try:
            await send_push_to_users(emails, title, body, CATEGORY, url=url)
        except Exception as exc:  # noqa: BLE001 - the notification rows are saved; a push is best effort
            logger.warning("A Books push could not be sent: %s", type(exc).__name__)
    return filed
