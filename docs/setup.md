# HMS Dashboard - Setup Guide

## Prerequisites

- Docker and Docker Compose installed on the server
- Cloudflare Tunnel configured and pointing at port 8000
- A domain routed through Cloudflare

## 1. Generate Secrets

```bash
# Application secret key (used for session signing)
openssl rand -hex 32

# Authentik secret key (needed if Authentik containers are kept)
openssl rand -base64 32

# PostgreSQL password (needed if Authentik containers are kept)
openssl rand -base64 24
```

Store these securely (e.g., in a password manager).

## 2. Create the .env File

```bash
cp .env.example .env
```

Edit `.env` and fill in the generated secrets:

```env
APP_SECRET_KEY=<your-app-secret>
REDIS_URL=redis://redis:6379/0

# Only needed if running Authentik containers:
AUTHENTIK_SECRET_KEY=<your-authentik-secret>
POSTGRES_PASSWORD=<your-postgres-password>
AUTHENTIK_CLIENT_ID=
AUTHENTIK_CLIENT_SECRET=
```

The `AUTHENTIK_CLIENT_ID` and `AUTHENTIK_CLIENT_SECRET` fields can be left blank. Authentik/OIDC integration is not active in the current version.

## 3. Create the Data Directories

```bash
mkdir -p data uploads
```

- `data/` — SQLite database (`hms.db`), created on first startup
- `uploads/` — Uploaded assets (logos), volume-mounted into the container

## 4. Start the Containers

```bash
# Start Redis first
docker compose up -d redis

# Wait for Redis to be healthy
docker compose ps

# Start the dashboard
docker compose up -d hms-dashboard
```

On first startup, `app/seed.py` creates a default admin user:
- Username: `admin`
- Password: `admin123`

**Optional:** If you want the Authentik containers running for future OIDC work:

```bash
docker compose up -d postgresql
docker compose up -d authentik-server authentik-worker
```

These are not required for the dashboard to function.

## 5. Verify

```bash
# Check containers
docker compose ps

# Test health endpoint
curl http://localhost:8000/health

# Check logs
docker compose logs -f hms-dashboard
```

Open the dashboard URL in a browser. You should see the login page. Log in with `admin` / `admin123`.

## 6. Configure Integrations

After logging in, navigate to `/settings` and click the "Integrations" tab.

**Plex:** Enter your Plex server URL and API token. Click "Test Connection" to verify, then save.

**Uptime Kuma:** Enter your Uptime Kuma URL and status page slug. Click "Test Connection" to verify, then save.

**Overseerr:** Enter your Overseerr server URL and API key. Click "Test Connection" to verify, then save.

The dashboard will begin displaying live data from configured integrations.

## 7. Cloudflare Tunnel Configuration

Ensure your Cloudflare Tunnel routes are configured:

| Hostname | Service |
|----------|---------|
| `hmserver.tv` (or your domain) | `http://localhost:8000` |

If you plan to activate Authentik in the future, also configure:

| Hostname | Service |
|----------|---------|
| `auth.hmserver.tv` | `http://localhost:9000` |

---

## Rebuilding After Code Changes

```bash
docker compose up -d --build hms-dashboard
```

## Viewing Logs

```bash
# Dashboard logs
docker compose logs -f hms-dashboard

# All container logs
docker compose logs

# Redis logs
docker compose logs redis
```

## Troubleshooting

**Container will not start:**
```bash
docker compose logs hms-dashboard
docker compose down
docker compose up -d
```

**Database issues:**
```bash
# Check if database file exists
ls -la data/hms.db

# Query the database from inside the container
docker compose exec hms-dashboard sqlite3 /app/data/hms.db ".tables"
```

**Session issues (cannot log in or stay logged in):**
```bash
# Check Redis is running
docker compose ps redis

# Verify Redis connectivity from dashboard container
docker compose exec hms-dashboard python -c "import redis; r = redis.from_url('redis://redis:6379/0'); print(r.ping())"
```

**Reset everything (destroys all data):**
```bash
docker compose down
rm -f data/hms.db
docker volume rm hms-redis-data
docker compose up -d redis hms-dashboard
```

This will recreate the database with a fresh admin user and clear all sessions.

---

## Backup

Back up these files regularly:
- `data/hms.db` - All application data (users, news, services, settings)
- `uploads/` - Uploaded assets (logos)
- `.env` - Secrets and configuration

No automated backup is currently configured.
