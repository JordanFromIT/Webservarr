# Phase 9: WebServarr Branding & Public Release — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare WebServarr for public open-source release: publish to Docker Hub via CI, document updates and Authentik setup, seed proper default news posts, and clean up the dev instance.

**Architecture:** No new backend routes or models needed. Changes span GitHub Actions CI, docker-compose.yml, seed.py, database.py, and documentation files. The dev instance gets a one-off data fix via the admin API.

**Tech Stack:** GitHub Actions, Docker Buildx (multi-platform), Docker Hub, FastAPI/SQLAlchemy (seed functions), Python `markdown` + `bleach` (news content rendering).

**Note on testing:** This project has no automated test suite. Each task includes manual verification steps against the running container.

---

## Task 1: Renumber phases in VISION.md and CLAUDE.md

**Files:**
- Modify: `VISION.md`
- Modify: `CLAUDE.md`

**Step 1: Update VISION.md**

In `VISION.md`, find the Phase 9 heading and add a new Phase 9 block before it, renaming the old one to Phase 10.

Replace the existing Phase 9 section:
```markdown
### Phase 9: Security Hardening
```
with:
```markdown
### Phase 9: WebServarr Branding & Public Release ✓

- Docker Hub image publishing via GitHub Actions (multi-platform: amd64 + arm64)
- Update mechanism documented for both `docker compose` and `docker run` users
- Default news post seeding (welcome post + labeled example post)
- One-time news rebrand migration (HMS Dashboard → WebServarr post titles)
- Authentik OIDC setup documentation (existing instance + fresh install paths)

### Phase 10: Security Hardening
```

Also update the phase table in VISION.md (the delivery phases list) to add Phase 9 and renumber Security Hardening to 10.

**Step 2: Update CLAUDE.md**

In `CLAUDE.md`, find the phase table:
```markdown
| 9 | Security Hardening | **Next** |
```
Replace with:
```markdown
| 9 | WebServarr Branding & Public Release | **Next** |
| 10 | Security Hardening | Planned |
```

Also update the `**Current phase: 9**` line to remain 9.

**Step 3: Commit**

```bash
git add VISION.md CLAUDE.md
git commit -m "docs: renumber phases — Security Hardening moves to Phase 10"
```

---

## Task 2: GitHub Actions workflow for Docker Hub publishing

**Files:**
- Create: `.github/workflows/docker-publish.yml`

**Step 1: Create the workflows directory**

```bash
mkdir -p .github/workflows
```

**Step 2: Write the workflow file**

```yaml
name: Build and Push Docker Image

on:
  push:
    branches:
      - main

jobs:
  build-and-push:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            webservarr/webservarr:latest
            webservarr/webservarr:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

**Step 3: Add Docker Hub secrets to GitHub**

Go to the GitHub repo → Settings → Secrets and variables → Actions → New repository secret:
- `DOCKERHUB_USERNAME` — your Docker Hub username
- `DOCKERHUB_TOKEN` — a Docker Hub access token (create at hub.docker.com → Account Settings → Security)

**Step 4: Commit and verify**

```bash
git add .github/workflows/docker-publish.yml
git commit -m "ci: add GitHub Actions workflow to build and push Docker image to Docker Hub"
```

After pushing to `main`, go to the GitHub repo → Actions tab and verify the workflow runs successfully. It should produce `webservarr/webservarr:latest` on Docker Hub.

---

## Task 3: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Read the current file**

Current `docker-compose.yml`:
```yaml
services:
  webservarr:
    build: .
    container_name: webservarr
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=sqlite:////app/data/webservarr.db
      - REDIS_URL=redis://redis:6379/0
    volumes:
      - ./data:/app/data
      - ./uploads:/app/app/static/uploads
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      - redis
```

**Step 2: Apply changes**

- Add `image: webservarr/webservarr:latest` so users pulling from Docker Hub get the published image
- Keep `build: .` — when present alongside `image:`, running `docker compose up -d --build` builds locally (dev workflow unchanged)
- Remove the `/var/run/docker.sock` volume — nothing in the codebase uses it; it is a security risk in a public image

Result:
```yaml
services:
  webservarr:
    image: webservarr/webservarr:latest
    build: .
    container_name: webservarr
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=sqlite:////app/data/webservarr.db
      - REDIS_URL=redis://redis:6379/0
    volumes:
      - ./data:/app/data
      - ./uploads:/app/app/static/uploads
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    container_name: webservarr-redis
    restart: unless-stopped
    volumes:
      - redis_data:/data

volumes:
  redis_data:
```

**Step 3: Verify dev workflow still works**

```bash
docker compose up -d --build webservarr
docker compose ps
```

Expected: container starts, `docker compose ps` shows `webservarr` as running.

**Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add Docker Hub image reference, remove unused docker.sock mount"
```

---

## Task 4: Add docker run command to README.md

**Files:**
- Modify: `README.md`

**Step 1: Find the Quick Start section**

The current Quick Start shows `docker compose up -d`. Add a `docker run` alternative directly below it.

**Step 2: Update Quick Start**

Replace the existing Quick Start section with:

```markdown
## Quick Start

### Option A — Docker Compose (recommended)

```bash
# 1. Download the compose file
curl -O https://raw.githubusercontent.com/webservarr/webservarr/main/docker-compose.yml

# 2. Start the containers
docker compose up -d

# 3. Open the dashboard
open http://localhost:8000
```

### Option B — docker run

```bash
docker run -d \
  --name webservarr \
  --restart unless-stopped \
  -p 8000:8000 \
  -v ./data:/app/data \
  -v ./uploads:/app/app/static/uploads \
  webservarr/webservarr:latest
```

> A Redis container is also required. See [docs/setup.md](docs/setup.md) for the full `docker run` setup with Redis.
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add docker run quick start option alongside docker compose"
```

---

## Task 5: Update the "Updating" section in docs/setup.md

**Files:**
- Modify: `docs/setup.md`

**Step 1: Find the current Updating section (line ~84)**

Current:
```markdown
## Updating

```bash
# Pull the latest code
git pull

# Rebuild and restart
docker compose up -d --build
```
```

**Step 2: Replace with multi-method instructions**

```markdown
## Updating

### Docker Compose

```bash
docker compose pull
docker compose up -d
```

### docker run

```bash
docker pull webservarr/webservarr:latest
docker stop webservarr
docker rm webservarr
docker run -d \
  --name webservarr \
  --restart unless-stopped \
  -p 8000:8000 \
  -v ./data:/app/data \
  -v ./uploads:/app/app/static/uploads \
  webservarr/webservarr:latest
```

### Automatic updates with Watchtower (optional)

[Watchtower](https://containrrr.dev/watchtower/) watches Docker Hub for new image versions and automatically recreates your containers when a new `:latest` is published.

```bash
docker run -d \
  --name watchtower \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  webservarr webservarr-redis
```

This restarts only the `webservarr` and `webservarr-redis` containers when new images are available. Your data volumes persist across restarts.
```

**Step 3: Commit**

```bash
git add docs/setup.md
git commit -m "docs: update Updating section with docker run, compose pull, and Watchtower instructions"
```

---

## Task 6: Seed default news posts for fresh installs

**Files:**
- Modify: `app/seed.py`
- Modify: `app/database.py`

**Step 1: Add `seed_default_news` to seed.py**

Add this function at the end of `app/seed.py`, after `seed_secret_key`:

```python
def seed_default_news(db: Session) -> None:
    """Seed default news posts for fresh installs. Skips if any posts exist."""
    from app.models import NewsPost
    from app.routers.news import render_markdown
    from datetime import datetime, timezone

    if db.query(NewsPost).count() > 0:
        return

    now = datetime.now(timezone.utc)

    posts = [
        {
            "title": "Welcome to WebServarr",
            "content": (
                "## Welcome to WebServarr\n\n"
                "WebServarr is your self-hosted media server portal. Here's what you can do:\n\n"
                "- **Plex Streams** — Monitor active streams and playback quality in real time\n"
                "- **Service Health** — Status tiles powered by Uptime Kuma\n"
                "- **System Gauges** — CPU, RAM, and network stats from Netdata\n"
                "- **Media Requests** — Search and request movies and TV shows via Overseerr\n"
                "- **Release Calendar** — Upcoming movies and episodes from Radarr and Sonarr\n"
                "- **Notifications** — In-app and browser push notifications\n"
                "- **Theme Engine** — Colors, fonts, logos, and custom CSS\n\n"
                "Head to **Settings** to connect your integrations and get started."
            ),
            "pinned": True,
        },
        {
            "title": "[Example] Server Maintenance Notice",
            "content": (
                "> **Note:** This is an example post showing news formatting. "
                "Edit or delete it from **Settings > News**.\n\n"
                "We will be performing routine maintenance on **Saturday** from 2:00 AM to 4:00 AM.\n\n"
                "**Services affected:**\n"
                "- Media streaming (Plex)\n"
                "- Media requests (Overseerr)\n\n"
                "Expected downtime: ~30 minutes. Thank you for your patience!"
            ),
            "pinned": False,
        },
    ]

    for post_data in posts:
        content_html = render_markdown(post_data["content"])
        post = NewsPost(
            title=post_data["title"],
            content=post_data["content"],
            content_html=content_html,
            author_id="system",
            author_name="WebServarr",
            published=True,
            published_at=now,
            pinned=post_data["pinned"],
        )
        db.add(post)

    db.commit()
    logger.info("Seeded %d default news posts", len(posts))
```

**Step 2: Wire it into database.py**

In `app/database.py`, find the `init_db` function:

```python
    from app.seed import seed_default_admin, seed_default_settings, seed_vapid_keys
    db = SessionLocal()
    try:
        seed_default_admin(db)
        seed_default_settings(db)
        seed_vapid_keys(db)
    finally:
        db.close()
```

Replace with:

```python
    from app.seed import seed_default_admin, seed_default_settings, seed_vapid_keys, seed_default_news
    db = SessionLocal()
    try:
        seed_default_admin(db)
        seed_default_settings(db)
        seed_vapid_keys(db)
        seed_default_news(db)
    finally:
        db.close()
```

**Step 3: Verify on dev instance**

The dev instance already has news posts, so `seed_default_news` will be a no-op (count > 0 guard). No action needed here — verification happens in Task 7.

**Step 4: Commit**

```bash
git add app/seed.py app/database.py
git commit -m "feat: seed default news posts on fresh install"
```

---

## Task 7: One-time news rebrand migration

**Files:**
- Modify: `app/seed.py`
- Modify: `app/database.py`

**Step 1: Add `migrate_news_rebrand` to seed.py**

Add this function after `seed_default_news` in `app/seed.py`:

```python
def migrate_news_rebrand(db: Session) -> None:
    """One-time migration: update news post titles/content from HMS Dashboard to WebServarr branding.
    Guarded by a migration marker in Settings so it runs exactly once."""
    from sqlalchemy.exc import IntegrityError
    from app.models import NewsPost
    from app.routers.news import render_markdown

    # Skip if already ran
    if db.query(Setting).filter(Setting.key == "migration.news_rebrand_v1").first():
        return

    # Update the welcome post
    welcome = db.query(NewsPost).filter(NewsPost.title == "Welcome to HMS Dashboard").first()
    if welcome:
        new_content = (
            "## Welcome to WebServarr\n\n"
            "WebServarr is your self-hosted media server portal. Here's what you can do:\n\n"
            "- **Plex Streams** — Monitor active streams and playback quality in real time\n"
            "- **Service Health** — Status tiles powered by Uptime Kuma\n"
            "- **System Gauges** — CPU, RAM, and network stats from Netdata\n"
            "- **Media Requests** — Search and request movies and TV shows via Overseerr\n"
            "- **Release Calendar** — Upcoming movies and episodes from Radarr and Sonarr\n"
            "- **Notifications** — In-app and browser push notifications\n"
            "- **Theme Engine** — Colors, fonts, logos, and custom CSS\n\n"
            "Head to **Settings** to connect your integrations and get started."
        )
        welcome.title = "Welcome to WebServarr"
        welcome.content = new_content
        welcome.content_html = render_markdown(new_content)

    # Rename and update the maintenance example post
    maintenance = db.query(NewsPost).filter(
        NewsPost.title == "Server Maintenance Scheduled"
    ).first()
    if maintenance:
        new_content = (
            "> **Note:** This is an example post showing news formatting. "
            "Edit or delete it from **Settings > News**.\n\n"
            "We will be performing routine maintenance on **Saturday** from 2:00 AM to 4:00 AM.\n\n"
            "**Services affected:**\n"
            "- Media streaming (Plex)\n"
            "- Media requests (Overseerr)\n\n"
            "Expected downtime: ~30 minutes. Thank you for your patience!"
        )
        maintenance.title = "[Example] Server Maintenance Notice"
        maintenance.content = new_content
        maintenance.content_html = render_markdown(new_content)

    # Delete the test post
    test_post = db.query(NewsPost).filter(NewsPost.title == "test").first()
    if test_post:
        db.delete(test_post)

    db.commit()

    # Mark migration as done
    try:
        db.add(Setting(
            key="migration.news_rebrand_v1",
            value="done",
            description="One-time news post rebrand migration (HMS Dashboard -> WebServarr)",
        ))
        db.commit()
    except IntegrityError:
        db.rollback()

    logger.info("Completed one-time news rebrand migration")
```

**Step 2: Wire it into database.py**

Update the import and call in `app/database.py`:

```python
    from app.seed import (
        seed_default_admin, seed_default_settings, seed_vapid_keys,
        seed_default_news, migrate_news_rebrand,
    )
    db = SessionLocal()
    try:
        seed_default_admin(db)
        seed_default_settings(db)
        seed_vapid_keys(db)
        seed_default_news(db)
        migrate_news_rebrand(db)
    finally:
        db.close()
```

**Step 3: Build and verify on dev instance**

```bash
docker compose up -d --build webservarr
docker compose logs webservarr | grep -i "migration\|news\|rebrand"
```

Expected log output:
```
INFO     app.seed:seed.py:XXX Completed one-time news rebrand migration
```

Then open `https://dev.hmserver.tv` and verify the homepage news section shows:
- "Welcome to WebServarr" (pinned, correct content)
- "[Example] Server Maintenance Notice" (with the example note at top)
- "test" post is gone

**Step 4: Commit**

```bash
git add app/seed.py app/database.py
git commit -m "feat: one-time migration to rebrand existing news posts to WebServarr"
```

---

## Task 8: Authentik one-off data migration (dev instance only)

This task uses the live admin API to write the four Authentik settings into the DB. No code is added to the repo.

**Step 1: Read the current .env to get the Authentik values**

```bash
grep -i authentik .env
```

Note the values for: `AUTHENTIK_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, and the app slug.

**Step 2: Get a session cookie**

```bash
curl -s -c /tmp/ws_cookies.txt -X POST https://dev.hmserver.tv/auth/simple-login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

Expected: `{"message": "Login successful"}`

**Step 3: Write the Authentik settings to DB**

Fill in the actual values from `.env`:

```bash
curl -s -b /tmp/ws_cookies.txt -X PUT https://dev.hmserver.tv/api/admin/settings/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "settings": [
      {"key": "integration.authentik.url", "value": "REPLACE_WITH_AUTHENTIK_URL"},
      {"key": "integration.authentik.client_id", "value": "REPLACE_WITH_CLIENT_ID"},
      {"key": "integration.authentik.client_secret", "value": "REPLACE_WITH_CLIENT_SECRET"},
      {"key": "integration.authentik.app_slug", "value": "REPLACE_WITH_APP_SLUG"}
    ]
  }'
```

Expected: JSON response listing the four updated settings.

**Step 4: Verify in the Settings UI**

Open `https://dev.hmserver.tv/settings`, navigate to Integrations → Authentik (Optional), expand the accordion. All four fields should be populated.

**Step 5: Verify Authentik login still works**

Open a private browser window, go to `https://dev.hmserver.tv`, and click "Sign in with Plex (via Authentik)". Confirm login completes successfully.

**Step 6: Cleanup**

```bash
rm /tmp/ws_cookies.txt
```

No commit needed — this is a data operation only.

---

## Task 9: Expand Authentik documentation in docs/setup.md

**Files:**
- Modify: `docs/setup.md`

**Step 1: Find the existing Authentik section (around line 109)**

The current section is thin. Replace the entire "Advanced: Authentik OIDC Setup" section with the expanded version below.

**Step 2: Write the expanded documentation**

```markdown
## Advanced: Authentik OIDC Setup

Authentik provides Plex login *through* an identity provider. This is useful if you already run Authentik for SSO across multiple services, or want centralized session management. If you just want users to sign in with Plex, use **direct Plex OAuth** instead — it requires no Authentik and is configured entirely in Settings > Integrations > Plex.

### Path A — Connect to an existing Authentik instance

#### 1. Create a Plex source in Authentik

In Authentik, go to **Directory → Federation & Social login → Create → Plex**.

- Give it a name (e.g., "Plex")
- Save and note the slug

This allows users to authenticate with their Plex account through Authentik.

#### 2. Create an OAuth2/OIDC Provider

In Authentik, go to **Applications → Providers → Create → OAuth2/OpenID Connect**.

- **Name:** WebServarr (or any name)
- **Redirect URIs:** `https://your-domain.com/auth/callback`
  This must exactly match your WebServarr domain including the scheme (`https://`) and no trailing slash.
- **Signing Key:** Select the default certificate
- Save, then note the **Client ID** and **Client Secret** from the provider detail page

#### 3. Create an Application

In Authentik, go to **Applications → Applications → Create**.

- **Name:** WebServarr
- **Slug:** `webservarr` (or any slug — note it, you'll need it)
- **Provider:** select the OAuth2 provider you just created
- Save

#### 4. Configure in WebServarr

In WebServarr, go to **Settings → Integrations → Authentik (Optional)**:

| Field | Value |
|-------|-------|
| Authentik URL | `https://auth.example.com` (your Authentik base URL) |
| Client ID | From the OAuth2 provider detail page |
| Client Secret | From the OAuth2 provider detail page |
| App Slug | The slug of the Authentik application (e.g., `webservarr`) |

Click **Save**. The "Sign in with Plex (via Authentik)" button will appear on the login page.

---

### Path B — New Authentik instance alongside WebServarr

The repo includes an optional Docker Compose overlay that adds Authentik and its PostgreSQL database alongside WebServarr, sharing the existing Redis container.

#### 1. Generate required secrets

```bash
echo "AUTHENTIK_SECRET_KEY=$(openssl rand -base64 32)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 16)" >> .env
```

#### 2. Start all containers

```bash
docker compose -f docker-compose.yml -f docker-compose.authentik.yml up -d
```

#### 3. Complete the Authentik setup wizard

Open `http://localhost:9000/if/flow/initial-setup/` and create the initial admin account.

#### 4. Follow Path A steps above

Continue from "Create a Plex source" to configure the provider, application, and WebServarr settings.

---

### Troubleshooting

**"Sign in with Plex (via Authentik)" button not appearing**
All four settings (URL, Client ID, Client Secret, App Slug) must be saved in Settings → Integrations → Authentik. Verify none are blank.

**Redirect URI mismatch error**
The redirect URI in the Authentik OAuth2 provider must exactly match `https://your-domain.com/auth/callback` — same scheme, same domain, no trailing slash.

**Plex popup blocked on mobile**
Authentik opens a Plex popup window during login. Some mobile browsers block popups. For mobile users, direct Plex OAuth (no Authentik) is the recommended auth method — configure it in Settings → Integrations → Plex.

**Logout doesn't return to the WebServarr login page**
This is a known upstream Authentik limitation with end-session redirects. Users will land on the Authentik logout confirmation page rather than being redirected back automatically.
```

**Step 3: Commit**

```bash
git add docs/setup.md
git commit -m "docs: expand Authentik OIDC setup guide with two-path walkthrough and troubleshooting"
```

---

## Task 10: Final verification pass

**Step 1: Check all containers are healthy**

```bash
docker compose ps
docker compose logs webservarr --tail=30
```

Expected: no errors, `webservarr` and `webservarr-redis` both up.

**Step 2: Verify homepage news posts**

Open `https://dev.hmserver.tv`. Confirm:
- "Welcome to WebServarr" pinned post visible with correct content
- "[Example] Server Maintenance Notice" visible with example note
- No "test" post, no "Welcome to HMS Dashboard" post

**Step 3: Verify Authentik login**

Private window → `https://dev.hmserver.tv` → "Sign in with Plex (via Authentik)" → confirm login succeeds.

**Step 4: Verify Settings UI shows Authentik values**

Settings → Integrations → Authentik → expand accordion → all four fields populated.

**Step 5: Check GitHub Actions**

Push any commit to `main` and confirm the GitHub Actions workflow completes, producing `webservarr/webservarr:latest` on Docker Hub.

**Step 6: Update CLAUDE.md phase status**

Mark Phase 9 as complete:

```markdown
| 9 | WebServarr Branding & Public Release | **Complete** |
| 10 | Security Hardening | **Next** |
```

```bash
git add CLAUDE.md VISION.md
git commit -m "docs: mark Phase 9 complete, advance to Phase 10"
```
