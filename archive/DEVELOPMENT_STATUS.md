> Archived 2026-02-22. Replaced by VISION.md (project phases) and docs/app-contract.md (current state). Kept for historical reference.

# HMS Dashboard - Development Status

## Completed Phases

### Phase 1: Design (Feb 2026)

Produced the initial UI designs using Google Stitch and established the Baltic Blue color palette. Pages designed: login, dashboard, requests, settings. All pages use Tailwind CSS via CDN with Material Design Icons.

### Phase 2: Infrastructure and Scaffold (Feb 2026)

Set up Docker Compose with 5 containers (hms-dashboard, authentik-server, authentik-worker, postgresql, redis). Configured Cloudflare Tunnel for routing. Established the SSHFS development workflow from local machine to Linode VPS. Created the FastAPI application skeleton with SQLAlchemy models, Redis session management, and static file serving.

### Phase 3: Authentication and Core CRUD (Feb 2026)

Implemented database-backed authentication:
- User model in SQLite with bcrypt password hashing (via passlib)
- `app/seed.py` creates a default admin user on first startup
- Login endpoint at `POST /auth/simple-login` validates credentials against the database
- Session creation and storage in Redis with secure cookie settings (HttpOnly, Secure, SameSite=Lax)
- Logout endpoint clears session from Redis and removes cookie
- `get_current_user` dependency checks session on every protected request
- `require_admin` dependency enforces admin role on all write endpoints
- All pages redirect to `/login` if the user is not authenticated

Built core CRUD functionality:
- News posts: create, read, update, delete with HTML content sanitized by bleach
- Services: full CRUD via the settings page admin endpoints
- Settings: key-value store for configuration data

### Phase 4: Rich Text Editor and News System (Feb 2026)

Replaced the markdown-based news editor with a custom rich text editor:
- Built on contentEditable with `document.execCommand` (no external libraries)
- Toolbar with formatting buttons (bold, italic, underline, headings, lists, links)
- Keyboard shortcuts (Ctrl+B, Ctrl+I, etc.)
- Preview mode to see rendered output before saving
- HTML content stored in the database, sanitized server-side with bleach
- Published/draft toggle and pin support

### Phase 5: Integration Configuration (Feb 2026)

Added the Integrations tab to the settings page:
- Configuration forms for Plex, Uptime Kuma, and Overseerr
- Each integration stores its URL and API key/token in the settings table
- Test connection button that validates credentials against the external API
- API keys and tokens are masked in the UI after saving

### Phase 6: Live Dashboard Integrations (Feb 2026)

Wired the dashboard to pull live data from configured integrations:

**Plex integration (`app/integrations/plex.py`):**
- Fetches active streams (currently watching) and displays them on the dashboard
- Admin action buttons: kill stream, scan libraries, empty trash
- Parses Plex XML API responses

**Uptime Kuma integration (`app/integrations/uptime_kuma.py`):**
- Reads service health from Uptime Kuma's public status page API
- Dashboard service tiles show live up/degraded/down status
- Falls back to local database status if Uptime Kuma is not configured or unreachable

**Overseerr integration (`app/integrations/overseerr.py`):**
- Fetches recent media requests and displays them on the dashboard
- Shows request count summary (pending, approved, available)

**Dashboard behavior:**
- All integration sections refresh every 30 seconds
- Sections show graceful empty states when an integration is not configured
- Integration API calls use httpx with a 5-second timeout

---

## Current State Summary

**Working:**
- Authentication (database-backed, bcrypt, Redis sessions)
- Route protection and admin role enforcement
- News CRUD with rich text editor and HTML sanitization
- Service CRUD
- Integration configuration with test-connection and credential masking
- Live Plex, Uptime Kuma, and Overseerr data on the dashboard
- 30-second auto-refresh for dashboard sections
- Plex admin actions (kill stream, scan libraries, empty trash)

**Static placeholders (not wired to real data):**
- Upcoming Releases calendar section on the dashboard
- Server Load / footer statistics

**Scaffolded but inactive:**
- Authentik/OIDC authentication flow (`app/auth.py` and `app/routers/auth.py` exist but are not used)
- Authentik, PostgreSQL, and worker containers run but are not consumed by the application

---

## Future Work

These items are not implemented. They are listed here for planning purposes.

- **Authentik/OIDC integration:** Replace the simple login with Authentik as the identity provider. The OIDC client code exists in `app/auth.py` but needs configuration and testing. This would enable Plex OAuth login.
- **Notifications:** Email and/or Discord webhook notifications for news posts, maintenance, and incidents.
- **Theme customization:** Admin-controlled color scheme and branding via CSS variables.
- **User management:** Password change UI, user listing, role assignment beyond the seeded admin.
- **Mobile layout:** The `mobile.html` file exists but has not been updated to match current dashboard functionality.
- **Upcoming Releases:** Connect to a real data source (Sonarr/Radarr calendars or similar) instead of static placeholder data.
- **Server Load stats:** Fetch real system metrics instead of showing static placeholder values.
- **Rate limiting:** Login endpoint and public API rate limiting.
- **Backup automation:** Scheduled SQLite database backups.

---

## Development Workflow

Files live on the Linode VPS at `/root/hms-dashboard` and are mounted locally via SSHFS at `~/Dropbox/ClaudeCode/hms-dashboard`.

```bash
# Connect and mount
webserver

# Edit files
cd ~/Dropbox/ClaudeCode/hms-dashboard && claude

# Rebuild container after changes
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"

# View logs
ssh webserver "cd /root/hms-dashboard && docker compose logs -f hms-dashboard"

# Disconnect
webserver  # then choose option 2
```

### Debugging

```bash
# View all container logs
ssh webserver "cd /root/hms-dashboard && docker compose logs"

# Check container status
ssh webserver "cd /root/hms-dashboard && docker compose ps"

# Enter container shell
ssh webserver "cd /root/hms-dashboard && docker compose exec hms-dashboard /bin/bash"

# Query database
ssh webserver "cd /root/hms-dashboard && docker compose exec hms-dashboard sqlite3 /app/data/hms.db"
```
