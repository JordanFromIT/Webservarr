"""
Event log lines other programs post (spec
docs/superpowers/specs/2026-10-05-event-log-library-events-design.md,
sections 11.2 and 11.3).

POST /api/webhooks/n8n: an n8n workflow says an issue was fixed. It proves
itself with the X-Webhook-Secret header (setting
integration.n8n.webhook_secret) and sends a structured body; the line's
words are this site's (activity_lines.fixed_line), and anything that could
show a person, an address or a token is refused with a 422.

POST /api/webhooks/kometa/<token>: Kometa's run_end. Kometa's webhooks can't
send headers, so the token in the address (setting
integration.kometa.webhook_token) is the secret; it never reaches a log
(main.py hides it in the access log, with redact_path). Every other Kometa
event is acknowledged and ignored.

Both answer 4xx or 503, never a 500. They are registered before the arr
webhooks' /{app} route, which would otherwise take "n8n" as an app.
"""

import hmac
import json
import logging
import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database import get_db
from app.integrations import config as integration_config
from app.integrations import plex
from app.limiter import limiter
from app.services import activity_lines, status_feed

logger = logging.getLogger(__name__)

router = APIRouter()

N8N_SECRET_KEY = "integration.n8n.webhook_secret"
KOMETA_TOKEN_KEY = "integration.kometa.webhook_token"

N8N_PER_HOUR = 30
KOMETA_GAP = timedelta(hours=6)

KOMETA_PATH = "/api/webhooks/kometa/"
_KOMETA_TOKEN = re.compile(re.escape(KOMETA_PATH) + r"[^\s?\"]*")


def redact_path(path: str) -> str:
    """The address with Kometa's token hidden: ".../kometa/…"."""
    return _KOMETA_TOKEN.sub(KOMETA_PATH + "…", path)


class HideWebhookTokens(logging.Filter):
    """For uvicorn's access log, whose record's third argument is the path,
    and slowapi's "exceeded at endpoint" warning, whose third is the scope."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str) and KOMETA_PATH in args[2]:
            record.args = args[:2] + (redact_path(args[2]),) + args[3:]
        return True


def _matches(sent: str, key: str) -> bool:
    """`sent` is the setting's value; never for an empty setting. Compared
    as bytes, in constant time, whatever is sent."""
    secret = integration_config.read((key,)).get(key) or ""
    same = hmac.compare_digest(sent.encode("utf-8"), secret.encode("utf-8"))
    return bool(secret) and same


async def _json(request: Request):
    try:
        return json.loads(await request.body())
    except (ValueError, RecursionError):
        raise HTTPException(status_code=422, detail="The request body is not JSON") from None


def _unwritable(db: Session, source: str, exc: Exception) -> HTTPException:
    db.rollback()
    logger.warning("A %s event log line could not be written: %s", source, type(exc).__name__)
    return HTTPException(status_code=503, detail="The event log can't be written right now")


@router.post("/n8n", status_code=204)
@limiter.limit("60/minute")
async def n8n_webhook(request: Request, db: Session = Depends(get_db)):
    if not _matches(request.headers.get("x-webhook-secret") or "", N8N_SECRET_KEY):
        raise HTTPException(status_code=401, detail="Not authorised")
    body = await _json(request)
    try:
        text, ref = activity_lines.fixed_line(body)
    except activity_lines.Refused as exc:
        # The reason only: the body may hold exactly what was refused.
        logger.info("An n8n event log post was refused: %s", exc)
        raise HTTPException(status_code=422, detail=str(exc)) from None
    key = f"n8n:issue_fixed:{ref}"
    now = status_feed.now_utc()
    try:
        if status_feed.has_line(db, key):
            return Response(status_code=204)
        if status_feed.lines_since(db, "n8n", now - timedelta(hours=1)) >= N8N_PER_HOUR:
            raise HTTPException(status_code=429, detail="Too many event log lines this hour")
        status_feed.record_line(db, "n8n", key, text, "fixed", now)
    except SQLAlchemyError as exc:
        raise _unwritable(db, "n8n", exc) from None
    return Response(status_code=204)


@router.post("/kometa/{token}", status_code=204)
@limiter.limit("30/minute")
async def kometa_webhook(token: str, request: Request, db: Session = Depends(get_db)):
    if not _matches(token, KOMETA_TOKEN_KEY):
        raise HTTPException(status_code=401, detail="Not authorised")
    body = await _json(request)
    if not activity_lines.is_run_end(body):
        event = body.get("event") if isinstance(body, dict) else None
        logger.info("A Kometa webhook (%s) makes no event log line",
                    event[:40] if isinstance(event, str) else "no event")
        return Response(status_code=204)
    kinds = activity_lines.poster_kinds(body, await plex.library_types())
    now = status_feed.now_utc()
    window = int((now - datetime(1970, 1, 1)) // KOMETA_GAP)    # now is naive UTC
    try:
        for kind in kinds:
            prefix = f"kometa:{kind or 'all'}:"
            if status_feed.lines_since(db, "kometa", now - KOMETA_GAP, key_prefix=prefix):
                continue
            status_feed.record_line(db, "kometa", f"{prefix}{window}", activity_lines.POSTERS[kind], "posters", now)
    except SQLAlchemyError as exc:
        raise _unwritable(db, "Kometa", exc) from None
    return Response(status_code=204)
