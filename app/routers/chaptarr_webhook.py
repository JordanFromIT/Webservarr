"""
Chaptarr's import webhook (POST /api/webhooks/chaptarr).

Chaptarr calls it when a book has been imported, so the Books catalog picks
the book up now rather than at the next 15-minute rebuild. It is not a signed
in person's route: Chaptarr proves itself with the shared secret (setting
integration.chaptarr.webhook_secret), which it sends as the HTTP Basic
password of its webhook Username and Password fields; the username is
ignored. An empty secret setting refuses every call.

Only an import ("Download") event runs anything. Any other event is
acknowledged with 204 and nothing runs.

An import is rebuilt at once (what Kavita already has), and Kavita is asked to
scan its libraries, because it only looks for new files on its own schedule
(dev: daily). The catalog is then rebuilt again shortly after, and once more a
couple of minutes after, to pick the new file up when the scan has found it.
All of that runs in the background after the answer is sent. It is bounded: at
most one scan request per SCAN_GAP_S and one follow-up sequence per
SEQUENCE_S, claimed in Redis so the two workers and a burst of imports (one
event per book) share them; nothing is held in the process. With Redis
unreachable the scan and the follow-ups are skipped (the immediate rebuild and
the 15-minute one remain).
"""

import base64
import binascii
import hmac
import asyncio
import json
import logging

import redis.asyncio as aioredis
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response

from app.config import settings
from app.integrations import config as integration_config
from app.integrations import kavita
from app.limiter import limiter
from app.services import book_catalog

logger = logging.getLogger(__name__)

router = APIRouter()

SECRET_KEY = "integration.chaptarr.webhook_secret"
IMPORT_EVENTS = {"download", "import"}

SCAN_KEY = "books:kavita-scan"
SEQUENCE_KEY = "books:post-import"
SCAN_GAP_S = 30                 # Kavita is asked to scan at most this often
SEQUENCE_S = 150                # one follow-up sequence at a time, for a little longer than it runs
FOLLOW_UP_AT_S = (20, 120)      # rebuild again this long after the scan was asked, and once more


def _basic_password(request: Request) -> str:
    """The password of the request's Basic credentials; "" when it has none."""
    scheme, _, token = (request.headers.get("authorization") or "").partition(" ")
    if scheme.lower() != "basic":
        return ""
    try:
        decoded = base64.b64decode(token.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return ""
    return decoded.partition(":")[2]


def _authorised(request: Request) -> bool:
    secret = integration_config.read((SECRET_KEY,)).get(SECRET_KEY) or ""
    sent = _basic_password(request)
    # Compared as bytes, in constant time, whatever is sent; never true for an
    # empty secret.
    matches = hmac.compare_digest(sent.encode("utf-8"), secret.encode("utf-8"))
    return bool(secret) and matches


async def _rebuild_quietly() -> None:
    try:
        await book_catalog.rebuild("chaptarr")
    except Exception as exc:  # noqa: BLE001 - nobody is waiting on this; the 15-minute rebuild retries
        logger.warning("Rebuild after a Chaptarr import failed: %s", type(exc).__name__)


async def _claim(key: str, seconds: int) -> bool:
    """True when this caller took `key` (nobody had it in the last `seconds`).
    False when someone has it, and also when Redis cannot be reached."""
    try:
        redis = aioredis.from_url(settings.redis_url)
        try:
            return bool(await redis.set(key, "1", nx=True, ex=seconds))
        finally:
            await redis.aclose()
    except Exception as exc:  # noqa: BLE001
        logger.warning("The import follow-up could not reach Redis: %s", type(exc).__name__)
        return False


async def _scan_quietly() -> None:
    try:
        asked = await kavita.scan_libraries()
        logger.info("Kavita was asked to scan %d librar%s after a Chaptarr import", asked, "y" if asked == 1 else "ies")
    except kavita.KavitaUnavailable as exc:
        logger.warning("Kavita could not be asked to scan after a Chaptarr import: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Kavita could not be asked to scan after a Chaptarr import: %s", type(exc).__name__)


async def _after_import() -> None:
    """What an import sets going (see the module's note). Runs after the answer."""
    await _rebuild_quietly()
    if await _claim(SCAN_KEY, SCAN_GAP_S):
        await _scan_quietly()
    if not await _claim(SEQUENCE_KEY, SEQUENCE_S):
        return                        # a sequence from an earlier import is already waiting to rebuild
    waited = 0
    for at in FOLLOW_UP_AT_S:
        await asyncio.sleep(at - waited)
        waited = at
        await _rebuild_quietly()


@router.post("/chaptarr", status_code=202)
@limiter.limit("60/minute")
async def chaptarr_import(request: Request, background: BackgroundTasks):
    if not _authorised(request):
        raise HTTPException(status_code=401, detail="Not authorised",
                            headers={"WWW-Authenticate": 'Basic realm="webhook"'})
    try:
        body = json.loads(await request.body())
    except (ValueError, RecursionError):
        raise HTTPException(status_code=400, detail="The request body is not JSON") from None
    event = body.get("eventType") if isinstance(body, dict) else None
    if not isinstance(event, str) or event.strip().lower() not in IMPORT_EVENTS:
        return Response(status_code=204)
    background.add_task(_after_import)
    return {"status": "queued"}
