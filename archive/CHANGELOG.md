> Archived 2026-02-22. Historical version record. Active project phases are tracked in VISION.md. Kept for historical reference.

# Changelog

All notable changes to the HMS Dashboard project.

---

## [1.0] - 2026-02-14

### Phase 6: Live Dashboard Integrations

Connected the dashboard to external services for live data display.

**Plex integration (`app/integrations/plex.py`):**
- Added Plex API client that parses XML responses
- Dashboard shows active Plex streams (user, media title, playback progress)
- Admin action buttons: kill stream, scan libraries, empty trash
- All Plex API calls use httpx with 5-second timeout

**Uptime Kuma integration (`app/integrations/uptime_kuma.py`):**
- Added client for Uptime Kuma's public status page API
- Service health tiles on the dashboard pull live data from Uptime Kuma
- Falls back to local database status when Uptime Kuma is not configured or unreachable

**Overseerr integration (`app/integrations/overseerr.py`):**
- Added client for Overseerr's API
- Dashboard shows recent media requests
- Dashboard shows request count summary (pending, approved, available)

**Dashboard behavior:**
- All integration sections auto-refresh every 30 seconds
- Graceful empty states shown when an integration is not configured
- Integration router added at `app/routers/integrations.py` with proxy endpoints

### Phase 5: Integration Configuration

Added the Integrations tab to the settings page.

- Configuration forms for Plex (URL + token), Uptime Kuma (status page URL), and Overseerr (URL + API key)
- Credentials stored in the settings table as key-value pairs
- Test connection button on each integration that makes a real API call to validate credentials
- API keys and tokens masked in the UI after saving (only last few characters visible)
- Bulk settings save endpoint: `PUT /api/admin/settings/bulk`
- Test connection endpoint: `POST /api/admin/test-connection`

### Phase 4: Rich Text Editor and News Improvements

Replaced the markdown-based news editor with a custom rich text editor.

- Built on contentEditable with `document.execCommand` (no external libraries)
- Toolbar: bold, italic, underline, strikethrough, headings (H1-H3), ordered list, unordered list, link insertion
- Keyboard shortcuts: Ctrl+B (bold), Ctrl+I (italic), Ctrl+U (underline)
- Preview mode to toggle between editing and rendered output
- HTML content stored in database, sanitized server-side with bleach
- Switched news content pipeline from markdown rendering to direct HTML with sanitization

### Phase 3: Authentication and Route Protection

Replaced the temporary mock authentication with a real database-backed system.

- Added User model to `app/models.py` with bcrypt password hashing (via passlib)
- Added `app/seed.py` to create default admin user on first startup (admin/admin123)
- Login endpoint (`POST /auth/simple-login`) validates credentials against the User table
- Session creation in Redis with secure cookie (HttpOnly, Secure, SameSite=Lax)
- Logout endpoint clears session from Redis and removes cookie
- Session check endpoint (`GET /auth/check-session`) for frontend validation
- `get_current_user` dependency validates session on every protected request
- `require_admin` dependency enforces admin role on all write endpoints
- All pages redirect to `/login` if not authenticated
- Removed `get_mock_admin` dependency; all admin endpoints now use `require_admin`

### Phase 2: Core Application and CRUD

Built the FastAPI application with core CRUD functionality.

**Application structure:**
- `app/main.py` - FastAPI app with security headers middleware and router registration
- `app/database.py` - SQLAlchemy engine, session factory, `init_db`
- `app/models.py` - NewsPost, Service, Setting, StatusUpdate, ServiceStatus models
- `app/config.py` - Environment-based configuration
- `app/dependencies.py` - Authentication dependency functions

**Routers:**
- `app/routers/news.py` - News CRUD with HTML sanitization via bleach
- `app/routers/admin.py` - Service CRUD, settings management
- `app/routers/status.py` - Public service status endpoints
- `app/routers/simple_auth.py` - Login and logout endpoints

**Frontend:**
- `app/static/index.html` - Dashboard with dynamic service status and news feed
- `app/static/admin.html` - Admin panel for news management
- `app/static/settings.html` - Settings page with Services tab
- `app/static/login.html` - Login form

**Security:**
- Security headers middleware (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
- HTML sanitization with bleach for news content
- Secure session cookies

---

## [0.2] - 2026-02-14

### Infrastructure and Development Workflow

**Docker Compose:**
- Configured 5 containers: hms-dashboard, authentik-server, authentik-worker, postgresql, redis
- Dockerfile for hms-dashboard using Python 3.11-slim
- Volume mounts for SQLite database persistence and static files

**Development environment:**
- SSHFS-based remote development from local machine to Linode VPS
- SSH ControlMaster configuration for session reuse
- Helper scripts: `linode-dev-start.sh`, `linode-dev-stop.sh`, `linode-dev-status.sh`
- Bash aliases: `linode`, `linode-stop`, `linode-status`, `linode-cd`

**Cloudflare Tunnel:**
- Routing configured for hmserver.tv -> hms-dashboard:8000
- SSL termination at Cloudflare edge

---

## [0.1] - 2026-02-01

### Design Phase

- Created UI designs using Google Stitch
- Established Baltic Blue color palette (#125793, #2C6DA1, #4684B0, #BEEEF4, #000000)
- Pages designed: login (desktop + mobile), dashboard (desktop + mobile), requests, settings
- UI stack: Tailwind CSS via CDN, Material Design Icons, Spline Sans font
- Branding changed from "Plex Portal" to "HMS Dashboard"

### Initial Prototype

- Hand-coded prototype with custom CSS (orange/coral color scheme)
- Landing page with hero section
- Login page with rotating wallpapers
- Basic navigation structure
- Docker setup with nginx for static file serving
- Original files preserved as `.backup` in static directory

---

## Notes

- The Authentik/OIDC code exists in `app/auth.py` and `app/routers/auth.py` but is not active. It is scaffolded for a future integration phase.
- The Authentik, PostgreSQL, and worker containers run in Docker Compose but are not consumed by the application.
- `mobile.html` exists in the static directory but has not been updated to reflect current dashboard functionality.
- The "Upcoming Releases" and "Server Load" dashboard sections display static placeholder data.
