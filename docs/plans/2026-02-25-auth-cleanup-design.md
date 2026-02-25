# Auth Cleanup — Design

## Goal

Remove dormant native Plex PIN auth code and make simple (username/password) authentication toggleable via a settings flag, so open-source admins can bootstrap instances before configuring Plex/Authentik.

## Architecture

Two changes to the auth system:

1. **Remove Plex PIN code.** The `/auth/plex-start` and `/auth/plex-callback` endpoints, the `PlexStartRequest` model, the `PLEX_CLIENT_ID`/`PLEX_PRODUCT` constants, and the `store_plex_pin`/`get_plex_pin` session manager methods are all dead code since the login page now redirects to `/auth/login` (Authentik OIDC). Delete them.

2. **Toggleable simple auth.** New setting `features.show_simple_auth` (default: `true`). When disabled:
   - Login page hides the username/password form and "OR CONTINUE WITH" divider, showing only "Sign in with Plex"
   - Backend `/auth/simple-login` rejects requests with 403 (defense in depth)

## Data Flow

Login page loads → `theme-loader.js` fetches `/api/branding` → response includes `features.show_simple_auth` → login page conditionally shows/hides the form.

Admin toggles setting in Settings > Customization → saved to `settings` table → next login page load picks it up.

POST to `/auth/simple-login` → endpoint reads `features.show_simple_auth` from DB → if `"false"`, returns 403 before checking credentials.

## Files Changed

### Remove Plex PIN
- `app/routers/auth.py` — delete `PlexStartRequest`, `/auth/plex-start`, `/auth/plex-callback`, `PLEX_CLIENT_ID`, `PLEX_PRODUCT`
- `app/auth.py` — delete `store_plex_pin()`, `get_plex_pin()` from SessionManager

### Toggleable simple auth
- `app/seed.py` — add `features.show_simple_auth` default
- `app/routers/branding.py` — expose in `features` dict and `DEFAULTS`
- `app/routers/simple_auth.py` — guard `/auth/simple-login` with setting check
- `app/static/login.html` — conditionally hide form based on `HMS_THEME.features`
- `app/static/settings.html` — add toggle in Customization tab

## Not Changed

- `_is_plex_server_owner()` — still needed for OIDC admin determination
- `/auth/login`, `/auth/callback`, `/auth/me` — still needed for OIDC
- Logout logic in `simple_auth.py` — still handles both OIDC and simple sessions
- `docs/app-contract.md` — update after implementation
