# HMS Dashboard

A web portal for Plex media server administration. Provides a unified dashboard for monitoring Plex streams, service health (via Uptime Kuma), media requests (via Overseerr), and publishing news updates.

## Tech Stack

- **Backend:** FastAPI (Python 3.11), SQLite via SQLAlchemy, Redis sessions
- **Frontend:** Vanilla JavaScript, Tailwind CSS (CDN), Material Design Icons
- **Infrastructure:** Docker Compose, Cloudflare Tunnel, Linode VPS (2GB RAM)

## Quick Start

See [docs/setup.md](docs/setup.md) for full deployment instructions.

```bash
# Start the containers
docker compose up -d redis
docker compose up -d hms-dashboard
```

**Default credentials:** `admin` / `admin123` (created on first startup by `app/seed.py`)

## Project Structure

```
app/
  main.py              # FastAPI app entry point
  models.py            # SQLAlchemy models
  routers/             # API route handlers
  integrations/        # External service API clients
  static/              # Frontend HTML/JS pages
docs/
  app-contract.md      # Pages, endpoints, models, auth (source of truth)
  setup.md             # Deployment and operations guide
brand-assets/          # Stitch UI designs, color palette, logos
```

## Documentation

- [VISION.md](VISION.md) — Project plan and delivery phases
- [CLAUDE.md](CLAUDE.md) — Claude Code operator manual (development guide, subagent catalog)
- [docs/app-contract.md](docs/app-contract.md) — Application contract (pages, endpoints, models)
- [docs/setup.md](docs/setup.md) — Deployment and operations
