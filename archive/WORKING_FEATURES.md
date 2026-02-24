> Archived 2026-02-22. Replaced by docs/app-contract.md (single source of truth for pages, endpoints, models, auth). Kept for historical reference.

# HMS Dashboard - Working Features

This document lists every feature that is implemented and functional as of February 2026. If something is not listed here, it does not work yet.

---

## Authentication

- **Database-backed login:** Users are stored in the SQLite `users` table with bcrypt-hashed passwords (via passlib). No hardcoded credentials; the default admin is created by `app/seed.py` on first startup.
- **Session management:** On successful login, a session is created in Redis and a cookie is set with `HttpOnly`, `Secure`, and `SameSite=Lax` flags.
- **Route protection:** Every page except `/login` checks for a valid session via the `get_current_user` dependency. Unauthenticated requests are redirected to `/login`.
- **Admin enforcement:** All write endpoints (news creation/editing, service management, settings changes, integration actions) use the `require_admin` dependency. Non-admin users cannot perform these operations.
- **Logout:** Clears the session from Redis and removes the session cookie.
- **Session check:** `GET /auth/check-session` endpoint for the frontend to verify whether the current session is still valid.

**Default credentials (created by seed.py):**
- Username: `admin`
- Password: `admin123`

---

## Dashboard (`/`)

The main dashboard displays live data from configured integrations. Each section refreshes automatically every 30 seconds.

### Plex Streams Section
- Shows currently active Plex streams (who is watching, what they are watching, playback progress)
- Data fetched from the Plex API via `app/integrations/plex.py`
- Admin action buttons:
  - **Kill stream:** Terminates a specific Plex playback session
  - **Scan libraries:** Triggers a Plex library scan
  - **Empty trash:** Cleans up deleted items in Plex
- If Plex is not configured, shows a message indicating no integration is set up

### Overseerr Requests Section
- Displays recent media requests from Overseerr
- Shows request counts (pending, approved, available)
- Data fetched via `app/integrations/overseerr.py`
- If Overseerr is not configured, shows an empty state

### Service Status Section
- Service tiles with up/degraded/down indicators
- Health data sourced from Uptime Kuma's public status page API when configured
- Falls back to service status stored in the local database if Uptime Kuma is unavailable or not configured
- Data fetched via `app/integrations/uptime_kuma.py`

### News Section
- Displays published news posts from the database
- Pinned posts appear first
- HTML content rendered directly (sanitized server-side)

### Static Placeholder Sections
The following sections exist in the UI but display static/placeholder data:
- **Upcoming Releases:** Shows hardcoded sample entries, not connected to any data source
- **Server Load / footer stats:** Shows static values, not connected to system metrics

---

## News Management (`/admin`)

- **Rich text editor:** Custom implementation using contentEditable and `document.execCommand`. No external editor libraries are used.
  - Toolbar buttons: bold, italic, underline, strikethrough, headings (H1-H3), ordered list, unordered list, link insertion
  - Keyboard shortcuts: Ctrl+B (bold), Ctrl+I (italic), Ctrl+U (underline), and others
  - Preview mode: Toggle between editing and previewing the rendered HTML
- **CRUD operations:** Create, read, update, and delete news posts
- **Publishing controls:** Posts can be saved as draft or published. Only published posts appear on the dashboard.
- **Pinning:** Posts can be pinned to appear at the top of the news feed.
- **HTML sanitization:** All content is sanitized server-side using the bleach library before storage. Allowed tags are restricted to safe formatting elements.
- **Author and timestamps:** Posts record author name and creation/update timestamps.

---

## Service Management (`/settings` - Services Tab)

- **Service CRUD:** Create, edit, and delete services
- **Service properties:** name, display name, description, URL, icon (Material Design icon name), status (up/degraded/down), enabled toggle, requires-auth flag
- **Immediate effect:** Changes to services are reflected on the dashboard without a page reload

---

## Integration Configuration (`/settings` - Integrations Tab)

Three integrations can be configured:

### Plex
- Fields: server URL, API token
- Test connection button validates the token against the Plex API
- Token is masked after saving

### Uptime Kuma
- Fields: server URL, status page slug
- Test connection button validates the URL returns a valid status page response
- Used by the dashboard to fetch service health data

### Overseerr
- Fields: server URL, API key
- Test connection button validates credentials against the Overseerr API
- API key is masked after saving

**Common behavior:**
- All credentials are stored in the settings table as key-value pairs
- API keys and tokens are masked in the UI (only last few characters visible)
- Test connection makes a real API call and reports success or failure
- Settings are saved via `PUT /api/admin/settings/bulk`

---

## API Endpoints

All endpoints listed here are implemented and functional.

### Authentication
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/simple-login` | None | Login with username/password |
| POST | `/auth/simple-logout` | Session | Destroy session and clear cookie |
| GET | `/auth/check-session` | Session | Check if session is valid |
| GET | `/auth/me` | Session | Get current user info |

### News
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/news/` | Session | List published news posts |
| GET | `/api/news/{id}` | Session | Get a single post |
| POST | `/api/news/` | Admin | Create a post |
| PUT | `/api/news/{id}` | Admin | Update a post |
| DELETE | `/api/news/{id}` | Admin | Delete a post |

### Services and Status
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/status/services` | Session | List services with current status |
| GET | `/api/status/services/{name}` | Session | Get a single service by name |

### Admin
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/services` | Admin | List all services |
| POST | `/api/admin/services` | Admin | Create a service |
| PUT | `/api/admin/services/{id}` | Admin | Update a service |
| DELETE | `/api/admin/services/{id}` | Admin | Delete a service |
| GET | `/api/admin/settings/{key}` | Admin | Get a setting value |
| PUT | `/api/admin/settings` | Admin | Update a single setting |
| PUT | `/api/admin/settings/bulk` | Admin | Update multiple settings at once |
| POST | `/api/admin/test-connection` | Admin | Test integration API credentials |

### Integrations
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/integrations/active-streams` | Session | Get active Plex streams |
| POST | `/api/integrations/kill-stream` | Admin | Terminate a Plex stream |
| POST | `/api/integrations/plex/scan` | Admin | Trigger Plex library scan |
| POST | `/api/integrations/plex/empty-trash` | Admin | Empty Plex trash |
| GET | `/api/integrations/service-status` | Session | Get service health from Uptime Kuma |
| GET | `/api/integrations/recent-requests` | Session | Get recent Overseerr requests |
| GET | `/api/integrations/request-counts` | Session | Get Overseerr request count summary |

### Health
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Container health check |

---

## Security

- Session cookies: HttpOnly, Secure, SameSite=Lax
- HTML sanitization via bleach on all news content
- Security headers middleware in FastAPI (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- API keys and tokens masked in settings responses
- Admin role required for all state-changing operations
- External API calls use httpx with 5-second timeout to prevent hanging

---

## Database Models

Defined in `app/models.py`:

- **User** - id, username, email, display_name, password_hash, is_admin, is_active, created_at, last_login
- **NewsPost** - id, title, content, content_html, author, published, pinned, created_at, updated_at
- **Service** - id, name, display_name, description, url, icon, status, enabled, requires_auth, created_at
- **Setting** - id, key, value, created_at, updated_at
- **StatusUpdate** - id, service_id, status, message, created_at, resolved_at
- **ServiceStatus** - id, service_id, status, checked_at
