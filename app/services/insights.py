"""
Insights: reading and listening across everyone, for the admin
(docs/superpowers/specs/2026-10-10-insights-design.md).

Only app/routers/insights.py calls this, and every route there is admin only.
Nothing here changes what a member's own pages show them.

Where each figure comes from (spec section 4; the page labels the estimates):
- Web listening: wall time from the player's check-in log, as Your stats
  counts it (listening.listened_spans): listening_hourly for the hours the
  rollup holds, the log for the hours after them (listens).
- Plex app listening: Plex's own history, one play per track, counted at the
  track's length, an estimate. The web player reports to Plex too, so a play
  is the web player's own, and left out, when the same person listened to the
  same book on the web around it (app_plays).
- Reading: Kavita's lifetime totals as WebServarr read them each day
  (reading_totals; pages on a day are the rise from the day before) and places
  in ebooks (ebook_places).
- Requests: book_requesters, matched to the library by folded title.

People are named, and keyed for the browser by utils.identity_key; an account
identity never leaves the server. Nothing is held in this module between
calls (two uvicorn workers): Plex's answers are cached in Redis (cache_get,
cache_set) and every figure is worked out from the database on each call.
"""
import bisect
import json
import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Iterable, List, Optional, Set, Tuple

from redis.exceptions import RedisError
from sqlalchemy import exists, func
from sqlalchemy.orm import Session

from app.models import (Book, BookAudioEdition, BookRequester, BookVisit, EbookPlace, ListeningHourly,
                        ListeningLog, ListeningPosition, ReadingTotal, User)
from app.services import book_catalog, insights_store, listening
from app.utils import identity_key, utc_iso

logger = logging.getLogger(__name__)

PERIODS = {"30d": 30, "90d": 90, "1y": 365, "all": None}
BUCKETS = {"30d": "day", "90d": "week", "1y": "month", "all": "month"}
NOW_PLAYING = timedelta(seconds=60)        # the player checks in every 10 s while it plays
NOW_PAUSED = timedelta(minutes=10)
CURRENT = timedelta(days=30)               # a current book was touched this recently
ABANDONED = timedelta(days=30)             # an abandoned one has been untouched this long
STARTED_MS = 5 * 60 * 1000                 # less than this into a book is a mis-tap (as book_discovery.LISTENER_MS)
ECHO_SLACK = timedelta(hours=1)
ECHO_DAY = timedelta(days=1)               # web listening read this much before a period, for the echo rule
CURRENT_MAX = 5
TOP = 10
LIST_MAX = 100
NEVER_OPENED_MAX = 50
HISTORY_WEEKS = 12
DROP_OFF_MIN = 2                           # a drop-off chapter is one at least this many stopped in
GONE_TITLE = "A book no longer in the library"
EPOCH = datetime(1970, 1, 1)

CACHE_PREFIX = "webservarr:insights:v1:"
ANSWER_TTL = 5 * 60
PLAYS_TTL = 10 * 60
DURATIONS_TTL = 6 * 60 * 60
PEOPLE_TTL = 60 * 60


@dataclass(frozen=True)
class Listen:
    """Web listening by one person in one book in one UTC hour."""
    identity: str
    hour: datetime
    book_key: str
    source: str
    ms: int


@dataclass(frozen=True)
class Play:
    """One track played in a Plex app; `ms` is the track's length, the estimate."""
    identity: str
    book_key: str
    at: datetime
    ms: int


@dataclass(frozen=True)
class BookInfo:
    book_id: Optional[int]
    title: str
    author: str
    series: str


@dataclass(frozen=True)
class Place:
    """A person's place in an audiobook edition (listening_positions)."""
    identity: str
    book_key: str
    updated_at: datetime
    percent: Optional[int]
    finished: bool
    book_ms: int
    chapter: str
    device: str


@dataclass(frozen=True)
class EbookAt:
    """A person's place in an ebook (ebook_places). `at` is Kavita's time, else when WebServarr saw it."""
    identity: str
    book_id: int
    at: datetime
    percent: Optional[int]
    finished: bool
    started: bool


@dataclass
class Sources:
    """What one answer is worked out from. `plays` are the Plex app plays (the
    web player's own left out), None while Plex can't be read."""
    listens: List[Listen]
    plays: Optional[List[Play]]
    names: Dict[str, str]
    now: datetime
    unavailable: List[str] = field(default_factory=list)


# --- Small helpers ---------------------------------------------------------------

def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def since_of(period: str, now: datetime) -> Optional[datetime]:
    days = PERIODS[period]
    return None if days is None else now - timedelta(days=days)


def _hour(at: datetime) -> datetime:
    return at.replace(minute=0, second=0, microsecond=0)


def _local(at: datetime, zone) -> datetime:
    return at.replace(tzinfo=timezone.utc).astimezone(zone)


def _monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _weeks(now: datetime, zone, count: int) -> List[date]:
    this = _monday(_local(now, zone).date())
    return [this - timedelta(weeks=n) for n in range(count - 1, -1, -1)]


def _chunks(items, size: int = 400):
    items = list(items)
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _percent(ms, total) -> Optional[int]:
    if ms is None or not total or total <= 0:
        return None
    return max(0, min(100, int(ms * 100 // total)))


def _stamp(value) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    try:
        found = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return found.astimezone(timezone.utc).replace(tzinfo=None) if found.tzinfo else found


def _ident(info: BookInfo, key: str) -> tuple:
    """One book, whichever edition: its catalog id, else (a book gone from the library) its key."""
    return ("book", info.book_id) if info.book_id is not None else ("key", key)


# --- Redis caches (Plex's answers and whole answers) ------------------------------

async def cache_get(r, key: str):
    if r is None:
        return None
    try:
        raw = await r.get(CACHE_PREFIX + key)
        return json.loads(raw) if raw else None
    except (RedisError, ValueError) as exc:
        logger.info("Insights cache read failed: %s", type(exc).__name__)
        return None


async def cache_set(r, key: str, value, ttl: int) -> None:
    if r is None:
        return
    try:
        await r.set(CACHE_PREFIX + key, json.dumps(value), ex=ttl)
    except RedisError as exc:
        logger.info("Insights cache write failed: %s", type(exc).__name__)


async def plex_people(r) -> Tuple[str, Dict[str, str]]:
    """(the owner's plex.tv id, {plex.tv id: name}) from plex.tv, cached for
    PEOPLE_TTL; ("", {}) while plex.tv can't be read: names then fall back to
    short_name, and the owner's plays (Plex's account 1) are left out."""
    from app.integrations import plex_share

    found = await cache_get(r, "people")
    if found is None:
        try:
            found = await plex_share.server_people()
        except plex_share.PlexShareUnavailable as exc:
            logger.info("plex.tv people could not be read for Insights: %s", type(exc).__name__)
            return "", {}
        await cache_set(r, "people", found, PEOPLE_TTL)
    return str(found.get("owner") or ""), dict(found.get("names") or {})


async def plex_plays(r, owner: str) -> Optional[List[Play]]:
    """Every play in the audiobook library, by person, counted at its track's
    length (history cached PLAYS_TTL, lengths DURATIONS_TTL). [] with no
    audiobook library; None while Plex can't be read."""
    from app.integrations import plex_player as pp

    try:
        events = await cache_get(r, "plays")
        if events is None:
            events = [dict(e, viewed_at=utc_iso(e["viewed_at"])) for e in await pp.play_events(EPOCH)]
            await cache_set(r, "plays", events, PLAYS_TTL)
        lengths = await cache_get(r, "durations")
        if lengths is None:
            lengths = await pp.track_durations()
            await cache_set(r, "durations", lengths, DURATIONS_TTL)
    except pp.PlayerOff:
        return []
    except (pp.PlayerUnavailable, pp.NotInLibrary) as exc:
        logger.info("Plex's history could not be read for Insights: %s", type(exc).__name__)
        return None
    return to_plays(events, owner, lengths)


# --- Listening ---------------------------------------------------------------------

def listens(db: Session, since: Optional[datetime] = None) -> List[Listen]:
    """Web listening by person, hour, book and source from `since` (all of it
    for None): listening_hourly for the hours the rollup holds, the log for
    the hours after them."""
    H, L = ListeningHourly, ListeningLog
    done = listening.hours_through(db)
    q = db.query(H.identity, H.hour, H.book_key, H.source, H.ms)
    if since is not None:
        q = q.filter(H.hour >= _hour(since))
    if done is not None:
        q = q.filter(H.hour < done)
    out = [Listen(*row) for row in q]
    start = done if done is not None else (_hour(since) if since is not None else None)
    tail = db.query(L.identity, L.at, L.event, L.book_key, L.source)
    if start is not None:
        tail = tail.filter(L.at >= start)
    by_identity: Dict[str, list] = {}
    for identity, at, event, book, source in tail.order_by(L.identity, L.at, L.id):
        by_identity.setdefault(identity, []).append((at, event, book, source))
    totals: Dict[tuple, int] = {}
    for identity, rows in by_identity.items():
        spans = listening.listened_spans((at, event, book) for at, event, book, _source in rows)
        for (at, book, ms), row in zip(spans, rows):
            if ms and (since is None or _hour(at) >= _hour(since)):
                key = (identity, _hour(at), book, row[3] or "web")
                totals[key] = totals.get(key, 0) + ms
    return out + [Listen(i, h, b, s, ms) for (i, h, b, s), ms in totals.items()]


def to_plays(events, owner: str, durations: Dict[str, int]) -> List[Play]:
    """Plex's history events (plex_player.play_events, as cached) as plays by
    identity. Plex numbers its server's owner 1 in its history: that is
    `owner`'s plex.tv id; without it, the owner's plays are left out. A play
    whose track's length is not known counts 0."""
    plays = []
    for e in events if isinstance(events, list) else []:
        if not isinstance(e, dict):
            continue
        account = str(e.get("account") or "")
        if account == "1":
            account = owner
        at = _stamp(e.get("viewed_at"))
        book = e.get("book_key")
        if not account or at is None or not isinstance(book, str):
            continue
        ms = durations.get(str(e.get("track_key") or ""), 0) if isinstance(durations, dict) else 0
        plays.append(Play("plex:" + account, book, at, ms if isinstance(ms, int) else 0))
    return plays


def app_plays(plays: List[Play], web: List[Listen]) -> List[Play]:
    """The plays heard in a Plex app. The web player reports to Plex's
    timeline, so a play is its own, and left out, when the same person
    listened to the same book on the web from the track's length before the
    play, less ECHO_SLACK, to ECHO_SLACK after it."""
    hours: Dict[Tuple[str, str], List[datetime]] = {}
    for listen in web:
        if listen.source == "web":
            hours.setdefault((listen.identity, listen.book_key), []).append(listen.hour)
    for found in hours.values():
        found.sort()
    kept = []
    for play in plays:
        found = hours.get((play.identity, play.book_key), [])
        low = _hour(play.at - timedelta(milliseconds=play.ms) - ECHO_SLACK)
        i = bisect.bisect_left(found, low)
        if i < len(found) and found[i] <= play.at + ECHO_SLACK:
            continue
        kept.append(play)
    return kept


# --- People, books and places -----------------------------------------------------

def short_name(identity: str) -> str:
    """A stand-in for someone whose name is not known: the last four digits of their id."""
    return "Account " + identity.rsplit(":", 1)[-1][-4:]


def names_of(db: Session, identities: Iterable[str], plex_names: Dict[str, str]) -> Dict[str, str]:
    """{identity: the name to show}: a local account's display name, a Plex
    account's plex.tv name, else short_name."""
    wanted = {i for i in identities if i}
    found: Dict[str, str] = {}
    local = {i.split(":", 1)[1]: i for i in wanted if i.startswith("local:")}
    for chunk in _chunks(local):
        for uid, name in db.query(User.uid, User.display_name).filter(User.uid.in_(chunk)):
            found[local[uid]] = name
    for identity in wanted:
        if identity.startswith("plex:") and plex_names.get(identity[5:]):
            found[identity] = plex_names[identity[5:]]
    return {i: found.get(i) or short_name(i) for i in wanted}


def audio_books(db: Session, keys: Iterable[str]) -> Dict[str, BookInfo]:
    """{audiobook key: what it is}: its live catalog book, else (a book gone
    from the library) the title and author a place kept."""
    keys = [k for k in dict.fromkeys(keys) if k]
    editions = book_catalog.live_editions(db, keys)
    books = catalog_books(db, {book_id for book_id, _narrator in editions.values()})
    kept: Dict[str, Tuple[str, str]] = {}
    P = ListeningPosition
    for chunk in _chunks([k for k in keys if k not in editions]):
        for key, title, author in db.query(P.book_key, P.book_title, P.author).filter(
                P.book_key.in_(chunk), P.book_title.isnot(None)):
            kept.setdefault(key, (title, author or ""))
    out = {}
    for key in keys:
        if key in editions and editions[key][0] in books:
            out[key] = books[editions[key][0]]
        else:
            title, author = kept.get(key, (GONE_TITLE, ""))
            out[key] = BookInfo(None, title or GONE_TITLE, author, "")
    return out


def catalog_books(db: Session, ids: Iterable[int]) -> Dict[int, BookInfo]:
    """{book id: the live catalog book}; ids of books no longer live are left out."""
    out = {}
    for chunk in _chunks(set(ids)):
        for book_id, title, author, series in db.query(Book.id, Book.title, Book.author, Book.series).filter(
                Book.id.in_(chunk), Book.merged_into.is_(None)):
            out[book_id] = BookInfo(book_id, title, author or "", series or "")
    return out


def audio_places(db: Session, identity: Optional[str] = None, keys: Optional[Iterable[str]] = None) -> List[Place]:
    """Places in audiobook editions, everyone's (or one person's, or in these
    editions'), finished by the player's own rule (listening.get_places)."""
    P, L = ListeningPosition, ListeningLog
    ended = exists().where(L.identity == P.identity, L.book_key == P.book_key, L.event == "end",
                           L.at == P.updated_at)
    q = db.query(P.identity, P.book_key, P.updated_at, P.book_ms, P.book_duration_ms, P.chapter_label, P.device,
                 ended.label("ended"))
    if identity is not None:
        q = q.filter(P.identity == identity)
    batches = [q] if keys is None else [q.filter(P.book_key.in_(chunk)) for chunk in _chunks(keys)]
    out = []
    for batch in batches:
        for who, key, at, ms, total, chapter, device, was_ended in batch:
            known = ms is not None and total is not None and total > 0
            finished = bool(was_ended) or (known and ms * 100 >= total * listening.FINISHED_PERCENT)
            percent = 100 if finished else (min(99, _percent(ms, total)) if known else None)
            out.append(Place(who, key, at, percent, finished, ms or 0, chapter or "", device or ""))
    return out


def ebook_rows(db: Session, identity: Optional[str] = None, book_ids: Optional[Iterable[int]] = None) -> List[EbookAt]:
    """Places in ebooks, everyone's (or one person's, or in these books)."""
    E = EbookPlace
    q = db.query(E.identity, E.book_id, E.page, E.pages, E.read_at, E.seen_at)
    if identity is not None:
        q = q.filter(E.identity == identity)
    batches = [q] if book_ids is None else [q.filter(E.book_id.in_(chunk)) for chunk in _chunks(set(book_ids))]
    out = []
    for batch in batches:
        for who, book_id, page, pages, read_at, seen_at in batch:
            finished = pages > 0 and page + 1 >= pages
            percent = None if pages <= 0 else (100 if finished else min(99, page * 100 // pages))
            out.append(EbookAt(who, book_id, read_at or seen_at, percent, finished, page > 0 or pages == 0))
    return out


def known_identities(db: Session, src: Sources) -> Set[str]:
    """Everyone Insights has anything about."""
    found = {i for (i,) in db.query(ListeningPosition.identity).distinct()}
    found |= {i for (i,) in db.query(EbookPlace.identity).distinct()}
    found |= {i for (i,) in db.query(BookVisit.identity)}
    found |= {i for (i,) in db.query(BookRequester.identity).distinct()}
    found |= {i for (i,) in db.query(ReadingTotal.identity).distinct()}
    found |= {listen.identity for listen in src.listens}
    found |= {play.identity for play in src.plays or ()}
    return {i for i in found if i}


def identity_for(db: Session, src: Sources, key: str) -> Optional[str]:
    """The person behind a key the page sent (utils.identity_key), or None."""
    for identity in known_identities(db, src):
        if identity_key(identity) == key:
            return identity
    return None


def tracking(db: Session) -> dict:
    """The day each kind of new record began (spec section 7, "Tracking started on")."""
    started = insights_store.tracking_started(db)
    day = started.isoformat() if started else None
    first = db.query(func.min(ListeningHourly.hour)).scalar()
    return {"requests": day, "reading": day, "ebook_places": day, "hours": first.date().isoformat() if first else day}


def requested(db: Session, src: Sources, identity: Optional[str] = None,
              since: Optional[datetime] = None) -> List[dict]:
    """Book requests, newest first, at most LIST_MAX, each with the library
    book its title names (book_catalog.fold; None while it isn't in the
    library) and when the person who asked first listened to it or read it
    after asking (None when they haven't)."""
    R = BookRequester
    q = db.query(R)
    if identity is not None:
        q = q.filter(R.identity == identity)
    if since is not None:
        q = q.filter(R.requested_at >= since)
    rows = q.order_by(R.requested_at.desc(), R.id.desc()).limit(LIST_MAX).all()
    if not rows:
        return []
    titles = {book_catalog.fold(r.title) for r in rows if r.title}
    by_title: Dict[str, int] = {}
    for book_id, title in db.query(Book.id, Book.title).filter(Book.merged_into.is_(None)).order_by(Book.id):
        folded = book_catalog.fold(title)
        if folded in titles:
            by_title.setdefault(folded, book_id)
    matched = {r.id: by_title.get(book_catalog.fold(r.title)) for r in rows}
    ids = {b for b in matched.values() if b is not None}
    keys_of: Dict[int, Set[str]] = {}
    for chunk in _chunks(ids):
        for key, book_id in db.query(BookAudioEdition.plex_book_key, BookAudioEdition.book_id).filter(
                BookAudioEdition.book_id.in_(chunk)):
            keys_of.setdefault(book_id, set()).add(key)
    asked = {r.identity for r in rows}
    times: Dict[Tuple[str, str], List[datetime]] = {}
    for listen in src.listens:
        if listen.identity in asked:
            times.setdefault((listen.identity, listen.book_key), []).append(listen.hour)
    for play in src.plays or ():
        if play.identity in asked:
            times.setdefault((play.identity, play.book_key), []).append(play.at)
    read = {(e.identity, e.book_id): e.at for e in ebook_rows(db, book_ids=ids) if e.identity in asked}
    names = names_of(db, asked, src.names)
    out = []
    for r in rows:
        book_id = matched[r.id]
        started = None
        if book_id is not None:
            after = [t for key in keys_of.get(book_id, ()) for t in times.get((r.identity, key), ())
                     if t >= _hour(r.requested_at)]
            at = read.get((r.identity, book_id))
            if at is not None and at >= r.requested_at:
                after.append(at)
            started = min(after) if after else None
        out.append({"key": identity_key(r.identity), "name": names[r.identity], "title": r.title,
                    "format": r.format, "requested_at": utc_iso(r.requested_at), "book_id": book_id,
                    "started_at": utc_iso(started)})
    return out


# --- Right now -----------------------------------------------------------------------

def now_view(db: Session, names: Dict[str, str], now: datetime) -> dict:
    """Who is listening in the web player now: a place saved in the last
    NOW_PAUSED whose latest log row is not a leave or an end; playing when it
    was saved in the last NOW_PLAYING by a playing event, else paused."""
    P, L = ListeningPosition, ListeningLog
    recent = (db.query(P.identity, P.book_key, P.updated_at, P.book_ms, P.book_duration_ms, P.device)
              .filter(P.updated_at >= now - NOW_PAUSED).all())
    last_event: Dict[Tuple[str, str], str] = {}
    who = sorted({row[0] for row in recent})
    for chunk in _chunks(who):
        for identity, key, event in (db.query(L.identity, L.book_key, L.event)
                                     .filter(L.at >= now - NOW_PAUSED - NOW_PLAYING, L.identity.in_(chunk))
                                     .order_by(L.at, L.id)):
            last_event[(identity, key)] = event
    infos = audio_books(db, [row[1] for row in recent])
    people = names_of(db, who, names)
    found = []
    for identity, key, at, ms, total, device in recent:
        event = last_event.get((identity, key))
        if event in ("leave", "end"):
            continue
        playing = at >= now - NOW_PLAYING and event in listening.PLAYING_EVENTS
        info = infos[key]
        found.append({"key": identity_key(identity), "name": people[identity], "book_id": info.book_id,
                      "title": info.title, "author": info.author, "format": "audio", "where": "web",
                      "state": "playing" if playing else "paused", "device": device or "",
                      "percent": _percent(ms, total), "updated_at": utc_iso(at)})
    found.sort(key=lambda item: (item["state"] != "playing", item["name"].casefold()))
    return {"listening": found, "reading": [], "unavailable": [], "checked_at": utc_iso(now)}


# --- People ----------------------------------------------------------------------------

def _current(info: BookInfo, fmt: str, where: str, percent: Optional[int], at: datetime) -> dict:
    return {"book_id": info.book_id, "title": info.title, "format": fmt, "where": where, "percent": percent,
            "updated_at": utc_iso(at), "at": at}


def _public(item: dict) -> dict:
    return {k: v for k, v in item.items() if k != "at"}


def people_view(db: Session, src: Sources) -> dict:
    """Everyone, most recently active first: when they were last active and
    doing what, their listening in the last 30 days (the Plex part an
    estimate) and up to CURRENT_MAX books they are in the middle of."""
    now = src.now
    month = now - CURRENT
    places = audio_places(db)
    ebooks = ebook_rows(db)
    plays = src.plays or []
    last: Dict[str, Tuple[datetime, str]] = {}

    def seen(identity: str, at: Optional[datetime], what: str) -> None:
        if identity and at is not None and (identity not in last or at > last[identity][0]):
            last[identity] = (at, what)

    for place in places:
        seen(place.identity, place.updated_at, "listening")
    for play in plays:
        seen(play.identity, play.at, "plex")
    for ebook in ebooks:
        seen(ebook.identity, ebook.at, "reading")
    for identity, at in db.query(BookVisit.identity, BookVisit.seen_at):
        seen(identity, at, "visit")
    for identity, at in db.query(BookRequester.identity, func.max(BookRequester.requested_at)).group_by(
            BookRequester.identity):
        seen(identity, at, "request")

    web_ms: Counter = Counter()
    plex_ms: Counter = Counter()
    for listen in src.listens:
        if listen.hour >= _hour(month):
            web_ms[listen.identity] += listen.ms
    recent_plays = [p for p in plays if p.at >= month]
    for play in recent_plays:
        plex_ms[play.identity] += play.ms

    recent_places = [p for p in places if p.updated_at >= month and not p.finished]
    infos = audio_books(db, {p.book_key for p in recent_places} | {p.book_key for p in recent_plays})
    ebook_infos = catalog_books(db, {e.book_id for e in ebooks if e.at >= month and not e.finished})
    current: Dict[str, Dict[tuple, dict]] = {}

    def offer(identity: str, ident: tuple, item: dict) -> None:
        held = current.setdefault(identity, {}).get(ident)
        if held is None or item["at"] > held["at"]:
            current[identity][ident] = item

    for place in recent_places:
        info = infos[place.book_key]
        offer(place.identity, _ident(info, place.book_key),
              _current(info, "audio", "web", place.percent, place.updated_at))
    placed = {(p.identity, p.book_key) for p in places}
    for play in recent_plays:
        if (play.identity, play.book_key) not in placed:
            info = infos[play.book_key]
            offer(play.identity, _ident(info, play.book_key), _current(info, "audio", "plex", None, play.at))
    for ebook in ebooks:
        if ebook.at >= month and not ebook.finished and ebook.book_id in ebook_infos:
            offer(ebook.identity, ("book", ebook.book_id),
                  _current(ebook_infos[ebook.book_id], "ebook", "kavita", ebook.percent, ebook.at))

    names = names_of(db, last, src.names)
    people = []
    for identity, (at, what) in last.items():
        items = sorted(current.get(identity, {}).values(), key=lambda i: i["at"], reverse=True)[:CURRENT_MAX]
        people.append({"key": identity_key(identity), "name": names[identity], "last_active": utc_iso(at),
                       "last_what": what, "listened_ms_30d": web_ms[identity], "plex_ms_30d": plex_ms[identity],
                       "current": [_public(i) for i in items]})
    people.sort(key=lambda p: (p["last_active"] or "", p["name"]), reverse=True)
    return {"people": people, "unavailable": list(src.unavailable), "tracking": tracking(db)}


# --- One person -----------------------------------------------------------------------

def _book_row(row: dict) -> dict:
    return {"book_id": row["book_id"], "title": row["title"], "author": row["author"], "formats": row["formats"],
            "percent": row["percent"], "finished": row["finished"], "listened_ms": row["listened_ms"],
            "plex_ms": row["plex_ms"], "last_at": utc_iso(row["last"])}


def person_view(db: Session, src: Sources, identity: str, zone) -> dict:
    """One person's history: totals, HISTORY_WEEKS weekly bars (web, and Plex
    apps as an estimate, weeks Monday first in `zone`), every book they
    touched (newest first, at most LIST_MAX) and their requests."""
    now = src.now
    mine = [listen for listen in src.listens if listen.identity == identity]
    plays = [play for play in src.plays or () if play.identity == identity]
    places = audio_places(db, identity=identity)
    ebooks = ebook_rows(db, identity=identity)
    infos = audio_books(db, {x.book_key for x in mine} | {x.book_key for x in plays} | {x.book_key for x in places})
    ebook_infos = catalog_books(db, {e.book_id for e in ebooks})
    books: Dict[tuple, dict] = {}

    def row_for(ident: tuple, info: BookInfo, fmt: str) -> dict:
        row = books.setdefault(ident, {"book_id": info.book_id, "title": info.title, "author": info.author,
                                       "formats": [], "percent": None, "finished": False, "listened_ms": 0,
                                       "plex_ms": 0, "last": None})
        if fmt not in row["formats"]:
            row["formats"].append(fmt)
        return row

    def touch(row: dict, at: Optional[datetime]) -> None:
        if at is not None and (row["last"] is None or at > row["last"]):
            row["last"] = at

    for place in places:
        info = infos[place.book_key]
        row = row_for(_ident(info, place.book_key), info, "audio")
        if place.percent is not None:
            row["percent"] = max(row["percent"] or 0, place.percent)
        row["finished"] = row["finished"] or place.finished
        touch(row, place.updated_at)
    for listen in mine:
        info = infos[listen.book_key]
        row = row_for(_ident(info, listen.book_key), info, "audio")
        row["listened_ms"] += listen.ms
        touch(row, listen.hour)
    for play in plays:
        info = infos[play.book_key]
        row = row_for(_ident(info, play.book_key), info, "audio")
        row["plex_ms"] += play.ms
        touch(row, play.at)
    for ebook in ebooks:
        info = ebook_infos.get(ebook.book_id)
        if info is None:
            continue
        row = row_for(("book", ebook.book_id), info, "ebook")
        if ebook.percent is not None:
            row["percent"] = max(row["percent"] or 0, ebook.percent)
        row["finished"] = row["finished"] or ebook.finished
        touch(row, ebook.at)
    listed = sorted(books.values(), key=lambda r: r["last"] or datetime.min, reverse=True)

    weeks = _weeks(now, zone, HISTORY_WEEKS)
    weekly = {w: [0, 0] for w in weeks}
    for listen in mine:
        week = _monday(_local(listen.hour, zone).date())
        if week in weekly:
            weekly[week][0] += listen.ms
    for play in plays:
        week = _monday(_local(play.at, zone).date())
        if week in weekly:
            weekly[week][1] += play.ms

    pages = (db.query(ReadingTotal.pages).filter(ReadingTotal.identity == identity)
             .order_by(ReadingTotal.day.desc()).limit(1).scalar())
    visits = [at for (at,) in db.query(BookVisit.seen_at).filter(BookVisit.identity == identity)]
    last = max([r["last"] for r in listed if r["last"]] + visits, default=None)
    return {"key": identity_key(identity), "name": names_of(db, [identity], src.names)[identity],
            "last_active": utc_iso(last),
            "totals": {"listened_ms": sum(x.ms for x in mine), "plex_ms": sum(x.ms for x in plays),
                       "finished": sum(1 for r in listed if r["finished"]), "pages_read": pages},
            "weekly": [{"week": w.isoformat(), "web_ms": weekly[w][0], "plex_ms": weekly[w][1]} for w in weeks],
            "books": [_book_row(r) for r in listed[:LIST_MAX]],
            "requests": requested(db, src, identity=identity),
            "unavailable": list(src.unavailable), "tracking": tracking(db)}


# --- Trends -------------------------------------------------------------------------------

def _bucket(day: date, unit: str) -> date:
    if unit == "day":
        return day
    if unit == "week":
        return _monday(day)
    return day.replace(day=1)


def _next(day: date, unit: str) -> date:
    if unit == "day":
        return day + timedelta(days=1)
    if unit == "week":
        return day + timedelta(weeks=1)
    return (day.replace(day=28) + timedelta(days=4)).replace(day=1)


def _span(first: date, last: date, unit: str) -> List[date]:
    """The starts of every bucket from the one holding `first` to the one holding `last`."""
    out, day = [], _bucket(first, unit)
    while day <= last:
        out.append(day)
        day = _next(day, unit)
    return out


def reading_pages(db: Session, since: Optional[datetime] = None) -> Dict[Tuple[str, date], int]:
    """Pages read per person per UTC day: the rise in Kavita's lifetime total
    from the person's previous row (spec 4.3). Across a gap of days the rise
    lands on the later day, an estimate; a total that went down counts nothing."""
    R = ReadingTotal
    out: Dict[Tuple[str, date], int] = {}
    previous: Dict[str, int] = {}
    for identity, day, pages in db.query(R.identity, R.day, R.pages).order_by(R.identity, R.day):
        if identity in previous and pages > previous[identity] and (since is None or day >= since.date()):
            out[(identity, day)] = pages - previous[identity]
        previous[identity] = pages
    return out


def _top(rows: Iterable[dict], name_of) -> List[dict]:
    """Rows of {"info", "ms", "people"} grouped by a name (book_catalog.name_key), most listened first."""
    groups: Dict[str, dict] = {}
    for row in rows:
        name = name_of(row["info"])
        if not name or not name.strip():
            continue
        group = groups.setdefault(book_catalog.name_key(name), {"name": name, "ms": 0, "people": set()})
        group["ms"] += row["ms"]
        group["people"] |= row["people"]
    ranked = sorted(groups.values(), key=lambda g: (-g["ms"], -len(g["people"]), g["name"].casefold()))
    return [{"name": g["name"], "listened_ms": g["ms"], "people": len(g["people"])} for g in ranked[:TOP]]


def trends_view(db: Session, src: Sources, period: str, zone) -> dict:
    """Spec section 7, Trends: listening per bucket (web, and Plex apps as an
    estimate) with pages read beside it (null before any reading is kept);
    people active each week; the top books, authors and series by time
    listened, then by people. Buckets and weeks are in `zone`."""
    now = src.now
    since = since_of(period, now)
    unit = BUCKETS[period]
    web = [x for x in src.listens if since is None or x.hour >= _hour(since)]
    plays = [x for x in src.plays or () if since is None or x.at >= since]
    pages = reading_pages(db, since)
    ebooks = [e for e in ebook_rows(db) if e.started and (since is None or e.at >= since)]
    today = _local(now, zone).date()
    seen_days = ([_local(x.hour, zone).date() for x in web] + [_local(x.at, zone).date() for x in plays]
                 + [day for (_identity, day) in pages])
    first = _local(since, zone).date() if since is not None else min(seen_days, default=today)

    starts = _span(first, today, unit)
    series = {s: {"web_ms": 0, "plex_ms": 0, "pages": 0} for s in starts}

    def add(day: date, what: str, amount: int) -> None:
        start = _bucket(day, unit)
        if start in series:
            series[start][what] += amount

    for x in web:
        add(_local(x.hour, zone).date(), "web_ms", x.ms)
    for x in plays:
        add(_local(x.at, zone).date(), "plex_ms", x.ms)
    for (_identity, day), amount in pages.items():
        add(day, "pages", amount)
    has_reading = db.query(ReadingTotal.id).first() is not None

    weeks = _span(first, today, "week")[-104:]
    active = {w: set() for w in weeks}

    def mark(day: date, identity: str) -> None:
        week = _monday(day)
        if week in active:
            active[week].add(identity)

    for x in web:
        if x.ms:
            mark(_local(x.hour, zone).date(), x.identity)
    for x in plays:
        mark(_local(x.at, zone).date(), x.identity)
    for (identity, day), _amount in pages.items():
        mark(day, identity)
    for e in ebooks:
        mark(_local(e.at, zone).date(), e.identity)

    infos = audio_books(db, {x.book_key for x in web} | {x.book_key for x in plays})
    ebook_infos = catalog_books(db, {e.book_id for e in ebooks})
    per_book: Dict[tuple, dict] = {}

    def tally(ident: tuple, info: BookInfo, identity: str, ms: int) -> None:
        row = per_book.setdefault(ident, {"info": info, "ms": 0, "people": set()})
        row["ms"] += ms
        row["people"].add(identity)

    for x in web:
        info = infos[x.book_key]
        tally(_ident(info, x.book_key), info, x.identity, x.ms)
    for x in plays:
        info = infos[x.book_key]
        tally(_ident(info, x.book_key), info, x.identity, x.ms)
    for e in ebooks:
        if e.book_id in ebook_infos:
            tally(("book", e.book_id), ebook_infos[e.book_id], e.identity, 0)
    ranked = sorted(per_book.values(), key=lambda r: (-r["ms"], -len(r["people"]), r["info"].title.casefold()))
    return {"period": period, "bucket": unit,
            "buckets": [{"start": s.isoformat(), "web_ms": series[s]["web_ms"], "plex_ms": series[s]["plex_ms"],
                         "pages": series[s]["pages"] if has_reading else None} for s in starts],
            "active": [{"week": w.isoformat(), "people": len(active[w])} for w in weeks],
            "top_books": [{"book_id": r["info"].book_id, "title": r["info"].title, "author": r["info"].author,
                           "listened_ms": r["ms"], "people": len(r["people"])} for r in ranked[:TOP]],
            "top_authors": _top(per_book.values(), lambda info: info.author),
            "top_series": _top(per_book.values(), lambda info: info.series),
            "unavailable": list(src.unavailable), "tracking": tracking(db)}


# --- Books ---------------------------------------------------------------------------------

def books_view(db: Session, src: Sources, period: str) -> dict:
    """Spec section 7, Books: abandoned places (unfinished, untouched for
    ABANDONED, at least STARTED_MS in for audio), the live books no one has
    opened (newest added first), and the finish rate of every book two or
    more people started in the period (their place moved in it), with the
    chapter DROP_OFF_MIN or more of the abandoned ones stopped in."""
    now = src.now
    since = since_of(period, now)
    cutoff = now - ABANDONED
    places = audio_places(db)
    ebooks = ebook_rows(db)
    plays = src.plays or []
    infos = audio_books(db, {p.book_key for p in places} | {p.book_key for p in plays}
                        | {x.book_key for x in src.listens})
    ebook_infos = catalog_books(db, {e.book_id for e in ebooks})
    names = names_of(db, {p.identity for p in places} | {e.identity for e in ebooks}, src.names)

    abandoned = []
    for p in places:
        if not p.finished and p.updated_at < cutoff and p.book_ms >= STARTED_MS:
            info = infos[p.book_key]
            abandoned.append({"key": identity_key(p.identity), "name": names[p.identity], "book_id": info.book_id,
                              "title": info.title, "format": "audio", "percent": p.percent,
                              "chapter": p.chapter or None, "last": p.updated_at})
    for e in ebooks:
        if not e.finished and e.started and e.at < cutoff and e.book_id in ebook_infos:
            info = ebook_infos[e.book_id]
            abandoned.append({"key": identity_key(e.identity), "name": names[e.identity], "book_id": info.book_id,
                              "title": info.title, "format": "ebook", "percent": e.percent, "chapter": None,
                              "last": e.at})
    abandoned.sort(key=lambda a: a["last"], reverse=True)

    opened = {info.book_id for info in infos.values() if info.book_id is not None} | {e.book_id for e in ebooks}
    never = [(book_id, title, author, added) for book_id, title, author, added in
             db.query(Book.id, Book.title, Book.author, Book.added_at).filter(Book.merged_into.is_(None))
             if book_id not in opened]
    never.sort(key=lambda r: (r[3] or datetime.min, r[0]), reverse=True)

    per_book: Dict[tuple, dict] = {}

    def row_for(ident: tuple, info: BookInfo) -> dict:
        return per_book.setdefault(ident, {"info": info, "started": set(), "finished": set(), "stops": Counter()})

    for p in places:
        if (p.book_ms < STARTED_MS and not p.finished) or (since is not None and p.updated_at < since):
            continue
        info = infos[p.book_key]
        row = row_for(_ident(info, p.book_key), info)
        row["started"].add(p.identity)
        if p.finished:
            row["finished"].add(p.identity)
        elif p.updated_at < cutoff and p.chapter:
            row["stops"][p.chapter] += 1
    for e in ebooks:
        if not e.started or e.book_id not in ebook_infos or (since is not None and e.at < since):
            continue
        row = row_for(("book", e.book_id), ebook_infos[e.book_id])
        row["started"].add(e.identity)
        if e.finished:
            row["finished"].add(e.identity)
    finish = []
    for row in per_book.values():
        started = len(row["started"])
        if started < 2:
            continue
        chapter, count = (row["stops"].most_common(1) or [(None, 0)])[0]
        finish.append({"book_id": row["info"].book_id, "title": row["info"].title, "author": row["info"].author,
                       "started": started, "finished": len(row["finished"]),
                       "rate": round(100 * len(row["finished"]) / started),
                       "drop_off": {"chapter": chapter, "people": count} if count >= DROP_OFF_MIN else None})
    finish.sort(key=lambda f: (-f["started"], f["rate"], f["title"].casefold()))
    return {"abandoned": [dict({k: v for k, v in a.items() if k != "last"}, last_at=utc_iso(a["last"]))
                          for a in abandoned[:LIST_MAX]],
            "never_opened": {"count": len(never),
                             "items": [{"book_id": b, "title": t, "author": a or "", "added_at": utc_iso(added)}
                                       for b, t, a, added in never[:NEVER_OPENED_MAX]]},
            "finish": finish[:LIST_MAX],
            "unavailable": list(src.unavailable), "tracking": tracking(db)}


def book_view(db: Session, src: Sources, book_id: int) -> Optional[dict]:
    """Spec section 7, one book: everyone's progress, time and finish in it
    (all its editions and its ebook), its totals and drop-off chapter, and
    who asked for it (by folded title). None for an id that is no book's;
    a merged book's id answers for the book it became."""
    book, survivor = book_catalog.resolve_book(db, book_id)
    if book is None and survivor is not None:
        book = db.get(Book, survivor)
    if book is None:
        return None
    keys = {k for (k,) in db.query(BookAudioEdition.plex_book_key).filter(BookAudioEdition.book_id == book.id)}
    places = audio_places(db, keys=keys)
    ebooks = ebook_rows(db, book_ids=[book.id])
    mine = [x for x in src.listens if x.book_key in keys]
    plays = [x for x in src.plays or () if x.book_key in keys]
    people: Dict[str, dict] = {}

    def row_for(identity: str, fmt: str) -> dict:
        row = people.setdefault(identity, {"formats": [], "percent": None, "finished": False, "listened_ms": 0,
                                           "plex_ms": 0, "last": None})
        if fmt not in row["formats"]:
            row["formats"].append(fmt)
        return row

    def touch(row: dict, at: Optional[datetime]) -> None:
        if at is not None and (row["last"] is None or at > row["last"]):
            row["last"] = at

    for p in places:
        row = row_for(p.identity, "audio")
        if p.percent is not None:
            row["percent"] = max(row["percent"] or 0, p.percent)
        row["finished"] = row["finished"] or p.finished
        touch(row, p.updated_at)
    for x in mine:
        row = row_for(x.identity, "audio")
        row["listened_ms"] += x.ms
        touch(row, x.hour)
    for x in plays:
        row = row_for(x.identity, "audio")
        row["plex_ms"] += x.ms
        touch(row, x.at)
    for e in ebooks:
        row = row_for(e.identity, "ebook")
        if e.percent is not None:
            row["percent"] = max(row["percent"] or 0, e.percent)
        row["finished"] = row["finished"] or e.finished
        touch(row, e.at)

    asked = [r for r in db.query(BookRequester).order_by(BookRequester.requested_at.desc())
             if book_catalog.fold(r.title) == book_catalog.fold(book.title)]
    names = names_of(db, set(people) | {r.identity for r in asked}, src.names)
    cutoff = src.now - ABANDONED
    stops = Counter(p.chapter for p in places
                    if not p.finished and p.updated_at < cutoff and p.book_ms >= STARTED_MS and p.chapter)
    started = {p.identity for p in places if p.book_ms >= STARTED_MS or p.finished} | {
        e.identity for e in ebooks if e.started}
    finished = {p.identity for p in places if p.finished} | {e.identity for e in ebooks if e.finished}
    chapter, count = (stops.most_common(1) or [(None, 0)])[0]
    listed = sorted(people.items(), key=lambda item: item[1]["last"] or datetime.min, reverse=True)
    return {"book_id": book.id, "title": book.title, "author": book.author or "", "series": book.series or "",
            "formats": (["ebook"] if book.kavita_chapter_id is not None else []) + (["audio"] if keys else []),
            "people": [{"key": identity_key(identity), "name": names[identity], "formats": row["formats"],
                        "percent": row["percent"], "finished": row["finished"], "listened_ms": row["listened_ms"],
                        "plex_ms": row["plex_ms"], "last_at": utc_iso(row["last"])}
                       for identity, row in listed[:LIST_MAX]],
            "totals": {"started": len(started), "finished": len(finished),
                       "rate": round(100 * len(finished) / len(started)) if started else 0,
                       "listened_ms": sum(x.ms for x in mine), "plex_ms": sum(x.ms for x in plays)},
            "drop_off": {"chapter": chapter, "people": count} if count >= DROP_OFF_MIN else None,
            "requested_by": [{"key": identity_key(r.identity), "name": names[r.identity],
                              "requested_at": utc_iso(r.requested_at)} for r in asked[:LIST_MAX]],
            "unavailable": list(src.unavailable)}


# --- Habits --------------------------------------------------------------------------------

def habits_view(db: Session, src: Sources, period: str, zone) -> dict:
    """Spec section 7, Habits: the web and Plex app split (Plex an estimate),
    the time-of-day heatmap (7 x 24, Monday first, in `zone`; an hour of web
    listening lands on the local hour its UTC hour starts in) and requested
    then read (the newest LIST_MAX requests in the period)."""
    since = since_of(period, src.now)
    web = [x for x in src.listens if since is None or x.hour >= _hour(since)]
    plays = [x for x in src.plays or () if since is None or x.at >= since]
    heat = [[0] * 24 for _ in range(7)]
    for x in web:
        local = _local(x.hour, zone)
        heat[local.weekday()][local.hour] += x.ms
    for x in plays:
        local = _local(x.at, zone)
        heat[local.weekday()][local.hour] += x.ms
    asked = requested(db, src, since=since)
    return {"split": {"web_ms": sum(x.ms for x in web), "plex_ms": sum(x.ms for x in plays)},
            "heatmap": heat,
            "requested": {"total": len(asked), "read": sum(1 for a in asked if a["started_at"]), "items": asked},
            "unavailable": list(src.unavailable), "tracking": tracking(db)}
