> Archived 2026-02-22. Content absorbed into CLAUDE.md (key paths, conventions, dev workflow) and docs/app-contract.md (models, auth flow, endpoints). Kept for historical reference.

# HMS Dashboard - Technical Architecture

## Overview

HMS Dashboard is a web portal for Plex media server administration. It runs on a Linode VPS behind Cloudflare Tunnel and provides a unified interface for monitoring Plex streams, service health (via Uptime Kuma), media requests (via Overseerr), and publishing news updates.

The architecture separates the always-online portal (VPS) from the home media server, so the dashboard remains accessible even during home network outages.

## Infrastructure

- WebServer (Linode VPS - 2GB RAM, 1 vCPU Core)
    - Runs Cloudflare Tunnel for routing and SSL.
    - Docker for container management.
    - The WebServer hosts the dashboard containers and Uptime Kuma.
- MediaServer (UNRAID Midtower 16C/32T AMD Ryzen 9 9900x)
    - Docker for container management.
    - Hosts the docker containers; Plex, Radarr, Sonarr, Overseerr, and other unrelated docker containers.

### Container Architecture

There are 5 containers defined in `docker-compose.yml`:

```
hms-dashboard       FastAPI app + static files       Port 8000 (internal)
authentik-server    OIDC provider (not active)       Port 9000 (internal)
authentik-worker    Background tasks (not active)    -
postgresql          Authentik database (not active)  Internal only
redis               Session storage for dashboard    Internal only
```

**Important:** Only `hms-dashboard` and `redis` are actively used by the application today. The Authentik containers (server, worker) and PostgreSQL exist in the compose file for a planned OIDC integration phase. They consume resources but do not serve the dashboard.

### What Each Active Container Does

**hms-dashboard:**
- Runs FastAPI with Uvicorn
- Serves static HTML/JS/CSS files for all pages
- Handles API requests for authentication, news, services, settings, and integrations
- Stores application data in SQLite at `/app/data/hms.db`
- Connects to Redis for session storage

**redis:**
- Stores dashboard sessions (DB 0)
- Authentik would use DB 1 if activated

---

## Application Architecture

### Backend (FastAPI)

```
app/
  main.py              FastAPI app creation, middleware, router registration
  config.py            Settings loaded from environment variables
  database.py          SQLAlchemy engine, session factory, init_db function
  models.py            All SQLAlchemy models (see below)
  seed.py              Creates default admin user on first startup
  auth.py              SessionManager (Redis) + OIDC client scaffold (inactive)
  dependencies.py      FastAPI dependencies for auth checks

  routers/
    simple_auth.py     POST /auth/simple-login, GET /auth/logout, GET /auth/check-session
    news.py            News CRUD endpoints with bleach sanitization
    admin.py           Service CRUD, settings CRUD, bulk settings, test-connection
    status.py          Public service status endpoints
    integrations.py    Proxy endpoints for Plex, Uptime Kuma, Overseerr
    auth.py            OIDC login/callback/logout (scaffolded, not active)

  integrations/
    plex.py            Plex API client: sessions, kill stream, scan, empty trash (XML parsing)
    uptime_kuma.py     Uptime Kuma public status page API client
    overseerr.py       Overseerr API client: requests, counts
```

### Database Models (`app/models.py`)

All models use SQLAlchemy and are stored in a single SQLite file (`/app/data/hms.db`).

| Model | Purpose | Key Fields |
|-------|---------|------------|
| User | Authentication | username, email, display_name, password_hash (bcrypt), is_admin, is_active, last_login |
| NewsPost | News/announcements | title, content, content_html, author, published, pinned |
| Service | Service registry | name, display_name, url, icon, status, enabled |
| Setting | Key-value config store | key, value (used for integration credentials) |
| StatusUpdate | Incident tracking | service_id, status, message, resolved_at |
| ServiceStatus | Point-in-time health | service_id, status, checked_at |

### Authentication Flow

The current authentication is handled entirely within the FastAPI application:

```
1. User visits any page
2. Frontend JavaScript checks GET /auth/check-session
3. If no valid session -> redirect to /login
4. User submits credentials via POST /auth/simple-login
5. Backend looks up User in SQLite, verifies bcrypt hash
6. On success: create session in Redis, set cookie (HttpOnly, Secure, SameSite=Lax)
7. Redirect to /
8. Subsequent requests include session cookie
9. get_current_user dependency validates session against Redis on each request
10. require_admin dependency additionally checks user.role == "admin"
```

There is no Authentik/OIDC flow active. The code in `app/auth.py` and `app/routers/auth.py` is scaffolded for a future phase where Authentik would handle login via Plex OAuth.

### Integration Data Flow

The dashboard fetches live data from external services through a proxy pattern:

```
Browser -> GET /api/integrations/active-streams -> FastAPI -> Plex API (httpx, 5s timeout)
Browser -> GET /api/integrations/service-status -> FastAPI -> Uptime Kuma status page API
Browser -> GET /api/integrations/recent-requests -> FastAPI -> Overseerr API
```

Integration credentials (URLs, API keys/tokens) are stored in the `settings` table and loaded on each request. If an integration is not configured, the endpoint returns an empty/unconfigured response and the frontend shows a graceful empty state.

The dashboard JavaScript polls these endpoints every 30 seconds.

### Service Health Resolution

Service status on the dashboard uses a two-tier approach:

1. If Uptime Kuma is configured, fetch health from its public status page API
2. If Uptime Kuma is not configured or unreachable, fall back to the status stored in the local `services` table

---

## Frontend Architecture

The frontend is vanilla JavaScript with no build step:

- **Tailwind CSS** loaded from CDN
- **Material Design Icons** (Google) loaded from CDN
- **No JavaScript framework** - plain DOM manipulation and fetch API
- **Rich text editor** built on contentEditable with `document.execCommand`

Each page is a standalone HTML file served from `app/static/`:

| File | Path | Description |
|------|------|-------------|
| login.html | /login | Login form |
| index.html | / | Main dashboard with dynamic sections |
| admin.html | /admin | News management with rich text editor |
| settings.html | /settings | Service CRUD, integration config, system settings |
| mobile.html | /mobile | Mobile layout (exists but unmaintained) |

---

## Network Architecture

### Cloudflare Tunnel Routing

```
User request -> Cloudflare Edge (SSL termination) -> Cloudflare Tunnel -> Docker container

Routes:
  hmserver.tv            -> hms-dashboard:8000
  auth.hmserver.tv       -> authentik-server:9000 (defined but not actively used)
  requests.hmserver.tv   -> overseerr:5055 (home server)
```

No ports are exposed directly to the internet. Cloudflare handles SSL/TLS and provides DDoS protection. There is no nginx or reverse proxy container; Cloudflare routes directly to the application containers.

### Resilience

**When the home server is offline:**
- Dashboard remains accessible (runs on VPS)
- Plex stream data and Overseerr requests will show empty/error states
- Uptime Kuma will report services as down (if monitoring home services)
- News, settings, and authentication continue to work normally

**When the VPS is offline:**
- Dashboard is completely unavailable
- Plex and Overseerr remain directly accessible via their own URLs

---

## Security

### Cookie Configuration
```python
response.set_cookie(
    key="session_id",
    value=session_id,
    httponly=True,
    secure=True,
    samesite="lax",
    max_age=604800  # 7 days
)
```

### Security Headers (FastAPI Middleware)
- Content-Security-Policy
- X-Frame-Options: SAMEORIGIN
- X-Content-Type-Options: nosniff
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy

### Content Safety
- News content sanitized with bleach before storage
- API keys masked in settings API responses
- External API calls use httpx with 5-second timeout

### Secret Management
- Secrets stored in `.env` file (not committed to git)
- Loaded via environment variables into `app/config.py`
- Integration credentials stored in the SQLite settings table

---

## Development Environment

Development happens on the Linode VPS. Files are mounted locally via SSHFS for editing.

**Remote path:** `/root/hms-dashboard` on Linode VPS
**Local mount:** `~/Dropbox/ClaudeCode/hms-dashboard` (SSHFS mounts directly to project directory)

**SSH Configuration:**
```
Host webserver
    HostName 172.232.27.184
    User root
    IdentityFile /home/jordan/Dropbox/Shared/WebServerOpenSSH
    ControlMaster auto
    ControlPath ~/.ssh/control-%r@%h:%p
    ControlPersist 1h
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

SSH ControlMaster keeps the connection alive so that file edits via SSHFS and remote Docker commands do not require re-authentication within a session.

**Connection script:** `/home/jordan/bin/webserver` - Interactive connect/disconnect with SSHFS mount

---

## Resource Usage (Estimated)

| Container | RAM | Notes |
|-----------|-----|-------|
| hms-dashboard | ~150MB | Uvicorn with limited workers |
| authentik-server | ~250MB | Running but not serving the app |
| authentik-worker | ~150MB | Running but not serving the app |
| postgresql | ~150MB | Running but not serving the app |
| redis | ~50MB | Session storage |
| System overhead | ~250MB | OS + Docker |
| **Total** | **~1000MB** | ~50% of 2GB VPS |

Note: Approximately 550MB of the ~1000MB is consumed by Authentik and PostgreSQL containers that are not actively used. Removing them would significantly reduce resource usage.

---

## Backup

**What to back up:**
- `./data/hms.db` - SQLite database (all application data)
- `.env` - Environment variables and secrets

The static files are in version control and do not need separate backup.

**No automated backup is currently configured.** This is listed as future work.
