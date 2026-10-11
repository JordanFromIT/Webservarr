"""
What Insights records as it happens (docs/superpowers/specs/2026-10-10-insights-design.md,
section 5): who asked for which book, the Kavita account each person
connected, their Kavita reading totals once a day, their place in each
ebook WebServarr reads for them, and the minutes Kavita measured them reading
each day (the nightly sweep, services/insights_kavita). Listening is recorded by the player's own
log and its hourly rollup (app/services/listening.py).

Each writer is called by a route that has already done its own job, through
best_effort, so a database failure here is logged and never fails that
route. Writes are single statements (INSERT ... ON CONFLICT), so two workers
cannot race. Nothing is held between calls.
"""
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import BookRequester, EbookPlace, KavitaLink, ReadingMinutes, ReadingTotal, Setting

logger = logging.getLogger(__name__)

KEEP_DAYS = 730
REQUEST_FORMATS = ("ebook", "audiobook", "both")
FOREIGN_ID_MAX = 100
TITLE_MAX = 300
USERNAME_MAX = 100
# Internal row: the UTC day this install began recording for Insights
# (seed.migrate_insights_started_v1), for "Tracking started on ...".
STARTED_KEY = "insights.tracking_started"


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _whole(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def best_effort(db: Session, what: str, write, *args, **kwargs):
    """Run one of the writers below for a route that has already done its
    job: a database failure is rolled back and logged (its kind only), never
    raised. Returns the writer's answer, or None when it failed."""
    try:
        return write(db, *args, **kwargs)
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("Insights could not record %s: %s", what, type(exc).__name__)
        return None


def record_request(db: Session, identity: str, foreign_id, title, fmt: str,
                   now: Optional[datetime] = None) -> bool:
    """Record that `identity` asked for a book. False, and nothing written,
    without an identity or a book id, or for a format not in REQUEST_FORMATS."""
    if not identity or fmt not in REQUEST_FORMATS or not isinstance(foreign_id, str) or not foreign_id.strip():
        return False
    db.add(BookRequester(identity=identity, foreign_id=foreign_id.strip()[:FOREIGN_ID_MAX],
                         title=(title if isinstance(title, str) else "")[:TITLE_MAX], format=fmt,
                         requested_at=now or now_utc()))
    db.commit()
    return True


def record_kavita_link(db: Session, identity: str, account, now: Optional[datetime] = None) -> bool:
    """Record the Kavita account a person just connected. `account` is
    Kavita's /api/account answer; only its id and username are read (it also
    holds the person's API key, which is never touched here). False, and
    nothing written, without an identity or with neither."""
    if not identity or not isinstance(account, dict):
        return False
    user_id = account.get("id")
    if not (isinstance(user_id, int) and not isinstance(user_id, bool) and user_id > 0):
        user_id = None
    username = account.get("username")
    username = username.strip()[:USERNAME_MAX] if isinstance(username, str) else ""
    if user_id is None and not username:
        return False
    at = now or now_utc()
    values = {"kavita_user_id": user_id, "kavita_username": username, "linked_at": at}
    db.execute(sqlite_insert(KavitaLink).values(identity=identity, **values)
               .on_conflict_do_update(index_elements=[KavitaLink.identity], set_=values))
    db.commit()
    return True


def has_reading_today(db: Session, identity: str, now: Optional[datetime] = None) -> bool:
    """True when today's (UTC) reading totals are already kept for this person."""
    day = (now or now_utc()).date()
    return db.query(ReadingTotal.id).filter(ReadingTotal.identity == identity,
                                            ReadingTotal.day == day).first() is not None


def record_reading_totals(db: Session, identity: str, totals, now: Optional[datetime] = None) -> bool:
    """Keep today's reading totals (kavita.reading_stats: pages, words,
    hours): one row a UTC day, the latest read that day wins."""
    if not identity or not isinstance(totals, dict):
        return False
    at = now or now_utc()
    values = {"pages": _whole(totals.get("pages")), "words": _whole(totals.get("words")),
              "hours": _whole(totals.get("hours")), "seen_at": at}
    db.execute(sqlite_insert(ReadingTotal).values(identity=identity, day=at.date(), **values)
               .on_conflict_do_update(index_elements=[ReadingTotal.identity, ReadingTotal.day], set_=values))
    db.commit()
    return True


def record_ebook_places(db: Session, identity: str, places, now: Optional[datetime] = None) -> int:
    """Keep this person's place in each of these ebooks: {catalog book id:
    {"page", "pages", "at"}} (kavita.book_places' places, keyed by the book).
    A place replaces the one kept before. Returns how many were kept."""
    if not identity or not isinstance(places, dict):
        return 0
    at = now or now_utc()
    kept = 0
    for book_id, place in places.items():
        if not (isinstance(book_id, int) and not isinstance(book_id, bool)) or not isinstance(place, dict):
            continue
        read_at = place.get("at")
        values = {"page": _whole(place.get("page")), "pages": _whole(place.get("pages")),
                  "read_at": read_at if isinstance(read_at, datetime) else None, "seen_at": at}
        db.execute(sqlite_insert(EbookPlace).values(identity=identity, book_id=book_id, **values)
                   .on_conflict_do_update(index_elements=[EbookPlace.identity, EbookPlace.book_id], set_=values))
        kept += 1
    db.commit()
    return kept


def ebook_place_times(db: Session, identity: str, book_ids) -> dict:
    """{catalog book id: when this person last read it} for those of these
    books with a kept place (Kavita's own time, else when WebServarr saw it).
    Read only from what is kept here: no call to Kavita. Scoped by identity."""
    wanted = [b for b in dict.fromkeys(book_ids or ()) if isinstance(b, int) and not isinstance(b, bool)]
    if not identity or not wanted:
        return {}
    found = {}
    for start in range(0, len(wanted), 400):
        for book_id, read_at, seen_at in (db.query(EbookPlace.book_id, EbookPlace.read_at, EbookPlace.seen_at)
                                          .filter(EbookPlace.identity == identity,
                                                  EbookPlace.book_id.in_(wanted[start:start + 400]))):
            found[book_id] = read_at or seen_at
    return found


def record_reading_minutes(db: Session, identity: str, minutes, now: Optional[datetime] = None) -> int:
    """Keep the minutes this person read on each UTC day as Kavita measured
    them ({date: whole minutes}, from the nightly sweep). A day's figure
    replaces the one kept before. A day of 0 is not written, so a day Kavita
    no longer counts keeps what was read. Returns how many days were kept."""
    if not identity or not isinstance(minutes, dict):
        return 0
    at = now or now_utc()
    kept = 0
    for day, count in minutes.items():
        if not isinstance(day, date) or isinstance(day, datetime) or not _whole(count):
            continue
        values = {"minutes": count, "seen_at": at}
        db.execute(sqlite_insert(ReadingMinutes).values(identity=identity, day=day, **values)
                   .on_conflict_do_update(index_elements=[ReadingMinutes.identity, ReadingMinutes.day], set_=values))
        kept += 1
    db.commit()
    return kept


def prune(db: Session, now: Optional[datetime] = None) -> int:
    """Delete what is older than KEEP_DAYS: requests, daily totals and
    minutes, and places WebServarr has not seen for that long. The Kavita
    links stay (one row a person, replaced at each connect). Returns how many
    rows went."""
    cutoff = (now or now_utc()) - timedelta(days=KEEP_DAYS)
    gone = db.query(BookRequester).filter(BookRequester.requested_at < cutoff).delete(synchronize_session=False)
    gone += db.query(ReadingTotal).filter(ReadingTotal.day < cutoff.date()).delete(synchronize_session=False)
    gone += db.query(ReadingMinutes).filter(ReadingMinutes.day < cutoff.date()).delete(synchronize_session=False)
    gone += db.query(EbookPlace).filter(EbookPlace.seen_at < cutoff).delete(synchronize_session=False)
    db.commit()
    return gone


def tracking_started(db: Session) -> Optional[date]:
    """The UTC day this install began recording for Insights, or None before the migration ran."""
    row = db.query(Setting.value).filter(Setting.key == STARTED_KEY).first()
    try:
        return datetime.strptime(row[0], "%Y-%m-%d").date() if row else None
    except ValueError:
        return None
