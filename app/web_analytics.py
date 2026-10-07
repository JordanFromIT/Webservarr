"""
Cloudflare Web Analytics and the site's Content Security Policy.

A site behind Cloudflare with Web Analytics on has Cloudflare's beacon script
injected into every HTML page on the way out. The CSP (app/main.py) refuses it
unless the operator turns security.cloudflare_web_analytics on; then HTML
responses also allow the beacon's script host and the host it reports to.
Off, the shipped default, the CSP stays exactly as strict as before.

The switch is read for every HTML response, so the answer is cached in Redis,
which both workers share: a miss reads the database once and keeps the answer
for CACHE_SECONDS, and a settings save that writes the switch drops it
(forget), so the change reaches both workers on their next page.

Redis is reached with the blocking client in a worker thread rather than the
sessions' asyncio client: the read sits in the security headers middleware,
under every HTML response, and this client is bound to no event loop.
"""

import logging
from typing import Optional

import redis
from fastapi.concurrency import run_in_threadpool
from redis.exceptions import RedisError

from app.config import settings
from app.database import SessionLocal
from app.models import Setting

logger = logging.getLogger(__name__)

SETTING_KEY = "security.cloudflare_web_analytics"
SCRIPT_SOURCE = "https://static.cloudflareinsights.com"
CONNECT_SOURCE = "https://cloudflareinsights.com"
CACHE_KEY = "webservarr:cache:cloudflare-web-analytics"
# Bounds how long a save that could not drop the cached answer stays unseen.
CACHE_SECONDS = 60
REDIS_TIMEOUT = 1.0

_client: Optional[redis.Redis] = None


def _redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(settings.redis_url, socket_timeout=REDIS_TIMEOUT,
                                       socket_connect_timeout=REDIS_TIMEOUT)
    return _client


def _stored() -> bool:
    """The switch as the database holds it. A missing row is the default, off."""
    db = SessionLocal()
    try:
        row = db.query(Setting).filter(Setting.key == SETTING_KEY).first()
        return row is not None and row.value == "true"
    finally:
        db.close()


def _answer() -> bool:
    try:
        cached = _redis().get(CACHE_KEY)
    except RedisError:
        cached = None
    if cached is not None:
        return cached == b"1"
    try:
        on = _stored()
    except Exception:  # noqa: BLE001 - the strict CSP is the safe answer
        logger.warning("Could not read %s; serving the strict CSP", SETTING_KEY, exc_info=True)
        return False
    try:
        _redis().set(CACHE_KEY, "1" if on else "0", ex=CACHE_SECONDS)
    except RedisError:
        pass   # uncached: the next page reads the database again
    return on


async def allowed() -> bool:
    """True when the operator has allowed Cloudflare Web Analytics.

    Redis trouble falls back to the database; database trouble answers off,
    the strict CSP, rather than failing the page."""
    return await run_in_threadpool(_answer)


def _forget() -> None:
    try:
        _redis().delete(CACHE_KEY)
    except RedisError:
        logger.warning("Saved %s, but its cached value wasn't cleared; it updates within %d s",
                       SETTING_KEY, CACHE_SECONDS)


async def forget() -> None:
    """Drop the cached answer after a save wrote the switch. A failure is
    logged, not raised: the save has landed, and the cached answer expires
    within CACHE_SECONDS anyway."""
    await run_in_threadpool(_forget)
