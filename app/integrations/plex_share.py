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

The create call is the one build task 1 proved (route A, the v1 invite that
python-plexapi's inviteFriend sends).
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
NO_USERNAME = "This Plex account has no username, so nothing was sent. Invite it in Plex by its email"
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
    share_id: str       # Plex's id for the share
    invited_id: str     # the plex.tv account id the share is for
    names: frozenset    # the invited account's username, title and email, casefolded


async def _entries(client: httpx.AsyncClient, server: PlexServer) -> List[Entry]:
    """Every share of our server, accepted then pending."""
    out = []
    for state in ("accepted", "pending"):
        data = await _get_json(client, f"{CLIENTS}/api/v2/shared_servers/owned/{state}", server)
        for entry in data if isinstance(data, list) else []:
            if not isinstance(entry, dict) or str(entry.get("machineIdentifier") or "") != server.machine_id:
                continue
            invited = entry.get("invited") if isinstance(entry.get("invited"), dict) else {}
            names = (entry.get("invitedEmail"), invited.get("username"), invited.get("title"), invited.get("email"))
            out.append(Entry(state, str(entry.get("id") or ""), str(entry.get("invitedId") or ""),
                             frozenset(str(n).casefold() for n in names if isinstance(n, str) and n)))
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
    """Who the server is shared with, and its owner, for the names on the
    admin's Insights page: {"owner": the owner's plex.tv id or "", "names":
    {plex.tv id: name}}. From each accepted share's `invited` account and
    plex.tv's own account for the admin token. Only ids and names are read
    out of either answer (never an email or a token). Raises
    PlexShareUnavailable."""
    server = await _server()
    async with _client() as client:
        accepted = await _get_json(client, f"{CLIENTS}/api/v2/shared_servers/owned/accepted", server)
        owner = await _get_json(client, f"{PLEX_TV}/api/v2/user", server)
    names: Dict[str, str] = {}
    for entry in accepted if isinstance(accepted, list) else []:
        invited = entry.get("invited") if isinstance(entry, dict) else None
        if isinstance(invited, dict) and invited.get("id"):
            names[str(invited["id"])] = str(invited.get("title") or invited.get("username") or "")[:NAME_MAX]
    owner_id = str(owner.get("id") or "") if isinstance(owner, dict) else ""
    if owner_id:
        names[owner_id] = str(owner.get("title") or owner.get("username") or "")[:NAME_MAX]
    return {"owner": owner_id, "names": names}


async def _create(client: httpx.AsyncClient, server: PlexServer, username: str, ids: List[str]) -> httpx.Response:
    """Route A: the v1 invite, with the body python-plexapi's inviteFriend sends."""
    body = {
        "server_id": server.machine_id,
        "shared_server": {"library_section_ids": [int(i) for i in ids], "invited_email": username},
        "sharing_settings": {"allowSync": "0", "allowCameraUpload": "0", "allowChannels": "0",
                             "filterMovies": "", "filterTelevision": "", "filterMusic": ""},
    }
    return await client.post(f"{PLEX_TV}/api/servers/{server.machine_id}/shared_servers",
                             json=body, headers=server.headers)


async def share_server(account: Dict[str, str], section_keys: List[str]) -> Tuple[str, Optional[str]]:
    """Share the server with account (plex_account_id, plex_username) and the
    libraries whose section keys are given. ("existing", None) when Plex
    already has a share for the account (no POST); ("shared", None) when
    Plex lists the new share for exactly this account; else ("failed",
    a short reason). Never raises for Plex trouble, and never deletes a
    share: a stray invite is reported, for the admin to remove in Plex.

    Route A invites by username, so an empty username (the account has none;
    a display name is not one) is never sent. And since a username can
    change hands, a new share that names the username but is for a
    different plex.tv account is WRONG_ACCOUNT, not a missing confirmation."""
    account_id = str(account["plex_account_id"])
    username = str(account.get("plex_username") or "")
    try:
        server = await _server()
        async with _client() as client:
            before = await _entries(client, server)
            if _state_for(before, account_id):
                return "existing", None
            if not username:
                return "failed", NO_USERNAME
            by_key = {s["key"]: s["id"] for s in await _sections(client, server)}
            ids = [by_key[k] for k in section_keys if k in by_key]
            if not ids or len(ids) != len(section_keys):
                return "failed", "Those libraries aren't on the server any more"
            try:
                resp = await _create(client, server, username, ids)
            except httpx.HTTPError:
                return "failed", "Plex didn't answer the share"
            if resp.status_code not in (200, 201):
                return "failed", f"Plex refused the share (HTTP {resp.status_code})"
            after = await _entries(client, server)
            seen = {(e.share_id, e.invited_id) for e in before}
            if any((e.share_id, e.invited_id) not in seen and e.invited_id != account_id
                   and username.casefold() in e.names for e in after):
                logger.warning("Plex share: the invite went to a different Plex account")
                return "failed", WRONG_ACCOUNT
            if _state_for(after, account_id) is None:
                return "failed", "Plex didn't confirm the share"
            return "shared", None
    except PlexShareUnavailable as exc:
        return "failed", str(exc)[:200]
