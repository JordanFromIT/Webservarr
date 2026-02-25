# HMS Dashboard — Claude Code Operator Manual

HMS Dashboard is a FastAPI + vanilla JS web portal for Plex media server administration, running on a Linode VPS (2GB RAM, 1 CPU) behind Cloudflare Tunnel at dev.hmserver.tv. The frontend does NOT yet match the Stitch UI designs in `brand-assets/`. See VISION.md for the full project plan.

---

## Key Paths

```
app/main.py                  # FastAPI app, middleware, router registration
app/config.py                # Settings from environment variables (pydantic-settings)
app/database.py              # SQLAlchemy engine, session factory, init_db
app/models.py                # User, NewsPost, Service, Setting, StatusUpdate, ServiceStatus
app/seed.py                  # Default admin user + settings seeding on first startup
app/auth.py                  # SessionManager (Redis) + OIDCClient (active)
app/dependencies.py          # get_current_user, require_admin dependencies

app/routers/simple_auth.py   # Simple login/logout/session-check + shared logout (OIDC-aware). Guarded by features.show_simple_auth.
app/routers/auth.py          # OIDC auth routes — Plex OAuth via Authentik (/auth/login, /auth/callback, /auth/me)
app/routers/news.py          # News CRUD with bleach sanitization
app/routers/admin.py         # Service CRUD, settings CRUD, test-connection
app/routers/status.py        # Public service status endpoints
app/routers/integrations.py  # Plex, Uptime Kuma, Overseerr proxy endpoints

app/services/notification_poller.py # Background polling for notifications
app/services/push.py               # Web Push dispatch via pywebpush
app/routers/notifications.py       # Notification CRUD + preferences + push subscription

app/integrations/plex.py          # Plex API client (XML parsing)
app/integrations/uptime_kuma.py   # Uptime Kuma status page API client
app/integrations/overseerr.py     # Overseerr API client
app/integrations/sonarr.py        # Sonarr API client (calendar, upcoming episodes)
app/integrations/radarr.py        # Radarr API client (calendar, upcoming movies)
app/integrations/netdata.py       # Netdata API client (CPU%, RAM%, network MB/s, uptime, hostname)

app/static/login.html        # Login page
app/static/index.html        # Main dashboard
app/static/settings.html      # Integrations (accordion), System, Customization (icons, theme, labels), News tabs

uploads/                      # Uploaded assets (logos) — volume-mounted, persists across rebuilds
docker-compose.yml            # 5 containers (all active: hms-dashboard, redis, authentik-server, authentik-worker, postgresql)
Dockerfile                    # Python 3.11-slim image
requirements.txt              # Python dependencies
.env                          # Secrets (not in git)
data/hms.db                   # SQLite database (not in git)

docs/app-contract.md          # Single source of truth: pages, endpoints, models, auth
docs/setup.md                 # Deployment and operations guide
```

## Development Workflow

Files live on the Linode VPS at `/root/hms-dashboard` and are mounted locally via SSHFS directly to `~/Dropbox/ClaudeCode/hms-dashboard`. Edits here are live on the VPS when the mount is active.

**SSH host alias:** `webserver` (configured in `~/.ssh/config`)
**Connection script:** `/home/jordan/bin/webserver` (interactive connect/disconnect)
**SSH key:** `/home/jordan/Dropbox/Shared/WebServerOpenSSH`

```bash
# Connect and mount (interactive, prompts for passphrase + 2FA)
webserver

# Rebuild container after code changes
ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"

# View logs
ssh webserver "cd /root/hms-dashboard && docker compose logs -f hms-dashboard"

# Check container status
ssh webserver "cd /root/hms-dashboard && docker compose ps"

# Enter container shell
ssh webserver "cd /root/hms-dashboard && docker compose exec hms-dashboard /bin/bash"
```

## Conventions

- **Backend:** Python with type hints. FastAPI dependency injection for auth. SQLAlchemy ORM models.
- **Frontend:** No build step. Vanilla JS with `fetch()` API calls. Tailwind CSS from CDN. Material Design Icons.
- **Auth:** Plex OAuth via Authentik OIDC (primary) + simple username/password (toggleable fallback via `features.show_simple_auth` setting). bcrypt hashing via passlib. Sessions stored in Redis with auth_method tracking ("oidc" or "simple").
- **Content safety:** bleach for HTML sanitization on news content. Security headers middleware in `main.py`.
- **External APIs:** httpx with 5-second timeout. Proxy pattern: browser → FastAPI endpoint → external service.

## Known Issues

- Authentik end-session doesn't auto-redirect back to login page (upstream issue, PR goauthentik/authentik#20011 will fix)
- Authentik Plex source uses a popup for Plex auth — mobile browsers may block the popup (inherent to Authentik's Plex integration, cannot be changed to redirect)
- Plex active streams has a float-as-int parsing bug (minor, pre-existing in `plex.py`)
- Default admin password (`admin123`) should be changed for production
- Startup can hit "table already exists" on rebuild if SQLite DB file already exists (container auto-recovers on restart)
- Frontend HTML does not match the Stitch UI designs in `brand-assets/` (future redesign work)
- Sidebar responsive but mobile layout could be refined further

---

## Brand Assets

Design reference files live in `brand-assets/` at the repo root.

```
brand-assets/
├── HMServer Logo.png                          # Project logo
├── Color Palette/
│   ├── palette.txt                            # HEX, HSL, RGB, CSV, XML, JSON formats
│   └── palette.scss                           # SCSS variables + CSS gradients
└── Google Stitch UI Design/
    ├── Login - Desktop/
    │   ├── code.html                          # Stitch HTML export
    │   └── screen.png                         # Design screenshot
    ├── Login - Mobile/
    │   ├── code.html
    │   └── screen.png
    ├── Homepage Dashboard - Desktop/
    │   ├── code.html
    │   └── screen.png
    └── Homepage Dashboard - Mobile/
        ├── code.html
        └── screen.png
```

**Color Palette:**
| Name | Hex | Usage |
|------|-----|-------|
| Baltic Blue | #125793 | Primary |
| Cornflower Ocean | #2C6DA1 | Secondary |
| Steel Blue | #4684B0 | Tertiary |
| Frosted Blue | #BEEEF4 | Light accent |
| Black | #000000 | Background/dark |

**Rules for UI work:**
- Always reference `brand-assets/Color Palette/palette.scss` for color values
- Use Stitch HTML exports as the design target, not the current frontend HTML
- Do not invent new visual directions — stay within the brand assets unless explicitly asked otherwise
- Read the Stitch `screen.png` screenshots to understand intended layout before writing HTML

---

## Project Phases

**Current phase: 7**

| Phase | Name | Status |
|-------|------|--------|
| 0 | Documentation & Tooling | Complete |
| 1 | Auth & Plex Integration | Complete |
| 2 | Frontend Rebuild | Complete |
| 3 | Uptime Kuma Integration | Complete |
| 4 | Overseerr Integration | Complete |
| 5 | Radarr & Sonarr Calendar | Complete |
| 6 | In-App Notifications + Browser Push | Complete |
| 7 | Hardening & Release | **Next** |

See VISION.md for detailed phase descriptions.

---

## Subagent Catalog

Use these Task agent descriptions when delegating work. Always use `subagent_type` as specified. Each subagent has a defined boundary — respect it.

### Docker/Deploy (`subagent_type: "Bash"`)

**Use for:** Rebuilding containers, checking logs, verifying container state, SSH commands to VPS.

**Prompt template:**
> You are working on the HMS Dashboard project deployed on a Linode VPS accessible via `ssh webserver`. The project is at `/root/hms-dashboard` on the VPS. Docker Compose manages the containers. The active containers are `hms-dashboard` and `redis` (the authentik containers exist but are not actively used). Task: [describe task]

---

### Backend Build (`subagent_type: "general-purpose"`)

**Use for:** Adding, modifying, or debugging FastAPI endpoints, database models, integration clients, or middleware. Also use for tracing Python code paths, finding bugs, and understanding auth flow.

**Boundary:** Only edits Python files in `app/` and `requirements.txt`. Never touches HTML/JS files.

**Prompt template:**
> You are building and debugging backend functionality for the HMS Dashboard, a FastAPI application. The project root is `/home/jordan/Dropbox/ClaudeCode/hms-dashboard`.
>
> **Key files:** `app/main.py` (app setup, middleware), `app/routers/simple_auth.py` (login), `app/dependencies.py` (auth checks), `app/auth.py` (session manager), `app/config.py` (settings), `app/models.py` (DB models), `app/database.py` (SQLAlchemy setup).
>
> **Current API surface:** Read `docs/app-contract.md` for all existing endpoints, models, and auth dependencies.
>
> **Conventions:**
> - FastAPI dependency injection for auth (`get_current_user`, `require_admin` from `app/dependencies.py`)
> - SQLAlchemy ORM models in `app/models.py`
> - Integration clients in `app/integrations/` using httpx with 5-second timeout
> - Proxy pattern: browser → FastAPI endpoint → external service
> - bleach for HTML sanitization on user content
> - Settings stored as key-value pairs in the `settings` table
>
> **Boundary:** Only edit Python files in `app/` and `requirements.txt`. Do not modify HTML/JS files.
>
> **After making changes:** Update `docs/app-contract.md` to reflect any new or modified endpoints, models, or auth requirements.
>
> To rebuild and test: `ssh webserver "cd /root/hms-dashboard && docker compose up -d --build hms-dashboard"`
>
> Task: [describe task]

---

### Frontend Build (`subagent_type: "general-purpose"`)

**Use for:** Building, modifying, or debugging frontend pages. Wiring UI elements to backend endpoints. Implementing Stitch UI designs. Also use for inspecting HTML/JS source, tracing fetch calls, and checking auth redirects.

**Boundary:** Only edits files in `app/static/`. Never touches Python files.

**Prompt template:**
> You are building and debugging frontend pages for the HMS Dashboard. The project root is `/home/jordan/Dropbox/ClaudeCode/hms-dashboard`.
>
> **Key files:** All pages are vanilla HTML+JS in `app/static/`: `login.html` (login form, posts to `/auth/simple-login`), `index.html` (dashboard, polls integration endpoints every 30s), `settings.html` (services/integrations/system/theme/news tabs).
>
> **Design reference:** Read the Stitch UI design exports in `brand-assets/Google Stitch UI Design/` for the target layout. Read `brand-assets/Color Palette/palette.scss` for color values. The brand colors are: Baltic Blue (#125793), Cornflower Ocean (#2C6DA1), Steel Blue (#4684B0), Frosted Blue (#BEEEF4), Black (#000000).
>
> **API surface:** Read `docs/app-contract.md` for all available endpoints, their auth requirements, and expected responses.
>
> **Stack:** Vanilla JS (no frameworks), Tailwind CSS via CDN, Material Design Icons. No build step.
>
> **Auth pattern:** Each page checks `GET /auth/check-session` on load and redirects to `/login` if not authenticated.
>
> **Boundary:** Only edit files in `app/static/`. Do not modify any Python files.
>
> You have access to Chrome DevTools MCP tools (prefixed `mcp__chrome-devtools__`) to inspect and verify the live site at `https://dev.hmserver.tv`:
> - `take_snapshot` — get a text snapshot of the page DOM (prefer this over screenshots)
> - `take_screenshot` — capture a visual screenshot
> - `list_console_messages` — check for JS errors
> - `list_network_requests` / `get_network_request` — inspect fetch calls and API responses
> - `navigate_page` — load a specific page (url type with full URL)
> - `click`, `fill`, `press_key` — interact with page elements using uid from snapshot
>
> Task: [describe task]

---

### Integration Test (`subagent_type: "general-purpose"`)

**Use for:** Testing API endpoints via curl or browser, verifying auth flow end-to-end, checking response codes and payloads, interacting with the live UI.

**Prompt template:**
> You are testing the HMS Dashboard API and UI. The app runs at `https://dev.hmserver.tv` (production via Cloudflare Tunnel) or `http://localhost:8000` (direct container access on VPS via `ssh webserver`). Auth flow: POST `/auth/simple-login` with JSON `{"username":"admin","password":"admin123"}` to get a session cookie, then include that cookie in subsequent requests.
>
> You have two ways to test:
> 1. **curl via SSH** — `ssh webserver "curl ..."` for direct API testing against localhost:8000
> 2. **Chrome DevTools MCP tools** (prefixed `mcp__chrome-devtools__`) for browser-based testing against dev.hmserver.tv:
>    - `navigate_page` — load pages (url type with full URL)
>    - `take_snapshot` — get page DOM as text (prefer over screenshots)
>    - `take_screenshot` — capture visual state
>    - `fill` / `click` / `press_key` — interact with form elements using uid from snapshot
>    - `list_console_messages` — check for JS errors
>    - `list_network_requests` / `get_network_request` — inspect API calls and responses
>
> Task: [describe task]

---

### Codebase Review (`subagent_type: "Explore"`)

**Use for:** Read-only review and auditing. Comparing the live frontend against Stitch design exports. Verifying `docs/app-contract.md` matches the actual codebase. Identifying visual differences or documentation drift. Never edits any files.

**Prompt template:**
> You are reviewing the HMS Dashboard codebase. The project root is `/home/jordan/Dropbox/ClaudeCode/hms-dashboard`.
>
> **Design source:** Stitch UI exports in `brand-assets/Google Stitch UI Design/`. Each subfolder has a `code.html` (design HTML) and `screen.png` (design screenshot). Read the screenshots to understand the intended visual layout.
>
> **Contract:** `docs/app-contract.md` is the claimed app surface (endpoints, models, auth, pages).
>
> **Verification checklist (use when auditing contract):**
> 1. Read each router file in `app/routers/` and verify every endpoint listed in the contract exists, and no unlisted endpoints exist
> 2. Check auth dependencies match what the contract claims (None, Session, Admin)
> 3. Read `app/models.py` and verify model fields match the contract
> 4. Read `app/static/` filenames and verify the pages table is accurate
> 5. Check `app/integrations/` files and verify the integration client status column is accurate
>
> You have access to Chrome DevTools MCP tools (prefixed `mcp__chrome-devtools__`) to inspect the live site at `https://dev.hmserver.tv`:
> - `take_screenshot` — capture current visual state
> - `take_snapshot` — get DOM structure
> - `navigate_page` — load specific pages
>
> **Output:** Report findings organized by topic. For design reviews, describe what the design shows vs what the live site shows. For contract audits, report any drift (missing/extra endpoints, auth mismatches, model field mismatches).
>
> **Boundary:** Do not edit any files. This is a read-only review.
>
> Task: [describe task]
