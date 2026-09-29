"""
The audiobook player's Plex bridge: books, chapters, a listener's server
access, Plex's own listening state, and timeline write-through.

The audiobook library is a Plex music library: artist (author), album, disc
(the book), tracks (the files). A book's key is "<album ratingKey>:<disc>".
Chapters come from the files where they carry them; a multi-part book whose
files carry none has its parts as chapters.

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


class NoLibraryAccess(NoServerAccess):
    """The listener reaches the server, but their share does not include the
    audiobook library: their server token cannot read that section."""


class TokenRejected(PlayerUnavailable):
    """Plex answered 401 to the token sent. On the listener's server token it
    means the cached access is stale (revoked share, changed token): the
    cache is dropped so the next call asks plex.tv again."""


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


def player_on() -> bool:
    """True when an audiobook library is configured (the player is on)."""
    return bool(_admin()["section"])


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
    if resp.status_code == 401:
        logger.warning("Plex refused the token for %s (HTTP 401)", path)
        raise TokenRejected("Plex refused the token")
    if resp.status_code != 200:
        logger.warning("Plex returned HTTP %d for %s", resp.status_code, path)
        raise PlayerUnavailable("Plex is unavailable")
    try:
        body = resp.json()
    except ValueError:
        logger.warning("Plex sent a response that is not JSON for %s", path)
        raise PlayerUnavailable("Plex is unavailable") from None
    # An empty answer is an empty container, as before; any other shape than
    # {"MediaContainer": {...}} is Plex misbehaving, not a crash here.
    container = body.get("MediaContainer") if isinstance(body, dict) else None
    if container is None:
        container = {}
    if not isinstance(body, (dict, type(None))) or not isinstance(container, dict):
        logger.warning("Plex sent a response of an unexpected shape for %s", path)
        raise PlayerUnavailable("Plex is unavailable")
    return container


def _items(container, key: str = "Metadata") -> list:
    """A container's list of objects under `key` ([] when there is none).
    Any other shape (an object, a string, a list holding something that is
    not an object) is Plex misbehaving: PlayerUnavailable (503), not a crash."""
    value = container.get(key) if isinstance(container, dict) else None
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, dict) for v in value):
        logger.warning("Plex sent %s of an unexpected shape", key)
        raise PlayerUnavailable("Plex is unavailable")
    return value


def _first(container, key: str) -> dict:
    """The first object of a container's list under `key`, or {} (lenient:
    the Media and Part of a track that is otherwise fine)."""
    value = container.get(key) if isinstance(container, dict) else None
    first = value[0] if isinstance(value, list) and value else None
    return first if isinstance(first, dict) else {}


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


async def forget_access(session: dict, session_id: Optional[str] = None) -> None:
    """Drop the cached server access from the session (the dict and Redis),
    so the next server_access asks plex.tv again."""
    session.pop(SERVER_FIELD, None)
    if session_id:
        try:
            await session_manager.update_session(session_id, {SERVER_FIELD: ""})
        except Exception as exc:  # noqa: BLE001 - the cache still expires within SERVER_TTL
            logger.warning("Could not drop the cached Plex server access: %s", type(exc).__name__)


async def server_access(session: dict, session_id: Optional[str] = None, force: bool = False) -> dict:
    """The listener's access to the configured server:
    {"token": str, "uris": {"local": [...], "remote": [...]}}.

    `session` is the listener's session dict and `session_id` its id: the
    result is written back to the session (field SERVER_FIELD) for SERVER_TTL
    and also set on the dict, so the rest of this request reuses it. Without
    a session_id nothing is persisted. `force` skips the cache and rewrites
    it (for a caller that saw the cached token fail, e.g. a stream refused).
    The cache is also dropped whenever Plex answers 401 to the cached token
    (plex_position, timeline); the configured server's identity is not
    re-checked on every request.

    Raises NoServerAccess (a PlayerUnavailable) for a session without a Plex
    token or an account the server is not shared with, and PlayerUnavailable
    when Plex or plex.tv cannot answer."""
    if not session.get("plex_token"):
        raise NoServerAccess("This session has no Plex token")
    admin = _configured(need_section=False)
    cached = None if force else _cached_access(session, admin)
    if cached:
        return cached
    access = await _fetch_access(session, admin)
    blob = json.dumps({**access, "at": int(time.time()), "base": admin["url"]})
    session[SERVER_FIELD] = blob
    if session_id:
        await session_manager.update_session(session_id, {SERVER_FIELD: blob})
    return access


async def library_access(session: dict, session_id: Optional[str] = None, force: bool = False) -> dict:
    """server_access(), once the listener's own server token is known to read
    the audiobook library section.

    A share can leave a library out, and list_books reads with the admin
    token, so without this a listener outside the library would see every
    book and then fail on the stream. The server's /library/sections lists
    only the sections the token may read. A confirmed check is remembered in
    the same session field as the access ("section"), so it is made once per
    cached access: a refetch (expiry, force, a 401) or a different library
    setting checks again. A refusal is not remembered, so a library shared
    later works at once.

    Raises NoLibraryAccess (a NoServerAccess) when the section is not
    readable, and what server_access raises. A 401 on the listener's token
    drops the cached access and raises TokenRejected."""
    admin = _configured()
    access = await server_access(session, session_id=session_id, force=force)
    try:
        blob = json.loads(session.get(SERVER_FIELD) or "")
    except (ValueError, TypeError):
        blob = None
    if not isinstance(blob, dict):
        blob = None
    if blob and blob.get("section") == admin["section"] and blob.get("token") == access["token"]:
        return access

    async with _pms_client() as client:
        try:
            container = await _pms_get(client, admin, access["token"], "/library/sections")
        except TokenRejected:
            await forget_access(session, session_id)
            raise
    if container is None:
        logger.warning("Plex has no /library/sections for the listener's token")
        raise PlayerUnavailable("Plex is unavailable")
    readable = {str(d.get("key")) for d in _items(container, "Directory")}
    if admin["section"] not in readable:
        logger.info("The listener's share does not include the audiobook library")
        raise NoLibraryAccess("This account cannot read the audiobook library")

    if blob:
        raw = json.dumps({**blob, "section": admin["section"]})
        session[SERVER_FIELD] = raw
        if session_id:
            try:
                await session_manager.update_session(session_id, {SERVER_FIELD: raw})
            except Exception as exc:  # noqa: BLE001 - the check is simply made again next time
                logger.warning("Could not remember the library check: %s", type(exc).__name__)
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
    return _first(_first(t, "Media"), "Part")


def _format(t: dict) -> dict:
    """The track's container, codec and codec profile as Plex reports them
    (lower case, "" when Plex gives none): the player asks the browser with
    them whether it can decode the file itself."""
    media = _first(t, "Media")

    def text(value) -> str:
        return str(value or "").strip().lower()[:64]

    return {"container": text(media.get("container") or _part(t).get("container")),
            "codec": text(media.get("audioCodec")),
            "profile": text(media.get("audioProfile") or _part(t).get("audioProfile"))}


def _track_duration(t: dict) -> int:
    return _int(t.get("duration")) or _int(_part(t).get("duration"))


def _natural(text: str) -> tuple:
    """A sort key that orders "CD2" before "CD10"."""
    return tuple((0, int(p), "") if p.isdigit() else (1, 0, p.casefold())
                 for p in re.split(r"([0-9]+)", text) if p)


def _close(a: int, b: int) -> bool:
    """Two durations the same within max(2 s, 1%)."""
    return abs(a - b) <= max(2000, 0.01 * max(a, b))


_DISC_NUMBER = re.compile(r"(?<![a-z])(?:cd|disc|disk|part)[\s._-]*([0-9]+)(?![0-9])", re.IGNORECASE)


def _disc_parts(folder: str) -> tuple:
    """(the folder's last name with each disc, CD or part number replaced by
    "#", casefolded; those numbers as ints)."""
    name = folder.rsplit("/", 1)[-1]
    return _DISC_NUMBER.sub("#", name).casefold(), tuple(int(n) for n in _DISC_NUMBER.findall(name))


def _disc_siblings(a: str, b: str) -> bool:
    """True when two folder names differ only by a disc, CD or part number
    ("CD1"/"CD2", "Disc 1"/"Disc 2", "Title - CD3"/"Title - CD4"): the discs
    of one rip, never copies of each other, however alike their lengths
    (audio CDs all run 70-79 minutes, and a rip cut into fixed-length tracks
    matches track for track)."""
    (rest_a, nums_a), (rest_b, nums_b) = _disc_parts(a), _disc_parts(b)
    return bool(nums_a) and rest_a == rest_b and nums_a != nums_b


def _same_book(a: list, b: list) -> bool:
    """True when two folders' tracks are copies of one book: the same track
    numbers with durations matching track for track and in total, or one
    whole file whose length matches the other folder's parts put together.

    One track in ten may differ (a re-rip can cut one part differently: a
    live library holds two 22-part copies whose 17th parts differ by 3 min
    while the other 21 agree within 5 s). A short set gets no such slack, so
    two real CDs with numbering restarting at 1 are never taken for copies."""
    da = {_int(t.get("index")): _track_duration(t) for t in a}
    db = {_int(t.get("index")): _track_duration(t) for t in b}
    if len(a) == len(b) == len(da) == len(db) and set(da) == set(db):
        misses = sum(not _close(da[i], db[i]) for i in da)
        return misses <= len(da) // 10 and _close(sum(da.values()), sum(db.values()))
    if (len(a) == 1) != (len(b) == 1):
        return _close(sum(_track_duration(t) for t in a), sum(_track_duration(t) for t in b))
    return False


def _pick_copy(tracks: list) -> list:
    """One disc's tracks in play order, with a duplicate copy left out.

    Some discs hold the same book twice, from two folders (a whole file and a
    set of parts, or two sets of parts), which shows as repeated track
    numbers. Playing both would repeat the book. A multi-CD rip whose folders
    each restart at track 1 repeats numbers too, so folders only count as
    copies when _same_book says so; one of each set of copies is kept (a
    copy whose track numbers do not repeat, then the longest, then the
    earliest added). A folder whose name differs from another folder's only
    by a disc, CD or part number (_disc_siblings) belongs to a CD set: it is
    always kept and never counted as a copy of anything, even though a
    whole-book copy beside a CD set then plays twice. Kept folders play in
    order: a CD set by its disc numbers (CD1, Disc2, CD3), other folders in
    natural order (CD2 before CD10), then by track number. Without a
    repeated number every track is kept in track order."""
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

    def rank(folder):
        group = folders[folder]
        numbers = [_int(t.get("index")) for t in group]
        return (len(set(numbers)) == len(numbers), sum(_track_duration(t) for t in group),
                -min(_int(t.get("ratingKey")) for t in group))

    # A folder with a disc sibling on this disc is part of a CD set: it is
    # always kept and never joins a set of copies, so no third folder can
    # stand in for it. The rest are grouped into sets of copies, of which one
    # each is kept.
    names = sorted(folders, key=_natural)
    in_sequence = [n for n in names if any(_disc_siblings(n, o) for o in names if o != n)]
    sets = []
    for name in (n for n in names if n not in in_sequence):
        home = next((c for c in sets if any(_same_book(folders[name], folders[o]) for o in c)), None)
        if home is None:
            sets.append([name])
        else:
            home.append(name)

    def folder_order(name):
        # A CD set plays by its disc numbers whatever the keyword (CD1,
        # Disc2, CD3); any other folder in natural order.
        if name in in_sequence:
            parent = name.rsplit("/", 1)[0] if "/" in name else ""
            rest, numbers = _disc_parts(name)
            return _natural(f"{parent}/{rest}"), numbers
        return _natural(name), ()

    kept = sorted(in_sequence + [max(c, key=rank) for c in sets], key=folder_order)
    return [t for name in kept for t in sorted(folders[name], key=order)]


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


async def _library() -> list:
    """Every book in the audiobook library, read with the admin token, as
    (album, disc, the disc's tracks in play order, disc count, summary), in
    the order list_books gives them."""
    admin = _configured()
    path = f"/library/sections/{admin['section']}/all"
    async with _pms_client() as client:
        albums = await _pms_get(client, admin, admin["token"], path, {"type": 9})
        tracks = await _pms_get(client, admin, admin["token"], path, {"type": 10})
    if albums is None or tracks is None:
        logger.warning("The configured audiobook library section was not found")
        raise PlayerUnavailable("The audiobook library was not found")

    by_album = {}
    for t in _items(tracks):
        by_album.setdefault(str(t.get("parentRatingKey")), []).append(t)
    books = []
    for album in _items(albums):
        discs = _discs(by_album.get(str(album.get("ratingKey")), []))
        for disc, ts in discs.items():
            books.append((album.get("titleSort") or album.get("title") or "", album, disc, ts, len(discs),
                          _summary(album, disc, ts, len(discs))))
    books.sort(key=lambda b: (b[5]["author"].casefold(), b[0].casefold(), b[2]))
    return [b[1:] for b in books]


async def list_books() -> list:
    """Every book in the audiobook library, read with the admin token:
    [{key, title, author, series, narrator, cover, duration_ms, shape}].

    `cover` is the album's Plex thumbnail path, not a URL. Raises PlayerOff
    when no library is configured and PlayerUnavailable when Plex fails."""
    return [b[4] for b in await _library()]


# --- Series ---------------------------------------------------------------------------
#
# Plex keeps no series or series number for a music album. A book's series is
# its album's collection ("<Series> - Read by <Narrator>", one collection per
# series and narration, so the same series can be there several times, once
# per edition), or, for an album holding several books as discs, the album.
# Its number in the series is the disc number for such an album; otherwise it
# is only ever written in text, if at all: "Book 4", "Vol. 2" or "#3" in the
# album's title, its sort title, the first track's title or the book's
# folder, or the series name followed by a number ("<Series> 6 - Title",
# "<Series> II: Title"). An edition that gives no number takes the one another
# edition of the same title in the same series gives. A book with no number
# has no next book: the order can't be known.

_NUMBERED = re.compile(r"(?:\bbook|\bvolume|\bvol\.?|#)\s*#?\s*([0-9]{1,3})(?![0-9])", re.IGNORECASE)
_NUMBER_WORDS = re.compile(r",?\s*(?:\bbook|\bvolume|\bvol\.?|#)\s*#?\s*[0-9]{1,3}(?![0-9])", re.IGNORECASE)
_ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50}


def _fold(text) -> str:
    """Casefolded, with typographic quotes made plain and spaces collapsed."""
    text = str(text or "").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return " ".join(text.casefold().split())


def _roman(word: str) -> Optional[int]:
    """The value of a Roman numeral from I to L written the usual way, or None."""
    total, prev = 0, 0
    for ch in reversed(word):
        v = _ROMAN.get(ch)
        if v is None:
            return None
        total = total - v if v < prev else total + v
        prev = max(prev, v)
    return total if 0 < total <= 50 and _to_roman(total) == word else None


def _to_roman(n: int) -> str:
    out = ""
    for value, letters in ((50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")):
        while n >= value:
            out += letters
            n -= value
    return out


def _series_number(texts, series: str) -> Optional[int]:
    """The book's number in its series from the first of `texts` that gives
    one, or None."""
    lead = re.compile(re.escape(_fold(series)) + r"[\s,:.\-–]*([0-9]{1,3}|[ivxl]{1,7})\b") if series else None
    for text in texts:
        folded = _fold(text)
        if not folded:
            continue
        m = _NUMBERED.search(folded)
        if m:
            return int(m.group(1))
        m = lead.match(folded) if lead else None
        if m:
            word = m.group(1)
            n = int(word) if word.isdigit() else _roman(word)
            if n:
                return n
    return None


def _title_key(title: str) -> str:
    """A book's title for matching its editions: without its number, case,
    quotes or punctuation."""
    return " ".join(re.sub(r"[^\w]+", " ", _NUMBER_WORDS.sub(" ", _fold(title))).split())


def _series_entries(library: list) -> list:
    """The library's books that belong to a series, each with its series
    (author and name), narrator, number (None when unknown) and summary."""
    entries = []
    for album, disc, tracks, disc_count, summary in library:
        if not summary["series"]:
            continue
        if disc_count > 1:
            number = disc
        else:
            first = tracks[0] if tracks else {}
            folder = (_part(first).get("file") or "").rsplit("/", 1)[0].rsplit("/", 1)[-1]
            number = _series_number((album.get("titleSort"), _split_narrator(album.get("title") or "")[0],
                                     first.get("title"), folder), summary["series"])
        entries.append({"series": (_fold(summary["author"]), _fold(summary["series"])),
                        "title": _title_key(summary["title"]), "narrator": _fold(summary["narrator"]),
                        "number": number, "book": summary})
    # An edition without a number takes the one the same title has in another
    # edition of the series (the most common, the lowest on a tie).
    known = {}
    for e in entries:
        if e["number"] is not None:
            known.setdefault((e["series"], e["title"]), []).append(e["number"])
    for e in entries:
        if e["number"] is None and (e["series"], e["title"]) in known:
            numbers = known[(e["series"], e["title"])]
            e["number"] = min(set(numbers), key=lambda n: (-numbers.count(n), n))
    return entries


def pick_next(entries: list, key: str) -> Optional[dict]:
    """The next book after `key` among _series_entries: the lowest number
    above its own in the same series, by the same narrator when that edition
    has it, else by any; None when there is none or its number is unknown."""
    me = next((e for e in entries if e["book"]["key"] == key), None)
    if me is None or me["number"] is None:
        return None
    later = [e for e in entries if e["series"] == me["series"] and e["number"] is not None
             and e["number"] > me["number"]]
    if not later:
        return None
    n = min(e["number"] for e in later)
    pool = [e for e in later if e["number"] == n]
    same = [e for e in pool if me["narrator"] and e["narrator"] == me["narrator"]]
    pick = min(same or pool, key=lambda e: (e["narrator"], e["title"], e["book"]["key"]))
    return dict(pick["book"])


async def next_in_series(key: str) -> Optional[dict]:
    """The book after this one in its series (the list_books fields), or
    None for a standalone book, the last one, or one whose number in its
    series the library doesn't give (see the Series notes above). A
    malformed key is NotInLibrary before any Plex call. Raises PlayerOff or
    PlayerUnavailable as list_books does."""
    parse_key(key)
    return pick_next(_series_entries(await _library()), key)


async def _album(client: httpx.AsyncClient, admin: dict, album_key: str) -> dict:
    """The album's metadata when it is an album in the audiobook library."""
    container = await _pms_get(client, admin, admin["token"], f"/library/metadata/{album_key}")
    items = _items(container)
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
    discs = _discs(_items(children))
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


# Tracks asked for per chapter request (comma-joined rating keys), which
# bounds the URL on a book of many parts.
CHAPTER_BATCH = 50


def _file_marks(track: dict, duration: int) -> list:
    """One file's embedded chapters as contiguous (start, end, tag) ranges in
    file time covering the whole file: each ends where the next starts, the
    first starts at 0 and the last ends at the file's duration. [] when the
    file has none."""
    marks = {}
    for c in track.get("Chapter") or []:
        if not isinstance(c, dict):
            continue
        start = _int(c.get("startTimeOffset"))
        if start < duration and start not in marks:
            marks[start] = c.get("tag")
    starts = sorted(marks)
    if not starts:
        return []
    if starts[0] != 0:
        marks[0] = marks.pop(starts[0])
        starts[0] = 0
    return [(s, starts[i + 1] if i + 1 < len(starts) else duration, marks[s]) for i, s in enumerate(starts)]


async def _embedded_chapters(client: httpx.AsyncClient, admin: dict, tracks: list) -> dict:
    """{track rating key: its Chapter list} for tracks whose file carries chapters."""
    found = {}
    keys = [str(t["ratingKey"]) for t in tracks]
    for i in range(0, len(keys), CHAPTER_BATCH):
        batch = ",".join(keys[i:i + CHAPTER_BATCH])
        container = await _pms_get(client, admin, admin["token"], f"/library/metadata/{batch}",
                                   {"includeChapters": 1})
        for item in _items(container):
            if isinstance(item.get("Chapter"), list) and item["Chapter"]:
                found[str(item.get("ratingKey"))] = item["Chapter"]
    return found


def _chapters(tracks: list, embedded: dict) -> list:
    """The book's chapters, [{index, label, start_ms, end_ms, track,
    track_start_ms, track_end_ms}]: start/end in book time (tracks laid end to
    end), track_start/track_end inside that chapter's track.

    When any track carries embedded chapters, those are the book's chapters,
    numbered across the whole book ("Chapter N of M" when untitled); a track
    without any in such a book counts as one untitled chapter spanning the
    track, so the chapters always cover the book. When no track has any, a
    single file is one chapter and a multi-part book's parts are its chapters
    ("Part N of M")."""
    durations = [_track_duration(t) for t in tracks]
    marks = [_file_marks({"Chapter": embedded.get(str(t["ratingKey"]))}, d) for t, d in zip(tracks, durations)]
    use_parts = len(tracks) > 1 and not any(marks)
    spans = []   # (track index, start, end, tag)
    for i, (m, d) in enumerate(zip(marks, durations)):
        for start, end, tag in (m if m and not use_parts else [(0, d, None)]):
            spans.append((i, start, end, tag))
    total = len(spans)
    out, base = [], [sum(durations[:i]) for i in range(len(tracks))]
    for n, (i, start, end, tag) in enumerate(spans, start=1):
        label = f"Part {n} of {total}" if use_parts else _chapter_label(tag, n, total)
        out.append({"index": n, "label": label, "start_ms": base[i] + start, "end_ms": base[i] + end,
                    "track": str(tracks[i]["ratingKey"]), "track_start_ms": start, "track_end_ms": end})
    return out


async def book_detail(key: str) -> dict:
    """One book, read with the admin token: the book_list fields plus
    tracks [{key, part_path, duration_ms, index, container, codec, profile}]
    in play order (index from 1; the format fields are strings, possibly empty)
    and chapters [{index, label, start_ms, end_ms, track, track_start_ms,
    track_end_ms}] (see _chapters): start/end are book time (a multi-part
    book's parts laid end to end), track_start/track_end are inside `track`.

    Chapters come from the files where they have them ("Chapter N of M" when
    untitled), numbered across the book; a multi-part book whose files have
    none gets its parts ("Part N of M"). Raises NotInLibrary, PlayerOff or
    PlayerUnavailable."""
    admin = _configured()
    parse_key(key)
    async with _pms_client() as client:
        album, disc, tracks, disc_count = await _book(client, admin, key)
        embedded = await _embedded_chapters(client, admin, tracks)

    out_tracks = [{"key": str(t["ratingKey"]), "part_path": _part(t).get("key") or "",
                   "duration_ms": _track_duration(t), "index": i + 1, **_format(t)}
                  for i, t in enumerate(tracks)]
    return {**_summary(album, disc, tracks, disc_count), "tracks": out_tracks,
            "chapters": _chapters(tracks, embedded)}


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
    items = _items(container)
    t = items[0] if items else {}
    if (t.get("type") != "track" or str(t.get("parentRatingKey")) != album_key
            or (_int(t.get("parentIndex")) or 1) != disc):
        raise NotInLibrary("Not in this book")


# The album thumbnail paths a cover may come from, and the square a cover is
# scaled to fit.
_THUMB_PATH = re.compile(r"/library/metadata/[0-9]{1,20}/thumb/[0-9]{1,20}", re.ASCII)
COVER_SIZE = 600


def cover_version(thumb) -> str:
    """The version stamp of an album thumbnail path (its last segment, which
    Plex changes with the image), or "" when it is not a thumbnail path."""
    if not (isinstance(thumb, str) and _THUMB_PATH.fullmatch(thumb)):
        return ""
    return thumb.rsplit("/", 1)[1]


async def cover_image(key: str, size: int = COVER_SIZE) -> tuple:
    """(image bytes, content type) of the book's album cover, scaled by Plex's
    photo transcoder with the admin token to fit a size x size square.

    It is not cropped to the square: Plex cannot crop, and most audiobook
    covers are print covers, taller than wide (about 0.57 to 0.77), so a
    square cut would lose the title. The player frames it instead.

    The key is checked as assert_in_library checks a book (malformed keys
    before any Plex call, then the album is in the audiobook library), in the
    same album read that finds the thumbnail. Raises NotInLibrary (also when
    the album has no cover or Plex cannot give it), PlayerOff or
    PlayerUnavailable."""
    album_key, _disc = parse_key(key)
    admin = _configured()
    async with _pms_client() as client:
        album = await _album(client, admin, album_key)
    thumb = album.get("thumb") or ""
    if not cover_version(thumb):
        raise NotInLibrary("This book has no cover")
    # get_thumbnail sends the token in a header, serves only raster image
    # types and caps the bytes read.
    content, content_type = await plex.get_thumbnail(thumb, width=size, height=size, fill=False)
    if content is None:
        raise NotInLibrary("This book's cover is not available")
    return content, content_type


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
    the next one, or at the end of the book after the last.

    `book_ms` is that playhead in book time: the durations of every track
    before it plus the offset, whatever Plex says about those earlier tracks
    (a listener who only ever played track 3 is at track 3, not track 1).
    Resume uses `track` and `offset_ms`; `book_ms` is for display and
    comparison. A 401 on the listener's server token drops the cached access
    and raises TokenRejected (a PlayerUnavailable)."""
    admin = _configured()
    parse_key(key)
    access = await server_access(session, session_id=session_id)
    async with _pms_client() as client:
        _album_meta, _disc, tracks, _n = await _book(client, admin, key)
        album_key = key.split(":", 1)[0]
        try:
            mine = await _pms_get(client, admin, access["token"], f"/library/metadata/{album_key}/children")
        except TokenRejected:
            await forget_access(session, session_id)
            raise
    try:
        rows = _items(mine)
    except PlayerUnavailable:
        # The listener's own state in a shape we can't read: no Plex place
        # (the book still resumes from WebServarr's copy and the local one).
        return None
    state = {str(t.get("ratingKey")): t for t in rows}

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
        if resp.status_code == 401:
            logger.warning("Plex timeline refused the server token (HTTP 401); access will be fetched again")
            await forget_access(session, session_id)
        elif resp.status_code != 200:
            logger.warning("Plex timeline returned HTTP %d", resp.status_code)
    except (PlayerUnavailable, NotInLibrary) as exc:
        logger.info("Plex timeline skipped: %s", exc)
    except httpx.HTTPError as exc:
        logger.warning("Plex timeline failed: %s", type(exc).__name__)
    except Exception as exc:  # noqa: BLE001 - best effort by contract, never raised
        logger.warning("Plex timeline failed unexpectedly: %s", type(exc).__name__)
