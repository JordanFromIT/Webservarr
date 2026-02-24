# App Contract

Single source of truth for the HMS Dashboard application surface. If it's not in this file, don't assume it exists.

Last verified: 2026-02-24

---

## Pages

| Path | HTML File | Auth | Description |
|------|-----------|------|-------------|
| `/login` | `app/static/login.html` | None | Login form (simple auth + Plex OAuth). Branding from theme engine. |
| `/` | `app/static/index.html` | Session | Main dashboard. Plex streams (quality warnings, "More info" expander), service status, news. |
| `/settings` | `app/static/settings.html` | Session (admin) | Four tabs: Integrations (accordion with Plex/Kuma/Overseerr/Sonarr/Radarr/Netdata), System, Customization (icon picker, theme, sidebar labels), News. |
| `/requests` | `app/static/requests.html` | Session | Overseerr iframe embed with Plex SSO. Calls re-auth before loading iframe. |
| `/requests2` | `app/static/requests2.html` | Session | Native media request page. Search TMDB, create requests, view existing requests with poster grid and filter tabs. Alternative to iframe approach. |
| `/issues` | `app/static/issues.html` | Session | Report and view media issues (audio, video, subtitle). Per-user Plex auth for writes. |

**Auth pattern:** Page routes in `main.py` check the session cookie server-side and return a 302 redirect to `/login` if unauthenticated — the HTML is never sent. Each page's JS also calls `GET /auth/check-session` as a secondary check.

**Login methods:**
- **Plex native (primary):** "Sign in with Plex" button → browser creates PIN via `plex.tv/api/v2/pins` (user's IP) → `POST /auth/plex-start` stores PIN → full-page redirect to `app.plex.tv/auth` → user authenticates → Plex redirects to `/auth/plex-callback` → session created. No popups.
- **Plex OAuth via Authentik (legacy, still functional):** `GET /auth/login` → Authentik OIDC → Plex OAuth. Desktop uses popup (postMessage to close). Mobile uses full-page redirect. No longer used by default.
- **Simple auth (fallback):** Username/password form → `POST /auth/simple-login`.

**Admin determination:** First checks if user's email matches `system.admin_email` setting (if configured). Falls back to checking if email matches the Plex server owner's email (via `plex.tv/api/v2/user` with admin token from `integration.plex.token` setting).

**Session fields:** `user_id`, `email`, `name`, `username`, `is_admin`, `auth_method` (plex/oidc/simple), `id_token` (for OIDC logout), `plex_token` (for Overseerr SSO).

---

## Frontend Architecture

### Shared JS/CSS

All pages (except login) use a shared sidebar component and theme system:

| File | Purpose |
|------|---------|
| `app/static/js/theme-loader.js` | Fetches `/api/branding`, sets CSS custom properties (RGB triplets), injects Google Font, applies dark/light mode. Cached in localStorage to prevent FOUC. Loaded in `<head>` before Tailwind. |
| `app/static/js/auth.js` | `checkAuth()`, `wireLogout()`, `escapeHtml()`, `getTimeAgo()`, `formatUptime()`, `loadAppVersion()` |
| `app/static/js/sidebar.js` | `initSidebar(page)` — injects sidebar HTML into `<div id="sidebar-root">`. Desktop: persistent 256px sidebar. Mobile: hamburger drawer. `showAdminNav(isAdmin)` reveals admin-only items. Logo auto-sizes to sidebar width. |
| `app/static/css/theme.css` | CSS custom property defaults, glass-card styles, custom scrollbar. |

### Tailwind + CSS Custom Properties

Colors defined as RGB triplets via CSS custom properties for Tailwind alpha modifier support:
```
--color-primary: 18 87 147     →  "primary": "rgb(var(--color-primary) / <alpha-value>)"
```

### Responsive Layout

- **Desktop (≥1024px):** Persistent sidebar (left) + main content. Header visible.
- **Mobile (<1024px):** Sticky top bar with hamburger + slide-out drawer overlay. Header hidden.
- Body: `flex flex-col lg:flex-row`

---

## API Endpoints

### Simple Authentication (`app/routers/simple_auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/simple-login` | None | Login with username/password JSON body |
| POST | `/auth/simple-logout` | Session | Destroy session, clear cookie (JSON response) |
| GET | `/auth/logout` | Session | Destroy session + redirect. OIDC sessions also redirect through Authentik end-session. |
| GET | `/auth/check-session` | Session | Returns 200 if session valid, 401 if not |

### OIDC Authentication (`app/routers/auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/login` | None | Redirect to Authentik OIDC authorization (legacy) |
| GET | `/auth/callback` | None | OIDC callback — exchanges code, checks Plex server owner for admin, creates session (legacy) |
| POST | `/auth/plex-start` | None | Store client-created Plex PIN in Redis, return callback URL |
| GET | `/auth/plex-callback` | None | Plex PIN callback — checks PIN for auth token, gets user info, creates session, redirects to dashboard |
| GET | `/auth/me` | Session | Returns current user info (works for all auth methods) |

### Branding (`app/routers/branding.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/branding` | None | Returns theme/branding settings (colors, font, app name, etc.) |

**Response shape:**
```json
{
  "app_name": "HMS Dashboard",
  "tagline": "Home Media Server Management",
  "logo_url": "",
  "colors": { "primary": "#125793", "secondary": "#2C6DA1", "accent": "#4684B0", "text": "#BEEEF4", "background": "#000000" },
  "font": "Spline Sans",
  "custom_css": "",
  "features": { "show_requests": false },
  "sidebar_labels": { "home": "Home", "requests": "Requests", "requests2": "Requests", "issues": "Issues", "settings": "Settings" },
  "icons": { "sidebar_logo": "dashboard", "nav_home": "home", "nav_requests": "download", "nav_requests2": "movie", "nav_issues": "report_problem", "nav_settings": "settings", "section_streams": "play_circle", "section_services": "health_metrics", "section_requests": "movie", "section_news": "newspaper" }
}
```

### News (`app/routers/news.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/news/` | Session | List published news posts |
| GET | `/api/news/{id}` | Session | Get single post |
| POST | `/api/news/` | Admin | Create post (HTML sanitized by bleach) |
| PUT | `/api/news/{id}` | Admin | Update post |
| DELETE | `/api/news/{id}` | Admin | Delete post |

### Status (`app/routers/status.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/status/updates` | None | List active status updates |
| POST | `/api/status/updates` | Admin | Create status update |
| PUT | `/api/status/updates/{id}/resolve` | Admin | Resolve status update |

### Admin (`app/routers/admin.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| PUT | `/api/admin/monitors/{id}` | Admin | Update monitor preferences (enabled, icon) |
| GET | `/api/admin/settings` | Admin | List all settings |
| GET | `/api/admin/settings/{key}` | Admin | Get single setting |
| PUT | `/api/admin/settings` | Admin | Update single setting |
| PUT | `/api/admin/settings/bulk` | Admin | Update multiple settings |
| POST | `/api/admin/upload-logo` | Admin | Upload logo image (PNG, JPEG, GIF, SVG, WebP; 2MB max). Saves to `/static/uploads/` and updates `branding.logo_url` setting. |
| POST | `/api/admin/test-connection` | Admin | Test integration credentials |
| POST | `/api/admin/restart-container` | Admin | Restart hms-dashboard container via Docker API |
| POST | `/api/admin/shutdown-container` | Admin | Stop hms-dashboard container via Docker API |

### Integrations (`app/routers/integrations.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/integrations/active-streams` | Session | Active Plex streams (source/stream quality, pixel heights, thumbnails via proxy) |
| GET | `/api/integrations/plex/thumb` | Session | Proxy Plex thumbnail images (avoids mixed-content) |
| GET | `/api/integrations/monitors` | Session | All Uptime Kuma monitors with preferences |
| GET | `/api/integrations/service-status` | Session | Enabled monitors only (for homepage) |
| GET | `/api/integrations/recent-requests` | Session | Recent Overseerr requests |
| GET | `/api/integrations/request-counts` | Session | Overseerr request count summary |
| GET | `/api/integrations/overseerr-url` | Session | Configured Overseerr URL for iframe embedding |
| POST | `/api/integrations/overseerr-auth` | Session | Re-authenticate with Overseerr using stored Plex token (sets connect.sid cookie) |
| GET | `/api/integrations/overseerr-search` | Session | Search TMDB via Overseerr proxy (query, page params) |
| POST | `/api/integrations/overseerr-request` | Session | Create media request in Overseerr (mediaType, mediaId body) |
| GET | `/api/integrations/issues` | Session | List Overseerr issues with media details (take, skip, sort params) |
| GET | `/api/integrations/issue-counts` | Session | Overseerr issue count statistics |
| GET | `/api/integrations/issues/{id}` | Session | Single issue with comments |
| POST | `/api/integrations/issues` | Session | Create issue (per-user Plex auth). Body: issueType (1-4), message, mediaId |
| POST | `/api/integrations/issues/{id}/comment` | Session | Add comment to issue (per-user Plex auth). Body: message |
| GET | `/api/integrations/upcoming-releases` | Session | Upcoming TV/movie releases from Sonarr/Radarr (days param) |

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Container health check |

### Inactive (scaffolded, not wired)

*None currently — all scaffolded endpoints have been activated.*

---

## Configuration (`app/config.py`)

### Domain / URL Settings

| Env Var | Default | Description |
|---------|---------|-------------|
| `APP_DOMAIN` | `dev.hmserver.tv` | Application domain |
| `APP_SCHEME` | `https` | URL scheme |
| `CORS_ORIGINS` | `""` | Additional CORS origins (comma-separated) |
| `CSP_FRAME_SRC` | `""` | Additional frame-src CSP origins (comma-separated) |
| `CSP_CONNECT_SRC` | `""` | Additional connect-src CSP origins (comma-separated) |

CORS origins and CSP directives are built dynamically from these settings plus `app_url` and `authentik_url`.

### Theme/Branding Settings (DB)

Stored in `settings` table, seeded on first startup:

| Key | Default | Description |
|-----|---------|-------------|
| `branding.app_name` | `HMS Dashboard` | App name shown in sidebar and login |
| `branding.tagline` | `Home Media Server Management` | Shown on login page |
| `branding.logo_url` | `""` | Custom logo URL (or path from upload) |
| `theme.color_primary` | `#125793` | Primary color (Baltic Blue) |
| `theme.color_secondary` | `#2C6DA1` | Secondary color (Cornflower Ocean) |
| `theme.color_accent` | `#4684B0` | Accent color (Steel Blue) |
| `theme.color_text` | `#BEEEF4` | Text color (Frosted Blue) |
| `theme.color_background` | `#000000` | Background color |
| `theme.font` | `Spline Sans` | Google Font family (30 curated fonts in dropdown + custom entry) |
| `theme.custom_css` | `""` | Custom CSS injected on all pages |
| `features.show_requests` | `false` | Show Overseerr iframe Requests page in sidebar |
| `sidebar.label_home` | `Home` | Sidebar label for Home page |
| `sidebar.label_requests` | `Requests` | Sidebar label for Requests iframe page |
| `sidebar.label_requests2` | `Requests` | Sidebar label for native Requests page |
| `sidebar.label_issues` | `Issues` | Sidebar label for Issues page |
| `sidebar.label_settings` | `Settings` | Sidebar label for Settings page |
| `icon.sidebar_logo` | `dashboard` | Material Symbol for sidebar logo (when no logo image) |
| `icon.nav_home` | `home` | Material Symbol for Home nav item |
| `icon.nav_requests` | `download` | Material Symbol for Requests iframe nav item |
| `icon.nav_requests2` | `movie` | Material Symbol for native Requests nav item |
| `icon.nav_issues` | `report_problem` | Material Symbol for Issues nav item |
| `icon.nav_settings` | `settings` | Material Symbol for Settings nav item |
| `icon.section_streams` | `play_circle` | Material Symbol for Active Streams section |
| `icon.section_services` | `health_metrics` | Material Symbol for Service Health section |
| `icon.section_requests` | `movie` | Material Symbol for Recent Requests section |
| `icon.section_news` | `newspaper` | Material Symbol for Latest News section |
| `system.admin_email` | `""` | Admin email (priority check for Plex admin determination) |

---

## Database Models (`app/models.py`)

| Model | Table | Key Fields |
|-------|-------|------------|
| User | users | id, username, email, display_name, password_hash, is_admin, is_active, created_at, last_login |
| NewsPost | news_posts | id, title, content, content_html, author, published, pinned, created_at, updated_at |
| Service | services | id, name, display_name, description, url, icon, status, enabled, requires_auth, created_at |
| Setting | settings | id, key, value, created_at, updated_at |
| StatusUpdate | status_updates | id, service_id, status, message, created_at, resolved_at |
| ServiceStatus | service_statuses | id, service_id, status, checked_at |

Storage: SQLite at `/app/data/hms.db` (container path) / `data/hms.db` (host path).

---

## Integration Clients (`app/integrations/`)

| Client | File | Status | What it does |
|--------|------|--------|-------------|
| Plex | `plex.py` | Working | XML API parsing, active streams with source/stream quality detection + pixel heights, thumbnail proxy |
| Uptime Kuma | `uptime_kuma.py` | Working | Public status page API, service health monitors |
| Overseerr | `overseerr.py` | Working | Recent requests, request counts, TMDB search, media request creation, Plex token SSO authentication, issue management (list, detail, create, comment) with per-user Plex token authentication for writes |
| Sonarr | `sonarr.py` | Exists | Client code present, not fully wired to dashboard |
| Radarr | `radarr.py` | Exists | Client code present, not fully wired to dashboard |
| Netdata | `netdata.py` | Exists | Client code present, not fully wired to dashboard |

**Pattern:** Browser → FastAPI proxy endpoint → external service API (httpx, 10s timeout for Plex, 5s for others). Credentials stored in `settings` table.

---

## Dashboard Sections (index.html)

| Section | Data Source | Status |
|---------|------------|--------|
| Active Streams | Plex API via `/api/integrations/active-streams` | Working |
| Service Health | Uptime Kuma via `/api/integrations/service-status` (enabled monitors only, compact single-line rows) | Working |
| Recent Requests | Overseerr via `/api/integrations/recent-requests` | Working |
| News | Local DB via `/api/news/` | Working |
| Upcoming Releases | Hardcoded placeholder | **Not wired to real data** |
| Server Load / footer stats | Hardcoded placeholder | **Not wired to real data** |

Auto-refresh: all sections poll every 30 seconds.

## Requests Page Sections (requests2.html)

| Section | Data Source | Status |
|---------|------------|--------|
| Search | Overseerr via `/api/integrations/overseerr-search` | Working |
| Request Creation | Overseerr via `/api/integrations/overseerr-request` | Working |
| Existing Requests | Overseerr via `/api/integrations/recent-requests` | Working |
| Request Stats | Overseerr via `/api/integrations/request-counts` | Working |

## Issues Page Sections (issues.html)

| Section | Data Source | Status |
|---------|------------|--------|
| Issue Stats | Overseerr via `/api/integrations/issue-counts` | Working |
| Report Issue (search) | Overseerr via `/api/integrations/overseerr-search` | Working |
| Report Issue (create) | Overseerr via `/api/integrations/issues` | Working |
| Issues List | Overseerr via `/api/integrations/issues` | Working |
| Issue Detail + Comments | Overseerr via `/api/integrations/issues/{id}` | Working |

### Active Streams UI

Stream cards show title (with year for movies, S##E## for TV), thumbnail via backend proxy, and progress bar.

**Quality indicators:**
- **Direct Play / Direct Stream:** Green text — "Direct Play (Full Quality)" or "Direct Stream (Full Quality)"
- **Transcode:** Yellow warning — "Warning: Not playing at full quality!" with expandable "More info" section showing source vs stream pixel heights and instructions to set Plex quality to "Original"
- Polling uses `_lastStreams` cache to prevent UI flicker on transient API failures
- No usernames displayed (privacy), no admin controls (kill stream, scan, etc.)

---

## Security

**Implemented:**
- Server-side page auth: all page routes (except `/login`) check session cookie in `main.py` and 302 redirect to `/login` if unauthenticated — no HTML is served to anonymous users
- Secure cookies (HttpOnly, Secure, SameSite=Lax)
- HTML sanitization (bleach) on news content
- Security headers middleware (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- CSP directives built dynamically from config (no hardcoded domains)
- API keys/tokens masked in settings responses
- Admin role enforcement on all write endpoints
- httpx 5-second timeout on external API calls
- CSP connect-src includes `https://plex.tv` for client-side PIN creation
- Overseerr SSO: Plex token stored server-side in Redis, never exposed to frontend. `connect.sid` cookie set on `.hmserver.tv` with `SameSite=None; Secure; HttpOnly` for cross-subdomain iframe SSO. Cleared on logout.

**Not implemented:**
- CSRF tokens
- Rate limiting
- Bot protection (Cloudflare Turnstile)
- HSTS (would be at Cloudflare level)

---

## Auth Dependencies (`app/dependencies.py`)

| Dependency | What it checks | Used by |
|------------|---------------|---------|
| `get_current_user` | Valid session cookie → Redis lookup → returns user dict | All protected endpoints |
| `get_current_user_optional` | Same as above but returns None instead of 401 | Endpoints with optional auth |
| `require_admin` | Calls get_current_user + checks is_admin flag | All write/admin endpoints |
