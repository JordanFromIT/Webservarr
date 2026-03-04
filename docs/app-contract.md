# App Contract

Single source of truth for the WebServarr application surface. If it's not in this file, don't assume it exists.

Last verified: 2026-02-27

---

## Pages

| Path | HTML File | Auth | Description |
|------|-----------|------|-------------|
| `/login` | `app/static/login.html` | None | Login page with three auth methods: simple (username/password), direct Plex OAuth, and Authentik OIDC. Branding from theme engine. Rotating TMDB backdrop slideshow (via Overseerr `/api/v1/backdrops`). Falls back to static poster grid. |
| `/` | `app/static/index.html` | Session | Main dashboard. Plex streams (quality warnings, "More info" expander), service status, Netdata gauges, upcoming releases, news. |
| `/settings` | `app/static/settings.html` | Session (admin) | Four tabs: Integrations (accordion with Plex/Kuma/Overseerr/Sonarr/Radarr/Netdata), System (Authentication toggles for simple/Plex/Authentik with inline Authentik config), Customization (icon picker, theme, sidebar labels, feature flags), News. |
| `/requests` | `app/static/requests.html` | Session | Native media request page. Search TMDB, create requests, view existing requests with poster grid and filter tabs. |
| `/requests-embed` | `app/static/requests-embed.html` | Session | Overseerr iframe embed with Plex SSO. Calls re-auth before loading iframe. |
| `/requests2` | *(301 redirect to `/requests`)* | None | Legacy redirect for old bookmarks. |
| `/issues` | `app/static/issues.html` | Session | Report and view media issues (audio, video, subtitle). Per-user Plex auth for writes. |
| `/calendar` | `app/static/calendar.html` | Session | Combined Radarr + Sonarr month calendar. Click day for release details. Month navigation. |
| `/tickets` | `app/static/tickets.html` | Session | User support tickets. Submit new tickets (multipart with optional image), view own + public tickets, admin management panel. |

All authenticated pages include a notification bell in the top bar that shows unread count and opens a dropdown panel for viewing/managing notifications.

**Auth pattern:** Page routes in `main.py` check the session cookie server-side and return a 302 redirect to `/login` if unauthenticated -- the HTML is never sent. Each page's JS also calls `GET /auth/check-session` as a secondary check.

**Login methods:**

1. **Simple auth (default, toggleable):** Username/password form -> `POST /auth/simple-login`. Controlled by `features.show_simple_auth` setting (default: `true`). When disabled: login page hides the form, and the backend rejects requests with 403 (defense in depth). Intended for bootstrapping instances before Plex is configured.

2. **Direct Plex OAuth (recommended):** "Sign in with Plex" button -> `POST /auth/plex-start` (creates PIN, returns auth URL) -> user redirected to `app.plex.tv/auth` -> redirect back to `/auth/plex-callback-page` -> `POST /auth/plex-callback` (exchanges PIN for token, creates session with `auth_method: "plex"`). Same PIN-based flow used by Overseerr and Tautulli. Requires Plex integration to be configured.

3. **Authentik OIDC (advanced):** "Sign in with Plex" (via Authentik) button -> `GET /auth/login` -> Authentik OIDC authorization -> Plex OAuth -> `GET /auth/callback` (exchanges code, creates session with `auth_method: "oidc"`). Requires Authentik to be configured in Settings > Integrations > Authentik.

**Admin determination:** First checks if user's email matches `system.admin_email` setting (if configured). Falls back to checking if email matches the Plex server owner's email (via `plex.tv/api/v2/user` with admin token from `integration.plex.token` setting).

**Session fields:** `user_id`, `email`, `name`, `username`, `is_admin`, `auth_method` (simple/plex/oidc), `id_token` (for OIDC logout), `plex_token` (for Overseerr SSO), `avatar_url`.

---

## Frontend Architecture

### Shared JS/CSS

All pages (except login) use a shared sidebar component and theme system:

| File | Purpose |
|------|---------|
| `app/static/js/theme-loader.js` | Fetches `/api/branding`, sets CSS custom properties (RGB triplets), injects Google Font, applies dark/light mode. Cached in localStorage to prevent FOUC. Loaded in `<head>` before Tailwind. Stores branding data as `window.WEBSERVARR_THEME` for other scripts. |
| `app/static/js/auth.js` | `checkAuth()`, `wireLogout()`, `escapeHtml()`, `getTimeAgo()`, `formatUptime()`, `loadAppVersion()` |
| `app/static/js/sidebar.js` | `initSidebar(page)` -- injects sidebar HTML into `<div id="sidebar-root">`. Desktop: persistent 256px sidebar with logo + nav. Mobile: hamburger drawer. `showAdminNav(isAdmin)` reveals admin-only items. Logo auto-sizes to sidebar width. |
| `app/static/css/theme.css` | CSS custom property defaults, glass-card styles, custom scrollbar, gauge-circle animation, service-icon drop-shadow. |

### Tailwind + CSS Custom Properties

Colors defined as RGB triplets via CSS custom properties for Tailwind alpha modifier support:
```
--color-primary: 18 87 147     ->  "primary": "rgb(var(--color-primary) / <alpha-value>)"
```

### Responsive Layout

- **Desktop (>=1024px):** Persistent sidebar (left) + main content. Header visible.
- **Mobile (<1024px):** Sticky top bar with hamburger + slide-out drawer overlay. Header hidden.
- Body: `flex flex-col lg:flex-row`

---

## API Endpoints

### Simple Authentication (`app/routers/simple_auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/simple-login` | None | Login with username/password JSON body. Returns 403 if `features.show_simple_auth` is `"false"`. |
| POST | `/auth/simple-logout` | Session | Destroy session, clear cookie (JSON response) |
| GET | `/auth/logout` | Session | Destroy session + redirect. OIDC sessions also redirect through Authentik end-session. |
| GET | `/auth/check-session` | Session | Returns 200 if session valid, 401 if not |

### Direct Plex OAuth (`app/routers/plex_auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/plex-start` | None | Initiate Plex PIN-based auth. Returns `pin_id` and `auth_url`. Requires Plex integration configured. |
| POST | `/auth/plex-callback` | None | Complete Plex PIN auth. Body: `{"pin_id": int}`. Exchanges PIN for token, creates session. |
| GET | `/auth/plex-callback-page` | None | Landing page after Plex redirect. Sends postMessage to opener (popup) or redirects to login (full-page). |

### OIDC Authentication (`app/routers/auth.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/login` | None | Redirect to Authentik OIDC authorization. Uses DB settings or env var config. |
| GET | `/auth/callback` | None | OIDC callback -- exchanges code, checks Plex server owner for admin, creates session |
| GET | `/auth/me` | Session | Returns current user info (works for all auth methods) |

### Branding (`app/routers/branding.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/branding` | None | Returns theme/branding settings (colors, font, app name, etc.) |

**Response shape:**
```json
{
  "app_name": "WebServarr",
  "tagline": "Media Server Management",
  "logo_url": "",
  "colors": { "primary": "#125793", "secondary": "#2C6DA1", "accent": "#4684B0", "text": "#BEEEF4", "background": "#000000" },
  "font": "Spline Sans",
  "custom_css": "",
  "features": { "show_requests": false, "show_simple_auth": true, "show_plex_auth": true, "show_authentik_auth": false, "login_backgrounds": true, "show_tickets": true },
  "auth_methods": { "simple": true, "plex": true, "authentik": false },
  "sidebar_labels": { "home": "Home", "requests": "Requests", "requests-embed": "Requests (Embed)", "issues": "Issues", "calendar": "Calendar", "settings": "Settings" },
  "icons": { "sidebar_logo": "settings_input_component", "nav_home": "home", "nav_requests": "movie", "nav_requests-embed": "download", "nav_issues": "report_problem", "nav_calendar": "calendar_month", "nav_settings": "settings", "section_streams": "play_circle", "section_services": "health_metrics", "section_releases": "calendar_month", "section_requests": "shopping_cart", "section_news": "newspaper" },
  "vapid_public_key": "..."
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
| POST | `/api/admin/restart-container` | Admin | Restart webservarr container via Docker API |
| POST | `/api/admin/shutdown-container` | Admin | Stop webservarr container via Docker API |

### Notifications (`app/routers/notifications.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/notifications` | Session | List user's notifications (paginated) |
| GET | `/api/notifications/unread-count` | Session | Unread notification count |
| PUT | `/api/notifications/{id}/read` | Session | Mark notification as read |
| PUT | `/api/notifications/read-all` | Session | Mark all notifications as read |
| DELETE | `/api/notifications/{id}` | Session | Delete a notification |
| GET | `/api/notifications/preferences` | Session | Get per-category toggles |
| PUT | `/api/notifications/preferences` | Session | Update per-category toggles |
| POST | `/api/notifications/push-subscribe` | Session | Register push subscription |
| DELETE | `/api/notifications/push-subscribe` | Session | Remove push subscriptions |
| POST | `/api/admin/notifications/send` | Admin | Send notification to all users |

### Tickets (`app/routers/tickets.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/tickets` | Session | List user's tickets + public tickets (filters: status, category, limit, offset) |
| POST | `/api/tickets` | Session | Create a new ticket (multipart: title, description, category, optional image) |
| GET | `/api/tickets/counts` | Session | Ticket counts by status (open, in_progress, resolved, closed, total) |
| GET | `/api/tickets/{id}` | Session | Ticket detail with comments. Accessible if own ticket, public, or admin. |
| POST | `/api/tickets/{id}/comments` | Session | Add comment to ticket (multipart: message, optional image). Only creator or admin. |
| GET | `/api/admin/tickets` | Admin | List all tickets with filters (status, category, priority, creator) |
| PUT | `/api/admin/tickets/{id}` | Admin | Update ticket status, priority, or visibility (JSON body) |
| DELETE | `/api/admin/tickets/{id}` | Admin | Delete ticket + all comments + associated images |
| GET | `/api/uploads/tickets/{filename}` | Session | Serve ticket image with auth check (admin=all, non-admin=own+public) |

All ticket endpoints respect the `features.show_tickets` setting -- returns 403 when disabled.

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
| GET | `/api/integrations/backgrounds` | None | TMDB trending backdrop URLs for login page (via Overseerr). Empty list if disabled or unavailable. |
| GET | `/api/integrations/upcoming-releases` | Session | Upcoming TV/movie releases from Sonarr/Radarr (days, start params) |

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Container health check |

### Inactive (scaffolded, not wired)

*None currently -- all scaffolded endpoints have been activated.*

---

## Configuration (`app/config.py`)

### Environment Variables

| Env Var | Default | Description |
|---------|---------|-------------|
| `APP_DOMAIN` | `localhost` | Application domain — used for CSP headers; auth URLs derived from HTTP request |
| `APP_SCHEME` | `https` | URL scheme — used for CSP headers; auth URLs derived from HTTP request |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection string |
| `CORS_ORIGINS` | `""` | Additional CORS origins (comma-separated) |
| `CSP_FRAME_SRC` | `""` | Additional frame-src CSP origins (comma-separated) |
| `CSP_CONNECT_SRC` | `""` | Additional connect-src CSP origins (comma-separated) |
| `AUTHENTIK_URL` | `""` | Authentik base URL (env var fallback; prefer Settings UI) |
| `AUTHENTIK_CLIENT_ID` | `""` | Authentik OAuth2 client ID (env var fallback) |
| `AUTHENTIK_CLIENT_SECRET` | `""` | Authentik OAuth2 client secret (env var fallback) |

CORS origins and CSP directives are built dynamically from these settings plus `app_url` and `authentik_url`.

### Theme/Branding Settings (DB)

Stored in `settings` table, seeded on first startup:

| Key | Default | Description |
|-----|---------|-------------|
| `branding.app_name` | `WebServarr` | App name shown in sidebar and login |
| `branding.tagline` | `Media Server Management` | Shown on login page |
| `branding.logo_url` | `""` | Custom logo URL (or path from upload) |
| `theme.color_primary` | `#125793` | Primary color (Baltic Blue) |
| `theme.color_secondary` | `#2C6DA1` | Secondary color (Cornflower Ocean) |
| `theme.color_accent` | `#4684B0` | Accent color (Steel Blue) |
| `theme.color_text` | `#BEEEF4` | Text color (Frosted Blue) |
| `theme.color_background` | `#000000` | Background color |
| `theme.font` | `Spline Sans` | Google Font family (30 curated fonts in dropdown + custom entry) |
| `theme.custom_css` | `""` | Custom CSS injected on all pages |
| `features.show_requests` | `false` | Show Overseerr iframe Requests (Embed) page in sidebar |
| `features.show_simple_auth` | `true` | Show username/password login form. When `"false"`, hides form and backend rejects `/auth/simple-login` with 403. |
| `features.show_plex_auth` | `true` | Show Plex OAuth login button. Default ON; requires Plex integration configured. |
| `features.show_authentik_auth` | `false` | Show Authentik OIDC login button. Default OFF; must be explicitly enabled and requires Authentik configured. |
| `features.login_backgrounds` | `true` | Show rotating TMDB backgrounds on login page (requires Overseerr) |
| `sidebar.label_home` | `Home` | Sidebar label for Home page |
| `sidebar.label_requests` | `Requests` | Sidebar label for Requests page |
| `sidebar.label_requests_embed` | `Requests (Embed)` | Sidebar label for Requests (Embed) page |
| `sidebar.label_issues` | `Issues` | Sidebar label for Issues page |
| `sidebar.label_calendar` | `Calendar` | Sidebar label for Calendar page |
| `sidebar.label_settings` | `Settings` | Sidebar label for Settings page |
| `icon.sidebar_logo` | `settings_input_component` | Material Symbol for sidebar logo (when no logo image) |
| `icon.nav_home` | `home` | Material Symbol for Home nav item |
| `icon.nav_requests` | `movie` | Material Symbol for Requests nav item |
| `icon.nav_requests_embed` | `download` | Material Symbol for Requests (Embed) nav item |
| `icon.nav_issues` | `report_problem` | Material Symbol for Issues nav item |
| `icon.nav_calendar` | `calendar_month` | Material Symbol for Calendar nav item |
| `icon.nav_settings` | `settings` | Material Symbol for Settings nav item |
| `icon.section_streams` | `play_circle` | Material Symbol for Active Streams section |
| `icon.section_services` | `health_metrics` | Material Symbol for Service Health section |
| `icon.section_releases` | `calendar_month` | Material Symbol for Upcoming Releases section |
| `icon.section_news` | `newspaper` | Material Symbol for Latest News section |
| `icon.section_requests` | `shopping_cart` | Material Symbol for Recent Requests section |
| `system.admin_email` | `""` | Admin email (priority check for Plex admin determination) |
| `system.secret_key` | (auto) | Auto-generated secret key for session signing |
| `system.plex_client_id` | (auto) | Auto-generated Plex client identifier for PIN-based auth |
| `netdata.cpu_label` | `""` | Label under CPU gauge (e.g., "16C/32T"). Falls back to thread count from API. |
| `netdata.ram_label` | `""` | Label under RAM gauge (e.g., "64 GB"). Auto-detects used/total if empty. |
| `netdata.net_label` | `""` | Label under Network gauge (e.g., "1 Gbps"). |

### Authentik Settings (DB)

Stored in `settings` table. Override environment variable values when non-empty. Configurable in Settings > Integrations > Authentik.

| Key | Default | Description |
|-----|---------|-------------|
| `integration.authentik.url` | `""` | Authentik base URL (e.g., `https://auth.example.com`) |
| `integration.authentik.client_id` | `""` | Authentik OAuth2 client ID |
| `integration.authentik.client_secret` | `""` | Authentik OAuth2 client secret |
| `integration.authentik.app_slug` | `""` | Authentik application slug (for logout URL) |

### Notification Settings (DB)

| Key | Default | Description |
|-----|---------|-------------|
| `notifications.poll_interval_overseerr` | `60` | Seconds between Overseerr checks |
| `notifications.poll_interval_monitors` | `60` | Seconds between Uptime Kuma checks |
| `notifications.poll_interval_news` | `60` | Seconds between news checks |
| `notifications.vapid_public_key` | (auto) | Web Push VAPID public key |
| `notifications.vapid_private_key` | (auto) | Web Push VAPID private key |
| `notify.{hash}.{category}` | `true` | Per-user notification preference |

---

## Database Models (`app/models.py`)

| Model | Table | Key Fields |
|-------|-------|------------|
| User | users | id, username, email, display_name, password_hash, is_admin, is_active, created_at, last_login |
| NewsPost | news_posts | id, title, content, content_html, author, published, pinned, created_at, updated_at |
| Service | services | id, name, display_name, description, url, icon, status, enabled, requires_auth, created_at |
| Setting | settings | id, key, value, description, created_at, updated_at |
| StatusUpdate | status_updates | id, service_id, status, message, created_at, resolved_at |
| ServiceStatus | service_statuses | id, service_id, status, checked_at |
| Notification | notifications | id, user_email, category, title, body, reference_id, read, created_at |
| PushSubscription | push_subscriptions | id, user_email, endpoint, p256dh, auth, created_at |
| Ticket | tickets | id, title, description, category, status, priority, is_public, creator_username, creator_name, image_path, created_at, updated_at |
| TicketComment | ticket_comments | id, ticket_id, author_username, author_name, is_admin, message, image_path, created_at |

### Notification

| Field | Type | Notes |
|-------|------|-------|
| id | Integer | PK, auto-increment |
| user_email | String(200) | Indexed |
| category | String(20) | request, issue, service, news |
| title | String(200) | |
| body | Text | Nullable |
| reference_id | String(100) | Nullable, for dedup |
| read | Boolean | Default false |
| created_at | DateTime | Auto-set |

### PushSubscription

| Field | Type | Notes |
|-------|------|-------|
| id | Integer | PK, auto-increment |
| user_email | String(200) | Indexed |
| endpoint | Text | Push service URL |
| p256dh | String(200) | Client key |
| auth | String(200) | Auth secret |
| created_at | DateTime | Auto-set |

### Ticket

| Field | Type | Notes |
|-------|------|-------|
| id | Integer | PK, auto-increment |
| title | String(200) | |
| description | Text | |
| category | String(50) | media_request, playback_issue, account_issue, feature_suggestion, other |
| status | String(20) | open, in_progress, resolved, closed (default: open) |
| priority | String(20) | Nullable. low, medium, high, urgent (admin-only) |
| is_public | Boolean | Default false |
| creator_username | String(100) | Indexed |
| creator_name | String(100) | |
| image_path | String(300) | Nullable. Path to uploaded image |
| created_at | DateTime | Auto-set |
| updated_at | DateTime | Auto-set, auto-updated |

### TicketComment

| Field | Type | Notes |
|-------|------|-------|
| id | Integer | PK, auto-increment |
| ticket_id | Integer | Indexed, references Ticket |
| author_username | String(100) | |
| author_name | String(100) | |
| is_admin | Boolean | Default false |
| message | Text | |
| image_path | String(300) | Nullable. Path to uploaded image |
| created_at | DateTime | Auto-set |

Storage: SQLite at `/app/data/webservarr.db` (container path) / `data/webservarr.db` (host path).

---

## Integration Clients (`app/integrations/`)

| Client | File | Status | What it does |
|--------|------|--------|-------------|
| Plex | `plex.py` | Working | XML API parsing, active streams with source/stream quality detection + pixel heights, thumbnail proxy |
| Uptime Kuma | `uptime_kuma.py` | Working | Public status page API, service health monitors |
| Overseerr | `overseerr.py` | Working | Recent requests, request counts, TMDB search, media request creation, Plex token SSO authentication, issue management (list, detail, create, comment) with per-user Plex token authentication for writes |
| Sonarr | `sonarr.py` | Working | Calendar API, upcoming episodes with series info and posters |
| Radarr | `radarr.py` | Working | Calendar API, upcoming movies with release types and posters |
| Netdata | `netdata.py` | Working | System stats (CPU%, RAM%, network throughput MB/s, uptime, hostname, cpu_cores, configurable gauge labels) via `/api/integrations/system-stats` |

**Pattern:** Browser -> FastAPI proxy endpoint -> external service API (httpx, 10s timeout for Plex, 5s for others). Credentials stored in `settings` table.

---

## Dashboard Sections (index.html)

| Section | Data Source | Status |
|---------|------------|--------|
| Active Streams | Plex API via `/api/integrations/active-streams` | Working |
| Service Health | Uptime Kuma via `/api/integrations/service-status` (auto-fit tile grid with selfh.st CDN icons, "Checked Xs ago" live timer updating every 1s) | Working |
| Netdata Gauges | Netdata via `/api/integrations/system-stats` (SVG circular gauges: CPU, RAM, Network with configurable sub-labels; polls every 1s) | Working |
| Recent Requests | Overseerr via `/api/integrations/recent-requests` | Working |
| News | Local DB via `/api/news/` | Working |
| Upcoming Releases | Sonarr/Radarr via `/api/integrations/upcoming-releases?days=7` | Working -- compact 7-day grouped list with "View calendar" link |

Auto-refresh: all sections poll every 30 seconds. Netdata gauges poll every 1 second for real-time monitoring. "Checked X ago" timer text updates every 1 second. Active Streams paginated at 6 per page with chevron navigation.

## Requests Page Sections (requests.html)

| Section | Data Source | Status |
|---------|------------|--------|
| Search | Overseerr via `/api/integrations/overseerr-search` (paginated 9 per page) | Working |
| Request Creation | Overseerr via `/api/integrations/overseerr-request` (single "Request" button) | Working |
| Existing Requests | Overseerr via `/api/integrations/recent-requests` (paginated 9 per page, filter tabs) | Working |
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
- **Direct Play / Direct Stream:** Green text -- "Direct Play (Full Quality)" or "Direct Stream (Full Quality)"
- **Transcode:** Yellow warning -- "Warning: Not playing at full quality!" with expandable "More info" section showing source vs stream pixel heights and instructions to set Plex quality to "Original"
- Polling uses `_lastStreams` cache to prevent UI flicker on transient API failures
- No usernames displayed (privacy), no admin controls (kill stream, scan, etc.)

---

## Security

**Implemented:**
- Server-side page auth: all page routes (except `/login`) check session cookie in `main.py` and 302 redirect to `/login` if unauthenticated -- no HTML is served to anonymous users
- Secure cookies (HttpOnly, Secure, SameSite=Lax)
- HTML sanitization (bleach) on news content
- Security headers middleware (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- CSP directives built dynamically from config (no hardcoded domains)
- API keys/tokens masked in settings responses
- Admin role enforcement on all write endpoints
- httpx 5-second timeout on external API calls
- Simple auth feature flag: `features.show_simple_auth` gates both UI (form hidden) and backend (403 on POST) for defense in depth
- Plex PIN anti-replay: PINs tracked in Redis with 5-minute TTL
- Auto-generated secret key and Plex client identifier (no manual secret setup required)

**Not implemented:**
- CSRF tokens
- Rate limiting
- Bot protection
- HSTS (typically set at reverse proxy level)

---

## Auth Dependencies (`app/dependencies.py`)

| Dependency | What it checks | Used by |
|------------|---------------|---------|
| `get_current_user` | Valid session cookie -> Redis lookup -> returns user dict | All protected endpoints |
| `get_current_user_optional` | Same as above but returns None instead of 401 | Endpoints with optional auth |
| `require_admin` | Calls get_current_user + checks is_admin flag | All write/admin endpoints |
