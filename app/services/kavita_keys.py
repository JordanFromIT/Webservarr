"""
Each person's own Kavita API key, kept on the server so Books can sign them
in to Kavita again without a trip through the browser.

A session holds the person's Kavita sign-in (token, key, address), and the only
way to get one is the full-page hand-off through /kavita/connect and the
identity provider. A new session starts without one (a new login, a restart
that empties the session store, a token Kavita refuses), and the identity
provider's own session may have lapsed by then, which sent a signed-in person
to its login page on their first visit to Books.

So the key from every successful hand-off is kept here, by account identity,
with the Kavita address it came from, and `relink` turns it into a token again
(kavita.person_token, the exchange the hand-off itself makes). The trip is
left for a person with no key on file for this address, or one Kavita refuses.

Rules:
- A key is only ever sent to the address it came from (same_address).
- A key Kavita refuses was rotated: it is deleted, and the person connects again.
- It belongs to the person, not the session: logging out does not delete it.
  Moving the Kavita address does (forget_all).
- Stored as plain text like the settings table's secrets (models.KavitaKey).
- Database failures are logged by kind and never fail the request: without the
  key, the old hand-off still works.
"""
import logging
from datetime import datetime, timezone
from typing import NamedTuple, Optional

from redis.exceptions import RedisError
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import SQLAlchemyError

from app.auth import session_manager
from app.database import SessionLocal
from app.integrations import kavita
from app.integrations.config import same_address
from app.models import KavitaKey

logger = logging.getLogger(__name__)


class Relinked(NamedTuple):
    token: str
    api_key: str


def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _identity(user: dict) -> str:
    from app.routers.tickets import account_identity      # the router module imports the services
    return account_identity(user)


def remember(user: dict, base: str, api_key: str) -> None:
    """Keep this person's key for `base`, replacing any other. Nothing without
    an account identity (a session that owns nothing), an address or a key."""
    identity = _identity(user)
    if not (identity and base and api_key):
        return
    values = {"base": base, "api_key": api_key, "stored_at": _now_utc()}
    db = SessionLocal()
    try:
        db.execute(sqlite_insert(KavitaKey).values(identity=identity, **values)
                   .on_conflict_do_update(index_elements=[KavitaKey.identity], set_=values))
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("A Kavita key could not be kept: %s", type(exc).__name__)
    finally:
        db.close()


def _stored_key(identity: str, base: str) -> Optional[str]:
    """The key on file for this identity, only when it came from `base`."""
    db = SessionLocal()
    try:
        row = db.query(KavitaKey).filter(KavitaKey.identity == identity).first()
        return row.api_key if row and same_address(row.base, base) else None
    except SQLAlchemyError as exc:
        logger.warning("A Kavita key could not be read: %s", type(exc).__name__)
        return None
    finally:
        db.close()


def forget(identity: str) -> None:
    """Delete this identity's key (Kavita refused it: it was rotated)."""
    db = SessionLocal()
    try:
        db.query(KavitaKey).filter(KavitaKey.identity == identity).delete()
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("A Kavita key could not be deleted: %s", type(exc).__name__)
    finally:
        db.close()


def forget_all() -> int:
    """Delete every key (the Kavita address moved). Returns how many there were."""
    db = SessionLocal()
    try:
        count = db.query(KavitaKey).delete()
        db.commit()
        return count
    finally:
        db.close()


async def relink(user: dict, base: str, session_id: Optional[str]) -> Optional[Relinked]:
    """A Kavita token for this person at `base`, minted from their own key and
    saved in their session with the key and the address (no trip). The key on
    file is used first (the latest connect, from any device), else the one
    this session holds, and only when it came from `base`.

    None when there is no key to use, no session to save it in, or Kavita
    refuses the key (the stored one is then deleted: they connect again).
    KavitaUnavailable when Kavita does not answer, which a trip would not fix.
    The caller has already resolved `base` through kavita_url_for, so eBooks
    switched off for a member never reaches here."""
    if not session_id:
        return None
    identity = _identity(user)
    stored = _stored_key(identity, base) if identity else None
    held = (user.get("kavita_api_key") or "") if same_address(user.get("kavita_base"), base) else ""
    api_key = stored or held
    if not api_key:
        return None
    try:
        token = await kavita.person_token(base, api_key)
    except kavita.KavitaTokenRefused:
        if stored:
            forget(identity)
        return None
    signed_in = {"kavita_token": token, "kavita_api_key": api_key, "kavita_base": base}
    user.update(signed_in)                        # the rest of this request sees it too
    try:
        await session_manager.update_session(session_id, signed_in)
    except (RedisError, OSError) as exc:
        logger.warning("A renewed Kavita token could not be saved: %s", type(exc).__name__)
    if not stored:
        remember(user, base, api_key)             # a session from before keys were kept
    return Relinked(token, api_key)
