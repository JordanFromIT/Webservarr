"""
Request access from the sign-in page: the rules that live in the database
(docs/superpowers/specs/2026-10-10-request-access-design.md, sections 4 to 6).

The router (app/routers/access_requests.py) talks to Plex and Redis and
holds the submit lock; this module decides. Times are naive UTC, as every
stored timestamp is.
"""
import logging
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Tuple
from urllib.parse import urlsplit

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AccessRequest, Setting
from app.utils import utc_iso

logger = logging.getLogger(__name__)

COOLDOWN = timedelta(days=30)        # a denied account may ask again after this
APPROVED_KEPT = timedelta(days=30)   # approved rows are tidied away after this
OPEN_CAP = 20                        # pending requests at once, across everyone
TIDY_INTERVAL = 3600                 # seconds between tidies, in the poller's leader loop
NAME_MAX = 80
NOTE_MAX = 1000
AVATAR_MAX = 500
NAME_PROBLEM = "Enter your name (up to 80 characters)."
NOTE_PROBLEM = "Tell us who you are and how you know us (up to 1000 characters)."


class FormProblem(ValueError):
    """The form can't be taken; the text says why, in the card's words."""


class CapReached(Exception):
    """OPEN_CAP requests are already waiting."""


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _setting(db: Session, key: str, default: str = "") -> str:
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row is not None and row.value is not None else default


def is_open(db: Session) -> bool:
    """The server-side gate: the switch is on and Plex is set up. The same
    rule as the branding flag auth_methods.request_access."""
    return (_setting(db, "access_requests.enabled", "false") == "true"
            and bool(_setting(db, "integration.plex.url"))
            and bool(_setting(db, "integration.plex.token")))


def safe_avatar_url(value) -> str:
    """The Plex avatar as it may be stored and shown: https on plex.tv or a
    subdomain of it, with no credentials in it, else ""."""
    if not isinstance(value, str):
        return ""
    v = value.strip()
    if not v or len(v) > AVATAR_MAX or any(c.isspace() or c == "\\" for c in v):
        return ""
    try:
        parts = urlsplit(v)
        host = (parts.hostname or "").lower()
        _ = parts.port   # a port past 65535 raises here
    except ValueError:
        return ""
    if parts.scheme.lower() != "https" or parts.username is not None or parts.password is not None:
        return ""
    return v if host == "plex.tv" or host.endswith(".plex.tv") else ""


def _has_control(text: str, allowed: str = "") -> bool:
    return any(unicodedata.category(c) == "Cc" and c not in allowed for c in text)


def clean_form(name: str, note: str) -> Tuple[str, str]:
    """The form as stored: both trimmed, the note's line ends as \\n. Control
    characters are refused, except newlines in the note; a tab, CR or
    newline at either end is trimmed like a space."""
    note = note.replace("\r\n", "\n").replace("\r", "\n")
    # Every other control character is looked for before trimming: strip()
    # also removes U+0085 and U+001C to U+001F, so one at either end would pass.
    name_has_control = _has_control(name, allowed="\t\n\r")
    note_has_control = _has_control(note, allowed="\t\n")
    name, note = name.strip(), note.strip()
    if name_has_control or _has_control(name) or not name or len(name) > NAME_MAX:
        raise FormProblem(NAME_PROBLEM)
    if note_has_control or _has_control(note, allowed="\n") or not note or len(note) > NOTE_MAX:
        raise FormProblem(NOTE_PROBLEM)
    return name, note


def _row(db: Session, plex_account_id: str) -> Optional[AccessRequest]:
    return db.query(AccessRequest).filter(AccessRequest.plex_account_id == str(plex_account_id)).first()


def _cooled_down(row: AccessRequest, now: datetime) -> bool:
    return row.status == "denied" and row.cooldown_until is not None and row.cooldown_until <= now


def _state_of(row: AccessRequest) -> Dict[str, str]:
    out = {"state": row.status, "submitted_at": utc_iso(row.created_at)}
    if row.status == "denied":
        out["can_ask_after"] = utc_iso(row.cooldown_until)
    return out


def state_for(db: Session, plex_account_id: str, now: datetime) -> Dict[str, str]:
    """What the card says to this account from its row: new (no row, or a
    cooldown that has ended), pending, approved, denied (with can_ask_after)
    or blocked."""
    row = _row(db, plex_account_id)
    if row is None or _cooled_down(row, now):
        return {"state": "new"}
    return _state_of(row)


def place(db: Session, account: Dict[str, str], name: str, note: str,
          now: datetime) -> Tuple[Dict, Optional[AccessRequest]]:
    """Submit's checks and insert, in the spec's order: blocked, cooldown, an
    open request (pending or approved), then the cap. The caller holds the
    submit lock, so two workers can't both pass the cap. Returns the answer
    for the card and the new row (None when nothing was made). Raises
    CapReached when OPEN_CAP requests are already waiting."""
    row = _row(db, account["plex_account_id"])
    if row is not None and _cooled_down(row, now):
        db.delete(row)       # the person may ask again: the new row replaces it
        db.flush()
        row = None
    if row is not None:
        return {**_state_of(row), "sent": False}, None
    if db.query(AccessRequest).filter(AccessRequest.status == "pending").count() >= OPEN_CAP:
        db.rollback()        # puts back a denied row deleted above
        raise CapReached()
    new = AccessRequest(
        plex_account_id=str(account["plex_account_id"]),
        plex_username=str(account.get("plex_username") or "")[:100],
        plex_email=str(account.get("plex_email") or "")[:254],
        plex_avatar_url=safe_avatar_url(account.get("plex_avatar_url")),
        name=name, note=note, status="pending", created_at=now,
    )
    db.add(new)
    try:
        db.commit()
    except IntegrityError:   # the same account, inserted a moment ago
        db.rollback()
        existing = _row(db, account["plex_account_id"])
        return ({**_state_of(existing), "sent": False} if existing else {"state": "new", "sent": False}), None
    db.refresh(new)
    return {"state": "pending", "sent": True}, new


def tidy(db: Session, now: datetime) -> int:
    """Delete denied rows whose cooldown has ended and approved rows decided
    more than APPROVED_KEPT ago. Blocked and pending rows stay. Returns how
    many rows went."""
    gone = (db.query(AccessRequest)
            .filter(AccessRequest.status == "denied", AccessRequest.cooldown_until.isnot(None),
                    AccessRequest.cooldown_until <= now)
            .delete(synchronize_session=False))
    gone += (db.query(AccessRequest)
             .filter(AccessRequest.status == "approved", AccessRequest.decided_at.isnot(None),
                     AccessRequest.decided_at <= now - APPROVED_KEPT)
             .delete(synchronize_session=False))
    db.commit()
    return gone


async def notify_admins(r, db: Session, row: AccessRequest) -> int:
    """File an "access" bell for every admin contact of the account that owns
    the admin token, and push it to their devices (spec section 8). The admin
    is found by Plex account id, never by comparing emails. Returns how many
    bells were filed. Never raises: a notice that can't go out must not fail
    the request, and the Settings badge still counts it. The note is never
    in a bell or a push."""
    # At call time: the poller imports this module, and the auth router the app.
    from app.routers.auth import _fetch_owner_account
    from app.services import admin_contacts
    from app.services.notification_poller import _create_notification_once
    from app.services.push import dispatch_push

    title, body = "Access request", f"{row.plex_username} asked for access"
    try:
        owner = await _fetch_owner_account(db) or {}
        # The id _is_plex_server_owner compares a signing-in account with.
        owner_id = str(owner.get("id") or owner.get("uuid") or "")
        if not owner_id:
            logger.warning("Access request %s: the server owner couldn't be read; no notice sent", row.id)
            return 0
        told = []
        for email in admin_contacts.emails_for(db, owner_id):
            if await _create_notification_once(r, db, email, "access", title, body, f"access:{row.id}"):
                told.append(email)
    except Exception as exc:
        logger.warning("Access request %s: the admin notice failed: %s", row.id, type(exc).__name__)
        return 0
    if told:
        try:
            await dispatch_push(told, title, body, "access", "/settings#access-requests")
        except Exception as exc:
            logger.warning("Access request %s: the push failed: %s", row.id, type(exc).__name__)
    return len(told)
