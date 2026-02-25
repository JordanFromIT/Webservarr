# Authentik OIDC Restoration — Design

## Goal

Restore Authentik OIDC as the primary "Sign in with Plex" auth flow, replacing the native Plex PIN flow. This makes Authentik the central identity provider so future services (ticketing system, etc.) can SSO through it using the user's Plex identity.

## Architecture

**Plex (identity source) → Authentik (IdP/SSO hub) → HMS Dashboard + future services**

User clicks "Sign in with Plex" on login page → full-page redirect to Authentik → Authentik auto-redirects to Plex OAuth → user authenticates → redirect chain back to `/auth/callback` → session created → dashboard loads.

No popups. No JavaScript PIN creation. All full-page redirects.

## Auth Flow

1. User clicks "Sign in with Plex" on `login.html`
2. Browser navigates to `/auth/login`
3. Backend generates CSRF state, redirects to Authentik authorize URL (scope: `openid profile email plex`)
4. Authentik auto-redirects to Plex OAuth (flow configured in Authentik admin)
5. User authenticates with Plex
6. Plex redirects back to Authentik
7. Authentik redirects to `/auth/callback?code=...&state=...`
8. Backend exchanges code for tokens, gets userinfo (including `plex_token` from custom scope mapping)
9. Backend creates session (`auth_method: "oidc"`), sets cookie, `RedirectResponse(url="/")`

**Logout:** Session has `auth_method: "oidc"` → logout clears dashboard session + Authentik end-session + Overseerr `connect.sid`. Already implemented, no changes needed.

**Simple auth:** Username/password form stays as admin fallback. No changes.

## Code Changes

### `app/routers/auth.py` — OIDC callback
- Remove popup/postMessage HTML response
- Replace with `RedirectResponse(url="/", status_code=302)` with session cookie

### `app/static/login.html` — Plex button
- Replace Plex PIN JavaScript with simple redirect: `window.location.href = '/auth/login'`
- Button label stays "Sign in with Plex"

### `app/main.py` — CSP headers
- Remove `https://plex.tv` from `connect-src` (browser no longer calls plex.tv directly)

### No changes needed
- `app/auth.py` — OIDCClient already correct
- `app/routers/simple_auth.py` — logout already handles OIDC sessions
- `app/config.py` — Authentik URLs already configured
- `docker-compose.yml` — Authentik env vars already present
- Native Plex PIN endpoints — leave dormant in codebase

### Authentik admin task (manual)
- Configure HMS Dashboard authentication flow to auto-redirect to Plex source

## Testing Plan

1. Rebuild container
2. Navigate to login page, verify both buttons present
3. Click "Sign in with Plex" — verify redirect to Authentik → Plex
4. User authenticates with Plex (manual step)
5. Verify callback redirects to `/` (not popup close)
6. Verify session has `auth_method: "oidc"` and `plex_token`
7. Test logout clears both dashboard + Authentik sessions
8. Test simple auth still works
