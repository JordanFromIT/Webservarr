"""
Where the admin's notices go (docs/superpowers/specs/2026-10-10-request-access-design.md,
section 8).

The bell and push are keyed by the email of the signed-in session
(utils.identity_email), and an admin who signs in through Authentik carries
Authentik's email claim, which need not be the plex.tv owner's. So the admin
is never found by comparing emails. Each admin sign-in records the pair it
knows for certain: the session's immutable Plex account id and the email its
bell is filed under. A notice for the admin goes to the emails recorded for
the account id that owns the admin token now: the id rule sign-in uses to
make someone admin (auth._is_plex_server_owner).
"""
from datetime import datetime, timezone
from typing import List

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AdminContact
from app.utils import identity_email


def remember(db: Session, session_data: dict) -> bool:
    """Record an admin session's (Plex account id, notice email), or refresh
    its seen_at. False, and nothing written, for a member or a session with
    no Plex account id or no email."""
    if session_data.get("is_admin") != "true":
        return False
    account_id = str(session_data.get("plex_account_id") or "")
    email = identity_email(session_data.get("email"))
    if not account_id or not email:
        return False
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    row = db.get(AdminContact, (account_id, email))
    if row is None:
        db.add(AdminContact(plex_account_id=account_id, notify_email=email, seen_at=now))
    else:
        row.seen_at = now
    try:
        db.commit()
    except IntegrityError:
        db.rollback()   # the other worker recorded the same pair a moment ago
    return True


def emails_for(db: Session, owner_account_id) -> List[str]:
    """The notice emails recorded for the account that owns the admin token."""
    owner = str(owner_account_id or "")
    if not owner:
        return []
    rows = db.query(AdminContact.notify_email).filter(AdminContact.plex_account_id == owner).all()
    return sorted({email for (email,) in rows if email})
