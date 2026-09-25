"""
Honest integration status for Settings > Integrations.

Each configured integration is probed the way its real client talks to it
(same path, same credential), all in parallel, each capped at PROBE_TIMEOUT,
and the answer becomes one of four states with a plain-English reason:

  unconfigured  nothing to check yet                                  (grey)
  ok            reachable and our credentials were accepted            (green)
  warn          reachable but misconfigured: key rejected, status page (amber)
                or folder not found, required key missing
  error         unreachable: timeout, refused, DNS, blocked address    (red)

Results are cached in Redis for CACHE_TTL seconds: uvicorn runs two workers,
so a module-level cache would give each worker its own answer.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple
from urllib.parse import quote

import httpx

from app.integrations.nyt import BASE_URL as NYT_BASE_URL

logger = logging.getLogger(__name__)

IDS = ("plex", "seerr", "chaptarr", "kavita", "nyt", "sonarr", "radarr", "uptime_kuma", "netdata")
UNCONFIGURED, OK, WARN, ERROR = "unconfigured", "ok", "warn", "error"
PROBE_TIMEOUT = 5.0
CACHE_KEY = "webservarr:cache:integration-health"
CACHE_TTL = 30


_CREDENTIAL_KEYS = {
    "plex": "integration.plex.token",
    "seerr": "integration.seerr.api_key",
    "chaptarr": "integration.chaptarr.api_key",
    "nyt": "integration.nyt.api_key",
    "sonarr": "integration.sonarr.api_key",
    "radarr": "integration.radarr.api_key",
    "netdata": "integration.netdata.api_key",
}


def credential_key(service: str) -> Optional[str]:
    return _CREDENTIAL_KEYS.get(service)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _result(state: str, reason: str) -> dict:
    return {"state": state, "reason": reason, "checked_at": _now()}


def _client() -> httpx.AsyncClient:
    # verify=False matches every integration client (LAN services, self-signed
    # certs). follow_redirects=False is httpx's default, stated so nobody flips
    # it: a LAN service answering 302 to 169.254.169.254 would otherwise walk
    # the probe past is_safe_integration_url. A 3xx lands in map_response.
    return httpx.AsyncClient(timeout=PROBE_TIMEOUT, verify=False, follow_redirects=False)


def build_probe(service: str, values: Dict[str, str]) -> Tuple[Optional[dict], Optional[Tuple[str, str]]]:
    """(request, None) to probe, or (None, (state, reason)) when no request is needed."""
    def val(key: str) -> str:
        return (values.get(key) or "").strip()

    if service == "nyt":
        key = val("integration.nyt.api_key")
        if not key:
            return None, (UNCONFIGURED, "Not set up yet")
        return {"url": NYT_BASE_URL.format(list_name="combined-print-and-e-book-fiction"),
                "headers": {}, "params": {"api-key": key}}, None

    base = val(f"integration.{service}.url").rstrip("/")
    if not base:
        return None, (UNCONFIGURED, "Not set up yet")
    from app.utils import is_safe_integration_url
    if not is_safe_integration_url(base):
        return None, (ERROR, "That address isn't allowed")

    cred_key = credential_key(service)
    cred = val(cred_key) if cred_key else ""
    if service == "plex":
        if not cred:
            return None, (WARN, "Add the Plex token")
        return {"url": f"{base}/status/sessions",
                "headers": {"X-Plex-Token": cred, "Accept": "application/json"}, "params": {}}, None
    if service in ("seerr", "sonarr", "radarr", "chaptarr"):
        if not cred:
            return None, (WARN, "Add the API key")
        path = {"seerr": "/api/v1/request/count", "sonarr": "/api/v3/system/status",
                "radarr": "/api/v3/system/status", "chaptarr": "/api/v1/rootfolder"}[service]
        return {"url": base + path, "headers": {"X-Api-Key": cred}, "params": {}}, None
    if service == "kavita":
        return {"url": f"{base}/api/health", "headers": {}, "params": {}}, None
    if service == "uptime_kuma":
        slug = val("integration.uptime_kuma.slug") or "default"
        return {"url": f"{base}/api/status-page/heartbeat/{quote(slug, safe='')}", "headers": {}, "params": {}}, None
    if service == "netdata":
        headers = {"Accept": "application/json"}
        if cred:
            headers["Authorization"] = f"Bearer {cred}"
        return {"url": f"{base}/api/v1/info", "headers": headers, "params": {}}, None
    return None, (UNCONFIGURED, "Not set up yet")


def map_response(service: str, status_code: int, body=None, values: Optional[Dict[str, str]] = None) -> Tuple[str, str]:
    values = values or {}
    if 200 <= status_code < 300:
        if service == "chaptarr" and isinstance(body, list):
            paths = {str(f.get("path", "")).rstrip("/") for f in body if isinstance(f, dict)}
            for key, label in (("integration.chaptarr.root_folder", "eBook"),
                               ("integration.chaptarr.audiobook_root_folder", "audiobook")):
                want = (values.get(key) or "").strip().rstrip("/")
                if want and want not in paths:
                    return WARN, f'The {label} folder "{want}" isn\'t set up in Chaptarr'
        return OK, "Connected"
    if status_code in (401, 403):
        return WARN, "It rejected the token" if service == "plex" else "It rejected the API key"
    if status_code == 404:
        if service == "uptime_kuma":
            slug = (values.get("integration.uptime_kuma.slug") or "default").strip() or "default"
            return WARN, f'The status page "{slug}" wasn\'t found'
        return WARN, "It answered, but that address doesn't look like the right service"
    if status_code == 429:
        return WARN, "Too many requests right now. Try again in a minute."
    return WARN, f"It answered with an error (HTTP {status_code})"


def map_exception(exc: BaseException) -> Tuple[str, str]:
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return ERROR, f"No answer within {int(PROBE_TIMEOUT)} seconds"
    if isinstance(exc, httpx.ConnectError):
        return ERROR, "Couldn't connect. Check the address and that the service is running."
    if isinstance(exc, httpx.RequestError):
        return ERROR, "Couldn't connect"
    return ERROR, "Couldn't check it"


async def probe_one(service: str, values: Dict[str, str], client=None) -> dict:
    probe, immediate = build_probe(service, values)
    if immediate:
        return _result(*immediate)
    own = client is None
    if own:
        client = _client()
    try:
        resp = await asyncio.wait_for(
            client.get(probe["url"], headers=probe["headers"], params=probe["params"]),
            timeout=PROBE_TIMEOUT,
        )
        body = None
        if service == "chaptarr" and 200 <= resp.status_code < 300:
            try:
                body = resp.json()
            except ValueError:
                body = None
        return _result(*map_response(service, resp.status_code, body, values))
    except Exception as exc:  # noqa: BLE001 - every failure becomes a red light with a reason
        return _result(*map_exception(exc))
    finally:
        if own:
            await client.aclose()


async def check_all(values: Dict[str, str], only: Optional[str] = None) -> Dict[str, dict]:
    services = [only] if only else list(IDS)
    async with _client() as client:
        results = await asyncio.gather(*(probe_one(s, values, client) for s in services))
    return dict(zip(services, results))


async def _cache_read() -> Optional[dict]:
    try:
        from app.auth import session_manager
        redis = await session_manager.get_redis()
        raw = await redis.get(CACHE_KEY)
        return json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001 - a cold cache is not an error
        return None


async def _cache_write(data: dict) -> None:
    try:
        from app.auth import session_manager
        redis = await session_manager.get_redis()
        await redis.set(CACHE_KEY, json.dumps(data), ex=CACHE_TTL)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not cache integration health: %s", exc)


async def get_health(values: Dict[str, str], refresh: bool = False, only: Optional[str] = None) -> dict:
    cached = await _cache_read()
    complete = bool(cached) and set(IDS) <= set((cached or {}).get("integrations", {}))
    if complete and not refresh:
        return cached
    if refresh and only and complete:
        merged = dict(cached["integrations"])
        merged.update(await check_all(values, only))
    else:
        merged = await check_all(values)
    data = {"checked_at": _now(), "integrations": merged}
    await _cache_write(data)
    return data
