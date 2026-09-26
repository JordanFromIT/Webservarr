"""
Admin settings API, driven by the settings registry (app/settings_registry.py).

Every write is validated against the registry before anything is stored. A
save with any invalid value is rejected as a whole (422, per-key messages)
so the database never holds half a form.
"""

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings as app_settings
from app.database import get_db
from app.integrations import config as integration_config
from app.dependencies import require_admin
from app.limiter import limiter
from app.models import Setting
from app.settings_registry import (
    MASK, PAGE_ADDRESSES, PATTERN_DEFS, REGISTRY, USER_DATA_MESSAGE, active_defs, get_def, is_user_data, mask,
    meta_for, normalize_page_order, validate_value,
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
    """422 with every per-key message. `detail` repeats the first one, for a
    caller that shows a single message."""
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
    """SettingsView. `view` is accepted and ignored: the page asks for
    view=registry, which was once one of two shapes."""
    effective = effective_values(db)
    values = {k: mask(k, v) for k, v in effective.items()}
    meta = {d.key: meta_for(d) for d in active_defs()}
    for _rx, pd in PATTERN_DEFS:
        meta[pd.key] = meta_for(pd)
    # The front end takes these from here rather than keeping its own copies:
    # "mask" is what a saved secret reads as in `values`; "page_order" is the
    # sidebar order as the nav renders it (normalised, whatever the row
    # holds); "page_addresses" are the fixed page routes.
    return {"values": values, "meta": meta, "mask": MASK,
            "page_order": normalize_page_order(effective["pages.order"]),
            "page_addresses": dict(PAGE_ADDRESSES)}


@router.put("/settings/bulk")
@limiter.limit("30/minute")
async def bulk_update_settings(
    request: Request,
    payload: BulkSettingsUpdate,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """BulkSave: validate everything, then write everything, or nothing.

    Validation runs in a worker thread: checking an address can resolve a
    hostname with a blocking lookup, which on the event loop would stall
    every request this worker is serving. It is awaited, so the session is
    still used by one thing at a time."""
    writes, errors = await run_in_threadpool(plan_writes, db, [(i.key, i.value) for i in payload.settings])
    errors = errors or apply_writes(db, writes)
    if errors:
        return validation_error(errors)
    return {"saved": list(writes), "values": {k: mask(k, v) for k, v in writes.items()}}


# ---- Backup: export and import ----

EXPORT_FORMAT = "webservarr-settings"
EXPORT_VERSION = 1
MAX_IMPORT_KEYS = 2000
IMPORT_STALE_MESSAGE = "Settings changed since the preview. Preview the import again."


class ImportRequest(BaseModel):
    data: Any                       # checked by plan_import, so a wrong file gets a plain-English error
    diff_token: Optional[str] = None


def _diff_token(changes: List[dict]) -> str:
    canonical = json.dumps(changes, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def plan_import(db: Session, data: Any) -> Tuple[List[dict], List[str], Dict[str, str], Dict[str, str]]:
    """(changes, ignored, warnings, errors) for an export file.

    The file is diffed against the current values first, and only keys whose
    value would change go through plan_writes (BulkSave's validation, so the
    lockout guard runs only when a sign-in key changes). A value equal to
    what the install holds now is not a write: if today's rules reject it
    (stored before they existed) it is a warning, not an error, so a file
    always imports back onto the install it came from. Secrets (and any key
    marked deprecated) are ignored; per-user, internal and unknown keys,
    the keys retired in v1.11 among them, are errors."""
    if (not isinstance(data, dict) or data.get("format") != EXPORT_FORMAT
            or not isinstance(data.get("settings"), dict)):
        return [], [], {}, {"_file": "This isn't a WebServarr settings file"}
    if data.get("format_version") != EXPORT_VERSION:
        return [], [], {}, {"_file": "This settings file was made by a different version of WebServarr"}
    if len(data["settings"]) > MAX_IMPORT_KEYS:
        return [], [], {}, {"_file": "This file has too many settings"}

    current = effective_values(db)
    ignored: List[str] = []
    warnings: Dict[str, str] = {}
    errors: Dict[str, str] = {}
    items: List[Tuple[str, str]] = []
    for key, value in data["settings"].items():
        d = get_def(key)
        if d is None:                   # per-user, internal or unknown: plan_writes refuses it
            items.append((key, value))
            continue
        if d.secret or d.deprecated:
            ignored.append(key)
            continue
        if not isinstance(value, str):
            errors[key] = "Must be text"
            continue
        if key == integration_config.KUMA_SLUG_KEY and not value.strip():
            # An older install's page could save an empty slug, which the
            # client reads as the default page (kuma_slug()); Settings no
            # longer stores one, so the file's empty slug means that page.
            value = integration_config.DEFAULT_KUMA_SLUG
        if value == current.get(key, d.default):
            message = validate_value(key, value)
            if message:
                warnings[key] = message
            continue
        items.append((key, value))

    writes, write_errors = plan_writes(db, items)
    errors.update(write_errors)
    if errors:
        return [], sorted(ignored), {}, errors
    changes = [{"key": k, "old": current.get(k, get_def(k).default), "new": writes[k]} for k in sorted(writes)]
    return changes, sorted(ignored), warnings, {}


@router.get("/settings/export")
@limiter.limit("10/minute")
async def export_settings(
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """SettingsExport: every non-secret setting, and the names of the secrets left out.

    effective_values holds registry keys and pattern rows only, so internal
    rows (system.secret_key, VAPID keys, the setup token, setup/seed/migration
    markers) and per-user rows never reach the file."""
    values = effective_values(db)
    now = datetime.now(timezone.utc)
    body = {
        "format": EXPORT_FORMAT,
        "format_version": EXPORT_VERSION,
        "app_version": app_settings.app_version or "dev",
        "exported_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "settings": {k: v for k, v in values.items() if not get_def(k).secret},
        "secrets_excluded": [d.key for d in active_defs() if d.secret and values.get(d.key)],
    }
    return JSONResponse(content=body, headers={
        "Content-Disposition": f'attachment; filename="webservarr-settings-{now:%Y%m%d-%H%M%S}.json"',
        "Cache-Control": "no-store",
    })


@router.get("/settings/shell")
@limiter.limit("60/minute")
async def settings_shell(
    request: Request,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """ShellFragment: the sidebar links as they render now, so the Settings page
    can show a saved label/icon/order/visibility change without a reload. The
    markup comes from the same renderer as every page, so it cannot drift."""
    from app.pages import render_nav_links
    from app.routers.branding import load_branding

    branding = load_branding(db, True)
    return {"nav_html": render_nav_links(branding, True, "settings")}


@router.post("/settings/import")
@limiter.limit("10/minute")
async def import_settings(
    request: Request,
    payload: ImportRequest,
    dry_run: bool = True,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """SettingsImport: preview (dry_run=true) or apply exactly the previewed diff.

    Apply re-plans the file against the database as it is now and refuses
    (409) unless that diff hashes to the token the preview returned.
    Planning validates, so it runs in a worker thread, as in BulkSave."""
    changes, ignored, warnings, errors = await run_in_threadpool(plan_import, db, payload.data)
    if errors:
        return validation_error(errors)
    token = _diff_token(changes)
    if dry_run:
        return {"changes": changes, "ignored": ignored, "warnings": warnings, "diff_token": token}
    if not payload.diff_token or payload.diff_token != token:
        return JSONResponse(status_code=409, content={"detail": IMPORT_STALE_MESSAGE})
    errors = apply_writes(db, {c["key"]: c["new"] for c in changes})
    if errors:
        return validation_error(errors)
    return {"applied": [c["key"] for c in changes]}
