"""
Keeps the trending book shelves warm in the background.

The film and TV rows are one Seerr call each and answer in about a tenth of a
second. A book row cannot be: Open Library and the NYT supply only titles, so
every one of them needs a Chaptarr lookup to become requestable and a cover
lookup to become presentable. That is roughly 46 external round trips against
one, and it showed - the shelves arrived seconds after everything else.

Rather than make those calls cheaper, they are made before anyone asks. The
shelves are rebuilt on a timer and served from cache, so a visitor sees them as
quickly as the Seerr rows. The first build after a restart still costs what it
costs, but nobody is waiting on it.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

# Slightly under the hour the caches hold their entries for, so a shelf is
# replaced just before it goes stale rather than just after.
REFRESH_INTERVAL = 55 * 60

# Long enough for the database and integrations to settle after boot, short
# enough that an early visitor is unlikely to beat it.
STARTUP_DELAY = 15

_running = False

# uvicorn runs multiple workers and each one starts its own warmer, so without
# coordination every external call is made once per worker - doubling the load
# on the NYT API in particular, which answered the second worker with 429s.
# One worker takes this lock per cycle and the others sit the round out. The
# lease is deliberately shorter than the refresh interval so a worker that dies
# mid-warm does not leave the shelves unattended.
_LOCK_KEY = "webservarr:shelf_warmer"
_LOCK_TTL = 10 * 60


async def _claim_turn() -> bool:
    """True if this worker should do this round's warming."""
    try:
        from app.auth import session_manager

        redis = await session_manager.get_redis()
        # SET NX EX: whoever sets it first wins, and it expires on its own.
        return bool(await redis.set(_LOCK_KEY, "1", nx=True, ex=_LOCK_TTL))
    except Exception as exc:  # noqa: BLE001
        # Without Redis there is no way to coordinate, so warm anyway - a
        # duplicated shelf build is better than none.
        logger.debug("Shelf warmer could not claim a turn (%s); warming anyway", exc)
        return True


async def _warm_once() -> None:
    """Build both shelves into cache. Never raises."""
    # Imported here rather than at module scope to avoid an import cycle
    # through the router at startup.
    from app.routers import integrations

    for name, builder in (
        ("books", integrations.build_books_shelf),
        ("audiobooks", integrations.build_audiobooks_shelf),
    ):
        try:
            cards = await builder()
            logger.info("Warmed trending %s shelf: %d cards", name, len(cards))
        except Exception as exc:  # noqa: BLE001 - warming must never take the app down
            logger.warning("Could not warm trending %s shelf: %s", name, exc)


async def start_warmer() -> None:
    """Warm the shelves shortly after boot, then keep them fresh."""
    global _running
    _running = True

    try:
        await asyncio.sleep(STARTUP_DELAY)
        while _running:
            if await _claim_turn():
                await _warm_once()
            else:
                logger.debug("Another worker is warming the shelves this round")
            await asyncio.sleep(REFRESH_INTERVAL)
    except asyncio.CancelledError:
        raise


async def stop_warmer() -> None:
    global _running
    _running = False
