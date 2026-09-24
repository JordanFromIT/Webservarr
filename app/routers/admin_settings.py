"""
Admin settings API, driven by the settings registry (app/settings_registry.py).

Every write is validated against the registry before anything is stored. A
save with any invalid value is rejected as a whole (422, per-key messages)
so the database never holds half a form. Mounted before app.routers.admin so
its fixed paths (/settings/export, /settings/shell) win over the older
/settings/{key} route.
"""

import logging
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import require_admin
from app.limiter import limiter
from app.models import Setting
from app.settings_registry import (
    MASK, PATTERN_DEFS, REGISTRY, USER_DATA_MESSAGE, active_defs, get_def, is_user_data, mask, meta_for,
    validate_value,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# Keys whose change can take the last usable sign-in method away.
_SIGN_IN_KEYS = (
    "features.show_simple_auth", "features.show_plex_auth", "features.show_authentik_auth",
    "integration.plex.url", "integration.plex.token",
    "integration.authentik.url", "integration.authentik.client_id",
)
LOCKOUT_MESSAGE = ("Keep at least one sign-in method on and set up, "
                   "or nobody (including you) will be able to sign in.")
SAVE_FAILED_MESSAGE = "Couldn't save the settings right now. Nothing was changed; please try again."

# The legacy list endpoint returns every row, so it keeps the old
# term-based masking that also covers internal secrets (system.secret_key,
# the VAPID private key). Removed with the legacy shape in the switch-over.
LEGACY_SENSITIVE_TERMS = ("api_key", "token", "secret", "password", "private_key")


def mask_any(key: str, value: Optional[str]) -> str:
    """Mask a stored row for an admin response: by the registry for settings,
    by key terms for internal rows the registry doesn't describe."""
    if get_def(key) is not None:
        return mask(key, value)
    if value and any(t in key.lower() for t in LEGACY_SENSITIVE_TERMS):
        return MASK
    return "" if value is None else value


class SettingItem(BaseModel):
    key: str
    value: str
    description: Optional[str] = None


class BulkSettingsUpdate(BaseModel):
    settings: List[SettingItem]


def _rows(db: Session) -> Dict[str, str]:
    return {r.key: (r.value if r.value is not None else "") for r in db.query(Setting).all()}


def effective_values(db: Session) -> Dict[str, str]:
    """Every active key's stored-or-default raw value, plus pattern rows (unmasked)."""
    rows = _rows(db)
    out = {d.key: rows.get(d.key, d.default) for d in active_defs()}
    for key, value in rows.items():
        if key not in REGISTRY and get_def(key) is not None:
            out[key] = value
    return out


def usable_sign_in_methods(values: Dict[str, str]) -> List[str]:
    """Mirrors build_branding()'s auth_methods: what the login page would offer."""
    methods = []
    if values.get("features.show_simple_auth", "true") != "false":
        methods.append("simple")
    if (values.get("features.show_plex_auth", "false") != "false"
            and values.get("integration.plex.url") and values.get("integration.plex.token")):
        methods.append("plex")
    if (values.get("features.show_authentik_auth", "false") == "true"
            and values.get("integration.authentik.url") and values.get("integration.authentik.client_id")):
        methods.append("authentik")
    return methods


def plan_writes(db: Session, items: List[Tuple[str, str]]) -> Tuple[Dict[str, str], Dict[str, str]]:
    """Validate a batch. Returns (writes, errors); writes is empty whenever errors is not."""
    writes: Dict[str, str] = {}
    errors: Dict[str, str] = {}
    seen: List[str] = []
    for key, value in items:
        if key in seen:
            errors[key] = "Listed more than once"
            continue
        seen.append(key)
        if is_user_data(key):          # notify.<hash>.<category>: not an operator setting
            errors[key] = USER_DATA_MESSAGE
            continue
        d = get_def(key)
        if d is None:
            errors[key] = "Unknown setting"
            continue
        if value == MASK:
            if not d.secret:
                errors[key] = "That value isn't allowed"
            continue          # a secret sent back masked means "leave it as it is"
        message = validate_value(key, value)
        if message:
            errors[key] = message
            continue
        writes[key] = value

    if not errors:
        touched = [k for k in seen if k in _SIGN_IN_KEYS]
        if touched:
            after = effective_values(db)
            after.update(writes)
            if not usable_sign_in_methods(after):
                errors[_lockout_key(touched)] = LOCKOUT_MESSAGE
    return ({} if errors else writes), errors


def _lockout_key(touched: List[str]) -> str:
    """The key a lockout error is reported on: the first switch, else the first sign-in key."""
    flags = [k for k in touched if k.startswith("features.")]
    return (flags or touched)[0]


def apply_writes(db: Session, writes: Dict[str, str]) -> Dict[str, str]:
    """Upsert every write in one transaction, or none of them.

    Returns {} once saved, or the lockout error (nothing saved) when a change
    to sign-in keys would leave no usable method. plan_writes checks that too,
    but on a snapshot read before either worker held a write lock: two admins
    turning off different methods at once would each pass. So the check runs
    again here after the flush, which takes SQLite's write lock, and sees this
    batch plus whatever the other worker had already committed.

    One retry covers the other worker inserting the same new key at the same
    moment. Any failure (SQLite "database is locked" with two workers, for
    one) rolls back and becomes a 503, so a save never lands half-written."""
    if not writes:
        return {}
    touched = [k for k in writes if k in _SIGN_IN_KEYS]
    try:
        for attempt in (1, 2):
            existing = {r.key: r for r in db.query(Setting).filter(Setting.key.in_(list(writes))).all()}
            for key, value in writes.items():
                if key in existing:
                    existing[key].value = value
                else:
                    d = get_def(key)
                    db.add(Setting(key=key, value=value, description=d.description if d else None))
            try:
                if touched:
                    db.flush()
                    if not usable_sign_in_methods(effective_values(db)):
                        db.rollback()
                        return {_lockout_key(touched): LOCKOUT_MESSAGE}
                db.commit()
                return {}
            except IntegrityError:
                db.rollback()
                if attempt == 2:
                    raise
    except Exception:
        db.rollback()
        logger.warning("Settings save failed; nothing was saved", exc_info=True)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SAVE_FAILED_MESSAGE)


def validation_error(errors: Dict[str, str]) -> JSONResponse:
    """422 with every per-key message. `detail` repeats the first one, because
    the old settings page (live until the switch-over) shows only `detail`."""
    return JSONResponse(status_code=422,
                        content={"detail": next(iter(errors.values())), "errors": errors})


@router.get("/settings")
@limiter.limit("60/minute")
async def list_settings(
    request: Request,
    view: Optional[str] = None,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """SettingsView (view=registry) or, until the switch-over, the legacy row list."""
    if view != "registry":
        return [
            {"key": row.key, "value": mask_any(row.key, row.value), "description": row.description}
            for row in db.query(Setting).all()
            if not is_user_data(row.key)     # per-user rows never reach Settings
        ]

    values = {k: mask(k, v) for k, v in effective_values(db).items()}
    meta = {d.key: meta_for(d) for d in active_defs()}
    for _rx, pd in PATTERN_DEFS:
        meta[pd.key] = meta_for(pd)
    return {"values": values, "meta": meta}


@router.put("/settings/bulk")
@limiter.limit("30/minute")
async def bulk_update_settings(
    request: Request,
    payload: BulkSettingsUpdate,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """BulkSave: validate everything, then write everything, or nothing."""
    writes, errors = plan_writes(db, [(i.key, i.value) for i in payload.settings])
    errors = errors or apply_writes(db, writes)
    if errors:
        return validation_error(errors)
    return {"saved": list(writes), "values": {k: mask(k, v) for k, v in writes.items()}}
