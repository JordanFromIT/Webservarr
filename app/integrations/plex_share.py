"""
Share the configured Plex server with one Plex account, as the server's
owner (the admin token), for Settings > Access requests
(docs/superpowers/specs/2026-10-10-request-access-design.md, section 7),
and read who the server is shared with for Insights' names.

Every call this module makes goes to a fixed plex.tv host with TLS
verified, the admin token in the X-Plex-Token header (never the query
string) and the app's Plex client headers. Each call times out after
TIMEOUT seconds, and nothing is retried, so a share is never POSTed twice.
Finding the server's machine id is not one of those calls: _server reuses
the sign-in gate's _fetch_configured_server_identifiers, which also sends
the admin token, in a header, to the configured Plex server's own /identity
(the integration.plex.url address, TLS not verified on that LAN hop) and
falls back to plex.tv when that server doesn't answer. Plex's answers carry invite and
access tokens: only the fields named here are read out of them, and nothing
from them is logged or stored.

The create call is route B, proved live on 2026-10-10: the v2 share that
names the account by its plex.tv id (invitedId), never by a username, which
can change hands.
"""
import logging
from typing import Dict, List, NamedTuple, Optional, Tuple

import httpx

from app.database import SessionLocal
from app.integrations import config as integration_config

logger = logging.getLogger(__name__)

TIMEOUT = 10.0
PLEX_TV = "https://plex.tv"
CLIENTS = "https://clients.plex.tv"

# share_server's reasons that need more of the admin than a share by hand.
NO_ACCOUNT_ID = "This request has no Plex account id, so nothing was sent"
WRONG_ACCOUNT = "Plex sent the invite to a different Plex account. Remove that invite in Plex"


class PlexShareUnavailable(Exception):
    """Plex isn't set up, didn't answer, or answered with something unusable.
    The text is safe to show to the admin: never a token."""


class PlexServer(NamedTuple):
    machine_id: str
    headers: Dict[str, str]   # the client headers plus the admin X-Plex-Token


async def _server() -> PlexServer:
    """The configured server's machine id and the headers every call sends."""
    # At call time: the auth router imports the app.
    from app.routers.auth import _fetch_configured_server_identifiers, _plex_client_headers

    values = integration_config.read([integration_config.url_key("plex"), integration_config.CREDENTIAL_KEYS["plex"]])
    token = integration_config.credential("plex", values)
    if not token or not integration_config.base_url("plex", values):
        raise PlexShareUnavailable("Plex isn't connected")
    db = SessionLocal()
    try:
        headers = {**_plex_client_headers(db), "X-Plex-Token": token}
        ids = await _fetch_configured_server_identifiers(db)
    finally:
        db.close()
    if len(ids) != 1:
        raise PlexShareUnavailable("Plex didn't say which server is yours")
    return PlexServer(next(iter(ids)), headers)


def _client() -> httpx.AsyncClient:
    """A client per call. The tests replace this with one on a MockTransport."""
    return httpx.AsyncClient(timeout=TIMEOUT)


async def _get_json(client: httpx.AsyncClient, url: str, server: PlexServer):
    # "from None": httpx errors name the URL, which holds the machine id, so
    # none is chained where a logged traceback would print it.
    try:
        resp = await client.get(url, headers=server.headers)
    except httpx.HTTPError:
        raise PlexShareUnavailable("Plex didn't answer") from None
    if resp.status_code != 200:
        raise PlexShareUnavailable(f"Plex answered HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError:
        raise PlexShareUnavailable("Plex sent something unreadable") from None


async def _sections(client: httpx.AsyncClient, server: PlexServer) -> List[Dict[str, str]]:
    """[{id, key, title, type}], where id is plex.tv's section id (what the
    invite takes) and key the server's own section key (what Settings shows)."""
    data = await _get_json(client, f"{PLEX_TV}/api/v2/servers/{server.machine_id}", server)
    listed = data.get("librarySections") if isinstance(data, dict) else None
    out = []
    for s in listed if isinstance(listed, list) else []:
        if isinstance(s, dict) and s.get("id") is not None and s.get("key") is not None:
            out.append({"id": str(s["id"]), "key": str(s["key"]),
                        "title": str(s.get("title") or ""), "type": str(s.get("type") or "")})
    return out


class Entry(NamedTuple):
    """One share of our server, as far as this module reads it."""
    state: str          # "accepted" or "pending"
    invited_id: str     # the plex.tv account id the share is for


async def _entries(client: httpx.AsyncClient, server: PlexServer) -> List[Entry]:
    """Every share of our server, accepted then pending."""
    out = []
    for state in ("accepted", "pending"):
        data = await _get_json(client, f"{CLIENTS}/api/v2/shared_servers/owned/{state}", server)
        for entry in data if isinstance(data, list) else []:
            if not isinstance(entry, dict) or str(entry.get("machineIdentifier") or "") != server.machine_id:
                continue
            out.append(Entry(state, str(entry.get("invitedId") or "")))
    return out


def _state_for(entries: List[Entry], plex_account_id: str) -> Optional[str]:
    for entry in entries:
        if entry.invited_id == str(plex_account_id):
            return entry.state
    return None


async def _find(client: httpx.AsyncClient, server: PlexServer, plex_account_id: str) -> Optional[str]:
    return _state_for(await _entries(client, server), plex_account_id)


async def list_libraries() -> List[Dict[str, str]]:
    """The server's libraries: [{key, title, type}]."""
    server = await _server()
    async with _client() as client:
        sections = await _sections(client, server)
    return [{"key": s["key"], "title": s["title"], "type": s["type"]} for s in sections]


async def find_share(plex_account_id: str) -> Optional[str]:
    """"accepted" or "pending" when the server is already shared with this
    account, else None."""
    server = await _server()
    async with _client() as client:
        return await _find(client, server, plex_account_id)


NAME_MAX = 100


async def server_people() -> Dict[str, object]:
    """Who the server is shared with, and its owner, for the names and
    pictures on the admin's Insights page: {"owner": the owner's plex.tv id
    or "", "names": {plex.tv id: name}, "usernames": {plex.tv id: username},
    "thumbs": {plex.tv id: picture address}}. From each accepted share's
    `invited` account and plex.tv's own account for the admin token. Only
    ids, names, usernames (never one that looks like an email: the page tells
    two people with the same name apart by it) and picture addresses on
    plex.tv (avatar_url) are read out of either answer (never an email or a
    token). Raises PlexShareUnavailable."""
    server = await _server()
    async with _client() as client:
        accepted = await _get_json(client, f"{CLIENTS}/api/v2/shared_servers/owned/accepted", server)
        owner = await _get_json(client, f"{PLEX_TV}/api/v2/user", server)
    names: Dict[str, str] = {}
    usernames: Dict[str, str] = {}
    thumbs: Dict[str, str] = {}

    def keep(account: dict) -> str:
        found = str(account.get("id") or "")
        if found:
            names[found] = str(account.get("title") or account.get("username") or "")[:NAME_MAX]
            username = str(account.get("username") or "")[:NAME_MAX]
            if username and "@" not in username:
                usernames[found] = username
            thumb = avatar_url(account.get("thumb"))
            if thumb:
                thumbs[found] = thumb
        return found

    for entry in accepted if isinstance(accepted, list) else []:
        invited = entry.get("invited") if isinstance(entry, dict) else None
        if isinstance(invited, dict):
            keep(invited)
    owner_id = keep(owner) if isinstance(owner, dict) else ""
    return {"owner": owner_id, "names": names, "usernames": usernames, "thumbs": thumbs}


# Some plex.tv pictures are full-size uploads (2 MB seen); the browser keeps each a day.
AVATAR_MAX_BYTES = 4 * 1024 * 1024
AVATAR_HOPS = 3
AVATAR_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")


def _plex_host(host: str) -> bool:
    return host == "plex.tv" or host.endswith(".plex.tv")


def avatar_url(value) -> str:
    """A plex.tv account picture's address, or "" for anything else: only an
    https address on plex.tv itself, so a picture is only ever fetched from there."""
    if not isinstance(value, str) or len(value) > 500:
        return ""
    try:
        url = httpx.URL(value)
    except (httpx.InvalidURL, TypeError, ValueError):
        return ""
    return value if url.scheme == "https" and _plex_host(url.host or "") and not url.userinfo else ""


def _hop_ok(url: httpx.URL) -> bool:
    """A redirect from plex.tv may go on to its image host: https, a name
    (never an address typed as numbers) and nothing on this machine."""
    host = url.host or ""
    return (url.scheme == "https" and bool(host) and host != "localhost" and not host.endswith(".local")
            and not host.replace(".", "").isdigit() and ":" not in host)


async def avatar_image(url: str) -> Tuple[bytes, str]:
    """The picture at a plex.tv account's avatar address (avatar_url), for
    Insights to serve from this origin: (bytes, its type). Sent with no
    token. Up to AVATAR_HOPS redirects, each checked (_hop_ok); only a PNG,
    JPEG, WebP or GIF of AVATAR_MAX_BYTES or less. Raises PlexShareUnavailable."""
    if not avatar_url(url):
        raise PlexShareUnavailable("Not a Plex picture")
    target = httpx.URL(url)
    async with _client() as client:
        for _hop in range(AVATAR_HOPS + 1):
            try:
                resp = await client.get(target, headers={"Accept": "image/*"})
            except httpx.HTTPError:
                raise PlexShareUnavailable("Plex didn't answer") from None
            if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                target = target.join(resp.headers["location"])
                if not _hop_ok(target):
                    raise PlexShareUnavailable("Plex sent the picture somewhere unexpected")
                continue
            kind = resp.headers.get("content-type", "").split(";")[0].strip().lower()
            if resp.status_code != 200 or kind not in AVATAR_TYPES:
                raise PlexShareUnavailable("Plex had no picture")
            if len(resp.content) > AVATAR_MAX_BYTES:
                raise PlexShareUnavailable("The picture is too large")
            return resp.content, kind
    raise PlexShareUnavailable("Too many redirects")


async def _create(client: httpx.AsyncClient, server: PlexServer, account_id: str, ids: List[str]) -> httpx.Response:
    """Route B: the v2 share, addressed by the plex.tv account id. Plex
    answers 201 with the new share as JSON, and may file it as accepted
    straight away rather than pending."""
    body = {
        "machineIdentifier": server.machine_id,
        "invitedId": int(account_id),
        "librarySectionIds": [int(i) for i in ids],
        "settings": {"allowSync": False, "allowCameraUpload": False, "allowChannels": False,
                     "filterMovies": "", "filterTelevision": "", "filterMusic": ""},
    }
    return await client.post(f"{CLIENTS}/api/v2/shared_servers", json=body, headers=server.headers)


def _invited_id(resp: httpx.Response) -> Optional[str]:
    """The account id Plex says the new share is for, or None when the
    answer doesn't say (only invitedId is read out of it)."""
    try:
        data = resp.json()
    except ValueError:
        return None
    found = data.get("invitedId") if isinstance(data, dict) else None
    return None if found is None else str(found)


async def share_server(account: Dict[str, str], section_keys: List[str]) -> Tuple[str, Optional[str]]:
    """Share the server with account (its plex_account_id, the plex.tv id
    identify verified) and the libraries whose section keys are given.
    ("existing", None) when Plex already has a share for the account (no
    POST); ("shared", None) when Plex lists the new share, pending or
    accepted, for exactly this account id; else ("failed", a short reason).
    Never raises for Plex trouble, and never deletes a share: a stray invite
    is reported, for the admin to remove in Plex.

    Route B invites by account id only, so a request without a usable id is
    never sent, and there is no fallback to a username. A new share that Plex
    says is for a different account is WRONG_ACCOUNT."""
    account_id = str(account.get("plex_account_id") or "")
    if not (account_id.isascii() and account_id.isdigit()):
        return "failed", NO_ACCOUNT_ID
    account_id = str(int(account_id))   # as Plex writes it, with no leading zeros
    try:
        server = await _server()
        async with _client() as client:
            if _state_for(await _entries(client, server), account_id):
                return "existing", None
            by_key = {s["key"]: s["id"] for s in await _sections(client, server)}
            ids = [by_key[k] for k in section_keys if k in by_key]
            if not ids or len(ids) != len(section_keys):
                return "failed", "Those libraries aren't on the server any more"
            try:
                resp = await _create(client, server, account_id, ids)
            except httpx.HTTPError:
                return "failed", "Plex didn't answer the share"
            if resp.status_code not in (200, 201):
                return "failed", f"Plex refused the share (HTTP {resp.status_code})"
            invited = _invited_id(resp)
            if invited is not None and invited != account_id:
                logger.warning("Plex share: the invite went to a different Plex account")
                return "failed", WRONG_ACCOUNT
            if _state_for(await _entries(client, server), account_id) is None:
                return "failed", "Plex didn't confirm the share"
            return "shared", None
    except PlexShareUnavailable as exc:
        return "failed", str(exc)[:200]
