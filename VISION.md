# WebServarr - Vision and Project Plan

## Project Purpose

A self-hosted web portal for Plex media server administration. The portal provides:
- A homepage/dashboard showing live Plex streams, service health via Uptime Kuma, system gauges via Netdata, and a news system for announcements
- Media request management via Overseerr integration (search, request, track, report issues)
- A combined Radarr + Sonarr release calendar
- In-app and browser push notifications for request updates, issue responses, service changes, and news
- Full theme engine with color pickers, fonts, logos, icons, and custom CSS
- Three authentication methods: simple (default), direct Plex OAuth, and Authentik OIDC
- Designed for long-term maintainability, high performance on modest hardware, and strong security practices
- Fully configurable through the Settings UI -- nothing is hardcoded that should be a variable

## Design Decisions

**Backend:** FastAPI (Python 3.11). Chosen for lightweight footprint, good OIDC library support, async performance, and compatibility with the Plex ecosystem.

**Database:** SQLite for dashboard data (news, services, settings, users, notifications). File-based, easy to back up, performant for read-heavy single-server workloads.

**Frontend:** Vanilla JavaScript + Tailwind CSS from CDN. No build step, no framework. Keeps things simple and avoids dependency churn.

**Infrastructure:** Docker Compose with two containers (webservarr + redis). Optional Authentik overlay for OIDC authentication adds three more containers (authentik-server, authentik-worker, postgresql).

**Authentication:** Three methods supported simultaneously:
- Simple username/password login against SQLite (default, toggleable)
- Direct Plex OAuth via PIN-based flow (same as Overseerr/Tautulli)
- Plex via Authentik OIDC (advanced, for users who already run Authentik)

Admin determination: checks `system.admin_email` setting first, then falls back to comparing against the Plex server owner's email.

---

## Delivery Phases

### Prior work (code exists, revisited in later phases)

1. Repo scaffold and infrastructure -- Docker Compose, deployment tooling
2. UI design -- Stitch design exports created (login + dashboard, desktop + mobile) and stored in `brand-assets/`
3. Backend skeleton -- FastAPI app structure, SQLAlchemy models, Redis session management
4. Authentication -- Database-backed login, bcrypt, session cookies, route protection, admin enforcement
5. News system -- CRUD with rich text editor, bleach sanitization, publish/pin controls
6. Service management -- CRUD via settings page, dashboard display
7. Integration configuration -- Plex/Uptime Kuma/Overseerr settings with test-connection and credential masking
8. Live dashboard -- Plex streams, Uptime Kuma health, Overseerr requests, 30-second refresh

### Phase 0: Documentation and Tooling ✓

- Consolidated documentation into structured layout
- Built developer manual with subagent templates
- Defined project phases 0-8

### Phase 1: Auth and Plex Integration ✓

- Configured Authentik OIDC with native Plex source
- Built OIDC callback with admin determination (Plex server owner = admin)
- Desktop and mobile auth flows (popup-based and full-page redirect)
- Logout clears both dashboard and Authentik sessions
- Session tracks auth_method (oidc/simple) and id_token for logout
- Simple auth kept as fallback alongside Plex OAuth

### Phase 2: Frontend Rebuild ✓

- Rebuilt frontend pages with responsive sidebar and theme engine
- Domain configurability: all URLs driven by settings, no hardcoded domains
- Public branding API for theme/colors/font/branding
- Shared JS/CSS: theme-loader.js, auth.js, sidebar.js, theme.css
- Mobile: hamburger drawer. Desktop: persistent sidebar.
- Theme settings UI: color pickers, font dropdown, logo upload, custom CSS
- Tailwind + CSS custom properties with RGB triplets for alpha support

### Phase 3: Uptime Kuma Integration ✓

- Services exclusively from Uptime Kuma monitors (no manual CRUD)
- Monitor preferences (enabled/disabled, custom icon) stored in Settings
- Auto-fit tile grid with selfh.st CDN icons on homepage
- New monitors default to enabled, configurable through Settings UI

### Phase 4: Overseerr Integration ✓

- Overseerr SSO via Plex token forwarding
- Native requests page: search TMDB, create requests, view existing with filter tabs
- Native issues page: report issues, view list, detail modal with comments
- Per-user Plex auth for write operations
- Request/issue stat summary cards
- Configurable sidebar labels and icons

### Phase 5: Radarr and Sonarr Calendar Integration ✓

- Combined Radarr + Sonarr calendar endpoint with month navigation
- Full calendar page: month grid, day click detail panel, auto-refresh
- Homepage: compact 7-day grouped list with "View calendar" link
- Configurable sidebar label and icon for Calendar nav item

### Phase 6: In-App Notifications and Browser Push ✓

- Notification system for all users: media request availability, issue responses, service up/down, news posts
- In-app bell icon dropdown + optional browser push notifications (Web Push / VAPID)
- Backend polling service with configurable intervals (default 60s)
- SQLite models: Notification (per-user, per-category) + PushSubscription
- VAPID key auto-generation on first startup
- Per-user category preferences (request, issue, service, news)
- Admin endpoint for custom broadcast notifications
- Service worker for push display and click-to-navigate
- Dedup via reference_id; first-run silent seeding prevents notification flood

### Phase 7: Hardening and Release ✓

- Rebranded from HMS Dashboard to WebServarr for open-source release
- Direct Plex OAuth (PIN-based) as second auth method alongside Authentik OIDC
- Three auth methods: simple (default), direct Plex OAuth, Authentik OIDC
- Moved Authentik config from environment variables to Settings DB (configurable in UI)
- Auto-generated SECRET_KEY on first startup (zero-config)
- Auto-generated Plex client identifier (system.plex_client_id)
- Docker Compose simplified to 2 containers (webservarr + redis)
- Optional Authentik overlay (docker-compose.authentik.yml)
- Login page updated for multi-auth with dynamic button visibility
- Frontend rebranded: titles, service worker, manifest
- Public-facing documentation: README, LICENSE, setup guide, API contract

### Phase 8: Ticket System

- User support ticket system for non-admin Plex users to submit issues and feature requests
- Ticket categories: media_request, playback_issue, account_issue, feature_suggestion, other
- Status workflow: open -> in_progress -> resolved -> closed (admin-managed)
- Priority levels: low, medium, high, urgent (admin-only assignment)
- Public/private visibility toggle (admin controls which tickets are visible to all users)
- Image attachments on tickets and comments (PNG, JPEG, WebP; 2MB max)
- Privacy-aware: non-admin users only see their own tickets + public tickets; creator info hidden on others' public tickets
- Admin panel: full ticket list with filters (status, category, priority, creator), bulk status/priority update, delete with cascade
- Comment system with per-ticket threads, admin badge on admin comments
- Notification integration: ticket status changes and new comments trigger in-app + push notifications
- Feature flag: `features.show_tickets` setting (default: true) gates both UI and all API endpoints (403 when disabled)
- bleach HTML sanitization on all text inputs (title, description, comments)

### Phase 9: Security Hardening

- CSRF tokens for form submissions
- Rate limiting on login and public endpoints
- Input validation hardening
- Dependency audit and pinning
- Security documentation

---

## Core Principles

1. **Administration and longevity** -- Stable tooling, centralized management, audit trails
2. **Customization** -- Sitewide theme engine (CSS custom properties, branding API, color pickers, font dropdown, logo upload, custom CSS injection)
3. **Lightweight performance** -- Minimal overhead, fast responses, simple deployment
4. **Security** -- Strong authentication, safe content handling, hardened headers

## Security Requirements

Implemented:
- Secure cookies (HttpOnly, Secure, SameSite=Lax)
- HTML sanitization (bleach) for user-provided content
- Security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- No secrets in source control
- Admin role enforcement on state-changing operations
- Server-side page auth (302 redirect, no HTML leak)

Not yet implemented:
- CSRF tokens for form submissions
- Rate limiting on login and public endpoints
- Bot protection (e.g., Cloudflare Turnstile)
- HSTS headers (typically set at reverse proxy level)

## Out of Scope

- Multiple embedded services beyond Overseerr
- Public user registration (beyond Plex OAuth)
