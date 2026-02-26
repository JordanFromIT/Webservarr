# Phase 7: WebServarr Open-Source Release — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebrand HMS Dashboard to WebServarr and make the app fully self-contained for public release — direct Plex OAuth, zero-config startup, all settings in the UI, minimal Docker Compose.

**Architecture:** Replace Authentik OIDC as the primary auth with direct Plex PIN-based OAuth. Move all Authentik config from env vars to the Settings DB. Auto-generate SECRET_KEY on first startup. Rename everything from HMS Dashboard to WebServarr. Ship a minimal docker-compose.yml with just the app + Redis.

**Tech Stack:** Python/FastAPI (backend), httpx (Plex API), vanilla JS (frontend), Docker Compose

---

### Task 1: Auto-generate SECRET_KEY on first startup

The app currently requires `APP_SECRET_KEY` as an env var. Instead, auto-generate it on first startup and store it in the database, so users never need to set env vars.

**Files:**
- Modify: `app/config.py`
- Modify: `app/seed.py`
- Modify: `app/main.py`

**Step 1: Update config.py to make SECRET_KEY optional**

In `app/config.py`, change the `app_secret_key` field default from raising an error to accepting an empty string. The real key will come from the database at startup.

```python
# Change:
app_secret_key: str
# To:
app_secret_key: str = ""
```

**Step 2: Add SECRET_KEY auto-generation to seed.py**

In `app/seed.py`, after the VAPID key generation block, add a similar block for SECRET_KEY:

```python
import secrets

def seed_secret_key(db: Session):
    """Auto-generate SECRET_KEY on first startup and store in Settings."""
    existing = db.query(Setting).filter(Setting.key == "system.secret_key").first()
    if existing:
        return existing.value

    key = secrets.token_hex(32)
    setting = Setting(
        key="system.secret_key",
        value=key,
        description="Auto-generated secret key for session signing"
    )
    db.add(setting)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(Setting).filter(Setting.key == "system.secret_key").first()
        return existing.value if existing else key
    return key
```

**Step 3: Wire up SECRET_KEY loading in main.py**

In `app/main.py`, in the `lifespan` function, after `init_db()` but before Redis connection, load or generate the secret key:

```python
from app.seed import seed_secret_key

# After init_db():
db = SessionLocal()
try:
    secret_key = seed_secret_key(db)
    if not settings.app_secret_key:
        settings.app_secret_key = secret_key
finally:
    db.close()
```

**Step 4: Commit**

```bash
git add app/config.py app/seed.py app/main.py
git commit -m "feat: auto-generate SECRET_KEY on first startup"
```

---

### Task 2: Rebrand Python defaults to WebServarr

Change all HMS Dashboard references in Python backend to WebServarr. This is a find-and-replace across several files.

**Files:**
- Modify: `app/config.py`
- Modify: `app/seed.py`
- Modify: `app/routers/branding.py`
- Modify: `app/services/push.py`
- Modify: `app/routers/admin.py`

**Step 1: Update config.py defaults**

| Setting | Old Value | New Value |
|---------|-----------|-----------|
| `app_name` | `"HMS Dashboard"` | `"WebServarr"` |
| `app_domain` | `"dev.hmserver.tv"` | `"localhost"` |
| `session_cookie_name` | `"hms_session"` | `"webservarr_session"` |

**Step 2: Update seed.py defaults**

| Setting | Old Value | New Value |
|---------|-----------|-----------|
| `branding.app_name` | `"HMS Dashboard"` | `"WebServarr"` |
| `branding.tagline` | `"Home Media Server Management"` | `"Media Server Management"` |
| Default admin email | `"admin@hmserver.tv"` | `"admin@localhost"` |

**Step 3: Update branding.py DEFAULTS dict**

Same as seed.py: change `branding.app_name` and `branding.tagline` defaults.

**Step 4: Update push.py VAPID contact**

Change hardcoded `VAPID_CLAIMS` to read from the database:

```python
# Remove the hardcoded VAPID_CLAIMS constant.
# In send_push_to_users(), read admin email from Settings:
admin_email_setting = db.query(Setting).filter(Setting.key == "system.admin_email").first()
admin_email = admin_email_setting.value if admin_email_setting else "admin@localhost"
vapid_claims = {"sub": f"mailto:{admin_email}"}
```

**Step 5: Update admin.py container name**

Replace hardcoded `"hms-dashboard"` with configurable name:

```python
import os
CONTAINER_NAME = os.environ.get("CONTAINER_NAME", "webservarr")

# In restart/shutdown endpoints:
container = client.containers.get(CONTAINER_NAME)
```

**Step 6: Commit**

```bash
git add app/config.py app/seed.py app/routers/branding.py app/services/push.py app/routers/admin.py
git commit -m "feat: rebrand Python defaults to WebServarr"
```

---

### Task 3: Direct Plex OAuth backend

Add PIN-based Plex OAuth that works without Authentik. This is the same flow Overseerr, Tautulli, and other *arr apps use.

**Files:**
- Create: `app/routers/plex_auth.py` (new router for Plex PIN-based auth)
- Modify: `app/main.py` (register new router)

**Step 1: Create app/routers/plex_auth.py**

This router handles direct Plex OAuth without Authentik:

- `POST /auth/plex-start`: Creates a Plex PIN, returns auth URL for the frontend to open
- `POST /auth/plex-callback`: Polls the PIN for auth token, gets user info, creates session
- `GET /auth/plex-callback-page`: Simple landing page for Plex redirect (closes popup or redirects)

Key implementation details:
- Checks `integration.plex.url` and `integration.plex.token` in Settings to verify Plex is configured
- Auto-generates and persists a `system.plex_client_id` (UUID stored in Settings, same pattern as VAPID keys)
- Uses `_is_plex_server_owner()` from existing `app/routers/auth.py` for admin determination
- Stores `plex_token` in session for Overseerr SSO (same as current OIDC flow)
- Sets `auth_method: "plex"` in session data
- PIN stored in Redis state with 5-min TTL
- Plex callback page uses `postMessage` for popup flow, URL param for mobile redirect flow
- The callback landing page HTML should be constructed using FastAPI's `HTMLResponse` with a static string

**Step 2: Register the router in main.py**

In `app/main.py`, import and include the new router:

```python
from app.routers import plex_auth
app.include_router(plex_auth.router)
```

**Step 3: Commit**

```bash
git add app/routers/plex_auth.py app/main.py
git commit -m "feat: add direct Plex OAuth (PIN-based, no Authentik required)"
```

---

### Task 4: Move Authentik config from env vars to Settings DB

Currently Authentik OIDC settings are env vars in `config.py`. Move them to the Settings DB so they can be configured in the UI.

**Files:**
- Modify: `app/config.py` (make Authentik fields optional, they already mostly are)
- Modify: `app/auth.py` (OIDCClient reads from DB with env var fallback)
- Modify: `app/routers/auth.py` (dynamically check if OIDC is available)
- Modify: `app/routers/simple_auth.py` (dynamic Authentik slug in logout URL)
- Modify: `app/seed.py` (seed Authentik setting keys)

**Step 1: Add factory function to auth.py**

Create `get_oidc_client(db)` that builds an OIDCClient from Settings DB, falling back to env vars:

```python
def get_oidc_client(db: Session):
    from app.models import Setting
    def get_setting(key):
        s = db.query(Setting).filter(Setting.key == key).first()
        return s.value if s else ""

    url = get_setting("integration.authentik.url")
    client_id = get_setting("integration.authentik.client_id")
    client_secret = get_setting("integration.authentik.client_secret")

    if not url or not client_id or not client_secret:
        if settings.authentik_url and settings.authentik_client_id:
            return OIDCClient()
        return None

    return OIDCClient(authentik_url=url, client_id=client_id, client_secret=client_secret)
```

Update OIDCClient `__init__` to accept optional override parameters.

**Step 2: Update auth routes to use dynamic OIDC client**

Change `/auth/login` and `/auth/callback` to call `get_oidc_client(db)` instead of using the global.

**Step 3: Update logout for dynamic Authentik slug**

In `simple_auth.py`, read `integration.authentik.url` and `integration.authentik.app_slug` from Settings instead of using hardcoded slug.

**Step 4: Seed Authentik setting keys**

Add to `DEFAULT_SETTINGS` in `seed.py`:
```python
"integration.authentik.url": ("", "Authentik base URL"),
"integration.authentik.client_id": ("", "Authentik OAuth2 client ID"),
"integration.authentik.client_secret": ("", "Authentik OAuth2 client secret"),
"integration.authentik.app_slug": ("", "Authentik application slug"),
```

**Step 5: Commit**

```bash
git add app/config.py app/auth.py app/routers/auth.py app/routers/simple_auth.py app/seed.py
git commit -m "feat: move Authentik config from env vars to Settings DB"
```

---

### Task 5: Update login page for multi-auth

The login page needs to show/hide auth buttons based on what's configured. Add the direct Plex OAuth flow and conditional Authentik button.

**Files:**
- Modify: `app/static/login.html`
- Modify: `app/routers/branding.py` (expose auth method availability)

**Step 1: Add auth_methods to branding endpoint**

In `app/routers/branding.py`, add an `auth_methods` section to the response:

```python
plex_url = get("integration.plex.url")
plex_token = get("integration.plex.token")
authentik_url = get("integration.authentik.url")
authentik_client_id = get("integration.authentik.client_id")

auth_methods = {
    "simple": get("features.show_simple_auth") != "false",
    "plex": bool(plex_url and plex_token),
    "authentik": bool(authentik_url and authentik_client_id),
}
```

**Step 2: Update login.html Plex button**

Replace the existing click handler (which redirects to `/auth/login`) with the PIN-based flow:

1. On click: `POST /auth/plex-start` to get PIN + auth URL
2. Desktop: open auth URL in popup, listen for `postMessage` callback
3. Mobile: store `pin_id` in `sessionStorage`, redirect to auth URL
4. On auth complete: `POST /auth/plex-callback` with `pin_id`
5. On success: redirect to `/`
6. Retry logic: if PIN not yet authorized, retry every 2 seconds

**Step 3: Add Authentik button (conditional)**

Add a new button `#authentikLoginBtn` (hidden by default). Show it when `auth_methods.authentik` is true. Click handler: `window.location.href = '/auth/login'`.

**Step 4: Handle mobile return from Plex auth**

Check for `?plex_auth=complete` URL parameter on page load. If present, read `pin_id` from `sessionStorage` and call `completePlexAuth()`.

**Step 5: Remove Google CDN static images**

Remove the 12 `<div>` elements with `lh3.googleusercontent.com` URLs. Replace the static poster grid with a simple dark gradient fallback:

```html
<div id="staticPosterGrid" class="fixed inset-0 z-0">
    <div class="absolute inset-0 bg-gradient-to-br from-black via-baltic-blue/20 to-black"></div>
</div>
```

**Step 6: Hide/show simple auth form based on auth_methods**

```javascript
var authMethods = theme.auth_methods || {};
if (!authMethods.simple) { /* hide form fields, keep auth buttons */ }
if (!authMethods.plex) { /* hide plex button */ }
if (authMethods.authentik) { /* show authentik button */ }
```

**Step 7: Commit**

```bash
git add app/static/login.html app/routers/branding.py
git commit -m "feat: multi-auth login page with direct Plex OAuth"
```

---

### Task 6: Add Authentik accordion to Settings page

Add an Authentik integration section to the Settings page and a safety warning when disabling simple auth.

**Files:**
- Modify: `app/static/settings.html`

**Step 1: Add Authentik accordion HTML**

After the Radarr accordion, add a new accordion for Authentik with fields: URL, Client ID, Client Secret, Application Slug. Follow the exact same pattern as existing accordions (icon: `shield_person`, label: "Authentik (Optional)").

**Step 2: Add Authentik to integrationFields JS object**

```javascript
authentik: {
    urlInput: 'integrationAuthentikUrl',
    credInput: 'integrationAuthentikClientId',
    urlKey: 'integration.authentik.url',
    credKey: 'integration.authentik.client_id',
    statusDiv: 'statusAuthentik',
    extraFields: [
        { input: 'integrationAuthentikClientSecret', key: 'integration.authentik.client_secret' },
        { input: 'integrationAuthentikSlug', key: 'integration.authentik.app_slug' },
    ]
},
```

**Step 3: Add safety warning for disabling simple auth**

Add a `change` event listener on the `featureSimpleAuth` checkbox. When unchecked, show a `confirm()` dialog warning about lockout risk. If user cancels, re-check the box.

**Step 4: Commit**

```bash
git add app/static/settings.html
git commit -m "feat: add Authentik integration settings and simple auth safety warning"
```

---

### Task 7: Frontend cleanup — dynamic titles, SW, reset defaults

Make page titles dynamic, update service worker fallback, and rebrand settings defaults.

**Files:**
- Modify: `app/static/login.html`, `index.html`, `requests2.html`, `issues.html`, `calendar.html`, `settings.html`, `requests.html`
- Modify: `app/static/sw.js`
- Modify: `app/static/js/theme-loader.js`
- Modify: `app/static/js/sidebar.js`
- Modify: `app/static/js/auth.js`
- Modify: `app/static/js/notifications.js`

**Step 1: Dynamic page titles via theme-loader.js**

At the end of `applyTheme()`, update `document.title` using `data.app_name` while preserving the page suffix (e.g., "- Login", "- Dashboard").

**Step 2: Update all HTML `<title>` tags**

Replace "HMS Dashboard" with "WebServarr" in all `<title>` elements (the theme-loader will override at runtime with whatever the user configured).

**Step 3: Update sw.js fallback title**

Change `'HMS Dashboard'` to `'WebServarr'` in the push notification fallback payload.

**Step 4: Update settings.html THEME_DEFAULTS**

Change `'HMS Dashboard'` to `'WebServarr'` and `'Home Media Server Management'` to `'Media Server Management'`.

**Step 5: Update theme-loader.js cache key**

Change `'hms_branding'` to `'webservarr_branding'`.

**Step 6: Update JS file comment headers**

Replace "HMS Dashboard" with "WebServarr" in comment headers of `sidebar.js`, `auth.js`, `notifications.js`, `theme-loader.js`.

**Step 7: Commit**

```bash
git add app/static/
git commit -m "feat: rebrand frontend to WebServarr, dynamic page titles"
```

---

### Task 8: Docker Compose cleanup

Ship a minimal docker-compose.yml with just WebServarr + Redis.

**Files:**
- Modify: `docker-compose.yml` (replace with minimal version)
- Create: `docker-compose.authentik.yml` (optional reference for Authentik setup)

**Step 1: Replace docker-compose.yml**

Replace with minimal compose containing only `webservarr` and `redis` services. Keep the Docker socket mount (needed for container restart admin feature) and existing volume patterns.

**Step 2: Create docker-compose.authentik.yml**

An example/reference compose file showing how to overlay Authentik (authentik-server, authentik-worker, postgresql) via `docker compose -f docker-compose.yml -f docker-compose.authentik.yml up -d`. Include comments explaining the setup.

**Step 3: Commit**

```bash
git add docker-compose.yml docker-compose.authentik.yml
git commit -m "feat: minimal docker-compose (WebServarr + Redis only)"
```

---

### Task 9: Documentation — README, LICENSE, VISION, setup guide

Write public-facing documentation for the GitHub release.

**Files:**
- Modify: `README.md` (rewrite for public audience)
- Create: `LICENSE` (MIT)
- Modify: `VISION.md` (update phase names, mark completions, remove personal infra details)
- Modify: `CLAUDE.md` (update for WebServarr naming)
- Modify: `docs/app-contract.md` (add new Plex OAuth endpoints, Authentik settings)
- Modify: `docs/setup.md` (rewrite as user-facing installation guide)

**Step 1: Create MIT LICENSE file**

Standard MIT license with "Copyright (c) 2026 WebServarr".

**Step 2: Rewrite README.md**

Structure: project description, features, quick start (3 steps), configuration, integrations, auth options, contributing, license.

**Step 3: Update VISION.md**

Mark Phases 2-4 with checkmarks. Update Phase 7 description. Add Phase 8: Security Hardening. Remove personal infrastructure details (Linode specs, UNRAID, specific domains).

**Step 4: Update CLAUDE.md**

Replace "HMS Dashboard" with "WebServarr". Update auth docs for three auth methods. Update docker-compose references. Remove personal domain references.

**Step 5: Update docs/app-contract.md**

Add new endpoints: `POST /auth/plex-start`, `POST /auth/plex-callback`, `GET /auth/plex-callback-page`. Add new settings: `integration.authentik.*`, `system.secret_key`, `system.plex_client_id`. Update auth documentation.

**Step 6: Rewrite docs/setup.md**

Replace VPS-specific guide with generic: Prerequisites, Installation, First-time Setup, Updating, Backup, Advanced (Authentik, reverse proxy), Troubleshooting.

**Step 7: Commit**

```bash
git add README.md LICENSE VISION.md CLAUDE.md docs/app-contract.md docs/setup.md
git commit -m "docs: rewrite documentation for WebServarr public release"
```

---

### Task 10: Final verification and cleanup

Rebuild, test all auth flows, verify no HMS references remain.

**Step 1: Search for remaining HMS/hmserver references**

Search all source files for `HMS Dashboard`, `hmserver`, `hms-dashboard`, `hms_session`, `hms_branding`. Fix any remaining references.

**Step 2: Rebuild container**

```bash
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build"
```

**Step 3: Test auth flows**

1. Simple auth: login with admin/admin123
2. Verify Settings > Integrations shows Authentik accordion
3. Verify login page shows correct buttons based on config
4. Test Plex OAuth flow (if Plex configured)
5. Verify branding shows "WebServarr" by default
6. Check all page titles are dynamic
7. Test disable-simple-auth safety warning

**Step 4: Final commit and push**

```bash
git add -A
git commit -m "chore: final cleanup for WebServarr open-source release"
git push
```
