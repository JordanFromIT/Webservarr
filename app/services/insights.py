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
