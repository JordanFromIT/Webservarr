"""
Keeps the request-status snapshot warm in the background.

Building it costs five integration calls plus a Plex lookup per outstanding
title -- tens of round trips over the tunnel, several seconds in total. That is
fine on a timer and far too slow to make somebody wait for on a page load, so
the snapshot is rebuilt on a schedule and every request is served from cache.

The first build after a restart still costs what it costs, but the page renders
the previous snapshot while it happens rather than blocking.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

# Comfortably inside the cache's own TTL, so a snapshot is replaced shortly
# before it expires rather than shortly after -- the page should never fall
# back to an empty cache on a healthy system.
REFRESH_INTERVAL = 15 * 60

# Long enough for the database and integrations to settle after boot.
STARTUP_DELAY = 20

# As with the shelf warmer: uvicorn runs two workers and each starts its own
# loop, so without coordination every rebuild would hit Radarr, Sonarr, Seerr
# and Plex twice. One worker takes the lock per cycle; the other sits it out.
# The lease is shorter than the interval so a worker that dies mid-build does
# not leave the snapshot unattended.
_LOCK_KEY = "webservarr:request_status_warmer"
_LOCK_TTL = 10 * 60

_running = False


async def _claim_turn() -> bool:
    """True if this worker should do this round's rebuild."""
    try:
        from app.auth import session_manager

        redis = await session_manager.get_redis()
        return bool(await redis.set(_LOCK_KEY, "1", nx=True, ex=_LOCK_TTL))
    except Exception as exc:  # noqa: BLE001
        logger.debug("Request-status warmer could not claim a turn (%s); warming anyway", exc)
        return True


async def start_warmer() -> None:
    """Build the snapshot shortly after boot, then keep it fresh."""
    global _running
    _running = True

    from app.services import request_status

    try:
        await asyncio.sleep(STARTUP_DELAY)
        while _running:
            if await _claim_turn():
                try:
                    await request_status.refresh()
                except Exception as exc:  # noqa: BLE001 - warming never takes the app down
                    logger.warning("Could not rebuild request status: %s", exc)
            else:
                logger.debug("Another worker is rebuilding request status this round")
            await asyncio.sleep(REFRESH_INTERVAL)
    except asyncio.CancelledError:
        raise


async def stop_warmer() -> None:
    global _running
    _running = False
