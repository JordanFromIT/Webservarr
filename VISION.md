# HMS Dashboard - Vision and Project Plan

## Project Purpose

Create a single web portal for Plex media server administration. The portal provides:
- A homepage/dashboard showing:
    - Live Plex streams: Similar to what the plex admin dashboard shows.
    - Service health: Using Uptime Kuma, show the current status of specific services.
    - A news system: Announcements and maintenance notices for the plex media server and related services.
- The project is designed for long-term maintainability by a single administrator, high performance on modest hardware, and strong security practices.
- There should be settings pages for all the necessary API integrations with the other containerized services I offer.
- When we are complete I should be able to put this on github and share it so that anyone with similar contianers can configure it how they want and use it. Nothing should be hardcoded into that should be a variable; things like logos, branding, plex api, radarr api, etc.
## Original Design Decisions

These decisions were made at the start of the project and still hold:

**Backend:** FastAPI (Python 3.11). Chosen for lightweight footprint, good OIDC library support, async performance, and compatibility with the Plex ecosystem.

**Database:** SQLite for dashboard data (news, services, settings, users). File-based, easy to back up, performant for read-heavy single-server workloads. PostgreSQL exists in the compose file for Authentik but is not used by the dashboard.

**Frontend:** Vanilla JavaScript + Tailwind CSS from CDN. No build step, no framework. Keeps things simple and avoids dependency churn.

**Infrastructure:** 
- WebServer (Linode VPS - 2GB RAM, 1 vCPU Core)
    - Runs Cloudflare Tunnel for routing and SSL.
    - Docker for container management.
    - The WebServer hosts the dashboard containers and Uptime Kuma.
- MediaServer (UNRAID Midtower 16C/32T AMD Ryzen 9 9900x)
    - Docker for container management.
    - Hosts the docker containers; Plex, Radarr, Sonarr, Overseerr, and other unrelated docker containers.

**Authentication (primary):** Authentik as OIDC identity provider with Plex OAuth as the login method. Users click "Sign in with Plex" on the login page, authenticate with Plex via Authentik, and the backend checks if the user's email matches the Plex server owner (admin) or is a known Plex friend (user). Sessions stored in Redis with `auth_method` tracking.

**Authentication (fallback):** Simple username/password login against the SQLite User table with bcrypt hashing. Kept for admin access when Plex/Authentik is unavailable.

---

## Delivery Phases

### Prior work (code exists, needs revisiting)

The following was built during initial development. The backend code is functional but the frontend HTML does not match the Stitch UI designs in `brand-assets/`. Each integration will be revisited in its own phase below.

1. **Repo scaffold and infrastructure** — Docker Compose, Cloudflare Tunnel, SSHFS dev workflow
2. **UI design** — Stitch design exports created (login + dashboard, desktop + mobile) and stored in `brand-assets/`. The current frontend HTML was built independently and does NOT implement these designs. Rebuilding the frontend to match Stitch is Phase 2.
3. **Backend skeleton** — FastAPI app structure, SQLAlchemy models, Redis session management
4. **Authentication** — Database-backed login (temporary), bcrypt, session cookies, route protection, admin enforcement
5. **News system** — CRUD with custom rich text editor, bleach sanitization, publish/pin controls
6. **Service management** — CRUD via settings page, dashboard display
7. **Integration configuration** — Plex/Uptime Kuma/Overseerr settings with test-connection and credential masking
8. **Live dashboard** — Plex streams, Uptime Kuma health, Overseerr requests, 30-second refresh, admin actions

### Phase 0: Documentation & Tooling ✓

- Consolidated 10 markdown files into 3 root + 2 docs + 5 archive
- Built CLAUDE.md as operator manual with 5 subagent templates
- Defined project phases 0-8

### Phase 1: Auth & Plex Integration ✓

- Configured Authentik OIDC with native Plex source (HMS-Plex)
- Created custom "Plex Direct Login" flow for auto-redirect to Plex OAuth
- Built OIDC callback with admin determination (Plex server owner = admin)
- Desktop: popup-based auth flow (postMessage pattern)
- Mobile: full-page redirect flow (detected via UA/touch/width)
- Logout clears both dashboard and Authentik sessions
- Session tracks auth_method (oidc/simple) and id_token for logout
- Simple auth kept as fallback alongside Plex OAuth

### Phase 2: Frontend Rebuild

- Rebuild frontend pages to match Stitch UI designs
- Wire pages to existing backend endpoints
- Responsive/mobile support
- Make app configurable (no hardcoded values — logos, branding all variable)

### Phase 3: Uptime Kuma Integration

- Deep-dive Uptime Kuma API
- Settings page for Uptime Kuma configuration
- Service health dashboard wiring

### Phase 4: Overseerr Integration

- Deep-dive Overseerr API
- Settings page for Overseerr configuration
- Request display, iframe/portal route

### Phase 5: Radarr Integration

- Deep-dive Radarr API
- Settings page for Radarr configuration
- Dashboard wiring (upcoming movies, library stats)

### Phase 6: Sonarr Integration

- Deep-dive Sonarr API
- Settings page for Sonarr configuration
- Dashboard wiring (upcoming episodes, library stats)

### Phase 7: Notifications & Theming

- Discord webhook and/or email notifications
- Theme engine (CSS variables from admin settings)

### Phase 8: Hardening & Release

- Rate limiting, CSP tuning
- Automated backups, monitoring
- Final pass for GitHub shareability

---

## Core Principles

1. **Administration and longevity** - Stable tooling, centralized management, audit trails
2. **Customization** - Sitewide theme engine (planned, not yet built)
3. **Lightweight performance** - Minimal overhead, fast responses, simple deployment
4. **Security** - Strong authentication, safe content handling, hardened headers

## Security Requirements

Implemented or started to impletement:
- Secure cookies (HttpOnly, Secure, SameSite=Lax)
- HTML sanitization (bleach) for user-provided content
- Security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- No secrets in source control
- Admin role enforcement on state-changing operations

Not yet implemented:
- CSRF tokens for form submissions
- Rate limiting on login and public endpoints
- Bot protection (Cloudflare Turnstile)
- HSTS headers (would be set at Cloudflare level)

## Key Risks

- **Iframe compatibility:** Embedding Overseerr in an iframe may require CSP and X-Frame-Options changes on the Overseerr side.

## Out of Scope

- Multiple embedded services beyond Overseerr
- Public user registration (beyond Plex OAuth, when implemented)
- Full ticketing or support system
