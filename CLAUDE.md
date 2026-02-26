# WebServarr -- Claude Code Operator Manual

WebServarr is a FastAPI + vanilla JS web portal for Plex media server administration. See VISION.md for the full project plan.

---

## Key Paths

```
app/main.py                  # FastAPI app, middleware, router registration
app/config.py                # Settings from environment variables (pydantic-settings)
app/database.py              # SQLAlchemy engine, session factory, init_db
app/models.py                # User, NewsPost, Service, Setting, StatusUpdate, ServiceStatus, Notification, PushSubscription
app/seed.py                  # Default admin user + settings seeding on first startup
app/auth.py                  # SessionManager (Redis) + OIDCClient
app/dependencies.py          # get_current_user, require_admin dependencies

app/routers/simple_auth.py   # Simple login/logout/session-check + shared logout (OIDC-aware). Guarded by features.show_simple_auth.
app/routers/auth.py          # OIDC auth routes -- Plex OAuth via Authentik (/auth/login, /auth/callback, /auth/me)
app/routers/plex_auth.py     # Direct Plex OAuth -- PIN-based auth (/auth/plex-start, /auth/plex-callback, /auth/plex-callback-page)
app/routers/news.py          # News CRUD with bleach sanitization
app/routers/admin.py         # Service CRUD, settings CRUD, test-connection
app/routers/status.py        # Public service status endpoints
app/routers/integrations.py  # Plex, Uptime Kuma, Overseerr proxy endpoints
app/routers/branding.py      # Public branding/theme endpoint
app/routers/notifications.py # Notification CRUD + preferences + push subscription

app/services/notification_poller.py # Background polling for notifications
app/services/push.py               # Web Push dispatch via pywebpush

app/integrations/plex.py          # Plex API client (XML parsing)
app/integrations/uptime_kuma.py   # Uptime Kuma status page API client
app/integrations/overseerr.py     # Overseerr API client
app/integrations/sonarr.py        # Sonarr API client (calendar, upcoming episodes)
app/integrations/radarr.py        # Radarr API client (calendar, upcoming movies)
app/integrations/netdata.py       # Netdata API client (CPU%, RAM%, network MB/s, uptime, hostname)

app/static/login.html        # Login page (multi-auth: simple, Plex OAuth, Authentik OIDC)
app/static/index.html        # Main dashboard
app/static/settings.html     # Integrations (accordion), System, Customization (icons, theme, labels), News tabs
app/static/requests.html     # Overseerr iframe embed (optional)
app/static/requests2.html    # Native media request page
app/static/issues.html       # Issue reporting and tracking
app/static/calendar.html     # Combined Radarr + Sonarr calendar

uploads/                      # Uploaded assets (logos) -- volume-mounted, persists across rebuilds
docker-compose.yml            # 2 containers: webservarr + redis
docker-compose.authentik.yml  # Optional Authentik overlay (3 additional containers)
Dockerfile                    # Python 3.11-slim image
requirements.txt              # Python dependencies
.env                          # Secrets (not in git)
data/hms.db                   # SQLite database (not in git)

docs/app-contract.md          # Single source of truth: pages, endpoints, models, auth
docs/setup.md                 # Installation and operations guide
```

## Development Workflow

```bash
# Rebuild container after code changes
docker compose up -d --build webservarr

# View logs
docker compose logs -f webservarr

# Check container status
docker compose ps

# Enter container shell
docker compose exec webservarr /bin/bash
```

## Conventions

- **Backend:** Python with type hints. FastAPI dependency injection for auth. SQLAlchemy ORM models.
- **Frontend:** No build step. Vanilla JS with `fetch()` API calls. Tailwind CSS from CDN. Material Design Icons.
- **Auth:** Three methods: simple (username/password, toggleable via `features.show_simple_auth`), direct Plex OAuth (PIN-based, same as Overseerr/Tautulli), Authentik OIDC (Plex via Authentik). bcrypt hashing via passlib. Sessions stored in Redis with `auth_method` tracking ("simple", "plex", or "oidc").
- **Content safety:** bleach for HTML sanitization on news content. Security headers middleware in `main.py`.
- **External APIs:** httpx with 5-second timeout (10s for Plex). Proxy pattern: browser -> FastAPI endpoint -> external service.

## Known Issues

- Authentik end-session doesn't auto-redirect back to login page (upstream issue)
- Authentik Plex source uses a popup for Plex auth -- mobile browsers may block it
- Plex active streams has a float-as-int parsing bug (minor, pre-existing in `plex.py`)
- Default admin password (`admin123`) should be changed for production
- Startup can hit "table already exists" on rebuild if SQLite DB file already exists (auto-recovers on restart)

---

## Brand Assets

Design reference files live in `brand-assets/` at the repo root.

```
brand-assets/
+-- Color Palette/
|   +-- palette.txt                            # HEX, HSL, RGB, CSV, XML, JSON formats
|   +-- palette.scss                           # SCSS variables + CSS gradients
+-- Google Stitch UI Design/
    +-- Login - Desktop/
    |   +-- code.html                          # Stitch HTML export
    |   +-- screen.png                         # Design screenshot
    +-- Login - Mobile/
    |   +-- code.html
    |   +-- screen.png
    +-- Homepage Dashboard - Desktop/
    |   +-- code.html
    |   +-- screen.png
    +-- Homepage Dashboard - Mobile/
        +-- code.html
        +-- screen.png
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
- Do not invent new visual directions -- stay within the brand assets unless explicitly asked otherwise
- Read the Stitch `screen.png` screenshots to understand intended layout before writing HTML

---

## Project Phases

**Current phase: 8**

| Phase | Name | Status |
|-------|------|--------|
| 0 | Documentation and Tooling | Complete |
| 1 | Auth and Plex Integration | Complete |
| 2 | Frontend Rebuild | Complete |
| 3 | Uptime Kuma Integration | Complete |
| 4 | Overseerr Integration | Complete |
| 5 | Radarr and Sonarr Calendar | Complete |
| 6 | In-App Notifications + Browser Push | Complete |
| 7 | Hardening and Release | Complete |
| 8 | Security Hardening | **Next** |

See VISION.md for detailed phase descriptions.

---

## Subagent Catalog

Use these Task agent descriptions when delegating work. Always use `subagent_type` as specified. Each subagent has a defined boundary -- respect it.

### Docker/Deploy (`subagent_type: "Bash"`)

**Use for:** Rebuilding containers, checking logs, verifying container state.

**Prompt template:**
> You are working on the WebServarr project. Docker Compose manages the containers. The active containers are `webservarr` and `redis`. Optional Authentik containers can be added via `docker-compose.authentik.yml`. Task: [describe task]

---

### Backend Build (`subagent_type: "general-purpose"`)

**Use for:** Adding, modifying, or debugging FastAPI endpoints, database models, integration clients, or middleware. Also use for tracing Python code paths, finding bugs, and understanding auth flow.

**Boundary:** Only edits Python files in `app/` and `requirements.txt`. Never touches HTML/JS files.

**Prompt template:**
> You are building and debugging backend functionality for WebServarr, a FastAPI application.
>
> **Key files:** `app/main.py` (app setup, middleware), `app/routers/simple_auth.py` (simple login), `app/routers/plex_auth.py` (direct Plex OAuth), `app/routers/auth.py` (Authentik OIDC), `app/dependencies.py` (auth checks), `app/auth.py` (session manager), `app/config.py` (settings), `app/models.py` (DB models), `app/database.py` (SQLAlchemy setup).
>
> **Current API surface:** Read `docs/app-contract.md` for all existing endpoints, models, and auth dependencies.
>
> **Conventions:**
> - FastAPI dependency injection for auth (`get_current_user`, `require_admin` from `app/dependencies.py`)
> - SQLAlchemy ORM models in `app/models.py`
> - Integration clients in `app/integrations/` using httpx with 5-second timeout
> - Proxy pattern: browser -> FastAPI endpoint -> external service
> - bleach for HTML sanitization on user content
> - Settings stored as key-value pairs in the `settings` table
>
> **Boundary:** Only edit Python files in `app/` and `requirements.txt`. Do not modify HTML/JS files.
>
> **After making changes:** Update `docs/app-contract.md` to reflect any new or modified endpoints, models, or auth requirements.
>
> To rebuild and test: `docker compose up -d --build webservarr`
>
> Task: [describe task]

---

### Frontend Build (`subagent_type: "general-purpose"`)

**Use for:** Building, modifying, or debugging frontend pages. Wiring UI elements to backend endpoints. Implementing Stitch UI designs. Also use for inspecting HTML/JS source, tracing fetch calls, and checking auth redirects.

**Boundary:** Only edits files in `app/static/`. Never touches Python files.

**Prompt template:**
> You are building and debugging frontend pages for WebServarr.
>
> **Key files:** All pages are vanilla HTML+JS in `app/static/`: `login.html` (login form with simple auth + Plex OAuth + Authentik OIDC), `index.html` (dashboard, polls integration endpoints every 30s), `settings.html` (services/integrations/system/customization/news tabs).
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
> You have access to Chrome DevTools MCP tools (prefixed `mcp__chrome-devtools__`) to inspect and verify the live site:
> - `take_snapshot` -- get a text snapshot of the page DOM (prefer this over screenshots)
> - `take_screenshot` -- capture a visual screenshot
> - `list_console_messages` -- check for JS errors
> - `list_network_requests` / `get_network_request` -- inspect fetch calls and API responses
> - `navigate_page` -- load a specific page (url type with full URL)
> - `click`, `fill`, `press_key` -- interact with page elements using uid from snapshot
>
> Task: [describe task]

---

### Integration Test (`subagent_type: "general-purpose"`)

**Use for:** Testing API endpoints via curl or browser, verifying auth flow end-to-end, checking response codes and payloads, interacting with the live UI.

**Prompt template:**
> You are testing the WebServarr API and UI. The app runs at `http://localhost:8000`. Auth flow: POST `/auth/simple-login` with JSON `{"username":"admin","password":"admin123"}` to get a session cookie, then include that cookie in subsequent requests.
>
> You have two ways to test:
> 1. **curl** -- `curl http://localhost:8000/...` for direct API testing
> 2. **Chrome DevTools MCP tools** (prefixed `mcp__chrome-devtools__`) for browser-based testing:
>    - `navigate_page` -- load pages (url type with full URL)
>    - `take_snapshot` -- get page DOM as text (prefer over screenshots)
>    - `take_screenshot` -- capture visual state
>    - `fill` / `click` / `press_key` -- interact with form elements using uid from snapshot
>    - `list_console_messages` -- check for JS errors
>    - `list_network_requests` / `get_network_request` -- inspect API calls and responses
>
> Task: [describe task]

---

### Codebase Review (`subagent_type: "Explore"`)

**Use for:** Read-only review and auditing. Comparing the live frontend against Stitch design exports. Verifying `docs/app-contract.md` matches the actual codebase. Identifying visual differences or documentation drift. Never edits any files.

**Prompt template:**
> You are reviewing the WebServarr codebase.
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
> You have access to Chrome DevTools MCP tools (prefixed `mcp__chrome-devtools__`) to inspect the live site:
> - `take_screenshot` -- capture current visual state
> - `take_snapshot` -- get DOM structure
> - `navigate_page` -- load specific pages
>
> **Output:** Report findings organized by topic. For design reviews, describe what the design shows vs what the live site shows. For contract audits, report any drift (missing/extra endpoints, auth mismatches, model field mismatches).
>
> **Boundary:** Do not edit any files. This is a read-only review.
>
> Task: [describe task]
