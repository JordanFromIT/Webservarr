"""
The audiobook player's Plex bridge: books, chapters, a listener's server
access, Plex's own listening state, and timeline write-through.

The audiobook library is a Plex music library: artist (author), album, disc
(the book), tracks (the files). A book's key is "<album ratingKey>:<disc>".
One track is a single-file book whose chapters come from the file; several
tracks are a multi-part book whose parts are its chapters.

Two tokens are in play and never mix:

- The admin token (integration.plex.token) reads the library structure,
  which is the same for every listener.
- The listener's own server access token, which plex.tv hands to their Plex
  account for this server, reads their listening state, writes their
  timeline, and goes to their browser for streaming. It is cached in their
  session (Redis), because uvicorn's two workers share nothing else.

Every token travels in the X-Plex-Token header, never in a query string, so
no URL in a log line or an exception can carry one. Nothing here logs a
response body.
"""

import hashlib
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlsplit

import httpx

from app.auth import session_manager
from app.integrations import config as integration_config
from app.integrations import plex
from app.utils import utc_iso

logger = logging.getLogger(__name__)

LIBRARY_KEY = "integration.plex.audiobook_library"
# The session field holding the listener's server access, and how long it is
# trusted before plex.tv is asked again.
SERVER_FIELD = "player_server"
SERVER_TTL = 6 * 60 * 60

PMS_TIMEOUT = 10.0
PLEX_TV_TIMEOUT = 10.0
RESOURCES_URL = "https://plex.tv/api/v2/resources"

# "<album>:<disc>", ASCII digits only and bounded (the store caps keys at 64).
_BOOK_KEY = re.compile(r"([0-9]{1,20}):([0-9]{1,6})", re.ASCII)
_RATING_KEY = re.compile(r"[0-9]{1,20}", re.ASCII)

TIMELINE_STATES = ("playing", "paused", "stopped")

# Generic client identity for every Plex call made on a listener's behalf.
PRODUCT = "WebServarr"
PLATFORM = "Web"
VERSION = "1.0"


class PlayerUnavailable(Exception):
    """Plex or plex.tv could not answer (maps to 503)."""


class NoServerAccess(PlayerUnavailable):
    """The listener has no Plex token, or plex.tv does not list the configured
    server for them. A PlayerUnavailable, so it maps to 503 unless the caller
    chooses to treat it as the listener's own lack of access."""


class NotInLibrary(Exception):
    """The key is malformed or not in the configured audiobook library (maps to 404)."""


class PlayerOff(NotInLibrary):
    """No audiobook library is configured: the player is off (404)."""


# --- Config -------------------------------------------------------------------

def _admin() -> dict:
    """The admin Plex address and token, and the audiobook library section."""
    config = plex._get_config()
    section = (integration_config.read((LIBRARY_KEY,)).get(LIBRARY_KEY) or "").strip()
    return {"url": config["url"], "token": config["token"],
            "section": section if _RATING_KEY.fullmatch(section) else ""}


def _configured(need_section: bool = True) -> dict:
    admin = _admin()
    if need_section and not admin["section"]:
        raise PlayerOff("No audiobook library is configured")
    if not admin["url"] or not admin["token"]:
        raise PlayerUnavailable("Plex is not configured")
    return admin


def parse_key(key) -> tuple:
    """(album, disc) from a book key, or NotInLibrary before any Plex call."""
    m = _BOOK_KEY.fullmatch(key) if isinstance(key, str) else None
    if not m:
        raise NotInLibrary("Malformed book key")
    return m.group(1), int(m.group(2))


def client_identifier(session: dict) -> str:
    """The X-Plex-Client-Identifier for this listener's player.

    Derived from the listener's Plex account id alone, so both workers (and
    every request) compute the same value with nothing shared between them,
    and Plex sees one steady player per listener instead of one per request.
    Hashed so the id itself is not sent as a device name."""
    who = session.get("plex_account_id") or session.get("user_id") or ""
    digest = hashlib.sha256(f"webservarr-player:{who}".encode()).hexdigest()[:16]
    return f"webservarr-player-{digest}"


def _client_headers(session: dict) -> dict:
    return {
        "Accept": "application/json",
        "X-Plex-Product": PRODUCT,
        "X-Plex-Version": VERSION,
        "X-Plex-Platform": PLATFORM,
        "X-Plex-Device-Name": PRODUCT,
        "X-Plex-Client-Identifier": client_identifier(session),
    }


async def _pms_get(client: httpx.AsyncClient, admin: dict, token: str, path: str,
                   params: Optional[dict] = None) -> Optional[dict]:
    """GET a Plex Media Server path as JSON: its MediaContainer, or None on a
    404. Anything else that is not a 200 is PlayerUnavailable."""
    try:
        resp = await client.get(f"{admin['url']}{path}", params=params,
                                headers={"X-Plex-Token": token, "Accept": "application/json"})
    except httpx.HTTPError as exc:
        logger.warning("Plex request for %s failed: %s", path, type(exc).__name__)
        raise PlayerUnavailable("Plex is unavailable") from None
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        logger.warning("Plex returned HTTP %d for %s", resp.status_code, path)
        raise PlayerUnavailable("Plex is unavailable")
    try:
        return (resp.json() or {}).get("MediaContainer") or {}
    except ValueError:
        logger.warning("Plex sent a response that is not JSON for %s", path)
        raise PlayerUnavailable("Plex is unavailable") from None


def _pms_client() -> httpx.AsyncClient:
    # The admin address is usually the LAN server with a self-signed
    # certificate, as for every other Plex call in the app.
    return httpx.AsyncClient(timeout=PMS_TIMEOUT, verify=False)


# --- Server access --------------------------------------------------------------

def _cached_access(session: dict, admin: dict) -> Optional[dict]:
    raw = session.get(SERVER_FIELD)
    if not raw:
        return None
    try:
        blob = json.loads(raw)
        at = int(blob["at"])
        token = blob["token"]
        uris = blob["uris"]
        if not (isinstance(token, str) and token and isinstance(uris, dict)):
            return None
        local, remote = list(uris.get("local") or []), list(uris.get("remote") or [])
    except (ValueError, TypeError, KeyError):
        return None
    now = time.time()
    if not (now - SERVER_TTL < at <= now) or blob.get("base") != admin["url"]:
        return None
    return {"token": token, "uris": {"local": local, "remote": remote}}


def _usable_uri(conn: dict) -> Optional[str]:
    """The connection's URI when it is a direct https plex.direct address."""
    if conn.get("relay") or (conn.get("protocol") or "").lower() != "https":
        return None
    uri = (conn.get("uri") or "").strip().rstrip("/")
    try:
        parts = urlsplit(uri)
        parts.port  # noqa: B018 - raises on a malformed port
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if (parts.scheme != "https" or not host.endswith(".plex.direct") or parts.path or parts.query
            or parts.fragment or parts.username or parts.password):
        return None
    return uri


async def _server_machine_id(admin: dict) -> str:
    async with _pms_client() as client:
        container = await _pms_get(client, admin, admin["token"], "/identity")
    mid = (container or {}).get("machineIdentifier")
    if not mid:
        logger.warning("Plex /identity gave no machine identifier")
        raise PlayerUnavailable("Plex is unavailable")
    return str(mid)


async def _fetch_access(session: dict, admin: dict) -> dict:
    machine = await _server_machine_id(admin)
    try:
        async with httpx.AsyncClient(timeout=PLEX_TV_TIMEOUT) as client:
            resp = await client.get(
                RESOURCES_URL, params={"includeHttps": 1},
                headers={**_client_headers(session), "X-Plex-Token": session["plex_token"]},
            )
    except httpx.HTTPError as exc:
        logger.warning("plex.tv resources request failed: %s", type(exc).__name__)
        raise PlayerUnavailable("plex.tv is unavailable") from None
    if resp.status_code != 200:
        logger.warning("plex.tv resources returned HTTP %d", resp.status_code)
        raise PlayerUnavailable("plex.tv is unavailable")
    try:
        resources = resp.json()
    except ValueError:
        logger.warning("plex.tv resources sent a response that is not JSON")
        raise PlayerUnavailable("plex.tv is unavailable") from None

    server = next((r for r in (resources if isinstance(resources, list) else [])
                   if isinstance(r, dict) and str(r.get("clientIdentifier")) == machine
                   and "server" in (r.get("provides") or "").split(",")), None)
    if server is None:
        logger.info("plex.tv does not list the configured server for this listener")
        raise NoServerAccess("The configured Plex server is not shared with this account")
    token = server.get("accessToken")
    if not token:
        logger.warning("plex.tv listed the configured server without an access token")
        raise NoServerAccess("No access token for the configured Plex server")

    uris = {"local": [], "remote": []}
    # IPv4 before IPv6: a browser is likelier to reach it.
    conns = sorted((c for c in (server.get("connections") or []) if isinstance(c, dict)),
                   key=lambda c: bool(c.get("IPv6")))
    for conn in conns:
        uri = _usable_uri(conn)
        side = uris["local" if conn.get("local") else "remote"]
        if uri and uri not in side:
            side.append(uri)
    if not uris["local"] and not uris["remote"]:
        logger.warning("The configured server advertises no direct https plex.direct connection")
        raise PlayerUnavailable("No usable connection to the Plex server")
    return {"token": token, "uris": uris}


async def server_access(session: dict, session_id: Optional[str] = None) -> dict:
    """The listener's access to the configured server:
    {"token": str, "uris": {"local": [...], "remote": [...]}}.

    `session` is the listener's session dict and `session_id` its id: the
    result is written back to the session (field SERVER_FIELD) for SERVER_TTL
    and also set on the dict, so the rest of this request reuses it. Without
    a session_id nothing is persisted.

    Raises NoServerAccess (a PlayerUnavailable) for a session without a Plex
    token or an account the server is not shared with, and PlayerUnavailable
    when Plex or plex.tv cannot answer."""
    if not session.get("plex_token"):
        raise NoServerAccess("This session has no Plex token")
    admin = _configured(need_section=False)
    cached = _cached_access(session, admin)
    if cached:
        return cached
    access = await _fetch_access(session, admin)
    blob = json.dumps({**access, "at": int(time.time()), "base": admin["url"]})
    session[SERVER_FIELD] = blob
    if session_id:
        await session_manager.update_session(session_id, {SERVER_FIELD: blob})
    return access


# --- Books ------------------------------------------------------------------------

_READ_BY = (
    re.compile(r"^(?P<title>.*?)\s+-\s+Read by\s+(?P<narrator>.+?)\s*$", re.IGNORECASE),
    re.compile(r"^(?P<title>.*?)\s*\((?:Narrated|Read) by\s+(?P<narrator>.+?)\)\s*$", re.IGNORECASE),
)
_PART_SUFFIX = re.compile(r"[\s,\-]+Part\s*[0-9]+\s*$", re.IGNORECASE)


def _split_narrator(title: str) -> tuple:
    """("Title", "Narrator") from "Title - Read by Narrator" or
    "Title (Narrated by Narrator)"; the narrator is "" when not named."""
    title = (title or "").strip()
    for pattern in _READ_BY:
        m = pattern.match(title)
        if m and m.group("title").strip():
            return m.group("title").strip(), m.group("narrator").strip()
    return title, ""


def _int(value) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _part(t: dict) -> dict:
    media = t.get("Media") or [{}]
    parts = (media[0] or {}).get("Part") or [{}]
    return parts[0] or {}


def _track_duration(t: dict) -> int:
    return _int(t.get("duration")) or _int(_part(t).get("duration"))


def _pick_copy(tracks: list) -> list:
    """One disc's tracks in play order, with a duplicate copy left out.

    Some discs hold the same book twice, from two folders (a whole file and a
    set of parts, or two sets of parts), which shows as repeated track
    numbers. Playing both would repeat the book, so then the tracks are
    grouped by folder and one copy is kept: a copy whose track numbers do not
    repeat, then the longest, then the earliest added. Without a repeated
    number every track is kept, so a book spread over several folders (CD1,
    CD2) stays whole."""
    def order(t):
        return (_int(t.get("index")), _int(t.get("ratingKey")))

    indexes = [_int(t.get("index")) for t in tracks]
    if len(set(indexes)) == len(indexes):
        return sorted(tracks, key=order)
    folders = {}
    for t in tracks:
        folder = (_part(t).get("file") or "").rsplit("/", 1)[0]
        folders.setdefault(folder, []).append(t)
    if len(folders) == 1:
        return sorted(tracks, key=order)

    def rank(group):
        indexes = [_int(t.get("index")) for t in group]
        return (len(set(indexes)) == len(indexes), sum(_track_duration(t) for t in group),
                -min(_int(t.get("ratingKey")) for t in group))
    return sorted(max(folders.values(), key=rank), key=order)


def _discs(tracks: list) -> dict:
    """{disc number: [tracks in play order]} for one album's tracks."""
    discs = {}
    for t in tracks:
        if t.get("type", "track") == "track" and t.get("ratingKey"):
            discs.setdefault(_int(t.get("parentIndex")) or 1, []).append(t)
    return {disc: _pick_copy(ts) for disc, ts in discs.items()}


def _describe(album: dict, disc: int, tracks: list, disc_count: int) -> dict:
    """The fields a book shows, from its album and its tracks."""
    album_title, narrator = _split_narrator(album.get("title") or album.get("parentTitle") or "")
    collection = next((c.get("tag") for c in (album.get("Collection") or [])
                       if isinstance(c, dict) and c.get("tag")), "")
    series, series_narrator = _split_narrator(collection)
    first = tracks[0] if tracks else {}
    if disc_count > 1:
        # The album is a series and each disc a book: the book is named by
        # its tracks, and the album names the series.
        title = _PART_SUFFIX.sub("", (first.get("title") or "").strip()) or f"{album_title}, Disc {disc}"
        series = series or album_title
    else:
        title = album_title
    return {
        "title": title,
        "author": (album.get("parentTitle") or first.get("grandparentTitle") or "").strip(),
        "series": series,
        "narrator": narrator or series_narrator,
        "cover": album.get("thumb") or first.get("parentThumb") or first.get("thumb") or "",
    }


def _summary(album: dict, disc: int, tracks: list, disc_count: int) -> dict:
    return {
        "key": f"{album.get('ratingKey')}:{disc}",
        **_describe(album, disc, tracks, disc_count),
        "duration_ms": sum(_track_duration(t) for t in tracks),
        "shape": "single" if len(tracks) == 1 else "parts",
    }


async def list_books() -> list:
    """Every book in the audiobook library, read with the admin token:
    [{key, title, author, series, narrator, cover, duration_ms, shape}].

    `cover` is the album's Plex thumbnail path, not a URL. Raises PlayerOff
    when no library is configured and PlayerUnavailable when Plex fails."""
    admin = _configured()
    path = f"/library/sections/{admin['section']}/all"
    async with _pms_client() as client:
        albums = await _pms_get(client, admin, admin["token"], path, {"type": 9})
        tracks = await _pms_get(client, admin, admin["token"], path, {"type": 10})
    if albums is None or tracks is None:
        logger.warning("The configured audiobook library section was not found")
        raise PlayerUnavailable("The audiobook library was not found")

    by_album = {}
    for t in tracks.get("Metadata") or []:
        by_album.setdefault(str(t.get("parentRatingKey")), []).append(t)
    books = []
    for album in albums.get("Metadata") or []:
        discs = _discs(by_album.get(str(album.get("ratingKey")), []))
        for disc, ts in discs.items():
            books.append((album.get("titleSort") or album.get("title") or "", disc,
                          _summary(album, disc, ts, len(discs))))
    books.sort(key=lambda b: (b[2]["author"].casefold(), b[0].casefold(), b[1]))
    return [b[2] for b in books]


async def _album(client: httpx.AsyncClient, admin: dict, album_key: str) -> dict:
    """The album's metadata when it is an album in the audiobook library."""
    container = await _pms_get(client, admin, admin["token"], f"/library/metadata/{album_key}")
    items = (container or {}).get("Metadata") or []
    album = items[0] if items else {}
    section = str(album.get("librarySectionID") or (container or {}).get("librarySectionID") or "")
    if album.get("type") != "album" or section != admin["section"]:
        raise NotInLibrary("Not in the audiobook library")
    return album


async def _book(client: httpx.AsyncClient, admin: dict, key: str) -> tuple:
    """(album, disc, the disc's tracks in play order, disc count) for a book in the library."""
    album_key, disc = parse_key(key)
    album = await _album(client, admin, album_key)
    children = await _pms_get(client, admin, admin["token"], f"/library/metadata/{album_key}/children")
    discs = _discs((children or {}).get("Metadata") or [])
    if disc not in discs:
        raise NotInLibrary("Not in the audiobook library")
    return album, disc, discs[disc], len(discs)


def _chapter_label(tag, n: int, total: int) -> str:
    """A chapter's own title, or "Chapter N of M" when it has none worth
    showing (missing, or only a number)."""
    text = " ".join(str(tag or "").replace("\xa0", " ").split())
    if not text or not re.search(r"[^\W\d_]", text):
        return f"Chapter {n} of {total}"
    return text


def _file_chapters(track: dict, duration: int) -> list:
    """A single file's chapters as contiguous [start, end) ranges covering the
    whole file: each ends where the next starts, the first starts at 0 and
    the last ends at the file's duration."""
    marks = {}
    for c in track.get("Chapter") or []:
        start = _int(c.get("startTimeOffset"))
        if start < duration and start not in marks:
            marks[start] = c.get("tag")
    starts = sorted(marks)
    if not starts:
        starts, marks = [0], {0: None}
    elif starts[0] != 0:
        marks[0] = marks.pop(starts[0])
        starts[0] = 0
    total = len(starts)
    rk = str(track.get("ratingKey"))
    return [{"index": i + 1, "label": _chapter_label(marks[s], i + 1, total), "start_ms": s,
             "end_ms": starts[i + 1] if i + 1 < total else duration, "track": rk}
            for i, s in enumerate(starts)]


async def book_detail(key: str) -> dict:
    """One book, read with the admin token: the book_list fields plus
    tracks [{key, part_path, duration_ms, index}] in play order (index from 1)
    and chapters [{index, label, start_ms, end_ms, track}], whose times are
    book time (a multi-part book's parts laid end to end).

    A single file's chapters are its own ("Chapter N of M" when untitled); a
    multi-part book's chapters are its parts ("Part N of M"). Raises
    NotInLibrary, PlayerOff or PlayerUnavailable."""
    admin = _configured()
    parse_key(key)
    async with _pms_client() as client:
        album, disc, tracks, disc_count = await _book(client, admin, key)
        chapters = []
        if len(tracks) == 1:
            only = tracks[0]
            full = await _pms_get(client, admin, admin["token"], f"/library/metadata/{only['ratingKey']}",
                                  {"includeChapters": 1})
            items = (full or {}).get("Metadata") or [only]
            chapters = _file_chapters(items[0], _track_duration(only))

    out_tracks, start = [], 0
    for i, t in enumerate(tracks):
        duration = _track_duration(t)
        out_tracks.append({"key": str(t["ratingKey"]), "part_path": _part(t).get("key") or "",
                           "duration_ms": duration, "index": i + 1})
        if len(tracks) > 1:
            chapters.append({"index": i + 1, "label": f"Part {i + 1} of {len(tracks)}", "start_ms": start,
                             "end_ms": start + duration, "track": str(t["ratingKey"])})
        start += duration
    return {**_summary(album, disc, tracks, disc_count), "tracks": out_tracks, "chapters": chapters}


async def assert_in_library(key: str, track_key: Optional[str] = None) -> None:
    """NotInLibrary unless the book's album is in the audiobook library and,
    when `track_key` is given, that track belongs to this book (album and
    disc). Malformed keys are refused before any Plex call. PlayerOff when
    no library is configured; PlayerUnavailable when Plex fails."""
    album_key, disc = parse_key(key)
    if track_key is not None and not (isinstance(track_key, str) and _RATING_KEY.fullmatch(track_key)):
        raise NotInLibrary("Malformed track key")
    admin = _configured()
    async with _pms_client() as client:
        await _album(client, admin, album_key)
        if track_key is None:
            return
        container = await _pms_get(client, admin, admin["token"], f"/library/metadata/{track_key}")
    items = (container or {}).get("Metadata") or []
    t = items[0] if items else {}
    if (t.get("type") != "track" or str(t.get("parentRatingKey")) != album_key
            or (_int(t.get("parentIndex")) or 1) != disc):
        raise NotInLibrary("Not in this book")


# --- Plex's listening state ---------------------------------------------------------

async def plex_position(session: dict, key: str, session_id: Optional[str] = None) -> Optional[dict]:
    """Plex's own position for this listener and book, or None when Plex has
    none: {track, offset_ms, duration_ms, book_ms, book_duration_ms,
    updated_at, device, source}. `duration_ms` is the track's, `updated_at`
    the track's lastViewedAt as ISO UTC (the listening store's format).

    The book's tracks are the admin view; each track's viewOffset, viewCount
    and lastViewedAt are read with the listener's server token. The most
    recently touched track wins: an offset is a place inside that track, and
    a finished track (viewCount, no offset) puts the place at the start of
    the next one, or at the end of the book after the last."""
    admin = _configured()
    parse_key(key)
    access = await server_access(session, session_id=session_id)
    async with _pms_client() as client:
        _album_meta, _disc, tracks, _n = await _book(client, admin, key)
        album_key = key.split(":", 1)[0]
        mine = await _pms_get(client, admin, access["token"], f"/library/metadata/{album_key}/children")
    state = {str(t.get("ratingKey")): t for t in (mine or {}).get("Metadata") or []}

    durations = [_track_duration(t) for t in tracks]
    best = None   # (lastViewedAt, in progress, track position, offset)
    for i, t in enumerate(tracks):
        s = state.get(str(t["ratingKey"]), {})
        seen = _int(s.get("lastViewedAt"))
        offset = _int(s.get("viewOffset"))
        if offset > 0:
            candidate = (seen, 1, i, min(offset, durations[i]))
        elif _int(s.get("viewCount")) > 0:
            candidate = (seen, 0, i + 1, 0) if i + 1 < len(tracks) else (seen, 0, i, durations[i])
        else:
            continue
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    if best is None or not best[0]:
        return None
    seen, _, i, offset = best
    return {
        "track": str(tracks[i]["ratingKey"]),
        "offset_ms": offset,
        "duration_ms": durations[i],
        "book_ms": sum(durations[:i]) + offset,
        "book_duration_ms": sum(durations),
        "updated_at": utc_iso(datetime.fromtimestamp(seen, timezone.utc)),
        "device": "Plex",
        "source": "plex",
    }


async def timeline(session: dict, track_key: str, state: str, time_ms: int, duration_ms: int,
                   session_id: Optional[str] = None) -> None:
    """Report playback to Plex's /:/timeline with the listener's server token,
    so Plex's own apps see the place and Plex shows the session. Best effort:
    every failure is logged and swallowed."""
    try:
        if state not in TIMELINE_STATES:
            logger.warning("Timeline state %r refused", state)
            return
        if not (isinstance(track_key, str) and _RATING_KEY.fullmatch(track_key)):
            logger.warning("Timeline refused a malformed track key")
            return
        duration = _int(duration_ms)
        position = min(_int(time_ms), duration) if duration else _int(time_ms)
        admin = _configured(need_section=False)
        access = await server_access(session, session_id=session_id)
        async with _pms_client() as client:
            resp = await client.get(
                f"{admin['url']}/:/timeline",
                params={"ratingKey": track_key, "key": f"/library/metadata/{track_key}", "state": state,
                        "time": position, "duration": duration,
                        "identifier": "com.plexapp.plugins.library"},
                headers={**_client_headers(session), "X-Plex-Token": access["token"]},
            )
        if resp.status_code != 200:
            logger.warning("Plex timeline returned HTTP %d", resp.status_code)
    except (PlayerUnavailable, NotInLibrary) as exc:
        logger.info("Plex timeline skipped: %s", exc)
    except httpx.HTTPError as exc:
        logger.warning("Plex timeline failed: %s", type(exc).__name__)
    except Exception as exc:  # noqa: BLE001 - best effort by contract, never raised
        logger.warning("Plex timeline failed unexpectedly: %s", type(exc).__name__)
