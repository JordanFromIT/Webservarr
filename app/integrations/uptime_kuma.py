"""
Uptime Kuma monitoring integration.
Fetches service status from Uptime Kuma's public status page API.

Everything here is a GET against public endpoints: the status page, its
heartbeats (the last 50 checks of each monitor and the past day's uptime) and
the uptime badges (/api/badge/<id>/uptime/<hours>), which are the only public
source of uptime over longer windows. Nothing is ever written to Uptime Kuma.
"""

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import Dict, Iterable, Optional

import httpx
from app.integrations import config as integration_config

logger = logging.getLogger(__name__)

TIMEOUT = 5.0
CONFIG_TIMEOUT = 10.0  # Config endpoint is slower on first call

# Map Uptime Kuma status codes to our ServiceStatus values
STATUS_MAP = {
    0: "down",
    1: "up",
    2: "degraded",  # pending
    3: "maintenance",
}


# The uptime windows the status panel offers, in hours. "all" asks for far
# more hours than any install has kept (100000 h is about 11 years): Uptime
# Kuma 1.23 then answers over every check it still holds, the same figure a
# ten times larger window gives.
UPTIME_WINDOWS = {"24h": 24, "30d": 720, "all": 100000}
BADGE_TIMEOUT = 4.0
# A badge figure moves slowly; one read per monitor and window per 10 minutes
# serves every worker (Redis, never module memory: uvicorn runs several). A
# badge that could not be read is asked again sooner, but not on every call.
BADGE_TTL = 600
BADGE_MISS_TTL = 120
_CACHE_PREFIX = "webservarr:cache:kuma-uptime:"
# The figure in a badge's accessible name: aria-label="Uptime (720h): 99.72%".
_BADGE_LABEL = re.compile(r'aria-label="[^"]*?:\s*(\d{1,3}(?:\.\d+)?)\s*%"')
_BADGE_TITLE = re.compile(r"<title>[^<]*?:\s*(\d{1,3}(?:\.\d+)?)\s*%</title>")


def kuma_iso(value) -> Optional[str]:
    """A heartbeat time as ISO 8601 UTC with a Z. Uptime Kuma sends its
    stored UTC time with no zone ("2026-10-06 01:56:33.664"); a browser given
    that would read it as its own local time. None for anything else."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("T", " ").rstrip("Z")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(text, fmt)
        except ValueError:
            continue
        return dt.replace(tzinfo=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return None


def beat_list(heartbeats) -> list:
    """The last 50 checks, oldest first: {status, ping, time}. status is one
    of STATUS_MAP's words, ping whole milliseconds or None (a down check has
    no reply), time ISO UTC."""
    out = []
    for beat in (heartbeats or [])[-50:]:
        if not isinstance(beat, dict):
            continue
        ping = beat.get("ping")
        out.append({
            "status": STATUS_MAP.get(beat.get("status", 0), "down"),
            "ping": int(round(ping)) if isinstance(ping, (int, float)) and not isinstance(ping, bool) and ping >= 0 else None,
            "time": kuma_iso(beat.get("time")),
        })
    return out


def parse_badge_percent(svg) -> Optional[float]:
    """The uptime figure in an Uptime Kuma uptime badge, or None.

    Read from the badge's accessible name (aria-label, then <title>), never
    from its drawn text or colours. "N/A" (a monitor that is not public, or
    has no checks in the window), anything not a badge, or a figure outside
    0-100 is None, so the panel says "Not available" instead of a number."""
    if not isinstance(svg, str) or "<svg" not in svg[:400]:
        return None
    for pattern in (_BADGE_LABEL, _BADGE_TITLE):
        m = pattern.search(svg)
        if m:
            value = float(m.group(1))
            return round(value, 2) if 0 <= value <= 100 else None
    return None


def configured() -> bool:
    """Whether an Uptime Kuma address is set: without one there is no status
    to show, which is not the same as Uptime Kuma not answering."""
    return bool(_get_config()["url"])


def _get_config() -> dict:
    """Read Uptime Kuma config from settings table (short-lived session)."""
    values = integration_config.read((integration_config.url_key("uptime_kuma"), integration_config.KUMA_SLUG_KEY))
    return {
        "url": integration_config.base_url("uptime_kuma", values),
        # An empty slug means the default page, as the Settings status light tests it.
        "slug": integration_config.kuma_slug(values),
    }


async def get_monitors() -> list:
    """
    Fetch monitor status from Uptime Kuma's public status page API.
    Returns list of monitor dicts compatible with our Service model format,
    or [] when Uptime Kuma is not set up or can't be read.
    """
    return await read_monitors() or []


async def read_monitors(fresh: bool = False) -> Optional[list]:
    """Like get_monitors, but None when Uptime Kuma is not set up or could not
    be read, so a caller can tell "no monitors" from "no answer" (the status
    feed must never say everything is running when it simply doesn't know).

    fresh: ask past Uptime Kuma's own one-minute cache of the heartbeat
    answer (its apicache honours the x-apicache-bypass request header), so
    the checks are the ones Uptime Kuma holds now. Only read_monitors_live
    asks for this, and it shares one answer per BEATS_TTL across every
    viewer and worker."""
    config = _get_config()
    if not config["url"]:
        return None

    slug = config["slug"]

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            # Fetch the public status page heartbeat data
            resp = await client.get(f"{config['url']}/api/status-page/heartbeat/{slug}",
                                    headers={"x-apicache-bypass": "1"} if fresh else None)
            if resp.status_code != 200:
                logger.warning("Uptime Kuma heartbeat returned HTTP %d", resp.status_code)
                return None

            data = resp.json()
            heartbeat_list = data.get("heartbeatList", {})
            uptime_list = data.get("uptimeList", {})

            # Also fetch the status page config to get monitor names/groups
            # Use longer timeout — this endpoint is slow on first call
            config_resp = await client.get(
                f"{config['url']}/api/status-page/{slug}",
                timeout=CONFIG_TIMEOUT,
            )
            monitor_names = {}
            if config_resp.status_code == 200:
                config_data = config_resp.json()
                for group in config_data.get("publicGroupList", []):
                    for monitor in group.get("monitorList", []):
                        monitor_names[monitor["id"]] = monitor.get("name", f"Monitor {monitor['id']}")

            monitors = []
            for monitor_id_str, heartbeats in heartbeat_list.items():
                monitor_id = int(monitor_id_str)
                name = monitor_names.get(monitor_id, f"Monitor {monitor_id}")

                # Get latest heartbeat
                latest = heartbeats[-1] if heartbeats else None
                if not latest:
                    continue

                status_code = latest.get("status", 0)
                status = STATUS_MAP.get(status_code, "down")
                response_time = latest.get("ping", 0)

                # When the monitor entered its current status: the first beat
                # of the trailing run with that status. The status page only
                # returns the last few dozen beats, so when the run fills the
                # whole window its start is not visible and status_since is
                # None (the oldest beat would slide on every poll). The
                # notification poller then falls back to its detection time.
                status_since = None
                run_start = None
                for beat in reversed(heartbeats):
                    if STATUS_MAP.get(beat.get("status", 0), "down") != status:
                        status_since = run_start
                        break
                    run_start = beat.get("time") or run_start

                # The past day's uptime is the only window the status page
                # sends (<id>_24, 0..1). Longer windows come from the badges
                # (read_uptime); there is no <id>_720 key, so uptime_30d is
                # None here and filled in by the caller that reads them.
                uptime_24h = uptime_list.get(f"{monitor_id}_24")

                monitors.append({
                    "id": monitor_id,
                    "name": name,
                    "status": status,
                    "response_time": response_time,
                    "uptime_24h": _percent(uptime_24h),
                    "uptime_30d": None,
                    "last_check": latest.get("time", ""),
                    "status_since": status_since,
                    "status_message": latest.get("msg", ""),
                    "beats": beat_list(heartbeats),
                })

            return monitors

    except httpx.TimeoutException:
        logger.warning("Uptime Kuma connection timed out")
        return None
    except httpx.ConnectError:
        logger.warning("Could not connect to Uptime Kuma at %s", config["url"])
        return None
    except Exception as e:
        logger.error("Uptime Kuma integration error: %s", str(e))
        return None


def _percent(value) -> Optional[float]:
    """Uptime Kuma's 0..1 ratio as a percentage (a value already over 1 is
    taken as one), or None when there is no number."""
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        return None
    return round(value * 100, 2) if value <= 1 else round(min(value, 100), 2)


async def _redis():
    from app.auth import session_manager
    return await session_manager.get_redis()


# The status panel's checks, live while it is open. The panel asks every 15 s
# (Uptime Kuma checks most monitors every 20 s); one read of Uptime Kuma per
# BEATS_TTL serves every viewer and worker (Redis, never module memory:
# uvicorn runs several). The TTL sits a little under the panel's interval so
# one viewer's next ask always finds the copy expired and gets new checks.
# An answer that failed is kept for BEATS_MISS_TTL, so a Kuma that is down is
# not asked once per viewer, and recovery shows within seconds.
BEATS_TTL = 13
BEATS_MISS_TTL = 5
# While one worker reads Uptime Kuma, the others wait for its answer (polling
# Redis) instead of asking too. Longer than a normal read, shorter than the
# worst case, after which a waiter reads Kuma itself.
BEATS_LOCK_TTL = 8
BEATS_WAIT_STEP = 0.1
_BEATS_PREFIX = "webservarr:cache:kuma-checks:"


def _beats_key(config: dict) -> str:
    # The address and page in the key: a change in Settings is a new copy.
    digest = hashlib.sha256(f"{config['url']}|{config['slug']}".encode()).hexdigest()[:16]
    return _BEATS_PREFIX + digest


async def _read_shared(redis, key: str):
    """(True, monitors or None) when a copy is in Redis, else (False, None)."""
    raw = await redis.get(key)
    if not raw:
        return False, None
    return True, json.loads(raw).get("m")


async def read_monitors_live() -> Optional[list]:
    """read_monitors(fresh=True), shared through Redis for BEATS_TTL seconds
    so any number of open status panels read Uptime Kuma at most once per
    TTL. Same answers as read_monitors: None when not set up or not
    answering. Without Redis it reads Uptime Kuma directly."""
    config = _get_config()
    if not config["url"]:
        return None
    key = _beats_key(config)
    try:
        redis = await _redis()
        found, monitors = await _read_shared(redis, key)
        if found:
            return monitors
        if not await redis.set(key + ":lock", "1", nx=True, ex=BEATS_LOCK_TTL):
            # Another worker is reading Kuma now: wait for its answer.
            for _ in range(int(BEATS_LOCK_TTL / BEATS_WAIT_STEP)):
                await asyncio.sleep(BEATS_WAIT_STEP)
                found, monitors = await _read_shared(redis, key)
                if found:
                    return monitors
            return await read_monitors(fresh=True)
    except Exception as exc:  # noqa: BLE001 - no Redis: read Kuma directly
        logger.debug("Status checks not shared through Redis: %s", exc)
        return await read_monitors(fresh=True)
    try:
        monitors = await read_monitors(fresh=True)
        try:
            await redis.set(key, json.dumps({"m": monitors}),
                            ex=BEATS_TTL if monitors is not None else BEATS_MISS_TTL)
        except Exception:  # noqa: BLE001
            pass
        return monitors
    finally:
        try:
            await redis.delete(key + ":lock")
        except Exception:  # noqa: BLE001
            pass


async def _badge(client: httpx.AsyncClient, url: str, monitor_id: int, hours: int) -> Optional[float]:
    """One badge's figure, from Redis when a worker read it in the last 10
    minutes. A failed read is remembered (as null) for 2 minutes."""
    key = f"{_CACHE_PREFIX}{monitor_id}:{hours}"
    redis = None
    try:
        redis = await _redis()
        raw = await redis.get(key)
        if raw:
            return json.loads(raw).get("pct")
    except Exception:  # noqa: BLE001 - a cold or missing cache is not an error
        redis = None
    pct = None
    try:
        resp = await client.get(f"{url}/api/badge/{monitor_id}/uptime/{hours}")
        if resp.status_code == 200:
            pct = parse_badge_percent(resp.text)
    except Exception as exc:  # noqa: BLE001 - one badge never fails the rest
        logger.debug("Uptime badge %s/%sh not read: %s", monitor_id, hours, exc)
    if redis is not None:
        try:
            await redis.set(key, json.dumps({"pct": pct}), ex=BADGE_TTL if pct is not None else BADGE_MISS_TTL)
        except Exception:  # noqa: BLE001
            pass
    return pct


async def read_uptime(monitors: Iterable[dict]) -> Dict[int, dict]:
    """Uptime per monitor for every window in UPTIME_WINDOWS:
    {id: {"24h": pct, "30d": pct, "all": pct}}, each a percentage or None
    ("Not available"). The past day comes from the heartbeat answer already
    in hand (uptime_24h); the longer windows from the badges, read together.
    WebServarr keeps no uptime history of its own to fall back on (the status
    feed records outages, not checks), so a badge that can't be read is None,
    never an estimate."""
    monitors = list(monitors)
    out = {m["id"]: {"24h": m.get("uptime_24h")} for m in monitors}
    config = _get_config()
    long_windows = [(name, hours) for name, hours in UPTIME_WINDOWS.items() if name != "24h"]
    if not config["url"] or not monitors:
        for m in monitors:
            out[m["id"]].update({name: None for name, _ in long_windows})
        return out
    async with httpx.AsyncClient(timeout=BADGE_TIMEOUT, verify=False) as client:
        jobs = [(m["id"], name, _badge(client, config["url"], m["id"], hours))
                for m in monitors for name, hours in long_windows]
        values = await asyncio.gather(*(job for _, _, job in jobs))
    for (monitor_id, name, _), value in zip(jobs, values):
        out[monitor_id][name] = value
    return out
