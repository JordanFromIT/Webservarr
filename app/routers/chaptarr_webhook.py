"""
The arr webhooks (POST /api/webhooks/{app}, app one of sonarr, radarr,
chaptarr).

Each app calls it with its Webhook connection. It is not a signed in
person's route: the app proves itself with its own shared secret (setting
integration.<app>.webhook_secret), which it sends as the HTTP Basic password
of its webhook Username and Password fields; the username is ignored. An
empty secret setting refuses every call to that app's address.

Every event the event log has words for becomes a library line in the status
feed (app/services/library_lines.py translates, status_feed stores and groups
Sonarr's per-file imports). Anything else is acknowledged and nothing is
written. The answer is 204 either way; 401 for a wrong secret, 404 for an
app not listed, 422 for a body that is not JSON, 503 when the database can't
be written, never a 500. The rate limit is per app (and caller), roomy enough
for a full-series import: Sonarr sends one post per episode file and does
not retry.

Chaptarr's import ("Download") also refreshes the Books catalog, so the
Books page picks the book up now rather than at the next 15-minute rebuild:
an import is rebuilt at once (what Kavita already has), and Kavita is asked
to scan its libraries, because it only looks for new files on its own
schedule (dev: daily). The catalog is then rebuilt again shortly after, and
once more a couple of minutes after, to pick the new file up when the scan
has found it. All of that runs in the background after the answer is sent.
It is bounded: at most one scan request per SCAN_GAP_S and one follow-up
sequence per SEQUENCE_S, claimed in Redis so the two workers and a burst of
imports (one event per book) share them; nothing is held in the process.
With Redis unreachable the scan and the follow-ups are skipped (the
immediate rebuild and the 15-minute one remain).
"""

import base64
import binascii
import hmac
import asyncio
import json
import logging

import redis.asyncio as aioredis
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.integrations import config as integration_config
from app.integrations import kavita
from app.limiter import limiter, rate_limit_key
from app.services import book_catalog, library_lines, status_feed

logger = logging.getLogger(__name__)

router = APIRouter()

APPS = library_lines.APPS
IMPORT_EVENTS = {"download", "import"}
# Per app and caller. All three apps usually share one address, and a
# full-series import is one post per episode file.
RATE_LIMIT = "600/minute"

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


def secret_key(app: str) -> str:
    return f"integration.{app}.webhook_secret"


def _rate_key(request: Request) -> str:
    """The rate-limit key: the app named in the address, and the caller."""
    return f"webhook:{str(request.path_params.get('app', ''))[:10]}:{rate_limit_key(request)}"


def _authorised(request: Request, app: str) -> bool:
    key = secret_key(app)
    secret = integration_config.read((key,)).get(key) or ""
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


@router.post("/{app}", status_code=204)
@limiter.limit(RATE_LIMIT, key_func=_rate_key)
async def arr_webhook(app: str, request: Request, background: BackgroundTasks, db: Session = Depends(get_db)):
    if app not in APPS:
        raise HTTPException(status_code=404, detail="Not found")
    if not _authorised(request, app):
        raise HTTPException(status_code=401, detail="Not authorised",
                            headers={"WWW-Authenticate": 'Basic realm="webhook"'})
    try:
        body = json.loads(await request.body())
    except (ValueError, RecursionError):
        raise HTTPException(status_code=422, detail="The request body is not JSON") from None
    event = body.get("eventType") if isinstance(body, dict) else None
    if app == "chaptarr" and isinstance(event, str) and event.strip().lower() in IMPORT_EVENTS:
        background.add_task(_after_import)
    line = library_lines.translate(app, body)
    if line is None:
        # Never the body: it names people, paths and releases.
        logger.info("A %s webhook (%s) makes no event log line", app,
                    event[:40] if isinstance(event, str) else "no event type")
        return Response(status_code=204)
    try:
        status_feed.record_library_event(db, app, line, status_feed.now_utc())
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("A %s webhook's event log line could not be written: %s", app, type(exc).__name__)
        raise HTTPException(status_code=503, detail="The event log can't be written right now") from None
    return Response(status_code=204)
