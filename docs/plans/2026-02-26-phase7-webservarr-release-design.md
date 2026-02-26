# Phase 7: WebServarr — Open-Source Release Prep

**Date:** 2026-02-26
**Status:** Approved

## Summary

Rebrand HMS Dashboard to WebServarr and prepare for public GitHub release. Add direct Plex OAuth (removing the Authentik requirement for first-time setup), make everything configurable through the Settings UI (zero filesystem config), clean up all hardcoded values, and write public-facing documentation.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Rebrand scope | Full rebrand to WebServarr | App is an *arr-ecosystem project, ships under new name |
| Authentik dependency | Optional (configurable in Settings UI) | Huge barrier for new users; most won't set up Authentik |
| Direct Plex OAuth | PIN-based flow, same as Overseerr/Tautulli | Standard approach, no external IdP needed |
| Default auth | Simple auth is default until Plex/Authentik configured | Works out of box, zero dependencies |
| Docker compose | Minimal: WebServarr + Redis only | Low barrier to entry; Authentik is optional add-on doc |
| Configuration | Zero-config: auto-generate secrets, everything in Settings UI | *arr app philosophy — `docker compose up` and go |
| Env vars | Optional overrides only, never required | Advanced/CI/K8s users can still use them |
| License | MIT | Most permissive, standard for ecosystem |
| Security hardening | Deferred to Phase 8 | Keep this phase focused on rebrand + auth + cleanup |

## Auth Architecture

### Three auth methods (all configurable via Settings UI)

1. **Simple auth** (default) — username/password against SQLite User table
   - Always available out of the box
   - Default credentials: admin / admin123
   - Disabling shows safety warning: "You will lose access if Plex/Authentik is misconfigured"

2. **Direct Plex OAuth** — available when Plex integration is configured
   - PIN-based flow (same as Overseerr, Tautulli)
   - Backend: POST `plex.tv/api/v2/pins` → user signs in → poll for `authToken`
   - Admin check: compare email to Plex server owner (existing `_is_plex_server_owner()` logic)
   - Stores plex_token in session for Overseerr SSO
   - Login page shows "Sign in with Plex" button when configured

3. **Authentik OIDC** — available when Authentik integration is configured in Settings
   - Settings: URL, client ID, client secret, app slug
   - New "Authentik" accordion in Settings > Integrations
   - Login page shows "Sign in with Plex (via Authentik)" button when configured
   - Existing OIDC flow preserved

### Auth flow at startup

```
App starts
  → Simple auth: always enabled (default)
  → Check Plex integration settings configured?
      Yes → enable "Sign in with Plex" on login page
  → Check Authentik integration settings configured?
      Yes → enable "Sign in via Authentik" on login page
```

### Login page button visibility

- Simple auth form: always visible unless `features.show_simple_auth` = false
- "Sign in with Plex" button: visible when `integration.plex.url` + `integration.plex.token` are set
- "Sign in via Authentik" button: visible when Authentik settings are configured
- Disable-simple-auth warning: modal confirmation when toggling off

## Rebrand Scope

### Python defaults

| File | Change |
|------|--------|
| `config.py` | `app_name` → `"WebServarr"`, `app_domain` → `"localhost"`, `session_cookie_name` → `"webservarr_session"` |
| `config.py` | Remove hardcoded Authentik slug; read from settings |
| `seed.py` | Admin email → `"admin@localhost"`, branding → `"WebServarr"` / `"Media Server Management"` |
| `push.py` | VAPID contact → read from `system.admin_email` setting |
| `admin.py` | Container name → read from env var `CONTAINER_NAME` (default: `"webservarr"`) |

### Docker

| File | Change |
|------|--------|
| `docker-compose.yml` | Minimal: `webservarr` + `redis` only. No Authentik containers. |
| `docker-compose.yml` | Service/container name → `webservarr` |
| `docker-compose.yml` | Remove all `hmserver.tv` domain references |
| `Dockerfile` | No changes expected |
| New: `docker-compose.authentik.yml` | Optional reference for Authentik setup |

### Frontend

| File | Change |
|------|--------|
| All HTML `<title>` tags | Dynamic from branding API (already loaded per page) |
| `login.html` | Remove 12 Google CDN `lh3.googleusercontent.com` image URLs; use dark gradient fallback |
| `sw.js` | Fallback push notification title → read from branding |
| `settings.html` | Reset defaults → `"WebServarr"`, test notification body → generic |
| `settings.html` | New Authentik accordion in Integrations tab |

### Auto-generated on first startup

| Value | Storage | Notes |
|-------|---------|-------|
| `SECRET_KEY` | Settings table | Used for session signing. Auto-generated if missing. |
| VAPID keys | Settings table | Already auto-generated (existing behavior) |

### Settings moved from env vars to Settings UI

| Current env var | New setting key | Location in Settings UI |
|-----------------|----------------|------------------------|
| `AUTHENTIK_URL` | `integration.authentik.url` | Integrations > Authentik |
| `OIDC_CLIENT_ID` | `integration.authentik.client_id` | Integrations > Authentik |
| `OIDC_CLIENT_SECRET` | `integration.authentik.client_secret` | Integrations > Authentik |
| N/A (hardcoded) | `integration.authentik.app_slug` | Integrations > Authentik |

Env vars remain as optional overrides for all settings (advanced users, CI, Kubernetes).

## Cleanup

### Remove

- 12 Google CDN image URLs in `login.html` (replace with CSS gradient fallback)
- All `hmserver.tv` / `dev.hmserver.tv` references in source code
- VPS-specific comments ("2GB VPS") in compose
- Authentik containers from main compose file

### Replace

- "HMS Dashboard" → "WebServarr" in all user-facing defaults
- "Home Media Server Management" → "Media Server Management"
- `admin@hmserver.tv` → `admin@localhost`
- `hms_session` → `webservarr_session`
- `hms-dashboard` container name → `webservarr`

## Documentation

| File | Action |
|------|--------|
| `README.md` | Rewrite for public GitHub: project description, screenshots, quick start, configuration reference |
| `LICENSE` | New file, MIT license |
| `VISION.md` | Update phase names, mark 2-4 as complete, add phases 7-8 |
| `CLAUDE.md` | Update for WebServarr naming and new auth architecture |
| `docs/app-contract.md` | Add Plex OAuth endpoints, Authentik settings, update auth docs |
| `docs/setup.md` | Rewrite as user-facing installation guide |

## Docker-Compose (shipped)

```yaml
services:
  webservarr:
    build: .
    container_name: webservarr
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
    restart: unless-stopped
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    container_name: webservarr-redis
    restart: unless-stopped
    volumes:
      - redis_data:/data

volumes:
  redis_data:
```

## First-Run Experience

1. `docker compose up -d`
2. Visit `http://localhost:8000`
3. Login with `admin` / `admin123`
4. Configure integrations in Settings (Plex, Overseerr, etc.)
5. Configure branding (name, logo, colors, font)
6. Plex login button appears once Plex is configured
7. Optionally configure Authentik for OIDC
8. Optionally disable simple auth (with safety warning)

## Phase 8: Security Hardening (future, not part of this phase)

- Rate limiting on login and public endpoints
- CSRF protection for form submissions
- CSP tuning and tightening
- Automated database backups
- Health check endpoints and monitoring
- Bot protection considerations
