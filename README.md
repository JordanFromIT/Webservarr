# WebServarr

A self-hosted web dashboard for Plex media server administration. WebServarr brings together your Plex streams, service health monitoring, media requests, upcoming releases, and news announcements into a single, themeable portal.

## Features

- **Live Plex Streams** -- Active stream monitoring with quality indicators (direct play, transcode, resolution details)
- **Service Health** -- Real-time status tiles powered by Uptime Kuma with auto-fit grid and selfh.st icons
- **System Gauges** -- CPU, RAM, and network utilization from Netdata displayed as animated SVG gauges
- **Media Requests** -- Search TMDB, create requests, and track status via Overseerr integration
- **Issue Tracking** -- Report and manage media issues (audio, video, subtitle) through Overseerr
- **Release Calendar** -- Combined Radarr and Sonarr calendar with month navigation and homepage 7-day strip
- **News System** -- Publish announcements and maintenance notices with rich text and pinning
- **Notifications** -- In-app bell notifications and optional browser push (Web Push / VAPID) for request updates, issue responses, service changes, and news posts
- **Themeable** -- Full theme engine with color pickers, Google Fonts, custom CSS, logo upload, configurable sidebar labels and icons
- **Three Auth Methods** -- Simple username/password (default), direct Plex OAuth (recommended), or Plex via Authentik OIDC (advanced)

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

Log in with the default credentials (`admin` / `admin123`) and head to **Settings** to configure your integrations.

## Configuration

All configuration is done through the Settings UI after logging in. No `.env` file is required for basic operation.

### Integrations

Navigate to **Settings > Integrations** to connect your services:

| Integration | What You Need | What It Provides |
|------------|---------------|-----------------|
| **Plex** | Server URL + API token | Active streams, quality monitoring, Plex OAuth login |
| **Uptime Kuma** | URL + status page slug | Service health tiles on the homepage |
| **Overseerr** | URL + API key | Media requests, issue tracking, TMDB search, login backgrounds |
| **Radarr** | URL + API key | Upcoming movie releases on calendar |
| **Sonarr** | URL + API key | Upcoming TV episode releases on calendar |
| **Netdata** | URL | CPU, RAM, and network gauges on the homepage |

Each integration has a **Test Connection** button to verify your credentials before saving.

### Authentication

WebServarr supports three authentication methods, configurable in **Settings > Integrations**:

1. **Simple Auth** (default) -- Username and password login against the local database. Enabled out of the box. Can be disabled once Plex OAuth is configured.

2. **Direct Plex OAuth** (recommended) -- Users sign in with their Plex account. Same PIN-based flow used by Overseerr and Tautulli. Requires Plex integration to be configured. Admin is determined by matching the user's email against the Plex server owner or `system.admin_email` setting.

3. **Authentik OIDC** (advanced) -- Plex login through an Authentik identity provider. Useful if you already run Authentik for SSO across multiple services. See [docs/setup.md](docs/setup.md) for setup instructions.

### Environment Variables

For most users, the Settings UI is sufficient. Advanced users can override defaults via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_DOMAIN` | `localhost` | Your domain — used for CSP headers (e.g., `dashboard.example.com`) |
| `APP_SCHEME` | `https` | URL scheme — used for CSP headers (`http` for local development) |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection string |
| `CORS_ORIGINS` | `""` | Additional CORS origins (comma-separated) |
| `CSP_FRAME_SRC` | `""` | Additional CSP frame-src origins |
| `CSP_CONNECT_SRC` | `""` | Additional CSP connect-src origins |

## Tech Stack

- **Backend:** FastAPI (Python 3.11), SQLite, Redis sessions
- **Frontend:** Vanilla JavaScript, Tailwind CSS (CDN), Material Design Icons
- **Deployment:** Docker Compose (2 containers: `webservarr` + `redis`)

## Project Structure

```
app/
  main.py              # FastAPI app entry point
  config.py            # Settings from environment variables
  models.py            # SQLAlchemy ORM models
  seed.py              # Default admin + settings seeded on first startup
  auth.py              # Session manager + OIDC client
  routers/             # API route handlers
  integrations/        # External service API clients (Plex, Overseerr, etc.)
  services/            # Background services (notification poller, push dispatch)
  static/              # Frontend HTML/JS/CSS pages
docs/
  app-contract.md      # Full API surface documentation
  setup.md             # Installation and operations guide
brand-assets/          # Design references, color palette, logos
```

## Updating

```bash
docker compose pull
docker compose up -d
```

Data is stored in `./data/` (SQLite database) and `./uploads/` (logos). These directories persist across updates.

## Backup

Back up these directories regularly:

- `data/` -- SQLite database (users, news, settings, notifications)
- `uploads/` -- Uploaded assets (logos)
- `.env` -- Environment overrides (if you use any)

## Documentation

- [docs/setup.md](docs/setup.md) -- Full installation and operations guide
- [docs/app-contract.md](docs/app-contract.md) -- API endpoints, models, and auth reference
- [VISION.md](VISION.md) -- Project roadmap and design decisions

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push to your fork and open a pull request

## License

[MIT](LICENSE)
