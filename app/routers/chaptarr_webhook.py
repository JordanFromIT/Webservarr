"""
Chaptarr's import webhook (POST /api/webhooks/chaptarr).

Chaptarr calls it when a book has been imported, so the Books catalog picks
the book up now rather than at the next 15-minute rebuild. It is not a signed
in person's route: Chaptarr proves itself with the shared secret (setting
integration.chaptarr.webhook_secret), which it sends as the HTTP Basic
password of its webhook Username and Password fields; the username is
ignored. An empty secret setting refuses every call.

Only an import ("Download") event runs a rebuild. Any other event is
acknowledged with 204 and nothing runs.
"""

import base64
import binascii
import hmac
import json
import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response

from app.integrations import config as integration_config
from app.limiter import limiter
from app.services import book_catalog

logger = logging.getLogger(__name__)

router = APIRouter()

SECRET_KEY = "integration.chaptarr.webhook_secret"
IMPORT_EVENTS = {"download", "import"}


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


async def _rebuild_after_import() -> None:
    try:
        await book_catalog.rebuild("chaptarr")
    except Exception as exc:  # noqa: BLE001 - nobody is waiting on this; the 15-minute rebuild retries
        logger.warning("Rebuild after a Chaptarr import failed: %s", type(exc).__name__)


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
    background.add_task(_rebuild_after_import)
    return {"status": "queued"}
