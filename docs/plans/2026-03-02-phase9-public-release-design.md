# Phase 9: WebServarr Branding & Public Release — Design

**Date:** 2026-03-02
**Status:** Approved

## Overview

Prepare WebServarr for public open-source release on Docker Hub. Covers Docker image publishing, update documentation, Authentik OIDC setup documentation, default news post seeding, and one-time data cleanup for the dev instance.

Security Hardening (previously Phase 9) is renumbered to Phase 10.

---

## 1. Phase Renumbering

Update `VISION.md` and `CLAUDE.md`:
- Phase 9: WebServarr Branding & Public Release (this phase)
- Phase 10: Security Hardening (was Phase 9)

---

## 2. Docker Hub Publishing

### GitHub Actions Workflow

File: `.github/workflows/docker-publish.yml`

- **Trigger:** push to `main`
- **Platforms:** `linux/amd64` + `linux/arm64` (Raspberry Pi / ARM server support)
- **Tags:**
  - `webservarr/webservarr:latest`
  - `webservarr/webservarr:<git-sha>` (traceability)
- **Required GitHub secrets:** `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`

### docker-compose.yml Changes

- Add `image: webservarr/webservarr:latest` so users pull from Docker Hub
- Keep `build: .` alongside — `docker compose up -d --build` still works for local dev
- **Remove** `/var/run/docker.sock` volume mount — nothing in the codebase uses it; it is a security risk in a public image

### README.md

Add a `docker run` one-liner for users who don't use Compose:

```bash
docker run -d \
  --name webservarr \
  --restart unless-stopped \
  -p 8000:8000 \
  -v ./data:/app/data \
  -v ./uploads:/app/app/static/uploads \
  webservarr/webservarr:latest
```

---

## 3. Update Mechanism (docs/setup.md)

Replace the current "Updating" section with instructions for both install methods:

**Docker Compose:**
```bash
docker compose pull
docker compose up -d
```

**docker run:**
```bash
docker pull webservarr/webservarr:latest
docker stop webservarr
docker rm webservarr
docker run -d ... # same flags as initial install
```

**Optional — Watchtower (automatic updates):**
Add a brief note that Watchtower can watch Docker Hub and automatically recreate containers when a new `:latest` is published. One-liner to add Watchtower to any Docker Compose setup.

---

## 4. Authentik Settings (dev instance only — no code in repo)

The dev instance at `dev.hmserver.tv` has Authentik configured via environment variables. The Settings UI reads from DB first, falling back to env vars, so the fields appear empty in the UI even though Authentik works.

**Fix:** After deployment, run a one-off `curl` command against the admin API to write the four values (`url`, `client_id`, `client_secret`, `app_slug`) directly into the DB settings table. No migration code is added to the repository — this is a one-time manual operation for this instance only.

---

## 5. Default News Posts

### Fresh Install Seed (`seed_default_news` in `app/seed.py`)

Runs only when the `NewsPost` table is empty (new installs).

**Post 1 — pinned:**
- Title: "Welcome to WebServarr"
- Content: Brief intro + bulleted feature highlights (Plex streams, service health, media requests, calendar, notifications, theme engine)

**Post 2 — unpinned:**
- Title: "[Example] Server Maintenance Notice"
- Content: A clearly labeled example post demonstrating markdown formatting (bold text, bullet lists, inline code). Includes a note at the top that this is an example and can be deleted.

### One-Time Rebrand Migration (`migrate_news_rebrand` in `app/seed.py`)

Runs once on the dev instance; guarded by `migration.news_rebrand_v1` setting so it never runs again.

- Update post titled "Welcome to HMS Dashboard" → title: "Welcome to WebServarr", refresh content
- Rename "Server Maintenance Scheduled" → "[Example] Server Maintenance Notice", add example label to content
- Delete the "test" post
- Write `migration.news_rebrand_v1 = done` to prevent re-running

Both functions are called from `database.py` `init_db()` alongside existing seed functions.

---

## 6. Authentik Documentation (docs/setup.md)

Expand the existing "Advanced: Authentik OIDC Setup" section into two complete paths.

### Context note
Authentik provides Plex login *through* an identity provider — distinct from direct Plex OAuth (which requires no Authentik). Use Authentik if you already run it for SSO across multiple services, or want centralized session management.

### Path A — Existing Authentik Instance

Step-by-step:
1. **Create a Plex source** in Authentik (Directory → Federation & Social login → Create → Plex) — this allows users to authenticate with their Plex account
2. **Create an OAuth2/OIDC Provider** (Applications → Providers → Create → OAuth2/OpenID Connect)
   - Redirect URI: `https://your-domain.com/auth/callback`
   - Note the Client ID and Client Secret
3. **Create an Application** (Applications → Applications → Create) linked to the provider — note the slug
4. **Configure in WebServarr:** Settings → Integrations → Authentik (Optional)
   - Authentik URL (e.g., `https://auth.example.com`)
   - Client ID
   - Client Secret
   - App Slug

After saving, the "Sign in with Plex (via Authentik)" button appears on the login page.

### Path B — New Authentik Instance Alongside WebServarr

Use the optional overlay file included in the repo:

```bash
# Generate required secrets
echo "AUTHENTIK_SECRET_KEY=$(openssl rand -base64 32)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 16)" >> .env

# Start WebServarr + Authentik + PostgreSQL
docker compose -f docker-compose.yml -f docker-compose.authentik.yml up -d
```

Then:
1. Open Authentik at `http://localhost:9000` and complete the initial setup wizard
2. Follow Path A steps above

### Troubleshooting

- **Redirect URI mismatch:** The URI in the Authentik provider must exactly match `https://your-domain.com/auth/callback` including the scheme and no trailing slash
- **Mobile Plex popup blocked:** Authentik opens a Plex popup window — mobile browsers may block it. This is an upstream limitation; direct Plex OAuth (no Authentik) is the recommended mobile-friendly auth method
- **Logout doesn't redirect back to login:** Known upstream Authentik issue with end-session redirect. Users land on the Authentik logout confirmation page instead of returning to WebServarr automatically
- **"Sign in with Plex (via Authentik)" button not appearing:** Verify all four fields (URL, Client ID, Client Secret, App Slug) are saved in Settings → Integrations → Authentik
